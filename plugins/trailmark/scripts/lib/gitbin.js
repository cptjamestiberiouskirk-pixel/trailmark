// Where git is, and how every trailmark git call runs it.
//
// On Windows, Node's child_process looks for a bare program name in the
// child's working folder before it searches PATH (libuv search_path). A repo
// with git.exe or git.com at its root would then run its own program every
// time a hook ran `git` there, set up or not. So git is looked up here, on
// absolute PATH entries only, and always run by its full path. A PATH entry
// that is relative, '.', or the working folder itself is skipped on every
// platform, since on Linux and macOS a '.' entry has the same effect.
//
// Every call also gets --no-optional-locks (and GIT_OPTIONAL_LOCKS=0), so
// `git status` never takes .git/index.lock to refresh the index. Another
// session's `git commit` would fail while it held that lock.
//
// The commit hook runs git in folders named in a command's text (cd x && git
// commit), so every call is also hardened against a hostile config in the
// repo it runs in. Settings given with -c override the repo's own, and the
// environment variables below override config entirely:
//   core.fsmonitor=false        no fsmonitor program or daemon
//   core.hooksPath=<null>       no hook programs
//   safe.bareRepository=explicit  a bare repo planted inside a folder isn't used
//   protocol.*.allow=never, GIT_ALLOW_PROTOCOL, GIT_NO_LAZY_FETCH
//                               no transport at all, so a partial clone's lazy
//                               fetch can't run the repo's ext:: command, its
//                               uploadpack or sshCommand, or a credential helper.
//                               A repo's own protocol.file.allow=always beats a
//                               plain -c protocol.allow=never; the variable
//                               doesn't (tested on git 2.43).
//   log.showSignature=false     no gpg.program on signed commits
//   status.submoduleSummary=false, --ignore-submodules=dirty on status
//                               no git started inside submodules
//   color.ui=false, --no-pager  plain output
// GIT_DIR, GIT_WORK_TREE and the like are dropped from the environment, so
// git looks at the folder it runs in and nothing else.
//
// Not covered here: `git status` (only in the PreCompact hook) runs a clean
// or process filter that the repo's attributes and config name, when a
// tracked file's timestamps changed. gitfacts.js switches those filters off
// call by call (filterOverrides), since turning attributes off for every
// call would break status in Git LFS repos.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_GLOBAL = [
  '--no-pager', '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'safe.bareRepository=explicit',
  '-c', 'protocol.allow=never',
  ...['file', 'ext', 'ssh', 'git', 'http', 'https'].flatMap(p => ['-c', `protocol.${p}.allow=never`]),
  '-c', 'log.showSignature=false',
  '-c', 'status.submoduleSummary=false',
  '-c', 'color.ui=false',
];

// Repo-location variables. Set in Claude Code's environment, they would point
// every call at one repo, whatever folder it runs in.
const DROP_ENV = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/i;

function envValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find(k => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function absoluteEntry(entry, platform) {
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(entry) || /^\\\\[^\\]/.test(entry);
  return entry.startsWith('/');
}

function sameDir(a, b, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = x => {
    let r = p.resolve(x).replace(/[\\/]+$/, '');
    if (platform === 'win32') r = r.replace(/\//g, '\\').toLowerCase();
    return r;
  };
  return norm(a) === norm(b);
}

function realOrNull(p, real) {
  try { return real(p); } catch { return null; }
}

// Pure lookup, for tests: { env, cwd, platform, isExec, realpath } -> absolute path or ''.
// The working folder is skipped by name and, where both resolve, by real path,
// which also catches other spellings of it (8.3 names, a trailing dot, \\?\,
// a junction). A PATH entry that is a subfolder of the repo (an activated
// .venv\Scripts, say) is not skipped: the user's own shell runs that git too.
function findGit({ env = process.env, cwd = process.cwd(), platform = process.platform, isExec = isExecutable, realpath = fs.realpathSync.native } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const raw = envValue(env, 'PATH') || '';
  const sep = platform === 'win32' ? ';' : ':';
  let names = ['git'];
  if (platform === 'win32') {
    const order = String(envValue(env, 'PATHEXT') || '.COM;.EXE').split(';')
      .map(x => x.trim().toLowerCase()).filter(x => x === '.exe' || x === '.com');
    names = (order.length ? [...new Set(order)] : ['.com', '.exe']).map(x => 'git' + x);
  }
  const realCwd = cwd ? realOrNull(cwd, realpath) : null;
  for (let entry of raw.split(sep)) {
    entry = entry.trim();
    if (platform === 'win32') entry = entry.replace(/^"(.*)"$/, '$1');
    if (!entry || !absoluteEntry(entry, platform)) continue;
    if (cwd && sameDir(entry, cwd, platform)) continue;
    const found = names.map(n => p.join(entry, n)).find(f => isExec(f));
    if (!found) continue;
    // Only an entry that has a git in it is resolved, to keep the walk cheap.
    if (realCwd) {
      const re = realOrNull(entry, realpath);
      if (re && sameDir(re, realCwd, platform)) continue;
    }
    return found;
  }
  return '';
}

const cache = new Map();

// Absolute path of git for runs in `cwd`, or '' when there is none on PATH.
function gitPath(cwd = process.cwd()) {
  const key = String(cwd);
  if (!cache.has(key)) {
    let found = '';
    try { found = findGit({ cwd }); } catch { found = ''; }
    cache.set(key, found);
  }
  return cache.get(key);
}

function gitEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!DROP_ENV.test(k)) env[k] = v;
  // Not a protocol name anything uses, so no transport is allowed.
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'jbmem-none', GIT_TERMINAL_PROMPT: '0' };
}

// A repo's own files can send git to a network share even when the folder
// git runs in is local: a .git file's gitdir, a worktree's commondir,
// include.path and includeIf paths, core.attributesFile and the other
// settings that name a file, and objects/info/alternates. git follows them
// whatever -c settings it gets, and on Windows reaching a share sends it your
// sign-in hash. So before git runs in a folder, the .git above it is checked,
// and a network path in any of those places (\\server, //server, or an NT
// path such as \??\UNC\server) keeps git out of that folder.
//
// The check fails closed: anything it can't be sure of keeps git out.
// - Every path is followed one part at a time from a local root. A link on
//   the way is read as text (never followed blind) and refused when it leads
//   to a network path; a .git that is itself a link, and links among the
//   gitdir's own entries (HEAD, refs, objects and the rest), are refused.
// - Config files are read by git itself (git config --file, includes off,
//   from this script's folder with discovery stopped above it), so quoting,
//   comments and subsections are taken the way git takes them. Includes are
//   followed ten deep, as git does, and at most 50 files are read; past
//   either limit git is kept out. A value starting with %(prefix) is refused:
//   git hands an absolute path after it on unchanged.
// - Alternates are followed five deep, as git does, C-quoted lines decoded.
// - Every .git from the folder up to the drive's root is checked, not only
//   the first: git passes over a .git that isn't a valid repo and keeps going.
// - A folder inside a .git is never used (git may take it for a submodule's
//   or worktree's own repo), whatever its Windows spelling (GIT~1, ".git.").
// - On Windows a drive-relative path (C:x) or a root-relative one (\x) in a
//   pointer is refused: git and this check would resolve it differently.
// Not covered: a link planted in place of a single loose object file, or
// among a repo's refs past the first 20,000 entries.
const NET_START = /^[\\/]{2}|^[\\/]\?\?[\\/]/;
const WIN = process.platform === 'win32';
const farCache = new Map();
// A value as git might read it: quotes dropped and escapes undone. Both the
// raw and the decoded spelling are checked, so neither can hide a share.
function netText(s) {
  const raw = String(s).replace(/"/g, '').trim();
  const dec = raw.replace(/\\\\/g, '\\').trim();
  if (/^%\(prefix\)/i.test(raw)) return true;
  return NET_START.test(raw) || NET_START.test(dec);
}
// A pointer git and this check may resolve differently on Windows.
function oddRelative(t) {
  if (!WIN) return false;
  const v = String(t).replace(/"/g, '').trim();
  return /^[A-Za-z]:(?![\\/])/.test(v) || /^[\\/](?![\\/])/.test(v);
}
const UNSAFE = Symbol('unsafe');
// p with every link on the way read and replaced by its target, one part at
// a time from the root; null when a link leads to a network path or the
// links loop. Parts that don't exist are kept as they are.
function localPath(p) {
  let cur = path.resolve(p);
  if (NET_START.test(cur)) return null;
  for (let hops = 0; hops < 40; hops++) {
    const root = path.parse(cur).root;
    const parts = cur.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let at = root;
    let relinked = false;
    for (let i = 0; i < parts.length; i++) {
      const next = path.join(at, parts[i]);
      let st;
      try { st = fs.lstatSync(next); } catch { return path.join(at, ...parts.slice(i)); }
      if (st.isSymbolicLink()) {
        let t;
        try { t = fs.readlinkSync(next); } catch { return null; }
        if (netText(t) || oddRelative(t)) return null;
        cur = path.resolve(at, t, ...parts.slice(i + 1));
        if (NET_START.test(cur)) return null;
        relinked = true;
        break;
      }
      at = next;
    }
    if (!relinked) return at;
  }
  return null;
}
// null when the file is missing; UNSAFE when it is there but can't be read
// as a plain small file (a link, a folder, too big, no access), since git
// would still follow it.
function readSmall(file, max) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e && e.code === 'ENOENT' || e && e.code === 'ENOTDIR' ? null : UNSAFE; }
  if (!st.isFile() || st.size > max) return UNSAFE;
  try { return fs.readFileSync(file, 'utf8'); } catch { return UNSAFE; }
}
// [key, value] pairs of one config file as git reads it, includes not
// followed; null when the file is missing, UNSAFE when git can't read it.
function configEntries(file) {
  const st = readSmall(file, 512 * 1024);
  if (st === null || st === UNSAFE) return st;
  const bin = gitPath(__dirname);
  if (!bin) return UNSAFE;
  try {
    const out = execFileSync(bin, [...GIT_GLOBAL, 'config', '--file', file, '--no-includes', '--null', '--list'], {
      cwd: __dirname, env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(__dirname) },
      encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    return out.split('\0').filter(Boolean).map(r => {
      const i = r.indexOf('\n');
      return i < 0 ? [r, ''] : [r.slice(0, i), r.slice(i + 1)];
    });
  } catch { return UNSAFE; }
}
const MAX_INCLUDE_DEPTH = 10;
const MAX_CONFIG_FILES = 50;
// st: { seen, files } shared by one whole check.
function farConfig(file, depth, st) {
  if (depth > MAX_INCLUDE_DEPTH) return 'deep-config';
  const real = localPath(file);
  if (!real) return 'network-config';
  if (st.seen.has(real)) return '';
  st.seen.add(real);
  if (++st.files > MAX_CONFIG_FILES) return 'many-config-files';
  const entries = configEntries(real);
  if (entries === null) return '';
  if (entries === UNSAFE) return 'unreadable-config';
  for (const [key, value] of entries) {
    if (netText(value)) return 'network-config';
    if (!/^include\.path$|^includeif\..*\.path$/i.test(key)) continue;
    let p = value.trim();
    if (oddRelative(p)) return 'odd-config-path';
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
    else if (p.startsWith('~')) return 'odd-config-path';
    const why = farConfig(path.resolve(path.dirname(real), p), depth + 1, st);
    if (why) return why;
  }
  return '';
}
// An alternates line as git reads it: a line starting with a quote is
// C-quoted (\\, \", \t and the like, \ooo octal).
function altLine(line) {
  const t = line.trim();
  if (!t.startsWith('"')) return t;
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  const body = m ? m[1] : t.slice(1);
  const map = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  return body.replace(/\\([0-7]{3}|.)/g, (_, c) => c.length === 3 ? String.fromCharCode(parseInt(c, 8)) : (map[c] || c));
}
// The alternates of one objects folder and theirs, five deep as git goes.
function farAlternates(objects, depth, seen) {
  if (depth > 5) return '';
  const real = localPath(objects);
  if (!real) return 'network-config';
  if (seen.has(real)) return '';
  seen.add(real);
  const alt = readSmall(path.join(real, 'info', 'alternates'), 64 * 1024);
  if (alt === null) return '';
  if (alt === UNSAFE) return 'unreadable-config';
  for (const raw of alt.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const line = altLine(raw);
    if (netText(raw) || netText(line)) return 'network-config';
    if (oddRelative(line)) return 'odd-config-path';
    const why = farAlternates(path.resolve(real, line), depth + 1, seen);
    if (why) return why;
  }
  return '';
}
// A pointer read from a file (gitdir:, commondir), resolved locally; null
// when it is, or leads through a link to, a network path or is ambiguous.
function gitdirAt(base, t) {
  if (netText(t) || oddRelative(t)) return null;
  return localPath(path.resolve(base, t.trim()));
}
// The gitdir's own entries git reads; none may be a link.
const GITDIR_ENTRIES = ['HEAD', 'config', 'config.worktree', 'commondir', 'objects', 'refs', 'packed-refs', 'logs', 'index', 'info', 'modules', 'worktrees', 'shallow', 'hooks', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD'];
function linkedEntries(gitdir) {
  const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  for (const e of GITDIR_ENTRIES) if (isLink(path.join(gitdir, e))) return true;
  // refs, and the first level of objects and objects/pack, walked for links.
  // Past 20,000 entries the rest isn't looked at: a big repo's unpacked refs
  // shouldn't keep git out.
  let budget = 20000;
  const walk = (d, depth) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const x of list) {
      if (--budget < 0) return false;
      if (x.isSymbolicLink()) return true;
      if (x.isDirectory() && depth > 0 && walk(path.join(d, x.name), depth - 1)) return true;
    }
    return false;
  };
  return walk(path.join(gitdir, 'refs'), 10) || walk(path.join(gitdir, 'objects'), 0) || walk(path.join(gitdir, 'objects', 'pack'), 0);
}
function farGit(gitEntry) {
  let st;
  try { st = fs.lstatSync(gitEntry); } catch { return ''; }
  let gitdir = gitEntry;
  if (st.isSymbolicLink()) return 'linked-gitdir';
  if (st.isFile()) {
    const t = readSmall(gitEntry, 4096);
    if (t === UNSAFE) return 'unreadable-config';
    const m = t === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(t);
    if (!m) return '';
    gitdir = gitdirAt(path.dirname(gitEntry), m[1]);
    if (!gitdir) return 'network-gitdir';
  } else if (!st.isDirectory()) return '';
  const dirs = [gitdir];
  const common = readSmall(path.join(gitdir, 'commondir'), 4096);
  if (common === UNSAFE) return 'unreadable-config';
  if (common !== null && common.trim()) {
    const c = gitdirAt(gitdir, common);
    if (!c) return 'network-gitdir';
    dirs.push(c);
  }
  const cst = { seen: new Set(), files: 0 };
  for (const d of dirs) {
    if (linkedEntries(d)) return 'linked-gitdir';
    for (const f of ['config', 'config.worktree']) {
      const why = farConfig(path.join(d, f), 0, cst);
      if (why) return why;
    }
    const why = farAlternates(path.join(d, 'objects'), 0, new Set());
    if (why) return why;
  }
  return '';
}
// Is this path part .git, in any spelling Windows takes for it?
function isGitPart(c) {
  const n = String(c).replace(/:.*$/, '').replace(/[. ]+$/, '').toLowerCase();
  return n === '.git' || (WIN && /^git~\d+$/.test(n));
}
// '' when git may run in cwd, else the reason it may not. Every .git from
// cwd up to the root is checked: git passes over one that isn't a valid
// repo and goes on looking above it.
function farGitConfig(cwd) {
  const key = path.resolve(String(cwd || '.'));
  if (farCache.has(key)) return farCache.get(key);
  let why = '';
  const root = path.parse(key).root;
  if (NET_START.test(String(cwd || '')) || NET_START.test(key)) why = 'network-folder';
  else if (key.slice(root.length).split(/[\\/]+/).some(isGitPart)) why = 'inside-gitdir';
  const real = why ? '' : localPath(key);
  if (!why && !real) why = 'network-folder';
  if (!why && real.slice(path.parse(real).root.length).split(/[\\/]+/).some(isGitPart)) why = 'inside-gitdir';
  let d = real;
  for (let i = 0; !why; i++) {
    if (i > 512) { why = 'deep-folder'; break; }
    const g = path.join(d, '.git');
    let found = false;
    try { fs.lstatSync(g); found = true; } catch { found = false; }
    if (found) why = farGit(g);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (farCache.size > 64) farCache.clear();
  farCache.set(key, why);
  return why;
}
// For a submodule's or nested repo's folder (git status looks into them).
function farNested(dir) {
  const real = localPath(dir);
  if (!real) return 'network-folder';
  return farGit(path.join(real, '.git'));
}

module.exports = { farGitConfig, farNested, localPath, findGit, gitPath, gitEnv, GIT_GLOBAL };

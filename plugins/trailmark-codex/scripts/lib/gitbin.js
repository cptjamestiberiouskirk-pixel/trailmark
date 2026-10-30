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
// sign-in hash. So before git runs in a folder, the .git above it is read as
// text, and a network path in any of those places (\\server, //server, or an
// NT path such as \??\UNC\server) keeps git out of that folder. Included
// config files that are local are read the same way, five deep.
const NET_START = /^[\\/]{2}|^[\\/]\?\?[\\/]/;
const farCache = new Map();
// A value as git might read it: quotes dropped and escapes undone. Both the
// raw and the decoded spelling are checked, so neither can hide a share.
function netText(s) {
  const raw = String(s).replace(/"/g, '').trim();
  const dec = raw.replace(/\\\\/g, '\\').trim();
  return NET_START.test(raw) || NET_START.test(dec);
}
// null when the file is missing; UNSAFE when it is there but can't be read
// as a plain small file (a link, a folder, too big, no access), since git
// would still follow it.
const UNSAFE = Symbol('unsafe');
function readSmall(file, max) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e && e.code === 'ENOENT' || e && e.code === 'ENOTDIR' ? null : UNSAFE; }
  if (!st.isFile() || st.size > max) return UNSAFE;
  try { return fs.readFileSync(file, 'utf8'); } catch { return UNSAFE; }
}
// Logical config lines: a line ending in a backslash goes on to the next.
function configLines(text) {
  return text.replace(/\\\r?\n/g, '').split(/\r?\n/);
}
function farConfig(file, depth, seen) {
  if (depth > 5 || seen.has(file)) return '';
  seen.add(file);
  const text = readSmall(file, 512 * 1024);
  if (text === null) return '';
  if (text === UNSAFE) return 'unreadable-config';
  for (let line of configLines(text)) {
    line = line.replace(/^\s*\[[^\]]*\]/, '');
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const value = line.slice(eq + 1);
    if (netText(value)) return 'network-config';
    if (/^\s*path\s*$/i.test(line.slice(0, eq))) {
      let p = value.replace(/"/g, '').replace(/\\\\/g, '\\').trim();
      if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
      const why = farConfig(path.resolve(path.dirname(file), p), depth + 1, seen);
      if (why) return why;
    }
  }
  return '';
}
function gitdirAt(base, t) {
  if (netText(t)) return null;
  const r = path.resolve(base, t.trim());
  return NET_START.test(r) ? null : r;
}
function farGit(gitEntry) {
  let st;
  try { st = fs.lstatSync(gitEntry); } catch { return ''; }
  let gitdir = gitEntry;
  if (st.isSymbolicLink()) {
    let t = '';
    try { t = fs.readlinkSync(gitEntry); } catch { return 'network-gitdir'; }
    gitdir = gitdirAt(path.dirname(gitEntry), t);
    if (!gitdir) return 'network-gitdir';
  } else if (st.isFile()) {
    const t = readSmall(gitEntry, 4096);
    if (t === UNSAFE) return 'unreadable-config';
    const m = t === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(t);
    if (!m) return '';
    gitdir = gitdirAt(path.dirname(gitEntry), m[1]);
    if (!gitdir) return 'network-gitdir';
  }
  const dirs = [gitdir];
  const common = readSmall(path.join(gitdir, 'commondir'), 4096);
  if (common === UNSAFE) return 'unreadable-config';
  if (common !== null && common.trim()) {
    const c = gitdirAt(gitdir, common);
    if (!c) return 'network-gitdir';
    dirs.push(c);
  }
  for (const d of dirs) {
    for (const f of ['config', 'config.worktree']) {
      const why = farConfig(path.join(d, f), 0, new Set());
      if (why) return why;
    }
    const alt = readSmall(path.join(d, 'objects', 'info', 'alternates'), 64 * 1024);
    if (alt === UNSAFE) return 'unreadable-config';
    if (alt !== null && alt.split(/\r?\n/).some(netText)) return 'network-config';
  }
  return '';
}
// '' when git may run in cwd, else the reason it may not. The .git is the
// first one in cwd or a folder above it, as git finds it.
function farGitConfig(cwd) {
  const key = path.resolve(String(cwd || '.'));
  if (farCache.has(key)) return farCache.get(key);
  let why = '';
  let d = key;
  for (let i = 0; i < 64; i++) {
    const g = path.join(d, '.git');
    let found = false;
    try { fs.lstatSync(g); found = true; } catch { found = false; }
    if (found) { why = farGit(g); break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (farCache.size > 64) farCache.clear();
  farCache.set(key, why);
  return why;
}

module.exports = { farGitConfig, findGit, gitPath, gitEnv, GIT_GLOBAL };

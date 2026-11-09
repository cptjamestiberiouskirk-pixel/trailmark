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
    // The look-behind keeps a long run of separators linear: see pathKey.
    let r = p.resolve(x).replace(/(?<![\\/])[\\/]+$/, '');
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
// - Alternates are followed six deep, as git 2.43 reads them, C-quoted lines
//   decoded; each alternate's own folders are walked for links, and so is an
//   LFS store next to a first-level one (git-lfs looks there).
// - Every .git from the folder up to the drive's root is checked, not only
//   the first: git passes over a .git that isn't a valid repo and keeps going.
// - A folder inside a .git is never used (git may take it for a submodule's
//   or worktree's own repo), whatever its Windows spelling (GIT~1, ".git.").
// - On Windows a drive-relative path (C:x) or a root-relative one (\x) in a
//   pointer is refused: git and this check would resolve it differently.
// Not covered: a link planted in place of a single loose object file, or
// in a Git LFS or git-annex store past its first 10,000 entries. A gitdir
// past its first 100,000 other entries keeps git out.
const NET_START = /^[\\/]{2}|^[\\/]\?\?[\\/]/;
const WIN = process.platform === 'win32';
// The network share the session itself works in (\\server\share), while one
// check runs: git may reach that share, since the user opened the repo there
// (\\wsl$\..., a company share), but no other. Long forms (\\?\UNC) aren't
// taken as a share of their own and stay refused.
let ALLOW_SHARE = '';
function shareRoot(p) {
  const m = /^[\\/]{2}(?![?.][\\/])([^\\/]+)[\\/]([^\\/]+)/.exec(String(p));
  return m ? ('//' + m[1] + '/' + m[2]).toLowerCase() : '';
}
function blocked(p) {
  if (!NET_START.test(p)) return false;
  return !(ALLOW_SHARE && shareRoot(p) === ALLOW_SHARE);
}
function withShare(cwd, fn) {
  const prev = ALLOW_SHARE;
  const prevSeen = LSTAT_SEEN;
  ALLOW_SHARE = NET_START.test(String(cwd || '')) ? shareRoot(cwd) : '';
  if (!LSTAT_SEEN) LSTAT_SEEN = new Map();
  try { return fn(); } finally { ALLOW_SHARE = prev; LSTAT_SEEN = prevSeen; }
}
// What localPath found for each part of a path, while one check runs (the
// outermost withShare call): every path it resolves starts with the same
// folders, so a superproject with 200 module gitdirs looked at each of them
// about 15 times. Dropped when that check returns, since a folder can be
// swapped for a link between two checks.
let LSTAT_SEEN = null;
const MAX_LSTAT_SEEN = 20000;
function lstatPart(p) {
  if (!LSTAT_SEEN) return fs.lstatSync(p);
  let r = LSTAT_SEEN.get(p);
  if (r === undefined) {
    try { r = fs.lstatSync(p); } catch (e) { r = e instanceof Error ? e : new Error('lstat'); }
    if (LSTAT_SEEN.size >= MAX_LSTAT_SEEN) LSTAT_SEEN.clear();
    LSTAT_SEEN.set(p, r);
  }
  if (r instanceof Error) throw r;
  return r;
}
const farCache = new Map();
// A value as git might read it: quotes dropped and escapes undone. Both the
// raw and the decoded spelling are checked, so neither can hide a share.
function netText(s) {
  const raw = String(s).replace(/"/g, '').trim();
  const dec = raw.replace(/\\\\/g, '\\').trim();
  if (/^%\(prefix\)/i.test(raw)) return true;
  return blocked(raw) || blocked(dec);
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
// a + sep + b without normalizing (b absolute: b), so '..' is taken where it
// stands. On Windows paths are normalized as text first, as Windows does.
function rawJoin(a, b) {
  if (path.isAbsolute(b)) return WIN ? path.resolve(b) : b;
  if (WIN) return path.resolve(a, b);
  // Not Windows here: only / separates (a backslash is part of a name).
  return /\/$/.test(a) ? a + b : a + path.sep + b;
}
// The pointer text git uses, refused (null) when it starts or ends with
// whitespace or holds a line break: git keeps such characters, and this
// check would otherwise look at a different file than git opens.
// A NUL is refused too: git reads a pointer up to a NUL, so the check would
// look at a different path than git opens. So is U+FFFD, which is what Node
// makes of bytes that aren't valid UTF-8: git opens the raw bytes (Git for
// Windows maps them to other characters), a path this check can't name.
function exactPointer(t) {
  const v = String(t).replace(/[\r\n]+$/, '');
  return /^\s|\s$|[\r\n\0\uFFFD]/.test(v) ? null : v;
}
function localPath(p) {
  // A NUL ends the path for git but makes Node throw, and U+FFFD stands for
  // bytes that aren't valid UTF-8 (see exactPointer): never taken as local.
  if (/[\0\uFFFD]/.test(String(p))) return null;
  let cur = WIN ? path.resolve(String(p)) : String(p);
  if (!WIN && !cur.startsWith('/') && !NET_START.test(cur)) cur = rawJoin(process.cwd(), cur);
  if (blocked(cur)) return null;
  for (let hops = 0; hops < 40; hops++) {
    const root = path.parse(cur).root;
    // A backslash is a separator on Windows only; elsewhere it is part of a name.
    const parts = cur.slice(root.length).split(WIN ? /[\\/]+/ : /\/+/).filter(x => x && x !== '.');
    let at = root;
    let relinked = false;
    for (let i = 0; i < parts.length; i++) {
      // '..' after a link goes up from where the link led, as the kernel does.
      if (parts[i] === '..') { at = path.dirname(at); continue; }
      const next = path.join(at, parts[i]);
      let st;
      // A part that isn't there: the rest can't be looked through. A '..'
      // after it would climb back by text into folders never checked (the
      // kernel would stop at the missing part), so that is refused.
      try { st = lstatPart(next); } catch { return parts.slice(i + 1).includes('..') ? null : path.resolve(at, ...parts.slice(i)); }
      if (st.isSymbolicLink()) {
        let t;
        try { t = fs.readlinkSync(next); } catch { return null; }
        if (netText(t) || oddRelative(t) || t.includes('\uFFFD')) return null;
        const rest = parts.slice(i + 1).join(path.sep);
        cur = rawJoin(at, t);
        if (rest) cur = rawJoin(cur, rest);
        if (blocked(cur)) return null;
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
// A config file with no quotes or backslashes, read the way git does:
// [section] or [section.sub] headers, key = value, a key alone is true,
// comments from # or ; on. null when a line doesn't fit that shape, or
// holds anything but printable ASCII after its indent: git's own idea of
// whitespace (space, tab, CR, LF only, a tab inside a value read as a space)
// and a NUL that ends its value differ from JavaScript's, so git reads those.
function plainConfig(text) {
  if (/[^\t\r\n\x20-\x7E]/.test(text)) return null;
  const out = [];
  let sec = '';
  for (let line of text.split(/\r?\n/)) {
    if (/[\t\r]/.test(line.replace(/^[ \t]+/, ''))) return null;
    line = line.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    let m = /^\[\s*([A-Za-z0-9.-]+)\s*\]$/.exec(line);
    if (m) { sec = m[1].toLowerCase(); continue; }
    m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!m || !sec) return null;
    out.push([`${sec}.${m[1].toLowerCase()}`, m[2] === undefined ? 'true' : m[2].trim()]);
  }
  return out;
}
// [key, value] pairs of one config file as git reads it, includes not
// followed; null when the file is missing, UNSAFE when git can't read it.
function configEntries(file) {
  const st = readSmall(file, 8 * 1024 * 1024);
  if (st === null || st === UNSAFE) return st;
  // No backslash, no quote, no '//', no %( and no include: no value in it
  // can name a network path or another file, so git isn't started for it.
  // (Quotes and backslashes are what git's value parser joins or decodes:
  // /""/server/share reads as //server/share.)
  // A key that names a file or folder (attributesFile, mailmap.file,
  // worktree, lfs.storage and the like) is read too: its value may be a
  // plain name that is a link.
  if (!/[\\"]|\/\/|%\(|include|(?:file|path|dir|storage|template|worktree)\s*=/i.test(st)) return [];
  // No backslash, quote, '//', %( or include, but a key that names a file
  // (a submodule's worktree = ../../sub, say): with nothing to decode, the
  // text is read here without starting git, as git reads such a file.
  if (!/[\\"]|\/\/|%\(|include/i.test(st)) { const e = plainConfig(st); if (e) return e; }
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
const REMOTE_ADDRESS = /^remote\..+\.(?:url|pushurl)$|^url\..+\.(?:insteadof|pushinsteadof)$|^submodule\..+\.url$/i;
// Settings whose value names a file or folder git may open (core.attributesFile,
// core.excludesFile, core.worktree, mailmap.file, lfs.storage and the like),
// judged by the last part of the key's name.
const PATH_KEY = /(?:file|path|dir|storage|template|worktree)$/i;
// A file or folder named by a setting: absolute, ~/, or relative to any
// folder git might take it from (the worktree, the gitdir, the session's
// folder). '' when every reading of it is local, else the reason.
// ~<you>/... is your own home folder: the length of that prefix, or 0.
function ownTilde(p) {
  let me = '';
  try { me = os.userInfo().username; } catch { return 0; }
  const m = /^~([^\\/]+)[\\/]/.exec(p);
  return m && me && (WIN ? m[1].toLowerCase() === me.toLowerCase() : m[1] === me) ? m[0].length : 0;
}
// A base folder, links followed, that isn't there. False for anything else,
// a base that leads to a share included: that one is refused where it is
// read.
function missingBase(b) {
  const r = localPath(b);
  if (!r) return false;
  try { fs.lstatSync(r); return false; } catch (e) { return !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'); }
}
function farPathValue(value, bases, key = '') {
  const v = exactPointer(value);
  if (v === null) return 'odd-config-path';
  if (!v) return '';
  // The null device, a common way to switch a file setting off.
  if (/^(?:\/dev\/null|nul)$/i.test(v)) return '';
  if (oddRelative(v)) return 'odd-config-path';
  let p = v;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  else if (ownTilde(p)) p = path.join(os.homedir(), p.slice(ownTilde(p)));
  else if (p.startsWith('~')) return 'odd-config-path';
  // Both readings: links followed first (as git does), and '..' taken as
  // text first (as git-lfs does). From a base folder that isn't there (the
  // worktree of a removed submodule, say) the first reading reaches nothing,
  // since the kernel stops at the missing folder, so only the second is
  // checked. localPath would refuse it, as it refuses any '..' after a part
  // that isn't there.
  const tries = path.isAbsolute(p) ? [p, path.resolve(p)] : bases.filter(Boolean).flatMap(b => (missingBase(b) ? [path.resolve(b, p)] : [rawJoin(b, p), path.resolve(b, p)]));
  const walked = new Set();
  for (const t of tries) {
    const real = localPath(t);
    if (!real) return 'network-config';
    // git-lfs keeps objects and temp files in lfs.storage: walked like a gitdir.
    if (/^lfs\.storage$/i.test(key)) {
      let isDir = false;
      try { isDir = fs.statSync(real).isDirectory(); } catch { isDir = false; }
      const k = WIN ? real.toLowerCase() : real;
      if (isDir && !walked.has(k)) { walked.add(k); const why = linkedEntries(real, { lfsStore: true }); if (why) return why; }
    }
  }
  return '';
}
const MAX_INCLUDE_DEPTH = 10;
const MAX_CONFIG_FILES = 50;
// st: { seen, files } shared by one whole check.
// file is the path as git builds it (a relative include is taken from the
// folder of that path, not of where a link led); it is read at its real path.
function farConfig(file, depth, st) {
  if (depth > MAX_INCLUDE_DEPTH) return 'deep-config';
  const real = localPath(file);
  if (!real) return 'network-config';
  // Each path as git builds it, not each real file: a file reached two ways
  // has relative includes that differ by the way. On Windows git takes '..'
  // as text first; elsewhere '..' goes up from where a link led, so the path
  // is kept as written (two spellings that collapse to the same text may be
  // different files).
  const seenKey = WIN ? path.resolve(file).toLowerCase() : file;
  if (st.seen.has(seenKey)) return '';
  st.seen.add(seenKey);
  if (++st.files > MAX_CONFIG_FILES) return 'many-config-files';
  const entries = configEntries(real);
  if (entries === null) return '';
  if (entries === UNSAFE) return 'unreadable-config';
  for (const [key, value] of entries) {
    // A remote's address is used only to fetch and push, and every transport
    // is off in the calls made here (GIT_ALLOW_PROTOCOL, protocol.*.allow,
    // GIT_NO_LAZY_FETCH), so a remote on a share doesn't keep git out.
    if (REMOTE_ADDRESS.test(key)) continue;
    if (netText(value)) return 'network-config';
    if (PATH_KEY.test(key) && !/^include\.path$|^includeif\..*\.path$/i.test(key)) {
      // Checked once every config file is read: a core.worktree anywhere
      // moves git, and relative values are then taken from there too.
      (st.pending = st.pending || []).push({ key, value, file });
      continue;
    }
    if (!/^include\.path$|^includeif\..*\.path$/i.test(key)) continue;
    let p = exactPointer(value);
    if (p === null || oddRelative(p)) return 'odd-config-path';
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
    else if (ownTilde(p)) p = path.join(os.homedir(), p.slice(ownTilde(p)));
    else if (p.startsWith('~')) return 'odd-config-path';
    const why = farConfig(rawJoin(path.dirname(file), p), depth + 1, st);
    if (why) return why;
  }
  return '';
}
// The entries of an alternates file, read as git reads them
// (parse_alt_odb_entry, unquote_c_style): one per line; a line starting with
// '#' is a comment; a line starting with '"' is C-quoted, its \ooo escapes
// raw bytes. null (keep git out) where git and this check could read
// different paths: quoting git would reject (it then takes the raw text),
// text after the closing quote (git reads it as another entry), or escapes
// that aren't valid UTF-8.
function altEntries(text) {
  const out = [];
  const map = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  let i = 0;
  while (i < text.length) {
    let nl = text.indexOf('\n', i);
    if (nl < 0) nl = text.length;
    const raw = text.slice(i, nl);
    if (raw[0] === '#' || raw === '') { i = nl + 1; continue; }
    if (raw[0] !== '"') { out.push({ raw, line: raw }); i = nl + 1; continue; }
    const bytes = [];
    let k = i + 1;
    let closed = false;
    while (k < text.length) {
      // One character at a time (a code point, not half of a pair).
      const ch = String.fromCodePoint(text.codePointAt(k));
      if (ch === '"') { closed = true; k++; break; }
      if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); k += ch.length; continue; }
      const e = text[k + 1];
      if (e !== undefined && Object.prototype.hasOwnProperty.call(map, e)) { bytes.push(map[e]); k += 2; continue; }
      if (/^[0-3][0-7][0-7]$/.test(text.slice(k + 1, k + 4))) { bytes.push(parseInt(text.slice(k + 1, k + 4), 8)); k += 4; continue; }
      return null;
    }
    if (!closed || k !== nl) return null;
    let line;
    // ignoreBOM: a BOM is part of the name for git, so it stays in (and a
    // leading one is then refused with the other leading whitespace).
    try { line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(bytes)); } catch { return null; }
    out.push({ raw, line });
    i = nl + 1;
  }
  return out;
}
// The alternates of one objects folder and theirs, as deep as git goes (git
// 2.43 reads the sixth one's too).
function farAlternates(objects, depth, seen, tops = []) {
  if (depth > 6) return '';
  const real = localPath(objects);
  if (!real) return 'network-config';
  if (seen.has(real)) return '';
  seen.add(real);
  // An alternate's own folders (pack/, info/, its loose objects) are read
  // like the repo's: no link in them may lead to a share.
  if (depth > 0) { const linked = linkedEntries(real, { objectsRoot: true }); if (linked) return linked; }
  const alt = readSmall(path.join(real, 'info', 'alternates'), 64 * 1024);
  if (alt === null) return '';
  if (alt === UNSAFE) return 'unreadable-config';
  // Windows can't name a file with a CR in it, so a CRLF file reads the same
  // there; elsewhere a CR stays part of the path, as git keeps it.
  const entries = altEntries(WIN ? alt.replace(/\r\n/g, '\n') : alt);
  if (!entries) return 'odd-config-path';
  for (const { raw, line } of entries) {
    if (/^\s|\s$|[\0\r\n\uFFFD]/.test(line) || /[\0\uFFFD]/.test(raw)) return 'odd-config-path';
    if (netText(raw) || netText(line)) return 'network-config';
    if (oddRelative(line)) return 'odd-config-path';
    // git-lfs looks for an LFS store next to each first-level alternate
    // (<alt>/../lfs, '..' taken as text, a relative line from the worktree).
    if (depth === 0) {
      const alt = rawJoin(real, line);
      const sib = [path.resolve(alt, '..', 'lfs'), path.join(path.dirname(localPath(alt) || alt), 'lfs')];
      if (!path.isAbsolute(line)) for (const t of tops) sib.push(path.resolve(t, line, '..', 'lfs'));
      for (const c of sib) {
        const r = localPath(c);
        if (!r) return 'network-config';
        let isDir = false;
        try { isDir = fs.lstatSync(r).isDirectory(); } catch { isDir = false; }
        if (isDir) { const linked = linkedEntries(r, { lfsStore: true }); if (linked) return linked; }
      }
    }
    const why = farAlternates(rawJoin(real, line), depth + 1, seen);
    if (why) return why;
  }
  return '';
}
// A pointer read from a file (gitdir:, commondir), resolved locally; null
// when it is, or leads through a link to, a network path or is ambiguous.
function gitdirAt(base, t) {
  const v = exactPointer(t);
  if (v === null || !v || netText(v) || oddRelative(v)) return null;
  return localPath(rawJoin(base, v));
}
// No link in a gitdir that leads to a network path: git reads its logs,
// info, packs, the split index and more. A link to a local place is followed
// and what it leads to is walked too (tools such as git-new-workdir and
// Android's repo link a gitdir's entries). hooks/ is left out: hooks never
// run (core.hooksPath is set). Loose object files (objects/xx/...) aren't
// walked, as there can be very many; past 100,000 other entries git is kept
// out (many-entries), since a link could hide past them.
// '' when nothing in the gitdir is a link to a network path, else the reason.
// Folders deeper than MAX_GITDIR_DEPTH (far past nested submodules with deep
// branch names) aren't walked, so a gitdir that has one is refused rather
// than passed.
const MAX_GITDIR_DEPTH = 64;
// objectsRoot: gitdir is an objects folder itself (an alternate's), whose
// two-hex loose-object folders are skipped like the gitdir's own.
// lfsStore: gitdir is a git-lfs store (lfs.storage, or one next to an
// alternate): its objects/ab/cd folders are walked too. A gitdir's own lfs/
// is walked last, on a budget of its own (LFS_BUDGET), so a large LFS store
// can't use up the budget for git's own folders.
const LFS_BUDGET = 10000;
// A gitdir's own entries (loose objects and the LFS and annex stores aside):
// about 50,000 unpacked branches with their reflogs, walked in well under a
// second.
const GITDIR_BUDGET = 100000;
// A HEAD in d (a file or a link, as git accepts either).
function headAt(d) {
  try { const h = fs.lstatSync(path.join(d, 'HEAD')); return h.isFile() || h.isSymbolicLink(); } catch { return false; }
}
// Only plain files in d, as in a loose-object folder (no folder, link or
// anything else that could hide a gitdir); false when d can't be listed.
function onlyFiles(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).every(x => x.isFile()); } catch { return false; }
}
// A listing that failed: '' when the folder is gone (removed meanwhile, or
// not a folder), 'odd-path' when it is still there. On a file system that
// reports no entry types, Node lstat's each name it decoded, and a name that
// isn't valid UTF-8 then fails as ENOENT: the folder would be passed over
// unchecked though git can read it. A folder no one may read (EACCES) is
// passed over as before: git can't read it either.
function unlisted(d, e) {
  const code = e && e.code;
  if (code !== 'ENOENT' && code !== 'ENOTDIR') return '';
  try { return fs.lstatSync(d).isDirectory() ? 'odd-path' : ''; } catch { return ''; }
}
function linkedEntries(gitdir, { objectsRoot = false, lfsStore = false } = {}) {
  // JBMEM_TEST_GITDIR_BUDGET can only lower it (the tests use 20,000).
  const low = Number(process.env.JBMEM_TEST_GITDIR_BUDGET);
  const main = { n: lfsStore ? LFS_BUDGET : (low > 0 && low < GITDIR_BUDGET ? low : GITDIR_BUDGET), lfs: lfsStore };
  const seen = new Set();
  let lfsLater = null;
  // top: the path (below gitdir) of the gitdir d is in, '' for gitdir itself,
  // or a submodule's under modules/, so a submodule's own refs aren't taken
  // for one.
  const walk = (d, rel, depth, budget, top = '') => {
    const below = top ? rel.slice(top.length + 1) : rel;
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return unlisted(d, e); }
    for (const x of list) {
      // Past the budget: the rest isn't looked at. In the gitdir's own
      // folders that keeps git out, since a link could hide past it; a big
      // LFS store (its own budget) is let through.
      if (--budget.n < 0) return budget.lfs ? '' : 'many-entries';
      // A name that isn't valid UTF-8 can't be looked up by the name Node
      // gives. A plain file (a branch or its reflog, say) is never followed,
      // so it is passed over; a folder or link with one keeps git out.
      if (x.name.includes('\uFFFD')) { if (x.isFile()) continue; return 'odd-path'; }
      if (!rel && !objectsRoot && x.name === 'hooks') continue;
      if (!rel && !objectsRoot && !lfsStore && x.name === 'lfs' && !lfsLater) { lfsLater = x; continue; }
      // A submodule gitdir's own LFS store, and git-annex's object store, can
      // be large too: each is walked on a budget of its own, but only right
      // at a gitdir's top (rel === top).
      if (!objectsRoot && !lfsStore && x.isDirectory() && rel === top && ((x.name === 'lfs' && rel) || x.name === 'annex')) {
        const why = walk(path.join(d, x.name), rel ? rel + '/' + x.name : x.name, depth + 1, { n: LFS_BUDGET, lfs: true }, top);
        if (why) return why;
        continue;
      }
      let sub = path.join(d, x.name);
      let isDir = x.isDirectory();
      if (x.isSymbolicLink()) {
        const real = localPath(sub);
        if (!real) return 'linked-gitdir';
        try { isDir = fs.statSync(real).isDirectory(); } catch { isDir = false; }
        sub = real;
      }
      if (!isDir) continue;
      // Loose-object folders of git's own object stores only (objects/ and a
      // submodule's modules/.../objects/): a branch may be named objects/ab
      // (refs/heads/objects/ab/...), and git-lfs keeps lfs/objects/ab/cd.
      // A folder under modules/ with no HEAD (left behind by a removed
      // submodule) isn't a gitdir git opens: its objects/ is skipped the same
      // way, so a large one can't use up the budget.
      // A submodule may also be named like vendor/objects/ab (or
      // vendor/objects/ab/child): its gitdir is then inside such a leftover's
      // objects/, so there a folder is passed over only when it has no HEAD
      // and holds plain files only, as loose objects do; else it is walked.
      // A real submodule gitdir's own two-hex folders are passed over
      // unlisted: looking into each (even for a HEAD only) took seconds on
      // Windows with 200 submodules of 256 folders each. git 2.56 won't
      // make a submodule vendor/objects/ab when vendor is one ("is inside
      // git dir"), and opens a gitdir there only through a submodule's .git
      // file, which farNested checks first (seen 2026-11-05).
      const own = lfsStore ? false : objectsRoot ? rel === '' : rel === (top ? top + '/objects' : 'objects');
      const leftover = !lfsStore && !objectsRoot && !own && /^modules\/.+\/objects$/.test(below);
      if ((own || leftover) && /^[0-9a-f]{2}$/i.test(x.name) && !(leftover && (headAt(sub) || !onlyFiles(sub)))) continue;
      if (depth >= MAX_GITDIR_DEPTH) return 'deep-gitdir';
      const k = WIN ? sub.toLowerCase() : sub;
      if (seen.has(k)) continue;
      seen.add(k);
      // A folder under this gitdir's modules/ with a HEAD (a file or a link,
      // as git accepts either) is a submodule's gitdir: the top below it.
      const childRel = rel ? rel + '/' + x.name : x.name;
      const childBelow = below ? below + '/' + x.name : x.name;
      let childTop = top;
      if (!objectsRoot && !lfsStore && /^modules\/./.test(childBelow)) {
        if (headAt(sub)) childTop = childRel;
      }
      const why = walk(sub, childRel, depth + 1, budget, childTop);
      if (why) return why;
    }
    return '';
  };
  const why = walk(gitdir, '', 0, main);
  if (why || !lfsLater) return why;
  // The lfs/ folder (a link to a share there is refused like any other).
  let sub = path.join(gitdir, 'lfs');
  if (lfsLater.isSymbolicLink()) { const real = localPath(sub); if (!real) return 'linked-gitdir'; sub = real; }
  let isDir = false;
  try { isDir = fs.statSync(sub).isDirectory(); } catch { isDir = false; }
  return isDir ? walk(sub, 'lfs', 1, { n: LFS_BUDGET, lfs: true }) : '';
}
// Is this a gitdir git would accept: HEAD there, objects and refs in it or
// in its commondir.
function validGitdir(gitdir, common) {
  const base = common || gitdir;
  let head = '';
  // readSmall: a FIFO or a huge file as HEAD would hang or stall the read.
  const t = readSmall(path.join(gitdir, 'HEAD'), 4096);
  if (t === null || t === UNSAFE) return false;
  head = t.slice(0, 200);
  if (!/^ref: refs\/|^[0-9a-f]{40}|^[0-9a-f]{64}/.test(head)) return false;
  // Resolved a part at a time first, so a link to a share is never stat-ed
  // through; and searchable, as git requires (access X_OK), so a decoy git
  // passes over isn't taken for the repo.
  const usable = (q) => {
    const r = localPath(q);
    if (!r) return false;
    try {
      if (!fs.statSync(r).isDirectory()) return false;
      if (!WIN) fs.accessSync(r, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  return usable(path.join(base, 'objects')) && usable(path.join(base, 'refs'));
}
// '' when every worktrees/<id>/commondir and gitdir in wt leads to a local
// place, else the reason. Up to 10,000 worktrees are read; past that, git is kept out.
// The worktrees folder, or an entry in it, may be a link: git reads through
// it, so it is resolved a part at a time first (a link to a share is never
// listed or read through), and the files are read where it leads. A relative
// commondir or gitdir there is checked from both the link and where it leads.
const MAX_WORKTREES = 10000;
function realFolder(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return { dir: '' }; }
  if (st.isDirectory()) return { dir: p };
  if (!st.isSymbolicLink()) return { dir: '' };
  const real = localPath(p);
  if (!real) return { why: 'linked-gitdir' };
  try { return { dir: fs.statSync(real).isDirectory() ? real : '' }; } catch { return { dir: '' }; }
}
function otherWorktrees(wt) {
  const top = realFolder(wt);
  if (top.why) return top.why;
  if (!top.dir) return '';
  let names;
  try { names = fs.readdirSync(top.dir); } catch { return ''; }
  if (names.length > MAX_WORKTREES) return 'many-worktrees';
  for (const n of names) {
    if (n.includes('\uFFFD')) return 'odd-path';
    const d = path.join(wt, n);
    const r = realFolder(path.join(top.dir, n));
    if (r.why) return r.why;
    if (!r.dir) continue;
    const bases = [...new Set([d, path.join(top.dir, n), r.dir])];
    const c = readSmall(path.join(r.dir, 'commondir'), 4096);
    if (c === UNSAFE) return 'unreadable-config';
    if (c !== null && c.replace(/[\r\n]+$/, '') && bases.some(b => !gitdirAt(b, c))) return 'network-gitdir';
    // The worktree's own folder, as recorded in gitdir: git 2.56 looks it up
    // for rev-list --all (and git worktree list), relative paths included
    // (worktree.useRelativePaths), so one that leads to a network path, or
    // through a link to one, keeps git out too.
    const g = readSmall(path.join(r.dir, 'gitdir'), 4096);
    if (g === UNSAFE) return 'unreadable-config';
    if (g !== null && g.replace(/[\r\n]+$/, '') && bases.some(b => !gitdirAt(b, g))) return 'network-gitdir';
  }
  return '';
}
// What git reads when it tries a folder as a bare repo before
// safe.bareRepository=explicit refuses it (is_git_directory, git 2.43): HEAD,
// which must look like a head (a link is opened through), then commondir and
// the objects and refs folders it names. Nothing else: config, alternates and
// links inside aren't read. '' or the reason.
// safe.bareRepository needs git 2.38: an older git uses a bare repo it finds,
// so there the whole folder is checked like a gitdir. Unknown counts as old.
let bareRefusedCache;
function bareRefused() {
  if (bareRefusedCache !== undefined) return bareRefusedCache;
  bareRefusedCache = false;
  const bin = gitPath(__dirname);
  if (!bin) return false;
  try {
    const v = /git version (\d+)\.(\d+)/.exec(execFileSync(bin, ['--version'], { cwd: __dirname, env: gitEnv(), encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
    bareRefusedCache = !!v && (+v[1] > 2 || (+v[1] === 2 && +v[2] >= 38));
  } catch { /* unknown: old */ }
  return bareRefusedCache;
}
function farBareProbe(d) {
  const h = path.join(d, 'HEAD');
  let st;
  try { st = fs.lstatSync(h); } catch { return ''; }
  let file = h;
  let valid = false;
  if (st.isSymbolicLink()) {
    let t = '';
    try { t = fs.readlinkSync(h); } catch { return 'unreadable-config'; }
    if (t.includes('\uFFFD')) return 'unreadable-config';
    file = localPath(h);
    if (!file) return 'network-gitdir';
    if (/^refs\//.test(t)) valid = true;
    else {
      try { st = fs.statSync(file); } catch { return ''; }
    }
  }
  if (!valid) {
    if (!st.isFile()) return '';
    let text = '';
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
      const buf = Buffer.alloc(256);
      text = buf.subarray(0, fs.readSync(fd, buf, 0, 256, 0)).toString('latin1');
    } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } } // git can't read it either
    if (!/^ref:\s*refs\/|^[0-9a-f]{40}/i.test(text)) return '';
  }
  let base = d;
  const common = readSmall(path.join(d, 'commondir'), 4096);
  if (common === UNSAFE) return 'unreadable-config';
  if (common !== null && common.replace(/[\r\n]+$/, '')) {
    base = gitdirAt(d, common);
    if (!base) return 'network-gitdir';
  }
  for (const s of ['objects', 'refs']) if (!localPath(path.join(base, s))) return 'network-gitdir';
  // An older git that takes such a folder as a repo (objects and refs there)
  // reads all of it, so then all of it is checked.
  if (!bareRefused()) {
    const usable = ['objects', 'refs'].every(s => { try { return fs.statSync(localPath(path.join(base, s))).isDirectory(); } catch { return false; } });
    return usable ? farGit(d) : '';
  }
  return '';
}
// light: for a submodule gitdir in modules/ (its links were walked with the
// repo's gitdir); the rest of the checks are the same.
// locate: only find the gitdir and commondir (out), for localRepoRoot; '' or
// a reason found on the way there, and no config read, so no git call.
function farGit(gitEntry, out = {}, { light = false, locate = false } = {}) {
  let st;
  try { st = fs.lstatSync(gitEntry); } catch { return ''; }
  let gitdir = gitEntry;
  if (st.isSymbolicLink()) {
    // On Windows git takes '..' in a relative pointer or include as text from
    // the .git it was given, while the check would start where the link led:
    // a .git that is a link or junction there keeps git out.
    if (WIN) return 'linked-gitdir';
    gitdir = localPath(gitEntry);
    if (!gitdir) return 'network-gitdir';
    try { st = fs.statSync(gitdir); } catch { return ''; }
  }
  if (st.isFile()) {
    const t = readSmall(gitEntry, 4096);
    if (t === UNSAFE) return 'unreadable-config';
    // git: the file must start with "gitdir: "; the rest, less trailing line
    // breaks, is the path.
    if (t === null || !t.startsWith('gitdir: ')) return '';
    gitdir = gitdirAt(path.dirname(gitdir), t.slice(8));
    if (!gitdir) return 'network-gitdir';
  } else if (!st.isDirectory()) return '';
  const dirs = [gitdir];
  const common = readSmall(path.join(gitdir, 'commondir'), 4096);
  if (common === UNSAFE) return 'unreadable-config';
  if (common !== null && common.replace(/[\r\n]+$/, '')) {
    const c = gitdirAt(gitdir, common);
    if (!c) return 'network-gitdir';
    dirs.push(c);
  }
  out.gitdir = gitdir;
  out.common = dirs[1] || '';
  if (locate) return '';
  // Each other worktree's commondir: git reads the refs there for --all (and
  // a later git version may for more), so one that leads to a network path
  // keeps git out like the repo's own.
  if (!light) {
    for (const d of dirs) {
      const w = otherWorktrees(path.join(d, 'worktrees'));
      if (w) return w;
    }
  }
  // Folders a relative path in a setting may be taken from.
  const cst = { seen: new Set(), files: 0, bases: [path.dirname(gitEntry), gitdir, dirs[1] || '', CHECK_CWD], pending: [] };
  for (const d of dirs) {
    const linked = light ? '' : linkedEntries(d);
    if (linked) return linked;
    for (const f of ['config', 'config.worktree']) {
      const why = farConfig(path.join(d, f), 0, cst);
      if (why) return why;
    }
  }
  // core.worktree (relative to the gitdir whose config set it) is where git
  // runs; it becomes one more folder relative values are taken from.
  const bases = cst.bases.slice();
  for (const e of cst.pending) {
    if (!/^core\.worktree$/i.test(e.key)) continue;
    const v = exactPointer(e.value);
    if (v === null || !v) continue;
    for (const w of path.isAbsolute(v) ? [v] : [rawJoin(gitdir, v), rawJoin(path.dirname(e.file), v)]) {
      const real = localPath(w);
      if (!real) return 'network-config';
      bases.push(real, path.resolve(w));
    }
  }
  for (const e of cst.pending) {
    const why = farPathValue(e.value, bases, e.key);
    if (why) return why;
  }
  for (const d of dirs) {
    // git-lfs takes a relative alternates line from where it runs: the
    // worktree, a core.worktree included.
    const why = farAlternates(path.join(d, 'objects'), 0, new Set(), bases.filter(Boolean));
    if (why) return why;
  }
  return '';
}
// Submodule gitdirs kept in .git/modules (and the commondir's): git status
// may open one by the name in .gitmodules when the submodule's own .git can't
// be used, so before status each is checked like a gitdir (links in them
// were walked with the repo's own). '' or the reason; left() gives the time
// left in ms, and the check stops with 'git-timeout' when it runs short.
function farModules(top, left = () => Infinity) {
  // A relative setting may also be taken from the folder git runs in
  // (CHECK_CWD). git status runs in top, so that is the folder here, not the
  // one the last check in this process happened to look at.
  const prev = CHECK_CWD;
  CHECK_CWD = path.resolve(String(top || '.'));
  try { return farModulesIn(top, left); } finally { CHECK_CWD = prev; }
}
function farModulesIn(top, left) {
  return withShare(top, () => {
    const at = {};
    const g = path.join(top, '.git');
    let st;
    try { st = fs.lstatSync(g); } catch { return ''; }
    if (st.isDirectory()) { at.gitdir = g; } else { farGit(g, at, { light: true }); }
    if (!at.gitdir) return '';
    const dirs = [at.gitdir];
    const common = readSmall(path.join(at.gitdir, 'commondir'), 4096);
    if (typeof common === 'string' && common.replace(/[\r\n]+$/, '')) { const c2 = gitdirAt(at.gitdir, common); if (!c2) return 'network-gitdir'; dirs.push(c2); }
    for (const d of dirs) {
      const mods = moduleGitdirs(path.join(d, 'modules'));
      if (mods.why) return mods.why;
      for (const m of mods.list) {
        if (left() < 800) return 'git-timeout';
        const why = farGit(m, {}, { light: true });
        if (why) return why;
      }
    }
    return '';
  });
}
// Folders under modules/ that hold a HEAD (submodule gitdirs), at most 2000.
// A nested submodule's gitdir is found by farGit on its parent's.
// { list, why }: why is set when the walk can't be sure it found them all
// (too many, too deep, a link to a share), and the caller keeps git out.
const MAX_MODULE_GITDIRS = 2000;
function moduleGitdirs(root) {
  const out = [];
  const seen = new Set();
  let why = '';
  // modules/ itself may be a link: resolved first, never listed through one to a share.
  const top = realFolder(root);
  if (top.why) return { list: out, why: top.why };
  if (!top.dir) return { list: out, why };
  root = top.dir;
  // An entry of folder d, a link followed: { p, dir }, or null for a link
  // that leads to a share (why is set).
  const follow = (d, x) => {
    const p = path.join(d, x.name);
    if (!x.isSymbolicLink()) return { p, dir: x.isDirectory() };
    const real = localPath(p);
    if (!real) { why = 'linked-gitdir'; return null; }
    let dir;
    try { dir = fs.statSync(real).isDirectory(); } catch { dir = false; }
    return { p: real, dir };
  };
  // A gitdir's objects/: a submodule named vendor/objects/x keeps its gitdir
  // there when vendor is one. git 2.56 won't make one by that name, and
  // opens it only through a submodule's .git file, which farNested checks;
  // an older git may open it by name. Every folder there is walked but the
  // two-hex ones, passed over unlisted as in linkedEntries (see there for
  // the cost).
  const objectsIn = (od, depth) => {
    let list;
    try { list = fs.readdirSync(od, { withFileTypes: true }); } catch (e) { why = unlisted(od, e); return; }
    for (const x of list) {
      if (/^[0-9a-f]{2}$/i.test(x.name)) continue;
      if (x.name.includes('\uFFFD')) { if (x.isFile()) continue; why = 'odd-path'; return; }
      const f = follow(od, x);
      if (!f) return;
      if (f.dir) walk(f.p, depth + 1);
      if (why) return;
    }
  };
  const walk = (d, depth) => {
    if (why) return;
    if (out.length >= MAX_MODULE_GITDIRS) { why = 'many-submodules'; return; }
    if (depth > MAX_GITDIR_DEPTH) { why = 'deep-gitdir'; return; }
    const k = WIN ? d.toLowerCase() : d;
    if (seen.has(k)) return;
    seen.add(k);
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { why = unlisted(d, e); return; }
    // A folder with a HEAD (a file or a link, as git accepts either) is a
    // candidate gitdir; the walk goes on inside it too, since a submodule
    // named a/b keeps its gitdir in modules/a/b even when modules/a is one.
    const isGitdir = list.some(x => x.name === 'HEAD' && (x.isFile() || x.isSymbolicLink()));
    if (isGitdir) out.push(d);
    for (const x of list) {
      if (x.name.includes('\uFFFD')) { why = 'odd-path'; return; }
      // A gitdir's own refs (refs/remotes/origin holds a HEAD too), logs, lfs
      // and hooks hold no submodule gitdir; its objects/ may (objectsIn).
      if (isGitdir && /^(refs|lfs|logs|hooks)$/.test(x.name)) continue;
      const f = follow(d, x);
      if (!f) return;
      if (f.dir && isGitdir && x.name === 'objects') {
        const k2 = WIN ? f.p.toLowerCase() : f.p;
        if (!seen.has(k2)) { seen.add(k2); objectsIn(f.p, depth + 1); }
      } else if (f.dir) walk(f.p, depth + 1);
      if (why) return;
    }
  };
  walk(root, 0);
  return { list: out, why };
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
  return withShare(cwd, () => farGitConfigIn(cwd));
}
let CHECK_CWD = '';
function farGitConfigIn(cwd) {
  // Outside Windows, '..' after a link goes up from where the link led, while
  // path.resolve takes it as text: a folder where the two differ is refused,
  // since the check would look at a different folder than git runs in.
  if (!WIN && String(cwd || '').split('/').includes('..')) {
    const raw = String(cwd);
    const a = localPath(path.isAbsolute(raw) ? raw : rawJoin(process.cwd(), raw));
    const b = localPath(path.resolve(raw));
    if (a !== b) return 'odd-path';
  }
  const key = path.resolve(String(cwd || '.'));
  CHECK_CWD = key;
  if (farCache.has(key)) return farCache.get(key);
  let why = '';
  const root = path.parse(key).root;
  if ((NET_START.test(String(cwd || '')) || NET_START.test(key)) && !ALLOW_SHARE) why = 'network-folder';
  else if (key.slice(root.length).split(/[\\/]+/).some(isGitPart)) why = 'inside-gitdir';
  const real = why ? '' : localPath(key);
  if (!why && !real) why = 'network-folder';
  if (!why && real.slice(path.parse(real).root.length).split(/[\\/]+/).some(isGitPart)) why = 'inside-gitdir';
  // The folders above both the path as given and its real path: git may
  // search either (on Windows it may keep the path as given).
  // folder -> true where git would stop (a repo it accepts), false otherwise.
  const seenDirs = new Map();
  for (const start of why ? [] : [real, key]) {
    let d = start;
    for (let i = 0; !why; i++) {
      if (i > 512) { why = 'deep-folder'; break; }
      const k = WIN ? d.toLowerCase() : d;
      if (seenDirs.has(k)) {
        if (seenDirs.get(k)) break;
      } else {
        seenDirs.set(k, false);
        const g = path.join(d, '.git');
        let found = false;
        try { fs.lstatSync(g); found = true; } catch { found = false; }
        let accepted = false;
        if (found) {
          const at = {};
          why = farGit(g, at);
          // git stops at the first repo it accepts; past one it doesn't, it
          // goes on looking, so the check does too.
          if (why) break;
          accepted = !!(at.gitdir && validGitdir(at.gitdir, at.common));
        }
        // git also tries each folder it passes as a gitdir of its own (a
        // bare repo) before safe.bareRepository refuses it, also when the
        // folder has a .git it didn't accept (an empty folder, a dead link):
        // a folder with a HEAD in it gets what git reads there checked
        // (farBareProbe).
        if (!accepted) {
          let head = false;
          try { fs.lstatSync(path.join(d, 'HEAD')); head = true; } catch { head = false; }
          if (head) why = farBareProbe(d);
          if (why) break;
        }
        if (accepted) { seenDirs.set(k, true); break; }
      }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  if (farCache.size > 64) farCache.clear();
  farCache.set(key, why);
  return why;
}
// For a submodule's or nested repo's folder (git status looks into them).
function farNested(dir, base) {
  return withShare(base || dir, () => farNestedIn(dir));
}
function farNestedIn(dir) {
  const real = localPath(dir);
  if (!real) return 'network-folder';
  return farGit(path.join(real, '.git'));
}

// The main checkout's root found without running git, the way git would:
// the first repo it accepts from cwd up; for a worktree, the folder holding
// the shared .git. '' when there is none. Used when git is kept out or timed
// out, so the memory folder is still the one every worktree shares. It reads
// only the .git entries and pointer files (farGit locate), never a config
// file, so it starts no git and keeps within the caller's time.
function localRepoRoot(cwd) {
  return withShare(cwd, () => {
    let d = localPath(path.resolve(String(cwd || '.')));
    for (let i = 0; d && i < 512; i++) {
      const g = path.join(d, '.git');
      let found = false;
      try { fs.lstatSync(g); found = true; } catch { found = false; }
      if (found) {
        const at = {};
        farGit(g, at, { locate: true });
        if (at.gitdir && validGitdir(at.gitdir, at.common)) {
          if (at.common && path.basename(at.common) === '.git') return path.dirname(at.common);
          return d;
        }
      }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    return '';
  });
}

// A worktree's .lfsconfig, which git-lfs reads with includes on while it
// runs as a filter: '' when it is safe, else the reason. It may not be a
// link, and it may not include another file (git-lfs follows those).
function farLfsFile(file, top) {
  let st;
  try { st = fs.lstatSync(file); } catch { return ''; }
  if (!st.isFile()) return 'lfs-config';
  const entries = configEntries(file);
  if (entries === null) return '';
  if (entries === UNSAFE) return 'lfs-config';
  return farLfsEntries(entries, top);
}
// The same rules for .lfsconfig's settings however they were read (from the
// worktree file, or from the index's or HEAD's copy with git config --blob).
function farLfsEntries(entries, top) {
  for (const [key, value] of entries) {
    if (/^include\.|^includeif\./i.test(key)) return 'lfs-config';
    if (REMOTE_ADDRESS.test(key)) continue;
    if (netText(value)) return 'network-config';
    if (PATH_KEY.test(key)) { const why = farPathValue(value, [top], key); if (why) return why; }
  }
  return '';
}
// localPath with the share that `base` is on allowed (a session working on a
// share may name folders on it).
function localPathFrom(base, p) { return withShare(base, () => localPath(p)); }
module.exports = { farGitConfig, farNested, farModules, farLfsFile, farLfsEntries, localPath, localPathFrom, localRepoRoot, shareRoot, findGit, gitPath, gitEnv, GIT_GLOBAL };

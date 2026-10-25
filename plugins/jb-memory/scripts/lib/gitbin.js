// Where git is, and how every jb-memory git call runs it.
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

module.exports = { findGit, gitPath, gitEnv, GIT_GLOBAL };

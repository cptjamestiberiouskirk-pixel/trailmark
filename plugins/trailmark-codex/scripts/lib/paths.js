// Resolve the Claude Code auto-memory directory for the current repo.
//
// Claude Code keys auto memory by git repository, so every worktree and
// subdirectory of one repo shares a single memory dir
// (code.claude.com/docs/en/memory, "Storage location"). The docs do not state
// the exact path-to-folder-name rule, so this resolver never relies on one
// guess alone:
//
//   1. JBMEM_DIR (set by the trailmark.js launcher; also tests and manual override)
//   2. CLAUDE_CODE_PROJECT_DIR_NAME (documented override)
//   3. autoMemoryDirectory in user settings (documented override)
//   4. Hook context: when the session runs at the repo root, the transcript
//      folder Claude Code chose for this session IS the project folder.
//   5. Candidate folder names derived from the repo root, accepted only if
//      the folder already exists.
//   6. Scan of ~/.claude/projects: match a session transcript whose recorded
//      cwd is the repo root.
//   7. Formula fallback (reported as unverified).
//
// Derived from memory-toolkit's find-memory-dir.js (MIT, Ilya Gorsky), which
// split paths on '/' only and so could not resolve Windows paths.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { farGitConfig, localRepoRoot, gitPath, gitEnv, GIT_GLOBAL } = require('./gitbin');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsRoot() {
  return path.join(configDir(), 'projects');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// A path in the form the host OS compares it in.
function pathKey(p, platform = process.platform) {
  // Linux and macOS keep a run of backslashes in a path. The look-behind
  // starts a match only at the start of a run: without it, a long run takes
  // time quadratic in its length.
  const x = path.resolve(p).replace(/(?<![\\/])[\\/]+$/, '');
  return platform === 'win32' ? x.replace(/\//g, '\\').toLowerCase() : x;
}

// Compare paths the way the host OS does.
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  return pathKey(a, platform) === pathKey(b, platform);
}

// Candidate folder names. The first is the rule observed on Linux and macOS
// (every non-alphanumeric character becomes '-'); the second is upstream's.
function candidateKeys(root) {
  const keys = [root.replace(/[^a-zA-Z0-9]/g, '-')];
  const upstream = '-' + root.replace(/[/.]/g, '-').replace(/^-/, '');
  if (!keys.includes(upstream)) keys.push(upstream);
  return keys;
}

// git by full path from PATH, never from the repo itself (see gitbin.js).
function git(cwd, args, timeout = 3000) {
  const far = farGitConfig(cwd);
  if (far) { const e = new Error(`git not run: the repo's .git points at a network path (${far})`); e.code = 'JBMEM_FAR'; throw e; }
  const bin = gitPath(cwd);
  if (!bin) { const e = new Error('git not found on PATH'); e.code = 'ENOENT'; throw e; }
  return execFileSync(bin, [...GIT_GLOBAL, ...args], {
    cwd, env: gitEnv(), encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
}

// Main checkout root, also when called from inside a linked worktree.
// timeoutMs: for each git call (3 s unless given).
function repoRoot(cwd = process.cwd(), timeoutMs = 3000) {
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
  // git kept out (gitbin.js): the root found the way git would, without it,
  // so a worktree or subfolder still finds the shared memory folder.
  if (farGitConfig(cwd)) return localRepoRoot(cwd) || path.resolve(cwd);
  // git too slow (it timed out): the root found the same way, without git.
  // The folder itself would put a worktree or subfolder on a memory folder
  // of its own, where hooks find nothing set up and init sets up the wrong
  // one. A git that timed out once will time out again, so no second
  // rev-parse, and localRepoRoot starts no git (it reads only the .git
  // entries and pointer files).
  const slow = () => { try { return localRepoRoot(cwd) || path.resolve(cwd); } catch { return path.resolve(cwd); } };
  try {
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], t);
    if (common && path.basename(common) === '.git') return path.dirname(common);
  } catch (e) {
    if (e && e.code === 'ETIMEDOUT') return slow();
    /* not a repo, or git older than 2.31 */
  }
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel'], t);
    if (top) return path.resolve(top);
  } catch (e) {
    if (e && e.code === 'ETIMEDOUT') return slow();
    /* not a repo */
  }
  return path.resolve(cwd);
}

function readUserSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// First 64 KB of the newest transcript in a project folder, searched for a cwd.
function transcriptCwds(projectDir) {
  const found = [];
  let files;
  try {
    files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, t: require('./plainfile').plainMtime(path.join(projectDir, f)) }))
      .filter(x => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t)
      .slice(0, 2);
  } catch {
    return found;
  }
  for (const { f } of files) {
    let fd;
    try {
      // Never through a link, never a FIFO: this runs in the launcher.
      fd = require('./plainfile').openPlain(path.join(projectDir, f));
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      // The folder the session started in only: a later record's cwd is
      // wherever a command moved it, possibly another project.
      found.push(...require('./plainfile').recordCwds(buf.slice(0, n).toString('utf8'), 1));
    } catch { /* unreadable */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return found;
}

function scanForRoot(root, platform) {
  const pr = projectsRoot();
  let entries;
  try { entries = fs.readdirSync(pr, { withFileTypes: true }); } catch { return null; }
  for (const e of entries.slice(0, 500)) {
    if (!e.isDirectory()) continue;
    const dir = path.join(pr, e.name);
    if (transcriptCwds(dir).some(c => samePath(c, root, platform))) return dir;
  }
  return null;
}

// ctx: { cwd, transcriptPath, platform, gitTimeoutMs, noScan }. noScan skips
// reading other project folders' transcripts (the commit sweep asks about
// several folders and has a time budget).
function findMemoryDir(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const platform = ctx.platform || process.platform;
  const out = (dir, method, root) => ({ dir, exists: fs.existsSync(dir), method, root });

  if (process.env.JBMEM_DIR) {
    // Set by trailmark.js, which already resolved the folder before starting a sandboxed script.
    return out(path.resolve(process.env.JBMEM_DIR), process.env.JBMEM_METHOD || 'JBMEM_DIR', process.env.JBMEM_ROOT || cwd);
  }

  // One folder name under the projects folder, never a path, and only the
  // characters Claude Code uses in those names: a separator or a dot-name
  // could move the memory folder (and the sandbox's write grant) anywhere,
  // and a * would widen the grant, which Node reads as a wildcard.
  const pdn = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (pdn && /^[A-Za-z0-9._-]{1,255}$/.test(pdn) && pdn !== '.' && pdn !== '..') {
    return out(path.join(projectsRoot(), process.env.CLAUDE_CODE_PROJECT_DIR_NAME, 'memory'),
      'CLAUDE_CODE_PROJECT_DIR_NAME', cwd);
  }

  const settings = readUserSettings();
  if (typeof settings.autoMemoryDirectory === 'string' && settings.autoMemoryDirectory) {
    return out(path.resolve(expandHome(settings.autoMemoryDirectory)), 'autoMemoryDirectory', cwd);
  }

  const root = repoRoot(cwd, ctx.gitTimeoutMs);

  if (ctx.transcriptPath && !/^(\\\\|\/\/)/.test(String(ctx.transcriptPath)) && samePath(cwd, root, platform)) {
    const projectDir = path.dirname(path.resolve(String(ctx.transcriptPath)));
    // Codex: its transcripts live under ~/.codex, never in Claude Code's
    // projects folder, so only a path there counts.
    if (samePath(path.dirname(projectDir), projectsRoot(), platform)) {
      return out(path.join(projectDir, 'memory'), 'transcript', root);
    }
  }

  for (const key of candidateKeys(root)) {
    const projectDir = path.join(projectsRoot(), key);
    if (fs.existsSync(projectDir)) return out(path.join(projectDir, 'memory'), 'key:' + key, root);
  }

  const scanned = ctx.noScan ? null : scanForRoot(root, platform);
  if (scanned) return out(path.join(scanned, 'memory'), 'scan', root);

  return out(path.join(projectsRoot(), candidateKeys(root)[0], 'memory'), 'formula-unverified', root);
}

module.exports = { findMemoryDir, repoRoot, candidateKeys, samePath, pathKey, projectsRoot, configDir };

#!/usr/bin/env node
// migrate-from-jb-memory.js -- moves an install of jb-memory (Trailmark's name
// before 0.5.0) to Trailmark, for Claude Code and for Codex, and installs this
// release with its own installer.
//
//   node tools/migrate-from-jb-memory.js            show the plan, ask, then do it
//   node tools/migrate-from-jb-memory.js --dry-run  show the plan, change nothing
//
// On Windows, migrate-from-jb-memory.cmd at the top of the release runs this.
//
// What it does, in order. Each step that has nothing to do says so and moves
// on, so running it again after a partial run picks up where it stopped.
//
//   1. Looks, and changes nothing: every jb-memory install Claude Code lists
//      (user, project and local scope), the marketplaces that provide it, old
//      copies left in Claude Code's plugin cache, hooks in your Claude Code
//      settings that still run jbm.js, the Codex marketplace and plugin
//      jb-memory-codex, old Codex cache copies, the old jb-watchdog tasks on
//      Windows, and how many memory folders Trailmark set up.
//   2. Runs the installer's own checks (--preflight), so nothing is removed
//      when it would refuse. Shows the plan and asks before changing anything
//      (--yes skips asking).
//   3. Claude Code: uninstalls each jb-memory install with `claude plugin
//      uninstall`, project and local scopes first (from their repo's folder),
//      user scope last. If one of those can't be removed, or is kept with
//      --keep-project-scopes, jb-memory stays at user scope too and the
//      installer is skipped, so you still have a plugin (with --no-install,
//      user scope is removed anyway). Then removes the old
//      marketplace with `claude plugin marketplace remove`, unless another
//      installed plugin still comes from it or it offers other plugins too,
//      or it is a copy Claude Code made (from GitHub or a URL) that Codex's
//      jb-memory-codex may still come from (removing it deletes the copy).
//   4. Moves the old copies out of Claude Code's plugin cache into a backup
//      folder. Claude Code leaves them there after an uninstall, and both
//      Trailmark and the watchdog warn about them, since a cached copy can run.
//   5. Codex: the plugin can only be uninstalled in the ChatGPT app, which
//      lists it only through its marketplace. So while Codex's config.toml
//      still lists jb-memory-codex as installed, this keeps that marketplace
//      and the cache copy and says to uninstall it there; run this again
//      afterwards. Then it removes the jb-memory-codex marketplace with
//      `codex plugin marketplace remove` and moves old cache copies to the backup.
//      If the plugin is installed but its marketplace is already gone, the app
//      can't show it, so the old marketplace is added back from the old
//      release folder (next to this one, the old Claude Code marketplace, or
//      --old-release) for you to uninstall it there.
//   6. Runs this release's installer (install.ps1 on Windows, install.sh
//      elsewhere), with -Codex/--codex when Codex is in use and, on Windows,
//      -Watchdog when the old watchdog was installed. The installer makes its
//      own checks and asks its own questions. If it still stops, the list at
//      the end says how to run it again, or how to put jb-memory back.
//   7. Checks the result: Trailmark installed and on, no jb-memory left in any
//      scope or in the cache, the memory folders all still there.
//
// It never touches memory folders, handoffs, .jbmem.json or any repo file,
// except the .claude/settings.json or settings.local.json of a repo where
// jb-memory was installed at project or local scope: `claude plugin uninstall`
// edits those (--keep-project-scopes leaves them), and Codex's config.toml
// with --clean-codex-trust only. Cache copies are moved to
// the backup folder, with a log of every step, and stay there until you
// delete them; the only things it removes are folders left empty by that move
// and the empty folder it makes for a repo that moved. It downloads nothing.
// It runs claude, codex, the installer and, on Windows, schtasks and tasklist
// to look; a shell only for a claude or codex installed as a .cmd file, which
// Windows can't start any other way.
//
// Options:
//   --dry-run              show what would be done; change nothing
//   --yes                  don't ask before changing things
//   --claude-only          leave Codex alone
//   --codex-only           leave Claude Code alone (still installs Trailmark's
//                          Codex marketplace, not the Claude Code plugin)
//   --no-install           only remove the old install
//   --keep-project-scopes  leave project and local scope installs as they are
//   --keep-cache           don't move old cache copies
//   --watchdog / --no-watchdog
//                          Windows: install trailmark-watchdog or not (default:
//                          only when the old jb-watchdog is installed)
//   --scan <folder>        also look under <folder> (six levels down) for repos
//                          whose .claude/settings*.json still turn jb-memory
//                          on, such as a repo that moved; reported, not edited
//   --old-release <folder> the old jb-memory release folder, for when Codex
//                          still has jb-memory-codex installed but its
//                          marketplace is gone (see step 5); found on its
//                          own when it sits next to this folder
//   --clean-codex-trust    also remove the hook-trust records Codex keeps for
//                          jb-memory-codex in config.toml after it is
//                          uninstalled ([hooks.state."jb-memory-codex@..."]),
//                          with a backup of config.toml first
//   --backup-dir <folder>  where cache copies and the log go
//   --set-no-cwd-lookup, --allow-old-node, --repoint
//                          passed on to the installer (see MANUAL.md, section 3)
//
// Exit codes: 0 done; 1 stopped on an error; 2 done here, with something left
// for you (listed at the end, or a WARN line above says what wasn't done);
// 3 --dry-run found something to do.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const HERE = path.resolve(__dirname, '..');
const OLD_PLUGIN = 'jb-memory';
const OLD_CODEX = 'jb-memory-codex';
const SAFE = /^[\w.+@-]{1,128}$/;

// ---------- options

function parseArgs(argv) {
  const o = {
    dryRun: false, yes: false, claude: true, codex: true, install: true, projectScopes: true,
    cache: true, watchdog: 'auto', backupDir: '', pass: [], help: false, scan: [], oldRelease: '', cleanTrust: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': o.dryRun = true; break;
      case '--yes': case '-y': o.yes = true; break;
      case '--claude-only': o.codex = false; break;
      case '--codex-only': o.claude = false; break;
      case '--no-install': o.install = false; break;
      case '--keep-project-scopes': o.projectScopes = false; break;
      case '--keep-cache': o.cache = false; break;
      case '--watchdog': o.watchdog = 'yes'; break;
      case '--no-watchdog': o.watchdog = 'no'; break;
      case '--old-release': o.oldRelease = folderArg(argv[++i]); if (!o.oldRelease) throw new Error('--old-release needs a folder'); break;
      case '--clean-codex-trust': o.cleanTrust = true; break;
      case '--scan': o.scan.push(folderArg(argv[++i])); if (!o.scan[o.scan.length - 1]) throw new Error('--scan needs a folder'); break;
      case '--backup-dir': o.backupDir = folderArg(argv[++i]); if (!o.backupDir) throw new Error('--backup-dir needs a folder'); break;
      case '--set-no-cwd-lookup': case '--allow-old-node': case '--repoint': o.pass.push(a); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option: ${a} (see --help)`);
    }
  }
  if (!o.claude && !o.codex) throw new Error('--claude-only and --codex-only together leave nothing to do');
  return o;
}

// ---------- output and log

const logLines = [];
function out(line = '') { console.log(line); logLines.push(line); }
const step = t => { out(''); out(`=== ${t}`); };
const ok = t => out(`  ok    ${t}`);
const info = t => out(`  ..    ${t}`);
const warn = t => out(`  WARN  ${t}`);
const todo = [];
let backupDir = '';
function writeLog() {
  if (!backupDir) return;
  try { fs.mkdirSync(backupDir, { recursive: true }); fs.writeFileSync(path.join(backupDir, 'migrate.log'), logLines.join('\n') + '\n'); } catch { /* best effort */ }
}
function later(t) { todo.push(t); }
class Stop extends Error {}
function fail(t) { out(`  FAIL  ${t}`); throw new Stop(t); }

// ---------- finding programs

// A program by name on absolute PATH entries only, never from the current
// folder (on Windows a bare name is looked up there first). Windows takes
// .exe, then .cmd; a .cmd runs through cmd.exe with checked arguments.
function findProgram(name) {
  const sep = WIN ? ';' : ':';
  const exts = WIN ? ['.exe', '.cmd'] : [''];
  const cwd = process.cwd();
  for (let e of String(process.env.PATH || process.env.Path || '').split(sep)) {
    e = e.trim().replace(/^"(.*)"$/, '$1');
    if (!e || !path.isAbsolute(e) || (WIN && /^[\\/][^\\/]/.test(e))) continue;
    if (path.resolve(e).toLowerCase() === path.resolve(cwd).toLowerCase()) continue;
    for (const x of exts) {
      const f = path.join(e, name + x);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
    }
  }
  return '';
}

// On Windows, cmd.exe (which runs an npm .cmd shim) looks for a bare program
// name such as node in the current folder first; this variable stops that.
// PATH for the programs this runs: absolute folders only. claude and codex
// installed by npm start node by name (#!/usr/bin/env node, or SET _prog=node
// in the .cmd shim), and an empty entry or "." would then find a node in the
// repo folder a project-scope uninstall runs in.
function absolutePath() {
  const sep = WIN ? ';' : ':';
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  // POSIX: the entry as it is must start with '/' (a leading space or quote
  // makes it relative). Windows: kept trimmed and unquoted, as it is read.
  const keep = [];
  for (const e of String(process.env[key] || '').split(sep)) {
    if (!WIN) { if (e.startsWith('/')) keep.push(e); continue; }
    const t = e.trim().replace(/^"(.*)"$/, '$1');
    if (t && path.win32.isAbsolute(t) && !/^[\\/][^\\/]/.test(t)) keep.push(t);
  }
  return { key, value: keep.join(sep) };
}
const BASE_ENV = (() => {
  const env = { ...process.env };
  const p = absolutePath();
  env[p.key] = p.value;
  if (WIN) env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
})();
function run(prog, args, { cwd, inherit = false, timeout = 120000, env = BASE_ENV } = {}) {
  for (const a of args) if (typeof a !== 'string' || /[\0\r\n]/.test(a)) throw new Error(`refusing an unusual argument: ${JSON.stringify(a)}`);
  let file = prog;
  let argv = args;
  let verbatim = false;
  if (WIN && /\.cmd$/i.test(prog)) {
    // cmd.exe reads its line itself. Every word goes in double quotes, inside
    // which only ", % and ! still mean something to it, so those are refused.
    for (const a of [prog, ...args]) if (/["%!]/.test(a)) throw new Error(`refusing to run ${prog} with ${JSON.stringify(a)}: cmd.exe treats some of its characters specially`);
    file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    argv = ['/d', '/s', '/c', `""${prog}" ${args.map(a => `"${a}"`).join(' ')}"`];
    verbatim = true;
  }
  const r = spawnSync(file, argv, {
    cwd: cwd || os.homedir(), encoding: 'utf8', timeout, windowsHide: true, windowsVerbatimArguments: verbatim,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], env,
  });
  return { code: r.status === null ? -1 : r.status, out: r.stdout || '', err: r.stderr || '', error: r.error };
}

function jsonOf(text) {
  const t = String(text).replace(/^\uFEFF/, '').trim();
  try { return JSON.parse(t); } catch { /* maybe log lines first */ }
  const i = t.search(/^[[{]/m);
  if (i > 0) { try { return JSON.parse(t.slice(i)); } catch { /* no */ } }
  return undefined;
}
function lastJsonLine(text) {
  const lines = String(text).trim().split(/\r?\n/).reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch { /* next */ } }
  return null;
}

// One line from the terminal, read without touching process.stdin (which
// would switch it to non-blocking reads). EAGAIN means no input yet.
function askYes(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(256);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let got = '';
  const until = Date.now() + 30 * 60000;
  while (Date.now() < until && !got.includes('\n')) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e && e.code === 'EAGAIN') { Atomics.wait(nap, 0, 0, 50); continue; }
      break;
    }
    if (!n) break;
    got += buf.slice(0, n).toString();
  }
  return /^\s*y(es)?\s*$/i.test(got.split(/\r?\n/)[0]);
}

// ---------- small file helpers

function readText(f, max = 4 * 1024 * 1024) {
  try { const st = fs.lstatSync(f); if (!st.isFile() || st.size > max) return null; return fs.readFileSync(f, 'utf8'); } catch { return null; }
}
// A file read through links (Codex's config.toml is often a dotfile link):
// null when missing, undefined when it is there but can't be read.
function readFollow(f, max = 4 * 1024 * 1024) {
  let st;
  try { st = fs.statSync(f); } catch (e) { return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : undefined; }
  if (!st.isFile() || st.size > max) return undefined;
  try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; }
}
function readJson(f) { const t = readText(f); if (t === null) return undefined; try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return null; } }
function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }
function isDir(d) { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } }
// A folder, or a link to one (a home folder kept in a dotfiles repo).
function isDirFollow(d) { try { return !NET.test(d) && fs.statSync(d).isDirectory(); } catch { return false; } }
const NET = /^(?:\\\\|\/\/|[\\/]\?\?[\\/])/;
// Same folder by name or by real path (a subst drive, a junction, a link).
function sameReal(a, b) {
  if (samePath(a, b)) return true;
  if (NET.test(a) || NET.test(b)) return false;
  try { return samePath(fs.realpathSync.native(a), fs.realpathSync.native(b)); } catch { return false; }
}
function samePath(a, b) {
  const n = p => { let r = path.resolve(p).replace(/[\\/]+$/, ''); if (WIN) r = r.replace(/\//g, '\\').toLowerCase(); return r; };
  return n(a) === n(b);
}

// ---------- survey: Claude Code

function claudeConfigDir() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

function surveyClaude(claude) {
  const s = { plugins: [], trailmark: [], marketplaces: [], oldMarketplaces: [], cache: [], settingsHooks: [], memoryFolders: 0, listed: false };
  const cfg = claudeConfigDir();
  if (claude) {
    const l = run(claude, ['plugin', 'list', '--json']);
    const j = l.code === 0 ? jsonOf(l.out) : undefined;
    if (!Array.isArray(j)) fail(`claude plugin list --json didn't give the list expected (exit ${l.code}). ${l.err.trim().split('\n')[0] || ''}`);
    s.listed = true;
    for (const p of j) {
      const id = String((p && p.id) || '');
      const name = id.split('@')[0].toLowerCase();
      const entry = { id, scope: String(p.scope || 'user'), projectPath: p.projectPath ? String(p.projectPath) : '', enabled: p.enabled !== false, version: String(p.version || ''), folder: String(p.readFromFolder || '') };
      if (name === OLD_PLUGIN) s.plugins.push(entry);
      else if (name === 'trailmark') s.trailmark.push(entry);
      else s.others = (s.others || []).concat(entry);
    }
    const m = run(claude, ['plugin', 'marketplace', 'list', '--json']);
    const mj = m.code === 0 ? jsonOf(m.out) : undefined;
    if (!Array.isArray(mj)) fail(`claude plugin marketplace list --json didn't give the list expected (exit ${m.code}).`);
    s.marketplaces = mj.map(x => ({ name: String((x && x.name) || ''), path: String((x && (x.path || x.installLocation)) || ''), source: String((x && x.source) || ''), repo: String((x && x.repo) || ''), url: String((x && x.url) || '') }));
    const fromInstalls = new Set(s.plugins.map(p => p.id.split('@')[1]).filter(Boolean));
    for (const mk of s.marketplaces) {
      let provides = false;
      if (mk.path && !NET.test(mk.path)) {
        const man = readJson(path.join(mk.path, '.claude-plugin', 'marketplace.json'));
        provides = !!(man && Array.isArray(man.plugins) && man.plugins.some(p => p && String(p.name).toLowerCase() === OLD_PLUGIN));
        mk.alsoTrailmark = !!(man && Array.isArray(man.plugins) && man.plugins.some(p => p && String(p.name).toLowerCase() === 'trailmark'));
      }
      if (fromInstalls.has(mk.name) || provides || /^jb-memory/i.test(mk.name)) s.oldMarketplaces.push(mk);
    }
  }
  // Cache copies: <config>/plugins/cache/<marketplace>/jb-memory/<version>,
  // and any cached plugin that still holds the old launcher.
  const cache = path.join(cfg, 'plugins', 'cache');
  const installedKeys = new Set((s.others || []).concat(s.trailmark).map(p => p.id.toLowerCase()));
  for (const mk of listDir(cache)) {
    if (!mk.isDirectory()) continue;
    for (const pl of listDir(path.join(cache, mk.name))) {
      if (!pl.isDirectory()) continue;
      const dir = path.join(cache, mk.name, pl.name);
      const named = pl.name.toLowerCase() === OLD_PLUGIN;
      const holdsOld = !named && listDir(dir).some(v => v.isDirectory() && fs.existsSync(path.join(dir, v.name, 'scripts', 'jbm.js')));
      // A plugin Claude Code lists as installed stays, whatever it holds.
      if (holdsOld && installedKeys.has(`${pl.name}@${mk.name}`.toLowerCase())) { s.keptCache = (s.keptCache || []).concat(dir); continue; }
      if (named || holdsOld) s.cache.push(dir);
    }
  }
  // Hooks in Claude Code's own settings files that run the old launcher, from
  // installs made by hand before the plugin existed. Reported, not edited.
  for (const f of ['settings.json', 'settings.local.json']) {
    const t = readText(path.join(cfg, f));
    if (!t) continue;
    let hooks = t;
    try { const j = JSON.parse(t.replace(/^\uFEFF/, '')); hooks = JSON.stringify((j && j.hooks) || {}); } catch { /* unreadable: search it all */ }
    if (/jbm\.js|[\\/]jb-memory[\\/]/i.test(hooks)) s.settingsHooks.push(path.join(cfg, f));
  }
  const projects = path.join(cfg, 'projects');
  for (const d of listDir(projects)) {
    if (d.isDirectory() && fs.existsSync(path.join(projects, d.name, 'memory', '.jbmem.json'))) s.memoryFolders++;
  }
  return s;
}

// Repos under a folder whose own Claude Code settings still turn jb-memory on,
// for repos that moved since Claude Code recorded them. Reads only.
function scanRepos(root, { maxDepth = 6, maxDirs = 20000 } = {}) {
  const found = [];
  let seen = 0;
  const skip = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'Library', 'AppData']);
  const walk = (d, depth) => {
    if (depth > maxDepth || seen++ > maxDirs) return;
    for (const f of ['settings.json', 'settings.local.json']) {
      const t = readText(path.join(d, '.claude', f), 1024 * 1024);
      if (!t) continue;
      try { const j = JSON.parse(t.replace(/^\uFEFF/, '')); if (j && j.enabledPlugins && Object.entries(j.enabledPlugins).some(([k, v]) => v === true && k.split('@')[0].toLowerCase() === OLD_PLUGIN)) found.push(path.join(d, '.claude', f)); } catch { /* not JSON */ }
    }
    for (const e of listDir(d)) if (e.isDirectory() && !skip.has(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(path.resolve(root), 0);
  return { found, partial: seen > maxDirs };
}

// ---------- survey: Codex

const TRUST_RE = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*"jb-memory-codex@/i;
function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// config.toml without the [hooks.state."jb-memory-codex@..."] tables and the
// lines under them, each table running to the next line that starts with '['.
// Blank lines stay. Returns { text, removed }.
// Inside such a table only single-line `key = value` lines are removed;
// comments and blank lines stay with whatever follows. Anything else there
// (a multi-line string or array) means the file isn't the shape expected, and
// nothing is removed: { unsafe: true }.
const SCALAR_LINE = /^\s*[\w.-]+\s*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|true|false|[-+]?[\d._]+(?:[eE][-+]?\d+)?|\[[^\[\]]*\]|\{[^{}]*\})\s*(?:#.*)?$/;
function withoutTrust(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const keep = [];
  let removed = 0;
  let skip = false;
  for (const l of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*\[/.test(l)) {
      skip = TRUST_RE.test(l);
      if (skip) { removed++; continue; }
      keep.push(l);
      continue;
    }
    if (!skip || l.trim() === '' || /^\s*#/.test(l)) { keep.push(l); continue; }
    if (!SCALAR_LINE.test(l)) return { text, removed: 0, unsafe: true };
    removed++;
  }
  return { text: (text.startsWith('\uFEFF') ? '\uFEFF' : '') + keep.join(nl), removed };
}

// An old release folder whose Codex marketplace provides jb-memory-codex under
// the marketplace name Codex has it installed from ('' when none is found).
// A local copy of the old release whose Claude Code manifest still offers
// jb-memory: { folder, name } or null. Not one Claude Code copied into its
// own folder (removing the marketplace deleted it).
// A folder given on the command line. Windows PowerShell 5.1 passes
// "C:\My Repos\" on as C:\My Repos" (the \" read as a quote): put back.
function folderArg(a) {
  let v = String(a || '');
  if (WIN && /[^"]"$/.test(v) && !v.slice(0, -1).includes('"')) v = v.slice(0, -1) + '\\';
  return v;
}
function oldClaudeRelease(folders) {
  const ownCfg = (path.resolve(claudeConfigDir()) + path.sep).toLowerCase();
  for (const f of folders) {
    if (!f || NET.test(f) || !isDirFollow(f) || (path.resolve(f) + path.sep).toLowerCase().startsWith(ownCfg) || samePath(f, HERE)) continue;
    const man = readJson(path.join(f, '.claude-plugin', 'marketplace.json'));
    if (man && SAFE.test(String(man.name || '')) && Array.isArray(man.plugins) && man.plugins.some(q => q && String(q.name).toLowerCase() === OLD_PLUGIN)) return { folder: path.resolve(f), name: String(man.name) };
  }
  return null;
}
// jb-memory* folders next to this release (an old release kept beside it).
function siblingReleases() {
  return listDir(path.dirname(HERE)).filter(d => d.isDirectory() && /^jb-memory/i.test(d.name)).map(d => path.join(path.dirname(HERE), d.name));
}
function oldCodexRelease(folders, mkt) {
  for (const f of folders) {
    if (!f || NET.test(f) || !isDir(f)) continue;
    const man = readJson(path.join(f, '.agents', 'plugins', 'marketplace.json'));
    if (man && man.name === mkt && Array.isArray(man.plugins) && man.plugins.some(q => q && String(q.name).toLowerCase() === OLD_CODEX)) return path.resolve(f);
  }
  return '';
}

// A Windows path without its long-path prefix: \\?\C:\x is C:\x, and
// \\?\UNC\server\share is \\server\share (Codex prints and stores some roots
// that way). Anything else is unchanged.
function plainRoot(p) {
  if (/^[\\/][\\/?]\?[\\/][A-Za-z]:/.test(p)) return p.slice(4);
  if (/^[\\/][\\/?]\?[\\/]UNC[\\/]/i.test(p)) return '\\\\' + p.slice(8);
  return p;
}
// The plugins a Codex marketplace offers besides jb-memory-codex and
// trailmark-codex (from its folder's .agents/plugins/marketplace.json).
function codexOffersOthers(m) {
  if (!m || !m.path || NET.test(m.path)) return [];
  const man = readJson(path.join(m.path, '.agents', 'plugins', 'marketplace.json'));
  return man && Array.isArray(man.plugins) ? man.plugins.map(q => String((q && q.name) || '').toLowerCase()).filter(n => n && n !== OLD_CODEX && n !== 'trailmark-codex') : [];
}
// A Claude Code marketplace that Claude Code copied into its own folder (from
// GitHub or a URL) is deleted on removal; keep it while Codex may still list
// jb-memory-codex from that copy: it offers jb-memory-codex, and Codex has it
// installed, or Codex's state can't be read (a network home, an unreadable
// config.toml). Checked whatever --claude-only says.
function codexMayUse(m, cx) {
  if (!m || !m.path || NET.test(m.path)) return false;
  if (!path.resolve(m.path).toLowerCase().startsWith(path.resolve(claudeConfigDir()).toLowerCase() + path.sep)) return false;
  const man = readJson(path.join(m.path, '.agents', 'plugins', 'marketplace.json'));
  if (!(man && Array.isArray(man.plugins) && man.plugins.some(q => q && String(q.name).toLowerCase() === OLD_CODEX))) return false;
  const home = codexHome();
  if (NET.test(home)) return true;
  const cfg = readFollow(path.join(home, 'config.toml'));
  if (cfg === undefined) return true;
  if (!(cfg && /^\s*\[\s*plugins\s*\.\s*"jb-memory-codex@/im.test(cfg))) return false;
  // When Codex's own list said where its marketplaces are, only a copy one
  // of them uses is kept.
  if (cx && cx.listOk && cx.oldMarketplaces.some(cm => cm.path)) {
    return cx.oldMarketplaces.some(cm => cm.path && !NET.test(cm.path) && (samePath(cm.path, m.path) || path.resolve(cm.path).toLowerCase().startsWith(path.resolve(m.path).toLowerCase() + path.sep)));
  }
  return true;
}
// The plugins a Claude Code marketplace offers besides jb-memory and Trailmark.
function claudeOffersOthers(m) {
  if (!m || !m.path || NET.test(m.path)) return [];
  const man = readJson(path.join(m.path, '.claude-plugin', 'marketplace.json'));
  return man && Array.isArray(man.plugins) ? man.plugins.map(q => String((q && q.name) || '').toLowerCase()).filter(n => n && n !== OLD_PLUGIN && n !== 'trailmark') : [];
}
function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

function surveyCodex(codex) {
  const s = { home: codexHome(), used: false, marketplaces: [], oldMarketplaces: [], installed: [], cache: [], listOk: false, trailmarkMarketplace: false };
  // Codex counts as used when its home folder exists; the CLI on PATH alone
  // doesn't, or every run would ask to install trailmark-codex.
  s.used = isDirFollow(s.home);
  // A home on a network path isn't looked into at all.
  if (NET.test(s.home)) { s.used = false; return Object.assign(s, { fromMkt: {}, trust: 0, tmInstalled: false, tmVersion: '' }); }
  const cfgRaw = readFollow(path.join(s.home, 'config.toml'));
  // Can't read it: whether jb-memory-codex is installed is unknown, so every
  // Codex step is left alone.
  s.cfgUnknown = cfgRaw === undefined;
  const cfgText = cfgRaw || '';
  for (const m of cfgText.matchAll(/^\s*\[\s*plugins\s*\.\s*"([^"]+)"\s*\]/gm)) {
    const id = m[1];
    if (id.split('@')[0].toLowerCase() === OLD_CODEX) s.installed.push(id);
  }
  // Plugins installed from each marketplace, by marketplace name.
  s.fromMkt = {};
  for (const m of cfgText.matchAll(/^\s*\[\s*plugins\s*\.\s*"([^"@]+)@([^"]+)"\s*\]/gm)) (s.fromMkt[m[2]] = s.fromMkt[m[2]] || []).push(m[1]);
  for (const m of cfgText.matchAll(/^\s*\[\s*marketplaces\s*\.\s*"?([\w.+-]+)"?\s*\]/gm)) {
    if (m[1].toLowerCase() === OLD_CODEX) s.oldMarketplaces.push({ name: m[1], from: 'config.toml' });
  }
  // One entry per name: config.toml's [marketplaces.<name>] table names it
  // without a folder, and the CLI's list adds the folder and whether it is
  // stale (it now holds something other than jb-memory-codex, such as this
  // release unpacked over the old folder).
  const addOld = (name, root, provides) => {
    // Stale: it no longer offers jb-memory-codex (this release unpacked over
    // it), or its folder is gone. A network root isn't read.
    const stale = !provides && !!root && !NET.test(root) && (!!readJson(path.join(root, '.agents', 'plugins', 'marketplace.json')) || !isDirFollow(root));
    const had = s.oldMarketplaces.find(o => o.name === name);
    if (had) { if (root && !had.path) { had.path = root; had.stale = stale; } return; }
    s.oldMarketplaces.push({ name, path: root, stale });
  };
  if (codex) {
    const l = run(codex, ['plugin', 'marketplace', 'list', '--json']);
    const j = l.code === 0 ? jsonOf(l.out) : undefined;
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.marketplaces) ? j.marketplaces : null);
    if (arr) {
      s.listOk = true;
      for (const x of arr) {
        const name = String((x && x.name) || '');
        const p = plainRoot(String((x && (x.path || x.root || x.installLocation)) || ''));
        s.marketplaces.push({ name, path: p });
        let provides = false;
        if (p && !NET.test(p)) {
          const man = readJson(path.join(p, '.agents', 'plugins', 'marketplace.json'));
          provides = !!(man && Array.isArray(man.plugins) && man.plugins.some(q => q && String(q.name).toLowerCase() === OLD_CODEX));
        }
        if (name === 'trailmark-codex') { if (!p || sameReal(p, HERE)) s.trailmarkMarketplace = true; else s.trailmarkElsewhere = p; }
        if (provides || name.toLowerCase() === OLD_CODEX) addOld(name, p, provides);
      }
    } else {
      // Codex without --json prints a table: MARKETPLACE and ROOT columns.
      const t = run(codex, ['plugin', 'marketplace', 'list']);
      if (t.code === 0) {
        s.listOk = true;
        for (const line of t.out.split(/\r?\n/)) {
          const m = /^(\S+)\s+(.*\S)\s*$/.exec(line) || /^(\S+)\s*$/.exec(line);
          if (!m || m[1] === 'MARKETPLACE') continue;
          const name = m[1], root = plainRoot(m[2] || '');
          if (name === 'trailmark-codex') { if (!root || sameReal(root, HERE)) s.trailmarkMarketplace = true; else s.trailmarkElsewhere = root; }
          let provides = false;
          if (root && !NET.test(root)) {
            const man = readJson(path.join(root, '.agents', 'plugins', 'marketplace.json'));
            provides = !!(man && Array.isArray(man.plugins) && man.plugins.some(q => q && String(q.name).toLowerCase() === OLD_CODEX));
          }
          if (provides || name.toLowerCase() === OLD_CODEX) addOld(name, root, provides);
        }
      }
    }
  }
  const cache = path.join(s.home, 'plugins', 'cache');
  for (const mk of listDir(cache)) {
    if (!mk.isDirectory()) continue;
    for (const pl of listDir(path.join(cache, mk.name))) {
      if (pl.isDirectory() && pl.name.toLowerCase() === OLD_CODEX) s.cache.push(path.join(cache, mk.name, pl.name));
    }
  }
  // Hook-trust records Codex keeps per plugin; they can outlive it.
  s.trust = cfgText.split(/\r?\n/).filter(l => TRUST_RE.test(l)).length;
  // trailmark-codex as installed: the newest version folder in the cache.
  s.tmInstalled = /^\s*\[\s*plugins\s*\.\s*"trailmark-codex@/im.test(cfgText);
  s.tmVersion = listDir(path.join(cache, 'trailmark-codex', 'trailmark-codex')).filter(d => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name)).map(d => d.name).sort(cmpVersion).pop() || '';
  return s;
}

// ---------- survey: the old Windows watchdog

function oldWatchdog() {
  if (!WIN) return { tasks: [], folder: '' };
  const schtasks = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
  const tasks = [];
  for (const n of ['jb-watchdog', 'jb-watchdog-reminder']) {
    const r = run(schtasks, ['/Query', '/TN', n]);
    if (r.code === 0) tasks.push(n);
  }
  const folder = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'jb-watchdog');
  return { tasks, folder: isDir(folder) ? folder : '' };
}

// ---------- running programs that would use old files

function runningPrograms() {
  let names = [];
  if (WIN) {
    const r = run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH']);
    names = r.out.split(/\r?\n/).map(l => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean).map(n => n.toLowerCase());
  } else {
    const ps = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
    const r = run(ps, ['-A', '-o', 'comm=']);
    names = r.out.split(/\r?\n/).map(l => path.basename(l.trim()).toLowerCase()).filter(Boolean);
  }
  const has = n => names.includes(n);
  return {
    claude: has('claude') || has('claude.exe'),
    codex: has('codex') || has('codex.exe') || has('chatgpt.exe') || has('chatgpt'),
  };
}

// ---------- doing

// Runs this release's installer with these flags; inherit shows its output.
function runInstaller(flags, inherit) {
  if (WIN) {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Without PowerShell 7's PSModulePath: Windows PowerShell 5.1 started
    // with it can't load its own Get-Acl and the like (install.ps1 also
    // drops those entries itself).
    const env = Object.fromEntries(Object.entries(BASE_ENV).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
    return run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'install.ps1'), ...flags], { cwd: HERE, inherit, timeout: 30 * 60000, env });
  }
  const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : findProgram('bash');
  if (!bash) return { code: 1, out: '', err: 'bash was not found (/bin/bash or an absolute PATH folder); install.sh needs it' };
  const r = run(bash, [path.join(HERE, 'install.sh'), ...flags], { cwd: HERE, inherit, timeout: 30 * 60000 });
  if (r.code !== 0 && !r.out && !r.err && r.error) r.err = String(r.error.message || r.error);
  return r;
}

function backupDirFor(o) {
  if (o.backupDir) return path.resolve(o.backupDir);
  const base = WIN ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) : path.join(os.homedir(), '.local', 'share');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return path.join(base, 'trailmark-migration', stamp);
}

function moveAside(src, backup, label) {
  const dest = path.join(backup, label, path.relative(path.parse(src).root, src).replace(/[:\\/]+/g, '_'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e && e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: false });
  }
  // The marketplace folder above it, when that was its only plugin.
  try { fs.rmdirSync(path.dirname(src)); } catch { /* not empty: other plugins */ }
  return dest;
}

// A project or local install this script can remove: a usable id and scope,
// and an absolute local folder (one that is gone is made again for it).
function usableScope(p) {
  return SAFE.test(p.id) && /^(project|local)$/.test(p.scope) && !!p.projectPath && path.isAbsolute(p.projectPath) && !NET.test(p.projectPath);
}
function uninstallClaude(claude, p, o) {
  const args = ['plugin', 'uninstall', p.id, '--scope', p.scope, '--json'];
  if (!SAFE.test(p.id) || !/^(user|project|local)$/.test(p.scope)) { warn(`skipped an install with an unusual id or scope: ${JSON.stringify(p)}`); return false; }
  let cwd;
  if (p.scope !== 'user') {
    if (!o.projectScopes) { info(`left ${p.id} at ${p.scope} scope in ${p.projectPath} (--keep-project-scopes)`); later(`jb-memory is still installed at ${p.scope} scope in ${p.projectPath}; once Trailmark is installed, it warns there until jb-memory is removed.`); return false; }
    if (!p.projectPath || !path.isAbsolute(p.projectPath) || NET.test(p.projectPath)) {
      warn(`${p.id} is recorded at ${p.scope} scope for ${p.projectPath || 'an unknown folder'}, which can't be used`);
      later(`Claude Code still records jb-memory at ${p.scope} scope for ${p.projectPath || 'an unknown folder'}; remove it by hand there: claude plugin uninstall ${p.id} --scope ${p.scope}`);
      return false;
    }
    cwd = p.projectPath;
  }
  // A repo that moved or was deleted: Claude Code only uninstalls a project or
  // local install from the folder it recorded, so that folder is made again,
  // empty, for the one command, and removed again after.
  const made = [];
  if (cwd && !isDirFollow(cwd)) {
    try {
      let d = cwd;
      while (!fs.existsSync(d)) { made.unshift(d); const up = path.dirname(d); if (up === d) break; d = up; }
      for (const m of made) fs.mkdirSync(m);
      info(`${cwd} is gone (repo moved or deleted); made it empty for the uninstall`);
    } catch (e) {
      warn(`${p.id} is recorded at ${p.scope} scope for ${cwd}, which is gone and couldn't be made again: ${e.message}`);
      later(`Claude Code still records jb-memory at ${p.scope} scope for ${cwd}. Make that folder, then run there: claude plugin uninstall ${p.id} --scope ${p.scope}`);
      return false;
    }
  }
  const r = run(claude, args, { cwd });
  for (const m of made.slice().reverse()) {
    try { fs.rmdirSync(m); } catch { warn(`left ${m} (it isn't empty)`); }
  }
  if (made.length) later(`The repo Claude Code knew at ${cwd} has moved or gone. If it still exists somewhere, its .claude/settings.json may still turn jb-memory on: run this with --scan <folder that holds your repos> to find it.`);
  const j = lastJsonLine(r.out);
  if (r.code === 0 || (j && j.failureCode === 'not_installed')) {
    ok(`uninstalled ${p.id} (${p.scope} scope${cwd ? ', ' + cwd : ''})`);
    if (p.scope === 'project' && !made.length) later(`${path.join(cwd, '.claude', 'settings.json')} changed (jb-memory removed from enabledPlugins). It's a committed file: commit the change, or your teammates' Claude Code keeps asking for jb-memory.`);
    return true;
  }
  warn(`claude plugin uninstall ${p.id} --scope ${p.scope} failed: ${(j && j.message) || r.err.trim().split('\n')[0] || 'exit ' + r.code}`);
  return false;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 1; }
  if (o.help) { const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1); console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }

  out(`Trailmark migration from jb-memory${o.dryRun ? ' (dry run: nothing will be changed)' : ''}`);
  out(`  release folder: ${HERE}`);

  step('Look');
  if (process.env.CLAUDECODE === '1' && !o.dryRun) fail('this is running inside a Claude Code session. Run it from a terminal of its own: uninstalling the plugin pulls hooks out from under this session.');
  if ((process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED) && !o.dryRun) fail('this is running inside a Codex session. Run it from a terminal of its own, with the ChatGPT app closed.');
  const man = readJson(path.join(HERE, '.claude-plugin', 'marketplace.json'));
  if (!man || man.name !== 'trailmark' || !fs.existsSync(path.join(HERE, 'plugins', 'trailmark', '.claude-plugin', 'plugin.json'))) fail(`${HERE} isn't a Trailmark release folder (no trailmark marketplace.json).`);
  const claude = o.claude || o.install ? findProgram('claude') : '';
  const codex = o.codex ? findProgram('codex') : '';
  if (o.claude && !claude) fail('the claude command isn\'t on PATH. Install Claude Code 2.1.304 or later first, or run with --codex-only.');
  // Claude Code loads the plugin from this folder in place, so it has to stay.
  if (/[\\/](?:downloads|onedrive[^\\/]*)[\\/]/i.test(HERE + path.sep) || samePath(path.dirname(HERE), os.tmpdir()) || HERE.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) {
    warn(`${HERE} looks like a download, synced or temporary folder. Claude Code runs the plugin from here, so moving or deleting it later breaks the install; MANUAL.md, section 3, suggests ~/tools/trailmark.`);
  }
  info(`claude: ${claude || '(not used)'}`);
  info(`codex:  ${codex || (o.codex ? 'not on PATH' : '(not used)')}`);

  const c = o.claude ? surveyClaude(claude) : null;
  const x = o.codex ? surveyCodex(codex) : null;
  const wd = oldWatchdog();
  if (c) {
    if (c.plugins.length) for (const p of c.plugins) info(`jb-memory installed: ${p.id}, ${p.scope} scope${p.projectPath ? ' in ' + p.projectPath : ''}${p.enabled ? '' : ' (disabled)'}, version ${p.version || '?'}`);
    else ok('no jb-memory install listed by Claude Code');
    for (const m of c.oldMarketplaces) info(`old marketplace: ${m.name}${m.path ? ' -> ' + m.path : ''}`);
    for (const d of c.cache) info(`old copy in the plugin cache: ${d}`);
    for (const f of c.settingsHooks) warn(`${f} has a hook that runs jb-memory's jbm.js (added by hand?)`);
    for (const t of c.trailmark) info(`Trailmark already installed: ${t.id}, ${t.scope} scope${t.enabled ? '' : ' (disabled)'}`);
    info(`memory folders set up: ${c.memoryFolders} (left exactly as they are)`);
  }
  if (x) {
    if (NET.test(x.home)) {
      warn(`Codex's home folder ${x.home} is on a network path, which this doesn't look into; every Codex step is left alone`);
      later(`Codex's home folder is on a network path. Do the Codex steps in MANUAL.md, section 15, by hand.`);
    } else if (!x.used) info(`Codex: not found (no ${x.home})`);
    if (x.cfgUnknown) {
      warn(`${path.join(x.home, 'config.toml')} is there but can't be read, so whether jb-memory-codex is installed is unknown; every Codex step is left alone`);
      later(`Make ${path.join(x.home, 'config.toml')} readable (or fix the link it is), then run this again for the Codex steps.`);
      x.used = false;
    }
    for (const id of x.installed) info(`Codex plugin installed: ${id} (listed in ${path.join(x.home, 'config.toml')})`);
    if (x.trailmarkElsewhere) {
      warn(`the trailmark-codex marketplace points at ${x.trailmarkElsewhere}, not this folder`);
      later(`Point Codex at this release: codex plugin marketplace remove trailmark-codex, then codex plugin marketplace add "${HERE}" (in the ChatGPT app, upgrade trailmark-codex afterwards).`);
    }
    for (const m of x.oldMarketplaces) info(`old Codex marketplace: ${m.name}${m.path ? ' -> ' + m.path : ''}`);
    for (const d of x.cache) info(`old copy in Codex's plugin cache: ${d}`);
    if (x.used && codex && !x.listOk) warn('codex plugin marketplace list failed, so old Codex marketplaces could not be listed');
    if (x.used && !codex && x.oldMarketplaces.length) warn('the codex command isn\'t on PATH, so the old Codex marketplace can\'t be removed from here');
    if (x.trust) info(`hook-trust records left for jb-memory-codex in config.toml: ${x.trust}`);
    if (x.tmInstalled) info(`trailmark-codex installed${x.tmVersion ? ', version ' + x.tmVersion : ''}`);
    // Installed with no marketplace: the app can't show it, so it can't be
    // uninstalled there until its marketplace is added back.
    // Or when the old marketplace's folder no longer offers it (a release
    // unpacked over the old one): the app can't show it either way.
    x.orphan = x.installed.length && (!x.oldMarketplaces.length || x.oldMarketplaces.every(m => m.stale));
    if (x.orphan) {
      const mkt = (x.installed[0].split('@')[1] || OLD_CODEX).replace(/\s.*$/, '');
      const sibs = listDir(path.dirname(HERE)).filter(d => d.isDirectory() && /^jb-memory/i.test(d.name)).map(d => path.join(path.dirname(HERE), d.name));
      x.orphanMkt = mkt;
      // Not a copy under Claude Code's own folder: removing the old Claude Code
      // marketplace deletes it before the Codex step runs.
      const ownCfg = path.resolve(claudeConfigDir()) + path.sep;
      // Unless it is kept for Codex: then it is still there to add back from.
      const fromClaude = (c ? c.oldMarketplaces.filter(m => m.path && (!(path.resolve(m.path) + path.sep).toLowerCase().startsWith(ownCfg.toLowerCase()) || codexMayUse(m, x))).map(m => m.path) : []);
      x.orphanFrom = oldCodexRelease([o.oldRelease, ...fromClaude, ...sibs], mkt);
      warn(`jb-memory-codex is installed but its marketplace ${mkt} is gone, so the ChatGPT app can't show it to uninstall`);
      if (o.oldRelease && !oldCodexRelease([o.oldRelease], mkt)) warn(`--old-release ${o.oldRelease} has no Codex marketplace named ${mkt} that provides jb-memory-codex`);
      if (x.orphanFrom) info(`old release with that marketplace: ${x.orphanFrom}`);
      else later(`Codex has jb-memory-codex installed, but its marketplace (${mkt}) is gone, so the ChatGPT app can't show it to uninstall. Run this again with --old-release <your old jb-memory release folder> to add that marketplace back, or add it yourself: codex plugin marketplace add <that folder>. Then uninstall jb-memory-codex in the app and run this again.`);
      if (x.orphanFrom && !codex) later(`The codex command isn't on PATH here. Add the old marketplace back yourself: codex plugin marketplace add "${x.orphanFrom}" (or add that folder as a marketplace in the ChatGPT app), then uninstall jb-memory-codex in the app and run this again.`);
    }
    if (!x.installed.length && x.trust && !o.cleanTrust) info('those records do nothing now; --clean-codex-trust removes them');
    const relCodex = readJson(path.join(HERE, 'plugins', 'trailmark-codex', '.codex-plugin', 'plugin.json'));
    if (x.tmInstalled && x.tmVersion && relCodex && relCodex.version && cmpVersion(x.tmVersion, relCodex.version) < 0) later(`Codex has trailmark-codex ${x.tmVersion} installed; this release is ${relCodex.version}. In the ChatGPT app: restart it, open Plugins, then Marketplace, then Trailmark for Codex, and choose Upgrade (or reinstall), then trust its hooks again if asked.`);
  }
  if (c) {
    const tmk = c.marketplaces.find(m => m.name === 'trailmark');
    if (tmk && tmk.path && !samePath(tmk.path, HERE) && !o.pass.includes('--repoint')) warn(`the trailmark marketplace points at ${tmk.path}; the installer stops unless you run this with --repoint, which points it here`);
  }
  if (wd.tasks.length) info(`old watchdog tasks: ${wd.tasks.join(', ')}`);
  // --scan runs after the uninstalls (or here, for a dry run), so a repo they
  // fixed isn't reported.
  const doScan = () => { for (const root of o.scan) {
    let dirOk = false;
    try { dirOk = !NET.test(root) && fs.statSync(root).isDirectory(); } catch { dirOk = false; }
    if (!dirOk) { warn(`--scan ${root}: not a local folder`); continue; }
    const r = scanRepos(root);
    for (const f of r.found) {
      warn(`${f} turns jb-memory on`);
      later(`${f} still turns jb-memory on. Remove the "jb-memory@..." line from its enabledPlugins (and any jb-memory entry under extraKnownMarketplaces), then commit it if the file is committed. This script doesn't edit repo files.`);
    }
    if (!r.found.length) ok(`--scan ${root}: no repo settings turn jb-memory on`);
    if (r.partial) warn(`--scan ${root}: stopped after 20,000 folders; scan a smaller folder to be sure`);
  } };
  if (o.dryRun) doScan();
  const run1 = runningPrograms();

  // ---------- plan
  const plan = [];
  // jb-memory installs at project or local scope that this run won't remove:
  // kept on purpose, or recorded for a folder that can't be used. The
  // installer refuses while jb-memory is installed anywhere, so then the
  // user-scope jb-memory stays too, rather than leaving no plugin at all.
  const stays = c ? c.plugins.filter(p => p.scope !== 'user' && (!o.projectScopes || !usableScope(p))) : [];
  o.keepUser = !!(o.install && o.claude && stays.length && c.plugins.some(p => p.scope === 'user'));
  if (o.install && c && stays.length) {
    info(`jb-memory stays at ${stays.map(p => `${p.scope} scope${p.projectPath ? ' in ' + p.projectPath : ''}`).join(', ')}${o.projectScopes ? '' : ' (--keep-project-scopes)'}, and the installer refuses while it is installed anywhere, so the installer is skipped${o.keepUser ? ' and jb-memory is kept at user scope too, so you still have a plugin' : ''}`);
    later(o.projectScopes
      ? 'Remove jb-memory from the scopes above by hand (the warnings say how), then run this again.'
      : 'Install Trailmark once jb-memory is gone from every scope: run this again without --keep-project-scopes, or run the installer yourself.');
    o.install = false;
  }
  // jb-memory (or Trailmark) turned off at user scope: the installer turns
  // Trailmark on, so the run says how to turn it off again.
  const wasOff = !!(c && ((c.plugins.some(p => p.scope === 'user') && c.plugins.filter(p => p.scope === 'user').every(p => !p.enabled)) ||
    c.trailmark.some(p => p.id === 'trailmark@trailmark' && p.scope === 'user' && !p.enabled)));
  if (c) {
    for (const p of c.plugins) if ((p.scope === 'user' && !o.keepUser) || (p.scope !== 'user' && o.projectScopes)) plan.push(`uninstall ${p.id} (${p.scope}${p.projectPath ? ', ' + p.projectPath : ''})`);
    for (const m of c.oldMarketplaces) {
      if (codexMayUse(m, x)) plan.push(`keep the Claude Code marketplace ${m.name} for now: Codex's jb-memory-codex may still come from its folder`);
      else if (claudeOffersOthers(m).length) plan.push(`keep the Claude Code marketplace ${m.name}: it also offers ${claudeOffersOthers(m).join(', ')}`);
      else plan.push(`remove the Claude Code marketplace ${m.name} (unless a plugin you keep still comes from it)`);
    }
    if (o.cache) for (const d of c.cache) plan.push(`move ${d} to the backup folder`);
  }
  if (x && x.used) {
    // The ChatGPT app lists an installed plugin only through its marketplace,
    // so that marketplace stays until the plugin is uninstalled there.
    if (!codex && x.used) later(`The codex command isn't on PATH, so this couldn't change Codex. In the ChatGPT app: add ${HERE} as a plugin marketplace, install trailmark-codex from it and trust its hooks${x.installed.length ? '; uninstall jb-memory-codex first' : ''}. Or install the Codex CLI and run this again.`);
    else if (x.installed.length) for (const m of x.oldMarketplaces) plan.push(x.orphan && x.orphanFrom && codex && m.stale ? `replace the Codex marketplace ${m.name}, which no longer offers jb-memory-codex, with the old release, until jb-memory-codex is uninstalled in the ChatGPT app` : `keep the Codex marketplace ${m.name} until jb-memory-codex is uninstalled in the ChatGPT app`);
    else if (codex) for (const m of x.oldMarketplaces) plan.push(codexOffersOthers(m).length ? `keep the Codex marketplace ${m.name}: it also offers ${codexOffersOthers(m).join(', ')}` : `remove the Codex marketplace ${m.name}`);
    if (o.cache && !x.installed.length) for (const d of x.cache) plan.push(`move ${d} to the backup folder`);
    if (x.orphan && x.orphanFrom && codex) plan.push(`add the old Codex marketplace back from ${x.orphanFrom}, so the ChatGPT app shows jb-memory-codex for you to uninstall`);
    if (o.cleanTrust && !x.installed.length && x.trust) plan.push(`remove ${x.trust} hook-trust records for jb-memory-codex from config.toml (backed up first)`);
  }
  const useCodex = !!(x && x.used && codex);
  // The old watchdog is running only while its tasks exist; its folder stays
  // behind on purpose, with the old log, once the new watchdog replaced it.
  // Only install.ps1 installs it, and only a Claude Code run starts that.
  const watchdog = WIN && o.claude && (o.watchdog === 'yes' || (o.watchdog === 'auto' && wd.tasks.length > 0));
  const codexCurrentEarly = () => !useCodex || (x && x.trailmarkMarketplace);
  // Trailmark from this folder at user scope, on or turned off on purpose
  // (the installer would turn it back on).
  const current = c && c.trailmark.find(p => p.id === 'trailmark@trailmark' && p.scope === 'user' && p.folder && samePath(p.folder, path.join(HERE, 'plugins', 'trailmark')));
  const codexCurrent = !useCodex || (x && x.trailmarkMarketplace);
  if (o.install && current && codexCurrent && !c.plugins.length && !watchdog) {
    info(`Trailmark from this folder is already installed${current.enabled ? ' and on' : ' (turned off, and left that way)'}, so the installer is skipped`);
    o.install = false;
  } else if (o.install && current && !current.enabled && !c.plugins.length && !watchdog) {
    // Only the Codex marketplace is missing: the installer would turn the
    // Claude Code plugin back on, so only the marketplace is added.
    info('Trailmark from this folder is installed (turned off, and left that way); only the trailmark-codex marketplace is added');
    o.mktOnly = true;
  }
  if (o.install && o.claude && !o.mktOnly && !(current && codexCurrentEarly() && !c.plugins.length && !watchdog)) {
    // The installer's own checks, run now: once jb-memory is removed, a
    // refusal would leave no plugin at all.
    const pf = [WIN ? '-Preflight' : '--preflight'];
    for (const p of o.pass) {
      if (WIN && p !== '--set-no-cwd-lookup') pf.push({ '--allow-old-node': '-AllowOldNode', '--repoint': '-Repoint' }[p]);
      else if (!WIN && p !== '--set-no-cwd-lookup') pf.push(p);
    }
    const r = runInstaller(pf, false);
    if (r.code !== 0) {
      out('');
      out('  The installer\'s checks (run first, before anything is removed):');
      for (const l of (r.out + r.err).trim().split(/\r?\n/)) out('    ' + l);
      fail('the installer would refuse to install, so nothing was removed. Fix what it says above (MANUAL.md, section 3), then run this again.');
    }
    ok('the installer\'s checks pass (run first, so nothing is removed if it would refuse)');
  }
  if (o.install) {
    const flags = [];
    if (useCodex) flags.push(WIN ? '-Codex' : '--codex');
    if (watchdog) flags.push('-Watchdog');
    for (const p of o.pass) {
      if (WIN) flags.push({ '--set-no-cwd-lookup': '-SetNoCwdLookup', '--allow-old-node': '-AllowOldNode', '--repoint': '-Repoint' }[p]);
      else if (p !== '--set-no-cwd-lookup') flags.push(p);
    }
    if (!o.claude || o.mktOnly) { if (!(x && x.trailmarkMarketplace)) plan.push(`add the trailmark-codex marketplace (codex plugin marketplace add ${HERE})`); }
    else plan.push(`run ${WIN ? 'install.ps1' : 'install.sh'}${flags.length ? ' ' + flags.join(' ') : ''}`);
    o.flags = flags;
  }

  // The new Codex plugin is installed in the ChatGPT app, not from here; until
  // config.toml names it, say so on every run.
  // Installed means a [plugins."trailmark-codex@..."] table; adding the
  // marketplace also writes its name into config.toml, so a bare mention
  // doesn't count.
  const codexInstalled = () => /^\s*\[\s*plugins\s*\.\s*"trailmark-codex@/im.test(readFollow(path.join(codexHome(), 'config.toml')) || '');
  // Said only once the trailmark-codex marketplace is there to choose.
  const codexPending = () => useCodex && !codexInstalled() && !!(codex && surveyCodex(codex).trailmarkMarketplace);
  step('Plan');
  // Lines that only say what stays aren't work to do.
  const keeps = plan.filter(p => /^keep /.test(p));
  if (plan.length && keeps.length === plan.length) { for (const p of keeps) info(p.replace(/^keep /, 'keeping ')); plan.length = 0; }
  if (!plan.length) {
    ok('nothing to do here');
    if (!o.dryRun && o.scan.length) doScan();
    if (codexPending()) later('In the ChatGPT app: restart it, open Plugins, choose the trailmark-codex marketplace, install trailmark-codex, then review and trust its hooks when asked.');
    if (!todo.length) return 0;
    out(''); out('Left for you:');
    todo.forEach((t, i) => out(`  ${i + 1}. ${t}`));
    return 2;
  }
  for (const p of plan) out(`  - ${p}`);
  if (run1.claude && c && (c.plugins.length || c.cache.length)) warn('Claude Code is running. Sessions open now keep the old hooks until they end; start new ones afterwards.');
  if (run1.codex && x && (x.oldMarketplaces.length || x.cache.length)) warn('Codex or the ChatGPT app is running. Quit it before Codex steps, or restart it afterwards.');
  if (o.dryRun) { out(''); out('Dry run: nothing was changed.'); return 3; }
  if (!o.yes) {
    if (!require('tty').isatty(0)) fail('nothing was changed: run it in a terminal to be asked, or pass --yes.');
    if (!askYes('\nGo ahead? [y/N] ')) { out('Nothing was changed.'); return 1; }
  }

  const backup = backupDirFor(o);
  backupDir = backup;
  let moved = 0;

  // ---------- Claude Code
  if (c) {
    step('Claude Code: remove jb-memory');
    // Project and local scopes first, user scope last: if one of those can't
    // be removed, the installer can't run, and jb-memory then stays at user
    // scope so there is still a plugin.
    for (const p of c.plugins) if (p.scope !== 'user') uninstallClaude(claude, p, o);
    if (o.install && !o.keepUser && c.plugins.some(p => p.scope !== 'user') && c.plugins.some(p => p.scope === 'user')) {
      const stuck = surveyClaude(claude).plugins.filter(p => p.scope !== 'user');
      if (stuck.length) {
        warn(`jb-memory is still installed at ${stuck.map(p => `${p.scope} scope${p.projectPath ? ' in ' + p.projectPath : ''}`).join(', ')}, so the installer can't run; jb-memory is kept at user scope, so you still have a plugin`);
        later('Remove jb-memory from the scopes above by hand (the warnings say how), then run this again.');
        o.keepUser = true;
        o.install = false;
      }
    }
    if (!o.keepUser) for (const p of c.plugins) if (p.scope === 'user') uninstallClaude(claude, p, o);
    // Uninstall left nothing at any scope? Then the marketplaces and cache can go.
    const after = surveyClaude(claude);
    const left = after.plugins.filter(p => (o.projectScopes && p.scope !== 'user') || (p.scope === 'user' && !o.keepUser));
    if (left.length) {
      warn(`still installed: ${left.map(p => `${p.id} (${p.scope})`).join(', ')}`);
      for (const p of left) later(`Uninstall ${p.id} by hand${p.projectPath ? ` from ${p.projectPath}` : ''}: claude plugin uninstall ${p.id} --scope ${p.scope}${p.projectPath ? ' (run it in that folder)' : ''}. Then run this again.`);
      if (o.install) { info('the installer is skipped: it refuses while jb-memory is installed anywhere'); o.install = false; }
    }
    for (const m of c.oldMarketplaces) {
      if (!SAFE.test(m.name)) { warn(`skipped a marketplace with an unusual name: ${JSON.stringify(m.name)}`); continue; }
      // A marketplace Claude Code copied into its own folder (from GitHub or a
      // URL) is deleted with it, and that copy may also be the folder of a
      // Codex marketplace kept for the ChatGPT app.
      if (codexMayUse(m, x)) {
        info(`kept the marketplace ${m.name}: Codex's jb-memory-codex marketplace uses its folder; run this again once jb-memory-codex is uninstalled in the ChatGPT app`);
        later(`Run this again once jb-memory-codex is uninstalled in the ChatGPT app: it then removes the Claude Code marketplace ${m.name}, whose folder Codex uses.`);
        continue;
      }
      const still = (after.others || []).concat(after.trailmark).filter(p => p.id.split('@')[1] === m.name);
      // Kept only while something is installed from it. A jb-memory marketplace
      // that now points at this release (unpacked over the old folder) goes,
      // and the installer adds it again as trailmark.
      if (still.length || m.name === 'trailmark') { info(`kept the marketplace ${m.name}: ${still.length ? still.map(p => p.id).join(', ') + ' still comes from it' : 'it is Trailmark\'s own'}`); continue; }
      if (after.plugins.some(p => p.id.split('@')[1] === m.name)) { info(`kept the marketplace ${m.name}: jb-memory is still installed from it`); continue; }
      // A marketplace of yours that offers other plugins too stays; only one
      // that offers nothing but jb-memory (or Trailmark's own release) goes.
      if (m.path && !NET.test(m.path)) {
        const man = readJson(path.join(m.path, '.claude-plugin', 'marketplace.json'));
        const extra = man && Array.isArray(man.plugins) ? man.plugins.map(q => String((q && q.name) || '').toLowerCase()).filter(n => n && n !== OLD_PLUGIN && n !== 'trailmark') : [];
        if (extra.length) { info(`kept the marketplace ${m.name}: it also offers ${extra.join(', ')}`); continue; }
      }
      const r = run(claude, ['plugin', 'marketplace', 'remove', m.name, '--json']);
      const j = lastJsonLine(r.out);
      if (r.code === 0 || (j && j.failureCode === 'not_configured')) ok(`removed the marketplace ${m.name}`);
      else {
        warn(`claude plugin marketplace remove ${m.name} failed: ${(j && j.message) || r.err.trim().split('\n')[0] || 'exit ' + r.code}`);
        later(`Remove the old marketplace by hand: claude plugin marketplace remove ${m.name}`);
      }
    }
    if (o.cache) {
      if (after.plugins.length && !o.projectScopes) info('old cache copies kept: jb-memory is still installed at project or local scope (--keep-project-scopes)');
      else if (after.plugins.length) warn('old cache copies kept, since jb-memory is still installed somewhere');
      else {
        for (const d of surveyClaude(claude).cache) {
          try { ok(`moved ${d}\n          to ${moveAside(d, backup, 'claude-cache')}`); moved++; } catch (e) { warn(`could not move ${d}: ${e.message}`); }
        }
        if (!c.cache.length) ok('no old copies in the plugin cache');
      }
    }
    if (o.scan.length) { step('Scan for repos that still turn jb-memory on'); doScan(); }
    for (const f of c.settingsHooks) later(`${f} has a hook that runs jb-memory's jbm.js. Remove that hook by hand (it runs next to Trailmark's). This script doesn't edit settings files.`);
  }

  // ---------- Codex
  if (x && x.used) {
    step('Codex: remove jb-memory-codex');
    // A Codex step that throws (a path the shell can't be given safely, say)
    // must not stop the run before Trailmark is installed below.
    try {
    if (x.orphan) {
      if (x.orphanFrom && codex && !oldCodexRelease([x.orphanFrom], x.orphanMkt)) {
        later(`The old release at ${x.orphanFrom} is gone now. Run this again with --old-release <a copy of your old jb-memory release>, then uninstall jb-memory-codex in the ChatGPT app.`);
      } else if (x.orphanFrom && codex) {
        // A same-named marketplace that no longer offers the plugin goes first.
        for (const m of x.oldMarketplaces.filter(q => q.stale && SAFE.test(q.name))) {
          const rr = run(codex, ['plugin', 'marketplace', 'remove', m.name]);
          if (rr.code === 0) ok(`removed the Codex marketplace ${m.name}, which no longer offers jb-memory-codex`);
          else warn(`codex plugin marketplace remove ${m.name} failed: ${(rr.err || rr.out).trim().split('\n')[0] || 'exit ' + rr.code}`);
        }
        const r = run(codex, ['plugin', 'marketplace', 'add', x.orphanFrom]);
        if (r.code === 0) ok(`added the old Codex marketplace back from ${x.orphanFrom}`);
        else {
          warn(`codex plugin marketplace add ${x.orphanFrom} failed: ${(r.err || r.out).trim().split('\n')[0] || 'exit ' + r.code}`);
          later(`Add the old Codex marketplace back by hand, so the ChatGPT app shows jb-memory-codex to uninstall: codex plugin marketplace remove ${x.orphanMkt || OLD_CODEX} (if it is still listed), then codex plugin marketplace add "${x.orphanFrom}"`);
        }
      }
    }
    if (!codex && x.oldMarketplaces.length && !x.installed.length) later(`Remove the old Codex marketplace: codex plugin marketplace remove ${x.oldMarketplaces[0].name} (the codex command wasn't on PATH here).`);
    for (const m of codex && !x.installed.length ? x.oldMarketplaces : []) {
      if (!SAFE.test(m.name)) { warn(`skipped a marketplace with an unusual name: ${JSON.stringify(m.name)}`); continue; }
      const others = (x.fromMkt[m.name] || []).filter(n => n.toLowerCase() !== OLD_CODEX);
      if (others.length) { info(`kept the Codex marketplace ${m.name}: ${others.join(', ')} still comes from it`); continue; }
      // A marketplace of yours that offers other plugins too stays, as on the
      // Claude Code side.
      const extra = codexOffersOthers(m);
      if (extra.length) { info(`kept the Codex marketplace ${m.name}: it also offers ${extra.join(', ')}`); continue; }
      const r = run(codex, ['plugin', 'marketplace', 'remove', m.name]);
      if (r.code === 0) ok(`removed the Codex marketplace ${m.name}`);
      else if (/not configured|not found|no such marketplace/i.test(r.err + r.out)) ok(`the Codex marketplace ${m.name} was already gone`);
      else warn(`codex plugin marketplace remove ${m.name} failed: ${(r.err || r.out).trim().split('\n')[0] || 'exit ' + r.code}`);
    }
    if (!x.oldMarketplaces.length && !x.orphan) ok('no old Codex marketplace');
    else if (x.installed.length && x.oldMarketplaces.length) info(`kept the Codex marketplace ${x.oldMarketplaces.map(m => m.name).join(', ')}: the ChatGPT app shows jb-memory-codex, and so lets you uninstall it, only through it`);
    x.installed = surveyCodex(codex).installed;
    if (x.installed.length) {
      later(`In the ChatGPT app, open Plugins and uninstall ${x.installed.join(', ')} (Codex installs and uninstalls plugins only there), quit the app, then run this again: it moves the old copy out of Codex's cache once it is uninstalled.`);
      info('old Codex cache copies kept until the plugin is uninstalled in the ChatGPT app');
    } else if (o.cache) {
      for (const d of x.cache) {
        try { ok(`moved ${d}\n          to ${moveAside(d, backup, 'codex-cache')}`); moved++; } catch (e) { warn(`could not move ${d}: ${e.message}`); later(`Move ${d} out of Codex's plugin cache by hand (quit the ChatGPT app first), or run this again: each chat start warns while it is there.`); }
      }
      if (!x.cache.length) ok('no old copies in Codex\'s plugin cache');
    }
    if (!x.installed.length && x.trust) {
      if (!o.cleanTrust) { /* said in Look */ }
      else if (runningPrograms().codex) later('Quit the ChatGPT app, then run this again with --clean-codex-trust: the app may write config.toml while it runs.');
      else {
        const cfg = path.join(x.home, 'config.toml');
        let isLink = false;
        try { isLink = fs.lstatSync(cfg).isSymbolicLink(); } catch { /* missing */ }
        const before = readText(cfg);
        const w = before === null ? { removed: 0 } : withoutTrust(before);
        if (isLink) later(`${cfg} is a link, which this script doesn't write through. Remove the [hooks.state."jb-memory-codex@..."] tables from the file it points to by hand, if you want them gone.`);
        else if (w.unsafe) later(`${cfg} has something other than plain settings inside a jb-memory-codex hook-trust table, so nothing was removed. Remove those tables by hand, if you want them gone.`);
        else if (w.removed) {
          const bak = path.join(backup, 'codex-config.toml');
          try {
            // config.toml can hold tokens: the copy is readable only by you.
            fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
            fs.writeFileSync(bak, before, { mode: 0o600 });
            fs.writeFileSync(cfg, w.text);
            ok(`removed ${w.removed} lines of jb-memory-codex hook-trust records from config.toml (backup: ${bak})`);
          } catch (e) {
            warn(`could not rewrite ${cfg}: ${e.message}`);
            later(`${cfg} couldn't be written (${e.code || 'error'}); the hook-trust records are still there. They do nothing, so this can wait.`);
          }
        }
      }
    }
    } catch (e) {
      warn(`a Codex step stopped: ${e.message}`);
      later('The Codex steps stopped early (the warning above says why). Fix that, then run this again; Claude Code steps already done are skipped.');
    }
  }

  // ---------- install
  let installed = true;
  if (o.install) {
    step('Install Trailmark');
    if (!o.claude || o.mktOnly) {
      if (!codex) { warn('the codex command isn\'t on PATH, so the trailmark-codex marketplace wasn\'t added'); later(`Add the Codex marketplace: codex plugin marketplace add "${HERE}"`); }
      else if (x && x.trailmarkMarketplace) ok('the trailmark-codex marketplace is already added');
      else {
        let r;
        try { r = run(codex, ['plugin', 'marketplace', 'add', HERE]); } catch (e) { r = { code: 1, out: '', err: e.message }; }
        if (r.code === 0) ok(`added the trailmark-codex marketplace (${HERE})`);
        else { warn(`codex plugin marketplace add failed: ${(r.err || r.out).trim().split('\n')[0]}`); later(`Add the Codex marketplace by hand: codex plugin marketplace add "${HERE}"`); installed = false; }
      }
    } else {
      const r = runInstaller(o.flags, true);
      out('');
      if (r.code === 0) ok('the installer finished');
      else if (r.code === 3) { ok('the installer finished; trailmark-watchdog was not installed (its message is above)'); later(`trailmark-watchdog wasn't installed. When you're ready: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(HERE, 'tools', 'windows', 'install-trailmark-watchdog.ps1')}"`); }
      else {
        warn(`the installer stopped (exit ${r.code}); its message is above`);
        installed = false;
        // jb-memory is already gone here: say how to finish, or how to go back.
        // Back only from a local copy of the old release that still offers
        // jb-memory: the GitHub repo under the old name is Trailmark now, so
        // adding it from there gives a marketplace named trailmark instead.
        const back = oldClaudeRelease([o.oldRelease, ...(c ? c.oldMarketplaces.map(m => m.path) : []), ...siblingReleases()]);
        later(`Neither jb-memory nor Trailmark may be installed now. Fix what the installer says, then run it again: ${WIN ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(HERE, 'install.ps1')}"` : `"${path.join(HERE, 'install.sh')}"`}${back ? `. To go back to jb-memory meanwhile: claude plugin marketplace add "${back.folder}", then claude plugin install jb-memory@${back.name}` : '. To go back to jb-memory meanwhile, you need a copy of the old jb-memory release folder (its GitHub repo is Trailmark now)'}`);
      }
      if (installed && wasOff) later(`${c.plugins.some(p => p.scope === 'user' && !p.enabled) ? 'jb-memory' : 'Trailmark'} was turned off at user scope, and the installer turned Trailmark on. To turn it off: claude plugin disable trailmark@trailmark --scope user`);
    }
  }

  // ---------- check
  step('Check');
  let clean = true;
  if (c) {
    const end = surveyClaude(claude);
    const tm = end.trailmark.find(p => p.id === 'trailmark@trailmark' && p.scope === 'user');
    if (o.install || current) {
      if (tm && tm.enabled) ok(`Trailmark ${tm.version} installed and on (trailmark@trailmark, user scope)`);
      else if (tm && (!o.install || o.mktOnly) && current && !current.enabled) ok(`Trailmark ${tm.version} installed, turned off as before (trailmark@trailmark, user scope)`);
      else { warn('Trailmark isn\'t installed and on at user scope'); clean = false; }
    }
    const strays = end.trailmark.filter(p => p.id !== 'trailmark@trailmark');
    if (strays.length) { warn(`Trailmark is also installed as ${strays.map(p => p.id).join(', ')}; two copies would each run every hook`); clean = false; }
    if (end.plugins.length) { warn(`jb-memory still installed: ${end.plugins.map(p => `${p.id} (${p.scope})`).join(', ')}`); clean = false; } else ok('no jb-memory install left');
    if (end.cache.length && o.cache) { warn(`old copies still in the plugin cache: ${end.cache.join(', ')}`); clean = false; } else if (!end.cache.length) ok('no old copies in the plugin cache');
    if (end.memoryFolders !== c.memoryFolders) { warn(`memory folders set up: ${end.memoryFolders}, was ${c.memoryFolders}`); clean = false; } else ok(`memory folders set up: ${end.memoryFolders}, as before`);
  }
  if (x && x.used) {
    const end = surveyCodex(codex);
    // One kept on purpose (other plugins come from it or it offers them) isn't a leftover.
    // Nor is one kept until jb-memory-codex is uninstalled in the app.
    const leftover = end.installed.length ? [] : end.oldMarketplaces.filter(m => !codexOffersOthers(m).length && !(end.fromMkt[m.name] || []).some(n => n.toLowerCase() !== OLD_CODEX));
    if (leftover.length) { warn(`old Codex marketplace still configured: ${leftover.map(m => m.name).join(', ')}`); clean = false; }
    if (end.installed.length) { warn(`jb-memory-codex still installed in the ChatGPT app`); clean = false; }
    if (o.install && codex && end.listOk) { if (end.trailmarkMarketplace) ok('the trailmark-codex marketplace is added'); else { warn(end.trailmarkElsewhere ? `the trailmark-codex marketplace points at ${end.trailmarkElsewhere}, not this folder` : 'the trailmark-codex marketplace isn\'t listed by Codex'); clean = false; } }
  }

  if (WIN && watchdog && o.flags) {
    const wd2 = oldWatchdog();
    if (wd2.tasks.length) { warn(`the old watchdog's tasks are still there: ${wd2.tasks.join(', ')}`); clean = false; }
    const schtasks = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
    if (run(schtasks, ['/Query', '/TN', 'trailmark-watchdog']).code === 0) ok('trailmark-watchdog is installed'); else { warn('trailmark-watchdog isn\'t installed'); clean = false; }
  }

  // ---------- report
  out(''); out(`Log${moved ? ' and the old copies' : ''}: ${backup}`);
  if (moved) out('Delete that folder once Trailmark works for you.');
  if (codexPending()) later('In the ChatGPT app: restart it, open Plugins, choose the trailmark-codex marketplace, install trailmark-codex, then review and trust its hooks when asked. Its skills are tm-checkpoint, tm-recall and so on.');
  if (wd.folder && !wd.tasks.length) later(`The old watchdog's log and known-good list are in ${wd.folder}; delete that folder when you no longer need them.`);
  if (todo.length) {
    out(''); out('Left for you:');
    todo.forEach((t, i) => out(`  ${i + 1}. ${t}`));
  }
  out('');
  out('Then start a new Claude Code session in a repo you had set up: a status line starting [trailmark] and ending "sandbox on" means it works. Skills are now /trailmark:checkpoint and so on.');
  writeLog();
  if (!installed) return 1;
  return todo.length || !clean ? 2 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  if (!(e instanceof Stop)) { out(`  FAIL  ${e && e.stack ? e.stack : e}`); }
  out(''); out('Stopped. Anything listed as ok above was done; run this again to carry on.');
  writeLog();
  process.exitCode = 1;
}

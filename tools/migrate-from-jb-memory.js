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
//   2. Shows the plan and asks before changing anything (--yes skips asking).
//   3. Claude Code: uninstalls each jb-memory install with `claude plugin
//      uninstall`, scope by scope (project and local ones from their repo's
//      folder), then removes the old marketplace with `claude plugin
//      marketplace remove`, unless another installed plugin still comes from it.
//   4. Moves the old copies out of Claude Code's plugin cache into a backup
//      folder. Claude Code leaves them there after an uninstall, and both
//      Trailmark and the watchdog warn about them, since a cached copy can run.
//   5. Codex: removes the jb-memory-codex marketplace with `codex plugin
//      marketplace remove`. The plugin itself can only be uninstalled in the
//      ChatGPT app, so while Codex's config.toml still lists it, this says so
//      and leaves its cache alone; run this again after uninstalling it there.
//      Once it is gone from config.toml, old cache copies move to the backup.
//   6. Runs this release's installer (install.ps1 on Windows, install.sh
//      elsewhere), with -Codex/--codex when Codex is in use and, on Windows,
//      -Watchdog when the old watchdog was installed. The installer makes its
//      own checks and asks its own questions.
//   7. Checks the result: Trailmark installed and on, no jb-memory left in any
//      scope or in the cache, the memory folders all still there.
//
// It never touches memory folders, handoffs, .jbmem.json or any repo file,
// except the .claude/settings.json or settings.local.json of a repo where
// jb-memory was installed at project or local scope: `claude plugin uninstall`
// edits those (--keep-project-scopes leaves them). Cache copies are moved to
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
//   --backup-dir <folder>  where cache copies and the log go
//   --set-no-cwd-lookup, --allow-old-node, --repoint
//                          passed on to the installer (see MANUAL.md, section 3)
//
// Exit codes: 0 done; 1 stopped on an error; 2 done here, with steps left for
// you to do (listed at the end); 3 --dry-run found something to do.

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
    cache: true, watchdog: 'auto', backupDir: '', pass: [], help: false, scan: [],
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
      case '--scan': o.scan.push(argv[++i] || ''); if (!o.scan[o.scan.length - 1]) throw new Error('--scan needs a folder'); break;
      case '--backup-dir': o.backupDir = argv[++i] || ''; if (!o.backupDir) throw new Error('--backup-dir needs a folder'); break;
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

function run(prog, args, { cwd, inherit = false, timeout = 120000, env = process.env } = {}) {
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

// ---------- small file helpers

function readText(f, max = 4 * 1024 * 1024) {
  try { const st = fs.lstatSync(f); if (!st.isFile() || st.size > max) return null; return fs.readFileSync(f, 'utf8'); } catch { return null; }
}
function readJson(f) { const t = readText(f); if (t === null) return undefined; try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { return null; } }
function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }
function isDir(d) { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } }
const NET = /^(?:\\\\|\/\/|[\\/]\?\?[\\/])/;
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
    s.marketplaces = mj.map(x => ({ name: String((x && x.name) || ''), path: String((x && (x.path || x.installLocation)) || ''), source: String((x && x.source) || '') }));
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
  for (const mk of listDir(cache)) {
    if (!mk.isDirectory()) continue;
    for (const pl of listDir(path.join(cache, mk.name))) {
      if (!pl.isDirectory()) continue;
      const dir = path.join(cache, mk.name, pl.name);
      const named = pl.name.toLowerCase() === OLD_PLUGIN;
      const holdsOld = !named && listDir(dir).some(v => v.isDirectory() && fs.existsSync(path.join(dir, v.name, 'scripts', 'jbm.js')));
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
      try { const j = JSON.parse(t.replace(/^\uFEFF/, '')); if (j && j.enabledPlugins && Object.keys(j.enabledPlugins).some(k => k.split('@')[0].toLowerCase() === OLD_PLUGIN)) found.push(path.join(d, '.claude', f)); } catch { /* not JSON */ }
    }
    for (const e of listDir(d)) if (e.isDirectory() && !skip.has(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(path.resolve(root), 0);
  return { found, partial: seen > maxDirs };
}

// ---------- survey: Codex

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

function surveyCodex(codex) {
  const s = { home: codexHome(), used: false, marketplaces: [], oldMarketplaces: [], installed: [], cache: [], listOk: false, trailmarkMarketplace: false };
  s.used = !!codex || isDir(s.home);
  const cfgText = readText(path.join(s.home, 'config.toml')) || '';
  for (const m of cfgText.matchAll(/^\s*\[\s*plugins\s*\.\s*"([^"]+)"\s*\]/gm)) {
    const id = m[1];
    if (id.split('@')[0].toLowerCase() === OLD_CODEX) s.installed.push(id);
  }
  // The exact shape Codex uses isn't documented, so any other mention of the
  // old plugin's name counts as installed too: its cache then stays put.
  // Marketplace entries and hook-trust records ([hooks.state."<plugin>:..."],
  // which can outlive the plugin) don't mean it is installed.
  const mentions = cfgText.split(/\r?\n/).filter(l => /jb-memory-codex/i.test(l) && !/^\s*\[\s*(?:marketplaces|hooks\s*\.\s*state)\b/i.test(l) && !/^\s*#/.test(l));
  if (!s.installed.length && mentions.length) s.installed.push(`${OLD_CODEX} (named in config.toml)`);
  for (const m of cfgText.matchAll(/^\s*\[\s*marketplaces\s*\.\s*"?([\w.+-]+)"?\s*\]/gm)) {
    if (/^jb-memory/i.test(m[1])) s.oldMarketplaces.push({ name: m[1], from: 'config.toml' });
  }
  if (codex) {
    const l = run(codex, ['plugin', 'marketplace', 'list', '--json']);
    const j = l.code === 0 ? jsonOf(l.out) : undefined;
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.marketplaces) ? j.marketplaces : null);
    if (arr) {
      s.listOk = true;
      for (const x of arr) {
        const name = String((x && x.name) || '');
        const p = String((x && (x.path || x.root || x.installLocation)) || '');
        s.marketplaces.push({ name, path: p });
        let provides = false;
        if (p && !NET.test(p)) {
          const man = readJson(path.join(p, '.agents', 'plugins', 'marketplace.json'));
          provides = !!(man && Array.isArray(man.plugins) && man.plugins.some(q => q && String(q.name).toLowerCase() === OLD_CODEX));
        }
        if (name === 'trailmark-codex') s.trailmarkMarketplace = true;
        if ((provides || /^jb-memory/i.test(name)) && !s.oldMarketplaces.some(o => o.name === name)) s.oldMarketplaces.push({ name, path: p });
      }
    } else {
      // Older Codex without --json: the plain list, one name per line.
      const t = run(codex, ['plugin', 'marketplace', 'list']);
      if (t.code === 0) {
        s.listOk = true;
        for (const w of t.out.split(/\s+/)) {
          if (/^jb-memory[\w.+-]*$/i.test(w) && !s.oldMarketplaces.some(o => o.name === w)) s.oldMarketplaces.push({ name: w });
          if (w === 'trailmark-codex') s.trailmarkMarketplace = true;
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

function uninstallClaude(claude, p, o) {
  const args = ['plugin', 'uninstall', p.id, '--scope', p.scope, '--json'];
  if (!SAFE.test(p.id) || !/^(user|project|local)$/.test(p.scope)) { warn(`skipped an install with an unusual id or scope: ${JSON.stringify(p)}`); return false; }
  let cwd;
  if (p.scope !== 'user') {
    if (!o.projectScopes) { info(`left ${p.id} at ${p.scope} scope in ${p.projectPath} (--keep-project-scopes)`); later(`jb-memory is still installed at ${p.scope} scope in ${p.projectPath}; Trailmark will warn there until it is removed.`); return false; }
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
  if (cwd && !isDir(cwd)) {
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
  const man = readJson(path.join(HERE, '.claude-plugin', 'marketplace.json'));
  if (!man || man.name !== 'trailmark' || !fs.existsSync(path.join(HERE, 'plugins', 'trailmark', '.claude-plugin', 'plugin.json'))) fail(`${HERE} isn't a Trailmark release folder (no trailmark marketplace.json).`);
  const claude = o.claude || o.install ? findProgram('claude') : '';
  const codex = o.codex ? findProgram('codex') : '';
  if (o.claude && !claude) fail('the claude command isn\'t on PATH. Install Claude Code 2.1.304 or later first, or run with --codex-only.');
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
    if (!x.used) info(`Codex: not found (no codex command, no ${x.home})`);
    for (const id of x.installed) info(`Codex plugin installed: ${id} (listed in ${path.join(x.home, 'config.toml')})`);
    for (const m of x.oldMarketplaces) info(`old Codex marketplace: ${m.name}${m.path ? ' -> ' + m.path : ''}`);
    for (const d of x.cache) info(`old copy in Codex's plugin cache: ${d}`);
    if (x.used && codex && !x.listOk) warn('codex plugin marketplace list failed, so old Codex marketplaces could not be listed');
    if (x.used && !codex && x.oldMarketplaces.length) warn('the codex command isn\'t on PATH, so the old Codex marketplace can\'t be removed from here');
  }
  if (wd.tasks.length) info(`old watchdog tasks: ${wd.tasks.join(', ')}`);
  for (const root of o.scan) {
    if (NET.test(root) || !isDir(root)) { warn(`--scan ${root}: not a local folder`); continue; }
    const r = scanRepos(root);
    for (const f of r.found) {
      warn(`${f} turns jb-memory on`);
      later(`${f} still turns jb-memory on. Remove the "jb-memory@..." line from its enabledPlugins (and any jb-memory entry under extraKnownMarketplaces), then commit it if the file is committed. This script doesn't edit repo files.`);
    }
    if (!r.found.length) ok(`--scan ${root}: no repo settings turn jb-memory on`);
    if (r.partial) warn(`--scan ${root}: stopped after 20,000 folders; scan a smaller folder to be sure`);
  }
  const run1 = runningPrograms();

  // ---------- plan
  const plan = [];
  if (c) {
    for (const p of c.plugins) if (p.scope === 'user' || o.projectScopes) plan.push(`uninstall ${p.id} (${p.scope}${p.projectPath ? ', ' + p.projectPath : ''})`);
    for (const m of c.oldMarketplaces) plan.push(`remove the Claude Code marketplace ${m.name}`);
    if (o.cache) for (const d of c.cache) plan.push(`move ${d} to the backup folder`);
  }
  if (x) {
    for (const m of x.oldMarketplaces) plan.push(`remove the Codex marketplace ${m.name}`);
    if (o.cache && !x.installed.length) for (const d of x.cache) plan.push(`move ${d} to the backup folder`);
  }
  const useCodex = !!(x && x.used && codex);
  // The old watchdog is running only while its tasks exist; its folder stays
  // behind on purpose, with the old log, once the new watchdog replaced it.
  const watchdog = WIN && (o.watchdog === 'yes' || (o.watchdog === 'auto' && wd.tasks.length > 0));
  const current = c && c.trailmark.find(p => p.id === 'trailmark@trailmark' && p.scope === 'user' && p.enabled && p.folder && samePath(p.folder, path.join(HERE, 'plugins', 'trailmark')));
  const codexCurrent = !useCodex || (x && x.trailmarkMarketplace);
  if (o.install && current && codexCurrent && !c.plugins.length && !watchdog) {
    info('Trailmark from this folder is already installed and on, so the installer is skipped');
    o.install = false;
  }
  if (o.install) {
    const flags = [];
    if (useCodex) flags.push(WIN ? '-Codex' : '--codex');
    if (watchdog) flags.push('-Watchdog');
    for (const p of o.pass) {
      if (WIN) flags.push({ '--set-no-cwd-lookup': '-SetNoCwdLookup', '--allow-old-node': '-AllowOldNode', '--repoint': '-Repoint' }[p]);
      else if (p !== '--set-no-cwd-lookup') flags.push(p);
    }
    if (!o.claude) plan.push(`add the trailmark-codex marketplace (codex plugin marketplace add ${HERE})`);
    else plan.push(`run ${WIN ? 'install.ps1' : 'install.sh'}${flags.length ? ' ' + flags.join(' ') : ''}`);
    o.flags = flags;
  }

  // The new Codex plugin is installed in the ChatGPT app, not from here; until
  // config.toml names it, say so on every run.
  // Installed means a [plugins."trailmark-codex@..."] table; adding the
  // marketplace also writes its name into config.toml, so a bare mention
  // doesn't count.
  const codexInstalled = () => /^\s*\[\s*plugins\s*\.\s*"trailmark-codex@/im.test(readText(path.join(codexHome(), 'config.toml')) || '');
  const codexPending = () => useCodex && !codexInstalled();
  step('Plan');
  if (!plan.length) {
    ok('nothing to do here');
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
    if (!process.stdin.isTTY) fail('nothing was changed: run it in a terminal to be asked, or pass --yes.');
    process.stdout.write('\nGo ahead? [y/N] ');
    const buf = Buffer.alloc(16);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, 16, null); } catch { n = 0; }
    if (!/^\s*y(es)?\s*$/i.test(buf.slice(0, n).toString())) { out('Nothing was changed.'); return 1; }
  }

  const backup = backupDirFor(o);
  backupDir = backup;
  let moved = 0;

  // ---------- Claude Code
  if (c) {
    step('Claude Code: remove jb-memory');
    for (const p of c.plugins) uninstallClaude(claude, p, o);
    // Uninstall left nothing at any scope? Then the marketplaces and cache can go.
    const after = surveyClaude(claude);
    const left = after.plugins.filter(p => o.projectScopes || p.scope === 'user');
    if (left.length) warn(`still installed: ${left.map(p => `${p.id} (${p.scope})`).join(', ')}`);
    for (const m of c.oldMarketplaces) {
      if (!SAFE.test(m.name)) { warn(`skipped a marketplace with an unusual name: ${JSON.stringify(m.name)}`); continue; }
      const still = (after.others || []).concat(after.trailmark).filter(p => p.id.split('@')[1] === m.name);
      if (still.length || m.alsoTrailmark || m.name === 'trailmark') { info(`kept the marketplace ${m.name}: ${still.length ? still.map(p => p.id).join(', ') + ' still comes from it' : 'it also provides Trailmark'}`); continue; }
      if (after.plugins.some(p => p.id.split('@')[1] === m.name)) { info(`kept the marketplace ${m.name}: jb-memory is still installed from it`); continue; }
      const r = run(claude, ['plugin', 'marketplace', 'remove', m.name, '--json']);
      const j = lastJsonLine(r.out);
      if (r.code === 0 || (j && j.failureCode === 'not_configured')) ok(`removed the marketplace ${m.name}`);
      else warn(`claude plugin marketplace remove ${m.name} failed: ${(j && j.message) || r.err.trim().split('\n')[0] || 'exit ' + r.code}`);
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
    for (const f of c.settingsHooks) later(`${f} has a hook that runs jb-memory's jbm.js. Remove that hook by hand (it runs next to Trailmark's). This script doesn't edit settings files.`);
  }

  // ---------- Codex
  if (x && x.used) {
    step('Codex: remove jb-memory-codex');
    if (!codex && x.oldMarketplaces.length) later(`Remove the old Codex marketplace: codex plugin marketplace remove ${x.oldMarketplaces[0].name} (the codex command wasn't on PATH here).`);
    for (const m of codex ? x.oldMarketplaces : []) {
      if (!SAFE.test(m.name)) { warn(`skipped a marketplace with an unusual name: ${JSON.stringify(m.name)}`); continue; }
      const r = run(codex, ['plugin', 'marketplace', 'remove', m.name]);
      if (r.code === 0) ok(`removed the Codex marketplace ${m.name}`);
      else if (/not found|no marketplace|unknown/i.test(r.err + r.out)) ok(`the Codex marketplace ${m.name} was already gone`);
      else warn(`codex plugin marketplace remove ${m.name} failed: ${(r.err || r.out).trim().split('\n')[0] || 'exit ' + r.code}`);
    }
    if (!x.oldMarketplaces.length) ok('no old Codex marketplace');
    x.installed = surveyCodex(codex).installed;
    if (x.installed.length) {
      later(`In the ChatGPT app, open Plugins and uninstall ${x.installed.join(', ')} (Codex installs and uninstalls plugins only there), quit the app, then run this again: it moves the old copy out of Codex's cache once it is uninstalled.`);
      info('old Codex cache copies kept until the plugin is uninstalled in the ChatGPT app');
    } else if (o.cache) {
      for (const d of x.cache) {
        try { ok(`moved ${d}\n          to ${moveAside(d, backup, 'codex-cache')}`); moved++; } catch (e) { warn(`could not move ${d}: ${e.message}`); }
      }
      if (!x.cache.length) ok('no old copies in Codex\'s plugin cache');
    }
  }

  // ---------- install
  let installed = true;
  if (o.install) {
    step('Install Trailmark');
    if (!o.claude) {
      if (!codex) { warn('the codex command isn\'t on PATH, so the trailmark-codex marketplace wasn\'t added'); later(`Add the Codex marketplace: codex plugin marketplace add "${HERE}"`); }
      else if (x && x.trailmarkMarketplace) ok('the trailmark-codex marketplace is already added');
      else {
        const r = run(codex, ['plugin', 'marketplace', 'add', HERE]);
        if (r.code === 0) ok(`added the trailmark-codex marketplace (${HERE})`);
        else { warn(`codex plugin marketplace add failed: ${(r.err || r.out).trim().split('\n')[0]}`); installed = false; }
      }
    } else {
      let r;
      if (WIN) {
        const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        // Without PowerShell 7's PSModulePath: Windows PowerShell 5.1 started
        // with it can't load its own Get-Acl and the like (install.ps1 also
        // drops those entries itself).
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
        r = run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'install.ps1'), ...o.flags], { cwd: HERE, inherit: true, timeout: 30 * 60000, env });
      } else {
        r = run('/bin/bash', [path.join(HERE, 'install.sh'), ...o.flags], { cwd: HERE, inherit: true, timeout: 30 * 60000 });
      }
      out('');
      if (r.code === 0) ok('the installer finished');
      else { warn(`the installer stopped (exit ${r.code}); its message is above`); installed = false; }
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
    if (end.oldMarketplaces.length) { warn(`old Codex marketplace still configured: ${end.oldMarketplaces.map(m => m.name).join(', ')}`); clean = false; }
    if (end.installed.length) { warn(`jb-memory-codex still installed in the ChatGPT app`); clean = false; }
    if (o.install && codex && end.listOk) { if (end.trailmarkMarketplace) ok('the trailmark-codex marketplace is added'); else { warn('the trailmark-codex marketplace isn\'t listed by Codex'); clean = false; } }
  }

  // ---------- report
  out(''); out(`Log${moved ? ' and the old copies' : ''}: ${backup}`);
  if (moved) out('Delete that folder once Trailmark works for you.');
  if (codexPending() || (!o.claude && codex && !codexInstalled())) later('In the ChatGPT app: restart it, open Plugins, choose the trailmark-codex marketplace, install trailmark-codex, then review and trust its hooks when asked. Its skills are tm-checkpoint, tm-recall and so on.');
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

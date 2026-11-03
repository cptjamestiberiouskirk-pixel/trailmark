// Checks on what trailmark runs with, for the session-start hook and the
// sandbox check. They read only; nothing here changes a file.
//
// nodeAdvice: the Node release lines with the October 2026 security fixes
// and the first fixed version of each. Two of those fixes are in the
// permission model this plugin uses as its sandbox (CVE-2026-58043 in July,
// CVE-2026-106073 in October). Older releases still pass the sandbox check,
// so the check alone can't tell; the version can.
//
// otherCopies: copies of trailmark in Claude Code's plugin cache other than
// the one running. A session once found an old cached copy by searching the
// disk and ran it: it wrote the handoff without the version check. Naming
// them at session start tells the model which copy not to run, and the user
// which folder to remove.
//
// The cache is data anyone with write access to the profile can shape, so
// the walk is bounded (entries per folder, bytes per file, total time) and
// says when it stopped early instead of reporting a short list as complete.
// Links that point at a network path (\\server\share) are never followed:
// following one would connect to that server.

'use strict';

const fs = require('fs');
const path = require('path');

const NODE_FLOORS = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
const OLDEST_LINE = 22;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function before(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// '' when the version is fine or its line is newer than this list knows;
// otherwise one sentence saying what to install.
function nodeAdvice(version) {
  const v = parseVersion(version);
  if (!v) return '';
  const floor = NODE_FLOORS[v[0]];
  if (floor) {
    return before(v, floor) ? `Node ${version} is older than the October 2026 security release for its line (${floor.join('.')}), which fixes the permission model trailmark's sandbox relies on. Update Node.` : '';
  }
  if (v[0] < OLDEST_LINE) return `Node ${version} is out of support. Install Node 24.22.1 or later.`;
  if (v[0] < 26 && v[0] % 2 === 1) return `Node ${version} is not a long-term-support line and gets no security releases. Install Node 24.22.1 or later.`;
  return '';
}

// A small file's text, or null when it is missing, not a file, or over max
// bytes (never read in full).
function readSmall(file, max) {
  if (!local(path.dirname(file)) || !local(file)) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

// Every installPath string in Claude Code's installed_plugins.json, whatever
// its layout version. ok is false when the file is there but couldn't be
// read within the limits.
function installPaths(configDir) {
  const file = path.join(configDir, 'plugins', 'installed_plugins.json');
  // Looked up only once the folders on the way are known to be local: the
  // plugins folder could itself be a link to a share.
  if (!local(path.dirname(file)) || !local(file)) return { ok: false, paths: [] };
  if (!fs.existsSync(file)) return { ok: true, paths: [] };
  const text = readSmall(file, 1024 * 1024);
  if (text === null) return { ok: false, paths: [] };
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, paths: [] }; }
  const out = [];
  const stack = [j];
  let n = 0;
  let cut = false;
  while (stack.length && n++ < 5000) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      if (v.length > 1000) cut = true;
      for (let i = 0; i < v.length && i < 1000; i++) stack.push(v[i]);
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const entries = Object.entries(v);
    if (entries.length > 1000) cut = true;
    for (const [k, x] of entries.slice(0, 1000)) {
      if (k === 'installPath' && typeof x === 'string' && x && x.length < 4096) out.push(x);
      else if (x && typeof x === 'object') stack.push(x);
    }
  }
  if (stack.length || out.length > 200) cut = true;
  return { ok: !cut, paths: out.slice(0, 200) };
}

// \\server, //server and the NT form \??\UNC\server, as gitbin.js reads them.
const networkPath = p => /^(\\\\|\/\/|[\\/]\?\?[\\/])/.test(String(p || ''));

// False when p is a link (or under a link at its last step) that points at
// a network path: such a path is treated as missing, never touched.
function local(p) {
  // Every link on the way, read a part at a time (gitbin.localPath).
  return !networkPath(p) && !!require('./gitbin').localPath(p);
}

function realOr(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

// installPath strings come from installed_plugins.json, data like the rest
// of the cache: one that leads through a link to a share is never resolved.
function samePlace(a, b) {
  if (networkPath(a) || networkPath(b) || !local(a) || !local(b)) return false;
  const x = realOr(a), y = realOr(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// Folder names in dir, a linked folder (symlink or junction) included: an
// old copy behind a link still runs if someone points at it. Read one entry
// at a time and stop after max; full is false when entries were left unread.
function list(dir, max) {
  const out = [];
  // The folder itself may be a link (the cache, a marketplace): one that
  // leads to a network path is never opened.
  if (!local(dir)) return { names: out, full: false, net: true };
  let d;
  // A folder that is there but can't be listed is not an empty one.
  try { d = fs.opendirSync(dir); } catch (e) { return { names: out, full: !!(e && e.code === 'ENOENT') }; }
  let seen = 0;
  let full = true;
  try {
    for (;;) {
      const e = d.readSync();
      if (!e) break;
      if (++seen > max) { full = false; break; }
      if (e.isDirectory()) { out.push(e.name); continue; }
      if (e.isSymbolicLink()) {
        const p = path.join(dir, e.name);
        let target = '';
        try { target = fs.readlinkSync(p); } catch { continue; }
        if (networkPath(target) || !local(p)) continue;
        try { if (fs.statSync(p).isDirectory()) out.push(e.name); } catch { /* broken link */ }
      }
    }
  } catch { full = false; /* unreadable mid-way: keep what was read */ } finally {
    try { d.closeSync(); } catch { /* ignore */ }
  }
  return { names: out, full };
}

// A version as shown to the user and the model: plugin.json's version when
// it looks like one, else the folder name when that does, else a stand-in.
const SAFE_NAME = /^[\w.+-]{1,64}$/;
const showName = n => (SAFE_NAME.test(n) ? n : '<unusual name>');

// Copies at <config>/plugins/cache/<marketplace>/<plugin>/<version>/ whose
// plugin folder is named trailmark, or that hold trailmark's launcher, and
// that aren't the copy running (ownRoot). A copy Claude Code lists as
// installed (installPath in plugins/installed_plugins.json) is left out too:
// it may run from there.
// Returns { copies: [{ path, display, version }], incomplete }, where
// incomplete names why the walk stopped early ('' when it saw everything).
// <marketplace>/trailmark is looked at first in every marketplace, so the
// copies most likely to be run are found even when the walk stops early.
function otherCopies(configDir, ownRoot, { maxCopies = 10, budgetMs = 300, maxEntries = 200 } = {}) {
  const copies = [];
  const until = Date.now() + budgetMs;
  const why = new Set();
  const cache = path.join(configDir, 'plugins', 'cache');
  const inst = installPaths(configDir);
  if (!inst.ok) why.add('installed_plugins.json could not be read');
  const seen = new Set();
  // Copies under the old name count too: a jb-memory left installed or cached
  // from before the rename would run every hook a second time.
  const NAMES = ['trailmark', 'jb-memory'];
  const LAUNCHERS = ['trailmark.js', 'jbm.js'];
  const consider = (mkt, plugin, ver) => {
    const root = path.join(cache, mkt, plugin, ver);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) return;
    seen.add(key);
    const named = NAMES.includes(plugin.toLowerCase());
    const scripts = path.join(root, 'scripts');
    const hasLauncher = () => local(scripts) && LAUNCHERS.some(l => { const f = path.join(scripts, l); return local(f) && fs.existsSync(f); });
    if (!named && !hasLauncher()) return;
    // An installed Trailmark is the plugin itself. An installed copy under the
    // old name is not: it runs next to Trailmark, so it is named all the same.
    const current = plugin.toLowerCase() !== 'jb-memory' && local(scripts) && fs.existsSync(path.join(scripts, 'trailmark.js'));
    if (samePlace(root, ownRoot) || (current && inst.paths.some(p => samePlace(root, p)))) return;
    let version = SAFE_NAME.test(ver) ? ver : '';
    const text = readSmall(path.join(root, '.claude-plugin', 'plugin.json'), 4096);
    if (text !== null) {
      try {
        const j = JSON.parse(text);
        if (j && typeof j.version === 'string' && /^[\w.+-]{1,40}$/.test(j.version)) version = j.version;
      } catch { /* folder name stands in */ }
    }
    // display: the only form shown to the model or the user. Folder names are
    // data anyone with write access to the profile can choose, so any part
    // that isn't a plain name is replaced.
    const display = ['plugins', 'cache', showName(mkt), showName(plugin), showName(ver)].join('/');
    copies.push({ path: root, display, version: version || '<unusual name>' });
  };
  const late = () => { if (Date.now() > until) { why.add('it took too long'); return true; } return false; };
  const mkts = list(cache, maxEntries);
  if (mkts.net) why.add('the plugin cache leads to a network path');
  else if (!mkts.full) why.add('the plugin cache has too many folders');
  // Pass 1: <marketplace>/trailmark/<version>, and the same under the old name.
  outer1:
  for (const [mkt, name] of mkts.names.flatMap(m => NAMES.map(n => [m, n]))) {
    if (late()) break;
    const pdir = path.join(cache, mkt, name);
    let isDir = false;
    try { isDir = local(pdir) && fs.statSync(pdir).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    const vers = list(pdir, maxEntries);
    if (!vers.full) why.add(`${showName(mkt)}/${name} has too many folders`);
    for (const ver of vers.names) {
      if (late() || copies.length >= maxCopies) break outer1;
      consider(mkt, name, ver);
    }
  }
  // Pass 2: other plugin folders that hold trailmark.js (or the old jbm.js).
  outer2:
  for (const mkt of mkts.names) {
    if (late() || copies.length >= maxCopies) break;
    const plugins = list(path.join(cache, mkt), maxEntries);
    if (!plugins.full) why.add(`${showName(mkt)} has too many folders`);
    for (const plugin of plugins.names) {
      if (NAMES.includes(plugin.toLowerCase())) continue;
      if (late()) break outer2;
      const vers = list(path.join(cache, mkt, plugin), maxEntries);
      if (!vers.full) why.add('a plugin folder has too many folders');
      for (const ver of vers.names) {
        if (late() || copies.length >= maxCopies) break outer2;
        consider(mkt, plugin, ver);
      }
    }
  }
  if (copies.length >= maxCopies) why.add(`it stopped at ${maxCopies} copies`);
  return { copies, incomplete: [...why].join('; ') };
}

// '' unless the Node running this sits directly in one of folders (the
// session's folder or its repo's top folder). Every hook starts `node` by name; on Windows, cmd.exe,
// and Node's own child_process, look in the working folder before PATH, so a
// node.exe committed to a repo can run in place of the installed one. A
// planted program needn't run trailmark at all, so this can't catch a
// malicious one; it does catch a copy of Node sitting in a repo, and it is
// how test-node-lookup.ps1 reads which node a host started.
function nodeInside(execPath, folders, platform = process.platform) {
  if (typeof execPath !== 'string' || !execPath) return '';
  const P = platform === 'win32' ? path.win32 : path.posix;
  const fold = s => (platform === 'win32' ? s.toLowerCase() : s);
  // A trailing separator goes, except a drive or file-system root's own.
  const norm = (s) => {
    const r = P.resolve(String(s));
    const root = P.parse(r).root;
    return fold(r.length > root.length ? r.replace(/[\\/]+$/, '') : r);
  };
  // Only a node directly in the folder: the working-folder lookup doesn't
  // look in subfolders.
  const under = (b, d) => b === d;
  // Real paths too, where they can be read on this machine: a junction or an
  // 8.3 name can make the same folder look like two.
  const real = (s) => { if (platform !== process.platform) return ''; try { return norm(fs.realpathSync.native(s)); } catch { return ''; } };
  const bins = [norm(P.dirname(execPath)), real(P.dirname(execPath))].filter(Boolean);
  for (const f of folders || []) {
    if (typeof f !== 'string' || !f) continue;
    const ds = [norm(f), real(f)].filter(Boolean);
    if (bins.some(b => ds.some(d => under(b, d)))) {
      return `the Node running trailmark (${execPath.length > 200 ? '...' + execPath.slice(-197) : execPath}) is inside this session's folder or repo, so a node program there ran in place of the installed one. Remove it, and set NoDefaultCurrentDirectoryInExePath=1 (MANUAL.md, section 9)`;
    }
  }
  return '';
}

// jb-memory-codex, the Codex copy's name before 0.5.1, in Codex's own plugin
// cache: left installed, it would run every hook next to trailmark-codex.
// Codex doesn't document the cache's layout, so the folders are searched by
// name, three levels down, local folders only. Returns their display paths.
function oldCodexCopies(codexHome, { maxEntries = 200, depth = 3 } = {}) {
  const found = [];
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome) || networkPath(codexHome)) return found;
  const walk = (dir, rel, d) => {
    if (d > depth || found.length >= 3 || !local(dir)) return;
    for (const n of list(dir, maxEntries).names) {
      const p = path.join(dir, n);
      if (n.toLowerCase() === 'jb-memory-codex') { if (local(p)) found.push([...rel, showName(n)].join('/')); continue; }
      walk(p, [...rel, showName(n)], d + 1);
    }
  };
  walk(path.join(codexHome, 'plugins', 'cache'), ['plugins', 'cache'], 1);
  return found;
}

module.exports = { oldCodexCopies, nodeAdvice, otherCopies, nodeInside, NODE_FLOORS, parseVersion, SAFE_NAME };

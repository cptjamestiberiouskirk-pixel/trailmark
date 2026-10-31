// Git facts for the hooks. The launcher collects them before starting a
// sandboxed hook (which may not start processes) and passes them in
// JBMEM_GIT. Run directly, without the launcher, the hooks collect them here.
// Every git call goes through gitbin.js's hardened flags and environment.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { oneLine, displayPath, inside } = require('./store');
const { farGitConfig, farNested, localPath, gitPath, gitEnv, GIT_GLOBAL } = require('./gitbin');

// The snapshot shows 20 status lines. JBMEM_GIT is one environment variable,
// and Windows caps a variable at 32,767 characters (Linux at 128 KB), so only
// the first STATUS_KEEP lines travel, with the full count beside them.
const STATUS_KEEP = 50;

// Whitespace of any kind, control and format characters (zero-width, bidi,
// tag characters), characters that never show (Default_Ignorable), and
// blank-looking letters such as the Hangul fillers and the braille blank,
// so a branch name stays one visible word.
const BRANCH_GAPS = /[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u115f\u1160\u2800\u3164\uffa0]+/gu;

// A branch name is repo data that reaches the handoff's Updated line and the
// snapshot. Git refuses spaces in branch names but takes non-breaking and
// other Unicode spaces, which would let a branch read like a sentence.
function branchToken(text, max = 80) {
  const t = String(text).replace(/[\u0000-\u001f\u007f]+/g, '').replace(BRANCH_GAPS, '_').replace(/^_+|_+$/g, '');
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

// One time budget for a hook's git calls. After one call times out the rest
// are skipped: a git that hung once will hang again.
function runner(budgetMs) {
  const deadline = Date.now() + budgetMs;
  const r = { hung: false };
  r.left = () => deadline - Date.now();
  // input: text for git's stdin (check-attr --stdin).
  r.run = (cwd, args, input) => {
    const left = Math.min(4000, deadline - Date.now());
    if (r.hung || left < 250) return { ok: false, out: '', why: 'timeout' };
    const far = farGitConfig(cwd);
    if (far) return { ok: false, out: '', why: far };
    const bin = gitPath(cwd);
    if (!bin) return { ok: false, out: '', why: 'no-git' };
    try {
      const out = execFileSync(bin, [...GIT_GLOBAL, ...args], {
        cwd, env: gitEnv(), encoding: 'utf8', timeout: left, maxBuffer: 32 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], windowsHide: true,
        ...(input === undefined ? {} : { input }),
      });
      return { ok: true, out };
    } catch (e) {
      if (e && e.code === 'ETIMEDOUT') { r.hung = true; return { ok: false, out: '', why: 'timeout' }; }
      return { ok: false, out: '', why: 'error', status: e && typeof e.status === 'number' ? e.status : null };
    }
  };
  return r;
}

// budgetMs caps the time for all the calls together, so a hook stays well
// inside Claude Code's timeout when git is slow or hangs (a network drive, a
// stuck credential helper). A fact that wasn't collected is left out, and the
// hooks carry on without it.
function gitFacts(cwd, wanted, { budgetMs = 5000 } = {}) {
  const r = runner(budgetMs);
  const git = (args) => (wanted.length ? r.run(cwd, args).out.trim() : '');
  const f = {};
  if (wanted.includes('branch')) f.branch = branchToken(git(['branch', '--no-color', '--show-current']) || 'detached', 80) || 'detached';
  if (wanted.includes('head')) f.head = git(['rev-parse', '--short', 'HEAD']).replace(/[^0-9a-f]/gi, '').slice(0, 12);
  if (wanted.includes('subject')) f.subject = oneLine(git(['log', '-1', '--no-show-signature', '--no-color', '--format=%s']), 100);
  if (wanted.includes('status')) {
    // git status may run a clean or process filter that the repo's own
    // attributes and config name. Those filters are switched off for the
    // call; without the list of their names, status isn't read at all.
    // git status (and the attribute lookup below) also looks into every
    // submodule folder, into untracked folders that are repos of their own,
    // and through the folders that hold tracked files. So untracked files
    // aren't listed, and before anything runs each submodule's .git is
    // checked like the repo's own, and no folder of tracked files may be a
    // link to a network path.
    const subs = farWorktree(r, cwd);
    const off = subs ? { why: subs } : filterOverrides(r, cwd);
    if (off.why) f.statusSkipped = off.why;
    else {
      if (off.offFiles) f.statusFiltersOff = off.offFiles;
      const st = r.run(cwd, [...off.args, 'status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=dirty']);
      if (st.ok) {
        const all = st.out.trim().split('\n').filter(Boolean);
        f.statusCount = all.length;
        f.status = all.slice(0, STATUS_KEEP).map(l => oneLine(l, 120));
      } else f.statusSkipped = st.why === 'timeout' ? 'git-timeout' : 'git-error';
    }
  }
  // Last: only snapshots and the Updated line use it, and they fall back to
  // the folder git ran in.
  if (wanted.includes('toplevel')) {
    const top = git(['rev-parse', '--show-toplevel']).split(/\r?\n/)[0].slice(0, 400);
    if (top) f.toplevel = top;
  }
  if (r.hung) f.gitTimedOut = true;
  return f;
}

// '' when every submodule (gitlink) folder in the index passes the same check
// as the repo's own .git, else why status shouldn't run. ls-files --stage only
// reads the index; it doesn't look into the folders.
const MAX_SUBMODULES = 200;
const MAX_TREE_FOLDERS = 20000;
function farWorktree(r, cwd) {
  const top = topLevel(r, cwd);
  if (!top.ok) return top.why === 'timeout' ? 'git-timeout' : 'git-error';
  const ls = r.run(cwd, ['ls-files', '--stage', '-z', '--full-name']);
  if (!ls.ok) return ls.why === 'timeout' ? 'git-timeout' : 'git-error';
  let n = 0;
  const folders = new Set();
  for (const e of ls.out.split('\0')) {
    const rel = e.slice(e.indexOf('\t') + 1);
    if (!rel || e.indexOf('\t') < 0) continue;
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 'odd-path';
    // Every folder on the way to the file (past MAX_TREE_FOLDERS the rest
    // isn't looked at, so a very large repo still gets a snapshot).
    const parts = rel.split('/');
    for (let i = 1; i < parts.length && folders.size < MAX_TREE_FOLDERS; i++) folders.add(parts.slice(0, i).join('/'));
    if (!e.startsWith('160000 ')) continue;
    if (++n > MAX_SUBMODULES) return 'many-submodules';
    if (farNested(path.join(top.top, rel))) return 'submodule-pointer';
  }
  for (const rel of folders) {
    let st;
    try { st = fs.lstatSync(path.join(top.top, rel)); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let t = '';
    try { t = fs.readlinkSync(path.join(top.top, rel)); } catch { return 'linked-folder'; }
    if (/^[\\/]{2}|^[\\/]\?\?[\\/]|^%\(prefix\)/i.test(t.replace(/"/g, '').trim())) return 'linked-folder';
    if (!localPath(path.join(top.top, rel))) return 'linked-folder';
  }
  return '';
}

// The filters (filter=<name> in .gitattributes, .git/info/attributes or
// core.attributesFile) that tracked files use, and -c settings that switch
// off the ones the repo itself defines: filter.<name>.clean, .smudge and
// .process set empty, .required false (tested on git 2.43: an empty command
// runs nothing). A filter defined only in the user's own global or system
// config (git lfs install) is left alone: a repo can't write those. So is
// Git LFS set up in the repo's own config with exactly the settings `git lfs
// install --local` writes, since switching it off would show every touched
// LFS file as modified. Git LFS also runs extension programs named in the
// repo's config (lfs.extension.<name>.clean, tested with git-lfs 3.4.1), so
// with LFS running and such a setting in the repo, status isn't read.
// Returns { args, offFiles } (offFiles: tracked files whose filter was
// switched off, which can show as modified when they aren't) or { why }
// when status shouldn't run.
const FILTER_NAME = /^[A-Za-z0-9._\-]{1,64}$/;
const LFS_STANDARD = {
  clean: /^git-lfs clean -- %f$/,
  smudge: /^git-lfs smudge(?: --skip)? -- %f$/,
  process: /^git-lfs filter-process(?: --skip)?$/,
  required: /^(?:true|false|)$/i, // a key with no value is true
};
const USER_SCOPES = /^(?:global|system|command)$/i;

function filterOverrides(r, cwd) {
  const ls = r.run(cwd, ['ls-files', '-z']);
  if (!ls.ok) return { why: ls.why === 'timeout' ? 'git-timeout' : 'git-error' };
  if (!ls.out) return { args: [] };
  const ca = r.run(cwd, ['check-attr', '-z', '--stdin', 'filter'], ls.out);
  if (!ca.ok) return { why: ca.why === 'timeout' ? 'git-timeout' : 'filter-check' };
  const names = new Map(); // filter name -> tracked files that use it
  const parts = ca.out.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const v = parts[i + 2];
    if (!v || v === 'unspecified' || v === 'unset' || v === 'set') continue;
    if (!FILTER_NAME.test(v)) return { why: 'odd-filter-name' };
    names.set(v, (names.get(v) || 0) + 1);
    if (names.size > 32) return { why: 'many-filters' };
  }
  if (!names.size) return { args: [] };
  // Where each setting comes from (git 2.26 and later): "<scope>\0<key>\n<value>\0".
  // Exit status 1 means no such settings at all. Without scopes, every
  // filter is switched off.
  const sc = r.run(cwd, ['config', '-z', '--show-scope', '--get-regexp', '^(filter|lfs)\\.']);
  if (!sc.ok && sc.why === 'timeout') return { why: 'git-timeout' };
  const scoped = sc.ok || sc.status === 1;
  const repoKeys = new Map(); // filter name -> [{ key, value }] set at the repo's own scopes
  let lfsExtension = false;
  if (sc.ok) {
    const f = sc.out.split('\0');
    for (let i = 0; i + 1 < f.length; i += 2) {
      const scope = f[i];
      const nl = f[i + 1].indexOf('\n');
      const key = nl < 0 ? f[i + 1] : f[i + 1].slice(0, nl);
      const value = nl < 0 ? '' : f[i + 1].slice(nl + 1);
      if (USER_SCOPES.test(scope)) continue;
      if (/^lfs\.extension\./i.test(key)) { lfsExtension = true; continue; }
      const m = /^filter\.(.+)\.([a-z]+)$/i.exec(key);
      if (!m) continue;
      if (!repoKeys.has(m[1])) repoKeys.set(m[1], []);
      repoKeys.get(m[1]).push({ key: m[2].toLowerCase(), value });
    }
  }
  const args = [];
  let offFiles = 0;
  for (const [n, count] of names) {
    if (scoped) {
      const own = repoKeys.get(n) || [];
      const lfsAsInstalled = n === 'lfs' && own.every(e => LFS_STANDARD[e.key] && LFS_STANDARD[e.key].test(e.value));
      if (!own.length || lfsAsInstalled) {
        if (n === 'lfs' && lfsExtension) return { why: 'lfs-extension' };
        continue;
      }
    }
    args.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
    offFiles += count;
  }
  return { args, offFiles };
}

// ---------- the commits a command made ----------

// A reflog entry written by `git commit`: "commit: ", "commit (amend): ",
// "commit (initial): ", "commit (merge): ". A checkout, pull, merge, reset or
// rebase moves HEAD too, and isn't a commit this session made.
const COMMIT_ACTION = /^commit(?: \([a-z -]+\))?: /;
// A commit older than the longest a command can run wasn't made by the
// command that just finished: Claude Code stops a Bash command after 10
// minutes unless BASH_MAX_TIMEOUT_MS says otherwise. One minute of slack.
function windowMs(env = process.env) {
  const max = Number(env.BASH_MAX_TIMEOUT_MS);
  return Math.min(Number.isFinite(max) && max > 0 ? max : 600000, 2 * 3600 * 1000) + 60000;
}
const MAX_FOLDERS = 4;
// Unresolved reasons logged for one command.
const MAX_UNRESOLVED = 12;
// Commits logged from one folder for one command.
const MAX_PER_FOLDER = 30;
// Where the window opens. Claude Code's duration_ms counts back from when the
// command ended, but this hook can only count it back from when its own
// process started, which is later: Claude Code starts it after the command
// ends, and on a busy Windows PC that can take more than a second. Counted
// back from there, the window would open after the command started and miss
// its first commits. The PreToolUse record's time was taken before the
// command ran, so the window opens at the earlier of the two, with slack; but
// no more than SPAN_MS before the duration says, since the record can be
// minutes older than the command when a permission prompt waited in between.
// Without a record, NO_RECORD_SLACK_MS covers the start-up delay.
const SLACK_MS = 2000;
const RECORD_SLACK_MS = 1000;
const NO_RECORD_SLACK_MS = 5000;
const SPAN_MS = 60000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function folderKey(p) {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
}

// A network path is compared by name only: resolving it would reach the
// server. Paths reach here from command text and the state file.
function realOr(p) {
  if (NET_RE.test(String(p || ''))) return p;
  try { return fs.realpathSync.native(p); } catch { return p; }
}

// Same folder by name or, where both resolve, by real path (an 8.3 name, a
// junction, a mapped drive).
function sameFolder(a, b) {
  if (!a || !b) return false;
  return folderKey(a) === folderKey(b) || folderKey(realOr(a)) === folderKey(realOr(b));
}

// git's top level for `dir`, used only when dir really is in it. core.worktree
// in a repo's config can make git print any path at all.
function topLevel(r, dir) {
  const t = r.run(dir, ['rev-parse', '--show-toplevel']);
  if (!t.ok) return { ok: false, why: t.why };
  const top = t.out.split(/\r?\n/)[0].trim().slice(0, 400);
  if (top && (sameFolder(top, dir) || inside(path.resolve(top), path.resolve(dir)))) return { ok: true, top: path.resolve(top) };
  return { ok: true, top: path.resolve(dir) };
}

function parseEntries(out, timeField) {
  const list = [];
  for (const line of out.split(/\r?\n/)) {
    const [sha, short, when, action, subject] = line.split('\x1f');
    if (!SHA.test(sha || '')) continue;
    let t = NaN;
    if (timeField === 'reflog') { const m = /@\{(\d+)\}$/.exec(when || ''); if (m) t = Number(m[1]) * 1000; }
    else t = Number(when) * 1000;
    list.push({ sha, short: String(short || '').replace(/[^0-9a-f]/g, '').slice(0, 12) || sha.slice(0, 8), t, action: action || '', subject: subject || '' });
  }
  return list;
}

// Whether a commit is still on the folder's HEAD after the command: true,
// false, or null when git couldn't say. `recent` holds HEAD's newest
// commits, which settles almost every case without another git call.
function onHead(r, dir, sha, recent) {
  if (recent.has(sha)) return true;
  const t = r.run(dir, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (t.ok) return true;
  return t.status === 1 ? false : null;
}

// When the command started, at the latest, with slack (see SLACK_MS).
// procStart: when this process started; startAt: the PreToolUse record's time.
// Without durationMs (Claude Code passes none for a command that failed), the
// record's time alone.
function windowStart(now, durationMs, procStart, startAt) {
  const recorded = Number.isFinite(startAt) && startAt > 0 && startAt <= now;
  if (!(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0)) {
    return recorded ? Math.floor((startAt - RECORD_SLACK_MS) / 1000) * 1000 : NaN;
  }
  const ref = Number.isFinite(procStart) && procStart > 0 && procStart <= now ? procStart : now;
  const byDuration = ref - durationMs;
  const lo = Number.isFinite(startAt) && startAt > 0 && startAt <= now
    ? Math.max(Math.min(startAt - RECORD_SLACK_MS, byDuration - SLACK_MS), byDuration - SPAN_MS)
    : byDuration - NO_RECORD_SLACK_MS;
  // The reflog keeps whole seconds: a commit made just after the command
  // started can carry the second before.
  return Math.floor(lo / 1000) * 1000;
}

// The commits `found` (from commands.commitSites) made. For each folder,
// the reflog entries written by `git commit` while the command ran: from
// windowStart() on, or, when durationMs (Claude Code's duration_ms) isn't
// known, within windowMs() and at most one per commit in the command (more
// in a loop). Without a reflog (core.logAllRefUpdates off) HEAD counts when
// its commit time is in that window. A commit the same command then
// rewrote is logged as its rebased copy when there is one ("rebased"),
// dropped when the next entry amended it, and otherwise kept
// ("not-on-head": reset away, or left on another branch).
// homeCwd: the session's own folder; a commit outside it is logged with in=.
// Returns { folders: [{ dir, display, own, entries: [{ sha, short, subject, note? }] }],
//           unresolved: [{ why, dir? }], gitTimedOut? }.
// printed: the short SHAs git printed for the command ("[main 1a2b3c4] fix"),
// from the tool's output. concurrent: other sessions' commit commands that
// ran at the same time as this one ([{ at, cwd, sites? }], from their
// PreToolUse records). known: SHA prefixes already logged. Only when one of
// those commits in the same repo folder (one of its sites, or its start
// folder when the record has none), and that folder has more new commits in
// the window than this command's `git commit` sites, where the extra ones are
// exactly the new ones git didn't print that came after it started, are
// those left out: that command's own hook logs them. Otherwise all of them
// stay: a quiet commit, output cut short, or a commit the text doesn't show
// (a git alias, a post-commit hook, a script) is this command's.
// onlyPrinted: keep only the commits git printed (a failed command with no
// record of when it started).
function commitFacts(found, cwd, { budgetMs = 5000, now = Date.now(), window = windowMs(), durationMs, homeCwd, procStart, startAt, printed, concurrent, known, onlyPrinted = false } = {}) {
  const r = runner(budgetMs);
  const out = { folders: [], unresolved: (found && found.unresolved ? found.unresolved : []).map(why => ({ why })) };
  const loops = new Set(((found && found.loops) || []).map(folderKey));
  const groups = [];
  for (const dir of (found && found.sites) || []) {
    const key = folderKey(dir);
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, dir: path.resolve(dir), n: 0, loop: loops.has(key) }; groups.push(g); }
    g.n++;
  }
  if (groups.length > MAX_FOLDERS) { out.unresolved.push({ why: 'too-many-folders' }); groups.length = MAX_FOLDERS; }
  if (!groups.length) return out;
  // The command's run is known from its duration, or from its PreToolUse
  // record alone (a failed command's hook gets no duration).
  const timed = (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) ||
    (Number.isFinite(startAt) && startAt > 0 && startAt <= now);
  const lo = timed ? windowStart(now, durationMs, procStart, startAt) : now - window;
  const hi = now + 60000;
  const own = topLevel(r, homeCwd || cwd);
  const ownTop = own.ok ? own.top : path.resolve(homeCwd || cwd);
  const tops = new Map(); // a concurrent command's folder -> its top level
  let side = null; // the git calls for those, on a budget of their own
  for (const g of groups) {
    if (farNetwork(g.dir, homeCwd || cwd)) { out.unresolved.push({ why: 'network-folder', dir: displayPath(g.dir) }); continue; }
    let isDir = false;
    try { isDir = fs.statSync(g.dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) { out.unresolved.push({ why: 'missing-folder', dir: displayPath(g.dir) }); continue; }
    const t = topLevel(r, g.dir);
    if (!t.ok) { out.unresolved.push({ why: t.why === 'timeout' ? 'git-timeout' : 'no-repo', dir: displayPath(g.dir) }); continue; }
    const many = timed || g.loop;
    const want = many ? MAX_PER_FOLDER : Math.min(g.n, MAX_PER_FOLDER);
    const lg = r.run(g.dir, ['log', '-g', `-n${many ? 120 : 4 * want + 8}`, '--date=unix', '--no-show-signature', '--no-color', '--format=%H%x1f%h%x1f%gd%x1f%gs%x1f%s']);
    if (!lg.ok && lg.why === 'timeout') { out.unresolved.push({ why: 'git-timeout', dir: displayPath(t.top) }); continue; }
    let entries = lg.ok ? parseEntries(lg.out, 'reflog') : [];
    if (!entries.length) {
      const h = r.run(g.dir, ['log', '-1', '--no-show-signature', '--no-color', '--format=%H%x1f%h%x1f%ct%x1f%x1f%s']);
      entries = h.ok ? parseEntries(h.out, 'commit').map(e => ({ ...e, action: 'commit: ' })) : [];
    }
    const inWin = entries.filter(e => e.t >= lo && e.t <= hi); // newest first
    let commits = inWin.filter(e => COMMIT_ACTION.test(e.action));
    if (onlyPrinted) commits = commits.filter(c => printed && [...printed].some(p => c.sha.startsWith(p)));
    if (!timed) commits = commits.slice(0, want);
    if (timed && !g.loop && printed && printed.size && commits.length > g.n && Array.isArray(concurrent) && concurrent.length) {
      // Another session's command counts only if it commits in this repo
      // folder (by top level: a worktree inside it has its own HEAD). A
      // folder spelled as this top level settles it without git. Other ones
      // get git calls of their own, a second in all, so a git that hangs in
      // that session's folder can't use up this command's time.
      let concurrentFrom = Infinity;
      const here = folderKey(t.top);
      for (const c of concurrent.slice(0, 8)) {
        if (!c || !Number.isFinite(c.at) || c.at >= concurrentFrom) continue;
        const where = Array.isArray(c.sites) ? c.sites : [c.cwd];
        for (const d of where) {
          if (typeof d !== 'string' || !d || farNetwork(d, homeCwd || cwd)) continue;
          if (!tops.has(d)) {
            if (folderKey(d) === here) tops.set(d, here);
            else {
              if (!side) side = runner(Math.max(0, Math.min(1000, r.left() - 1500)));
              const ct = side.left() >= 250 && !side.hung ? topLevel(side, d) : { ok: false };
              tops.set(d, ct.ok ? folderKey(ct.top) : '');
            }
          }
          if (tops.get(d) === here) { concurrentFrom = c.at; break; }
        }
      }
      const isKnown = (c) => Array.isArray(known) && known.some(k => c.sha.startsWith(k));
      const shown = (c) => [...printed].some(p => c.sha.startsWith(p));
      const fresh = commits.filter(c => !isKnown(c));
      // The reflog keeps whole seconds: a commit made after the other command
      // started carries a time at most a second before its start.
      const theirs = fresh.filter(c => !shown(c) && c.t >= concurrentFrom - 1000);
      if (theirs.length && theirs.length === fresh.length - g.n) commits = commits.filter(c => !theirs.includes(c));
    }
    if (commits.length > MAX_PER_FOLDER) { out.unresolved.push({ why: 'too-many-commits', dir: displayPath(t.top) }); commits = commits.slice(0, MAX_PER_FOLDER); }
    const head = commits.length ? r.run(g.dir, ['rev-list', '-n', '300', 'HEAD']) : { ok: false, out: '' };
    const recent = new Set(head.ok ? head.out.split(/\r?\n/).filter(x => SHA.test(x)) : []);
    const picked = [];
    for (const c of commits) {
      const on = onHead(r, g.dir, c.sha, recent);
      if (on !== false) { picked.push({ sha: c.sha, short: c.short, subject: c.subject }); continue; }
      const ci = inWin.indexOf(c);
      let copy = null;
      for (let k = 0; k < ci && !copy; k++) {
        const e = inWin[k];
        if (e.sha !== c.sha && e.subject === c.subject && !COMMIT_ACTION.test(e.action) && onHead(r, g.dir, e.sha, recent) === true) copy = e;
      }
      if (copy) { picked.push({ sha: copy.sha, short: copy.short, subject: c.subject, note: 'rebased' }); continue; }
      // Amended: the next reflog entry replaced this commit. A commit left
      // on another branch (git checkout -b x HEAD~1 && git commit) is kept.
      const ei = entries.indexOf(c);
      if (ei > 0 && /^commit \(amend\): /.test(entries[ei - 1].action)) continue;
      picked.push({ sha: c.sha, short: c.short, subject: c.subject, note: 'not-on-head' });
    }
    const seen = new Set();
    const list = picked.reverse().filter(e => (seen.has(e.sha) ? false : seen.add(e.sha)))
      .map(e => ({ ...e, subject: oneLine(e.subject, 100) }));
    out.folders.push({ dir: g.dir, display: displayPath(t.top), own: sameFolder(t.top, ownTop), entries: list });
  }
  if (r.hung) out.gitTimedOut = true;
  out.unresolved = out.unresolved.slice(0, MAX_UNRESOLVED);
  return out;
}

// The facts travel in one environment variable (JBMEM_GIT), and Windows caps
// a variable at 32,767 characters: past `limit`, subjects are shortened, then
// the oldest entries of the longest folder are dropped (too-many-commits).
function fitCommitFacts(c, limit = 30000) {
  const size = () => JSON.stringify(c).length;
  if (!c || size() <= limit) return c;
  for (const f of c.folders) for (const e of f.entries) e.subject = oneLine(e.subject, 40);
  while (size() > limit) {
    const f = c.folders.reduce((a, b) => (b.entries.length > a.entries.length ? b : a), c.folders[0]);
    if (!f || !f.entries.length) break;
    f.entries.splice(0, Math.max(1, Math.ceil(f.entries.length / 4)));
    if (!c.unresolved.some(u => u.why === 'too-many-commits' && u.dir === f.display)) c.unresolved.push({ why: 'too-many-commits', dir: f.display });
  }
  return c;
}

// ---------- commits no hook logged ----------

// The commits a sweep should log if no hook did, folder by folder. Each item
// of `folders` is { dir, since, until?, exclude? }: reflog entries written by
// git commit from `since` on (to the second, as the reflog keeps time), and
// before `until` (a commit command still running) and before the second the
// sweep started (a command that starts now is the next sweep's), not amended
// away and still on a branch or tag (a rebase or reset can leave the original
// nowhere; its copy was logged instead), and not one of `exclude` (SHA
// prefixes logged in another memory folder). Newest last, at most
// MAX_PER_FOLDER a folder, MAX_SWEEP_FOLDERS folders. The caller passes the
// folders whose sweep is oldest first. homeCwd: the session's own folder (no
// in=). The caller drops the ones already logged.
// Returns { at, folders: [{ dir, display, own, entries }], read: [{ dir, at }] }:
// `read` lists each folder read to the end, with where its next sweep starts.
// A folder not read (missing, slow, out of time) keeps its old start.
const MAX_SWEEP_FOLDERS = 6;
// A network folder (\\\\server\\share, //server/share, or a device path) named in
// command text is never touched unless the session itself works under it:
// even a stat would connect to that server, from outside any sandbox the host
// put the command in, and on Windows send it your sign-in hash.
const NET_RE = /^(?:\\\\|\/\/|[\\/]\?\?[\\/])/;
function farNetwork(dir, base, P = path) {
  const d = P.resolve(String(dir || ''));
  if (!NET_RE.test(d) && !NET_RE.test(String(dir || ''))) return false;
  if (!base) return true;
  const rel = P.relative(P.resolve(base), d);
  return rel === '..' || rel.startsWith('..' + P.sep) || P.isAbsolute(rel);
}

function sweepCommits(folders, { homeCwd, budgetMs = 3000, now = Date.now() } = {}) {
  const r = runner(budgetMs);
  const nowSec = Math.floor(now / 1000) * 1000;
  const out = { at: nowSec, folders: [], read: [] };
  const own = homeCwd ? topLevel(r, homeCwd) : { ok: false };
  const ownTop = own.ok ? own.top : (homeCwd ? path.resolve(homeCwd) : '');
  const seen = new Map(); // top level -> { lo, hi } of its read
  for (const item of folders || []) {
    if (!item || typeof item.dir !== 'string' || !Number.isFinite(item.since)) continue;
    if (out.read.length >= MAX_SWEEP_FOLDERS || r.left() < 800) break;
    const dir = item.dir;
    if (farNetwork(dir, homeCwd)) continue;
    const lo = Math.floor(item.since / 1000) * 1000;
    const hi = Number.isFinite(item.until) ? Math.min(item.until, nowSec) : nowSec;
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    const t = topLevel(r, dir);
    if (!t.ok) continue;
    // Another of the session's folders in the same repo, read already from
    // no later a start: this one is covered too.
    const key = folderKey(t.top);
    if (seen.has(key)) {
      const first = seen.get(key);
      if (first.lo <= lo) out.read.push({ dir, at: Math.min(hi, first.hi) });
      continue;
    }
    const lg = r.run(t.top, ['log', '-g', '-n200', '--date=unix', '--no-show-signature', '--no-color', '--format=%H%x1f%h%x1f%gd%x1f%gs%x1f%s']);
    if (!lg.ok) continue;
    const entries = parseEntries(lg.out, 'reflog');
    const excluded = (sha) => Array.isArray(item.exclude) && item.exclude.some(k => sha.startsWith(k));
    const commits = entries.filter((e, i) => e.t >= lo && e.t < hi && COMMIT_ACTION.test(e.action) &&
      !(i > 0 && /^commit \(amend\): /.test(entries[i - 1].action)) && !excluded(e.sha));
    if (commits.length) {
      const reach = r.run(t.top, ['rev-list', '--all', '-n', '3000', `--since=${Math.floor(lo / 1000) - 3600}`]);
      if (!reach.ok) continue;
      const onRef = new Set(reach.out.split(/\r?\n/).filter(x => SHA.test(x)));
      const keep = new Set();
      const list = commits.filter(c => onRef.has(c.sha) && (keep.has(c.sha) ? false : keep.add(c.sha))).slice(0, MAX_PER_FOLDER).reverse()
        .map(e => ({ sha: e.sha, short: e.short, subject: oneLine(e.subject, 100) }));
      if (list.length) out.folders.push({ dir: t.top, display: displayPath(t.top), own: sameFolder(t.top, ownTop), entries: list });
    }
    out.read.push({ dir, at: hi });
    seen.set(key, { lo, hi });
  }
  if (r.hung) out.gitTimedOut = true;
  return out;
}

// Facts passed by the launcher, or collected now when run directly.
// The commits on HEAD since `base`, the short SHA on the handoff's Updated
// line, for the session-start injection. state: ok (base is an ancestor of
// HEAD; count and the newest 10 follow), not-ancestor (another branch, or
// rewritten history) or unknown-base (this checkout doesn't have it). null
// when git couldn't answer in time. base is checked as hex before git sees it.
const SINCE_SHOW = 10;
function commitsSince(cwd, base, { budgetMs = 1500 } = {}) {
  if (!/^[0-9a-f]{7,12}$/.test(String(base || ''))) return null;
  const r = runner(budgetMs);
  // Every object whose name starts with base, so a branch or tag that
  // happens to be named like the SHA can't stand in for it; then the one
  // that is a commit, looked up by its full name.
  const all = r.run(cwd, ['rev-parse', `--disambiguate=${base}`]);
  if (!all.ok) return all.why === 'error' ? { base, state: 'unknown-base' } : null;
  const commits = [];
  for (const cand of all.out.split(/\r?\n/).map(x => x.trim()).filter(x => SHA.test(x)).slice(0, 8)) {
    const t = r.run(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
    if (t.ok && t.out.trim() === cand) commits.push(cand);
    else if (!t.ok && t.why !== 'error') return null;
  }
  if (commits.length !== 1) return { base, state: 'unknown-base' };
  const sha = commits[0];
  const anc = r.run(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (!anc.ok) return anc.status === 1 ? { base, state: 'not-ancestor' } : null;
  const cnt = r.run(cwd, ['rev-list', '--count', `${sha}..HEAD`]);
  if (!cnt.ok) return null;
  const count = Number.parseInt(cnt.out.trim(), 10);
  if (!Number.isInteger(count) || count < 0) return null;
  if (!count) return { base, state: 'ok', count: 0, entries: [] };
  const log = r.run(cwd, ['log', '--no-show-signature', '--no-color', `--max-count=${SINCE_SHOW}`, '--format=%H%x1f%h%x1f%ct%x1f%x1f%s', `${sha}..HEAD`]);
  const entries = log.ok ? parseEntries(log.out, 'time').map(e => ({ short: e.short, subject: oneLine(e.subject, 80), t: Number.isFinite(e.t) ? e.t : 0 })) : [];
  return { base, state: 'ok', count, entries };
}

function facts(cwd, wanted) {
  if (process.env.JBMEM_GIT) {
    try { return JSON.parse(process.env.JBMEM_GIT); } catch { /* fall through */ }
  }
  return gitFacts(cwd, wanted);
}

module.exports = { commitsSince, farNetwork, gitFacts, commitFacts, fitCommitFacts, sweepCommits, facts, branchToken, sameFolder, windowMs, windowStart, STATUS_KEEP };

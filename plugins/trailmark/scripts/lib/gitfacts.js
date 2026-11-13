// Git facts for the hooks. The launcher collects them before starting a
// sandboxed hook (which may not start processes) and passes them in
// JBMEM_GIT. Run directly, without the launcher, the hooks collect them here.
// Every git call goes through gitbin.js's hardened flags and environment.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { oneLine, displayPath, inside } = require('./store');
const { withTime, farGitConfig, farNested, farModules, farLfsFile, farLfsEntries, localPath, localPathFrom, dotEnd, gitPath, gitEnv, GIT_GLOBAL } = require('./gitbin');

// The snapshot shows 20 status lines. JBMEM_GIT is one environment variable,
// and Linux caps a variable at 128 KiB (the comment on PAYLOAD_MAX in
// hookio.js says more), so only the first STATUS_KEEP lines travel, with the
// full count beside them.
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
  // late: a call was refused or stopped for lack of time.
  const r = { hung: false, late: false };
  r.left = () => deadline - Date.now();
  // input: text for git's stdin (check-attr --stdin).
  r.run = (cwd, args, input) => {
    const left = Math.min(4000, deadline - Date.now());
    if (r.hung || left < 250) { r.late = true; return { ok: false, out: '', why: 'timeout' }; }
    // The check stops at the 250 ms this call needs, not at the status
    // check's 800: a runner with a second in all still gets its calls.
    const far = withTime(r.left, () => farGitConfig(cwd), 250);
    // The check ran out of the time: the same answer as a call that did.
    if (far === 'git-timeout') { r.late = true; return { ok: false, out: '', why: 'timeout' }; }
    if (far) { r.refused = r.refused || far; return { ok: false, out: '', why: far }; }
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
      if (e && e.code === 'ETIMEDOUT') { r.hung = r.late = true; return { ok: false, out: '', why: 'timeout' }; }
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
  // git kept out of this folder: no facts, and the reason (a fixed word).
  const refused = withTime(r.left, () => farGitConfig(cwd), 250);
  // The check ran out of the time: git isn't kept out for that, and each
  // call below answers as one that ran out of time (r.run).
  if (refused && refused !== 'git-timeout') { f.gitRefused = refused; return f; }
  if (wanted.includes('branch')) {
    // 'unknown' when git didn't answer (a timeout); 'detached' when it said
    // there is no current branch, or failed (not a repo), as before.
    const b = r.run(cwd, ['branch', '--no-color', '--show-current']);
    f.branch = b.ok ? branchToken(b.out.trim() || 'detached', 80) || 'detached' : b.why === 'timeout' ? 'unknown' : 'detached';
  }
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
    // status covers the whole worktree, not only the folder it runs in, and
    // ls-files and check-attr list only what is under the folder they run
    // in. So all of them run at the top level, which must be cwd or above it.
    const top = statusTop(r, cwd);
    const subs = top.why || farWorktree(r, top.top);
    const off = subs ? { why: subs } : filterOverrides(r, top.top);
    if (off.why) f.statusSkipped = off.why;
    else {
      if (off.offFiles) f.statusFiltersOff = off.offFiles;
      const st = r.run(top.top, [...off.args, 'status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=dirty']);
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
// The time check below is what bounds the run; this only caps a huge index.
const MAX_SUBMODULES = 2000;
const MAX_TREE_FOLDERS = 20000;
// How much of git's list of tracked files is gone through between two looks
// at the time (characters).
const LIST_STEP = 1 << 20;
// Windows and macOS find a file whatever the case of its name.
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const WIN = process.platform === 'win32';
function farWorktree(r, cwd) {
  const top = topLevel(r, cwd);
  if (!top.ok) return top.why === 'timeout' ? 'git-timeout' : 'git-error';
  const ls = r.run(cwd, ['ls-files', '--stage', '-z', '--full-name']);
  if (!ls.ok) return ls.why === 'timeout' ? 'git-timeout' : 'git-error';
  // A path that isn't valid UTF-8 reads back here with U+FFFD in it, so
  // every lookup below would name a file git doesn't use: not checked, so
  // status isn't read.
  if (ls.out.includes('\uFFFD')) return 'odd-path';
  let n = 0;
  let files = 0;
  let anyFolder = false;
  // The folders, as a tree of names (to tell a new one with one short lookup
  // for each level) and as a list of paths, parents before their subfolders.
  const tree = { path: '', kids: new Map() };
  const folders = [];
  const entries = [];
  let read = 0;
  for (const e of ls.out.split('\0')) {
    // The list can be 32 MB, and nothing below looks at the disk, so the
    // time is looked at once for each LIST_STEP characters of it.
    if ((read += e.length + 1) >= LIST_STEP) { read -= LIST_STEP; if (r.left() < 800) return 'git-timeout'; }
    const rel = e.slice(e.indexOf('\t') + 1);
    if (!rel || e.indexOf('\t') < 0) continue;
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 'odd-path';
    // On Windows git opens `d/f` for a tracked `d./f` or `d /f`, and with
    // core.fscache off (a repo can set it) `u` for a tracked `u.`, while the
    // lookups below would name `d.` and `u.` and find nothing. What git opens
    // there would go unchecked, so status isn't read (RS-A-dottracked).
    // The same goes there for a backslash, which git takes as one more
    // separator while the folders below are split on `/` alone (a tracked
    // `d\f` is read through a link `d` that is never looked at), and for a
    // drive letter at the start (`C:d/f`), which names a place of its own.
    if (dotEnd(rel) || (WIN && (rel.includes('\\') || /^[A-Za-z]:/.test(rel)))) return 'odd-path';
    // Every folder on the way to the file. Past MAX_TREE_FOLDERS the rest
    // can't be looked at, and git status would go through them, so the file
    // list isn't read (the rest of the snapshot still is).
    // One lookup of a name for each level, and a path built only for a new
    // folder: joining every level's whole path for every file took 12 s for
    // 1,500 files in a folder 1,500 deep, with nothing on disk and nothing
    // looking at the time (RS-A-deepindex).
    const parts = rel.split('/');
    // A part that is empty or `.` (`d//f`, `d/./f`, `./f`, `d/`): git's own
    // commands did not give a tracked file such a path when tried (`add`
    // wrote `d/f`; `update-index`, `read-tree` and `checkout` refused), so
    // one is in this list when another tool wrote the index. (A sparse index
    // has an entry for a folder that ends in a slash, `out/`; this list is
    // asked for without `--sparse` and has that folder's files in its place.)
    // For the first three of these shapes `git check-attr` answered
    // `unspecified` where an attributes line of the same text named a filter,
    // and `git status` then ran that filter: the filter check that comes
    // after this one would have left it on (RS-A-dotpath).
    if (parts.includes('') || parts.includes('.')) return 'odd-path';
    let at = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = at.kids.get(parts[i]);
      if (!next) {
        if (folders.length >= MAX_TREE_FOLDERS) return 'many-folders';
        next = { path: i ? `${at.path}/${parts[i]}` : parts[i], kids: new Map() };
        at.kids.set(parts[i], next);
        folders.push(next.path);
      }
      at = next;
    }
    entries.push({ rel, link: e.startsWith('160000 ') });
  }
  // The folders first, parents before their subfolders: nothing below looks
  // into one until it is known not to be a link to a network path.
  // The time is looked at before each one: a folder that is a link has where
  // it leads walked, and 500 links to a long path took 5.2 s with nothing
  // looking at the time; 20,000 folders are allowed.
  for (const rel of folders) {
    if (r.left() < 800) return 'git-timeout'; // RS-A-linkfolders
    let st;
    try { st = fs.lstatSync(path.join(top.top, rel)); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let t = '';
    try { t = fs.readlinkSync(path.join(top.top, rel)); } catch { return 'linked-folder'; }
    if (/^[\\/]{2}|^[\\/]\?\?[\\/]|^%\(prefix\)/i.test(t.replace(/"/g, '').trim())) return 'linked-folder';
    if (!localPathFrom(top.top, path.join(top.top, rel))) return 'linked-folder';
  }
  // A tracked file whose path is now a folder: git status looks for a repo
  // there (as for a submodule), so one there is checked the same way. Found
  // with one listing per folder of tracked files rather than a lookup per
  // file.
  const byFolder = new Map();
  for (const { rel, link } of entries) {
    if (link) continue;
    const i = rel.lastIndexOf('/');
    const dir = i < 0 ? '' : rel.slice(0, i);
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    byFolder.get(dir).push(rel.slice(i + 1));
  }
  const fold = (x) => (CASELESS ? x.toLowerCase() : x);
  for (const [dir, names] of byFolder) {
    if (++files % 500 === 0 && r.left() < 800) return 'git-timeout';
    let list;
    if (names.length <= 2) {
      // A few tracked names: each looked up (the filesystem matches the name
      // as git's own lookup will), not the whole folder listed.
      list = [];
      for (const nm of names) {
        try { if (fs.lstatSync(path.join(top.top, dir, nm)).isDirectory()) list.push({ name: nm, isDirectory: () => true }); } catch { /* not there */ }
      }
    } else {
      try { list = fs.readdirSync(path.join(top.top, dir), { withFileTypes: true }); } catch { continue; }
    }
    const subdirs = list.filter(x => x.isDirectory()).map(x => x.name);
    if (!subdirs.length) continue;
    // Windows and macOS match names in ways JavaScript's lower case doesn't
    // (final sigma, Unicode normal forms), so there every subfolder on disk
    // is checked; elsewhere only those named like a tracked file.
    const want = new Set(names.map(fold));
    for (const nm of subdirs) {
      if (!CASELESS && !want.has(nm)) continue;
      if (nm.includes('\uFFFD')) return 'odd-path';
      const at = path.join(top.top, dir, nm);
      let g = false;
      try { fs.lstatSync(path.join(at, '.git')); g = true; } catch { g = false; }
      // The time is looked at before each one, as for the submodules below:
      // a check can take a second, and one folder can hold any number of
      // these. 12 slow ones took 12.4 s where 5 s were given, since the look
      // above comes once in 500 folders of tracked files (RS-A-nestedtime).
      if (g && r.left() < 800) return 'git-timeout';
      const nested = g ? withTime(r.left, () => farNested(at, top.top)) : '';
      if (nested) return nested === 'git-timeout' ? nested : 'submodule-pointer';
      if (g || want.has(fold(nm))) anyFolder = true;
    }
  }
  for (const { rel, link } of entries) {
    if (!link) continue;
    if (++n > MAX_SUBMODULES) return 'many-submodules';
    if (r.left() < 800) return 'git-timeout';
    const sub = withTime(r.left, () => farNested(path.join(top.top, rel), top.top));
    if (sub) return sub === 'git-timeout' ? sub : 'submodule-pointer';
  }
  // With submodules (or a tracked file that is now a folder), git status
  // may read .gitmodules for names (it must be a plain file or missing) and
  // open a submodule's gitdir in .git/modules by that name.
  if (n || anyFolder) {
    let gm = null;
    try { gm = fs.lstatSync(path.join(top.top, '.gitmodules')); } catch { gm = null; }
    if (gm && !gm.isFile()) return 'submodule-pointer';
    const why = withTime(r.left, () => farModules(top.top, () => r.left()));
    if (why) return why === 'git-timeout' || why === 'many-submodules' ? why : 'submodule-pointer';
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
// What `git check-attr` prints for a file with no filter: the attribute
// unspecified, unset (`-filter`), set with no value (`filter`) or set to
// nothing (`filter=`). It prints the same for a file whose filter has one of
// those words for its name (`filter=set`), and git runs such a filter
// (RS-A-filtername).
const NO_FILTER = new Set(['', 'unspecified', 'unset', 'set']);
// A Map, since the word looked up comes from a repo's config: a plain
// object also answers for `constructor`, with something that is no pattern
// (RS-A-filterkey).
const LFS_STANDARD = new Map([
  ['clean', /^git-lfs clean -- %f$/],
  ['smudge', /^git-lfs smudge(?: --skip)? -- %f$/],
  ['process', /^git-lfs filter-process(?: --skip)?$/],
  ['required', /^(?:true|false|)$/i], // a key with no value is true
]);
// Whether a setting under filter.lfs. is one `git lfs install` writes, by
// its last word and its value. Exported for its test.
function lfsStandard(key, value) {
  const standard = LFS_STANDARD.get(key);
  return standard !== undefined && standard.test(value);
}
const USER_SCOPES = /^(?:global|system|command)$/i;

// The .lfsconfig git-lfs would read: the worktree's (checked like a config
// file, no includes, not a link), else the index's or HEAD's, which aren't
// checked here, so status isn't read then.
function farLfsConfig(r, top) {
  const f = path.join(top, '.lfsconfig');
  let there = false;
  try { fs.lstatSync(f); there = true; } catch { there = false; }
  if (there) return farLfsFile(f, top);
  // Not in the worktree: git-lfs reads the index's copy, else HEAD's, and
  // the same rules apply to it (read by git config --blob, includes off).
  const idx = r.run(top, ['ls-files', '-z', '--', '.lfsconfig']);
  if (!idx.ok) return idx.why === 'timeout' ? 'git-timeout' : 'git-error';
  let spec = idx.out ? ':.lfsconfig' : '';
  if (!spec) {
    const head = r.run(top, ['rev-parse', '--verify', '-q', 'HEAD:.lfsconfig']);
    if (head.ok && head.out.trim()) spec = 'HEAD:.lfsconfig';
  }
  if (!spec) return '';
  const cfg = r.run(top, ['config', '--blob', spec, '--no-includes', '--null', '--list']);
  if (!cfg.ok) return cfg.why === 'timeout' ? 'git-timeout' : 'lfs-config';
  const entries = cfg.out.split('\0').filter(Boolean).map(e => { const i = e.indexOf('\n'); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; });
  return farLfsEntries(entries, top);
}

function filterOverrides(r, cwd) {
  const ls = r.run(cwd, ['ls-files', '-z']);
  if (!ls.ok) return { why: ls.why === 'timeout' ? 'git-timeout' : 'git-error' };
  if (!ls.out) return { args: [] };
  // Sent back to check-attr as text, a path that isn't valid UTF-8 would
  // name another file and its filter wouldn't be seen.
  if (ls.out.includes('\uFFFD')) return { why: 'odd-path' };
  const ca = r.run(cwd, ['check-attr', '-z', '--stdin', 'filter'], ls.out);
  if (!ca.ok) return { why: ca.why === 'timeout' ? 'git-timeout' : 'filter-check' };
  const names = new Map(); // filter name -> tracked files that use it
  const unsure = new Set(); // answers seen that mean no filter, or a filter so named
  // The answer is taken only when it is "<path>\0filter\0<value>\0" for
  // each path sent, in the order sent. Anything else is not the answer to
  // this question (git read its paths from somewhere else, or was cut
  // short), and a file left out of it would keep its filter running
  // (RS-A-redirect).
  const sent = ls.out.split('\0').slice(0, -1);
  const parts = ca.out.split('\0');
  if (parts.pop() !== '' || parts.length !== sent.length * 3) return { why: 'filter-check' };
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i] !== sent[i / 3] || parts[i + 1] !== 'filter') return { why: 'filter-check' };
    const v = parts[i + 2];
    if (NO_FILTER.has(v)) { unsure.add(v); continue; }
    if (!FILTER_NAME.test(v)) return { why: 'odd-filter-name' };
    names.set(v, (names.get(v) || 0) + 1);
    if (names.size > 32) return { why: 'many-filters' };
  }
  // A filter under one of those names, in any config git reads: the files
  // that use it cannot be told from files with no filter, so status isn't
  // read. The call brings a setting of its own and asks for it too, so a
  // whole answer always has it: exit status 1 ("nothing matched", and also
  // what Windows gives for a git ended from outside) is a failure like any
  // other, and so is an answer without that setting.
  if (unsure.size) {
    const odd = r.run(cwd, ['-c', 'trailmark.asked=1', 'config', '-z', '--get-regexp', '^(trailmark\\.asked$|filter\\.(set|unset|unspecified)?\\.)']);
    if (!odd.ok) return { why: odd.why === 'timeout' ? 'git-timeout' : 'filter-check' };
    let whole = false;
    for (const e of odd.out.split('\0')) {
      const nl = e.indexOf('\n');
      const key = nl < 0 ? e : e.slice(0, nl);
      if (key === 'trailmark.asked') { whole = true; continue; }
      const m = /^filter\.(.*)\.[^.]+$/.exec(key);
      if (m && unsure.has(m[1])) return { why: 'odd-filter-name' };
    }
    if (!whole) return { why: 'filter-check' };
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
      const lfsAsInstalled = n === 'lfs' && own.every(e => lfsStandard(e.key, e.value));
      if (!own.length || lfsAsInstalled) {
        if (n === 'lfs' && lfsExtension) return { why: 'lfs-extension' };
        // git-lfs, left running, reads the repo's .lfsconfig with includes on.
        if (n === 'lfs') { const lc = farLfsConfig(r, cwd); if (lc) return { why: lc }; }
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
  // The look-behind keeps a long run of separators linear: see pathKey.
  const r = path.resolve(p).replace(/(?<![\\/])[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
}

// A network path is compared by name only: resolving it would reach the
// server. Paths reach here from command text and the state file.
function realOr(p) {
  if (NET_RE.test(String(p || ''))) return p;
  // A path from the state file or a payload may lead through a link to a
  // share: compared by name then, never resolved.
  if (!localPath(String(p || ''))) return p;
  try { return fs.realpathSync.native(p); } catch { return p; }
}

// Same folder by name or, where both resolve, by real path (an 8.3 name, a
// junction, a mapped drive).
function sameFolder(a, b) {
  if (!a || !b) return false;
  return folderKey(a) === folderKey(b) || folderKey(realOr(a)) === folderKey(realOr(b));
}

// The top level that git status would cover from cwd: { top }, or { why }
// when git can't say or names a folder that isn't cwd or above it
// (core.worktree in the repo's config can point anywhere).
function statusTop(r, cwd) {
  const t = r.run(cwd, ['rev-parse', '--show-toplevel']);
  if (!t.ok) return { why: t.why === 'timeout' ? 'git-timeout' : 'git-error' };
  const top = t.out.split(/\r?\n/)[0].trim();
  if (!top || top.length > 4096) return { why: 'outside-worktree' };
  const a = folderKey(realOr(top));
  const b = folderKey(realOr(cwd));
  if (a !== b && !inside(a, b) && !sameFolder(top, cwd) && !inside(folderKey(top), folderKey(cwd))) return { why: 'outside-worktree' };
  return { top: path.resolve(top) };
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
    // A folder from command text may be a link to a share: not even a stat
    // through it.
    if (!localPathFrom(homeCwd || cwd, g.dir)) { out.unresolved.push({ why: 'network-folder', dir: displayPath(g.dir) }); continue; }
    let isDir = false;
    try { isDir = fs.statSync(g.dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) { out.unresolved.push({ why: 'missing-folder', dir: displayPath(g.dir) }); continue; }
    const t = topLevel(r, g.dir);
    // A why other than these is the reason git was kept out of the folder.
    // A folder git timed out in goes back to the hook (folder), which hands it
    // to the commit sweep: the commit is logged later, not lost.
    if (!t.ok) { out.unresolved.push(t.why === 'timeout' ? { why: 'git-timeout', dir: displayPath(g.dir), folder: g.dir } : { why: t.why === 'error' || t.why === 'no-git' ? 'no-repo' : 'git-kept-out', dir: displayPath(g.dir) }); continue; }
    const many = timed || g.loop;
    const want = many ? MAX_PER_FOLDER : Math.min(g.n, MAX_PER_FOLDER);
    const lg = r.run(g.dir, ['log', '-g', `-n${many ? 120 : 4 * want + 8}`, '--date=unix', '--no-show-signature', '--no-color', '--format=%H%x1f%h%x1f%gd%x1f%gs%x1f%s']);
    if (!lg.ok && lg.why === 'timeout') { out.unresolved.push({ why: 'git-timeout', dir: displayPath(t.top), folder: g.dir }); continue; }
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

// The facts travel in one environment variable (JBMEM_GIT), and Linux caps a
// variable at 128 KiB (PAYLOAD_MAX in hookio.js; the limit of 30,000 characters
// takes at most 90,000 bytes): past `limit`, subjects are shortened, then
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
// Returns { at, folders: [{ dir, display, own, entries }], read: [{ dir, at }],
// stopped? }: `read` lists each folder read to the end, with where its next
// sweep starts. A folder not read (missing, slow, out of time) keeps its old
// start. stopped is 'out-of-time' when time ran out (the budget, or a git
// call that timed out) before every folder was read, so the skip is reported.
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
    if (out.read.length >= MAX_SWEEP_FOLDERS) break;
    if (r.left() < 800) { r.late = true; break; }
    const dir = item.dir;
    // The launcher passes only folders it checked; checked here too, so no
    // caller can have a link to a share stat-ed.
    if (farNetwork(dir, homeCwd) || !localPathFrom(homeCwd || dir, dir)) continue;
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
      const reach = r.run(t.top, ['rev-list', '--all', '-n', '3000', `--since=${Math.floor(lo / 1000) - 3600}`, '--']);
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
  // Only when a folder was left unread: a git call that timed out before the
  // first folder, with none to read, cut nothing short.
  if (r.late && out.read.length < (folders || []).length) out.stopped = 'out-of-time';
  return out;
}

// Facts passed by the launcher, or collected now when run directly.
// The commits on HEAD since `base`, the short SHA on the handoff's Updated
// line, for the session-start injection. state: ok (base is an ancestor of
// HEAD; count and the newest 10 follow), not-ancestor (another branch, or
// rewritten history), unknown-base (this checkout doesn't have it) or late
// (git ran out of time before it could answer). With ok, unlisted is 'late'
// or 'error' when the count came but git log didn't. null when git failed
// otherwise. base is checked as hex before git sees it.
const SINCE_SHOW = 10;
function commitsSince(cwd, base, { budgetMs = 1500 } = {}) {
  if (!/^[0-9a-f]{7,12}$/.test(String(base || ''))) return null;
  const r = runner(budgetMs);
  const none = () => (r.late ? { base, state: 'late' } : null);
  // Every object whose name starts with base, so a branch or tag that
  // happens to be named like the SHA can't stand in for it; then the one
  // that is a commit, looked up by its full name.
  const all = r.run(cwd, ['rev-parse', `--disambiguate=${base}`]);
  if (!all.ok) return all.why === 'error' ? { base, state: 'unknown-base' } : none();
  const commits = [];
  for (const cand of all.out.split(/\r?\n/).map(x => x.trim()).filter(x => SHA.test(x)).slice(0, 8)) {
    const t = r.run(cwd, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
    if (t.ok && t.out.trim() === cand) commits.push(cand);
    else if (!t.ok && t.why !== 'error') return none();
  }
  if (commits.length !== 1) return { base, state: 'unknown-base' };
  const sha = commits[0];
  const anc = r.run(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (!anc.ok) return anc.status === 1 ? { base, state: 'not-ancestor' } : none();
  const cnt = r.run(cwd, ['rev-list', '--count', `${sha}..HEAD`]);
  if (!cnt.ok) return none();
  const count = Number.parseInt(cnt.out.trim(), 10);
  if (!Number.isInteger(count) || count < 0) return null;
  if (!count) return { base, state: 'ok', count: 0, entries: [] };
  const log = r.run(cwd, ['log', '--no-show-signature', '--no-color', `--max-count=${SINCE_SHOW}`, '--format=%H%x1f%h%x1f%ct%x1f%x1f%s', `${sha}..HEAD`]);
  const entries = log.ok ? parseEntries(log.out, 'time').map(e => ({ short: e.short, subject: oneLine(e.subject, 80), t: Number.isFinite(e.t) ? e.t : 0 })) : [];
  return { base, state: 'ok', count, entries, ...(log.ok ? {} : { unlisted: log.why === 'timeout' ? 'late' : 'error' }) };
}

function facts(cwd, wanted) {
  if (process.env.JBMEM_GIT) {
    try { return JSON.parse(process.env.JBMEM_GIT); } catch { /* fall through */ }
  }
  return gitFacts(cwd, wanted);
}

// farWorktree is here for its test, which hands it a made-up list of files.
module.exports = { commitsSince, farNetwork, farWorktree, filterOverrides, lfsStandard, gitFacts, commitFacts, fitCommitFacts, sweepCommits, facts, branchToken, sameFolder, windowMs, windowStart, STATUS_KEEP };

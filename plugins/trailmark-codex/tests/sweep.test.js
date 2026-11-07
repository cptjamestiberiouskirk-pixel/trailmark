// Run: node --test tests/sweep.test.js
// 0.3.4 and 0.5.1: the commit sweep for commits no hook saw, the end check,
// and git that is slow or times out.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { dp, POSIX_ONLY, sandbox, versionNow, J, JBM, jbm, SA, SB, SC, stateOf,
  notesOf, multiFolder, commitLines, jbmIn, tick, SWEEP_SKIP, sweepRepeats,
  settle, settleCall, sweepTest, GIT_TIMEOUT_STUB } = require('./helpers.js');
// Tool-use IDs: this file counts its own, and helpers.js counts for its
// own prefix, so no two IDs are the same.
let toolSeq = 0;

// ---------- 0.3.4 ----------

const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One tool call's two hooks, run apart: pre() before the command, post() after.
function toolCall(s, sid, command, { tool_name = 'Bash', id = `toolu_c${++toolSeq}x${process.pid}` } = {}) {
  const base = { session_id: sid, tool_name, tool_input: { command }, tool_use_id: id };
  return {
    id,
    pre: (cwd) => jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...base, cwd, hook_event_name: 'PreToolUse' })),
    post: (cwd, response = {}, duration_ms = 60000) => jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ ...base, cwd, hook_event_name: 'PostToolUse', tool_response: response, duration_ms })),
  };
}

test('0.3.4 hardening: the PreCompact status switches off a filter the repo defines, keeps one from the user\'s own config, and skips status for an odd filter name', { skip: POSIX_ONLY }, () => {
  const s = sandbox();
  jbm(s, ['init']);
  const marks = path.join(s.base, 'marks');
  fs.mkdirSync(marks);
  // A clean filter that passes the content through, and a process filter that fails.
  const prog = (name, body = 'cat') => { const f = path.join(s.base, `prog-${name}`); fs.writeFileSync(f, `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, name))}\n${body}\n`, { mode: 0o755 }); return f; };
  fs.writeFileSync(path.join(s.repo, 'b'), 'b');
  fs.writeFileSync(path.join(s.repo, '.gitattributes'), 'a filter=evil\nb filter=kept\n');
  s.g('add', '.gitattributes', 'b');
  s.g('commit', '-qm', 'attrs');
  // Set last, so only the hook's own git calls could run them.
  s.g('config', 'filter.evil.clean', prog('evil-clean'));
  s.g('config', 'filter.evil.process', prog('evil-process', 'exit 1'));
  const globalCfg = path.join(s.base, 'global.gitconfig');
  fs.writeFileSync(globalCfg, `[filter "kept"]\n\tclean = ${prog('kept-clean')}\n`);
  const env = { GIT_CONFIG_GLOBAL: globalCfg };
  // Each status must hash a and b again: their times no longer match the index.
  let back = 3;
  const age = () => { const t = new Date(Date.now() - (back++) * 3600000); for (const f of ['a', 'b']) fs.utimesSync(path.join(s.repo, f), t, t); };
  // Proof that the fixture is live: plain git runs each filter (a failing
  // process filter stops git status, so each is shown on its own).
  for (const f of ['a', 'b']) spawnSync('git', ['hash-object', `--path=${f}`, f], { cwd: s.repo, env: { ...s.env, ...env }, stdio: 'ignore' });
  assert.deepStrictEqual(fs.readdirSync(marks).sort(), ['evil-process', 'kept-clean']);
  fs.rmSync(marks, { recursive: true }); fs.mkdirSync(marks);
  age();
  const r = jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: SA }), env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(marks), ['kept-clean'], 'the repo\'s filter ran, or the user\'s own did not');
  const snap = () => fs.readFileSync(path.join(s.memdir, 'snapshots', `${SA}.md`), 'utf8');
  assert.match(snap(), /^Uncommitted files: 0$/m, snap());
  assert.match(snap(), /\(1 tracked file\(s\) use a filter the repo's own config defines; it was off for this check/, snap());
  // A filter name that can't be passed safely as a -c setting: status is not read.
  fs.writeFileSync(path.join(s.repo, '.gitattributes'), 'a filter=evil\nb filter=kept\nc filter=ev:il\n');
  fs.writeFileSync(path.join(s.repo, 'c'), 'c');
  s.g('add', 'c');
  fs.rmSync(marks, { recursive: true }); fs.mkdirSync(marks);
  age();
  assert.strictEqual(jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: SA }), env).status, 0);
  assert.match(snap(), /^Uncommitted files: not read \(odd-filter-name\)$/m, snap());
  assert.match(notesOf(s), /PRE_COMPACT trigger=auto .* uncommitted=unknown session=11111111/);
  assert.deepStrictEqual(fs.readdirSync(marks), []);
});

// A commit hook whose git ran out of the launcher's time (about 5 s,
// trailmark.js; a busy machine) logs COMMIT_UNRESOLVED why=git-timeout and
// leaves the commit to the next sweep. The step isn't made again (the hook
// would take it for the same command run twice), so the test is skipped.
class GitOutOfTime extends Error {}
const inTimeTest = (fn) => (t) => {
  try { fn(t); } catch (e) {
    if (!(e instanceof GitOutOfTime)) throw e;
    t.skip(e.message);
  }
};
test('0.3.4 commits: another session\'s commit in the same folder while a command ran is left to that session when git printed this command\'s', inTimeTest(() => {
  const { s, wt, gWt, head, hook } = multiFolder();
  const logged = () => {
    if (/COMMIT_UNRESOLVED why=git-timeout/.test(notesOf(s))) throw new GitOutOfTime('a commit hook ran out of the launcher\'s time for git (COMMIT_UNRESOLVED why=git-timeout): git is too slow on this machine now');
    return commitLines(s);
  };
  const a = toolCall(s, SA, 'git commit -m "by A"');
  const b = toolCall(s, SB, 'git commit -m "by B meanwhile"');
  a.pre(wt); b.pre(wt);
  // Each PreToolUse record names the folders its command commits in.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.memdir, 'pending', `${b.id}.json`), 'utf8')).sites, [wt]);
  gWt('commit', '-q', '--allow-empty', '-m', 'by B meanwhile');
  const shaB = head(wt);
  gWt('commit', '-q', '--allow-empty', '-m', 'by A');
  const shaA = head(wt);
  assert.strictEqual(a.post(wt, { stdout: `[wa ${shaA}] by A\n`, stderr: '', interrupted: false }).status, 0);
  let lines = logged();
  assert.deepStrictEqual(lines.map(l => l.slice(8)), [`COMMIT ${shaA} by A session=11111111`], lines.join('\n'));
  b.post(wt, { stdout: `[wa ${shaB}] by B meanwhile\n`, stderr: '', interrupted: false });
  lines = logged();
  assert.deepStrictEqual(lines.map(l => l.slice(8)), [`COMMIT ${shaA} by A session=11111111`, `COMMIT ${shaB} by B meanwhile session=22222222`], lines.join('\n'));
  // Nothing printed (git commit -q): both stay with the command, as in 0.3.3.
  gWt('commit', '-q', '--allow-empty', '-m', 'quiet other');
  gWt('commit', '-q', '--allow-empty', '-m', 'quiet mine');
  hook(wt, SA, 'git commit -q -m "quiet mine"');
  lines = logged();
  assert.ok(lines.some(l => l.endsWith(' quiet other session=11111111')) && lines.some(l => l.endsWith(' quiet mine session=11111111')), lines.join('\n'));
  // A printed SHA that accounts for none of the extras (output from another
  // command): all stay.
  gWt('commit', '-q', '--allow-empty', '-m', 'odd one');
  gWt('commit', '-q', '--allow-empty', '-m', 'odd two');
  hook(wt, SA, 'git commit -m "odd two"', { response: { stdout: '[wa 0123456] something else\n' } });
  lines = logged();
  assert.ok(lines.some(l => l.endsWith(' odd one session=11111111')) && lines.some(l => l.endsWith(' odd two session=11111111')), lines.join('\n'));
  // A commit the command text doesn't show (a git alias, a post-commit hook,
  // a script), quiet, with no other commit command running: it is this
  // command's, printed line or not.
  gWt('commit', '-q', '--allow-empty', '-m', 'via an alias');
  gWt('commit', '-q', '--allow-empty', '-m', 'explicit');
  hook(wt, SA, 'git ci -q -m "via an alias" && git commit -m explicit', { response: { stdout: `[wa ${head(wt)}] explicit\n` } });
  lines = logged();
  assert.ok(lines.some(l => l.endsWith(' via an alias session=11111111')) && lines.some(l => l.endsWith(' explicit session=11111111')), lines.join('\n'));
  // The same, with records that aren't another session's command in this
  // folder: this session's own earlier command whose PostToolUse hook never
  // ran (it failed), and another session's command running in the main
  // checkout, which holds this worktree inside it but has its own HEAD.
  toolCall(s, SA, 'git commit -m "rejected by a hook"').pre(wt);
  toolCall(s, SB, 'git commit -m "in the main checkout" && sleep 600').pre(s.repo);
  gWt('commit', '-q', '--allow-empty', '-m', 'via an alias again');
  gWt('commit', '-q', '--allow-empty', '-m', 'explicit again');
  hook(wt, SA, 'git ci -q -m "via an alias again" && git commit -m "explicit again"', { response: { stdout: `[wa ${head(wt)}] explicit again\n` } });
  lines = logged();
  assert.ok(lines.some(l => l.endsWith(' via an alias again session=11111111')) && lines.some(l => l.endsWith(' explicit again session=11111111')), lines.join('\n'));
}));

test('0.3.4 sweep: a commit no hook saw is logged once as (found later) at write-handoff and at a resume; an amended one, one already logged and another folder\'s are not', sweepTest((t) => {
  const repeats0 = sweepRepeats();
  const { s, wt, clone, gClone, gWt, head, hook } = multiFolder();
  const start = (sid, cwd, source) => settle(() => {
    const r = jbmIn(s, cwd, ['--hook', 'session-start'], JSON.stringify({ cwd, session_id: sid, source, hook_event_name: 'SessionStart' }));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  });
  const write = (sid, cwd) => settle(() => {
    const r = jbmIn(s, cwd, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${sid}`], `# H\n- by ${sid.slice(0, 8)}\n`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  });
  start(SA, wt, 'startup');
  // Through the hook, in the clone: logged with the session as usual, and the clone becomes one of its folders.
  gClone('commit', '-q', '--allow-empty', '-m', 'hooked');
  hook(wt, SA, `git -C "${clone}" commit -q -m hooked`);
  // No hook saw these: a script's commit in the worktree, one in the clone, and one amended away.
  gWt('commit', '-q', '--allow-empty', '-m', 'by a script');
  const scripted = head(wt);
  gClone('commit', '-q', '--allow-empty', '-m', 'typo');
  gClone('commit', '-q', '--amend', '--allow-empty', '-m', 'fixed typo');
  // A commit in a folder that isn't this session's.
  s.g('commit', '-q', '--allow-empty', '-m', 'main by hand');
  tick();
  const w = write(SA, wt);
  assert.strictEqual(w.logged, 2, w.out);
  let lines = commitLines(s).map(l => l.slice(8));
  assert.ok(lines.includes(`COMMIT ${scripted} by a script (found later) session=11111111`), lines.join('\n'));
  assert.ok(lines.includes(`COMMIT ${head(clone)} in="${dp(clone)}" fixed typo (found later) session=11111111`), lines.join('\n'));
  assert.strictEqual(lines.filter(l => / hooked /.test(l)).length, 1, lines.join('\n'));
  assert.ok(!lines.some(l => / typo \(found later\)/.test(l) && !/fixed typo/.test(l)), 'the amended-away commit: ' + lines.join('\n'));
  assert.ok(!notesOf(s).includes('main by hand'), notesOf(s));
  // Again: nothing new.
  tick();
  assert.strictEqual(write(SA, wt).logged, 0);
  assert.strictEqual(commitLines(s).length, lines.length);
  // A resume finds a commit made while the session was away, once.
  gWt('commit', '-q', '--allow-empty', '-m', 'while away');
  tick();
  start(SA, wt, 'resume');
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(wt)} while away (found later) session=11111111`)), notesOf(s));
  start(SA, wt, 'resume');
  assert.strictEqual(commitLines(s).filter(l => / while away /.test(l)).length, 1);
  let rec = stateOf(s).sessions[SA];
  assert.ok(rec.home === wt && rec.swept[wt] > rec.start && rec.swept[clone] > rec.start, JSON.stringify(rec));
  // A folder that can't be read during one sweep keeps its own start: what
  // happened there is found once it is back.
  gClone('commit', '-q', '--allow-empty', '-m', 'while the clone was away');
  const away = clone + '-away';
  fs.renameSync(clone, away);
  tick();
  write(SA, wt);
  fs.renameSync(away, clone);
  assert.ok(!notesOf(s).includes('while the clone was away'));
  tick();
  write(SA, wt);
  assert.strictEqual(commitLines(s).filter(l => l.endsWith(` in="${dp(clone)}" while the clone was away (found later) session=11111111`)).length, 1, notesOf(s));
  // A session the hooks never saw start isn't swept.
  gWt('commit', '-q', '--allow-empty', '-m', 'unrecorded');
  tick();
  assert.strictEqual(write(SC, wt).logged, 0);
  assert.ok(!notesOf(s).includes('unrecorded (found later) session=33333333'));
  t.diagnostic(`sweeps that ran out of time and were repeated: ${sweepRepeats() - repeats0}`);
}));

test('0.5.1 sweep: one that runs out of time says so, logs nothing and moves no start; the next sweep logs what it missed', sweepTest(() => {
  const { s, wt, gWt, head } = multiFolder();
  const start = (env) => jbmIn(s, wt, ['--hook', 'session-start'], JSON.stringify({ cwd: wt, session_id: SA, source: 'resume', hook_event_name: 'SessionStart' }), env);
  const write = (env) => {
    const r = jbmIn(s, wt, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], `# H\n- by A\n`, env);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  // The first start records the session (its start time), whether its sweep finishes or not.
  assert.strictEqual(start({}).status, 0);
  const swept0 = JSON.stringify(stateOf(s).sessions[SA].swept || {});
  gWt('commit', '-q', '--allow-empty', '-m', 'by a script');
  const scripted = head(wt);
  tick();
  // Too little time to read any folder: 1600 ms leaves 1100 at the
  // launcher's first gate, under the 1300 a folder needs; 1000 is below the
  // 1500 a sweep needs at all.
  for (const ms of ['1600', '1000']) {
    const out = write({ JBMEM_TEST_SWEEP_MS: ms });
    assert.match(out, SWEEP_SKIP, out);
    assert.doesNotMatch(out, /logged \d+ commit/, out);
    const r = start({ JBMEM_TEST_SWEEP_MS: ms });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).systemMessage, SWEEP_SKIP, r.stdout);
    assert.ok(!notesOf(s).includes('by a script'), notesOf(s));
    assert.strictEqual(JSON.stringify(stateOf(s).sessions[SA].swept || {}), swept0, 'swept moved on a skipped sweep');
  }
  // The next sweep with its full time logs the commit, once.
  const w = settle(() => write({}));
  assert.strictEqual(w.logged, 1, w.out);
  assert.strictEqual(commitLines(s).filter(l => l.endsWith(`COMMIT ${scripted} by a script (found later) session=11111111`)).length, 1, notesOf(s));
  assert.ok(stateOf(s).sessions[SA].swept[wt] > 0, JSON.stringify(stateOf(s).sessions[SA]));
}));

test('0.5.1 sweep: gitfacts.sweepCommits with less than 800 ms left reads no folder and says it ran out of time', () => {
  const s = sandbox();
  const { sweepCommits } = require('../scripts/lib/gitfacts');
  const r = sweepCommits([{ dir: s.repo, since: Date.now() - 3600000 }], { homeCwd: s.repo, budgetMs: 700 });
  assert.strictEqual(r.stopped, 'out-of-time', JSON.stringify(r));
  assert.deepStrictEqual(r.read, []);
  assert.deepStrictEqual(r.folders, []);
  // No folders to read: nothing was cut short.
  assert.strictEqual(sweepCommits([], { homeCwd: s.repo, budgetMs: 700 }).stopped, undefined);
});

test('0.5.1 paths: when git times out in a linked worktree or a subfolder, the main checkout\'s memory folder is still the one used (dir, init, the commit-start record)', () => {
  const s = sandbox();
  const wt = path.join(s.repo, '.claude', 'worktrees', 'wb');
  s.g('worktree', 'add', '-q', '-b', 'wb', wt);
  const sub = path.join(s.repo, 'src');
  fs.mkdirSync(sub);
  // Claude Code makes a project folder for each folder a session runs in, so
  // the worktree has one of its own: a lookup from the worktree itself takes
  // it as verified.
  const wtProject = path.join(s.cfg, 'projects', wt.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(wtProject, { recursive: true });
  const stub = path.join(s.base, 'git-timeout.js');
  fs.writeFileSync(stub, GIT_TIMEOUT_STUB);
  const slow = (cwd, args, input) => spawnSync(process.execPath, ['-r', stub, JBM, ...args], { cwd, env: s.env, input, encoding: 'utf8' });
  // The stub works: git rev-parse fails with ETIMEDOUT under it.
  const probe = spawnSync(process.execPath, ['-r', stub, '-e', "try { require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel']); console.log('ran'); } catch (e) { console.log(e.code); }"], { cwd: wt, encoding: 'utf8' });
  assert.strictEqual(probe.stdout.trim(), 'ETIMEDOUT', probe.stdout + probe.stderr);
  for (const cwd of [wt, sub]) {
    const d = slow(cwd, ['dir', '--json']);
    assert.strictEqual(d.status, 0, d.stdout + d.stderr);
    assert.strictEqual(path.resolve(JSON.parse(d.stdout).dir), path.resolve(s.memdir), d.stdout);
  }
  // Set up from the worktree while git times out: the main checkout's folder, not the worktree's.
  const init = slow(wt, ['init']);
  assert.strictEqual(init.status, 0, init.stdout + init.stderr);
  assert.ok(fs.existsSync(path.join(s.memdir, 'handoff.md')), init.stdout);
  assert.ok(!fs.existsSync(path.join(wtProject, 'memory')), 'the worktree\'s own folder was set up');
  // A commit command's PreToolUse record is written where the sweep reads it.
  const id = `toolu_slow${process.pid}`;
  const pre = slow(wt, ['--hook', 'commit-start'], JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_use_id: id, cwd: wt, hook_event_name: 'PreToolUse' }));
  assert.strictEqual(pre.status, 0, pre.stdout + pre.stderr);
  assert.ok(fs.existsSync(path.join(s.memdir, 'pending', `${id}.json`)), 'no commit-start record');
});

test('0.3.4 sweep: another clone with its own memory folder: what its sessions logged, or are still committing, stays theirs', sweepTest(() => {
  const { s, wt, clone, gClone, head, hook } = multiFolder();
  const start = (sid, cwd) => jbmIn(s, cwd, ['--hook', 'session-start'], JSON.stringify({ cwd, session_id: sid, source: 'startup', hook_event_name: 'SessionStart' }));
  const write = (sid, cwd) => {
    // The version read in the folder written: the clone has a handoff of its own.
    const r = jbmIn(s, cwd, ['write-handoff', `--base=${versionNow((a, i) => jbmIn(s, cwd, a, i))}`, `--session=${sid}`], `# H\n- by ${sid.slice(0, 8)}\n`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  // The clone is set up for trailmark too, with its own memory folder
  // (Claude Code made a project folder for it when a session ran there).
  fs.mkdirSync(path.join(s.cfg, 'projects', clone.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const ci = jbmIn(s, clone, ['init']);
  assert.strictEqual(ci.status, 0, ci.stdout + ci.stderr);
  const cloneMem = JSON.parse(jbmIn(s, clone, ['dir', '--json']).stdout).dir;
  assert.notStrictEqual(cloneMem, s.memdir);
  const cloneNotes = () => fs.readdirSync(path.join(cloneMem, 'notes')).map(f => fs.readFileSync(path.join(cloneMem, 'notes', f), 'utf8')).join('');
  start(SA, wt); start(SB, clone);
  // A commits in the clone through the hook, so the clone is one of A's folders.
  gClone('commit', '-q', '--allow-empty', '-m', 'A in the clone');
  hook(wt, SA, `git -C "${clone}" commit -q -m "A in the clone"`);
  // B, whose session is in the clone, commits there; its hook logs it in the clone's memory.
  gClone('commit', '-q', '--allow-empty', '-m', 'B at home');
  const shaB = head(clone);
  const bHook = hook(clone, SB, 'git commit -q -m "B at home"');
  // With git slowed by other work, B's hook can run out of time: it says so,
  // and B's own sweep logs the commit, in the clone's memory.
  if (/not logged yet: git was too slow/.test(bHook.stdout)) settle(() => write(SB, clone));
  // Logged by B's hook, or by B's sweep, which marks it (found later).
  assert.match(cloneNotes(), new RegExp(`COMMIT ${shaB} B at home (?:\\(found later\\) )?session=22222222`));
  // A commit nobody logged anywhere, before B's next command starts.
  gClone('commit', '-q', '--allow-empty', '-m', 'nobody logged');
  const shaN = head(clone);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
  // B's next command is still running when A checkpoints.
  const b2 = toolCall(s, SB, 'git commit -m "B running" && sleep 600');
  jbmIn(s, clone, ['--hook', 'commit-start'], JSON.stringify({ session_id: SB, tool_name: 'Bash', tool_input: { command: 'git commit -m "B running" && sleep 600' }, tool_use_id: b2.id, cwd: clone, hook_event_name: 'PreToolUse' }));
  gClone('commit', '-q', '--allow-empty', '-m', 'B running');
  const shaB2 = head(clone);
  tick();
  settle(() => write(SA, wt));
  const mine = notesOf(s);
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${shaN} in="${dp(clone)}" nobody logged (found later) session=11111111`)), mine);
  assert.ok(!mine.includes(shaB), 'B\'s logged commit: ' + mine);
  assert.ok(!mine.includes(shaB2), 'B\'s running command\'s commit: ' + mine);
  assert.ok(!mine.includes('B at home') && !mine.includes('B running'), mine);
}));

test('0.3.4 sweep: a commit made after the sweep started is the next sweep\'s', sweepTest(() => {
  const s = sandbox();
  const { sweepCommits } = require('../scripts/lib/gitfacts');
  tick();
  const t0 = Date.now();
  tick();
  s.g('commit', '-q', '--allow-empty', '-m', 'after the sweep began');
  const first = settleCall(() => sweepCommits([{ dir: s.repo, since: t0 }], { homeCwd: s.repo, now: t0 }));
  assert.deepStrictEqual(first.folders, []);
  assert.deepStrictEqual(first.read, [{ dir: s.repo, at: Math.floor(t0 / 1000) * 1000 }]);
  const second = settleCall(() => sweepCommits([{ dir: s.repo, since: first.read[0].at }], { homeCwd: s.repo, now: Date.now() + 1000 }));
  assert.deepStrictEqual(second.folders.map(f => f.entries.map(e => e.subject)), [['after the sweep began']]);
  // An excluded SHA (logged in another memory folder) is left out; a folder that isn't there isn't read.
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.repo, encoding: 'utf8' }).trim();
  const third = settleCall(() => sweepCommits([{ dir: s.repo, since: first.read[0].at, exclude: [sha.slice(0, 7)] }, { dir: path.join(s.base, 'gone'), since: 0 }], { homeCwd: s.repo, now: Date.now() + 1000 }));
  assert.deepStrictEqual(third.folders, []);
  assert.deepStrictEqual(third.read.map(r => r.dir), [s.repo]);
}));

const HAVE_LFS = spawnSync('git', ['lfs', 'version'], { stdio: 'ignore' }).status === 0;
test('0.3.4 hardening: Git LFS set up in the repo\'s own config still runs for status; an LFS extension the repo defines skips status', { skip: POSIX_ONLY || (!HAVE_LFS && 'git-lfs is not installed') }, () => {
  const s = sandbox();
  jbm(s, ['init']);
  // Only the repo's own config: no system or global LFS install.
  const emptyGlobal = path.join(s.base, 'empty.gitconfig');
  fs.writeFileSync(emptyGlobal, '');
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobal };
  const g = (...a) => execFileSync('git', a, { cwd: s.repo, env: { ...process.env, ...env }, stdio: 'ignore' });
  g('lfs', 'install', '--local');
  g('lfs', 'track', '*.bin');
  fs.writeFileSync(path.join(s.repo, 'x.bin'), Buffer.alloc(4096, 7));
  g('add', '.gitattributes', 'x.bin');
  g('commit', '-qm', 'lfs file');
  let back = 3;
  const age = () => { const t = new Date(Date.now() - (back++) * 3600000); fs.utimesSync(path.join(s.repo, 'x.bin'), t, t); };
  const snap = () => fs.readFileSync(path.join(s.memdir, 'snapshots', `${SA}.md`), 'utf8');
  const compact = () => assert.strictEqual(jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: SA }), env).status, 0);
  age();
  compact();
  assert.match(snap(), /^Uncommitted files: 0$/m, snap());
  assert.ok(!/use a filter/.test(snap()), snap());
  // "required" with no value means true.
  const cfgFile = path.join(s.repo, '.git', 'config');
  const cfgText = fs.readFileSync(cfgFile, 'utf8');
  assert.match(cfgText, /required = true/);
  fs.writeFileSync(cfgFile, cfgText.replace(/required = true/, 'required'));
  age();
  compact();
  assert.match(snap(), /^Uncommitted files: 0$/m, snap());
  // An extension program named in the repo's own config: git-lfs would run it.
  const marks = path.join(s.base, 'marks');
  fs.mkdirSync(marks);
  const prog = path.join(s.base, 'ext');
  fs.writeFileSync(prog, `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, 'ext'))}\ncat\n`, { mode: 0o755 });
  g('config', 'lfs.extension.evil.clean', `${prog} %f`);
  g('config', 'lfs.extension.evil.smudge', 'cat');
  g('config', 'lfs.extension.evil.priority', '0');
  spawnSync('git', ['hash-object', '--path=x.bin', 'x.bin'], { cwd: s.repo, env: { ...process.env, ...env }, stdio: 'ignore' });
  assert.deepStrictEqual(fs.readdirSync(marks), ['ext'], 'plain git with LFS runs the extension');
  fs.rmSync(marks, { recursive: true }); fs.mkdirSync(marks);
  age();
  compact();
  assert.deepStrictEqual(fs.readdirSync(marks), []);
  assert.match(snap(), /^Uncommitted files: not read \(lfs-extension\)$/m, snap());
  // LFS settings in the repo that aren't what git lfs install writes: switched off like any repo filter, and said so.
  g('config', '--unset-all', 'lfs.extension.evil.clean');
  g('config', 'filter.lfs.process', `${prog}`);
  age();
  compact();
  assert.deepStrictEqual(fs.readdirSync(marks), []);
  assert.match(snap(), /\(1 tracked file\(s\) use a filter the repo's own config defines/, snap());
});

test('0.3.4 commits: a command that commits and then fails (PostToolUseFailure) logs the commit, with no reminder or end check, and is marked done', () => {
  const { s, wt, clone, gClone, head } = multiFolder();
  const cmd = `cd "${clone}" && git commit -q -m "then the push failed" && git push nowhere`;
  const t = toolCall(s, SA, cmd);
  t.pre(wt);
  gClone('commit', '-q', '--allow-empty', '-m', 'then the push failed');
  // As Claude Code sends it for a failed command: no tool_response, no duration_ms, the cwd where it started.
  const fail = { session_id: SA, tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: t.id, cwd: wt, hook_event_name: 'PostToolUseFailure', error: 'Exit code 128', is_interrupt: false };
  const r = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify(fail));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" then the push failed session=11111111`)), notesOf(s));
  assert.ok(!notesOf(s).includes('END_MISMATCH'), notesOf(s));
  assert.ok(fs.existsSync(path.join(s.memdir, 'pending', `${t.id}.done`)));
  // Run twice (git commit and git -C both match): logged once.
  jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify(fail));
  assert.strictEqual(commitLines(s).filter(l => / then the push failed /.test(l)).length, 1);
});

test('0.3.4 sweep: the sweeping session\'s own open records (a command denied at the prompt, a subagent still committing) hold nothing back', sweepTest(() => {
  const { s, wt, gWt } = multiFolder();
  const start = (sid, cwd) => jbmIn(s, cwd, ['--hook', 'session-start'], JSON.stringify({ cwd, session_id: sid, source: 'startup', hook_event_name: 'SessionStart' }));
  start(SA, wt);
  // A's command that never ran (denied), and A's subagent's commit command still running.
  toolCall(s, SA, 'git commit -m "denied"').pre(wt);
  toolCall(s, SA, 'git commit -m "subagent" && sleep 600').pre(wt);
  gWt('commit', '-q', '--allow-empty', '-m', 'by the subagent');
  gWt('commit', '-q', '--allow-empty', '-m', 'by a script');
  tick();
  settle(() => {
    const r = jbmIn(s, wt, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], '# H\n- x\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  });
  // Both are A's, so A's sweep logs them.
  const lines = commitLines(s);
  assert.ok(lines.some(l => l.endsWith(' by a script (found later) session=11111111')) && lines.some(l => l.endsWith(' by the subagent (found later) session=11111111')), lines.join('\n'));
}));

test('0.3.4 commits: a failed command with no PreToolUse record logs only what git printed; the printed rule reads a failed command\'s error text', () => {
  const { s, wt, gWt, head, hook } = multiFolder();
  const fail = (cmd, error, extra = {}) => jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `toolu_f${++toolSeq}x${process.pid}`, cwd: wt, hook_event_name: 'PostToolUseFailure', error, is_interrupt: false, ...extra }));
  // A commit made by hand a little earlier, then `git commit` that fails with nothing to commit.
  gWt('commit', '-q', '--allow-empty', '-m', 'made by hand');
  assert.strictEqual(fail('git commit -m x', 'Exit code 1\nnothing to commit, working tree clean').stdout, '');
  assert.ok(!notesOf(s).includes('made by hand'), notesOf(s));
  // One that commits, then fails at the push, with no record: what git printed is logged.
  gWt('commit', '-q', '--allow-empty', '-m', 'then the push failed');
  const sha = head(wt);
  fail('git commit -m "then the push failed" && git push nowhere', `Exit code 128\nfatal: 'nowhere' does not appear to be a git repository\n[wa ${sha}] then the push failed`);
  let lines = commitLines(s);
  assert.deepStrictEqual(lines.filter(l => / then the push failed /.test(l)).map(l => l.slice(8)), [`COMMIT ${sha} then the push failed session=11111111`]);
  assert.ok(!lines.some(l => / made by hand /.test(l)), lines.join('\n'));
  // With a record, another session committing in the same folder meanwhile, and
  // git's line for this command's commit in the error text: the other one is left out.
  const a = toolCall(s, SA, 'git commit -m "A then failed" && git push nowhere');
  const b = toolCall(s, SB, 'git commit -m "B meanwhile"');
  // Out of the window of A's command: the commits above.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
  a.pre(wt); b.pre(wt);
  gWt('commit', '-q', '--allow-empty', '-m', 'B meanwhile');
  const shaB = head(wt);
  gWt('commit', '-q', '--allow-empty', '-m', 'A then failed');
  const shaA = head(wt);
  jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: 'git commit -m "A then failed" && git push nowhere' }, tool_use_id: a.id, cwd: wt, hook_event_name: 'PostToolUseFailure', error: `Exit code 128\n[wa ${shaA}] A then failed`, is_interrupt: false }));
  lines = commitLines(s);
  assert.ok(lines.some(l => l.endsWith(`COMMIT ${shaA} A then failed session=11111111`)), lines.join('\n'));
  assert.ok(!lines.some(l => l.includes(shaB)), lines.join('\n'));
  b.post(wt, { stdout: `[wa ${shaB}] B meanwhile\n` });
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${shaB} B meanwhile session=22222222`)), notesOf(s));
});

test('0.3.4 sweep: a commit command still running (its PostToolUse hook hasn\'t run) keeps its commits for its own session', sweepTest(() => {
  const { s, wt, gWt, head, hook } = multiFolder();
  const start = (sid, cwd) => jbmIn(s, cwd, ['--hook', 'session-start'], JSON.stringify({ cwd, session_id: sid, source: 'startup', hook_event_name: 'SessionStart' }));
  const write = (sid) => settle(() => {
    const r = jbmIn(s, wt, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${sid}`], `# H\n- by ${sid.slice(0, 8)}\n`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  });
  start(SA, wt); start(SB, wt);
  gWt('commit', '-q', '--allow-empty', '-m', 'before B started');
  const early = head(wt);
  // The reflog keeps whole seconds and the sweep stops 1 s short of a running command's start.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200);
  // B's command starts, commits, and is still running when A checkpoints.
  const b = toolCall(s, SB, 'git commit -m "B running" && sleep 600');
  b.pre(wt);
  gWt('commit', '-q', '--allow-empty', '-m', 'B running');
  const shaB = head(wt);
  write(SA);
  let lines = commitLines(s).map(l => l.slice(8));
  // What came before B's command started is swept; B's commit isn't.
  assert.ok(lines.includes(`COMMIT ${early} before B started (found later) session=11111111`), lines.join('\n'));
  assert.ok(!lines.some(l => l.includes(shaB)), lines.join('\n'));
  // B's hook logs it with B's session; A's next sweep leaves it alone.
  b.post(wt, {}, 600000);
  write(SA);
  lines = commitLines(s).map(l => l.slice(8));
  assert.deepStrictEqual(lines.filter(l => l.includes(shaB)), [`COMMIT ${shaB} B running session=22222222`], lines.join('\n'));
  // Commands whose hooks found nothing new, or that failed, are marked done
  // and hold nothing back.
  const none = toolCall(s, SB, 'git commit -m none');
  none.pre(wt);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
  assert.strictEqual(none.post(wt).stdout, '');
  const bad = toolCall(s, SC, 'git commit -m rejected');
  bad.pre(wt);
  bad.post(wt, { exit_code: 1 });
  assert.ok(fs.existsSync(path.join(s.memdir, 'pending', `${none.id}.done`)) && fs.existsSync(path.join(s.memdir, 'pending', `${bad.id}.done`)));
  // And a commit after that is swept as usual.
  gWt('commit', '-q', '--allow-empty', '-m', 'after B');
  tick();
  write(SA);
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(wt)} after B (found later) session=11111111`)), notesOf(s));
}));

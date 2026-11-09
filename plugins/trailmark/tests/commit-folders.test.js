// Run: node --test tests/commit-folders.test.js
// 0.6.0: the session's commit folders and what a hook's script is handed,
// with the context-watch tests that came after them in 0.6.0 (the others
// are in context-watch.test.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { dp, ROOT, sandbox, versionNow, wh, J, JBM, jbm, SA, notesOf, cp,
  ageReflogs, multiFolder, commitLines, tick, settle, sweepTest,
  GIT_TIMEOUT_STUB, contextWatchSetup, askText } = require('./helpers.js');
// Tool-use IDs: this file counts its own, and helpers.js counts for its
// own prefix, so no two IDs are the same.
let toolSeq = 0;

// ---------- 0.6.0: the session's commit folders ----------

// A plain repo for a commit folder, its first commit ten minutes old as far
// as its reflog says.
const plainRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('commit', '-q', '--allow-empty', '-m', 'first');
  ageReflogs(path.join(dir, '.git'), 600);
  return g;
};
// A commit command sent to the background in dir: its hooks run before it commits.
const bgCommit = (s, dir, msg) => {
  const id = `toolu_bgj${++toolSeq}x${process.pid}`;
  const base = { session_id: SA, tool_name: 'Bash', tool_input: { command: `git -C "${dir}" commit -q --allow-empty -m "${msg}"`, run_in_background: true }, tool_use_id: id };
  assert.strictEqual(jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...base, cwd: s.repo, hook_event_name: 'PreToolUse' })).status, 0);
  const post = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ ...base, cwd: s.repo, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 40 }));
  assert.strictEqual(post.status, 0, post.stdout + post.stderr);
};
const sweepNow = (s) => settle(() => {
  const r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], '# H\n- swept\n');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
});

test('0.6.0 commit folders: a folder that joins the session\'s commit folders is swept from its command\'s start, not the session\'s', sweepTest(() => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const { s, clone, gClone, head } = multiFolder();
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'startup', hook_event_name: 'SessionStart' }));
  // The session started five minutes ago; another session committed in the
  // clone half a minute ago, before this session's command there.
  S.updateState(s.memdir, SA, (state, rec) => { rec.start = Date.now() - 300000; });
  gClone('commit', '-q', '--allow-empty', '-m', 'not this session');
  ageReflogs(path.join(clone, '.git'), 30);
  bgCommit(s, clone, 'bg elsewhere');
  gClone('commit', '-q', '--allow-empty', '-m', 'bg elsewhere');
  const sha = head(clone);
  tick();
  sweepNow(s);
  const lines = commitLines(s);
  assert.ok(lines.some(l => l.endsWith(`COMMIT ${sha} in="${dp(clone)}" bg elsewhere (found later) session=11111111`)), notesOf(s));
  assert.ok(!lines.some(l => l.includes('not this session')), lines.join('\n'));
}));

test('0.6.0 commit folders: past six, a folder a sweep has read since it joined goes first, not one whose background command may still commit', sweepTest(() => {
  const { s, hook } = multiFolder();
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'startup', hook_event_name: 'SessionStart' }));
  const at = (n) => path.join(s.base, n);
  const g = Object.fromEntries(['bgx', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(n => [n, plainRepo(at(n))]));
  tick();
  // First a command sent to the background in bgx, which hasn't committed yet.
  bgCommit(s, at('bgx'), 'bg late');
  // Then commits in five more folders, logged as they land.
  const logged = (n) => {
    const r = hook(s.repo, SA, `git -C "${at(n)}" commit -q --allow-empty -m "in ${n}"`, { duration_ms: 3000, between: () => g[n]('commit', '-q', '--allow-empty', '-m', `in ${n}`) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  };
  for (const n of ['f1', 'f2', 'f3', 'f4', 'f5']) logged(n);
  tick();
  // A sweep reads all six; the background command may still commit after it.
  sweepNow(s);
  // A seventh folder: f1, read since it joined, makes room, not bgx.
  logged('f6');
  const rec = JSON.parse(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8')).sessions[SA];
  assert.strictEqual(rec.commitDirs.length, 6, JSON.stringify(rec.commitDirs));
  assert.ok(rec.commitDirs.some(d => d === at('bgx')), JSON.stringify(rec.commitDirs));
  assert.ok(!rec.commitDirs.some(d => d === at('f1')), JSON.stringify(rec.commitDirs));
  // The background command commits now, and the next sweep logs it.
  g.bgx('commit', '-q', '--allow-empty', '-m', 'bg late');
  tick();
  sweepNow(s);
  assert.ok(commitLines(s).some(l => l.includes(`in="${dp(at('bgx'))}" bg late (found later)`)), notesOf(s));
}));

test('0.6.0 commit hook: when git times out and another command holds the state file, Claude is still told the commit isn\'t logged', () => {
  const s = sandbox();
  jbm(s, ['init']);
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'startup', hook_event_name: 'SessionStart' }));
  const stub = path.join(s.base, 'git-timeout.js');
  fs.writeFileSync(stub, GIT_TIMEOUT_STUB);
  s.g('commit', '-q', '--allow-empty', '-m', 'slow and locked');
  // The lock's holder is this test process, alive, so the hook gives up after its 2 s.
  const lock = path.join(s.memdir, '.jbmem.lock');
  fs.writeFileSync(lock, `pid ${process.pid} since now token busy\n`);
  let r;
  try {
    r = spawnSync(process.execPath, ['-r', stub, JBM, '--hook', 'milestone', 'commit'], { cwd: s.repo, env: s.env, encoding: 'utf8',
      input: JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: 'git commit -m "slow and locked"' }, tool_use_id: `toolu_lk${++toolSeq}x${process.pid}`, cwd: s.repo, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 3000 }) });
  } finally {
    fs.rmSync(lock, { force: true });
  }
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(notesOf(s), /COMMIT_UNRESOLVED why=git-timeout/, notesOf(s));
  assert.ok(r.stdout, 'nothing was said to Claude');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /A commit was not logged: git was too slow \(it timed out\) in one folder, and trailmark's state file couldn't be updated, so a later sweep may miss it\./, ctx);
  assert.ok(!ctx.includes(dp(s.repo)), ctx);
});

test('0.6.0 context watch: an image counts as one image, one tool call adds at most 25k, and an ask from an estimate under the first step neither repeats nor ends the steps', () => {
  const c = contextWatchSetup({ model: 'claude-haiku-4-5' }); // a 200k model: compaction near 167k, 75% near 125k, first step near 142k
  // An image Read, shaped as in a transcript (2026-11-05): its base64 is
  // 670k characters, the model gets at most 4,784 tokens. 120k + 4.8k is
  // under the first step; counted as text it would be 120k + 25k.
  c.usage(120000);
  const image = { type: 'image', file: { base64: 'QUJD'.repeat(167500), type: 'image/png', originalSize: 500000 } };
  assert.strictEqual(c.run({ tool_name: 'Read', tool_response: image }), null, 'an image Read at 120k: silent');
  // Two large results in a row from under 75% (Opus round 2): 124k + 20k
  // asks, at most 25k for one call.
  c.usage(124000);
  assert.match(askText(c.run({ tool_name: 'Read', tool_response: { file: { content: 'r'.repeat(80000) } } })), /about 144k tokens/);
  const edit = { tool_name: 'Edit', tool_response: { filePath: 'x', originalFile: 'y'.repeat(400000) } };
  // Still under 75%: the same step doesn't ask again, call after call.
  c.usage(121000);
  for (let i = 1; i <= 2; i++) assert.strictEqual(c.run(edit), null, `call ${i} under 75%: silent`);
  // The handoff is written: an estimate past the line asks nothing more
  // (Opus round 3: it asked again at once at an estimated 151k)...
  assert.strictEqual(wh((a2, i) => jbm(c.s, a2, i), '# H\n## Next\n- x\n', [`--session=${SA}`]).status, 0);
  c.usage(126000);
  assert.strictEqual(c.run(edit), null, '126k + 25k after the checkpoint: silent');
  // ...until the transcript itself reaches the first step: the steps start
  // over there, and the request comes from the real size.
  c.usage(143000);
  const again = askText(c.run());
  assert.match(again, /about 143k tokens/);
  assert.doesNotMatch(again, /has not written/);
  // Without a write, reaching the first step doesn't start over: no second
  // first request while Claude is still on the first, also with a size under
  // the line read since the ask (Opus round 3).
  const d = contextWatchSetup({ model: 'claude-haiku-4-5' });
  d.usage(124000);
  assert.ok(d.run(edit), 'an early ask');
  for (const n of [124500, 126000, 127000]) {
    d.usage(n);
    assert.strictEqual(d.run(), null, `${n}, no write: silent`);
  }
  d.usage(143000);
  assert.strictEqual(d.run(), null, '143k, no write: silent');
  assert.strictEqual(d.rec().contextWatch.level, 1, 'kept');
  d.usage(151000);
  assert.match(askText(d.run()), /has not written/, 'the next step asks again, as a repeat');
});

test('0.6.0 context watch: a request bigger than the window the model\'s name gives lifts that cap (a 1M context the name doesn\'t show)', () => {
  // The window from the variable, capped at 200k by the name.
  const c = contextWatchSetup({ model: 'claude-sonnet-4-5-20250929' });
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' };
  c.usage(145000);
  assert.match(askText(c.run({}, env)), /about 167k/, 'under 200k the cap holds');
  assert.strictEqual(wh((a2, i) => jbm(c.s, a2, i), '# H\n## Next\n- x\n', [`--session=${SA}`]).status, 0);
  c.usage(600000);
  assert.strictEqual(c.run({}, env), null, 'past 200k: the 1M window, under its first step');
  c.usage(830000);
  assert.match(askText(c.run({}, env)), /about 830k tokens.*about 967k/);
  // No setting: the model's own window, lifted to 1M the same way.
  const d = contextWatchSetup({ model: 'claude-sonnet-4-5-20250929', settings: {} });
  d.usage(830000);
  assert.match(askText(d.run()), /about 967k/);
});

test('0.6.0 commit folders: a folder\'s join time is measured from the launcher\'s start, not from the later start of the script it runs', () => {
  const s = sandbox();
  jbm(s, ['init']);
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'startup', hook_event_name: 'SessionStart' }));
  const other = path.join(s.base, 'jt');
  const g = plainRepo(other);
  g('commit', '-q', '--allow-empty', '-m', 'joined');
  // A preload that holds the launcher 3 s, as slow git would; the script it
  // starts under the sandbox gets no -r.
  const wait = path.join(s.base, 'wait.js');
  fs.writeFileSync(wait, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n');
  const before = Date.now();
  const r = spawnSync(process.execPath, ['-r', wait, JBM, '--hook', 'milestone', 'commit'], { cwd: s.repo, env: s.env, encoding: 'utf8',
    input: JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: `git -C "${other}" commit -q --allow-empty -m "joined"` }, tool_use_id: `toolu_jt${++toolSeq}x${process.pid}`, cwd: s.repo, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 1000 }) });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - before >= 3000, 'the launcher was held');
  const rec = JSON.parse(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8')).sessions[SA];
  const key = Object.keys(rec.commitDirsAt || {}).find(k => path.resolve(k).toLowerCase() === path.resolve(other).toLowerCase());
  assert.ok(key, JSON.stringify(rec));
  // With no PreToolUse record: the launcher's start, less duration_ms and
  // 5 s, in whole seconds. From the sandboxed script's start it would be
  // about 3 s later.
  const from = rec.commitDirsAt[key][0];
  assert.ok(from <= before - 5000, `the join time is ${from - before} ms from the launcher's start`);
});

test('0.6.0 context watch: a prompt counts in full, and an image counts as much as the high-resolution tier allows', () => {
  const c = contextWatchSetup(); // 400k window: compaction near 367k, first step near 312k
  // Claude Code has no 25k limit on a prompt: a 200k-character paste is
  // about 50k tokens, 280k + 50k.
  c.usage(280000);
  const a = c.run({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(200000) });
  assert.match(askText(a), /about 330k tokens/);
  // An image costs at most 4,784 tokens on the high-resolution tier
  // (Claude's vision docs): 308k + 4.8k is past the first step.
  const d = contextWatchSetup();
  d.usage(308000);
  const image = { type: 'image', file: { base64: 'QUJD'.repeat(100000), type: 'image/png', originalSize: 300000 } };
  assert.match(askText(d.run({ tool_name: 'Read', tool_response: image })), /about 313k tokens/);
});

test('0.6.0 commit hook: when git times out and the state file can\'t be updated for another reason (the state file or the lock is a folder), Claude isn\'t told another command held it', () => {
  const s = sandbox();
  jbm(s, ['init']);
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'startup', hook_event_name: 'SessionStart' }));
  const stub = path.join(s.base, 'git-timeout.js');
  fs.writeFileSync(stub, GIT_TIMEOUT_STUB);
  s.g('commit', '-q', '--allow-empty', '-m', 'slow, state unreadable');
  // A folder where the state file goes: reading it fails, and no lock is held.
  const state = path.join(s.memdir, '.jbmem-state.json');
  fs.rmSync(state, { force: true });
  fs.mkdirSync(state);
  let r;
  try {
    r = spawnSync(process.execPath, ['-r', stub, JBM, '--hook', 'milestone', 'commit'], { cwd: s.repo, env: s.env, encoding: 'utf8',
      input: JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: 'git commit -m "slow, state unreadable"' }, tool_use_id: `toolu_su${++toolSeq}x${process.pid}`, cwd: s.repo, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 3000 }) });
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout, 'nothing was said to Claude');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /A commit was not logged: git was too slow \(it timed out\) in one folder, and trailmark's state file couldn't be updated, so a later sweep may miss it\./, ctx);
  assert.doesNotMatch(ctx, /another command held/, ctx);
  // A folder where the lock file goes: the lock code (JBMEM_LOCKED) without
  // another command holding anything.
  s.g('commit', '-q', '--allow-empty', '-m', 'slow, lock path a folder');
  const lock = path.join(s.memdir, '.jbmem.lock');
  fs.mkdirSync(lock);
  try {
    r = spawnSync(process.execPath, ['-r', stub, JBM, '--hook', 'milestone', 'commit'], { cwd: s.repo, env: s.env, encoding: 'utf8',
      input: JSON.stringify({ session_id: SA, tool_name: 'Bash', tool_input: { command: 'git commit -m "slow, lock path a folder"' }, tool_use_id: `toolu_lf${++toolSeq}x${process.pid}`, cwd: s.repo, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 3000 }) });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout, 'nothing was said to Claude about the lock folder');
  const ctx2 = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx2, /in one folder, and trailmark's state file couldn't be updated, so a later sweep may miss it\./, ctx2);
  assert.doesNotMatch(ctx2, /another command held/, ctx2);
});

test('0.6.0 context watch: a call with no new request since the ask (a parallel sibling) doesn\'t start over, and a window that grows does', () => {
  // A real-size ask, then a sibling call: the transcript has no request newer
  // than the ask, which is not a transcript that couldn't be read back.
  const c = contextWatchSetup({ model: 'claude-haiku-4-5' }); // compaction near 167k, first step near 142k
  c.usage(145000);
  assert.ok(c.run(), 'asks at 145k');
  assert.strictEqual(c.run(), null, 'a sibling call: silent');
  // An ask from the estimate, carried on at the first step, then a sibling.
  const edit = { tool_name: 'Edit', tool_response: { filePath: 'x', originalFile: 'y'.repeat(400000) } };
  const d = contextWatchSetup({ model: 'claude-haiku-4-5' });
  d.usage(124000);
  assert.ok(d.run(edit), 'an early ask');
  d.usage(143000);
  assert.strictEqual(d.run(), null, '143k, no write: carried on');
  assert.strictEqual(d.run(), null, 'a sibling call: silent');
  // Three asks under a 200k window with no write, then the window grows to
  // 400k (compaction near 367k, steps near 312k, 330k and 349k): the steps
  // of the new window ask again.
  const e = contextWatchSetup({ settings: { autoCompactWindow: 200000 } });
  for (const n of [145000, 152000, 160000]) { e.usage(n); assert.ok(e.run(), `asks at ${n / 1000}k`); }
  fs.writeFileSync(path.join(e.s.cfg, 'settings.json'), JSON.stringify({ autoCompactWindow: 400000 }));
  e.usage(200000);
  assert.strictEqual(e.run(), null, '200k in the 400k window: under its first step');
  e.usage(315000);
  assert.match(askText(e.run()), /about 315k tokens.*about 367k/);
});

test('0.6.0 context watch: a window that flips between two sizes starts the steps over once, not on every call', () => {
  // claude-sonnet-4-5 is 200k by its name; a request over that proves the
  // 250k window the setting allows (compaction near 167k and near 217k).
  const c = contextWatchSetup({ model: 'claude-sonnet-4-5', settings: { autoCompactWindow: 250000 } });
  for (const n of [145000, 152000, 160000]) { c.usage(n); assert.ok(c.run(), `asks at ${n / 1000}k`); }
  assert.strictEqual(wh((a2, i) => jbm(c.s, a2, i), '# H\n## Next\n- x\n', [`--session=${SA}`]).status, 0);
  const asked = [];
  for (const n of [202000, 198000, 203000, 199000, 204000, 197000]) { c.usage(n); asked.push(askText(c.run()) ? `${n / 1000}k` : '-'); }
  // The bigger window asks once (at its 90% step), and the 200k window once
  // more as a repeat (no write since); flipping back and forth after that is
  // silent.
  assert.deepStrictEqual(asked, ['202k', '198k', '-', '-', '-', '-']);
});

test('context watch: a window that flips to one whose first step is not reached asks once (next version)', () => {
  // RS-H-flipwipe. A request over 200k proves the 300k window the setting
  // allows (compaction near 267k, first step near 227k): nothing to ask there.
  const c = contextWatchSetup({ model: 'claude-sonnet-4-5', settings: { autoCompactWindow: 300000 } });
  const asked = [];
  for (const n of [198000, 201000, 199000, 202000, 198000]) { c.usage(n); asked.push(askText(c.run()) ? `${n / 1000}k` : '-'); }
  assert.deepStrictEqual(asked, ['198k', '-', '-', '-', '-']);
  // The bigger window's own first step still asks, as a first request.
  c.usage(230000);
  const d = c.run();
  assert.match(askText(d), /about 230k tokens.*about 267k/);
  assert.doesNotMatch(askText(d), /has not written/);
});

test('0.6.0 context watch: a prompt after /compact, before the next request, doesn\'t ask with the size from before the compaction', () => {
  const c = contextWatchSetup(); // 400k window: compaction near 367k
  c.usage(315000);
  // A subagent's compaction is a sidechain entry: the main thread's size stands.
  c.add({ type: 'system', subtype: 'compact_boundary', isSidechain: true, compactMetadata: { trigger: 'auto', preTokens: 180000 } });
  assert.ok(c.run(), 'asks at 315k');
  assert.strictEqual(wh((a2, i) => jbm(c.s, a2, i), '# H\n## Next\n- x\n', [`--session=${SA}`]).status, 0);
  // /compact writes the boundary and the summary; the next request comes
  // after the next prompt.
  c.add({ type: 'system', subtype: 'compact_boundary', isSidechain: false, compactMetadata: { trigger: 'manual', preTokens: 316000 } });
  c.add({ type: 'user', isSidechain: false, sessionId: SA, cwd: c.s.repo, isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } });
  assert.strictEqual(c.run({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }), null, 'the last request is from before the compaction: silent');
  assert.strictEqual(c.run(), null, 'a tool call before the next request: silent too');
  c.usage(40000);
  assert.strictEqual(c.run(), null, 'the first request after the compaction is small');
  c.usage(316000);
  const d = c.run();
  assert.ok(d, 'crossing the first step again asks');
  assert.match(askText(d), /about 316k tokens/);
  assert.doesNotMatch(askText(d), /has not written/, 'the steps started over at the compaction');
});

test('0.6.0 commit folders: a folder already swept keeps its sweep start when another commit command runs there, so a script\'s commit in between is found', sweepTest(() => {
  const { s, clone, gClone, head, hook } = multiFolder();
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'startup', hook_event_name: 'SessionStart' }));
  const write = () => settle(() => {
    const r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], '# H\n- by A\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  });
  const commitHere = (msg) => hook(s.repo, SA, `git -C "${clone}" commit -q --allow-empty -m "${msg}"`, { between: () => gClone('commit', '-q', '--allow-empty', '-m', msg), duration_ms: 500 });
  // A commit command joins the clone, and a checkpoint sweeps it past that command.
  assert.strictEqual(commitHere('one').status, 0);
  tick();
  write();
  tick();
  // A script commits there with no hook; then a commit command runs there again.
  gClone('commit', '-q', '--allow-empty', '-m', 'by a script');
  const sha = head(clone);
  // Past the slack the hook's window reaches back before a command starts
  // (about 2 s, gitfacts.windowStart), so the hook doesn't take it as its own.
  for (let i = 0; i < 4; i++) tick();
  assert.strictEqual(commitHere('two').status, 0);
  assert.ok(!commitLines(s).some(l => l.includes(`COMMIT ${sha} `)), `the hook logged the script's commit: ${notesOf(s)}`);
  tick();
  write();
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${sha} in="${dp(clone)}" by a script (found later) session=11111111`)), notesOf(s));
}));

// RS:647: a session whose session-start record was missing (its hook was
// stopped, or the lock was busy) got no commit sweep, and nothing said so.
test('commit folders: a session whose session-start record is missing is still swept, from when its record was made (next version)', sweepTest(() => {
  const { s, clone, gClone, head, hook } = multiFolder();
  const write = () => settle(() => {
    const r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], '# H\n- by A\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  });
  // No session-start hook: a commit command makes the session's record.
  assert.strictEqual(hook(s.repo, SA, `git -C "${clone}" commit -q --allow-empty -m "one"`, { between: () => gClone('commit', '-q', '--allow-empty', '-m', 'one'), duration_ms: 500 }).status, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8')).sessions[SA];
  assert.ok(rec && !rec.start, JSON.stringify(rec));
  // Past the slack the hook's window reaches back (about 2 s), a script
  // commits in the clone and in the session's own folder, with no hook.
  for (let i = 0; i < 4; i++) tick();
  gClone('commit', '-q', '--allow-empty', '-m', 'by a script there');
  const there = head(clone);
  s.g('commit', '-q', '--allow-empty', '-m', 'by a script here');
  const here = head(s.repo);
  tick();
  assert.doesNotMatch(write().out, /start isn't recorded/);
  const lines = commitLines(s);
  assert.ok(lines.some(l => l.endsWith(`COMMIT ${there} in="${dp(clone)}" by a script there (found later) session=11111111`)), notesOf(s));
  assert.ok(lines.some(l => l.includes(`COMMIT ${here} `) && l.endsWith('by a script here (found later) session=11111111')), notesOf(s));
  assert.ok(Number.isFinite(rec.first), JSON.stringify(rec));
}));

test('commit folders: a session record with no start at all says the sweep was skipped, and the next sweep has one (next version)', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const s = sandbox();
  jbm(s, ['init']);
  // A record from before rec.first, made by some hook, with no start.
  S.updateState(s.memdir, SA, (state, rec) => { delete rec.first; delete rec.start; });
  const write = () => {
    const r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], '# H\n- x\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  assert.match(write(), /^\[trailmark\] commit sweep skipped: this session's start isn't recorded, so commits no hook logged before now can't be looked for\. Later sweeps start from this checkpoint\.$/m);
  const rec = JSON.parse(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8')).sessions[SA];
  assert.ok(Number.isFinite(rec.first), JSON.stringify(rec));
  assert.doesNotMatch(write(), /start isn't recorded/);
  // A record with no start and a huge commitDirsAt (the state file is
  // untrusted) still starts the session and saves the checkpoint (review
  // round 1, S1: a spread of it threw).
  const big = {};
  for (let i = 0; i < 200000; i++) big[`k${i}`] = [1];
  S.updateState(s.memdir, SA, (state, rec) => { delete rec.first; delete rec.start; rec.commitDirsAt = big; });
  const st = jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, session_id: SA, source: 'resume', hook_event_name: 'SessionStart' }));
  assert.strictEqual(st.status, 0, st.stderr.slice(0, 500));
  S.updateState(s.memdir, SA, (state, rec) => { delete rec.first; delete rec.start; rec.commitDirsAt = big; });
  const r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], '# H\n- y\n');
  assert.strictEqual(r.status, 0, r.stderr.slice(0, 500));
});

// RS:646 (review round 8, R1): a swept folder dropped past six and joined
// again got the new command's start, so a commit made there in between was
// never found.
test('commit folders: a folder dropped past six and joined again keeps where its last sweep stopped (next version)', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const D = (n) => path.resolve(os.tmpdir(), `jbmem-r8probe-f${n}`);
  const rec = {};
  S.addCommitDirs(rec, [D(1)], 1000, 1500);
  rec.swept = { [D(1)]: 2000 }; // a sweep read f1 past settled
  for (let i = 2; i <= 7; i++) S.addCommitDirs(rec, [D(i)], 3000 + i * 100, 3500 + i * 100);
  assert.ok(!rec.commitDirs.includes(D(1)), 'f1 was dropped');
  S.addCommitDirs(rec, [D(1)], 9000, 9500);
  assert.deepStrictEqual(rec.commitDirsAt[D(1)], [2000, 9500]);
  // A folder never swept starts at its command's window, as before.
  S.addCommitDirs(rec, [D(8)], 9100, 9600);
  assert.deepStrictEqual(rec.commitDirsAt[D(8)], [9100, 9600]);
  // A sweep that stopped later than the window doesn't move it.
  rec.swept[D(9)] = 9900;
  S.addCommitDirs(rec, [D(9)], 9200, 9700);
  assert.deepStrictEqual(rec.commitDirsAt[D(9)], [9200, 9700]);
});

// ---------- 0.6.0: what a hook's script is handed ----------

// Records, in the launcher, what it hands each hook script: stdin (input),
// JBMEM_PAYLOAD and JBMEM_GIT. On macOS, spawnSync sometimes deadlocks while
// it writes a big input to the child's stdin, and the launcher then stops the
// hook after 9 s (seen in CI 2026-11-06). The launcher drops NODE_* for its
// child, so only the launcher is spied on.
function hookInputSpy(s) {
  const log = path.join(s.base, 'hook-inputs.jsonl');
  const spy = path.join(s.base, 'hook-input-spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs'),path=require('path');const o=cp.spawnSync;cp.spawnSync=function(f,a,opt){const s=(a||[]).find(x=>/hook-[a-z-]+\\.js$/.test(String(x)));if(s){const e=(opt&&opt.env)||{};fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({script:path.basename(String(s)),input:opt&&opt.input!==undefined?String(opt.input):null,payload:typeof e.JBMEM_PAYLOAD==='string'?e.JBMEM_PAYLOAD:null,git:typeof e.JBMEM_GIT==='string'?e.JBMEM_GIT:null})+'\\n')}return o.apply(this,arguments)}`);
  return {
    env: { NODE_OPTIONS: `--require ${spy}` },
    inputs: script => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []).filter(i => i.script === script),
  };
}
// Nothing on stdin, and a payload of under `max` characters in JBMEM_PAYLOAD.
function assertHanded(i, max = 2000) {
  assert.strictEqual(i.input, null, `${i.script} got ${i.input === null ? 0 : i.input.length} characters on stdin`);
  assert.ok(typeof i.payload === 'string' && i.payload.length < max, `${i.script} got ${i.payload === null ? 'no' : i.payload.length + ' characters of'} payload`);
  return JSON.parse(i.payload);
}

test('0.6.0 context watch: the hook gets nothing on stdin and only the payload fields it reads, and the estimates for a 670k image and a 400k Edit are as before', () => {
  const c = contextWatchSetup({ model: 'claude-haiku-4-5' }); // compaction near 167k, the fast path's line 120k, the first step near 142k
  const spy = hookInputSpy(c.s);
  // The image Read of the test above (670k characters of base64), at 120k.
  c.usage(120000);
  const image = { type: 'image', file: { base64: 'QUJD'.repeat(167500), type: 'image/png', originalSize: 500000 } };
  assert.strictEqual(c.run({ tool_name: 'Read', tool_response: image }, spy.env), null, 'an image Read at 120k: silent');
  // A 400k Edit at 124k: 25k more, the most one call adds.
  c.usage(124000);
  const edit = { tool_name: 'Edit', tool_response: { filePath: 'x', originalFile: 'y'.repeat(400000) } };
  assert.match(askText(c.run(edit, spy.env)), /about 149k tokens/);
  // A 200k-character prompt: 50k more.
  c.usage(124000);
  c.run({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(200000) }, spy.env);
  const got = spy.inputs('hook-context-watch.js');
  assert.strictEqual(got.length, 3, 'three hook runs');
  // The launcher works the estimate out from the whole payload before the
  // hook starts, and hands it over in JBMEM_GIT: one image is 4,784 tokens,
  // and its other fields' text 13 more. The same on 03da9fd.
  assert.deepStrictEqual(got.map(i => JSON.parse(i.git).context.tokens), [124797, 149000, 174000]);
  const p = got.map(i => assertHanded(i));
  assert.deepStrictEqual({ session_id: p[1].session_id, hook_event_name: p[1].hook_event_name, cwd: p[1].cwd, transcript_path: p[1].transcript_path, tool_name: p[1].tool_name },
    { session_id: SA, hook_event_name: 'PostToolUse', cwd: c.s.repo, transcript_path: c.transcript, tool_name: 'Edit' });
  assert.deepStrictEqual(p[0].tool_response, {});
  assert.deepStrictEqual(p[1].tool_response, {});
  assert.strictEqual(p[2].hook_event_name, 'UserPromptSubmit');
  assert.ok(!('prompt' in p[2]), Object.keys(p[2]).join(' '));
});

test('0.6.0 hooks: a commit hook gets nothing on stdin and not the command\'s 400k output, and a long command still reaches it', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const spy = hookInputSpy(s);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  s.g('commit', '--allow-empty', '-qm', 'big output');
  const m = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SA, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_big1', tool_input: { command: 'git commit --allow-empty -m "big output"', description: 'd'.repeat(50000) }, tool_response: { stdout: 'y'.repeat(400000), stderr: '', interrupted: false } }), spy.env);
  assert.strictEqual(m.status, 0, m.stderr);
  assert.match(JSON.parse(m.stdout).hookSpecificOutput.additionalContext, /Commit landed/);
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ big output/);
  let got = spy.inputs('hook-milestone.js');
  assert.strictEqual(got.length, 1, 'one hook run');
  let p = assertHanded(got[0]);
  assert.deepStrictEqual(p.tool_input, { command: 'git commit --allow-empty -m "big output"' });
  assert.deepStrictEqual(p.tool_response, { interrupted: false });
  assert.strictEqual(p.tool_use_id, 'toolu_big1');
  // The exit fields still reach the hook: an interrupted command gets no
  // reminder and logs no commit.
  s.g('commit', '--allow-empty', '-qm', 'cut short');
  let before = notesOf(s);
  const q = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SA, hook_event_name: 'PostToolUse', tool_input: { command: 'git commit --allow-empty -m "cut short"' }, tool_response: { stdout: 'y'.repeat(400000), interrupted: true } }), spy.env);
  assert.strictEqual(q.status, 0, q.stderr);
  assert.strictEqual(q.stdout, '');
  assert.strictEqual(notesOf(s), before);
  // A 20,000-character command (a long message in a heredoc) reaches the
  // hook whole, still not on stdin, and its commit is logged.
  s.g('commit', '--allow-empty', '-qm', 'long command');
  const long = `git commit --allow-empty -F - <<'EOF'\nlong command\n\n${'m'.repeat(20000)}\nEOF`;
  const l = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SA, hook_event_name: 'PostToolUse', tool_input: { command: long }, tool_response: { stdout: '' } }), spy.env);
  assert.strictEqual(l.status, 0, l.stderr);
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ long command/);
  got = spy.inputs('hook-milestone.js');
  assert.strictEqual(got.length, 3, 'three hook runs');
  p = assertHanded(got[2], 30001);
  assert.strictEqual(p.tool_input.command, long);
  // Past 30,000 characters (PAYLOAD_MAX in hookio.js) the hook
  // script isn't started, and the launcher says why.
  before = notesOf(s);
  const huge = `git commit --allow-empty -F - <<'EOF'\nhuge\n\n${'m'.repeat(40000)}\nEOF`;
  const h = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SA, hook_event_name: 'PostToolUse', tool_input: { command: huge }, tool_response: {} }), spy.env);
  assert.strictEqual(h.status, 0, h.stderr);
  assert.match(h.stderr, /hook-milestone\.js was not run: what it would be handed is over 30,000 characters/);
  assert.strictEqual(h.stdout, '');
  assert.strictEqual(spy.inputs('hook-milestone.js').length, 3, 'no fourth hook run');
  assert.strictEqual(notesOf(s), before);
});

test('0.6.0 write-handoff and park: a 124k text reaches the script whole, and the launcher writes none of it to the script\'s stdin', () => {
  const s = sandbox();
  jbm(s, ['init']);
  // A preload in the launcher logs how each write-handoff or park run of
  // memory.js gets its text: written by the launcher (input), or the
  // launcher's own stdin (inherit), or a checked --from file it opens itself
  // (from, with nothing on stdin).
  const log = path.join(s.base, 'memory-inputs.jsonl');
  const spy = path.join(s.base, 'memory-input-spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs');const o=cp.spawnSync;cp.spawnSync=function(f,a,opt){const c=(a||[]).find(x=>x==='write-handoff'||x==='park');if(c&&(a||[]).some(x=>/memory\\.js$/.test(String(x)))){const st=opt&&Array.isArray(opt.stdio)?opt.stdio[0]:null;fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cmd:c,input:opt&&opt.input!=null?String(opt.input).length:null,stdin:typeof st==='number'?'fd':st,from:!!(opt&&opt.env&&opt.env.JBMEM_FROM)})+'\\n')}return o.apply(this,arguments)}`);
  const env = { NODE_OPTIONS: `--require ${spy}` };
  // 2,000 lines, about 124k characters: past the 64 KB a pipe holds, and
  // past the sizes that stalled on macOS.
  const big = end => `# H\n## Next\n${Array.from({ length: 2000 }, (_, i) => `- item ${i} ${'x'.repeat(50)}`).join('\n')}\n- ${end}\n`;
  const handoff = () => fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  const parked = slug => fs.readFileSync(path.join(s.memdir, 'parked', `${slug}.md`), 'utf8');
  // On stdin. A handoff that big is over its budget: saved, exit 2.
  let r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`], big('the first handoff'), env);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(handoff().includes('- item 1999 ') && handoff().includes('- the first handoff'), 'the whole handoff was saved');
  r = jbm(s, ['park', '--slug=big-stdin'], big('the first idea'), env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(parked('big-stdin').includes('- the first idea'), 'the whole idea was parked');
  // From a drop file in the memory folder (--from).
  const pdrop = path.join(s.memdir, 'incoming-park.md');
  fs.writeFileSync(pdrop, big('the second idea'));
  r = jbm(s, ['park', '--slug=big-file', `--from=${pdrop}`], undefined, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(parked('big-file').includes('- the second idea'));
  assert.ok(!fs.existsSync(pdrop), 'the drop file is removed once saved');
  const hdrop = path.join(s.memdir, 'incoming-handoff.md');
  fs.writeFileSync(hdrop, big('the second handoff'));
  r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--from=${hdrop}`], undefined, env);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(handoff().includes('- the second handoff'));
  assert.ok(fs.existsSync(hdrop), 'over budget, the drop file stays');
  // --from naming handoff.md itself: the script replaces the very file it
  // reads, which Windows refuses while a handle to it is open (CI, a778ace).
  const own = path.join(s.memdir, 'handoff.md');
  fs.writeFileSync(own, big('the third handoff'));
  r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--from=${own}`], undefined, env);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(handoff().includes('- the third handoff'));
  const got = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepStrictEqual(got.map(g => g.cmd), ['write-handoff', 'park', 'park', 'write-handoff', 'write-handoff']);
  for (const g of got) assert.strictEqual(g.input, null, `${g.cmd} got ${g.input} characters written to its stdin by the launcher`);
  assert.deepStrictEqual(got.map(g => g.stdin), ['inherit', 'inherit', 'ignore', 'ignore', 'ignore']);
  assert.deepStrictEqual(got.map(g => g.from), [false, false, true, true, true]);
  // The script reads a --from file only if it is still the one the launcher
  // checked: another file ID, or a second hard link since, is refused.
  const direct = (file, id) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'memory.js'), 'park', '--slug=swapped'], { cwd: s.repo, env: { ...s.env, JBMEM_DIR: s.memdir, JBMEM_LAUNCHED: '1', JBMEM_FROM: file, JBMEM_FROM_ID: id }, encoding: 'utf8' });
  const idea = path.join(s.memdir, 'incoming-park.md');
  fs.writeFileSync(idea, '# Idea\nwhy\n');
  const st = fs.statSync(idea, { bigint: true });
  r = direct(idea, `${st.dev}:${st.ino + 1n}`);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /changed after the launcher checked it; nothing was written/);
  fs.linkSync(idea, path.join(s.base, 'second-link.md'));
  r = direct(idea, `${st.dev}:${st.ino}`);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /changed after the launcher checked it/);
  assert.ok(!fs.existsSync(path.join(s.memdir, 'parked', 'swapped.md')));
  fs.unlinkSync(path.join(s.base, 'second-link.md'));
  r = direct(idea, `${st.dev}:${st.ino}`);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(parked('swapped'), /why/);
});

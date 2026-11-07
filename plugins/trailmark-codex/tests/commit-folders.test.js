// Run: node --test tests/commit-folders.test.js
// 0.6.0: the session's commit folders, and what a hook's script is handed.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { dp, ROOT, sandbox, versionNow, J, JBM, jbm, SA, notesOf, cp,
  ageReflogs, multiFolder, commitLines, tick, settle, sweepTest,
  GIT_TIMEOUT_STUB } = require('./helpers.js');
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

test('0.6.0 hooks: a commit hook gets nothing on stdin and not the command\'s 400k output, and a long command still reaches it', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const spy = hookInputSpy(s);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  const post = payload => jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify({ cwd: s.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SA, ...payload }), { JBMEM_CODEX_SHELL: 'bash', ...spy.env });
  s.g('commit', '--allow-empty', '-qm', 'big output');
  let r = post({ tool_use_id: 'b1', tool_input: { command: 'git commit --allow-empty -m "big output"' }, tool_response: `Exit code: 0\nOutput:\n${'y'.repeat(400000)}` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Commit landed/);
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ big output/);
  let got = spy.inputs('hook-milestone.js');
  assert.strictEqual(got.length, 1, 'one hook run');
  let p = assertHanded(got[0]);
  assert.deepStrictEqual(p.tool_input, { command: 'git commit --allow-empty -m "big output"' });
  assert.ok(!('tool_response' in p), 'printed text is not an object, so nothing of it is kept');
  // A failed command after its commit: the launcher makes it a
  // PostToolUseFailure, whose 400k error text isn't handed over either.
  s.g('commit', '--allow-empty', '-qm', 'then failed');
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: s.repo, encoding: 'utf8' }).trim();
  r = post({ tool_use_id: 'b2', tool_input: { command: 'git commit --allow-empty -m "then failed" && false' }, tool_response: `Exit code: 1\nOutput:\n[master ${sha}] then failed\n${'z'.repeat(400000)}` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'no reminder after a failed command');
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ then failed/);
  got = spy.inputs('hook-milestone.js');
  assert.strictEqual(got.length, 2, 'two hook runs');
  p = assertHanded(got[1]);
  assert.strictEqual(p.hook_event_name, 'PostToolUseFailure');
  assert.ok(!('error' in p) && !('tool_response' in p), Object.keys(p).join(' '));
  // Past 30,000 characters (Windows caps a variable at 32,767) the hook
  // script isn't started, and the launcher says why.
  const before = notesOf(s);
  r = post({ tool_use_id: 'b3', tool_input: { command: `git commit --allow-empty -m "${'m'.repeat(40000)}"` }, tool_response: 'Exit code: 0\nOutput:\n' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /hook-milestone\.js was not run: what it would be handed is over 30,000 characters/);
  assert.strictEqual(spy.inputs('hook-milestone.js').length, 2, 'no third hook run');
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

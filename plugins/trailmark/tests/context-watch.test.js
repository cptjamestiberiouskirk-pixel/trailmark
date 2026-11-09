// Run: node --test tests/context-watch.test.js
// 0.6.0: the context watch. More of its tests are in commit-folders.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { realTemp, sandbox, wh, jbm, SA, cp, contextWatchSetup, askText } = require('./helpers.js');

// ---------- 0.6.0: the context watch ----------

test('0.6.0 context watch: asks at the first step of the compaction point, again at the next only without a checkpoint, and starts over after a compaction', () => {
  const c = contextWatchSetup(); // 400k window: compaction near 367k; steps 312k, 330k, 349k
  c.usage(300000);
  assert.strictEqual(c.run(), null, 'below the first step: silent');
  c.usage(315000);
  const a = c.run();
  assert.ok(a, 'crossing the first step asks');
  assert.match(askText(a), /about 315k tokens.*about 367k/);
  assert.match(askText(a), /trailmark:checkpoint/);
  assert.match(askText(a), /start no long operation/);
  assert.doesNotMatch(askText(a), /has not written/);
  assert.match(a.systemMessage, /^\[trailmark\] Context about 315k tokens, auto-compaction near 367k/);
  assert.strictEqual(a.hookSpecificOutput.hookEventName, 'PostToolUse');
  const r1 = c.rec();
  assert.strictEqual(r1.contextWatch.level, 1);
  assert.ok(r1.lastHintAt >= r1.contextWatch.firstAt, 'the request counts as a hint');
  c.usage(320000);
  assert.strictEqual(c.run(), null, 'the same step again: silent');
  c.usage(335000);
  const b = c.run();
  assert.match(askText(b), /has not written the handoff since the first request/, 'the next step asks again and says why');
  assert.strictEqual(c.rec().contextWatch.firstAt, r1.contextWatch.firstAt, 'the first request time is kept');
  assert.strictEqual(wh((a2, i) => jbm(c.s, a2, i), '# H\n## Next\n- x\n', [`--session=${SA}`]).status, 0);
  c.usage(350000);
  assert.strictEqual(c.run(), null, 'past the last step after this session checkpointed: silent');
  assert.strictEqual(c.rec().contextWatch.done, true);
  c.usage(355000);
  assert.strictEqual(c.run(), null, 'still high after the checkpoint: silent');
  c.boundary();
  c.usage(60000);
  assert.strictEqual(c.run(), null, 'after the compaction: silent');
  c.usage(316000);
  const d = c.run();
  assert.ok(d, 'crossing the first step after a compaction asks again');
  assert.doesNotMatch(askText(d), /has not written/);
});

test('0.6.0 context watch: a prompt counts too, and its text is added at about four characters a token', () => {
  const c = contextWatchSetup();
  c.usage(305000);
  assert.strictEqual(c.run({ hook_event_name: 'UserPromptSubmit', prompt: 'short' }), null);
  const a = c.run({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(40000) }); // about 10k tokens more
  assert.ok(a, 'the prompt lifts it past the first step');
  assert.strictEqual(a.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('0.6.0 context watch: a shrink by a fifth without a compaction entry starts over; a dip between 75% and the first step does not', () => {
  const c = contextWatchSetup();
  c.usage(315000);
  assert.ok(c.run());
  c.usage(290000); // about 79% of 367k: kept
  c.usage(316000);
  assert.strictEqual(c.run(), null, 'a dip that stays above 75% keeps the request');
  c.usage(240000); // a fifth below the last size seen
  c.usage(316000);
  assert.ok(c.run(), 'after a shrink the first step asks again');
});

test('0.6.0 context watch: silent in a subagent, for other events, in a repo not set up, when turned off, and with no usable entry', () => {
  const c = contextWatchSetup();
  c.usage(340000);
  assert.strictEqual(c.run({ agent_id: 'a1', agent_type: 'Explore' }), null, 'subagent');
  assert.strictEqual(c.run({ hook_event_name: 'Stop' }), null, 'another event');
  const cfgFile = path.join(c.s.memdir, '.jbmem.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, contextWatch: { on: false } }));
  assert.strictEqual(c.run(), null, 'turned off in .jbmem.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  assert.ok(c.run(), 'on again');
  const n = contextWatchSetup({ init: false });
  n.usage(340000);
  assert.strictEqual(n.run(), null, 'repo not set up');
  const e = contextWatchSetup();
  e.usage(340000, '<synthetic>');
  e.usage(340000, 'claude-opus-5-5', { isSidechain: true });
  assert.strictEqual(e.run(), null, 'only synthetic and sidechain entries');
});

test('0.6.0 context watch: the window comes from the variable, then a model\'s own settings entry (dated IDs match), then the top-level value; "auto" means the model\'s own window', () => {
  // A dated model ID finds its modelSettings entry: 250k, so compaction near 217k.
  const d = contextWatchSetup({ model: 'claude-opus-5-5-20261001', settings: { autoCompactWindow: 400000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 250000 } } } });
  d.usage(190000);
  assert.match(askText(d.run()), /about 217k/);
  // "auto" for a 200k model: its own window (compaction near 167k), not the top-level 150k.
  const a = contextWatchSetup({ model: 'claude-sonnet-4-6', settings: { autoCompactWindow: 150000, modelSettings: { 'claude-sonnet-4-6': { autoCompactWindow: 'auto' } } } });
  a.usage(110000);
  assert.strictEqual(a.run(), null, 'with 150k this would ask; with auto it is 66% of 167k');
  a.usage(145000);
  assert.match(askText(a.run()), /about 167k/);
  // The variable wins over the settings, and takes "200k".
  const v = contextWatchSetup();
  v.usage(150000);
  assert.match(askText(v.run({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200k' })), /about 167k/);
  // The percentage override can only bring the point earlier: 50% of 400k.
  const p = contextWatchSetup();
  p.usage(175000);
  assert.match(askText(p.run({}, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' })), /about 200k/);
  // A 200k model is capped at its own window whatever the settings say.
  const cap = contextWatchSetup({ model: 'claude-sonnet-4-6', window: 400000 });
  cap.usage(150000);
  assert.match(askText(cap.run()), /about 167k/);
});

test('0.6.0 context watch: every step comes before the compaction point, at a 400k and a 200k window', () => {
  const { decide } = require('../scripts/hook-context-watch.js');
  const S = require('../scripts/lib/store.js');
  const cfg = S.loadConfig(realTemp('jbmem-cw-')).contextWatch;
  for (const [win, compactsAt] of [[400000, 367000], [200000, 167000]]) {
    const seen = [];
    let w = {};
    for (let t = 100000; t < compactsAt; t += 1000) {
      const d = decide(w, {}, { tokens: t, base: t, win, pct: 0, since: { min: t, boundary: false, reached: true } }, cfg, 1000);
      if (d.ask) seen.push(t);
      w = d.w;
    }
    assert.strictEqual(seen.length, 3, `${win}: all three steps before ${compactsAt}: ${seen}`);
  }
  // Configured steps are clamped to 80..99 and the reserve to 20k..50k.
  const dir = realTemp('jbmem-cw-');
  fs.writeFileSync(path.join(dir, '.jbmem.json'), JSON.stringify({ contextWatch: { steps: [10, 99, 99, 'x'], reserve: 5 } }));
  assert.deepStrictEqual(S.loadConfig(dir).contextWatch, { on: true, steps: [80, 99], reserve: 20000 });
});

test('0.6.0 context watch: below the first step the launcher starts no git and looks up no memory folder', () => {
  const c = contextWatchSetup();
  c.usage(250000);
  const log = path.join(c.s.base, 'spawned.txt');
  const spy = path.join(c.s.base, 'spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs');for(const k of ['spawnSync','execFileSync','execSync','spawn','execFile','exec']){const o=cp[k];cp[k]=function(...a){fs.appendFileSync(${JSON.stringify(log)},k+' '+a[0]+'\\n');return o.apply(this,a)}}`);
  assert.strictEqual(c.run({}, { NODE_OPTIONS: `--require ${spy}` }), null);
  assert.ok(!fs.existsSync(log), 'no child process: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
  c.usage(320000);
  assert.ok(c.run({}, { NODE_OPTIONS: `--require ${spy}` }), 'above it, it asks');
  assert.ok(fs.existsSync(log), 'and then git and the sandboxed script run');
});

test('0.6.0 context watch: a worktree session\'s transcript, outside the memory folder, is read by the launcher with the sandbox on', () => {
  const s = sandbox();
  const wt = path.join(s.repo, '.claude', 'worktrees', 'cw');
  s.g('worktree', 'add', '-q', '-b', 'cw', wt);
  const c = contextWatchSetup({ s });
  // The worktree session's transcript sits in the worktree's own project folder.
  const wtProject = path.join(s.cfg, 'projects', wt.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(wtProject, { recursive: true });
  const tp = path.join(wtProject, `${SA}.jsonl`);
  c.usage(320000);
  fs.copyFileSync(c.transcript, tp);
  const r = c.call({ transcript_path: tp }, { JBMEM_SHOW_GRANTS: '1' }, wt);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /trailmark grants: read=[^\n]*write=/);
  assert.ok(!r.stderr.includes(wtProject), 'the sandbox gets no grant on the transcript\'s folder');
  assert.match(askText(JSON.parse(r.stdout)), /about 320k/);
  assert.strictEqual(c.rec().contextWatch.level, 1, 'the state is in the main checkout\'s memory folder');
});

test('0.6.0 context watch: a transcript_path outside the projects folder, or deeper in it, is refused', () => {
  const c = contextWatchSetup();
  c.usage(340000);
  const outside = path.join(c.s.base, 'elsewhere', `${SA}.jsonl`);
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.copyFileSync(c.transcript, outside);
  assert.strictEqual(c.run({ transcript_path: outside }), null, 'outside the projects folder');
  const deeper = path.join(c.s.projectDir, 'sub', `${SA}.jsonl`);
  fs.mkdirSync(path.dirname(deeper), { recursive: true });
  fs.copyFileSync(c.transcript, deeper);
  assert.strictEqual(c.run({ transcript_path: deeper }), null, 'not directly in a project folder');
  assert.strictEqual(c.run({ transcript_path: c.transcript.replace(/\.jsonl$/, '.txt') }), null, 'not a .jsonl');
  assert.ok(c.run(), 'the real one asks');
});

// RS-H-samesince: two hooks whose launchers read the same seenAt carry the same
// `since`. Where it said to start over (a transcript not read that far, a
// compaction, a shrink), each one did, and the same request went out twice.
test('context watch: a hook whose launcher read an older seenAt than the saved one does not start over (next version)', () => {
  const { decide } = require(path.join(__dirname, '..', 'scripts', 'hook-context-watch.js'));
  const cfg = { on: true, steps: [85, 90, 95], reserve: 33000 };
  const before = { level: 1, firstAt: 900, seen: 320000, seenAt: 900, point: 367000 };
  for (const since of [{ reached: false }, { min: 320000, boundary: true, reached: true }, { min: 1000, boundary: false, reached: true }]) {
    const c = { tokens: 320000, base: 320000, win: 400000, pct: 0, since, seenAt: 900 };
    const a = decide(before, {}, c, cfg, 1000);
    assert.deepStrictEqual(a.ask, { repeat: false, level: 1 }, 'the first hook starts over and asks');
    const b = decide(a.w, {}, c, cfg, 1001);
    assert.strictEqual(b.ask, null, JSON.stringify(since));
    assert.deepStrictEqual(b.w, a.w);
    // A later step is a repeat request as usual.
    assert.deepStrictEqual(decide(a.w, {}, { ...c, tokens: 335000 }, cfg, 1002).ask, { repeat: true, level: 2 });
    // With no seenAt from the launcher, nothing is known: as before.
    assert.deepStrictEqual(decide(a.w, {}, { ...c, seenAt: 0 }, cfg, 1002).ask, { repeat: false, level: 1 });
  }
});

test('context watch: a bigger compaction point starts the steps over even when a sibling hook saved first (next version)', () => {
  const { decide } = require(path.join(__dirname, '..', 'scripts', 'hook-context-watch.js'));
  const cfg = { on: true, steps: [85, 90, 95], reserve: 33000 };
  const before = { level: 1, firstAt: 900, seen: 142000, seenAt: 900, point: 167000 };
  const since = { min: 142000, boundary: false, reached: true };
  // Both launchers read seenAt 900. The 200k hook saves first, at the top step.
  const small = decide(before, {}, { tokens: 160000, base: 160000, win: 200000, pct: 0, since, seenAt: 900 }, cfg, 1000);
  assert.deepStrictEqual(small.ask, { repeat: true, level: 3 });
  // The steps it passed were the smaller point's, with or without a `since`.
  const big = { tokens: 320000, base: 320000, win: 400000, pct: 0, since, seenAt: 900 };
  for (const c of [big, { ...big, since: null, seenAt: 0 }]) {
    const a = decide(small.w, {}, c, cfg, 1001);
    assert.deepStrictEqual(a.ask, { repeat: false, level: 1 }, JSON.stringify(c.since));
    assert.strictEqual(a.w.point, 367000);
    // A sibling with the same facts doesn't ask a second time.
    assert.strictEqual(decide(a.w, {}, c, cfg, 1002).ask, null, JSON.stringify(c.since));
  }
  // A smaller point than the saved one keeps the state, as before.
  const saved = decide(small.w, {}, big, cfg, 1001).w;
  assert.strictEqual(decide(saved, {}, { tokens: 150000, base: 150000, win: 200000, pct: 0, since, seenAt: 900 }, cfg, 1002).ask, null);
});

test('context watch: a hook that ran late moves the saved seenAt forward, never back (next version)', () => {
  const { decide } = require(path.join(__dirname, '..', 'scripts', 'hook-context-watch.js'));
  const cfg = { on: true, steps: [85, 90, 95], reserve: 33000 };
  const since = { min: 320000, boundary: false, reached: true };
  const saved = { level: 1, firstAt: 900, seen: 320000, seenAt: 1001, point: 367000 };
  // This hook's launcher read 900 and its clock was read before the lock, at
  // 1000 or in the same millisecond as the saved state. It still raises the step.
  for (const now of [1000, 1001]) {
    const late = decide(saved, {}, { tokens: 335000, base: 335000, win: 400000, pct: 0, since, seenAt: 900 }, cfg, now);
    assert.deepStrictEqual(late.ask, { repeat: true, level: 2 });
    assert.ok(late.w.seenAt > 1001, String(late.w.seenAt));
    // A third hook, whose launcher read 1001, must see that a sibling saved after it.
    const third = decide(late.w, {}, { tokens: 320000, base: 320000, win: 400000, pct: 0, since: { reached: false }, seenAt: 1001 }, cfg, 1003);
    assert.strictEqual(third.ask, null, String(now));
  }
  // The same when the late hook starts the steps over for a bigger point.
  const grew = decide({ ...saved, point: 167000 }, {}, { tokens: 320000, base: 320000, win: 400000, pct: 0, since, seenAt: 900 }, cfg, 1000);
  assert.deepStrictEqual(grew.ask, { repeat: false, level: 1 });
  assert.ok(grew.w.seenAt > 1001, String(grew.w.seenAt));
  // A hook that isn't behind a sibling saves its own clock, as before.
  const own = decide(saved, {}, { tokens: 335000, base: 335000, win: 400000, pct: 0, since, seenAt: 1001 }, cfg, 2000);
  assert.strictEqual(own.w.seenAt, 2000);
  // A late hook with a later clock than the saved state keeps its own too.
  assert.strictEqual(decide(saved, {}, { tokens: 335000, base: 335000, win: 400000, pct: 0, since, seenAt: 900 }, cfg, 2000).w.seenAt, 2000);
});

test('context watch: the launcher tells the hook which seenAt it read, and the hook checks it (next version)', () => {
  const { contextFacts } = require(path.join(__dirname, '..', 'scripts', 'hook-context-watch.js'));
  const facts = (seenAt) => JSON.stringify({ context: { tokens: 320000, base: 320000, win: 400000, pct: 0, since: { reached: false }, seenAt } });
  const saved = process.env.JBMEM_GIT;
  try {
    process.env.JBMEM_GIT = facts(900);
    assert.strictEqual(contextFacts().seenAt, 900);
    for (const bad of ['900', -1, 1e15, null]) {
      process.env.JBMEM_GIT = facts(bad);
      assert.strictEqual(contextFacts().seenAt, 0, String(bad));
    }
  } finally {
    if (saved === undefined) delete process.env.JBMEM_GIT; else process.env.JBMEM_GIT = saved;
  }
  const c = contextWatchSetup();
  c.usage(320000);
  assert.match(askText(c.run()), /about 320k/);
  const seenAt = c.rec().contextWatch.seenAt;
  assert.ok(seenAt > 0);
  const log = path.join(c.s.base, 'facts.jsonl');
  const spy = path.join(c.s.base, 'facts-spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs');const o=cp.spawnSync;cp.spawnSync=function(f,a,opt){if(opt&&opt.env&&opt.env.JBMEM_GIT)fs.appendFileSync(${JSON.stringify(log)},opt.env.JBMEM_GIT+'\\n');return o.apply(this,arguments)};`);
  c.usage(320100);
  c.run({}, { NODE_OPTIONS: `--require ${JSON.stringify(spy)}` });
  const got = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.strictEqual(got.context.seenAt, seenAt);
});

// RS:638: two context-watch hooks whose launchers both read the record before
// the first request was saved carry no `since`, and decide() took that as a
// reason to start over: the same first request went out twice.
test('context watch: a hook whose launcher read the record before the first request was saved does not ask again (next version)', () => {
  const { decide } = require(path.join(__dirname, '..', 'scripts', 'hook-context-watch.js'));
  const cfg = { on: true, steps: [85, 90, 95], reserve: 33000 };
  const c = { tokens: 320000, base: 320000, win: 400000, pct: 0, since: null };
  const a = decide({}, {}, c, cfg, 1000);
  assert.deepStrictEqual(a.ask, { repeat: false, level: 1 });
  const b = decide(a.w, {}, c, cfg, 1001);
  assert.strictEqual(b.ask, null, JSON.stringify(b.ask));
  assert.deepStrictEqual(b.w, a.w);
  // With a checkpoint in between, too.
  assert.strictEqual(decide(a.w, { lastWrite: 1000 + 500 }, c, cfg, 1600).ask, null);
  // A later step is a repeat request as usual.
  const later = decide(a.w, {}, { ...c, tokens: 335000 }, cfg, 1002);
  assert.deepStrictEqual(later.ask, { repeat: true, level: 2 });
  // A state with no seenAt says nothing about when it was saved: asking once
  // more stays the safe side.
  assert.deepStrictEqual(decide({ level: 1, firstAt: 1000, seen: 320000, point: 367000 }, {}, c, cfg, 1001).ask, { repeat: false, level: 1 });
});

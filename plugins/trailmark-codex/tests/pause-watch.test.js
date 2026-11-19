// Run: dev/release-check.sh --only 'pause watch'
// The Codex copy of the pause watch: a prompt that says the user is about to
// reboot, restart, shut down or close the chat asks the agent to checkpoint
// first. The matcher, lib/pausewords.js, is the Claude Code copy's file word
// for word (the shared-file list in tests.yml), and its own cases are in that
// copy's pause-watch.test.js. These cover what is this copy's own: the
// launcher's wiring, the hook script's note (no systemMessage, Codex's skill
// name and rule), the setting, the shape log and hooks.json.
// Each test loads the copy's files itself, so on a copy without the pause
// watch each one fails at its own step, not at the file's first line.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, JBM, jbm, jbmIn, wh, sandbox, SA } = require('./helpers.js');

const words = () => require(path.join(ROOT, 'scripts', 'lib', 'pausewords.js'));
const askText = o => o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext;
// A Codex thread ID is a UUIDv7 (the Codex trials, RS-D-codexshortid).
const CODEX_ID = '01a1e532-8d05-7c3e-9a4b-0123456789ab';

function setup({ init = true } = {}) {
  const s = sandbox();
  delete s.env.JBMEM_SANDBOX; delete s.env.PLUGIN_DATA; delete s.env.JBMEM_SHAPES;
  if (init) assert.strictEqual(jbm(s, ['init']).status, 0);
  // Codex keeps its transcripts under ~/.codex; this one is never read.
  const transcript = path.join(s.base, 'codex', 'sessions', 'rollout-x.jsonl');
  const call = (payload = {}, env = {}, cwd = s.repo) => jbmIn(s, cwd, ['--hook', 'pause-watch'], JSON.stringify({
    session_id: SA, transcript_path: transcript, cwd: s.repo, hook_event_name: 'UserPromptSubmit', model: 'gpt-x', permission_mode: 'default', turn_id: 't1', prompt: 'pause for reboot', ...payload,
  }), env);
  const run = (payload, env) => {
    const r = call(payload, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stderr, '');
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  return { s, transcript, call, run };
}

// Records, in the launcher, what it hands the hook script (as in the Claude
// Code copy's pause-watch.test.js): stdin, JBMEM_PAYLOAD and JBMEM_GIT.
function spyOn(s) {
  const log = path.join(s.base, 'hook-inputs.jsonl');
  const spy = path.join(s.base, 'hook-input-spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs'),path=require('path');const o=cp.spawnSync;cp.spawnSync=function(f,a,opt){const s=(a||[]).find(x=>/hook-[a-z-]+\\.js$/.test(String(x)));if(s){const e=(opt&&opt.env)||{};fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({script:path.basename(String(s)),input:opt&&opt.input!==undefined?String(opt.input):null,payload:typeof e.JBMEM_PAYLOAD==='string'?e.JBMEM_PAYLOAD:null,git:typeof e.JBMEM_GIT==='string'?e.JBMEM_GIT:null})+'\\n')}return o.apply(this,arguments)}`);
  return {
    env: { NODE_OPTIONS: `--require ${spy}` },
    inputs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []),
  };
}

test('pause watch (Codex): through the launcher, "pause for reboot" asks the agent for tm-checkpoint, with no systemMessage, and the prompt goes no further', () => {
  const c = setup();
  const spy = spyOn(c.s);
  const a = c.run({ prompt: 'OK, REBOOTING NOW' }, spy.env);
  assert.ok(a, 'asks');
  assert.strictEqual(a.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(askText(a), /^\[trailmark\] The user's prompt may say they are about to reboot, restart, shut down or close this chat \(it matched "reboot"\)\. /);
  assert.match(askText(a), /run the tm-checkpoint skill before this turn ends/);
  assert.match(askText(a), /ignore this note/);
  // Codex's skill rule: the skill's file and the launcher by their full paths.
  assert.ok(askText(a).includes(`Its instructions are in ${path.join(ROOT, 'skills', 'tm-checkpoint', 'SKILL.md')}`), askText(a));
  assert.ok(askText(a).includes(`run trailmark only through ${JBM}`), askText(a));
  // Codex shows a systemMessage as a warning: this copy sends none here.
  assert.deepStrictEqual(Object.keys(a), ['hookSpecificOutput']);
  // Nothing of the prompt is in the note.
  assert.doesNotMatch(JSON.stringify(a), /REBOOTING|NOW|OK,/);
  // The script got the word and the payload without the prompt.
  const got = spy.inputs();
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].script, 'hook-pause-watch.js');
  assert.strictEqual(got[0].input, null, 'nothing on stdin');
  assert.deepStrictEqual(JSON.parse(got[0].git), { pause: { word: 'reboot' } });
  const p = JSON.parse(got[0].payload);
  assert.ok(!('prompt' in p), Object.keys(p).join(' '));
  assert.doesNotMatch(got[0].payload, /REBOOTING/);
  assert.strictEqual(p.hook_event_name, 'UserPromptSubmit');
  // It writes nothing: the same prompt asks again.
  assert.ok(c.run({ prompt: 'rebooting now' }), 'asks again');
  // A Codex thread ID is a session ID here.
  assert.ok(c.run({ session_id: CODEX_ID }), 'asks with a UUIDv7 thread ID');
});

test('pause watch (Codex): each word on the list reads the same way in the note', () => {
  const c = setup();
  assert.ok(c.run({ prompt: 'rebooting now' }), 'the control asks');
  const P = words();
  const each = {
    reboot: 'rebooting now', restart: 'restarting now', 'shut down': 'shutting down now', 'power off': 'powering off now',
    'log off': 'log out now', 'sign off': 'signing off now', 'turn off': 'turning off now', close: 'close the chat',
    quit: 'quit codex', exit: 'exit codex', end: 'ending this conversation',
  };
  assert.deepStrictEqual(Object.keys(each).sort(), [...P.WORDS].sort());
  for (const [w, p] of Object.entries(each)) {
    assert.strictEqual(P.pauseWord(p), w, p);
    const r = c.run({ prompt: p });
    assert.ok(r, `no ask for: ${p}`);
    assert.ok(askText(r).includes(`close this chat (it matched "${w}"). If it does`), p);
    assert.strictEqual(r.systemMessage, undefined, p);
  }
});

test('pause watch (Codex): through the launcher, silent for other prompts, other events, a subagent, a repo not set up, when off and right after a write', () => {
  const c = setup();
  const spy = spyOn(c.s);
  // A control first: the same call with its own prompt asks.
  assert.ok(c.run({}, spy.env), 'the control asks');
  assert.strictEqual(spy.inputs().length, 1);
  const P = words();
  // The long prompt would match without the length limit: its first clause is
  // "rebooting now", and each x is a line of its own.
  for (const prompt of ['restart the server', 'please fix the test', '', 'rebooting now' + '\nx'.repeat(P.MAX_CHARS)]) assert.strictEqual(c.run({ prompt }, spy.env), null, prompt.slice(0, 30));
  assert.strictEqual(c.run({ hook_event_name: 'PostToolUse' }, spy.env), null, 'a tool call');
  assert.strictEqual(c.run({ agent_id: 'a1' }, spy.env), null, 'a subagent');
  assert.strictEqual(c.run({ agent_type: 'worker' }, spy.env), null, 'a subagent type');
  assert.strictEqual(c.run({ session_id: 'not-a-session' }, spy.env), null, 'no session ID');
  assert.strictEqual(spy.inputs().length, 1, 'no script was started for any of these');
  // A repo not set up: the launcher finds no memory folder. The script would
  // stay silent too (its own memory-folder check), so the launcher's exit
  // shows as no script started.
  const d = setup({ init: false });
  const dspy = spyOn(d.s);
  assert.strictEqual(d.run({}, dspy.env), null, 'not set up');
  assert.strictEqual(dspy.inputs().length, 0, 'no script was started for a repo not set up');
  // Off in .jbmem.json, the file both copies read.
  const marker = path.join(c.s.memdir, '.jbmem.json');
  const cfg0 = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, JSON.stringify({ ...cfg0, pauseWatch: { on: false } }));
  assert.strictEqual(c.run(), null, 'off');
  fs.writeFileSync(marker, JSON.stringify({ ...cfg0, pauseWatch: { on: 'no' } }));
  assert.ok(c.run(), 'only false turns it off');
  // Right after this session wrote the handoff.
  fs.writeFileSync(marker, JSON.stringify(cfg0));
  const run = (args, input) => jbm(c.s, args, input);
  assert.strictEqual(wh(run, '# Handoff\nfresh\n', [`--session=${SA}`]).status, 0);
  assert.strictEqual(c.run(), null, 'a handoff written just now');
  fs.writeFileSync(marker, JSON.stringify({ ...cfg0, hints: { freshCheckpointMinutes: 0 } }));
  assert.ok(c.run(), 'with freshCheckpointMinutes 0 it asks');
});

test('pause watch (Codex): the setting is read from .jbmem.json, on unless false', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const c = setup();
  const marker = path.join(c.s.memdir, '.jbmem.json');
  const cfg0 = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepStrictEqual(S.loadConfig(c.s.memdir).pauseWatch, { on: true }, 'default');
  for (const [v, on] of [[{ on: false }, false], [{ on: true }, true], [{ on: 'no' }, true], [{ on: 0 }, true], [false, true], [null, true], [[], true]]) {
    fs.writeFileSync(marker, JSON.stringify({ ...cfg0, pauseWatch: v }));
    assert.deepStrictEqual(S.loadConfig(c.s.memdir).pauseWatch, { on }, JSON.stringify(v));
  }
});

test('pause watch (Codex): the hook takes only a word from its list, and asks unless off or right after a write', () => {
  const { decide, pauseFact } = require(path.join(ROOT, 'scripts', 'hook-pause-watch.js'));
  const P = words();
  const was = process.env.JBMEM_GIT;
  try {
    for (const w of P.WORDS) { process.env.JBMEM_GIT = JSON.stringify({ pause: { word: w } }); assert.strictEqual(pauseFact(), w); }
    for (const v of [{ pause: { word: 'Reboot' } }, { pause: { word: 'reboot now' } }, { pause: { word: 5 } }, { pause: 'reboot' }, { pause: ['reboot'] }, {}, null]) {
      process.env.JBMEM_GIT = JSON.stringify(v);
      assert.strictEqual(pauseFact(), '', JSON.stringify(v));
    }
    process.env.JBMEM_GIT = 'not json';
    assert.strictEqual(pauseFact(), '');
  } finally {
    if (was === undefined) delete process.env.JBMEM_GIT; else process.env.JBMEM_GIT = was;
  }
  const cfg = (on = true, fresh = 3) => ({ pauseWatch: { on }, hints: { freshCheckpointMinutes: fresh, minMinutesBetween: 20 } });
  const now = 10 * 3600000;
  assert.strictEqual(decide(null, cfg(), now), true, 'no record');
  assert.strictEqual(decide({}, cfg(), now), true, 'no write');
  assert.strictEqual(decide({}, cfg(false), now), false, 'off');
  assert.strictEqual(decide({ lastWrite: now - 179999 }, cfg(), now), false, 'written just under 3 minutes ago');
  assert.strictEqual(decide({ lastWrite: now - 180000 }, cfg(), now), true, 'written 3 minutes ago');
  assert.strictEqual(decide({ lastWrite: now - 1000 }, cfg(true, 0), now), true, 'freshCheckpointMinutes 0');
  assert.strictEqual(decide({ lastWrite: now + 60000 }, cfg(), now), true, 'a write dated in the future');
  assert.strictEqual(decide({ lastWrite: 'x' }, cfg(), now), true, 'a write time that is not a number');
  // The reminder throttle doesn't apply.
  assert.strictEqual(decide({ lastHintAt: now - 1000 }, cfg(), now), true, 'a reminder a second ago');
});

test('pause watch (Codex): the script run on its own checks the event, a subagent, the session and the word', () => {
  const c = setup();
  const script = path.join(ROOT, 'scripts', 'hook-pause-watch.js');
  const env = { ...c.s.env, JBMEM_GIT: JSON.stringify({ pause: { word: 'reboot' } }) };
  delete env.JBMEM_LAUNCHED; delete env.JBMEM_PAYLOAD;
  const direct = (extra = {}) => {
    const r = spawnSync(process.execPath, [script], { cwd: c.s.repo, env, encoding: 'utf8', input: JSON.stringify({
      session_id: SA, transcript_path: c.transcript, cwd: c.s.repo, hook_event_name: 'UserPromptSubmit', ...extra,
    }) });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  assert.ok(askText(direct()), 'the control asks');
  assert.strictEqual(direct({ hook_event_name: 'PostToolUse' }), null, 'another event');
  assert.strictEqual(direct({ agent_id: 'a1' }), null, 'a subagent');
  assert.strictEqual(direct({ agent_type: 'worker' }), null, 'a subagent type');
  assert.strictEqual(direct({ session_id: 'not-a-session' }), null, 'no session ID');
  env.JBMEM_GIT = JSON.stringify({ pause: { word: 'restart the server' } });
  assert.strictEqual(direct(), null, 'a word not on the list');
});

test('pause watch (Codex): the script is granted no write, and a cwd that is not a full path is the launcher\'s own', () => {
  const c = setup();
  const r = c.call({}, { JBMEM_SHOW_GRANTS: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /^trailmark grants: read=\S+ write=$/m, r.stderr);
  assert.ok(askText(JSON.parse(r.stdout)), 'asks with no write grant');
  // A relative cwd in the payload: the launcher works from its own folder (the repo here).
  assert.ok(c.run({ cwd: 'not-a-folder' }), 'asks, from the launcher\'s own folder');
});

test('pause watch (Codex): the shape log gets one line for a match, with field names only, and none for other prompts', () => {
  const c = setup();
  const data = path.join(c.s.base, 'plugdata');
  const log = path.join(data, 'payload-shapes.log');
  assert.strictEqual(c.run({ prompt: 'restart the server' }, { PLUGIN_DATA: data }), null);
  assert.ok(!fs.existsSync(log), 'logged a prompt that did not match');
  assert.ok(c.run({ prompt: 'OK, REBOOTING NOW' }, { PLUGIN_DATA: data }), 'asks');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /hook=pause-watch event=UserPromptSubmit .*keys=\S*prompt:string\S* .*session=uuid/);
  assert.doesNotMatch(lines[0], /REBOOTING|NOW|OK,/);
  // A repo not set up logs nothing.
  const d = setup({ init: false });
  const dlog = path.join(d.s.base, 'plugdata');
  assert.strictEqual(d.run({}, { PLUGIN_DATA: dlog }), null);
  assert.ok(!fs.existsSync(path.join(dlog, 'payload-shapes.log')), 'logged in a repo not set up');
});

test('pause watch (Codex): hooks.json runs it on every prompt, and its command finds the launcher under sh', (t) => {
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.ok(Array.isArray(h.UserPromptSubmit), 'no UserPromptSubmit hook');
  const ups = h.UserPromptSubmit.flatMap(g => g.hooks);
  assert.strictEqual(ups.length, 1);
  assert.strictEqual(h.UserPromptSubmit[0].matcher, undefined, 'every prompt');
  const cmd = ups[0].command;
  // The same command as the other hooks but for its last words.
  const start = h.SessionStart[0].hooks[0].command;
  assert.strictEqual(cmd, start.replace(/ --hook session-start$/, ' --hook pause-watch'));
  // Needs sh on PATH (Git for Windows puts it in Git\bin, not Git\cmd).
  if (spawnSync('sh', ['-c', 'exit 0']).error) { t.skip('no sh on PATH'); return; }
  const c = setup();
  const env = { ...c.s.env, PLUGIN_ROOT: ROOT };
  const input = JSON.stringify({ session_id: SA, transcript_path: c.transcript, cwd: c.s.repo, hook_event_name: 'UserPromptSubmit', prompt: 'pause for reboot' });
  const r = spawnSync('sh', ['-c', cmd], { cwd: c.s.repo, env, input, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(askText(JSON.parse(r.stdout || 'null')), /run the tm-checkpoint skill/);
  const r2 = spawnSync('sh', ['-c', cmd], { cwd: c.s.repo, env, input: input.replace('pause for reboot', 'restart the server'), encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(r2.stdout, '');
});

// RS-T-clockstep, as in the Claude Code copy: the hook's time for finding the
// memory folder counts on Node's monotonic clock (sinceT0 in trailmark.js). A
// preload sets the system clock (Date.now) 20 s forward before the launcher's
// first line, as a clock change during the hook would, and notes the timeout
// of each git call that asks for the repo's root (rev-parse --git-common-dir,
// repoRoot in lib/paths.js). With the launcher's time spent before its script
// (the JBMEM_SHOW_CLOCK run line) under 1500 ms, that call had its 3000 ms; a
// busy machine skips that check, with a note.
test('pause watch (Codex): a system clock set forward during the hook takes no time from finding the memory folder (RS-T-clockstep)', (t) => {
  const c = setup();
  const roots = path.join(c.s.base, 'step-roots.txt');
  const stub = path.join(c.s.base, 'step.js');
  fs.writeFileSync(stub, `const cp = require('child_process');
const fs = require('fs');
const real = Date.now;
Date.now = () => real() + 20000;
const exec = cp.execFileSync;
cp.execFileSync = function (file, a, opts) {
  if (Array.isArray(a) && a.includes('--git-common-dir')) fs.appendFileSync(${JSON.stringify(roots)}, String(opts && opts.timeout) + String.fromCharCode(10));
  return exec.apply(this, arguments);
};
`);
  const spawnAt = Date.now();
  const r = spawnSync(process.execPath, ['-r', stub, JBM, '--hook', 'pause-watch'], { cwd: c.s.repo, env: { ...c.s.env, JBMEM_SHOW_CLOCK: '1' }, encoding: 'utf8', input: JSON.stringify({
    session_id: SA, transcript_path: c.transcript, cwd: c.s.repo, hook_event_name: 'UserPromptSubmit', prompt: 'pause for reboot',
  }) });
  const endAt = Date.now();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(askText(JSON.parse(r.stdout || 'null')), /may say they are about to reboot/);
  const run = /^trailmark run: script spent=(-?\d+) timeout=(\d+)$/m.exec(r.stderr);
  assert.ok(run, `the launcher wrote no JBMEM_SHOW_CLOCK run line (stderr: ${JSON.stringify(r.stderr)})`);
  // The time spent the check below is gated on: inside the spawn, 50 ms
  // either way for two readings of the system clock.
  assert.ok(Number(run[1]) >= 0 && Number(run[1]) <= endAt - spawnAt + 50, `the script's time spent is not inside the spawn's ${endAt - spawnAt} ms: ${run[0]}`);
  if (Number(run[1]) >= 1500) return t.diagnostic(`the launcher spent ${run[1]} ms before its script: the root call was not checked`);
  let calls = [];
  try { calls = fs.readFileSync(roots, 'utf8').split('\n').filter(Boolean).map(Number); } catch { calls = []; }
  assert.ok(calls.includes(3000), `finding the memory folder started no git for the root with its 3000 ms (root calls: ${JSON.stringify(calls)}; ${run[0]})`);
});

// Run: dev/release-check.sh --only 'pause watch'
// The pause watch: a prompt that says the user is about to reboot, restart,
// shut down or close the session asks Claude to checkpoint first
// (lib/pausewords.js, hook-pause-watch.js, dev/pause-watch-design.md).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, JBM, jbm, jbmIn, wh, SA, contextWatchSetup, askText } = require('./helpers.js');
const P = require('../scripts/lib/pausewords.js');
const { decide, pauseFact } = require('../scripts/hook-pause-watch.js');

// ---------- the matcher ----------

// Each prompt with the word it gives. The forms of each trigger are all here.
const MATCH = [
  ['pause for reboot', 'reboot'], ['Pause for a reboot.', 'reboot'], ['rebooting now', 'reboot'], ['reboots', 'reboot'],
  ['brb, quick reboot', 'reboot'], ["ok that's it, I'm going to reboot", 'reboot'], ['Great, commit and push, then I’ll reboot', 'reboot'],
  ['heads up: rebooting for windows updates', 'reboot'], ['time to reboot', 'reboot'], ['rebooting in 5 minutes', 'reboot'], ['restart in 120 sec', 'restart'],
  ['Restarting now, back in 5', 'restart'], ['about to restart my pc', 'restart'], ['restarts', 'restart'], ['restart', 'restart'],
  ['I need to restart Claude Code to load the plugin', 'restart'],
  ['shutting down for the night', 'shut down'], ['Shut down.', 'shut down'], ['shutdown now', 'shut down'],
  ['powering off', 'power off'], ['power down the pc', 'power off'],
  ['logging off for the day', 'log off'], ['log out now', 'log off'], ['signing off', 'sign off'], ['sign out', 'sign off'],
  ['turning off my laptop now', 'turn off'], ['turn off the computer', 'turn off'],
  ['closing this session', 'close'], ['close the terminal', 'close'], ['quitting claude', 'quit'], ['quit the chat', 'quit'],
  ['exit claude', 'exit'], ['exiting the ide', 'exit'], ['ending this conversation', 'end'], ['end the session', 'end'],
];
// Prompts that must give nothing: the false hits the design names, and the
// shapes each rule is for.
const NO_MATCH = [
  'restart the server', 'reboot the router', 'can you restart the dev server', "don't reboot", 'i will not reboot', 'no need to restart',
  'after the reboot, check the build', 'I rebooted, carry on', 'restarted', 'should I restart?', 'restart the app', 'restart it',
  'does the hook survive a reboot?', 'the service keeps restarting', 'restart the build from scratch', "let's restart the task from the beginning",
  'restart the test run', 'restart nginx and then check the logs', 'turn off the lights', 'log out of github', 'shut the door',
  'close the file', 'end the loop', 'quit vim', 'close', 'exit', 'fix the bug that ends the session early',
  'rebooting in 1000 minutes', 'restart 2nd node', 'reboot v2',
  'Run `systemctl restart nginx` please', '```\nreboot\n```', '> rebooting now', '', '   ',
];

test('pause watch: the matcher gives each listed prompt its word, and nothing for the false hits', () => {
  for (const [p, w] of MATCH) assert.strictEqual(P.pauseWord(p), w, p);
  for (const p of NO_MATCH) assert.strictEqual(P.pauseWord(p), '', p);
  // Every word that comes out is one the sandboxed hook accepts.
  for (const [, w] of MATCH) assert.ok(P.WORDS.includes(w), w);
  assert.deepStrictEqual([...new Set(MATCH.map(m => m[1]))].sort(), P.WORDS.slice().sort(), 'each word has a case');
  for (const v of [undefined, null, 5, ['reboot'], { prompt: 'reboot' }]) assert.strictEqual(P.pauseWord(v), '', String(v));
});

test('pause watch: one word not on the allowed list, anywhere in the clause, stops each trigger', () => {
  // The texts next to each match: the same clause with one more word, at its
  // start, before the trigger and at its end.
  const base = ['reboot', 'rebooting', 'restart', 'restarting', 'shut down', 'shutting down', 'power off', 'powering down', 'log off', 'logging out', 'sign off', 'signing out', 'turn off', 'turning off', 'shutdown'];
  for (const b of base) {
    assert.ok(P.pauseWord(`${b} now`), `${b} now`);
    for (const x of ['server', 'app', "don't", 'not', 'after', 'should', 'it', 'router', 'service']) {
      for (const p of [`${x} ${b} now`, `${b} ${x} now`, `${b} now ${x}`]) assert.strictEqual(P.pauseWord(p), '', p);
    }
  }
  // Past forms and others that look like a trigger are no trigger.
  for (const w of ['rebooted', 'restarted', 'reboooting', 'rebootnow', 'shut', 'power', 'log', 'sign', 'turn', 'down', 'off']) assert.strictEqual(P.pauseWord(w), '', w);
});

test('pause watch: names every object has are no word of any table, after a pair word or alone', () => {
  // The class (PLAYBOOK "Writing" step 11): the names every object has, in
  // lower case, as the matcher sees its text. `__proto__` reaches the tables
  // as `proto` (an underscore ends a word); both are here. Round 1's security
  // review found `shut constructor` gave the Object function. The list comes
  // from Object.prototype itself, so a name added there is in it. `__proto__`
  // is added by hand: `--disable-proto=delete` takes it off Object.prototype.
  const own = Object.getOwnPropertyNames(Object.prototype).map(s => s.toLowerCase());
  const names = [...new Set(['__proto__', 'proto', ...own, ...own.map(s => s.replace(/[^a-z]/g, ''))])];
  for (const n of ['constructor', 'definegetter', 'lookupsetter']) assert.ok(names.includes(n), n);
  for (const p of ['shut', 'shutting', 'power', 'powering', 'log', 'logging', 'sign', 'signing', 'turn', 'turning']) {
    for (const n of names) {
      assert.strictEqual(P.pauseWord(`${p} ${n}`), '', `${p} ${n}`);
      assert.strictEqual(P.pauseWord(`${p} ${n}. Rebooting now`), 'reboot', `${p} ${n}. Rebooting now`);
    }
  }
  for (const n of names) {
    for (const t of [n, `reboot ${n}`, `close ${n}`, `${n} the session`]) assert.strictEqual(P.pauseWord(t), '', t);
  }
});

test('pause watch: close, quit, exit and end need a session word in the same clause', () => {
  const forms = ['close', 'closing', 'quit', 'quitting', 'exit', 'exiting', 'end', 'ending'];
  const sessions = ['session', 'chat', 'conversation', 'claude', 'codex', 'terminal', 'window', 'ide', 'editor', 'vscode'];
  for (const f of forms) {
    assert.strictEqual(P.pauseWord(`${f} now`), '', `${f} now`);
    for (const s of sessions) assert.ok(P.pauseWord(`${f} the ${s}`), `${f} the ${s}`);
    // The session word in another clause doesn't count.
    assert.strictEqual(P.pauseWord(`${f} now, session`), '', `${f} now, session`);
    assert.strictEqual(P.pauseWord(`${f} now and the session`), '', `${f} now and the session`);
  }
});

test('pause watch: clauses are cut at punctuation, line breaks and joining words, and only one has to match', () => {
  for (const sep of ['. ', '! ', '? ', '; ', ': ', ', ', '\n', '\r\n', ' (', ' and ', ' then ', ' so ', ' but ', ' also ', ' plus ']) {
    assert.strictEqual(P.pauseWord(`fix the failing test${sep}rebooting now`), 'reboot', JSON.stringify(sep));
  }
  // A word that joins nothing keeps one clause.
  for (const sep of [' or ', ' while fixing ', ' with ']) assert.strictEqual(P.pauseWord(`fix the failing test${sep}rebooting now`), '', JSON.stringify(sep));
});

test('pause watch: the length limits, code between backticks and quoted lines', () => {
  const pad = n => 'x'.repeat(n);
  const tail = '\nrebooting now';
  assert.strictEqual(P.pauseWord(pad(P.MAX_CHARS - tail.length) + tail), 'reboot', 'at the limit');
  assert.strictEqual(P.pauseWord(pad(P.MAX_CHARS - tail.length + 1) + tail), '', 'one character over');
  const words = n => Array(n - 1).fill('now').concat('reboot').join(' ');
  assert.strictEqual(P.pauseWord(words(P.MAX_WORDS)), 'reboot', `${P.MAX_WORDS} words`);
  assert.strictEqual(P.pauseWord(words(P.MAX_WORDS + 1)), '', `${P.MAX_WORDS + 1} words`);
  assert.strictEqual(P.pauseWord('see `x`, rebooting now'), 'reboot', 'code elsewhere doesn\'t stop the rest');
  assert.strictEqual(P.pauseWord('`rebooting now`'), '', 'code');
  assert.strictEqual(P.pauseWord('> rebooting now\nok'), '', 'a quoted line');
  assert.strictEqual(P.pauseWord('ok\n  > rebooting now'), '', 'an indented quoted line');
  assert.strictEqual(P.pauseWord('a > b\nrebooting now'), 'reboot', 'a > inside a line is no quote');
});

// ---------- the sandboxed hook ----------

test('pause watch: the hook takes only a word from its list, and asks unless off or right after a write', () => {
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

// ---------- through the launcher ----------

// Records, in the launcher, what it hands the hook script (as in
// commit-folders.test.js): stdin, JBMEM_PAYLOAD and JBMEM_GIT.
function spyOn(s) {
  const log = path.join(s.base, 'hook-inputs.jsonl');
  const spy = path.join(s.base, 'hook-input-spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs'),path=require('path');const o=cp.spawnSync;cp.spawnSync=function(f,a,opt){const s=(a||[]).find(x=>/hook-[a-z-]+\\.js$/.test(String(x)));if(s){const e=(opt&&opt.env)||{};fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({script:path.basename(String(s)),input:opt&&opt.input!==undefined?String(opt.input):null,payload:typeof e.JBMEM_PAYLOAD==='string'?e.JBMEM_PAYLOAD:null,git:typeof e.JBMEM_GIT==='string'?e.JBMEM_GIT:null})+'\\n')}return o.apply(this,arguments)}`);
  return {
    env: { NODE_OPTIONS: `--require ${spy}` },
    inputs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []),
  };
}

function setup(opts) {
  const c = contextWatchSetup(opts);
  const call = (payload = {}, env = {}) => jbmIn(c.s, c.s.repo, ['--hook', 'pause-watch'], JSON.stringify({
    session_id: SA, transcript_path: c.transcript, cwd: c.s.repo, hook_event_name: 'UserPromptSubmit', prompt: 'pause for reboot', ...payload,
  }), env);
  const run = (payload, env) => {
    const r = call(payload, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stderr, '');
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  return { ...c, call, run };
}

test('pause watch: through the launcher, "pause for reboot" asks for a checkpoint and the prompt goes no further', () => {
  const c = setup();
  const spy = spyOn(c.s);
  const a = c.run({ prompt: 'OK, REBOOTING NOW' }, spy.env);
  assert.ok(a, 'asks');
  assert.strictEqual(a.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(askText(a), /^\[trailmark\] The user's prompt may say they are about to reboot/);
  assert.match(askText(a), /\(it matched "reboot"\)/);
  assert.match(askText(a), /run the trailmark:checkpoint skill before this turn ends/);
  assert.match(askText(a), /ignore this note/);
  assert.match(a.systemMessage, /^\[trailmark\] Your prompt may say you are about to stop \(it matched "reboot"\): asked Claude to checkpoint first/);
  // Each word reads the same way in the message (round 1 found "mentions a end").
  const each = {
    reboot: 'rebooting now', restart: 'restarting now', 'shut down': 'shutting down now', 'power off': 'powering off now',
    'log off': 'log out now', 'sign off': 'signing off now', 'turn off': 'turning off now', close: 'close the session',
    quit: 'quit claude', exit: 'exit claude', end: 'ending this conversation',
  };
  assert.deepStrictEqual(Object.keys(each).sort(), [...P.WORDS].sort());
  for (const [w, p] of Object.entries(each)) {
    assert.strictEqual(P.pauseWord(p), w, p);
    const r = c.run({ prompt: p });
    assert.ok(r, `no ask for: ${p}`);
    assert.ok(r.systemMessage.includes(`may say you are about to stop (it matched "${w}"): asked Claude`), p);
    assert.ok(askText(r).includes(`(it matched "${w}"). If it does`), p);
  }
  // Nothing of the prompt is in the note or the message.
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
});

test('pause watch: through the launcher, silent for other prompts, other events, a subagent, a repo not set up, when off and right after a write', () => {
  const c = setup();
  const spy = spyOn(c.s);
  // The long prompt would match without the length limit: its first clause is
  // "rebooting now", and each x is a line of its own.
  for (const prompt of ['restart the server', 'please fix the test', '', 'rebooting now' + '\nx'.repeat(P.MAX_CHARS)]) assert.strictEqual(c.run({ prompt }, spy.env), null, prompt.slice(0, 30));
  assert.strictEqual(c.run({ hook_event_name: 'PostToolUse' }, spy.env), null, 'a tool call');
  assert.strictEqual(c.run({ agent_id: 'a1' }, spy.env), null, 'a subagent');
  assert.strictEqual(c.run({ agent_type: 'Explore' }, spy.env), null, 'a subagent type');
  assert.strictEqual(c.run({ session_id: 'not-a-session' }, spy.env), null, 'no session ID');
  assert.strictEqual(spy.inputs().length, 0, 'no script was started for any of these');
  // A repo not set up: the launcher finds no memory folder.
  // The script would stay silent too (its own memory-folder check), so the
  // launcher's exit shows as no script started.
  const d = setup({ init: false });
  const dspy = spyOn(d.s);
  assert.strictEqual(d.run({}, dspy.env), null, 'not set up');
  assert.strictEqual(dspy.inputs().length, 0, 'no script was started for a repo not set up');
  // Off in .jbmem.json.
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

test('pause watch: the script is granted no write, and a cwd that is not a full path is the launcher\'s own', () => {
  const c = setup();
  const r = c.call({}, { JBMEM_SHOW_GRANTS: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /^trailmark grants: read=\S+ write=$/m, r.stderr);
  assert.ok(askText(JSON.parse(r.stdout)), 'asks with no write grant');
  // A relative cwd in the payload: the launcher works from its own folder (the repo here).
  assert.ok(c.run({ cwd: 'not-a-folder' }), 'asks, from the launcher\'s own folder');
});

test('pause watch: the script run on its own checks the event, a subagent and the session itself', () => {
  const c = setup();
  const script = path.join(ROOT, 'scripts', 'hook-pause-watch.js');
  const env = { ...c.s.env, JBMEM_GIT: JSON.stringify({ pause: { word: 'reboot' } }) };
  delete env.JBMEM_LAUNCHED; delete env.JBMEM_PAYLOAD;
  const direct = (extra = {}) => {
    const r = require('child_process').spawnSync(process.execPath, [script], { cwd: c.s.repo, env, encoding: 'utf8', input: JSON.stringify({
      session_id: SA, transcript_path: c.transcript, cwd: c.s.repo, hook_event_name: 'UserPromptSubmit', ...extra,
    }) });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  assert.ok(askText(direct()), 'the control asks');
  assert.strictEqual(direct({ hook_event_name: 'PostToolUse' }), null, 'another event');
  assert.strictEqual(direct({ agent_id: 'a1' }), null, 'a subagent');
  assert.strictEqual(direct({ agent_type: 'Explore' }), null, 'a subagent type');
  assert.strictEqual(direct({ session_id: 'not-a-session' }), null, 'no session ID');
  env.JBMEM_GIT = JSON.stringify({ pause: { word: 'restart the server' } });
  assert.strictEqual(direct(), null, 'a word not on the list');
});

test('pause watch: hooks.json runs it on every prompt, beside the context watch', () => {
  const ups = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit.flatMap(g => g.hooks);
  const args = ups.map(h => (h.args || []).slice(1).join(' '));
  assert.deepStrictEqual(args, ['--hook context-watch', '--hook pause-watch']);
  for (const h of ups) assert.strictEqual(h.args[0], '${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js');
  assert.ok(fs.existsSync(JBM));
});

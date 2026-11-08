// Run: node --test tests/codex.test.js
// What the Codex copy does differently from trailmark for Claude Code.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { realTemp, dp, bashSyntax, ROOT, sandbox, wh, J, jbm, SA, SB, SC,
  notesOf, commitLines } = require('./helpers.js');

// ---------- Codex copy: what differs from trailmark for Claude Code ----------

const HOOKS_JSON = path.join(ROOT, 'hooks', 'hooks.json');
const hookCmd = (ev) => JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks[ev][0].hooks[0].command;

test('codex hooks.json: events, matchers and one command form for every shell', () => {
  const h = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks;
  assert.deepStrictEqual(Object.keys(h).sort(), ['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionStart']);
  assert.strictEqual(h.PreToolUse[0].matcher, '^Bash$');
  assert.strictEqual(h.PostToolUse[0].matcher, '^Bash$');
  for (const [ev, groups] of Object.entries(h)) {
    for (const g of groups) for (const x of g.hooks) {
      assert.strictEqual(x.type, 'command');
      assert.ok(Number.isInteger(x.timeout) && x.timeout <= 20, ev);
      // No $, %, backtick or `--`: nothing a shell expands, nothing PowerShell drops.
      assert.doesNotMatch(x.command, /[$%`]|\s--\s/, ev);
      assert.match(x.command, /^node -e "[^"]+" trailmark --hook [a-z-]+( auto)?$/, ev);
    }
  }
  assert.match(hookCmd('PostToolUse'), /--hook milestone auto$/);
});

test('codex hooks.json: the command finds trailmark.js from PLUGIN_ROOT under sh, and exits 0 without it', (t) => {
  // Needs sh on PATH (Git for Windows puts it in Git\bin, not Git\cmd).
  if (spawnSync('sh', ['-c', 'exit 0']).error) { t.skip('no sh on PATH'); return; }
  const s = sandbox();
  jbm(s, ['init']);
  const run = (env) => spawnSync('sh', ['-c', hookCmd('SessionStart')], { cwd: s.repo, env: { ...s.env, ...env }, input: JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  const r = run({ PLUGIN_ROOT: ROOT });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /ChatGPT\/Codex copy of trailmark/);
  const e = { ...s.env }; delete e.PLUGIN_ROOT; delete e.CLAUDE_PLUGIN_ROOT;
  const r2 = spawnSync('sh', ['-c', hookCmd('SessionStart')], { cwd: s.repo, env: e, input: '{}', encoding: 'utf8' });
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout, '');
  // A relative PLUGIN_ROOT could resolve through node_modules in the repo: refused.
  const planted = path.join(s.repo, 'node_modules', 'evil', 'scripts');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, 'trailmark.js'), "require('fs').writeFileSync(require('path').join(process.cwd(), 'PWNED'), 'x')");
  const r3 = spawnSync('sh', ['-c', hookCmd('SessionStart')], { cwd: s.repo, env: { ...e, PLUGIN_ROOT: 'evil', CLAUDE_PLUGIN_ROOT: ROOT }, input: '{}', encoding: 'utf8' });
  assert.strictEqual(r3.status, 0);
  assert.ok(!fs.existsSync(path.join(s.repo, 'PWNED')), 'a relative PLUGIN_ROOT ran planted code');
  assert.strictEqual(r3.stdout, '', 'CLAUDE_PLUGIN_ROOT is not a fallback');
  assert.doesNotMatch(hookCmd('SessionStart'), /!/, 'cmd delayed expansion would eat a !');
});

test('codex session start: launcher path and session ID reach the model; no systemMessage without a warning', () => {
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- state\n');
  const out = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA, hook_event_name: 'SessionStart' })).stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(`Launcher: ${path.join(ROOT, 'scripts', 'trailmark.js')}`), ctx);
  assert.ok(ctx.includes(`--session=${SA}`));
  assert.match(ctx, /tm-checkpoint, tm-recall, tm-park, tm-session-end, tm-memory-prune/);
  const nodeWarn = require(path.join(ROOT, 'scripts', 'lib', 'health')).nodeAdvice(process.version);
  if (nodeWarn) assert.match(out.systemMessage, /WARNING: Node /); else assert.strictEqual(out.systemMessage, undefined);
  const none = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: 'not-a-uuid' })).stdout);
  assert.match(none.hookSpecificOutput.additionalContext, /No session ID was given: leave --session out/);
  assert.match(jbm(s, ['status']).stdout, /SESSION_START source=startup branch=\S+ sandbox=on host=codex/);
});

test('codex payloads: argv commands, a failed commit command, a failed PR merge, workdir', (t) => {
  bashSyntax(t);
  const s = sandbox();
  jbm(s, ['init']);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  const post = (payload) => jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify({ cwd: s.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SA, ...payload }), { JBMEM_CODEX_SHELL: 'bash' });
  // An argv array as older Codex builds send it.
  s.g('commit', '--allow-empty', '-qm', 'argv form');
  let r = post({ tool_use_id: 'c1', tool_input: { command: ['bash', '-lc', 'git commit --allow-empty -m "argv form"'] }, tool_response: 'Exit code: 0\nOutput:\n[master abc1234] argv form' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Commit landed.*tm-checkpoint/);
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ argv form/);
  // A command that failed after committing: logged, no reminder.
  s.g('commit', '--allow-empty', '-qm', 'then push failed');
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: s.repo, encoding: 'utf8' }).trim();
  r = post({ tool_use_id: 'c2', tool_input: { command: 'git commit --allow-empty -m "then push failed" && git push' }, tool_response: `Exit code: 1\nOutput:\n[master ${sha}] then push failed\nfatal: no remote` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'no reminder after a failed command');
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ then push failed/);
  // A line in the command's own output can't pose as a failed exit code.
  s.g('commit', '--allow-empty', '-qm', 'output lies');
  r = post({ tool_use_id: 'c2b', tool_input: { command: 'git commit --allow-empty -m "output lies"' }, tool_response: 'Exit code: 0\nOutput:\nExit code: 1\n' });
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ output lies/);
  // A failed PR merge is not a milestone.
  r = post({ tool_use_id: 'c3', tool_input: { command: 'gh pr merge 5 --squash' }, tool_response: { exit_code: 1, output: 'not mergeable' } });
  assert.strictEqual(r.stdout, '');
  assert.doesNotMatch(notesOf(s), /PR_MERGE/);
  r = post({ tool_use_id: 'c4', tool_input: { command: 'gh pr merge 6 --squash' }, tool_response: { exit_code: 0 } });
  assert.match(notesOf(s), /PR_MERGE gh pr merge 6/);
  // Anything else leaves at once.
  r = post({ tool_use_id: 'c5', tool_input: { command: 'git status' }, tool_response: 'Exit code: 0' });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
  // workdir: the command runs in another folder.
  const other = path.join(s.base, 'other');
  execFileSync('git', ['clone', '-q', s.repo, other]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'in workdir'], { cwd: other });
  r = post({ tool_use_id: 'c6', tool_input: { command: 'git commit --allow-empty -m "in workdir"', workdir: other }, tool_response: 'Exit code: 0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(commitLines(s).some(l => l.includes('in workdir') && l.includes(`in="${dp(other)}"`)), notesOf(s));
});

test('codex shape log: field names and types only, in PLUGIN_DATA, never command text, only in set-up repos', () => {
  const s = sandbox();
  const data = path.join(s.base, 'plugdata');
  const payload = { cwd: s.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SA, tool_input: { command: 'GITHUB_TOKEN=ghp_SECRETSECRET gh pr merge 5' }, tool_response: 'Exit code: 0\nOutput:\nSECRET-OUT' };
  jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...payload, tool_input: { command: 'git commit -m x' } }), { PLUGIN_DATA: data });
  assert.ok(!fs.existsSync(path.join(data, 'payload-shapes.log')), 'logged in a repo not set up');
  jbm(s, ['init']);
  jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify(payload), { PLUGIN_DATA: data });
  jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify({ ...payload, tool_input: { command: 'git commit -m x' } }), { PLUGIN_DATA: data });
  const log = fs.readFileSync(path.join(data, 'payload-shapes.log'), 'utf8');
  assert.match(log, /hook=milestone\/pr-merge event=PostToolUse tool=Bash .*tool_input=command:string cmd0=other .*exit=0 (exit_tx=\S+ )?session=uuid/);
  assert.match(log, /cmd0=git /);
  assert.doesNotMatch(log, /SECRET|ghp_/);
  fs.rmSync(data, { recursive: true });
  jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify(payload), { PLUGIN_DATA: data, JBMEM_SHAPES: 'off' });
  assert.ok(!fs.existsSync(path.join(data, 'payload-shapes.log')));
});

test('codex transcript: reads this session\'s rollout, events over response items, never a Claude transcript', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const home = path.join(s.base, 'codex');
  const day = path.join(home, 'sessions', '2026', '10', '24');
  fs.mkdirSync(day, { recursive: true });
  const L = (o) => JSON.stringify(o);
  const ts = (m) => `2026-10-24T10:${String(m).padStart(2, '0')}:00Z`;
  const roll = path.join(day, `rollout-2026-10-24T10-00-00-${SA}.jsonl`);
  fs.writeFileSync(roll, [
    L({ timestamp: ts(0), type: 'session_meta', payload: { id: SA, cwd: s.repo } }),
    L({ timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context> use PowerShell' }] } }),
    L({ timestamp: ts(1), type: 'event_msg', payload: { type: 'user_message', message: 'use PowerShell' } }),
    L({ timestamp: ts(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["rm -rf x"]}' } }),
    L({ timestamp: ts(2), type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } }),
    L({ timestamp: ts(3), type: 'event_msg', payload: { type: 'agent_message', message: 'Done, tests pass.' } }),
    L({ timestamp: ts(4), type: 'compacted', payload: { message: 'summary of the work' } }),
  ].join('\n') + '\n');
  // A Claude Code transcript for the same session ID in the projects folder: never read.
  fs.writeFileSync(path.join(s.projectDir, `${SA}.jsonl`), L({ type: 'user', timestamp: ts(5), message: { content: 'CLAUDE-SIDE' } }) + '\n');
  const env = { CODEX_HOME: home };
  // A session that never started in this repo: refused.
  const t0 = jbm(s, ['transcript', `--session=${SA}`], undefined, env);
  assert.notStrictEqual(t0.status, 0);
  assert.match(t0.stderr, /has not started in this repo/);
  for (const id of [SA, SB, SC]) jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: id }), env);
  const t = jbm(s, ['transcript', `--session=${SA}`], undefined, env);
  assert.strictEqual(t.status, 0, t.stderr);
  assert.ok(t.stdout.includes(`file: ${roll}`), t.stdout);
  assert.match(t.stdout, /USER: use PowerShell/);
  assert.strictEqual((t.stdout.match(/USER: /g) || []).length, 1, 'user message counted twice');
  assert.match(t.stdout, /ASSISTANT: Done, tests pass\./);
  assert.match(t.stdout, /COMPACTION SUMMARY: summary of the work/);
  assert.doesNotMatch(t.stdout, /rm -rf|tool output|environment_context|CLAUDE-SIDE/);
  // Without events, the response items stand in, wrappers stripped.
  const roll2 = path.join(day, `rollout-2026-10-24T11-00-00-${SB}.jsonl`);
  fs.writeFileSync(roll2, [
    L({ timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>x</user_instructions> fix the bug' }] } }),
    L({ timestamp: ts(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }),
    L({ timestamp: ts(2), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEV-ONLY' }] } }),
  ].join('\n') + '\n');
  const t2 = jbm(s, ['transcript', `--session=${SB}`], undefined, env);
  assert.match(t2.stdout, /USER: fix the bug/);
  assert.match(t2.stdout, /ASSISTANT: Fixed\./);
  assert.doesNotMatch(t2.stdout, /DEV-ONLY|user_instructions/);
  // No session, or none found: refused, nothing read.
  assert.notStrictEqual(jbm(s, ['transcript'], undefined, env).status, 0);
  const t3 = jbm(s, ['transcript', `--session=${SC}`], undefined, env);
  assert.notStrictEqual(t3.status, 0);
  assert.match(t3.stderr, /no Codex transcript found/);
});

test('codex transcript: the path recorded at session start is used only inside Codex\'s session folders', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store'));
  const { findCodexTranscript } = require(path.join(ROOT, 'scripts', 'lib', 'transcript'));
  const base = realTemp('jbmem-cx-');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(base, 'codex');
  try {
    const inside = path.join(base, 'codex', 'archived_sessions', `rollout-x-${SA}.jsonl`);
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, '');
    const outside = path.join(base, 'elsewhere.jsonl');
    fs.writeFileSync(outside, '');
    assert.strictEqual(findCodexTranscript(SA, outside), inside, 'a recorded path outside is ignored; the archive is searched');
    assert.strictEqual(findCodexTranscript(SA, inside), inside);
    assert.strictEqual(findCodexTranscript('nope', inside), null);
    assert.ok(S.cleanSession(SA));
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
});

test('codex init: refused unless JBMEM_CODEX_INIT=1, so the folder comes from Claude Code', () => {
  const s = sandbox();
  const r = jbm(s, ['init'], undefined, { JBMEM_CODEX_INIT: '' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /init is off in this copy/);
  assert.doesNotMatch(r.stderr, /Claude Code/);
  assert.ok(!fs.existsSync(path.join(s.memdir, '.jbmem.json')));
});

test('codex skills: tm- names, no Claude Code placeholders, every command through <launcher>, text through files', () => {
  const dir = path.join(ROOT, 'skills');
  const names = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(names, ['tm-checkpoint', 'tm-memory-prune', 'tm-memory-setup', 'tm-park', 'tm-recall', 'tm-session-end']);
  for (const n of names) {
    const t = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8');
    assert.match(t, new RegExp(`^---\\nname: ${n}\\n`), n);
    assert.doesNotMatch(t, /\$\{CLAUDE_|JBMEM_EOF|<<'|Bash tool|Write tool|trailmark:(checkpoint|recall|park|session-end|memory-prune)\b/, n);
    for (const m of t.matchAll(/node "([^"]+)"/g)) assert.strictEqual(m[1], '<launcher>', `${n}: ${m[0]}`);
    assert.ok(!/[^\x00-\x7f]/.test(t), `${n}: non-ASCII`);
  }
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store'));
  assert.strictEqual(S.CHECKPOINT_SKILL, 'tm-checkpoint');
  assert.ok(S.SKILL_RULE.includes(path.join(ROOT, 'skills', 'tm-checkpoint', 'SKILL.md')));
  for (const f of ['plugin.json', path.join('.codex-plugin', 'plugin.json')]) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.strictEqual(m.name, 'trailmark-codex');
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
  }
  const mk = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.deepStrictEqual(mk.plugins.map(p => [p.name, p.source.source, p.source.path]), [['trailmark-codex', 'local', './plugins/trailmark-codex']]);
});

test('codex 0.1.1: "sandbox": false is ignored with a warning, and a Node inside the repo is named', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const cfgFile = path.join(s.memdir, '.jbmem.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), sandbox: false }));
  assert.match(jbm(s, ['dir']).stdout, /sandbox: on/);
  const out = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA })).stdout);
  assert.match(out.systemMessage, /"sandbox": false, which trailmark ignores/);
  const H = require(path.join(ROOT, 'scripts', 'lib', 'health'));
  assert.match(H.nodeInside('C:\\Repo\\node.exe', ['c:\\repo'], 'win32'), /inside this session's folder or repo/);
  assert.strictEqual(H.nodeInside('C:\\Program Files\\nodejs\\node.exe', ['C:\\Repo'], 'win32'), '');
});

test('transcript: lines are read in chunks, across chunk edges and split characters, and an overlong line is skipped', () => {
  const { forEachLine, extract } = require('../scripts/lib/transcript');
  const base = realTemp('jbmem-lines-');
  const file = path.join(base, 't.jsonl');
  const lines = ['short', 'caf\u00e9 \u00b7 \u{1F680} across the edge', 'x'.repeat(100), '', 'last, no newline'];
  fs.writeFileSync(file, lines.join('\n'));
  const got = [];
  forEachLine(file, l => got.push(l), { chunk: 7, maxLine: 64 });
  assert.deepStrictEqual(got, ['short', lines[1], 'last, no newline'], 'the 100-char line is over maxLine and skipped; the empty line yields nothing');
  const t = path.join(base, 'big.jsonl');
  const msg = (role, text, ts) => JSON.stringify({ type: role, timestamp: ts, message: { content: text } });
  fs.writeFileSync(t, [msg('user', 'first ask', '2026-10-15T10:00:00Z'), 'null', '{"type":"user","message":{"content":"' + 'y'.repeat(40 << 20) + '"}}', msg('user', 'second ask', '2026-10-15T10:05:00Z')].join('\n') + '\n');
  const r = extract(t, {});
  assert.strictEqual(r.total, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /first ask[\s\S]*second ask/);
});

test('codex 0.1.3: the desktop app\'s JSON results give the exit code; text in the output can\'t fake one', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  const post = (id, command, tool_response) => jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify({ cwd: s.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SA, tool_use_id: id, tool_input: { command }, tool_response }), { JBMEM_CODEX_SHELL: 'bash' });
  const res = (code, output) => JSON.stringify({ chunk_id: '9f424c', wall_time_seconds: 0.64, exit_code: code, original_token_count: 12, output });
  // A failed PR merge, plain JSON and after the "Script completed" header.
  post('p1', 'gh pr merge 7 --squash', res(1, 'not mergeable'));
  post('p2', 'gh pr merge 8 --squash', 'Script completed\nWall time 2.0 seconds\nOutput:\n' + res(1, 'not mergeable'));
  assert.doesNotMatch(notesOf(s), /PR_MERGE/, 'a failed merge was logged');
  // Output that pretends to be a later exit code, and a result cut short.
  post('p3', 'gh pr merge 9 --squash', res(0, '"exit_code":1 Exit code: 1'));
  post('p4', 'gh pr merge 10 --squash', res(0, 'x'.repeat(50)).slice(0, 90));
  assert.match(notesOf(s), /PR_MERGE gh pr merge 9/);
  assert.match(notesOf(s), /PR_MERGE gh pr merge 10/);
  // A commit command that commits and then fails: logged, no reminder.
  s.g('commit', '--allow-empty', '-qm', 'json then fail');
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: s.repo, encoding: 'utf8' }).trim();
  const r = post('c1', 'git commit --allow-empty -m "json then fail" && git push', res(1, `[master ${sha}] json then fail\nfatal: no remote`));
  assert.strictEqual(r.stdout, '', 'no reminder after a failed command');
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ json then fail/);
});

test('codex 0.1.3: a transcript path with the \\\\?\\ prefix is the same folder; item_completed messages are read', () => {
  const T = require(path.join(ROOT, 'scripts', 'lib', 'transcript'));
  assert.strictEqual(T.plainPath('\\\\?\\C:\\Users\\ann\\.codex\\sessions\\a.jsonl'), 'C:\\Users\\ann\\.codex\\sessions\\a.jsonl');
  assert.strictEqual(T.plainPath('\\\\?\\UNC\\srv\\share\\a.jsonl'), '\\\\srv\\share\\a.jsonl');
  assert.strictEqual(T.plainPath('/home/x/a.jsonl'), '/home/x/a.jsonl');
  const s = sandbox();
  jbm(s, ['init']);
  const home = path.join(s.base, 'codex');
  const day = path.join(home, 'sessions', '2026', '10', '25');
  fs.mkdirSync(day, { recursive: true });
  const roll = path.join(day, `rollout-2026-10-25T08-11-55-${SA}.jsonl`);
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(roll, [
    L({ timestamp: '2026-10-25T12:24:34Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make hello.txt' }] } }),
    L({ timestamp: '2026-10-25T12:24:34Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'make hello.txt' }] } } }),
    L({ timestamp: '2026-10-25T12:24:36Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }], phase: 'commentary' } } }),
    L({ timestamp: '2026-10-25T12:24:40Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['pwsh.exe', '-Command', 'rm -r x'] } } }),
  ].join('\n') + '\n');
  // Not POSIX: the prefix form only exists on Windows, so the record is made the plain way here.
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA, transcript_path: roll }), { CODEX_HOME: home });
  const t = jbm(s, ['transcript', `--session=${SA}`], undefined, { CODEX_HOME: home });
  assert.strictEqual(t.status, 0, t.stderr);
  assert.strictEqual((t.stdout.match(/USER: make hello\.txt/g) || []).length, 1, t.stdout);
  assert.match(t.stdout, /ASSISTANT: Done\./);
  assert.doesNotMatch(t.stdout, /rm -r x/);
});

test('codex 0.1.4: the shape log describes a tool result without quoting it; a dump is written only on request', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const data = path.join(s.base, 'plugdata');
  fs.mkdirSync(data);
  const resp = 'Script completed\nWall time 1.0 seconds\nOutput:\n' + JSON.stringify({ chunk_id: 'a', exit_code: 1, output: 'SECRET-OUT fatal: x' });
  const payload = { cwd: s.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SA, tool_use_id: 'd1', tool_input: { command: 'git commit -m x' }, tool_response: resp, transcript_path: '\\\\?\\C:\\Users\\x\\.codex\\sessions\\a.jsonl' };
  jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify(payload), { PLUGIN_DATA: data });
  const log = fs.readFileSync(path.join(data, 'payload-shapes.log'), 'utf8');
  assert.match(log, /resp=len\d+\|first:letter\|exit_code_field\|wall_time\|output_hdr\|script_completed\|brace@\d+ exit=1 /);
  assert.match(log, /transcript=elsewhere\([^)]*longprefix/);
  assert.doesNotMatch(log, /SECRET/);
  assert.ok(!fs.existsSync(path.join(data, 'tool-result-dump.txt')), 'dumped without a request');
  fs.writeFileSync(path.join(data, 'dump-next-tool-result'), '');
  jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify({ ...payload, tool_use_id: 'd2' }), { PLUGIN_DATA: data });
  const dump = fs.readFileSync(path.join(data, 'tool-result-dump.txt'), 'utf8');
  assert.match(dump, /command: git commit -m x/);
  assert.match(dump, /SECRET-OUT/);
  assert.ok(!fs.existsSync(path.join(data, 'dump-next-tool-result')), 'the request file is removed');
});

test('codex 0.1.5: the exit code comes from the transcript\'s CommandExecution item with the hook\'s ID', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  const home = path.join(s.base, 'codex');
  const day = path.join(home, 'sessions', '2026', '10', '25');
  fs.mkdirSync(day, { recursive: true });
  const roll = path.join(day, `rollout-2026-10-25T09-57-16-${SA}.jsonl`);
  const item = (id, exit_code, status) => JSON.stringify({ timestamp: '2026-10-25T13:57:24Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id, process_id: '1', cwd: 'file:///x', status, exit_code, aggregated_output: '"id":"exec-other" CommandExecution' } } });
  fs.writeFileSync(roll, [item('exec-11111111-0000-4000-8000-000000000001', 1, 'failed'), item('exec-11111111-0000-4000-8000-000000000002', 0, 'completed'), item('exec-11111111-0000-4000-8000-000000000003', 1, 'failed')].join('\n') + '\n');
  const env = { CODEX_HOME: home, JBMEM_CODEX_SHELL: 'bash' };
  const post = (id, command, out, tp = roll) => jbm(s, ['--hook', 'milestone', 'auto'], JSON.stringify({ cwd: s.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SA, tool_use_id: id, transcript_path: tp, tool_input: { command }, tool_response: out }), env);
  // A failed merge (exit 1 in the transcript) is not logged.
  post('exec-11111111-0000-4000-8000-000000000001', 'gh pr merge 3 --squash', 'GraphQL: not mergeable');
  assert.doesNotMatch(notesOf(s), /PR_MERGE/);
  // A commit that lands and then fails: logged, no reminder.
  // PreToolUse first, as Codex runs it, so the command's time span is known.
  jbm(s, ['--hook', 'commit-start'], JSON.stringify({ cwd: s.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: SA, tool_use_id: 'exec-11111111-0000-4000-8000-000000000003', tool_input: { command: 'git commit --allow-empty -m "landed then failed" && git push' } }), env);
  s.g('commit', '--allow-empty', '-qm', 'landed then failed');
  const r = post('exec-11111111-0000-4000-8000-000000000003', 'git commit --allow-empty -m "landed then failed" && git push', 'fatal: no remote');
  assert.strictEqual(r.stdout, '', 'no reminder after a failed command');
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ landed then failed/);
  // A successful merge per the transcript is logged.
  post('exec-11111111-0000-4000-8000-000000000002', 'gh pr merge 4 --squash', '');
  assert.match(notesOf(s), /PR_MERGE gh pr merge 4/);
  // No transcript line for the ID, or a transcript outside Codex's folders:
  // unknown, so a merge counts only when gh said it merged.
  const outside = path.join(s.base, 'elsewhere.jsonl');
  fs.writeFileSync(outside, item('exec-11111111-0000-4000-8000-000000000009', 0, 'completed') + '\n');
  post('exec-11111111-0000-4000-8000-000000000009', 'gh pr merge 5 --squash', 'some error', outside);
  assert.doesNotMatch(notesOf(s), /PR_MERGE gh pr merge 5/);
  post('exec-11111111-0000-4000-8000-000000000008', 'gh pr merge 6 --squash', '✓ Squashed and merged pull request #6 (fix)');
  assert.match(notesOf(s), /PR_MERGE gh pr merge 6/);
});

// Next version, S1 (RS:652 at a09ee5f): with no "Launcher:" in the note, the
// skills said to take scripts/trailmark.js two folders up, which rebuilt the
// very path usablePath had refused (one holding $(...), say). The fallback
// now applies only when the session has no session-start note at all, keyed
// on that note's fixed start (other [trailmark] lines, such as the handoff's
// version line, don't count), and only to a path free of every character
// usablePath refuses, each named in the skills. A change to usablePath's set
// within printable ASCII or the samples below fails here until the skills
// follow. Characters are built with fromCharCode so the source stays ASCII.
test('codex skills: the launcher two folders up only with no [trailmark] note, never a path usablePath refuses', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store'));
  const u = (...c) => String.fromCharCode(...c), bs = u(92);
  const quotes = 'a curly double quote (U+201C to U+201E)', spaces = 'a space other than a plain one', hidden = 'a control or invisible character';
  // [what usablePath refuses inside a folder name, the words the skills use]
  const kinds = [['"', 'a double quote'], ['$', '`$`'], ['`', 'a backtick'], ['%', '`%`'], ['!', '`!`'],
    [u(0x201c), quotes], [u(0x201d), quotes], [u(0x201e), quotes], [bs + bs, 'two backslashes in a row'],
    ['  ', 'two spaces in a row'], [u(0xa0), spaces], [u(0x3000), spaces],
    [u(7), hidden], [u(0x7f), hidden], [u(0x200b), hidden], [u(0x202e), hidden], [u(0x2028), hidden]];
  const at = (c) => `/x/a${c}b/scripts/trailmark.js`;
  for (const [c] of kinds) assert.strictEqual(S.usablePath(at(c)), '', `usablePath passes ${JSON.stringify(c)}`);
  assert.strictEqual(S.usablePath(' /x/scripts/trailmark.js'), '');
  assert.strictEqual(S.usablePath('/x/scripts/trailmark.js '), '');
  assert.strictEqual(S.usablePath('/' + 'a'.repeat(1025)), '');
  // Every printable ASCII character: refused exactly when the skills list it.
  const listed = new Set(kinds.map(([c]) => c));
  for (let i = 32; i < 127; i++) {
    const c = String.fromCharCode(i);
    assert.strictEqual(S.usablePath(at(c)) === '', listed.has(c), `usablePath and the skills disagree on ${JSON.stringify(c)}`);
  }
  // Characters the skills don't list pass: the quotes next to the refused
  // ones, accented and CJK letters, one backslash, a plain path. So the
  // fallback keeps working for an ordinary install folder.
  for (const c of [u(0x2018), u(0x2019), u(0x201a), u(0x201b), u(0x201f), u(0xb4), u(0xe9), u(0x4e00), bs, ' ']) {
    assert.strictEqual(S.usablePath(at(c)), at(c), `usablePath refuses ${JSON.stringify(c)}, which the skills don't list`);
  }
  for (const ok of ['/home/me/.codex/plugins/cache/trailmark/trailmark-codex/0.6.0/scripts/trailmark.js', `C:${bs}Users${bs}J${u(0xfc)}rgen${bs}x${bs}trailmark.js`]) assert.strictEqual(S.usablePath(ok), ok);
  // The skills key on the session-start note's fixed start; both of the
  // hook's note variants (path written, path refused) begin with it.
  const NOTE = '[trailmark] ChatGPT/Codex copy of trailmark.';
  const hook = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-session-start.js'), 'utf8');
  assert.strictEqual(hook.split('`' + NOTE + ' Launcher: ${launcherPath}').length, 2, 'the note with the launcher');
  assert.strictEqual(hook.split('`' + NOTE + " The path of the folder it is installed in isn't written here").length, 2, 'the note without it');
  const refusedText = `If this session has a note that starts \`${NOTE}\` but gives no "Launcher:", trailmark left its own path out on purpose, since it holds characters trailmark doesn't pass on or is too long: stop and tell the user what the note says, and don't work the path out yourself.`;
  const dir = path.join(ROOT, 'skills');
  for (const n of fs.readdirSync(dir)) {
    const t = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(!t.includes('If there is no such note'), `${n}: the old fallback`);
    const refused = t.indexOf(refusedText);
    const only = t.indexOf(`Only when this session has no such note at all (the repo isn't set up yet, or Codex hasn't run trailmark's hooks, say) is the launcher \`scripts/trailmark.js\` two folders up from this SKILL.md (this file is \`<plugin folder>/skills/${n}/SKILL.md\`), and only when that path holds none of these:`);
    assert.ok(refused > 0 && only === refused + refusedText.length + 1, `${n}: the fallback's conditions`);
    assert.strictEqual(t.split('two folders up').length, 2, `${n}: one fallback`);
    const end = t.indexOf('Use that one path', only);
    const list = t.slice(only, end);
    for (const [, words] of kinds) assert.ok(list.includes(words), `${n}: ${words}`);
    assert.ok(list.endsWith(" a space at either end, a space other than a plain one, or a control or invisible character. If it holds one, or is over 1,024 characters, don't run it: tell the user to install trailmark in a folder with a plain path. Other lines that start `[trailmark]`, such as a command's output or a note about a commit, don't count as that note. "), `${n}: the end of the fallback`);
  }
});

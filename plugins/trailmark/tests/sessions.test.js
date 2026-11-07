// Run: node --test tests/sessions.test.js
// Several sessions sharing one memory folder: the version check, the lock,
// undo, session IDs and snapshots.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { realTemp, POSIX_ONLY, ROOT, sandbox, versionNow, wh, J, JBM, jbm, SA,
  SB, SC, stateOf, notesOf } = require('./helpers.js');

// ---------- several sessions sharing one memory folder ----------

test('version check: a write needs a base, a stale base is refused with a diff, a merged write goes through', () => {
  const s = sandbox();
  jbm(s, ['init']);
  fs.unlinkSync(path.join(s.memdir, 'handoff.md')); // setup writes a starter handoff; start from none
  const none = jbm(s, ['handoff']).stdout;
  assert.match(none, /^\[trailmark\] handoff version: none /);
  assert.match(none, /NO_HANDOFF/);
  const noBase = jbm(s, ['write-handoff'], '# H\n- a\n');
  assert.strictEqual(noBase.status, 1);
  assert.match(noBase.stderr, /needs --base=<version>/);
  assert.ok(!fs.existsSync(path.join(s.memdir, 'handoff.md')));
  assert.strictEqual(jbm(s, ['write-handoff', '--base=bogus'], '# H\n').status, 1);
  // Both sessions read the same version.
  assert.strictEqual(jbm(s, ['write-handoff', '--base=none', `--session=${SA}`], '# H\n## Next\n- shared item\n- old item\n').status, 0);
  const v1 = versionNow(J(s));
  // B writes first: it marks the old item [done] (archived as it saves) and adds a line.
  assert.strictEqual(jbm(s, ['write-handoff', `--base=${v1}`, `--session=${SB}`], '# H\n## Next\n- shared item\n- [done] old item\n- B ADDED THIS\n').status, 0);
  const current = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  // A writes with the version it read before B's changes.
  const r = jbm(s, ['write-handoff', `--base=${v1}`, `--session=${SA}`], '# H\n## Next\n- shared item\n- old item\n- A ADDED THIS\n');
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /REFUSED: the handoff changed after you read it/);
  assert.match(r.stdout, /Last written by session 22222222 at /);
  assert.match(r.stdout, /^\+ - B ADDED THIS$/m);
  assert.match(r.stdout, /^- - old item$/m);
  assert.match(r.stdout, /--- CURRENT HANDOFF \(version [0-9a-f]{12}\) ---/);
  assert.strictEqual(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'), current, 'nothing written on a conflict');
  const v2 = /write the merged handoff with --base=([0-9a-f]{12})/.exec(r.stdout)[1];
  assert.strictEqual(v2, versionNow(J(s)));
  const merged = jbm(s, ['write-handoff', `--base=${v2}`, `--session=${SA}`], '# H\n## Next\n- shared item\n- B ADDED THIS\n- A ADDED THIS\n');
  assert.strictEqual(merged.status, 0, merged.stdout + merged.stderr);
  const after = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  assert.match(after, /B ADDED THIS[\s\S]*A ADDED THIS/);
  assert.match(after, /^Updated: .* \| session 11111111 \| by Claude Code$/m);
  assert.match(merged.stdout, /handoff version: ([0-9a-f]{12}) \(this session's next write goes with --base=\1\)/);
  // A version line copied in from the `handoff` output is dropped.
  const copied = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`], `[trailmark] handoff version: ${v2} (write it back with --base=${v2})\n# H\n- body\n`);
  assert.strictEqual(copied.status, 0, copied.stderr);
  assert.ok(!fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8').includes('handoff version:'));
  // --force (by hand only) skips the check.
  assert.strictEqual(jbm(s, ['write-handoff', '--base=none', '--force'], '# H\n- forced\n').status, 0);
});

test('version check: of six sessions writing on the same version at once, exactly one wins', async () => {
  const { spawn } = require('child_process');
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- start\n');
  const base = versionNow(J(s));
  const run = (i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [JBM, 'write-handoff', `--base=${base}`, `--session=4444444${i}-aaaa-4bbb-8ccc-00000000000${i}`], { cwd: s.repo, env: s.env });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    c.on('close', code => resolve({ i, code, out }));
    c.stdin.end(`# H\n- start\n- WRITER ${i}\n`);
  });
  const res = await Promise.all([1, 2, 3, 4, 5, 6].map(run));
  const won = res.filter(r => r.code === 0);
  const refused = res.filter(r => r.code === 3);
  assert.strictEqual(won.length, 1, JSON.stringify(res, null, 1));
  assert.strictEqual(refused.length, 5, JSON.stringify(res, null, 1));
  const text = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  assert.match(text, new RegExp(`- WRITER ${won[0].i}\\n`));
  assert.strictEqual((text.match(/WRITER/g) || []).length, 1);
  assert.ok(!fs.existsSync(path.join(s.memdir, '.jbmem.lock')), 'lock released');
  for (const r of refused) assert.match(r.out, new RegExp(`\\+ - WRITER ${won[0].i}`));
});

test('lock: a stale lock is taken over, a held one is waited for, release leaves a lock that is not ours', async () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const s = sandbox();
  jbm(s, ['init']);
  const lock = path.join(s.memdir, '.jbmem.lock');
  fs.writeFileSync(lock, 'pid 999999 since long ago token dead\n');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  const r = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`], '# H\n- after stale lock\n');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(lock));
  assert.ok(!fs.readdirSync(s.memdir).some(f => f.endsWith('.stale')), 'no moved-aside lock left behind');
  // A lock whose holder is still running (this test process): the command waits until it is released.
  fs.writeFileSync(lock, `pid ${process.pid} since now token busy\n`);
  const { spawn } = require('child_process');
  const started = Date.now();
  const done = new Promise((resolve) => {
    const c = spawn(process.execPath, [JBM, 'note', 'waited for the lock'], { cwd: s.repo, env: s.env });
    c.on('close', code => resolve(code));
  });
  const v = versionNow(J(s));
  const w = new Promise((resolve) => {
    const c = spawn(process.execPath, [JBM, 'write-handoff', `--base=${v}`], { cwd: s.repo, env: s.env });
    c.on('close', code => resolve({ code, ms: Date.now() - started }));
    c.stdin.end('# H\n- after waiting\n');
  });
  setTimeout(() => fs.unlinkSync(lock), 700);
  const [noteCode, wr] = await Promise.all([done, w]);
  assert.strictEqual(noteCode, 0);
  assert.strictEqual(wr.code, 0);
  assert.ok(wr.ms >= 600, `write waited ${wr.ms} ms`);
  assert.match(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'), /after waiting/);
  // If the lock was taken over while fn ran, release leaves the new holder's lock alone.
  S.withLock(s.memdir, () => { fs.writeFileSync(lock, 'pid 1 token someone-else\n'); });
  assert.ok(fs.existsSync(lock), "another holder's lock is not removed");
  fs.unlinkSync(lock);
});

test('sessions: per-session snapshots, start messages, notes, status and the Updated line', () => {
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- state\n', [`--session=${SA}`]);
  const past = new Date(Date.now() - 600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), past, past);
  // Two sessions start, then both compact.
  for (const sid of [SA, SB]) jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: sid }));
  for (const sid of [SA, SB]) assert.strictEqual(jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: sid })).status, 0);
  assert.ok(fs.existsSync(path.join(s.memdir, 'snapshots', `${SA}.md`)));
  assert.ok(fs.existsSync(path.join(s.memdir, 'snapshots', `${SB}.md`)));
  assert.ok(!fs.existsSync(path.join(s.memdir, 'precompact.md')));
  const ca = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'compact', session_id: SA })).stdout).hookSpecificOutput.additionalContext;
  assert.match(ca, /COMPACTION SNAPSHOT \(this session, taken just before compaction\)/);
  assert.match(ca, /in session 11111111/);
  assert.ok(!/in session 22222222/.test(ca), "B's snapshot is not shown to A");
  assert.match(ca, /Other sessions active in this repo in the last 3 h: 22222222/);
  // A fresh session C sees the newest snapshot another session took after the last checkpoint.
  const cc = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SC })).stdout).hookSpecificOutput.additionalContext;
  assert.match(cc, /COMPACTION SNAPSHOT \(session (11111111|22222222) compacted after the last checkpoint\)/);
  assert.match(cc, /Other sessions active/);
  // Notes carry the session.
  jbm(s, ['note', 'hello from b', `--session=${SB}`]);
  const n = notesOf(s);
  assert.match(n, /hello from b session=22222222/);
  assert.match(n, /SESSION_START source=startup .* session=11111111/);
  assert.match(n, /PRE_COMPACT trigger=auto .* session=22222222/);
  // Status shows the last writer and the other sessions.
  const st = jbm(s, ['status', `--session=${SC}`]).stdout;
  assert.match(st, /last handoff write: session 11111111 at /);
  assert.match(st, /other sessions active in the last 3 h: .*11111111/);
  assert.match(st, /this session \(33333333\): started /);
  // The Updated line names the writing session and drops one the model copied.
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const t = S.stampUpdated('# H\nUpdated: 2020-01-01 00:00 | branch x | session deadbeef\n', null, new Date(2026, 9, 17, 9, 5), SB);
  assert.strictEqual(t, '# H\nUpdated: 2026-10-17 09:05 | branch x | session 22222222 | by Claude Code\n');
  assert.strictEqual(S.stampUpdated('# H\nUpdated: 2020-01-01 00:00 | session deadbeef\n', null, new Date(2026, 9, 17, 9, 5)), '# H\nUpdated: 2026-10-17 09:05 | by Claude Code\n');
  // A session ID that isn't one (an unsubstituted ${CLAUDE_SESSION_ID}) is ignored.
  assert.strictEqual(S.cleanSession('${CLAUDE_SESSION_ID}'), '');
  assert.strictEqual(jbm(s, ['note', 'no id', '--session=${CLAUDE_SESSION_ID}']).status, 0);
  assert.match(notesOf(s), /- \d\d:\d\d no id\n/);
});

test('sessions: resume warns when another session wrote since, undo refuses to undo another session', () => {
  const s = sandbox();
  jbm(s, ['init']);
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA }));
  wh(J(s), '# H\n- by A\n', [`--session=${SA}`]);
  let r = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'resume', session_id: SA })).stdout).hookSpecificOutput.additionalContext;
  assert.match(r, /only if another session may have changed/);
  wh(J(s), '# H\n- by B\n', [`--session=${SB}`]);
  r = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'resume', session_id: SA })).stdout).hookSpecificOutput.additionalContext;
  assert.match(r, /last written .* by session 22222222, not this one\. Re-read it/);
  const u = jbm(s, ['undo-handoff', `--session=${SA}`]);
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /was written by session 22222222, not this session/);
  assert.match(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'), /by B/);
  assert.strictEqual(jbm(s, ['undo-handoff', `--session=${SB}`]).status, 0);
  assert.match(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'), /by A/);
  const f = jbm(s, ['undo-handoff', `--session=${SA}`, '--force']);
  assert.strictEqual(f.status, 0, f.stderr);
});

test('sessions: milestone reminders are throttled per session; only this session\'s checkpoint counts as fresh', () => {
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- state\n', [`--session=${SB}`]);
  const commit = (sid, name) => {
    fs.writeFileSync(path.join(s.repo, name), name); s.g('add', name); s.g('commit', '-qm', name);
    const r = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: sid, tool_input: { command: `git commit -m ${name}` }, tool_response: {} }));
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  };
  assert.match(commit(SA, 'c1'), /checkpoint skill/, "B's fresh checkpoint doesn't silence A");
  assert.strictEqual(commit(SA, 'c2'), '', "A's second reminder is throttled");
  assert.strictEqual(commit(SB, 'c3'), '', 'B checkpointed a moment ago');
  assert.match(commit(SC, 'c4'), /checkpoint skill/, 'C has its own throttle');
  const st = stateOf(s);
  assert.ok(st.sessions[SA].lastHintAt && st.sessions[SC].lastHintAt && !st.sessions[SB].lastHintAt);
  assert.match(notesOf(s), /COMMIT [0-9a-f]+ c4 session=33333333/);
});

test('sessions: transcript finds this session\'s own file, and --since=checkpoint starts at its own last checkpoint', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const t = Date.now();
  const line = (ts, text) => JSON.stringify({ type: 'user', timestamp: new Date(ts).toISOString(), cwd: s.repo, message: { content: text } });
  const fa = path.join(s.projectDir, `${SA}.jsonl`);
  const fb = path.join(s.projectDir, `${SB}.jsonl`);
  fs.writeFileSync(fa, [line(t - 30 * 60000, 'A EARLY'), line(t - 5 * 60000, 'A LATE')].join('\n') + '\n');
  fs.writeFileSync(fb, line(t - 60000, 'B ONLY') + '\n');
  const older = new Date(t - 120000);
  fs.utimesSync(fa, older, older); // B's transcript is the newest one in the folder
  assert.match(jbm(s, ['transcript']).stdout, /B ONLY/);
  const a = jbm(s, ['transcript', `--session=${SA}`]);
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /A EARLY[\s\S]*A LATE/);
  assert.ok(!/B ONLY/.test(a.stdout));
  // The path Claude Code gave the SessionStart hook wins, even under another name.
  const moved = path.join(s.projectDir, 'renamed-by-claude.jsonl');
  fs.writeFileSync(moved, line(t - 60000, 'FROM RECORDED PATH') + '\n');
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SC, transcript_path: moved }));
  assert.match(jbm(s, ['transcript', `--session=${SC}`]).stdout, /FROM RECORDED PATH/);
  // A recorded path outside the projects folder is ignored.
  const st = stateOf(s);
  st.sessions[SC].transcript = path.join(s.base, 'elsewhere.jsonl');
  fs.writeFileSync(path.join(s.memdir, '.jbmem-state.json'), JSON.stringify(st));
  fs.writeFileSync(path.join(s.base, 'elsewhere.jsonl'), line(t, 'OUTSIDE') + '\n');
  const o = jbm(s, ['transcript', `--session=${SC}`]);
  assert.ok(!/OUTSIDE/.test(o.stdout));
  assert.match(o.stdout, /WARNING: no transcript found for session 33333333/);
  // Session A started 40 minutes ago; B checkpointed just now. A's
  // since-checkpoint still covers everything A said, because B's checkpoint
  // didn't save A's work.
  wh(J(s), '# H\n- by B\n', [`--session=${SB}`]);
  const st2 = stateOf(s);
  st2.sessions[SA] = { start: t - 40 * 60000, seen: t };
  fs.writeFileSync(path.join(s.memdir, '.jbmem-state.json'), JSON.stringify(st2));
  const sinceA = jbm(s, ['transcript', '--since=checkpoint', `--session=${SA}`]).stdout;
  assert.match(sinceA, /A EARLY[\s\S]*A LATE/);
  assert.match(sinceA, /this session's start \(no checkpoint by it yet\)/);
  // Once A checkpoints, its since-checkpoint starts there.
  wh(J(s), '# H\n- by B\n- by A\n', [`--session=${SA}`]);
  const afterA = jbm(s, ['transcript', '--since=checkpoint', `--session=${SA}`]).stdout;
  assert.ok(!/A EARLY|A LATE/.test(afterA), afterA);
  assert.match(afterA, /this session's last checkpoint/);
});

test('sessions: per-session drop files work and a leftover one is not a topic file', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const drop = path.join(s.memdir, `incoming-handoff-${SA}.md`);
  fs.writeFileSync(drop, '# H\n- from A\n');
  const w = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SA}`, `--from=${drop}`]);
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  assert.ok(!fs.existsSync(drop));
  // A refused write leaves the drop file for the merged text.
  const dropB = path.join(s.memdir, `incoming-handoff-${SB}.md`);
  fs.writeFileSync(dropB, '# H\n- from B\n');
  assert.strictEqual(jbm(s, ['write-handoff', '--base=none', `--session=${SB}`, `--from=${dropB}`]).status, 3);
  assert.ok(fs.existsSync(dropB));
  const pr = JSON.parse(jbm(s, ['prune-report', '--json']).stdout);
  assert.ok(!pr.orphans.some(o => o.startsWith('incoming-')), JSON.stringify(pr.orphans));
});

test('stdin: text that arrives late is still read (no EAGAIN)', async () => {
  const { spawn } = require('child_process');
  const s = sandbox();
  jbm(s, ['init']);
  const base = versionNow(J(s));
  const res = await Promise.all([1, 2, 3].map(i => new Promise((resolve) => {
    const args = i === 3 ? ['park', `--slug=late-${i}`] : ['write-handoff', `--base=${base}`];
    const c = spawn(process.execPath, [JBM, ...args], { cwd: s.repo, env: s.env });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    c.on('close', code => resolve({ i, code, out }));
    setTimeout(() => c.stdin.end(`# H\n- LATE ${i}\n`), 300 + i * 50);
  })));
  for (const r of res) assert.ok(!/EAGAIN|empty handoff/.test(r.out), r.out);
  assert.deepStrictEqual(res.map(r => r.code).sort(), [0, 0, 3], JSON.stringify(res));
  assert.ok(fs.existsSync(path.join(s.memdir, 'parked', 'late-3.md')));
});

// ---------- review fixes: the lock, Windows retries, undo, IDs, BOM, worktrees ----------

const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
const runAll = (s, specs, extraEnv = {}) => {
  const { spawn } = require('child_process');
  return Promise.all(specs.map(({ args, input }, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [JBM, ...args], { cwd: s.repo, env: { ...s.env, ...extraEnv } });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    c.on('close', code => resolve({ i, code, out }));
    c.stdin.end(input || '');
  })));
};

test('lock: keeps concurrent commands apart (with a pause inside each check-then-write)', async () => {
  const s = sandbox();
  jbm(s, ['init']);
  const hold = { JBMEM_TEST_HOLD_MS: '150' };
  const base = versionNow(J(s));
  const w = await runAll(s, [1, 2, 3, 4, 5, 6].map(i => ({ args: ['write-handoff', `--base=${base}`, `--session=5555555${i}-aaaa-4bbb-8ccc-00000000000${i}`], input: `# H\n- WRITER ${i}\n` })), hold);
  assert.deepStrictEqual(w.map(r => r.code).sort(), [0, 3, 3, 3, 3, 3], JSON.stringify(w, null, 1));
  const p = await runAll(s, [1, 2, 3, 4].map(i => ({ args: ['park', '--slug=same-idea'], input: `# Idea ${i}\n` })), hold);
  assert.deepStrictEqual(p.map(r => r.code).sort(), [0, 1, 1, 1], JSON.stringify(p, null, 1));
  const ids = [1, 2, 3, 4, 5, 6].map(i => `6666666${i}-aaaa-4bbb-8ccc-00000000000${i}`);
  const h = await runAll(s, ids.map(id => ({ args: ['--hook', 'session-start'], input: JSON.stringify({ cwd: s.repo, source: 'startup', session_id: id }) })), { JBMEM_TEST_HOLD_MS: '80' });
  assert.ok(h.every(r => r.code === 0));
  const st = stateOf(s);
  for (const id of ids) assert.ok(st.sessions[id] && st.sessions[id].start, `session ${id} recorded: ${JSON.stringify(Object.keys(st.sessions))}`);
  assert.ok(!fs.existsSync(path.join(s.memdir, '.jbmem.lock')));
});

test('lock: broken only when its holder is gone, and never waited on past the deadline', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const os = require('os');
  const HOST = String(os.hostname() || 'unknown').replace(/\s+/g, '_').slice(0, 64);
  const s = sandbox();
  jbm(s, ['init']);
  const lock = path.join(s.memdir, '.jbmem.lock');
  const age = (ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(lock, t, t); };
  const tryLock = (waitMs) => { const t0 = Date.now(); try { S.withLock(s.memdir, () => {}, { waitMs }); return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, code: e.code, msg: e.message, ms: Date.now() - t0 }; } };
  const locked = (r) => !r.ok && r.code === 'JBMEM_LOCKED' && r.ms >= 250 && r.ms < 2500;
  // A command that crashes while holding the lock leaves it behind, labeled.
  const crash = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'store.js'))}).withLock(${JSON.stringify(s.memdir)}, () => process.exit(7))`]);
  assert.strictEqual(crash.status, 7);
  assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^pid \\d+ host ${HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} since .* token [0-9a-f]+`));
  // Dead holder, under 5 s old: not broken yet. Over 5 s: broken at once.
  let r = tryLock(300);
  assert.ok(locked(r), JSON.stringify(r));
  age(6000);
  r = tryLock(3000);
  assert.ok(r.ok && r.ms < 1500, JSON.stringify(r));
  // Dead pid on another host: its pid means nothing here, so only age counts (60 s).
  fs.writeFileSync(lock, `pid ${deadPid()} host some-other-machine since then token far\n`);
  age(30000);
  assert.ok(locked(tryLock(300)));
  age(61000);
  assert.ok(tryLock(3000).ok);
  // Live holder (this process), fresh or 50 s old: waited on, then JBMEM_LOCKED, lock untouched.
  for (const ms of [0, 50000]) {
    fs.writeFileSync(lock, `pid ${process.pid} host ${HOST} since now token live\n`);
    age(ms);
    r = tryLock(300);
    assert.ok(locked(r) && /another trailmark command is using the memory folder \(lock: pid /.test(r.msg), JSON.stringify(r));
    assert.ok(fs.existsSync(lock));
  }
  // Live holder over 60 s old, or dated an hour in the future: broken.
  for (const ms of [61000, -3600000]) {
    fs.writeFileSync(lock, `pid ${process.pid} host ${HOST} since then token old\n`);
    age(ms);
    r = tryLock(3000);
    assert.ok(r.ok, `${ms}: ${JSON.stringify(r)}`);
  }
  // No label yet: young means a holder that just created it; over 30 s means it crashed first.
  fs.writeFileSync(lock, '');
  assert.ok(locked(tryLock(300)));
  age(31000);
  assert.ok(tryLock(3000).ok);
  // A break file left by a crash is cleaned up once it is old.
  fs.writeFileSync(lock, `pid ${deadPid()} host ${HOST} token dead\n`);
  age(10000);
  fs.writeFileSync(lock + '.break', '');
  const tb = new Date(Date.now() - 40000); fs.utimesSync(lock + '.break', tb, tb);
  assert.ok(tryLock(3000).ok);
  assert.ok(!fs.existsSync(lock + '.break') && !fs.existsSync(lock));
  // On Windows, a create refused with EPERM (a lock deleted while something
  // still had it open) is waited on like a held lock, not spun on forever,
  // and the error names the real cause when no lock file is there.
  const realOpen = fs.openSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  fs.openSync = (f, flags, ...rest) => { if (String(f).endsWith('.jbmem.lock') && flags === 'wx') { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realOpen(f, flags, ...rest); };
  try {
    r = tryLock(300);
  } finally {
    fs.openSync = realOpen;
    Object.defineProperty(process, 'platform', realPlatform);
  }
  assert.ok(locked(r) && /could not create the lock file .*EPERM/.test(r.msg), JSON.stringify(r));
});

test('windows retries: a rename refused for a moment is retried on win32 only, and a failed write leaves no temp file', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  let calls = 0;
  const flaky = () => { calls++; if (calls < 3) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return 'done'; };
  assert.strictEqual(S.retryWin(flaky, 'win32'), 'done');
  assert.strictEqual(calls, 3);
  calls = 0;
  assert.throws(() => S.retryWin(flaky, 'linux'), /EPERM/);
  assert.strictEqual(calls, 1);
  const always = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
  const t0 = Date.now();
  assert.throws(() => S.retryWin(always, 'win32'), /EBUSY/);
  assert.ok(Date.now() - t0 >= 1900 && Date.now() - t0 < 4000);
  assert.throws(() => S.retryWin(() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }, 'win32'), /ENOENT/);
  // atomicWrite removes its temp file when the rename fails for good.
  const d = realTemp('jbmem-aw-');
  fs.mkdirSync(path.join(d, 'target.md')); // a folder where the file should go: the rename fails
  assert.throws(() => S.atomicWrite(path.join(d, 'target.md'), 'x'));
  assert.deepStrictEqual(fs.readdirSync(d), ['target.md']);
});

test('undo: only the session that wrote the current version; the replaced version is kept; a failed state write makes undo refuse', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const handoffFile = path.join(s.memdir, 'handoff.md');
  // Written by a session with no ID: no session may undo it without --force.
  wh(J(s), '# H\n- NO ID WRITE\n');
  let u = jbm(s, ['undo-handoff', `--session=${SA}`]);
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /written by a session that gave no ID, not this session/);
  // A writes, A undoes: allowed, and the version it replaced is in the history.
  wh(J(s), '# H\n- A WROTE THIS\n', [`--session=${SA}`]);
  u = jbm(s, ['undo-handoff', `--session=${SA}`]);
  assert.strictEqual(u.status, 0, u.stderr);
  assert.match(fs.readFileSync(handoffFile, 'utf8'), /NO ID WRITE/);
  const hdir = path.join(s.memdir, 'archive', 'handoff-history');
  assert.ok(fs.readdirSync(hdir).some(f => fs.readFileSync(path.join(hdir, f), 'utf8').includes('A WROTE THIS')), 'the undone version is in the history');
  // A writes, B writes, B undoes (back to A's version). A's undo must not
  // bring back B's discarded text: handoff.prev.md isn't what A replaced.
  wh(J(s), '# H\n- A FIRST\n', [`--session=${SA}`]);
  wh(J(s), '# H\n- B DISCARDED\n', [`--session=${SB}`]);
  assert.strictEqual(jbm(s, ['undo-handoff', `--session=${SB}`]).status, 0);
  u = jbm(s, ['undo-handoff', `--session=${SA}`]);
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /handoff\.prev\.md is not the version this session replaced/);
  assert.match(fs.readFileSync(handoffFile, 'utf8'), /A FIRST/);
  // A hand edit after A's write: not A's version any more.
  wh(J(s), '# H\n- A AGAIN\n', [`--session=${SA}`]);
  fs.appendFileSync(handoffFile, '- edited by hand\n');
  u = jbm(s, ['undo-handoff', `--session=${SA}`]);
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /not recorded as this session's write/);
  // The state file can't be saved: the write still lands, says so, and undo refuses.
  const stateFile = path.join(s.memdir, '.jbmem-state.json');
  fs.rmSync(stateFile, { force: true });
  fs.mkdirSync(path.join(stateFile, 'blocker'), { recursive: true });
  const w = jbm(s, ['write-handoff', `--base=${versionNow(J(s))}`, `--session=${SB}`], '# H\n- B WROTE THIS\n');
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /WARNING: the state file could not be updated/);
  assert.match(fs.readFileSync(handoffFile, 'utf8'), /B WROTE THIS/);
  u = jbm(s, ['undo-handoff', `--session=${SB}`]);
  assert.strictEqual(u.status, 1);
  fs.rmSync(stateFile, { recursive: true, force: true });
});

test('session IDs: only UUIDs count; a made-up or unsubstituted ID is no ID', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  for (const bad of ['current-session', '${CLAUDE_SESSION_ID}', '', 'abcdefgh', '11111111-aaaa-4bbb-8ccc-00000000000', '../../11111111-aaaa-4bbb-8ccc-000000000001']) assert.strictEqual(S.cleanSession(bad), '', bad);
  assert.strictEqual(S.cleanSession('ABCDEF12-aaaa-4bbb-8ccc-000000000001'), 'abcdef12-aaaa-4bbb-8ccc-000000000001');
  const s = sandbox();
  jbm(s, ['init']);
  const w = wh(J(s), '# H\n- x\n', ['--session=current-session']);
  assert.strictEqual(w.status, 0, w.stderr);
  assert.ok(!/\| session /.test(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8')));
  assert.strictEqual(jbm(s, ['undo-handoff', '--session=current-session']).status, 1);
});

test('BOM: text from Windows PowerShell 5.1 with a byte order mark gets one frontmatter block', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const drop = path.join(s.memdir, 'incoming-handoff.md');
  fs.writeFileSync(drop, '\uFEFF---\r\nname: handoff\r\ndescription: x\r\ntype: project\r\n---\r\n# H\r\n- with bom\r\n');
  assert.strictEqual(wh(J(s), undefined, [`--from=${drop}`]).status, 0);
  const t = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  assert.ok(!t.includes('\uFEFF'));
  assert.strictEqual((t.match(/^---$/gm) || []).length, 2, t);
  assert.strictEqual(jbm(s, ['park', '--slug=bom-idea'], '\uFEFF# Idea\nwhy\n').status, 0);
  assert.ok(fs.readFileSync(path.join(s.memdir, 'parked', 'bom-idea.md'), 'utf8').startsWith('---\nname: bom-idea'));
});

test('snapshots: a fresh session sees another session\'s snapshot only from its own folder', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const wt = path.join(s.repo, '.claude', 'worktrees', 'feat');
  s.g('worktree', 'add', '-q', '-b', 'feat', wt);
  wh(J(s), '# H\n- state\n', [`--session=${SA}`]);
  const past = new Date(Date.now() - 600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), past, past);
  assert.strictEqual(jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: wt, trigger: 'auto', session_id: SA })).status, 0);
  assert.match(fs.readFileSync(path.join(s.memdir, 'snapshots', `${SA}.md`), 'utf8'), /^worktree: .*feat$/m);
  const inRepo = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SC })).stdout).hookSpecificOutput.additionalContext;
  assert.ok(!/COMPACTION SNAPSHOT/.test(inRepo), 'a snapshot from the feat worktree is not shown in the main checkout');
  const inWt = JSON.parse(jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: wt, source: 'startup', session_id: SB })).stdout).hookSpecificOutput.additionalContext;
  assert.match(inWt, /COMPACTION SNAPSHOT \(session 11111111 compacted after the last checkpoint\)/);
  assert.match(inWt, /Branch: feat/);
});

test('strict reads: a file that can\'t be read stops the write instead of being replaced', () => {
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- [done] ITEM-ONE\n- live\n', [`--session=${SA}`]);
  const archDir = path.join(s.memdir, 'archive');
  const archFile = path.join(archDir, fs.readdirSync(archDir).find(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)));
  const archBefore = fs.readFileSync(archFile, 'utf8');
  const handoffBefore = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  const stateBefore = fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8');
  const realRead = fs.readFileSync;
  const realOpen = fs.openSync;
  // Reads go through a descriptor (only a plain file is read), so the open fails.
  const failOn = (target) => {
    const busy = (f) => { if (typeof f !== 'number' && path.resolve(String(f)) === target) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } };
    fs.readFileSync = (f, ...rest) => { busy(f); return realRead(f, ...rest); };
    fs.openSync = (f, ...rest) => { busy(f); return realOpen(f, ...rest); };
  };
  try {
    failOn(archFile);
    assert.throws(() => S.writeHandoff(s.memdir, '# H\n- [done] ITEM-TWO\n- live\n', 'repo', null, { base: S.versionOf(handoffBefore), session: SA }), /EBUSY/);
    failOn(path.join(s.memdir, '.jbmem-state.json'));
    assert.throws(() => S.updateState(s.memdir, SB, (st) => { st.junk = 1; }), /EBUSY/);
  } finally {
    fs.readFileSync = realRead;
    fs.openSync = realOpen;
  }
  assert.strictEqual(fs.readFileSync(archFile, 'utf8'), archBefore, 'archive untouched');
  assert.strictEqual(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'), handoffBefore, 'handoff untouched');
  assert.strictEqual(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8'), stateBefore, 'state untouched');
  assert.ok(!fs.existsSync(path.join(s.memdir, '.jbmem.lock')));
  // A state file that isn't JSON is set aside, not silently lost.
  fs.writeFileSync(path.join(s.memdir, '.jbmem-state.json'), '{not json');
  S.updateState(s.memdir, SB, () => {});
  assert.strictEqual(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json.bad'), 'utf8'), '{not json');
});

// The launcher stops a hook's script at its time limit (trailmark.js: 4.5 s
// for commit-start, 9 s for the others) and says so on stderr. On a machine
// with every core busy that is the designed outcome, not a fault: the hook is
// run again, and after 3 stops in a row the test is skipped with the reason.
// Any other exit is left to the caller's asserts. With the lock busy, a stop
// may be the lock's own fault (a wait past its bound), so the hook is then
// run once with the lock free. If that run left room for the lock's wait
// (2 s, store.js) inside the 9 s limit, with 1 s to spare, the lock cost more
// than its wait and the test fails; a slower free run says nothing either way.
const HOOK_STOPPED = /took too long and was stopped/;
const ROOM_FOR_LOCK_MS = 9000 - 2000 - 1000;
class HookOutOfTime extends Error {}
const stopped = r => r.status === 1 && HOOK_STOPPED.test(r.stderr);
function hookInTime(call, what, { tries = 3, unlocked } = {}) {
  for (let i = 1; ; i++) {
    const r = call();
    if (!stopped(r)) return r;
    if (i < tries) continue;
    if (unlocked) {
      const t0 = Date.now();
      const free = unlocked();
      const took = Date.now() - t0;
      if (!stopped(free) && took < ROOM_FOR_LOCK_MS) assert.fail(`${what}: stopped ${i} times in a row with the lock busy, but took ${took} ms with it free: a busy lock cost the hook more than its 2 s wait`);
    }
    throw new HookOutOfTime(`${what}: the launcher stopped the hook at its time limit ${i} times in a row: this machine is too slow now`);
  }
}

test('hooks: a busy lock costs the reminder, never the commit log line; a payload with a BOM still parses', (t) => {
  try {
    const s = sandbox();
    jbm(s, ['init']);
    const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
    const lock = path.join(s.memdir, '.jbmem.lock');
    fs.writeFileSync(lock, `pid ${process.pid} host x since now token busy\n`);
    // The subagent hook with the lock free, for hookInTime; the test ends after a call to it.
    const free = () => { fs.rmSync(lock, { force: true }); return jbm(s, ['--hook', 'milestone', 'subagent'], JSON.stringify({ cwd: s.repo, session_id: SA, tool_input: {}, tool_response: {} })); };
    // What a busy lock costs a hook: its one updateState (hook-milestone.js,
    // the default wait of 2 s) gives up after that wait. Timed here, in this
    // process: the hook's own run time is mostly starting node and git, which
    // the machine's load decides (4 to 10 s with every core busy, about 3 s
    // idle), and says nothing about the wait.
    const t0 = Date.now();
    assert.throws(() => S.updateState(s.memdir, SA, (st) => { st.junk = 1; }), (e) => e.code === 'JBMEM_LOCKED');
    const waited = Date.now() - t0;
    assert.ok(waited < 4000, `updateState waited ${waited} ms on a busy lock`);
    fs.writeFileSync(path.join(s.repo, 'q'), 'q'); s.g('add', 'q'); s.g('commit', '-qm', 'logged while busy');
    const m = hookInTime(() => jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SA, tool_input: { command: 'git commit -m q' }, tool_response: {} })), 'the commit hook', { unlocked: free });
    assert.strictEqual(m.status, 0, m.stderr);
    assert.match(notesOf(s), /COMMIT [0-9a-f]+ logged while busy session=11111111/);
    // A subagent result with the lock busy: no reminder and no log line of any kind.
    const before = notesOf(s);
    const sub = hookInTime(() => jbm(s, ['--hook', 'milestone', 'subagent'], JSON.stringify({ cwd: s.repo, session_id: SA, tool_input: {}, tool_response: {} })), 'the subagent hook', { unlocked: free });
    assert.strictEqual(sub.status, 0, sub.stderr);
    assert.strictEqual(sub.stdout, '');
    assert.strictEqual(notesOf(s), before);
    fs.unlinkSync(lock);
    const st = hookInTime(() => jbm(s, ['--hook', 'session-start'], '\uFEFF' + JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SB })), 'the session-start hook');
    assert.strictEqual(st.status, 0, st.stderr);
    assert.ok(stateOf(s).sessions[SB], 'the session with a BOM-prefixed payload was recorded');
  } catch (e) {
    if (!(e instanceof HookOutOfTime)) throw e;
    t.skip(e.message);
  }
});

test('slow git: hooks finish well inside Claude Code\'s timeout when git hangs, and still inject', { skip: POSIX_ONLY }, () => {
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- SLOW GIT STATE\n', [`--session=${SA}`]);
  const bin = realTemp('jbmem-slowgit-');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  let t0 = Date.now();
  const st = jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SB }), env);
  const startMs = Date.now() - t0;
  assert.strictEqual(st.status, 0, st.stderr);
  assert.ok(startMs < 8000, `session-start took ${startMs} ms`);
  assert.match(JSON.parse(st.stdout).hookSpecificOutput.additionalContext, /SLOW GIT STATE/);
  t0 = Date.now();
  const pc = jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: SB }), env);
  const pcMs = Date.now() - t0;
  assert.strictEqual(pc.status, 0, pc.stderr);
  assert.ok(pcMs < 8000, `precompact took ${pcMs} ms`);
  assert.match(fs.readFileSync(path.join(s.memdir, 'snapshots', `${SB}.md`), 'utf8'), new RegExp(`^worktree: ${s.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('milestone: concurrent hooks for one commit log it once', async () => {
  const s = sandbox();
  jbm(s, ['init']);
  fs.writeFileSync(path.join(s.repo, 'once'), '1'); s.g('add', 'once'); s.g('commit', '-qm', 'logged once');
  const payload = (sid) => JSON.stringify({ cwd: s.repo, session_id: sid, tool_input: { command: 'git commit -m once' }, tool_response: {} });
  const r = await runAll(s, [SA, SB, SC, SA].map(sid => ({ args: ['--hook', 'milestone', 'commit'], input: payload(sid) })), { JBMEM_TEST_HOLD_MS: '100' });
  assert.ok(r.every(x => x.code === 0));
  assert.strictEqual((notesOf(s).match(/COMMIT [0-9a-f]+ logged once/g) || []).length, 1, notesOf(s));
});

test('state file: null, an array, a sessions list or a BOM are handled without losing the session', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const stateFile = path.join(s.memdir, '.jbmem-state.json');
  for (const bad of ['null', '[]', '{"sessions":[]}', '\uFEFF{"lastCommit":"abc","sessions":{}}']) {
    fs.writeFileSync(stateFile, bad);
    const h = jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA }));
    assert.strictEqual(h.status, 0, `${bad}: ${h.stderr}`);
    assert.match(JSON.parse(h.stdout).hookSpecificOutput.additionalContext, /BEGIN HANDOFF/, bad);
    const w = wh(J(s), `# H\n- after ${bad.length}\n`, [`--session=${SA}`]);
    assert.strictEqual(w.status, 0, `${bad}: ${w.stderr}`);
    assert.ok(!/WARNING/.test(w.stdout), `${bad}: ${w.stdout}`);
    const u = jbm(s, ['undo-handoff', `--session=${SA}`]);
    assert.strictEqual(u.status, 0, `${bad}: ${u.stderr}`);
  }
  // The BOM-prefixed state kept its content rather than being set aside.
  assert.strictEqual(stateOf(s).lastCommit, 'abc');
});

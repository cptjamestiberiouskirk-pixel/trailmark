// Run: node --test tests/basics.test.js
// Paths, opt-in, the handoff and its budget, session start, milestone hints,
// the transcript, and the sandbox launcher.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, CLI, sandbox, wh, J, JBM, jbm, cp, tick } = require('./helpers.js');

test('paths: Windows-style comparison and candidate keys', () => {
  const { samePath, candidateKeys } = require('../scripts/lib/paths');
  assert.ok(samePath('C:\\Users\\Ann\\Repo', 'c:/users/ann/repo/', 'win32'));
  assert.ok(!samePath('/a/b', '/a/B', 'linux'));
  assert.strictEqual(candidateKeys('C:\\Users\\ann\\game-port')[0], 'C--Users-ann-game-port');
  assert.strictEqual(candidateKeys('/home/u/my.repo')[0], '-home-u-my-repo');
});

test('paths: worktree resolves to the main checkout memory dir', () => {
  const s = sandbox();
  const wt = path.join(s.repo, '.claude', 'worktrees', 'feat');
  s.g('worktree', 'add', '-q', '-b', 'feat', wt);
  const r = spawnSync(process.execPath, [CLI, 'dir', '--json'], { cwd: wt, env: s.env, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(r.stdout).dir, s.memdir);
});

test('paths: scan finds the project folder from a transcript cwd when the key rule differs', () => {
  const s = sandbox();
  const odd = path.join(s.cfg, 'projects', 'some-other-encoding');
  fs.renameSync(s.projectDir, odd);
  fs.writeFileSync(path.join(odd, 'x.jsonl'), JSON.stringify({ type: 'user', cwd: s.repo, message: { content: 'hi' } }) + '\n');
  const r = s.cli(['dir', '--json']);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.method, 'scan');
  assert.strictEqual(out.dir, path.join(odd, 'memory'));
});

test('opt-in: write commands refuse and hooks stay silent before setup', () => {
  const s = sandbox();
  assert.strictEqual(s.cli(['note', 'x']).status, 1);
  const h = s.hook('hook-session-start.js', { source: 'startup' });
  assert.strictEqual(h.status, 0);
  assert.strictEqual(h.stdout, '');
  assert.ok(!fs.existsSync(path.join(s.memdir, 'notes')));
});

test('handoff: write keeps prev and archives [done] items verbatim, once; rotate does the same for a hand edit', () => {
  const s = sandbox();
  s.cli(['init']);
  const body = '# H\n## State\n- [done] shipped A\n  - detail A\n- doing B\n## Next\n1. [DONE] old\n2. do C\n';
  const w = wh(s.cli, body);
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /\[done\] items: 2 archived verbatim to archive[\\/]\d{4}-\d{2}-\d{2}\.md/);
  assert.ok(fs.existsSync(path.join(s.memdir, 'handoff.prev.md')));
  const handoffFile = path.join(s.memdir, 'handoff.md');
  const h = fs.readFileSync(handoffFile, 'utf8');
  assert.ok(!/done/i.test(h));
  assert.match(h, /- doing B/);
  const arch = fs.readdirSync(path.join(s.memdir, 'archive')).find(f => f.endsWith('.md'));
  const archFile = path.join(s.memdir, 'archive', arch);
  assert.match(fs.readFileSync(archFile, 'utf8'), /- \[done\] shipped A\n  - detail A\n1\. \[DONE\] old/);
  // The same [done] item sent again (a tightened rewrite of the same draft) is not archived twice.
  const again = wh(s.cli, body.replace('2. do C', '2. do C, tighter'));
  assert.match(again.stdout, /0 archived verbatim .*2 already archived today/);
  assert.strictEqual((fs.readFileSync(archFile, 'utf8').match(/shipped A/g) || []).length, 1);
  assert.ok(!/done/i.test(fs.readFileSync(handoffFile, 'utf8')));
  // rotate archives items in a handoff edited by hand.
  fs.writeFileSync(handoffFile, fs.readFileSync(handoffFile, 'utf8') + '- [done] edited in by hand\n');
  assert.match(s.cli(['rotate']).stdout, /Archived 1 item/);
  assert.match(fs.readFileSync(archFile, 'utf8'), /edited in by hand/);
  // Undo without a session ID needs --force.
  const u = s.cli(['undo-handoff']);
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /needs --session/);
  assert.strictEqual(s.cli(['undo-handoff', '--force']).status, 0);
  assert.match(fs.readFileSync(handoffFile, 'utf8'), /edited in by hand/);
});

test('handoff history: several writes in one session keep the original, capped at 20, out of search', () => {
  const s = sandbox();
  s.cli(['init']);
  wh(s.cli, '# H\n- ORIGINAL-STATE\n');
  for (let i = 0; i < 25; i++) wh(s.cli, `# H\n- version ${i}\n`);
  const hdir = path.join(s.memdir, 'archive', 'handoff-history');
  const files = fs.readdirSync(hdir);
  assert.strictEqual(files.length, 20);
  const s2 = sandbox();
  s2.cli(['init']);
  wh(s2.cli, '# H\n- ORIGINAL-STATE\n');
  wh(s2.cli, '# H\n- second\n');
  wh(s2.cli, '# H\n- third\n');
  const h2 = path.join(s2.memdir, 'archive', 'handoff-history');
  assert.ok(fs.readdirSync(h2).some(f => fs.readFileSync(path.join(h2, f), 'utf8').includes('ORIGINAL-STATE')));
  assert.ok(!fs.readFileSync(path.join(s2.memdir, 'handoff.prev.md'), 'utf8').includes('ORIGINAL-STATE'), 'prev is one level deep');
  assert.match(s2.cli(['list', 'history']).stdout, /handoff-history\/handoff-/);
  const hits = s2.cli(['search', 'ORIGINAL-STATE']).stdout;
  assert.ok(!hits.includes('handoff-history'), 'history copies stay out of search');
});

test('budget: over-budget handoff exits 2 and injection is truncated under the cap', () => {
  const s = sandbox();
  s.cli(['init']);
  const big = '# H\n' + Array.from({ length: 400 }, (_, i) => `- line ${i} ${'x'.repeat(60)}`).join('\n');
  assert.strictEqual(wh(s.cli, big).status, 2);
  const h = s.hook('hook-session-start.js', { source: 'startup' });
  const ctx = JSON.parse(h.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 9000, `injection ${ctx.length} chars`);
  assert.match(ctx, /\[truncated:/);
  assert.match(JSON.parse(h.stdout).systemMessage, /TRUNCATED/);
});

test('session start: resume does not re-inject; compact adds snapshot and reminder', () => {
  const s = sandbox();
  s.cli(['init']);
  wh(s.cli, '# H\n- state\n');
  const resume = JSON.parse(s.hook('hook-session-start.js', { source: 'resume' }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(!resume.includes('BEGIN HANDOFF'));
  const past = new Date(Date.now() - 600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), past, past);
  s.hook('hook-precompact.js', { trigger: 'auto' });
  const c = JSON.parse(s.hook('hook-session-start.js', { source: 'compact' }).stdout).hookSpecificOutput.additionalContext;
  assert.match(c, /COMPACTION SNAPSHOT/);
  assert.match(c, /compaction just ran/);
  assert.match(c, /run the tm-checkpoint skill now/);
  assert.match(c, /don't look for or run another trailmark\.js/);
  // The Codex text names the plugin's own folder, whose path may hold "init"
  // (a checkout named that way): only the rest is checked.
  assert.ok(!/init/.test(c.split('COMPACTION SNAPSHOT')[1].split(ROOT).join('')), 'snapshot must not carry commit subjects');
});

test('milestone: hint after a new commit, throttled, silent when checkpoint is fresh', () => {
  const s = sandbox();
  s.cli(['init']);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  fs.writeFileSync(path.join(s.repo, 'b'), 'b'); s.g('add', 'b'); s.g('commit', '-qm', 'second');
  const p = { tool_input: { command: 'git commit -m second' }, tool_response: { stdout: 'ok' } };
  const first = s.hook('hook-milestone.js', p, ['commit']);
  const hint = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
  assert.match(hint, /checkpoint skill/);
  // 0.3.6: plain "checkpoint" is Claude Code's /rewind, so the reminder names
  // the skill in full and says what to do when it won't load.
  assert.match(hint, /run the tm-checkpoint skill/);
  assert.ok(hint.includes(path.join(ROOT, 'skills', 'tm-checkpoint', 'SKILL.md')), hint);
  assert.match(hint, /don't look for or run another trailmark\.js/);
  fs.writeFileSync(path.join(s.repo, 'c'), 'c'); s.g('add', 'c'); s.g('commit', '-qm', 'third');
  assert.strictEqual(s.hook('hook-milestone.js', p, ['commit']).stdout, '', 'throttled');
  const notes = fs.readdirSync(path.join(s.memdir, 'notes')).map(f => fs.readFileSync(path.join(s.memdir, 'notes', f), 'utf8')).join('');
  assert.match(notes, /COMMIT [0-9a-f]+ second/);
  assert.match(notes, /COMMIT [0-9a-f]+ third/);
  const failed = { tool_input: { command: 'git commit -m x' }, tool_response: { exit_code: 1 } };
  assert.strictEqual(s.hook('hook-milestone.js', failed, ['commit']).stdout, '');
});

test('safety: archive-file stays inside the memory dir; park validates slugs', () => {
  const s = sandbox();
  s.cli(['init']);
  assert.strictEqual(s.cli(['archive-file', '../../outside.md']).status, 1);
  assert.strictEqual(s.cli(['archive-file', 'handoff.md']).status, 1);
  assert.strictEqual(s.cli(['park', '--slug=../evil'], 'x').status, 1);
  assert.strictEqual(s.cli(['park', '--slug=good-idea'], '# Good idea\nWhy it matters').status, 0);
  assert.strictEqual(s.cli(['park', '--slug=good-idea'], 'again').status, 1);
  fs.writeFileSync(path.join(s.memdir, 'feedback_x.md'), '---\nname: x\ndescription: d\n---\nbody\n');
  fs.writeFileSync(path.join(s.memdir, 'MEMORY.md'), '# Memory\n- [X](feedback_x.md) -- d\n- [Y](other.md) -- e\n');
  const r = s.cli(['archive-file', 'feedback_x.md']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.readFileSync(path.join(s.memdir, 'MEMORY.md'), 'utf8').includes('feedback_x.md'));
  assert.ok(fs.existsSync(path.join(s.memdir, 'archive', 'files', 'feedback_x.md')));
});

test('prune-report flags dead links, orphans and stale files', () => {
  const s = sandbox();
  s.cli(['init']);
  fs.writeFileSync(path.join(s.memdir, 'MEMORY.md'), '- [Gone](gone.md) -- x\n- [Live](live.md) -- y\n');
  fs.writeFileSync(path.join(s.memdir, 'live.md'), '---\nname: live\ndescription: same\nmodified: 2025-01-01T00:00:00Z\n---\n');
  fs.writeFileSync(path.join(s.memdir, 'orphan.md'), '---\nname: o\ndescription: same\n---\n');
  const r = JSON.parse(s.cli(['prune-report', '--json']).stdout);
  assert.deepStrictEqual(r.deadLinks, ['gone.md']);
  assert.deepStrictEqual(r.orphans, ['orphan.md']);
  assert.ok(r.stale.some(x => x.file === 'live.md'));
  assert.strictEqual(r.duplicates.length, 1);
});

// ---------- sandbox launcher ----------

test('launcher: sandbox self-check passes on this machine', () => {
  const r = spawnSync(process.execPath, [JBM, '--sandbox-check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SANDBOX OK/);
  assert.strictEqual((r.stdout.match(/PASS/g) || []).length, 5);
});

test('launcher: CLI commands work under the sandbox and report it', () => {
  const s = sandbox();
  assert.strictEqual(jbm(s, ['init']).status, 0);
  const w = wh(J(s), '# H\n- [done] old\n- live state\n');
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /\[done\] items: 1 archived/);
  assert.match(jbm(s, ['rotate']).stdout, /No \[done\] items/);
  assert.match(jbm(s, ['dir']).stdout, /sandbox: on/);
  assert.match(jbm(s, ['budget']).stdout, /handoff\.md/);
  assert.strictEqual(jbm(s, ['park', '--slug=idea-one'], '# Idea\nwhy').status, 0);
  assert.match(jbm(s, ['search', 'live state']).stdout, /handoff\.md/);
});

test('launcher: read commands answer before memory/ exists, with or without the project folder', () => {
  const s = sandbox();
  assert.ok(!fs.existsSync(s.memdir));
  const d = jbm(s, ['dir']);
  assert.strictEqual(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /set up: false/);
  assert.match(d.stdout, /sandbox: on/);
  assert.match(jbm(s, ['status']).stdout, /NOT set up/);
  fs.rmSync(s.projectDir, { recursive: true });
  const u = jbm(s, ['dir']);
  assert.strictEqual(u.status, 0, u.stdout + u.stderr);
  assert.match(u.stdout, /formula-unverified/);
  assert.ok(!fs.existsSync(s.memdir), 'a read command must not create anything');
});

test('launcher: init --force sets up a repo Claude Code has never opened; without --force it leaves nothing', () => {
  const s = sandbox();
  fs.rmSync(s.projectDir, { recursive: true });
  const r = jbm(s, ['init']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /could not confirm/);
  assert.ok(!fs.existsSync(s.projectDir), 'a refused init must not leave a project folder that would count as verified');
  const e = jbm(s, ['init', '--', '--force']);
  assert.notStrictEqual(e.status, 0, 'a --force after a lone -- is text, not a flag');
  assert.ok(!fs.existsSync(s.projectDir));
  const f = jbm(s, ['init', '--force']);
  assert.strictEqual(f.status, 0, f.stdout + f.stderr);
  assert.ok(fs.existsSync(path.join(s.memdir, 'handoff.md')));
  assert.match(jbm(s, ['dir']).stdout, /set up: true/);
  const n = jbm(s, ['note', 'after setup']);
  assert.strictEqual(n.status, 0, n.stdout + n.stderr);
});

// The launcher gives a hook's git calls about 5 s (trailmark.js). A hook
// whose git ran out of that time (a busy machine) leaves a git-timeout marker.
// lateAgain makes such a call again, up to 3 tries in all, and returns the
// reason when git ran out in every one, else ''.
const lateAgain = (call, sign) => {
  for (let i = 1; ; i++) {
    const m = sign();
    if (!m) return '';
    if (i === 3) return `git ran out of the launcher's time in ${i} tries in a row (${m}): git is too slow on this machine now`;
    tick();
    call();
  }
};

test('launcher: hooks run sandboxed with launcher-collected git facts', (t) => {
  const s = sandbox();
  jbm(s, ['init']);
  wh(J(s), '# H\n- state\n');
  const start = jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup' }));
  const out = JSON.parse(start.stdout);
  // Codex gets the status line only with a warning (an old Node gives one).
  assert.ok(!out.systemMessage || /sandbox on/.test(out.systemMessage), out.systemMessage);
  assert.match(out.hookSpecificOutput.additionalContext, /BEGIN HANDOFF/);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  fs.writeFileSync(path.join(s.repo, 'z'), 'z'); s.g('add', 'z'); s.g('commit', '-qm', 'zed commit');
  const readNotes = () => fs.readdirSync(path.join(s.memdir, 'notes')).map(f => fs.readFileSync(path.join(s.memdir, 'notes', f), 'utf8')).join('');
  const timeouts = () => (readNotes().match(/COMMIT_UNRESOLVED why=git-timeout/g) || []).length;
  let before = 0;
  const milestone = () => { before = timeouts(); return jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, tool_input: { command: 'git commit -m zed' }, tool_response: {} })); };
  const m = milestone();
  assert.match(JSON.parse(m.stdout).hookSpecificOutput.additionalContext, /checkpoint skill/);
  let late = lateAgain(milestone, () => timeouts() > before && 'COMMIT_UNRESOLVED why=git-timeout');
  if (late) return t.skip(late);
  const snap = require('../scripts/lib/store').snapshotPath(s.memdir, '');
  const precompact = () => { fs.rmSync(snap, { force: true }); assert.strictEqual(jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto' })).status, 0); };
  precompact();
  late = lateAgain(precompact, () => { try { return /not read \(git-timeout\)/.test(fs.readFileSync(snap, 'utf8')) && 'Uncommitted files: not read (git-timeout)'; } catch { return ''; } });
  if (late) return t.skip(late);
  const notes = readNotes();
  assert.match(notes, /SESSION_START source=startup branch=\S+/);
  assert.match(notes, /COMMIT [0-9a-f]+ zed commit/);
  assert.match(notes, /PRE_COMPACT trigger=auto branch=\S+ head=[0-9a-f]+ uncommitted=0/);
});

test('launcher: a sandboxed script that strays outside the memory folder is refused and reported', () => {
  const s = sandbox();
  jbm(s, ['init']);
  // archive-file validates paths itself, so call the store directly through a crafted
  // MEMORY.md link that points outside: prune-report only reads, so instead prove the
  // seat belt with JBMEM_DIR pointing the child at the memory folder while asking it to
  // write a note into a folder that is not granted.
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  const probe = path.join(s.base, 'probe.js');
  fs.writeFileSync(probe, `require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'store.js'))}).note(${JSON.stringify(outside)}, 'x');`);
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${s.base}`, `--allow-fs-write=${s.memdir}`, probe], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /ERR_ACCESS_DENIED/);
  assert.ok(!fs.existsSync(path.join(outside, 'notes')));
});

test('commands: what counts as a commit or a PR merge', () => {
  const { isMilestoneCommand: m } = require(path.join(ROOT, 'scripts', 'lib', 'commands.js'));
  for (const c of [
    'git commit -m x',
    'git -C . commit --allow-empty -m "x"',
    'git -C "E:/Code/Projects/game-port" commit -m x',
    "git -c user.name='Ann B' commit -m y",
    'cd /r && git commit -am "fix"',
  ]) assert.ok(m('commit', c), c);
  for (const c of ['git -C . status', 'git -C "E:/a b" log --oneline', 'git -C . commit-tree abc', 'git status']) assert.ok(!m('commit', c), c);
  assert.ok(m('pr-merge', 'gh pr merge 12 --squash'));
  assert.ok(m('pr-merge', 'gh pr merge 12 --subject "how -h works" --squash'), 'a quoted -h is not the flag');
  assert.ok(m('pr-merge', 'gh pr merge 12 --squash && gh pr view --help'), 'help in another segment does not cancel the merge');
  for (const c of ['gh pr view 12', 'gh pr merge --help', 'gh pr merge -h', 'gh pr merge --help | head -n 3', 'gh pr merge 12 --help'])
    assert.ok(!m('pr-merge', c), c);
  assert.ok(m('subagent', ''));
  assert.ok(!m('nonsense', 'git commit -m x'));
  const t = Date.now();
  m('commit', 'git ' + '-a "b c" '.repeat(20000) + 'status');
  assert.ok(Date.now() - t < 500, 'a long command must not stall the hook');
});

test('session start: log line records sandbox state, node and entry point; status shows the latest', () => {
  const s = sandbox();
  jbm(s, ['init']);
  assert.match(jbm(s, ['status']).stdout, /last session start: none logged yet/);
  const r = jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup' }), {});
  assert.strictEqual(r.status, 0, r.stderr);
  const st = jbm(s, ['status']).stdout;
  assert.match(st, /last session start: \d{4}-\d{2}-\d{2} \d{2}:\d{2} SESSION_START source=startup branch=\S+ sandbox=on host=codex node=v\d+\.\d+\.\d+ exec=\S/);
  assert.ok(st.includes(`exec=${process.execPath}`));
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'clear' }), { JBMEM_SANDBOX: 'off' });
  assert.match(jbm(s, ['status']).stdout, /SESSION_START source=clear branch=\S+ sandbox=off\(JBMEM_SANDBOX=off\) host=codex node=/);
});

test('launcher: git -C commits are logged; other git -C commands leave before any git work', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(s.memdir, 'handoff.md'), old, old);
  s.g('commit', '--allow-empty', '-qm', 'dash c');
  const m = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, tool_input: { command: 'git -C . commit --allow-empty -m "dash c"' }, tool_response: {} }));
  assert.match(JSON.parse(m.stdout).hookSpecificOutput.additionalContext, /Commit landed/);
  const notes = () => fs.readdirSync(path.join(s.memdir, 'notes')).map(f => fs.readFileSync(path.join(s.memdir, 'notes', f), 'utf8')).join('');
  assert.match(notes(), /COMMIT [0-9a-f]+ dash c/);
  // Record every process the launcher would start, then feed it a non-commit.
  const log = path.join(s.base, 'spawned.txt');
  const spy = path.join(s.base, 'spy.js');
  fs.writeFileSync(spy, `const cp=require('child_process'),fs=require('fs');for(const k of ['spawnSync','execFileSync','execSync','spawn','execFile','exec']){const o=cp[k];cp[k]=function(...a){fs.appendFileSync(${JSON.stringify(log)},k+' '+a[0]+'\\n');return o.apply(this,a)}}`);
  const before = notes();
  const q = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, tool_input: { command: 'git -C . status' }, tool_response: {} }), { NODE_OPTIONS: `--require ${spy}` });
  assert.strictEqual(q.status, 0);
  assert.strictEqual(q.stdout, '');
  assert.ok(!fs.existsSync(log), 'no git call and no child process: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
  assert.strictEqual(notes(), before);
  // A help call to gh pr merge leaves no PR_MERGE line and no reminder. The
  // throttle goes off first, since the commit above just sent a reminder.
  const cfgFile = path.join(s.memdir, '.jbmem.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), hints: { minMinutesBetween: 0, freshCheckpointMinutes: 0 } }));
  const h = jbm(s, ['--hook', 'milestone', 'pr-merge'], JSON.stringify({ cwd: s.repo, tool_input: { command: 'gh pr merge --help' }, tool_response: {} }));
  assert.strictEqual(h.stdout, '');
  assert.ok(!/PR_MERGE/.test(notes()));
  const r = jbm(s, ['--hook', 'milestone', 'pr-merge'], JSON.stringify({ cwd: s.repo, tool_input: { command: 'gh pr merge 1 --squash' }, tool_response: {} }));
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PR merge command finished/);
  assert.match(notes(), /PR_MERGE gh pr merge 1 --squash/);
});

test('write-handoff: the Updated line gets the clock time, and git branch and HEAD through the launcher', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const p2 = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const before = fmt(new Date());
  const w = wh(J(s), '# Handoff: x\nUpdated: 2020-01-01 00:00 | branch old | HEAD 0000000\n\n## Bootstrap\n- go\n');
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  const after = fmt(new Date());
  const text = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  const m = /^Updated: (\S+ \S+) \| branch (\S+) \| HEAD ([0-9a-f]+) \| by Codex$/m.exec(text);
  assert.ok(m, text);
  assert.ok(m[1] >= before && m[1] <= after, `${m[1]} is not between ${before} and ${after}`);
  const g = a => execFileSync('git', a, { cwd: s.repo, encoding: 'utf8' }).trim();
  assert.strictEqual(m[2], g(['branch', '--show-current']));
  assert.strictEqual(m[3], g(['rev-parse', '--short', 'HEAD']));
  assert.ok(!text.includes('2020-01-01') && !text.includes('branch old'));
  // No Updated line: one goes under the heading. CRLF input, as from a PowerShell pipe, is normalized.
  wh(J(s), '# Handoff: x\r\n\r\n## Bootstrap\r\n- go\r\n');
  const t2 = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  assert.match(t2, /# Handoff: x\nUpdated: \S+ \S+ \| branch \S+ \| HEAD [0-9a-f]+ \| by Codex\n/);
  assert.ok(!t2.includes('\r'));
  // Run directly, without the launcher's git facts: the time is stamped, the model's branch and HEAD stay.
  const d = wh(s.cli, '# Handoff: x\nUpdated: 2020-01-01 00:00 | branch mine | HEAD abc1234\n');
  assert.strictEqual(d.status, 0, d.stdout + d.stderr);
  const t3 = fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8');
  assert.match(t3, /^Updated: \S+ \S+ \| branch mine \| HEAD abc1234 \| by Codex$/m);
  assert.ok(!t3.includes('2020-01-01'));
  // Frontmatter is left alone; only the body's Updated line changes.
  const S = require(path.join(ROOT, 'scripts', 'lib', 'store.js'));
  const fm = S.stampUpdated('---\nname: handoff\n---\n# H\nUpdated: 2020-01-01 00:00\n', null, new Date(2026, 9, 17, 9, 5));
  assert.strictEqual(fm, '---\nname: handoff\n---\n# H\nUpdated: 2026-10-17 09:05 | by Codex\n');
});

test('write-handoff and park: --from=<file> works like stdin; a file in the memory folder is removed once saved', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const handoffFile = path.join(s.memdir, 'handoff.md');
  const drop = path.join(s.memdir, 'incoming-handoff.md');
  fs.writeFileSync(drop, '# Handoff: x\r\nUpdated: later\r\n\r\n## Bootstrap\r\n- from a file\r\n');
  const w = wh(J(s), undefined, [`--from=${drop}`]);
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  const text = fs.readFileSync(handoffFile, 'utf8');
  assert.match(text, /- from a file/);
  assert.match(text, /^Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| branch /m);
  assert.ok(!text.includes('\r'));
  assert.ok(!fs.existsSync(drop), 'the drop file in the memory folder is removed after saving');
  // A file outside the memory folder is refused by the launcher (it reads
  // --from before the sandbox starts), and left alone.
  const outside = path.join(s.base, 'idea.md');
  fs.writeFileSync(outside, '# Idea\nwhy');
  const p = jbm(s, ['park', '--slug=from-file', `--from=${outside}`]);
  assert.strictEqual(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /--from must name a file inside the memory folder/);
  assert.ok(!fs.existsSync(path.join(s.memdir, 'parked', 'from-file.md')));
  assert.ok(fs.existsSync(outside));
  // A drop file inside the folder works for park too.
  const pdrop = path.join(s.memdir, 'incoming-park.md');
  fs.writeFileSync(pdrop, '# Idea\nwhy');
  const p2 = jbm(s, ['park', '--slug=from-file', `--from=${pdrop}`]);
  assert.strictEqual(p2.status, 0, p2.stdout + p2.stderr);
  assert.ok(fs.existsSync(path.join(s.memdir, 'parked', 'from-file.md')));
  assert.ok(!fs.existsSync(pdrop));
  // A missing file fails cleanly and changes nothing.
  const before = fs.readFileSync(handoffFile, 'utf8');
  const missing = wh(J(s), undefined, [`--from=${path.join(s.memdir, 'incoming-nope.md')}`]);
  assert.notStrictEqual(missing.status, 0);
  assert.match(missing.stderr, /could not read/);
  assert.strictEqual(fs.readFileSync(handoffFile, 'utf8'), before);
  // Over budget (exit 2): the drop file stays, so it can be tightened and sent again.
  fs.writeFileSync(drop, '# H\n' + 'x'.repeat(8000) + '\n');
  assert.strictEqual(wh(J(s), undefined, [`--from=${drop}`]).status, 2);
  assert.ok(fs.existsSync(drop));
  // Run directly, without the launcher.
  fs.writeFileSync(outside, '# Handoff: x\n- direct\n');
  assert.strictEqual(wh(s.cli, undefined, [`--from=${outside}`]).status, 0);
  assert.match(fs.readFileSync(handoffFile, 'utf8'), /- direct/);
});

test('launcher: repo not set up means no child process and no output', () => {
  const s = sandbox();
  const r = jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup' }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('launcher: JBMEM_SANDBOX=off runs unsandboxed and says so', () => {
  const s = sandbox();
  jbm(s, ['init']);
  const r = jbm(s, ['dir'], undefined, { JBMEM_SANDBOX: 'off' });
  assert.match(r.stdout, /sandbox: off: JBMEM_SANDBOX=off/);
});

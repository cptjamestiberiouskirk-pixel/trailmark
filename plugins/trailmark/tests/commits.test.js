// Run: node --test tests/commits.test.js
// 0.3.3: commits logged from the folder they ran in, the command parser,
// and hostile repo config.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { realTemp, WIN, dp, POSIX_ONLY, NO_LINKS, sandbox, versionNow, wh, J,
  jbm, SA, SB, SC, notesOf, multiFolder, commitLines, jbmIn, tick } = require('./helpers.js');

// ---------- 0.3.3: commits logged from the folder they ran in ----------

test('0.3.3 commits: a session committing in another clone logs that clone\'s commits, never its own HEAD again (the 964ea2d0 repeat)', () => {
  const { s, wt, clone, gClone, head, hook } = multiFolder();
  const w0 = head(wt);
  const made = [];
  for (let i = 1; i <= 3; i++) {
    // Session A (in worktree wa) commits in the other clone, as `cd /e/audit2 && git commit` did.
    gClone('commit', '-q', '--allow-empty', '-m', `audit ${i}`);
    made.push(head(clone));
    const a = hook(wt, SA, `cd "${clone}" && git commit -q --no-edit && git log --oneline -1 | cat`);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.match(JSON.parse(a.stdout).hookSpecificOutput.additionalContext, /Commit landed/);
    // Session B commits in the main checkout in between.
    s.g('commit', '-q', '--allow-empty', '-m', `main ${i}`);
    assert.strictEqual(hook(s.repo, SB, `git commit -q -m "main ${i}"`).status, 0);
  }
  const lines = commitLines(s);
  for (const [i, sha] of made.entries()) {
    assert.ok(lines.some(l => l.includes(`COMMIT ${sha} in="${dp(clone)}" audit ${i + 1} session=11111111`)), `audit ${i + 1} (${sha}) not logged from the clone:\n${lines.join('\n')}`);
  }
  assert.ok(!lines.some(l => l.includes(` ${w0} `)), `the worktree's HEAD ${w0} was logged:\n${lines.join('\n')}`);
  const shas = lines.map(l => /COMMIT ([0-9a-f]+)/.exec(l)[1]);
  assert.strictEqual(new Set(shas).size, shas.length, `a SHA was logged twice:\n${lines.join('\n')}`);
  // B's commits in the main checkout carry no in= (its own folder), as in 0.3.2.
  assert.ok(lines.some(l => /COMMIT [0-9a-f]+ main 2 session=22222222$/.test(l)), lines.join('\n'));
  // The same command again, with nothing new committed: no line, no reminder.
  const again = hook(wt, SA, `cd "${clone}" && git commit -q --no-edit && git log --oneline -1 | cat`);
  assert.strictEqual(again.stdout, '');
  assert.strictEqual(commitLines(s).length, lines.length);
});

test('0.3.3 Updated line: branch and HEAD come from where the session\'s last commit went, and that folder is named; the main checkout\'s line is unchanged', () => {
  const { s, wt, clone, gClone, head, hook } = multiFolder();
  gClone('commit', '-q', '--allow-empty', '-m', 'audit work');
  hook(wt, SA, `cd "${clone}" && git commit -q -m "audit work"`);
  const run = (cwd, sid) => {
    const r = jbmIn(s, cwd, ['write-handoff', `--base=${versionNow((a, i) => jbmIn(s, cwd, a, i))}`, `--session=${sid}`], `# H\n- by ${sid.slice(0, 8)}\n`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return /^Updated: .*$/m.exec(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'))[0];
  };
  const a = run(wt, SA);
  assert.match(a, new RegExp(`^Updated: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\| branch audit \\| HEAD ${head(clone)} \\| in ${dp(clone).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| session 11111111 \\| by Claude Code$`), a);
  // A session in the main checkout: the 0.3.2 format, no folder.
  s.g('commit', '-q', '--allow-empty', '-m', 'main work');
  const b = run(s.repo, SB);
  assert.match(b, new RegExp(`^Updated: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\| branch \\S+ \\| HEAD ${head(s.repo)} \\| session 22222222 \\| by Claude Code$`), b);
  // A session in the worktree that never committed: the worktree, named.
  const c = run(wt, SC);
  assert.match(c, new RegExp(`\\| branch wa \\| HEAD ${head(wt)} \\| in ${dp(wt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| session 33333333 \\| by Claude Code$`), c);
  // A recorded folder that is gone: back to the session's own folder.
  fs.rmSync(clone, { recursive: true, force: true });
  assert.match(run(wt, SA), new RegExp(`\\| branch wa \\| HEAD ${head(wt)} \\| in .*wa \\| session 11111111 \\| by Claude Code$`));
});

test('0.3.3 commits: two folders in one command are both logged; a commit named only in a heredoc, a quoted string or a pull is not a commit', () => {
  const { s, wt, clone, gClone, gWt, head, hook } = multiFolder();
  gWt('commit', '-q', '--allow-empty', '-m', 'own one');
  gClone('commit', '-q', '--allow-empty', '-m', 'other one');
  hook(wt, SA, `git commit -q -m "own one" && cd "${clone}" && git commit -q -m "other one"`);
  let lines = commitLines(s);
  assert.ok(lines.some(l => l.endsWith(`COMMIT ${head(wt)} own one session=11111111`)), lines.join('\n'));
  assert.ok(lines.some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" other one session=11111111`)), lines.join('\n'));
  // A commit made outside any session (no hook ran), then commands that only
  // mention git commit: 0.3.2 logged that HEAD as this session's commit.
  s.g('commit', '-q', '--allow-empty', '-m', 'made by hand');
  const n = commitLines(s).length;
  for (const cmd of [
    `cd "${s.repo}" && python3 - <<'PYEOF'\nimport os\nos.system("git commit -m x")\nPYEOF`,
    `cd "${s.repo}" && echo "git commit -m x" && grep -c "git commit" README || true`,
    `cd "${s.repo}" # && git commit -m x`,
  ]) {
    const r = hook(s.repo, SB, cmd);
    assert.strictEqual(r.stdout, '', cmd);
  }
  assert.strictEqual(commitLines(s).length, n, commitLines(s).join('\n'));
  // A pull brings in someone else's commit; `git commit` then has nothing to
  // commit and the command still exits 0.
  const gc = (...a) => execFileSync('git', a, { cwd: clone, stdio: 'ignore' });
  gc('fetch', '-q', s.repo, 'HEAD');
  gc('checkout', '-q', '-B', 'pulled', 'FETCH_HEAD~1');
  gc('pull', '-q', '--ff-only', s.repo, 'HEAD');
  assert.strictEqual(head(clone), head(s.repo));
  const p = hook(s.repo, SC, `cd "${clone}" && git pull -q --ff-only && git commit -q -m nothing; true`, { end: s.repo });
  assert.strictEqual(p.status, 0, p.stderr);
  assert.strictEqual(p.stdout, '');
  assert.ok(!notesOf(s).includes('made by hand'), notesOf(s));
});

test('0.3.3 commits: a folder that can\'t be known is logged as unresolved, never as the session folder\'s HEAD', () => {
  const { s, wt, head, hook } = multiFolder();
  s.g('commit', '-q', '--allow-empty', '-m', 'not mine');
  const w0 = head(wt);
  const r = hook(wt, SA, 'cd "$REPO" && git commit -q -m "x"');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Commit landed/);
  assert.match(notesOf(s), /COMMIT_UNRESOLVED why=unknown-folder session=11111111/);
  hook(wt, SA, 'GIT_DIR=/elsewhere/.git git commit -m x');
  assert.match(notesOf(s), /COMMIT_UNRESOLVED why=other-repo session=11111111/);
  hook(wt, SA, `cd "${path.join(s.base, 'gone')}" && git commit -m x`);
  assert.match(notesOf(s), /COMMIT_UNRESOLVED why=missing-folder in="[^"]*gone" session=11111111/);
  assert.strictEqual(commitLines(s).length, 0, commitLines(s).join('\n'));
  assert.ok(!notesOf(s).includes(w0));
});

test('0.3.3 commits: the PowerShell tool\'s Set-Location and Push-Location are followed', () => {
  const { s, wt, clone, gClone, head, hook } = multiFolder();
  gClone('commit', '-q', '--allow-empty', '-m', 'from powershell');
  const r = hook(wt, SA, `Set-Location -LiteralPath '${clone}'; git commit -q -m 'from powershell'`, { tool_name: 'PowerShell' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" from powershell session=11111111`)), notesOf(s));
  gClone('commit', '-q', '--allow-empty', '-m', 'pushed');
  hook(wt, SA, `Push-Location '${clone}'\ngit commit -q -m pushed\nPop-Location`, { tool_name: 'PowerShell' });
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" pushed session=11111111`)), notesOf(s));
});

test('0.3.3 commits: a commit logged while the lock was busy is not logged again afterwards', () => {
  const { s, wt, clone, gClone, gWt, head, hook } = multiFolder();
  // In the session's own folder: 0.3.2 logged it again here as soon as
  // another session's commit had replaced lastCommit.
  s.g('commit', '-q', '--allow-empty', '-m', 'own busy');
  const lock0 = path.join(s.memdir, '.jbmem.lock');
  fs.writeFileSync(lock0, `pid ${process.pid} host x since now token busy\n`);
  assert.strictEqual(hook(s.repo, SA, 'git commit -m "own busy"').status, 0);
  fs.unlinkSync(lock0);
  gWt('commit', '-q', '--allow-empty', '-m', 'in the worktree');
  hook(wt, SB, 'git commit -m "in the worktree"');
  hook(s.repo, SA, 'git commit -q -m "own busy" || true');
  assert.strictEqual(commitLines(s).filter(l => l.includes(' own busy ')).length, 1, commitLines(s).join('\n'));
  gClone('commit', '-q', '--allow-empty', '-m', 'busy one');
  const lock = path.join(s.memdir, '.jbmem.lock');
  fs.writeFileSync(lock, `pid ${process.pid} host x since now token busy\n`);
  assert.strictEqual(hook(s.repo, SA, `git -C "${clone}" commit -m "busy one"`).status, 0);
  fs.unlinkSync(lock);
  // Another session's commit in between, then A's same command again.
  s.g('commit', '-q', '--allow-empty', '-m', 'between');
  hook(s.repo, SB, 'git commit -m between');
  hook(s.repo, SA, `git -C "${clone}" commit -m "busy one"`);
  const mine = commitLines(s).filter(l => l.includes(head(clone)));
  assert.strictEqual(mine.length, 1, commitLines(s).join('\n'));
});

test('0.3.3 commits: state and log from 0.3.2 (lastCommit, an earlier COMMIT line) keep that commit from being logged again', () => {
  const { s, head, hook } = multiFolder();
  s.g('commit', '-q', '--allow-empty', '-m', 'logged by 0.3.2');
  const sha = head(s.repo);
  fs.writeFileSync(path.join(s.memdir, '.jbmem-state.json'), JSON.stringify({ lastCommit: 'beef000', sessions: {} }));
  S_note(s, `COMMIT ${sha} logged by 0.3.2`);
  const r = hook(s.repo, SA, 'git commit -m "logged by 0.3.2"');
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(commitLines(s).length, 1, commitLines(s).join('\n'));
  // 0.3.2's lastCommit alone is enough too.
  s.g('commit', '-q', '--allow-empty', '-m', 'second');
  const st = JSON.parse(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8'));
  st.lastCommit = head(s.repo);
  fs.writeFileSync(path.join(s.memdir, '.jbmem-state.json'), JSON.stringify(st));
  assert.strictEqual(hook(s.repo, SA, 'git commit -m second').stdout, '');
  assert.ok(!notesOf(s).includes('second'));
});
function S_note(s, text) {
  require('../scripts/lib/store').note(s.memdir, text, '');
}

test('0.3.3 hardening: hostile repo config in the folder git runs in starts no program (lazy fetch, uploadpack, gpg, fsmonitor, hooks)', { skip: POSIX_ONLY }, () => {
  const s = sandbox();
  jbm(s, ['init']);
  const marks = path.join(s.base, 'marks');
  fs.mkdirSync(marks);
  const prog = (name) => {
    const f = path.join(s.base, `prog-${name}`);
    fs.writeFileSync(f, `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, name))}\nexit 1\n`, { mode: 0o755 });
    return f;
  };
  // A folder whose config would run something: a partial clone whose lazy
  // fetch goes through ext:: (or a local uploadpack), with every transport
  // the repo can allow allowed; a signature program for signed commits; an
  // fsmonitor; a hook folder.
  const hostile = (dir, via) => {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('config', 'core.repositoryformatversion', '1');
    g('config', 'extensions.partialClone', 'origin');
    g('config', 'remote.origin.promisor', 'true');
    if (via === 'ext') g('config', 'remote.origin.url', `ext::sh -c touch% ${path.join(marks, 'lazy-ext')}`);
    else { g('config', 'remote.origin.url', s.repo); g('config', 'remote.origin.uploadpack', prog('lazy-uploadpack')); }
    g('config', 'protocol.ext.allow', 'always');
    g('config', 'protocol.file.allow', 'always');
    g('config', 'gpg.program', prog('gpg'));
    g('config', 'log.showSignature', 'true');
    g('config', 'core.fsmonitor', prog('fsmonitor'));
    const hooks = path.join(s.base, `hooks-${path.basename(dir)}`);
    fs.mkdirSync(hooks, { recursive: true });
    for (const h of ['post-index-change', 'reference-transaction', 'post-checkout']) fs.copyFileSync(prog(h), path.join(hooks, h));
    fs.chmodSync(hooks, 0o755);
    for (const h of fs.readdirSync(hooks)) fs.chmodSync(path.join(hooks, h), 0o755);
    g('config', 'core.hooksPath', hooks);
    // Two new reflog entries: a signed commit, then one that isn't there
    // (reading it needs a lazy fetch), which HEAD points at.
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const ts = Math.floor(Date.now() / 1000);
    const obj = (body, write) => execFileSync('git', ['hash-object', '-t', 'commit', ...(write ? ['-w'] : []), '--stdin'], { cwd: dir, encoding: 'utf8', input: body }).trim();
    const ghost = obj(`tree ${tree}\nparent ${parent}\nauthor t <t@t> ${ts} +0000\ncommitter t <t@t> ${ts} +0000\n\nghost\n`, false);
    const signed = obj(`tree ${tree}\nparent ${parent}\nauthor t <t@t> ${ts} +0000\ncommitter t <t@t> ${ts} +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`, true);
    fs.appendFileSync(path.join(dir, '.git', 'logs', 'HEAD'), `${parent} ${signed} t <t@t> ${ts} +0000\tcommit: signed\n${signed} ${ghost} t <t@t> ${ts} +0000\tcommit: ghost\n`);
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), ghost + '\n');
  };
  // Proof that the fixture is live: a plain git read there runs the repo's
  // command, through ext:: or through a local uploadpack.
  const clone = (name) => { const d = path.join(s.base, name); execFileSync('git', ['clone', '-q', s.repo, d], { stdio: 'ignore' }); return d; };
  const probeExt = clone('probe-ext');
  const probeFile = clone('probe-file');
  const other = clone('other');
  hostile(probeExt, 'ext');
  hostile(probeFile, 'file');
  for (const d of [probeExt, probeFile]) spawnSync('git', ['log', '-1', '--format=%s'], { cwd: d, stdio: 'ignore', timeout: 10000 });
  spawnSync('git', ['log', '-1', '--format=%s', 'HEAD@{1}'], { cwd: probeExt, stdio: 'ignore', timeout: 10000 });
  assert.deepStrictEqual(fs.readdirSync(marks).sort(), ['gpg', 'lazy-ext', 'lazy-uploadpack'], 'the fixture should run its programs for an unhardened git');
  fs.rmSync(marks, { recursive: true }); fs.mkdirSync(marks);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = realTemp('jbmem-hostile-');
  const calls = path.join(bin, 'calls.txt');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$PWD $*" >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  // 1. The session's own folder is hostile (0.3.2 ran `git log -1` there).
  hostile(s.repo, 'ext');
  for (const kind of ['commit', 'subagent', 'pr-merge']) {
    jbm(s, ['--hook', 'milestone', kind], JSON.stringify({ cwd: s.repo, session_id: SA, tool_input: { command: kind === 'pr-merge' ? 'gh pr merge 1' : 'git commit -m ghost' }, tool_response: {} }), env);
  }
  jbm(s, ['--hook', 'session-start'], JSON.stringify({ cwd: s.repo, source: 'startup', session_id: SA }), env);
  jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: SA }), env);
  wh((a, i) => jbm(s, a, i, env), '# H\n- x\n', [`--session=${SA}`]);
  // 2. A folder named in the command is hostile.
  hostile(other, 'file');
  jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SB, tool_input: { command: `cd "${other}" && git commit -m ghost` }, tool_response: {} }), env);
  assert.deepStrictEqual(fs.readdirSync(marks), [], 'a program from the repo config ran');
  // And the hooks did read both folders, so the check above means something.
  const ran = fs.readFileSync(calls, 'utf8').split('\n');
  assert.ok(ran.some(l => l.startsWith(`${other} `) && / log -g /.test(l)), 'the hook read the reflog in the hostile folder');
  assert.ok(ran.some(l => l.startsWith(`${s.repo} `) && / log -g /.test(l)), 'the hook read the reflog in the session folder');
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

test('0.3.3 hardening: the PreCompact status runs no fsmonitor, hook or submodule git', (ctx) => {
  const s = sandbox();
  jbm(s, ['init']);
  const marks = path.join(s.base, 'marks');
  fs.mkdirSync(marks);
  const prog = (name) => { const f = path.join(s.base, `prog-${name}`); fs.writeFileSync(f, `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, name))}\nexit 1\n`, { mode: 0o755 }); return f; };
  const sub = path.join(s.base, 'subrepo');
  execFileSync('git', ['init', '-q', sub]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 's'], { cwd: sub });
  s.g('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
  s.g('commit', '-qm', 'sub');
  fs.writeFileSync(path.join(s.repo, 'sub', 'dirty'), 'x');
  // The repo's config is set last, so only the hook's own git calls could run it.
  s.g('config', 'core.fsmonitor', prog('fsmonitor'));
  const hooks = path.join(s.base, 'hooks');
  fs.mkdirSync(hooks);
  fs.copyFileSync(prog('post-index-change'), path.join(hooks, 'post-index-change'));
  fs.chmodSync(path.join(hooks, 'post-index-change'), 0o755);
  s.g('config', 'core.hooksPath', hooks);
  // Proof that the fixture is live: a plain status runs both.
  // (On Windows git doesn't run these shell scripts, so only the trace below counts there.)
  spawnSync('git', ['status', '--porcelain'], { cwd: s.repo, stdio: 'ignore' });
  if (!WIN) assert.deepStrictEqual(fs.readdirSync(marks).sort(), ['fsmonitor', 'post-index-change']);
  fs.rmSync(marks, { recursive: true }); fs.mkdirSync(marks);
  fs.utimesSync(path.join(s.repo, 'a'), new Date(Date.now() - 4 * 3600000), new Date(Date.now() - 4 * 3600000));
  const old = new Date(Date.now() - 3 * 3600000);
  fs.utimesSync(path.join(s.repo, 'a'), old, old);
  // git's own trace lists every program it starts.
  const trace = path.join(s.base, 'trace.txt');
  // Each try's trace is kept, so every one is checked below.
  const snap = require('../scripts/lib/store').snapshotPath(s.memdir, SA);
  const precompact = () => { fs.rmSync(snap, { force: true }); assert.strictEqual(jbm(s, ['--hook', 'precompact'], JSON.stringify({ cwd: s.repo, trigger: 'auto', session_id: SA }), { GIT_TRACE: trace }).status, 0); };
  precompact();
  const late = lateAgain(precompact, () => { try { return /not read \(git-timeout\)/.test(fs.readFileSync(snap, 'utf8')) && 'Uncommitted files: not read (git-timeout)'; } catch { return ''; } });
  // What git started is checked on every run, also when git ran out of time.
  assert.deepStrictEqual(fs.readdirSync(marks), []);
  const t = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
  assert.ok(!/run_command:/.test(t), 'git started another program: ' + t.split('\n').filter(l => /run_command/.test(l)).join('\n'));
  if (late) return ctx.skip(late);
  assert.ok(/built-in: git .*status --porcelain/.test(t), 'the hook ran status: ' + t);
});

test('0.3.3 parser: where each commit ran, for Bash, Git Bash on Windows and PowerShell', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd, extra = {}) => commitSites(cmd, { platform: 'linux', cwd: '/r/wt', home: '/h', ...extra });
  const W = (cmd, shell = 'bash') => commitSites(cmd, { platform: 'win32', cwd: 'E:\\Code\\repo\\.claude\\worktrees\\wa', home: 'C:\\Users\\ann', shell });
  const sites = r => r.sites;
  // Bash.
  assert.deepStrictEqual(sites(L('git commit -m x')), ['/r/wt']);
  assert.deepStrictEqual(sites(L('cd /e/x && git commit -m y; cd sub; git commit -m z')), ['/e/x', '/e/x/sub']);
  assert.deepStrictEqual(sites(L('git -C ../b -C c commit -m x')), ['/r/b/c']);
  assert.deepStrictEqual(sites(L('(cd /a && git commit -m x); git commit -m y')), ['/a', '/r/wt'], 'a subshell keeps its cd');
  assert.deepStrictEqual(sites(L('cd /a | cat; git commit -m y')), ['/r/wt'], 'a pipeline element runs in a subshell');
  assert.deepStrictEqual(sites(L('{ cd /a; }; git commit -m y')), ['/a'], 'a { } group does not');
  assert.deepStrictEqual(sites(L('pushd /a && git commit -m x && popd && git commit -m y')), ['/a', '/r/wt']);
  assert.deepStrictEqual(sites(L('cd /a && cd - && git commit -m x')), ['/r/wt']);
  assert.deepStrictEqual(sites(L('cd ~/src && git commit -m x; cd && git commit -m y')), ['/h/src', '/h']);
  assert.deepStrictEqual(sites(L('cd "/a b" && git commit -m "cd /nope"')), ['/a b']);
  assert.deepStrictEqual(sites(L("cd '/a'\\''b' && git commit -m x")), ["/a'b"]);
  assert.deepStrictEqual(sites(L('cd /a\\\n/b && git commit -m x')), ['/a/b']);
  assert.deepStrictEqual(sites(L('cd "$(git rev-parse --show-toplevel)" && git commit -m x')), ['/r/wt']);
  assert.deepStrictEqual(sites(L('bash -c "cd /q && git commit -m x"; git commit -m y')), ['/q', '/r/wt']);
  assert.deepStrictEqual(sites(L('if git commit -m x; then echo ok; fi')), ['/r/wt']);
  assert.deepStrictEqual(sites(L('timeout 60 git -c user.name=x commit -m y && env A=1 git commit -m z')), ['/r/wt', '/r/wt']);
  assert.deepStrictEqual(sites(L('git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" && cd /z && git commit -m two')), ['/r/wt', '/z']);
  assert.deepStrictEqual(sites(L('cat > f <<EOF\ncd /x\ngit commit -m in-heredoc\nEOF\ngit commit -m after')), ['/r/wt']);
  assert.deepStrictEqual(sites(L('f() { cd /x; git commit -m in-func; }; git commit -m y')), ['/r/wt'], 'a function body only runs when called');
  for (const none of ['echo git commit', 'echo "git commit -m x"', 'git log --grep commit', 'git commit-tree x', 'git commit --dry-run',
    'git commit --help', 'git -C . status', '# git commit -m x', "python3 - <<'X'\ngit commit\nX"]) {
    const r = L(none);
    assert.deepStrictEqual(r.sites, [], none);
  }
  assert.deepStrictEqual(L('echo git commit'), { sites: [], loops: [], unresolved: [], end: '/r/wt' }, 'echo prints text');
  // end: where the command, as read, leaves the shell (for the launcher's end-folder check).
  assert.strictEqual(L('cd /a && git commit -m x').end, '/a');
  assert.strictEqual(L('(cd /a && git commit -m x)').end, '/r/wt', 'a subshell does not move the shell');
  assert.strictEqual(L('cd "$D" && git commit -m x').end, null, 'not known');
  assert.deepStrictEqual(L('cmd /c "git commit -m x"').unresolved, ['unrecognized']);
  for (const [cmd, why] of [['cd "$D" && git commit -m x', 'unknown-folder'], ['cd /a* && git commit -m x', 'unknown-folder'],
    ['cd /a || cd /b; git commit -m x', 'unknown-folder'], ['git -C "$R" commit -m x', 'unknown-folder'],
    ['GIT_DIR=/x/.git git commit -m y', 'other-repo'], ['git --git-dir=/x/.git commit -m y', 'other-repo'],
    ['xargs -I{} git -C {} commit -m y', 'unknown-folder'], ['for d in a b; do (cd $d && git commit -m y); done', 'unknown-folder']]) {
    const r = L(cmd);
    assert.deepStrictEqual({ sites: r.sites, unresolved: r.unresolved }, { sites: [], unresolved: [why] }, cmd);
  }
  // Git Bash on Windows: /e/x is E:\x; /tmp is not known.
  assert.deepStrictEqual(sites(W('cd /e/audit2 && git commit -q --no-edit')), ['E:\\audit2']);
  assert.deepStrictEqual(sites(W('cd "E:/Code/Unity Projects/x" && git commit -m y')), ['E:\\Code\\Unity Projects\\x']);
  assert.deepStrictEqual(sites(W('cd /cygdrive/c/Users && git commit -m y; cd .. && git commit -m z')), ['C:\\Users', 'C:\\']);
  for (const c of ['cd /tmp && git commit -m y', 'cd E: && git commit -m y']) assert.deepStrictEqual(W(c).unresolved, ['unknown-folder'], c);
  assert.deepStrictEqual(sites(W('powershell -NoProfile -Command "Set-Location E:\\q; git commit -m y"; git commit -m z')), ['E:\\q', 'E:\\Code\\repo\\.claude\\worktrees\\wa']);
  // PowerShell.
  const P = cmd => W(cmd, 'powershell');
  assert.deepStrictEqual(sites(P('Set-Location E:\\audit2; git commit -m x')), ['E:\\audit2']);
  assert.deepStrictEqual(sites(P("cd 'E:\\a b'\ngit commit -m x\ncd ..\\c; & git.exe commit -m y")), ['E:\\a b', 'E:\\c']);
  assert.deepStrictEqual(sites(P('sl -Path:E:\\q; git -C sub commit -m x')), ['E:\\q\\sub']);
  assert.deepStrictEqual(sites(P('Push-Location E:\\a; git commit -m x; Pop-Location; git commit -m y')), ['E:\\a', 'E:\\Code\\repo\\.claude\\worktrees\\wa']);
  assert.deepStrictEqual(P('if (Test-Path E:\\q) { cd E:\\q }; git commit -m y').unresolved, ['unknown-folder'], 'a location set in a block that may not run is unknown after it');
  assert.deepStrictEqual(sites(P('& { cd E:\\q }; git commit -m y')), ['E:\\q'], 'a block run with & does run');
  assert.deepStrictEqual(sites(P('cd ~\\src; git commit -m a; cd $HOME; git commit -m b; cd \\top; git commit -m c')), ['C:\\Users\\ann\\src', 'C:\\Users\\ann', 'C:\\top']);
  assert.deepStrictEqual(sites(P('cd -LiteralPath "E:\\x [1]"; git commit -m y')), ['E:\\x [1]']);
  assert.deepStrictEqual(sites(P('Set-Location E:\\q -WhatIf; git commit -m y')), ['E:\\Code\\repo\\.claude\\worktrees\\wa']);
  for (const none of ["@'\ngit commit -m x\n'@ | Out-File a.txt", "'git commit -m x'", '<# git commit #> git status', 'Write-Host "git commit"']) {
    assert.deepStrictEqual(P(none).sites, [], none);
  }
  for (const cmd of ['cd $repo; git commit -m y', 'cd "E:\\x [1]"; git commit -m y', 'cd HKLM:\\x; git commit -m y', 'cd (Get-Item x); git commit -m y']) {
    const r = P(cmd);
    assert.deepStrictEqual({ sites: r.sites, unresolved: r.unresolved }, { sites: [], unresolved: ['unknown-folder'] }, cmd);
  }
  // A long command doesn't stall the hook.
  const t = Date.now();
  L('cd /a && ' + 'git add "b c" && '.repeat(20000) + 'git commit -m x');
  P('Set-Location E:\\a; ' + "git add 'b c'; ".repeat(20000) + 'git commit -m x');
  L(`cat <<EOF\n${'x\n'.repeat(200000)}EOF\ngit commit -m y`);
  L('$('.repeat(5000) + 'git commit' + ')'.repeat(5000));
  assert.ok(Date.now() - t < 3000, `parsing took ${Date.now() - t} ms`);
});

test('0.3.3 commits: a commit older than a command can run is not this command\'s', () => {
  const { s, clone, gClone, hook } = multiFolder();
  // The reflog takes its time from GIT_COMMITTER_DATE, as for a commit made two hours ago.
  const old = new Date(Date.now() - 2 * 3600000).toISOString();
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'two hours old'], { cwd: clone, env: { ...process.env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old } });
  const r = hook(s.repo, SA, `cd "${clone}" && git commit -q -m nothing || true`);
  assert.strictEqual(r.stdout, '');
  assert.ok(!notesOf(s).includes('two hours old'), notesOf(s));
  // BASH_MAX_TIMEOUT_MS widens the window to match.
  const wide = jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ cwd: s.repo, session_id: SA, tool_name: 'Bash', tool_input: { command: `cd "${clone}" && git commit -q -m nothing || true` }, tool_response: {} }), { BASH_MAX_TIMEOUT_MS: String(3 * 3600000) });
  assert.strictEqual(wide.status, 0);
  assert.ok(notesOf(s).includes('two hours old'), 'a 3 h limit (capped at 2 h + 1 min) should still cover a 2 h old commit');
  gClone('commit', '-q', '--allow-empty', '-m', 'fresh');
  hook(s.repo, SA, `cd "${clone}" && git commit -q -m fresh`);
  assert.ok(notesOf(s).includes(' fresh session=11111111'));
});

// ---------- 0.3.3 review round 1: where a command starts, and what it made ----------

test('0.3.3 start folder: PostToolUse cwd is where the command ended; the PreToolUse record says where it started', () => {
  const { s, wt, gWt, head, hook } = multiFolder();
  fs.mkdirSync(path.join(wt, 'src'));
  // cd src && git commit: Claude Code moves the session to wt/src afterwards.
  gWt('commit', '-q', '--allow-empty', '-m', 'sub commit');
  const a = hook(wt, SA, 'cd src && git commit -q --allow-empty -m "sub commit"', { end: path.join(wt, 'src') });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(wt)} sub commit session=11111111`)), notesOf(s));
  // From there, cd .. && git commit: the session is back in wt.
  gWt('commit', '-q', '--allow-empty', '-m', 'parent commit');
  hook(path.join(wt, 'src'), SA, 'cd .. && git commit -q --allow-empty -m "parent commit"', { end: wt });
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(wt)} parent commit session=11111111`)), notesOf(s));
  assert.ok(!notesOf(s).includes(' in="'), 'all of these are the session folder\'s own: ' + notesOf(s));
  // With no PreToolUse record (an older Claude Code, a hook that didn't run),
  // a command that moved the session is read from an unknown start: never
  // the wrong folder.
  gWt('commit', '-q', '--allow-empty', '-m', 'no record');
  const n = commitLines(s).length;
  hook(wt, SA, 'cd src && git commit -q --allow-empty -m "no record"', { end: path.join(wt, 'src'), pre: false });
  assert.strictEqual(commitLines(s).length, n);
  assert.match(notesOf(s), /COMMIT_UNRESOLVED why=unknown-folder session=11111111/);
  // A command that didn't move the session: its end folder is its start.
  gWt('commit', '-q', '--allow-empty', '-m', 'stayed');
  hook(wt, SA, 'git commit -q --allow-empty -m stayed', { pre: false });
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(wt)} stayed session=11111111`)), notesOf(s));
});

test('0.3.3 start folder: a session left in an added folder (another clone) still logs to its own memory, with in=', () => {
  const { s, wt, clone, gClone, head, hook } = multiFolder();
  // Claude Code's transcript for the session, whose first cwd is where it started.
  const tdir = path.join(s.cfg, 'projects', wt.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(tdir, { recursive: true });
  const transcript = path.join(tdir, `${SA}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: wt, sessionId: SA, message: { content: 'hi' } }) + '\n');
  gClone('commit', '-q', '--allow-empty', '-m', 'into the clone');
  // The clone is a folder the session may use, so Claude Code leaves it there.
  hook(wt, SA, `cd "${clone}" && git commit -q --allow-empty -m "into the clone"`, { end: clone, transcript_path: transcript });
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" into the clone session=11111111`)), notesOf(s));
  // The next command starts there: both hooks get the clone as cwd.
  gClone('commit', '-q', '--allow-empty', '-m', 'still there');
  hook(clone, SA, 'git commit -q --allow-empty -m "still there"', { transcript_path: transcript });
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" still there session=11111111`)), notesOf(s));
});

test('0.3.3 commits: loops, many commits, functions, scripts on stdin and a message that looks like a flag are all logged', () => {
  const { s, clone, gClone, head, hook } = multiFolder();
  const shas = [];
  for (let i = 1; i <= 3; i++) { gClone('commit', '-q', '--allow-empty', '-m', `loop ${i}`); shas.push(head(clone)); }
  hook(s.repo, SA, `cd "${clone}" && for i in 1 2 3; do git commit -q --allow-empty -m "loop $i"; done`, { end: s.repo });
  for (const sha of shas) assert.ok(commitLines(s).some(l => l.includes(`COMMIT ${sha} `)), `${sha}: ${notesOf(s)}`);
  // Without duration_ms (an older Claude Code) a loop still takes them all.
  // The commits are made after PreToolUse, as the command would: without a
  // duration the window starts at that record (a slow machine takes more than
  // its second of slack for three commits made before it).
  const shas2 = [];
  hook(s.repo, SA, `cd "${clone}" && while read m; do git commit -q --allow-empty -m "$m"; done < list`, { end: s.repo, duration_ms: null,
    between: () => { for (let i = 1; i <= 3; i++) { gClone('commit', '-q', '--allow-empty', '-m', `loop2 ${i}`); shas2.push(head(clone)); } } });
  for (const sha of shas2) assert.ok(commitLines(s).some(l => l.includes(`COMMIT ${sha} `)), `${sha}: ${notesOf(s)}`);
  // Fourteen commits in one command.
  const many = [];
  for (let i = 1; i <= 14; i++) { gClone('commit', '-q', '--allow-empty', '-m', `many ${i}`); many.push(head(clone)); }
  hook(s.repo, SA, `cd "${clone}" && ` + Array.from({ length: 14 }, (_, i) => `git commit -q --allow-empty -m "many ${i + 1}"`).join(' && '), { end: s.repo });
  assert.strictEqual(many.filter(sha => commitLines(s).some(l => l.includes(`COMMIT ${sha} `))).length, 14, notesOf(s));
  for (const [cmd, msg] of [
    [`f() { git -C "${clone}" commit -q --allow-empty -m from-a-function; }; f`, 'from-a-function'],
    [`bash <<'EOF'\ncd "${clone}" && git commit -q --allow-empty -m from-stdin\nEOF`, 'from-stdin'],
    [`cat <<'EOF' | bash\ncd "${clone}" && git commit -q --allow-empty -m from-a-pipe\nEOF`, 'from-a-pipe'],
    [`cd "${clone}" && git commit -q --allow-empty -m '--dry-run'`, '--dry-run'],
  ]) {
    gClone('commit', '-q', '--allow-empty', '-m', msg);
    hook(s.repo, SA, cmd, { end: s.repo });
    assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(clone)} in="${dp(clone)}" ${msg} session=11111111`)), `${msg}: ${notesOf(s)}`);
  }
});

test('0.3.3 commits: only commits made while the command ran; a rebase in the same command logs the rebased copy, an amend only the amended one', () => {
  const { s, clone, gClone, head, hook } = multiFolder();
  // The user's own commit a minute ago in the clone, then a command there that commits nothing.
  const ago = new Date(Date.now() - 60000).toISOString();
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'by hand'], { cwd: clone, env: { ...process.env, GIT_COMMITTER_DATE: ago, GIT_AUTHOR_DATE: ago } });
  const r = hook(s.repo, SA, `cd "${clone}" && git commit -q -m x || true`, { end: s.repo, duration_ms: 3000 });
  assert.strictEqual(r.stdout, '');
  assert.ok(!notesOf(s).includes('by hand'), notesOf(s));
  // commit, then pull --rebase onto a new upstream commit.
  s.g('commit', '-q', '--allow-empty', '-m', 'upstream');
  gClone('commit', '-q', '--allow-empty', '-m', 'fix');
  const pre = head(clone, true);
  execFileSync('git', ['pull', '-q', '--rebase', s.repo, 'HEAD'], { cwd: clone, stdio: 'ignore' });
  const now = head(clone);
  assert.notStrictEqual(pre.slice(0, now.length), now);
  hook(s.repo, SA, `cd "${clone}" && git commit -q -m fix && git pull -q --rebase`, { end: s.repo });
  const fix = commitLines(s).filter(l => / fix /.test(l + ' '));
  assert.strictEqual(fix.length, 1, notesOf(s));
  assert.ok(fix[0].includes(`COMMIT ${now} in="${dp(clone)}" fix (rebased in the same command)`), fix[0]);
  // commit, then amend.
  gClone('commit', '-q', '--allow-empty', '-m', 'first try');
  gClone('commit', '-q', '--amend', '--allow-empty', '-m', 'second try');
  hook(s.repo, SA, `cd "${clone}" && git commit -q -m "first try" && git commit -q --amend -m "second try"`, { end: s.repo });
  assert.ok(!notesOf(s).includes('first try'), notesOf(s));
  assert.ok(commitLines(s).some(l => l.includes(`COMMIT ${head(clone)} in="${dp(clone)}" second try session=`)), notesOf(s));
});

test('0.3.3 commits: a command that runs the hook twice (git commit and git -C in one) logs nothing twice; the PreToolUse hook prints nothing', { skip: NO_LINKS }, () => {
  const { s, wt, clone, gClone, gWt, hook } = multiFolder();
  gWt('commit', '-q', '--allow-empty', '-m', 'own');
  gClone('commit', '-q', '--allow-empty', '-m', 'other');
  const cmd = `git commit -q -m own && git -C "${clone}" commit -q -m other && cd "$UNKNOWN" && git commit -m x`;
  const id = 'toolu_twice01';
  const base = { session_id: SA, tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: id };
  const pre = jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...base, cwd: wt, hook_event_name: 'PreToolUse' }));
  assert.strictEqual(pre.status, 0, pre.stderr);
  assert.strictEqual(pre.stdout, '');
  assert.ok(fs.existsSync(path.join(s.memdir, 'pending', `${id}.json`)));
  for (let i = 0; i < 2; i++) jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ ...base, cwd: wt, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 5000 }));
  const n = notesOf(s);
  assert.strictEqual((n.match(/ own session=/g) || []).length, 1, n);
  assert.strictEqual((n.match(/ other session=/g) || []).length, 1, n);
  assert.strictEqual((n.match(/COMMIT_UNRESOLVED/g) || []).length, 1, n);
  // Not set up: the PreToolUse hook does nothing.
  const other = sandbox();
  const q = jbm(other, ['--hook', 'commit-start'], JSON.stringify({ ...base, cwd: other.repo }));
  assert.strictEqual(q.status, 0);
  assert.strictEqual(q.stdout, '');
  assert.ok(!fs.existsSync(path.join(other.memdir, 'pending')));
  // A record in a planted link folder is refused, and the command still runs (exit 0).
  fs.rmSync(path.join(s.memdir, 'pending'), { recursive: true });
  const outside = path.join(s.base, 'outside-pending');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(s.memdir, 'pending'));
  const l = jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...base, tool_use_id: 'toolu_link', cwd: wt }));
  assert.strictEqual(l.status, 0);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test('0.3.3 Updated line: a main checkout reached through another spelling (a link) gets no folder; a % in a folder is encoded once', { skip: NO_LINKS }, () => {
  const { s, head, hook } = multiFolder();
  const link = path.join(s.base, 'repolink');
  fs.symlinkSync(s.repo, link);
  s.g('commit', '-q', '--allow-empty', '-m', 'through the link');
  hook(s.repo, SA, `cd "${link}" && git commit -q -m "through the link"`, { end: s.repo });
  wh(J(s), '# H\n- x\n', [`--session=${SA}`]);
  const line = /^Updated: .*$/m.exec(fs.readFileSync(path.join(s.memdir, 'handoff.md'), 'utf8'))[0];
  assert.match(line, new RegExp(`\\| HEAD ${head(s.repo)} \\| session 11111111 \\| by Claude Code$`), line);
  // A clone whose folder name has a %.
  const odd = path.join(s.base, '100% done');
  execFileSync('git', ['clone', '-q', s.repo, odd], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'odd'], { cwd: odd });
  hook(s.repo, SA, `cd "${odd}" && git commit -q -m odd`, { end: s.repo });
  assert.ok(notesOf(s).includes(`in="${dp(s.base)}/100%25 done" odd`), notesOf(s));
});

test('0.3.3 parser: code that may not run, functions, scriptblocks, GIT_DIR set earlier, and odd input', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd) => commitSites(cmd, { platform: 'linux', cwd: '/r', home: '/h' });
  const P = (cmd) => commitSites(cmd, { platform: 'win32', cwd: 'E:\\wt', home: 'C:\\U', shell: 'powershell' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  // Bash: a branch, loop or test that may not have changed folder leaves it unknown.
  for (const c of ['if false; then cd /b; fi; git commit -m x', 'while false; do cd /b; done; git commit -m x', 'case x in y) cd /b;; esac; git commit -m x',
    'test -d /b && cd /b; git commit -m x', '[ -d /b ] && cd /b; git commit -m x', 'git pull && cd /b; git commit -m x']) {
    assert.deepStrictEqual(one(L(c)), { sites: [], unresolved: ['unknown-folder'] }, c);
  }
  assert.deepStrictEqual(L('cd /a && cd sub; git commit -m x').sites, ['/a/sub'], 'cd after cd is taken as done');
  assert.deepStrictEqual(L('cd /a && if true; then git commit -m x; fi').sites, ['/a']);
  assert.deepStrictEqual(L('for i in 1 2; do git commit -m $i; done').loops, ['/r']);
  // Functions run where they are called, and only when called.
  assert.deepStrictEqual(L('f() { cd /a; }; git commit -m x; f; git commit -m y').sites, ['/r', '/a']);
  assert.deepStrictEqual(L('function g { git commit -m x; }').sites, []);
  // GIT_DIR exported earlier; CDPATH; lastpipe.
  for (const c of ['export GIT_DIR=/o/.git; git commit -m x', 'GIT_DIR=/o/.git; export GIT_DIR; git commit -m x']) assert.deepStrictEqual(one(L(c)), { sites: [], unresolved: ['other-repo'] }, c);
  assert.deepStrictEqual(one(L('CDPATH=/e cd a && git commit -m x')), { sites: [], unresolved: ['unknown-folder'] });
  assert.deepStrictEqual(L('shopt -s lastpipe; true | cd /a; git commit -m x').sites, ['/a']);
  // Quotes inside ${ }, and a quote the parser can't close: never a silent loss.
  assert.deepStrictEqual(L('echo ${x:-"}"}; cd /b; git commit -m x').sites, ['/b']);
  // Text, not commands.
  for (const c of ['echo git commit -m x', 'alias gc="git commit"', 'printf "git commit\\n"', 'git commit -m "x" --help']) assert.deepStrictEqual(one(L(c)), { sites: [], unresolved: [] }, c);
  // PowerShell: function bodies and stored script blocks don't run; blocks
  // for a cmdlet or a keyword may not; & runs; Start-Job runs elsewhere.
  assert.deepStrictEqual(P('function f { cd E:\\a }; git commit -m x').sites, ['E:\\wt']);
  assert.deepStrictEqual(P('function f { cd E:\\a; git commit -m x }; f').sites, ['E:\\a']);
  assert.deepStrictEqual(P('$sb = { cd E:\\a; git commit -m x }; git commit -m y').sites, ['E:\\wt']);
  assert.deepStrictEqual(one(P('Start-Job { cd E:\\a; git commit -m x }')), { sites: [], unresolved: ['unrecognized'] });
  assert.deepStrictEqual(one(P('Get-Item x | ForEach-Object { cd E:\\a }; git commit -m x')), { sites: [], unresolved: ['unknown-folder'] });
  assert.deepStrictEqual(P('foreach ($x in 1,2) { git commit -m $x }').loops, ['E:\\wt']);
  assert.deepStrictEqual(P('try { cd E:\\a } finally { }; git commit -m x').sites, ['E:\\a']);
  assert.deepStrictEqual(one(P("$env:GIT_DIR = 'E:\\o\\.git'; git commit -m x")), { sites: [], unresolved: ['other-repo'] });
  assert.deepStrictEqual(P('Set-Location -WhatIf:$false E:\\a; git commit -m x').sites, ['E:\\a']);
  assert.deepStrictEqual(one(P('Start-Process git -ArgumentList "commit -m x"')), { sites: [], unresolved: ['unrecognized'] });
  // Shapes that were slow, and a deadline for anything else.
  let t = Date.now();
  for (const c of ['a=1 '.repeat(80000) + 'git commit -m x', '! '.repeat(80000) + 'git commit -m x', 'pushd /a; '.repeat(80000) + 'git commit', 'if '.repeat(5000) + 'git commit']) L(c);
  P('Push-Location E:\\a; '.repeat(80000) + 'git commit');
  assert.ok(Date.now() - t < 4000, `took ${Date.now() - t} ms`);
  t = Date.now();
  const slow = commitSites('f() { ' + 'true; '.repeat(2000) + '}; ' + 'f; '.repeat(3000) + 'git commit -m x', { platform: 'linux', cwd: '/r', home: '/h', deadlineMs: 300 });
  assert.ok(Date.now() - t < 2000, `deadline not kept: ${Date.now() - t} ms`);
  assert.deepStrictEqual(slow.unresolved, ['too-long']);
});

// ---------- 0.3.3 review round 2 ----------

test('0.3.3 parser: PowerShell assignments, stored script blocks, Invoke-Command and scoped function names', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const P = (cmd) => commitSites(cmd, { platform: 'win32', cwd: 'E:\\wt', home: 'C:\\U', shell: 'powershell' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  // The right side of an assignment runs, and its Set-Location counts.
  for (const c of ['$null = Set-Location E:\\a', '$v = cd E:\\a', '$x=cd E:\\a', '$p = Push-Location E:\\a -PassThru', '$x = & { cd E:\\a; 1 }',
    '$r = Invoke-Command { cd E:\\a }', 'Invoke-Command -ScriptBlock { cd E:\\a }', 'icm { cd E:\\a } -ArgumentList 1',
    '$sb = { cd E:\\a }; & $sb', '$sb = { cd E:\\a }; . $sb', '$sb = { cd E:\\a }; $sb.Invoke()', '$sb = { cd E:\\a }; Invoke-Command $sb',
    'function global:Go { Set-Location E:\\a }; Go', 'function script:go { cd E:\\a }; GO', '[int]$n = 5; $n += 1; cd E:\\a']) {
    assert.deepStrictEqual(one(P(c + '; git commit -m x')), { sites: ['E:\\a'], unresolved: [] }, c);
  }
  assert.deepStrictEqual(one(P('$out = git commit -m x 2>&1')), { sites: ['E:\\wt'], unresolved: [] });
  assert.deepStrictEqual(one(P('$sb = { git commit -m x }; & $sb')), { sites: ['E:\\wt'], unresolved: [] });
  // Sent to another computer, or a job: not here.
  for (const c of ['Invoke-Command -ComputerName srv { cd E:\\a; git commit -m x }', 'Invoke-Command { git commit -m x } -Session $s',
    'icm srv { git commit -m x }', '$sb = { git commit -m x }; Start-Job -ScriptBlock $sb', '$sb = { git commit -m x }; Invoke-Command -AsJob $sb']) {
    assert.deepStrictEqual(one(P(c)), { sites: [], unresolved: ['unrecognized'] }, c);
  }
  assert.deepStrictEqual(one(P('Invoke-Command -ComputerName srv { cd E:\\a }; git commit -m x')), { sites: ['E:\\wt'], unresolved: [] });
  // A stored block that is never called, or one handed on in a way not followed.
  assert.deepStrictEqual(one(P('$sb = { cd E:\\a; git commit -m x }; git commit -m y')), { sites: ['E:\\wt'], unresolved: [] });
  // Handed to a cmdlet, it may run here.
  assert.deepStrictEqual(one(P('$sb = { git commit -m x }; Get-Item . | ForEach-Object -Process $sb')), { sites: ['E:\\wt'], unresolved: [] });
  // ForEach-Object -Parallel runs in other runspaces.
  assert.deepStrictEqual(one(P('1..2 | ForEach-Object -Parallel { cd E:\\a }; git commit -m x')), { sites: ['E:\\wt'], unresolved: [] });
  // An alias wins over a function of the same name.
  assert.deepStrictEqual(one(P('function cd { Set-Location E:\\b }; cd E:\\a; git commit -m x')), { sites: ['E:\\a'], unresolved: [] });
  // $env:GIT_DIR set, then cleared where it surely runs.
  for (const c of ["$env:GIT_DIR = 'E:\\o'; $env:GIT_DIR = $null", "$env:GIT_DIR='E:\\o'; Remove-Item Env:GIT_DIR"]) {
    assert.deepStrictEqual(one(P(c + '; git commit -m x')), { sites: ['E:\\wt'], unresolved: [] }, c);
  }
  assert.deepStrictEqual(one(P("$env:GIT_DIR = 'E:\\o'; if ($x) { Remove-Item Env:GIT_DIR }; git commit -m x")), { sites: [], unresolved: ['other-repo'] });
});

test('0.3.3 parser: Bash groups after reserved words, function scope, return and exit, unset -f, builtin cd, function arguments', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd) => commitSites(cmd, { platform: 'linux', cwd: '/r', home: '/h' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  const at = (sites) => ({ sites, unresolved: [] });
  const unknown = { sites: [], unresolved: ['unknown-folder'] };
  for (const [c, want] of [
    // A { } group right after then, do, !, time or if still runs here.
    ['if true; then { cd /a; git commit -m x; }; fi', at(['/a'])],
    ['time { cd /a; }; git commit -m x', at(['/a'])],
    ['! { cd /a; }; git commit -m x', at(['/a'])],
    ['if { cd /a; }; then git commit -m x; fi', at(['/a'])],
    ['while true; do { cd /a; }; done; git commit -m x', unknown],
    // A function defined in a subshell is gone afterwards; one defined in a branch may or may not be there.
    ['(f() { cd /a; }); f; git commit -m x', at(['/r'])],
    ['if x; then f() { cd /a; }; else f() { cd /b; }; fi; f; git commit -m x', unknown],
    ['if x; then git() { command git -C /a "$@"; }; fi; git commit -m x', { sites: ['/r', '/a'], unresolved: [] }],
    ['outer() { inner() { cd /a; }; }; inner; git commit -m x', at(['/r'])],
    // return ends the function; one that may run leaves either folder.
    ['f() { return; cd /a; }; f; git commit -m x', at(['/r'])],
    ['f() { cd /a; return; }; f; git commit -m x', at(['/a'])],
    ['f() { [ -d /a ] || return 1; cd /a; }; f; git commit -m x', unknown],
    ['return; cd /a; git commit -m x', at(['/a'])],
    // exit ends the script, also from a function; in a subshell or pipeline only that.
    ['git commit -m a; exit 0; cd /x; git commit -m b', at(['/r'])],
    ['f() { exit; }; f; git commit -m x', at([])],
    ['(exit 1); git commit -m x', at(['/r'])],
    ['exit | cat; git commit -m x', at(['/r'])],
    ['cd /a || exit 1; git commit -m x', at(['/a'])],
    // A function is found before cd; command and builtin skip it; env runs a program.
    ['cd() { builtin cd /z; }; cd /a; git commit -m x', at(['/z'])],
    ['cd() { builtin cd /z; }; builtin cd /a; git commit -m x', at(['/a'])],
    ['env cd /a; git commit -m x', at(['/r'])],
    ['f() { cd /a; }; unset -f f; f; git commit -m x', at(['/r'])],
    ['f() { cd /a; }; if x; then unset -f f; fi; f; git commit -m x', unknown],
    // Arguments: "$1" and "$@" are the words the function was called with.
    ['go() { cd "$1"; }; go /a; git commit -m x', at(['/a'])],
    ['gc() { git "$@"; }; gc commit -m x', at(['/r'])],
    ['git() { command git -C /x "$@"; }; git commit -m x', at(['/x'])],
    ['f() { git commit -m "$1"; }; f one; f two', at(['/r', '/r'])],
    // GIT_DIR unset where it surely runs; in a subshell, the export stays there.
    ['export GIT_DIR=/o/.git; unset GIT_DIR; git commit -m x', at(['/r'])],
    ['(export GIT_DIR=/o/.git); git commit -m x', at(['/r'])],
    ['export GIT_DIR=/o/.git; if x; then unset GIT_DIR; fi; git commit -m x', { sites: [], unresolved: ['other-repo'] }],
  ]) assert.deepStrictEqual(one(L(c)), want, c);
});

test('0.3.3 parser: scripts written by the command, heredoc expansion, awk; the no-record fallback is not fooled by a cd back', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd) => commitSites(cmd, { platform: 'linux', cwd: '/r', home: '/h' });
  const W = (cmd) => commitSites(cmd, { platform: 'win32', cwd: 'E:\\wt', home: 'C:\\Users\\Ann' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  for (const [c, want] of [
    // A script file this command wrote, then ran: read like the heredoc it came from.
    ["cat > fix.sh <<'EOF'\ncd /e/a && git commit -m x\nEOF\nbash fix.sh", ['/e/a']],
    ["cat <<'EOF' > fix.sh\ncd /e/a && git commit -m x\nEOF\nchmod +x fix.sh && ./fix.sh", ['/e/a']],
    ["cat > env.sh <<'EOF'\ncd /e/a\nEOF\nsource env.sh; git commit -m x", ['/e/a']],
    ["cat > env.sh <<'EOF'\ncd /e/a\nEOF\n. ./env.sh && git commit -m x", ['/e/a']],
    ['echo "cd /e/a && git commit -m x" > s.sh; bash s.sh', ['/e/a']],
    ["tee s.sh <<'EOF' >/dev/null\ncd /e/a && git commit -m x\nEOF\nsh s.sh", ['/e/a']],
    ["cat > s.sh <<'EOF'\ncd /e/a && git commit -m x\nEOF\nbash < s.sh", ['/e/a']],
    // Unquoted delimiter: expanded first. \$ is a plain $, and a body that depends on a variable is not read.
    ['bash <<EOF\ncd /e/a && git commit -m x\nEOF', ['/e/a']],
    ['cat <<EOF\n$(cd /q && git commit -m in-sub)\nEOF', ['/q']],
  ]) assert.deepStrictEqual(one(L(c)), { sites: want, unresolved: [] }, c);
  // Written by something else since: the text recorded for it is stale, so a
  // commit in it is unresolved.
  for (const c of ['bash <<EOF\ncd \\$D && git commit -m x\nEOF', 'bash <<EOF\ncd $D && git commit -m x\nEOF',
    "cat > s.sh <<EOF\ncd $D && git commit -m x\nEOF\nbash s.sh", "cat > s.sh <<'EOF'\ncd /e/a && git commit -m x\nEOF\ngit show HEAD:s.sh > s.sh; bash s.sh"]) {
    assert.deepStrictEqual(one(L(c)), { sites: [], unresolved: ['unknown-folder'] }, c);
  }
  // In Git Bash, $HOME in a heredoc reads /c/Users/Ann.
  assert.deepStrictEqual(one(W('bash <<EOF\ncd $HOME/a && git commit -m x\nEOF')), { sites: ['C:\\Users\\Ann\\a'], unresolved: [] });
  // awk's system() runs commands, so a commit there is never just text.
  assert.deepStrictEqual(one(L("awk 'BEGIN{system(\"git commit -m x\")}'")), { sites: [], unresolved: ['unrecognized'] });
  // No PreToolUse record: the end folder is the start only if the command
  // never moved the shell, even back to where it ends.
  const nr = (cmd, end) => one(commitSites(cmd, { platform: 'linux', cwd: end, home: '/h', startKnown: false }));
  assert.deepStrictEqual(nr('git commit -qm x && cd /r/clone', '/r/clone'), { sites: [], unresolved: ['unknown-folder'] });
  assert.deepStrictEqual(nr('f() { cd /r/clone; }; git commit -qm x; f', '/r/clone'), { sites: [], unresolved: ['unknown-folder'] });
  assert.deepStrictEqual(nr('git commit -qm x', '/r/wt'), { sites: ['/r/wt'], unresolved: [] });
  assert.deepStrictEqual(nr('(cd /x && git commit -m a); git commit -m b', '/r/wt'), { sites: ['/x', '/r/wt'], unresolved: [] });
  // An absolute Set-Location first: known from any start.
  assert.deepStrictEqual(one(commitSites('Set-Location E:\\c; git commit -m x; Set-Location E:\\c', { platform: 'win32', cwd: 'E:\\c', home: 'C:\\U', shell: 'powershell', startKnown: false })), { sites: ['E:\\c'], unresolved: [] });
  assert.deepStrictEqual(one(commitSites('git commit -m x; Set-Location E:\\c', { platform: 'win32', cwd: 'E:\\c', home: 'C:\\U', shell: 'powershell', startKnown: false })), { sites: [], unresolved: ['unknown-folder'] });
});

test('0.3.3 commits: a hook that starts late still finds the command\'s first commit; a commit left on another branch is kept', () => {
  const { s, wt, clone, gWt, head, hook } = multiFolder();
  const { windowStart } = require('../scripts/lib/gitfacts');
  // The window opens at the earlier of the PreToolUse time and duration_ms
  // counted back from this process's start, but no more than a minute early.
  const now = 1_800_000_000_000;
  // Command from now-4.0 s to now-3.7 s, record at now-4.1 s, hook process
  // started at now-0.2 s: duration_ms alone would open at now-0.5 s.
  assert.strictEqual(windowStart(now, 300, now - 200, now - 4100), now - 6000);
  assert.strictEqual(windowStart(now, 300, now, now - 400), now - 3000);
  assert.strictEqual(windowStart(now, 300, now, now - 10 * 60000), now - 61000);
  assert.strictEqual(windowStart(now, 300, now, undefined), now - 6000);
  // As Claude Code runs it, with the PostToolUse hook starting 2.5 s after a
  // 0.3 s command ended: before, the window opened after the commit.
  const sid = SA;
  const cmd = 'git commit -q --allow-empty -m "early commit" && sleep 0.3';
  const base = { session_id: sid, tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `toolu_late${process.pid}` };
  jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...base, cwd: wt, hook_event_name: 'PreToolUse' }));
  gWt('commit', '-q', '--allow-empty', '-m', 'early commit');
  spawnSync('sleep', ['2.8']);
  jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify({ ...base, cwd: wt, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 300 }));
  assert.ok(commitLines(s).some(l => l.endsWith(`COMMIT ${head(wt)} early commit session=11111111`)), notesOf(s));
  // A commit on one branch, then a new branch from before it and a commit
  // there: the first is still on its branch, so it is logged (not on HEAD).
  const g = (...a) => execFileSync('git', a, { cwd: clone, encoding: 'utf8' }).trim();
  g('commit', '-q', '--allow-empty', '-m', 'fix A on audit');
  const a = g('rev-parse', '--short', 'HEAD');
  g('checkout', '-q', '-b', 'featB', 'HEAD~1');
  g('commit', '-q', '--allow-empty', '-m', 'fix B');
  hook(s.repo, SA, `cd "${clone}" && git commit -q -m "fix A on audit" && git checkout -q -b featB HEAD~1 && git commit -q -m "fix B"`, { end: s.repo });
  assert.ok(commitLines(s).some(l => l.includes(`COMMIT ${a} in="${dp(clone)}" fix A on audit (not on HEAD after the command) session=`)), notesOf(s));
  assert.ok(commitLines(s).some(l => l.includes(`COMMIT ${head(clone)} in="${dp(clone)}" fix B session=`)), notesOf(s));
});

// ---------- 0.3.3 review round 3 ----------

test('0.3.3 parser: exit in a piped group, shift and set --, word splitting, code from a variable, exec', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd) => commitSites(cmd, { platform: 'linux', cwd: '/r', home: '/h' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  const at = (sites) => ({ sites, unresolved: [] });
  const unknown = { sites: [], unresolved: ['unknown-folder'] };
  for (const [c, want] of [
    // A { } group in a pipeline or the background is a subshell: its exit ends only it.
    ['{ exit; } | cat; git commit -m x', at(['/r'])],
    ['{ exit; } 2>&1 | cat; git commit -m x', at(['/r'])],
    ['{ exit; } & git commit -m x', at(['/r'])],
    ['{ cd /a; exit; } | cat; git commit -m x', at(['/r'])],
    ['f() { exit; }; { f; } | cat; git commit -m x', at(['/r'])],
    ['cat | { exit; }; git commit -m x', at(['/r'])],
    ['{ exit; }; git commit -m x', at([])],
    // shift and set -- move the arguments; unquoted $1 is split again.
    ['f() { shift; cd "$1"; }; f /a /b; git commit -m x', at(['/b'])],
    ['f() { set -- /z; cd "$1"; }; f /a; git commit -m x', at(['/z'])],
    ['f() { set -euo pipefail; cd "$1"; }; f /a; git commit -m x', at(['/a'])],
    ['f() { if x; then shift; fi; cd "$1"; }; f /a /b; git commit -m x', unknown],
    ['set -- /a; cd "$1"; git commit -m x', at(['/a'])],
    ['f() { cd $1; }; f "/my dir"; git commit -m x', unknown],
    ['f() { cd "$1"; }; f "/my dir"; git commit -m x', at(['/my dir'])],
    ['(set -- /a); cd "$1"; git commit -m x', unknown],
    // Code from a variable may cd; $(tool) output is taken as variables only.
    ['eval "$CMD"; git commit -m x', unknown],
    ['$CMD; git commit -m x', unknown],
    ['eval "$(ssh-agent -s)"; git commit -m x', at(['/r'])],
    ['"$GIT_HOME/bin/git" commit -m x', at(['/r'])],
    // exec: the shell becomes the command, so nothing after it runs.
    ['exec git commit -m x; git commit -m y', at(['/r'])],
    ['exec 2>&1; git commit -m x', at(['/r'])],
  ]) assert.deepStrictEqual(one(L(c)), want, c);
});

test('0.3.3 parser: script files built with printf, echo -e and >>, or changed by another command; PowerShell aliases, block copies, return, unknown calls', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd) => commitSites(cmd, { platform: 'linux', cwd: '/r', home: '/h' });
  const P = (cmd) => commitSites(cmd, { platform: 'win32', cwd: 'E:\\wt', home: 'C:\\U', shell: 'powershell' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  const at = (sites) => ({ sites, unresolved: [] });
  const unknown = { sites: [], unresolved: ['unknown-folder'] };
  for (const [c, want] of [
    ["printf 'cd /e/a\\ngit commit -m x\\n' > f.sh && bash f.sh", at(['/e/a'])],
    ["printf '%s\\n' 'cd /e/a' 'git commit -m x' > f.sh && bash f.sh", at(['/e/a'])],
    ["echo -e 'cd /e/a\\ngit commit -m x' > f.sh && bash f.sh", at(['/e/a'])],
    ["echo 'cd /e/a' > f.sh; echo 'git commit -m x' >> f.sh; bash f.sh", at(['/e/a'])],
    ["echo 'git commit -m x' >> f.sh; bash f.sh", unknown],
    // Changed since it was written: what it holds isn't known.
    ["echo 'cd /e/a' > f.sh; sed -i 's/a/b/' f.sh; source f.sh; git commit -m x", unknown],
    ["echo 'cd /e/a' > f.sh; mv g.sh f.sh; source f.sh; git commit -m x", unknown],
    ["echo 'cd /e/a' > f.sh; git checkout f.sh; source f.sh; git commit -m x", unknown],
    ["echo 'cd /e/a' > f.sh; chmod +x f.sh; source f.sh; git commit -m x", at(['/e/a'])],
    ["echo 'cd /e/a' > f.sh; sed -n 1p f.sh; source f.sh; git commit -m x", at(['/e/a'])],
    // $(git rev-parse --show-toplevel)/sub in a heredoc is built on the repo, not this folder.
    ['bash <<EOF\ncd $(git rev-parse --show-toplevel)/sub && git commit -m x\nEOF', unknown],
  ]) assert.deepStrictEqual(one(L(c)), want, c);
  for (const [c, want] of [
    ['Set-Alias -Name go -Value Set-Location; go E:\\a; git commit -m x', at(['E:\\a'])],
    ['New-Alias go Set-Location; go E:\\a; git commit -m x', at(['E:\\a'])],
    ['if ($x) { Set-Alias go Set-Location }; go E:\\a; git commit -m x', unknown],
    ['$sb = { cd E:\\a }; $sb2 = $sb; & $sb2; git commit -m x', at(['E:\\a'])],
    ['$sb = { cd E:\\a }; 1 | ForEach-Object $sb; git commit -m x', unknown],
    ['$sb = { cd E:\\a }; Start-Job $sb; git commit -m x', at(['E:\\wt'])],
    ['function f { return; Set-Location E:\\a }; f; git commit -m x', at(['E:\\wt'])],
    ['function f { if ($x) { return }; Set-Location E:\\a }; f; git commit -m x', unknown],
    ['function f { try { return } finally { Set-Location E:\\a } }; f; git commit -m x', at(['E:\\a'])],
    ['& { return; cd E:\\a }; git commit -m x', at(['E:\\wt'])],
    ['function f { exit }; f; git commit -m x', at([])],
    ['$cmd = "cd E:\\a"; iex $cmd; git commit -m x', unknown],
    ['& $h.go; git commit -m x', unknown],
    ['& ([scriptblock]::Create("cd E:\\a")); git commit -m x', unknown],
    ['Invoke-Command -ScriptBlock { param($d) cd $d } -ArgumentList E:\\a; git commit -m x', unknown],
    ['icm -Zzz { cd E:\\a }; git commit -m x', unknown],
    ['function Set-Location { Microsoft.PowerShell.Management\\Set-Location E:\\z }; Set-Location E:\\a; git commit -m x', at(['E:\\z'])],
    ['function git { & git.exe -C E:\\x @args }; git commit -m x', at(['E:\\x'])],
    ['function f { Set-Location $args[0] }; f E:\\a; git commit -m x', at(['E:\\a'])],
    ['& "$env:ProgramFiles\\Git\\bin\\git.exe" commit -m x', at(['E:\\wt'])],
  ]) assert.deepStrictEqual(one(P(c)), want, c);
});

test('0.3.3 commits: thousands of unresolved reasons stay one short list, and the facts fit a Windows environment variable', () => {
  const { s, wt, gWt, head, hook } = multiFolder();
  let helpers = 'f0() { :; }; ';
  for (let i = 1; i <= 12; i++) helpers += `f${i}() { ${Array(10).fill(`f${i - 1}`).join('; ')}; }; `;
  gWt('commit', '-q', '--allow-empty', '-m', 'after helpers');
  const r = hook(wt, SA, helpers + 'if false; then f12; fi; git commit -q --allow-empty -m "after helpers"');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  const un = notesOf(s).match(/COMMIT_UNRESOLVED/g) || [];
  assert.ok(un.length >= 1 && un.length <= 8, notesOf(s));
  const { fitCommitFacts } = require('../scripts/lib/gitfacts');
  const big = { folders: [{ dir: '/x', display: '/x', own: true, entries: Array.from({ length: 30 }, (_, i) => ({ sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'y'.repeat(100) + i })) }], unresolved: [] };
  const fit = fitCommitFacts(big, 2000);
  assert.ok(JSON.stringify(fit).length <= 2000, JSON.stringify(fit).length);
  assert.ok(fit.unresolved.some(u => u.why === 'too-many-commits'));
  assert.ok(head(wt));
});

// ---------- 0.3.3 review round 4 ----------

test('0.3.3 parser: shift past the end, an emptied script file, param() functions, removed and redefined aliases, blocks only passed on', () => {
  const { commitSites } = require('../scripts/lib/commands');
  const L = (cmd) => commitSites(cmd, { platform: 'linux', cwd: '/r', home: '/h' });
  const P = (cmd) => commitSites(cmd, { platform: 'win32', cwd: 'E:\\wt', home: 'C:\\U', shell: 'powershell' });
  const one = (r) => ({ sites: r.sites, unresolved: r.unresolved });
  const at = (sites) => ({ sites, unresolved: [] });
  const unknown = { sites: [], unresolved: ['unknown-folder'] };
  for (const [c, want] of [
    ['f() { shift 5; cd "$1"; }; f /a; git commit -m x', at(['/a'])],
    ["echo 'cd /e/a' > f.sh; > f.sh; source f.sh; git commit -m x", at(['/r'])],
    ["echo 'cd /e/a' > f.sh; >> f.sh; source f.sh; git commit -m x", at(['/e/a'])],
  ]) assert.deepStrictEqual(one(L(c)), want, c);
  for (const [c, want] of [
    ['function f { param($d) Set-Location $args[0] }; f E:\\a; git commit -m x', unknown],
    ['function f($d) { Set-Location $args[0] }; f E:\\a; git commit -m x', unknown],
    ['function f { Set-Location @args }; f E:\\a; git commit -m x', at(['E:\\a'])],
    ['Set-Alias go Set-Location; Remove-Item alias:go; go E:\\a; git commit -m x', at(['E:\\wt'])],
    ['Set-Alias go Set-Location; Remove-Alias go; go E:\\a; git commit -m x', at(['E:\\wt'])],
    ['Set-Alias cd Push-Location -Option AllScope -Force; cd E:\\a; Pop-Location; git commit -m x', unknown],
    ['$sb = { git commit -m x }; Write-Output $sb', { sites: [], unresolved: ['unrecognized'] }],
    ['$sb = { git commit -m x }; Measure-Command $sb', at(['E:\\wt'])],
    ['. { cd E:\\a }; git commit -m x', at(['E:\\a'])],
    ['function f { 1 | ForEach-Object { return }; cd E:\\a }; f; git commit -m x', at(['E:\\a'])],
    ['function f { if ($x) { return }; cd E:\\a }; f; git commit -m x', unknown],
  ]) assert.deepStrictEqual(one(P(c)), want, c);
});

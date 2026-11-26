'use strict';
// Tests for dev/tier.js and dev/review-gate.js. The CLI tests use their own
// temp folder and remove it.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const g = require('./review-gate.js');
const t = require('./tier.js');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'risk-tiers.json'), 'utf8'));
const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const B = 'main';
const body = '## Testing\nran it\n## Risk\nlow\n## How to revert\ngit revert';
const round = (sha, n = 0, base = B, r = 1) => ({ body: `x\n<!-- auto-review round=${r} sha=${sha} base=${base} blocking=${n} -->` });
const thread = (isResolved, replies = [], sha = H) => ({ isResolved, firstBody: `**t**\n<!-- auto-review finding=regression-1 sha=${sha} -->`, replies });
const base = (o = {}) => ({ tier: { tier: 'low' }, head: H, base: B, owner: 'jim', botLogin: 'github-actions', prBody: body,
  botComments: [round(H)], threads: [], comments: [], merged: [], draft: false, ...o });
const ship = (o = {}) => ({ body: `/ship ${H}`, user: 'jim', via_app: false, created_at: 't1', updated_at: 't1', ...o });
const file = (filename, patch = '', extra = {}) => ({ filename, status: 'modified', patch, ...extra });
const CLI = path.join(__dirname, 'review-gate.js');

test('tier: workflow change is high, test file low, script medium, unknown file medium', () => {
  assert.equal(t.classify([file('.github/workflows/tests.yml')], rules).tier, 'high');
  assert.equal(t.classify([file('plugins/trailmark/tests/a.test.js', '@@\n+assert.ok(1)')], rules).tier, 'low');
  assert.equal(t.classify([file('plugins/trailmark/scripts/x.js')], rules).tier, 'medium');
  assert.equal(t.classify([file('weird/new.bin', null, { status: 'added' })], rules).tier, 'medium');
});
test('tier: instruction files, manifests and the gate files are high, in any case', () => {
  for (const f of ['CLAUDE.local.md', 'plugins/x/claude.md', 'AGENTS.md', '.mcp.json', '.claude-plugin/marketplace.json',
    '.agents/plugins/marketplace.json', 'plugins/x/scripts/.gitattributes', 'REVIEW.md', 'PLAYBOOK.md', 'dev/review-gate.test.js', 'dev/tier.js']) {
    assert.equal(t.classify([file(f)], rules).tier, 'high', f);
  }
});
test('tier: rename out of a high path is high; empty list or a short list is high', () => {
  assert.equal(t.classify([file('x.md', '', { previous_filename: 'REVIEW.md', status: 'renamed' })], rules).tier, 'high');
  assert.equal(t.classify([], rules).tier, 'high');
  assert.equal(t.classify([file('dev/ship-signers')], rules).tier, 'high');
  assert.equal(t.classify([file('dev/sign-ship.sh')], rules).tier, 'high');
  assert.equal(t.classify([file('README.md')], rules, 3001).tier, 'high');
  assert.equal(t.classify([file('README.md')], rules, 1).tier, 'low');
});
test('tier: weakened tests lift to high; a conditional skip only adds a must-check', () => {
  const f = (patch) => [file('plugins/trailmark/tests/a.test.js', patch)];
  assert.equal(t.classify(f('@@\n-assert.ok(1)\n-assert.ok(2)\n+assert.ok(3)'), rules).tier, 'high');
  assert.equal(t.classify(f('@@\n-  assert(x)\n+  x;'), rules).tier, 'high');
  assert.equal(t.classify(f("@@\n+test('x', { skip: true }, () => {})"), rules).tier, 'high');
  assert.equal(t.classify(f("@@\n+test.todo('x')"), rules).tier, 'high');
  assert.equal(t.classify(f("@@\n+    return t.skip('long path')"), rules).tier, 'high');
  const c = t.classify(f("@@\n+test('x', { skip: WIN && 'no' }, () => {})"), rules);
  assert.equal(c.tier, 'low');
  assert.equal(c.mustCheck.length, 1);
  assert.equal(t.classify(f("@@\n+test('x', { skip: WIN && 'no' }, () => {})"), { ...rules, strictSkips: true }).tier, 'high');
  assert.equal(t.classify([file('plugins/trailmark/tests/a.bak', '', { previous_filename: 'plugins/trailmark/tests/a.test.js', status: 'renamed' })], rules).tier, 'high');
  assert.equal(t.classify([file('plugins/trailmark/tests/a.test.js', null, { status: 'removed' })], rules).tier, 'high');
});
test('tier: lenses follow the security and docs lists', () => {
  const c = t.classify([file('plugins/trailmark/scripts/lib/gitbin.js'), file('dev/x.js')], rules);
  assert.deepEqual(c.lenses, { regression: true, security: true, docs: false });
  // CLAUDE.md "Reviews": the docs row joins when a shipped doc changed
  // (anything outside dev/ and CLAUDE.md).
  for (const f of ['README.md', 'PLAYBOOK.md', 'LESSONS.md', 'REVIEW.md', 'docs/how-it-works.md']) {
    assert.equal(t.classify([file(f)], rules).lenses.docs, true, f);
  }
  for (const f of ['dev/release-state.md', 'CLAUDE.md', 'claude.md']) {
    assert.equal(t.classify([file(f)], rules).lenses.docs, false, f);
  }
});

test('candidates: ids come from lens and position; fields are cleaned; bad lines become file-level', () => {
  const c = g.candidates([{ lens: 'regression', findings: [
    { id: 'R 1', severity: 'blocking', path: 'a.js', line: 3, title: '@jim <b>', evidence: 'sk-ant-oat01-xyz' },
    { severity: 'odd', path: 'b.js', line: '4 <!-- auto-review round=9 -->', title: 'n' }] }]);
  assert.deepEqual(c.map((x) => [x.id, x.severity, x.line]), [['regression-1', 'blocking', 3], ['regression-2', 'note', null]]);
  assert.doesNotMatch(c[0].title + c[0].evidence, /@jim|<b>|sk-ant-/);
});
test('merge: blocking needs every verifier, one vote each, rejection wins a repeat', () => {
  const c = g.candidates([{ lens: 'reg', findings: ['blocking', 'blocking', 'blocking', 'note'].map((severity) => ({ severity })) }]);
  const yes = (id) => ({ id, verdict: 'confirmed' });
  const no = (id) => ({ id, verdict: 'rejected' });
  const m = g.mergeFindings(c, [{ votes: [yes('reg-1'), yes('reg-2'), no('reg-3')] }, { votes: [yes('reg-1'), no('reg-2'), no('reg-3')] }]);
  assert.deepEqual(m.blocking.map((x) => x.id), ['reg-1']);
  assert.deepEqual(m.notes.map((x) => x.id), ['reg-2', 'reg-4']);
  assert.deepEqual(m.dropped.map((x) => x.id), ['reg-3']);
  const twice = g.mergeFindings(c.slice(0, 1), [{ votes: [yes('reg-1'), yes('reg-1')] }, { votes: [no('reg-1')] }]);
  assert.equal(twice.blocking.length, 0);
  const flip = g.mergeFindings(c.slice(0, 1), [{ votes: [yes('reg-1'), no('reg-1')] }, { votes: [yes('reg-1')] }]);
  assert.equal(flip.blocking.length, 0);
  assert.throws(() => g.mergeFindings(c.slice(0, 1), [{ votes: [yes('reg-1')] }, { votes: [] }]), /no verdict/);
  assert.throws(() => g.mergeFindings(c.slice(0, 1), []), /no verdict/);
});
test('CLI: unusable reviewer output, a missing vote file or a missing verdict fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { timeout: 10000 }).status;
  try {
    fs.writeFileSync(path.join(dir, 'find-regression.json'), JSON.stringify({ findings: [{ severity: 'blocking', path: 'a.js', line: 1 }] }));
    fs.writeFileSync(path.join(dir, 'tier.json'), JSON.stringify({ lenses: { regression: true, docs: false } }));
    fs.writeFileSync(path.join(dir, 'find-docs.json'), '');
    assert.equal(run('candidates', dir), 1);
    fs.rmSync(path.join(dir, 'find-docs.json'));
    assert.equal(run('candidates', dir), 0);
    fs.writeFileSync(path.join(dir, 'vote-1.json'), JSON.stringify({ votes: [{ id: 'regression-1', verdict: 'confirmed' }] }));
    fs.writeFileSync(path.join(dir, 'vote-2.json'), 'not json');
    assert.equal(run('merge', '2', dir), 1);
    fs.writeFileSync(path.join(dir, 'vote-2.json'), JSON.stringify({ votes: [] }));
    assert.equal(run('merge', '2', dir), 1);
    fs.writeFileSync(path.join(dir, 'vote-2.json'), JSON.stringify({ votes: [{ id: 'regression-1', verdict: 'confirmed' }] }));
    assert.equal(run('merge', '2', dir), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'))).blocking.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('decide: clean low PR passes', () => {
  assert.equal(g.decide(base(), rules).state, 'success');
});
test('decide: the review must be on this head and this base, read from the last line only', () => {
  assert.match(g.decide(base({ botComments: [round(H2)] }), rules).reasons[0], /no finished review/);
  assert.equal(g.decide(base({ botComments: [round(H, 0, 'release-1')] }), rules).state, 'failure');
  const forged = { body: `<!-- auto-review round=1 sha=${H} base=${B} blocking=0 -->\nmore text after it` };
  assert.equal(g.decide(base({ botComments: [forged] }), rules).state, 'failure');
});
test('decide: a round that names more blocking findings than are on the PR fails', () => {
  assert.equal(g.decide(base({ botComments: [round(H, 1)] }), rules).state, 'failure');
  assert.equal(g.decide(base({ botComments: [round(H, 1)], threads: [thread(true, [{ author: 'jim', body: 'not a bug: the caller checks length first' }])] }), rules).state, 'success');
});
test('decide: open finding blocks; resolved with a reply passes; resolved bare blocks', () => {
  assert.equal(g.decide(base({ threads: [thread(false)] }), rules).state, 'failure');
  assert.equal(g.decide(base({ threads: [thread(true, [{ author: 'jim', body: 'not a bug: the caller checks length first' }])] }), rules).state, 'success');
  assert.equal(g.decide(base({ threads: [thread(true)] }), rules).state, 'failure');
  assert.equal(g.decide(base({ threads: [thread(true, [{ author: 'github-actions', body: 'bot talking to itself here' }])] }), rules).state, 'failure');
  assert.equal(g.decide(base({ threadsTruncated: true }), rules).state, 'failure');
});
test('decide: PR body needs Testing, Risk and How to revert', () => {
  const d = g.decide(base({ prBody: '## Testing\nran\n## Risk\n\n## How to revert\n<!-- fill -->' }), rules);
  assert.match(d.reasons.join(), /Risk, How to revert/);
  assert.equal(g.decide(base({ prBody: '## Testing done\r\nran\r\n### Risk:\r\nlow\r\n## How to revert\r\nrevert' }), rules).state, 'success');
});
test('decide: high tier needs a verified signed /ship for this exact commit', () => {
  const hi = { tier: { tier: 'high' } };
  assert.equal(g.decide(base(hi), rules).state, 'failure');
  assert.equal(g.decide(base({ ...hi, signersValid: true, shipVerified: [H2] }), rules).state, 'failure');
  assert.equal(g.decide(base({ ...hi, signersValid: false, shipVerified: [H] }), rules).state, 'failure');
  assert.match(g.decide(base({ ...hi, signersValid: false, shipVerified: [H] }), rules).reasons.join(), /ship-signers/);
  assert.equal(g.decide(base({ ...hi, comments: [ship()] }), rules).state, 'failure');
  assert.equal(g.decide(base({ ...hi, signersValid: true, shipVerified: [H] }), rules).state, 'success');
});
test('ship: signers file takes only security keys in the ship namespace; comment parsing', () => {
  const sk = 'owner namespaces="trailmark-ship" sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t jim';
  assert.equal(g.signersOk(`# keys\n${sk}\n`), true);
  assert.equal(g.signersOk('# only comments\n'), false);
  assert.equal(g.signersOk(sk.replace('sk-ssh-ed25519@openssh.com', 'ssh-ed25519')), false);
  assert.equal(g.signersOk(sk.replace('namespaces="trailmark-ship" ', '')), false);
  assert.equal(g.signersOk(sk.replace('owner ', 'session ')), false);
  assert.equal(g.signersOk(`${sk}\nowner cert-authority sk-ssh-ed25519@openssh.com AAAA`), false);
  const sig = '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----';
  assert.deepEqual(g.shipParts(`/ship ${H}\r\n\r\n\`\`\`\r\n${sig}\r\n\`\`\``), { sha: H, sig: sig + '\n' });
  assert.equal(g.shipParts(`/ship ${H}`), null);
  assert.equal(g.shipParts(`/ship ${H.slice(0, 7)}\n${sig}`), null);
  assert.equal(g.shipParts(`please /ship ${H}\n${sig}`), null);
});
test('ship: a key-signed comment verifies only for its own repo, PR, head and namespace', (t) => {
  if (spawnSync('ssh-keygen', ['-?']).error) return t.skip('ssh-keygen is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-'));
  try {
    const key = path.join(dir, 'k');
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0);
    // A plain key stands in for the security key here; signersOk refuses it in the workflow.
    fs.writeFileSync(path.join(dir, 'signers'), `owner namespaces="trailmark-ship" ${fs.readFileSync(key + '.pub', 'utf8')}`);
    const msg = path.join(dir, 'm');
    fs.writeFileSync(msg, g.shipMessage('o/r', 7, H));
    assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'trailmark-ship', msg]).status, 0);
    const sig = fs.readFileSync(msg + '.sig', 'utf8').trim();
    const comment = { body: `/ship ${H}\n\n\`\`\`\n${sig}\n\`\`\`\n`, user: 'jim' };
    const verify = (head, pr) => {
      const [x] = g.shipCandidates({ head, owner: 'jim', repo: 'o/r', pr, comments: [comment] }, { requireSk: false });
      if (!x) return false;
      const sf = path.join(dir, `s-${head.slice(0, 3)}-${pr}`);
      fs.writeFileSync(sf, x.sig);
      return spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(dir, 'signers'), '-I', 'owner', '-n', 'trailmark-ship',
        '-s', sf], { input: x.msg }).status === 0;
    };
    assert.equal(verify(H, 7), true);
    // The workflow's own command writes nothing for a key that isn't a security key.
    const r = path.join(dir, 'cli');
    fs.mkdirSync(r);
    fs.writeFileSync(path.join(r, 'gate-input.json'), JSON.stringify({ head: H, owner: 'jim', repo: 'o/r', pr: 7, comments: [comment] }));
    assert.equal(spawnSync(process.execPath, [CLI, 'ship-candidates', r]).stdout.toString().trim(), '0');
    assert.equal(verify(H, 8), false);
    assert.equal(verify(H2, 7), false);
    const wrongNs = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(dir, 'signers'), '-I', 'owner', '-n', 'git',
      '-s', msg + '.sig'], { input: fs.readFileSync(msg) }).status;
    assert.notEqual(wrongNs, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('decide: medium passes alone unless mediumNeedsOwner', () => {
  const md = { tier: { tier: 'medium' } };
  assert.equal(g.decide(base(md), rules).state, 'success');
  assert.equal(g.decide(base(md), { ...rules, mediumNeedsOwner: true }).state, 'failure');
});
test('decide: a finding still open on the fourth reviewed push escalates', () => {
  const shas = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  const d = g.decide(base({ head: shas[3], botComments: shas.map((s, i) => round(s, 1, B, i + 1)), threads: [thread(false, [], shas[3])] }), rules);
  assert.equal(d.escalate, true);
  assert.equal(d.needsOwner, true);
});
test('breaker: two regressions in the window trip it; resetAfter clears it', () => {
  const merged = [
    { number: 10, labels: ['tier:low'], body: '' }, { number: 11, labels: ['tier:medium'], body: '' },
    { number: 12, labels: ['tier:high'], body: '' },
    { number: 13, labels: ['tier:low'], body: 'fix\r\nRegression-of: #10\nRegression-of: #11' },
  ];
  assert.equal(g.breaker(merged, rules).tripped, true);
  assert.equal(g.decide(base({ merged }), rules).state, 'failure');
  assert.equal(g.breaker(merged, { ...rules, breaker: { resetAfter: 12 } }).tripped, false);
});
test('payload: findings first, round marker last, with base and blocking count', () => {
  const c = g.candidates([{ lens: 'r', findings: [{ severity: 'blocking', path: 'a.js', line: 3, title: 't' }, { severity: 'blocking', path: 'b.js', title: 'u' }] }]);
  const p = g.payload({ head: H, base: B, round: 2, tier: { tier: 'low' }, findings: { blocking: c, notes: [] } });
  assert.equal(p.comments[0].line, 3);
  assert.equal(p.comments[1].subject_type, 'file');
  assert.match(p.comments[0].body, /<!-- auto-review finding=r-1 sha=a{40} -->$/);
  assert.match(p.review.body, /\n<!-- auto-review round=2 sha=a{40} base=main blocking=2 -->$/);
});

test('tier: text in quotes is not a condition; an if on the same line is; nested tests and .mjs count', () => {
  const f = (patch, name = 'plugins/trailmark/tests/a.test.js') => [file(name, patch)];
  assert.equal(t.classify(f("@@\n+test.skip('why? && how', () => {})"), rules).tier, 'high');
  assert.equal(t.classify(f("@@\n+  if (process.env.CI) { t.skip('slow'); return; }"), rules).tier, 'low');
  assert.equal(t.classify(f("@@\n+test.skip('x', () => {})", 'plugins/trailmark/tests/unit/b.test.mjs'), rules).tier, 'high');
});
test('decide: past maxRounds the owner decides even after every thread is resolved', () => {
  const shas = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  const reason = [{ author: 'jim', body: 'not a bug: the caller checks length first' }];
  const d = g.decide(base({ head: shas[3], botComments: shas.map((s, i) => round(s, 0, B, i + 1)), threads: [thread(true, reason, shas[0])] }), rules);
  assert.equal(d.escalate, true);
  assert.equal(d.state, 'failure');
  const ok = g.decide(base({ head: shas[3], botComments: shas.map((s, i) => round(s, 0, B, i + 1)), threads: [] }), rules);
  assert.equal(ok.state, 'success');
});
test('decide: "fixed in" on a finding raised on this head blocks until a push', () => {
  const fixed = [{ author: 'jim', body: 'fixed in 1234567' }];
  assert.match(g.decide(base({ threads: [thread(true, fixed, H)] }), rules).reasons.join(' '), /push the fix/);
  assert.equal(g.decide(base({ botComments: [round(H2, 1, B, 1), round(H, 0, B, 2)], threads: [thread(true, fixed, H2)] }), rules).state, 'success');
});
test('payload: a finding on a file the diff does not change goes on a changed file and names its own', () => {
  const c = g.candidates([{ lens: 'r', findings: [{ severity: 'blocking', path: 'lib/other.js', line: 9, title: 't' }] }]);
  const p = g.payload({ head: H, base: B, round: 1, tier: { tier: 'low' }, findings: { blocking: c, notes: [] }, changed: ['a.js'] });
  assert.equal(p.comments[0].path, 'a.js');
  assert.equal(p.comments[0].subject_type, 'file');
  assert.equal(p.comments[0].line, undefined);
  assert.match(p.comments[0].body, /^In `lib\/other\.js:9`/);
});
test('evals: the eval workflow and runner use the review workflow\'s CLI, model, tools, prompt and flags', () => {
  const wf = (n) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', n), 'utf8');
  const envOf = (text) => Object.fromEntries([...text.matchAll(/^ {2}([A-Z_]+): (.+)$/gm)].map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1')]));
  const review = envOf(wf('auto-review.yml'));
  const evals = envOf(wf('review-evals.yml'));
  for (const k of ['CLI_VERSION', 'MODEL_REGRESSION', 'TOOLS', 'READ_TOOLS', 'DENY_TOOLS']) {
    assert.ok(review[k], `auto-review.yml sets ${k}`);
    assert.equal(evals[k], review[k], k);
  }
  assert.match(review.CLI_VERSION, /^\d+\.\d+\.\d+$/);
  const run = require('./review-evals/run.js');
  const line = wf('auto-review.yml').split('\n').find((l) => l.includes('reviewer for PR $PR'));
  const shell = line.match(/-p "(.*)" \\$/)[1].replace(/\\"/g, '"').replace('$1', 'regression').replace('$1', 'regression').replace('$PR', '7');
  assert.equal(run.reviewerPrompt('regression', 7), shell);
  // The flags after the prompt, with their values, the same in both directions.
  const lines = wf('auto-review.yml').split('\n');
  const at = lines.indexOf(line);
  const call = lines.slice(at + 1, at + 4).join(' ').split('>')[0];
  const shellArgs = call.replace(/\\/g, ' ').trim().split(/\s+/).map((a) => a.replace(/^"(.*)"$/, '$1'));
  const asShell = { MODEL_REGRESSION: '$2', TOOLS: '$TOOLS', READ_TOOLS: '$READ_TOOLS', DENY_TOOLS: '$DENY_TOOLS' };
  assert.deepEqual(run.reviewerArgs(asShell, 'P').slice(2), shellArgs);
  // The same install step, word for word.
  const install = (text) => text.match(/^ +npm install [\s\S]*?CLAUDE_BIN=\$bin" >> "\$GITHUB_ENV"$/m)[0];
  assert.equal(install(wf('review-evals.yml')), install(wf('auto-review.yml')));
});
test('evals: a case is caught only by a blocking finding on its file within 10 lines', () => {
  const run = require('./review-evals/run.js');
  const c = { file: 'plugins/trailmark/scripts/x.js', lines: [50, 80] };
  const f = (o) => [{ severity: 'blocking', path: c.file, line: 60, ...o }];
  assert.equal(run.caught(c, f()), true);
  assert.equal(run.caught(c, f({ line: 61 })), false);
  assert.equal(run.caught(c, f({ line: 39 })), false);
  assert.equal(run.caught(c, f({ line: 40 })), true);
  assert.equal(run.caught(c, f({ severity: 'note' })), false);
  assert.equal(run.caught(c, f({ path: '.review/head/plugins/trailmark/scripts/x.js' })), true);
  assert.equal(run.caught(c, f({ path: 'plugins/trailmark-codex/scripts/x.js' })), false);
  assert.equal(run.caught(c, f({ line: null })), false);
  assert.equal(run.parseResult(JSON.stringify({ result: '```json\n{"findings":[]}\n```' })).findings.length, 0);
  assert.equal(run.parseResult(JSON.stringify({ result: 'Here it is: {"findings":[]}' })), null);
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'review-evals', 'cases.json'), 'utf8')).cases;
  assert.ok(cases.length >= 6 && cases.length <= 10, `${cases.length} cases`);
  for (const k of cases) {
    assert.match(k.causeMerge, /^[0-9a-f]{40}$/, k.id);
    assert.ok(typeof k.file === 'string' && k.lines.length > 0 && k.lines.every(Number.isInteger), k.id);
  }
});
test('ship: a security-key signature counts only with the touch flag set', () => {
  const str = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const B_ = (x) => Buffer.from(x);
  const blob = (flags, ns = 'trailmark-ship') => {
    const inner = Buffer.concat([str(B_('sk-ssh-ed25519@openssh.com')), str(Buffer.alloc(64)), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
    const v = Buffer.alloc(4); v.writeUInt32BE(1);
    const body = Buffer.concat([B_('SSHSIG'), v, str(B_('pub')), str(B_(ns)), str(B_('')), str(B_('sha512')), str(inner)]);
    return `-----BEGIN SSH SIGNATURE-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END SSH SIGNATURE-----`;
  };
  const d = (sig) => ({ head: H, owner: 'jim', repo: 'o/r', pr: 1, comments: [{ user: 'jim', body: `/ship ${H}\n${sig}` }] });
  assert.deepEqual(g.sigInfo(blob(0x01)), { ns: 'trailmark-ship', type: 'sk-ssh-ed25519@openssh.com', sk: true, flags: 1 });
  assert.equal(g.shipCandidates(d(blob(0x01))).length, 1);
  assert.equal(g.shipCandidates(d(blob(0x05))).length, 1);
  assert.equal(g.shipCandidates(d(blob(0x00))).length, 0);
  assert.equal(g.shipCandidates(d(blob(0x01, 'git'))).length, 0);
  assert.equal(g.sigInfo('-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----'), null);
});

// Round 1 of the review of this branch (2026-11-21).
test('candidates: a "lens" key in a reviewer\'s JSON does not replace the lens from its file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { timeout: 10000 }).status;
  try {
    const one = (title) => ({ findings: [{ severity: 'blocking', path: 'a.js', line: 1, title }] });
    fs.writeFileSync(path.join(dir, 'find-regression.json'), JSON.stringify(one('real')));
    fs.writeFileSync(path.join(dir, 'find-docs.json'), JSON.stringify({ lens: 'regression', ...one('decoy') }));
    fs.writeFileSync(path.join(dir, 'tier.json'), JSON.stringify({ lenses: { regression: true, docs: true } }));
    assert.equal(cli('candidates', dir), 0);
    const ids = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'))).map((c) => c.id).sort();
    assert.deepEqual(ids, ['docs-1', 'regression-1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => g.candidates([{ lens: 'x -->\n@a', findings: [] }]), /bad lens/);
  assert.throws(() => g.candidates([{ lens: 'r', findings: [{}] }, { lens: 'r', findings: [{}] }]), /share an id/);
});
test('decide: a resolved finding counts as answered only with a reply from the owner\'s login', () => {
  const r = (author, b = 'not a problem, trust me on this') => [thread(true, [{ author, body: b }])];
  assert.equal(g.decide(base({ threads: r('stranger') }), rules).state, 'failure');
  assert.equal(g.decide(base({ threads: r('copilot-pull-request-reviewer') }), rules).state, 'failure');
  assert.equal(g.decide(base({ threads: r('jim') }), rules).state, 'success');
  assert.equal(g.decide(base({ threads: r('jim', 'ok fine') }), rules).state, 'failure');
});
test('decide: an escalated PR passes with the owner\'s verified /ship on the head, and not without it', () => {
  const four = [H2, 'c'.repeat(40), 'd'.repeat(40)].map((s) => round(s)).concat([round(H)]);
  const reason = [{ author: 'jim', body: 'not a bug: the caller checks length first' }];
  const d = (o) => g.decide(base({ botComments: four, threads: [thread(true, reason, H2)], ...o }), rules);
  assert.equal(d({}).escalate, true);
  assert.equal(d({}).state, 'failure');
  assert.match(d({}).reasons.join('\n'), /4 reviewed pushes \(more than 3\) and a finding on at least one/);
  assert.equal(d({ signersValid: true, shipVerified: [H] }).state, 'success');
  assert.equal(d({ signersValid: true, shipVerified: [H2] }).state, 'failure');
  // Three reviewed pushes with a finding: not yet escalated.
  const three = g.decide(base({ botComments: four.slice(1), threads: [thread(true, reason, 'c'.repeat(40))] }), rules);
  assert.equal(three.escalate, false);
  assert.equal(three.state, 'success');
});
test('decide: a tier it does not know fails', () => {
  for (const tier of [{}, { tier: 'High' }, { tier: 'none' }]) assert.equal(g.decide(base({ tier }), rules).state, 'failure');
});
test('breaker: a list item, lower case and several PRs on one line all count; a mention mid-line does not', () => {
  const auto = (n) => ({ number: n, body: '', labels: ['tier:low'] });
  const by = (b) => g.breaker([auto(10), auto(11), auto(12), { number: 20, body: b, labels: [] }], rules).hits.sort();
  assert.deepEqual(by('Regression-of: #10, #11'), [10, 11]);
  assert.deepEqual(by('Regression-of: #10 #11'), [10, 11]);
  assert.deepEqual(by('- Regression-of: #10\n- regression-of: #12'), [10, 12]);
  assert.deepEqual(by('Regression-of: 11'), [11]);
  assert.deepEqual(by('This is no Regression-of: #10'), []);
  // A high-tier PR is not counted, and only the last `window` low or medium ones are.
  assert.deepEqual(g.breaker([{ number: 10, body: '', labels: ['tier:high'] }, { number: 20, body: 'Regression-of: #10', labels: [] }], rules).hits, []);
  const many = Array.from({ length: 25 }, (_, i) => auto(i + 1));
  assert.deepEqual(g.breaker([...many, { number: 99, body: 'Regression-of: #1\nRegression-of: #6', labels: [] }], rules).hits, [6]);
});
test('clean: more token shapes go, and an entity cannot rebuild a mention', () => {
  const s = g.clean(`github_pat_${'A'.repeat(30)} ghr_${'b'.repeat(30)} xghs_${'c'.repeat(30)} &#64;octocat`);
  assert.doesNotMatch(s, /github_pat_A|ghr_b|ghs_c/);
  assert.match(s, /&amp;#64;octocat/);
});
test('candidates: a path under .review/head/ or with ./ is the PR\'s own path', () => {
  const c = g.candidates([{ lens: 'r', findings: [{ severity: 'blocking', path: '.review/head/a.js', line: 3 }, { severity: 'blocking', path: './b.js', line: 4 }] }]);
  assert.deepEqual(c.map((x) => x.path), ['a.js', 'b.js']);
  const p = g.payload({ head: H, base: B, round: 1, tier: { tier: 'low' }, findings: { blocking: c, notes: [] }, changed: ['a.js', 'b.js'] });
  assert.deepEqual(p.comments.map((x) => [x.path, x.line]), [['a.js', 3], ['b.js', 4]]);
});
test('sections: an unclosed comment, a lone dash or headings inside a code fence do not fill a section', () => {
  const ok = '## Testing\nran it\n## Risk\nlow\n## How to revert\ngit revert';
  assert.deepEqual(g.sections(ok), []);
  assert.deepEqual(g.sections(ok.replace('ran it', '<!-- what you ran')), ['Testing', 'Risk', 'How to revert']);
  assert.deepEqual(g.sections(ok.replace('ran it', '-')), ['Testing']);
  assert.deepEqual(g.sections('```\n' + ok + '\n```'), ['Testing', 'Risk', 'How to revert']);
  assert.deepEqual(g.sections('```js\nx\n```\n' + ok), []);
});
test('tier: more skip forms lift the tier; a constant that decides the skip is not a condition', () => {
  const f = (patch) => t.classify([file('plugins/trailmark/tests/a.test.js', `@@\n+${patch}`)], rules);
  for (const l of ["t.skip ('x');", "t['skip']('x');", "test('a', { skip }, () => {})", "test.only('a', () => {})",
    "test('a', { skip: true || 0 }, () => {})", "test('a', { skip: 1 ? 'always' : 0 }, () => {})"]) {
    assert.equal(f(l).tier, 'high', l);
  }
  assert.equal(f("test('a', { skip: WIN && 'no' }, () => {})").tier, 'low');
  // Words in quotes or comments are not a skip or a focus (PRs #63 and #52).
  assert.equal(f("const OFF_WIN = { skip: WIN && 'the system makes these failures outside Windows only' };").tier, 'low');
  assert.equal(f('  // one (Windows only: macOS has no path that long).').tier, 'low');
  assert.equal(f("test('a', { only: true }, () => {})").tier, 'high');
});
test('decide: gaps the round-1 mutations showed', () => {
  // /ship from another login is not a candidate, with a signature that would pass otherwise.
  const str = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const inner = Buffer.concat([str(Buffer.from('sk-ssh-ed25519@openssh.com')), str(Buffer.alloc(64)), Buffer.from([1]), Buffer.from([0, 0, 0, 1])]);
  const v = Buffer.alloc(4); v.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from('SSHSIG'), v, str(Buffer.from('pub')), str(Buffer.from('trailmark-ship')), str(Buffer.from('')), str(Buffer.from('sha512')), str(inner)]);
  const sig = `-----BEGIN SSH SIGNATURE-----\n${blob.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END SSH SIGNATURE-----`;
  const by = (user) => g.shipCandidates({ head: H, owner: 'jim', repo: 'o/r', pr: 1, comments: [{ user, body: `/ship ${H}\n${sig}` }] }).length;
  assert.equal(by('jim'), 1);
  assert.equal(by('eve'), 0);
  assert.equal(g.decide(base({ draft: true }), rules).state, 'failure');
  // The posted count is of threads on this head only.
  assert.ok(g.decide(base({ botComments: [round(H, 1)], threads: [thread(false, [], H2)] }), rules).reasons.some((r) => /round says 1/.test(r)));
  // Two markers on one sha are one round.
  assert.equal(g.decide(base({ botComments: [round(H), round(H)] }), rules).round, 1);
  // "fixed in" blocks on the raised head only when every owner reply says so.
  const both = [{ author: 'jim', body: 'fixed in 1234567' }, { author: 'jim', body: 'and the reason it holds is here' }];
  assert.equal(g.decide(base({ threads: [thread(true, both)] }), rules).state, 'success');
  assert.ok(g.decide(base({ tier: { tier: 'x'.repeat(200) } }), rules).description.length <= 140);
});
test('evals: every case\'s cause merge is in this repo', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'review-evals', 'cases.json'), 'utf8')).cases;
  for (const k of cases) {
    const r = spawnSync('git', ['-C', path.join(__dirname, '..'), 'cat-file', '-e', `${k.causeMerge}^{commit}`], { timeout: 10000 });
    assert.equal(r.status, 0, k.id);
  }
});
test('evals: with no PR text a case does not run, so its own title is never the PR\'s', () => {
  const runJs = JSON.stringify(path.join(__dirname, 'review-evals', 'run.js'));
  const code = `try { require(${runJs}).prText({ causePr: 1, title: 'the bug' }); console.log('returned'); } catch (e) { console.log('threw: ' + e.message); }`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: '' } });
  assert.match(r.stdout, /^threw: no PR text for #1/);
});
test('tier: a line with an unclosed quote and many backslash pairs is read in linear time', () => {
  const tierJs = JSON.stringify(path.join(__dirname, 'tier.js'));
  const rulesJs = JSON.stringify(path.join(__dirname, 'risk-tiers.json'));
  // An unclosed quote, then 40 backslash pairs: exponential for a regex that
  // can split each pair two ways. On a skip call (the old reader ran there
  // only) and on a plain line (the new one reads every line).
  const pairs = '\\\\'.repeat(40);
  const line = "+t.skip('" + pairs + "y\n+x('" + pairs + 'y';
  const code = `const t = require(${tierJs}); const r = require(${rulesJs});
    const s = Date.now(); t.classify([{ filename: 'plugins/trailmark/tests/a.test.js', status: 'modified', patch: '@@\\n' + ${JSON.stringify(line)} }], r);
    console.log(Date.now() - s);`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, null, 'classify did not finish in 20 s');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(r.stdout) < 2000, `took ${r.stdout.trim()} ms`);
});
test('tier: skip words in prose stay low; quoted keys, ?.() and only: 1 lift; a conditional skip with a comment is a must-check', () => {
  const f = (patch) => t.classify([file('plugins/trailmark/tests/a.test.js', `@@\n+${patch}`)], rules);
  for (const l of ['const x = parse("a, only, b");', 'const { skip, todo } = opts;', '  // reads it, only, then stops',
    "assert.equal(mode, 'skip');"]) {
    assert.equal(f(l).tier, 'low', l);
  }
  for (const l of ["test('a', { 'skip': true }, () => {})", "t.skip?.('x');", "test('a', { only: 1 }, () => {})",
    "if (WIN) test.only('a', () => {})", "WIN && t.todo('later')"]) {
    assert.equal(f(l).tier, 'high', l);
  }
  const c = f("test('a', { skip: WIN && 'no' }, () => {}) // Windows only");
  assert.equal(c.tier, 'low');
  assert.equal(c.mustCheck.length, 1);
});
test('breaker: after the first PR only #N counts; quote, numbered and bold lines count', () => {
  const auto = (n) => ({ number: n, body: '', labels: ['tier:low'] });
  const by = (b) => g.breaker([auto(10), auto(11), auto(12), { number: 20, body: b, labels: [] }], rules).hits.sort();
  assert.deepEqual(by('Regression-of: #10 11 tests failed'), [10]);
  assert.deepEqual(by('Regression-of: #10 and #11'), [10, 11]);
  assert.deepEqual(by('> Regression-of: #10'), [10]);
  assert.deepEqual(by('1. Regression-of: #11'), [11]);
  assert.deepEqual(by('**Regression-of:** #12'), [12]);
  assert.deepEqual(by('Regression-of: 12'), [12]);
});
test('sections: fenced text fills a section; any fence keeps its headings and comment openers from counting', () => {
  const ok = '## Testing\nran it\n## Risk\nlow\n## How to revert\ngit revert';
  const none = ['Testing', 'Risk', 'How to revert'];
  assert.deepEqual(g.sections(ok.replace('ran it', '```\nnpm test\n```')), []);
  assert.deepEqual(g.sections(ok.replace('ran it', '```\n<!-- x\n```')), []);
  assert.deepEqual(g.sections(ok.replace('ran it', '```x``` ran')), []);
  for (const fence of ['~~~', '   ```', '````']) {
    assert.deepEqual(g.sections(`${fence}\n${ok}\n${fence}`), none, fence);
  }
  // A shorter fence does not close a longer one.
  assert.deepEqual(g.sections(`\`\`\`\`\n${ok}\n\`\`\`\n`), none);
});
test('decide: the owner\'s login matches in any case', () => {
  const r = [{ author: 'jim', body: 'the reason it holds is here' }];
  assert.equal(g.decide(base({ owner: 'Jim', threads: [thread(true, r)] }), rules).state, 'success');
});
test('evals: the workflow runs the regression reviewer on MODEL_REGRESSION, which review-evals.yml sets once', () => {
  const wf = (n) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', n), 'utf8');
  assert.ok(wf('auto-review.yml').split('\n').some((l) => l.trim() === 'run regression "$MODEL_REGRESSION" &'));
  assert.equal(wf('review-evals.yml').match(/MODEL_REGRESSION:/g).length, 1);
});
test('evals: case ids are plain names; a plain folder the run did not make is never deleted', () => {
  const run = require('./review-evals/run.js');
  for (const id of ['..', '.', '', 'A', 'a/b', 'a\\b', '-a', 'a'.repeat(61), undefined]) {
    assert.throws(() => run.checkId({ id }), /bad case id/, String(id));
  }
  run.checkId({ id: 'longroot-note-cut-test' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evalids-'));
  try {
    const work = path.join(tmp, 'work');
    const mine = path.join(work, 'some-case');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'keep.txt'), 'x');
    assert.throws(() => run.prepare({ id: '..', causePr: 1, causeMerge: 'HEAD' }, work), /bad case id/);
    assert.throws(() => run.prepare({ id: 'some-case', causePr: 1, causeMerge: 'HEAD' }, work), /is already there/);
    run.dropWorktree(mine);
    assert.ok(fs.existsSync(path.join(mine, 'keep.txt')));
    assert.ok(fs.existsSync(work));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('evals: exit 2 when any case has no result or there are none, else 0 at the floor and 1 below', () => {
  const { exitCode } = require('./review-evals/run.js');
  assert.equal(exitCode([], 0.5), 2);
  assert.equal(exitCode([{ caught: true }, { noResult: true }], 0.5), 2);
  assert.equal(exitCode([{ caught: true }, { caught: false }], 0.5), 0);
  assert.equal(exitCode([{ caught: false }, { caught: false }], 0.5), 1);
});
test('tier: shorthand with other keys, a call in a template or after a stray quote, and a CR line all lift', () => {
  const f = (patch) => t.classify([file('plugins/trailmark/tests/a.test.js', `@@\n+${patch}`)], rules);
  for (const l of ["it('x', { skip, timeout: 5 }, f)", "it('x', { timeout: 5, skip }, f)", "it('x', { todo }, f)",
    'const m = `${t.skip(\'x\')}`;', "/* don't */ t.skip(); // can't", "x = /'/; t.skip('a'); y = /'/",
    "t.skip('a') /* ? */", "t.skip('x'); // a && b\r"]) {
    const c = f(l);
    assert.equal(c.tier, 'high', JSON.stringify(l));
    assert.equal(c.mustCheck.length, 0, JSON.stringify(l));
  }
  assert.equal(f('const { skip, todo } = opts;').tier, 'low');
});
test('tier: lines built to slow a quote or comment reader are read in linear time', () => {
  const tierJs = JSON.stringify(path.join(__dirname, 'tier.js'));
  const rulesJs = JSON.stringify(path.join(__dirname, 'risk-tiers.json'));
  // A quote, then many escaped quotes and no closing one; many slashes and a
  // CR. The child builds the lines: they are too long for a command line.
  const code = `const t = require(${tierJs}); const r = require(${rulesJs});
    const q = String.fromCharCode(39), b = String.fromCharCode(92), cr = String.fromCharCode(13), nl = String.fromCharCode(10);
    const patch = '@@' + nl + '+t.skip(' + q + (b + q).repeat(80000) + nl + '+' + '/'.repeat(80000) + cr;
    const s = Date.now(); t.classify([{ filename: 'plugins/trailmark/tests/a.test.js', status: 'modified', patch }], r);
    console.log(Date.now() - s);`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, null, 'classify did not finish in 20 s');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(r.stdout) < 2000, `took ${r.stdout.trim()} ms`);
});
test('breaker: bold or italic with the colon inside or after the marks counts; a long run of blanks is read in linear time', () => {
  const auto = (n) => ({ number: n, body: '', labels: ['tier:low'] });
  const by = (b) => g.breaker([auto(10), auto(11), auto(12), { number: 20, body: b, labels: [] }], rules).hits.sort();
  assert.deepEqual(by('**Regression-of**: #10'), [10]);
  assert.deepEqual(by('__Regression-of:__ #11'), [11]);
  assert.deepEqual(by('*Regression-of:* #12'), [12]);
  const s = Date.now();
  g.breaker([auto(1), { number: 20, body: 'Regression-of: #1' + ' '.repeat(60000) + 'x', labels: [] }], rules);
  assert.ok(Date.now() - s < 2000, `took ${Date.now() - s} ms`);
});
test('sections: a fence line inside a comment opens nothing; many comment openers are read in linear time', () => {
  const ok = '## Testing\nran it\n## Risk\nlow\n## How to revert\ngit revert';
  assert.deepEqual(g.sections('<!--\n```\n-->\n' + ok), []);
  assert.deepEqual(g.sections('<!-- a --> <!--\n```\n-->\n' + ok), []);
  assert.deepEqual(g.sections('<!--\n```\n' + ok), ['Testing', 'Risk', 'How to revert']);
  const s = Date.now();
  g.sections('<!--'.repeat(15000) + '\n' + ok);
  g.sections('<!--\n' + '-->'.repeat(15000) + '<!--'.repeat(15000) + '\n' + ok);
  assert.ok(Date.now() - s < 2000, `took ${Date.now() - s} ms`);
});
// A test's cleanup of the one worktree it made: never `git worktree prune`, which is repo-wide and
// would drop the record of an unrelated worktree whose folder is away. `remove --force` leaves a
// locked worktree, so it is unlocked first (RS-G-testprune, RS-G-testlocked).
function dropOwnWorktree(root, p) {
  spawnSync('git', ['-C', root, 'worktree', 'unlock', p], { timeout: 60000 });
  spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', p], { timeout: 60000 });
}
test('evals: the test cleanup removes a locked worktree of its own and leaves another worktree whose folder is away (RS-G-testlocked, RS-G-testprune)', () => {
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evallocked-'));
  const mine = path.join(tmp, 'mine');
  const away = path.join(tmp, 'away');
  const gitq = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 60000 });
  const listed = () => gitq('worktree', 'list', '--porcelain').stdout.toLowerCase();
  try {
    assert.equal(gitq('worktree', 'add', '--detach', mine, 'HEAD').status, 0);
    assert.equal(gitq('worktree', 'add', '--detach', away, 'HEAD').status, 0);
    fs.rmSync(away, { recursive: true, force: true });
    assert.equal(gitq('worktree', 'lock', mine).status, 0);
    // The old cleanup: a plain `remove --force` does not take a locked worktree.
    assert.notEqual(gitq('worktree', 'remove', '--force', mine).status, 0);
    assert.ok(listed().includes('jbmem-evallocked-'), 'locked record is still there');
    dropOwnWorktree(root, mine);
    assert.ok(!listed().includes(path.basename(mine) + '\n'), 'own record gone');
    assert.equal(fs.existsSync(mine), false);
    assert.ok(listed().includes('away'), 'the other record is kept');
  } finally {
    dropOwnWorktree(root, mine);
    dropOwnWorktree(root, away);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('evals: a worktree of this repo the run did not make is kept, untracked files and all', () => {
  const run = require('./review-evals/run.js');
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evaltree-'));
  const ws = path.join(tmp, 'work', 'user-tree');
  try {
    const add = spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', ws, 'HEAD'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(add.status, 0, add.stderr);
    fs.writeFileSync(path.join(ws, 'my-notes.txt'), 'x');
    assert.throws(() => run.prepare({ id: 'user-tree', causePr: 1, causeMerge: 'HEAD' }, path.join(tmp, 'work')), /is already there/);
    assert.ok(fs.existsSync(path.join(ws, 'my-notes.txt')));
  } finally {
    dropOwnWorktree(root, ws);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('evals: two cases with one id stop the run before any case starts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evaldup-'));
  try {
    const cases = path.join(tmp, 'cases.json');
    fs.writeFileSync(cases, JSON.stringify({ cases: [{ id: 'same', causePr: 1, causeMerge: 'HEAD' }, { id: 'same', causePr: 2, causeMerge: 'HEAD' }] }));
    const env = { ...process.env, CLAUDE_BIN: 'none', MODEL_REGRESSION: 'm', TOOLS: 't', READ_TOOLS: 'r', DENY_TOOLS: 'd', PATH: '' };
    const r = spawnSync(process.execPath, [path.join(__dirname, 'review-evals', 'run.js'), cases, path.join(tmp, 'work')], { encoding: 'utf8', timeout: 60000, env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /two cases share an id/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('sections: hidden comments holding fence lines leave a section empty; a fence closes only on its own kind, length and a bare line', () => {
  const ok = '## Testing\nran it\n## Risk\nlow\n## How to revert\ngit revert';
  const none = ['Testing', 'Risk', 'How to revert'];
  // Two comments, each with a fence line: GitHub shows an empty Testing section.
  assert.deepEqual(g.sections('## Testing\n<!--\n```\n-->\n<!-- hidden filler\n```\n-->\n## Risk\nlow\n## How to revert\ngit revert'), ['Testing']);
  assert.deepEqual(g.sections('```\n~~~\n' + ok), none);
  assert.deepEqual(g.sections('```\n```js\n' + ok), none);
  assert.deepEqual(g.sections('````\n```\n' + ok + '\n````\n'), none);
});
test('tier: a call named in a comment lifts; a key form inside a string does not', () => {
  const f = (patch) => t.classify([file('plugins/trailmark/tests/a.test.js', `@@\n+${patch}`)], rules);
  assert.equal(f("// t.skip('later')").tier, 'high');
  for (const l of ["const s = 'skip: true';", 'const s = "{ skip }";', "log('only: 1')"]) {
    assert.equal(f(l).tier, 'low', l);
  }
});
test('breaker: a task box, a blank before the colon and bare numbers after a comma count', () => {
  const auto = (n) => ({ number: n, body: '', labels: ['tier:low'] });
  const by = (b) => g.breaker([auto(10), auto(11), auto(12), { number: 20, body: b, labels: [] }], rules).hits.sort();
  assert.deepEqual(by('- [x] Regression-of: #10'), [10]);
  assert.deepEqual(by('Regression-of : #11'), [11]);
  assert.deepEqual(by('Regression-of: 10, 11'), [10, 11]);
  assert.deepEqual(by('Regression-of: #10, 12'), [10, 12]);
  assert.deepEqual(by('_Regression-of:_ #12'), [12]);
});
test('evals: an empty folder made while gh runs is not taken for the run\'s own, and is kept', () => {
  const run = require('./review-evals/run.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evalrace-'));
  try {
    const work = path.join(tmp, 'work');
    const ws = path.join(work, 'race-case');
    // The gh call's stand-in makes the folder, as another process could.
    const made = () => { fs.mkdirSync(ws, { recursive: true }); return { title: 't', body: '' }; };
    assert.throws(() => run.prepare({ id: 'race-case', causePr: 1, causeMerge: 'HEAD' }, work, { prText: made }), /EEXIST/);
    assert.equal(run.live.has(ws), false);
    run.dropWorktree(ws);
    assert.ok(fs.existsSync(ws));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('evals: prepare reaches git worktree add, and the run removes the worktree it made', () => {
  const run = require('./review-evals/run.js');
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evaladd-'));
  const ws = path.join(tmp, 'work', 'add-case');
  try {
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30000 }).stdout.trim();
    run.prepare({ id: 'add-case', causePr: 1, causeMerge: head }, path.join(tmp, 'work'), { prText: () => ({ title: 't', body: '' }) });
    assert.ok(run.live.has(ws));
    assert.ok(fs.existsSync(path.join(ws, '.review', 'pr.json')));
    run.dropWorktree(ws);
    assert.equal(fs.existsSync(ws), false);
    const list = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 30000 }).stdout;
    assert.ok(!list.toLowerCase().includes('add-case'), 'worktree still registered');
  } finally {
    dropOwnWorktree(root, ws);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('evals: a link at .review or REVIEW.md in the checked-out parent stops the case (RS-G-reviewlink)', () => {
  const run = require('./review-evals/run.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evallink-'));
  try {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    const mk = (name) => { const ws = path.join(tmp, name); fs.mkdirSync(ws); return ws; };
    // No link: fine, with or without the names there.
    const plain = mk('plain');
    fs.mkdirSync(path.join(plain, '.review'));
    fs.writeFileSync(path.join(plain, 'REVIEW.md'), 'x');
    run.noLinks(plain);
    run.noLinks(mk('empty'));
    // A directory link (a junction needs no privilege on Windows) at .review.
    const d = mk('dirlink');
    fs.symlinkSync(outside, path.join(d, '.review'), 'junction');
    assert.throws(() => run.noLinks(d), /\.review is a link/);
    // A file link at REVIEW.md: needs symlink rights on Windows, so that half is skipped there without them.
    const f = mk('filelink');
    let made = true;
    try { fs.symlinkSync(path.join(outside, 'target.md'), path.join(f, 'REVIEW.md'), 'file'); } catch (e) { if (e.code !== 'EPERM') throw e; made = false; }
    if (made) assert.throws(() => run.noLinks(f), /REVIEW\.md is a link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('evals: git\'s own refusal at worktree add stops the case, and the run-owned folder goes with whatever is in it (RS-G-addhappy, RS-G-mkdirfill)', () => {
  const run = require('./review-evals/run.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evalrefuse-'));
  const ws = path.join(tmp, 'work', 'refuse-case');
  try {
    // A merge that is not there: git refuses the add, and `prepare` throws with the folder still in `live`.
    assert.throws(() => run.prepare({ id: 'refuse-case', causePr: 1, causeMerge: '0'.repeat(40) }, path.join(tmp, 'work'), { prText: () => ({ title: 't', body: '' }) }));
    assert.ok(run.live.has(ws));
    // The folder is this run's (made with a create that fails if it is there), so a file another process
    // puts in it is removed with it. That is the design: nothing outside the run's own folder is touched.
    fs.writeFileSync(path.join(ws, 'stray.txt'), 'x');
    run.dropWorktree(ws);
    assert.equal(fs.existsSync(ws), false);
    assert.equal(run.live.has(ws), false);
    assert.ok(fs.existsSync(path.join(tmp, 'work')));
  } finally {
    run.dropWorktree(ws);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('evals: a tree name with a backslash, colon or dotted part stops the case, and nothing is written outside', () => {
  const run = require('./review-evals/run.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evalpath-'));
  try {
    const dir = path.join(tmp, 'a', 'b', 'head');
    fs.mkdirSync(dir, { recursive: true });
    const bs = String.fromCharCode(92);
    const tree = (names) => names.map((n) => `100644 blob ${'1'.repeat(40)}\t${n}`).join('\0') + '\0';
    const opts = (names) => ({ lsTree: () => tree(names), blob: () => Buffer.from('x') });
    const bad = [`x${bs}..${bs}..${bs}..${bs}out.txt`, `..${bs}out.txt`, 'C:out.txt', 'a:stream', 'x/../../../out.txt',
      'x/.. /out.txt', 'x/./y', 'x/y.', '/out.txt', 'x//y'];
    for (const n of bad) {
      assert.throws(() => run.writeHead('sha', dir, opts([n])), /unsafe path/, JSON.stringify(n));
    }
    assert.deepEqual(fs.readdirSync(tmp), ['a']);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'a')), ['b']);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'a', 'b')), ['head']);
    assert.deepEqual(fs.readdirSync(dir), []);
    const good = ['a/b.txt', '.github/x.yml', 'a/.hidden', 'x..y/z'];
    assert.deepEqual(run.writeHead('sha', dir, opts(good)), []);
    for (const n of good) assert.equal(fs.readFileSync(path.join(dir, n), 'utf8'), 'x', n);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('evals: Ctrl+C removes the run\'s own worktree and keeps the record of another worktree whose folder is missing', () => {
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-evalprune-'));
  const other = path.join(tmp, 'other-tree');
  const own = path.join(tmp, 'work', 'prune-case');
  const gitq = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 60000 });
  try {
    const head = gitq('rev-parse', 'HEAD').stdout.trim();
    assert.equal(gitq('worktree', 'add', '--detach', other, head).status, 0);
    fs.rmSync(other, { recursive: true, force: true });
    const code = `const run = require(${JSON.stringify(path.join(__dirname, 'review-evals', 'run.js'))});
run.prepare({ id: 'prune-case', causePr: 1, causeMerge: ${JSON.stringify(head)} }, ${JSON.stringify(path.join(tmp, 'work'))}, { prText: () => ({ title: 't', body: '' }) });
run.stop();`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 130, r.stderr);
    assert.equal(fs.existsSync(own), false);
    const list = gitq('worktree', 'list', '--porcelain').stdout.toLowerCase();
    assert.ok(!list.includes('prune-case'), 'own worktree still registered');
    assert.ok(list.includes('other-tree'), 'the other worktree\'s record was dropped');
  } finally {
    // Only this test's own records go (see dropOwnWorktree): the run's worktree stays
    // when the run did not finish its own cleanup (an assertion failed first, or the
    // worktree is locked), and `other` always stays until here.
    dropOwnWorktree(root, own);
    dropOwnWorktree(root, other);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('tier: a destructuring on the line, a slash-star in a regex and a stray quote do not hide a skip or fake its condition', () => {
  const f = (patch) => t.classify([file('plugins/trailmark/tests/a.test.js', `@@\n+${patch}`)], rules);
  // RS-G-destructline: only the destructuring itself is exempt, not the rest of the line.
  assert.equal(f("const { a } = o; test('x', { skip }, () => {})").tier, 'high');
  assert.equal(f('const { skip, todo } = opts;').tier, 'low');
  // RS-G-regexcomment: a /* with no end after code may be a regex; one that opens the line is a comment.
  const c = f("const re = /a\\/*b/; test('x', { skip: true }, () => {})");
  assert.equal(c.tier, 'high');
  assert.equal(f('/* the docs say { skip: true } here').tier, 'low');
  // RS-G-rawconditional: && inside a string, with a stray quote after it, is not a condition.
  const d = f("t.skip('a && b', /'/)");
  assert.equal(d.tier, 'high');
  assert.equal(d.mustCheck.length, 0);
  // A real condition before a stray quote still counts.
  const e = f("test('x', { skip: WIN && 'no' }, /'/)");
  assert.equal(e.tier, 'low');
  assert.equal(e.mustCheck.length, 1);
});
test('tier: a todo or focus stays high after a stray quote, and a nested destructuring is exempt whole', () => {
  const f = (patch) => t.classify([file('plugins/trailmark/tests/a.test.js', `@@\n+${patch}`)], rules);
  // PR 116, Codex: a condition with a stray quote before test.only or test.todo must not make it a must-check.
  for (const l of ["if (WIN) { const re = /'/; test.only('x', fn); }", "if (WIN) { const re = /'/; test.todo('x'); }"]) {
    const c = f(l);
    assert.equal(c.tier, 'high', l);
    assert.equal(c.mustCheck.length, 0, l);
  }
  // PR 116, Codex: a nested pattern or a default is part of the destructuring.
  for (const l of ['const { a: { skip }, b } = opts;', 'const { skip = {}, todo } = opts;', 'let { a: { b: { todo } } } = opts;']) {
    assert.equal(f(l).tier, 'low', l);
  }
  // What follows the destructuring still counts, and so does an assignment that is a comparison.
  assert.equal(f("const { a: { skip }, b } = opts; test('x', { skip }, fn)").tier, 'high');
  assert.equal(f("const { skip } == 1; test('x', { skip }, fn)").tier, 'high');
  // PR 116, Opus: the first line of a multi-line destructuring is all pattern, and a
  // `skip: true ||` after a stray quote still keeps the line high.
  assert.equal(f('const { skip,').tier, 'low');
  // PR 116, review round 2: a closed comment inside a skip is still taken out when a `/*` with no end, or a stray quote, follows.
  assert.equal(f("test('x', { skip /* flaky */ }, fn); /* see #12").tier, 'high');
  assert.equal(f("test('x', { skip/* flaky */: true }, fn); /* see #12").tier, 'high');
  assert.equal(f("test('x', { skip /* flaky */ }, /'/); /* see #12").tier, 'high');
  // PR 116, round 4: the raw read still guards a mispaired quote or comment earlier on the line,
  // and a constant skip that the raw read leaves unnormalized still keeps the line high.
  assert.equal(f("it's done`); test('x', { skip: true }, fn); f('y')").tier, 'high');
  assert.equal(f("const glob = /src\\/*.js/; test('x', { skip: true }, fn); /* end */ 'x").tier, 'high');
  for (const l of ["test('x', { skip: 'flaky' || WIN }, fn); /* see #12", "test('x', { skip: true /* c */ || WIN }, fn); /* x", "test('x', { skip: `a` || WIN }, fn); /* x"]) {
    assert.equal(f(l).tier, 'high', l);
  }
  // PR 116, review round 3 (automated): stray quotes that pair across the skip must not hide it.
  assert.equal(f("const re = /'/; test('x', { skip: true }, () => [/'/, /'/].map(f))").tier, 'high');
  // PR 116, round 5: the raw half of the constant check (a mispaired quote makes the keep read miss it).
  assert.equal(f("if (WIN) it's test('x', { skip: 1 ? 'a' : b }, fn)").tier, 'high');
  assert.equal(f("if (WIN) it's test('x', { skip: true || WIN }, fn) f('y')").tier, 'high');
  // PR 116, review note: a condition before a `/*` with no end still counts (the strict read stops at it); a todo after it does not.
  const o = f("test('x', { skip: WIN }, fn); /* the docs say skip: true");
  assert.equal(o.tier, 'low');
  assert.equal(o.mustCheck.length, 1);
  assert.equal(f("test('x', { skip: WIN }, fn); /* todo later").tier, 'high');
  // The strict read stops at the `/*`, so a `&&` in the comment is not a condition.
  assert.equal(f("test('x', { skip: true }, fn); /* a && b").tier, 'high');
  // PR 116, Opus round 2: a brace in a string or regex of the pattern must not hide what follows.
  for (const l of ["const { a = '{' } = o; test('x', { skip }, /'/)", "const { a = '{' } = o; test('x', { only }, /'/)", "const { a = /{/ } = o; test('x', { skip }, fn)", "const { a /* { */ } = o; test('x', { skip }, /'/)", 'const { a = /{/ } = o; test(x, { skip }, fn)']) {
    assert.equal(f(l).tier, 'high', l);
  }
  assert.equal(f("test('x', { skip: WIN }, /'/, { skip: true || x })").tier, 'high');
});
test('lens-ok: only JSON with a findings array passes, as `candidates` requires', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-lensok-'));
  try {
    const ok = (body) => {
      const f = path.join(tmp, 'f.json');
      fs.writeFileSync(f, body);
      return spawnSync(process.execPath, [path.join(__dirname, 'review-gate.js'), 'lens-ok', f], { encoding: 'utf8', timeout: 20000 }).status;
    };
    assert.equal(ok('{"findings":[]}'), 0);
    assert.equal(ok('{"findings":[{"title":"x"}],"lens":"a"}'), 0);
    for (const bad of ['', 'not json', '{}', '{"findings":null}', '{"findings":{}}', '[]', 'null', '5', '{"findings":"x"}']) assert.equal(ok(bad), 1, JSON.stringify(bad));
    const gone = spawnSync(process.execPath, [path.join(__dirname, 'review-gate.js'), 'lens-ok', path.join(tmp, 'nope.json')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(gone.status, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
// The text of a shell function in a workflow step, from its header to the closing
// brace at the same indent, with the step's 10-space indent removed.
const wfFn = (wf, header, from = 0) => {
  const start = wf.indexOf('          ' + header, from);
  const end = wf.indexOf('\n          }\n', start);
  assert.ok(start > 0 && end > start, `${header} is in the workflow`);
  return { text: wf.slice(start, end + '\n          }'.length).split('\n').map((l) => l.slice(10)).join('\n'), at: start };
};
// Reads a step's stderr as the runner does: every line must sit inside a stop
// block, and a block ends only at its own resume token, so no line is read with
// workflow commands live. Returns each block's text, in order.
const stopBlocks = (err) => {
  const blocks = [];
  let tok = null;
  let cur = [];
  for (const l of err.replace(/\n$/, '').split('\n')) {
    if (tok === null) {
      const m = /^::stop-commands::([0-9a-f]{32})$/.exec(l);
      assert.ok(m, `a line outside a stop block: ${JSON.stringify(l.slice(0, 80))}`);
      tok = m[1];
      cur = [];
    } else if (l === `::${tok}::`) {
      blocks.push(cur.join('\n'));
      tok = null;
    } else cur.push(l);
  }
  assert.equal(tok, null, 'every stop block is closed');
  return blocks;
};
const wfText = () => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'auto-review.yml'), 'utf8');
// The workflow's tails(). The first RS-G-tailorder test fails when it is missing;
// a no-op stands in for it here, so the worker tests still check that a worker
// itself writes nothing to stderr (the check an older workflow fails).
const tailsText = (wf) => (wf.includes('          tails() { # lens|vote') ? wfFn(wf, 'tails() { # lens|vote').text : 'tails() { :; }');
test('workflow: both review steps print failure text only through one tails(), after wait (RS-G-tailorder)', () => {
  const wf = wfText();
  const lens = wfFn(wf, 'run() { # lens model');
  const vote = wfFn(wf, 'vote() { # verifier');
  const t1 = wfFn(wf, 'tails() { # lens|vote');
  const t2 = wfFn(wf, 'tails() { # lens|vote', t1.at + 1);
  assert.ok(t1.at < lens.at && lens.at < t2.at && t2.at < vote.at, 'each step defines tails() before its worker');
  assert.equal(t1.text, t2.text, 'the two steps print the same way');
  assert.ok(wf.includes('\n          wait\n          tails lens\n          node dev/review-gate.js candidates .review || exit 1\n'), 'the lens step prints after wait');
  assert.ok(wf.includes('\n          for i in $(seq 1 "$VERIFIERS"); do vote "$i" & done\n          wait\n          tails vote\n'), 'the verifier step prints after wait');
  // A worker never writes to the step's stderr itself.
  for (const fn of [lens.text, vote.text]) assert.ok(!/>&2/.test(fn), 'no >&2 in a worker');
});
test('workflow: a lens that gives nothing is asked once more, prints its stderr tail, and still fails on a second empty answer', (t) => {
  if (spawnSync('bash', ['-c', 'true'], { timeout: 20000 }).status !== 0) return t.skip('bash is needed');
  const wf = wfText();
  const fn = wfFn(wf, 'run() { # lens model').text + '\n' + tailsText(wf);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-lensrun-'));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, '.review'));
    // As the tier step leaves it: only the regression lens, so `candidates` fails on its answer, not on a missing lens.
    fs.writeFileSync(path.join(tmp, '.review', 'tier.json'), JSON.stringify({ lenses: { regression: true, security: false, docs: false } }));
    fs.mkdirSync(path.join(tmp, 'dev'));
    fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(tmp, 'dev', 'review-gate.js'));
    // A stand-in for the one jq call run() makes (jq -r '.result // ""' FILE), so the test needs only bash and node.
    fs.mkdirSync(path.join(tmp, 'bin'));
    // Like jq, it writes a parse error to stderr when the CLI's output is not JSON.
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), 'const t = require("fs").readFileSync(process.argv[2], "utf8"); let o = {}; try { if (t.trim()) o = JSON.parse(t); } catch { console.error("jq: parse error (stand-in)"); process.exit(2); } console.log(o.result ?? "");\n');
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$3"\n', { mode: 0o755 });
    // The stand-in CLI: the answers it gives, one per call, the last one repeating.
    const stub = path.join(tmp, 'stub.sh');
    fs.writeFileSync(stub, [
      '#!/bin/bash',
      'n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STUB_COUNT"',
      // A failed call prints text that is not JSON, so jq complains too.
      'if [ "$n" -le "$STUB_EMPTY" ]; then echo "cli crashed $n"; echo "boom: transient error $n" >&2; echo "::error title=spoof::from stderr" >&2; exit 1; fi',
      'echo \'{"result":"```json\\n{\\"findings\\":[]}\\n```"}\'',
      '',
    ].join('\n'), { mode: 0o755 });
    const go = (empty) => {
      const count = path.join(tmp, 'count');
      fs.rmSync(count, { force: true });
      fs.rmSync(path.join(tmp, '.review', 'tail-lens-regression.txt'), { force: true });
      // run() alone must leave the step's stderr empty; only tails, after it, prints.
      const script = ['set -uo pipefail', `PR=7 TOOLS=a READ_TOOLS=b DENY_TOOLS=c CLAUDE_BIN="${sh(stub)}"`, fn,
        'run regression m 2> .review/worker-stderr.txt; echo "rc=$?"; tails lens'].join('\n');
      const r = spawnSync('bash', ['-c', script], { cwd: tmp, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH, STUB_COUNT: sh(count), STUB_EMPTY: String(empty) } });
      return { out: r.stdout, err: r.stderr, worker: fs.readFileSync(path.join(tmp, '.review', 'worker-stderr.txt'), 'utf8'),
        calls: Number(fs.readFileSync(count, 'utf8')), found: fs.readFileSync(path.join(tmp, '.review', 'find-regression.json'), 'utf8') };
    };
    // Empty once: asked again, the second answer is used, and the log says why the first failed.
    const once = go(1);
    assert.match(once.out, /rc=0/);
    assert.equal(once.calls, 2);
    assert.equal(once.worker, '', 'run() wrote nothing to stderr itself');
    // The runner reads stderr for `::command::` lines: all of it sits in one closed stop block.
    const blocks = stopBlocks(once.err);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /regression reviewer gave no usable output \(attempt 1 of 2\)/);
    assert.match(blocks[0], /^jq: parse error \(stand-in\)$/m, "jq's stderr is kept with the worker's text");
    assert.match(blocks[0], /boom: transient error 1/);
    assert.match(blocks[0], /^::error title=spoof::from stderr$/m);
    assert.deepEqual(JSON.parse(once.found), { findings: [] });
    // Empty twice: two calls, no more, and the failure stays so `candidates` fails the job.
    const twice = go(2);
    assert.match(twice.out, /rc=1/);
    assert.equal(twice.calls, 2);
    assert.equal(twice.worker, '');
    assert.match(stopBlocks(twice.err).join('\n'), /\(attempt 2 of 2\)/);
    assert.notEqual(spawnSync(process.execPath, [path.join(tmp, 'dev', 'review-gate.js'), 'candidates', path.join(tmp, '.review')], { encoding: 'utf8', timeout: 20000 }).status, 0);
    // A good first answer: one call and nothing on stderr.
    const fine = go(0);
    assert.match(fine.out, /rc=0/);
    assert.equal(fine.calls, 1);
    assert.equal(fine.worker, '');
    assert.equal(fine.err, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
const VCANDS = [{ id: 'regression-1', severity: 'blocking' }, { id: 'docs-1', severity: 'note' }, { id: 'security-1', severity: 'blocking' }];
const vote = (...ids) => ({ votes: ids.map((id) => ({ id, verdict: 'confirmed' })) });
test('vote-ok: only a verdict for every blocking candidate passes, and the reason is named (RS-G-emptyverifier)', () => {
  assert.equal(g.voteProblem(vote('regression-1', 'security-1'), VCANDS), null);
  // A note needs no verdict; an extra id or a null entry does no harm.
  assert.equal(g.voteProblem({ votes: [null, 5, { id: 'regression-1', verdict: 'confirmed' }, { id: 'security-1', verdict: 'rejected' }, { id: 'x-9' }, { id: 'docs-1', verdict: 'maybe' }] }, VCANDS), null);
  assert.equal(g.voteProblem(vote('regression-1'), VCANDS), 'no verdict for security-1');
  assert.equal(g.voteProblem({ votes: [{ id: 'docs-1' }] }, VCANDS), 'no verdict for regression-1');
  for (const bad of [null, 5, 'x', [], {}, { votes: null }, { votes: {} }]) assert.equal(g.voteProblem(bad, VCANDS), 'no votes array', JSON.stringify(bad));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-voteok-'));
  try {
    const cands = path.join(tmp, 'candidates.json');
    fs.writeFileSync(cands, JSON.stringify(VCANDS));
    const ok = (text, c = cands) => {
      const f = path.join(tmp, 'vote-1.json');
      if (text === undefined) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, text);
      return spawnSync(process.execPath, [CLI, 'vote-ok', f, c], { encoding: 'utf8', timeout: 20000 });
    };
    assert.equal(ok(JSON.stringify(vote('security-1', 'regression-1'))).status, 0);
    assert.equal(ok(JSON.stringify(vote('security-1', 'regression-1'))).stderr, '');
    const cases = [['', 'vote-1.json: not JSON'], ['not json', 'vote-1.json: not JSON'], ['{}', 'vote-1.json: no votes array'],
      [JSON.stringify(vote('regression-1')), 'vote-1.json: no verdict for security-1'], [undefined, 'vote-1.json: missing']];
    for (const [text, why] of cases) {
      const r = ok(text);
      assert.equal(r.status, 1, String(JSON.stringify(text)));
      assert.equal(r.stderr.trim(), why);
    }
    // Candidates it can't read fail too, so a broken step never reads as a good vote.
    const r = ok(JSON.stringify(vote('security-1', 'regression-1')), path.join(tmp, 'none.json'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^no candidates in /);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('vote-ok and merge: a blocking finding\'s verdict must be "confirmed" or "rejected"; any other is unusable, not a rejection (RS-G-verdictvalue)', () => {
  const v = (verdict) => ({ votes: [{ id: 'regression-1', verdict: 'confirmed' }, verdict === undefined ? { id: 'security-1' } : { id: 'security-1', verdict }] });
  for (const bad of [undefined, 'Confirmed', 'REJECTED', true, 1, null, '', ' confirmed']) {
    assert.equal(g.voteProblem(v(bad), VCANDS), 'bad verdict for security-1', String(JSON.stringify(bad)));
  }
  assert.equal(g.voteProblem(v('rejected'), VCANDS), null);
  // A second entry for the same id with a bad verdict spoils a good one.
  assert.equal(g.voteProblem({ votes: [...v('confirmed').votes, { id: 'security-1', verdict: 'yes' }] }, VCANDS), 'bad verdict for security-1');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-verdict-'));
  try {
    fs.writeFileSync(path.join(tmp, 'candidates.json'), JSON.stringify(VCANDS));
    for (const bad of [undefined, 'Confirmed', true]) {
      fs.writeFileSync(path.join(tmp, 'vote-1.json'), JSON.stringify(v(bad)));
      const ok = spawnSync(process.execPath, [CLI, 'vote-ok', path.join(tmp, 'vote-1.json'), path.join(tmp, 'candidates.json')], { encoding: 'utf8', timeout: 20000 });
      assert.equal(ok.status, 1, `vote-ok ${JSON.stringify(bad)}`);
      assert.equal(ok.stderr.trim(), 'vote-1.json: bad verdict for security-1');
      // On the parent this merged, with security-1 counted as rejected and dropped.
      const m = spawnSync(process.execPath, [CLI, 'merge', '1', tmp], { encoding: 'utf8', timeout: 20000 });
      assert.equal(m.status, 1, `merge ${JSON.stringify(bad)}`);
      assert.equal(m.stderr.trim(), 'a verifier gave no usable output (vote-1.json: bad verdict for security-1)');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('merge: a failed verifier is named with its file and reason; only vote-1 to vote-N count (RS-G-emptyverifier)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-votemerge-'));
  const merge = (n = '3') => spawnSync(process.execPath, [CLI, 'merge', n, tmp], { encoding: 'utf8', timeout: 20000 });
  const put = (i, v) => fs.writeFileSync(path.join(tmp, `vote-${i}.json`), typeof v === 'string' ? v : JSON.stringify(v));
  try {
    fs.writeFileSync(path.join(tmp, 'candidates.json'), JSON.stringify(VCANDS));
    put(1, vote('regression-1', 'security-1'));
    put(2, 'oops');
    put(4, vote('regression-1', 'security-1'));
    let r = merge();
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'a verifier gave no usable output (vote-2.json: not JSON; vote-3.json: missing)');
    // A fourth file does not stand in for a missing third.
    put(2, vote('regression-1'));
    put(3, vote('regression-1', 'security-1'));
    r = merge();
    assert.equal(r.stderr.trim(), 'a verifier gave no usable output (vote-2.json: no verdict for security-1)');
    put(2, { votes: [null, { id: 'regression-1', verdict: 'confirmed' }, { id: 'security-1', verdict: 'rejected' }] });
    r = merge();
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(fs.readFileSync(path.join(tmp, 'findings.json'), 'utf8'));
    assert.deepEqual([out.verifiers, out.blocking.map((c) => c.id), out.notes.map((c) => c.id)], [3, ['regression-1'], ['docs-1', 'security-1']]);
    // Each of these fails closed later too; the message shows the count check ran first.
    for (const bad of ['0', '-1', 'x', '', '1e3', '1000']) {
      const b = merge(bad);
      assert.equal(b.status, 1, bad);
      assert.match(b.stderr, /^bad verifier count "/, bad);
    }
    // With no blocking finding, nothing needs a vote.
    fs.writeFileSync(path.join(tmp, 'candidates.json'), JSON.stringify([VCANDS[1]]));
    for (const i of [1, 2, 3, 4]) fs.rmSync(path.join(tmp, `vote-${i}.json`), { force: true });
    assert.equal(merge().status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('workflow: a verifier that gives nothing is asked once more, prints its stderr tail, and still fails on a second empty answer (RS-G-emptyverifier)', (t) => {
  if (spawnSync('bash', ['-c', 'true'], { timeout: 20000 }).status !== 0) return t.skip('bash is needed');
  const wf = wfText();
  const fn = wfFn(wf, 'vote() { # verifier').text + '\n' + tailsText(wf);
  assert.ok(wf.includes('\n          for i in $(seq 1 "$VERIFIERS"); do vote "$i" & done\n          wait\n'), 'each verifier runs through vote()');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-voterun-'));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, '.review'));
    fs.mkdirSync(path.join(tmp, 'dev'));
    fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(tmp, 'dev', 'review-gate.js'));
    fs.writeFileSync(path.join(tmp, '.review', 'candidates.json'), JSON.stringify(VCANDS));
    // A stand-in for the one jq call vote() makes (jq -r '.result // ""' FILE), so the test needs only bash and node.
    fs.mkdirSync(path.join(tmp, 'bin'));
    // Like jq, it writes a parse error to stderr when the CLI's output is not JSON.
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), 'const t = require("fs").readFileSync(process.argv[2], "utf8"); let o = {}; try { if (t.trim()) o = JSON.parse(t); } catch { console.error("jq: parse error (stand-in)"); process.exit(2); } console.log(o.result ?? "");\n');
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$3"\n', { mode: 0o755 });
    // The stand-in CLI: STUB_EMPTY bad answers first (no JSON, then a vote that leaves out a blocking finding), then a good one.
    const stub = path.join(tmp, 'stub.sh');
    fs.writeFileSync(stub, [
      '#!/bin/bash',
      'n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STUB_COUNT"',
      'if [ "$n" -le "$STUB_EMPTY" ]; then',
      '  if [ "$n" = 1 ]; then echo \'{"result":""}\'; else echo \'{"result":"{\\"votes\\":[{\\"id\\":\\"regression-1\\",\\"verdict\\":\\"confirmed\\"}]}"}\'; fi',
      '  echo "boom: transient error $n" >&2; echo "::error title=spoof::from stderr" >&2; exit 1',
      'fi',
      'echo \'{"result":"```json\\n{\\"votes\\":[{\\"id\\":\\"regression-1\\",\\"verdict\\":\\"confirmed\\"},{\\"id\\":\\"security-1\\",\\"verdict\\":\\"rejected\\"}]}\\n```"}\'',
      '',
    ].join('\n'), { mode: 0o755 });
    const go = (empty) => {
      const count = path.join(tmp, 'count');
      fs.rmSync(count, { force: true });
      fs.rmSync(path.join(tmp, '.review', 'tail-vote-2.txt'), { force: true });
      // vote() alone must leave the step's stderr empty; only tails, after it, prints.
      const script = ['set -uo pipefail', `PR=7 TOOLS=a READ_TOOLS=b DENY_TOOLS=c MODEL_VERIFY=m CLAUDE_BIN="${sh(stub)}"`, fn,
        'vote 2 2> .review/worker-stderr.txt; echo "rc=$?"; tails vote'].join('\n');
      const r = spawnSync('bash', ['-c', script], { cwd: tmp, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH, STUB_COUNT: sh(count), STUB_EMPTY: String(empty) } });
      return { out: r.stdout, err: r.stderr, worker: fs.readFileSync(path.join(tmp, '.review', 'worker-stderr.txt'), 'utf8'),
        calls: Number(fs.readFileSync(count, 'utf8')), vote: fs.readFileSync(path.join(tmp, '.review', 'vote-2.json'), 'utf8') };
    };
    // The lens step's file, already printed by that step: `tails vote` leaves it out.
    fs.writeFileSync(path.join(tmp, '.review', 'tail-lens-regression.txt'), 'lens text\n');
    // Empty once: asked again, the second answer is used, and the log says why the first failed.
    const once = go(1);
    assert.match(once.out, /rc=0/);
    assert.equal(once.calls, 2);
    assert.equal(once.worker, '', 'vote() wrote nothing to stderr itself');
    assert.doesNotMatch(once.err, /lens text/);
    // The runner reads stderr for `::command::` lines: all of it sits in one closed stop block.
    const blocks = stopBlocks(once.err);
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /vote-2\.json: not JSON/);
    assert.match(blocks[0], /verifier 2 gave no usable output \(attempt 1 of 2\)/);
    assert.match(blocks[0], /boom: transient error 1/);
    assert.match(blocks[0], /^::error title=spoof::from stderr$/m);
    assert.equal(JSON.parse(once.vote).votes.length, 2);
    // Bad twice (the second a vote missing a blocking finding): two calls, no more, and the failure stays so `merge` fails the job.
    const twice = go(2);
    assert.match(twice.out, /rc=1/);
    assert.equal(twice.calls, 2);
    assert.equal(twice.worker, '');
    const both = stopBlocks(twice.err).join('\n');
    assert.match(both, /vote-2\.json: no verdict for security-1/);
    assert.match(both, /\(attempt 2 of 2\)/);
    const m = spawnSync(process.execPath, [path.join(tmp, 'dev', 'review-gate.js'), 'merge', '2', path.join(tmp, '.review')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(m.status, 1);
    assert.match(m.stderr, /vote-2\.json: no verdict for security-1/);
    // A good first answer: one call and nothing on stderr.
    const fine = go(0);
    assert.match(fine.out, /rc=0/);
    assert.equal(fine.calls, 1);
    assert.equal(fine.worker, '');
    assert.equal(fine.err, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('workflow: two verifiers that fail at once print their tails one after the other, each in its own closed stop block (RS-G-tailorder)', (t) => {
  if (spawnSync('bash', ['-c', 'true'], { timeout: 20000 }).status !== 0) return t.skip('bash is needed');
  const wf = wfText();
  const fn = wfFn(wf, 'vote() { # verifier').text + '\n' + tailsText(wf);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-votepair-'));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, '.review'));
    fs.mkdirSync(path.join(tmp, 'dev'));
    fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(tmp, 'dev', 'review-gate.js'));
    fs.writeFileSync(path.join(tmp, '.review', 'candidates.json'), JSON.stringify(VCANDS));
    fs.mkdirSync(path.join(tmp, 'bin'));
    // Like jq, it writes a parse error to stderr when the CLI's output is not JSON.
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), 'const t = require("fs").readFileSync(process.argv[2], "utf8"); let o = {}; try { if (t.trim()) o = JSON.parse(t); } catch { console.error("jq: parse error (stand-in)"); process.exit(2); } console.log(o.result ?? "");\n');
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$3"\n', { mode: 0o755 });
    // The stand-in CLI always fails; it names its verifier (from the prompt) on each of its 20 stderr lines, a command among them.
    const stub = path.join(tmp, 'stub.sh');
    fs.writeFileSync(stub, [
      '#!/bin/bash',
      'case "$2" in *"verifier 1 "*) w=1 ;; *) w=2 ;; esac',
      'echo "cli crashed"',
      'for k in $(seq 1 19); do echo "worker $w line $k" >&2; done',
      'echo "::error title=w$w::from worker $w" >&2',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const script = ['set -uo pipefail', `PR=7 TOOLS=a READ_TOOLS=b DENY_TOOLS=c MODEL_VERIFY=m CLAUDE_BIN="${sh(stub)}"`, fn,
      'for i in 1 2; do vote "$i" & done', 'wait', 'tails vote'].join('\n');
    const r = spawnSync('bash', ['-c', script], { cwd: tmp, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH } });
    const blocks = stopBlocks(r.stderr);
    assert.equal(blocks.length, 2, 'one block per verifier');
    blocks.forEach((b, i) => {
      const w = i + 1;
      const other = 3 - w;
      assert.match(b, new RegExp(`verifier ${w} gave no usable output \\(attempt 1 of 2\\)`));
      assert.match(b, new RegExp(`verifier ${w} gave no usable output \\(attempt 2 of 2\\)`));
      assert.match(b, new RegExp(`^::error title=w${w}::from worker ${w}$`, 'm'));
      assert.equal(b.split('\n').filter((l) => l === 'jq: parse error (stand-in)').length, 2, "jq's stderr from both attempts stays in the block");
      assert.doesNotMatch(b, new RegExp(`worker ${other}|verifier ${other} `), `block ${w} holds only its own text`);
    });
    // Each resume token is new: a token in an earlier block's text could not be the one that closes a later block.
    const toks = r.stderr.split('\n').filter((l) => l.startsWith('::stop-commands::'));
    assert.equal(new Set(toks).size, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('workflow: under the runner\'s bash -e, a worker whose CLI exits nonzero or prints no JSON still gets its second attempt and its tail (RS-G-errexit)', (t) => {
  if (spawnSync('bash', ['-c', 'true'], { timeout: 20000 }).status !== 0) return t.skip('bash is needed');
  const wf = wfText();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-errexit-'));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, 'bin'));
    // Like jq, it exits nonzero with a parse error when the CLI's output is not JSON.
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), 'const t = require("fs").readFileSync(process.argv[2], "utf8"); let o = {}; try { if (t.trim()) o = JSON.parse(t); } catch { console.error("jq: parse error (stand-in)"); process.exit(2); } console.log(o.result ?? "");\n');
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$3"\n', { mode: 0o755 });
    // The stand-in CLI. STUB_MODE exit1: the first call prints no JSON and exits 1; badjson: it
    // prints no JSON and exits 0, so jq fails; always: every call prints no JSON and exits 1.
    const stub = path.join(tmp, 'stub.sh');
    fs.writeFileSync(stub, [
      '#!/bin/bash',
      'n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STUB_COUNT"',
      'if [ "$n" = 1 ] || [ "$STUB_MODE" = always ]; then echo "cli output that is not JSON"; echo "boom $n" >&2; [ "$STUB_MODE" = badjson ] && exit 0; exit 1; fi',
      'case "$2" in *verifier*) echo \'{"result":"{\\"votes\\":[{\\"id\\":\\"regression-1\\",\\"verdict\\":\\"confirmed\\"},{\\"id\\":\\"security-1\\",\\"verdict\\":\\"rejected\\"}]}"}\' ;; *) echo \'{"result":"{\\"findings\\":[]}"}\' ;; esac',
      '',
    ].join('\n'), { mode: 0o755 });
    // Runs one worker as its step does (in the background, then wait and tails), as a file
    // under `bash -e`, which is how the runner starts every `run:` step ("shell: /usr/bin/bash -e {0}").
    const go = (worker, mode) => {
      const [header, call, step, out, check] = worker === 'vote'
        ? ['vote() { # verifier', 'vote 1 &', 'vote', 'vote-1.json', ['vote-ok', '.review/vote-1.json', '.review/candidates.json']]
        : ['run() { # lens model', 'run regression m &', 'lens', 'find-regression.json', ['lens-ok', '.review/find-regression.json']];
      const d = path.join(tmp, `${worker}-${mode}`);
      fs.mkdirSync(path.join(d, '.review'), { recursive: true });
      fs.mkdirSync(path.join(d, 'dev'));
      fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(d, 'dev', 'review-gate.js'));
      fs.writeFileSync(path.join(d, '.review', 'candidates.json'), JSON.stringify(VCANDS));
      fs.writeFileSync(path.join(d, 'step.sh'), ['set -uo pipefail', wfFn(wf, header).text, tailsText(wf), call, 'wait', `tails ${step}`, 'echo "step end"', ''].join('\n'));
      const count = path.join(d, 'count');
      const r = spawnSync('bash', ['-e', 'step.sh'], { cwd: d, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH,
        PR: '7', TOOLS: 'a', READ_TOOLS: 'b', DENY_TOOLS: 'c', MODEL_VERIFY: 'm', CLAUDE_BIN: sh(stub), STUB_COUNT: sh(count), STUB_MODE: mode } });
      const ok = spawnSync(process.execPath, [path.join(d, 'dev', 'review-gate.js'), ...check], { cwd: d, encoding: 'utf8', timeout: 20000 });
      return { r, ok, calls: fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0, out };
    };
    for (const worker of ['run', 'vote']) {
      for (const mode of ['exit1', 'badjson']) {
        const x = go(worker, mode);
        assert.equal(x.calls, 2, `${worker}() ${mode}: the worker lives on to its second attempt`);
        assert.equal(x.ok.status, 0, `${worker}() ${mode}: the second answer is used (${x.ok.stderr})`);
        assert.match(x.r.stdout, /step end/);
        const blocks = stopBlocks(x.r.stderr);
        assert.equal(blocks.length, 1, `${worker}() ${mode}: one tail block`);
        assert.match(blocks[0], /gave no usable output \(attempt 1 of 2\)/);
        assert.match(blocks[0], /^boom 1$/m, "the CLI's stderr is kept");
      }
      // Failing every time: two calls, no more, both attempts in the tail, and the output stays unusable.
      const x = go(worker, 'always');
      assert.equal(x.calls, 2, `${worker}() always: two calls`);
      assert.notEqual(x.ok.status, 0, `${worker}() always: ${x.out} stays unusable`);
      assert.match(x.r.stdout, /step end/);
      const both = stopBlocks(x.r.stderr).join('\n');
      assert.match(both, /\(attempt 1 of 2\)[\s\S]*\(attempt 2 of 2\)/);
      assert.match(both, /^boom 2$/m);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('workflow tests: every CLI stand-in is written executable, since Linux runs it as "$CLAUDE_BIN" (RS-G-stubmode)', () => {
  // Git Bash runs a file with a #! line whatever its mode, so only this check catches a missing mode here.
  const src = fs.readFileSync(__filename, 'utf8');
  const starts = [...src.matchAll(/fs\.writeFileSync\(stub, \[/g)].map((m) => m.index);
  assert.ok(starts.length >= 4, `stand-ins found: ${starts.length}`);
  for (const at of starts) {
    const end = src.indexOf("].join('\\n')", at);
    assert.ok(end > at, 'the stand-in ends with a join');
    assert.ok(src.startsWith("].join('\\n'), { mode: 0o755 });", end), `the stand-in at offset ${at} is written with mode 0o755`);
  }
});
test('candidates: every lens the tier started must have left its file, or the round fails naming it (RS-G-lensmissing)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10000 });
  const tier = (lenses) => fs.writeFileSync(path.join(dir, 'tier.json'), JSON.stringify({ tier: 'medium', lenses }));
  try {
    fs.writeFileSync(path.join(dir, 'find-regression.json'), JSON.stringify({ findings: [{ severity: 'blocking', path: 'a.js', line: 1, title: 't' }] }));
    // The security lens was started and left no file: the round fails and names it.
    tier({ regression: true, security: true, docs: false });
    let r = cli('candidates', dir);
    assert.equal(r.status, 1, 'a started lens without its file fails the round');
    assert.match(r.stderr, /the security reviewer left no output \(find-security\.json is missing\)/);
    assert.equal(r.stdout, 'lenses started: regression,security; files: 1 of 2\n', 'one log line names the lenses and counts their files');
    assert.ok(!fs.existsSync(path.join(dir, 'candidates.json')), 'no candidates are written');
    // With its file there the round goes on; docs was not started, so it needs none,
    // and a stray file of it is not counted as a started lens's file.
    fs.writeFileSync(path.join(dir, 'find-security.json'), JSON.stringify({ findings: [] }));
    fs.writeFileSync(path.join(dir, 'find-docs.json'), JSON.stringify({ findings: [] }));
    r = cli('candidates', dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'lenses started: regression,security; files: 2 of 2\n');
    fs.rmSync(path.join(dir, 'find-docs.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8')).map((c) => c.id), ['regression-1']);
    // Two missing lenses are both named.
    fs.rmSync(path.join(dir, 'find-security.json'));
    fs.rmSync(path.join(dir, 'candidates.json'));
    tier({ regression: true, security: true, docs: true });
    r = cli('candidates', dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the security reviewer left no output[\s\S]*the docs reviewer left no output/);
    // No tier.json: nothing says which lenses ran, so the round fails.
    fs.rmSync(path.join(dir, 'tier.json'));
    r = cli('candidates', dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no lenses in tier\.json/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The rule itself, after the CLI checks so the parent fails on the missing lens first.
  assert.deepEqual(g.lensesStarted({ lenses: { regression: true, security: true, docs: false } }), ['regression', 'security']);
  // Only exactly true starts a lens.
  assert.deepEqual(g.lensesStarted({ lenses: { regression: true, security: 'false', docs: 1 } }), ['regression']);
  for (const bad of [null, {}, { lenses: null }, { lenses: 'regression' }, { lenses: [true] }, { lenses: 7 }, { lenses: { regression: false } }, { lenses: { regression: 'true' } }, { lenses: { 'Reg-1': true } }]) {
    assert.equal(g.lensesStarted(bad), null, JSON.stringify(bad));
  }
});
// One step's `run: |` text from the workflow, dedented, as the runner writes it to a file.
const stepRun = (wf, name) => {
  const start = wf.indexOf(`\n      - name: ${name}\n`);
  const body = wf.indexOf('\n        run: |\n', start);
  const next = wf.indexOf('\n      - name: ', start + 1);
  assert.ok(start > 0 && body > start && (next < 0 || body < next), `step "${name}" is in the workflow`);
  // The block ends at its first line indented less than its own ten spaces, as YAML
  // reads it, so the last step of a job does not take in the next job.
  const lines = wf.slice(body + '\n        run: |\n'.length).split('\n');
  const end = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('          '));
  return lines.slice(0, end < 0 ? lines.length : end).map((l) => l.slice(10)).join('\n') + '\n';
};
test('workflow: under bash -e, a lens whose worker dies before writing fails the lens step, and a normal round still passes (RS-G-lensmissing)', (t) => {
  if (spawnSync('bash', ['-c', 'true'], { timeout: 20000 }).status !== 0) return t.skip('bash is needed');
  const step = stepRun(wfText(), 'Find problems, one reviewer per lens, in parallel');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-lensgone-'));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, 'bin'));
    // A stand-in for the step's three jq calls: the CLI's `.result`, a lens switch from
    // tier.json, and the closing summary of candidates.json.
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), [
      'const [filter, file] = process.argv.slice(2);',
      'const t = require("fs").readFileSync(file, "utf8");',
      'let o = {}; try { if (t.trim()) o = JSON.parse(t); } catch { console.error("jq: parse error (stand-in)"); process.exit(2); }',
      'const m = /^\\.lenses\\.([a-z]+)$/.exec(filter);',
      'if (filter === \'.result // ""\') console.log(o.result ?? ""); else if (m) console.log(String((o.lenses || {})[m[1]] ?? null)); else console.log("{}");',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$2" "$3"\n', { mode: 0o755 });
    // The stand-in CLI: the lens named in STUB_KILL kills its own worker, as a crash of
    // that worker's shell would; every other lens answers with no findings.
    const stub = path.join(tmp, 'stub.sh');
    fs.writeFileSync(stub, [
      '#!/bin/bash',
      'case "$2" in *"the security reviewer"*) l=security ;; *"the docs reviewer"*) l=docs ;; *) l=regression ;; esac',
      'echo "$l" >> "$STUB_LOG"',
      'if [ "$l" = "$STUB_KILL" ]; then kill -9 $PPID; sleep 1; exit 1; fi',
      'echo \'{"result":"{\\"findings\\":[]}"}\'',
      '',
    ].join('\n'), { mode: 0o755 });
    const go = (kill) => {
      const d = path.join(tmp, kill || 'none');
      fs.mkdirSync(path.join(d, '.review'), { recursive: true });
      fs.mkdirSync(path.join(d, 'dev'));
      fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(d, 'dev', 'review-gate.js'));
      fs.writeFileSync(path.join(d, '.review', 'tier.json'), JSON.stringify({ tier: 'high', lenses: { regression: true, security: true, docs: true } }));
      fs.writeFileSync(path.join(d, 'step.sh'), step);
      const r = spawnSync('bash', ['-e', 'step.sh'], { cwd: d, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH,
        PR: '7', TOOLS: 'a', READ_TOOLS: 'b', DENY_TOOLS: 'c', MODEL_REGRESSION: 'm', MODEL_SECURITY: 'm', MODEL_DOCS: 'm',
        CLAUDE_BIN: sh(stub), STUB_KILL: kill, STUB_LOG: sh(path.join(d, 'calls.txt')) } });
      const finds = fs.readdirSync(path.join(d, '.review')).filter((n) => n.startsWith('find-')).sort();
      const calls = fs.existsSync(path.join(d, 'calls.txt')) ? fs.readFileSync(path.join(d, 'calls.txt'), 'utf8').trim().split('\n').sort() : [];
      return { r, finds, calls };
    };
    // A normal round: all three lenses answer, and the step passes.
    const none = go('');
    assert.deepEqual(none.calls, ['docs', 'regression', 'security'], 'the step started all three lenses');
    assert.equal(none.r.status, 0, none.r.stderr);
    assert.deepEqual(none.finds, ['find-docs.json', 'find-regression.json', 'find-security.json']);
    // The security worker dies before writing its file: the step fails and names it.
    const gone = go('security');
    assert.deepEqual(gone.calls, ['docs', 'regression', 'security']);
    assert.deepEqual(gone.finds, ['find-docs.json', 'find-regression.json'], 'the killed worker left no file');
    assert.notEqual(gone.r.status, 0, 'the lens step fails without the security lens');
    assert.match(gone.r.stderr, /the security reviewer left no output/);
    // The log line, after the fail-closed checks so the parent fails on the missing lens first.
    assert.match(none.r.stdout, /^lenses started: regression,security,docs; files: 3 of 3$/m, 'the log says which lenses ran');
    assert.match(gone.r.stdout, /^lenses started: regression,security,docs; files: 2 of 3$/m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('landed: only a bot entry made after the snapshot whose last line is the item\'s own marker counts (RS-G-postlanded)', () => {
  const BOT = 'github-actions[bot]';
  const mark = `<!-- auto-review finding=regression-1 sha=${H} -->`;
  const roundMark = `<!-- auto-review round=2 sha=${H} base=main blocking=1 -->`;
  const item = { body: `**t**\n\nx\n${mark}` };
  const e = (id, body, login = BOT) => ({ id, user: { login }, body });
  // The plain yes: a new bot comment ending in the marker, whatever its line ends.
  assert.equal(g.landed([], [e(1, `other\n${mark}`)], item), true);
  assert.equal(g.landed([], [e(1, `other\r\n${mark}  \n`)], item), true);
  assert.equal(g.landed([], [e(1, '')], { body: `r\n${roundMark}` }), false);
  assert.equal(g.landed([], [e(1, ''), e(2, `Round 2\n${roundMark}`)], { body: `r\n${roundMark}` }), true);
  // Made before the snapshot (a re-run's earlier post), by another login, or with the marker not last: no.
  assert.equal(g.landed([e(1, mark)], [e(1, mark)], item), false);
  for (const login of ['mallory', 'github-actions', 'Github-actions[bot]', 'github-actions[bot] ']) {
    assert.equal(g.landed([], [e(1, mark, login)], item), false, login);
  }
  assert.equal(g.landed([], [{ id: 1, body: mark }], item), false, 'no user');
  assert.equal(g.landed([], [e(1, `${mark}\nmore`)], item), false);
  assert.equal(g.landed([], [], item), false);
  // Every text one change away from the marker, at every place: a character left out,
  // one put in (x), one changed (its code with the low bit flipped), two neighbors
  // swapped, the whole in capitals; none counts.
  let tried = 0;
  for (let i = 0; i <= mark.length; i++) {
    const near = [mark.slice(0, i) + 'x' + mark.slice(i)];
    if (i < mark.length) {
      near.push(mark.slice(0, i) + mark.slice(i + 1));
      near.push(mark.slice(0, i) + String.fromCharCode(mark.charCodeAt(i) ^ 1) + mark.slice(i + 1));
      if (i + 1 < mark.length && mark[i] !== mark[i + 1]) near.push(mark.slice(0, i) + mark[i + 1] + mark[i] + mark.slice(i + 2));
    }
    for (const n of near) {
      if (n.trim() === mark) continue;
      tried++;
      assert.equal(g.landed([], [e(1, `x\n${n}`)], item), false, JSON.stringify(n));
    }
  }
  assert.equal(g.landed([], [e(1, `x\n${mark.toUpperCase()}`)], item), false);
  assert.ok(tried > 3 * mark.length, `near texts tried: ${tried}`);
  // An item with no marker can match nothing for sure (GitHub adds empty bot reviews), so it is refused.
  for (const body of ['', 'text', `${mark}\nmore`, undefined, `x\n${mark} x`]) {
    assert.throws(() => g.landed([], [e(1, body || '')], { body }), /no marker/, String(body));
  }
  // A listing entry without a numeric id can't be told apart, so it is refused too.
  for (const bad of [null, 5, {}, { id: '1' }, { id: 1.5 }]) {
    assert.throws(() => g.landed([], [bad], item), /without an id/, JSON.stringify(bad));
    assert.throws(() => g.landed([bad], [], item), /without an id/, JSON.stringify(bad));
  }
  // The CLI: 0 landed, 1 not, 2 when it can't tell.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-landed-'));
  try {
    const w = (n, t) => fs.writeFileSync(path.join(dir, n), t);
    const cli = () => spawnSync(process.execPath, [CLI, 'landed', path.join(dir, 'b.jsonl'), path.join(dir, 'a.jsonl'), path.join(dir, 'item.json')], { encoding: 'utf8', timeout: 10000 });
    w('item.json', JSON.stringify(item));
    w('b.jsonl', '');
    w('a.jsonl', JSON.stringify(e(3, mark)) + '\n');
    assert.equal(cli().status, 0);
    w('b.jsonl', JSON.stringify(e(3, mark)) + '\n');
    assert.equal(cli().status, 1);
    w('a.jsonl', 'not json\n');
    let r = cli();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^landed: /);
    w('a.jsonl', '');
    w('item.json', JSON.stringify({ body: '' }));
    r = cli();
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no marker/);
    fs.rmSync(path.join(dir, 'item.json'));
    assert.equal(cli().status, 2, 'a missing item file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
// Stand-ins for the post step, written to files with Function.prototype.toString so
// their source needs no escaping. gh answers the four calls the step makes, checks
// every argument and each request's keys, keeps the PR's comments and reviews in
// GH_STATE, and refuses any other call (exit 99) or a request of another shape (exit 98).
// As GitHub does, each review comment it takes also adds a review of the bot's with an
// empty body (seen on PR 153: comment 4697368757 sits under review 6060758482, whose
// body is empty).
function ghStandIn() {
  const fs = require('fs');
  const file = process.env.GH_STATE;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = process.argv.slice(2);
  const save = () => fs.writeFileSync(file, JSON.stringify(s, null, 1));
  const base = 'repos/' + process.env.REPO + '/pulls/' + process.env.PR + '/';
  const kindOf = (p) => (p === base + 'comments' ? 'comments' : p === base + 'reviews' ? 'reviews' : null);
  const add = (kind, req, login) => {
    s[kind].push({ id: s.nextId++, user: { login }, ...req });
    if (kind === 'comments') s.reviews.push({ id: s.nextId++, user: { login }, body: '' });
  };
  const page = '?per_page=100';
  if (a.length === 5 && a[0] === 'api' && a[1] === '--paginate' && a[2].endsWith(page) && kindOf(a[2].slice(0, -page.length)) && a[3] === '--jq' && a[4] === '.[]') {
    const kind = kindOf(a[2].slice(0, -page.length));
    s.log.push('get ' + kind);
    const n = s.log.filter((l) => l.startsWith('get ')).length;
    save();
    if (s.getFail.includes(n)) { console.error('HTTP 502 (stand-in)'); process.exit(1); }
    for (const x of s[kind]) console.log(JSON.stringify(x));
    return;
  }
  if (a.length === 4 && a[0] === 'api' && kindOf(a[1]) && a[2] === '--input') {
    const kind = kindOf(a[1]);
    const req = JSON.parse(fs.readFileSync(a[3] === '-' ? 0 : a[3], 'utf8'));
    const keys = Object.keys(req).sort().join(',');
    const shape = kind === 'reviews' ? (keys === 'body,commit_id,event' && req.event === 'COMMENT' ? 'review' : null)
      : keys === 'body,commit_id,line,path,side' && req.side === 'RIGHT' && Number.isInteger(req.line) ? 'inline'
      : keys === 'body,commit_id,path,subject_type' && req.subject_type === 'file' ? 'file' : null;
    const last = String(req.body).split('\n').pop();
    const m = /finding=([a-z]+-[0-9]+) /.exec(last);
    if (!shape || req.commit_id !== s.head || typeof req.body !== 'string') {
      s.log.push('bad ' + kind + ' ' + keys); save(); console.error('stand-in: bad request ' + keys); process.exit(98);
    }
    const plan = kind === 'comments' ? s.commentPosts : s.reviewPosts;
    const how = plan.length ? plan.shift() : 'ok';
    s.log.push(['post', kind, m ? m[1] : 'round', shape, how].join(' '));
    if (how === 'ok' || how === 'landed') add(kind, req, 'github-actions[bot]');
    if (how === 'other') add(kind, req, 'mallory');
    save();
    if (how === 'ok') { console.log(JSON.stringify({ id: s.nextId - 1 })); return; }
    console.error(how === 'landed' ? 'unexpected end of JSON input' : 'HTTP 422 (stand-in)');
    process.exit(1);
  }
  s.log.push('unexpected ' + JSON.stringify(a)); save();
  console.error('stand-in: unexpected call ' + JSON.stringify(a));
  process.exit(99);
}
// The step's one jq call: del(.line, .side) + {subject_type: "file"} on a file (or on
// stdin, as the step before RS-G-postlanded gave it), printed compact.
function jqStandIn() {
  const fs = require('fs');
  const a = process.argv.slice(2);
  if (a.length < 2 || a.length > 3 || a[0] !== '-c' || a[1] !== 'del(.line, .side) + {subject_type: "file"}') {
    console.error('jq stand-in: unexpected call ' + JSON.stringify(a));
    process.exit(99);
  }
  const o = JSON.parse(fs.readFileSync(a.length === 3 ? a[2] : 0, 'utf8'));
  delete o.line;
  delete o.side;
  o.subject_type = 'file';
  console.log(JSON.stringify(o));
}
// The post step's text, in one place, so the parent-commit probe of RS-G-postlanded can
// swap in the old step's posting lines here.
const postStep = (wf) => stepRun(wf, 'Post each finding, then the round');
const POST_BOT = 'github-actions[bot]';
// Two findings, as payload writes them: regression-1 inline on a.js, security-1 file-level on b.js.
const POST_INPUT = { head: H, base: 'main', round: 2, tier: { tier: 'high' }, changed: ['a.js', 'b.js'],
  findings: { blocking: [{ id: 'regression-1', path: 'a.js', line: 3, title: 't1', evidence: 'e1', repro: 'r1' },
    { id: 'security-1', path: 'b.js', title: 't2', evidence: 'e2', repro: 'r2' }], notes: [] } };
const POST_ROUND = g.payload(POST_INPUT).review.body.split('\n').pop();
const hasBash = () => spawnSync('bash', ['-c', 'true'], { timeout: 20000 }).status === 0;
// Runs the post step once, as a file under `bash -e` like the runner, in a temp folder of
// its own that it removes. o: comments and reviews already on the PR; commentPosts and
// reviewPosts, how each POST in turn goes (ok; landed: kept, then an error; fail: an error;
// other: kept under another login, then an error); getFail, which GETs fail (1-based).
function runPost(name, o = {}) {
  const step = postStep(wfText());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jbmem-postlanded-${name}-`));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.writeFileSync(path.join(tmp, 'bin', 'gh.js'), `(${ghStandIn})();\n`);
    fs.writeFileSync(path.join(tmp, 'bin', 'gh'), '#!/bin/bash\nexec node "$(dirname "$0")/gh.js" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), `(${jqStandIn})();\n`);
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$@"\n', { mode: 0o755 });
    const d = path.join(tmp, 'w');
    fs.mkdirSync(path.join(d, '.review'), { recursive: true });
    fs.mkdirSync(path.join(d, 'dev'));
    fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(d, 'dev', 'review-gate.js'));
    fs.writeFileSync(path.join(d, '.review', 'payload-input.json'), JSON.stringify(POST_INPUT));
    const p = spawnSync(process.execPath, [path.join(d, 'dev', 'review-gate.js'), 'payload', path.join(d, '.review')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(p.status, 0, p.stderr);
    const state = path.join(tmp, 'gh-state.json');
    fs.writeFileSync(state, JSON.stringify({ head: H, nextId: 100, comments: o.comments || [], reviews: o.reviews || [],
      commentPosts: o.commentPosts || [], reviewPosts: o.reviewPosts || [], getFail: o.getFail || [], log: [] }));
    fs.writeFileSync(path.join(d, 'step.sh'), step);
    const r = spawnSync('bash', ['-e', 'step.sh'], { cwd: d, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH,
      REPO: 'o/r', PR: '7', GH_TOKEN: 'x', GH_STATE: sh(state) } });
    const s = JSON.parse(fs.readFileSync(state, 'utf8'));
    assert.ok(!s.log.some((l) => /^(unexpected|bad) /.test(l)), `${name}: the step made only the calls the stand-in knows (${s.log.join('; ')})`);
    return {
      r, s,
      // How many entries the bot made in the step end in a finding's marker, or in the round's.
      on: (kind, id) => s[kind].filter((x) => x.user.login === POST_BOT && x.id >= 100
        && String(x.body).split('\n').pop() === (id ? `<!-- auto-review finding=${id} sha=${H} -->` : POST_ROUND)).length,
      posts: (id) => s.log.filter((l) => l.startsWith(`post comments ${id} `)),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
test('workflow post step: every POST answers, so each comment and the round go once (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('ok');
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.deepEqual(x.s.log.filter((l) => l.startsWith('post ')), ['post comments regression-1 inline ok', 'post comments security-1 file ok', 'post reviews round review ok']);
  assert.deepEqual([x.on('comments', 'regression-1'), x.on('comments', 'security-1'), x.on('reviews')], [1, 1, 1]);
});
test('workflow post step: an inline POST that errors after the comment landed counts, with no second POST (RS-G-postlanded, the PR 153 case)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('landed', { commentPosts: ['landed'] });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.deepEqual(x.posts('regression-1'), ['post comments regression-1 inline landed']);
  assert.equal(x.on('comments', 'regression-1'), 1, 'no duplicate');
  assert.equal(x.on('comments', 'security-1'), 1, 'the next finding still goes');
  assert.equal(x.on('reviews'), 1, 'the round is posted');
  // One snapshot of each list before the first POST, and one read back after the error.
  assert.deepEqual(x.s.log.slice(0, 4), ['get comments', 'get reviews', 'post comments regression-1 inline landed', 'get comments']);
  assert.match(x.r.stdout, /^::warning::finding 1: the POST failed, and the comment is on the PR$/m);
});
test('workflow post step: an inline POST that fails and did not land is sent again file-level (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('fallback', { commentPosts: ['fail'] });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.deepEqual(x.posts('regression-1'), ['post comments regression-1 inline fail', 'post comments regression-1 file ok']);
  assert.deepEqual([x.on('comments', 'regression-1'), x.on('comments', 'security-1'), x.on('reviews')], [1, 1, 1]);
});
test('workflow post step: a file-level POST that errors after the comment landed counts (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('fallback-landed', { commentPosts: ['fail', 'landed'] });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.deepEqual(x.posts('regression-1'), ['post comments regression-1 inline fail', 'post comments regression-1 file landed']);
  assert.deepEqual([x.on('comments', 'regression-1'), x.on('comments', 'security-1'), x.on('reviews')], [1, 1, 1]);
  assert.match(x.r.stdout, /^::warning::finding 1: the file-level POST failed, and the comment is on the PR$/m);
});
test('workflow post step: when both POSTs fail and neither landed, the step fails and nothing after it goes (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('neither', { commentPosts: ['fail', 'fail'] });
  assert.notEqual(x.r.status, 0);
  assert.deepEqual([x.posts('security-1').length, x.on('reviews')], [0, 0]);
  assert.match(x.r.stdout, /finding 1 was not posted/);
});
test('workflow post step: a round POST that errors after the review landed counts (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('review-landed', { reviewPosts: ['landed'] });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.on('reviews'), 1);
  assert.match(x.r.stdout, /^::warning::the round's POST failed, and the review is on the PR$/m);
});
test('workflow post step: the empty reviews GitHub adds for each comment are not the round (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('review-empty', { reviewPosts: ['fail'] });
  assert.equal(x.s.reviews.filter((v) => v.user.login === POST_BOT && v.body === '').length, 2, 'premise: two empty bot reviews are new');
  assert.notEqual(x.r.status, 0);
  assert.match(x.r.stdout, /the round was not posted/);
});
test('workflow post step: on a re-run, a comment or round with the same marker from before the step is not this step\'s post (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const old = [{ id: 1, user: { login: POST_BOT }, body: `old\n<!-- auto-review finding=regression-1 sha=${H} -->` }];
  let x = runPost('rerun-comment', { comments: old, commentPosts: ['fail', 'fail'] });
  assert.notEqual(x.r.status, 0);
  assert.match(x.r.stdout, /finding 1 was not posted/);
  x = runPost('rerun-review', { reviews: [{ id: 2, user: { login: POST_BOT }, body: `old\n${POST_ROUND}` }], reviewPosts: ['fail'] });
  assert.notEqual(x.r.status, 0);
  assert.match(x.r.stdout, /the round was not posted/);
});
test('workflow post step: another login\'s comment with the marker, made during the step, is not the bot\'s post (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('other-user', { commentPosts: ['other', 'other'] });
  assert.equal(x.s.comments.filter((c) => c.user.login === 'mallory').length, 2, 'premise: the other login posted the marker twice');
  assert.notEqual(x.r.status, 0);
  assert.match(x.r.stdout, /finding 1 was not posted/);
});
test('workflow post step: when the read back fails, the step stops without a second POST (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runPost('reread-fails', { commentPosts: ['fail'], getFail: [3] });
  assert.notEqual(x.r.status, 0);
  assert.deepEqual(x.posts('regression-1'), ['post comments regression-1 inline fail']);
  assert.match(x.r.stdout, /finding 1: could not read the PR's comments back/);
});
test('workflow post step: a read back that fails after the file-level POST or the round POST is told apart from "not posted" (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  // GETs: 1 and 2 are the first lists, 3 the read back after the inline POST, 4 after the file-level one.
  let x = runPost('reread-fails-file', { commentPosts: ['fail', 'fail'], getFail: [4] });
  assert.notEqual(x.r.status, 0);
  assert.deepEqual(x.posts('regression-1'), ['post comments regression-1 inline fail', 'post comments regression-1 file fail']);
  assert.match(x.r.stdout, /^finding 1: could not read the PR's comments back$/m);
  assert.doesNotMatch(x.r.stdout, /was not posted/);
  // Both comments go; GET 3 is the read back after the round POST.
  x = runPost('reread-fails-round', { reviewPosts: ['landed'], getFail: [3] });
  assert.notEqual(x.r.status, 0);
  assert.equal(x.on('reviews'), 1, 'premise: the round landed');
  assert.match(x.r.stdout, /^the round: could not read the PR's reviews back$/m);
  assert.doesNotMatch(x.r.stdout, /was not posted/);
});
test('workflow post step: when a first list fails, the step stops before any POST and says which (RS-G-postlanded)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  for (const [n, kind] of [[1, 'comments'], [2, 'reviews']]) {
    const x = runPost(`first-list-${kind}`, { getFail: [n] });
    assert.notEqual(x.r.status, 0);
    assert.deepEqual(x.s.log.filter((l) => l.startsWith('post ')), [], `${kind}: nothing is posted`);
    assert.match(x.r.stdout, new RegExp(`^could not list the PR's ${kind} before posting$`, 'm'));
  }
});
test('breaker: a number followed by a word is prose, not a PR (RS-G-commaprose)', () => {
  const auto = (n) => ({ number: n, body: '', labels: ['tier:low'] });
  const by = (b) => g.breaker([auto(2), auto(10), auto(11), auto(12), { number: 20, body: b, labels: [] }], rules).hits.sort((x, y) => x - y);
  assert.deepEqual(by('Regression-of: #10, 2 tests failed'), [10]);
  assert.deepEqual(by('Regression-of: 12 in the parser'), [12]);
  assert.deepEqual(by('Regression-of: #10, 11 and #12'), [10, 11, 12]);
  assert.deepEqual(by('Regression-of: 10, 11'), [10, 11]);
  assert.deepEqual(by('Regression-of: #10, 2'), [2, 10]);
  assert.deepEqual(by('Regression-of: 12'), [12]);
  // Still linear on a long run of numbers and words.
  const t0 = Date.now();
  by('Regression-of: ' + '1, '.repeat(30000) + 'x');
  assert.ok(Date.now() - t0 < 2000);
});

// Q89: a gate job whose own run reviewed nothing (a bot's edit of the PR's body)
// replaced the pending status of a review still running on the same head. PR 153
// at d3fdbb3: pending "review running" at 19:19:58Z, then "no finished review"
// at 19:20:19Z and 19:20:33Z from two edits by cursor[bot], then the round's own
// verdict at 19:28:54Z.
const pendingAt = (created_at, o = {}) => ({ id: 1, context: 'auto-review/gate', state: 'pending', description: 'review running', created_at, ...o });
const PR153 = (o = {}) => base({ tier: { tier: 'medium' }, botComments: [round(H2)], reviewResult: 'skipped',
  statuses: [pendingAt('2026-11-25T19:19:58Z')], now: '2026-11-25T19:20:19Z', ...o });
const minutesAfter = (iso, m) => new Date(Date.parse(iso) + m * 60000).toISOString();
test('gate: a run with no review of its own holds the pending status of a review still running on the head (Q89, the PR 153 sequence)', () => {
  const enforce = { ...rules, mode: 'enforce' };
  const hold = (o, r = enforce) => g.decide(PR153(o), r).hold;
  assert.equal(hold({}), true, 'the PR 153 sequence holds');
  // The decision itself is unchanged; only the write is held.
  assert.match(g.decide(PR153(), enforce).reasons[0], /no finished review/);
  // The review run's own gate job writes, whatever its review's result.
  for (const reviewResult of ['success', 'failure', 'cancelled', undefined]) assert.equal(hold({ reviewResult }), false, String(reviewResult));
  // A round of this head is posted: the decision rests on it.
  assert.equal(hold({ botComments: [round(H2), round(H)] }), false, 'a finished review of the head');
  // A round of the head on another base does not count as finished here.
  assert.equal(hold({ botComments: [round(H, 0, 'dev')] }), true, 'a round on another base');
  // The review job is stopped at REVIEW_MINUTES, so an older pending is not kept.
  assert.equal(hold({ now: minutesAfter('2026-11-25T19:19:58Z', g.REVIEW_MINUTES - 1) }), true, 'one minute inside the limit');
  assert.equal(hold({ now: minutesAfter('2026-11-25T19:19:58Z', g.REVIEW_MINUTES) }), false, 'at the limit');
  // A runner clock a little behind GitHub's still holds.
  assert.equal(hold({ now: '2026-11-25T19:19:50Z' }), true, 'clock behind');
  // Only the newest status of the gate's context counts, by time and then id, in any order.
  const failed = { id: 2, context: 'auto-review/gate', state: 'failure', description: 'medium, round 2: x', created_at: '2026-11-25T19:20:05Z' };
  assert.equal(hold({ statuses: [pendingAt('2026-11-25T19:19:58Z'), failed] }), false, 'a newer failure');
  assert.equal(hold({ statuses: [failed, pendingAt('2026-11-25T19:20:10Z', { id: 3 })] }), true, 'a newer pending listed last');
  assert.equal(hold({ statuses: [{ ...failed, created_at: '2026-11-25T19:19:58Z' }, pendingAt('2026-11-25T19:19:58Z', { id: 3 })] }), true, 'same second, higher id');
  assert.equal(hold({ statuses: [{ ...failed, id: 3, created_at: '2026-11-25T19:19:58Z' }, pendingAt('2026-11-25T19:19:58Z')] }), false, 'same second, lower id');
  // Another context, another description, or a pending with no review.
  assert.equal(hold({ statuses: [pendingAt('2026-11-25T19:19:58Z', { context: 'auto-review/observe' })] }), false, 'the observe context in enforce mode');
  assert.equal(hold({ statuses: [pendingAt('2026-11-25T19:19:58Z', { context: 'auto-review/observe' })] }, { ...rules, mode: 'observe' }), true, 'the observe context in observe mode');
  assert.equal(hold({ statuses: [pendingAt('2026-11-25T19:19:58Z', { description: 'queued' })] }), false, 'another description');
  assert.equal(hold({ statuses: [pendingAt('2026-11-25T19:19:58Z', { context: 'ci/other' })] }), false, 'another context only');
  // A read that failed or gave something else holds nothing.
  for (const statuses of [undefined, null, {}, 'x', []]) assert.equal(hold({ statuses }), false, JSON.stringify(statuses));
  assert.equal(hold({ statuses: [pendingAt('not a time')] }), false, 'a status time that does not parse');
  assert.equal(hold({ now: undefined }), false, 'no clock');
});
test('gate: the hold reads the same limit, description and inputs as the workflow (Q89)', () => {
  const wf = wfText();
  const review = wf.slice(wf.indexOf('\n  review:\n'), wf.indexOf('\n  gate:\n'));
  assert.ok(review.includes(`\n    timeout-minutes: ${g.REVIEW_MINUTES}\n`), 'REVIEW_MINUTES is the review job\'s limit');
  assert.ok(review.includes(`-f description="${g.RUNNING}"`), 'RUNNING is the pending status the review job writes');
  assert.match(stepRun(wf, 'Gather what the gate reads'), /\n *gh api "repos\/\$REPO\/commits\/\$head\/statuses\?per_page=100" > \.review\/statuses\.json \\\n *\|\| \{ echo "::warning::[^\n]*"; rm -f \.review\/statuses\.json; \}\n/);
  const decideStep = stepRun(wf, 'Decide and set the status');
  assert.ok(decideStep.startsWith('set -euo pipefail\nnode dev/review-gate.js decide dev/risk-tiers.json .review "$REVIEW_RESULT"\n'), 'decide gets the review job\'s result');
});
// Runs the decide step once, as a file under `bash -e` like the runner, with stand-ins
// for gh (it logs each call) and jq (the step's own filters), in a temp folder of its
// own that it removes. o: the review job's result, the statuses file's text (none if
// absent) and the gate input.
function runDecide(name, o) {
  const step = stepRun(wfText(), 'Decide and set the status');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jbmem-q89-${name}-`));
  const sh = (p) => p.replace(/\\/g, '/');
  try {
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.writeFileSync(path.join(tmp, 'bin', 'gh.js'), [
      "const fs = require('fs'); const a = process.argv.slice(2);",
      "const known = (a[0] === 'api' && a[1] === 'repos/o/r/statuses/' + process.env.HEAD) || (a[0] === 'pr' && a[1] === 'edit');",
      "fs.appendFileSync(process.env.GH_LOG, (known ? '' : 'unexpected ') + a.join(' ') + '\\n');",
      'process.exit(known ? 0 : 99);', ''].join('\n'));
    fs.writeFileSync(path.join(tmp, 'bin', 'gh'), '#!/bin/bash\nexec node "$(dirname "$0")/gh.js" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'bin', 'jq.js'), [
      "const fs = require('fs'); const [r, f, file] = process.argv.slice(2);",
      "const o = JSON.parse(fs.readFileSync(file, 'utf8'));",
      "const out = r !== '-r' ? undefined : /^\\.[a-z]+$/i.test(f) ? String(o[f.slice(1)] ?? null)",
      "  : f.startsWith('\"would pass: ') ? `would pass: ${o.wouldPass}\\n` + o.reasons.map((x) => '- ' + x).join('\\n')",
      "  : f === '.needsOwner and (.wouldPass | not)' ? String(Boolean(o.needsOwner && !o.wouldPass)) : undefined;",
      "if (out === undefined) { console.error('jq stand-in: unexpected call ' + JSON.stringify(process.argv.slice(2))); process.exit(99); }",
      'console.log(out);', ''].join('\n'));
    fs.writeFileSync(path.join(tmp, 'bin', 'jq'), '#!/bin/bash\nexec node "$(dirname "$0")/jq.js" "$@"\n', { mode: 0o755 });
    const d = path.join(tmp, 'w');
    fs.mkdirSync(path.join(d, '.review'), { recursive: true });
    fs.mkdirSync(path.join(d, 'dev'));
    fs.copyFileSync(path.join(__dirname, 'review-gate.js'), path.join(d, 'dev', 'review-gate.js'));
    fs.writeFileSync(path.join(d, 'dev', 'risk-tiers.json'), JSON.stringify({ ...rules, mode: 'enforce' }));
    fs.writeFileSync(path.join(d, '.review', 'gate-input.json'), JSON.stringify({ signersValid: true, shipVerified: [], ...o.input }));
    if (o.statuses !== undefined) fs.writeFileSync(path.join(d, '.review', 'statuses.json'), o.statuses);
    fs.writeFileSync(path.join(d, 'step.sh'), step);
    const log = path.join(tmp, 'gh.log');
    const summary = path.join(tmp, 'summary.md');
    fs.writeFileSync(log, '');
    fs.writeFileSync(summary, '');
    const r = spawnSync('bash', ['-e', 'step.sh'], { cwd: d, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: sh(path.join(tmp, 'bin')) + path.delimiter + process.env.PATH,
      REPO: 'o/r', PR: '7', HEAD: H, REVIEW_RESULT: o.result, GH_TOKEN: 'x', GH_LOG: sh(log), GITHUB_STEP_SUMMARY: sh(summary) } });
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.ok(!calls.some((l) => l.startsWith('unexpected ')), `${name}: the step made only the calls the stand-in knows (${calls.join('; ')})`);
    return { r, calls, statusPosts: calls.filter((l) => l.startsWith('api repos/o/r/statuses/')), summary: fs.readFileSync(summary, 'utf8') };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const NO_ROUND = base({ tier: { tier: 'medium' }, botComments: [round(H2)] });
test('workflow decide step: a body edit while the review of the head runs leaves its pending status (Q89, the PR 153 sequence)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const x = runDecide('held', { result: 'skipped', statuses: JSON.stringify([pendingAt(agoIso(21000))]), input: NO_ROUND });
  assert.equal(x.r.status, 0, x.r.stderr);
  assert.deepEqual(x.statusPosts, [], 'no status written over the pending one');
  assert.deepEqual(x.calls, [], 'no label changed either');
  assert.match(x.r.stdout, /a review of this head is still running; its own gate job sets the status/);
  assert.match(x.summary, /still running/);
});
test('workflow decide step: with no running review to wait for, the gate still writes its decision (Q89 controls)', (t) => {
  if (!hasBash()) return t.skip('bash is needed');
  const posts = (o) => { const x = runDecide(o.name, o); assert.equal(x.r.status, 0, x.r.stderr); return x; };
  // The review run's own gate job, after its review.
  const own = posts({ name: 'own', result: 'success', statuses: JSON.stringify([pendingAt(agoIso(21000))]), input: base({ tier: { tier: 'medium' } }) });
  assert.equal(own.statusPosts.length, 1);
  assert.match(own.statusPosts[0], /-f state=success -f context=auto-review\/gate -f description=medium, round 1: ok to merge$/);
  // A pending older than the review job's limit: that review is over.
  const stale = posts({ name: 'stale', result: 'skipped', statuses: JSON.stringify([pendingAt(agoIso((g.REVIEW_MINUTES + 1) * 60000))]), input: NO_ROUND });
  assert.equal(stale.statusPosts.length, 1);
  assert.match(stale.statusPosts[0], /-f state=failure -f context=auto-review\/gate -f description=medium, round 1: no finished review/);
  // The statuses read failed (no file): written as before.
  const gone = posts({ name: 'gone', result: 'skipped', input: NO_ROUND });
  assert.equal(gone.statusPosts.length, 1);
  // A file that does not hold a list: written as before, and the log says why.
  const bad = posts({ name: 'bad', result: 'skipped', statuses: '{"message":"Not Found"}', input: NO_ROUND });
  assert.equal(bad.statusPosts.length, 1);
  assert.match(bad.r.stdout, /^::warning::statuses\.json holds no list of statuses/m);
  const broken = posts({ name: 'broken', result: 'skipped', statuses: '[{"id":', input: NO_ROUND });
  assert.equal(broken.statusPosts.length, 1);
  assert.match(broken.r.stdout, /^::warning::statuses\.json holds no list of statuses/m);
});

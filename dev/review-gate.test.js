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
    '.agents/plugins/marketplace.json', 'plugins/x/scripts/.gitattributes', 'REVIEW.md', 'dev/review-gate.test.js', 'dev/tier.js']) {
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
    spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', ws], { timeout: 60000 });
    spawnSync('git', ['-C', root, 'worktree', 'prune'], { timeout: 60000 });
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

// Checks that the test steps' limits end each kind of hang they are for, on
// the Node version and system it runs on (RS-T-hang75, dev/release-state.md).
// For each case it runs .github/run-tests.sh, the command the test steps run,
// in its enforce mode, on .github/test-limits-fixture.js with a limit of 3 s,
// and reads the TAP output and the annotations: a hung case must end, fail
// and name the case. Each run has a guard of 25 s, and the whole check a
// budget of 160 s (no case starts after 135 s), so that a limit that can't
// fire fails the check, and the
// check still prints its result and stops what the cases left within its
// step's limit of 3 min. On Node 22 run-tests.sh leaves --test-timeout out
// and the preload gives each test() call the limit (see there): the async
// case checks that, with the TAP's location line of its first test (run from a
// folder whose name holds parentheses), and the
// longfile case checks that a file whose tests together run past the limit
// still passes, which --test-timeout on Node 22 would fail. Its step fails
// the job when a case does not give what it must (RS-T-hang75-enforce). It
// runs from the repository's root, needs bash on PATH, and stops the
// processes the cases leave.
// Usage: node .github/test-limits-check.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIMIT_MS = 3000;
const GUARD_MS = 25000;
const BUDGET_MS = 160000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmark-limits-'));
const stopLine = /^::error title=calls stopped by the per-test limit \(1\)::/m;
// The fixture's line and column of the async case's first test() call, which
// its TAP location line must name (line 0 when the call is not found, which
// no location matches). The async case runs a copy of the fixture from a
// folder whose name holds parentheses, and the location must keep that
// folder's name.
const FIXTURE = '.github/test-limits-fixture.js';
const fixture = fs.readFileSync(FIXTURE, 'utf8').split('\n');
const asyncLine = fixture.findIndex(l => l.includes("test('case async', hang)")) + 1;
const asyncCol = asyncLine ? fixture[asyncLine - 1].indexOf('test(') + 1 : 0;
const asyncAt = new RegExp(`^not ok \\d+ - case async\\n(?:  .*\\n)*?  location: '[^']*limits \\(x\\)[\\\\/]+test-limits-fixture\\.js:${asyncLine}:${asyncCol}'$`, 'm');
const parenCopy = path.join(dir, 'limits (x)', 'test-limits-fixture.js');

// What each case must give: the run's exit status, patterns the TAP output
// must match (holds) and patterns the annotations must match (says).
const cases = [
  { name: 'pass', status: 0, holds: [/^ok \d+ - case pass$/m, /^# fail 0$/m], says: [] },
  { name: 'own', status: 0, holds: [/^ok \d+ - case own$/m, /^# fail 0$/m], says: [] },
  { name: 'async', file: parenCopy, status: 1, holds: [/^not ok \d+ - case async$/m, /^not ok \d+ - case async with options$/m, /^not ok \d+ - case async with timeout Infinity$/m, /test timed out after 3000ms/, asyncAt], says: [] },
  { name: 'longfile', status: 0, holds: [/^ok \d+ - case longfile 3$/m, /^# fail 0$/m, /^# cancelled 0$/m], says: [] },
  { name: 'spawnsync', status: 1, holds: [/^not ok \d+ - case spawnsync$/m, /spawnSync .*test-limits-fixture\.js stubborn was stopped by the test limit of 3000 ms .* at [^']*test-limits-fixture\.js:\d+/], says: [stopLine] },
  { name: 'orphan', status: 1, holds: [/^not ok \d+ - case orphan$/m, /execFileSync .*test-limits-fixture\.js orphan was stopped by the test limit of 3000 ms .* at [^']*test-limits-fixture\.js:\d+/], says: [stopLine] },
  { name: 'swallowed', status: 1, holds: [/^ok \d+ - case swallowed$/m, /2 call\(s\) stopped by the test limit; this file fails/], says: [/^::error title=calls stopped by the per-test limit \(2\)::execFileSync .*orphan a.nb.rc.u2028d.u2029e was stopped/m] },
];

const start = Date.now();
let bad = 0;
let ran = 0;
const left = [];
try {
  const v = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  console.log(`node ${process.version}, ${(v.stdout || String(v.error)).split('\n')[0]}`);
  fs.mkdirSync(path.dirname(parenCopy));
  fs.copyFileSync(FIXTURE, parenCopy);
  for (const c of cases) {
    ran++;
    if (Date.now() - start > BUDGET_MS - GUARD_MS) { bad++; console.log(`FAIL ${c.name}: not run, the check's ${BUDGET_MS / 1000} s budget is spent`); continue; }
    const pids = path.join(dir, `${c.name}.pids`);
    const tap = path.join(dir, `${c.name}.tap`);
    fs.writeFileSync(pids, '');
    const t0 = Date.now();
    const r = spawnSync('bash', ['.github/run-tests.sh', tap, c.file || FIXTURE], {
      encoding: 'utf8', timeout: GUARD_MS, killSignal: 'SIGKILL', windowsHide: true,
      env: { ...process.env, LIMITS_CASE: c.name, LIMITS_PIDS: pids, TRAILMARK_TEST_LIMIT_MS: String(LIMIT_MS), TRAILMARK_TEST_LIMITS: 'enforce' },
    });
    const ms = Date.now() - t0;
    let out = '';
    try { out = fs.readFileSync(tap, 'utf8'); } catch { /* no TAP: the reason below says so */ }
    const misses = c.holds.filter(p => !p.test(out)).map(String);
    const unsaid = c.says.filter(p => !p.test(r.stdout || '')).map(String);
    const why = r.error ? `guard stopped it (${r.error.code})` : r.status !== c.status ? `exit ${r.status}, expected ${c.status}`
      : misses.length ? `output lacks ${misses.join(', ')}` : unsaid.length ? `annotations lack ${unsaid.join(', ')}` : '';
    console.log(`${why ? 'FAIL' : 'ok  '} ${c.name}: exit ${r.status} after ${ms} ms${why ? `: ${why}` : ''}`);
    if (why) { bad++; console.log(out.split(/\r?\n/).filter(l => /^\s*(not ok|ok) |^# |error:/.test(l)).slice(0, 20).map(l => `     ${l}`).join('\n')); }
    left.push(...fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number));
  }
} finally {
  // Stop what the cases left (the orphans), then remove the temp folder,
  // trying again for a few seconds while Windows lets go of the files.
  let stopped = 0;
  for (const pid of left) { try { process.kill(pid, 'SIGKILL'); stopped++; } catch { /* already gone */ } }
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tried again below */ }
    removed = !fs.existsSync(dir);
    if (!removed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  console.log(`processes the cases started: ${left.length}, kill signals delivered now: ${stopped}; temp folder removed ${removed}${removed ? '' : ` (${dir})`}`);
}
console.log(`${ran - bad} of ${ran} cases as expected`);
process.exit(bad ? 1 : 0);

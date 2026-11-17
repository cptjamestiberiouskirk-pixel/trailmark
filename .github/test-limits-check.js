// Checks that the test steps' limits end each kind of hang they are for, on
// the Node version and system it runs on (RS-T-hang75, dev/release-state.md).
// For each case it runs .github/run-tests.sh, the command the test steps run,
// in its enforce mode, on .github/test-limits-fixture.js with a limit of 3 s,
// and reads the TAP output: a hung case must end, fail and name the case.
// Each run has a guard
// of 60 s, this script's own timeout, so a limit that can't fire fails the
// check instead of hanging it. It runs from the repository's root, needs
// bash on PATH, and stops the processes the cases leave.
// Usage: node .github/test-limits-check.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIMIT_MS = 3000;
const GUARD_MS = 60000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmark-limits-'));

// What each case must give: the run's exit status, and patterns the TAP
// output must match.
const cases = [
  { name: 'pass', status: 0, holds: [/^ok \d+ - case pass$/m, /^# fail 0$/m] },
  { name: 'own', status: 0, holds: [/^ok \d+ - case own$/m, /^# fail 0$/m] },
  { name: 'async', status: 1, holds: [/^not ok \d+ - case async$/m, /test timed out after 3000ms/] },
  { name: 'spawnsync', status: 1, holds: [/^not ok \d+ - case spawnsync$/m, /spawnSync .*test-limits-fixture\.js sleep was stopped by the test limit of 3000 ms .* at [^']*test-limits-fixture\.js:\d+/] },
  { name: 'orphan', status: 1, holds: [/^not ok \d+ - case orphan$/m, /execFileSync .*test-limits-fixture\.js orphan was stopped by the test limit of 3000 ms .* at [^']*test-limits-fixture\.js:\d+/] },
  { name: 'swallowed', status: 1, holds: [/^ok \d+ - case swallowed$/m, /1 call\(s\) stopped by the test limit; this file fails/] },
];

let bad = 0;
const left = [];
try {
  const v = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  console.log(`node ${process.version}, ${(v.stdout || String(v.error)).split('\n')[0]}`);
  for (const c of cases) {
    const pids = path.join(dir, `${c.name}.pids`);
    const tap = path.join(dir, `${c.name}.tap`);
    fs.writeFileSync(pids, '');
    const t0 = Date.now();
    const r = spawnSync('bash', ['.github/run-tests.sh', tap, '.github/test-limits-fixture.js'], {
      encoding: 'utf8', timeout: GUARD_MS, killSignal: 'SIGKILL', windowsHide: true,
      env: { ...process.env, LIMITS_CASE: c.name, LIMITS_PIDS: pids, TRAILMARK_TEST_LIMIT_MS: String(LIMIT_MS), TRAILMARK_TEST_LIMITS: 'enforce' },
    });
    const ms = Date.now() - t0;
    let out = '';
    try { out = fs.readFileSync(tap, 'utf8'); } catch { /* no TAP: the reason below says so */ }
    const misses = c.holds.filter(p => !p.test(out)).map(String);
    const why = r.error ? `guard stopped it (${r.error.code})` : r.status !== c.status ? `exit ${r.status}, expected ${c.status}` : misses.length ? `output lacks ${misses.join(', ')}` : '';
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
console.log(`${cases.length - bad} of ${cases.length} cases as expected`);
process.exit(bad ? 1 : 0);

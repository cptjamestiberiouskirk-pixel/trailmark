// A test file that hangs on purpose, for .github/test-limits-check.js only
// (it is not in any test step's file list). LIMITS_CASE picks the shape:
//   pass       nothing hangs (the control)
//   async      waits on a promise that never settles, with a timer open
//   spawnsync  spawnSync of a child that never ends and ignores SIGTERM,
//              with `timeout: 0` (which Node reads as none)
//   orphan     execFileSync of a child that exits at once and leaves a
//              grandchild holding its output pipe, with `timeout: undefined`
//   swallowed  the orphan case, with no timeout key, inside a try/catch that
//              ignores the error
//   own        spawnSync with a timeout of its own, which it keeps
// LIMITS_PIDS names a file where every process started here writes its pid,
// so the check can stop what is left.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');

const which = process.env.LIMITS_CASE || 'pass';
const pids = process.env.LIMITS_PIDS;
// The child: with "sleep" it stays, and with "stubborn" it also ignores
// SIGTERM; with "orphan" it starts a sleeper that holds its stdout and
// stderr, then exits.
if (process.argv[2] === 'sleep' || process.argv[2] === 'stubborn') {
  fs.appendFileSync(pids, `${process.pid}\n`);
  if (process.argv[2] === 'stubborn') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1 << 30);
} else if (process.argv[2] === 'orphan') {
  const c = require('child_process').spawn(process.execPath, [__filename, 'sleep'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  fs.appendFileSync(pids, `${c.pid}\n`);
  c.unref();
} else {
  // This test file's own process too: when the check's guard stops a run, it
  // stops only bash, and this process (and node --test above it, which waits
  // on it) would go on.
  fs.appendFileSync(pids, `${process.pid}\n`);
  test('before the case', () => {});
  test(`case ${which}`, async () => {
    if (which === 'async') {
      await new Promise(() => { setInterval(() => {}, 1000); });
    } else if (which === 'spawnsync') {
      const r = spawnSync(process.execPath, [__filename, 'stubborn'], { encoding: 'utf8', timeout: 0 });
      assert.strictEqual(r.status, 0);
    } else if (which === 'orphan') {
      execFileSync(process.execPath, [__filename, 'orphan'], { encoding: 'utf8', timeout: undefined });
    } else if (which === 'swallowed') {
      try { execFileSync(process.execPath, [__filename, 'orphan'], { encoding: 'utf8' }); } catch { /* ignored on purpose */ }
    } else if (which === 'own') {
      const r = spawnSync(process.execPath, [__filename, 'sleep'], { encoding: 'utf8', timeout: 1000 });
      assert.strictEqual(r.error && r.error.code, 'ETIMEDOUT');
    }
  });
  test('after the case', () => {});
}

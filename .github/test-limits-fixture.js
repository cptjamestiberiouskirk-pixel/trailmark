// A test file that hangs on purpose, for .github/test-limits-check.js only
// (it is not in any test step's file list). LIMITS_CASE picks the shape:
//   pass       nothing hangs (the control)
//   async      three tests wait on a promise that never settles, with a timer
//              open: called test(name, fn), test(name, options, fn), and
//              with `timeout: Infinity` (which Node reads as none)
//   longfile   three tests of 1.2 s each: the file runs past the limit and
//              no test does, so all pass
//   readonly   Error.prepareStackTrace made read-only before a test() call,
//              which must still register the test
//   stacktrace four other shapes of Error.prepareStackTrace, each before a
//              test() call and removed after it: a getter that throws, a
//              setter that refuses the old value, no property, and none of
//              Error's own with an accessor on Function.prototype that keeps
//              what is assigned. Each test must register, the stack must stay
//              a string, and the file's own property or value must be as it
//              set them (RS-T-pstaccessor; the stand-in runs on Node 22 only)
//   spawnsync  spawnSync of a child that never ends and ignores SIGTERM,
//              with `timeout: 0` (which Node reads as none)
//   orphan     execFileSync of a child that exits at once and leaves a
//              grandchild holding its output pipe, with `timeout: undefined`
//   swallowed  the orphan case twice, with no timeout key and then
//              `timeout: null`, and an argument that holds each line
//              terminator, inside a try/catch that ignores the error
//   own        spawnSync with a timeout of its own, which it keeps, and one
//              with a timeout Node refuses, which still throws, in a test
//              with a timeout of its own (8 s) that runs past the limit
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
  const hang = () => new Promise(() => { setInterval(() => {}, 1000); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (which === 'async') {
    test('case async', hang);
    test('case async with options', { skip: false }, hang);
    test('case async with timeout Infinity', { timeout: Infinity }, hang);
  }
  if (which === 'longfile') for (const n of [1, 2, 3]) test(`case longfile ${n}`, () => sleep(1200));
  if (which === 'readonly') {
    Object.defineProperty(Error, 'prepareStackTrace', { value: Error.prepareStackTrace, writable: false, configurable: true });
    test('case readonly', () => {});
  }
  if (which === 'stacktrace') {
    const own = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    const mine = (e, s) => `mine ${Array.isArray(s)}`;
    const bad = [];
    const stack = () => { try { return typeof new Error('x').stack; } catch (e) { return `threw ${e.message}`; } };
    // Sets a shape, registers a test, reads what is left, and puts Node's own
    // property back before the next shape.
    const shape = (name, set, left) => {
      set();
      try { test(`case stacktrace ${name}`, () => {}); } catch (e) { bad.push(`${name}: test() threw ${e.message}`); }
      const got = left();
      if (got) bad.push(`${name}: ${got}`);
      delete Error.prepareStackTrace;
      delete Function.prototype.prepareStackTrace;
      if (own) Object.defineProperty(Error, 'prepareStackTrace', own);
    };
    shape('getter', () => Object.defineProperty(Error, 'prepareStackTrace', { get() { throw new Error('getter says no'); }, set() {}, configurable: true }), () => '');
    let v;
    shape('refused', () => {
      v = undefined;
      Object.defineProperty(Error, 'prepareStackTrace', { get: () => v, set: x => { if (typeof x !== 'function') throw new TypeError('must be a function'); v = x; }, configurable: true });
    }, () => (v === undefined && stack() === 'string' ? '' : `holds ${typeof v}, stack ${stack()}`));
    shape('deleted', () => { delete Error.prepareStackTrace; },
      () => (Object.prototype.hasOwnProperty.call(Error, 'prepareStackTrace') ? 'an own property came back' : ''));
    let held;
    shape('inherited', () => {
      held = mine;
      delete Error.prepareStackTrace;
      Object.defineProperty(Function.prototype, 'prepareStackTrace', { get: () => held, set: x => { held = x; }, configurable: true });
    }, () => (held === mine && stack() === 'string' ? '' : `holds ${held === mine ? 'its own' : typeof held}, stack ${stack()}`));
    test('case stacktrace', () => assert.deepStrictEqual(bad, []));
  }
  if (which !== 'async' && which !== 'longfile' && which !== 'readonly' && which !== 'stacktrace') test(`case ${which}`, which === 'own' ? { timeout: 8000 } : {}, async () => {
    if (which === 'spawnsync') {
      const r = spawnSync(process.execPath, [__filename, 'stubborn'], { encoding: 'utf8', timeout: 0 });
      assert.strictEqual(r.status, 0);
    } else if (which === 'orphan') {
      execFileSync(process.execPath, [__filename, 'orphan'], { encoding: 'utf8', timeout: undefined });
    } else if (which === 'swallowed') {
      // The same call twice, first with no timeout key and then with
      // `timeout: null`, with an argument that holds each line terminator
      // (\n, \r, U+2028, U+2029): each stop is counted, and its message stays
      // on one line.
      const arg = `a\nb\rc${String.fromCharCode(0x2028)}d${String.fromCharCode(0x2029)}e`;
      for (const opts of [{ encoding: 'utf8' }, { encoding: 'utf8', timeout: null }]) {
        try { execFileSync(process.execPath, [__filename, 'orphan', arg], opts); } catch { /* ignored on purpose */ }
      }
    } else if (which === 'own') {
      const r = spawnSync(process.execPath, [__filename, 'sleep'], { encoding: 'utf8', timeout: 1000 });
      assert.strictEqual(r.error && r.error.code, 'ETIMEDOUT');
      assert.throws(() => spawnSync(process.execPath, ['--version'], { timeout: -1 }), { code: 'ERR_OUT_OF_RANGE' });
      await sleep(3500);
    }
  });
  test('after the case', () => {});
}

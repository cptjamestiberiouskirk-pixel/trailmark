// Loaded with --require into each test file's process by .github/run-tests.sh,
// which the test steps of tests.yml run (RS-T-hang75, dev/release-state.md).
// The per-test limit (--test-timeout) ends a test that waits on something
// asynchronous, but it runs on the test's own thread, so it can't end a test
// blocked in a synchronous child call: one whose child never ends, or whose
// child has ended and left a grandchild holding its output pipe. This gives
// each spawnSync, execFileSync and execSync call with no timeout of its own
// (no `timeout` key, or 0, null or undefined, which Node reads as none) the same
// limit, TRAILMARK_TEST_LIMIT_MS (unset or 0: calls are left as they are).
// Node's own timeout then stops the child, with SIGKILL unless the call names
// its own killSignal (a child that ignores SIGTERM is stopped too), and closes
// the pipes, and the call throws an error that names the command, the limit and
// the test file's line, also when the child itself had ended (spawnSync then
// gives status 0 with ETIMEDOUT). The error is also written to stderr, and
// the process exits with 1 at its end, so the file fails even when a test
// catches the error.
// --test-force-exit, which run-tests.sh adds so a test ended by its limit
// doesn't leave the file waiting on what it left open, also lets a file
// whose tests all passed exit with handles still open (before, such a file
// could keep its step waiting). So at exit this writes a line naming the
// file and what is still open, other than its stdio pipes; tap-annotate.js
// turns it into a warning. It only reports.
// On Node 22 run-tests.sh gives no --test-timeout (there it would limit each
// test file as a whole) and sets TRAILMARK_TEST_LIMIT_OPTION=1 in its place.
// Then require('node:test') gives the test file a stand-in for test() that
// hands each call with no timeout of its own (no `timeout` key, or null,
// undefined or Infinity, which Node reads as none) the limit as its `timeout`
// option, and calls node:test's test() with it. Node applies that option to
// the one test, and its subtests copy it (v22.x, fetched 2026-11-18,
// lib/internal/test_runner/test.js, lines 554 and 608), so a test that waits
// on something asynchronous fails with its name after the limit, as with
// --test-timeout on Node 24. Node takes a test's location from the function
// that calls test(), so the stand-in calls it from a function compiled at the
// test file's line and column of the call, and the TAP's location lines stay
// the test file's. It covers a call of the function require('node:test')
// gives, the form the test files use (`const test = require('node:test')`),
// not test.test, test.it, describe(), hooks, a call of another shape, or a
// test file that imports node:test.
'use strict';
const cp = require('child_process');

// --require also loads this into node --test's own process, which runs no
// test: only a test file's process (NODE_TEST_CONTEXT, set by node --test
// for each file it starts) gets the limit and the report.
const IN_TEST_FILE = /^child/.test(process.env.NODE_TEST_CONTEXT || '');
const LIMIT = IN_TEST_FILE ? Number(process.env.TRAILMARK_TEST_LIMIT_MS) || 0 : 0;
const stopped = [];
const ESCAPES = { '\n': '\\n', '\r': '\\r', '\u2028': '\\u2028', '\u2029': '\\u2029' };
if (LIMIT > 0) {
  // The frames of the stack in a .js file other than this one and Node's own
  // (node:...): the test file's lines. `where` gives the first three.
  const frames = () => (new Error().stack || '').split('\n').map(l => l.trim().replace(/^at /, ''))
    .filter(l => /\.js:\d+:\d+\)?$/.test(l) && !/\(node:|^node:/.test(l) && !l.includes(__filename));
  const where = () => frames().slice(0, 3).join(' < ');
  const stoppedError = (name, file, args) => {
    // Each line terminator in the command (\n, \r, U+2028, U+2029: Node's
    // runner splits stderr at each) is written as its escape, so the message
    // stays on one line of stderr, where tap-annotate.js finds it.
    const cmd = [file, ...(args || [])].join(' ').replace(/[\n\r\u2028\u2029]/g, c => ESCAPES[c]).slice(0, 300);
    const e = new Error(`${name} ${cmd} was stopped by the test limit of ${LIMIT} ms (TRAILMARK_TEST_LIMIT_MS, .github/test-limits.js) at ${where() || 'an unknown line'}`);
    e.code = 'TRAILMARK_TEST_LIMIT';
    stopped.push(e.message);
    process.stderr.write(`# ${e.message}\n`);
    return e;
  };
  // spawnSync and execFileSync take (file, [args], [options]); execSync
  // takes (command, [options]). A call whose timeout is undefined, null or 0
  // (Node's "none") gets the limit; any other timeout, a valid one or one Node
  // refuses, goes to Node as the call gave it.
  const split = (a, b) => (Array.isArray(a) || a == null ? { args: a, opts: b } : { args: undefined, opts: a });
  const limited = opts => (opts && !(opts.timeout == null || opts.timeout === 0) ? null
    : { ...(opts || {}), timeout: LIMIT, killSignal: (opts && opts.killSignal) || 'SIGKILL' });

  const { spawnSync, execFileSync, execSync } = cp;
  cp.spawnSync = function (file, a, b) {
    const { args, opts } = split(a, b);
    const mine = limited(opts);
    if (!mine) return spawnSync.apply(this, arguments);
    const r = spawnSync.call(this, file, args || [], mine);
    if (r.error && r.error.code === 'ETIMEDOUT') throw stoppedError('spawnSync', file, args);
    return r;
  };
  cp.execFileSync = function (file, a, b) {
    const { args, opts } = split(a, b);
    const mine = limited(opts);
    if (!mine) return execFileSync.apply(this, arguments);
    try {
      return execFileSync.call(this, file, args || [], mine);
    } catch (e) {
      if (e && e.code === 'ETIMEDOUT') throw stoppedError('execFileSync', file, args);
      throw e;
    }
  };
  cp.execSync = function (command, opts) {
    const mine = limited(opts);
    if (!mine) return execSync.apply(this, arguments);
    try {
      return execSync.call(this, command, mine);
    } catch (e) {
      if (e && e.code === 'ETIMEDOUT') throw stoppedError('execSync', command);
      throw e;
    }
  };

  if (process.env.TRAILMARK_TEST_LIMIT_OPTION === '1') {
    const Module = require('module');
    const vm = require('vm');
    const isObj = v => v !== null && typeof v === 'object';
    const none = t => t == null || t === Infinity;
    // test([name][, options][, fn]): the options are the first argument when
    // that is an object, else the second (Node's createSubtest).
    const withLimit = args => {
      const a = Array.from(args);
      const at = isObj(a[0]) ? 0 : 1;
      if (isObj(a[at])) { if (none(a[at].timeout)) a[at] = { ...a[at], timeout: LIMIT }; }
      else if (a[1] == null) a[1] = { timeout: LIMIT };
      else if (typeof a[1] === 'function' && typeof a[0] !== 'function') a.splice(1, 0, { timeout: LIMIT });
      return a;
    };
    // The place that called test(): the first stack frame in a .js file that
    // is neither Node's own nor this file, read from V8's call sites rather
    // than parsed from the stack's text, where a path may hold parentheses.
    // Null when a test file's Error.prepareStackTrace makes the assignment
    // throw (read-only in strict code, a getter with no setter, a setter that
    // throws) or not take (an accessor that does not keep what is assigned:
    // the stack is then no array). An accessor that keeps it gives the call
    // site; a getter that throws still throws here (RS-T-pstaccessor).
    const callSite = () => {
      const keep = Error.prepareStackTrace;
      let sites = [];
      try {
        Error.prepareStackTrace = (_, s) => s;
        sites = new Error().stack;
      } catch { return null; } finally {
        // Throws when the assignment above did (read-only), or when the file's
        // own setter refuses the old value, which then leaves the call-site
        // array in place (RS-T-pstaccessor).
        try { Error.prepareStackTrace = keep; } catch { /* see above */ }
      }
      for (const s of Array.isArray(sites) ? sites : []) {
        const file = s.getFileName();
        if (file && file.endsWith('.js') && !file.startsWith('node:') && file !== __filename) {
          return { file, line: s.getLineNumber(), col: s.getColumnNumber() };
        }
      }
      return null;
    };
    // A function compiled at the test file's line and column of the call,
    // one for each place: it calls test(), so Node's getCallerLocation reads
    // that place. Null (the stand-in then calls test() itself) when the place
    // can't be read or is on the file's first line.
    const callers = new Map();
    const callerAt = () => {
      const at = callSite();
      if (!at || !(at.line >= 2) || !(at.col >= 1)) return null;
      const key = `${at.file}:${at.line}:${at.col}`;
      if (!callers.has(key)) {
        callers.set(key, vm.compileFunction(`return (\n${' '.repeat(at.col - 1)}f(...a))`, ['f', 'a'],
          { filename: at.file, lineOffset: at.line - 2 }));
      }
      return callers.get(key);
    };
    const load = Module._load;
    let stand = null;
    Module._load = function (request) {
      const m = load.apply(this, arguments);
      if (request !== 'node:test' || typeof m !== 'function') return m;
      stand = stand || new Proxy(m, {
        apply(target, self, args) {
          const a = withLimit(args);
          const call = callerAt();
          return call ? call(target, a) : Reflect.apply(target, self, a);
        },
      });
      return stand;
    };
  }
}
if (IN_TEST_FILE) process.on('exit', () => {
  const open = process.getActiveResourcesInfo().filter(r => r !== 'PipeWrap' && r !== 'TTYWrap');
  if (open.length) process.stderr.write(`# trailmark-test-limits: open at exit in ${process.argv[1]}: ${open.join(', ')}\n`);
  if (!stopped.length) return;
  process.stderr.write(`# ${stopped.length} call(s) stopped by the test limit; this file fails\n`);
  process.exitCode = 1;
});

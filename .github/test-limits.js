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
  // The first three frames of the stack in a .js file other than this one
  // and Node's own (node:...): the test file's lines.
  const where = () => (new Error().stack || '').split('\n').map(l => l.trim().replace(/^at /, ''))
    .filter(l => /\.js:\d+:\d+\)?$/.test(l) && !/\(node:|^node:/.test(l) && !l.includes(__filename)).slice(0, 3).join(' < ');
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
}
if (IN_TEST_FILE) process.on('exit', () => {
  const open = process.getActiveResourcesInfo().filter(r => r !== 'PipeWrap' && r !== 'TTYWrap');
  if (open.length) process.stderr.write(`# trailmark-test-limits: open at exit in ${process.argv[1]}: ${open.join(', ')}\n`);
  if (!stopped.length) return;
  process.stderr.write(`# ${stopped.length} call(s) stopped by the test limit; this file fails\n`);
  process.exitCode = 1;
});

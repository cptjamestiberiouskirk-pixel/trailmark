// What the trailmark test files share: temp folders, the sandbox a test
// runs in, and the helpers more than one file uses.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// Temp folders by their real path: on macOS the temp folder is reached
// through a link (/var -> /private/var), and on Windows through an 8.3 short
// name (RUNNER~1), while git and trailmark report the real one.
// Every temp folder a test makes is removed when the test ends, unless it
// failed (the folder is named, to look at) or JBMEM_TEST_KEEP=1 is set.
// Folders made outside a test go when the file's tests are done.
const tempMade = [];
const realTemp = (prefix) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempMade.push(d);
  return d;
};
const clearTemp = (keep) => {
  for (const d of tempMade.splice(0)) {
    if (keep) { console.log(`# kept ${d}`); continue; }
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the OS */ }
  }
};
test.afterEach((t) => clearTemp(process.env.JBMEM_TEST_KEEP === '1' || t.passed === false));
test.after(() => clearTemp(process.env.JBMEM_TEST_KEEP === '1'));
const WIN = process.platform === 'win32';
// How trailmark writes a folder in the log and on the Updated line (forward
// slashes on Windows; lib/store.js, displayPath).
const dp = p => require(path.join(__dirname, '..', 'scripts', 'lib', 'store.js')).displayPath(p);
// Tests that put a shell script in place of git, or need git to run one,
// can't run on Windows: trailmark starts git.exe only, and Node won't start a
// .cmd file without a shell.
const POSIX_ONLY = WIN && 'needs a shell script run in place of git or by git, which Windows cannot do';
// Making a symlink on Windows needs Developer Mode or admin rights: CI's
// runners have them, an ordinary desktop account may not. Junctions need
// neither, so tests that make only junctions run either way.
const NO_LINKS = WIN && (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-linkprobe-'));
  try { fs.symlinkSync('missing', path.join(d, 'l'), 'file'); return false; } catch { return 'making symlinks needs Developer Mode on Windows'; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
// Bash syntax in a command: on Windows the Codex copy reads commands as
// PowerShell unless JBMEM_CODEX_SHELL=bash, so such a test asks for bash.
function bashSyntax(t) {
  if (process.env.JBMEM_CODEX_SHELL === 'bash') return;
  process.env.JBMEM_CODEX_SHELL = 'bash';
  t.after(() => { delete process.env.JBMEM_CODEX_SHELL; });
}

// The Codex copy refuses init unless this is set (scripts/trailmark.js).
process.env.JBMEM_CODEX_INIT = '1';
delete process.env.CODEX_THREAD_ID;
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'memory.js');

function sandbox() {
  const base = realTemp('jbmem-');
  const cfg = path.join(base, 'cfg');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a'), 'a'); g('add', 'a'); g('commit', '-qm', 'init');
  const key = repo.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = path.join(cfg, 'projects', key);
  fs.mkdirSync(projectDir, { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  delete env.JBMEM_DIR; delete env.CLAUDE_CODE_PROJECT_DIR_NAME; delete env.CLAUDE_CODE_ENTRYPOINT;
  const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, input, encoding: 'utf8' });
  const hook = (name, payload, args = []) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args],
    { cwd: repo, env, input: JSON.stringify({ cwd: repo, ...payload }), encoding: 'utf8' });
  const memdir = path.join(projectDir, 'memory');
  return { base, cfg, repo, env, cli, hook, memdir, projectDir, g };
}

// The version `handoff` prints, as a skill reads it before writing.
function versionNow(run) {
  const out = run(['handoff']).stdout;
  const m = /^\[trailmark\] handoff version: (\S+)/m.exec(out);
  assert.ok(m, 'no version line in: ' + out);
  return m[1];
}
// write-handoff the way a skill does it: read the version, then write with --base.
function wh(run, body, extra = []) {
  return run(['write-handoff', `--base=${versionNow(run)}`, ...extra], body);
}
const J = s => (a, i) => jbm(s, a, i);

const JBM = path.join(ROOT, 'scripts', 'trailmark.js');
function jbm(s, args, input, extraEnv = {}) {
  return spawnSync(process.execPath, [JBM, ...args], { cwd: s.repo, env: { ...s.env, ...extraEnv }, input, encoding: 'utf8' });
}

const SA = '11111111-aaaa-4bbb-8ccc-000000000001';
const SB = '22222222-aaaa-4bbb-8ccc-000000000002';
const SC = '33333333-aaaa-4bbb-8ccc-000000000003';
const stateOf = s => JSON.parse(fs.readFileSync(path.join(s.memdir, '.jbmem-state.json'), 'utf8'));
const notesOf = s => fs.readdirSync(path.join(s.memdir, 'notes')).map(f => fs.readFileSync(path.join(s.memdir, 'notes', f), 'utf8')).join('');

const cp = (...codes) => String.fromCodePoint(...codes);

// A repo with a linked worktree (session A's folder, like a Claude Desktop
// worktree) and a second clone elsewhere (like E:\audit2).
let toolSeq = 0;
// Moves every reflog entry under gitDir/logs (and its worktrees') back by
// `seconds`.
function ageReflogs(gitDir, seconds) {
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^(\S+ \S+ .*?> )(\d+)( [+-]\d{4}\t)/gm, (m, a, t, b) => a + (Number(t) - seconds) + b));
    }
  };
  walk(path.join(gitDir, 'logs'));
  let wts = [];
  try { wts = fs.readdirSync(path.join(gitDir, 'worktrees')); } catch { wts = []; }
  for (const w of wts) walk(path.join(gitDir, 'worktrees', w, 'logs'));
}
function multiFolder() {
  const s = sandbox();
  jbm(s, ['init']);
  const wt = path.join(s.repo, '.claude', 'worktrees', 'wa');
  s.g('worktree', 'add', '-q', '-b', 'wa', wt);
  const clone = path.join(s.base, 'audit2');
  execFileSync('git', ['clone', '-q', s.repo, clone], { stdio: 'ignore' });
  const gIn = (dir) => (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  for (const d of [wt, clone]) { gIn(d)('config', 'user.email', 't@t'); gIn(d)('config', 'user.name', 't'); }
  gIn(clone)('checkout', '-q', '-b', 'audit');
  const head = (dir, full = false) => execFileSync('git', ['rev-parse', ...(full ? [] : ['--short']), 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  // As Claude Code runs them: PreToolUse with the folder the command starts
  // in, then PostToolUse with the folder it ended in (end), the same tool
  // call ID, and the command's duration.
  const hook = (cwd, sid, command, extra = {}) => {
    const { end, pre = true, duration_ms = 60000, env = {}, response = {}, between, ...rest } = extra;
    const base = { session_id: sid, tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_t${++toolSeq}x${process.pid}`, ...rest };
    if (pre) jbm(s, ['--hook', 'commit-start'], JSON.stringify({ ...base, cwd, hook_event_name: 'PreToolUse' }), env);
    // What the command does, run after PreToolUse as in a real session.
    if (between) between();
    const post = { ...base, cwd: end || cwd, hook_event_name: 'PostToolUse', tool_response: response };
    if (duration_ms !== null) post.duration_ms = duration_ms;
    return jbm(s, ['--hook', 'milestone', 'commit'], JSON.stringify(post), env);
  };
  // Everything so far happened ten minutes ago, as far as the reflogs say,
  // so only what a test commits right before a hook is that command's.
  for (const d of [path.join(s.repo, '.git'), path.join(clone, '.git')]) ageReflogs(d, 600);
  // Reminders off, so the tests see every one.
  const cfgFile = path.join(s.memdir, '.jbmem.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), hints: { minMinutesBetween: 0, freshCheckpointMinutes: 0 } }));
  return { s, wt, clone, gWt: gIn(wt), gClone: gIn(clone), head, hook };
}
const commitLines = s => (notesOf(s).match(/^- \d\d:\d\d COMMIT .*$/gm) || []);
const jbmIn = (s, cwd, args, input, extraEnv = {}) => spawnSync(process.execPath, [JBM, ...args], { cwd, env: { ...s.env, ...extraEnv }, input, encoding: 'utf8' });

// The sweep reads up to the whole second it started in: a commit made in that
// second is the next sweep's. Tests wait that second out.
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

// A sweep that runs out of time (git slowed by other work on the machine)
// says so and reads nothing more; the folders it didn't read keep their
// start, so a later sweep logs what it missed. The tests accept that: each
// sweep is repeated until one finishes, and what they all logged is counted.
// While every git call takes about a second (every core kept busy) no sweep
// can finish in its fixed time; after 90 s of that the test is skipped with
// the reason, since what a finished sweep logs can't be checked then.
const SWEEP_SKIP = /commit sweep skipped: out of time/;
class SweepsOutOfTime extends Error {}
let sweepRepeats = 0;
const settle = (once, waitMs = 90000) => {
  const until = Date.now() + waitMs;
  let logged = 0, skips = 0, out = '';
  for (;;) {
    out = once();
    const m = /logged (\d+) commit\(s\) found/.exec(out);
    if (m) logged += Number(m[1]);
    if (!SWEEP_SKIP.test(out)) return { logged, skips, out };
    skips++;
    sweepRepeats++;
    if (Date.now() > until) throw new SweepsOutOfTime(`every sweep for ${waitMs / 1000} s ran out of time (${skips} in a row): git is too slow on this machine now`);
    tick();
  }
};
const settleCall = (call, waitMs = 90000) => {
  const until = Date.now() + waitMs;
  for (let skips = 1; ; skips++) {
    const r = call();
    if (r.stopped !== 'out-of-time') return r;
    sweepRepeats++;
    if (Date.now() > until) throw new SweepsOutOfTime(`every sweep for ${waitMs / 1000} s ran out of time (${skips} in a row): git is too slow on this machine now`);
    tick();
  }
};
const sweepTest = (fn) => (t) => {
  try { fn(t); } catch (e) {
    if (!(e instanceof SweepsOutOfTime)) throw e;
    t.diagnostic(`sweeps that ran out of time and were repeated: ${sweepRepeats}`);
    t.skip(e.message);
  }
};

// A preload (node -r) that makes every git rev-parse fail the way a git
// slower than its timeout does, for the launcher process only (the sandboxed
// script it starts gets no -r). Other programs and git commands run as usual.
const GIT_TIMEOUT_STUB = `const cp = require('child_process');
const path = require('path');
const real = cp.execFileSync;
cp.execFileSync = function (file, args, ...rest) {
  if (/^git(\.exe)?$/i.test(path.basename(String(file))) && Array.isArray(args) && args.includes('rev-parse')) {
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    throw e;
  }
  return real.call(this, file, args, ...rest);
};
`;

// Each test file takes what it uses from here.
module.exports = {
  tempMade, realTemp, clearTemp, WIN, dp, POSIX_ONLY, NO_LINKS, bashSyntax,
  ROOT, CLI, sandbox, versionNow, wh, J, JBM, jbm, SA, SB, SC, stateOf,
  notesOf, cp, ageReflogs, multiFolder, commitLines, jbmIn, tick, SWEEP_SKIP,
  SweepsOutOfTime, sweepRepeats: () => sweepRepeats, settle, settleCall,
  sweepTest, GIT_TIMEOUT_STUB,
};

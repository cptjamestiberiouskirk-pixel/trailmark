#!/usr/bin/env node
// trailmark launcher, ChatGPT desktop (Codex mode) copy. Every hook and every
// skill command enters here. It shares Claude Code's memory folder for the
// repo, so Claude Code and Codex sessions keep one handoff. What differs for
// Codex is marked "Codex:" below and in lib/host.js.
//
// Privilege separation: this launcher runs with normal rights but only reads.
// It finds the repo's memory folder, collects the few git facts the hooks
// need, then runs the real script under Node's permission model:
//   - writes allowed only inside that memory folder
//   - reads allowed only in the plugin folder and the memory folder
//     (plus Codex's session folders for the transcript command)
//   - no child processes, no worker threads, no native addons
// Node calls this a seat belt, not a sandbox: it stops bugs from writing in
// the wrong place, and it does not guarantee containment of malicious code.
//
// Usage:
//   node trailmark.js <memory.js command> [args]        skills
//   node trailmark.js --hook <session-start|precompact|commit-start|milestone> [kind]   hooks
//   node trailmark.js --sandbox-check                   self-test of the seat belt
//   node trailmark.js --copies                          list other trailmark copies on disk
//
// Escape hatch: JBMEM_SANDBOX=off in the environment runs without the
// permission model. Codex: "sandbox": false in the memory folder's
// .jbmem.json is not honored here; the memory folder can be a Codex writable
// root, where any command the agent runs could write that file.

'use strict';

// On Windows, a program started by bare name is looked for in the working
// folder before PATH unless this is set. trailmark runs git by full path
// anyway (lib/gitbin.js); this covers anything git itself starts.
process.env.NoDefaultCurrentDirectoryInExePath = '1';

// What the launcher hands the sandboxed script comes from the launcher alone,
// never from the environment it was started with: a repo's settings can set
// env variables, and these would otherwise choose the memory folder (and so
// the sandbox's write grant) or pass made-up git facts.
for (const k of ['JBMEM_DIR', 'JBMEM_DIR_MISSING', 'JBMEM_LAUNCHED', 'JBMEM_METHOD', 'JBMEM_ROOT', 'JBMEM_GIT']) delete process.env[k];

const fs = require('fs');
const os = require('os');
const path = require('path');
const tty = require('tty');
const { spawnSync } = require('child_process');
const { findMemoryDir: findMemoryDirRaw, projectsRoot, samePath, repoRoot, configDir } = require('./lib/paths');
const { oldCodexCopies, nodeAdvice, otherCopies, nodeInside } = require('./lib/health');
const S = require('./lib/store');
// Every memory folder found here is told to the store, so its link checks
// stop at that folder even when it is named like a subfolder (~/notes).
function findMemoryDir(ctx) { const l = findMemoryDirRaw(ctx); if (l && l.dir) S.addMemoryRoot(l.dir); return l; }
const { commitsSince, gitFacts, commitFacts, fitCommitFacts, sweepCommits, sameFolder, windowMs, farNetwork } = require('./lib/gitfacts');
const { localPath, localPathFrom } = require('./lib/gitbin');
// When the launcher started: a hook's sandboxed script gets what is left of
// the host's hook timeout, not a fixed time on top of the launcher's own work.
const T0 = Date.now();
const { isMilestoneCommand, commitSites } = require('./lib/commands');
const H = require('./lib/host');

const SCRIPTS = __dirname;
const PLUGIN_ROOT = path.dirname(SCRIPTS);

const HOOKS = {
  'session-start': { script: 'hook-session-start.js', facts: ['branch', 'toplevel'] },
  precompact: { script: 'hook-precompact.js', facts: ['branch', 'head', 'status', 'toplevel'] },
  milestone: { script: 'hook-milestone.js', facts: [] }, // commits: see commitFacts below
  'commit-start': { script: 'hook-commit-start.js', facts: [] },
};
const STDIN_COMMANDS = new Set(['write-handoff', 'park']);

// The drop files the skills write for --from: incoming-handoff.md,
// incoming-park.md, or either with a session ID. Only these are removed after
// a successful save; any other file named with --from is left in place.
const SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DROP_RE = new RegExp(`^incoming-(handoff|park)(-${SESSION_ID})?\\.md$`, process.platform === 'win32' ? 'i' : '');

// True when file is inside dir, by name and, when both exist, by real path,
// so a link inside the memory folder can't point --from somewhere else.
function insideFolder(dir, file) {
  const lexical = S.inside(path.resolve(dir), path.resolve(file));
  if (!lexical) return false;
  // A link to a network path is refused before anything resolves it: that
  // would connect to the server (and on Windows send it your sign-in hash).
  if (/^(\\\\|\/\/)/.test(path.resolve(file))) return false;
  // Nor a path through a link that leads to one.
  if (!localPath(file) || !localPath(dir)) return false;
  // A drop file is written by the session's file tool, never as a link, so a
  // link is refused outright (a chain of them could end on a network path).
  try { if (fs.lstatSync(file).isSymbolicLink()) return false; } catch { /* missing: reported when read */ }
  let realDir;
  let realFile;
  try { realDir = fs.realpathSync.native(dir); realFile = fs.realpathSync.native(file); } catch { return true; }
  return S.inside(realDir, realFile);
}

// Reads a --from file through one descriptor, so what was checked is what is
// read: the open file must be the one at the checked real path (same device
// and file ID), inside the memory folder, and have no other hard link, which
// could make a file elsewhere look like one in the folder.
function readFromFile(dir, file) {
  let fd;
  try {
    // A FIFO or device would block the read forever: refuse it before opening,
    // and open without blocking in case one is swapped in between.
    // A link is refused here too (insideFolder checked it already), and the
    // open doesn't follow one swapped in since.
    try { const l = fs.lstatSync(file); if (!l.isFile()) return { error: `${file} is a link or not a file.` }; } catch (e) { return { error: `could not read ${file}: ${e.code || e.message}.` }; }
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0)); } catch (e) { return { error: `could not read ${file}: ${e.code || e.message}.` }; }
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return { error: `${file} is not a file.` };
    if (st.nlink > 1n) return { error: `${file} has other hard links, so it may really live outside the memory folder. Save the text as a new file there.` };
    let real;
    let realDir;
    try { real = fs.realpathSync.native(file); realDir = fs.realpathSync.native(dir); } catch (e) { return { error: `could not resolve ${file}: ${e.code || e.message}.` }; }
    // Both sides resolved: the memory folder's own path may go through a
    // junction, a mapped drive or an 8.3 name, and that is fine.
    if (!S.inside(realDir, real)) return { error: `${file} resolves to ${real}, outside the memory folder (${realDir}).` };
    const st2 = fs.statSync(real, { bigint: true });
    if (st2.dev !== st.dev || st2.ino !== st.ino) return { error: `${file} changed while it was being checked.` };
    // Checked again after the path checks, so a hard link made in between counts.
    if (fs.fstatSync(fd, { bigint: true }).nlink > 1n) return { error: `${file} has other hard links, so it may really live outside the memory folder. Save the text as a new file there.` };
    return { data: fs.readFileSync(fd) };
  } catch (e) {
    return { error: `could not read ${file}: ${e.code || e.message}.` };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function isDropFile(dir, file) {
  const f = path.resolve(file);
  const parent = path.dirname(f);
  const same = process.platform === 'win32' ? parent.toLowerCase() === path.resolve(dir).toLowerCase() : parent === path.resolve(dir);
  return same && DROP_RE.test(path.basename(f));
}

function sandboxSupported() {
  try { return process.allowedNodeEnvironmentFlags.has('--permission'); } catch { return false; }
}

function sandboxDecision(dir) {
  if (String(process.env.JBMEM_SANDBOX || '').toLowerCase() === 'off') return { on: false, why: 'JBMEM_SANDBOX=off' };
  if (!sandboxSupported()) return { on: false, why: `Node ${process.version} has no --permission` };
  return { on: true, why: '' };
}

function permissionFlags({ reads, writes }) {
  const flags = ['--permission'];
  // Folders above others first: Node 22 can refuse to list a folder
  // granted after one inside it.
  for (const r of reads.slice().sort((a, b) => path.resolve(a).length - path.resolve(b).length)) flags.push(`--allow-fs-read=${path.resolve(r)}`);
  for (const w of writes) flags.push(`--allow-fs-write=${path.resolve(w)}`);
  return flags;
}

let HOOK_RUN = false;

// The environment for a sandboxed Node, without NODE_OPTIONS and the other
// NODE_* variables: they reach that Node too, where --allow-fs-write=* or
// --allow-child-process in them would undo the permission flags while the
// status still said "on".
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NODE_/i.test(k)) env[k] = v;
  return env;
}

function run(script, args, { dir, method, root, cwd, input, reads, writes, facts, dirMissing = false }) {
  const sb = sandboxDecision(dir);
  const env = Object.assign(cleanEnv(), {
    JBMEM_DIR: dir,
    JBMEM_LAUNCHED: '1',
    JBMEM_METHOD: method,
    JBMEM_ROOT: root,
    JBMEM_SANDBOX: sb.on ? 'on' : `off: ${sb.why}`,
  });
  if (dirMissing) env.JBMEM_DIR_MISSING = '1'; else delete env.JBMEM_DIR_MISSING;
  if (facts) env.JBMEM_GIT = JSON.stringify(facts);
  // Node reads * in a grant as a wildcard, so a granted path with one in it
  // would allow more than that folder. Such a path is refused, not granted.
  if (sb.on && [...reads, ...writes].some(p => path.resolve(p).includes('*'))) {
    process.stderr.write('trailmark: a folder it would grant has * in its path, which the sandbox reads as a wildcard; nothing was run.\n');
    return 1;
  }
  const nodeArgs = [...(sb.on ? permissionFlags({ reads, writes }) : []), path.join(SCRIPTS, script), ...args];
  // For the tests: show what the sandboxed script is allowed to touch.
  if (process.env.JBMEM_SHOW_GRANTS === '1') process.stderr.write(`trailmark grants: read=${reads.map(r => path.resolve(r)).join('|')} write=${writes.map(w => path.resolve(w)).join('|')}\n`);
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd,
    env,
    input: input === undefined ? undefined : input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    // A hook's script is killed before the host's own hook timeout, so it
    // can't be left running on its own if something blocks it.
    // (commit-start's own timeout is 5 s, the others' 10 s or more).
    timeout: HOOK_RUN ? Math.max(300, (HOOK_RUN === 'commit-start' ? 4500 : 9000) - (Date.now() - T0)) : 120000,
    killSignal: 'SIGKILL',
  });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') process.stderr.write(`trailmark: ${script} took too long and was stopped. Nothing it had not finished was saved.\n`);
    else process.stderr.write(`trailmark: could not start ${script}: ${r.error.message}\n`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

// Reads stdin to the end. Never touch process.stdin before this: Node then
// opens fd 0 as a stream and makes it non-blocking, and readFileSync(0) fails
// with EAGAIN whenever the writer hasn't sent anything yet (seen in the
// six-writer test, 2026-10-18). tty.isatty(0) answers "is it a terminal?"
// without that side effect. Hooks treat a failed read as an empty payload; a
// command reports it, so a write never goes ahead with text it didn't get.
function readAllStdin({ strict = false } = {}) {
  try { return fs.readFileSync(0); } catch (e) {
    if (strict) {
      process.stderr.write(`trailmark: could not read the text on stdin (${e.code || e.message}); nothing was written\n`);
      process.exit(1);
    }
    return Buffer.alloc(0);
  }
}

// The folder the session started in: the first cwd in its transcript.
// Only a transcript inside Claude Code's projects folder is read, and only
// its first 64 KB.
function sessionHome(payload) {
  const tp = payload && payload.transcript_path;
  if (typeof tp !== 'string' || !tp.endsWith('.jsonl')) return '';
  const f = path.resolve(tp);
  if (!S.inside(path.resolve(projectsRoot()), f)) return '';
  // Never through a link to a share. A local link (a project folder kept on
  // another disk) is fine, as in the transcript lookup.
  const real = localPath(f);
  if (!real) return '';
  let fd;
  try {
    // The name itself, so a transcript that is a link isn't read (openPlain
    // refuses it); localPath above already checked the folders on the way.
    fd = require('./lib/plainfile').openPlain(f); // never a FIFO
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    // The first record's own cwd (never one inside a tool call's arguments),
    // and only the share the hook's own cwd is on may be looked up.
    const c = require('./lib/plainfile').recordCwds(buf.slice(0, n).toString('utf8'), 1)[0];
    const pc = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : '';
    return typeof c === 'string' && path.isAbsolute(c) && (pc ? localPathFrom(pc, c) : localPath(c)) && fs.statSync(c).isDirectory() ? c : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// The memory folder for a hook. Claude Code's cwd is wherever the session's
// last command left it, which can be another repo the session may use (an
// added folder); then the folder the session started in decides.
function hookMemory(payload, cwd, gitTimeoutMs) {
  const tp = payload.transcript_path;
  let loc = null;
  try { loc = findMemoryDir({ cwd, transcriptPath: tp, gitTimeoutMs }); } catch { loc = null; }
  if (loc && S.isEnabled(loc.dir)) return loc;
  const home = sessionHome(payload);
  if (!home || sameFolder(home, cwd)) return null;
  try { loc = findMemoryDir({ cwd: home, transcriptPath: tp, gitTimeoutMs }); } catch { return null; }
  return loc && S.isEnabled(loc.dir) ? loc : null;
}

// Codex: the hook payload in the shape the hook scripts expect.
//   - tool_input.command is a string in the documented payload; an argv array
//     (["powershell.exe", "-Command", "..."], ["bash", "-lc", "..."]) is
//     turned into the script text, and its program says which shell.
//   - tool_name: Codex calls its shell tool Bash whatever the shell. On
//     Windows the agent's commands run in PowerShell, so a string command is
//     read as PowerShell there (JBMEM_CODEX_SHELL=bash or powershell
//     overrides, for an agent switched to Git Bash or WSL).
//   - tool_input.workdir, when given, is the folder the command runs in. It
//     goes in codex_workdir; cwd stays the session's folder, which decides
//     the memory folder.
//   - PostToolUse also runs after a command that failed; a failure (exit code
//     in tool_response) becomes PostToolUseFailure, with the output in
//     `error`, as Claude Code sends it.
function shellOf(exe) {
  const b = path.basename(String(exe || '').replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (b === 'powershell' || b === 'pwsh') return 'powershell';
  if (['bash', 'sh', 'zsh', 'dash'].includes(b)) return 'bash';
  return '';
}

// Only the host's own structured fields: a string result (the ChatGPT app's
// form) is what the command printed, which the command chooses.
function trustedExit(resp) {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return null;
  for (const k of ['exit_code', 'exitCode']) if (Number.isInteger(resp[k])) return resp[k];
  if (resp.metadata && Number.isInteger(resp.metadata.exit_code)) return resp.metadata.exit_code;
  return null;
}

// Every form, the printed text included: a last resort after the transcript.
function exitCodeOf(resp) {
  if (resp && typeof resp === 'object') {
    for (const k of ['exit_code', 'exitCode']) if (Number.isInteger(resp[k])) return resp[k];
    if (resp.metadata && Number.isInteger(resp.metadata.exit_code)) return resp.metadata.exit_code;
    for (const k of ['output', 'stdout', 'content', 'text']) if (typeof resp[k] === 'string') { const c = exitCodeOf(resp[k]); if (c !== null) return c; }
    return null;
  }
  if (typeof resp === 'string') {
    // The ChatGPT desktop app (seen 2026-10-25, Windows) gives the result as JSON,
    // {"chunk_id":..., "wall_time_seconds":..., "exit_code":0, ...,
    // "output":"..."}, alone or after a "Script completed ... Output:" header.
    // The exit code is read from the JSON, or, when the text was cut short,
    // only from the plain fields before it: the command's own output is a
    // string with escapes in it, which this never reads past, so a line in it
    // can't pose as the exit code.
    const s = resp.slice(0, 400000).replace(/^\uFEFF/, '').trimStart();
    const hdr = /^[^{]{0,300}?Output:\r?\n/.exec(s);
    const j = s.startsWith('{') ? s : hdr ? s.slice(hdr[0].length).trimStart() : '';
    if (j.startsWith('{')) {
      try { const o = JSON.parse(j); if (o && typeof o === 'object' && Number.isInteger(o.exit_code)) return o.exit_code; } catch { /* cut short */ }
      const lead = /^\{\s*(?:"[A-Za-z_]{1,40}"\s*:\s*(?:"[^"\\]{0,200}"|-?[0-9][0-9.eE+-]{0,39}|null|true|false)\s*,\s*){0,12}"exit_code"\s*:\s*(-?\d{1,10})\b/.exec(j);
      if (lead) return Number(lead[1]);
    }
    // The documented form: "Exit code: N" at the very start.
    const m = /^(?:Exit code:|Process exited with code) ?(-?\d+)/.exec(s.slice(0, 200));
    return m ? Number(m[1]) : null;
  }
  return null;
}

// The exit code the transcript recorded for one command: the
// item_completed event of its CommandExecution item, whose id is the hook's
// tool_use_id (seen 2026-10-25, Windows: exec-<uuid>, with exit_code and status).
// Only a transcript inside Codex's session folders, only its last 2 MB, only
// the line for this ID; null when it isn't there yet (a few short waits) or
// says nothing usable.
let txExit = ''; // for the shape log: what the transcript lookup found

function exitFromTranscript(tp, id) {
  if (typeof tp !== 'string' || typeof id !== 'string' || !/^exec-[A-Za-z0-9-]{1,100}$/.test(id)) return null;
  const T = require('./lib/transcript');
  const file = path.resolve(T.plainPath(tp));
  if (!/\.jsonl$/i.test(file)) return null;
  const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  // By name first: nothing outside Codex's session folders, and nothing on a
  // network path, is resolved or opened at all.
  if (NET_PATH.test(file) || !T.codexRoots().some(r => fold(file).startsWith(fold(path.resolve(r)) + path.sep))) return null;
  // Resolved one part at a time, a link read as text: one that leads to a
  // network path stops here, before anything is looked up through it.
  const real = localPath(file);
  if (!real) return null;
  const roots = T.codexRoots().map(r => localPath(path.resolve(r)) || path.resolve(r));
  if (!roots.some(r => fold(real).startsWith(fold(r) + path.sep))) return null;
  try { if (!fs.lstatSync(real).isFile()) return null; } catch { return null; }
  const needle = `"id":"${id}"`;
  const scan = () => {
    let fd;
    try {
      fd = require('./lib/plainfile').openPlain(real);
      if (!fs.fstatSync(fd).isFile()) return null;
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l.includes(needle) || !l.includes('"CommandExecution"')) continue;
        let o;
        try { o = JSON.parse(l); } catch { continue; }
        const item = o && o.payload && o.payload.item;
        if (!item || item.type !== 'CommandExecution' || item.id !== id) continue;
        if (Number.isInteger(item.exit_code)) return item.exit_code;
        if (Number.isInteger(item.exitCode)) return item.exitCode;
        if (item.status === 'failed') return 1;
        if (item.status === 'completed') return 0;
      }
      return null;
    } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = scan();
    if (c !== null) return c;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return null;
}

const NET_PATH = /^(\\\\|\/\/)/;

function normalizeCodex(p) {
  const out = { ...p };
  const agentTool = /^(agent|spawn_agent)$/i.test(String(p.tool_name || ''));
  if (p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input) && !agentTool) {
    const ti = { ...p.tool_input };
    let c = ti.command;
    let shell = '';
    if (Array.isArray(c) && c.length && c.every(x => typeof x === 'string')) {
      shell = shellOf(c[0]);
      const i = c.findIndex((x, j) => j > 0 && /^-(l?c|command|c)$/i.test(x));
      if (shell && i > 0 && i === c.length - 2) c = c[c.length - 1];
      else if (shell) c = '';
      else {
        // Quoted for the shell the text is read as below, so an argument
        // can't end its quotes early in the other shell's rules.
        const forced = String(process.env.JBMEM_CODEX_SHELL || '').toLowerCase();
        const ps = forced === 'powershell' || (forced !== 'bash' && process.platform === 'win32');
        c = c.map(x => (x === '' || /[^\w@%+=:,./\\-]/.test(x) ? (ps ? `'${x.replace(/['\u2018\u2019\u201a\u201b]/g, q => q + q)}'` : `'${x.replace(/'/g, "'\\''")}'`) : x)).join(' ');
      }
    }
    ti.command = typeof c === 'string' ? c : '';
    // A payload that already names the PowerShell tool (Codex's own says
    // Bash) is taken at its word.
    if (!shell && /^powershell$/i.test(String(p.tool_name || ''))) shell = 'powershell';
    if (!shell) {
      const forced = String(process.env.JBMEM_CODEX_SHELL || '').toLowerCase();
      shell = forced === 'bash' || forced === 'powershell' ? forced : (process.platform === 'win32' ? 'powershell' : 'bash');
    }
    out.tool_input = ti;
    out.tool_name = shell === 'powershell' ? 'PowerShell' : 'Bash';
    const wd = typeof ti.workdir === 'string' && ti.workdir && ti.workdir.length < 4096 ? ti.workdir : '';
    if (wd && typeof p.cwd === 'string' && path.isAbsolute(p.cwd)) out.codex_workdir = path.resolve(p.cwd, wd);
    else if (wd && path.isAbsolute(wd)) out.codex_workdir = path.resolve(wd);
    // A network folder outside the session's own is never used: the launcher
    // would touch it from outside Codex's sandbox.
    if (out.codex_workdir && NET_PATH.test(out.codex_workdir) && !(typeof p.cwd === 'string' && path.isAbsolute(p.cwd) && S.inside(path.resolve(p.cwd), out.codex_workdir))) delete out.codex_workdir;
  }
  if (p.hook_event_name === 'PostToolUse' && !agentTool) {
    const code = trustedExit(p.tool_response);
    if (code !== null && code !== 0) {
      out.hook_event_name = 'PostToolUseFailure';
      const r = p.tool_response;
      out.error = typeof r === 'string' ? r.slice(0, 400000) : JSON.stringify(r).slice(0, 400000);
      delete out.tool_response;
    }
  }
  return out;
}

// Codex: a record of each hook payload's shape, for checking this copy
// against the app it runs in, in repos set up for trailmark only. Field
// names and types only, plus the event, tool and source names and the first
// word of a command when it is one of a few program names (anything else,
// such as NAME=value, is logged as "other"): no command text, output or
// paths. Kept in the plugin's data folder (PLUGIN_DATA), at most 256 KB;
// JBMEM_SHAPES=off turns it off.
//
// resp= says how a tool result is built without quoting it: its length, its
// first character's kind, which of a few known markers it holds (an exit_code
// field, "Exit code", "Wall time", an "Output:" header), where its first {
// is, and its keys when it is JSON. transcript= says which folder under the
// user's home the transcript path names, and how it is spelled.
//
// On request only: when the data folder holds a file named
// dump-next-tool-result, the next shell tool result is written to
// tool-result-dump.txt there (the first 3,000 characters of the command and
// of the result, which can hold anything the command printed) and the
// request file is removed. Delete the dump once read.
function respForm(r) {
  if (typeof r !== 'string') return r === undefined ? 'undefined' : (Array.isArray(r) ? 'array' : r === null ? 'null' : typeof r);
  const s = r.slice(0, 8000);
  const t0 = s.trimStart();
  const c = t0[0] || '';
  const f = [`len${r.length}`, 'first:' + (c === '{' ? 'brace' : c === '[' ? 'bracket' : c === '"' ? 'quote' : /[A-Za-z]/.test(c) ? 'letter' : /\d/.test(c) ? 'digit' : c ? 'other' : 'empty')];
  for (const [k, re] of [['exit_code_field', /"exit_code"\s*:/], ['exitCode_field', /"exitCode"\s*:/], ['exit_code_word', /exit code/i], ['process_exited', /process exited/i], ['wall_time', /wall time/i], ['output_hdr', /^Output:/m], ['script_completed', /script completed/i]]) if (re.test(s)) f.push(k);
  const b = s.indexOf('{');
  if (b >= 0) f.push('brace@' + b);
  try { const o = JSON.parse(r); if (o && typeof o === 'object' && !Array.isArray(o)) f.push('jsonkeys:' + Object.keys(o).slice(0, 12).map(k => k.replace(/[^\w]/g, '?').slice(0, 30)).join('+')); } catch { /* not JSON */ }
  return f.join('|');
}

function pathForm(tp) {
  if (typeof tp !== 'string') return tp === null ? 'null' : typeof tp;
  const T = require('./lib/transcript');
  const marks = [];
  if (/^\\\\\?\\/.test(tp)) marks.push('longprefix');
  if (/^[a-z]:/.test(T.plainPath(tp))) marks.push('lowerdrive');
  const plain = path.resolve(T.plainPath(tp));
  const home = path.resolve(require('os').homedir());
  const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  let where = 'outside-home';
  if (fold(plain).startsWith(fold(home) + path.sep)) {
    const segs = plain.slice(home.length + 1).split(/[\\/]/).slice(0, 2).map(x => (/^[\w.-]{1,40}$/.test(x) ? x : '?'));
    where = '~/' + segs.join('/');
  }
  const inHome = S.inside(path.resolve(T.codexHome()), plain);
  return `${inHome ? 'codex-home' : 'elsewhere'}(${where}${marks.length ? ',' + marks.join(',') : ''})`;
}

// The diagnostics are written by the launcher, outside the sandbox, so never
// through a link, into a non-plain file, into a file with other hard links,
// or into a data folder that is itself a link or on a network path.
function writePlain(dir, name, text, append) {
  if (NET_PATH.test(dir)) return false;
  try { const d = fs.lstatSync(dir); if (d.isSymbolicLink() || !d.isDirectory()) return false; } catch { return false; }
  const file = path.join(dir, name);
  try { const st = fs.lstatSync(file); if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return false; } catch (e) { if (!e || e.code !== 'ENOENT') return false; }
  const C = fs.constants;
  // Truncated only after the check: a hard link swapped in since the lstat
  // must not have its other name emptied.
  const fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | (append ? C.O_APPEND : 0) | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0), 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return false;
    if (!append) fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text);
  } finally { fs.closeSync(fd); }
  return true;
}

function dumpOnRequest(dir, p) {
  const flag = path.join(dir, 'dump-next-tool-result');
  try { if (!fs.lstatSync(flag).isFile()) return; } catch { return; }
  if (p.hook_event_name !== 'PostToolUse') return;
  const cmd = p.tool_input && p.tool_input.command;
  const r = p.tool_response;
  const text = [
    `time: ${new Date().toISOString()}`,
    `tool_name: ${String(p.tool_name)}`,
    `command: ${(typeof cmd === 'string' ? cmd : JSON.stringify(cmd) || '').slice(0, 3000)}`,
    `tool_response type: ${Array.isArray(r) ? 'array' : r === null ? 'null' : typeof r}`,
    'tool_response:',
    (typeof r === 'string' ? r : JSON.stringify(r, null, 2) || '').slice(0, 3000),
    `transcript_path: ${String(p.transcript_path)}`,
  ].join('\n');
  if (!writePlain(dir, 'tool-result-dump.txt', text + '\n', false)) return;
  try { fs.unlinkSync(flag); } catch { /* left; the next result overwrites the dump */ }
}

function logShape(name, extra, p) {
  const dir = process.env.PLUGIN_DATA;
  if (!dir || !path.isAbsolute(dir) || NET_PATH.test(dir) || /^(0|off|false|no)$/i.test(process.env.JBMEM_SHAPES || '')) return;
  const f = path.join(dir, 'payload-shapes.log');
  try { if (fs.lstatSync(f).size > 256 * 1024) return; } catch { /* new file */ }
  const ty = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  const keys = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 30).map(k => `${k.replace(/[^\w-]/g, '?').slice(0, 30)}:${ty(o[k])}`).join(',') : ty(o));
  const safe = s => (typeof s === 'string' ? s.replace(/[^\w.:-]/g, '?').slice(0, 40) : ty(s));
  const cmd = p.tool_input && p.tool_input.command;
  const known = w => (/^(git|gh|node|npm|npx|powershell|pwsh|bash|sh|cmd|cd|set-location|push-location)(\.exe)?$/i.test(path.basename(String(w || '').replace(/\\/g, '/'))) ? path.basename(String(w).replace(/\\/g, '/')) : 'other');
  const first = typeof cmd === 'string' ? known(cmd.trim().split(/\s+/)[0]) : Array.isArray(cmd) ? cmd.slice(0, 2).map(known).join(':') : '';
  const resp = p.tool_response;
  const code = exitCodeOf(resp);
  const tp = p.transcript_path;
  const env = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CODEX_THREAD_ID', 'CODEX_HOME'].filter(k => process.env[k]).join('|');
  const line = [
    new Date().toISOString(), `hook=${name}${extra[0] ? '/' + extra[0] : ''}`, `event=${safe(p.hook_event_name)}`, `tool=${safe(p.tool_name)}`,
    `source=${safe(p.source)}`, `platform=${process.platform}`, `node=${process.version}`, `keys=${keys(p)}`, `tool_input=${keys(p.tool_input)}`,
    `cmd0=${safe(first)}`, `tool_response=${keys(resp)}`, `resp=${respForm(resp)}`, `exit=${code === null ? '?' : code}`, ...(txExit ? [`exit_tx=${txExit}`] : []),
    `session=${S.cleanSession(p.session_id) ? 'uuid' : ty(p.session_id)}`,
    `thread_env=${!process.env.CODEX_THREAD_ID ? 'unset' : S.cleanSession(process.env.CODEX_THREAD_ID) === S.cleanSession(p.session_id) ? 'same' : 'differs'}`,
    `transcript=${pathForm(tp)}`,
    `env=${env || 'none'}`,
  ].join(' ');
  if (NET_PATH.test(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  if (!writePlain(dir, 'payload-shapes.log', line + '\n', true)) return;
  try { dumpOnRequest(dir, p); } catch { /* diagnostics only */ }
}

function hookMode(name, extraIn) {
  let extra = extraIn;
  const started = Date.now();
  const spec = HOOKS[name];
  if (!spec) process.exit(0);
  let raw = readAllStdin();
  let payload = {};
  try { payload = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '') || '{}'); } catch { /* empty payload */ }
  if (!payload || typeof payload !== 'object') payload = {};
  const rawPayload = payload;
  payload = normalizeCodex(payload);
  const command = (payload.tool_input && payload.tool_input.command) || '';
  // Codex: hooks.json has no `if`, so one PostToolUse hook sees every shell
  // command and the kind is read from the command here.
  if (name === 'milestone' && extra[0] === 'auto') {
    const kind = isMilestoneCommand('commit', command) ? 'commit' : isMilestoneCommand('pr-merge', command) ? 'pr-merge' : '';
    if (!kind) process.exit(0);
    extra = [kind, ...extra.slice(1)];
  }
  // Codex runs PostToolUse after a failed command too. A failed commit
  // command is handled as Claude Code's PostToolUseFailure (commits it made
  // are logged, no reminder); a failed PR merge is not a milestone.
  // The ChatGPT desktop app's tool result is only what the command printed,
  // with no exit code (seen 2026-10-25, Windows). Its transcript records the
  // command, under the same ID, with the exit code, just before the hook runs.
  // The transcript comes first: printed text could pose as an exit code.
  if (name === 'milestone' && payload.hook_event_name === 'PostToolUse' && trustedExit(payload.tool_response) === null) {
    let code = null;
    try { code = exitFromTranscript(payload.transcript_path, payload.tool_use_id); } catch { code = null; }
    txExit = code === null ? 'none' : String(code);
    if (code === null) code = exitCodeOf(payload.tool_response);
    if (code !== null && code !== 0) {
      const r = payload.tool_response;
      payload = { ...payload, hook_event_name: 'PostToolUseFailure', error: typeof r === 'string' ? r.slice(0, 400000) : JSON.stringify(r || '').slice(0, 400000) };
      delete payload.tool_response;
    }
    // Still not known: a PR merge counts only when gh said it merged one.
    if (code === null && extra[0] === 'pr-merge' && !/\b(?:squashed and |rebased and )?merged pull request\b/i.test(String(payload.tool_response || ''))) process.exit(0);
  }
  if (name === 'milestone' && extra[0] === 'pr-merge' && payload.hook_event_name === 'PostToolUseFailure') process.exit(0);
  raw = Buffer.from(JSON.stringify(payload), 'utf8');
  // The commit hooks also fire on every `git -C ...` command, so leave before
  // any git work unless this one really is a commit (or a PR merge).
  if (name === 'milestone' && !isMilestoneCommand(extra[0], command)) process.exit(0);
  if (name === 'commit-start' && !isMilestoneCommand('commit', command)) process.exit(0);
  const cwd = payload.cwd || process.cwd();
  // The PreToolUse hook holds up the command, so its git calls get a second
  // each, not three: when git hangs, the PostToolUse hook carries on without
  // the record.
  const loc = hookMemory(payload, cwd, name === 'commit-start' ? 1000 : undefined);
  if (!loc) process.exit(0); // repo not set up: stay silent, and log nothing
  try { logShape(name, extra, rawPayload); } catch { /* diagnostics only */ }
  const opts = { dir: loc.dir, method: loc.method, root: loc.root, cwd, input: raw, reads: [PLUGIN_ROOT, loc.dir], writes: [loc.dir] };
  // PreToolUse: no git at all, only the record of where the command starts.
  if (name === 'commit-start') process.exit(run(spec.script, extra, opts));
  // All git work in a hook gets about 5 s, including finding the repo above,
  // so the hook ends well inside Claude Code's 10 s timeout even when git hangs.
  // A commit is read from the folder it ran in, worked out from the command
  // text and the folder it started in; pr-merge and subagent need no git.
  let facts;
  if (name === 'milestone' && extra[0] === 'commit') {
    const shell = String(payload.tool_name || '').toLowerCase() === 'powershell' ? 'powershell' : 'bash';
    const start = S.readCommitStart(loc.dir, payload.tool_use_id, S.cleanSession(payload.session_id));
    // PostToolUseFailure (the command failed): no tool_response and no
    // duration, and the session is still where the command started (Claude
    // Code saves the end folder only after a Bash command succeeds).
    const afterFailure = payload.hook_event_name === 'PostToolUseFailure';
    const from = start ? start.cwd : (payload.codex_workdir || cwd);
    const found = commitSites(command, { shell, cwd: from, startKnown: !!start || (afterFailure && shell === 'bash') });
    // Codex: the session's folder never moves, so it is the home folder.
    const home = sessionHome(payload) || cwd;
    // For the printed-SHA rule (gitfacts.commitFacts): another commit command
    // running at the same time, and what is logged already.
    // A failed command's output comes in `error` ("Exit code N", then stderr
    // and stdout).
    const printed = printedCommits(afterFailure ? payload.error : payload.tool_response);
    let concurrent = [], known;
    if (printed.size) {
      const began = start ? start.at : Date.now() - (Number(payload.duration_ms) || 0);
      try { concurrent = S.concurrentCommitStarts(loc.dir, payload.tool_use_id, payload.session_id, began, windowMs()); } catch { concurrent = []; }
      try { known = S.knownCommits(loc.dir, S.readState(loc.dir)); } catch { known = undefined; }
    }
    // A failed command with no PreToolUse record has no time span to read
    // commits in: only the ones git printed for it count.
    const onlyPrinted = afterFailure && !start;
    const commit = onlyPrinted && !printed.size ? { folders: [], unresolved: [] } : commitFacts(found, from, {
      budgetMs: Math.max(0, 5000 - (Date.now() - started)), durationMs: payload.duration_ms, homeCwd: home, procStart: performance.timeOrigin,
      startAt: start ? start.at : undefined, printed, concurrent, known, onlyPrinted,
    });
    // A failed command leaves the session where it started, whatever the
    // text says: no end-folder check for it.
    // Codex: each command runs in a fresh shell and the session's folder
    // never moves, so there is no end folder to compare.
    facts = { commit: fitCommitFacts(commit) };
  } else {
    facts = gitFacts(cwd, spec.facts, { budgetMs: Math.max(0, 5000 - (Date.now() - started)) });
    // At session start, commits in this session's folders that no hook logged.
    if (name === 'session-start') {
      // Commits since the handoff was written, and which repo this memory
      // folder was first used for.
      const since = sinceHandoff(loc, cwd, 5000 - (Date.now() - started) - 1500);
      if (since) facts.since = since;
      const seen = rootSeen(loc, cwd);
      if (seen) facts.rootSeen = seen;
      const sweep = sweepFacts(loc, S.cleanSession(payload.session_id), sessionHome(payload) || cwd, 5000 - (Date.now() - started));
      if (sweep) facts.sweep = sweep;
      // Read here, before the sandbox: the hook can't see Claude Code's
      // plugin cache. See lib/health.js.
      let copies = [];
      let incomplete = '';
      try { ({ copies, incomplete } = otherCopies(configDir(), PLUGIN_ROOT)); } catch { copies = []; incomplete = 'the check failed'; }
      facts.health = { node: nodeAdvice(process.version), copies, incomplete, nodeHere: nodeInside(process.execPath, [cwd, loc.root]) };
      // Codex: the old jb-memory-codex in Codex's own plugin cache.
      try {
        const ch = process.env.CODEX_HOME && path.isAbsolute(process.env.CODEX_HOME) ? process.env.CODEX_HOME : path.join(require('os').homedir(), '.codex');
        facts.health.oldCodex = oldCodexCopies(ch);
      } catch { /* not checked */ }
    }
  }
  process.exit(run(spec.script, extra, { ...opts, facts }));
}

// The commits on HEAD since the handoff's HEAD (its Updated line), read
// before the sandbox since the hook can't run git.
function sinceHandoff(loc, cwd, left) {
  if (left < 400) return null;
  let text = null;
  try { text = S.readText(path.join(loc.dir, S.HANDOFF)); } catch { return null; }
  const st = S.handoffStamp(text || '');
  if (!st.head) return null;
  try { return commitsSince(cwd, st.head, { budgetMs: Math.min(1200, left) }); } catch { return null; }
}

// The repo root recorded in the state file, and, when it differs from this
// one, whether it still holds a repo (lib/store.js, checkRepoRoot).
function rootSeen(loc, cwd) {
  let st = {};
  try { st = S.readState(loc.dir); } catch { return null; }
  const r = typeof st.repoRoot === 'string' && st.repoRoot.length < 4096 && path.isAbsolute(st.repoRoot) ? st.repoRoot : '';
  if (!r) return { recorded: '' };
  // A network path is never looked up, not even to compare it: resolving it
  // would reach the server, outside the sandbox.
  // Same by name first: a session on a share compares its own root without
  // looking it up. Then the session's own share may be looked up, no other.
  if (sameFolder(r, loc.root)) return { recorded: r, same: true };
  if (farNetwork(r, cwd) || !localPathFrom(cwd, r)) return { recorded: r, same: false, network: true };
  let exists = false;
  try { exists = fs.lstatSync(path.join(r, '.git')) !== null; } catch { exists = false; }
  return { recorded: r, same: false, exists };
}

// The short SHAs git printed for its commits ("[main 1a2b3c4] fix", also
// "(root-commit)" and "detached HEAD"), from the tool's output. Read from at
// most 400 KB of it.
function printedCommits(resp) {
  const texts = [];
  let size = 0;
  const walk = (v, depth) => {
    if (depth > 3 || size > 400000) return;
    if (typeof v === 'string') { texts.push(v.slice(0, 400000 - size)); size += v.length; }
    else if (v && typeof v === 'object') for (const k of Object.keys(v).slice(0, 20)) walk(v[k], depth + 1);
  };
  walk(resp, 0);
  const set = new Set();
  for (const m of texts.join('\n').matchAll(/\[[^\[\]\n]{1,200} ([0-9a-f]{7,40})\] /g)) set.add(m[1].toLowerCase());
  return set;
}

// The commit sweep for one session: its own folder and every folder its
// commits went to, each from where its last sweep ended (or the session's
// start, at most a day back). Needs a session record with a start time;
// returns undefined otherwise. When too little of the time budget is left to
// read every folder, the result says so (stopped: 'out-of-time', reported to
// the user) and the folders not read keep their start for the next sweep.
// JBMEM_TEST_SWEEP_MS can only lower the budget (the tests' way to run out).
// A folder with a memory folder of its own (another clone set up for
// trailmark) is swept only past the commits logged there and the commit
// commands still running there: those belong to that folder's sessions.
function sweepFacts(loc, session, homeCwd, budgetMs) {
  if (!session) return undefined;
  const low = Number(process.env.JBMEM_TEST_SWEEP_MS);
  if (low > 0) budgetMs = Math.min(budgetMs, low);
  const deadline = Date.now() + budgetMs - 500;
  let rec = null;
  try { rec = S.sessionRecord(loc.dir, session); } catch { rec = null; }
  if (!rec || !Number.isFinite(rec.start)) return undefined;
  const now = Date.now();
  const late = () => ({ at: Math.floor(now / 1000) * 1000, folders: [], read: [], stopped: 'out-of-time' });
  if (!(budgetMs >= 1500)) return late();
  const win = windowMs();
  // A commit command still running (another session's, most likely) logs its
  // own commits with its session; the sweep stops short of when it started.
  // The reflog keeps whole seconds: a commit made at or after the command's
  // start carries a time no more than a second before it.
  const held = (dir, mine) => {
    let state = {};
    try { state = S.readState(dir); } catch { state = {}; }
    const open = S.openCommitStart(dir, state, win, now, mine);
    return { until: Number.isFinite(open) ? open - 1000 : undefined, state };
  };
  const own = held(loc.dir, session);
  const swept = rec.swept && typeof rec.swept === 'object' && !Array.isArray(rec.swept) ? rec.swept : {};
  const sinceFor = (d) => {
    const k = Object.keys(swept).find(x => Number.isFinite(swept[x]) && sameFolder(x, d));
    return Math.max(k ? swept[k] : rec.start, now - 24 * 3600 * 1000);
  };
  const dirs = [];
  // The folders come from the state file, which a session can write: a
  // network one outside the session's folder is never touched.
  const add = (d) => { if (typeof d === 'string' && d.length < 4096 && path.isAbsolute(d) && !farNetwork(d, homeCwd) && localPathFrom(homeCwd, d) && !dirs.some(x => sameFolder(x, d))) dirs.push(d); };
  add(rec.home); add(homeCwd);
  for (const d of Array.isArray(rec.commitDirs) ? rec.commitDirs : []) add(d);
  add(rec.commitDir);
  const items = [];
  let short = false;
  for (const d of dirs.slice(0, 8)) {
    const left = deadline - Date.now();
    if (left < 1300) { short = true; break; }
    let other = null;
    try {
      const l2 = findMemoryDir({ cwd: d, gitTimeoutMs: Math.min(500, left - 800), noScan: true });
      if (l2 && l2.dir && !samePath(l2.dir, loc.dir) && S.isEnabled(l2.dir)) other = l2.dir;
    } catch { continue; } // not known: leave this folder for a later sweep
    const item = { dir: d, since: sinceFor(d), until: own.until };
    if (other) {
      const h = held(other, '');
      if (Number.isFinite(h.until)) item.until = Number.isFinite(item.until) ? Math.min(item.until, h.until) : h.until;
      try { item.exclude = S.knownCommits(other, h.state); } catch { continue; }
    }
    items.push(item);
  }
  items.sort((a, b) => a.since - b.since);
  const left = deadline - Date.now();
  if (left < 1000 || (!items.length && short)) return late();
  if (!items.length) return undefined;
  // rec.home comes from the state file, which a session can write: it is
  // used only when it is a local path (git runs there).
  const recHome = typeof rec.home === 'string' && rec.home && path.isAbsolute(rec.home) && !farNetwork(rec.home, homeCwd) && localPathFrom(homeCwd, rec.home) ? rec.home : homeCwd;
  const out = sweepCommits(items, { homeCwd: recHome, budgetMs: Math.min(left, 3000), now });
  if (short) out.stopped = 'out-of-time';
  return out;
}

// Whether init got --force, read the way memory.js reads its flags: options
// end at a lone "--", and the last --force or --force=<value> wins.
function initForced(argv) {
  const end = argv.indexOf('--', 1);
  let v;
  for (const a of (end >= 0 ? argv.slice(1, end) : argv.slice(1))) {
    if (a === '--force') v = true;
    else if (a.startsWith('--force=')) v = a.slice('--force='.length);
  }
  return !!v;
}

function cliMode(args) {
  const cmd = args[0];
  const cwd = process.cwd();
  const loc = findMemoryDir({ cwd });
  const reads = [PLUGIN_ROOT, loc.dir];
  const writes = [loc.dir];
  if (cmd === 'transcript') {
    const { codexRoots } = require('./lib/transcript');
    for (const r of codexRoots()) if (localPath(r) && fs.existsSync(r)) reads.push(r);
  }
  // Node only honors grants for paths that exist at startup. Before memory/
  // exists (a repo Claude Code hasn't written auto memory for yet), checks such
  // as "is it set up?" would be refused instead of answering no. Read access to
  // the nearest existing folder above it lets them answer, but only inside the
  // projects folder. A memory folder set somewhere else (autoMemoryDirectory)
  // gets no such grant: its parent could be a whole drive.
  // init creates memory/ itself. Inside the projects folder it gets the
  // project folder that holds memory/. A memory folder set somewhere else is
  // made here, before the sandbox starts, so the grant stays on that folder
  // alone and never reaches its parent, which could be a whole drive.
  // Codex: a session can't set a repo up on its own. A repo also used from
  // Claude Code is set up there, which knows its own folder rules (a folder
  // guessed here could split the handoff in two); a Codex-only repo is set up
  // by the user, by hand.
  // JBMEM_CODEX_INIT=1 allows it (the tests, or a repo used only from Codex).
  if (cmd === 'init' && process.env.JBMEM_CODEX_INIT !== '1') {
    process.stderr.write('trailmark: init is off in this copy, so a Codex session can\'t set a repo up on its own. Nothing was written. To set this repo up, run the tm-memory-setup skill: it shows the one command to run yourself, outside Codex.\n');
    process.exit(1);
  }
  if (cmd === 'init') {
    const top = path.resolve(projectsRoot());
    const parent = path.dirname(path.resolve(loc.dir));
    if (samePath(parent, top) || S.inside(top, parent)) {
      // A repo Claude Code has never opened has no project folder yet, and a
      // grant on a missing path does nothing, so init was refused. Make the
      // folder here, but only when init will go ahead: memory.js refuses an
      // unverified folder without --force, and an empty project folder left
      // behind would count as verified the next time.
      if (!fs.existsSync(parent) && (loc.method !== 'formula-unverified' || initForced(args))) {
        try { fs.mkdirSync(parent, { recursive: true }); } catch (e) {
          process.stderr.write(`trailmark: could not create ${parent}: ${e.code || e.message}\n`);
          process.exit(1);
        }
      }
      reads.push(parent); writes.push(parent);
    }
    else {
      try { fs.mkdirSync(loc.dir, { recursive: true }); } catch (e) {
        process.stderr.write(`trailmark: could not create ${loc.dir}: ${e.code || e.message}\n`);
        process.exit(1);
      }
    }
  }
  let dirMissing = false;
  if (!fs.existsSync(loc.dir)) {
    const top = path.resolve(projectsRoot());
    let up = path.dirname(path.resolve(loc.dir));
    const underTop = samePath(up, top) || S.inside(top, up);
    if (underTop) {
      while (!samePath(up, top) && !fs.existsSync(up)) up = path.dirname(up);
      // No projects folder at all (Claude Code never ran under this config):
      // nothing to grant, and nothing is set up.
      if (fs.existsSync(up)) reads.push(up); else dirMissing = true;
    } else {
      dirMissing = true;
    }
  }
  // write-handoff and park take their text on stdin, or from a file named with
  // --from=<path>. The file route is for PowerShell, which won't pipe text into
  // a command without manual approval. The launcher reads the file and passes
  // it on stdin, so the sandboxed script needs no extra grant. Because this
  // read happens before the sandbox starts, the file must be inside the memory
  // folder, like the drop files the skills write there. A drop file
  // (incoming-handoff*.md, incoming-park*.md) is removed once its text is
  // saved; any other file is left alone.
  let input;
  let childArgs = args;
  let dropFile = null;
  // Options end at a lone "--"; anything after it is text, never --from.
  const optEnd = args.indexOf('--');
  const opts = optEnd >= 0 ? args.slice(0, optEnd) : args;
  const fromArgs = STDIN_COMMANDS.has(cmd) ? opts.filter(a => a.startsWith('--from=')) : [];
  if (fromArgs.length > 1) {
    process.stderr.write('trailmark: --from was given more than once. Name one file. Nothing was written.\n');
    process.exit(1);
  }
  const fromArg = fromArgs[0];
  if (fromArg) {
    const file = path.resolve(cwd, fromArg.slice('--from='.length).replace(/^"(.*)"$/, '$1'));
    if (!insideFolder(loc.dir, file)) {
      process.stderr.write(`trailmark: --from must name a file inside the memory folder (${loc.dir}). ${file} is outside it. Save the text there with the Write tool, or pipe it on stdin. Nothing was written.\n`);
      process.exit(1);
    }
    const r = readFromFile(loc.dir, file);
    if (r.error) {
      process.stderr.write(`trailmark: ${r.error} Nothing was written.\n`);
      process.exit(1);
    }
    input = r.data;
    childArgs = [...opts.filter(a => !a.startsWith('--from=')), ...(optEnd >= 0 ? args.slice(optEnd) : [])];
    if (isDropFile(loc.dir, file)) dropFile = file;
  } else if (STDIN_COMMANDS.has(cmd) && !tty.isatty(0)) {
    input = readAllStdin({ strict: true });
  }
  // write-handoff stamps the Updated line with git's branch and HEAD. The
  // sandboxed script can't run git, so the launcher collects them here.
  let facts;
  if (cmd === 'write-handoff') {
    facts = handoffFacts(loc, cwd, sessionArg(opts));
    // At a checkpoint, commits this session made that no hook logged.
    const sweep = sweepFacts(loc, sessionArg(opts), cwd, 3000);
    if (sweep) facts.sweep = sweep;
  }
  const code = run('memory.js', childArgs, { dir: loc.dir, method: loc.method, root: loc.root, cwd, input, reads, writes, facts, dirMissing });
  if (code === 0 && dropFile) { try { fs.unlinkSync(dropFile); } catch { /* left in place; the next write replaces it */ } }
  process.exit(code);
}

// The session ID as memory.js reads it: the last --session=, else
// CODEX_THREAD_ID.
function sessionArg(opts) {
  const given = opts.filter(a => a.startsWith('--session=')).pop();
  return S.cleanSession(given ? given.slice('--session='.length) : '') || S.cleanSession(process.env.CODEX_THREAD_ID || '');
}

// Branch and HEAD for the Updated line, from where this session's work went:
// the folder of its last logged commit (the commit hook records it), else the
// folder it runs in. The folder is named on the line unless it is the main
// checkout, so a worktree or another clone is never mistaken for it.
function handoffFacts(loc, cwd, session) {
  let target = cwd;
  try {
    const rec = session ? S.sessionRecord(loc.dir, session) : null;
    const d = rec && typeof rec.commitDir === 'string' ? rec.commitDir : '';
    if (d && path.isAbsolute(d) && !farNetwork(d, cwd) && localPathFrom(cwd, d) && fs.statSync(d).isDirectory()) target = d;
  } catch { /* the session's own folder */ }
  let f = gitFacts(target, ['branch', 'head', 'toplevel']);
  if (!f.head && target !== cwd) { target = cwd; f = gitFacts(cwd, ['branch', 'head', 'toplevel']); }
  let top = path.resolve(target);
  if (f.toplevel) {
    const t = path.resolve(f.toplevel);
    if (sameFolder(t, top) || S.inside(t, top)) top = t; // core.worktree can make git print any path
  }
  const out = {};
  if (f.branch) out.branch = f.branch;
  if (f.head) out.head = f.head;
  let main = '';
  try { main = repoRoot(cwd); } catch { main = ''; }
  if ((out.head || out.branch) && !sameFolder(top, main) && !sameFolder(top, loc.root)) out.folder = S.displayPath(top);
  return out;
}

// For the user (the session-start warning points here): the other trailmark
// copies the session-start check finds, by full path. Run outside the sandbox,
// since the plugin cache is outside its grants; it only reads. What it prints
// is folder names from disk: data for whoever reads it.
function listCopies() {
  let copies = [];
  let incomplete = '';
  try { ({ copies, incomplete } = otherCopies(configDir(), PLUGIN_ROOT)); } catch { incomplete = 'the check failed'; }
  console.log(`trailmark: other copies in Claude Code's plugin cache (this one is ${S.oneLine(PLUGIN_ROOT, 600)}):`);
  if (!copies.length) console.log('  none found');
  for (const c of copies) console.log(`  ${S.oneLine(String(c.path || ''), 600)} (version ${S.oneLine(String(c.version || '?'), 40)})`);
  if (incomplete) console.log(`  the check stopped early: ${S.oneLine(incomplete, 300)}`);
  // Codex: the old jb-memory-codex in Codex's own plugin cache.
  try {
    const ch = process.env.CODEX_HOME && path.isAbsolute(process.env.CODEX_HOME) ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex');
    for (const rel of oldCodexCopies(ch)) console.log(`  jb-memory-codex (old name): ${S.oneLine(path.join(ch, rel), 600)}`);
  } catch { console.log('  (the Codex plugin cache could not be checked)'); }
  process.exit(0);
}

// Proves the seat belt on this machine: allowed writes work, everything else is refused.
function sandboxCheck() {
  if (!sandboxSupported()) {
    console.log(`SANDBOX UNAVAILABLE: Node ${process.version} does not support --permission. Install a current Node LTS.`);
    process.exit(1);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jbmem-check-'));
  const allowed = path.join(base, 'allowed');
  const denied = path.join(base, 'denied');
  fs.mkdirSync(allowed); fs.mkdirSync(denied);
  const probe = [
    "const fs=require('fs'),path=require('path'),cp=require('child_process');",
    'const [A,D,B]=process.argv.slice(1);const r={};',
    "const t=(k,f)=>{try{f();r[k]='allowed'}catch(e){r[k]=e.code==='ERR_ACCESS_DENIED'?'refused':'error '+e.code}};",
    "t('write inside memory folder',()=>fs.writeFileSync(path.join(A,'x.txt'),'x'));",
    "t('write outside memory folder',()=>fs.writeFileSync(path.join(D,'x.txt'),'x'));",
    "t('write to a look-alike folder name',()=>fs.writeFileSync(A+'-evil.txt','x'));",
    "t('read outside allowed folders',()=>fs.readdirSync(D));",
    "t('start a child process',()=>cp.execFileSync(process.execPath,['--version']));",
    'console.log(JSON.stringify(r));',
  ].join('');
  const r = spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${allowed}`, `--allow-fs-write=${allowed}`,
    '-e', probe, allowed, denied, base,
  ], { encoding: 'utf8', windowsHide: true, env: cleanEnv() });
  let res = {};
  try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* parse below */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp folder, best effort */ }
  const expect = {
    'write inside memory folder': 'allowed',
    'write outside memory folder': 'refused',
    'write to a look-alike folder name': 'refused',
    'read outside allowed folders': 'refused',
    'start a child process': 'refused',
  };
  let ok = true;
  console.log(`trailmark sandbox check on Node ${process.version} (${process.platform})`);
  // The check passes on Node releases that predate permission-model fixes,
  // so the version is checked on its own (lib/health.js).
  const advice = nodeAdvice(process.version);
  if (advice) console.log(`  WARN  ${advice}`);
  const here = nodeInside(process.execPath, [process.cwd()]);
  if (here) console.log(`  WARN  ${here}`);
  for (const [k, want] of Object.entries(expect)) {
    const got = res[k] || 'no result';
    const pass = got === want;
    ok = ok && pass;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${k}: ${got} (expected ${want})`);
  }
  if (!Object.keys(res).length) console.log(`  probe output: ${(r.stdout || '') + (r.stderr || '')}`.trim());
  console.log(ok ? 'SANDBOX OK' : 'SANDBOX CHECK FAILED');
  process.exit(ok ? 0 : 1);
}

const argv = process.argv.slice(2);
HOOK_RUN = argv[0] === '--hook' ? String(argv[1] || '') : false;
if (argv[0] === '--hook') hookMode(argv[1], argv.slice(2));
else if (argv[0] === '--sandbox-check') sandboxCheck();
else if (argv[0] === '--copies') listCopies();
else cliMode(argv);

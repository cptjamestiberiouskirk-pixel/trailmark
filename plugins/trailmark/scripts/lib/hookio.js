// Shared plumbing for trailmark hooks. A hook must never break a session, so
// failures exit 0. A refusal by the sandbox is the one failure worth seeing:
// it means the seat belt caught something, so it is reported to the user.

'use strict';

const fs = require('fs');
const { findMemoryDir } = require('./paths');
const S = require('./store');
const { facts } = require('./gitfacts');

// The hook's payload. Started by the launcher, a hook gets it in JBMEM_PAYLOAD
// (see hookInput below) and nothing on stdin; run directly, it reads stdin.
function readPayload() {
  const fromLauncher = process.env.JBMEM_LAUNCHED === '1' && typeof process.env.JBMEM_PAYLOAD === 'string' ? process.env.JBMEM_PAYLOAD : null;
  try { return JSON.parse(fromLauncher !== null ? fromLauncher : fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

// What the launcher hands a hook's script, as JSON text in JBMEM_PAYLOAD: the
// payload fields the hook scripts read (and memoryDirOrExit above), never a
// tool's result or a prompt. Not on stdin: on macOS, spawnSync sometimes
// deadlocks while it writes a big input to the child's stdin (a socket). The
// child waits in read, the parent in kevent, and the launcher stops the hook
// after 9 s (seen in CI 2026-11-06, 9 of 3,600 calls, all with 80k or more).
// A field's value is kept only when it is a string, number, boolean or null;
// tool_input keeps its command and run_in_background, tool_response only its
// exit fields. Windows caps a variable at 32,767 characters, so the launcher
// starts no hook script for a payload over PAYLOAD_MAX (a command that long).
const PAYLOAD_MAX = 30000;
const HOOK_FIELDS = ['session_id', 'transcript_path', 'cwd', 'codex_workdir', 'hook_event_name', 'source', 'trigger', 'tool_name', 'tool_use_id', 'duration_ms', 'agent_id', 'agent_type'];
const INPUT_FIELDS = ['command', 'run_in_background'];
const EXIT_FIELDS = ['interrupted', 'exit_code', 'exitCode'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const plain = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
function pick(from, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(from, k) && plain(from[k])) out[k] = from[k];
  return out;
}
function hookInput(payload) {
  const p = isObj(payload) ? payload : {};
  const out = pick(p, HOOK_FIELDS);
  if (isObj(p.tool_input)) out.tool_input = pick(p.tool_input, INPUT_FIELDS);
  if (isObj(p.tool_response)) out.tool_response = pick(p.tool_response, EXIT_FIELDS);
  return JSON.stringify(out);
}

// Returns the memory dir for an opted-in repo, or exits silently.
function memoryDirOrExit(payload) {
  const cwd = payload.cwd || process.cwd();
  let loc;
  try { loc = findMemoryDir({ cwd, transcriptPath: payload.transcript_path }); } catch { process.exit(0); }
  if (!loc || !S.isEnabled(loc.dir)) process.exit(0);
  return { dir: loc.dir, cwd };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function guard(fn) {
  try {
    fn();
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') {
      emit({ systemMessage: `[trailmark] sandbox refused ${e.permission || 'access'} to ${e.resource || 'a path'}. Nothing was written there. If this keeps happening, report it; JBMEM_SANDBOX=off bypasses the sandbox.` });
    }
    process.exit(0);
  }
}

// The sandbox state in a fixed form: the launcher sets JBMEM_SANDBOX to "on"
// or "off: <its reason>", but a hook run some other way gets whatever the
// environment held, which a repo's own settings can set. Only the launcher's
// own reasons are shown; anything else is "reason not shown".
function sandboxWord(s = process.env.JBMEM_SANDBOX) {
  if (!s) return 'off (run directly, not via trailmark.js)';
  if (s === 'on') return 'on';
  const why = String(s).replace(/^off:\s*/i, '');
  if (why === 'JBMEM_SANDBOX=off' || /^Node v\d{1,3}\.\d{1,3}\.\d{1,3} has no --permission$/.test(why)) return `off: ${why}`;
  return 'off: reason not shown';
}

function sandboxNote() {
  return `sandbox ${sandboxWord()}`;
}

module.exports = { readPayload, hookInput, HOOK_FIELDS, PAYLOAD_MAX, memoryDirOrExit, facts, emit, guard, sandboxNote, sandboxWord };

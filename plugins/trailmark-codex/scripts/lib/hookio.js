// Shared plumbing for trailmark hooks. A hook must never break a session, so
// failures exit 0. A refusal by the sandbox is the one failure worth seeing:
// it means the seat belt caught something, so it is reported to the user.

'use strict';

const fs = require('fs');
const { findMemoryDir } = require('./paths');
const S = require('./store');
const { facts } = require('./gitfacts');

function readPayload() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
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

module.exports = { readPayload, memoryDirOrExit, facts, emit, guard, sandboxNote, sandboxWord };

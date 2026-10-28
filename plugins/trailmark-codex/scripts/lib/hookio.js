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

function sandboxNote() {
  const s = process.env.JBMEM_SANDBOX;
  if (!s) return 'sandbox off (run directly, not via trailmark.js)';
  return s === 'on' ? 'sandbox on' : `sandbox ${s}`;
}

module.exports = { readPayload, memoryDirOrExit, facts, emit, guard, sandboxNote };

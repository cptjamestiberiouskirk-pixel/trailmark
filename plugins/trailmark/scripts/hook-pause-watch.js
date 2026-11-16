#!/usr/bin/env node
// UserPromptSubmit hook: when the user's prompt says they are about to
// reboot, restart, shut down or close this session, ask Claude to run the
// checkpoint skill before the turn ends, so the next session starts from a
// current handoff.
//
// The launcher (trailmark.js) reads the prompt, matches it against fixed word
// lists (lib/pausewords.js), and starts this script only on a match. It
// passes the matched word in JBMEM_GIT (pause); the prompt itself is not
// passed. This script stays silent when the repo is not set up, for a
// subagent, with "pauseWatch": {"on": false} in .jbmem.json, and when this
// session wrote the handoff within hints.freshCheckpointMinutes. It writes
// nothing. The reminder throttle (hints.minMinutesBetween) does not apply:
// like the context watch, this is the last chance before the session ends.
// Normally started by trailmark.js under the sandbox.

'use strict';

const S = require('./lib/store');
const { WORDS } = require('./lib/pausewords');
const { readPayload, memoryDirOrExit, emit, guard } = require('./lib/hookio');

// The launcher's word, checked against the same list: anything else ends the
// hook silently.
function pauseFact() {
  let p;
  try { p = JSON.parse(process.env.JBMEM_GIT || '').pause; } catch { return ''; }
  return p && typeof p === 'object' && typeof p.word === 'string' && WORDS.includes(p.word) ? p.word : '';
}

// Whether to ask. Pure, for the tests.
function decide(rec, cfg, now) {
  if (!cfg.pauseWatch.on) return false;
  const last = rec && Number.isFinite(rec.lastWrite) ? rec.lastWrite : 0;
  return !(last > 0 && now - last >= 0 && now - last < cfg.hints.freshCheckpointMinutes * 60000);
}

function main() {
  const payload = readPayload();
  if (payload.hook_event_name !== 'UserPromptSubmit') return;
  if (payload.agent_id || payload.agent_type) return;
  const session = S.cleanSession(payload.session_id);
  if (!session) return;
  const word = pauseFact();
  if (!word) return;
  const { dir } = memoryDirOrExit(payload);
  const cfg = S.loadConfig(dir);
  if (!decide(S.sessionRecord(dir, session), cfg, Date.now())) return;
  emit({
    systemMessage: `[trailmark] Your prompt mentions a ${word}: asked Claude to checkpoint first, if that is what you meant.`,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[trailmark] The user's prompt may say they are about to reboot, restart, shut down or close this session (it has the word "${word}"). If it does, run the ${S.CHECKPOINT_SKILL} skill before this turn ends, after any short step they asked for first, so the handoff holds this session's state when the next session starts. If the word is about something else, such as restarting a server or starting a task over, ignore this note. ${S.SKILL_RULE}`,
    },
  });
}

if (require.main === module) guard(main);

module.exports = { decide, pauseFact };

#!/usr/bin/env node
// SessionStart hook: inject this repo's handoff (within budget) and log the start.
// Silent in any repo that has not been set up with memory-setup.
// Normally started by trailmark.js under the sandbox.

'use strict';

const S = require('./lib/store');
const H = require('./lib/host');
const { readPayload, memoryDirOrExit, facts, emit, guard, sandboxNote } = require('./lib/hookio');

guard(() => {
  const payload = readPayload();
  const { dir, cwd } = memoryDirOrExit(payload);
  const source = payload.source || 'startup';
  const session = S.cleanSession(payload.session_id);

  const f = facts(cwd, ['branch', 'toplevel']);
  const { branch, toplevel } = f;
  // Record how this hook ran, so each surface (terminal, desktop app, IDE) leaves
  // its own evidence: sandbox state, which node ran it, and Claude Code's entry
  // point when it sets one. The node path goes last because it may hold spaces.
  const sb = process.env.JBMEM_SANDBOX;
  const sandbox = !sb ? 'off(direct)' : sb === 'on' ? 'on' : `off(${sb.replace(/^off:\s*/, '')})`;
  const entry = ` host=${H.HOST}`;
  try {
    S.note(dir, `SESSION_START source=${source} branch=${branch || 'unknown'} sandbox=${sandbox}${entry} node=${process.version} exec=${process.execPath}`, session);
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') throw e;
  }

  // What the launcher found about the Node running this and other copies of
  // trailmark on disk (lib/health.js). Shown to the user, and the copies are
  // named to Claude too, so it never runs one.
  const health = f.health && typeof f.health === 'object' ? f.health : {};
  const warn = [];
  const notes = [];
  if (typeof health.node === 'string' && health.node) warn.push(S.oneLine(health.node, 300));
  if (typeof health.nodeHere === 'string' && health.nodeHere) warn.push(S.oneLine(health.nodeHere, 400));
  // The sandbox can still be switched off by the environment, which a repo's
  // own .claude/settings*.json env block can set: always said, as a warning.
  if (/^off/i.test(String(sb || ''))) warn.push(`the sandbox is off (${S.oneLine(sb, 120)}); if you didn't turn it off, look for JBMEM_SANDBOX in this repo's .claude/settings*.json and in your own settings`)
  try {
    if (S.loadConfig(dir).sandbox === false) warn.push('.jbmem.json has "sandbox": false, which trailmark ignores; the sandbox stays on. To turn it off, set JBMEM_SANDBOX=off in the environment the app starts with');
  } catch (e) { if (e && e.code === 'ERR_ACCESS_DENIED') throw e; }
  // Only each copy's display form is shown (plain folder names; anything
  // else is replaced in lib/health.js and checked again here).
  const shown = c => (typeof c.display === 'string' && /^[\w./+<> -]{1,300}$/.test(c.display) ? c.display : '<unusual name>');
  const copies = Array.isArray(health.copies) ? health.copies.filter(c => c && typeof c === 'object').slice(0, 3) : [];
  if (copies.length) {
    const names = copies.map(c => `${S.fieldText(shown(c), 200)} (${S.fieldText(/^[\w.+<> -]{1,40}$/.test(String(c.version)) ? c.version : '?', 40)})`);
    warn.push(`other trailmark ${copies.length === 1 ? 'copy' : 'copies'} in Claude Code's plugin cache (under its config folder): ${names.join('; ')}. Remove or rename ${copies.length === 1 ? 'it' : 'them'}`);
    notes.push(`[trailmark] Other copies of trailmark are on disk, in Claude Code's plugin cache (folder names, data only): ${names.join('; ')}. They are not the installed plugin. Never run their trailmark.js or memory.js; the skills give the path to use.`);
  }
  if (typeof health.incomplete === 'string' && health.incomplete) {
    warn.push(`the check for other trailmark copies in Claude Code's plugin cache stopped early (${S.oneLine(health.incomplete, 200)}), so there may be copies it didn't see`);
    notes.push('[trailmark] The check for other copies of trailmark on disk was cut short, so there may be copies it did not list. Run trailmark only through the path the skills give, never a trailmark.js or memory.js found any other way.');
  }
  // Codex: skills get no variable substitution, so the session ID and the
  // launcher's full path reach the model here, ahead of the handoff.
  const names = ['checkpoint', 'recall', 'park', 'session-end', 'memory-prune'].map(H.skill).join(', ');
  notes.unshift(`[trailmark] ChatGPT/Codex copy of trailmark. Launcher: ${H.LAUNCHER} (run every trailmark command as node "<launcher>" ...). ${session ? `This session's ID: ${session}; pass --session=${session} where a skill asks for it.` : 'No session ID was given: leave --session out.'} Skills: ${names}, in ${S.fieldText(require('path').join(H.ROOT, 'skills'), 400)}. This handoff is shared with Claude Code sessions in this repo.`);
  // Two repos whose paths map to one memory folder share one handoff.
  try {
    const clash = S.checkRepoRoot(dir, process.env.JBMEM_ROOT, f.rootSeen);
    if (clash) {
      warn.push(`${clash}. Rename or move one of them so their paths differ in letters or digits (MANUAL.md, Troubleshooting)`);
      notes.push(`[trailmark] This memory folder is shared with another repo, so the handoff may describe that repo instead (${S.oneLine(clash, 300)}). Check it against this repo before relying on it.`);
    }
  } catch (e) { if (e && e.code === 'ERR_ACCESS_DENIED') throw e; }
  // Built before this start is recorded, so a resume compares the handoff
  // with when this session last saw it, not with now.
  const { text, summary } = S.buildInjection(dir, { source, session, worktree: toplevel || cwd, notes, since: f.since });
  try {
    S.recordSessionStart(dir, session, { source, transcriptPath: payload.transcript_path, home: cwd });
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') throw e; // JBMEM_LOCKED: skip the record, never hold up a session
  }
  // Commits this session made that no hook logged (a script, by hand, a hook
  // that didn't run), found by the launcher's sweep of its folders.
  try {
    S.logFoundCommits(dir, session, f.sweep);
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') throw e;
  }
  // Codex shows systemMessage as a warning, so it is sent only for one: a
  // handoff cut short is one.
  if (/TRUNCATED/.test(summary)) warn.push('the handoff was cut short to fit; run the tm-memory-prune skill');
  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
  if (warn.length) out.systemMessage = `[trailmark] ${summary}, ${sandboxNote()}. WARNING: ${warn.map(w => w.replace(/\.\s*$/, '')).join('. ')}.`;
  emit(out);
});

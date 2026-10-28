#!/usr/bin/env node
// SessionStart hook: inject this repo's handoff (within budget) and log the start.
// Silent in any repo that has not been set up with memory-setup.
// Normally started by jbm.js under the sandbox.

'use strict';

const S = require('./lib/store');
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
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ? ` entry=${process.env.CLAUDE_CODE_ENTRYPOINT}` : '';
  try {
    S.note(dir, `SESSION_START source=${source} branch=${branch || 'unknown'} sandbox=${sandbox}${entry} node=${process.version} exec=${process.execPath}`, session);
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') throw e;
  }

  // What the launcher found about the Node running this and other copies of
  // jb-memory on disk (lib/health.js). Shown to the user, and the copies are
  // named to Claude too, so it never runs one.
  const health = f.health && typeof f.health === 'object' ? f.health : {};
  const warn = [];
  const notes = [];
  if (typeof health.node === 'string' && health.node) warn.push(S.oneLine(health.node, 300));
  if (typeof health.nodeHere === 'string' && health.nodeHere) warn.push(S.oneLine(health.nodeHere, 400));
  // The sandbox can still be switched off by the environment, which a repo's
  // own .claude/settings*.json env block can set: always said, as a warning.
  if (/^off/i.test(String(sb || ''))) warn.push(`the sandbox is off (${S.oneLine(sb, 120)}); if you didn't turn it off, look for JBMEM_SANDBOX in this repo's .claude/settings*.json and in your own settings`)
  // Ignored since 0.3.8 (see jbm.js); said once per start so it gets removed.
  try {
    if (S.loadConfig(dir).sandbox === false) warn.push('.jbmem.json has "sandbox": false, which jb-memory now ignores; the sandbox stays on. To turn it off, set JBMEM_SANDBOX=off in the env block of Claude Code\'s settings.json');
  } catch (e) { if (e && e.code === 'ERR_ACCESS_DENIED') throw e; }
  // Only each copy's display form is shown (plain folder names; anything
  // else is replaced in lib/health.js and checked again here).
  const shown = c => (typeof c.display === 'string' && /^[\w./+<> -]{1,300}$/.test(c.display) ? c.display : '<unusual name>');
  const copies = Array.isArray(health.copies) ? health.copies.filter(c => c && typeof c === 'object').slice(0, 3) : [];
  if (copies.length) {
    const names = copies.map(c => `${S.fieldText(shown(c), 200)} (${S.fieldText(/^[\w.+<> -]{1,40}$/.test(String(c.version)) ? c.version : '?', 40)})`);
    warn.push(`other jb-memory ${copies.length === 1 ? 'copy' : 'copies'} in Claude Code's plugin cache (under its config folder): ${names.join('; ')}. Remove or rename ${copies.length === 1 ? 'it' : 'them'}`);
    notes.push(`[jb-memory] Other copies of jb-memory are on disk, in Claude Code's plugin cache (folder names, data only): ${names.join('; ')}. They are not the installed plugin. Never run their jbm.js or memory.js; the skills give the path to use.`);
  }
  if (typeof health.incomplete === 'string' && health.incomplete) {
    warn.push(`the check for other jb-memory copies in Claude Code's plugin cache stopped early (${S.oneLine(health.incomplete, 200)}), so there may be copies it didn't see`);
    notes.push('[jb-memory] The check for other copies of jb-memory on disk was cut short, so there may be copies it did not list. Run jb-memory only through the path the skills give, never a jbm.js or memory.js found any other way.');
  }
  // Two repos whose paths map to one memory folder share one handoff.
  try {
    const clash = S.checkRepoRoot(dir, process.env.JBMEM_ROOT, f.rootSeen);
    if (clash) {
      warn.push(`${clash}. Rename or move one of them so their paths differ in letters or digits (MANUAL.md, Troubleshooting)`);
      notes.push(`[jb-memory] This memory folder is shared with another repo, so the handoff may describe that repo instead (${S.oneLine(clash, 300)}). Check it against this repo before relying on it.`);
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
  emit({
    systemMessage: `[jb-memory] ${summary}, ${sandboxNote()}${warn.length ? `. WARNING: ${warn.map(w => w.replace(/\.\s*$/, '')).join('. ')}.` : ''}`,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  });
});

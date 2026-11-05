#!/usr/bin/env node
// SessionStart hook: inject this repo's handoff (within budget) and log the start.
// Silent in any repo that has not been set up with memory-setup.
// Normally started by trailmark.js under the sandbox.

'use strict';

const S = require('./lib/store');
const H = require('./lib/host');
const { readPayload, memoryDirOrExit, facts, emit, guard, sandboxNote, sandboxWord } = require('./lib/hookio');

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
  const sandbox = !sb ? 'off(direct)' : sb === 'on' ? 'on' : `off(${sandboxWord(sb).replace(/^off:\s*/, '')})`;
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
  // git kept out of this repo (gitbin.js): a fixed word, never repo text.
  const refused = typeof f.gitRefused === 'string' && /^[a-z][a-z-]{0,23}$/.test(f.gitRefused) ? f.gitRefused : '';
  if (refused) warn.push(`git is kept out of this repo (${refused}), so commits and the branch aren't read. Something in its .git leads to a network path or can't be checked; SECURITY.md, "Known limits", lists what`);
  const notes = [];
  if (typeof health.node === 'string' && health.node) warn.push(S.oneLine(health.node, 300));
  // Warnings are fixed text: a path or name from disk goes only in a note,
  // marked as data, and the launcher's --copies lists the copies it found.
  // The command names this launcher by the folder it was installed in. That
  // path is written only as it is on disk (usablePath): one that would have
  // to be changed to be written safely isn't written, so the command never
  // names a file that isn't there (Copilot on PR #4).
  const launcher = S.usablePath(require('path').join(__dirname, 'trailmark.js'));
  const listCmd = launcher ? `node "${launcher}" --copies` : `the --copies command of the trailmark.js in trailmark's install folder (its path isn't written here: it holds characters trailmark doesn't pass on, or is too long)`;
  if (typeof health.nodeHere === 'string' && health.nodeHere) {
    warn.push(`the Node running trailmark is inside this session's folder or repo, so a node program there ran in place of the installed one. Remove it, and set NoDefaultCurrentDirectoryInExePath=1 (MANUAL.md, section 9); ask Codex for its path`);
    notes.push(`[trailmark] The Node that ran this hook is inside this session's folder or repo, not the installed one (its path, data only: ${S.fieldText(S.oneLine(process.execPath, 400), 400)}). Tell the user if asked; never run it.`);
  }
  // The sandbox can still be switched off by the environment, which a repo's
  // own .claude/settings*.json env block can set: always said, as a warning.
  if (/^off/i.test(String(sb || ''))) warn.push(`the sandbox is ${sandboxWord(sb)}; if you didn't turn it off, look for JBMEM_SANDBOX in this repo's .claude/settings*.json and in your own settings`)
  try {
    if (S.loadConfig(dir).sandbox === false) warn.push('.jbmem.json has "sandbox": false, which trailmark ignores; the sandbox stays on. To turn it off, set JBMEM_SANDBOX=off in the environment the app starts with');
  } catch (e) { if (e && e.code === 'ERR_ACCESS_DENIED') throw e; }
  // Counted only (0.6.0): no folder is named, so every copy found is counted.
  const copies = Array.isArray(health.copies) ? health.copies.filter(c => c && typeof c === 'object') : [];
  if (copies.length) {
    const one = copies.length === 1;
    warn.push(`${one ? 'another trailmark copy is' : `${copies.length} other trailmark copies are`} in Claude Code's plugin cache (under plugins/cache in its config folder: a plugin folder named trailmark or jb-memory, or one whose scripts folder holds trailmark.js or jbm.js). Remove or rename ${one ? 'it' : 'them'}; ${listCmd} lists ${one ? 'it' : 'them'}`);
    notes.push(`[trailmark] ${one ? 'Another copy of trailmark is' : `${copies.length} other copies of trailmark are`} on disk, in Claude Code's plugin cache. They are not the installed plugin. Never run their trailmark.js or memory.js; the skills give the path to use. If the user asks which, run ${listCmd} and show its output.`);
  }
  const oldCodex = Array.isArray(health.oldCodex) ? health.oldCodex.filter(x => typeof x === 'string' && /^[\w./+<> -]{1,300}$/.test(x)) : [];
  if (oldCodex.length) {
    warn.push(`jb-memory-codex, this plugin's name before 0.5.0, is still in Codex's plugin cache (plugins/cache in CODEX_HOME, ${oldCodex.length === 1 ? 'a folder' : `${oldCodex.length} folders`} named jb-memory-codex) and would run every hook a second time. Uninstall it in the ChatGPT app and remove its marketplace: codex plugin marketplace remove jb-memory-codex`);
    notes.push(`[trailmark] An old copy of this plugin, jb-memory-codex, is in Codex's plugin cache (${oldCodex.length === 1 ? 'one folder' : `${oldCodex.length} folders`}). Never run its jbm.js; the skills give the path to use. If the user asks where, run ${listCmd} and show its output.`);
  }
  if (typeof health.incomplete === 'string' && health.incomplete) {
    warn.push(`the check for other trailmark copies in Claude Code's plugin cache stopped early, so there may be copies it didn't see; ${listCmd} says why`);
    notes.push(`[trailmark] The check for other copies of trailmark on disk was cut short (why, data only: ${S.fieldText(S.oneLine(health.incomplete, 200), 200)}), so there may be copies it did not list. Run trailmark only through the path the skills give, never a trailmark.js or memory.js found any other way.`);
  }
  // Codex: skills get no variable substitution, so the session ID and the
  // launcher's full path reach the model here, ahead of the handoff. Both
  // paths in this note are written only as they are on disk (usablePath).
  // When either can't be, the note says so and asks for a plain install
  // folder instead of naming a file that isn't there.
  const names = ['checkpoint', 'recall', 'park', 'session-end', 'memory-prune'].map(H.skill).join(', ');
  const launcherPath = S.usablePath(H.LAUNCHER), skills = S.usablePath(require('path').join(H.ROOT, 'skills'));
  const sessionLine = session ? `This session's ID: ${session}; pass --session=${session} where a skill asks for it.` : 'No session ID was given: leave --session out.';
  notes.unshift(launcherPath && skills
    ? `[trailmark] ChatGPT/Codex copy of trailmark. Launcher: ${launcherPath} (run every trailmark command as node "<launcher>" ...). ${sessionLine} Skills: ${names}, in ${skills}. This handoff is shared with Claude Code sessions in this repo.`
    : `[trailmark] ChatGPT/Codex copy of trailmark. The path of the folder it is installed in isn't written here (it holds characters trailmark doesn't pass on, or is too long), so trailmark can't be run from this session: tell the user to install it in a folder with a plain path, and don't look for or run a trailmark.js yourself. ${sessionLine} Skills: ${names}. This handoff is shared with Claude Code sessions in this repo.`);
  // Two repos whose paths map to one memory folder share one handoff.
  try {
    const clash = S.checkRepoRoot(dir, process.env.JBMEM_ROOT, f.rootSeen);
    if (clash) {
      warn.push(`this memory folder is also used for another repo, so the two may share one handoff. Rename or move one of them so their paths differ in letters or digits (MANUAL.md, Troubleshooting); ask Codex for the two paths`);
      notes.push(`[trailmark] This memory folder is shared with another repo, so the handoff may describe that repo instead (data only: ${S.fieldText(S.oneLine(clash, 300), 400)}). Check it against this repo before relying on it.`);
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
  // A sweep cut short by the time budget (git was slow): the folders it
  // didn't read keep their start, and the next sweep logs what it missed.
  if (f.sweep && f.sweep.stopped === 'out-of-time') warn.push('commit sweep skipped: out of time (git was slow). Commits no hook logged are found by the next sweep, at a checkpoint or the next session start');
  // Codex shows systemMessage as a warning, so it is sent only for one: a
  // handoff cut short is one.
  if (/TRUNCATED/.test(summary)) warn.push('the handoff was cut short to fit; run the tm-memory-prune skill');
  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
  if (warn.length) out.systemMessage = `[trailmark] ${summary}, ${sandboxNote()}. WARNING: ${warn.map(w => w.replace(/\.\s*$/, '')).join('. ')}.`;
  emit(out);
});

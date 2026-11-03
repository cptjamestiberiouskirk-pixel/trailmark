#!/usr/bin/env node
// PostToolUse hook: log commits and PR merges, and remind Claude to checkpoint
// after likely milestones. A hook cannot make Claude write the handoff; it can
// only put a short reminder next to the tool result. Reminders are throttled
// per session and skipped when this session checkpointed in the last few
// minutes. Another session's checkpoint doesn't count: it didn't save this
// session's work.
//
// A commit is logged from the folder it ran in, which the launcher works out
// from the command text (lib/commands.js), starting from the folder the
// PreToolUse hook recorded (hook-commit-start.js), and reads from that
// folder's reflog (lib/gitfacts.js): `cd /e/other-clone && git commit` logs
// the commit made there, not the session folder's HEAD. A commit is logged
// once, whichever session or folder sees it again. One made outside the
// session's own folder is logged as COMMIT <sha> in="<folder>" <subject>, and
// this session's record keeps that folder, so the next checkpoint's Updated
// line shows its branch and HEAD. A commit whose folder can't be known is
// logged as COMMIT_UNRESOLVED why=<reason>, never as another folder's HEAD.
//
// Usage (from hooks.json, via trailmark.js --hook milestone): commit | pr-merge | subagent

'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./lib/store');

// The note keeps only the gh pr merge part of the command, and of that only
// the flag names, the PR number or URL and short plain words: notes are read
// back to the model later, and a command may carry a token anywhere
// (GH_TOKEN=... gh pr merge 5, a --body with a key in it). Every value after
// a flag, every quoted string and anything that looks like a key is replaced.
function mergeText(command) {
  const m = /\bgh\s+pr\s+merge\b[^|;&\n]*/.exec(String(command || ''));
  const seg = (m ? m[0] : 'gh pr merge').replace(/"(?:[^"\\]|\\.)*"?|'[^']*'?/g, ' <text> ');
  const out = [];
  let takesValue = false;
  for (const t of seg.split(/\s+/).filter(Boolean)) {
    if (/^-{1,2}[A-Za-z][\w-]*=/.test(t)) { out.push(t.split('=')[0] + '=<value>'); takesValue = false; continue; }
    if (/^-{1,2}[A-Za-z][\w-]*$/.test(t)) { out.push(t); takesValue = !/^--?(squash|merge|rebase|auto|admin|delete-branch|disable-auto|d|s|m|r)$/.test(t); continue; }
    if (takesValue) { out.push('<value>'); takesValue = false; continue; }
    if (t === '<text>' || /^(gh|pr|merge|\d{1,7}|#\d{1,7})$/.test(t)) { out.push(t); continue; }
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(t)) { out.push(t); continue; }
    if (/^[\w./-]{1,40}$/.test(t) && !/\d/.test(t)) { out.push(t); continue; }
    out.push('<value>');
  }
  return S.oneLine(out.join(' '), 100);
}
const { readPayload, memoryDirOrExit, emit, guard } = require('./lib/hookio');
const { isMilestoneCommand, commitSites } = require('./lib/commands');
const { commitFacts } = require('./lib/gitfacts');

const BG_NOTE = 'A commit command was sent to the background; its commits are logged by a later sweep once it finishes.';
const HINTS = {
  commit: 'Commit landed.',
  'pr-merge': 'PR merge command finished.',
  subagent: 'Subagent results came back.',
};

function unresolvedLine(u) {
  return `COMMIT_UNRESOLVED why=${u.why}${u.dir ? ` in="${u.dir}"` : ''}`;
}

// The launcher's end-folder check (trailmark.js): where the command, as read here,
// ended, against where Claude Code says it ended. A diagnostic only.
function endCheckLine(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const parsed = typeof raw.parsed === 'string' ? S.fieldText(raw.parsed) : '';
  const actual = typeof raw.actual === 'string' ? S.fieldText(raw.actual) : '';
  if (!parsed || !actual) return '';
  const tool = raw.tool === 'powershell' ? 'powershell' : 'bash';
  return `END_MISMATCH tool=${tool} parsed="${parsed}" actual="${actual}"${raw.atStart ? ' actual=start' : ''}${raw.atHome ? ' actual=home' : ''}`;
}

function failed(resp) {
  if (!resp || typeof resp !== 'object') return false;
  if (resp.interrupted) return true;
  if (typeof resp.exit_code === 'number' && resp.exit_code !== 0) return true;
  if (typeof resp.exitCode === 'number' && resp.exitCode !== 0) return true;
  return false;
}

guard(() => {
  const kind = process.argv[2];
  if (!HINTS[kind]) process.exit(0);
  const payload = readPayload();
  const command = (payload.tool_input && payload.tool_input.command) || '';

  // `if` in hooks.json pre-filters and the launcher checks first; check again
  // in case this script is started some other way.
  if (!isMilestoneCommand(kind, command)) process.exit(0);
  const { dir, cwd } = memoryDirOrExit(payload);
  const toolId = typeof payload.tool_use_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.tool_use_id) ? payload.tool_use_id : '';
  // Every way out of a commit run marks its PreToolUse record done, after
  // anything it logs: a commit sweep waits for a command until then. A
  // command sent to the background returns before it has run, so its record
  // stays open until its time is up.
  const background = !!(payload.tool_input && payload.tool_input.run_in_background === true);
  const leave = () => {
    if (kind === 'commit' && toolId && !background) {
      try { S.markCommitDone(dir, toolId); } catch (e) { if (e && e.code === 'ERR_ACCESS_DENIED') throw e; }
    }
    process.exit(0);
  };
  // PostToolUseFailure: Claude Code's event for a command that failed (a
  // non-zero exit, or interrupted). A commit it made before failing (git
  // commit && git push, the push failing) is still logged; no reminder.
  const afterFailure = payload.hook_event_name === 'PostToolUseFailure';
  if (kind !== 'subagent' && !afterFailure && failed(payload.tool_response)) leave();

  const session = S.cleanSession(payload.session_id);
  const cfg = S.loadConfig(dir);
  const now = Date.now();
  const handoff = path.join(dir, S.HANDOFF);

  let commits = { entries: [], unresolved: [] };
  let endLine = '';
  if (kind === 'commit') {
    let raw = null;
    if (process.env.JBMEM_GIT) {
      try { raw = JSON.parse(process.env.JBMEM_GIT).commit; } catch { raw = null; }
    }
    endLine = endCheckLine(raw && raw.endCheck);
    if (!raw && process.env.JBMEM_LAUNCHED !== '1') {
      // Run directly, not through trailmark.js: collect the facts here, from the
      // PreToolUse record when there is one.
      const shell = String(payload.tool_name || '').toLowerCase() === 'powershell' ? 'powershell' : 'bash';
      const start = S.readCommitStart(dir, payload.tool_use_id, session);
      raw = commitFacts(commitSites(command, { shell, cwd: start ? start.cwd : cwd, startKnown: !!start }), start ? start.cwd : cwd,
        { durationMs: payload.duration_ms, homeCwd: start ? start.cwd : cwd, procStart: performance.timeOrigin, startAt: start ? start.at : undefined });
    }
    commits = S.checkCommitFacts(raw);
    // Nothing new in any folder the command committed in, no commit whose
    // folder is unknown, and nothing to report: no log line and no reminder.
    // A command sent to the background has usually not run yet: Claude is
    // told once (bgNoted, kept apart from recentBg, which marks a run that
    // logged) where its commits will be logged.
    if (!commits.entries.length && !commits.unresolved.length && !endLine) {
      if (background && toolId && !afterFailure) {
        let first = false;
        try {
          S.updateState(dir, session, (state) => {
            const noted = Array.isArray(state.bgNoted) ? state.bgNoted.filter(x => typeof x === 'string').slice(-50) : [];
            if (!noted.includes(toolId)) { state.bgNoted = noted.concat(toolId); first = true; }
          });
        } catch (e) { if (e && e.code === 'ERR_ACCESS_DENIED') throw e; }
        if (first) emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[trailmark] ${BG_NOTE}` } });
      }
      leave();
    }
  }

  // Already logged: see store.knownCommits.
  const loggedSet = (state) => S.knownCommits(dir, state);
  const isLogged = (known, sha) => known.some(k => sha.startsWith(k));

  // One read-modify-write of the shared state under the lock: the check that
  // a commit wasn't logged already, the log lines, and the reminder throttle.
  // If another command holds the lock for more than 2 s, the log lines are
  // still written (checked against the log itself) and the reminder is
  // skipped: a hook that stalls the session is worse than either.
  let hint = false;
  const done = new Set();
  let unresolvedDone = false;
  let mergeDone = false;
  // Folders git timed out in: the commit there isn't logged yet. They join
  // this session's commit folders, so the next sweep reads them, and Claude
  // is told so even when no reminder is due.
  const slow = commits.unresolved.filter(u => u.why === 'git-timeout');
  let slowNote = false;
  const logNew = (known) => {
    const fresh = [];
    for (const e of commits.entries) {
      if (done.has(e.sha) || isLogged(known, e.sha)) continue;
      S.note(dir, S.commitLine(e), session);
      done.add(e.sha);
      known.push(e.sha);
      fresh.push(e);
    }
    if (!unresolvedDone) {
      for (const u of commits.unresolved) S.note(dir, unresolvedLine(u), session);
      unresolvedDone = true;
      slowNote = slow.length > 0;
    }
    return fresh;
  };
  // A command matching two of the `if` patterns runs this hook twice: the
  // second run finds the commits logged, and leaves the unresolved lines to
  // the first.
  try {
    hint = S.updateState(dir, session, (state, rec) => {
      if (kind === 'commit') {
        const tools = Array.isArray(state.recentTools) ? state.recentTools.filter(x => typeof x === 'string').slice(-50) : [];
        // A command sent to the background is kept apart (recentBg): the
        // sweep counts recentTools as finished, and this one isn't.
        const bgs = Array.isArray(state.recentBg) ? state.recentBg.filter(x => typeof x === 'string').slice(-50) : [];
        const again = toolId && (tools.includes(toolId) || bgs.includes(toolId));
        if (again) unresolvedDone = true;
        else if (toolId && background) state.recentBg = bgs.concat(toolId);
        else if (toolId) state.recentTools = tools.concat(toolId);
        if (endLine && !again) S.note(dir, endLine, session);
        const fresh = logNew(loggedSet(state));
        if (fresh.length) {
          S.rememberCommits(state, fresh.map(e => e.sha));
          const last = fresh[fresh.length - 1];
          state.lastCommit = last.short; // what 0.3.2 reads, kept for a downgrade
          if (rec) {
            rec.commitDir = last.folder.dir;
            rec.commitAt = now;
            // Every folder this session committed in, for the commit sweep.
            const dirs = Array.isArray(rec.commitDirs) ? rec.commitDirs.filter(d => typeof d === 'string' && path.isAbsolute(d)) : [];
            for (const e of fresh) if (!dirs.includes(e.folder.dir)) dirs.push(e.folder.dir);
            rec.commitDirs = dirs.slice(-6);
          }
        }
        if (rec && slowNote) {
          const dirs = Array.isArray(rec.commitDirs) ? rec.commitDirs.filter(d => typeof d === 'string' && path.isAbsolute(d)) : [];
          for (const u of slow) if (u.folder && !dirs.includes(u.folder)) dirs.push(u.folder);
          rec.commitDirs = dirs.slice(-6);
        }
        if (!fresh.length && !commits.unresolved.length) return false; // nothing new was committed
      } else if (kind === 'pr-merge') {
        S.note(dir, `PR_MERGE ${mergeText(command)}`, session);
        mergeDone = true;
      }
      if (afterFailure) return false; // no reminder, so none is counted
      const lastWrite = rec ? rec.lastWrite : (S.plainExists(handoff) ? S.plainStat(handoff).mtimeMs : 0);
      const fresh = lastWrite && now - lastWrite < cfg.hints.freshCheckpointMinutes * 60000;
      const lastHint = rec ? rec.lastHintAt : state.lastHintAt;
      const recent = lastHint && now - lastHint < cfg.hints.minMinutesBetween * 60000;
      if (fresh || recent) return false;
      if (rec) rec.lastHintAt = now; else state.lastHintAt = now;
      return true;
    });
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') throw e;
    try {
      if (kind === 'commit') {
        let st = {};
        try { st = S.readState(dir); } catch { st = {}; }
        logNew(loggedSet(st));
      } else if (kind === 'pr-merge' && !mergeDone) {
        S.note(dir, `PR_MERGE ${mergeText(command)}`, session);
      }
    } catch (e2) { if (e2 && e2.code === 'ERR_ACCESS_DENIED') throw e2; }
    leave();
  }
  const slowText = slowNote
    ? `[trailmark] A commit was not logged yet: git was too slow (it timed out) in ${slow.map(u => `"${u.dir || 'the folder'}"`).join(', ')}. The next commit sweep logs it, at a checkpoint or the next session start.`
    : '';
  if (afterFailure || (!hint && !slowText)) leave();
  const hintText = hint
    ? `[trailmark] ${kind === 'commit' && background ? BG_NOTE : HINTS[kind]} If this completes a milestone (deliverable produced or updated, decision landed, correction accepted, results that change the plan), run the ${S.CHECKPOINT_SKILL} skill before moving on. Skip it if nothing material changed. ${S.SKILL_RULE}`
    : '';
  emit({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [slowText, hintText].filter(Boolean).join(' '),
    },
  });
  leave();
});

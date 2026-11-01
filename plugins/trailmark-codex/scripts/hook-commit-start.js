#!/usr/bin/env node
// PreToolUse hook for git commit commands: records the folder the command
// starts in, for the PostToolUse commit hook.
//
// Claude Code runs each Bash command as `... && eval <command> && pwd -P >| <file>`
// and can move the session's working folder to where the command ended, so
// PostToolUse's cwd may be that folder (`cd sub && git commit` would then read
// as starting in sub), or the start folder (Claude Code 2.1.304's Bash tool,
// seen on Windows). PreToolUse's cwd is the folder the command starts in. The
// two hooks share the tool call's ID.
//
// The record also keeps the folders the command's commits go to, as read
// now, so another session's commit hook can tell whether the two commit in
// the same folder at once (gitfacts.commitFacts).
//
// It never prints anything and never blocks the command: every failure
// exits 0, and the PostToolUse hook then works without the record.
//
// Usage (from hooks.json, via trailmark.js --hook commit-start)

'use strict';

const path = require('path');
const S = require('./lib/store');
const { readPayload, memoryDirOrExit, guard } = require('./lib/hookio');
const { isMilestoneCommand, commitSites } = require('./lib/commands');

guard(() => {
  const payload = readPayload();
  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!isMilestoneCommand('commit', command)) process.exit(0);
  // Codex: the folder the command runs in (tool_input.workdir, see trailmark.js)
  // when it isn't the session's.
  const cwd = typeof payload.codex_workdir === 'string' && path.isAbsolute(payload.codex_workdir) ? payload.codex_workdir : payload.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) process.exit(0);
  const { dir } = memoryDirOrExit(payload);
  const at = Date.now();
  // A short time limit: the command waits for this hook. Not read in time,
  // any commit whose folder isn't known, or a folder too long to keep: no
  // sites, and the start folder stands in.
  let sites;
  try {
    const shell = String(payload.tool_name || '').toLowerCase() === 'powershell' ? 'powershell' : 'bash';
    const found = commitSites(command, { shell, cwd, startKnown: true, deadlineMs: 300 });
    const list = [...new Set(found.sites)];
    if (!found.unresolved.length && list.length <= 4 && list.every(d => d.length <= 1024)) sites = list;
  } catch { sites = undefined; }
  const rec = { cwd, at, session: S.cleanSession(payload.session_id) };
  // A subagent's tool calls carry its agent_id: its commit commands can run
  // alongside the main thread's and other subagents', so the sweep tells
  // them apart (store.js, openCommitStart).
  const agent = S.cleanAgent(payload.agent_id);
  if (agent) rec.agent = agent;
  // Codex gives no subagent ID (store.js, openCommitStart); a command sent to
  // the background is still running after its hook.
  rec.host = 'codex';
  if (payload.tool_input && payload.tool_input.run_in_background === true) rec.bg = true;
  // The PostToolUse hook reads a record of up to 8 KB; the sites must not
  // push this one past that.
  if (sites && Buffer.byteLength(JSON.stringify({ ...rec, sites }), 'utf8') <= 6000) rec.sites = sites;
  S.recordCommitStart(dir, payload.tool_use_id, rec);
});

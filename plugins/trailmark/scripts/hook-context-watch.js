#!/usr/bin/env node
// PostToolUse and UserPromptSubmit hook: ask Claude to run the checkpoint
// skill before Claude Code's auto-compaction summarizes the session, so its
// decisions, corrections and next steps are in handoff.md first.
//
// The launcher (trailmark.js) reads the session's context size from its
// transcript, works out the auto-compact window, and starts this script only
// once the size could be past a step; it passes the numbers in JBMEM_GIT
// (context). This script reads .jbmem.json, decides, and keeps its state in
// this session's record of .jbmem-state.json, under the lock:
//   - Steps are percentages of the compaction point (the window less the
//     reserve, or the percentage override), never of the window: Claude Code
//     compacts a fixed amount below it.
//   - It asks at the first step it reaches, and again at a later step only
//     while this session has not written the handoff since the first request
//     (rec.lastWrite, as the milestone hints use it).
//   - It starts over after a compaction, or when the context has shrunk by a
//     fifth from the last size seen, or fell below 75% of the compaction point
//     (the launcher reads that from the transcript since the last request).
//     Between 75% and the first step nothing changes, so a large tool result
//     that lifts the estimate over a step and drops back asks only once.
//   - A request ignores hints.minMinutesBetween (it is the last chance before
//     the compaction) and sets lastHintAt, so milestone hints don't follow it
//     straight away.
// Normally started by trailmark.js under the sandbox.

'use strict';

const S = require('./lib/store');
const { compactPoint } = require('./lib/contextwatch');
const { readPayload, memoryDirOrExit, emit, guard } = require('./lib/hookio');

const SHRINK = 0.8;
const FORGET_BELOW = 0.75;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = v => (Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : NaN);
// A time in ms since 1970, or 0.
const when = v => (Number.isFinite(v) && v > 0 && v < 1e14 ? v : 0);

// The launcher's numbers, checked: anything else ends the hook silently.
function contextFacts() {
  let c;
  try { c = JSON.parse(process.env.JBMEM_GIT || '').context; } catch { return null; }
  if (!isObj(c)) return null;
  const out = { tokens: count(c.tokens), base: count(c.base), win: count(c.win), pct: Number.isFinite(c.pct) && c.pct >= 0 && c.pct <= 100 ? c.pct : 0 };
  if (!(out.tokens > 0) || !(out.base > 0) || !(out.win >= 100000) || out.win > 1000000) return null;
  const s = isObj(c.since) ? c.since : null;
  out.since = s ? { min: count(s.min), boundary: s.boundary === true, reached: s.reached === true } : null;
  return out;
}

// The new state for this session's record and whether to ask. Pure: run once
// on a plain read (most runs change nothing and write nothing), then again
// under the lock.
function decide(prev, rec, ctx, cfg, now) {
  let w = isObj(prev) ? { ...prev } : {};
  const point = compactPoint(ctx.win, cfg.reserve, ctx.pct);
  const level = cfg.steps.filter(s => ctx.tokens >= point * s / 100).length;
  const seen = count(w.seen);
  // Start over: a compaction since the last request, a shrink, a fall below
  // 75% of the compaction point, or a transcript that couldn't be read back
  // that far (asking once more is the safe side).
  if (w.level) {
    const s = ctx.since;
    const low = Math.min(ctx.base, s && Number.isFinite(s.min) ? s.min : Infinity);
    if (!s || s.boundary || !s.reached || (seen > 0 && low < seen * SHRINK) || low < point * FORGET_BELOW) w = {};
  }
  const firstAt = when(w.firstAt);
  if (w.level && !w.done && firstAt > 0 && when(rec && rec.lastWrite) > firstAt) w.done = true;
  if (!level || w.done || level <= (count(w.level) || 0)) {
    return { w, ask: null, point, changed: JSON.stringify(w) !== JSON.stringify(isObj(prev) ? prev : {}) };
  }
  const repeat = count(w.level) > 0;
  return { w: { level, firstAt: firstAt > 0 ? firstAt : now, seen: ctx.base, seenAt: now }, ask: { repeat, level }, point, changed: true };
}

const k = n => `${Math.round(n / 1000)}k`;

function main() {
  const payload = readPayload();
  const event = payload.hook_event_name === 'UserPromptSubmit' ? 'UserPromptSubmit' : 'PostToolUse';
  if (payload.agent_id || payload.agent_type) return;
  const session = S.cleanSession(payload.session_id);
  if (!session) return;
  const ctx = contextFacts();
  if (!ctx) return;
  const { dir } = memoryDirOrExit(payload);
  const cfg = S.loadConfig(dir).contextWatch;
  if (!cfg.on) return;
  const now = Date.now();
  const rec0 = S.sessionRecord(dir, session);
  const first = decide(rec0 && rec0.contextWatch, rec0, ctx, cfg, now);
  if (!first.changed) return;
  let out = null;
  try {
    out = S.updateState(dir, session, (state, rec) => {
      const d = decide(rec.contextWatch, rec, ctx, cfg, now);
      rec.contextWatch = d.w;
      if (d.ask) rec.lastHintAt = now;
      return d;
    });
  } catch (e) {
    if (e && e.code === 'ERR_ACCESS_DENIED') throw e;
    return; // busy or unreadable state: no request, so none is counted
  }
  if (!out || !out.ask) return;
  const again = out.ask.repeat ? ' This session has not written the handoff since the first request.' : '';
  emit({
    systemMessage: `[trailmark] Context about ${k(ctx.tokens)} tokens, auto-compaction near ${k(out.point)}: asked Claude to checkpoint first.`,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `[trailmark] This session's context is about ${k(ctx.tokens)} tokens, and Claude Code auto-compacts it at about ${k(out.point)}.${again} Run the ${S.CHECKPOINT_SKILL} skill now, so this session's decisions, corrections and next steps are in the handoff before the compaction summarizes them. A step that is about to finish may finish first, but start no long operation before the checkpoint. ${S.SKILL_RULE}`,
    },
  });
}

if (require.main === module) guard(main);

module.exports = { decide };

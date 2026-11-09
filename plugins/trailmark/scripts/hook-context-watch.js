#!/usr/bin/env node
// PostToolUse and UserPromptSubmit hook: ask Claude to run the checkpoint
// skill before Claude Code's auto-compaction summarizes the session, so its
// decisions and next steps are in handoff.md first.
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
//     (the launcher reads that from the transcript since the last request),
//     or when the compaction point grew past the biggest one it asked under,
//     since the steps it passed were a smaller point's. A point that shrinks
//     keeps the state: its steps come sooner. Keeping the biggest point means
//     a window that flips back and forth starts the steps over only once.
//     Between 75% and the first step nothing changes, so a large tool result
//     that lifts the estimate over a step and drops back asks only once.
//   - An ask made while the transcript's own size (before the estimate for
//     what came after it) is under the first step came from the estimate,
//     and is kept until the transcript itself reaches that step: the 75%
//     rule above doesn't clear it (a compaction or a shrink still does), so
//     an estimate that runs high can't ask again and again. At the first
//     step the steps start over if the handoff was written since that ask,
//     so the request that ends them is made from the real size; otherwise
//     Claude is still on it and the state carries on from there.
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
  out.seenAt = when(c.seenAt);
  return out;
}

// The new state for this session's record and whether to ask. Pure: run once
// on a plain read (most runs change nothing and write nothing), then again
// under the lock.
function decide(prev, rec, ctx, cfg, now) {
  let w = isObj(prev) ? { ...prev } : {};
  const point = compactPoint(ctx.win, cfg.reserve, ctx.pct);
  const line = point * FORGET_BELOW;
  const first = cfg.steps.length ? point * Math.min(...cfg.steps) / 100 : Infinity;
  const level = cfg.steps.filter(s => ctx.tokens >= point * s / 100).length;
  const seen = count(w.seen);
  const pt = Math.round(point);
  // Start over: a compaction since the last request, a shrink, a fall below
  // 75% of the compaction point, a compaction point bigger than any asked
  // under, or a transcript that couldn't be read back that far (asking once
  // more is the safe side).
  // The launcher passes `since` only when the record it read had a seenAt, so
  // a state that has one with no `since` here was saved after that read: two
  // hooks ran at once (parallel tool calls) and the other one asked. Its state
  // stands, or the same first request would go out twice (RS:638). A saved
  // seenAt newer than the one the launcher read says the same when there is a
  // `since`: it was measured from that older point (RS-H-samesince).
  const crossed = ctx.since ? ctx.seenAt > 0 && when(w.seenAt) > ctx.seenAt : when(w.seenAt) > 0;
  // `now` was read before the lock, so a hook behind a sibling can hold an
  // older clock than the saved state. What it saves still has to be newer, or
  // a third hook that read the sibling's seenAt couldn't tell it was crossed.
  const stamp = crossed ? Math.max(now, when(w.seenAt) + 1) : now;
  // A bigger point is measured against the saved one, not against what the
  // launcher read, so it holds whichever hook saved first.
  if (w.level && pt > count(w.point)) w = {};
  else if (w.level && !crossed) {
    const s = ctx.since;
    const low = Math.min(ctx.base, s && Number.isFinite(s.min) ? s.min : Infinity);
    if (!s || s.boundary || !s.reached || (seen > 0 && low < seen * SHRINK)) w = {};
    else if (seen > 0 && seen < first) {
      // Asked from an estimate: kept until the transcript reaches the first
      // step; there, start over if the handoff was written since, else carry
      // on from here (seenAt too, so the launcher reads on from now).
      if (ctx.base >= first) w = when(rec && rec.lastWrite) > when(w.firstAt) ? {} : { ...w, seen: ctx.base, seenAt: now };
    } else if (low < line) w = {};
  }
  const firstAt = when(w.firstAt);
  if (w.level && !w.done && firstAt > 0 && when(rec && rec.lastWrite) > firstAt) w.done = true;
  if (!level || w.done || level <= (count(w.level) || 0)) {
    return { w, ask: null, point, changed: JSON.stringify(w) !== JSON.stringify(isObj(prev) ? prev : {}) };
  }
  const repeat = count(w.level) > 0;
  // The biggest point asked under: a smaller one kept here would let the next
  // flip back to the bigger window start the steps over again.
  const keep = Math.max(pt, count(w.point) || 0);
  return { w: { level, firstAt: firstAt > 0 ? firstAt : now, seen: ctx.base, seenAt: stamp, point: keep }, ask: { repeat, level }, point, changed: true };
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
      additionalContext: `[trailmark] This session's context is about ${k(ctx.tokens)} tokens, and Claude Code auto-compacts it at about ${k(out.point)}.${again} Run the ${S.CHECKPOINT_SKILL} skill now, so this session's decisions and next steps are in the handoff before the compaction summarizes them. A step that is about to finish may finish first, but start no long operation before the checkpoint. ${S.SKILL_RULE}`,
    },
  });
}

if (require.main === module) guard(main);

module.exports = { decide, contextFacts };

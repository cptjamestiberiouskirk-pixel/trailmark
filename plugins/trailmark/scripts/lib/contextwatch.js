// The context watch, launcher side: how big this session's context is and
// where Claude Code will auto-compact it. Read before the sandbox starts,
// since a worktree session's transcript sits in another projects folder than
// the repo's memory folder. Everything here only reads, and everything read
// from the transcript or a settings file is data: only numbers and a model
// name of plain characters come out.
//
// Facts this rests on (Claude Code docs, code.claude.com/docs/en/model-config
// and env-vars, read 2026-11-04; and transcripts measured 2026-11-04):
//   - The window: CLAUDE_CODE_AUTO_COMPACT_WINDOW wins over the settings
//     (documented). In a settings file, modelSettings.<model>.autoCompactWindow
//     takes precedence over the top-level autoCompactWindow (documented); a
//     later file (user, project, local) wins over an earlier one (INFERRED from
//     how settings merge). 100k to 1M; "auto" means the model's own window.
//   - Default: the model's context limit; about 967k for a native 1M model,
//     200k for one Claude Code doesn't recognize; capped at the model's
//     context window (documented).
//   - Compaction comes a fixed amount below the window, not at a share of it:
//     compact_boundary entries showed 366,627 and 367,295 tokens with a 400k
//     window and 967k to 968k with 1M, so about 33k below (CONFIRMED in
//     transcripts; the amount itself is not documented).
//   - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: the percentage (1 to 100) of the window
//     at which compaction triggers; it can only lower the point (documented).

'use strict';

const fs = require('fs');
const path = require('path');
const { samePath, projectsRoot, configDir } = require('./paths');
const { localPath } = require('./gitbin');
const { openPlain } = require('./plainfile');

const ENV_WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const ENV_PCT = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const MIN_WINDOW = 100000;
const MAX_WINDOW = 1000000;
// How much of the transcript's end is read, in turn, to find the last request.
const TAIL_SIZES = [1 << 20, 8 << 20, 32 << 20];
const SETTINGS_MAX = 1 << 20;

// The steps and reserve the sandboxed hook may be configured with
// (store.js CONFIG_RANGES.contextWatch): the launcher leaves before any
// memory-folder lookup only below the earliest step any configuration allows.
const LOWEST_STEP = 80;
const MAX_RESERVE = 50000;

// Model families whose own window is 1M (docs, "default auto-compact
// thresholds": Fable, Sonnet 5 and later, Haiku 5.5, Opus 4.7 and later).
function nativeMillion(model) {
  const m = canonical(model);
  if (/^claude-fable\b/.test(m)) return true;
  let r = /^claude-(sonnet|haiku|opus)-(\d+)(?:-(\d+))?/.exec(m);
  if (!r) return false;
  const v = Number(r[2]) + (r[3] && r[3].length <= 2 ? Number(r[3]) / 10 : 0);
  if (r[1] === 'sonnet') return v >= 5;
  if (r[1] === 'haiku') return v >= 5.5;
  return v >= 4.7;
}

// Model names as settings keys match them: lower case, no [1m] suffix, no date.
function canonical(model) {
  return String(model || '').toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

// The model's own context window, as far as known.
function modelWindow(model, env = process.env) {
  if (/\[1m\]$/i.test(String(model || ''))) return MAX_WINDOW;
  if (String(env.CLAUDE_CODE_DISABLE_1M_CONTEXT || '') === '1') return 200000;
  return nativeMillion(model) ? MAX_WINDOW : 200000;
}

// A window as Claude Code takes it: 400000, "400000", "400k", "1m", or a bare
// 100 to 1000 meaning thousands; clamped to 100k..1M. "auto" and anything else
// give null.
function parseWindow(v, { env = false } = {}) {
  let n = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(v);
    if (m) n = Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1);
  } else return null;
  if (n === null || !(n > 0)) return null;
  // The settings and /autocompact read 100 to 1000 as thousands; the variable
  // reads a bare number as tokens (docs).
  if (!env && n >= 100 && n <= 1000) n *= 1000;
  return Math.round(Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, n)));
}

// A settings file: a plain local file of at most 1 MB, parsed as JSON.
function readSettings(file) {
  let fd;
  try {
    fd = openPlain(file);
    const size = fs.fstatSync(fd).size;
    if (size > SETTINGS_MAX) return null;
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    const v = JSON.parse(buf.slice(0, n).toString('utf8').replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function settingsFiles(configDir, projectDir) {
  const files = [path.join(configDir, 'settings.json')];
  if (projectDir && path.isAbsolute(projectDir) && localPath(projectDir)) {
    files.push(path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json'));
  }
  return files;
}

// The auto-compact window for this model and where it came from: env,
// settings env (a settings file's env block, in case the hook doesn't inherit
// it), settings, or model (the model's own window). uncapped: the window
// without the cap from the model's name (see fastPath).
function windowFor(model, { configDir, projectDir, env = process.env } = {}) {
  const cap = modelWindow(model, env);
  const capped = (w, source) => ({ win: Math.min(w, cap), source, uncapped: w });
  const fromEnv = parseWindow(env[ENV_WINDOW], { env: true });
  if (fromEnv) return capped(fromEnv, 'env');
  const want = canonical(model);
  let win = null;
  let envBlock = null;
  for (const f of settingsFiles(configDir, projectDir)) {
    const s = readSettings(f);
    if (!s) continue;
    if (s.env && typeof s.env === 'object' && Object.prototype.hasOwnProperty.call(s.env, ENV_WINDOW)) envBlock = parseWindow(s.env[ENV_WINDOW], { env: true });
    let v;
    const ms = s.modelSettings && typeof s.modelSettings === 'object' && !Array.isArray(s.modelSettings) ? s.modelSettings : {};
    for (const k of Object.keys(ms).slice(0, 200)) {
      const e = ms[k];
      if (want && canonical(k) === want && e && typeof e === 'object' && Object.prototype.hasOwnProperty.call(e, 'autoCompactWindow')) v = e.autoCompactWindow;
    }
    if (v === undefined && Object.prototype.hasOwnProperty.call(s, 'autoCompactWindow')) v = s.autoCompactWindow;
    // "auto" (or anything not a size) in a later file sets the model's own window back.
    if (v !== undefined) win = parseWindow(v);
  }
  if (envBlock) return capped(envBlock, 'settings env');
  if (win) return capped(win, 'settings');
  return { win: cap, source: 'model', uncapped: MAX_WINDOW };
}

// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE as a whole percentage 1..100, or 0 when unset.
function pctOverride(env = process.env) {
  const v = String(env[ENV_PCT] || '').trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(v)) return 0;
  const n = Number(v);
  return n >= 1 && n <= 100 ? n : 0;
}

// Where Claude Code compacts: the reserve below the window, or the percentage
// override when that comes earlier.
function compactPoint(win, reserve, pct) {
  const p = win - reserve;
  return pct ? Math.min(p, Math.floor(win * pct / 100)) : p;
}

// A transcript path the launcher may read: a .jsonl file directly in a folder
// of Claude Code's projects folder, on a local path. '' for anything else.
function transcriptFile(tp, projectsRoot) {
  if (typeof tp !== 'string' || !tp.endsWith('.jsonl') || /^(\\\\|\/\/)/.test(tp) || !path.isAbsolute(tp)) return '';
  const f = path.resolve(tp);
  if (!samePath(path.dirname(path.dirname(f)), path.resolve(projectsRoot))) return '';
  return localPath(f) ? f : '';
}

function usageOf(o) {
  if (!o || o.type !== 'assistant' || o.isSidechain) return null;
  const m = o.message;
  if (!m || typeof m !== 'object') return null;
  const u = m.usage;
  if (!u || typeof u !== 'object' || m.model === '<synthetic>') return null;
  const num = x => (Number.isFinite(x) && x > 0 ? x : 0);
  const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
  if (!(tokens > 0)) return null;
  const model = typeof m.model === 'string' && /^[\w.\-[\]]{1,80}$/.test(m.model) ? m.model : '';
  return { tokens: Math.round(tokens), model };
}

// Read from the end of the transcript. Without `since`: the last main-thread
// request's context size and model, or null when a compaction came after it
// (after /compact the next prompt comes before the next request, and the size
// from before the compaction says nothing about the context now). With
// `since` (ms): also the smallest size and any compaction after that time,
// and whether the read got back that far; read back to `since` with no
// request after it, `min` is null. null when no usable entry was found, or
// with `since` when the read didn't get back to it.
function readUsage(file, { since = 0 } = {}) {
  let fd;
  let last = null;
  let min = Infinity;
  let boundary = false;
  let reached = !since;
  try {
    fd = openPlain(file);
    const size = fs.fstatSync(fd).size;
    for (const want of TAIL_SIZES) {
      const len = Math.min(want, size);
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.slice(0, got).toString('utf8').split('\n');
      if (len < size) lines.shift(); // cut off by the read
      last = null; min = Infinity; boundary = false; reached = !since;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        // Quotes inside JSON strings are escaped, so these match only real fields.
        const isAsst = line.includes('"type":"assistant"') && line.includes('"usage"');
        const isBoundary = line.includes('"compact_boundary"');
        if (!isAsst && !isBoundary) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (!o || typeof o !== 'object') continue;
        const at = since ? Date.parse(o.timestamp) : NaN;
        if (since && Number.isFinite(at) && at <= since) { reached = true; break; }
        if (isBoundary && o.type === 'system' && o.subtype === 'compact_boundary' && !o.isSidechain) {
          // Without `since` the read stops at the last request, so this
          // compaction came after it.
          if (!since) return null;
          boundary = true;
          continue;
        }
        const u = usageOf(o);
        if (!u) continue;
        if (!last) { last = u; if (!since) break; }
        if (u.tokens < min) min = u.tokens;
      }
      if ((reached && (last || since)) || len >= size) break;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  if (!since) return last;
  // Read back to `since` with no request after it (a parallel tool call's
  // sibling, say): reached, with no size of its own.
  if (!last) return reached ? { min: null, boundary, reached } : null;
  return { ...last, min: Number.isFinite(min) ? min : last.tokens, boundary, reached };
}

// What one tool result or prompt adds. A tool's result in the payload can
// hold far more than the model is given: an image's base64 (229k characters
// for a 1093x1351 JPEG in a transcript seen 2026-11-05, where the model gets
// about 2k tokens), or an Edit's whole file. Claude Code itself refuses a
// Read past 25,000 tokens and cuts MCP output there (MAX_MCP_OUTPUT_TOKENS)
// and Bash output at 30,000 characters (docs), so one call counts for at
// most MAX_EXTRA. A prompt has no such limit and counts in full, up to the
// largest window.
const MAX_EXTRA = 25000;
// An image costs ceil(width / 28) x ceil(height / 28) tokens, at most 1,568
// on the standard tier and 4,784 on the high-resolution tier of Claude 4.7
// and later (Claude's vision docs, read 2026-11-05); the most is counted,
// and hook-context-watch.js keeps a high count from asking on every call.
// An image is base64 under "base64" or "data" in an object whose type,
// media_type or mimeType is image/...: a Read's result ({ file: { base64,
// type } }), an API content block's source, MCP output.
const IMAGE_TOKENS = 4784;
const BASE64_MIN = 1000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const isImage = o => ['type', 'media_type', 'mimeType', 'mime_type'].some(k => typeof o[k] === 'string' && /^image\//i.test(o[k]));

// About four characters a token for text and keys, an image's worth for each
// image, and at most cap in all.
function extraTokens(v, cap = MAX_EXTRA) {
  let chars = 0;
  let images = 0;
  let over = false;
  const walk = (x, depth) => {
    if (over) return;
    if (depth > 64 || chars > 4 * cap) { over = true; return; }
    if (typeof x === 'string') chars += x.length;
    else if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
    } else if (x && typeof x === 'object') {
      const img = isImage(x);
      for (const k of Object.keys(x)) {
        chars += k.length;
        const y = x[k];
        if (img && (k === 'base64' || k === 'data') && typeof y === 'string' && y.length >= BASE64_MIN && BASE64_RE.test(y)) images++;
        else walk(y, depth + 1);
      }
    } else if (typeof x === 'number' || typeof x === 'boolean') chars += String(x).length;
  };
  walk(v, 0);
  if (over) return cap;
  return Math.min(cap, Math.round(chars / 4) + images * IMAGE_TOKENS);
}

// The launcher's first step for this hook, run before it loads anything
// else: reads the payload, and exits 0 (silent) unless this is a main-thread
// tool call or prompt whose context could be past the earliest step any
// configuration allows. Returns what the rest of the launcher needs.
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fastPath() {
  let raw;
  try { raw = fs.readFileSync(0); } catch { process.exit(0); }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8').replace(/^﻿/, '') || '{}'); } catch { process.exit(0); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) process.exit(0);
  const event = payload.hook_event_name;
  if (event !== 'PostToolUse' && event !== 'UserPromptSubmit') process.exit(0);
  if (payload.agent_id || payload.agent_type) process.exit(0); // a subagent's call
  if (typeof payload.session_id !== 'string' || !SESSION_RE.test(payload.session_id)) process.exit(0);
  const tp = transcriptFile(payload.transcript_path, projectsRoot());
  if (!tp) process.exit(0);
  const last = readUsage(tp);
  if (!last) process.exit(0);
  // The last usage entry predates the tool's result or the new prompt.
  const tokens = last.tokens + (event === 'PostToolUse' ? extraTokens(payload.tool_response) : extraTokens(payload.prompt, MAX_WINDOW));
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR && path.isAbsolute(process.env.CLAUDE_PROJECT_DIR) ? process.env.CLAUDE_PROJECT_DIR : cwd;
  let { win, uncapped } = windowFor(last.model, { configDir: configDir(), projectDir });
  // The model's own window is guessed from its name, which doesn't show a 1M
  // context chosen with [1m] (transcripts don't carry the suffix). A request
  // bigger than the window proves the window is bigger: then the cap goes.
  if (last.tokens > win && uncapped > win) win = uncapped;
  const pct = pctOverride();
  if (tokens < compactPoint(win, MAX_RESERVE, pct) * LOWEST_STEP / 100) process.exit(0);
  return { raw, payload, tp, cwd, context: { tokens, base: last.tokens, win, pct } };
}

module.exports = {
  fastPath,
  ENV_WINDOW, ENV_PCT, LOWEST_STEP, MAX_RESERVE, MIN_WINDOW, MAX_WINDOW,
  canonical, nativeMillion, modelWindow, parseWindow, windowFor, pctOverride, compactPoint,
  transcriptFile, readUsage, extraTokens, MAX_EXTRA, IMAGE_TOKENS,
};

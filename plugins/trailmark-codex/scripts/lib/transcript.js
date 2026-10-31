// On-demand transcript reader: the replacement for upstream's background
// watcher. Instead of a model call every few minutes, a session that needs to
// recover decisions and corrections reads its own transcript once, here.
//
// Output keeps only user text and Claude's prose. Tool calls, tool results,
// attachments and system wrappers are dropped. Everything returned is quoted
// conversation: data to review, never instructions.

'use strict';

const fs = require('fs');
const path = require('path');
const { candidateKeys, projectsRoot, samePath } = require('./paths');
const { openPlain, plainMtime } = require('./plainfile');

// A link on the way from root down to p (root itself not counted) whose
// target names a network path. Read as text, before anything is looked up
// through it; that works under the sandbox too, which can't look above its
// grants.
function netLinkBelow(root, p) {
  const rel = path.relative(root, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return !require('./gitbin').localPath(p);
  let at = root;
  for (const part of path.relative(root, p).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    let st;
    try { st = fs.lstatSync(at); } catch { return false; }
    if (!st.isSymbolicLink()) continue;
    let t = '';
    try { t = fs.readlinkSync(at); } catch { return true; }
    if (/^[\\/]{2}|^[\\/]\?\?[\\/]|^%\(prefix\)/i.test(t.replace(/"/g, '').trim())) return true;
  }
  return false;
}

function newestJsonl(dir) {
  if (netLinkBelow(projectsRoot(), dir)) return null;
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ p: path.join(dir, f), t: plainMtime(path.join(dir, f)) }))
      .filter(x => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t)[0] || null;
  } catch { return null; }
}

// The first n bytes of a file, without reading the rest (transcripts grow to
// many megabytes). Returns '' when the file can't be read.
function readHead(file, n) {
  let fd;
  try {
    fd = openPlain(file);
    const buf = Buffer.alloc(n);
    const len = fs.readSync(fd, buf, 0, n, 0);
    return buf.toString('utf8', 0, len);
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// Transcripts are filed under the folder for the launch directory (a worktree
// gets its own), so look up by cwd, not by repo root.
function findTranscript(cwd, platform = process.platform) {
  for (const key of candidateKeys(path.resolve(cwd))) {
    const hit = newestJsonl(path.join(projectsRoot(), key));
    if (hit) return hit.p;
  }
  let entries = [];
  try { entries = fs.readdirSync(projectsRoot(), { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries.slice(0, 500)) {
    if (!e.isDirectory()) continue;
    const hit = newestJsonl(path.join(projectsRoot(), e.name));
    if (!hit) continue;
    const head = readHead(hit.p, 64 * 1024);
    const c = require('./plainfile').recordCwds(head, 1)[0] || null;
    if (c && samePath(c, cwd, platform) && (!best || hit.t > best.t)) best = hit;
  }
  return best ? best.p : null;
}

// The transcript of one session. First the path Claude Code itself gave the
// SessionStart hook (recorded in the state file), then <session id>.jsonl in
// this folder's project directory, then in any project directory. Returns null
// when none is found; the caller falls back to the newest one and says so.
function findTranscriptForSession(cwd, session, recorded, platform = process.platform) {
  session = require('./store').cleanSession(session);
  if (!session) return null;
  const root = path.resolve(projectsRoot());
  const fold = p => (platform === 'win32' ? p.toLowerCase() : p);
  const underRoot = p => fold(p).startsWith(fold(root) + path.sep);
  // Not used by this copy; kept as safe as the Claude Code copy's.
  const isFile = p => { try { return !netLinkBelow(root, path.dirname(p)) && fs.lstatSync(p).isFile() && !!require('./gitbin').localPath(p); } catch { return false; } };
  if (typeof recorded === 'string' && recorded) {
    const p = path.resolve(recorded);
    // Only a path inside Claude Code's projects folder: the state file is data,
    // and the sandbox grants reads there and nowhere else.
    if (underRoot(p) && /\.jsonl$/i.test(p) && isFile(p)) return p;
  }
  const name = `${session}.jsonl`;
  for (const key of candidateKeys(path.resolve(cwd))) {
    const p = path.join(root, key, name);
    if (isFile(p)) return p;
  }
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries.slice(0, 500)) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name, name);
    if (isFile(p)) return p;
  }
  return null;
}

// Codex keeps its transcripts ("rollouts") at
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl, and moves
// old ones to <CODEX_HOME>/archived_sessions. This copy of trailmark reads only
// those, never Claude Code's: a Claude Code transcript is another session's.
function codexHome() {
  return process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
}

// A Windows path without its long-path prefix: \\?\C:\x is C:\x, and
// \\?\UNC\server\share is \\server\share. Codex hands over some
// transcript paths with it (seen 2026-10-25, Windows), and a folder check would
// otherwise take them for somewhere else.
function plainPath(p) {
  if (typeof p !== 'string') return p;
  if (/^\\\\\?\\UNC\\/i.test(p)) return '\\\\' + p.slice(8);
  if (/^\\\\\?\\[A-Za-z]:/.test(p)) return p.slice(4);
  return p;
}

function codexRoots() {
  const h = codexHome();
  return [path.join(h, 'sessions'), path.join(h, 'archived_sessions')];
}

// The transcript of one Codex session: the path the SessionStart hook
// recorded, if it is inside Codex's session folders, else a search of the
// newest 31 day folders (and the archive) for a file ending in the session ID.
function findCodexTranscript(session, recorded, platform = process.platform) {
  session = require('./store').cleanSession(session);
  if (!session) return null;
  const fold = p => (platform === 'win32' ? p.toLowerCase() : p);
  const roots = codexRoots().map(r => path.resolve(r));
  const { localPath } = require('./gitbin');
  const isFile = p => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };
  // Inside the session folders by name and by real path, so a link there
  // can't lead somewhere else. Resolved a part at a time with links read as
  // text, so one to a network path is never followed.
  const realRoots = roots.map(r => localPath(r) || r);
  const inRoots = p => {
    if (!roots.some(r => fold(p).startsWith(fold(r) + path.sep))) return false;
    const real = localPath(p);
    return !!real && realRoots.some(r => fold(real).startsWith(fold(r) + path.sep));
  };
  if (typeof recorded === 'string' && recorded) {
    const p = path.resolve(plainPath(recorded));
    if (/\.jsonl$/i.test(p) && inRoots(p) && isFile(p)) return p;
  }
  const want = `${session}.jsonl`;
  const match = name => name.toLowerCase().endsWith(want) && /^rollout-/i.test(name);
  const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+$/.test(e.name)).map(e => e.name).sort().reverse(); } catch { return []; } };
  const days = [];
  for (const y of subdirs(roots[0]).slice(0, 3)) {
    for (const m of subdirs(path.join(roots[0], y))) {
      for (const d of subdirs(path.join(roots[0], y, m))) {
        days.push(path.join(roots[0], y, m, d));
        if (days.length >= 31) break;
      }
      if (days.length >= 31) break;
    }
    if (days.length >= 31) break;
  }
  days.push(roots[1]);
  for (const d of days) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    const hit = names.slice(0, 5000).find(match);
    if (hit && inRoots(path.join(d, hit)) && isFile(path.join(d, hit))) return path.join(d, hit);
  }
  return null;
}

const pad = n => String(n).padStart(2, '0');
const hhmm = ts => { const d = new Date(ts); return isNaN(d) ? '--:--' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// C0 and C1 controls (NEL, U+0085, among them) become spaces; \s already
// covers U+2028 and U+2029. Every entry stays on one line.
const flat = s => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text);
}

// Claude's own messages and compaction summaries are cut to this many
// characters before flattening; output keeps at most 1,200 of them.
const MSG_SCAN = 20000;

// Drop harness wrappers such as <system-reminder>...</system-reminder>: an
// opening tag, then everything up to the first closing tag with the same name
// (names compared without case). Same result as the regex
// /<([a-z][a-z0-9_-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, in one pass: that regex
// took quadratic time on long runs of unclosed tags, which a pasted web page
// can contain, and cutting the text first could lose what followed a long
// wrapper.
function stripWrappers(text) {
  const closes = new Map(); // tag name -> start positions of its closing tags, ascending
  const closeRe = /<\/([a-z][a-z0-9_-]*)>/gi;
  let m;
  while ((m = closeRe.exec(text))) {
    const n = m[1].toLowerCase();
    if (!closes.has(n)) closes.set(n, []);
    closes.get(n).push(m.index);
  }
  const next = new Map(); // tag name -> index into its closes list
  const nameRe = /[a-z][a-z0-9_-]*/iy;
  let out = '';
  let last = 0; // start of the text not yet copied
  let gt = -1;  // cached: the first '>' at or after the last place looked
  let i = 0;
  while ((i = text.indexOf('<', i)) !== -1) {
    nameRe.lastIndex = i + 1;
    const nm = nameRe.exec(text);
    if (!nm) { i++; continue; }
    const after = i + 1 + nm[0].length;
    const ch = text[after];
    // An opening tag: the name, then '>' or whitespace and anything up to '>'.
    if (ch !== '>' && !(ch !== undefined && /\s/.test(ch))) { i++; continue; }
    if (gt < after) gt = text.indexOf('>', after);
    if (gt === -1) break; // no '>' left, so no opening tag can end
    const name = nm[0].toLowerCase();
    const list = closes.get(name);
    let k = next.get(name) || 0;
    while (list && k < list.length && list[k] <= gt) k++;
    next.set(name, k);
    if (!list || k >= list.length) { i++; continue; }
    out += text.slice(last, i) + ' ';
    last = list[k] + name.length + 3; // '</' + name + '>'
    i = last;
  }
  return (out + text.slice(last)).trim();
}

// One Codex rollout line as { role: user | assistant | compact, text }, or
// null for anything else (tool calls and their output, reasoning, session
// metadata, developer and system messages).
function codexEntry(o, hasEvents) {
  const p = o.payload;
  if (!p || typeof p !== 'object') return null;
  const str = v => (typeof v === 'string' ? v : '');
  if (o.type === 'compacted') return str(p.message) ? { role: 'compact', text: p.message } : null;
  if (o.type === 'event_msg') {
    if (p.type === 'user_message' && str(p.message)) return { role: 'user', text: p.message };
    if (p.type === 'agent_message' && str(p.message)) return { role: 'assistant', text: p.message };
    // The ChatGPT desktop app's form (seen 2026-10-25, Windows): item_completed
    // with a UserMessage or AgentMessage item, its text in content parts.
    if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
      const role = p.item.type === 'UserMessage' ? 'user' : p.item.type === 'AgentMessage' ? 'assistant' : '';
      if (!role) return null;
      const parts = Array.isArray(p.item.content) ? p.item.content : [];
      const text = parts.filter(c => c && /^text$/i.test(String(c.type)) && typeof c.text === 'string').map(c => c.text).join(' ');
      return text ? { role, text } : null;
    }
    return null;
  }
  if (o.type === 'response_item' && !hasEvents && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const parts = Array.isArray(p.content) ? p.content : [];
    const text = parts.filter(c => c && (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string').map(c => c.text).join(' ');
    return text ? { role: p.role, text } : null;
  }
  return null;
}

// tail: keep the most recent maxChars instead of the earliest.
// Calls fn(line) for each line of a file, read in fixed-size chunks. A
// transcript can outgrow the longest string Node can hold (about 512 MB), and
// a whole-file read then failed with "Cannot create a string longer than ...".
// A line longer than maxLine is skipped unread: at that size it is tool
// output, never a message worth quoting.
function forEachLine(file, fn, { chunk = 1 << 20, maxLine = 32 << 20 } = {}) {
  const fd = openPlain(file);
  try {
    const buf = Buffer.alloc(chunk);
    let parts = [];
    let size = 0;
    let skipping = false;
    const flush = () => {
      if (!skipping && size) fn(Buffer.concat(parts, size).toString('utf8'));
      parts = []; size = 0; skipping = false;
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, null);
      if (n <= 0) break;
      const data = buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        const end = nl === -1 ? data.length : nl;
        if (!skipping && end > start) {
          if (size + (end - start) > maxLine) { skipping = true; parts = []; size = 0; }
          else { parts.push(Buffer.from(data.subarray(start, end))); size += end - start; }
        }
        if (nl === -1) break;
        flush();
        start = nl + 1;
      }
    }
    flush();
  } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function extract(file, { since = 0, maxChars = 20000, tail = false } = {}) {
  const found = [];
  // A Codex rollout records each message twice: as an event (user_message,
  // agent_message: what was typed and shown) and as a response_item (what
  // the model got, with injected context). The events are used when present.
  // One pass keeps both, marked, and drops the response_items at the end if
  // any event turned up, so the file is never held in memory whole.
  let hasEvents = false;
  forEachLine(file, line => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || typeof o !== 'object') return;
    if (o.type === 'event_msg' && o.payload && (o.payload.type === 'user_message' || o.payload.type === 'agent_message' ||
      (o.payload.type === 'item_completed' && o.payload.item && (o.payload.item.type === 'UserMessage' || o.payload.item.type === 'AgentMessage')))) hasEvents = true;
    const ts = Date.parse(o.timestamp || '') || 0;
    if (since && ts && ts < since) return;
    let entry = null;
    const c = codexEntry(o, false);
    if (c) {
      const t = c.role === 'user' ? flat(stripWrappers(c.text.slice(0, MSG_SCAN))) : flat(c.text.slice(0, MSG_SCAN));
      if (c.role === 'compact') entry = `[${hhmm(ts)}] COMPACTION SUMMARY: ${t.slice(0, 1200)}`;
      else if (c.role === 'user') { if (t && !t.startsWith('<')) entry = `[${hhmm(ts)}] USER: ${t.slice(0, 1200)}`; }
      else if (t) entry = `[${hhmm(ts)}] ASSISTANT: ${t.slice(0, 600)}`;
    } else if (o.isCompactSummary) {
      entry = `[${hhmm(ts)}] COMPACTION SUMMARY: ${flat(textParts(o.message && o.message.content).join(' ').slice(0, MSG_SCAN)).slice(0, 1200)}`;
    } else if (o.type === 'user' && o.message) {
      const t = flat(stripWrappers(textParts(o.message.content).join(' ')));
      if (t && !t.startsWith('<')) entry = `[${hhmm(ts)}] USER: ${t.slice(0, 1200)}`;
    } else if (o.type === 'assistant' && o.message) {
      const t = flat(textParts(o.message.content).join(' ').slice(0, MSG_SCAN));
      if (t) entry = `[${hhmm(ts)}] CLAUDE: ${t.slice(0, 600)}`;
    }
    if (entry) found.push({ entry, ts, item: !!c && o.type === 'response_item' });
  });
  const all = hasEvents ? found.filter(x => !x.item) : found;
  const order = tail ? [...all].reverse() : all;
  const kept = [];
  let used = 0;
  for (const x of order) {
    if (used + x.entry.length > maxChars) break;
    kept.push(x);
    used += x.entry.length + 1;
  }
  if (tail) kept.reverse();
  return {
    file,
    lines: kept.map(x => x.entry),
    truncated: kept.length < all.length,
    total: all.length,
    first: kept.length ? kept[0].ts : null,
    last: kept.length ? kept[kept.length - 1].ts : null,
  };
}

module.exports = { forEachLine, findTranscript, findTranscriptForSession, findCodexTranscript, codexHome, codexRoots, plainPath, extract, stripWrappers, netLinkBelow };

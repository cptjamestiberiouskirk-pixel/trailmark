// Opening a file the hooks read but didn't write (a Claude Code or Codex
// transcript), outside the memory folder's own checks: never through a link
// to a network path (on Windows, opening one sends your sign-in hash to that
// server), never a FIFO or device, which would block the hook, and the file
// opened must be the one lstat saw.
'use strict';

const fs = require('fs');
const { localPath } = require('./gitbin');

const O_READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);

function notPlain(file) { const e = new Error(`${file} is a link or not a plain file`); e.code = 'ENOTFILE'; return e; }

// A file descriptor for reading, or a thrown error.
function openPlain(file) {
  if (!localPath(file)) throw notPlain(file);
  const l = fs.lstatSync(file, { bigint: true });
  if (!l.isFile()) throw notPlain(file);
  const fd = fs.openSync(file, O_READ);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || (l.ino && (st.ino !== l.ino || st.dev !== l.dev))) throw notPlain(file);
  } catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } throw e; }
  return fd;
}

// A plain file's modification time, NaN for anything else (a link included).
function plainMtime(file) {
  try { const l = fs.lstatSync(file); return l.isFile() ? l.mtimeMs : NaN; } catch { return NaN; }
}

// The cwd fields of transcript records, in order: each line is parsed as
// JSON and only a record's own top-level "cwd" counts, never a "cwd" inside
// a tool call's arguments or a message. A line cut off at the end of the
// text read is scanned for its top-level "cwd" instead.
function recordCwds(text, max = Infinity) {
  const out = [];
  for (let line of String(text).replace(/^\uFEFF/, '').split('\n')) {
    if (out.length >= max) break;
    if (!line.includes('"cwd"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { j = undefined; }
    if (j !== undefined) {
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.cwd === 'string') out.push(j.cwd);
      continue;
    }
    // A line cut off where the read stopped (a long first prompt): its
    // top-level "cwd", read with a scan that tracks nesting and strings.
    const c = topLevelCwd(line);
    if (typeof c === 'string') out.push(c);
  }
  return out;
}
// The value of a top-level "cwd" key in the start of a JSON object, or
// undefined. Keys and values inside nested objects, arrays and strings never
// count.
function topLevelCwd(t) {
  let i = 0;
  const n = t.length;
  // JSON whitespace (and a BOM), by code: this runs per character.
  const ws = () => { for (let c = t.charCodeAt(i); i < n && (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff); c = t.charCodeAt(++i)); };
  const str = () => {
    const s0 = i;
    i++;
    // To the closing quote, escapes stepped over.
    for (;;) {
      const q = t.indexOf('"', i);
      if (q < 0) return null;
      let bs = 0;
      for (let k = q - 1; k >= s0 + 1 && t.charCodeAt(k) === 92; k--) bs++;
      i = q + 1;
      if (bs % 2 === 0) return t.slice(s0, i);
    }
  };
  ws();
  if (t[i] !== '{') return undefined;
  i++;
  let depth = 1;
  let expectKey = true;
  while (i < n && depth > 0) {
    ws();
    const ch = t[i];
    if (ch === undefined) break;
    if (ch === '"') {
      const raw = str();
      if (raw === null) return undefined;
      if (depth === 1 && expectKey) {
        ws();
        if (t[i] !== ':') return undefined;
        i++; ws();
        if (raw === '"cwd"') {
          if (t[i] !== '"') return undefined;
          const v = str();
          if (v === null) return undefined;
          try { return JSON.parse(v); } catch { return undefined; }
        }
        expectKey = false;
        continue;
      }
      continue;
    }
    if (ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ']') { depth--; i++; continue; }
    if (ch === ',') { if (depth === 1) expectKey = true; i++; continue; }
    i++;
  }
  return undefined;
}

module.exports = { openPlain, plainMtime, recordCwds };

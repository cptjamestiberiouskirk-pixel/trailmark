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

module.exports = { openPlain, plainMtime };

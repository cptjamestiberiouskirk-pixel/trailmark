#!/usr/bin/env node
// install-check.js -- small checks for install.sh and install.ps1, kept in a
// file so the installers never pass JavaScript on a command line (Windows
// PowerShell 5.1 mangles quotes in native arguments). Reads only; prints one
// line; changes nothing.
//
//   node install-check.js node-advice      '' or one sentence on updating Node
//   node install-check.js others           reads `claude plugin list --json` on
//                                          stdin; prints the ids of jb-memory
//                                          installed from another marketplace
//   node install-check.js marketplace      reads `claude plugin marketplace list
//                                          --json` on stdin; prints the real path
//                                          the jb-memory marketplace points at,
//                                          or '' when there is none
//
// Exit code 3 means the input wasn't the JSON list expected, so the caller can
// stop instead of taking it as "nothing installed".

'use strict';

const fs = require('fs');
const path = require('path');

function readList() {
  let s = '';
  try { s = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
  let j;
  try { j = JSON.parse(s.replace(/^﻿/, '').trim()); } catch { process.stdout.write('unreadable'); process.exit(3); }
  if (!Array.isArray(j)) { process.stdout.write('unreadable'); process.exit(3); }
  return j;
}

const cmd = process.argv[2];
if (cmd === 'node-advice') {
  const { nodeAdvice } = require(path.join(__dirname, '..', 'plugins', 'jb-memory', 'scripts', 'lib', 'health.js'));
  process.stdout.write(nodeAdvice(process.version));
} else if (cmd === 'others') {
  const ids = readList().map(p => String((p && p.id) || '')).filter(id => /^jb-memory@/i.test(id) && id !== 'jb-memory@jb-memory');
  process.stdout.write(ids.join(' '));
} else if (cmd === 'marketplace') {
  const m = readList().find(x => x && x.name === 'jb-memory');
  if (!m) process.exit(0);
  const p = String(m.path || m.installLocation || '');
  if (!p) { process.stdout.write(String(m.source || 'unknown source')); process.exit(0); }
  let r = p;
  try { r = fs.realpathSync.native(p); } catch { /* shown as recorded */ }
  process.stdout.write(r);
} else {
  process.stderr.write('usage: node install-check.js node-advice|others|marketplace\n');
  process.exit(2);
}

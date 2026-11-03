#!/usr/bin/env node
// install-check.js -- small checks for install.sh and install.ps1, kept in a
// file so the installers never pass JavaScript on a command line (Windows
// PowerShell 5.1 mangles quotes in native arguments). Reads only; prints one
// line; changes nothing.
//
//   node install-check.js node-advice      '' or one sentence on updating Node
//   node install-check.js others           reads `claude plugin list --json` on
//                                          stdin; prints each other copy once
//                                          (trailmark from another marketplace,
//                                          or jb-memory) with its scopes:
//                                          "id (scope[ in path], ...); ..." 
//   node install-check.js others-new       the same, leaving jb-memory out (the
//                                          migration removes it after the checks)
//   node install-check.js real <path>      the real path of a folder
//   node install-check.js marketplace      reads `claude plugin marketplace list
//                                          --json` on stdin; prints the real path
//                                          the trailmark marketplace points at,
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
  try { j = JSON.parse(s.replace(/^\uFEFF/, '').trim()); } catch { process.stdout.write('unreadable'); process.exit(3); }
  if (!Array.isArray(j)) { process.stdout.write('unreadable'); process.exit(3); }
  return j;
}

const cmd = process.argv[2];
if (cmd === 'node-advice') {
  const { nodeAdvice } = require(path.join(__dirname, '..', 'plugins', 'trailmark', 'scripts', 'lib', 'health.js'));
  process.stdout.write(nodeAdvice(process.version));
} else if (cmd === 'others' || cmd === 'others-new') {
  // others-new, for the migration's preflight: jb-memory is about to be
  // removed, so only another Trailmark install counts. Each id once, with the
  // scopes it is installed at (jb-memory: the name before 0.5.1).
  const want = cmd === 'others' ? /^(?:trailmark|jb-memory)@/i : /^trailmark@/i;
  const by = new Map();
  for (const p of readList()) {
    const id = String((p && p.id) || '');
    if (!want.test(id) || id === 'trailmark@trailmark') continue;
    const sc = String((p && p.scope) || 'user') + (p && p.projectPath ? ` in ${p.projectPath}` : '');
    if (!by.has(id)) by.set(id, []);
    if (!by.get(id).includes(sc)) by.get(id).push(sc);
  }
  process.stdout.write([...by].map(([id, s]) => `${id} (${s.join(', ')})`).join('; '));
} else if (cmd === 'real') {
  // A folder's real path (junctions and subst drives resolved), so it can be
  // compared with the marketplace's, which is printed the same way.
  let r = String(process.argv[3] || '');
  try { r = fs.realpathSync.native(r); } catch { /* as given */ }
  process.stdout.write(r);
} else if (cmd === 'marketplace') {
  const m = readList().find(x => x && x.name === 'trailmark');
  if (!m) process.exit(0);
  const p = String(m.path || m.installLocation || '');
  if (!p) { process.stdout.write(String(m.source || 'unknown source')); process.exit(0); }
  let r = p;
  try { r = fs.realpathSync.native(p); } catch { /* shown as recorded */ }
  process.stdout.write(r);
} else {
  process.stderr.write('usage: node install-check.js node-advice|others|others-new|marketplace|real <path>\n');
  process.exit(2);
}

#!/usr/bin/env node
// Every job of every workflow in .github/workflows has a `timeout-minutes` of
// its own, so a job that hangs ends at its limit and not at GitHub's 6 hours
// (dev/release-state.md, section "Next version: RS-D-jobtimeout").
//
//   node dev/check-workflow-timeouts.js [file ...]   check these files (default:
//                                                    .github/workflows/*.yml)
//   node dev/check-workflow-timeouts.js --self-test  run the built-in cases only
//
// It reads the files line by line, not as YAML: a job is a key one level below
// the top-level `jobs:`, and its limit is a `timeout-minutes:` key one level
// below the job (a step's limit is deeper and does not count for the job).
// Each `timeout-minutes` value it finds, job or step, is a whole number from 1
// to 360, or a `${{ }}` expression whose unquoted numbers are all in that range
// and that ends in `|| <number>`, so that no matrix row falls through to
// `false`. It prints the self-test's line, then one line per file and one
// `FAULT <file>: ...` line for each fault, and exits 1 on any fault. It only
// reads files. Shapes it does not read as YAML (a flow-style or quoted job
// key, an anchor, a quoted value, a job that calls a reusable workflow, which
// cannot take a limit) fail the check rather than pass it.
'use strict';
const fs = require('fs');
const path = require('path');

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => /^\s*(#.*)?$/.test(l);

function badValue(v) {
  if (/^[0-9]+$/.test(v)) return Number(v) >= 1 && Number(v) <= 360 ? '' : `${v} is not from 1 to 360`;
  const m = v.match(/^\$\{\{(.*)\}\}$/);
  if (!m) return `${JSON.stringify(v)} is neither a number nor an expression`;
  const nums = m[1].replace(/'[^']*'/g, '').match(/\b[0-9]+(\.[0-9]+)?\b/g) || [];
  if (!nums.length) return `${JSON.stringify(v)} holds no number`;
  const off = nums.filter((n) => !/^[0-9]+$/.test(n) || Number(n) < 1 || Number(n) > 360);
  if (off.length) return `${JSON.stringify(v)} holds ${off.join(', ')}, not from 1 to 360`;
  return /\|\|\s*[0-9]+\s*$/.test(m[1]) ? '' : `${JSON.stringify(v)} does not end in || <number>, so a matrix row can fall through`;
}

// Returns { jobs: [names], faults: [texts] } for one workflow's text.
function check(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const faults = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*timeout-minutes:\s*(.*?)\s*(#.*)?$/);
    if (m) { const b = badValue(m[1]); if (b) faults.push(`line ${i + 1}: timeout-minutes ${b}`); }
  }
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) return { jobs: [], faults: [...faults, 'no top-level jobs: key'] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (!isBlank(lines[i]) && indentOf(lines[i]) === 0) { end = i; break; }
  const body = [];
  for (let i = start + 1; i < end; i++) if (!isBlank(lines[i])) body.push(lines[i]);
  if (!body.length) return { jobs: [], faults: [...faults, 'jobs: holds no job'] };
  const jobIndent = indentOf(body[0]);
  const jobs = [];
  const names = () => jobs.map((j) => j.name);
  let cur = null;
  for (const l of body) {
    const ind = indentOf(l);
    if (ind < jobIndent) return { jobs: names(), faults: [...faults, `a line under jobs: is less indented than its first job: ${l.trim()}`] };
    if (ind === jobIndent) {
      const jm = l.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/);
      if (!jm) return { jobs: names(), faults: [...faults, `not a job key at the job level: ${l.trim()}`] };
      cur = { name: jm[1], keyIndent: -1, limit: false };
      jobs.push(cur);
      continue;
    }
    if (cur.keyIndent < 0) cur.keyIndent = ind;
    if (ind === cur.keyIndent && /^\s*timeout-minutes:/.test(l)) cur.limit = true;
  }
  for (const j of jobs) if (!j.limit) faults.push(`job ${j.name} has no timeout-minutes of its own`);
  return { jobs: names(), faults };
}

function selfTest() {
  const job = (extra) => `on: push\njobs:\n  a:\n    runs-on: x\n${extra}    steps:\n      - run: true\n`;
  const cases = [
    ['a job limit', job('    timeout-minutes: 30\n'), ''],
    ['a job limit with a comment after it', job('    timeout-minutes: 30 # why\n'), ''],
    ['a job limit as an expression', job("    timeout-minutes: ${{ matrix.os == 'windows-latest' && 45 || 25 }}\n"), ''],
    ['no limit', job(''), 'no timeout-minutes'],
    ['a step limit only', job('').replace('      - run: true\n', '      - run: true\n        timeout-minutes: 10\n'), 'no timeout-minutes'],
    ['a limit commented out', job('    # timeout-minutes: 30\n'), 'no timeout-minutes'],
    ['a limit one level too deep', job('      timeout-minutes: 30\n'), 'no timeout-minutes'],
    ['a limit under strategy', job('    strategy:\n      timeout-minutes: 30\n'), 'no timeout-minutes'],
    ['a limit of 0', job('    timeout-minutes: 0\n'), 'not from 1 to 360'],
    ['a limit of 361', job('    timeout-minutes: 361\n'), 'not from 1 to 360'],
    ['a limit of 2.5', job('    timeout-minutes: 2.5\n'), 'neither'],
    ['an empty limit', job('    timeout-minutes:\n'), 'neither'],
    ['an expression with 0', job('    timeout-minutes: ${{ true && 0 || 25 }}\n'), 'not from 1 to 360'],
    ['an expression with 400', job('    timeout-minutes: ${{ true && 400 || 25 }}\n'), 'not from 1 to 360'],
    ['an expression with no number', job('    timeout-minutes: ${{ matrix.limit }}\n'), 'holds no number'],
    ['an expression with no last number', job("    timeout-minutes: ${{ matrix.os == 'windows-latest' && 45 }}\n"), 'fall through'],
    ['an expression whose last part is a test', job("    timeout-minutes: ${{ matrix.os == 'windows-latest' && 45 || matrix.os == 'macos-latest' && 25 }}\n"), 'fall through'],
    ['an expression ending in a quoted number', job("    timeout-minutes: ${{ matrix.os == 'windows-latest' && 45 || '20' }}\n"), 'fall through'],
    ['an expression ending in || 20', job("    timeout-minutes: ${{ matrix.os == 'ubuntu-latest' && 20 || matrix.os == 'macos-latest' && 25 || 45 }}\n"), ''],
    ['a step expression that can fall through', job('    timeout-minutes: 30\n').replace('      - run: true\n', "      - run: true\n        timeout-minutes: ${{ matrix.os == 'x' && 8 }}\n"), 'fall through'],
    ['a bad step limit', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        timeout-minutes: 999\n'), 'not from 1 to 360'],
    ['two jobs, the second with none', job('    timeout-minutes: 30\n') + '  b:\n    runs-on: x\n', 'job b has no'],
    ['two jobs, the first with none', `jobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: x\n    timeout-minutes: 5\n`, 'job a has no'],
    ['four-space indents', `jobs:\n    a:\n        runs-on: x\n        timeout-minutes: 5\n`, ''],
    ['CRLF line ends', job('    timeout-minutes: 30\n').replace(/\n/g, '\r\n'), ''],
    ['CRLF line ends, no limit', job('').replace(/\n/g, '\r\n'), 'no timeout-minutes'],
    ['no jobs key', 'on: push\n', 'no top-level jobs'],
    ['an empty jobs key', 'jobs:\non: push\n', 'holds no job'],
    ['a key after jobs at the top level', job('    timeout-minutes: 30\n') + 'env:\n  timeout-minutes: 1\n', ''],
    ['a line less indented than the first job', `jobs:\n    a:\n        runs-on: x\n        timeout-minutes: 5\n  b:\n    runs-on: x\n`, 'less indented', 'a'],
    ['a quoted job key', `jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n  "b":\n    runs-on: x\n`, 'not a job key', 'a'],
  ];
  let bad = 0;
  for (const [name, text, want, jobsWant] of cases) {
    const r = check(text);
    const got = r.faults.join('; ');
    let ok = want ? got.includes(want) : got === '';
    if (jobsWant !== undefined && r.jobs.join(',') !== jobsWant) ok = false;
    if (!ok) { bad++; console.log(`self-test FAIL: ${name}: wanted ${want ? JSON.stringify(want) : 'no fault'}${jobsWant !== undefined ? ` and jobs ${jobsWant}` : ''}, got ${JSON.stringify(got)}, jobs ${r.jobs.join(',')}`); }
  }
  console.log(`self-test: ${cases.length - bad} of ${cases.length} cases as expected`);
  return bad === 0;
}

const args = process.argv.slice(2);
let ok = selfTest();
if (args[0] !== '--self-test') {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const files = args.length ? args : fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(dir, f));
  if (!files.length) { console.log('no workflow files found'); ok = false; }
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { ok = false; console.log(`FAULT ${path.basename(f)}: cannot read it (${e.code || e.message})`); continue; }
    const r = check(text);
    if (r.faults.length) ok = false;
    console.log(`${path.basename(f)}: ${r.jobs.length} jobs (${r.jobs.join(', ')}), ${r.faults.length ? `${r.faults.length} faults` : 'each has timeout-minutes'}`);
    for (const t of r.faults) console.log(`FAULT ${path.basename(f)}: ${t}`);
  }
}
process.exit(ok ? 0 : 1);

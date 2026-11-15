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
// Each `timeout-minutes` value it finds, job or step (a step's first key, after
// `- `, too), is a whole number from 1 to 360, or a `${{ }}` expression of one
// shape: `matrix.os == '<label>' && <n> || ... || <n>`, every <n> a whole
// number in that range. The last part is a number, so no matrix row falls
// through to `false`; any other shape (a hex or negative number, a function, a
// bare context) is refused.
//
// What it guards against: a limit that is missing or malformed in the plain
// YAML these workflows use. It does not guard against a limit hidden on
// purpose (the workflows are written in this repo, so that takes a commit
// that review sees); a real YAML parser would be needed for that. So it reads
// only that plain YAML and refuses the rest: a limit is accepted only as a
// plain `timeout-minutes: <value>` line; any other line that holds `timeout`
// or `minutes` in any case is a fault, except a full-line comment; so is any
// line with a character outside ASCII. Outside a block scalar (`run: |`), so
// is an anchor or an alias, a flow mapping, a flow sequence other than a
// one-line list of plain words, an explicit `? ` key, a double-quoted key
// that holds an escape, and a line that is neither a key with its colon nor
// a `- ` list item. A `#` with no space or tab before it is part of the
// value, as in YAML. It prints the
// self-test's line, then one line per file and one `FAULT <file>: ...` line
// for each fault, and exits 1 on any fault. It only reads files. Shapes it
// does not read as YAML (a flow-style or quoted job key, an anchor, a quoted
// value, a job that calls a reusable workflow, which cannot take a limit)
// fail the check rather than pass it.
'use strict';
const fs = require('fs');
const path = require('path');

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlank = (l) => /^\s*(#.*)?$/.test(l);

const inRange = (n) => Number(n) >= 1 && Number(n) <= 360;
const CHAIN_PART = /^matrix\.os\s*==\s*'[A-Za-z0-9._-]+'\s*&&\s*([0-9]+)$/;

function badValue(v) {
  if (/^[0-9]+$/.test(v)) return inRange(v) ? '' : `${v} is not from 1 to 360`;
  const m = v.match(/^\$\{\{(.*)\}\}$/);
  if (!m) return `${JSON.stringify(v)} is neither a number nor an expression`;
  const parts = m[1].split('||').map((p) => p.trim());
  const last = parts[parts.length - 1];
  if (!/^[0-9]+$/.test(last)) return `${JSON.stringify(v)} does not end in || <number>, so a matrix row can fall through`;
  const nums = [last];
  for (const p of parts.slice(0, -1)) {
    const pm = p.match(CHAIN_PART);
    if (!pm) return `${JSON.stringify(v)} has a part that is not matrix.os == '<label>' && <number>: ${JSON.stringify(p)}`;
    nums.push(pm[1]);
  }
  const off = nums.filter((n) => !inRange(n));
  return off.length ? `${JSON.stringify(v)} holds ${off.join(', ')}, not from 1 to 360` : '';
}

// Returns { jobs: [names], faults: [texts] } for one workflow's text.
function check(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const faults = [];
  // The line rules read the plain YAML these workflows use and refuse the
  // rest (see the header for what that guards against and what it does not).
  // A limit is accepted in one shape only: `timeout-minutes: <value>`,
  // indented with spaces, optionally a step's first key after `- `, with
  // only spaces or tabs before an end-of-line comment.
  let blockCol = -1; // inside a block scalar (`run: |`): lines deeper than this
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const at = `line ${i + 1}`;
    // Non-ASCII anywhere, comments too: a no-break space, a look-alike letter.
    if (/[^\x00-\x7f]/.test(l)) { faults.push(`${at}: holds a character outside ASCII, which this check does not read: ${l.trim()}`); continue; }
    const inBlock = blockCol >= 0 && (isBlank(l) || indentOf(l) > blockCol);
    if (!inBlock) blockCol = -1;
    if (!inBlock && /^[ \t]*#/.test(l)) continue; // a full-line comment
    if (!inBlock && !isBlank(l)) {
      // The YAML the workflows use, and nothing else: no anchor or alias, no
      // flow mapping, no flow sequence but a one-line list of plain words, no
      // explicit `? ` key, no double-quoted key with an escape, and every
      // line a key (with its colon on that line) or a `- ` list item.
      const bare = l.replace(/\$\{\{.*?\}\}/g, 'E').replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, 'Q');
      const why =
        /"(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*"[ \t]*:/.test(l) ? 'a double-quoted key with an escape' :
        /^[ \t]*(?:-[ \t]+)?\?(?:[ \t]|$)/.test(l) ? 'an explicit ? key' :
        /(?:^|[ \t:,[{-])[&*][^ \t&]/.test(bare.replace(/[ \t]#.*$/, '')) ? 'an anchor or an alias' :
        /\{/.test(bare.replace(/[ \t]#.*$/, '')) ? 'a flow mapping' :
        /\[/.test(bare.replace(/[ \t]#.*$/, '')) && !/^[ \t]*(?:-[ \t]+)?[A-Za-z0-9_-]+:[ \t]+\[[ A-Za-z0-9._,Q-]*\][ \t]*(?:[ \t]#.*)?$/.test(bare) ? 'a flow sequence that is not a one-line list of plain words' :
        !/^[ \t]*-(?:[ \t]|$)/.test(bare) && !/:(?:[ \t]|$)/.test(bare) ? 'a line that is not a key or a list item (a key whose colon is on another line, or a value that runs on)' : '';
      if (why) { faults.push(`${at}: ${why}, which this check does not read: ${l.trim()}`); continue; }
      const bm = bare.match(/^([ \t]*(?:-[ \t]+)?)[A-Za-z0-9_-]+:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/);
      if (bm) blockCol = bm[1].length;
    }
    // Any line that holds `timeout` or `minutes`, in any case, is the plain
    // shape or a fault: a quoted or capitalised key, a space before the colon,
    // none after it, or a `run:` or `name:` line that holds the word.
    if (!/timeout|minutes/i.test(l)) continue;
    const m = l.match(/^ *(?:- +)?timeout-minutes:(?:[ \t]+(.*?))?[ \t]*(?:[ \t]#.*)?$/);
    if (!m) { faults.push(`${at}: names timeout or minutes outside the one shape this check reads: ${l.trim()}`); continue; }
    const b = badValue(m[1] === undefined ? '' : m[1]);
    if (b) faults.push(`${at}: timeout-minutes ${b}`);
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
    if (ind === cur.keyIndent && /^ *timeout-minutes:(?:[ \t]|$)/.test(l)) cur.limit = true;
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
    ['an expression with 0', job("    timeout-minutes: ${{ matrix.os == 'x' && 0 || 25 }}\n"), 'not from 1 to 360'],
    ['an expression with 400', job("    timeout-minutes: ${{ matrix.os == 'x' && 400 || 25 }}\n"), 'not from 1 to 360'],
    ['an expression ending in 0', job("    timeout-minutes: ${{ matrix.os == 'x' && 30 || 0 }}\n"), 'not from 1 to 360'],
    ['an expression with no number', job('    timeout-minutes: ${{ matrix.limit }}\n'), 'fall through'],
    ['an expression with a hex number', job("    timeout-minutes: ${{ matrix.os == 'x' && 0x200 || 20 }}\n"), 'not matrix.os'],
    ['an expression with an exponent', job("    timeout-minutes: ${{ matrix.os == 'x' && 1e3 || 20 }}\n"), 'not matrix.os'],
    ['an expression ending in an exponent', job("    timeout-minutes: ${{ matrix.os == 'x' && 30 || 1e3 }}\n"), 'fall through'],
    ['an expression with a negative number', job("    timeout-minutes: ${{ matrix.os == 'x' && -5 || 20 }}\n"), 'not matrix.os'],
    ['an expression with a bare context', job('    timeout-minutes: ${{ matrix.os || 20 }}\n'), 'not matrix.os'],
    ['an expression with a function', job('    timeout-minutes: ${{ fromJSON(matrix.limit) || 20 }}\n'), 'not matrix.os'],
    ['an expression in parentheses', job("    timeout-minutes: ${{ (matrix.os == 'x' && 8) || 20 }}\n"), 'not matrix.os'],
    ['an expression that is one number', job('    timeout-minutes: ${{ 30 }}\n'), ''],
    ['a step limit as the first key, falling through', job('    timeout-minutes: 30\n').replace('      - run: true\n', "      - timeout-minutes: ${{ matrix.os == 'x' && 8 }}\n        run: true\n"), 'fall through'],
    ['a step limit as the first key, 0', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - timeout-minutes: 0\n        run: true\n'), 'not from 1 to 360'],
    ['a step limit as the first key only', job('').replace('      - run: true\n', '      - timeout-minutes: 30\n        run: true\n'), 'no timeout-minutes'],
    ['a flow-style step with a limit', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - {run: true, timeout-minutes: 0}\n'), 'does not read'],
    ['a quoted step key', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        "timeout-minutes": 0\n'), 'outside the one shape'],
    ['a space before the colon', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        timeout-minutes : 0\n'), 'outside the one shape'],
    ['a run line naming the key', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: echo timeout-minutes\n'), 'outside the one shape'],
    ['a job limit 30#c', job('    timeout-minutes: 30#c\n'), 'neither'],
    ['a step limit 30#c', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        timeout-minutes: 30#c\n'), 'neither'],
    ['a limit with spaces after it', job('    timeout-minutes: 30   \n'), ''],
    ['a step key with an \\x escape', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        "timeout\\x2dminutes": 0\n'), 'with an escape'],
    ['a step key with a \\u escape', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        "timeout\\u002dminutes": 0\n'), 'with an escape'],
    ['a flow-style step with an escaped key', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - {run: true, "time\\x6fut-minutes": 0}\n'), 'with an escape'],
    ['an explicit ? key', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        ? timeout-minutes\n        : 0\n'), 'explicit'],
    ['a job limit with a no-break space before #c', job('    timeout-minutes: 30 #c\n'), 'outside ASCII'],
    ['a step limit with a no-break space after it', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        timeout-minutes: 30 \n'), 'outside ASCII'],
    ['a job limit with no space after the colon', job('    timeout-minutes:30\n'), 'not a key or a list item'],
    ['no space after the colon is not the job limit', job('    timeout-minutes:30\n'), 'no timeout-minutes'],
    ['a job limit with a tab before its comment', job('    timeout-minutes: 30\t# why\n'), ''],
    ['a capitalised step key', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        Timeout-Minutes: 0\n'), 'outside the one shape'],
    ['an anchor on a step key', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        &t timeout-minutes: 0\n'), 'an anchor or an alias'],
    ['a name line holding the word', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - name: wait five minutes\n        run: true\n'), 'outside the one shape'],
    ['a key with only escapes for its letters', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        "\\x74imeout-minute\\x73": 0\n'), 'with an escape'],
    ['a flow mapping as a key value', job('    timeout-minutes: 30\n    env: {A: 1}\n'), 'flow mapping'],
    ['a flow mapping that runs on to the key indent', job('    env: {A: 1,\n    B: 2}\n    timeout-minutes: 30\n'), 'flow mapping'],
    ['a non-ASCII character in a comment', job('    timeout-minutes: 30\n    # café\n'), 'outside ASCII'],
    ['a no-break space inside an expression', job("    timeout-minutes: ${{ matrix.os == 'x' && 8 || 20 }}\n"), 'outside ASCII'],
    ['an if line with an expression', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: true\n        if: ${{ always() }}\n'), ''],
    // Round 5's forms (r5-probes/probe-r5.js, probe-r5b.js): an alias as a
    // key after an anchor on an escaped value, and a flow key whose colon is
    // on the next line. Each passed d685662's checker.
    ['J10 an alias key 400 after the job limit', job('    timeout-minutes: 30\n    env:\n      K: &k "\\x74imeout-\\x6dinutes"\n    *k : 400\n'), 'an anchor or an alias'],
    ['J11 an alias key with a fall-through', job("    timeout-minutes: 30\n    env:\n      K: &k \"\\x74imeout-\\x6dinutes\"\n    *k : ${{ matrix.os == 'x' && 8 }}\n"), 'an anchor or an alias'],
    ['B3 an alias key as a step first key', job('    timeout-minutes: 30\n    env:\n      K: &k "\\x74imeout-\\x6dinutes"\n').replace('      - run: true\n', '      - *k : 0\n        run: true\n'), 'an anchor or an alias'],
    ['B4 a flow step after a bare dash, colon next line', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      -\n        {run: true, "\\x74imeout-\\x6dinutes"\n          : 0}\n'), 'flow mapping'],
    ['B6 a flow sequence of steps', job('    timeout-minutes: 30\n').replace('    steps:\n      - run: true\n', '    steps: [{run: true,\n      "\\x74imeout-\\x6dinutes"\n      : 0}]\n'), 'flow'],
    ['B12 a tag before a flow step', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - !!map {run: true, "\\x74imeout-\\x6dinutes"\n          : 0}\n'), 'flow mapping'],
    ['B13 an anchor before a flow step', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - &s {run: true, "\\x74imeout-\\x6dinutes"\n          : 0}\n'), 'an anchor or an alias'],
    ['B8 a limit line with a deeper continuation line', job('    timeout-minutes: 30\n      0\n'), 'not a key or a list item'],
    ['a one-line list of plain words (passes)', job('    timeout-minutes: 30\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n        node: [\'22\', \'24\']\n'), ''],
    ['a run block with braces, brackets, & and * (passes)', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: |\n          [ -z "$x" ] && ls *.js | ForEach-Object { $_ }\n          & pwsh -File $p\n        shell: bash\n'), ''],
    ['a key after a run block is read again', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: |\n          true\n        timeout-minutes: 0\n'), 'not from 1 to 360'],
    ['a full-line comment with the words (passes)', job('    timeout-minutes: 30\n    # minutes of timeout\n'), ''],
    ['a run line with a quoted path holding backslashes', job('    timeout-minutes: 30\n').replace('      - run: true\n', '      - run: |\n          & "$env:windir\\System32\\x.exe" -a 2>&1\n'), ''],
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

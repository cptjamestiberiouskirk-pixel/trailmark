#!/usr/bin/env node
// Sorts a pull request into a risk tier from its file list, using the rules in
// dev/risk-tiers.json on the base branch. Read-only: it reads two files and
// prints JSON; it runs nothing from the PR and makes no network call.
//   node dev/tier.js <rules.json> <files.jsonl> [expected file count]
// files.jsonl holds one object per line, as GitHub's "list pull request files"
// API returns them: filename, status, previous_filename, patch. Every pattern
// in the rules is matched without regard to case.
'use strict';
const fs = require('node:fs');

const ORDER = ['low', 'medium', 'high'];
const re = (s) => new RegExp(s, 'i');

function fileTier(name, rules) {
  for (const t of ['high', 'medium', 'low']) {
    if ((rules[t] || []).some((p) => re(p).test(name))) return t;
  }
  return 'medium';
}

// The line's code, read once from left to right, so its time grows with the
// line: each quoted string becomes "", a // comment ends the line and a /* */
// comment goes. A quote still open at the end gives the raw line back, so a
// stray quote can't hide a skip from the key forms.
function code(l) {
  let out = '';
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < l.length && l[j] !== ch) j += l[j] === '\\' ? 2 : 1;
      if (j >= l.length) return l;
      out += '""';
      i = j;
    } else if (ch === '/' && l[i + 1] === '/') {
      break;
    } else if (ch === '/' && l[i + 1] === '*') {
      const end = l.indexOf('*/', i + 2);
      if (end < 0) break;
      out += ' ';
      i = end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}
// Skip forms: t.skip(), t.skip (), t.skip?.(), test.only() and t['skip']()
// (read on the raw line, so a call inside a template or after a stray quote
// counts, and so does one named in a string or comment); { skip: ... },
// { only: true } and the shorthand { skip }, { timeout: 5, todo } (read in
// the code, but not in a destructuring line such as `const { skip } = opts`);
// { 'skip': true } (raw). Other forms (an alias, a key set later, a call split
// over lines) are left to the reviewer.
const CALL = /\.\s*(skip|todo|only)\s*(\?\.\s*)?\(|\[\s*['"`](skip|todo|only)['"`]\s*\]/;
const KEY = /\b(skip|todo)\s*:|\bonly\s*:\s*(true|[1-9])/;
const SHORT = /[{,]\s*(skip|todo|only)\s*[,}]/;
const DESTRUCT = /^\+?\s*(const|let|var)\s*\{/;
const QUOTED = /['"](skip|todo|only)['"]\s*:/;
const isSkip = (l) => {
  const c = code(l);
  return CALL.test(l) || KEY.test(c) || (SHORT.test(c) && !DESTRUCT.test(c)) || QUOTED.test(l);
};
// A skip that names its condition on the same line (a platform, root, a flag).
// Read in the code, so `t.skip('why?')` or a `// a && b` comment is not a
// condition, and neither does a constant that decides it (`true || x`,
// `1 ? 'a' : b`), nor is an optional call (`?.(`). A todo or a focus (only)
// is never conditional.
const constant = (l) => /\bskip\s*:\s*(true|[1-9]\d*|"")\s*(\|\||\?)/.test(code(l));
const conditional = (l) => !/\b(todo|only)\b/i.test(code(l)) && !constant(l)
  && /\?(?!\.)|&&|\|\||\bif\s*\(|process\.(platform|getuid)|\bWIN\b/.test(code(l));
const added = (lines) => lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
const removed = (lines) => lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));

// Signs that a test was made weaker, kept here so one place decides "a person
// looks". Each one lifts the PR to high, because a weaker test can make a bad
// change pass. An early return or a looser assert is left to the reviewer.
function weakened(f, rules) {
  const tests = re(rules.weakenedTests);
  const isTest = tests.test(f.filename);
  const wasTest = f.previous_filename ? tests.test(f.previous_filename) : isTest;
  if (wasTest && !isTest) return ['test file renamed out of the tests'];
  if (!isTest) return [];
  if (f.status === 'removed') return ['test file removed'];
  if (f.patch == null) return ['test file with no patch text, check by hand'];
  const lines = f.patch.split('\n');
  const out = [];
  const rm = removed(lines).filter((l) => /\bassert\b/.test(l)).length;
  const ad = added(lines).filter((l) => /\bassert\b/.test(l)).length;
  if (rm > ad) out.push(`fewer asserts (-${rm} +${ad})`);
  // With strictSkips off, a conditional skip goes to the reviewer as a
  // must-check item instead of lifting the tier. Any other skip, and any todo,
  // lifts it.
  const skips = added(lines).filter((l) => isSkip(l));
  const hard = rules.strictSkips ? skips : skips.filter((l) => !conditional(l));
  if (hard.length > 0) out.push(`skip, todo or only added (${hard.length})`);
  return out;
}

function mustCheck(f, rules) {
  if (rules.strictSkips || f.patch == null || !re(rules.weakenedTests).test(f.filename)) return [];
  return added(f.patch.split('\n')).filter((l) => isSkip(l) && conditional(l))
    .map(() => `conditional skip in ${f.filename}: confirm the condition names the only systems it can't run on`);
}

function classify(files, rules, expected) {
  let tier = 'low';
  const reasons = [];
  const checks = [];
  const lift = (t, why) => {
    if (ORDER.indexOf(t) > ORDER.indexOf(tier)) tier = t;
    if (t !== 'low') reasons.push(`${t}: ${why}`);
  };
  const names = [];
  for (const f of files) {
    for (const n of [f.filename, f.previous_filename].filter(Boolean)) {
      names.push(n);
      lift(fileTier(n, rules), n);
    }
    for (const w of weakened(f, rules)) lift('high', `${w}: ${f.filename}`);
    checks.push(...mustCheck(f, rules));
  }
  if (files.length === 0) lift('high', 'no files listed, check by hand');
  if (expected != null && Number(expected) !== files.length) {
    lift('high', `the file list has ${files.length} files and the PR ${expected}, check by hand`);
  }
  const any = (list) => names.some((n) => list.some((p) => re(p).test(n)));
  return {
    tier,
    reasons,
    lenses: { regression: true, security: any(rules.securityLens || []), docs: any([rules.docsLens]) },
    mustCheck: [...new Set(checks)],
    files: names.length,
  };
}

module.exports = { classify, fileTier, weakened };

if (require.main === module) {
  const [rulesPath, filesPath, expected] = process.argv.slice(2);
  if (!rulesPath || !filesPath) {
    console.error('usage: node dev/tier.js <rules.json> <files.jsonl> [expected file count]');
    process.exit(2);
  }
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const files = fs.readFileSync(filesPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  process.stdout.write(JSON.stringify(classify(files, rules, expected)) + '\n');
}

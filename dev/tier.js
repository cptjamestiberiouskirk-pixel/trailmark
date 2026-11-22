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

const SKIP = /\.(skip|todo)\(|\b(skip|todo)\s*:/;
// A skip that names its condition on the same line (a platform, root, a flag).
// Text inside quotes doesn't count, so `t.skip('why?')` is not a condition.
const code = (l) => l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
const conditional = (l) => !/todo/i.test(l) && /\?|&&|\|\||\bif\s*\(|process\.(platform|getuid)|\bWIN\b/.test(code(l));
const added = (lines) => lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
const removed = (lines) => lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));

// The checks judge-guard ran, kept here so one place decides "a person looks".
// Each one lifts the PR to high, because a weaker test can make a bad change pass.
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
  const skips = added(lines).filter((l) => SKIP.test(l));
  const hard = rules.strictSkips ? skips : skips.filter((l) => !conditional(l));
  if (hard.length > 0) out.push(`skip or todo added (${hard.length})`);
  return out;
}

function mustCheck(f, rules) {
  if (rules.strictSkips || f.patch == null || !re(rules.weakenedTests).test(f.filename)) return [];
  return added(f.patch.split('\n')).filter((l) => SKIP.test(l) && conditional(l))
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

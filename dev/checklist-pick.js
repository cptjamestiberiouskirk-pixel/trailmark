#!/usr/bin/env node
// Lists the reliability checklist items whose trigger matches this branch's
// diff. Read-only: runs git show and git diff, writes nothing.
//   node dev/checklist-pick.js [base]     default base: origin/main
// An item with both paths and lines matches an added line in a matching file.
// An item with only one of them matches on that one alone.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const base = process.argv[2] || 'origin/main';
const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 64 << 20, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });

// The list comes from the base branch, so a branch can't drop or loosen an
// item. Only the PR that first adds the file falls back to the working tree.
let text;
try {
  text = git('show', `${base}:dev/reliability-checklist.json`);
} catch {
  console.error(`not on ${base} yet; using the working tree copy`);
  text = fs.readFileSync('dev/reliability-checklist.json', 'utf8');
}
const items = JSON.parse(text);

// Added lines per file, from one unified diff with no context.
const added = new Map();
let file = null;
for (const l of git('diff', '-U0', '--no-color', `${base}...HEAD`).split('\n')) {
  if (l.startsWith('+++ ')) {
    file = l === '+++ /dev/null' ? null : l.slice(6);
    if (file !== null && !added.has(file)) added.set(file, []);
  } else if (l.startsWith('diff --git ')) {
    file = null;
  } else if (file !== null && l.startsWith('+')) {
    added.get(file).push(l.slice(1));
  }
}
for (const f of git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)) {
  if (!added.has(f)) added.set(f, []); // deleted or binary files still count for paths
}

const hits = items.filter((it) => {
  const p = it.paths ? new RegExp(it.paths) : null;
  const re = it.lines ? new RegExp(it.lines) : null;
  for (const [f, lines] of added) {
    if (p && !p.test(f)) continue;
    if (!re || lines.some((l) => re.test(l))) return true;
  }
  return false;
});
for (const it of hits) {
  console.log(`${it.id}  ${it.title}\n    check: ${it.check}\n    from:  ${it.origin}`);
}
console.error(`${hits.length} of ${items.length} items matched against ${base}`);

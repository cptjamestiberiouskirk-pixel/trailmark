// Turns failing tests in node --test TAP output into GitHub annotations, so
// a failure can be read through the API without downloading the job log.
// Usage: node .github/tap-annotate.js <tap file>
'use strict';
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const esc = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
let shown = 0;
for (let i = 0; i < lines.length && shown < 10; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m || /^\s*not ok \d+ - .*\.test\.js$/.test(lines[i])) continue;
  const block = [];
  for (let k = i + 1; k < lines.length && !/^\s*\.\.\.\s*$/.test(lines[k]) && block.length < 40; k++) block.push(lines[k].trim());
  const keep = block.filter(l => /^(location|error|expected|actual|code):|^[+-] |AssertionError|Error:|at .*test\.js/.test(l) || !/^(duration_ms|type|failureType|stack):/.test(l));
  console.log(`::error title=${esc(m[1].slice(0, 120))}::${esc(keep.join('\n').slice(0, 3000))}`);
  shown++;
}
const sum = lines.filter(l => /^# (tests|pass|fail)/.test(l)).join(', ');
console.log(`::notice title=summary::${esc(sum)}`);

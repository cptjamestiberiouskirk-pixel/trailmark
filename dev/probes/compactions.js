// Read-only. What Claude Code's transcripts hold after each main-thread
// compaction: the first entry after the boundary, whether any request with a
// size comes before the summary, and how the first request after it compares
// with the boundary's preTokens. Backs the context watch's rule that a
// boundary after the last request leaves no size to go by (dev/release-state.md,
// "The stale ask after /compact").
//
//   node dev/probes/compactions.js [projects folder]
//
// The folder defaults to ~/.claude/projects. Prints counts only; writes nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = process.argv[2] || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const files = [];
for (const d of fs.readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(root, d.name);
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
}
const kind = o => {
  if (o.type === 'user') return `user${o.isSidechain ? '(side)' : ''}${o.isCompactSummary ? '(summary)' : ''}`;
  if (o.type === 'assistant') return `assistant${o.isSidechain ? '(side)' : ''}${o.message && o.message.usage ? '+usage' : ''}`;
  return String(o.type);
};
const tokens = u => ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
  .reduce((n, k) => n + (Number.isFinite(u[k]) && u[k] > 0 ? u[k] : 0), 0);
const out = { transcripts: files.length, withCompaction: 0, compactions: { manual: 0, auto: 0, other: 0 }, firstEntryAfter: {}, sizedBeforeSummary: 0, noRequestAfter: 0 };
const ratios = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!text.includes('"compact_boundary"')) continue;
  out.withCompaction++;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('"compact_boundary"')) continue;
    let b; try { b = JSON.parse(lines[i]); } catch { continue; }
    if (b.type !== 'system' || b.subtype !== 'compact_boundary' || b.isSidechain) continue;
    const trig = (b.compactMetadata && b.compactMetadata.trigger) || 'other';
    out.compactions[trig in out.compactions ? trig : 'other']++;
    let first = null;
    let summarySeen = false;
    let request = null;
    for (let j = i + 1; j < lines.length; j++) {
      let o; try { o = JSON.parse(lines[j]); } catch { continue; }
      if (!o || typeof o !== 'object' || o.type === 'system' || o.type === 'attachment' || o.type === 'file-history-snapshot') continue;
      if (!first) first = kind(o);
      if (o.type === 'user' && o.isCompactSummary) summarySeen = true;
      const u = o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage;
      if (u && o.message.model !== '<synthetic>') {
        if (!summarySeen) out.sizedBeforeSummary++;
        request = tokens(u);
        break;
      }
    }
    const key = `${trig}: ${first || '(nothing)'}`;
    out.firstEntryAfter[key] = (out.firstEntryAfter[key] || 0) + 1;
    if (request === null) out.noRequestAfter++;
    else ratios.push(Math.round(100 * request / Math.max(1, (b.compactMetadata && b.compactMetadata.preTokens) || 0)));
  }
}
ratios.sort((a, b) => a - b);
out.firstRequestPctOfPreTokens = ratios.length ? { n: ratios.length, min: ratios[0], median: ratios[ratios.length >> 1], max: ratios[ratios.length - 1] } : null;
console.log(JSON.stringify(out, null, 1));

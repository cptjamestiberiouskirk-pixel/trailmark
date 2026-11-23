#!/usr/bin/env node
// Decides whether a pull request may merge without the owner, from data the
// workflow fetched into .review/ (see .github/workflows/auto-review.yml).
// No network calls; it writes only its own output files in that folder.
//   node dev/review-gate.js candidates      <dir>             reviewers' output -> dir/candidates.json
//   node dev/review-gate.js merge           <verifiers> <dir> candidates + votes -> dir/findings.json
//   node dev/review-gate.js payload         <dir>             -> dir/comments.jsonl and dir/review.json
//   node dev/review-gate.js signers         <file>            exit 1 unless it holds only security keys for /ship
//   node dev/review-gate.js ship-candidates <dir>             -> dir/ship/<n>.msg and <n>.sig
//   node dev/review-gate.js decide          <rules> <dir>     -> dir/gate.json
// In the review job, a step that can't tell what happened fails closed (exit
// 1), so the round is not posted and the gate reads "review did not finish".
// decide fails a tier it does not know.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Markers are only read from the last line of a comment the bot wrote.
const ROUND = /^<!-- auto-review round=(\d+) sha=([0-9a-f]{40}) base=([A-Za-z0-9._/-]{1,100}) blocking=(\d+) -->$/;
const FINDING = /^<!-- auto-review finding=([A-Za-z0-9_-]{1,40}) sha=([0-9a-f]{40}) -->$/;
const lastLine = (s) => String(s || '').trimEnd().split('\n').pop();

// No @ mentions, HTML or token-shaped strings from model text reach a comment.
const clean = (s, max = 4000) => String(s == null ? '' : s)
  .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[removed]')
  .replace(/(github_pat_|gh[oprsu]_)[A-Za-z0-9_]{20,}/g, '[removed]')
  .replace(/&/g, '&amp;')
  .replace(/@/g, '@' + String.fromCharCode(0x200b)).replace(/</g, '&lt;').slice(0, max);

// A path as the PR names it: reviewers sometimes give the copy under
// .review/head/ or a leading "./".
const prPath = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\.review\/head\//, '');

// Ids are assigned here, by lens and position, so the reviewers' own ids never
// have to match anything. The lens comes from the file name, never from what a
// reviewer wrote, and two lenses can't share an id.
function candidates(reviewerOutputs) {
  const out = [];
  for (const f of reviewerOutputs) {
    if (!/^[a-z]{1,20}$/.test(String(f.lens))) throw new Error(`bad lens ${JSON.stringify(f.lens).slice(0, 40)}`);
    (f.findings || []).forEach((x, i) => {
      out.push({
        id: `${f.lens}-${i + 1}`,
        lens: f.lens,
        severity: x.severity === 'blocking' ? 'blocking' : 'note',
        path: typeof x.path === 'string' ? prPath(x.path) : '',
        line: Number.isInteger(x.line) && x.line > 0 ? x.line : null,
        title: clean(x.title, 300),
        evidence: clean(x.evidence),
        repro: clean(x.repro, 1000),
      });
    });
  }
  if (new Set(out.map((c) => c.id)).size !== out.length) throw new Error('two findings share an id');
  return out;
}

// A blocking finding needs every verifier to confirm it. Each verifier has one
// vote per finding; if it votes twice, a rejection wins. A verifier that gives
// no verdict for a blocking finding fails the round.
function mergeFindings(cands, voteOutputs) {
  const perVerifier = voteOutputs.map((v) => {
    const m = new Map();
    for (const x of v.votes || []) {
      const ok = x.verdict === 'confirmed';
      m.set(x.id, m.has(x.id) ? m.get(x.id) && ok : ok);
    }
    return m;
  });
  const blocking = [];
  const notes = [];
  const dropped = [];
  for (const c of cands) {
    if (c.severity !== 'blocking') { notes.push(c); continue; }
    if (perVerifier.length === 0 || perVerifier.some((m) => !m.has(c.id))) {
      throw new Error(`no verdict from every verifier for ${c.id}`);
    }
    const yes = perVerifier.filter((m) => m.get(c.id)).length;
    if (yes === perVerifier.length) blocking.push(c);
    else if (yes > 0) notes.push(c);
    else dropped.push(c);
  }
  return { blocking, notes, dropped, verifiers: perVerifier.length };
}

// A section counts when it holds a letter or digit, fenced text included.
// Comments are read as GitHub shows them (an unclosed one hides the rest of
// the body), and headings inside a fenced code block don't count.
function sections(body) {
  // Inside a ``` or ~~~ fence (up to 3 spaces in), a line is content: a
  // leading space keeps it from reading as a heading, and its comment opener
  // is broken so it can't hide what follows. Inside a comment a fence line
  // opens nothing, as GitHub shows it.
  // Where the comment still open at the end of s starts (from position `from`), or -1.
  const openAt = (s, from) => {
    for (let pos = from; ;) {
      const o = s.indexOf('<!--', pos);
      if (o < 0) return -1;
      const c = s.indexOf('-->', o + 4);
      if (c < 0) return o;
      pos = c + 3;
    }
  };
  // A comment opened in the middle of a line is inline HTML in a paragraph: GitHub
  // (checked on its markdown endpoint, 2026-11-22) ends it, leaving the `<!--` as
  // text, at a blank line, a heading, a fence or a list item; plain lines go on
  // inside it. One at the start of a line is a block and runs to `-->`.
  const BLOCK = /^(?: {0,3}(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d+[.)][ \t])|\s*$)/;
  let fence = null;
  let comment = false;
  let mid = -1; // the line (index) whose unclosed `<!--` is mid-line, and where it starts
  let midAt = -1;
  const cancel = [];
  const lines =String(body || '').replace(/\r\n/g, '\n').split('\n').map((l, i) => {
    if (comment && mid >= 0 && BLOCK.test(l)) {
      // The mid-line opener was text: break it so it hides nothing, and read this line afresh.
      cancel.push([mid, midAt]);
      comment = false;
      mid = -1;
    }
    if (comment) {
      const end = l.indexOf('-->');
      if (end >= 0) { const o = openAt(l, end + 3); comment = o >= 0; mid = -1; if (comment) { mid = i; midAt = o; } }
      return l;
    }
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    const opens = m && !(m[1][0] === '`' && m[2].includes('`'));
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
      return ' ' + l.replace(/<!--/g, '<! --');
    }
    if (opens) { fence = m[1]; return ' ' + l; }
    const o = openAt(l, 0);
    comment = o >= 0;
    // Only text with no comment markup before the opener makes it inline: after an
    // earlier `<!-- a -->` GitHub hides what follows as one comment.
    mid = comment && /\S/.test(l.slice(0, o)) && !/<!--|-->/.test(l.slice(0, o)) ? i : -1;
    midAt = o;
    return l;
  });
  for (const [i, at] of cancel) lines[i] = lines[i].slice(0, at) + '<! --' + lines[i].slice(at + 4);
  const text = lines.join('\n').replace(/<!--[\s\S]*?(-->|(?![\s\S]))/g, '');
  const missing = [];
  for (const h of ['Testing', 'Risk', 'How to revert']) {
    const re = new RegExp(`^#{2,3}[ \\t]*${h}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}[ \\t]|(?![\\s\\S]))`, 'm');
    const m = text.match(re);
    if (!m || !/[A-Za-z0-9]/.test(m[1])) missing.push(h);
  }
  return missing;
}

// ship: sessions act through the owner's own login, so GitHub can't tell them
// apart. An approval is "/ship <full sha>" plus an SSH signature over
// shipMessage(), made with a security key that needs the owner's touch. The
// workflow checks each signature with ssh-keygen against main's
// dev/ship-signers and passes the shas that verified as shipVerified.
const SHIP_NS = 'trailmark-ship';
const shipMessage = (repo, pr, sha) => `trailmark ship ${repo} pr=${pr} sha=${sha}\n`;
function shipParts(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const m = /^\/ship[ \t]+([0-9a-f]{40})[ \t]*\n[\s\S]*?(-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+?\n-----END SSH SIGNATURE-----)/.exec(text.trim());
  return m ? { sha: m[1], sig: m[2] + '\n' } : null;
}
// Only security-key keys, each limited to the ship namespace.
function signersOk(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const one = /^owner namespaces="trailmark-ship" sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com [A-Za-z0-9+/]+={0,2}( [^"]*)?$/;
  return lines.length > 0 && lines.every((l) => one.test(l));
}
// The type and flags of an SSH signature (the SSHSIG format). ssh-keygen
// checks the signature, flags included, but not whether the key was touched:
// for a security key the flags byte must say user presence (0x01).
function sigInfo(armored) {
  const b64 = String(armored).replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  let o = 0;
  const u32 = () => { if (o + 4 > buf.length) throw new Error('short'); const v = buf.readUInt32BE(o); o += 4; return v; };
  const str = () => { const n = u32(); if (o + n > buf.length) throw new Error('short'); const v = buf.subarray(o, o + n); o += n; return v; };
  try {
    if (buf.subarray(0, 6).toString() !== 'SSHSIG') return null;
    o = 6; u32(); str();
    const ns = str().toString(); str(); str();
    const sig = str();
    return { ns, ...innerSig(sig) };
  } catch { return null; }
}
function innerSig(sig) {
  let o = 0;
  const str = () => { const n = sig.readUInt32BE(o); o += 4; const v = sig.subarray(o, o + n); o += n; return v; };
  const type = str().toString(); str();
  const sk = type.startsWith('sk-');
  return { type, sk, flags: sk && o < sig.length ? sig[o] : null };
}
// Owner comments that claim the current head, each with the message to check
// (built here, never taken from the comment) and its signature.
function shipCandidates(d, { requireSk = true } = {}) {
  const out = [];
  for (const c of d.comments || []) {
    const p = shipParts(c.body);
    if (!p || p.sha !== d.head || c.user !== d.owner) continue;
    const info = sigInfo(p.sig);
    if (!info || info.ns !== SHIP_NS) continue;
    if (requireSk && !(info.sk && (info.flags & 0x01))) continue;
    out.push({ msg: shipMessage(d.repo, d.pr, d.head), sig: p.sig });
  }
  return out;
}
function shipped(d) {
  return d.signersValid === true && (d.shipVerified || []).includes(d.head);
}

// Breaker: of the last `window` merged PRs labeled tier:low or tier:medium,
// how many does a merged PR name in a "Regression-of:" line. The line may be
// a list item (-, *, + or 1.), a task box, a quote, bold or italic (with the
// colon inside the marks or after them), in any case, and name several PRs
// ("#10, #11", "10, 11", "#10 and #11"). Other forms ("PR #10") are not counted.
function breaker(merged, rules) {
  const b = { window: 20, trip: 2, resetAfter: 0, ...(rules.breaker || {}) };
  const auto = merged.filter((p) => p.number > b.resetAfter && p.labels.some((l) => /^tier:(low|medium)$/.test(l)))
    .sort((x, y) => y.number - x.number).slice(0, b.window);
  const named = new Set();
  for (const p of merged) {
    // After a comma a bare number counts ("10, 11"), unless a word follows it
    // ("#10, 2 tests failed"); after a blank or "and" only "#N" does. Each separator ends at a "," or a "#", so a run of
    // blanks is read one way only and the time stays linear in the body.
    for (const m of String(p.body || '').matchAll(/^[ \t>]*(?:[-*+][ \t]+|\d+[.)][ \t]+)?(?:\[[ xX]\][ \t]+)?[*_]{0,2}regression-of[*_]{0,2}[ \t]*:[*_]{0,2}[ \t]*((?:#\d+|\d+(?!\d|[ \t]+(?!and\b)[A-Za-z]))(?:[ \t]*,[ \t]*(?:#\d+|\d+(?!\d|[ \t]+(?!and\b)[A-Za-z]))|(?:[ \t]+and[ \t]+|[ \t]+)#\d+)*)/gim)) {
      for (const n of m[1].matchAll(/#?(\d+)/g)) named.add(Number(n[1]));
    }
  }
  const hits = auto.filter((p) => named.has(p.number)).map((p) => p.number);
  return { tripped: hits.length >= b.trip, hits, window: auto.length };
}

function decide(d, rules) {
  const reasons = [];
  const tier = d.tier.tier;
  const maxRounds = rules.maxRounds || 3;
  const rounds = (d.botComments || []).map((c) => ROUND.exec(lastLine(c.body))).filter(Boolean);
  const onHead = rounds.filter((m) => m[2] === d.head && m[3] === d.base);
  const round = new Set(rounds.map((m) => m[2])).size;
  const threads = (d.threads || []).map((t) => ({ ...t, m: FINDING.exec(lastLine(t.firstBody)) })).filter((t) => t.m);

  if (!['low', 'medium', 'high'].includes(tier)) reasons.push(`unknown tier ${JSON.stringify(tier)}`);
  if (onHead.length === 0) reasons.push('no finished review of this head on this base');
  // Each finding the round said it posted must be on the PR as a thread.
  for (const m of onHead) {
    const posted = threads.filter((t) => t.m[2] === d.head).length;
    if (posted < Number(m[4])) reasons.push(`round says ${m[4]} blocking findings, ${posted} are on the PR`);
  }
  const open = threads.filter((t) => !t.isResolved);
  if (open.length) reasons.push(`${open.length} open finding${open.length > 1 ? 's' : ''}`);
  // Only the owner's login answers a finding (sessions act through it too);
  // on a public repo anyone else can reply.
  const human = (t) => (t.replies || []).filter((r) => String(r.author).toLowerCase() === String(d.owner).toLowerCase() && String(r.body).trim().length >= 10);
  const bare = threads.filter((t) => t.isResolved && human(t).length === 0);
  if (bare.length) reasons.push(`${bare.length} finding${bare.length > 1 ? 's' : ''} resolved with no reply from the owner`);
  // "fixed in" on a finding raised on this very head names a fix nobody has
  // reviewed: push it, and the next round checks it.
  const unpushed = threads.filter((t) => t.isResolved && t.m[2] === d.head && human(t).length > 0
    && human(t).every((r) => /^\s*fixed in\b/i.test(r.body)));
  if (unpushed.length) reasons.push(`${unpushed.length} finding${unpushed.length > 1 ? 's' : ''} marked fixed on the commit it was raised on: push the fix`);
  // Past maxRounds with any finding ever posted, the owner decides, even after
  // the threads are resolved: their signed /ship on this head lets it pass.
  const escalate = round > maxRounds && threads.length > 0;
  const missing = sections(d.prBody);
  if (missing.length) reasons.push(`PR body section empty or missing: ${missing.join(', ')}`);
  if (d.draft) reasons.push('draft PR');
  if (d.threadsTruncated) reasons.push('more review threads than the gate can read, check by hand');

  const br = breaker(d.merged || [], rules);
  const needsOwner = tier === 'high' || br.tripped || (tier === 'medium' && rules.mediumNeedsOwner === true) || escalate;
  if (needsOwner && d.signersValid !== true) reasons.push('dev/ship-signers on main holds no key, or a line that is not a security key limited to /ship');
  if (needsOwner && !shipped(d)) {
    const why = escalate ? `${round} reviewed pushes (more than ${maxRounds}) and a finding on at least one; rethink the approach`
      : tier === 'high' ? 'high tier'
      : br.tripped ? `breaker tripped (regressions after ${br.hits.map((n) => '#' + n).join(', ')})` : 'medium tier';
    reasons.push(`${why}: needs the owner's signed /ship ${d.head}`);
  }
  const wouldPass = reasons.length === 0;
  return {
    state: wouldPass ? 'success' : 'failure',
    wouldPass, tier, round, needsOwner, escalate, breaker: br, reasons,
    description: `${tier}, round ${round}: ${wouldPass ? 'ok to merge' : reasons[0]}`.slice(0, 140),
  };
}

// Inline comments for findings with a line, file-level ones for the rest. The
// round marker goes in a separate review posted after every finding is up.
function payload(d) {
  // GitHub only takes review comments on files the diff changes, so a finding
  // about any other file is posted on the first changed file and names its own.
  const changed = d.changed || [];
  const onDiff = (x) => changed.length === 0 || changed.includes(x.path);
  const comments = d.findings.blocking.map((x) => ({
    commit_id: d.head,
    path: onDiff(x) ? x.path : changed[0],
    ...(x.line && onDiff(x) ? { line: x.line, side: 'RIGHT' } : { subject_type: 'file' }),
    body: `${onDiff(x) ? '' : `In \`${clean(x.path, 300)}${x.line ? ':' + x.line : ''}\`, which this PR doesn't change:\n\n`}**${x.title}**\n\n${x.evidence}\n\nRepro: ${x.repro}\n\nFix it and reply "fixed in <commit>", or reply with the reason it is not a problem. Then resolve this thread.\n<!-- auto-review finding=${x.id} sha=${d.head} -->`,
  }));
  const notes = d.findings.notes.map((x) => `- ${clean(x.path, 300)}${x.line ? ':' + x.line : ''} ${x.title}`).join('\n');
  const body = [
    `Round ${d.round} on ${d.head.slice(0, 7)}, tier ${d.tier.tier}: ${comments.length} blocking, ${d.findings.notes.length} notes.`,
    notes ? `\n\nNotes (not blocking):\n${notes}` : '',
    `\n<!-- auto-review round=${d.round} sha=${d.head} base=${d.base} blocking=${comments.length} -->`,
  ].join('');
  return { comments, review: { commit_id: d.head, event: 'COMMENT', body } };
}

module.exports = { candidates, mergeFindings, decide, payload, sections, shipped, shipParts, shipMessage, shipCandidates, sigInfo, signersOk, SHIP_NS, breaker, clean };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const tryRead = (p) => { try { return read(p); } catch { return null; } };
  const fail = (why) => { console.error(why); process.exit(1); };
  if (cmd === 'candidates') {
    const files = fs.readdirSync(a).filter((n) => /^find-[a-z]+\.json$/.test(n));
    // The lens goes last, so a "lens" key in a reviewer's own JSON can't replace it.
    const outs = files.map((n) => ({ ...(tryRead(path.join(a, n)) || { findings: null }), lens: n.slice(5, -5) }));
    if (outs.length === 0 || outs.some((x) => !Array.isArray(x.findings))) fail('a reviewer gave no usable output');
    let list;
    try { list = candidates(outs); } catch (e) { fail(e.message); }
    fs.writeFileSync(path.join(a, 'candidates.json'), JSON.stringify(list));
  } else if (cmd === 'merge') {
    const cands = read(path.join(b, 'candidates.json'));
    const votes = fs.readdirSync(b).filter((n) => /^vote-\d+\.json$/.test(n)).map((n) => tryRead(path.join(b, n)));
    const valid = votes.filter((v) => v && Array.isArray(v.votes));
    if (cands.some((c) => c.severity === 'blocking') && valid.length < Number(a)) fail('a verifier gave no usable output');
    try {
      fs.writeFileSync(path.join(b, 'findings.json'), JSON.stringify(mergeFindings(cands, valid)));
    } catch (e) { fail(e.message); }
  } else if (cmd === 'payload') {
    const p = payload(read(path.join(a, 'payload-input.json')));
    fs.writeFileSync(path.join(a, 'comments.jsonl'), p.comments.map((c) => JSON.stringify(c) + '\n').join(''));
    fs.writeFileSync(path.join(a, 'review.json'), JSON.stringify(p.review));
  } else if (cmd === 'signers') {
    let text = '';
    try { text = fs.readFileSync(a, 'utf8'); } catch { fail(`no ${a}`); }
    if (!signersOk(text)) fail(`${a} must hold only security-key keys limited to ${SHIP_NS}`);
  } else if (cmd === 'ship-candidates') {
    // Writes ship/<n>.msg and ship/<n>.sig for each owner comment that claims
    // the current head. The message is built here, never taken from the comment.
    // Only security-key signatures made with a touch are written.
    const out = path.join(a, 'ship');
    fs.mkdirSync(out, { recursive: true });
    const list = shipCandidates(read(path.join(a, 'gate-input.json')));
    list.forEach((x, i) => {
      fs.writeFileSync(path.join(out, `${i + 1}.msg`), x.msg);
      fs.writeFileSync(path.join(out, `${i + 1}.sig`), x.sig);
    });
    console.log(list.length);
  } else if (cmd === 'decide') {
    fs.writeFileSync(path.join(b, 'gate.json'), JSON.stringify(decide(read(path.join(b, 'gate-input.json')), read(a))));
  } else {
    console.error('usage: review-gate.js candidates|merge|payload|signers|ship-candidates|decide ...');
    process.exit(2);
  }
}

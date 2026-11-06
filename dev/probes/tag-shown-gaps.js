// Tags the plain path escapes and the shown path doesn't (dev/release-state.md,
// the combined round's items in "Deferred to the next version"). Every string
// of up to 4 symbols after <, over an alphabet with invisible characters, goes
// through TAG_LIKE as it is and through SHOWN_TAG_LIKE after visibleName, as
// search and --copies --show-names show it. Prints how many the plain path
// escapes and the shown one doesn't, sorted into three groups, with examples.
// Reads only; writes nothing.
//
//   node dev/probes/tag-shown-gaps.js plugins/trailmark
//
// From the combined review round of 0.6.0 (Fable's q1b-f1class.js). On
// ad757a4: 475,255 strings, 37,066 escaped on the plain path only, the same
// on 71d7a78. Its groups: 510 with a tag end hidden as an escape (O1), 28,696
// with a name of escapes only, and 7,860 others (O2 among them).
'use strict';
const S = require(require('path').resolve(process.argv[2] || 'plugins/trailmark', 'scripts', 'lib', 'store.js'));
const c = String.fromCodePoint;
const at = (s, re) => { re.lastIndex = 0; return [...s.matchAll(re)].map(m => m.index); };
const cats = { noEndAfterEscape: 0, nameOnlyEscapes: 0, other: 0 }; const otherEx = [], visibleTagLike = [];
let n = 0, f1 = 0;
const check = (s) => {
  n++;
  const p = at(s, S.TAG_LIKE); if (!p.length) return;
  const v = S.visibleName(s, 1e6);
  if (at(v, S.SHOWN_TAG_LIKE).length) return;
  f1++;
  // Would adding a tag end right after the last escape make it match? Then the gap is an end hidden as an escape.
  const vEnd = v.replace(/(<U\+[0-9A-F]{4,6}>)(?![\s>])/g, '$1>');
  const stripped = v.replace(/<U\+[0-9A-F]{4,6}>/g, '');
  if (at(vEnd, S.SHOWN_TAG_LIKE).length) cats.noEndAfterEscape++;
  else if (!at(stripped, S.TAG_LIKE).length && /[<＜﹤](?:<U\+[0-9A-F]{4,6}>)+/.test(v)) cats.nameOnlyEscapes++;
  else { cats.other++; if (otherEx.length < 15) otherEx.push(JSON.stringify(s) + ' -> ' + JSON.stringify(v)); }
  // Does the printed text still read as a tag with the escapes removed (a model ignoring them)?
  if (at(stripped, S.TAG_LIKE).length && visibleTagLike.length < 15) visibleTagLike.push(JSON.stringify(v));
};
const INV = [c(0x200b), c(0xfeff), c(0x301), c(0x3164), c(0x115f), c(0x1160), c(0xffa0), c(0xd800), '\t', '\u0000', c(0x202e), c(0x2800)];
const A = ['<', '/', '>', ' ', ...INV, 'a', c(0xe9), '1', '_', '-', '.', ':', '!', 'system', 'user'];
const all = (s, depth) => { check(s); if (depth) for (const a of A) all(s + a, depth - 1); };
all('<', 4);
console.log({ n, f1, cats });
console.log('other:', otherEx);
console.log('printed text tag-like once escapes are dropped:', visibleTagLike.length, visibleTagLike);

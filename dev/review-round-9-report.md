# Review round 9: `git diff 4172381..414b4f5` (Trailmark 0.6.0, PR #4)

**Stop rule: not met.** One CONFIRMED behavior in code changed in this range (F1: a tag with an invisible character inside it is not escaped by `search` or `--copies --show-names`). Its risk is INFERRED; the review-strategy session decides whether it holds the merge. The other CONFIRMED items are wording only.

The three passes ran as subagents on 414b4f5: security on Fable, regression on Opus, docs on Sonnet. Each item was reproduced in this session unless it says otherwise.

## Findings in code changed in the range

### F1. Tags split by an invisible character are not escaped (CONFIRMED; risk INFERRED)

- Where (414b4f5):
  - `plugins/trailmark/scripts/memory.js:321` and Codex `memory.js:322` (`search`).
  - `plugins/trailmark/scripts/trailmark.js:699` and Codex `trailmark.js:1003` (`--copies --show-names`).
- Both paths run `escapeTags(visibleName(t), { asIs: true })`. `visibleName` turns an invisible character into the visible text `<U+XXXX>` first, which splits the tag, so `TAG_LIKE` misses it. `escapeTags` alone (as in `framed()`) drops the character and escapes the tag. Reproduced in both copies:

  | Input | `escapeTags(t)` | New path |
  |---|---|---|
  | `<system` U+200B `> x` | `<\system> x` | `<system<U+200B>> x` |
  | `</` U+200B `system> x` | `<\/system> x` | `</<U+200B>system> x` |
  | `<sys` U+00AD `tem> x` | `<\system> x` | `<sys<U+00AD>tem> x` |
  | `<` U+200D `system-reminder> x` | `<\system-reminder> x` | `<<U+200D>system-reminder> x` |

- Fable's scan of U+0000 to U+2FFFF at 5 positions found 881 such misses, all Cc, Cf, Cs or Default_Ignorable characters, and reproduced the miss end to end in `search` and in `--show-names` with a fullwidth `＜` (CONFIRMED by Fable, not re-run).
- At 4172381, `search` printed lines raw and `--copies` didn't escape at all, so the range is no weaker on any input. It falls short of its own claim: CHANGELOG.md:20 says tag-like text gets a `\` after its `<`.
- Risk (INFERRED): the output never holds a literal `<system>`, and it comes after the data frame line. That a model reads `<system<U+200B>>` as a tag is plausible, not shown.
- Fix idea: in the `asIs` path, let `TAG_LIKE`'s runs of invisible characters also accept `<U\+[0-9A-F]{4,6}>`. Swapping the order would lose round 8's bidi display, since `dropControls` removes U+202E first. Test: `search` on `<system` U+200B `> x` prints `<\system<U+200B>> x`, both copies; it fails on 414b4f5.

### F2. `search` escapes a plain `a < b` (CONFIRMED; intended)

- `- needle with <launcher> and a < b_c and </details>` prints `a <\ b_c and <\/details>`; `<launcher>` is unchanged. This is `framed()`'s escaping, and CHANGELOG.md:20 says so. A hit copied verbatim into a handoff would carry the `\` (HYPOTHESIZED, Opus). Recorded, not a fix.

### W1. Test titles still say plain `--copies` lists or explains (CONFIRMED by grep; wording only)

- `handoff-checks.test.js` titles at :1662, :1681, :1758, :1783, :1791, :1805, :1829, plus :1771 by Opus's count, and the comment at :1581 ("named only by --copies").
- `trailmark.test.js:3509-3510`: "--copies says it".
- Every one of these tests now runs `--copies --show-names`. Both copies' test files.
- Fix idea: write `--copies --show-names` in the titles.

### W2. `dev/release-state.md` wording (CONFIRMED against code)

- Line 311 says plain `--copies` prints "a line saying the names aren't shown". `NAMES_HIDDEN` prints only when a copy was found, the check stopped early, or (Codex) old folders were found (`trailmark.js:696`). With none of those, plain `--copies` prints one count line. Fix: "and, when it found any, a line saying ...".
- The seven deferred entries from 468eed7 give the commit (015ea32) and a repro, but no label: they say "seen in code ..., read and not run" (7 counted here). Fix: open each with "CONFIRMED in code, not run;", and "HYPOTHESIZED" for the untraced WARNING text in "the rest".
- P3, S2 and K1, added in the range, have no runnable repro: a stub, a mock, and kept output since removed by the 20-run cap (Sonnet). Fix: a one-line repro, or "Repro: none".

## Checked and clean

- Both copies change together (Opus, CONFIRMED by Opus): `health.js` and `handoff-checks.test.js` are identical between the copies, and the other files' added lines match word for word apart from the intended Codex lines (jb-memory-codex, "Codex").
- Notes (Fable, CONFIRMED by Fable): every `notes.push` in both hooks uses `countCmd` or `dirCmd`, and `--show-names` is only in `warn.push`. Session start was run with a usable launcher and with the plugin under `inst %x`; no note held `--show-names` or the planted path.
- Plain `--copies` prints fixed text only, also when the check stopped early and with old Codex folders (Fable). `--show-names` puts the frame line first every time, shows bidi as `<U+202E>` and escapes fullwidth tags. In `search`, the frame appears only with hits, every hit has a real `file:line:` prefix ahead of any fake one, and 200 U+200B print in 1591 characters, under 1600.
- NFC skip (Fable): across all code points, only `<` + U+0338 is decided differently, and `asIs` escapes it where NFC would miss it.
- Skills (Opus, INFERRED from reading): park and recall don't parse `file:line: text` or rely on "No match".
- Failing first (Opus, CONFIRMED by Opus, not re-run): the search test fails on 9d363db, the plain `--copies` tests on 3b09afe (5 of 6; the sixth checks Codex-only text), the decomposed-name test on 015ea32. B8's helpers sit in the test file, so its test passes on the parent by construction; with direct calls restored it fails on the injected `EPERM`. `busyRetry` retries only `EPERM` and `EBUSY` in setup steps and rethrows the original error (CONFIRMED in code).
- Docs (Sonnet, CONFIRMED against code): CHANGELOG 14, 15 and 20, MANUAL:386, SECURITY:43 and how-it-works:284 match the code. The section references are right, and the added lines have no em or en dashes and no tricolons.

## Older, for the deferred list

- `search` cuts a long line at its start (CONFIRMED here; seen on 414b4f5, from 307e546, 0.4.0, `store.js:1603`, `oneLine(l, 200)`). A match past UTF-16 unit 200 prints without the matched word. Repro: `S.oneLine('\u200b'.repeat(200) + ' MARKER', 200).includes('MARKER')` is `false`; end to end, such a memory line and `search MARKER`. Fix idea: cut around the match.
- Codex `--copies` says nothing about Codex's cache when CODEX_HOME is a file (CONFIRMED here, cosmetic; seen on 414b4f5, and 4172381's catch also printed only on a throw). `oldCodexCopies(<a file>, { full: true })` returns `[]`, so neither "could not be checked" nor a count prints.
- MANUAL.md:386, "uninstall the other install (section 15)": 15 is "Moving from an older install" and 14 is "Uninstall" (INFERRED by Sonnet; older wording, seen on 414b4f5). It fits if the stale copy is an old jb-memory install. MANUAL.md:391, the repo-clash row, doesn't name `dir` (optional).
- `dir`'s recorded path still goes through NFC: already in release-state.

## Not checked

- `dev/release-check.sh` was not run: it is the no-model row, and the release session ran the full check on 468eed7's tree.
- The links test's `busyRetry` (`handoff-checks.test.js:540`) skips here without Developer Mode; CI's Windows runners run it.
- Names with a literal `<`, `>` or line break on disk: Windows refuses them, so fullwidth stand-ins were used and the POSIX path wasn't run.
- B8's statistics in release-state were read for consistency, not re-derived.

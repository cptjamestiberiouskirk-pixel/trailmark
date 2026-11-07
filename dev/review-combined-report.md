Nothing holds the release under the freeze bar: no finding is CONFIRMED in `414b4f5..ad757a4` that makes 0.6.0 worse than 0.5.1.

# Combined last review round, 0.6.0 (`git diff 414b4f5..ad757a4`, 2026-11-06)

Reviewers ran as subagents, chosen by CLAUDE.md's model table: Fable for `store.js` security, Opus for regression, Sonnet for docs. Each used its own temp folder and cleared it. The checkout is clean at ad757a4.

## Findings

None that hold the release.

Checks behind that:

- New tests (CONFIRMED here): `--only 'round 9 F1|^tag escaping:'` at ad757a4, 8/8 pass across all four files.
- Each new test fails on its parent (CONFIRMED by Opus, not re-run). F1's test fails 2/2 on 414b4f5's `store.js`. The six "tag escaping:" tests fail 6/6 on 71d7a78's. The fail-closed test isn't only an export check: it fails under each of six mutations of the new pattern, in both copies.
- Fail-closed against 71d7a78 (CONFIRMED by Fable, not re-run): 525,349 adversarial inputs, with 0 misses and 0 extras on the plain path and on the shown path. Opus ran its own differential (371,809 inputs, 39,401 of them real repo lines) and also found 0 differences.
- Plain callers (`framed()`, `escapeTags` without `asIs`) are unchanged from 414b4f5 (CONFIRMED by Fable, not re-run): 7,181,572 inputs, 0 differences.
- Linear time (CONFIRMED here for 5 shapes, by Fable for 61): at n = 30,000, at most 1.3 ms here and 18 ms in Fable's run.
- `SHOWN_TAG_LIKE` wraps all 10 classes that hold the invisible characters, out of 23 classes (CONFIRMED by Fable, not re-run).
- A planted `<U+XXXX>` can't hide a tag (CONFIRMED here): `visibleName` prints it as `<U+003C>U+...`. The round 8 bidi display holds (CONFIRMED here): `m` U+202E `x<system>` prints `m<U+202E>x<\system>`.
- Copies (CONFIRMED by Opus, not re-run): the 10 shared files are identical. The `store.js` and `trailmark.test.js` hunks match. `SHA256SUMS` verifies.
- Groups of 10 (CONFIRMED by Opus on Windows, with groups of 3 forced): every name is asserted, including the last partial group. The 10-and-2 split off Windows is INFERRED; CI run 42273942341 passed on b0215c0 (CONFIRMED by Sonnet with `gh api`).

## Defer to the next version

Each item below exists on 71d7a78, and on 414b4f5 where the code applies. None is worse than 0.5.1, which had no shown path.

1. O1 (CONFIRMED here on ad757a4 and 71d7a78, `store.js`). On the shown path, a tag whose only end is an invisible space stays unescaped. `escapeTags(visibleName('<system\uFEFF!'), { asIs: true })` gives `<system<U+FEFF>!`; TAB gives the same. The plain path escapes it. The printed text isn't tag-like. Fix idea: let `TAG_END` (`store.js:1902`) also take `<U+FEFF>`, `<U+0009>` and the other escaped spaces. Repro: Fable's `keep-sec/q1b-f1class.js`; 510 of 475,255 inputs.
2. O2 (CONFIRMED here on ad757a4 and 71d7a78). A Hangul filler as a tag's only letter is escaped on the plain path but not on the shown one: `<\u115F>` shows as `<<U+115F>>`. That text isn't tag-like. Fix idea: let a name start with an escape of one of the four fillers. Repro: the same script, or `escapeTags(visibleName('<\u115F>'), { asIs: true })`.
3. Record-keeping (CONFIRMED by Fable, not re-run, seen on ad757a4). `dev/release-state.md` says "F1's count ... is 0 for both". That holds only for its templates, named tags with an end. In general the count is 37,066 of 475,255, the same on old and new. Fix: say it holds for those templates. Repro: `keep-sec/q1b-f1class.js`.
4. Docs, inaccurate (CONFIRMED here, ad757a4). CHANGELOG.md:17 says "3,000 took minutes", and the `store.js` comment (Claude Code :1884, Codex :1866) says "minutes at 3,000". release-state.md:395 records about 43 s. Fix: "about 40 seconds". The conclusion, that session start was stopped, stands.
5. Docs, stale (CONFIRMED here). release-state.md:422 says "the Windows jobs: still running at 19:02Z". Run 42273942341 has since passed (CONFIRMED by Sonnet). Fix: "all 9 jobs passed".
6. Docs, minor (CONFIRMED here). `handoff-checks.test.js:1931` and `:2016`, and the `store.js` comment, call session start's limit "10 s". That is the host's limit. The launcher stops the hook at 9 s (`trailmark.js:200`). Fix: "the launcher's 9 s limit".
7. Docs, minor (INFERRED, Sonnet). "0.5.1 had it too" (CHANGELOG.md:17). The cubic time on v0.5.1 is CONFIRMED (release-state:394), but the stall at session start on 0.5.1 is only extrapolated. Fix: mark it INFERRED in release-state, or leave it.
8. Test load sensitivity (HYPOTHESIZED, Opus, ad757a4). F1's test plants 10 folders per group, the most `otherCopies` lists in its 300 ms budget. Under load it may miss names, like the deferred item at release-state.md:464. Not reproduced. Repro: `--only 'round 9 F1'` under CPU load.
9. Lowercase `<u+200b>` (CONFIRMED here). Planted literally, it passes `visibleName` unescaped (`store.js:514`, case-sensitive) and `SHOWN_TAG_LIKE` (flag `i`) counts it as an escape. So `<system<u+200b>>` gets a `\`. Fails closed: recorded only.

## Not checked

- The 10-and-2 groups off Windows locally. CI's Linux and macOS jobs on b0215c0 cover them.
- A full `dev/release-check.sh` run, which the freeze rules out. Only `--only` on the new and neighboring tests ran: Opus ran 83/91 pass, 8 skipped, 0 failed.
- The 9 CI jobs on ad757a4. Its only change from b0215c0 is in `dev/`.

Repro scripts: `C:\Users\willi\AppData\Local\Temp\claude\71ab46a3352ea046\40c88ea4-b53b-450a-83a5-d3ff7f9d1337\scratchpad\keep-sec` (Fable; they need 414b4f5's and 71d7a78's `plugins/trailmark/scripts` extracted with `git archive` into `old414/` and `old71d/`) and `...\scratchpad\keep-reg` (Opus). The scripts were checked for destructive operations. `keep-reg/mutate.js` and `mutrun.sh` overwrite `store.js` in the worktree they are given, so point them only at a scratch copy. `diffpat.js` uses `eval` on one guarded regex line taken from git history. The rest only read.

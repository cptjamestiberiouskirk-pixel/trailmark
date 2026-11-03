# Release state

Last updated 2026-11-03.

## 0.5.0

- Release commit: `418271766f54972443b131ff7a7edd1fbc4ee179`. Later commits touch only `dev/`, which the zip leaves out. The zip was built from it on 2026-11-02 into `D:\UserFiles\Downloads`: sha256 `00f2459a207bf4b38ae0ae9673c38b5f1d2200992fa903e1c1a245089a418898`, inner sums verified, no links. The release notes there are `trailmark-0.5.0-release-notes.md`.
- Review rounds 1 to 13 are done. The last round's follow-up review found nothing blocking.
- After that, a test-only change (2026-11-02): six `trailmark.test.js` tests that make symlinks skip on a Windows account that can't (no Developer Mode), and the cache-warning test accepts a second stop reason on a slow run. `dev/release-check.sh` names the TAP reporter, since Node 26 prints spec into a pipe. One Opus review found nothing. CI was green on all 9 jobs for the release commit, and its Windows jobs ran the six link tests (6 more passing than a local run without links).
- Decision (2026-11-03): ship 0.5.0 as built. The silent sweep skip (see the deferred list) is fixed in 0.5.1, since that code wasn't changed in this round.

### Still to do by hand

1. Check the zip hash, then publish (from Downloads):

   ```powershell
   gh release create v0.5.0 trailmark-0.5.0.zip trailmark-0.5.0.zip.sha256 --repo cptjamestiberiouskirk-pixel/trailmark --target 418271766f54972443b131ff7a7edd1fbc4ee179 --title "Trailmark 0.5.0" --notes-file trailmark-0.5.0-release-notes.md
   gh repo edit cptjamestiberiouskirk-pixel/trailmark --visibility public --accept-visibility-change-consequences
   gh api -X PUT repos/cptjamestiberiouskirk-pixel/trailmark/private-vulnerability-reporting
   ```

2. Update the installed copy: `Expand-Archive -LiteralPath D:\UserFiles\Downloads\trailmark-0.5.0.zip -DestinationPath C:\Users\willi\tools -Force`, then `install.ps1 -Check`, then the watchdog's `-Status` and `-Accept` (MANUAL.md, section 10), `/reload-plugins` in Claude Code, and Upgrade trailmark-codex in the ChatGPT app.
3. Submit to the plugin directory: https://claude.ai/directory/manage (Submit new, Plugin bundle). Checklist: https://claude.com/docs/plugins/pre-submission-checklist.md
4. Delete `C:\Users\willi\Documents\claude-plugins\tm-sandbox-test` (old build and sandbox scripts) and the leftovers of an early test run, after checking their contents: `C:\tmtest`, `C:\tmcfg`, `C:\fx`, `C:\shareroot`, `C:\tm`, and `%TEMP%\h1.txt`, `h2.txt`, `a b`.

### Confirmed since review

- CONFIRMED (2026-11-02, git 2.56.0.windows.2): Git for Windows takes `..` as text from a `.git` that is a junction. With `top\.git` a junction to `elsewhere\gitdir`, both `include.path = ../x` and a `commondir` of `../common` were read from `top\`, not `elsewhere\`. That held when git found `.git` itself (it reported the origin as `.git/../x`) and when it was given `--git-dir`. A copy without a junction read the same files, which shows the probe worked. The check would start where the junction leads, so the two would read different files, and the `linked-gitdir` refusal on Windows (`gitbin.js`) is needed. Not tested: other pointers (`objects/info/alternates`, a worktree's `gitdir` file) and directory symlinks as opposed to junctions.

## 0.5.1 (in progress)

### Done: the silent sweep skip (2026-11-03, branch `claude/loving-cannon-9abde1`)

- A sweep that runs out of time sets `stopped: 'out-of-time'` (`trailmark.js` `sweepFacts` at each budget gate; `gitfacts.js` `sweepCommits` when a folder is left unread because of the 800 ms gate or a git call refused or timed out). `write-handoff` prints "commit sweep skipped: out of time ..." and session start adds it to the warnings. Only fixed text is printed. `swept` moves only for folders read, as before. Timer values unchanged. `JBMEM_TEST_SWEEP_MS` can only lower the sweep's budget.
- Tests (each copy): the 0.3.4 sweep test repeats a sweep that reports the skip, for up to 90 s, and counts what all of them logged. If every sweep in that window runs out of time it is skipped with the reason, since nothing a finished sweep logs can be checked then. Two new 0.5.1 tests force the out-of-time path (launcher gates, and `sweepCommits` with 700 ms). Both fail on 4182717 for the intended reason (CONFIRMED).
- Under load (CONFIRMED, 2026-11-03, 32 busy threads): old code failed the 0.3.4 test 3 of 3. New code with a 20 s burst during the run: 7 of 7 sweep tests passed in 4 runs (one run repeated a skipped sweep once and then logged the commits). New code with every core busy for the whole run: no sweep finished in 90 s (6 and 7 skips in a row), so the 0.3.4 test and the 0.5.1 launcher test's last step were skipped with that reason; the 0.5.1 launcher test's out-of-time checks passed before that.
- Review: Fable, round 1 found one CONFIRMED test defect (an empty folder list could report `stopped` when the first git call timed out); fixed in code, `stopped` now needs a folder left unread. Round 2 found nothing CONFIRMED. Noted there: a bug that made every sweep report out-of-time would show as two skipped tests (90 s each) rather than failures, so a skip on an idle machine needs reading; and an invalid folder that the time gate passes over counts as unread (a harmless extra report).

## Deferred to 0.5.1

Found in review, fail closed or harmless, left for the next version:

- A worktree `gitdir` file with trailing spaces keeps git out with the reason `network-gitdir`, which misleads (git trims it; git never writes one).
- A branch or file name inside `.git` that isn't valid UTF-8 keeps git out (`odd-path`), though git handles it.
- A leftover folder under `.git/modules` with no `HEAD` has its loose objects walked; a very large one gives `many-entries`.
- A pending commit-start record written by trailmark-codex 0.4.5 has no `host` field and can be released early, within 11 minutes of upgrading.
- A background commit's hook note is rarely printed, since the hook usually runs before the commit exists.
- The two test files don't remove their temp folders (about 150 MB a full run). On Windows they write to `%TEMP%`: Node ignores `TMPDIR` there, so `release-check.sh`'s own cleanup misses them.
- Found while fixing the sweep (2026-11-03), not fixed yet:
  - With every core busy, four other sweep tests failed in both suites ("another clone with its own memory folder", "a commit made after the sweep started", "the sweeping session's own open records", "a commit command still running"). They passed idle and with a 20 s burst. INFERRED: the same out-of-time skip; their output under load wasn't read. Fix: use `settle` / `sweepTest` as the 0.3.4 test does.
  - CONFIRMED in code (`lib/paths.js` `repoRoot`): when a git call times out (3 s), the repo root falls back to the folder itself, so in a linked worktree the launcher picks the worktree's own memory folder and fails with "not set up for this repo". It fails closed. The Fable review saw this happen to the 0.5.1 launcher test under constant load.
- (Fixed in 0.5.1, see above.) The `0.3.4 sweep` test fails when git is slow, because a sweep that runs out of time is skipped without a trace. CONFIRMED (2026-11-02):
  - The one failure (zip build, 16:36) left its sandbox in `%TEMP%\jbmem-4hucLT`: `swept` never moved past the first write (21:36:41), and the resume hook took 7.8 s (p50 3.7 s over 62 runs) and logged nothing.
  - Defender's log shows another workload (a starflight test audit: python, node, pwsh) writing files from 16:36:42.4 to at least 16:36:58, which covers both sweeps that recorded nothing and none of those that worked.
  - Reproduced: with every core busy (`burn.js`, 32 threads), 3 of 3 runs failed and the 5 runs after the load passed. Under load each git call took 0.6 to 1.3 s (normally about 0.1 s), and the write-handoff sweep never reached `git log -g`: the budget gates (`trailmark.js` `sweepFacts`: 1300, 1000 ms; `gitfacts.js` `sweepCommits`: 800 ms) stopped it first.
  - The product is safe: `swept` doesn't advance, so the next sweep finds those commits. The defects are that the skip is silent and the test asserts an outcome that depends on time. Fix for 0.5.1: report a skipped sweep (for example "commit sweep skipped: out of time"), and have the test accept that report plus a later sweep that logs the commits, instead of requiring this sweep to finish.
- `handoff-checks.test.js` skips its link tests on every Windows machine (`skip: WIN`); the `NO_LINKS` probe from `trailmark.test.js` would let CI's Windows runners run them.
- `tools/windows` scripts and installers: no review findings open.

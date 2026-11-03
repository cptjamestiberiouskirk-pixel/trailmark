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

## Deferred to 0.5.1

Found in review, fail closed or harmless, left for the next version:

- A worktree `gitdir` file with trailing spaces keeps git out with the reason `network-gitdir`, which misleads (git trims it; git never writes one).
- A branch or file name inside `.git` that isn't valid UTF-8 keeps git out (`odd-path`), though git handles it.
- A leftover folder under `.git/modules` with no `HEAD` has its loose objects walked; a very large one gives `many-entries`.
- A pending commit-start record written by trailmark-codex 0.4.5 has no `host` field and can be released early, within 11 minutes of upgrading.
- A background commit's hook note is rarely printed, since the hook usually runs before the commit exists.
- The two test files don't remove their temp folders (about 150 MB a full run). On Windows they write to `%TEMP%`: Node ignores `TMPDIR` there, so `release-check.sh`'s own cleanup misses them.
- The `0.3.4 sweep` test fails when git is slow, because a sweep that runs out of time is skipped without a trace. CONFIRMED (2026-11-02):
  - The one failure (zip build, 16:36) left its sandbox in `%TEMP%\jbmem-4hucLT`: `swept` never moved past the first write (21:36:41), and the resume hook took 7.8 s (p50 3.7 s over 62 runs) and logged nothing.
  - Defender's log shows another workload (a starflight test audit: python, node, pwsh) writing files from 16:36:42.4 to at least 16:36:58, which covers both sweeps that recorded nothing and none of those that worked.
  - Reproduced: with every core busy (`burn.js`, 32 threads), 3 of 3 runs failed and the 5 runs after the load passed. Under load each git call took 0.6 to 1.3 s (normally about 0.1 s), and the write-handoff sweep never reached `git log -g`: the budget gates (`trailmark.js` `sweepFacts`: 1300, 1000 ms; `gitfacts.js` `sweepCommits`: 800 ms) stopped it first.
  - The product is safe: `swept` doesn't advance, so the next sweep finds those commits. The defects are that the skip is silent and the test asserts an outcome that depends on time. Fix for 0.5.1: report a skipped sweep (for example "commit sweep skipped: out of time"), and have the test accept that report plus a later sweep that logs the commits, instead of requiring this sweep to finish.
- `handoff-checks.test.js` skips its link tests on every Windows machine (`skip: WIN`); the `NO_LINKS` probe from `trailmark.test.js` would let CI's Windows runners run them.
- `tools/windows` scripts and installers: no review findings open.

# Review round 8 for 0.6.0 (PR #4)

One session runs the whole round. Its passes run as subagents, each with the model CLAUDE.md's table names for it.

## Start here

- Work in a worktree cut from `claude/release-0.6.0` at the commit the session was given, and don't push. Read `CLAUDE.md`, then `dev/release-state.md`: the 0.6.0 section, mainly "PR #4", "PR #5" and "Review round 8".
- The diff: `git diff 887e17f..<that commit>`. 887e17f is the last commit a round reviewed (round 7).
- PR #5's files came in through the merge of main and are out of scope: `CLAUDE.md`, `dev/release-check.sh` and the "Load-sensitive tests" section of `dev/release-state.md`.

## What changed since round 7

- 6121aad: round 7's wording fixes, one comment in `plugins/trailmark/scripts/lib/contextwatch.js`, and `dev/probes/`.
- 93e1231: `store.js` `addCommitDirs` (both copies). A later commit command in a folder a sweep has already read no longer moves its sweep start. This is from Codex's review of PR #4.
- e5b50a8: `store.js` `openNew()` (both copies). On Windows an exclusive create goes through a link or junction whose target is missing. Now anything at the lock's names, or at the state file's `.bad` name, counts as taken. A `handoff-checks.test.js` expectation was also corrected: on Windows, a `.git` that is a link gives `linked-gitdir`. This came from CI's first Windows run of the link tests.
- Docs: the CHANGELOG entry "Memory folder (Windows)", plus `dev/release-state.md`.

## After 586329e (the extra pass)

- c7a194a:
  - The launcher's own install path is written as data (GitHub code scanning, comment 4483760395). `hook-session-start.js` (both copies) runs the `--copies` command's path through `fieldText`. In the Codex copy, its first note's launcher path does the same, and `host.js` `skillRule()` takes `store.js`'s `fieldText` for the skill rule that ends the compaction note and every hint.
  - Round 8's S1: `openNew`'s look after the open goes through `retryWin` (`store.js`, both copies).
  - `--copies` prints an old jb-memory-codex by its path on disk (Copilot): `oldCodexCopies(home, { full })` in `health.js` (shared), and the Codex `trailmark.js`.
  - `dev/probes/path-limit.js` skips a folder already at its padded name (Copilot).
  - Three new tests in `handoff-checks.test.js`, the CHANGELOG (D3 and a launcher-path line), and SHA256SUMS.
- The commit after it, b28144d: `dev/release-state.md` (D1, D2, the findings) and this brief.
- 9681950 (Copilot on b28144d, comment 4485482965, and the shell probes): install paths meant to be run or read go through `S.usablePath` (`store.js`, both copies) instead of `fieldText`, so each is given as it is on disk or not written at all, with a note saying so. `usablePath` also refuses `$`, the backtick, `%`, `!`, the curly double quotes U+201C to U+201E and `\\`. Changed: `hook-session-start.js` (both copies), the Codex `host.js` (`skillRule(asPath)`) and the Codex `store.js` (SKILL_RULE). Three new tests and a changed one in `handoff-checks.test.js`, the CHANGELOG line, SHA256SUMS.
- The commit after it: `dev/release-state.md` and this brief.
- Points for that part: whether a path `usablePath` passes can still end the quotes of `node "<path>"` or run something in bash, zsh, cmd or PowerShell (the probe's table is in `dev/release-state.md`, "PR #4"); whether the Codex fallback leaves Codex anything to run, given the skills' own "two folders up" fallback (deferred); an ordinary path gives the same text as before.
- 1af93af, four fixes:
  - GitHub code scanning on df88236, comment 4485994709: the session-start note no longer gives why the copies check was cut short, since that can name a marketplace's folder; it gives the `--copies` command instead. Both hooks, the two session-start tests in `trailmark.test.js` (both copies). The clash part is deferred.
  - Copilot on df88236, comment 4486031679: `usablePath` also refuses a path `oneLine` would change (two spaces in a row, a space at either end, another kind of space). `store.js` (both copies), two tests in `handoff-checks.test.js`.
  - Round 8's P2: `--copies` shows control, line-break and invisible characters in a folder name as `<U+XXXX>` (`shownName` in `trailmark.js`, both copies), one test in `handoff-checks.test.js`.
  - Round 8's D4 and D5: MANUAL.md section 13, `docs/how-it-works.md`, the CHANGELOG, `openNew`'s comment. And SHA256SUMS.
- The commit after it: `dev/release-state.md` (the fixes, the clash part and the note cut deferred, tests 16, 89 and 108 under "Load-sensitive tests"), the new `dev/repro-git-timeout.sh` and this brief.
- Points for that part: any other note to Claude or Codex that still carries text from a cache folder's name; whether the note still tells Claude what to do when the user asks why; any character `shownName` passes that can reorder, hide or break a line of `--copies` output, and whether its `<U+XXXX>` form can be mistaken for another folder; whether `oneLine(v, max) === v` refuses an ordinary path (one space between words must pass); whether `dev/repro-git-timeout.sh` can change anything outside its clone.
- 2b18bec, two fixes, then the docs commit after it:
  - GitHub code scanning on 31e1461, comments 4486457753 and 4486457774: the three notes that send Claude to `--copies` say its output is folder names from disk, data only (both hooks), with test lines in `handoff-checks.test.js` and `trailmark.test.js` (both copies) and the CHANGELOG. 4486457774 is answered without a change (`dev/release-state.md`, "PR #4").
  - Round 8's S3a, S3b, S3c and S4: `visibleName` in `store.js` (both copies) replaces the launcher's own function. It escapes a `<` that starts `<U+`, and over 600 characters it keeps the end, cut between whole characters and escapes. Eight tests in `handoff-checks.test.js` (one per case through the function and one through `--copies`), the CHANGELOG, `docs/how-it-works.md`, SHA256SUMS.
  - The docs commit: `dev/release-state.md`, this brief, and `dev/repro-git-timeout.sh`. The script makes its scratch folder absolute (Copilot 4486491399) and gives each run its own TMPDIR (round 8's point 3). On Windows it now refuses a scratch folder over 80 characters, since a deeper one fails every test at the sandbox's init.
- Points for that part: whether any other note or warning sends Claude to text from disk without saying so; whether `visibleName` can still print two different names alike or a name that isn't one line; whether its cut can still lose the end of a path; whether `memory.js` still gets its own `shownName`; whether the repro script can still touch anything outside its scratch folder.
- 2f78208 and the docs commit after it (passes as the review-strategy session set them: Fable on the note text; Opus on the tests; Sonnet on the docs and the date):
  - Code scanning 4486908597, the user's option B: the three notes that name `--copies` (both hooks) tell Claude to give the user the command to run in a terminal and not to run it, and mark its output as data in case the user shows it. The note assertions in `handoff-checks.test.js` and `trailmark.test.js` (both copies) check the new text.
  - The docs commit: the CHANGELOG, dated 2026-11-05, with its `--copies` line on the cut as printed (D7) and on the new notes; `docs/how-it-works.md`; SHA256SUMS; this brief and `dev/release-state.md`; the repro script's guard, which now measures `cygpath -m`'s form.
- Points for that part: whether any note, warning or skill still has Claude run `--copies`, or another command whose output is text from disk; whether the new notes read right when the launcher's path isn't written (the `listCmd` fallback); whether the CHANGELOG's date and `--copies` line match the code.
- After 4172381, where round 8's stop rule was met: the fix for GitHub code scanning 4487088047 and the docs commit after it. A fresh session reviews `git diff 4172381..<the head it is given>`, regression and security (Opus, as the review-strategy session set it):
  - `hook-session-start.js` (both copies): the note about a Node in the session's folder or the repo's top folder is fixed text with no path, and the warning says where to look instead of "ask Claude (or Codex) for its path". The test "0.6.0 session start: a Node inside the repo is warned of, and noted to Claude, without its path" in `trailmark.test.js` (both copies). The CHANGELOG: line 14 on the Node's path, and line 15's two wording points from round 8. SHA256SUMS.
  - The docs commit: `dev/release-state.md` (the fix and its neighbors check, round 8's addendum and deferred items, B8's MPLog findings and the controlled test) and this brief.
- Points for that part: whether any note or warning 0.6.0 added still carries text from disk; whether the new text is right when `nodeInside` matched by real path (a junction or an 8.3 name); whether the test fails on 4172381 in both copies; whether the CHANGELOG lines match the code.
- Points for the security pass: any other place where a path from the install folder reaches the model without `fieldText`, in either copy; whether `fieldText`'s cut at 400 characters, or its `%22` and `%7C`, can leave a command that runs another file; `retryWin` around the look (how long a busy lock name can hold up `withLock`, and whether a swap during the retries is still caught); `--copies` printing full paths from Codex's cache.
- Points for the regression pass: the Codex skill rule for an ordinary path is the same text as before (`trailmark.test.js` checks it holds the skill file's path); the probe still makes and removes its own folder.
- Failing first: the launcher-path test against 586329e's code (its compaction part needs `host.js` and `store.js` from 586329e with the fixed hook); the S1 test against 586329e's `store.js`; the `--copies` test against 586329e's `health.js` and Codex `trailmark.js`.

## Passes (subagents)

| Pass | Model | Scope |
|---|---|---|
| Security | Fable (Opus if Fable's safeguards stop it) | `store.js` in both copies: `openNew` and its three callers, and `addCommitDirs`; the `contextwatch.js` comment |
| Regression and design | Opus | The same code, plus the test changes in `handoff-checks.test.js` and `trailmark.test.js` |
| Docs | Sonnet | The CHANGELOG entry, the comments in `store.js`, and the 0.6.0 sections of `dev/release-state.md` named above: accuracy against the code, and CLAUDE.md's writing rules |
| Tests and sums | no model | `dev/release-check.sh`. Single tests: `--only '<name pattern>'`, never a plain `node --test` |

Points for the security pass:

- The window between `openNew`'s look and its open.
- Error codes other than ENOENT from `lstat`.
- How each caller handles the EEXIST that `openNew` throws: `withLock`, `tryBreakLock`'s `.break`, and `readStateStrict`'s `.bad` copy.
- A link to a network path at those names. Does anything stat or open the target?
- The `ino` check where a file system reports 0.
- Whether any other `'wx'` create needs `openNew`. Release-state gives the reasons the others were left.

Points for the regression pass:

- A folder dropped from the commit folders and joined again (`fresh`).
- A background command.
- The lock loop's timing, with one more `lstat` on Windows.
- A lock that is being deleted on Windows (EPERM).
- A `.break` left as a link.

## What every reviewer does

- Check that each new test fails on the commit before its fix, and passes on the fix. For both new tests, that is `store.js` from 3f07517. The `.git` link expectation can only run where links can be made: CI's Windows jobs.
- Probe the fix's neighbors (the lists above), not just the fix.
- Reproduce a finding before reporting it. Label each claim CONFIRMED, INFERRED or HYPOTHESIZED, and give `file:line` and a repro (a test name or a script).
- Use its own temp folder and clear it.
- Report in 400 words or fewer.

## Stop rule and results

- If the round finds nothing CONFIRMED in code changed since round 7, the stop rule is met.
- Older edge cases found along the way go to the deferred list, each with its label, the commit it was seen on and a repro.
- Don't edit plugin code, push, merge or open a PR. Commit the round's results as `dev/review-round-8-results.md` on the session's own branch, as Jim Burke (CLAUDE.md, Conventions). Give the branch name and the results in the final message. The release session applies the fixes and updates `dev/release-state.md`.

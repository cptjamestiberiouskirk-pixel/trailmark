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

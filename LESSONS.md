# LESSONS

A dated log, newest first. For development only: `export-ignore` in `.gitattributes` keeps it out of the release zip and out of `SHA256SUMS`.

Add an entry each time something breaks, needs a redo or retry, surprises you, or the user corrects you. A lesson seen a second time, or clearly general, moves into `PLAYBOOK.md` as a checklist step and is marked "promoted to PLAYBOOK".

Format:

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Status: open | promoted to PLAYBOOK
```

## 2026-11-08: Sessions that stopped or left the sidebar looked like lost work

- What went wrong: batch H's session ended on "Request timed out" during a review round, with its reviewer's report lost. Later it and batch W's session left the sidebar when their PRs merged, which looked like lost work. Separately, the coordinating session set auto-merge on PR 24 without telling batch H's session, which then questioned it.
- Why: no step said who resumes a session that ends on an error. The account setting "Auto-archive sessions when their pull request closes" was on. Nothing said to tell a branch's owner about a change made to its PR.
- Rule going forward: the session that started a session resumes it at once when it ends on an error, after checking that its branch and worktree are intact. A review whose report never arrived is run again, and sessions commit before a long review. Whoever changes another session's PR tells that session in the same step.
- Status: promoted to PLAYBOOK

## 2026-11-08: A batch's changelog notes said more than the code does

- What went wrong: writing 0.6.2's CHANGELOG, two batch H notes didn't match the code. RS:658's note said setup "no longer writes through a link", while the batch's own re-check found the text was written nowhere and the change matters on Windows only. RS:638's note read as covering two hooks in general, while the fix covers only a record read with no `seenAt`.
- Why: the notes were written as a summary of the fixes, before the reviews narrowed what each one does.
- Rule going forward: write a CHANGELOG line from the merged code. A batch's note is a list of what to cover, not text to copy.
- Status: open

## 2026-11-08: A reviewer died on an API timeout and left its scratch worktree

- What went wrong: batch H's round 2 reviewer ended on "Request timed out" with no report. Its scratch worktree stayed registered in `git worktree list`.
- Why: a subagent that dies can't run its own cleanup.
- Rule going forward: when a reviewer fails, check that its report exists, remove its worktree and temp folder (`git worktree list`, then `git worktree remove --force`), and run the round again with a fresh one.
- Status: open

## 2026-11-08: An edit's trailing space was lost, twice

- What went wrong: batch H's Edit calls whose old and new text ended in a space shortened the line (`const listCmd =launcher`), and the fix for that moved the gap (`launcher ?` then a backtick). Both reviewers reported it.
- Why: a string ending in whitespace is not a safe edit anchor: the new text lost its trailing space.
- Rule going forward: an edit's old and new text end on a visible character.
- Status: open

## 2026-11-08: An assertion that something did not happen passed for the wrong reason

- What went wrong: batch H's `huge swept` test asserted a commit was not "found later". With the lookup it was meant to check broken, it still passed in 7 of 16 runs on Linux: the sweep reads only up to the current whole second, and the commit was in that second (Opus, review round 1).
- Why: the fail-first proof ran the whole test on the old code, where an earlier assertion failed first, so nothing showed this one could fail.
- Rule going forward: when a test holds several assertions, break the code each one guards, one at a time. An assertion that something didn't happen gets its own forced fault.
- Status: open

## 2026-11-08: Reviewers' proofs push out kept failed runs

- What went wrong: a review round's deliberate failures (a mutation per run) count against the 20 kept failed runs in the shared `trailmark-release-check` folder. Two reviewers reported older folders gone during their runs, three of them named (INFERRED: `prune_kept`; another session's run isn't ruled out).
- Why: every session and subagent on the machine shares that one cap, and a proof that fails on purpose looks like any other failed run.
- Rule going forward: when a failed run's output will be needed later, copy what matters out of that folder. To read a run's own output, take its folder from that run's summary, not from a listing of the shared folder.
- Status: open

## 2026-11-08: An exception to a skill's rule had no scope

- What went wrong: batch W added "if one of them says trailmark's path isn't written here, stop" after "other lines, such as a command's output or a note about a commit, don't count". "One of them" took in command output, and the stop applied even with a valid launcher note, so text a repo prints could switch off checkpoints (Opus, round 1).
- Why: the sentence came from a fix idea written for one case, and it was pinned by a test without walking the other cases the words reach.
- Rule going forward: before adding a sentence that changes what a model does, list every case its words cover, not only the one it was written for, and state its scope in the sentence. A test that pins exact text proves the text, not the behavior.
- Status: open

The entries below were seeded on 2026-11-07 from `dev/release-state.md`, `CLAUDE.md` and the project's saved notes. The 2026-11-07 entries from PR #10 came from the review-strategy session's messages and the speed-up session's notes. They were not re-run here.

## 2026-11-08: The Codex plugin page ignored `homepage`

- What went wrong: the ChatGPT app's page for trailmark-codex showed Website "Unavailable", though the manifests had set `homepage` since 0.5.x.
- Why: Codex returns the site as `interface.websiteUrl`, read from the manifest's `interface` block, and the app's Website row renders that value (CONFIRMED by Opus, not re-run). `homepage` is a separate field. The tests checked the manifests for name and version only, and `claude plugin validate --strict` doesn't read them: it passes with a corrupt Codex manifest (CONFIRMED).
- Rule going forward: when a Codex manifest changes, compare it with `plugin-creator/references/plugin-json-spec.md` under `~/.codex/.tmp/plugins` and look at the plugin's page in the app.
- Status: open

## 2026-11-08: A placeholder replace rewrote real tokens

- What went wrong: batch F's commit 2f5987b put its new commit's sha into `dev/release-state.md` with a global find-and-replace of a placeholder, `COMMIT`. It also rewrote every real `COMMIT` token in the file: `COMMIT_UNRESOLVED` became `bfa24ad_UNRESOLVED`, the "no COMMITS section" sign in "Load-sensitive tests" became "no bfa24adS section", 21 lines in all. The S5 session saw it on main, and the coordinating session confirmed it. Fixed in PR #20 from 2f5987b's own diff: only lines whose sole change was `COMMIT` to `bfa24ad`.
- Why: the placeholder was a word the file already used, and the commit went in without a look at its diff.
- Rule going forward: a placeholder that a replace fills in must be text that can't match real text (for example `@@SHA@@`), and the diff is read before the commit.
- Status: open

## 2026-11-08: Two sessions started the same four batch sessions

- What went wrong: the triage session asked the user "Push this branch as a dev-only PR, then start the four batch sessions?" in its own next-step box, and the coordinating session asked the same question. The user answered both. Each session then started D, F, O and S, so eight batch sessions ran at once, two per batch, writing the same files on separate branches (CONFIRMED by `list_sessions`, 01:17Z).
- Why: two sessions owned the same step, and neither checked the other's sessions before acting on a yes. A relayed approval arrives a turn late (the same cause as "A push went out before a batch instruction arrived").
- Rule going forward: one session owns each step that starts sessions or pushes. A side session reports and asks only its starter, never the user, about a step its starter owns. Before acting on a yes, `list_sessions {"linked": true}` checks whether that step has already been done.
- Status: promoted to PLAYBOOK (seen twice: relayed instructions arriving after the act)

## 2026-11-08: A size bound passed only on this machine's short paths

- What went wrong: batch F's F4 test asserted that 9 shortened notes fit in injectChars 2000. It passed here and failed on all 3 macOS and 2 Windows CI jobs (2,007 to 2,041 characters). The injection's cut note names the handoff's full path, and the memory path holds the temp path twice, so the framing grows with the temp folder. `TMPDIR=E:\DevTemp` is short. Reproduced here with 15 and 30 more characters of TMPDIR (2,016 to 2,059).
- Why: the bound was checked only with this machine's paths. The same "only checked here" blind spot as the POSIX error codes (above).
- Rule going forward: a test that bounds a text's size, where the text holds a path, is also run with a longer TMPDIR (`--only` with TMPDIR 30 characters longer) and keeps a margin.
- Status: promoted to PLAYBOOK (Writing code, step 3)

## 2026-11-07: Judged a CI cancel too early

- What went wrong: the coordinating session reported that `cancel-in-progress` didn't fire, after watching the older run for 3 minutes. GitHub had cancelled that run about 2.5 minutes after the newer run was created ("Canceling since a higher priority waiting request for tests-14 exists").
- Why: a run's status stays in_progress until every job has stopped, and the macOS and Windows jobs stop slowly.
- Rule going forward: judge a CI setting from the job list after it settles, not from the run status.
- Status: open

## 2026-11-07: A Windows-only check missed what POSIX returns

- What went wrong: batch F's F6 test (CODEX_HOME a file) passed here and would have failed on the 6 Linux and macOS CI jobs. Windows reports the cache under a file as missing (ENOENT), POSIX as not a folder (ENOTDIR), which F7 turned into a second reason. Opus found it in review round 1 by running the code in WSL.
- Why: the code and the test were checked only on Windows. The same blind spot as 0.6.0's F1 on 71d7a78 ("F1's test on Linux and macOS", `dev/release-state.md`).
- Rule going forward: a file-system error path lists what each system returns for it (ENOENT, ENOTDIR, EISDIR, EPERM, EACCES), and the test stubs the other systems' answer (`fs.opendirSync` throwing it) so every system runs the same check.
- Status: promoted to PLAYBOOK (second sighting)

## 2026-11-07: A control timed one step of the path that gives the sign

- What went wrong: batch F's commit-list control timed git's lookup alone (at least 900 ms), so a session start slowed before git (Opus's probe: 3.2 s before `sinceHandoff`) failed the test though only load was behind it. The first replacement, "each late session start took 1.2 s or more", sat 8 ms above the 1,192 ms a forced 0 ms budget's session start took at rest. The second (that floor plus a slow lookup) held at 8 and 16 busy loops only because the first of three starts came in under 1,200 ms (up to 1,184 ms); the duplicate batch-f-2 saw a whole-run floor let a forced 0 ms budget skip at 37 to 68% CPU (CONFIRMED by batch-f-2, not re-run). Fixed in batch F with the launcher's own report (`JBMEM_SHOW_SINCE=1`: time left, budget, git's time): a forced 0 ms budget then failed 14 of 14 at rest and under 16 and 32 busy loops.
- Why: the sign "git ran out of time" comes from the launcher's whole budget (`5000 - elapsed - 1500`, capped at 1.2 s), not from git alone. Any time measured from outside (whole runs, the test's own lookup) grows with load whatever the cause, so it can't tell load from a fault on a busy machine.
- Rule going forward: a time-sign control reads the product's own report of the time each step had and spent, and checks the budget arithmetic against it. Each forced fault is run at rest and under load, before it ships.
- Status: promoted to PLAYBOOK (third sighting, with the two entries below)

## 2026-11-07: A control's floor sat below what the control takes at rest

- What went wrong: batch F's commit-list tests skip when git ran out of time at three session starts in a row and a control (the same lookup, run in the test with 30 s) shows the machine is slow. The first floor, "the control took at least 300 ms", let a forced fault through: with the launcher's budget forced to 0 ms, all 14 tests skipped, since the same lookup took 300 to 744 ms on this machine at rest (other sessions' tests running).
- Why: the floor was a guess at "git is quick", not measured, and not tied to the budget the product had.
- Rule going forward: before choosing a control's bound, run the control at rest and under the forced fault, and tie the bound to the product's budget (here three quarters of the launcher's 1.2 s: the forced 0 ms budget then failed 13 of 14, and 16 busy loops skipped 14 of 14 with controls of 2.4 to 4.2 s).
- Status: promoted to PLAYBOOK (with the entry above, 2026-11-07)

## 2026-11-07: A script edited while a run of it was going

- What went wrong: in batch D, an edit to `dev/release-check.sh` landed while a background `--sums --quick` of it was still running. The run stopped with "syntax error near unexpected token" at a line that parses fine, and its result was lost. The same run's `--sums` had also reordered `SHA256SUMS` under the shell's UTF-8 locale (D4), which the coordinating session noticed in the worktree.
- Why: bash reads a script as it runs it, so an edit shifts the bytes under a running copy. A background check makes this easy to forget.
- Rule going forward: don't edit a script while a run of it is going. Wait for the run, or run a copy. A run that overlapped an edit doesn't count as a check: rerun it.
- Status: open

## 2026-11-07: A commit went in after a failed check (batch O)

- What went wrong: `release-check.sh --sums --quick 2>&1 | tail -9 && git commit ...` committed 8f7894c although the check printed FAIL (8 handoff-checks tests, the listed commit-list load sign; they passed 10 of 10 when rerun with `--only`). In the same batch the first `--sums` wrote `SHA256SUMS` in the locale's order, so 48 lines changed for 8 files (the review-strategy session caught it; batch D's D4).
- Why: a pipeline's status is its last command's, so `tail` hid the check's exit code. And `release-check.sh` sorts the list with a plain `sort`.
- Rule going forward: never chain a commit after a check piped into `tail` or `head`. Run the check, read its summary, then commit. D4 has landed (PR #17 sorts with `LC_ALL=C`); still check `git diff --stat -- SHA256SUMS` against the files you changed.
- Status: open

## 2026-11-07: Escapes in a test's source didn't survive the edit (batch S)

- What went wrong: S1's new test in `codex.test.js` was written with `\u201c`, `\u202e` and similar escapes in an Edit call, and the file got the raw characters, a bidi override among them (Opus round 1, finding 5). A mutation probe's `sed` pattern with `\\u201e` lost its backslashes in a Bash heredoc, so the edit never applied and the test "passed" the mutation.
- Why: the edit tool wrote the escapes as the characters they name. The Bash tool collapses `\\` even in a quoted heredoc (PLAYBOOK's constraints).
- Rule going forward: build non-ASCII and backslash characters in test source with `String.fromCharCode`, and grep the diff for non-ASCII after writing it. A mutation probe checks that its edit applied (count the new text) before reading the result.
- Status: open

## 2026-11-07: The control was a cheaper call than the one it stood in for

- What went wrong: round 1's fix for the busy-lock skip ran the subagent hook as the lock-free control even when the commit hook was the one stopped. The subagent hook takes 30 to 40% of the commit hook's time, so under 24 to 30 busy loops the control would have failed the test on load alone (round 2, A). The same round found that F2's "five tries" also fired on time alone, since both copy walks share one budget (C: 2.4% to 90% of calls in a simulation).
- Why: the control was picked for convenience (one function for both calls), and the try count was picked without asking what else gives the same sign.
- Rule going forward: a control repeats the exact call it controls, with only the suspected cause removed. Before bounding a "can't tell" case by a try count, list every cause that gives that sign, simulate each at a few rates, and make the bound depend on evidence (here: any time reason seen in the window) rather than a count alone.
- Status: promoted to PLAYBOOK (Testing, step 7, 2026-11-07)

## 2026-11-07: A skip on the time sign hid faults that give the same sign

- What went wrong: two of the new load-proof helpers skipped on a fault, not only on load. Review round 1 of `claude/load-proof-tests` found both (F1, F2), and both were reproduced. `hookInTime` read a lock that hung the hook as "the machine is too slow" (with `updateState`'s wait at 20 s the busy-lock test skipped 2 of 2). `copiesInTime` repeated a session start cut short for a reason of its own until 30 s ran out, then skipped (1,708,788 tries in the probe).
- Why: a sign like "the hook was stopped" or "cut short" is what a slow machine shows, but a bug that makes the same call slow or stop shows it too. The every-call-late runs proved some test still fails, not that each skip fires only on load.
- Rule going forward: every skip on a time sign gets a control that only load passes, and a run with a forced non-time fault behind that sign (a hang, a throw) that must fail. Size the control from the budget arithmetic, not "it finished": the busy-lock control fails only when the lock-free run takes under the 9 s limit less the 2 s wait less 1 s. A plain "finished with the lock free" control would fail on a machine where hooks take 8 s, which brings the load sensitivity back.
- Status: promoted to PLAYBOOK (Testing, step 7, 2026-11-07)

## 2026-11-07: A quoted heredoc in the Bash tool still lost a backslash

- What went wrong: an edit script written with `cat > f <<'PYEOF'` in an inline Bash command had `\\n` in a Python literal. Python got `\n` (a real newline), so an anchor didn't match and the script stopped at its own assert before writing anything. A second pair would have written a real newline into a JS string.
- Why: the Bash tool collapses `\\` in the inline command before the shell sees it, quoted heredoc or not. CLAUDE.md says so ("Windows notes"), but only for inline commands in general.
- Rule going forward: any script holding a backslash goes through the Write tool, never a heredoc. The assert-before-write rule is what caught it.
- Status: promoted to PLAYBOOK (its first constraint covers it: a heredoc in the Bash tool is an inline command)

## 2026-11-07: The playbook pointed at an old version's checklist

- What went wrong: the first PLAYBOOK.md said to follow "Release checklist" in `dev/release-state.md`, but that heading appears once per version (0.6.0 at line 536, 0.5.1 at line 580), each with its own version numbers and paths. The docs reviewer caught it.
- Why: the heading was quoted without checking whether it was unique in the file.
- Rule going forward: before pointing a doc at a section by name, grep for the heading and check that it occurs once, or say which one.
- Status: open

## 2026-11-07: A subagent's test output landed on C:

- What went wrong: a review subagent's kept test output went to `C:\Users\willi\AppData\Local\Temp`, not the Dev Drive (`E:\DevTemp`). Reported by the review-strategy session (PR #10 round 5).
- Why: the subagent's Bash has TMPDIR on C:. The user's `TMPDIR=E:\DevTemp` doesn't reach it.
- Rule going forward: a brief that expects the Dev Drive sets `TMPDIR` itself.
- Status: promoted to PLAYBOOK

## 2026-11-07: A cleanup built only from variables was blocked

- What went wrong: `rm -rf "$B/$r"` was blocked by the safety check. Reported by the review-strategy session (PR #10 round 5).
- Why: an empty variable could expand the path toward the root.
- Rule going forward: delete by a literal path, or guard each variable with `${B:?}`.
- Status: open

## 2026-11-07: A reviewer used powershell.exe again

- What went wrong: a reviewer ran a read-only listing through `powershell.exe` instead of `pwsh` and redid it. This was the second slip across sessions. Reported by the review-strategy session.
- Why: the rule is in the user's global CLAUDE.md, but subagents only see their brief.
- Rule going forward: every review brief says to use `pwsh`.
- Status: promoted to PLAYBOOK

## 2026-11-07: A push went out before a batch instruction arrived

- What went wrong: c02207a (a record of the CI failure) was pushed while the coordinating session was writing that everything should go in one batch push with round 3. From the speed-up session's notes.
- Why: relayed instructions arrive a turn late, and Auto-fix had authorized the push itself.
- Rule going forward: while another session runs a review round on this branch, hold pushes for that round's batch unless the user says otherwise.
- Status: open

## 2026-11-07: Probes that measured themselves or the wrong thing

- What went wrong: four probe redos in one session (speed-up session's notes). `ps -ef | grep '[s]leep 26'` counted the probe's own inline command line, so a wait loop never ended. A `C:/...` scratch path in `PATH` split at the colon, so the fake `node` was never found. Git Bash rewrote `/mnt/c/...` arguments to `wsl.exe`. WSL's git couldn't read the worktree's Windows `gitdir`.
- Why: inline commands keep their text in the process list. MSYS treats `:` as the `PATH` separator and converts paths it passes to Windows programs. A worktree's `.git` file holds a Windows path.
- Rule going forward: write probes to script files, and check each probe's counts against a case with a known answer before trusting them. The MSYS and WSL facts are in PLAYBOOK's constraints.
- Status: promoted to PLAYBOOK

## 2026-11-07: Windows frees a stopped process's files late

- What went wrong: after a stop, the EXIT trap's single `rm -rf` left the stopped suite's temp folder in 4 of 5 runs, though no process of the suite was left (speed-up session's notes).
- Why: on Windows a terminated process gives back its file handles a moment after it is gone.
- Rule going forward: cleanup after stopping processes on Windows retries for a few seconds and says when it can't remove the folder.
- Status: promoted to PLAYBOOK

## 2026-11-07: A test's time budget was taken for a fault

- What went wrong: CI failed handoff-checks "copies: the command the note gives ..." once on windows-latest, Node 26 (5a1e1a4). Session start's copy check (`otherCopies`) ran past its 300 ms budget and said it stopped early, which the test didn't accept. The sign was not on the load-sensitive list. The first fix accepted "stopped early", and round 4 found it then also passed an early stop for a reason other than time. Reported by both PR #10 sessions.
- Why: the test checked only the success wording of a check with a time budget, and the loosened branches checked text that always comes with "stopped early".
- Rule going forward: a test that relies on a wall-clock budget handles the out-of-time path or forces the in-time path. When it accepts a designed early stop, it asserts the reason is the designed one, and a probe shows it fails on another reason (here `maxEntries` at 0). Reproduce a timing failure at the call that timed out (budget 0 at session start only), not everywhere: budget 0 everywhere moved the failure to another assertion.
- Status: open. The audit is done on `claude/load-proof-tests` (see "Load-proof tests" in `dev/release-state.md`): its rule held, and the three entries above add to it.

## 2026-11-07: A fix opened a hole next to it (`kill 0` and process groups)

- What went wrong: `release-check.sh`'s Ctrl-C trap ran `kill 0`. Started from another script, it killed that script too (Codex review, reproduced: the wrapper died with 143). PR #10 round 1 gave each suite its own process group (`set -m`). That stopped a terminal hangup (HUP) from reaching the suites, found in round 2 (CONFIRMED by the review-strategy session, not re-run: send HUP to the script's group, and the suites keep running). The stop then needed HUP, a bounded wait and the job table.
- Why: a script started without job control shares its caller's process group. Moving the children out of that group means every stopping signal has to be forwarded, and nobody listed what the old arrangement handled implicitly.
- Rule going forward: when a fix moves processes, files or signals, list what the old arrangement handled implicitly and test each. Never signal group 0 from a script that others call. Start background work in groups of its own, stop them for INT, TERM and HUP, read them from `jobs -rp`, bound the wait, and kill only groups still alive.
- Status: open

## 2026-11-07: Review rounds grew with every fix (PR #10)

- What went wrong: PR #10 (faster checks) took three review rounds in about an hour.
- Why: fixing INFERRED edge cases in `dev/` tooling grew each fix diff, and every relay hop through a coordinating session waited on a turn.
- Rule going forward: in `dev/` tooling, fix only CONFIRMED findings in the batch, and defer INFERRED ones with a repro unless they can change a test result. The owning session may run its review with fresh subagents.
- Status: open. The user approved it on 2026-11-07, to land in `CLAUDE.md` and `tests.yml` after PR #10 merges.

## 2026-11-06: Work stranded across sessions

- What went wrong: review reports sat untracked in worktrees, and a round-8 branch was never pushed. They were rescued into PR #7 by hand.
- Why: one session per item, with no step that checked the other sessions.
- Rule going forward: at each milestone, sweep every project session, branch, worktree and open PR. Every review brief names where its report lands.
- Status: promoted to PLAYBOOK

## 2026-11-06: Fix, scan, fix, scan never converged

- What went wrong: in 0.6.0 (PR #4), each approved scanner comment or finding added code that needed its own round. The user called it "an endless loop".
- Why: findings were fixed one at a time, and each push also cost about 42 minutes of testing (whole-file `--only` runs plus a full check that repeated them).
- Rule going forward: gather a round's findings and comments, fix them in one push, and review that diff once. Per push, run `--only` by test name, then `--sums --quick`, and leave the full suites to CI.
- Status: promoted to PLAYBOOK

## 2026-11-05: Test runs filled the temp folder

- What went wrong: `%TEMP%` held 3,071 `jbmem-*` folders.
- Why: plain `node --test` runs left the folders of failed tests in the system temp folder.
- Rule going forward: run single tests with `dev/release-check.sh --only`, never a plain `node --test`.
- Status: promoted to PLAYBOOK

## 2026-11-05: A timing comparison was confounded by run order

- What went wrong: a 0.6.0 comparison of two versions' timings pointed at the version, but the order of the runs decided which was slowest.
- Why: the runs went in a fixed order, so machine state lined up with one version.
- Rule going forward: alternate which version runs first (A B B A), and log CPU during the runs.
- Status: promoted to PLAYBOOK

## 2026-11-02: A failure was called "flaky"

- What went wrong: the `0.3.4 sweep` test failure was deferred as "flaky, cause hypothesized". The user rejected that.
- Why: the failure was parked without being reproduced or traced to code.
- Rule going forward: keep every run's output, loop the test under the failing conditions until it reproduces, and trace the assertion to code before labeling the cause CONFIRMED.
- Status: promoted to PLAYBOOK

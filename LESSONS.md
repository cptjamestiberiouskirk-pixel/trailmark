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

The entries below were seeded on 2026-11-07 from `dev/release-state.md`, `CLAUDE.md` and the project's saved notes. The 2026-11-07 entries from PR #10 came from the review-strategy session's messages and the speed-up session's notes. They were not re-run here.

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
- Status: open. The load-proof session audits all budgets after PR #10.

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

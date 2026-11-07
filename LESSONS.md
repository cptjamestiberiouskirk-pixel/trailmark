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

The entries below were seeded on 2026-11-07 from `dev/release-state.md`, `CLAUDE.md` and the project's saved notes.

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

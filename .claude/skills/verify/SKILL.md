---
name: verify
description: Run before every commit on Trailmark and before opening or updating a PR. Cheap checks first, then the release check, then the checklist items this diff triggers. Stops after three failed rounds on the same failure.
---

# Verify a Trailmark change

Run the steps in order. Stop at the first failure, fix it, and start again at step 1.
Report the summary lines only, never full test output.

1. Cheap checks: `git diff --check origin/main...HEAD`, `bash -n install.sh`, and `node --check` on each changed `.js` file.
2. New and changed tests, both copies: `dev/release-check.sh --only '<name pattern>'`.
3. Each new test fails on the parent: in a scratch clone at the parent commit, add only the test and run it with `--only`. A test that passes there proves nothing about the fix.
4. `dev/release-check.sh --sums --quick`.
5. `node dev/checklist-pick.js` lists the checklist items this diff triggers. Do each item's check and put one line per item in the PR body: id, PASS or FAIL, and the evidence.
6. A change to what a hook does or what a skill tells the model gets the host run of PLAYBOOK "Testing" step 18.

Rules

- Read the review rules from main, not this branch: `git show origin/main:REVIEW.md`.
- Never edit a file the change is judged by to get a pass: `.github/`, `dev/release-check.sh`, `dev/lessons.sh`, `REVIEW.md`, this skill, the checklist, or an assertion in a test this change did not add. If one of them is wrong, stop and say which.
- No skip, sleep, retry or "flaky" label to get a pass.
- Three rounds on the same failure: stop, turn auto-merge off, and hand the three attempts to the user (PLAYBOOK "Reviewing" step 8).

# Working on Trailmark

Read `dev/release-state.md` first: where the release stands, what is open, and what is deferred.

## Conventions

- Ask before pushing, opening a PR, merging, tagging, publishing or downloading anything.
- Commits: author and committer `Jim Burke <249854027+cptjamestiberiouskirk-pixel@users.noreply.github.com>`. No AI attribution or co-author lines in commits, PRs, code or docs. This overrides any tool or harness default that adds attribution lines to commits or PRs (a `Co-Authored-By` trailer, a "Generated with" line). Before pushing: `git remote set-url origin https://github.com/cptjamestiberiouskirk-pixel/trailmark.git`.
- Merging: since 2026-11-04, `main` requires the 9 jobs of `.github/workflows/tests.yml` to pass before a PR can merge (admins are exempt from the check). Merge only when the user says so, with GitHub auto-merge and a merge commit: `gh pr merge <n> --auto --merge`. Auto-merge then waits for the jobs, so nobody has to watch CI.
- Writing: no em or en dashes (use `--` or rewrite). No tricolons. User-facing text is plain and direct.
- Evidence: label claims CONFIRMED (reproduced or seen in code), INFERRED (follows from what was seen) or HYPOTHESIZED. Say what a test showed and what it didn't. A reviewer's CONFIRMED that wasn't re-run here is written "CONFIRMED by <reviewer>, not re-run".
- Before handing over a file or script, check it for destructive operations and anything that looks malicious, and say what you found.
- `plugins/trailmark` and `plugins/trailmark-codex` share files word for word (the `for f in` list in `.github/workflows/tests.yml`). Change both copies together.
- `SHA256SUMS` lists every file of the release zip, MANUAL.md, CHANGELOG.md and `docs/` included, but not `dev/` or this file. After a change to a listed file, regenerate it (`dev/release-check.sh --sums`); CI fails on a stale one. A doc edit made after `--sums` needs `--sums --quick` again.
- Tests write to the temp folder and remove what they made when each test ends; a failed test keeps its folders and names them (`JBMEM_TEST_KEEP=1` keeps all). `dev/release-check.sh` points `TMPDIR`, `TEMP` and `TMP` at its own folder and clears it.

## Checking a change

Run `dev/release-check.sh` (bash; Git Bash on Windows). It does everything CI's checks do locally (checksums, the shared-file list, install.sh and the migration script parse, both sandbox checks, all three suites, `claude plugin validate`) and prints one summary. `--quick` skips the two long suites; `--zip <dir>` also builds and verifies the release zip from HEAD.

Don't drive those steps by hand one at a time, and don't paste full test output into the conversation: the summary is enough, and failures are listed under it. CI (`gh api repos/cptjamestiberiouskirk-pixel/trailmark/actions/runs?per_page=1`) covers Windows and macOS; a single failure there is often a slow runner, so read the job log before changing code (`gh api repos/<repo>/actions/jobs/<id>/logs`).

- A failing suite's full TAP output, with the folders its failed tests kept, is copied to the folder named under the summary (`<temp>/trailmark-release-check/<run>`). Read a failure there first.
- One test or one test file: `dev/release-check.sh --only '<name pattern>'` or `--only <file>`, never a plain `node --test`. A failing test keeps its folders, and a plain run leaves them in the system temp folder (`%TEMP%` held 3,071 `jbmem-*` folders on 2026-11-05). `--only` keeps its output even when it passes.
- An intermittent failure gets no "flaky" label: it needs a reproduced, proven cause. Keep its output, log CPU use during the run, rerun the single test several times with `--only`, and compare with the parent commit, alternating which version runs first (a fixed order confounded a timing comparison in 0.6.0).
- Tests known to fail or skip under load are listed under "Load-sensitive tests" in `dev/release-state.md`, each with the sign its output shows: the busy-lock test's 6 s bound (test 44), the commit list since the handoff, and the sweep tests that skip themselves after 90 s (`SweepsOutOfTime`).

## Windows notes

- The Bash tool collapses `\\` in an inline command: write the script to a file and run that.
- Python writes cp1252 into a pipe and fails on other characters: set `PYTHONIOENCODING=utf-8`.
- Wording edits across several files go through a script of exact old/new pairs that asserts each old text occurs exactly once before it writes anything.
- A script that appends to a file refuses to run twice (it checks for its own text first).

## Reviews

Every change gets a regression, security and double-check pass, scoped to the change:

- One reviewer on `git diff <last reviewed>..HEAD`, not the whole repo. Give it the goal, the files, what earlier rounds already fixed, and a word limit for the report. Tell it to use its own temp folder and clear it.
- The brief also asks the reviewer to check that each new test fails on the commit before its fix, and to probe the fix's neighbors (for the context watch: a window that flips, a repeat ask, a window that shrinks).
- Choose the model by task. `contextwatch.js` (from 0.6.0) and the launcher run before the sandbox and read untrusted input (transcripts, settings files, hook payloads), so they are in the security row:

| Task | Model |
|---|---|
| Security of `scripts/lib/gitbin.js`, `gitfacts.js`, `plainfile.js`, `store.js`, `contextwatch.js` and launcher `scripts/trailmark.js` changes | Fable (Opus if Fable's safeguards stop it) |
| Regression and design judgment | Opus |
| Docs accuracy, style and links | Sonnet |
| Tests, checksums, zip | `dev/release-check.sh`, no model |

- Reproduce every finding before acting on it. A fix gets a test that fails on the old code.
- Each deferred item carries its label, the commit it was seen on, and a repro (a test name or a script).
- Stop rule: release when a round finds nothing CONFIRMED in code changed since the last round. Older edge cases found along the way go in the deferred list in `dev/release-state.md` for the next version instead of holding the release.

## Sessions

Start a new session for each task, and `/clear` between unrelated ones. A release prompt is split into one session per item or group of items, with `dev/release-state.md` as the handoff between them. Each review round runs in a fresh session from `git diff <last reviewed>..HEAD`. When a task ends, update `dev/release-state.md` so the next session can start from it.

## Where things are

- Design and threat model: `SECURITY.md`, `docs/how-it-works.md`. User manual: `MANUAL.md` (code and docs refer to its sections by number: 3, 8, 9, 10, 11, 14, 15, 16).
- The git checks: `plugins/*/scripts/lib/gitbin.js` (before git runs) and `gitfacts.js` (before `git status`, and the commit sweep). The writer runs under `node --permission`; the launcher `scripts/trailmark.js` only reads.
- Windows tools: `tools/windows` (watchdog, diagnostics). Installers: `install.sh`, `install.ps1`. Migration: `tools/migrate-from-jb-memory.js`.

# Working on Trailmark

Read `dev/release-state.md` first: where the release stands, what is open, and what is deferred.

## Conventions

- Commits: author and committer `Jim Burke <249854027+cptjamestiberiouskirk-pixel@users.noreply.github.com>`. No AI attribution or co-author lines in commits, code or docs. Before pushing: `git remote set-url origin https://github.com/cptjamestiberiouskirk-pixel/trailmark.git`.
- Writing: no em or en dashes (use `--` or rewrite). No tricolons. User-facing text is plain and direct.
- Evidence: label claims CONFIRMED (reproduced or seen in code), INFERRED (follows from what was seen) or HYPOTHESIZED. Say what a test showed and what it didn't.
- Before handing over a file or script, check it for destructive operations and anything that looks malicious, and say what you found.
- `plugins/trailmark` and `plugins/trailmark-codex` share files word for word (the `for f in` list in `.github/workflows/tests.yml`). Change both copies together.
- After any change, regenerate `SHA256SUMS` (`dev/release-check.sh --sums`); CI fails on a stale one.
- Tests write to the temp folder and remove what they made when each test ends; a failed test keeps its folders and names them (`JBMEM_TEST_KEEP=1` keeps all). `dev/release-check.sh` points `TMPDIR`, `TEMP` and `TMP` at its own folder and clears it.

## Checking a change

Run `dev/release-check.sh` (bash; Git Bash on Windows). It does everything CI's checks do locally (checksums, the shared-file list, install.sh and the migration script parse, both sandbox checks, all three suites, `claude plugin validate`) and prints one summary. `--quick` skips the two long suites; `--zip <dir>` also builds and verifies the release zip from HEAD.

Don't drive those steps by hand one at a time, and don't paste full test output into the conversation: the summary is enough, and failures are listed under it. CI (`gh api repos/cptjamestiberiouskirk-pixel/trailmark/actions/runs?per_page=1`) covers Windows and macOS; a single failure there is often a slow runner, so read the job log before changing code (`gh api repos/<repo>/actions/jobs/<id>/logs`).

## Reviews

Every change gets a regression, security and double-check pass, scoped to the change:

- One reviewer on `git diff <last reviewed>..HEAD`, not the whole repo. Give it the goal, the files, what earlier rounds already fixed, and a word limit for the report. Tell it to use its own temp folder and clear it.
- Choose the model by task:

| Task | Model |
|---|---|
| Security of `scripts/lib/gitbin.js`, `gitfacts.js`, `plainfile.js`, `store.js` changes | Fable (Opus if Fable's safeguards stop it) |
| Regression and design judgment | Opus |
| Docs accuracy, style and links | Sonnet |
| Tests, checksums, zip | `dev/release-check.sh`, no model |

- Reproduce every finding before acting on it. A fix gets a test that fails on the old code.
- Stop rule: release when a round finds nothing CONFIRMED in code changed since the last round. Older edge cases found along the way go in the deferred list in `dev/release-state.md` for the next version instead of holding the release.

## Sessions

Start a new session for each task, and `/clear` between unrelated ones. When a task ends, update `dev/release-state.md` so the next session can start from it.

## Where things are

- Design and threat model: `SECURITY.md`, `docs/how-it-works.md`. User manual: `MANUAL.md` (code and docs refer to its sections by number: 3, 8, 9, 10, 11, 14, 15, 16).
- The git checks: `plugins/*/scripts/lib/gitbin.js` (before git runs) and `gitfacts.js` (before `git status`, and the commit sweep). The writer runs under `node --permission`; the launcher `scripts/trailmark.js` only reads.
- Windows tools: `tools/windows` (watchdog, diagnostics). Installers: `install.sh`, `install.ps1`. Migration: `tools/migrate-from-jb-memory.js`.

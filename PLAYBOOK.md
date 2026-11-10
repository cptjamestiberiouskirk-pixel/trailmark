# PLAYBOOK

The current best way to do Trailmark's recurring work. For development only: `export-ignore` in `.gitattributes` keeps it out of the release zip and out of `SHA256SUMS`.

Run the lessons check below before each significant step. `CLAUDE.md` holds the user's rules and `dev/release-state.md` holds where the release stands. When this file disagrees with either one, they win and this file gets fixed.

## The lessons check

Run it before each of these: a design decision, a code change, a test run, a review brief, acting on a review finding, a push, a merge, a tag or a publish.

1. Get the rules. At the start of a session and after a compaction: `dev/lessons.sh` (every open rule). Before a later step: `dev/lessons.sh <words>`, with the step's topics (`commit`, `regex`, `review`). The steps in this file count too.
2. Write one line before acting, where the user can see it: `Lessons checked: <the rules that apply>`, or `Lessons checked: none apply`.
3. Follow each rule named. One that can't be followed goes to the user, with the reason, before the step.
4. After the step, report pass, fail or untested for each rule named.
5. Anything that broke, needed a redo, surprised you or drew a correction gets an entry in `LESSONS.md` before the next step. `dev/release-check.sh` fails on a broken entry (`dev/lessons.sh --check`).
6. A PR body ends with its `Lessons checked:` line, and a review brief tells the reviewer to run step 1.
7. A lesson seen twice, or clearly general, becomes a step here and is marked "promoted".

Limit: a session follows this by hand. Only the format in step 5 is checked by a tool.

## Constraints and known limits

- Windows, Git Bash: the Bash tool collapses `\\` in an inline command. Write the script to a file and run that.
- Python writes cp1252 into a pipe: set `PYTHONIOENCODING=utf-8`.
- MSYS splits `PATH` at `:`, so a `C:/...` entry breaks: put `cygpath -u` paths in `PATH`. It also rewrites path arguments to Windows programs: call `wsl.exe` with `MSYS_NO_PATHCONV=1`. WSL's git can't read a worktree's Windows `gitdir`: clone for WSL from the main repository's `.git`.
- A `cd` in one Bash call moves the calls after it: use absolute paths or `git -C`, and `cd` only to the worktree's root.
- An inline command's text shows in the process list, so `ps | grep` probes match themselves: write probes to script files.
- Windows gives back a killed process's file handles a moment after it exits: cleanup after a stop retries for a few seconds.
- PowerShell means `pwsh` (7), never `powershell.exe` (5.1), `gsudo` runs and `-File` scripts included.
- Node's `os.tmpdir()` uses `TEMP`/`TMP` on Windows, not `TMPDIR`. The user's `TMPDIR=E:\DevTemp` reaches tests only through `dev/release-check.sh`.
- Defender's MPLog is readable only by administrators. The user runs elevated scripts. Claude can't.
- Junction tests on Windows: libuv can fail with `EBUSY`/`EPERM` while the machine is busy (B8, `dev/release-state.md`). A deep temp path can also refuse init ("Windows, long paths").
- The writer runs under `node --permission`: it writes only in the memory folder and can't start programs. The launcher `scripts/trailmark.js` only reads.
- Codex: the memory folder is outside the workspace, so the sandbox refuses a checkpoint's first write and the skill asks for approval, unless the folder is a writable root (MANUAL.md section 3, the Codex README step 3).
- `main` requires the 9 jobs of `tests.yml`. Never add `paths-ignore`: a skipped workflow leaves the required jobs pending forever.
- Load-sensitive tests: the list lives under "Load-sensitive tests" in `dev/release-state.md`. Read it there, not from a copy.

## Do not attempt

- A plain `node --test`: it leaves `jbmem-*` folders in the system temp folder. Use `dev/release-check.sh --only`.
- Calling a failure "flaky", or adding a test to the load-sensitive list, without a reproduced cause.
- Pushing, opening a PR, merging, tagging, publishing or downloading anything without the user's word. A merge, tag or publish is asked for by name, as its own question, and run as its own command.
- Attribution lines (`Co-Authored-By`, "Generated with") in commits, PRs, code or docs.

## Planning a change

1. Read `dev/release-state.md`, then the code the change touches. Notes go stale: check them against the code.
2. Write the goal as a result you can check, and list what must not change.
3. Keep one purpose per change. A shared file in `plugins/trailmark` means the same edit in `plugins/trailmark-codex` (the `for f in` list in `tests.yml`).
4. During a frozen release, only a CONFIRMED regression in the last diff gets in. Everything else goes to the deferred list with its label, commit and repro.

## Writing code and docs

1. Match the file's existing style. Docs: no em or en dashes (use `--`), no tricolons, plain words.
2. A bug fix comes with a test that fails on the old code. Run it on the parent commit to prove that.
3. A file-system error path: list what Windows, Linux and macOS each return for it (ENOENT, ENOTDIR, EPERM, ...). This machine runs only Windows, so the test stubs the other systems' answer. A test that bounds the size of a text holding a path also runs with a TMPDIR 30 characters longer: CI's temp paths are longer than `E:\DevTemp`.
4. Wording edits across several files go through a script of exact old/new pairs that asserts each old text occurs once before it writes. Old text with backslashes or `\n` in it (code, tests) doesn't go in such a script: use the Edit tool on one copy and copy the file to the other, or swap a block between two plain markers from a text file.
5. Before handing over a script or file, read it for destructive or malicious operations, and say what you found.
6. After fixing a pattern, search the whole repo for that pattern before the first review.
7. A condition that skips a block, or code moved out of one: list each thing the block does in each case and ask whether the condition is about that thing. A value read before a lock can be older than the state under it: try the other order.

## Testing

1. New and changed tests: `dev/release-check.sh --only '<name pattern>'` (it runs both copies).
2. Then `dev/release-check.sh --sums --quick`. A doc edit after `--sums` needs `--sums --quick` again.
3. Leave the full suites to CI (three systems, three Node versions).
4. A failure: read the kept TAP output under `<temp>/trailmark-release-check/<run>` first. Compare its sign with the load-sensitive list. A sign not on the list is a new failure.
5. Intermittent failure: keep every run's output, log CPU, rerun with `--only` several times, and compare with the parent commit, alternating which runs first.
6. Report each item as pass, fail or untested, with what the test showed and what it didn't.
7. A test that skips on a time sign: its control repeats the exact call, covers every step whose time can give the sign, and takes its bounds from the product's budget. Prefer the product's own report of each step's time left and spent (a `JBMEM_SHOW_*` stderr line that only reports) over times measured from outside, which grow with load whatever the cause. Before it ships, run a forced non-time fault (must fail) at rest and under busy loops, and each step forced slow (must skip).
8. Read why each new test fails on the old code: a failure for another reason proves nothing. Remove each part of a fix alone and check that a test fails. An assertion that something didn't happen gets its own forced fault.
9. A search that finds nothing proves nothing until the input is shown to exist and the search to work (a download that failed, a grep that errored).
10. A validator's negative cases include inputs one small edit away from valid, what happens to the data after a line it doesn't recognize, and state left open when the input ends.
11. A limit on a count or on counted work: before it is written down, time the dearest thing one counted item can be (a folder to list, not a file's name; a disk lookup, not text) at the limit itself, on Windows and Linux.

## Committing

1. A commit goes in a later message than the edits it depends on, after they succeeded.
2. Never chain a commit after a check piped into `tail` or `head`: read the check's summary, then commit.

## Reviewing

1. One reviewer per row the diff touches (model table in `CLAUDE.md`), on `git diff <last reviewed>..HEAD` only.
2. The brief gives the goal, the files, what earlier rounds fixed, a word limit, its own temp folder, and where the report lands (the owning branch's next batch push). It also says to use `pwsh`, never `powershell.exe`, and sets `TMPDIR=E:\DevTemp` itself when kept output should land on the Dev Drive (a subagent's Bash has TMPDIR on C:).
3. Tell the reviewer to read `PLAYBOOK.md` and `LESSONS.md` first.
4. Reproduce every finding before acting on it.
5. Gather a round's findings plus the scanner and Copilot comments on that head, fix them in one push, then review that push once.

## Releasing

Follow the current version's "Release checklist" in `dev/release-state.md`. Older versions keep their own checklists there, with their own version numbers and paths: don't follow those. Then:

1. `dev/release-check.sh --zip <dir>` from a clean tree at the release commit. Record the commit and the zip's sha256 in `dev/release-state.md`.
2. Check the zip holds the change: unzip it and search for a string only the change adds. Check that `CLAUDE.md`, `PLAYBOOK.md`, `LESSONS.md` and `dev/` are absent.
3. After publishing, download the assets back and run `sha256sum -c`.
4. `.github/workflows/release-draft.yml` puts the zip of a version with no tag in a draft release after each push to `main`, replacing an earlier push's draft. Steps 1 and 2 can use the draft's zip instead of a local build. Publishing the draft makes the tag, and that stays the user's word. The job doesn't wait for `tests.yml`, so check that its jobs passed on that commit before publishing. A draft with the job's hidden mark in its notes is replaced by the next push, edited notes included. A draft without the mark stops the job with nothing changed.

## At each milestone

1. Sweep every project session, branch, worktree and open PR: unpushed work, untracked reports, pending asks.
2. One session owns each step that starts sessions, pushes or merges. A side session asks only its starter about such a step, not the user, and anyone acting on a yes first checks `list_sessions {"linked": true}` for the same step already done.
3. Update `dev/release-state.md` so the next session can start from it.
4. Log any mistake, redo or surprise in `LESSONS.md` right away. A lesson seen twice, or clearly general, becomes a step here and is marked "promoted".
5. A session that ends on an error (a request timeout, say) is resumed at once by the session that started it: check that its branch and worktree are intact, then send it the next step. A review whose report never arrived is run again. Sessions commit before starting a long review, so a stop can lose only that review.
6. When one session changes another session's PR (auto-merge, a merge), it tells that session in the same step.
7. Nothing wakes a session when a PR merges, and sessions don't poll CI. A session never promises to report on something that can't wake it. Its closing line says who acts next and what triggers that.

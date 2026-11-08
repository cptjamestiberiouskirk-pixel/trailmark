# PLAYBOOK

The current best way to do Trailmark's recurring work. For development only: `export-ignore` in `.gitattributes` keeps it out of the release zip and out of `SHA256SUMS`.

Re-read this file and the latest `LESSONS.md` entries before each significant step (a design decision, a code change, a test run, a release, a deliverable). `CLAUDE.md` holds the user's rules and `dev/release-state.md` holds where the release stands. When this file disagrees with either one, they win and this file gets fixed.

## Constraints and known limits

- Windows, Git Bash: the Bash tool collapses `\\` in an inline command. Write the script to a file and run that.
- Python writes cp1252 into a pipe: set `PYTHONIOENCODING=utf-8`.
- MSYS splits `PATH` at `:`, so a `C:/...` entry breaks: put `cygpath -u` paths in `PATH`. It also rewrites path arguments to Windows programs: call `wsl.exe` with `MSYS_NO_PATHCONV=1`. WSL's git can't read a worktree's Windows `gitdir`: clone for WSL from the main repository's `.git`.
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
- Pushing, opening a PR, merging, tagging, publishing or downloading anything without the user's word.
- Attribution lines (`Co-Authored-By`, "Generated with") in commits, PRs, code or docs.

## Planning a change

1. Read `dev/release-state.md`, then the code the change touches. Notes go stale: check them against the code.
2. Write the goal as a result you can check, and list what must not change.
3. Keep one purpose per change. A shared file in `plugins/trailmark` means the same edit in `plugins/trailmark-codex` (the `for f in` list in `tests.yml`).
4. During a frozen release, only a CONFIRMED regression in the last diff gets in. Everything else goes to the deferred list with its label, commit and repro.

## Writing code and docs

1. Match the file's existing style. Docs: no em or en dashes (use `--`), no tricolons, plain words.
2. A bug fix comes with a test that fails on the old code. Run it on the parent commit to prove that.
3. A file-system error path: list what Windows, Linux and macOS each return for it (ENOENT, ENOTDIR, EPERM, ...). This machine runs only Windows, so the test stubs the other systems' answer.
4. Wording edits across several files go through a script of exact old/new pairs that asserts each old text occurs once before it writes.
5. Before handing over a script or file, read it for destructive or malicious operations, and say what you found.

## Testing

1. New and changed tests: `dev/release-check.sh --only '<name pattern>'` (it runs both copies).
2. Then `dev/release-check.sh --sums --quick`. A doc edit after `--sums` needs `--sums --quick` again.
3. Leave the full suites to CI (three systems, three Node versions).
4. A failure: read the kept TAP output under `<temp>/trailmark-release-check/<run>` first. Compare its sign with the load-sensitive list. A sign not on the list is a new failure.
5. Intermittent failure: keep every run's output, log CPU, rerun with `--only` several times, and compare with the parent commit, alternating which runs first.
6. Report each item as pass, fail or untested, with what the test showed and what it didn't.
7. A test that skips on a time sign: its control repeats the exact call, covers every step whose time can give the sign, and takes its bounds from the product's budget. Before it ships, run it at rest, under busy loops, with a forced non-time fault (must fail) and with each step forced slow (must skip). Each bound keeps a margin over what the forced fault takes at rest.

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

## At each milestone

1. Sweep every project session, branch, worktree and open PR: unpushed work, untracked reports, pending asks.
2. Update `dev/release-state.md` so the next session can start from it.
3. Log any mistake, redo or surprise in `LESSONS.md` right away. A lesson seen twice, or clearly general, becomes a step here and is marked "promoted".

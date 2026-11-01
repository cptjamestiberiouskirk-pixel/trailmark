# Contributing

Bug reports and fixes are welcome. For anything that could let a repo, a web page or another program run code or change memory through Trailmark, don't open a public issue. Report it privately as [SECURITY.md](SECURITY.md) describes.

## Running the tests

The tests use Node's built-in test runner, so there are no dependencies to install. Use a Node release at or above the security floor (22.23.4, 24.22.1 or 26.12.1); on an older one the sandbox check warns. From the repository root:

```text
node --test plugins/trailmark/tests/trailmark.test.js plugins/trailmark/tests/handoff-checks.test.js
node --test plugins/trailmark-codex/tests/trailmark.test.js plugins/trailmark-codex/tests/handoff-checks.test.js
node plugins/trailmark/scripts/trailmark.js --sandbox-check
node plugins/trailmark-codex/scripts/trailmark.js --sandbox-check
```

Running `node --test tests/*.test.js` from inside a plugin folder does the same for that copy.

The tests create throwaway repos in the temp folder and never touch your own Claude Code settings. Set `TMPDIR` (or `TEMP` on Windows) to put them somewhere else. Some tests skip themselves, most of them saying why:

- On Windows, tests that need a shell script run in place of git, or that make symbolic links (which needs Developer Mode), are skipped. So are the bash and sh steps when Git's `bin` folder isn't on PATH.
- Two tests need a filesystem that keeps raw bytes in file names, so they skip on Windows and macOS.
- The Git LFS test skips when git-lfs isn't installed.
- One test needs POSIX permissions and a user other than root.

CI (`.github/workflows/tests.yml`) runs on Linux, macOS and Windows with Node 22, 24 and 26. Every job runs both test suites and the sandbox check for both copies; the sandbox check fails the job if it prints a WARN line. On Windows, CI also parses every PowerShell script with Windows PowerShell 5.1 and PowerShell 7, and runs the watchdog's own test (it reports without failing the job, since two of its checks need a desktop).

Once per run, on Linux with Node 24, a "Repository checks" step:

- checks `SHA256SUMS` (`sha256sum --quiet -c SHA256SUMS`);
- parses `install.sh` (`bash -n`);
- checks that `tools/migrate-from-jb-memory.js` parses and that its `--help` runs;
- compares the files the two plugin copies share word for word (see below).

The scripts in `tools/windows` that call the model (`test-trailmark-roundtrip.ps1`, `test-trailmark-sessions.ps1`, `verify-trailmark-hooks.ps1`) check the hooks end to end with a real Claude Code. They use `claude -p` and your own account, so they aren't part of CI. MANUAL.md, section 11, lists every script and what it changes.

## The two plugin copies

`plugins/trailmark-codex` is a separate copy of the Claude Code plugin's code. A fix to shared code needs the same fix in both copies, and both test suites must pass.

These files must be identical in both copies, and CI fails when one differs (the list is the `for f in ...` loop in the "Repository checks" step of `.github/workflows/tests.yml`; keep it in step when you add a shared file):

```text
LICENSE
scripts/hook-milestone.js
scripts/hook-precompact.js
scripts/lib/commands.js
scripts/lib/gitbin.js
scripts/lib/gitfacts.js
scripts/lib/health.js
scripts/lib/hookio.js
scripts/lib/plainfile.js
tests/handoff-checks.test.js
```

The other files differ on purpose. Codex-specific code is in `scripts/lib/host.js`, which only the Codex copy has, and in the lines of its `scripts/trailmark.js` marked "Codex:". `scripts/lib/transcript.js`, `hooks/hooks.json`, the skills (`skills/<name>` in the Claude Code copy, `skills/tm-<name>` in the Codex copy) and `tests/trailmark.test.js` differ more. There are smaller differences in `hook-session-start.js`, `hook-commit-start.js`, `memory.js`, `lib/paths.js` and `lib/store.js`. When you change one of these, check whether the other copy needs the same change.

## Sending a change

- Keep each pull request to one change, with a test that fails without it.
- Raise the version in the plugin's `plugin.json` and add a CHANGELOG entry. The plugin directory picks up a new version only when that number changes. The Codex copy has its version in both `plugins/trailmark-codex/plugin.json` and `plugins/trailmark-codex/.codex-plugin/plugin.json`.
- Run `claude plugin validate .`, `claude plugin validate plugins/trailmark` and `claude plugin validate plugins/trailmark-codex`.
- Regenerate `SHA256SUMS` from the repository root, after your change is staged or committed so that `git ls-files` lists every file:

  ```text
  git ls-files | grep -v '^SHA256SUMS$' | sort | sed 's|^|./|' | xargs sha256sum > SHA256SUMS
  ```

- Keep the sandbox rule: the launcher (`scripts/trailmark.js`) only reads, and only the script it starts under Node's permission model writes, inside the repo's memory folder. Anything new that reads a path from the memory folder or from command text treats it as untrusted, as SECURITY.md describes.

## Docs

Write plainly, in short sentences. Say what something does and what it doesn't. When a behavior was seen only on one platform or one version, say which.

Other files point at MANUAL.md by section number (sections 3, 8, 9, 10, 11, 14, 15 and 16) and at SECURITY.md's "Known limits", so keep those numbers and headings when you edit, or update the references too.

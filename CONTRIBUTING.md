# Contributing

Bug reports and fixes are welcome. For anything that could let a repo, a web page or another program run code or change memory through Trailmark, don't open a public issue: report it privately as [SECURITY.md](SECURITY.md) describes.

## Running the tests

Everything runs on Node's built-in test runner, with no dependencies to install. From the repository root:

```text
node --test plugins/trailmark/tests/trailmark.test.js plugins/trailmark/tests/handoff-checks.test.js
node --test plugins/trailmark-codex/tests/trailmark.test.js plugins/trailmark-codex/tests/handoff-checks.test.js
node plugins/trailmark/scripts/trailmark.js --sandbox-check
node plugins/trailmark-codex/scripts/trailmark.js --sandbox-check
```

The tests create throwaway repos in the temp folder and never touch your own Claude Code settings. A few tests need a shell script to stand in for git, which Windows can't run; they skip themselves there and say why.

CI (`.github/workflows/tests.yml`) runs all of this on Linux, macOS and Windows with Node 22, 24 and 26. On Windows it also parses every PowerShell script with Windows PowerShell 5.1 and PowerShell 7, and runs the watchdog's own test. Once per run it checks `SHA256SUMS`, parses `install.sh`, and fails if a file the two plugin copies share word for word differs between them.

The scripts in `tools/windows` that call the model (`test-trailmark-roundtrip.ps1`, `test-trailmark-sessions.ps1`, `verify-trailmark-hooks.ps1`) check the hooks end to end with a real Claude Code. They use `claude -p` and your own account, so they aren't part of CI. MANUAL.md, section 11, lists every script and what it changes.

## The two plugin copies

`plugins/trailmark-codex` is a separate copy of the Claude Code plugin's code. What differs is mostly in `scripts/lib/host.js`, the lines in `scripts/trailmark.js` marked "Codex:", `scripts/lib/transcript.js`, `hooks/hooks.json` and the skills, with smaller differences in `hook-session-start.js`, `hook-commit-start.js`, `paths.js`, `store.js` and `memory.js`. The CI step "Repository checks" lists the files that must stay identical. A fix to the shared code needs the same fix in both copies. `tests/handoff-checks.test.js` is the same file in both, and both test suites must pass.

## Sending a change

- Keep each pull request to one change, with a test that fails without it.
- Raise the version in the plugin's `plugin.json` and add a CHANGELOG entry. The plugin directory picks up a new version only when that number changes.
- Run `claude plugin validate .`, `claude plugin validate plugins/trailmark` and `claude plugin validate plugins/trailmark-codex`.
- Regenerate `SHA256SUMS` from the repository root:

  ```text
  find . -path ./.git -prune -o -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  ```

- Keep the sandbox rule: the launcher (`scripts/trailmark.js`) only reads, and only the script it starts under Node's permission model writes, inside the repo's memory folder. Anything new that reads a path from the memory folder or from command text treats it as untrusted, as SECURITY.md describes.

## Docs

Write plainly, in short sentences. Say what something does and what it doesn't. When a behavior was seen only on one platform or one version, say which.

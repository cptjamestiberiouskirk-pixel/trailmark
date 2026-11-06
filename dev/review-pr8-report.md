Holds the merge on wording only: 3 CONFIRMED inaccuracies in the PR's own docs and one comment (F1 to F3). No code finding: the security and regression passes found nothing CONFIRMED in the changed code.

# Review of PR #8, `git diff 03da9fd..a6a025b`

Reviewers: security (Fable), regression (Opus), docs (Sonnet), on 2026-11-06, on Windows 11 with Node 26.13. Under the stop rule, F1 to F3 are CONFIRMED findings in changed text. They change no behavior. Fixing them takes one docs commit, `--sums`, and a Sonnet docs pass on that commit. The user decides whether they hold the merge or go in after it.

## Findings

**F1. CONFIRMED (re-read in code here).** `docs/how-it-works.md:219` says the hook script gets "never a tool's result or a prompt". `hookInput` keeps `tool_response.interrupted`, `exit_code` and `exitCode` (`EXIT_FIELDS`, `plugins/*/scripts/lib/hookio.js:30`). Prompt text and tool output are dropped.
- Fix: "no prompt text and no tool output, only a result's exit fields".

**F2. CONFIRMED (re-run here).** `CHANGELOG.md:14` ("A command over 30,000 characters starts no hook script") and `docs/how-it-works.md:219` ("a command that long") misstate the cap. The cap is on the JSON text handed over (`plugins/*/scripts/trailmark.js:188`, `payload.length > PAYLOAD_MAX`). The other fields and JSON escaping count toward it.
- Repro: `hookInput({tool_input:{command:'"'.repeat(16000)}}).length` is 32,029. A 16,000-character command is skipped.
- Fix: "A hook whose payload would be over 30,000 characters (in practice, a very long command) isn't started, and the launcher says so on stderr. The tool call goes on."
- Same entry: the first Hooks bullet is one sentence of about 90 words. Split it after "(seen in CI)" (docs reviewer, CLAUDE.md "plain and direct").

**F3. CONFIRMED (re-run here).** The comment at `plugins/*/scripts/lib/hookio.js:20` says "memoryDirOrExit above". That function is defined below, at line 49. Change it to "below" in both copies, since the file is shared word for word.

## Checked and found sound

- **Forging.** Settings can't forge `JBMEM_PAYLOAD`, `JBMEM_FROM` or `JBMEM_FROM_ID`: they are deleted at `trailmark.js:37` (Codex :39), before `fastPath`, and honored only with `JBMEM_LAUNCHED=1`, which only `run()` sets. CONFIRMED by Fable, not re-run.
- **Who sees the payload.** Git run by the launcher never sees it, and sandboxed scripts can't spawn. CONFIRMED in code by Fable. The command in env is INFERRED to be no new exposure, since same-user processes can read the transcript.
- **`--from` reopen.** On Windows, `dev:ino` (bigint on both sides) matches across processes. A recreate, a hard link or another volume is refused. A junction swapped into a parent folder is followed (`O_NOFOLLOW` is 0 there), but only the checked file's ID matches. CONFIRMED by Fable's repro, not re-run.
- **Field coverage.** Every payload field the hook scripts read, in both copies, is kept, and Codex normalizes before `hookInput`. CONFIRMED: my grep and Fable's.
- **New tests.** 7/7 pass at a6a025b. CONFIRMED, re-run here (`--only '^0\.6\.0 (hooks:|context watch: the hook gets|write-handoff and park: a 124k)'`, output in `<temp>/trailmark-release-check/20261106-175132-1868`). All 7 fail on the 03da9fd scripts in both copies, and the write-handoff test fails at a778ace with the `handoff.md` EPERM. CONFIRMED by Opus, not re-run.
- **Copies.** The shared `hookio.js` and `handoff-checks.test.js` are identical, and the `memory.js` diff is the same in both. CONFIRMED by Opus.
- **Inherited stdin.** On Windows, a closed fd 0, an empty pipe, a tty and 200k of text behave as before. A stdin that never closes now stops at 120 s instead of blocking forever. CONFIRMED by Opus, not re-run.
- **Context watch and the trust docs.** The context-watch files are unchanged, and the estimate comes from the full payload (Opus, in code). SECURITY.md and MANUAL.md say nothing now false (Sonnet).

## Defer

- **D1. Pre and Post can fall on opposite sides of the cap.** PostToolUse's payload is 72 characters longer than PreToolUse's for the same command (re-run here: 29,315 against 29,387; Fable measured 58). A command in that band writes a commit-start record but gets no milestone ask. CONFIRMED (re-run here). The record itself is harmless: records are never marked done and are removed after 6 h by design (`store.js:1367-1370`). The ask is the only loss, and the over-cap skip already loses it. Seen on a6a025b. Fix idea: check the cap against the larger payload in both hooks.
- **D2. The 32,767 reason is wrong for spawnSync.** `hookio.js:27` and how-it-works give the Windows 32,767-character cap as the reason for the limit. Fable passed 40,000- and 120,000-character variables through spawnSync on Windows 11 / Node 26 intact. The cap still guards POSIX limits and stays conservative. CONFIRMED by Fable, not re-run. Seen on a6a025b. Wording only.
- **D3. A stale line in release-state.** `dev/release-state.md:478` still says the launcher "hands the payload over on stdin", as a historical note about 704399d. Seen on a6a025b. Fix: add "(until a6a025b)".
- **D4.** The rewrapped cliMode comment in `trailmark.js` (about line 615) leaves a short line. Cosmetic.

## Not checked

- macOS and Linux reruns. It is INFERRED, not tested, that an inherited non-blocking stdin can't hit EAGAIN on macOS (the old launcher's own read had the same exposure).
- Whole context-watch asks byte for byte. Opus saw the same token values and ask on the old code.
- Full suites and the SHA256SUMS hashes, locally. Every changed listed file has an updated line, and CI on a6a025b passed.
- Whether `park` has no size cap, as CHANGELOG says.

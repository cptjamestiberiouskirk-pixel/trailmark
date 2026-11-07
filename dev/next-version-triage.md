# Next version: triage of the deferred items

Written 2026-11-07 on main at a09ee5f, for the user to approve or adjust. A proposal only: no code is changed here.

`RS:<n>` is line `<n>` of `dev/release-state.md` at a09ee5f. Labels and the commit each item was seen on are as written there. "Re-check" says what this session ran or read on a09ee5f.

## Ground truth for the re-checks

- No shipped script or skill changed since v0.6.0 (CONFIRMED: `git diff --stat cf06986..a09ee5f` over `plugins/*/scripts`, `plugins/*/skills`, MANUAL.md, CHANGELOG.md, the installers and `tools/` shows only `docs/how-it-works.md`, one line). So an item seen on the 0.6.0 product code still stands as written. Items seen on older commits were spot-checked below.
- Repros re-run on a09ee5f (scratch `probe1.js`, read-only, it only requires `store.js` and `hook-context-watch.js` and prints): RS:644, RS:654, RS:655, RS:671, RS:693, RS:694, RS:701 and RS:638 all give the result the list records.
- Line numbers that moved since they were written: CHANGELOG.md's "3,000 took minutes" is on line 22 (was 17); the handoff-checks test comments are on 1991, 2000 and 2076 (were 1931 and 2016); MANUAL.md's section 15 reference is on line 384 (was 386).
- The top status line of `dev/release-state.md` (RS:3) is stale: PR #11 merged as 5579e63 and PR #14 as a09ee5f, and nothing is open. RS:7 still says PR #14 "waits for its 9 jobs". Housekeeping for the first batch that touches the file.

Review rows (CLAUDE.md): Fable for `gitbin.js`, `gitfacts.js`, `plainfile.js`, `store.js`, `contextwatch.js` and the launcher `scripts/trailmark.js`; Opus for regression and design; Sonnet for shipped docs. Every release adds a CHANGELOG section, so the Sonnet row runs once at the end whatever the batches hold.

## 1. Proposed scope

Four batches. Each owns its files, so no two batches write the same file and none waits on another's review. Batch D can go first as its own PR, since it ships nothing.

### Batch F: Fable files (Fable and Opus rows)

| # | Item | Label, seen on | Re-check on a09ee5f | User impact | Files | Size | Fails first |
|---|---|---|---|---|---|---|---|
| F1 | RS:647. A session whose session-start record has no `start` gets no commit sweep, and nothing says so | CONFIRMED (2 of 2, 2026-11-05) on c7a194a's tree; older than 0.6.0 | CONFIRMED in code: `trailmark.js:478`, `if (!rec \|\| !Number.isFinite(rec.start)) return undefined;` | Data: commits made in that session can go unlogged, silently. The same class as 0.5.1's silent sweep skip | `trailmark.js` (both copies), new test | M | Yes: the repro in RS:647 (drop the session-start call from the test) |
| F2 | RS:646. A swept commit folder dropped past six and joined again gets a new `from`, so a script's commit made there between the sweep and the rejoin is never logged | CONFIRMED by round 8 on 887e17f and 586329e, not re-run | `store.js` not changed since 0.6.0; the round 8 fix idea is one line (`from = min(from, swept[d])` on a rejoin) | Data: one commit unlogged; needs seven or more commit folders in one session | `store.js` (both copies), new test | S | Yes: `rejoin.js` in `dev/review-round-8-results.md` |
| F3 | RS:634 (also RS:52, RS:912). When `git log` alone runs out of time, session start says "HEAD has 1 newer commit, the newest 0 shown:" over an empty list | CONFIRMED twice, 2026-11-05; from before 0.6.0 | CONFIRMED in code: `store.js:2017` builds "the newest N shown" from `entries.length` with no time reason | Wrong text: Claude is told no commits are listed with no reason. Fixing it also gives the commit-list tests a time sign to key on, which takes them off "Load-sensitive tests" | `store.js`, `trailmark.js` `sinceHandoff` (both copies), the commit-list tests in `handoff-checks.test.js` | S to M; shipped wording | Yes: the load-proof proof already forces "only `git log` out on the first call" (RS:35) |
| F4 | RS:645. Over the injection budget, `buildInjection` cuts each note to 300 then 150 characters, so a note naming the launcher or the skills folder can be cut inside the path | INFERRED from the code, on df88236; "first in line for the next version" | CONFIRMED that the cuts are still there: `store.js:2165` (`oneLine(n, 300)`) and the last loop (150) | Wrong text: a path that names no file. It breaks the rule `usablePath` enforces | `store.js` (both copies), new test | M | Must: if a test can't make it fail, record it RULED OUT and drop it |
| F5 | RS:635, first half. Past 10 old jb-memory-codex folders the Codex note and `--copies` say "10 folders" with no sign of the cutoff | From Opus round 3 (0.6.0), no label written | CONFIRMED in code: `health.js:290` stops at `maxCopies = 10` and returns no `full` flag; the Codex launcher prints `old.length` (`trailmark.js:1017`) | Wrong count, Codex only | `health.js` (shared, both copies), Codex `trailmark.js` | S; shipped wording | Yes |
| F6 | RS:672. The Codex `--copies` says nothing about Codex's cache when `CODEX_HOME` is a file | CONFIRMED on 414b4f5 | `health.js` unchanged since 0.6.0 | Missing text, Codex only, cosmetic | `health.js`, Codex `trailmark.js` | S; shipped wording | Yes: the repro in RS:672 |
| F7 | RS:709 (also RS:59). `list()` reports any open or read error other than ENOENT as "<folder> has too many folders" | Wording CONFIRMED by a probe on 5566010; the trigger HYPOTHESIZED | CONFIRMED in code: `health.js:133` and `:150` set `full: false` for every error | Wrong reason printed by `--copies --show-names`; a test that hits it fails with a misleading reason. No shipped doc names the reason (CONFIRMED by grep, RS:59) | `health.js` | S; shipped wording | Yes: `load-proof/probe-list.js` |
| F8 | Comment riders: RS:696 and RS:698 in `store.js:1884-1885` and the handoff-checks comments (1991, 2000, 2076): "minutes" should be "about 40 seconds", and "10 s" should be the launcher's 9 s limit. RS:708, the short line in the `cliMode` comment of `trailmark.js` | CONFIRMED on main (03da9fd), the text as at ad757a4 | CONFIRMED by grep on a09ee5f | None (comments) | `store.js`, `trailmark.js`, `handoff-checks.test.js` | S | No (comments) |

F5 to F7 all sit in `health.js`, a shared file, so they ride this batch rather than an Opus-only one. F8 rides here because these files are open here anyway.

### Batch O: other shipped code (Opus row; Sonnet only if a skill's text changes)

| # | Item | Label, seen on | Re-check on a09ee5f | User impact | Files | Size | Fails first |
|---|---|---|---|---|---|---|---|
| O1 | RS:666. `transcript` frames its excerpt as data but prints each line without escaping tags | CONFIRMED in code on 015ea32 | CONFIRMED in code: `memory.js:414`, `for (const l of r.lines) console.log(l);` | Security (prompt injection): a message or tool result holding `</system-reminder>` comes back to Claude unescaped at each checkpoint, session end and recall | `memory.js` (both copies), new test | S | Yes: the repro in RS:666 |
| O2 | RS:664. `handoff` prints the handoff with no frame and no escape (session start escapes the same text) | CONFIRMED in code on 015ea32 | `memory.js` unchanged since 0.6.0 | Security, lower: the handoff is Claude's own text, but a merged handoff can carry another session's | `memory.js`, new test | S | Yes |
| O3 | RS:665. `write-handoff` refused with exit 3 prints the other session's lines and the current handoff with no data wording and no escape | CONFIRMED in code on 015ea32 | as O2 | Security: another session's text reaches this one unframed | `memory.js`, new test | S | Yes |
| O4 | RS:662 and RS:668 (one fix). `status` prints the newest SESSION_START line, with its `exec=` Node path, unframed | CONFIRMED in code, not tried | CONFIRMED in code: `hook-session-start.js:26` writes `exec=${process.execPath}`; `memory.js:217` prints it through `escapeTags(oneLine(...))` | Security, low: a Node path from the repo can still reach Claude after the note stopped naming it | `memory.js` (both copies), maybe `hook-session-start.js` | S | Yes |
| O5 | RS:642, the message only. Init and every write fail with "sandbox refused FileSystemWrite" when the memory folder's path is about 260 characters or more | CONFIRMED 2026-11-05 (Node 26.13; sets up at 259, fails at 261) | CONFIRMED in code that the message names no length: `memory.js:48`, `hookio.js:67` | Blocks use entirely for a repo path near 230 characters, with a message that points at the sandbox. Proposed: name the path's length and the limit, and say a shorter repo path fixes it. The grant fix (the `\\?\` form) stays deferred: its cause is HYPOTHESIZED | `memory.js`, `hookio.js` (shared) | S to M; shipped wording | Yes: `dev/probes/path-limit.js` |
| O6 | RS:703, comment only. `hookio.js` gives Windows' 32,767-character cap as the reason for `PAYLOAD_MAX`; Fable passed 40,000 and 120,000 characters on Windows 11 | CONFIRMED by Fable on a6a025b, not re-run | CONFIRMED the comment is there: `hookio.js:27` | None (comment). The docs half is in batch S | `hookio.js` | S | No |

Optional for batch O, each the user's call:

- O7, RS:637. After a repeat ask under a smaller point, the bigger window's later steps never ask: one repeat checkpoint ask is lost. CONFIRMED with the launcher on 0612f86, and by Codex on 3f07517. `hook-context-watch.js` (Claude Code only; not a Fable file). M, test first (the 202k / 198k / 207k / 210k sequence). The user said "Keep it deferred" on 2026-11-05, during 0.6.0; it is listed here because a lost ask can mean lost context at the compaction.

### Batch S: shipped docs and skill text (Sonnet row; Opus for S1's behavior)

| # | Item | Label, seen on | Re-check on a09ee5f | Files | Size |
|---|---|---|---|---|---|
| S1 | RS:652. The six Codex skills say that with no "Launcher:" note the launcher is `scripts/trailmark.js` two folders up. When `usablePath` refuses the install path, the note gives no "Launcher:" on purpose, so the fallback can lead Codex back to the refused path | INFERRED, not tried with Codex; from 75c9957 | CONFIRMED the text is in all 6 Codex SKILL.md files (grep: `tm-checkpoint/SKILL.md:14` and five more) | `plugins/trailmark-codex/skills/*/SKILL.md` | S |
| S2 | RS:703, the docs half: `docs/how-it-works.md:219` gives the same wrong reason for the 30,000 cap | CONFIRMED by Fable, not re-run | CONFIRMED by grep | `docs/how-it-works.md` | S |
| S3 | RS:696 and RS:699: CHANGELOG.md:22 says 3,000 "took minutes" (about 43 s measured) and ends "0.5.1 had it too" (the slow check is CONFIRMED in 0.5.1, a stalled session start there is not) | CONFIRMED and INFERRED | CONFIRMED by grep, now line 22 | CHANGELOG.md | S |
| S4 | RS:673: MANUAL.md:384 sends a stale cached copy to section 15, "Moving from an older install", which fits only an old jb-memory install | INFERRED by Sonnet on 414b4f5 | CONFIRMED the text, and section 14 is "Uninstall", 15 "Moving from an older install" | MANUAL.md | S |
| S5 | The new version's CHANGELOG section and version bumps, written once at the end | (release) | | CHANGELOG.md, the three `plugin.json`, MANUAL.md's version line | S |

S1 is the only one that changes what a model does. It needs Opus as well as Sonnet: the fallback must still hold when there is no `[trailmark]` note at all (Trailmark not set up), and only then.

### Batch D: `dev/` tooling (Opus row; no release dependency)

| # | Item | Label, seen on | Re-check on a09ee5f | Why it qualifies under the dev rule | Size |
|---|---|---|---|---|---|
| D1 | RS:707 (also RS:167, R3-2). After Ctrl-C, `release-check.sh` exits 130 instead of re-raising INT, so a shell loop that runs it keeps going | CONFIRMED by Opus on ff2e3e0 and 5a1e1a4, not re-run | CONFIRMED in code: `stop_suites` ends in `exit "$1"` (`release-check.sh:77`) | CONFIRMED | S |
| D2 | RS:663. Only the 20 newest run folders are kept, and since PR #10 every `--only` run keeps one even when it passes (`release-check.sh:170`), so a series of `--only` runs pushes out a failed full run's output | CONFIRMED (a 13:02 run's output was gone by 15:30) | CONFIRMED in code: `release-check.sh:106` | CONFIRMED; the cost grew with PR #10 | S |
| D3 | RS:705 (also RS:149). `--only` runs every file at Node's default concurrency (15 on 16 cores), not `AT_ONCE` | INFERRED on 86fd88a | CONFIRMED in code: the `--only` branch (`release-check.sh:190`) passes no `--test-concurrency` | INFERRED, but it can change a result: all files at once failed the commit-list test once (RS:124), which is the dev rule's exception | S |

## 2. What stays deferred, and why

Context watch (Claude Code only):

- RS:624, the ~300 ms per call past 80%: speed only, and the fix (`decide()` in the launcher) is a design change in a Fable file.
- RS:625, one handoff write ends the asks until the compaction: as briefed, not a defect.
- RS:627, RS:629, RS:631: HYPOTHESIZED, each waiting on a fact about Claude Code that nobody has established yet.
- RS:630, the over-estimates: an early ask at most once per cycle (the provisional rule); `contextwatch.js` is a Fable file.
- RS:636, RS:639, RS:640: rare (two window changes in a cycle) or wording only.
- RS:638, two hooks with no `since` give the first ask twice: CONFIRMED with `decide()` (re-run here), but nothing is lost, and the fix is in the launcher.
- RS:637 unless the user takes O7.

Commit tracking:

- RS:626, B5's trade-off: a chosen design.
- RS:628, told twice for `git -C x commit` while the lock is busy: duplicate text only.
- RS:659 (K1), `git-kept-out` under load: HYPOTHESIZED with no repro (its output is gone). Logging the reason is cheap and would turn the next sighting into evidence; worth adding if `gitfacts.js` is opened for another reason.
- RS:702, a command of about 29,300 characters writes a commit-start record but gets no milestone ask: a band 72 characters wide.

Copies and names (`--copies`, `visibleName`):

- RS:653, RS:654, RS:655: display only, and RS:654 and RS:655 re-run here unchanged. No name is lost or run.
- RS:656 (P1), an install path holding `!` or `%` gives Codex no launcher: CONFIRMED by round 8, but it fails closed, and loosening `usablePath` is a design choice about which shells the note's command must be safe in. Needs the user's call, not a fix in this batch.
- RS:657, single-quoted paths: needs both a user who quotes that way and such a folder (INFERRED).

Output escaping (`store.js`):

- RS:644, `fieldText` keeps `<b>` and fullwidth `＜system＞` (re-run here, unchanged): only whoever picks the install folder or repo path can put it there, and the fix that escapes tags also NFC-normalizes, which could stop a path naming its file on Linux (HYPOTHESIZED).
- RS:671, `search` keeps only a long line's start (re-run here: `false`): wrong output, low.
- RS:693 and RS:694 (O1, O2 of the combined round), re-run here unchanged: the printed text doesn't read as a tag.
- RS:667, RS:669, RS:670: `list parked`, `list history` and `prune-report` already pass names through `shownName` and text through `escapeTags`; the rest of the commands print counts or fixed text, and their warnings are untraced. A frame line for each is wording, after O1 to O4.

Git checks (`gitbin.js`):

- RS:632 and the B4 remainder (RS:252): a nested module gitdir named with two hex letters is still passed over. git 2.56 refuses to open one by name, and the cheap fix costs about 51,000 lookups for 200 submodules.

Tests and load:

- RS:633, `git init -q` failing with 46 node processes: HYPOTHESIZED, its exit code wasn't kept.
- RS:648, no session-start call asserts the hook's status: F1 makes the product say when the record is missing, which covers most of the gap; asserting all of them would add load-sensitive failures unless each skips with a reason.
- RS:660, libuv's unchecked remove: HYPOTHESIZED, never seen.
- RS:710, RS:711, RS:712 (also RS:54, RS:55): test gaps, INFERRED. RS:712 needs a bound that holds under load (a time from the hook's own trace), which is a design task of its own.
- RS:53 and RS:921, 0.3.4's side pass that can run out without a marker: HYPOTHESIZED.
- RS:56 and RS:57: designed costs of the load-proof helpers, HYPOTHESIZED rates, never seen failing.

Other:

- RS:650: 0.5.x only, already fixed by 0.6.0's `usablePath`. A note for 0.5.x users, not code.
- RS:658 and RS:651: flagged below.
- RS:716, Codex asking for escalation on the first try: an open question for the user, not a defect.
- RS:701: fails closed, "recorded only" in the list.

Left out as the user decided not to fix them (RS:862 to RS:865): the `network-gitdir` reason word, and the 0.4.5 `host` field.

## 3. Items that look serious

- O1 to O3 (RS:666, RS:664, RS:665): text from disk or another session reaches Claude without escaped tags. O1 is the widest, since a transcript holds tool results, web pages among them. In scope.
- S1 (RS:652): code that runs. A path the 0.6.0 launcher refuses because a shell would act on it can still be built by Codex from the skills' fallback (INFERRED, not tried with Codex). In scope.
- RS:651, deferred: the Claude Code skills get the install path from `${CLAUDE_PLUGIN_ROOT}`, not through `usablePath`, so a shell character in the install folder reaches their `node "..."` commands (INFERRED, not tried). The install folder sits under the user's own home, so such a character would come from the user's own account name or a marketplace name (INFERRED; which characters Claude Code allows in a cache path is not checked). A cheap first step: the session-start hook warns when `usablePath` refuses its own install path.
- RS:658, deferred: where a volume has no hard links (an SMB share), `init`'s `createOnce` writes `handoff.md` or `.jbmem.json` in place with `'wx'`, and on Windows a planted junction at that name is followed (INFERRED by Fable with a mock, not re-run; the repro wasn't kept). It needs both a memory folder on such a volume and a link planted in it. Worth a Fable repro before the release after this one.
- RS:650: 0.5.x wrote the launcher path into `node "<path>"` without refusing shell characters. Fixed in 0.6.0, so it only matters to someone still on 0.5.x.

## 4. Duplicates and items already fixed

- Fixed in the tests by PR #14 (merged as a09ee5f), skipped as the brief says: RS:641, RS:649, RS:661, RS:700, RS:706.
- Fixed in `dev/release-state.md` already, marked so in their entries: RS:695, RS:697, RS:704.
- The same item listed twice: RS:707 is "Faster local checks" R3-2 (RS:167); RS:705 is that section's round 1 Opus item (RS:149); RS:709 is the last "still load-sensitive" bullet (RS:59); RS:710 and RS:711 are RS:54 and RS:55; RS:634 is RS:52 and the commit-list entry of "Load-sensitive tests" (RS:912); RS:668's `exec=` path is RS:662.
- "Deferred to 0.5.2" (RS:869) and "Deferred to 0.5.1" (RS:875 to RS:905) were all taken into 0.6.0 as B1 to B11 (Scope table, RS:211 to RS:221) or marked fixed (RS:223 to RS:226). What is left of them: B4's two-hex case (in section 2) and the 12 POSIX-only handoff-checks tests that keep `skip: WIN` with their real reason (RS:257), which is by design.
- "Faster local checks" F3 (`${a[@]+...}` for bash before 4.4) is in the code (CONFIRMED: `release-check.sh:236`); only macOS's bash 3.2 is untested.

## Size of the proposal

Core: F1 to F8, O1 to O6, S1 to S5 and D1 to D3. Optional: O7. Every product fix but F8, O6 and the docs gets a test that fails first. By the stop rule, batch F needs a Fable and an Opus reviewer, batch O an Opus one, batch S a Sonnet one (plus Opus for S1), and batch D an Opus one in its own PR. A tighter cut, if wanted: F1 to F4, O1 to O5, S1 and D1, leaving F5 to F7 and the comment and wording riders to the release after.

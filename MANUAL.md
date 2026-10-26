# jb-memory manual

jb-memory keeps one short state file per repo, the handoff, and gives it to every new Claude Code session in that repo. Claude rewrites it at milestones (a commit, a merged PR, a subagent's result, before a compaction), so the next session starts from where the last one stopped instead of from a cold read of the code. This manual covers installing it, setting a repo up, using it day to day, the Codex copy for the ChatGPT desktop app, the Windows watchdog and the diagnostic scripts.

Version 0.4.2 (Codex copy 0.2.3, jb-watchdog 1.6.0). MIT licensed.

## Contents

1. What's in the package
2. Requirements
3. Install
4. Set up a repo
5. Day to day
6. The handoff
7. Configuration
8. Codex (ChatGPT desktop app)
9. Windows: the working-folder lookup
10. jb-watchdog (Windows)
11. Diagnostic scripts (Windows)
12. Updating
13. Troubleshooting
14. Uninstall
15. Moving from an older install

## 1. What's in the package

| Path | What it is |
|---|---|
| `install.sh` | Installer for macOS and Linux |
| `install.ps1`, `install.cmd` | Installer for Windows (`install.cmd` runs the `.ps1` without changing the execution policy) |
| `.claude-plugin/marketplace.json` | The Claude Code marketplace, named `jb-memory` |
| `plugins/jb-memory/` | The Claude Code plugin: hooks, six skills, the launcher and its tests |
| `.agents/plugins/marketplace.json` | The Codex marketplace, named `jb-memory-codex` |
| `plugins/jb-memory-codex/` | The same plugin adapted to Codex, sharing each repo's handoff with Claude Code |
| `tools/windows/` | jb-watchdog, its installer and test, and the diagnostic scripts |
| `README.md`, `MANUAL.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE` | Documentation |

Each plugin has its own README with the internals (how commits are found in command text, the lock, the size budget). This manual doesn't repeat those.

## 2. Requirements

| | Needed | Notes |
|---|---|---|
| Node.js | 22.23.4, 24.22.1 or 26.12.1 or later in its line | Every hook runs `node`. Older releases miss two fixes to the permission model the sandbox relies on. The installer refuses them unless you pass `--allow-old-node` / `-AllowOldNode` |
| Claude Code | 2.1.304 or later tested | Hooks use `args` and `if`, which 2.1.42 ignores. Versions between those two are untested |
| git | Any current release | Optional. Without it nothing breaks, but no commits are logged and the handoff's `Updated:` line has no branch or HEAD |
| Windows | Windows 10 or 11, Windows PowerShell 5.1 (built in) | PowerShell 7 works for the installer and the scripts. jb-watchdog's scheduled scans run under 5.1 |
| macOS, Linux | bash | The plugin and installer are tested on Linux. macOS is expected to work the same way, untested |
| Codex copy | ChatGPT desktop app with Codex mode, Codex CLI for the marketplace command | Observed working on Windows. macOS untested |

## 3. Install

Put the release folder somewhere permanent that only you can write to, such as `~/tools/jb-memory` or `%USERPROFILE%\tools\jb-memory`. Claude Code loads the plugin from that folder in place, so moving or deleting it later breaks the install, and anyone who can write to it can change what the hooks run.

### With the installer

macOS or Linux, in a terminal:

```bash
cd ~/tools/jb-memory
./install.sh
```

Windows: double-click `install.cmd`, or in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\tools\jb-memory\install.ps1"
```

The installer stops at the first problem and says what to do. In order, it:

1. checks Node against the security floors, and that git and `claude` are on PATH;
2. refuses a folder, or a folder above it, that anyone but you can write to, replace or own (on Windows, anyone but you, Administrators and SYSTEM), and a release that holds links;
3. on Windows, checks `NoDefaultCurrentDirectoryInExePath` (section 9);
4. runs the sandbox check;
5. refuses if jb-memory is already installed from another marketplace, or if a marketplace named `jb-memory` points at another folder, since two copies would each run every hook;
6. runs `claude plugin validate`, `claude plugin marketplace add <folder>` and `claude plugin install jb-memory@jb-memory` (user scope).

It downloads nothing and changes no file in the release folder. Options:

| install.sh | install.ps1 | Effect |
|---|---|---|
| `--check` | `-Check` | Run the checks only; change nothing |
| `--codex` | `-Codex` | Also add the Codex marketplace (section 8) |
| (none) | `-Watchdog` | Also install jb-watchdog (section 10) |
| (none) | `-SetNoCwdLookup` | Set `NoDefaultCurrentDirectoryInExePath=1` for your user |
| `--allow-old-node` | `-AllowOldNode` | Continue on a Node below the security floor |
| `--repoint` | `-Repoint` | Let an existing `jb-memory` marketplace that points elsewhere point here |
| `--uninstall` | `-Uninstall` | Uninstall the plugin and remove the marketplace (section 14) |

### By hand

```text
node plugins/jb-memory/scripts/jbm.js --sandbox-check
claude plugin validate <release folder>
claude plugin marketplace add <release folder>
claude plugin install jb-memory@jb-memory
```

User scope, the default, covers the terminal, the desktop app's local sessions and VS Code, since they read the same settings. `claude plugin list` should show `jb-memory@jb-memory`, enabled, read from `<release folder>/plugins/jb-memory`.

### From a git host

Claude Code can also install straight from GitHub, without a local folder:

```text
claude plugin marketplace add cptjamestiberiouskirk-pixel/jb-memory
claude plugin install jb-memory@jb-memory
```

Claude Code then installs a copy into its plugin cache instead of reading a folder in place, and `claude plugin marketplace update jb-memory` fetches new versions. The installers, jb-watchdog and the diagnostic scripts assume a local folder; with a hosted marketplace, use the plugin alone.

## 4. Set up a repo

jb-memory does nothing in a repo until it is set up there. In each repo you want covered:

1. Start Claude Code at the repo's top folder and run `/jb-memory:memory-setup`.
2. It checks Node, runs the sandbox check, finds Claude Code's memory folder for the repo (`~/.claude/projects/<key>/memory`), asks whether the repo is public (that turns on extra checks before anything is promoted into committed files), and creates `.jbmem.json`, an empty `handoff.md` and the folders it uses.
3. Start a new session (or run `/clear`). A status line starting `[jb-memory]` should appear and end with `sandbox on`. Check the terminal and the desktop app separately: a working terminal says nothing about the desktop app.

To stop using jb-memory in a repo, delete `.jbmem.json` from its memory folder. The hooks go quiet and the files stay where they are.

Every worktree of a repo shares one memory folder, so they share one handoff.

## 5. Day to day

Most of it happens on its own.

| When | What jb-memory does |
|---|---|
| Session start, `/clear`, after a compaction | Injects the handoff (within its budget) as notes from earlier sessions, and shows `[jb-memory] ...` with a token estimate. After a compaction it adds that session's snapshot. It names other sessions active in the repo in the last 3 hours |
| Resumed session | One line with the handoff's age, and a request to re-read it if another session wrote it since |
| `git commit` through the Bash or PowerShell tool | Logs each commit it made, in whichever folder it ran, and reminds Claude to checkpoint |
| `gh pr merge` | Logs the merge and reminds Claude to checkpoint |
| A subagent finishes | Reminds Claude to checkpoint if the result changed the state |
| Before a compaction | Saves a snapshot of git state for that session |

The reminders are rate-limited (20 minutes apart by default), and Claude may skip one when nothing material changed.

You call the skills by their full names:

| Skill | When to use it |
|---|---|
| `/jb-memory:checkpoint` | Any time you want the handoff brought up to date. Done items are archived word for word |
| `/jb-memory:session-end` | Before you stop for the day. It recovers anything the checkpoints missed from the transcript and asks you to approve the final handoff |
| `/jb-memory:park` | Save one idea for later without cluttering the handoff |
| `/jb-memory:recall` | Search memory, read archived items, measure the budget, undo the last checkpoint |
| `/jb-memory:memory-prune` | Shrink what loads every session: archive, dedupe, promote stable facts to path-scoped `.claude/rules` files |
| `/jb-memory:memory-setup` | Set a repo up, or re-check one |

Type the full name. Claude Code's own `/rewind` answers to `checkpoint`, so `/checkpoint` alone opens that instead.

Several sessions can work in one repo at once. Every handoff write names the version it started from; a write based on an older version is refused, and the skill merges the other session's changes and writes again. Neither session can silently undo the other's checkpoint.

## 6. The handoff

The checkpoint skill writes the handoff to a fixed template:

```text
# Handoff: <repo>
Updated: <time> | branch <branch> | HEAD <sha7>

## Bootstrap
<one line a fresh session can act on first>

## Current state
- <fact> (CONFIRMED | INFERRED | HYPOTHESIZED: <evidence>)

## Deliverables and locations
- <artifact> -- <path, branch or PR> -- <status>

## Next actions
1. <action> -- owner: <Claude or user>

## Decisions
- [user YYYY-MM-DD] <decision the user made or explicitly confirmed>
- [proposed] <suggestion of Claude's that the user has not confirmed>

## Open questions and risks
- <question or risk, with what would settle it>
```

Two rules in that template do most of the work.

Every state claim carries an evidence label. CONFIRMED means it was seen in code, output or logs; INFERRED means it follows from confirmed facts; HYPOTHESIZED means it is plausible and unverified. A label is carried forward only while it holds, and evidence from an earlier session says so ("CONFIRMED 10-14, not re-checked"). This keeps a guess from turning into a fact as it passes from session to session.

Decisions carry provenance. Only what you decided or explicitly confirmed is written as `[user ...]`; Claude's own suggestions stay `[proposed]` even when you reacted well. A wrong attribution would be repeated by every later session as your decision.

Test and build results are written only from output seen in that session, with the time. The handoff stays under 120 lines and 7,000 characters by default, and points at files for detail.

### Changing the conventions

The skills are plain text in `plugins/jb-memory/skills/*/SKILL.md`. Edits there take effect at the next session start, and jb-watchdog (if installed) reports them like any other change. Two settings are better made in the repo's `CLAUDE.md` (or `AGENTS.md` for Codex) instead, so the skills stay as shipped:

- A model policy. The checkpoint skill adds a `-- model:` note to a next action only when the repo or you set a policy, for example "Planning and review: Opus at high effort. Executing a written plan: Sonnet."
- A different provenance tag, such as your name in place of `user`. Say so in `CLAUDE.md` and keep it the same across sessions; the recall skill treats either form as a decision.

Keep the evidence labels unless you have a reason to drop them. They are what lets the next session tell what was checked from what was assumed.

## 7. Configuration

`.jbmem.json` in the repo's memory folder holds the per-repo settings. Every value is optional; a value outside its range is clamped, and anything that isn't a number falls back to the default.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `budgets.handoffChars` | 7000 | 500 to 100000 | Handoff size limit in characters |
| `budgets.handoffLines` | 120 | 10 to 5000 | Handoff size limit in lines |
| `budgets.injectChars` | 8500 | 1000 to 9500 | Most the session-start injection may hold (Claude Code cuts hook output over 10,000) |
| `budgets.memoryMdLines` | 150 | 10 to 1000 | Warning level for Claude Code's own MEMORY.md |
| `budgets.memoryMdBytes` | 20000 | 1000 to 200000 | Same, in bytes |
| `hints.minMinutesBetween` | 20 | 0 to 1440 | Least time between checkpoint reminders |
| `hints.freshCheckpointMinutes` | 3 | 0 to 1440 | No reminder this soon after a checkpoint |
| `staleDays` | 30 | 1 to 3650 | Age at which prune calls an item stale |
| `publicRepo` | false | true or false | Extra checks before anything is promoted into committed files |

Environment variables:

| Variable | Effect |
|---|---|
| `JBMEM_SANDBOX=off` | Runs without Node's permission model. Set it in the `env` block of `~/.claude/settings.json` only if the sandbox check fails and you accept the risk. Every session start then warns. `"sandbox": false` in `.jbmem.json` is ignored on purpose |
| `JBMEM_CODEX_SHELL=bash` | Codex copy: read commands as bash on Windows (for an agent running in Git Bash or WSL) |
| `JBMEM_CODEX_INIT=1` | Codex copy: allow `init`, for a repo used only from Codex. Set it for that one command (section 8, step 6), never permanently |
| `JBMEM_SHAPES=off` | Codex copy: stop the payload-shape log |

## 8. Codex (ChatGPT desktop app)

The Codex copy keeps the same handoff in the same folder as the Claude Code plugin, so a Codex chat and a Claude Code session in one repo read and write one handoff, with the same version check. A repo you also use in Claude Code is set up from Claude Code (section 4). A repo you use only from Codex is set up by hand, in step 6 below.

1. Add the marketplace: `./install.sh --codex`, `install.ps1 -Codex`, or by hand `codex plugin marketplace add <release folder>`.
2. Restart the ChatGPT desktop app, open Plugins, choose the `jb-memory-codex` marketplace and install `jb-memory-codex`. The Codex CLI only manages marketplaces; installing happens in the app, and Codex runs a plugin's hooks only when it was installed there.
3. Review and trust the hooks when the app asks. Each should read `node -e "...PLUGIN_ROOT..." jbm --hook <name>`. Codex asks again after any change to them.
4. Checkpoints write outside the workspace, so Codex's sandbox refuses the first try and the skill asks you to approve the write. That is the safer default. `plugins/jb-memory-codex/README.md`, step 3, explains how to skip the prompts with a writable root and what that costs.
5. On Windows, set `NoDefaultCurrentDirectoryInExePath` (section 9) before restarting the app.
6. Set the repo up, if Claude Code hasn't. For a repo used only from Codex, run this yourself in a terminal outside Codex, from the repo's top folder (add `--public` for a public repo):

   ```powershell
   $env:JBMEM_CODEX_INIT = '1'
   node "<release folder>\plugins\jb-memory-codex\scripts\jbm.js" init --force
   Remove-Item Env:\JBMEM_CODEX_INIT
   ```

   On macOS or Linux: `JBMEM_CODEX_INIT=1 node "<release folder>/plugins/jb-memory-codex/scripts/jbm.js" init --force`. The variable is for that one command only: set permanently, it would let a Codex session set up any repo on its own. `--force` is needed because, with no Claude Code session ever in the repo, the folder comes from Claude Code's naming formula and can't be confirmed. Claude Code uses the same formula, so it finds the same folder if you open the repo there later.
7. Start a new Codex chat in the repo and ask it to run the `jbm-memory-setup` skill.

The Codex skills are named `jbm-checkpoint`, `jbm-recall`, `jbm-park`, `jbm-session-end`, `jbm-memory-prune` and `jbm-memory-setup`. Codex installs a copy of the plugin in `~/.codex/plugins/cache/`, so after updating the release folder, restart the app and trust the hooks again.

## 9. Windows: the working-folder lookup

Every hook starts `node` by name. On Windows, cmd.exe and Node's own child_process look in the current folder before PATH, so a `node.exe` (or, through cmd, a `node.cmd` or `node.bat`) committed to a repo could run in place of Node at every hook, as you. One user setting turns that lookup off for cmd and for programs that honor it:

```powershell
[Environment]::SetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', '1', 'User')
```

`install.ps1 -SetNoCwdLookup` does the same. It applies to programs started afterwards, so restart Claude Code, the desktop app and the ChatGPT app. To undo it, set the value to `$null` the same way.

It was CONFIRMED on a Windows 11 PC that Claude Code in the terminal and in the desktop app then run the installed Node. `tools\windows\test-node-lookup.ps1` shows which lookups use the working folder on your PC. Independently, session start warns if the Node running jb-memory sits in the session's folder or repo, and jb-memory runs git by full path.

macOS and Linux shells don't search the current folder unless PATH holds `.` or an empty entry; the installer warns about both.

## 10. jb-watchdog (Windows)

jb-watchdog watches the release folder for changes and for content that looks malicious, because Claude Code runs the hooks from there at every session start. It also watches what decides which code Claude Code runs outside that folder: copies of jb-memory in Claude Code's plugin cache, and the hooks, helpers, plugins, marketplaces and MCP servers in Claude Code's user settings. It runs as you, with no admin rights, and never changes anything it watches.

### Install

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<release folder>\tools\windows\install-jb-watchdog.ps1"
```

or `install.ps1 -Watchdog`, or double-click `tools\windows\install-jb-watchdog.cmd`. The installer copies the watchdog to `%LOCALAPPDATA%\jb-watchdog`, shows a summary of the folder and asks you to type `yes` to record it as known-good, adds two scheduled tasks (`jb-watchdog` every 15 minutes, `jb-watchdog-reminder` at logon and unlock), runs each once and sends a test notification. Run from `tools\windows`, it watches the release folder two levels up; `-Root <folder>` names another.

### Using it

| Task | Command (Windows PowerShell) |
|---|---|
| See the current state | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\jb-watchdog\jb-watchdog.ps1" -Status` |
| Accept the changes after checking them | same, with `-Accept` |
| Read the log | `%LOCALAPPDATA%\jb-watchdog\watchdog.log` |
| Remove it | `install-jb-watchdog.ps1 -Uninstall` (the log and known-good list stay) |

Always accept with the installed copy, as above: the known-good list records the hash of the copy that accepted it, and a scan by a different copy is itself reported.

The known-good list also records the folder's layout: `root` for this release (the folder is the marketplace), `nested` for an older private setup with a `jb-memory-marketplace` subfolder. Accepting never switches it on its own, so planting a manifest can't move the watch. If you really did reorganize the folder, accept with `-SetLayout root` or `-SetLayout nested`.

A file over 64 MB is checked by its first and last 8 MB, size and time, so one huge file can't make every scan run out of time; adding one is HIGH. If a scan starts and never finishes, the next one says so in a notification.

### What the levels mean

| Level | Examples | What to do |
|---|---|---|
| HIGH | Any change to plugin files; a script that downloads and runs code; a new hook that runs something other than jbm.js; a new jb-memory copy in the plugin cache; something added to what Claude Code's settings run; Defender real-time protection off | Find out where it came from before you accept. A HIGH notification stays on screen until dismissed |
| MEDIUM | A changed script outside the plugin; an archive; a removed settings hook | Check it, then accept |
| LOW | Other files | Accept when convenient |

An unaccepted change is notified again every 24 hours and at logon or unlock (at most once every 10 minutes).

### What it doesn't cover

Repo settings (`.claude/settings*.json`, `.mcp.json` in each repo), what other plugins run, the Codex plugin cache under `~/.codex`, and anything behind a link once you've accepted it. It runs as you, so malware running as you could change it or its known-good list; it adds to Defender and doesn't replace it.

Updating the release folder (section 12) shows as a set of HIGH changes. That is expected: check that the changes match the release notes, then accept.

## 11. Diagnostic scripts (Windows)

All live in `tools\windows` and are run with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>`. Each writes a `.log` next to itself, which jb-watchdog ignores. The read-only ones take `-Repo <path>` and default to the current folder.

| Script | Changes anything | Model calls | Use it to |
|---|---|---|---|
| `check-jb-checkpoints.ps1` | No | No | List, per session, the milestones next to the checkpoints, and flag gaps (a compaction with no checkpoint after it, a refused write never redone, a write that skipped the version check) |
| `inspect-last-checkpoint.ps1` | No | No | See how the latest checkpoints were written and what each call returned |
| `trace-handoff-writes.ps1` | No | No | Find what touched the handoff in a time window. Its log keeps command text until the next run |
| `test-node-lookup.ps1` | Its own throwaway folders only | No (Part 2 needs you to start a session) | Check whether a `node` in the working folder can run in place of Node (section 9) |
| `test-jb-memory-sessions.ps1` | A throwaway repo, deleted after | Two, or none with `-CliOnly` | Prove two sessions can't undo each other's checkpoints |
| `test-jb-memory-roundtrip.ps1` | A throwaway repo, deleted after | Four | Prove a checkpoint written in one session reaches the next |
| `verify-jb-hooks.ps1` | A throwaway repo, deleted after | Several | Check every mid-session hook end to end on your PC |
| `test-jb-watchdog.ps1` | A throwaway folder under `%TEMP%`, deleted after | No | Check jb-watchdog against real Windows features; it shows one real notification |

The test scripts that call the model use `claude -p`, which uses your Claude Code account. The throwaway repos live in the temp folder, outside the folder jb-watchdog watches.

## 12. Updating

1. Replace the release folder's contents with the new release (keep the same path).
2. In Claude Code, run `/reload-plugins` or start new sessions. Nothing needs reinstalling: the plugin is read in place.
3. If jb-watchdog is installed, check the changes it reports against `CHANGELOG.md`, then accept. If the new release has a new `jb-watchdog.ps1`, run `install-jb-watchdog.ps1` again so the scheduled copy is the new one, then accept with the installed copy.
4. Codex: restart the ChatGPT app and trust the hooks again if they changed (0.2.0 changed them).

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No `[jb-memory]` line at session start | The repo isn't set up; the plugin isn't enabled; Node isn't on PATH for that app; Claude Code too old | Run `/jb-memory:memory-setup`; `claude plugin list`; `node --version` in a new terminal; update Claude Code |
| The line says `sandbox off` or warns about the sandbox | `JBMEM_SANDBOX=off` is set in user or repo settings | Remove it unless you set it on purpose |
| "Sandbox check failed" or "SANDBOX UNAVAILABLE" | Node too old or built without the permission model | Install a current Node LTS and rerun the check. Only if that's impossible, set `JBMEM_SANDBOX=off` (section 7) |
| Warning that Node is older than the security release | Node below its line's floor | Update Node |
| Warning naming another copy of jb-memory | A stale copy in Claude Code's plugin cache | Remove the named folder, or uninstall the other install (section 15) |
| `/checkpoint` opens the rewind menu | Claude Code's `/rewind` has that alias | Use `/jb-memory:checkpoint` |
| A checkpoint write is refused with exit code 3 | Another session wrote the handoff first | Nothing: the skill merges and writes again. Three refusals in a row means two sessions are checkpointing at the same moment |
| Exit code 2 | Over budget | The skill tightens the text and writes again |
| "another jb-memory command is using the memory folder" | The lock was busy for over 10 seconds | Wait and retry; the message names what holds it |
| Commits aren't logged | git not on PATH; the commit ran through a tool other than Bash or PowerShell; a hook didn't fire | `check-jb-checkpoints.ps1` (Windows) shows what each session ran next to what was logged |
| The installer says jb-memory is installed as another id | An older install from a different marketplace | Section 15 |
| The installer refuses the folder's permissions | A broad group can write there | Move the folder under your user profile, or fix the permissions |
| Codex never shows the handoff | Hooks not trusted (they must be trusted again after an update that changes them); the app not restarted; plugin installed from the CLI | Trust the hooks in the app; restart it; install from the app |
| jb-watchdog reports two names that differ only by case | A case-sensitive folder holds both | Remove one; the pair can't be accepted |

## 14. Uninstall

`./install.sh --uninstall` or `install.ps1 -Uninstall` runs `claude plugin uninstall jb-memory@jb-memory` and `claude plugin marketplace remove jb-memory`, and removes the `jb-memory-codex` marketplace from Codex if the CLI is present. Uninstall the Codex plugin in the ChatGPT app as well. jb-watchdog stays until you run `install-jb-watchdog.ps1 -Uninstall`.

Nothing in your repos or memory folders is deleted. Each repo's handoff, archive and logs stay in `~/.claude/projects/<key>/memory`; delete them by hand if you want them gone. After that you can delete the release folder.

## 15. Moving from an older install

If jb-memory was installed from an earlier private marketplace (for example `jb-memory@jb-local`), the installer refuses to add a second copy. To move:

1. `claude plugin uninstall jb-memory@<old marketplace>` and, if nothing else uses it, `claude plugin marketplace remove <old marketplace>`.
2. Run the installer from the new release folder.
3. Your repos' memory folders, handoffs and settings carry over unchanged: they live in Claude Code's projects folder, not in the plugin.
4. If jb-watchdog watched the old folder, run `install-jb-watchdog.ps1` from the new release's `tools\windows`. It records the new folder and its layout.

Handoffs written before 0.4.0 may carry a name in place of `user` in their decision tags. The skills read both.

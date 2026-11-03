# Trailmark manual

Trailmark keeps one short state file per repo, the handoff, and gives it to every new Claude Code session in that repo. Claude rewrites it at milestones (a commit, a merged PR, a subagent's result, before a compaction), so the next session starts from where the last one stopped instead of from a cold read of the code.

Sections 2 to 7 get you installed and working. The rest covers the Codex copy for the ChatGPT desktop app, the optional Windows tools, updating, troubleshooting, uninstalling and moving from jb-memory. The internals are in [docs/how-it-works.md](docs/how-it-works.md) and the security model is in [SECURITY.md](SECURITY.md).

Version 0.5.1, for both Claude Code and the Codex copy (trailmark-watchdog 1.7.0). MIT licensed.

## Contents

1. [What's in the package](#1-whats-in-the-package)
2. [Requirements](#2-requirements)
3. [Install](#3-install)
4. [Set up a repo](#4-set-up-a-repo)
5. [Day to day](#5-day-to-day)
6. [The handoff](#6-the-handoff)
7. [Configuration](#7-configuration)
8. [Codex (ChatGPT desktop app)](#8-codex-chatgpt-desktop-app)
9. [Windows: the working-folder lookup](#9-windows-the-working-folder-lookup)
10. [trailmark-watchdog (Windows)](#10-trailmark-watchdog-windows)
11. [Diagnostic scripts (Windows)](#11-diagnostic-scripts-windows)
12. [Updating](#12-updating)
13. [Troubleshooting](#13-troubleshooting)
14. [Uninstall](#14-uninstall)
15. [Moving from an older install](#15-moving-from-an-older-install)
16. [Reference: why git or the file list is skipped](#16-reference-why-git-or-the-file-list-is-skipped)

## 1. What's in the package

| Path | What it is |
|---|---|
| `install.sh` | Installer for macOS and Linux |
| `install.ps1`, `install.cmd` | Installer for Windows (`install.cmd` runs the `.ps1` without changing the execution policy) |
| `migrate-from-jb-memory.cmd`, `tools/migrate-from-jb-memory.*` | Moves an install of jb-memory, the name before 0.5.1, to Trailmark (section 15) |
| `.claude-plugin/marketplace.json` | The Claude Code marketplace, named `trailmark` |
| `plugins/trailmark/` | The Claude Code plugin: hooks, six skills, the launcher and its tests |
| `.agents/plugins/marketplace.json` | The Codex marketplace, named `trailmark-codex` |
| `plugins/trailmark-codex/` | The same plugin adapted to Codex, sharing each repo's handoff with Claude Code |
| `tools/windows/` | trailmark-watchdog, its installer and test, and the diagnostic scripts |
| `tools/install-check.js` | Small checks the installers run |
| `README.md`, `MANUAL.md`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE` | Documentation |
| `docs/how-it-works.md` | The technical reference: how commits are found in command text, the lock, the size budget. This manual doesn't repeat it |
| `SHA256SUMS` | A checksum for every file in the release (`sha256sum -c SHA256SUMS`) |
| `.github/` | The tests run for each change (CI) |

## 2. Requirements

| | Needed | Notes |
|---|---|---|
| Node.js | 22.23.4, 24.22.1 or 26.12.1, or later in the same line | Every hook runs `node`. Older releases miss two fixes to the permission model the sandbox relies on, and the installer refuses them unless you pass `--allow-old-node` / `-AllowOldNode`. Lines before 22, and odd-numbered lines before 26, are refused the same way, since they get no security releases |
| Claude Code | 2.1.304 or later (the oldest tested) | The hooks use the `args` and `if` options, which 2.1.42 ignores. Versions between the two are untested. The installer warns on an older one |
| git | Any current release | Optional. Without it nothing breaks, but no commits are logged and the handoff's `Updated:` line has no branch or HEAD |
| Windows | Windows 10 or 11, with Windows PowerShell 5.1 (built in) | PowerShell 7 also runs the installer and the scripts. trailmark-watchdog's scheduled scans run under 5.1 |
| macOS, Linux | bash | The plugin's tests run in CI on Linux, macOS and Windows. The installer is tested on Linux |
| Codex copy | The ChatGPT desktop app with Codex mode, and the Codex CLI for the marketplace command | Tested with the desktop app on Windows. macOS is untested |

## 3. Install

First put the release folder somewhere permanent that only you can write to, such as `~/tools/trailmark` or `%USERPROFILE%\tools\trailmark`. Claude Code loads the plugin from that folder in place. Moving or deleting it later breaks the install, and anyone who can write to it can change what the hooks run.

### With the installer

macOS or Linux, in a terminal:

```bash
cd ~/tools/trailmark
./install.sh
```

Windows: double-click `install.cmd`, or in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\tools\trailmark\install.ps1"
```

The installer downloads nothing and changes no file in the release folder. It stops at the first problem and says what to do. When it's done, set up each repo you want covered (section 4).

It works through these steps in order:

1. It leaves PATH entries that aren't absolute folders (`.`, an empty entry, a relative or drive-relative folder) out of its own run, and says so. Then it checks Node against the security floors and looks for git and `claude` on PATH.
2. It refuses a release folder that someone else could change, and a release that holds links. The exact rules are under "Folder permissions" below.
3. On Windows, it checks `NoDefaultCurrentDirectoryInExePath` (section 9).
4. It runs the sandbox check.
5. It refuses while jb-memory, the name before 0.5.1, is installed at any scope. It also refuses if Trailmark is already installed from another marketplace, or if a marketplace named `trailmark` points at another folder. Two copies would each run every hook.
6. It runs `claude plugin validate` (part of `--check` and `--preflight` too), then `claude plugin marketplace add <folder>` and `claude plugin install trailmark@trailmark` (user scope).

Options:

| install.sh | install.ps1 | Effect |
|---|---|---|
| `--check` | `-Check` | Run the checks only; change nothing |
| `--preflight` | `-Preflight` | The same checks, with jb-memory not counted as another copy. The migration script (section 15) runs this before it removes anything |
| `--codex` | `-Codex` | Also add the Codex marketplace (section 8) |
| (none) | `-Watchdog` | Also install trailmark-watchdog (section 10) |
| (none) | `-SetNoCwdLookup` | Set `NoDefaultCurrentDirectoryInExePath=1` for your user |
| `--allow-old-node` | `-AllowOldNode` | Continue on a Node below the security floor |
| `--repoint` | `-Repoint` | Let an existing `trailmark` marketplace that points elsewhere point here |
| `--uninstall` | `-Uninstall` | Uninstall the plugin and remove the marketplace (section 14) |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Stopped at a failed check. The FAIL line says why |
| 2 | `install.sh` was given an option it doesn't know. From `--uninstall` / `-Uninstall`, a step failed for a reason other than already being gone, or trailmark-codex is still installed in the ChatGPT app (its marketplace is kept until you uninstall it there), or Codex's `config.toml` can't be read |
| 3 | From `install.ps1`: Trailmark was installed but trailmark-watchdog wasn't. The watchdog installer's output says why |

#### Folder permissions

The installer refuses the release folder, or any folder above it, when someone other than you can write to it or replace it. A folder above it must belong to you or to root (Administrators and the system accounts on Windows). A file or the release folder owned by another user is refused on Windows and gets a warning on macOS and Linux.

On macOS and Linux, a group named after you counts as yours only while nobody else is in it, either as a listed member or as their main group. Any other group with write access counts as shared. On Linux, access-list entries (setfacl) that let others write are refused as well. Folders above the release may also belong to root.

On Windows, only you, Administrators, SYSTEM, TrustedInstaller and CREATOR OWNER may hold write rights, compared by SID. An owner or an access rule that can't be identified is refused too.

### By hand

```text
node plugins/trailmark/scripts/trailmark.js --sandbox-check
claude plugin validate <release folder>
claude plugin marketplace add <release folder>
claude plugin install trailmark@trailmark
```

User scope, the default, covers the terminal, the desktop app's local sessions and VS Code, since they read the same settings. `claude plugin list` should show `trailmark@trailmark`, enabled, read from `<release folder>/plugins/trailmark`.

### From a git host

Claude Code can also install straight from GitHub, without a local folder:

```text
claude plugin marketplace add cptjamestiberiouskirk-pixel/trailmark
claude plugin install trailmark@trailmark
```

Claude Code then installs a copy into its plugin cache instead of reading a folder in place, and `claude plugin marketplace update trailmark` fetches new versions. The installers, trailmark-watchdog and the diagnostic scripts assume a local folder, so with a hosted marketplace you use the plugin alone.

## 4. Set up a repo

Trailmark does nothing in a repo until it is set up there. In each repo you want covered:

1. Start Claude Code at the repo's top folder and run `/trailmark:memory-setup`.
2. The skill checks Node, runs the sandbox check and finds Claude Code's memory folder for the repo (`~/.claude/projects/<key>/memory`). It asks whether the repo is public, which turns on extra checks before anything is promoted into committed files. Then it creates `.jbmem.json`, a starting `handoff.md` and the folders it uses.
3. Start a new session (or run `/clear`). A status line starting `[trailmark]` should appear, ending with `sandbox on`. Check the terminal and the desktop app separately: a working terminal says nothing about the desktop app.

To stop using Trailmark in a repo, delete `.jbmem.json` from its memory folder. The hooks go quiet and the files stay where they are.

Every worktree of a repo shares one memory folder, so they share one handoff. Worktrees of a bare repo are the exception. With no main checkout to share through, each has its own.

## 5. Day to day

Most of it happens on its own.

| When | What Trailmark does |
|---|---|
| Session start, `/clear`, after a compaction | Injects the handoff (within its budget) as notes from earlier sessions, and shows `[trailmark] ...` with a token estimate. The extras it adds are listed below |
| Resumed session | One line with the handoff's age, and a request to re-read it if another session wrote it since |
| `git commit` through the Bash or PowerShell tool | Logs each commit it made, in whichever folder it ran, and reminds Claude to checkpoint |
| `gh pr merge` | Logs the merge and reminds Claude to checkpoint |
| A subagent finishes | Reminds Claude to checkpoint if the result changed the state |
| Before a compaction | Saves a snapshot of git state for that session |

After the handoff, session start also lists the commits made on HEAD since the handoff was written, and names any next step one of them may already cover. After a compaction it adds that session's snapshot. It names other sessions active in the repo in the last 3 hours, and warns if a second repo maps to the same memory folder.

The reminders are rate-limited (20 minutes apart by default), and Claude may skip one when nothing material changed.

You call the skills by their full names:

| Skill | When to use it |
|---|---|
| `/trailmark:checkpoint` | Any time you want the handoff brought up to date. Done items are archived word for word |
| `/trailmark:session-end` | Before you stop for the day. It recovers anything the checkpoints missed from the transcript and asks you to approve the final handoff |
| `/trailmark:park` | Save one idea for later without cluttering the handoff |
| `/trailmark:recall` | Search memory, read archived items, measure the budget, undo the last checkpoint |
| `/trailmark:memory-prune` | Shrink what loads every session: archive, dedupe, promote stable facts to path-scoped `.claude/rules` files |
| `/trailmark:memory-setup` | Set a repo up, or re-check one |

Type the full name. Claude Code's own `/rewind` answers to `checkpoint`, so `/checkpoint` alone opens that instead.

Several sessions can work in one repo at once. Every handoff write names the version it started from, and a write based on an older version is refused. The skill then merges the other session's changes and writes again, so neither session can silently undo the other's checkpoint.

## 6. The handoff

The checkpoint skill writes the handoff to a fixed template:

```text
# Handoff: <repo>
Updated: <time> | branch <branch> | HEAD <sha7> | session <id> | by <agent>

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

Every state claim carries an evidence label. CONFIRMED means it was seen in code, output or logs. INFERRED means it follows from confirmed facts. HYPOTHESIZED means it is plausible and unverified. A label is carried forward only while it holds, and evidence from an earlier session says so ("CONFIRMED 10-14, not re-checked"). This keeps a guess from turning into a fact as it passes from session to session.

Decisions carry provenance. Only what you decided or explicitly confirmed is written as `[user ...]`. Claude's own suggestions stay `[proposed]` even when you reacted well, because a wrong attribution would be repeated by every later session as your decision.

Test and build results are written only from output seen in that session, with the time. The handoff stays under 120 lines and 7,000 characters by default, and points at files for detail.

### Changing the conventions

The skills are plain text in `plugins/trailmark/skills/*/SKILL.md`. Edits there take effect at the next session start, and trailmark-watchdog (if installed) reports them like any other change. Two settings are better made in the repo's `CLAUDE.md` (or `AGENTS.md` for Codex), so the skills stay as shipped:

- A model policy. The checkpoint skill adds a `-- model:` note to a next action only when the repo or you set a policy, for example "Planning and review: Opus at high effort. Executing a written plan: Sonnet."
- A different provenance tag, such as your name in place of `user`. Say so in `CLAUDE.md` and keep it the same across sessions. The recall skill treats either form as a decision.

Keep the evidence labels unless you have a reason to drop them. They let the next session tell what was checked from what was assumed.

## 7. Configuration

`.jbmem.json` in the repo's memory folder holds the per-repo settings. Every value is optional. A value outside its range is clamped, and anything that isn't a number falls back to the default.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `budgets.handoffChars` | 7000 | 500 to 100000 | Handoff size limit in characters |
| `budgets.handoffLines` | 120 | 10 to 5000 | Handoff size limit in lines |
| `budgets.injectChars` | 8500 | 2000 to 9500 (8500 in the Codex copy) | Most the session-start injection may hold. Claude Code cuts hook output over 10,000 characters; Codex moves hook output past about 2,500 tokens (roughly 10,000 characters) to a file, so the Codex copy caps all its hook output at 9,000 characters |
| `budgets.memoryMdLines` | 150 | 10 to 1000 | Warning level for Claude Code's own MEMORY.md |
| `budgets.memoryMdBytes` | 20000 | 1000 to 200000 | Same, in bytes |
| `hints.minMinutesBetween` | 20 | 0 to 1440 | Least time between checkpoint reminders |
| `hints.freshCheckpointMinutes` | 3 | 0 to 1440 | No reminder this soon after a checkpoint |
| `staleDays` | 30 | 1 to 3650 | Age at which prune calls an item stale |
| `publicRepo` | false | true or false | Extra checks before anything is promoted into committed files |
| `notes` | true | true or false | `false` turns off the daily log in `notes/` |
| `notesKeepDays` | 90 | 1 to 3650 | Days a daily log file is kept. Older ones are deleted when a new day's log starts |

Environment variables:

| Variable | Effect |
|---|---|
| `JBMEM_SANDBOX=off` | Runs without Node's permission model. Set it in the `env` block of `~/.claude/settings.json` only if the sandbox check fails and you accept the risk. Every session start then warns. `"sandbox": false` in `.jbmem.json` is ignored on purpose |
| `JBMEM_CODEX_SHELL=bash` | Codex copy: read commands as bash on Windows (for an agent running in Git Bash or WSL) |
| `JBMEM_CODEX_INIT=1` | Codex copy: allow `init`, for a repo used only from Codex. Set it for that one command (section 8, step 6), never permanently |
| `JBMEM_SHAPES=off` | Codex copy: stop the payload-shape log |

## 8. Codex (ChatGPT desktop app)

The Codex copy keeps the same handoff in the same folder as the Claude Code plugin. A Codex chat and a Claude Code session in one repo read and write one handoff, with the same version check. A repo you also use in Claude Code is set up from Claude Code (section 4). A repo you use only from Codex is set up by hand, in step 6 below.

1. Add the marketplace: `./install.sh --codex`, `install.ps1 -Codex`, or by hand `codex plugin marketplace add <release folder>`.
2. Restart the ChatGPT desktop app, open Plugins, choose the `trailmark-codex` marketplace and install `trailmark-codex`. The Codex CLI only manages marketplaces. Installing happens in the app, and Codex runs a plugin's hooks only when it was installed there.
3. Review and trust the hooks when the app asks. Each should read `node -e "...PLUGIN_ROOT..." trailmark --hook <name>`. Codex asks again after any change to them.
4. Checkpoints write outside the workspace, so Codex's sandbox refuses the first try and the skill asks you to approve the write. That is the safer default. `plugins/trailmark-codex/README.md`, step 3, explains how to skip the prompts with a writable root and what that costs.
5. On Windows, set `NoDefaultCurrentDirectoryInExePath` (section 9), then restart the app once more so Codex's commands get it.
6. Set the repo up, if Claude Code hasn't. For a repo used only from Codex, run this yourself in a terminal outside Codex, from the repo's top folder (add `--public` for a public repo):

   ```powershell
   $env:JBMEM_CODEX_INIT = '1'
   node "<release folder>\plugins\trailmark-codex\scripts\trailmark.js" init --force
   Remove-Item Env:\JBMEM_CODEX_INIT
   ```

   On macOS or Linux: `JBMEM_CODEX_INIT=1 node "<release folder>/plugins/trailmark-codex/scripts/trailmark.js" init --force`.

   The variable is for that one command only. Set permanently, it would let a Codex session set up any repo on its own. `--force` is needed because, with no Claude Code session ever in the repo, the folder comes from Claude Code's naming formula and can't be confirmed. Claude Code uses the same formula, so it finds the same folder if you open the repo there later.
7. Start a new Codex chat in the repo and ask it to run the `tm-memory-setup` skill.

The Codex skills are named `tm-checkpoint`, `tm-recall`, `tm-park`, `tm-session-end`, `tm-memory-prune` and `tm-memory-setup`.

Codex installs a copy of the plugin in `~/.codex/plugins/cache/`. After updating the release folder, restart the app and trust the hooks again.

After Codex compacts a long chat, the handoff comes back through the SessionStart hook, which the desktop app runs with source `compact`. Codex's PostCompact hook can't add text to a chat, and the Codex copy doesn't use it. Whether the app puts the SessionStart text into the compacted chat hasn't been checked on its own. If the agent seems to have lost the thread after a compaction, ask it to run `tm-recall`.

## 9. Windows: the working-folder lookup

Every hook starts `node` by name. On Windows, cmd.exe and Node's own child_process look in the current folder before PATH. A `node.exe` committed to a repo (or, through cmd, a `node.cmd` or `node.bat`) could then run in place of Node at every hook, as you. One user setting turns that lookup off for cmd and for programs that honor it:

```powershell
[Environment]::SetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', '1', 'User')
```

`install.ps1 -SetNoCwdLookup` does the same. It applies to programs started afterwards, so restart Claude Code, the desktop app and the ChatGPT app. To undo it, set the value to `$null` the same way.

With the setting on Windows 11, Claude Code in the terminal and in the desktop app runs the installed Node (tested). `tools\windows\test-node-lookup.ps1` shows which lookups use the working folder on your PC. Separately from the setting, session start warns if the Node running Trailmark sits in the session's folder or repo, and Trailmark runs git by full path.

macOS and Linux shells don't search the current folder unless PATH holds `.` or an empty entry. The installer warns about both.

## 10. trailmark-watchdog (Windows)

trailmark-watchdog watches the release folder for changes and for content that looks malicious, because Claude Code runs the hooks from there at every session start. It also watches what decides which code Claude Code runs outside that folder: copies of Trailmark in Claude Code's plugin cache, and the hooks, helpers, plugins, marketplaces and MCP servers in Claude Code's user settings. It runs as you, with no admin rights, and never changes anything it watches.

It is a separate, opt-in tool. Neither plugin installs or starts it, and nothing in a plugin folder creates a scheduled task. Only the steps below do.

### Install

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<release folder>\tools\windows\install-trailmark-watchdog.ps1"
```

You can also run `install.ps1 -Watchdog`, or double-click `tools\windows\install-trailmark-watchdog.cmd`.

The installer copies the watchdog to `%LOCALAPPDATA%\trailmark-watchdog` and shows a summary of the folder. It asks you to type `yes` to record that as known-good. Then it adds two scheduled tasks (`trailmark-watchdog` every 15 minutes, `trailmark-watchdog-reminder` at logon and unlock), runs each once and sends a test notification. Run from `tools\windows`, it watches the release folder two levels up. `-Root <folder>` names another.

### Using it

| Task | Command (Windows PowerShell) |
|---|---|
| See the current state | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\trailmark-watchdog\trailmark-watchdog.ps1" -Status` |
| Accept the changes after checking them | The same, with `-Accept` |
| Read the log | `%LOCALAPPDATA%\trailmark-watchdog\watchdog.log` |
| Remove it | `install-trailmark-watchdog.ps1 -Uninstall` (the log and known-good list stay) |

Always accept with the installed copy, as above. The known-good list records the hash of the copy that accepted it, and a scan by a different copy is itself reported.

An unaccepted change is notified again every 24 hours and at logon or unlock (at most once every 10 minutes).

### What the levels mean

| Level | Examples | What to do |
|---|---|---|
| HIGH | Any change to plugin files; a script that downloads and runs code; a new hook that runs something other than trailmark.js; a new Trailmark copy in the plugin cache; something added to what Claude Code's settings run; Defender real-time protection off | Find out where it came from before you accept. A HIGH notification stays on screen until dismissed |
| MEDIUM | A changed script outside the plugin; an archive; a removed settings hook | Check it, then accept |
| LOW | Other files | Accept when convenient |

Updating the release folder (section 12) shows as a set of HIGH changes. That is expected: check that the changes match the release notes, then accept.

### What it doesn't cover

It doesn't watch repo settings (`.claude/settings*.json` and `.mcp.json` in each repo), what other plugins run, the Codex plugin cache under `~/.codex`, or anything behind a link once you've accepted it. It runs as you, so malware running as you could change it or its known-good list. It adds to Defender and doesn't replace it.

### Details

The known-good list also records the folder's layout: `root` for this release (the folder is the marketplace), or `nested` for an older setup with a `jb-memory-marketplace` subfolder. Accepting never switches it on its own, so planting a manifest can't move the watch. If you really did reorganize the folder, accept with `-SetLayout root` or `-SetLayout nested`.

A file over 64 MB is checked by its first and last 8 MB, its size and its time, so one huge file can't make every scan run out of time. Adding one is HIGH. If a scan starts and never finishes, the next one says so in a notification.

## 11. Diagnostic scripts (Windows)

All of these live in `tools\windows`. Run each with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>`. Each writes a `.log` next to itself, which trailmark-watchdog ignores. The read-only ones take `-Repo <path>` and default to the current folder; `trace-handoff-writes.ps1` also needs `-Session <id>`.

| Script | Changes anything | Model calls | Use it to |
|---|---|---|---|
| `check-trailmark-checkpoints.ps1` | No | No | List, per session, the milestones next to the checkpoints, and flag gaps (a compaction with no checkpoint after it, a refused write never redone, a write that skipped the version check) |
| `inspect-last-checkpoint.ps1` | No | No | See how the latest checkpoints were written and what each call returned |
| `trace-handoff-writes.ps1` | No | No | Find what touched the handoff in a time window. Its log keeps command text until the next run |
| `test-node-lookup.ps1` | Its own throwaway folders only | No (Part 2 needs you to start a session) | Check whether a `node` in the working folder can run in place of Node (section 9) |
| `test-trailmark-sessions.ps1` | A throwaway repo, deleted after | Two, or none with `-CliOnly` | Prove two sessions can't undo each other's checkpoints |
| `test-trailmark-roundtrip.ps1` | A throwaway repo, deleted after | Four | Prove a checkpoint written in one session reaches the next |
| `verify-trailmark-hooks.ps1` | A throwaway repo, deleted after | Several | Check every mid-session hook end to end on your machine |
| `test-trailmark-watchdog.ps1` | A throwaway folder under `%TEMP%`, deleted after | No | Check trailmark-watchdog against real Windows features. It shows one real notification |

The test scripts that call the model use `claude -p`, which uses your Claude Code account. Their throwaway repos live in the temp folder, outside the folder trailmark-watchdog watches.

## 12. Updating

1. Replace the release folder's contents with the new release, keeping the same path.
2. In Claude Code, run `/reload-plugins` or start new sessions. Nothing needs reinstalling, since the plugin is read in place.
3. If trailmark-watchdog is installed, check the changes it reports against `CHANGELOG.md`, then accept. If the new release has a new `trailmark-watchdog.ps1`, run `install-trailmark-watchdog.ps1` again so the scheduled copy is the new one, then accept with the installed copy.
4. For Codex, restart the ChatGPT app, open Plugins and choose Upgrade for trailmark-codex when it is offered. Codex runs its own cached copy until then. Trust the hooks again when Codex asks (it asks after any change to them).

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No `[trailmark]` line at session start | The repo isn't set up; the plugin isn't enabled; Node isn't on PATH for that app; Claude Code is too old | Run `/trailmark:memory-setup`; check `claude plugin list`; run `node --version` in a new terminal; update Claude Code |
| The line says `sandbox off` or warns about the sandbox | `JBMEM_SANDBOX=off` is set in user or repo settings | Remove it unless you set it on purpose |
| "Sandbox check failed" or "SANDBOX UNAVAILABLE" | Node is too old or was built without the permission model | Install a current Node LTS and rerun the check. Only if that's impossible, set `JBMEM_SANDBOX=off` (section 7) |
| Warning that Node is older than the security release | Node is below its line's floor | Update Node |
| Warning naming another copy of Trailmark | A stale copy in Claude Code's plugin cache | Remove the named folder, or uninstall the other install (section 15) |
| `/checkpoint` opens the rewind menu | Claude Code's `/rewind` has that alias | Use `/trailmark:checkpoint` |
| A checkpoint write is refused with exit code 3 | Another session wrote the handoff first | Nothing: the skill merges and writes again. Three refusals in a row means two sessions are checkpointing at the same moment |
| Exit code 2 | Over budget | The skill tightens the text and writes again |
| "another trailmark command is using the memory folder" | The lock was busy for over 10 seconds | Wait and retry. The message names what holds it |
| Warning that the memory folder was first used for another repo | Two repo paths that differ only in punctuation map to one folder name (`C:\a-b` and `C:\a\b` both give `C--a-b`), so they share one handoff | Rename or move one repo so the paths differ in letters or digits. Once the other path no longer holds a repo, the next session start takes the record over and the warning stops |
| A list of commits since the handoff, or a note that its HEAD is on another branch | Work was committed after the last checkpoint, or the branch changed | Nothing to fix. It is there so Claude checks the next steps against what was committed before redoing anything. A checkpoint records the new HEAD |
| Commits aren't logged | git isn't on PATH; the commit ran through a tool other than Bash or PowerShell; a hook didn't fire | On Windows, `check-trailmark-checkpoints.ps1` shows what each session ran next to what was logged |
| The installer says Trailmark is installed as another id | An older install from a different marketplace | See section 15 |
| The installer refuses the folder's permissions | A broad group can write there (a second drive's root often lets Authenticated Users modify it) | Move the folder under your user profile, or fix the permissions (section 3, "Folder permissions") |
| "git is kept out of this repo (...)" at session start, or `not read (git kept out: ...)` in a snapshot | Something in the repo's `.git` leads to a network path, or the check can't be sure it doesn't. The word in brackets is the reason (section 16; SECURITY.md, "Known limits", lists what the check looks at) | Fix what the reason names (for example a link in `.git` to a network share, or an include more than ten deep), or work in another clone. The handoff still loads; only commit and branch facts are off |
| A snapshot says `not read (<reason>)` | `git status` was skipped for the reason named (section 16) | Only the list of changed files is missing; the rest of the snapshot is there |
| `status` says a file is a link, or `init` refuses | A dotfile manager (stow and the like) linked `.jbmem.json`, `handoff.md` or the state file into the memory folder. Trailmark never reads through links, so the file counts as missing, and `init` won't set up over it. A linked `MEMORY.md` (Claude Code's own index) doesn't stop `init`, but `status`, `budget`, `prune-report` and `archive-file` say it isn't read | Replace the link with a plain copy of the file it points to |
| A checkpoint or park says a line starts with `JBMEM_EOF` | That is the end marker of the heredoc the Claude Code skills pass text in. A line starting with it could end the heredoc early when the handoff is copied forward | The skill indents the line and writes again. `handoff` and session start show such a line indented |
| Each worktree of a bare repo has its own handoff | Worktrees share a memory folder through a main checkout's `.git`, and a bare repo has none | Nothing to fix. Set up each worktree you use |
| Codex never shows the handoff | The hooks aren't trusted (they must be trusted again after an update that changes them); the app wasn't restarted; the plugin was installed from the CLI | Trust the hooks in the app; restart it; install from the app |
| trailmark-watchdog reports two names that differ only by case | A case-sensitive folder holds both | Remove one. The pair can't be accepted |

## 14. Uninstall

1. For Codex, uninstall trailmark-codex in the ChatGPT app first. The app shows a plugin only through its marketplace, so the marketplace has to outlive the plugin.
2. Run `./install.sh --uninstall` or `install.ps1 -Uninstall`. It runs `claude plugin uninstall trailmark@trailmark` and `claude plugin marketplace remove trailmark`. While Codex's `config.toml` still lists trailmark-codex, it keeps the `trailmark-codex` marketplace and says so; run it again after step 1 to remove that too.
3. If you installed trailmark-watchdog, run `install-trailmark-watchdog.ps1 -Uninstall`. It stays until you do.

Nothing in your repos or memory folders is deleted. Each repo's handoff, archive and logs stay in `~/.claude/projects/<key>/memory`; delete them by hand if you want them gone. After that you can delete the release folder.

## 15. Moving from an older install

### From jb-memory (before 0.5.1)

Trailmark was called jb-memory up to 0.4.5. The memory folders, handoffs and `.jbmem.json` settings carry over unchanged: they keep their file names, and so do the `JBMEM_*` environment variables. What changes is the plugin, marketplace and skill names, so the move is one uninstall and one install.

#### With the migration script

The migration script does the whole move, for Claude Code and Codex, and installs this release with its installer. Extract the release where you'll keep it (section 3) and quit Claude Code and the ChatGPT app. Then run it from a terminal of its own:

```text
node tools/migrate-from-jb-memory.js --dry-run    see what it would do
node tools/migrate-from-jb-memory.js              do it (it shows the plan and asks)
```

On Windows you can double-click `migrate-from-jb-memory.cmd` instead, or pass options to it (`migrate-from-jb-memory.cmd --dry-run`).

In short, it:

- runs the installer's own checks first (`--preflight`), so nothing is removed when the installer would refuse;
- uninstalls jb-memory at every scope Claude Code lists it in, and removes the old marketplace;
- moves old copies out of Claude Code's plugin cache into a backup folder;
- keeps the old Codex marketplace until you have uninstalled jb-memory-codex in the ChatGPT app, then removes it on the next run;
- runs this release's installer;
- checks the result and lists what is left for you, such as installing trailmark-codex in the ChatGPT app.

When Codex's home folder is on a network path, or its `config.toml` can't be read, it leaves every Codex step alone and says so; do those steps by hand ("By hand", below).

It never touches memory folders, handoffs or `.jbmem.json`. The only settings file it changes itself is Codex's `config.toml`, and only with `--clean-codex-trust`. (`claude plugin uninstall` and the installer change Claude Code's settings, and a repo's own settings for a project or local install, as described below.)

Running it again is safe: what is done already is skipped. It refuses to run inside a Claude Code or Codex session, though a `--dry-run` is allowed there.

| Option | Effect |
|---|---|
| `--dry-run` | Show what would be done; change nothing |
| `--yes`, `-y` | Don't ask before changing things |
| `--claude-only` | Leave Codex alone |
| `--codex-only` | Leave Claude Code alone (it still adds Trailmark's Codex marketplace, but not the Claude Code plugin) |
| `--no-install` | Only remove the old install |
| `--keep-project-scopes` | Leave project and local scope installs as they are |
| `--keep-cache` | Don't move old cache copies |
| `--watchdog`, `--no-watchdog` | Windows: install trailmark-watchdog or not (by default, only when the old jb-watchdog is installed) |
| `--scan <folder>` | Also look under a folder (six levels down) for repos whose own settings still turn jb-memory on, such as a repo that moved since Claude Code recorded it. Reported, not edited |
| `--old-release <folder>` | The old jb-memory release folder, for when Codex still has jb-memory-codex installed but its marketplace is gone |
| `--clean-codex-trust` | Remove the hook-trust records Codex keeps for jb-memory-codex in `config.toml` |
| `--backup-dir <folder>` | Where cache copies and the log go |
| `--set-no-cwd-lookup`, `--allow-old-node`, `--repoint` | Passed on to the installer (section 3) |
| `--help` | List every option |

Exit codes: 0 means done; 2 means done, with something left for you (it lists what, or a WARN line says what wasn't done); 1 means it stopped; 3 means `--dry-run` found something to do.

#### What the script does in detail

The script uninstalls jb-memory at every scope Claude Code lists, project and local scopes first and user scope last. If one of those can't be removed (or `--keep-project-scopes` keeps it), jb-memory stays at every scope, its marketplace and cache stay too, and the installer is skipped, since the installer refuses while jb-memory is installed anywhere. You keep a working plugin in every repo, and the list at the end says what to remove by hand. With `--no-install`, which installs nothing, the other scopes are removed anyway.

When a scope can't be removed only after another one was, the one already removed is installed again (and turned off again if it was off there). Claude Code may rewrite that repo's `settings.json` while doing so, and the list at the end then says to check `git diff` there.

A project or local scope install is uninstalled from its repo's folder, which edits that repo's `.claude/settings.json` or `settings.local.json`. Commit a changed `settings.json`, since your teammates read it. When the repo has moved or been deleted, the folder Claude Code recorded is made again, empty, for that one command and removed after.

The old marketplace is removed unless another plugin you still have comes from it, or it also offers plugins other than jb-memory. A marketplace Claude Code copied into its own folder (one added from GitHub or a URL) is kept while Codex may still list jb-memory-codex from that copy, since removing it deletes the folder.

Claude Code leaves old copies in its plugin cache after an uninstall, and Trailmark and the watchdog warn about them. The script moves them into a backup folder (`%LOCALAPPDATA%\trailmark-migration\<time>` on Windows, `~/.local/share/trailmark-migration/<time>` elsewhere), with a log. Nothing is deleted except the empty folder a move leaves behind.

Codex uninstalls plugins only in the ChatGPT app, and the app shows an installed plugin only through its marketplace. So while Codex's `config.toml` still lists jb-memory-codex as installed, the script keeps the `jb-memory-codex` marketplace and the old cache copy, and asks you to uninstall the plugin in the app. Run the script again afterwards. It then removes that marketplace (kept when it offers other plugins too) and moves the old Codex copy to the backup folder.

If the plugin is still installed but its marketplace is already gone, the app can't show it at all. The script then adds the old marketplace back from your old jb-memory release folder, so you can uninstall the plugin in the app. It finds that folder on its own when it sits next to this release with a name starting `jb-memory`, or when it was the old Claude Code marketplace (a local folder, or a copy Claude Code made from GitHub that is still there). Otherwise pass `--old-release <folder>`. When the old Codex marketplace is still configured but no longer offers jb-memory-codex, remove it first (`codex plugin marketplace remove <name>`), then add the old release folder.

Codex keeps a hook-trust record (`[hooks.state."jb-memory-codex@..."]` in `config.toml`) for each hook you trusted, and they stay after the plugin is gone. They do nothing. `--clean-codex-trust` removes them, with `config.toml` backed up to the backup folder first, and only while the ChatGPT app is closed. When an older trailmark-codex is installed, the script reminds you to choose Upgrade in the app.

Then the script runs `install.ps1` or `install.sh`. It adds `-Codex` when Codex is in use (its home folder, `~/.codex` or `CODEX_HOME`, exists, and a link to a folder counts) and the `codex` command is on PATH. On Windows it adds `-Watchdog` when the old jb-watchdog is installed; that installer removes the old watchdog.

When this release is already installed, on or turned off, and nothing else needs the installer (no jb-memory left, the Codex marketplace there when Codex is in use, no watchdog to install), the installer is skipped and the plugin is left as it is. A turned-off Trailmark that only lacks the Codex marketplace gets just that marketplace, and stays off. When jb-memory was turned off at user scope, Trailmark is still installed turned on; the list at the end says how to turn it off.

If the installer stops, the list at the end says how to run it again, or how to put jb-memory back meanwhile. If it stops after jb-memory was removed, the list says how to add jb-memory back from a local copy of the old release, or how to reinstall it from an old marketplace that was kept (for Codex, say). Its GitHub repo under the old name is Trailmark now.

The script warns when this release sits in a downloads, synced or temporary folder, since Claude Code runs the plugin from there. It warns when the `trailmark` marketplace already points at another folder (run it with `--repoint` to point it here). It reports a hook in your Claude Code settings that still runs `jbm.js` (from an install by hand) for you to remove.

#### By hand

1. Uninstall the old plugin and marketplace:

   ```text
   claude plugin uninstall jb-memory@jb-memory
   claude plugin marketplace remove jb-memory
   ```

   `claude plugin list` shows any project or local scope install too. Uninstall each from its repo's folder with `claude plugin uninstall jb-memory@jb-memory --scope project` (or `--scope local`).

   Until you do, the Trailmark installer refuses to install, because two copies would each run every hook. If you install by hand instead, every session start names the jb-memory copy, installed or only cached, until it is gone.
2. Put the new release where you keep it (renaming the folder is optional) and run its installer.
3. Type the new skill names: `/trailmark:checkpoint`, `/trailmark:session-end` and so on. A handoff is only text, so one that still mentions a `jb-memory:` skill name changes nothing. Edit it when it suits you.
4. For Codex, uninstall jb-memory-codex in the ChatGPT app first. Then remove its marketplace (`codex plugin marketplace remove jb-memory-codex`), add this release's (section 8) and trust the new hooks. The order matters: once its marketplace is gone, the app no longer lists the plugin, though `config.toml` still has it installed. If that happened, add the old marketplace back for a moment (`codex plugin marketplace add <old release folder>`), uninstall the plugin in the app, and remove the marketplace again. The skills are now `tm-checkpoint`, `tm-recall` and so on. While a `jb-memory-codex` folder is still in Codex's plugin cache, each chat start warns about it.
5. For the Windows watchdog, run `install-trailmark-watchdog.ps1` from the new `tools\windows`. It records the new folder first and only then removes the old `jb-watchdog` tasks and installed copy, so declining the recording leaves the old watchdog running. The old log and known-good list stay in `%LOCALAPPDATA%\jb-watchdog`; delete that folder once you no longer need them.

Handoffs written before 0.4.0 may carry a name in place of `user` in their decision tags. The skills read both.

## 16. Reference: why git or the file list is skipped

Before git runs in a repo, Trailmark checks that nothing in the repo's `.git` sends git to a network path. When something does, or the check can't be sure, git is kept out of that repo: session start says `git is kept out of this repo (<reason>)`, and a snapshot says `not read (git kept out: <reason>)`. The handoff still loads. SECURITY.md, "Known limits", describes the check in full.

| Reason | What it means |
|---|---|
| `network-config` | A config value or include leads to a network path. A remote's or submodule's address doesn't count; a Git LFS address on a share does. Also an alternate on a network path, and a path the check can't follow: a missing folder followed by `..` (for a pointer or a link inside `.git`, that shows as `network-gitdir` or `linked-gitdir` instead) |
| `network-gitdir` | The `.git` file, `commondir` (the repo's or another worktree's), or another worktree's recorded folder (its `gitdir` file) leads to a network path, or one of those pointers can't be read the way git reads it (a NUL in it, bytes that aren't valid UTF-8, whitespace at either end, or a drive-relative `C:x` or `\x` on Windows) |
| `linked-gitdir` | A link inside `.git` leads to one. On Windows, also a `.git` that is itself a link or junction |
| `many-worktrees` | There are more than 10,000 worktrees to check |
| `many-entries` | `.git` holds more than 100,000 entries besides loose objects and the Git LFS and git-annex stores (the repo's, and those at the top of a submodule's gitdir; loose objects in a folder left in `.git/modules` without a `HEAD` don't count either), so a link could hide past the ones checked. Unpacked branches and their reflogs count: `git pack-refs --all` packs the branches, and git drops old reflogs itself when they expire (90 days by default) |
| `odd-path` | A folder or link name inside `.git` isn't valid UTF-8, so the check can't name what git opens (a plain file with such a name, a branch for example, is passed over); or (macOS, Linux) the session's folder has a `..` after a link that leads somewhere else than it does as text |
| `deep-gitdir` | `.git` has folders nested more than 64 deep |
| `odd-config-path` | An include, a setting that names a file, or an `alternates` entry could be read differently by git and by the check (leading or trailing spaces, `~user/` for someone other than you, `C:x` or `\x` on Windows, bytes that aren't valid UTF-8, quoting git would reject) |
| `unreadable-config` | A config or pointer file isn't a plain small file (for example a link, a folder, a FIFO, a config file over 8 MB, an `alternates` file over 64 KB, or a pointer file over 4 KB) |
| `deep-config` | Includes go more than ten deep |
| `many-config-files` | Includes reach more than 50 files |
| `network-folder` | The folder itself is on a network path other than the session's own share |
| `inside-gitdir` | The session works inside a `.git` |
| `deep-folder` | There are more than 512 folders above it |

With git older than 2.38, a folder above the session with a git-like `HEAD`, `objects` and `refs` is checked as a whole repo, and any of these reasons can come from it.

Before a compaction, the snapshot runs `git status` to list changed files. When that is unsafe or fails, the snapshot says `not read (<reason>)` in place of the list, and the rest of the snapshot is still there.

| Reason | What it means |
|---|---|
| `git kept out: <reason>` | One of the reasons in the table above |
| `linked-folder` | A folder of tracked files is a link to a network path |
| `submodule-pointer` | A submodule's `.git` leads to a network path. Also a `.gitmodules` that is a link, and a submodule gitdir in `.git/modules` that leads to a network path |
| `many-submodules` | More than 2,000 submodules, or more than 2,000 submodule gitdirs in `.git/modules` |
| `outside-worktree` | The repo's `core.worktree` names a folder that isn't the session's folder or above it |
| `lfs-config` | Git LFS runs as a filter and the repo's `.lfsconfig` (the worktree's, else the index's or HEAD's) is a link or includes another file |
| `network-config`, `odd-config-path` | A value in the repo's `.lfsconfig` leads to a network path, or could be read differently by git-lfs and the check (see the table above) |
| `lfs-extension` | Git LFS runs and the repo's own config names an LFS extension program |
| `odd-path` | A tracked path is absolute, holds `..`, or isn't valid UTF-8, or a folder name among the tracked files' folders isn't |
| `many-folders` | The tracked files are in more than 20,000 folders, too many to check for links before `git status` |
| `odd-filter-name` | A filter name has characters other than letters, digits, `.`, `_` and `-` |
| `many-filters` | Tracked files use more than 32 filters |
| `filter-check` | Listing the filters tracked files use failed |
| `git-error`, `git-timeout` | git failed or ran out of time |

[docs/how-it-works.md](docs/how-it-works.md), "git hardening", explains the filter checks.

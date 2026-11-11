# Trailmark

[![tests](https://github.com/cptjamestiberiouskirk-pixel/trailmark/actions/workflows/tests.yml/badge.svg)](https://github.com/cptjamestiberiouskirk-pixel/trailmark/actions/workflows/tests.yml)

A per-project memory for Claude Code and Codex. Each repo gets a short handoff note on where the work stands and what to do next, and every new session starts from it.

![A new session's view: the handoff from the last session, then the commits made since it was written, with the next step one of them may already cover](plugins/trailmark/docs/session-start.png)

## Why

A new Claude Code session starts cold. After a `/clear` or a compaction you explain the project again, or Claude rereads the code and sometimes redoes a fix that was already committed. Claude Code's own memory keeps stable facts about a project. Trailmark adds the part that changes from one session to the next: what was just done, what comes next, the decisions behind it and the questions still open.

Claude updates the note at milestones (a commit, a merged PR, a subagent's result, before a compaction), and Trailmark hands it to the next session within a fixed size budget. It checks the note against git first, so a session sees the commits made since the note was written.

## Features

- A handoff in every new session, kept under 8,500 characters so it fits inside Claude Code's 10,000-character hook limit. A cut note says which sections were left out.
- Commits made since the handoff are listed, with any next step they may already cover.
- Reminders to checkpoint after commits and PR merges (in Claude Code, after subagent results too), and a git-state snapshot before each compaction.
- A request to checkpoint as the session nears auto-compaction, so the note is current before Claude Code summarizes the session (Claude Code only).
- Version-checked writes, so parallel sessions and worktrees can't overwrite each other's notes.
- One shared note for Claude Code and Codex in the same repo; its `Updated:` line names the agent that wrote it last.
- Opt-in per repo. Nothing happens in a repo until you set it up there.

Trailmark runs no background model and makes no network requests, and there's no telemetry. Each hook starts a small launcher that only reads: it runs git with hardened settings to look up commits and status. The part that writes runs under Node's permission model, which lets it write only in the repo's memory folder and start no programs. [SECURITY.md](SECURITY.md) has the full model and its limits.

## What you need

Install these yourself first. The installers check for them and stop or warn, as the last column says. They install none of them, and they download nothing.

| What | Needed for | Notes | When it's missing, the installer |
|---|---|---|---|
| Node.js 24.22.1 or later (22.23.4 or 26.12.1 on those release lines) | Both copies, on Windows, macOS and Linux | Every hook starts `node` from PATH. Use an even-numbered release line: 23 and 25 get no security releases | Stops. On an older Node, or on line 23 or 25, it stops too, unless you pass `--allow-old-node` (`-AllowOldNode`) |
| git | Both copies | Recommended. Without it the handoff still works, but no commits are logged and the note shows no branch or HEAD | Warns |
| Claude Code 2.1.304 or later | The Claude Code plugin, and the installers themselves | Windows, macOS and Linux | Stops without the `claude` command. Warns on an older version |
| The ChatGPT desktop app with Codex mode | The Codex copy | Tested with the app on Windows. With the app on macOS and Linux it is untested, though CI runs the copy's own tests on all three | Doesn't check |
| The Codex CLI (`codex`) | The Codex copy, to add its marketplace | | With `--codex` (`-Codex`): warns and leaves that step out |
| bash | `install.sh` on macOS and Linux | It uses `getent` and `getfacl` for its permission checks when they are there. Neither is required | Can't run without it |
| PowerShell 7 (`pwsh`) | On Windows, the typed commands for `install.ps1` and the optional scripts in `tools/windows` | Not part of Windows: `winget install --id Microsoft.PowerShell --source winget` installs it next to Windows PowerShell 5.1, which stays. Every `pwsh` command in these docs needs it. Double-clicking `install.cmd` needs nothing extra, since it starts the built-in Windows PowerShell 5.1. The optional watchdog needs 5.1, so its commands use `powershell.exe` | Doesn't check which PowerShell runs it |

Trailmark itself needs nothing else: no WSL, no Windows Sandbox and no other package. Its skills run their commands in the shell Claude Code or Codex already uses.

**The sandbox.** In these docs "the sandbox" means Node's permission model (`node --permission`), a part of Node.js itself. It is not the Windows Sandbox feature, and there is nothing to install or turn on for it. It works the same on Windows, macOS and Linux, and CI runs the sandbox check on all three with Node 22, 24 and 26. The installer runs that check (`node plugins/trailmark/scripts/trailmark.js --sandbox-check`, the Claude Code plugin's; the Codex copy has the same one) on your machine and stops if it fails. Codex has a sandbox of its own that decides where the agent may write; the docs call that one "Codex's sandbox".

Installed straight from GitHub, no installer runs. `/trailmark:memory-setup` then checks Node and runs the sandbox check when you set up a repo, and session start warns about a Node that is too old.

## Install

### Claude Code

Straight from GitHub:

```text
claude plugin marketplace add cptjamestiberiouskirk-pixel/trailmark
claude plugin install trailmark@trailmark
```

Or [download a release](https://github.com/cptjamestiberiouskirk-pixel/trailmark/releases), check it against its `.sha256` file, unzip it somewhere permanent that only you can write to, and run the installer. It checks Node, git and Claude Code, and proves the sandbox works on your machine before it installs anything.

| Platform | Command |
|---|---|
| macOS, Linux | `./install.sh` |
| Windows | double-click `install.cmd`, which needs nothing extra. Or, with PowerShell 7 installed ("What you need" above says how to get it), `pwsh -NoProfile -ExecutionPolicy Bypass -File install.ps1` |

`--check` (`-Check` on Windows) runs the checks without changing anything.

### Codex

Part of the install happens in the app, so there is no single command for it.

1. [Download a release](https://github.com/cptjamestiberiouskirk-pixel/trailmark/releases), check it against its `.sha256` file, and unzip it somewhere permanent that only you can write to.
2. Add the Codex marketplace. If you use Claude Code too, run the installer with `--codex` (`-Codex` on Windows, also through `install.cmd`): it installs the Claude Code plugin, then adds the Codex marketplace. The installer needs Claude Code, so for Codex alone add the marketplace by hand:

   ```text
   codex plugin marketplace add <release folder>
   ```

3. Restart the ChatGPT desktop app, open Plugins, choose the `trailmark-codex` marketplace and install `trailmark-codex`. Review and trust its hooks when the app asks. Codex runs a plugin's hooks only when it was installed in the app.
4. On Windows, set `NoDefaultCurrentDirectoryInExePath` ([MANUAL.md](MANUAL.md), section 9) and restart the app once more.

The [Codex copy's README](plugins/trailmark-codex/README.md) and [MANUAL.md](MANUAL.md), section 8, have every step in full, with what has and hasn't been tested.

### Moving from jb-memory

Coming from jb-memory, Trailmark's name before 0.5.0? Run `node tools/migrate-from-jb-memory.js --dry-run` from the release folder (or `migrate-from-jb-memory.cmd --dry-run` on Windows) to see the plan, then run it without `--dry-run` instead of the installer. It removes jb-memory, installs Trailmark and leaves your notes where they are. [MANUAL.md](MANUAL.md), section 15, has the details, with the steps left for you in the ChatGPT app when jb-memory-codex is installed.

### Updating and uninstalling

[MANUAL.md](MANUAL.md) covers both for Claude Code and for Codex: section 12 for updating and section 14 for uninstalling. Neither deletes your notes.

## Quick start

In Claude Code:

1. Open Claude Code in a repo and run `/trailmark:memory-setup`.
2. Start a new session. Look for a status line like `[trailmark] handoff 2 h old, ~900 tokens injected, sandbox on`.
3. Work as usual. Run `/trailmark:checkpoint` whenever you want the note brought up to date, and `/trailmark:session-end` before you stop.

In Codex:

1. Set the repo up. If you also use Claude Code in it, run `/trailmark:memory-setup` there. For a repo you use only from Codex, run the `init` command in [MANUAL.md](MANUAL.md), section 8, step 6, yourself in a terminal.
2. Start a new Codex chat in the repo and ask the agent to run the `tm-memory-setup` skill. It runs the sandbox check and confirms the chat got the handoff. Codex shows a `[trailmark]` message only when there is a warning, so don't wait for a status line.
3. Work as usual. Ask the agent to run `tm-checkpoint` whenever you want the note brought up to date, and `tm-session-end` before you stop. Codex asks you to approve each checkpoint's write, since the note lives outside the workspace.

## Codex

The `trailmark-codex` copy brings the same handoff to Codex. In a repo you use from both, either agent can pick up where the other stopped. What differs from the Claude Code plugin:

- Its skills are named `tm-checkpoint`, `tm-session-end`, `tm-park`, `tm-recall`, `tm-memory-prune` and `tm-memory-setup`, and you ask the agent to run them.
- It has no reminder after a subagent's result and no request to checkpoint as the context fills up.
- Each checkpoint's write needs your approval, unless you make the memory folder a writable root.

[Its README](plugins/trailmark-codex/README.md) lists every difference and what has been tested.

## Optional: the Windows watchdog

`tools/windows` in the downloaded release (not the GitHub marketplace install, which has no release folder of its own) holds trailmark-watchdog, a separate tool that watches the release folder, and what Claude Code's settings run, for changes and for content that looks malicious. It runs as a scheduled task under your account, needs no admin rights, and never changes anything it watches. Neither plugin installs it. See [MANUAL.md](MANUAL.md), section 10.

## Documentation

| | |
|---|---|
| [MANUAL.md](MANUAL.md) | Installing by hand, setup, every setting, Codex, the watchdog, troubleshooting, uninstalling, moving from jb-memory |
| [docs/how-it-works.md](docs/how-it-works.md) | Each hook in detail, how commits are traced, parallel sessions, the sandbox, exactly what is read and written |
| [SECURITY.md](SECURITY.md) | The threat model, known limits, and how to report a vulnerability |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running the tests, keeping the two plugin copies in step, sending changes |

Questions and bug reports go to [GitHub issues](https://github.com/cptjamestiberiouskirk-pixel/trailmark/issues). Security problems go through the private route in [SECURITY.md](SECURITY.md).

## Repository layout

| Path | |
|---|---|
| `plugins/trailmark/` | The Claude Code plugin |
| `plugins/trailmark-codex/` | The Codex copy |
| `tools/windows/` | trailmark-watchdog and the Windows diagnostic scripts |
| `tools/install-check.js`, `install.*` | The installers |
| `migrate-from-jb-memory.cmd`, `tools/migrate-from-jb-memory.*` | Moves a jb-memory install to Trailmark |
| `.claude-plugin/`, `.agents/plugins/` | The Claude Code and Codex marketplace files |

## License

MIT, see [LICENSE](LICENSE). Trailmark began as a rewritten fork of [memory-toolkit](https://github.com/IlyaGorsky/memory-toolkit) 1.9.15 by Ilya Gorsky, also MIT. It used to be called jb-memory; [MANUAL.md](MANUAL.md), section 15, covers moving from it.

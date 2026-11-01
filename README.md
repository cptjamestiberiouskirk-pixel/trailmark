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
- Reminders to checkpoint after commits, PR merges and subagent results, and a git-state snapshot before each compaction.
- Version-checked writes, so parallel sessions and worktrees can't overwrite each other's notes.
- One shared note for Claude Code and Codex in the same repo; its `Updated:` line names the agent that wrote it last.
- Opt-in per repo. Nothing happens in a repo until you set it up there.

Trailmark runs no background model and makes no network requests, and there's no telemetry. Each hook starts a small launcher that only reads: it runs git with hardened settings to look up commits and status. The part that writes runs under Node's permission model, which lets it write only in the repo's memory folder and start no programs. [SECURITY.md](SECURITY.md) has the full model and its limits.

## Install

You need Claude Code 2.1.304 or later and Node.js 24.22.1 or later (22.23.4 or 26.12.1 on those release lines). git is recommended. Windows, macOS and Linux are supported, and CI runs the tests on all three.

Straight from GitHub:

```text
claude plugin marketplace add cptjamestiberiouskirk-pixel/trailmark
claude plugin install trailmark@trailmark
```

Or [download a release](https://github.com/cptjamestiberiouskirk-pixel/trailmark/releases), check it against its `.sha256` file, unzip it somewhere permanent that only you can write to, and run the installer. It checks Node, git and Claude Code, and proves the sandbox works on your machine before it installs anything.

| Platform | Command |
|---|---|
| macOS, Linux | `./install.sh` |
| Windows | double-click `install.cmd`, or `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1` |

`--check` (`-Check` on Windows) runs the checks without changing anything.

Coming from jb-memory, Trailmark's name before 0.5.0? Run `node tools/migrate-from-jb-memory.js --dry-run` from the release folder (or `migrate-from-jb-memory.cmd --dry-run` on Windows) to see the plan, then run it without `--dry-run` instead of the installer. It removes jb-memory, installs Trailmark and leaves your notes where they are. [MANUAL.md](MANUAL.md), section 15, has the details.

## Quick start

1. Open Claude Code in a repo and run `/trailmark:memory-setup`.
2. Start a new session. Look for a status line like `[trailmark] handoff 2 h old, ~900 tokens injected, sandbox on`.
3. Work as usual. Run `/trailmark:checkpoint` whenever you want the note brought up to date, and `/trailmark:session-end` before you stop.

## Codex

The `trailmark-codex` copy brings the same handoff to Codex. It is tested with the ChatGPT desktop app on Windows; Codex runs a plugin's hooks only when it was installed there. In a repo you use from both, either agent can pick up where the other stopped. Installing it takes a few steps in the ChatGPT app; see [its README](plugins/trailmark-codex/README.md) or [MANUAL.md](MANUAL.md), section 8.

## Optional: the Windows watchdog

`tools/windows` holds trailmark-watchdog, a separate tool that watches the release folder, and what Claude Code's settings run, for changes and for content that looks malicious. It runs as a scheduled task under your account, needs no admin rights, and never changes anything it watches. Neither plugin installs it. See [MANUAL.md](MANUAL.md), section 10.

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

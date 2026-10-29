# Trailmark

Trailmark gives Claude Code a memory for each project. A short handoff note says where the work stands, what to do next, which decisions were made and which questions are still open. Claude updates it at milestones, and every new session starts from it, so you don't have to explain the project again after a `/clear` or a compaction.

![A new session's view: the handoff from the last session, then the commits made since it was written, with the next step one of them may already cover](docs/session-start.png)

That's what a fresh session receives: the handoff, then the commits made since it was written, with the next step one of them may already cover.

## What it does

- Every new session gets the repo's handoff, kept under 8,500 characters so it fits inside Claude Code's 10,000-character hook limit. When the note runs long, the cut says which sections were left out and where the full file is.
- The note is checked against git. Commits made since it was written are listed, so Claude doesn't redo finished work.
- After a commit, a merged PR or a subagent's result, Claude is reminded to update the note. Before a compaction, a snapshot of the repo's git state is saved.
- Parallel sessions are safe. Every write names the version it started from, so one session can't silently overwrite another's notes.
- If you also use Codex with trailmark-codex in the same repo, both read and write the same note, and each entry says which agent wrote it.

## What it doesn't do

Trailmark runs no background model and makes no network requests, and there's no telemetry. Each hook is a short Node script that reads git and writes plain text files in one folder. It runs under Node's permission model, so it can't write anywhere else or start other programs. Nothing is written inside your repo.

## Install

You need Claude Code 2.1.304 or later and Node.js 24.22.1 or later (22.23.4 or 26.12.1 on those release lines). git is recommended.

```text
claude plugin marketplace add cptjamestiberiouskirk-pixel/trailmark
claude plugin install trailmark@trailmark
```

You can also [download a release](https://github.com/cptjamestiberiouskirk-pixel/trailmark/releases) and run its installer (`install.sh` on macOS and Linux, `install.cmd` on Windows), which checks your Node version and proves the sandbox works on your machine before it installs anything.

## Set up a repo

Trailmark does nothing until you turn it on for a repo. Open Claude Code in the repo and run:

```text
/trailmark:memory-setup
```

Then start a new session. A status line starting `[trailmark]` and ending with `sandbox on` means it's working.

## Day to day

Most of it happens on its own. These are the skills you call:

| Skill | When to use it |
|---|---|
| `/trailmark:checkpoint` | Bring the handoff up to date. Finished items move to an archive word for word |
| `/trailmark:session-end` | Before you stop. It recovers anything the checkpoints missed and asks you to approve the final note |
| `/trailmark:park` | Save an idea for later without cluttering the handoff |
| `/trailmark:recall` | Search memory, read archived items, check the size budget, undo the last checkpoint |
| `/trailmark:memory-prune` | Shrink what loads every session |
| `/trailmark:memory-setup` | Turn Trailmark on for a repo, or check that its hooks fire |

Type the full name. Claude Code's own `/rewind` also answers to `checkpoint`, so `/checkpoint` alone opens that instead.

## Your data

Everything lives in Claude Code's own memory folder for the repo, under `~/.claude/projects/`, shared by all of the repo's worktrees:

- `handoff.md` is the note itself, with the previous version kept for undo and a history of the last 20.
- `archive/` and `parked/` hold finished items and parked ideas, which are never loaded unless you ask.
- `notes/` is a daily log of events: session starts, commits (short SHA and subject), merges and compactions. It keeps no prompt or reply text, each day's file is deleted after 90 days, and `"notes": false` in `.jbmem.json` turns it off.

To stop using Trailmark in a repo, delete `.jbmem.json` from its memory folder. To remove it entirely, run `claude plugin uninstall trailmark@trailmark`; your notes stay where they are.

## Learn more

- [Manual](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/MANUAL.md): installing by hand, every setting, the Codex copy, the optional Windows watchdog, troubleshooting
- [How it works](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/docs/how-it-works.md): each hook, how commits are traced, parallel sessions, the sandbox, exactly what is read and written
- [Security](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/SECURITY.md): the threat model, its limits, and how to report a problem
- [Changelog](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/CHANGELOG.md)

## License

MIT. Trailmark began as a rewritten fork of [memory-toolkit](https://github.com/IlyaGorsky/memory-toolkit) 1.9.15 by Ilya Gorsky, also MIT.

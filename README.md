# jb-memory

Session continuity for Claude Code. Each repo gets one short handoff file that Claude rewrites at milestones (a commit, a merged PR, a subagent's result, before a compaction) and that every new session in the repo starts from. It stays under a size budget, so it doesn't turn into a per-session token tax, and every write is version-checked, so two sessions in one repo can't undo each other's checkpoints.

A copy for the ChatGPT desktop app's Codex mode shares the same handoff, so Claude Code and Codex can hand work to each other in one repo.

```text
[jb-memory] handoff 2 h old, ~900 tokens injected, sandbox on
```

## Install

Put this folder somewhere permanent that only you can write to, then:

| Platform | Command |
|---|---|
| macOS, Linux | `./install.sh` |
| Windows | double-click `install.cmd`, or `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1` |

Then, in each repo you want covered, start Claude Code and run `/jb-memory:memory-setup`. Nothing happens in a repo until you do.

You need Node.js 24.22.1 or later (or 22.23.4, 26.12.1 in those lines) and Claude Code 2.1.304 or later. git is optional. [MANUAL.md](MANUAL.md) covers installing by hand, every option, the Codex copy, the Windows watchdog and troubleshooting.

## What you get

| | |
|---|---|
| At session start | The handoff, injected as notes from earlier sessions, plus a snapshot after a compaction and a note of other sessions active in the repo |
| After `git commit`, `gh pr merge`, a subagent | The commit or merge is logged and Claude is reminded to checkpoint |
| `/jb-memory:checkpoint` | Rewrites the handoff to a fixed template with evidence labels (CONFIRMED, INFERRED, HYPOTHESIZED) and decision provenance, and archives done items word for word |
| `/jb-memory:session-end` | Recovers what the checkpoints missed from the transcript and asks you to approve the final handoff |
| `/jb-memory:park`, `recall`, `memory-prune` | Park an idea, search and undo, shrink what loads every session |

The hooks run under Node's permission model: they can write only in the repo's memory folder and can't start programs. [SECURITY.md](SECURITY.md) has the full model and its limits.

## In this folder

| Path | |
|---|---|
| `plugins/jb-memory/` | The Claude Code plugin ([README](plugins/jb-memory/README.md)) |
| `plugins/jb-memory-codex/` | The Codex copy ([README](plugins/jb-memory-codex/README.md)) |
| `tools/windows/` | jb-watchdog, which watches this folder and Claude Code's settings for changes, and diagnostic scripts |
| `.claude-plugin/`, `.agents/plugins/` | The Claude Code and Codex marketplace files |

## License

MIT, see [LICENSE](LICENSE). Parts are derived from memory-toolkit 1.9.15 by Ilya Gorsky (MIT).

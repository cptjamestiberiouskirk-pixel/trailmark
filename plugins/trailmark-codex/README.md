# Trailmark for Codex

trailmark-codex gives Codex a memory for each project. Each repo gets a short handoff note on where the work stands, what to do next, the decisions behind it and the questions still open. The note is refreshed after commits and PR merges and before Codex compacts a long chat, and every new chat starts with it, so you don't have to explain the project again or dig back through old chats.

It's the Codex copy of [Trailmark](https://github.com/cptjamestiberiouskirk-pixel/trailmark), tested with the ChatGPT desktop app on Windows. Codex runs a plugin's hooks only when the plugin was installed in the app, so install it there (below).

## What it does

- Every new chat in a repo you've set up starts with that repo's handoff, kept under 8,500 characters so Codex doesn't move it out of the chat into a file.
- After a commit or a merged PR, the agent is reminded to bring the note up to date.
- Every write is version-checked, so two chats, or a chat and a Claude Code session, can't overwrite each other's notes.
- If you also use Claude Code with Trailmark in the same repo, both read and write the same note, so either agent can pick up where the other stopped. The note's `Updated:` line names the agent that wrote it last.

## What it doesn't do

It runs no background model, makes no network requests and sends no telemetry. Each hook starts a small launcher that only reads, running git with hardened settings. The part that writes runs under Node's permission model, which lets it write only in the repo's memory folder and start no programs. The one other file it writes is a small log of hook payload shapes in the plugin's own data folder (see "Checking how the hooks ran").

## Install

You need Node.js 24.22.1 or later (22.23.4 or 26.12.1 on those release lines) and the ChatGPT desktop app. Steps 1 and 5 are checked against Codex's documentation and in the ChatGPT app on Windows, step 2 against the documentation only, and step 3 says what hasn't been checked yet. The handoff, its budget, the commit log, parking, pruning and the sandbox work as [docs/how-it-works.md](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/docs/how-it-works.md) describes for Claude Code; the differences are below.

1. **Add the marketplace.** The release folder holds `.agents/plugins/marketplace.json`, which lists this plugin. With the Codex CLI on PATH:

   ```text
   codex plugin marketplace add <release folder>
   ```

   Restart the ChatGPT desktop app, open the Plugins directory, choose the **trailmark-codex** marketplace and install the plugin. The CLI only manages marketplaces; installing happens in the app.

2. **Trust the hooks.** Codex runs a plugin's hooks only after you review and trust them, and again after any change to them. Each hook should read `node -e "...PLUGIN_ROOT..." trailmark --hook <name>`. In the Codex CLI, `/hooks` lists them.

3. **Writes to the memory folder.** A checkpoint writes the handoff in Claude Code's memory folder for the repo, which is outside the workspace, so Codex asks you to approve each checkpoint write. That's the default and the safer choice: the approval shows the command, so you can see it's the launcher writing.

   To skip the prompts you can make the memory folder a writable root, but know the cost first: every command the agent runs may then write there, not only the launcher. A prompt-injected turn could edit `handoff.md` or `MEMORY.md` directly, past the version check, and that text is injected into every later Codex and Claude Code session in the repo. (It couldn't switch the sandbox off: this copy ignores `"sandbox": false` in `.jbmem.json`.) If you accept that, get the folder from the first line of `node "<launcher>" dir` and add it to `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows):

   ```toml
   [sandbox_workspace_write]
   writable_roots = ['<memory folder, as dir printed it>']
   ```

   Single quotes keep Windows backslashes as they are. Add one entry per repo, and don't add the whole `projects` folder, which also holds Claude Code's transcripts. If the file already has a `[sandbox_workspace_write]` table, add the entry to its list. Whether the Windows sandbox honors this setting hasn't been checked yet; approving each write works.

4. **Windows: keep `node` from being found in a repo folder.** Every hook starts `node` by name. If Codex runs hooks through cmd.exe, cmd looks in the current folder (the repo) before PATH, so a `node.exe` or `node.cmd` committed to a repo would run in place of Node. One user setting turns that lookup off:

   ```powershell
   [Environment]::SetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', '1', 'User')
   ```

   It takes effect for programs started after the ChatGPT app restarts (next step). PowerShell doesn't do this lookup. `tools/windows/test-node-lookup.ps1` shows which lookups on a PC use the working folder, and session start warns if the Node running Trailmark lives inside the session's folder or repo.

5. **Restart the ChatGPT desktop app.** The app copies the plugin to `~/.codex/plugins/cache/<marketplace>/trailmark-codex/<version>/` and runs it from there, so it picks up new files only after a restart. The same goes after every update.

6. **Set up a repo.** If you also use Claude Code in the repo, set it up from there with `/trailmark:memory-setup`. If you use only Codex in it, run this yourself, outside Codex, from the repo's top folder (add `--public` for a public repo):

   ```powershell
   $env:JBMEM_CODEX_INIT = '1'
   node "<release folder>\plugins\trailmark-codex\scripts\trailmark.js" init --force
   Remove-Item Env:\JBMEM_CODEX_INIT
   ```

   On macOS or Linux: `JBMEM_CODEX_INIT=1 node "<release folder>/plugins/trailmark-codex/scripts/trailmark.js" init --force`. Keep the variable to that one command: set permanently, it would let a Codex session set up any repo on its own. `--force` is needed because, with no Claude Code session ever in the repo, the folder comes from Claude Code's naming formula and can't be confirmed. Claude Code uses the same formula, so it finds the same folder if you open the repo there later.

7. **Check it.** Start a new Codex chat in the repo and ask the agent to run the `tm-memory-setup` skill. It runs the sandbox check, finds the memory folder, writes a test note and confirms the session-start note arrived.

[MANUAL.md](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/MANUAL.md), section 8, walks through the same install with more detail.

## Day to day

Most of it happens on its own. Ask the agent to run one of these skills when you want it:

| Skill | When to use it |
|---|---|
| `tm-checkpoint` | Bring the handoff up to date. Finished items move to an archive word for word |
| `tm-session-end` | Before you stop. It recovers anything the checkpoints missed and asks you to approve the final note |
| `tm-park` | Save an idea for later without cluttering the handoff |
| `tm-recall` | Search memory, read archived items, check the size budget, undo the last checkpoint |
| `tm-memory-prune` | Shrink what loads in every chat |
| `tm-memory-setup` | Check that Trailmark works in this repo, or troubleshoot it |

After a long chat compacts, run `tm-recall` if the agent seems to have lost the thread. Whether the app puts the handoff back into a compacted chat hasn't been checked on its own.

## Your data

The note lives in Claude Code's memory folder for the repo, under `~/.claude/projects/`, the same folder the Claude Code plugin uses, so both share it and its `.jbmem.json`. The handoff, the archive, parked ideas and the daily log work as in the Claude Code plugin: the log keeps events (chat starts, commits, merges, compactions) and no prompt or reply text, each day's file is deleted after 90 days (`"notesKeepDays"`), and `"notes": false` in `.jbmem.json` turns it off.

Outside the memory folder, this copy:

- reads folder names in Codex's plugin cache (`%USERPROFILE%\.codex\plugins\cache`, or under `CODEX_HOME`), three levels down, to warn about a leftover `jb-memory-codex`, this plugin's name before 0.5.0. It opens no files there.
- reads Codex's own chat records (`%USERPROFILE%\.codex\sessions` and `archived_sessions`) by session ID only, and only for a chat that started in this repo, for the exit code of a commit command and for the checkpoint skill. It never reads a Claude Code transcript.
- writes `payload-shapes.log` in the plugin's data folder (see below).

## How it differs from the Claude Code plugin

| Area | Claude Code plugin | This copy |
|---|---|---|
| Skill names | `trailmark:checkpoint` and so on | `tm-checkpoint`, `tm-recall`, `tm-park`, `tm-session-end`, `tm-memory-prune`, `tm-memory-setup` |
| Setup | `trailmark:memory-setup` creates the folder | Set the repo up from Claude Code. `init` is refused here, since a folder guessed by this copy could split the handoff in two. For a repo used only from Codex, run `init --force` yourself (Install, step 6) |
| Finding trailmark.js | `${CLAUDE_PLUGIN_ROOT}` in skills | Codex doesn't fill in skill text, so the chat-start note gives the launcher's full path and the session ID, and the skills use those |
| Hooks | `args` arrays, `if` filters, PostToolUseFailure | One command string per hook, the same for PowerShell, cmd and sh. The PostToolUse hook starts on every shell command and leaves at once unless it's a commit or a PR merge |
| Writing text | heredoc, or a drop file in PowerShell | Always a drop file in the memory folder (`incoming-handoff-<session id>.md`), then `--from` |
| Failed commands | PostToolUseFailure | Codex runs PostToolUse after a failed command too. Its exit code, read from the chat's record, decides: a failed commit command still logs the commits it made, with no reminder; a failed PR merge isn't logged |
| Shell | Bash or PowerShell tool | Codex calls its shell tool Bash whatever runs it. On Windows a command is read as PowerShell, the agent's default. Set `JBMEM_CODEX_SHELL=bash` if the agent runs in Git Bash or WSL |
| Chat-start message | Always shown | Codex shows it as a warning, so it's sent only for a real warning (an old Node, other Trailmark copies, a handoff cut short) |
| Size cap | 10,000 characters | 9,000: Codex moves hook output past about 2,500 tokens to a file instead of the chat |
| After a compaction | The SessionStart hook brings the handoff and the session's snapshot back | The same SessionStart hook, which the desktop app runs after a compaction. Codex's PostCompact hook can't add text to the chat, so this copy doesn't use it |
| Commit-folder check | An `END_MISMATCH` diagnostic | None: each Codex command runs in a fresh shell and the chat's folder never moves |

## Checking how the hooks ran

In a repo set up for Trailmark, each hook run that gets past its first checks (a chat start, a compaction, or a commit or PR merge command) adds one line to `payload-shapes.log` in the plugin's data folder (`PLUGIN_DATA`). The line has the event, the tool name, the payload's field names and types, the first word of the command when it's a common program name (git, gh, node, powershell and a few others; anything else shows as `other`), the exit code, and whether `CODEX_THREAD_ID` matches the session ID. It keeps no command text or output, nothing is logged for other repos, and the file stops growing at 256 KB. `JBMEM_SHAPES=off` turns it off. To find it:

```powershell
Get-ChildItem "$env:USERPROFILE\.codex" -Recurse -Filter payload-shapes.log -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
```

Each line also has `resp=`, which describes how a tool result is built (its length, first character, which known markers it holds such as an `exit_code` field, and its JSON keys), and `transcript=`, which names the first two folders under your home that the chat record's path points into (for example `~/.codex/sessions`) and whether it has the `\\?\` prefix. Neither quotes the result or the path in full.

To see one tool result in full, create an empty file named `dump-next-tool-result` in that same folder. The result of the next commit or PR merge command in a repo set up for Trailmark is written to `tool-result-dump.txt` there (the first 3,000 characters of the command and of its result, which can hold anything the command printed), and the request file is removed. Until such a command runs, the request stays armed. The dump and the log are never written through a link or into a file with other hard links. Delete the dump once you've read it.

## What's been tested

With the ChatGPT desktop app on Windows:

- The app's Codex mode runs the plugin's hooks. SessionStart (after a new chat, a resume, a fork and a compaction), PreToolUse, PostToolUse and PreCompact all fired, run by the installed Node with the sandbox on.
- The agent's commands run in PowerShell 7. The shell tool is named `Bash` in the hooks, with the command as a string.
- A tool result is only what the command printed, with no exit code. The chat record holds each command with its exit code just before the hook runs, and the hook reads it from there, waiting briefly if the line isn't written yet. When it can't, a `gh pr merge` counts only if gh printed that it merged the pull request.
- A commit was logged, the reminder reached the agent (it checkpointed unasked), and the checkpoint skill wrote the shared handoff.
- Some paths come with the `\\?\` long-path prefix; the hook removes it before its folder checks.
- The app starts short `fork` chats next to a chat. Each gets the handoff and logs a start; they do no harm.
- `CODEX_THREAD_ID` isn't set in the hooks' environment, so the skills take the session ID from the chat-start note.

Not checked yet: whether `writable_roots` applies under the Windows sandbox, whether a compacted chat gets the handoff text back, and anything on macOS or Linux, where the same hooks and skills are expected to work.

## Tests

```text
node --test tests/trailmark.test.js tests/handoff-checks.test.js
```

CONTRIBUTING.md in the repository covers keeping this copy in step with the Claude Code plugin.

## License

MIT. See LICENSE.

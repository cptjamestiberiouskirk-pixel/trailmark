# trailmark-codex

Trailmark for Codex, in the ChatGPT desktop app or the Codex CLI. Each repo gets a short handoff note on where the work stands and what to do next, with the decisions behind it and the questions still open. The note is refreshed after commits and PR merges and before Codex compacts a long chat, and every new chat starts with it, so you don't have to explain the project again or dig back through old chats.

You turn it on per repo. If you also use Claude Code with Trailmark in the same repo, both read and write the same note, so either agent can pick up where the other stopped. Every write is version-checked, so two chats, or a chat and a Claude Code session, can't overwrite each other's notes.

It runs no background model and makes no network requests. Each hook is a short Node script that reads git and writes text files in the repo's memory folder, under Node's permission model, so it can't write anywhere else or start programs. The one other file it writes is a small log of hook payload shapes in the plugin's own data folder ("Checking how the hooks ran" below). What it adds at the start of a chat stays under 8,500 characters, below the point where Codex moves hook output to a file.

The handoff, its budget, the commit log, parking, pruning and the sandbox work as [docs/how-it-works.md](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/docs/how-it-works.md) describes for the Claude Code plugin. This file covers what differs for Codex, and [MANUAL.md](https://github.com/cptjamestiberiouskirk-pixel/trailmark/blob/main/MANUAL.md), section 8, has the full install walk-through.

## What differs from the Claude Code plugin

| Area | Claude Code plugin | This copy |
|---|---|---|
| Hooks | `args` arrays, `if` filters, PostToolUseFailure | One command string per hook, the same for PowerShell, cmd and sh. The PostToolUse hook sees every shell command and leaves at once unless it is a commit or a PR merge |
| Finding trailmark.js | `${CLAUDE_PLUGIN_ROOT}` in skills | Codex doesn't fill in skill text, so the session-start note gives the launcher's full path and the session ID. Skills use them as `<launcher>` and `<session id>` |
| Skill names | `trailmark:checkpoint` and so on | `tm-checkpoint`, `tm-recall`, `tm-park`, `tm-session-end`, `tm-memory-prune`, `tm-memory-setup` |
| Writing text | heredoc, or a drop file in PowerShell | Always a drop file in the memory folder (`incoming-handoff-<session id>.md`), then `--from` |
| Failed commands | Claude Code's PostToolUseFailure | Codex runs PostToolUse after a failed command too. Its exit code, read from the session's transcript, decides: a failed commit command still logs the commits it made, with no reminder; a failed PR merge is not logged |
| Shell | Bash or PowerShell tool | Codex calls its shell tool Bash whatever runs it. On Windows a command is read as PowerShell (the agent's default). Set `JBMEM_CODEX_SHELL=bash` if the agent runs in Git Bash or WSL |
| Transcript | Claude Code's `~/.claude/projects` | Codex's own rollouts in `%USERPROFILE%\.codex\sessions` and `archived_sessions`, by session ID only, and only for a session that started in this repo. Never a Claude Code transcript |
| Setup | `trailmark:memory-setup` creates the folder | Set the repo up from Claude Code. `init` is refused here, since a folder guessed by this copy could split the handoff in two. For a repo used only from Codex, you run `init --force` yourself with `JBMEM_CODEX_INIT=1` for that one command (see Install, step 6) |
| Session start message | Always shown | Codex shows `systemMessage` as a warning, so it is sent only for a warning (old Node, other Trailmark copies, a handoff cut short) |
| Injection cap | 10,000 characters | 9,000: Codex moves hook output past about 2,500 tokens to a file instead of the context |
| Commit-folder end check | END_MISMATCH diagnostic | None: each Codex command runs in a fresh shell and the session's folder never moves |
| After a compaction | SessionStart with source `compact` brings the handoff and the session's snapshot back | The same SessionStart hook, which the desktop app ran with source `compact` (see "Observed"). Codex's PostCompact hook can't add text to the chat, and this copy doesn't use it. Whether the app puts the SessionStart text into the compacted chat hasn't been checked on its own, so after a long chat compacts, run `tm-recall` if the agent seems to have lost the thread |

## Install

Each step says whether it is CONFIRMED from Codex's documentation or from use with the ChatGPT desktop app on Windows, or still unverified.

1. **Add the marketplace.** The release folder holds `.agents/plugins/marketplace.json`, which lists this plugin. With the Codex CLI on PATH:

   ```text
   codex plugin marketplace add <release folder>
   ```

   Restart the ChatGPT desktop app, open the Plugins directory, choose the **trailmark-codex** marketplace and install the plugin. The CLI only manages marketplaces; installing happens in the app, and Codex runs a plugin's hooks only when it was installed there. (CONFIRMED in the docs and on Windows.)

2. **Trust the hooks.** Codex runs a plugin's hooks only after you review and trust them, and again after any change to them. Each hook should read `node -e "...PLUGIN_ROOT..." trailmark --hook <name>`. In the Codex CLI, `/hooks` lists them. (CONFIRMED in the docs.)

3. **Writes to the memory folder.** Commands the agent runs can write only in the workspace and in writable roots, and a checkpoint writes the handoff in Claude Code's memory folder for the repo, outside the workspace. The default, and the safer choice: approve each checkpoint write when Codex asks. The skills retry a refused write with escalated permissions, which is what makes Codex ask. The approval shows the command, so you see that it is the launcher writing.

   To skip the prompts, you can make the memory folder a writable root. Know the cost first: then every command the agent runs may write there, not only the launcher. A prompt-injected turn could edit `handoff.md` or `MEMORY.md` directly, past the version check, and that text is injected into every later Codex and Claude Code session in the repo. (It could not switch the sandbox off: this copy ignores `"sandbox": false` in `.jbmem.json`.) If you accept that, get the folder from the first line of `node "<launcher>" dir` and add it to `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows):

   ```toml
   [sandbox_workspace_write]
   writable_roots = ['<memory folder, as dir printed it>']
   ```

   Single quotes keep Windows backslashes as they are. Add one entry per repo; don't add the whole `projects` folder, which also holds Claude Code's transcripts. If the file already has a `[sandbox_workspace_write]` table, add the entry to its list. (The setting is CONFIRMED in the docs; whether the Windows sandbox honors it is unverified.)

4. **Windows: keep `node` from being found in a repo folder.** Every hook starts `node` by name. If Codex runs hooks through cmd.exe, cmd looks in the current folder (the repo) before PATH, so a `node.exe` or `node.cmd` committed to a repo would run in place of Node. One user setting turns that lookup off, for cmd and for programs that start others by name:

   ```powershell
   [Environment]::SetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', '1', 'User')
   ```

   It takes effect for programs started after the ChatGPT app restarts (next step). PowerShell doesn't do this lookup. `tools/windows/test-node-lookup.ps1` shows which lookups on a PC use the working folder, and session start warns if the Node running Trailmark lives inside the session's folder or repo.

5. **Restart the ChatGPT desktop app.** A local plugin's new files are picked up only after a restart, and the same goes after every update. (CONFIRMED in the docs and on Windows: the app copies the plugin to `~/.codex/plugins/cache/<marketplace>/trailmark-codex/<version>/` and runs it from there.)

6. **Set up a repo.** If you also use Claude Code in the repo, set it up from there (`/trailmark:memory-setup`). If you use only Codex in it, run this yourself, outside Codex, from the repo's top folder (add `--public` for a public repo):

   ```powershell
   $env:JBMEM_CODEX_INIT = '1'
   node "<release folder>\plugins\trailmark-codex\scripts\trailmark.js" init --force
   Remove-Item Env:\JBMEM_CODEX_INIT
   ```

   On macOS or Linux: `JBMEM_CODEX_INIT=1 node "<release folder>/plugins/trailmark-codex/scripts/trailmark.js" init --force`. Keep the variable to that one command; set permanently, it would let a Codex session set up any repo on its own. `--force` is needed because, with no Claude Code session ever in the repo, the folder comes from Claude Code's naming formula and can't be confirmed; Claude Code uses the same formula, so it finds the same folder if you open the repo there later.

7. **Check it.** Start a new Codex chat in the repo and ask it to run the `tm-memory-setup` skill. It runs the sandbox check, finds the memory folder, writes a test note and confirms the session-start note arrived.

## What it runs, writes and sends

The same as the section of that name in docs/how-it-works.md, with these differences:

- The PostToolUse hook starts on every shell command, since Codex has no per-command filter, and leaves before any git work unless the command is a commit or a PR merge.
- At chat start it reads folder names in Codex's plugin cache (`%USERPROFILE%\.codex\plugins\cache`, or under `CODEX_HOME`), three levels down, to warn about a leftover `jb-memory-codex`, this plugin's name before 0.5.0. It opens no files there.
- It reads Codex's own rollouts (`%USERPROFILE%\.codex\sessions` and `archived_sessions`) by session ID, for the exit code of a commit command and for the checkpoint skill. It never reads a Claude Code transcript.
- Outside the memory folder it writes one file, `payload-shapes.log` in the plugin's data folder (`PLUGIN_DATA`), which records field names and types only and stops growing at 256 KB. `JBMEM_SHAPES=off` turns it off. See the next section.
- Writes to the memory folder go through Codex's approval for commands outside the workspace (Install, step 3).

The daily log, the `"notes": false` switch and the 90-day retention (`"notesKeepDays"`) are the same in both copies, since they share the memory folder and its `.jbmem.json`.

## Checking how the hooks ran

In a repo set up for Trailmark, each hook run that gets past its first checks (a session start, a compaction, or a commit or PR merge command) adds one line to `payload-shapes.log` in the plugin's data folder (`PLUGIN_DATA`): the event, the tool name, the payload's field names and types, the first word of the command when it is a common program name (git, gh, node, powershell and a few others; anything else shows as `other`), the exit code, and whether `CODEX_THREAD_ID` matches the session ID. No command text or output is kept (only the `transcript=` field below names up to two folders under your home), nothing is logged for other repos, and the file stops growing at 256 KB. It is how this copy gets checked against the app: the Windows shell, the payload shapes and the transcript location are documented only in part. To find it:

```powershell
Get-ChildItem "$env:USERPROFILE\.codex" -Recurse -Filter payload-shapes.log -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
```

`JBMEM_SHAPES=off` turns it off.

Since 0.1.4 each line also has `resp=`, how a tool result is built (its length, first character, which known markers it holds such as an `exit_code` field, and its JSON keys), and `transcript=` names the first two folders under your home the transcript path points into (for example `~/.codex/sessions`), and whether it has the `\\?\` prefix. Neither quotes the result or the path in full.

To see one tool result in full, create an empty file named `dump-next-tool-result` in that same folder. The result of the next commit or PR merge command in a repo set up for Trailmark is written to `tool-result-dump.txt` there (the first 3,000 characters of the command and of its result, which can hold anything the command printed), and the request file is removed. Until such a command runs, the request stays armed. The dump, and the log, are never written through a link or into a file with other hard links. Delete the dump once you've read it.

## Tested with the ChatGPT desktop app on Windows

- The desktop app's Codex mode runs the plugin's hooks: SessionStart (sources startup, resume, fork and compact), PreToolUse, PostToolUse and PreCompact all fired, run by the installed Node with the sandbox on. That the `compact` start's text then reached the agent was not checked separately.
- The agent's commands run in PowerShell 7 (`pwsh.exe -Command ...`); the shell tool is named `Bash` in the hooks, with `tool_input.command` a string.
- `tool_response` is only what the command printed, with no exit code (seen with a capture, 0.1.4). The transcript records each command as a `CommandExecution` item under the hook's `tool_use_id`, with `exit_code` and `status`, just before the hook runs; since 0.1.5 the hook reads the exit code from there (a few short waits if the line isn't written yet). When it can't, a `gh pr merge` counts only if gh printed that it merged the pull request.
- The commit was logged, the PostToolUse reminder reached the agent (it checkpointed unasked), and the checkpoint skill wrote the shared handoff.
- Some transcript paths come with the `\\?\` long-path prefix; 0.1.3 removes it before the folder check.
- The rollouts record messages as `item_completed` events (`UserMessage`, `AgentMessage`); 0.1.3 reads those.
- The app starts short `fork` sessions next to a chat; each gets the handoff and logs a session start. They do no harm; what they are for is not known.
- `CODEX_THREAD_ID` is not set in the hooks' environment; the skills take the session ID from the session-start note.

Not seen yet: whether `writable_roots` applies under the Windows sandbox (approving each write works), and anything on macOS or Linux, where the same hooks and skills are expected to work but are untested with the desktop app.

## Tests

```text
node --test tests/trailmark.test.js tests/handoff-checks.test.js
```

CONTRIBUTING.md in the repository covers keeping this copy in step with the Claude Code plugin.

## License

MIT. See LICENSE.

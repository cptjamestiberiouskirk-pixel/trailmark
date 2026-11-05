# How Trailmark works

This is the technical reference: what each hook does, how commits are traced to the folder they ran in, how parallel sessions stay safe, the sandbox, the size budget, and exactly what is read and written. For installing and everyday use, see the [README](../README.md) and the [manual](../MANUAL.md). Paths below are inside the plugin folder, `plugins/trailmark/`, unless they say otherwise.

## What happens automatically

Once Trailmark is installed at user scope, the hooks act only in repos set up with `/trailmark:memory-setup`.

| Event | Hook does |
|---|---|
| Session start, `/clear`, after compaction | Injects the handoff (budget-capped) and adds the notes listed under "Session start" below |
| Resumed session | Injects one line with the handoff's age, not the whole file. If another session wrote the handoff since this one last saw it, the line says so and asks for a re-read |
| `git commit`, including `git -C <path> commit`, run through the Bash or PowerShell tool | Logs the commit to `notes/`, read from the folder it ran in (see "Where a commit ran"), and may remind Claude to checkpoint |
| `gh pr merge` (Bash or PowerShell tool; a `--help` or `-h` call doesn't count), subagent finished | The same reminder, with the same throttle |
| Before a `git commit` or `git -C` command (Bash or PowerShell tool) | Records the folder the command starts in, and the folders its commits go to as read from the text, for the commit hooks. Prints nothing; the only git it runs is the launcher's one-second lookup of the memory folder |
| Before compaction | Writes `snapshots/<session id>.md` (see "Before compaction") |
| After each tool call and prompt, as the context nears auto-compaction (Claude Code only) | Asks Claude to run the checkpoint skill before the compaction (see "Context watch") |

### Session start

At session start, after `/clear` and after a compaction, the hook:

- injects the handoff (budget-capped) and shows `[trailmark] ...` with an estimated token count where the app displays hook messages;
- after a compaction, adds that session's own snapshot;
- at a fresh start, adds another session's snapshot if one from the same folder is newer than the handoff, and names the other sessions active in the repo in the last 3 hours;
- logs a `SESSION_START` line with the sandbox state, the node that ran the hook and Claude Code's entry point (`trailmark.js status` shows the latest);
- on a resume or after a compaction, logs the commits in this session's folders that no hook logged (see "Commits no hook saw").

After the handoff it lists the commits made on HEAD since the handoff was written (its `Updated:` line records HEAD): the newest 10, with their subjects. It names any next-step item that shares two or more words with one of them, so Claude checks before redoing that work. If the handoff's HEAD is on another branch or isn't in this checkout, it says that instead.

The first start records which repo the memory folder serves. When a second repo that still exists maps to the same folder, every start warns.

### Commit commands

After a commit command, the hook logs each commit and checks the reminder throttle. If this session's last checkpoint is older than 3 minutes and this session got no reminder in the last 20, it asks Claude to consider a checkpoint.

Other `git -C` commands also start the hook, which leaves before doing any git work.

A command that commits and then fails (`git commit && git push`, with the push failing) gets Claude Code's PostToolUseFailure event instead of PostToolUse. The same hook runs there and logs the commit, with no reminder. Without a PreToolUse record for that command, only the commits git printed (in the error text Claude Code passes) are logged.

### Before compaction

The PreCompact hook writes `snapshots/<session id>.md` with the branch, HEAD and changed tracked files. Untracked files aren't listed (SECURITY.md says why), and there are no commit subjects. Snapshots older than 7 days are removed.

`git status` runs with any filter the repo itself defines switched off (see "git hardening"). When that can't be done, the count reads `not read (<reason>)`.

### Context watch

Claude Code only. After each tool call and each prompt, the launcher reads the session's context size from the end of its transcript: the tokens of the last main-thread request, plus about one token per four characters of the tool result or prompt that came after it. A tool's result can hold far more than the model is given (an image's base64, an Edit's whole file), so an image counts as 4,784 tokens, the most one costs on Claude's high-resolution tier, and one tool call adds at most 25,000, Claude Code's own limit for a Read or an MCP tool's output. A prompt has no such limit and counts in full. After the session compacts, it stays silent until the next request: the last request's size is from before the compaction, and a prompt (after `/compact`) or a tool result (after an automatic compaction mid-turn) can come before the next request. A subagent's calls are left alone.

It then works out where Claude Code will auto-compact. MANUAL.md, section 7, lists where the window comes from. Compaction comes a fixed amount below the window, about 33k tokens in the transcripts measured (`compact_boundary` entries at 366k and 367k with a 400k window, 967k and 968k with 1M), or at `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` percent of it when that is earlier.

Below 80% of the earliest point any setting allows, the launcher exits before it loads the rest of its code or looks for the memory folder. Most calls cost one read of the transcript's end and the settings files, and start no git. Past that, the sandboxed hook compares the size with the steps (85%, 90% and 95% of the compaction point by default). At the first step it reaches, it asks Claude to run `trailmark:checkpoint` and shows you `[trailmark] Context about ...`. A request made while the transcript's own size is under the first step came from the estimate. It is kept until the transcript itself reaches that step, so an estimate that runs high can't ask on every call. There the steps start over if the handoff was written since, so the next request comes from the real size; otherwise the state carries on from that size. It asks again at a later step only if this session hasn't written the handoff since the first request. The request ignores the reminder throttle and restarts it, so a commit reminder doesn't follow straight away.

It starts over after a compaction, or once the context has shrunk by a fifth or fallen below 75% of the compaction point (after a request made from the transcript's own size); the launcher reads that from the transcript since the last request. It also starts over when the compaction point grows past the biggest one it has asked under, as with a bigger window from another model or a setting. Its state is kept in the session's record in the state file. Before a step is reached, the state is written only to change an earlier request: to clear it when it starts over, or to note what came since (a handoff write, or the transcript reaching the first step after a request from the estimate). `"contextWatch": {"on": false}` in `.jbmem.json` turns it off.

The Codex copy has no context watch: Codex records token counts, but where it compacts by default isn't established, and its hooks have no prompt event.

### Writing the handoff

Writing the handoff stays a model action, through the `trailmark:checkpoint` skill. A hook can remind but can't make Claude write.

When the handoff is saved, `write-handoff` sets its `Updated:` line from the clock, from git (branch and HEAD) and from the agent that wrote it (`by Claude Code`, or `by Codex` from trailmark-codex), so those never depend on the model. It moves `[done]` items verbatim to `archive/<date>.md`. An item whose exact text was already archived that day isn't added twice.

## Where a commit ran

A session often commits somewhere other than its own folder: `cd /e/other-clone && git commit ...` from a worktree, or `git -C <path> commit`. Two hooks work together on each git commit command.

### The PreToolUse record

The PreToolUse hook (`commit-start`) records the folder the command starts in, in `pending/<tool call ID>.json`. With it go the folders the command's commits go to, as read from its text (at most 0.3 s of reading). Other sessions' commit hooks use those too (see "Other sessions committing in the same folder"). The hook runs no git and prints nothing. Its git calls for finding the memory folder get one second each, so a hung git holds the command up for seconds at most.

Only this record says for certain where a command started. Without one (an older Claude Code, a hook that didn't run or timed out), the end folder counts as the start only when the command never moves the shell's own folder, not even back to where it ends. For example, `git commit && cd /abs/clone`, read from the clone, would end where it began. Otherwise a commit whose folder depends on the start is unresolved.

### What Claude Code reports as the folder

Claude Code runs each Bash command as `... && eval <command> && pwd -P >| <file>`, so the session can follow a `cd`. Hooks are given the folder the session is in when they run, and PostToolUse runs after the tool call returns. So the PostToolUse `cwd` is either where the command ended or the session's start folder.

In the code of Claude Code 2.1.42 and 2.1.306 (2.1.304 was not read), after each Bash command the shell is moved back to the folder the session started in in two cases: when `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` is on, or when the command ended outside the session's folders (that start folder and any added with `--add-dir`). Only the second adds `Shell cwd was reset to <folder>` to the output. A subagent's Bash calls never move the session at all (2.1.42), so for them it is the folder the command started in.

What was seen on a Windows test machine with Claude Code 2.1.304:

- After `cd <folder> && git commit` in the Bash tool, PostToolUse got the start folder, both for a folder added with `--add-dir` and for the session's own scratch folder. This was logged as `END_MISMATCH` with `actual=start` (see "Checking the reading").
- The PowerShell tool's `cwd` followed `Set-Location`.
- In one run of `verify-trailmark-hooks.ps1`, its cd-then-pwd check (which reads Claude Code's reset line from the transcript) found the shell back in the start folder after a `cd` to an added folder.

Every reset seen so far was for a folder under `%TEMP%`, which Git Bash shows as `/tmp/...`. Whether that is the reason hasn't been settled.

### Reading the command

The PostToolUse commit hook reads the command the way the shell would, far enough to tell which folder each `git commit` in it ran in. It follows:

- `cd`, `pushd` and `popd` (and `Set-Location`, `Push-Location` and `Pop-Location` for the PowerShell tool), and `git -C`;
- subshells, pipelines, and `{ }` groups (also right after `then`, `do`, `!` or `time`);
- `bash -c` and `powershell -Command`;
- scripts fed to a shell on stdin (`bash <<'EOF'`, `cat <<'EOF' | bash`);
- script files the same command wrote (`cat > fix.sh <<'EOF'` ... then `bash fix.sh`, `./fix.sh` or `source fix.sh`);
- quoting and heredocs, and Git Bash paths such as `/e/x` for `E:\x`.

Some shell features need more care:

- Shell functions run where they are called, with the words they were called with as `"$1"` and `"$@"` (moved by `shift` and `set --`, and split again on blanks when unquoted). A function defined in a subshell is gone after it, one defined in an `if` branch may or may not be there, and `unset -f` removes one. A function named `cd` or `git` is found before the command unless `command` or `builtin` comes first. `return` ends the function and `exit` (or `exec <command>`) the script, except inside a subshell, a pipeline or the background, where they end only that. One that may not run (`[ -d x ] || return`) leaves either folder.
- Code from a variable (`eval "$CMD"`, `$CMD` as a command, `iex $cmd`, `& $x` in PowerShell) may `cd`, so the folder is unknown after it. `eval "$(ssh-agent -s)"` and the like are taken as setting variables only.
- A script file is read again where it runs (`cat > fix.sh`, `echo ... > fix.sh`, `printf`, `tee`, and `>>` to add to one), until another command may change it (`sed -i`, `mv`, `cp`, a `git checkout`). After that, a commit in what it held is unresolved.
- An unquoted heredoc (`<<EOF`) is expanded first: a `$( )` in it runs, and `\$` is a plain `$`. A body that depends on a variable is not read, so a commit in it is unresolved.
- In PowerShell, the right side of an assignment runs (`$null = Set-Location E:\x`, `$out = git commit ... 2>&1`). A script block stored in a variable runs when called (`& $sb`, `. $sb`, `$sb.Invoke()`, `Invoke-Command $sb`), or maybe when handed to a cmdlet such as `ForEach-Object $sb`. `Invoke-Command { }` runs here unless a parameter such as `-ComputerName`, `-Session` or `-AsJob` sends it elsewhere; a parameter it doesn't know leaves the folder unknown. `function global:Go` is called as `Go` with `@args`, `Set-Alias go Set-Location` is followed, and `return` and `exit` end a function or the script (a `finally` block still runs). `Start-Job`, `Start-Process` and `ForEach-Object -Parallel` run elsewhere.

A `git commit` that only appears inside a quoted heredoc, a quoted string, a comment or text a command prints is not a commit. (`awk` is not such a command: its `system()` runs one.) Code that may not run (an `if` branch, a loop body, `test -d x && cd x`, a PowerShell block given to a cmdlet) still counts for the commits in it, but a folder change inside it leaves the folder unknown afterwards.

### Which commits are logged

In each folder a commit ran in, the hook reads the reflog and logs the entries written by `git commit` while the command ran.

The window opens at the earlier of two times: the PreToolUse record's time less a second, and the command's `duration_ms` (which Claude Code passes to PostToolUse) counted back from when the hook's process started, less two seconds. It opens no more than a minute before the time `duration_ms` alone gives, since the record can be older than the command when a permission prompt waited in between. The hook starts after the command ends, sometimes more than a second after on a busy Windows machine, so `duration_ms` alone would open the window after the command's first commit.

Without a record, the window is `duration_ms` back from the hook's start, less five seconds. With a record but no `duration_ms` (the hook for a failed command gets none), it opens at the record's time less a second. With neither, it takes entries no older than a command can run (11 minutes: Claude Code's 10-minute limit plus one, or `BASH_MAX_TIMEOUT_MS` plus one, at most two hours and one minute), at most one per commit in the command, or all of them for a commit in a loop.

A pull, checkout, merge or reset moves HEAD too and isn't logged as a commit. Without a reflog (`core.logAllRefUpdates` off), HEAD counts when its commit time is in the window.

A commit the same command then rewrote is logged as its rebased copy (`(rebased in the same command)`). It is left out when the next reflog entry amended it, and otherwise logged with `(not on HEAD after the command)`: reset away, squashed, or left on another branch (`git commit && git checkout -b b HEAD~1 && git commit`).

A commit is logged once. The hook checks the SHAs it logged before (the last 200, in the state file) and the COMMIT lines of today's and yesterday's log, so another session committing in between can't make it log the same SHA again.

### Other sessions committing in the same folder

Another session's commit command running at the same time can commit in the same folder. That is the case when its PreToolUse record started in the same repo folder (its own top level, so a worktree and the checkout that holds it are apart) and wasn't marked done before this command started. A record of this session's own counts for nothing here: a commit by its own command or subagent is its own either way. Another session's record whose hook never ran (a command denied at the prompt) counts for up to 11 minutes.

When such a command ran, the extra commits can sometimes be left to it. That happens when git printed this command's commits (`[main 1a2b3c4] fix`, read from the tool's output) and the folder has more new commits in the window than the command has `git commit`s. The extra ones are left out if they are exactly the new ones git didn't print that came after the other command started, because the other session's own hook logs them.

Otherwise all of them stay. A quiet `git commit -q`, output cut short, or a commit the command text doesn't show (a git alias such as `git ci`, a post-commit hook, a script) is this command's. If a quiet commit of that kind lands while another session commits in the same folder, it can be left out here; the next sweep logs it as found later.

### Log lines

- A commit in the session's own folder is logged as `COMMIT <sha> <subject>`.
- A commit anywhere else is logged as `COMMIT <sha> in="<folder>" <subject>`, with the repo's top-level folder.
- A commit whose folder can't be known is never logged as another folder's HEAD. It is logged as `COMMIT_UNRESOLVED why=<reason>`, and the reminder still comes.

| Reason | When |
|---|---|
| `unknown-folder` | A variable, a substitution, a glob, `cd -` or `cd a \|\| cd b`, a folder change in code that may not have run, a Git Bash mount like `/tmp`, or a start folder that isn't known |
| `other-repo` | `--git-dir`, `--work-tree`, or `GIT_DIR` set on the command or earlier in it |
| `unrecognized` | `git commit` in a form it doesn't follow, such as `cmd /c`, `python -c` or a background job |
| `nested` | Shells inside shells, too deep to follow |
| `missing-folder` | The folder doesn't exist |
| `network-folder` | A folder on a network path, or a link to one, other than the session's own share |
| `no-repo` | git found no repo there, or git couldn't run |
| `git-kept-out` | git is kept out of that repo (SECURITY.md, "Known limits") |
| `git-timeout` | git ran out of time. The folder joins the session's commit folders, so the next sweep logs the commit, and Claude is told it isn't logged yet (not after a command that failed). While the state file can't be updated (for example, another command holds it for more than 2 s), the folder can't join: Claude is told that a later sweep may miss the commit, and to name it in the handoff |
| `too-many-folders` | More than 4 folders in one command |
| `too-many-commits` | More than 30 commits in one folder |
| `too-long` | The command took over 1.5 seconds to read |

### Checking the reading

The launcher also compares the folder the command ends in, as read, with the PostToolUse `cwd`. When they differ it logs `END_MISMATCH tool=<bash|powershell> parsed="<folder>" actual="<folder>"`, with `actual=start` when the PostToolUse `cwd` is the folder the command started in and `actual=home` when it is the folder the session started in.

This line changes nothing. It counts how often the reading of a command, or the assumption that Claude Code moves the session, is wrong. It needs a PreToolUse record and an end folder the reading knows (`git commit && cd x` leaves it unknown, since the `cd` may not run).

### Commits no hook saw

A commit made by a script the command didn't write, by a git command the hooks' `if` filter doesn't match, or while a hook didn't run, leaves no COMMIT line. The launcher sweeps for these at `write-handoff` with `--session`, and when a session resumes or compacts.

The sweep reads the reflog of each folder the session used: the folder it started in, the one it is in, and the session's commit folders (up to six): those its logged commits went to, and those a commit may still be logged from (git timed out there, or a command sent to the background commits there). It logs entries that meet all of these:

- written by `git commit` since that folder's last sweep, and before the second the sweep started. A folder not read yet starts at the session's start for the folders the session started in and is in, and for a commit folder at the start of the command that made it one (its window, as for a commit hook, or the session's start when neither a record nor `duration_ms` gives one); never more than a day back;
- still reachable from a ref (a branch, a tag, a remote, the stash, another worktree's `HEAD` or any other ref) and not amended away;
- not already in a COMMIT line or the state file.

They are logged as `COMMIT <sha> [in="<folder>"] <subject> (found later)`, and `write-handoff` says how many. Each folder keeps its own start in the session's record (`swept`), so a folder that couldn't be read (gone for a while, slow, or past the time budget) is read from where it was when it is back, up to a day. A sweep that runs out of time before it has read every folder (git slowed by other work on the machine) says so: `write-handoff` prints "commit sweep skipped: out of time", and session start shows it as a warning. The folders it didn't read keep their start for the next sweep.

Someone else working in the same folder (by hand, or a tool) is not told apart from the session, so "found later" means found in its folders, not proved to be its own.

Past six commit folders, one that a sweep has read since the last command that made it one finished goes first, the oldest such; for a command sent to the background, finished means its time is up (the 11 minutes above). Only when none has been read that far does the oldest go.

A folder that has a memory folder of its own (another clone set up for Trailmark) is swept past the commits logged there and the commit commands still running there, since those belong to its sessions. That memory folder is found by Claude Code's usual project-folder name only. One that Trailmark finds only by searching other transcripts isn't looked for here (the search has no time limit), so that clone's commits get no such exclusion.

Another session's commit command that may still be running is left alone. The sweep stops a second before the start of the earliest PreToolUse record younger than 11 minutes whose PostToolUse hook hasn't logged it, and the next sweep starts there. Each commit hook (PostToolUse, or PostToolUseFailure for a command that failed) marks its command done when it finishes (`pending/<tool call ID>.done`), whether it logged anything or not. The sweeping session's own records don't hold it back: a commit by its own command, or by its subagent running in parallel, is its own either way. Another session's command whose hook never ran (denied at the permission prompt, stopped with Esc, a hook that timed out) holds the sweep back until its 11 minutes pass, or until the same thread of that session (its main conversation, or the one subagent, told apart by the hook's `agent_id`) finishes a commit command it started later. One thread runs its commands one at a time, but subagents can run alongside it. A record from Codex, which gives no subagent ID, holds the sweep until its 11 minutes pass whichever copy sweeps, and so does a command sent to the background (`run_in_background`), which returns before it has run, so its hook neither marks it done nor counts it as finished. Its hook, which usually runs before the commit exists, tells Claude once that its commits are picked up by a later sweep (not while another command holds the state file for more than 2 s, and not when the commit already exists and no reminder is due). Each other folder it commits in (`git -C`) joins the session's commit folders when its hook runs, whether or not it has committed there yet, so that sweep reads it.

### Sessions that work in another repo

When the session's last command left it in another repo it may use (a folder added with `--add-dir` or `additionalDirectories`), the hooks find the memory folder from where the session started. That is the first transcript record's own `cwd`, never one inside a tool call's arguments. A first line longer than the 64 KB read is scanned for it.

The session's record keeps the folder of its last logged commit. `write-handoff` takes the `Updated:` line's branch and HEAD from there, so a session whose work went to another clone shows that clone's, not its own worktree's. The line names the folder whenever it isn't the main checkout: `Updated: <date> <time> | branch <b> | HEAD <h> | in <folder> | session <id> | by <agent>`. A session in the main checkout gets the line with no folder.

### What it still reads wrong

- A commit that something else made in that folder while the command ran (another session committing in the same clone at the same moment) is logged as this session's when git's output doesn't settle it (see "Other sessions committing in the same folder").
- A `cd` to a folder that doesn't exist is taken as done (`cd sub || true` too), so commits after it are reported as `missing-folder`.
- A script file the command didn't write (`bash ./release.sh`) is not read, so a commit only inside it is not logged. The hook's `if` filter only sees the command text anyway.
- Sourcing such a file (`source .venv/Scripts/activate`) is taken as leaving the folder alone.
- A function defined inside a pipeline element (`f() { ...; } | cat`) is taken as defined afterwards.
- `"$1"` outside a function is unknown, not empty.

## Several sessions at once

Every session in a repo, and every worktree of it, shares one memory folder and one handoff. Worktrees of a bare repo each have their own, since there is no main checkout to share through. Without a check, two sessions checkpointing from different starting points would mean the second write silently replaced the first. These rules prevent that:

- `handoff` prints a version (the first 12 hex digits of the file's SHA-256), and `write-handoff` must name the version it was based on with `--base=<version>`. If another session wrote in between, the write is refused with exit code 3. The refusal lists what the other session added and removed, and prints the current handoff with its version, so Claude can merge and write again. The checkpoint and session-end skills say how. `--force` skips the check and is meant for use by hand.
- Every read-modify-write of a shared file (the handoff, the state file, rotate, undo, park, archive-file's edit of MEMORY.md) runs under a lock file, `.jbmem.lock`. Commands hold it for milliseconds. A lock is broken only when its holder is gone: the process ID in it is no longer running on this machine and the lock is over 5 seconds old, or it holds no process ID and is over 30 seconds old, or it is over 60 seconds old. A command that can't get the lock in 10 seconds (2 for a hook) gives up without writing.
- A file that has to be read before it is rewritten (the state file, the day's archive, the handoff) stops the command when it can't be read, instead of being replaced by a copy missing what couldn't be read.
- Files are written to a temp file with a random name, created exclusively, then renamed into place, so a link planted at a predictable name is never written through. The day's notes file and the copy of a broken state file are checked the same way. Setup creates the marker and the starting handoff only if they don't exist yet.
- On Windows, a rename or delete refused because another program has the file open (an antivirus scan, a sync client) is retried for up to 2 seconds.
- Skills pass the session ID Claude Code substitutes for `${CLAUDE_SESSION_ID}`, and hooks take it from their payload. It keys the per-session state: when the session started, its last checkpoint, its reminder throttle and the transcript path Claude Code reported. So `transcript --session=<id>` reads this session's own transcript instead of the newest one in the folder. `--since=checkpoint` means since this session's last checkpoint, because another session's checkpoint didn't save this one's work.
- `undo-handoff` works only for the session that wrote the current version, and only while `handoff.prev.md` is still the version that write replaced. Undoing anyone else's write would throw their work away, and restoring a version another session undid would bring back text it rejected. Without a session ID it needs `--force`, and so does undoing a checkpoint made before a `/clear` (which starts a new session ID). The version it replaces goes to `archive/handoff-history/` first.
- The `Updated:` line, log lines in `notes/` and `status` name the session that acted, by the first 8 characters of its ID.

Nothing here decides who should write. Every session can checkpoint, or one lead session can own the handoff while the others park ideas or leave notes. The version check keeps either way safe.

## Sandbox

Every hook and skill command enters through `scripts/trailmark.js`. The launcher only reads: it finds the repo's memory folder and collects the git facts the hooks need. It then runs the real script under Node's permission model with these grants:

| Grant | Scope |
|---|---|
| Write | The repo's memory folder only |
| Read | The plugin folder and the memory folder (plus Claude Code's projects folder for `transcript`; in the Codex copy, Codex's `sessions` and `archived_sessions` folders) |
| Child processes, workers, native addons | None |

The sandboxed script gets the launcher's environment without `NODE_OPTIONS` or any other `NODE_*` variable, which could otherwise carry permission flags that undo these grants. It also gets no inherited `JBMEM_*` variables, which could choose the memory folder. Its subfolders (`snapshots/`, `archive/`, `parked/`) must be real folders, not links, since the permission model follows a link out of a granted folder.

Node describes the permission model as a seat belt that stops trusted code from touching the wrong files, not as protection against malicious code. `trailmark.js --sandbox-check` proves it on the current machine. A refusal during a session shows as a `[trailmark] sandbox refused ...` message.

`JBMEM_SANDBOX=off` turns the sandbox off. For every session, put it in the `env` block of `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows), where trailmark-watchdog sees it. A repo's own `.claude/settings.json` can set it too, through its `env` block, so whenever the sandbox is off the session-start message says so as a WARNING.

`"sandbox": false` in `.jbmem.json` is ignored, with a warning at session start. Claude Code may write in its own memory folder, so a session steered by text it read (a web page, a file in a repo) could otherwise switch the sandbox off for every later session.

Use a Node release that has the October 2026 security fixes (24.22.1, 22.23.4, 26.12.1 or later; see https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). Two of the permission-model fixes matter here. CVE-2026-58043 (July) could over-grant access across path-prefix boundaries, and CVE-2026-106073 (October) let `fs.realpathSync` get past the permission model. On the 26 line, the October release also fixed CVE-2026-106071, another filesystem over-grant.

The sandbox check tests one look-alike prefix case and passes on older releases too, so it also compares `node --version` with that list and prints a WARN line when Node is older. Session start does the same: an older Node gets a WARNING in the start message, and `check-trailmark-checkpoints.ps1` flags a session whose latest start ran on one. The permission model also follows a symbolic link out of a granted folder, which the check doesn't test.

`--from=<file>` is read by the launcher before the sandbox starts, so it must name one file inside the memory folder. Anything else, a second `--from`, or a file with another hard link is refused, and the file is read through the same handle that was checked. After a save, only the files the skills write their text to (`incoming-handoff*.md`, `incoming-park*.md`) are removed; any other file named with `--from` stays.

A memory folder set outside Claude Code's projects folder (`autoMemoryDirectory`) gets no grant on its parent folder, so setup creates it before the sandbox starts.

## git hardening

The launcher runs git without a shell and with timeouts. It runs git by full path, found on absolute PATH entries only: on Windows, Node would otherwise look for `git.exe` in the repo folder first, so a repo could ship its own. Every call has `--no-optional-locks`, so a hook's `git status` never takes `.git/index.lock` while another session commits.

The commit hook runs git in folders named in command text, so every git call is hardened against the config of the repo it runs in (`lib/gitbin.js` lists each setting and why):

- no fsmonitor and no hooks;
- no bare repo found by searching;
- no transport of any kind, so a partial clone's lazy fetch can't run the repo's `ext::` command, `uploadpack`, `sshCommand` or credential helper;
- no signature program, no git started in submodules, no pager or color.

`GIT_DIR` and the other repo-location variables are dropped. Before git runs in a folder at all, the `.git` above it is checked for anything that would send git to a network share; SECURITY.md, "Known limits", describes the check.

### Filters and `git status`

The PreCompact hook's `git status` would run a clean or process filter when a tracked file's timestamps changed. So it first lists the filters tracked files use (`git ls-files -z | git check-attr --stdin filter`) and where each one's settings come from (`git config --show-scope`).

A filter with any setting in the repo's own config is switched off for the call (`-c filter.<name>.clean=` and the same for `smudge` and `process`, `required=false`). The snapshot says how many tracked files use one, since they can then show as modified when they aren't. A filter set only in the user's global or system config keeps running, and so does Git LFS set up in the repo's own config with exactly what `git lfs install --local` writes.

Git LFS also runs extension programs named in config (`lfs.extension.<name>.clean`), so while LFS runs, such a setting in the repo's own config skips `git status`.

`git status` is also skipped, with the snapshot saying `not read (<reason>)`, in these cases:

| Reason | When |
|---|---|
| `lfs-extension` | The repo's own config names an LFS extension program while LFS runs |
| `odd-filter-name` | A filter name isn't plain letters, digits, `.`, `_` and `-` |
| `many-filters` | More than 32 filters |
| `filter-check` | Listing the filters failed |
| `git-error`, `git-timeout` | git failed or ran out of time |
| `odd-path` | A tracked path is absolute, holds `..`, or isn't valid UTF-8 (git keeps such a path as raw bytes, which the checks can't name exactly) |
| `many-folders` | The tracked files are in more than 20,000 folders, too many to check for links |
| `linked-folder`, `submodule-pointer`, `many-submodules`, `outside-worktree` | A folder of tracked files, a submodule or `core.worktree` leads where the check can't follow (MANUAL.md, section 16) |
| `lfs-config` | While git-lfs runs, the repo's `.lfsconfig` (the worktree's, else the index's or HEAD's copy) has includes, or the worktree's copy is a link (a value there that leads to a share gives `network-config`) |

What is left: a filter program the user installed (global or system config) runs as usual and reads the repo's config as it chooses. git-lfs itself is one.

The listing reads every tracked file's attributes once more, which adds time on a large repo (about 0.2 s for 60,000 files on Linux).

## How injected text is framed

Injected state is framed as notes from earlier sessions, not user instructions. The frame lines carry a random marker at each session start. Lines inside that look like frame or plugin lines are indented, so saved text can't close the frame early. They are judged after invisible characters, look-alike dashes and brackets, and every kind of line break have been turned into plain ones. Tag-like text (`<name>`, `</name>`) gets a backslash after the `<`, so it can't pose as markup.

The whole injection is cut to fit Claude Code's 10,000-character limit whatever the budgets say. The compaction snapshot carries no commit subjects and is labeled as repo data. Branch names are flattened to one word: spaces of every kind, and invisible and blank-looking characters, become `_`.

## Skills and other copies

At session start the launcher looks in Claude Code's plugin cache (`<config>/plugins/cache/<marketplace>/<plugin>/<version>`) for other copies of Trailmark. A copy is a folder named `trailmark` or `jb-memory` (the name before 0.5.0), or one holding `scripts/trailmark.js` or the old `scripts/jbm.js`, other than the running copy and the Trailmark that Claude Code lists as installed in `plugins/installed_plugins.json`. An installed copy under the old name is named too, since it runs every hook next to Trailmark.

The start message gives how many it found, in fixed text, and a command that lists them by full path: `node "<launcher>" --copies`, with the launcher's path filled in. A path that holds a character a shell would act on inside the quotes (`$`, a backtick, `%`, `!`, a curly double quote, two backslashes in a row), or one Trailmark changes in text it passes on (a control or invisible character, a `"`, two spaces in a row, a space at either end), or one over 1,024 characters, isn't filled in, and the message says so instead. It names no folder, since a folder's name is text whoever made it chose. `--copies` names them, with control, line-break and invisible characters (a bidi override among them) shown as `<U+XXXX>`, and a `<` before `U+` shown as `<U+003C>`, so the escape and the same text in a name can be told apart. When the user asks about the copies, Claude is told to give them that command to run in a terminal and not to run it itself, so the names reach Claude only if the user shows it the output. It tells Claude never to run another copy's scripts. Without that, a session could find an old cached copy by searching the disk and write the handoff with it, skipping the version check.

Call a skill by its full name: `/trailmark:checkpoint`, and `trailmark:checkpoint` for the Skill tool. Claude Code's built-in `/rewind` has the alias `checkpoint`, and the Skill tool refuses that name as a built-in command. In the code of Claude Code 2.1.306 and 2.1.309, the alias list is `checkpoint` and `undo`, and the Skill tool takes a command whose name matches exactly before any alias. So the full name reaches Trailmark's skill, and a bare name goes to the first command with that alias. A typed `/checkpoint` most likely opens `/rewind`; that has not been tested. The hook reminders give the full skill name, and say what to do if it won't load.

The skills are listed in the [plugin README](../plugins/trailmark/README.md).

## Size budget

Files on disk cost nothing until something reads them. Two things load every session: Claude Code's own MEMORY.md (first 200 lines or 25 KB) and the SessionStart injection (Claude Code cuts hook output over 10,000 characters to a 2,000-character preview). `trailmark.js budget` measures both against these defaults, which you can override in `.jbmem.json`:

| Budget | Default |
|---|---|
| handoff | 120 lines, 7,000 chars (~1,750 tokens) |
| SessionStart injection | 8,500 chars |
| MEMORY.md | 150 lines, 20 KB |

Each budget in `.jbmem.json` must be a number. One outside its allowed range is clamped (the injection to at most 9,500 characters), and anything else falls back to the default.

The whole injection, the commit list and any warnings included, stays inside the injection budget. When the handoff has to give way, the cut ends with a line saying how much was shown, which sections were left out (the rest of the one it stopped in, then up to five more by heading) and the full file's path, so Claude knows to read it.

## What it runs, writes and sends

All of this happens only in repos set up with `/trailmark:memory-setup`. In any other repo each hook exits before it does anything.

| Hook | Runs | Writes, in the memory folder |
|---|---|---|
| SessionStart | git: branch, top-level folder, HEAD's history since the handoff, commits in this session's folders | One log line, the state file |
| PreToolUse (Bash and PowerShell, `git commit` and `git -C`) | The launcher's `git rev-parse` to find the memory folder (one second) | `pending/`: where the command starts |
| PostToolUse (the same commands, and `gh pr merge`) and PostToolUseFailure (the same commands, without `gh pr merge`) | git: the commits the command made | Log lines, the state file |
| PostToolUse (Agent, Task) | Nothing | The reminder time in the state file |
| PreCompact | git: branch, HEAD, status | `snapshots/<session>.md`, one log line |
| PostToolUse (every tool) and UserPromptSubmit | Nothing below 80% of the earliest compaction point. Past it, the launcher's `git rev-parse` to find the memory folder | The session's context-watch state in the state file, when it changes |

Every hook goes through `scripts/trailmark.js`, which only reads. It runs git by full path, without a shell, with timeouts, and with every repo setting that could start a program switched off (`lib/gitbin.js` lists them). The git subcommands it uses are `rev-parse`, `branch`, `log` (also over the reflog), `rev-list`, `merge-base`, `status`, `ls-files`, `check-attr`, `config --show-scope`, and `config --file` to read a repo's own config files before git runs there. Then it starts the script that writes, under Node's permission model: that script can write only in the repo's memory folder, and can't start programs.

It writes only in the memory folder listed in "Where files live": nothing in the repo, nothing in Claude Code's settings, no CLAUDE.md, no shell profile. The skills write the handoff, parked ideas and the archive in the same folder. memory-prune edits CLAUDE.md only when you ask it to.

Besides the repo, which it reads through git, it reads:

- the memory folder;
- Claude Code's `settings.json` (for `autoMemoryDirectory`) and the first lines of transcripts in its projects folder, to find the memory folder;
- `installed_plugins.json` and the plugin cache, to warn about other Trailmark copies;
- for the context watch, the end of the session's own transcript (1 MB, up to 32 MB when it has to look further back) and Claude Code's settings files (its `settings.json`, and the project's `.claude/settings.json` and `.claude/settings.local.json`, up to 1 MB each);
- the session's own transcript, when the checkpoint skill asks for it.

It sends nothing. No script opens a network connection (a test checks that none loads Node's network modules), there is no telemetry, and no model is called outside the session you're in.

The daily log in `notes/` holds events only: session starts (with the sandbox state and which Node ran), commits (short SHA and subject line), PR merges (flag names only), compactions, and lines you ask for with `note`. It keeps no prompt or reply text. A day's file is deleted 90 days after its date, when a new day's log starts. `"notesKeepDays"` in `.jbmem.json` sets another number of days, and `"notes": false` turns the log off.

The plugin works from its own folder alone. The hooks need only `node` on PATH; the installers in the release add checks around the install, nothing the hooks rely on.

## Where files live

In Claude Code's auto-memory folder for the repo (`~/.claude/projects/<project>/memory/`). Every worktree of the repo shares it, except the worktrees of a bare repo, which each have their own. When git is too slow to say where the repo starts (it times out), trailmark finds the repo the way it does when git is kept out, from the `.git` entries on disk, so a worktree or subfolder still gets the shared folder.

```text
.jbmem.json        opt-in marker and budgets
handoff.md         the state register (injected)
handoff.prev.md    previous version (undo-handoff)
.jbmem-state.json  commits logged (last 200), last writer, per-session records (14 days),
                   the repo root this folder serves
.jbmem.lock        present only while a command is changing shared files
snapshots/         one compaction snapshot per session (7 days)
precompact.md      snapshot left by 0.2.x releases, which had no session ID
archive/           verbatim archived items and files (never injected)
archive/handoff-history/  copy of the handoff before each overwrite (last 20)
parked/            parked ideas (only the count is injected)
notes/             daily log: session starts, commits, merges, compactions (90 days)
pending/           where each recent git commit command started (6 hours)
```

## Compared with memory-toolkit

Trailmark began as a rewritten fork of memory-toolkit. It differs in these ways:

- Checkpoints happen at milestones, not only at the end of a session. The failure mode is staleness between syncs, not a missing end event.
- Size budgets are hard, with truncation, instead of injecting the whole handoff.
- There is no background watcher. The same extraction runs on demand from the transcript, in the main session, with the user reviewing it.
- A repo has to opt in with a marker. memory-toolkit wrote notes into any repo that had an auto-memory folder.
- Windows paths resolve correctly, and resolution is worktree-aware, matching Claude Code's per-repo memory.
- There is no `jq`, `python3` or `/tmp`. Content reaches the CLI on stdin, or from a file with `--from=<path>` in PowerShell sessions, where piping into a command needs manual approval every time.
- git is hardened as described in "git hardening", and injected text is framed as described in "How injected text is framed".

## Tests

From the repository root:

```text
node --test plugins/trailmark/tests/trailmark.test.js plugins/trailmark/tests/handoff-checks.test.js
node plugins/trailmark/scripts/trailmark.js --sandbox-check
```

CONTRIBUTING.md covers the Codex copy's tests, CI and the Windows scripts.

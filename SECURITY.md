# Security

Trailmark runs code as you at every Claude Code session start and compaction, and after every tool call and prompt. The Codex copy does the same at every Codex chat start and compaction, and around every shell command. This file says what that code can and can't do, what it trusts, and what's left to you.

The short version: the part that writes runs under Node's permission model and can write only in the repo's memory folder. git runs with every repo setting that could start a program switched off, and is kept away from network shares. Nothing in the release makes network requests. The limits that remain are listed under "Known limits".

## Reporting a problem

Report a security problem privately through GitHub: on the [repository](https://github.com/cptjamestiberiouskirk-pixel/trailmark), open the Security tab and choose **Report a vulnerability** (https://github.com/cptjamestiberiouskirk-pixel/trailmark/security/advisories/new).

Please don't open a public issue for anything that lets a repo, a web page or another program run code or change memory through Trailmark until a fix is out. Other bugs go in the repository's [issues](https://github.com/cptjamestiberiouskirk-pixel/trailmark/issues).

## What runs, and with what rights

Every hook and skill command enters through `plugins/trailmark/scripts/trailmark.js` (the launcher). The launcher only reads: it finds the repo's memory folder and collects a few git facts. For the context watch it also reads the end of the session's transcript and Claude Code's settings files. It then runs the real script under Node's permission model:

| Right | Granted |
|---|---|
| Write | The repo's memory folder only |
| Read | The plugin folder and the memory folder, plus Claude Code's projects folder for the transcript command (in the Codex copy, Codex's `sessions` and `archived_sessions` folders instead) |
| Child processes, worker threads, native addons, WASI | None |

`node plugins/trailmark/scripts/trailmark.js --sandbox-check` proves this on the current machine, and the installers refuse to install when it fails. Node calls its permission model a seat belt. It stops trusted code from touching the wrong files, and it doesn't promise to contain malicious code. It also follows a symbolic link out of a granted folder.

### What the sandbox is, and what it needs

"The sandbox" in Trailmark's docs is this permission model (`node --permission`). It is part of Node.js, so it needs Node and nothing else: no Windows Sandbox, no WSL, no container and no extra package, on Windows, macOS or Linux. The same check runs on all three, and CI runs it there with Node 22, 24 and 26 for both copies. Codex has a separate sandbox of its own, which decides where the agent's commands may write ("Codex write access" below); the docs call it "Codex's sandbox".

What the release relies on, and what the installers do about each:

| Needed | Used for | The installers (`install.sh`, `install.ps1`) |
|---|---|---|
| Node.js 22.23.4, 24.22.1 or 26.12.1, or later in the same line | Every hook, the launcher and the sandbox | Stop without `node`. Stop on an older Node, a line before 22, or line 23 or 25, unless `--allow-old-node` / `-AllowOldNode` is given. Stop when the sandbox check doesn't print `SANDBOX OK` |
| git (optional) | Commit and branch facts | Warn without it. Trailmark then logs no commits and shows no branch |
| Claude Code 2.1.304 or later | The Claude Code plugin, and the `claude` command the installers run | Stop without `claude`. Warn on an older version |
| The ChatGPT desktop app with Codex mode, and the Codex CLI | The Codex copy | Not checked, except that `--codex` / `-Codex` warns when `codex` isn't on PATH |

The installers install none of these and download nothing. A plugin installed straight from GitHub runs no installer: the setup skill then runs the sandbox check, and session start warns about an old Node.

git is run by the launcher, outside the sandbox. It runs by full path (found on absolute PATH entries only), with no shell, with timeouts, and with every repo-controlled setting that can run a program switched off: fsmonitor, hooks, transports, signing programs, pagers and repo-configured filters. `plugins/trailmark/scripts/lib/gitbin.js` lists each setting and why.

## What it trusts and what it doesn't

| Input | Treated as | How |
|---|---|---|
| Command text Claude runs | Untrusted | Parsed to find where commits ran; never executed by Trailmark. Folders named in it are only passed to hardened git |
| The repo and its `.git` config | Untrusted | See git above. A `node.exe` in the repo is the one gap the plugin can't close itself on Windows (see "Known limits") |
| Text saved in the handoff | Untrusted at the next session | Injected inside a frame marked as notes from earlier sessions, with a random marker per session. Lines that imitate the frame are indented and tag-like text is escaped. Invisible tag characters and bidi overrides are dropped (a flag such as Scotland's is kept). So saved text can't close the frame, pose as markup or hide text |
| Transcripts (Claude Code's projects folder, Codex's session folders) and the `transcript_path` a hook is given | Untrusted | Opened only as plain files: never a link, a FIFO or a device, and never through a link to a network path. The file opened must be the one checked (`lib/plainfile.js`). A transcript that is itself a link isn't read |
| The memory folder's own subfolders and files | Untrusted | Subfolders must be real folders, never links, before anything is written or pruned there. Files are read, listed and dated only when they are plain files, never through a link. A link counts as missing, and a linked lock file is removed, never followed. Files are opened with `O_NOFOLLOW` where the platform has it, and checked to be the same file that was seen before opening. This matters because the launcher reads some of them outside the sandbox, and a link could lead to a network share |
| The handoff's `Updated:` line (HEAD, agent) | Untrusted | Its HEAD reaches git only as 7 to 12 hex digits, checked by the launcher; anything else is ignored. The agent name is shown only when it is exactly `Claude Code` or `Codex` |
| Commit subjects listed at session start | Untrusted | Read by the launcher from `git log`, cut to one line of 80 characters, and injected in their own frame marked as repo data, with the same line and tag escaping as the handoff |
| The repo root recorded in the state file | Untrusted | Used only to compare paths and to check, outside the sandbox, whether a `.git` entry is there. A network path is never resolved, compared or checked. `dir` shows it after a label saying it is data, with tag-like text escaped |
| `.jbmem.json` | Partly trusted | Budgets are clamped. `"sandbox": false` is ignored, because a session steered by text it read could write it |
| `JBMEM_SANDBOX=off` | Trusted | Only the environment turns the sandbox off, and every session start then warns |
| `NODE_OPTIONS`, other `NODE_*`, the launcher's own `JBMEM_*` | Untrusted | Not passed to the sandboxed script; the launcher sets its own |
| Network paths in command text, payloads or `--from` | Untrusted | Never touched unless the session works under that path |
| Claude Code's plugin cache | Untrusted | Read with limits on entries, bytes and time; network links are never followed. Session start says how many other Trailmark copies are there, in fixed text, and tells Claude not to run them; `trailmark.js --copies --show-names`, named only in the warning shown to you, lists their folders, after a line saying the names are data, with tag-like text escaped. Plain `--copies`, the form the note to Claude names, prints counts only |
| Claude Code's settings files and the session's transcript, read for the context watch | Untrusted | Read by the launcher, as plain local files only (`lib/plainfile.js`): a settings file up to 1 MB, and up to the last 32 MB of a transcript that is a `.jsonl` file directly in a folder of Claude Code's projects folder. Only numbers and a model name of plain characters come out. No text from either file is passed on: two token counts appear, in the message to you and in the request to Claude |
| The Codex rollout transcript | Untrusted | Read by session ID only, only for a session that started in this repo, streamed with a size limit |

## Known limits

### The release folder is code

Claude Code reads a plugin from a local marketplace folder in place, so anyone who can write to that folder can change what runs at your next session start. The installers refuse a folder that broad groups can write to, and trailmark-watchdog (Windows) reports any change to it.

### Windows: a `node.exe` in a repo

On Windows, cmd.exe and Node's child_process look for `node` in the current folder before PATH. A `node.exe` committed to a repo could then run in place of Node, as you, before Trailmark starts, so Trailmark can't stop it. Set `NoDefaultCurrentDirectoryInExePath=1` for your user (MANUAL.md, section 9).

Session start warns when the Node that ran it lives in the session's folder or repo. That catches a copied Node, but not a malicious stand-in that never runs Trailmark.

### Node versions

Use a Node release with the October 2026 security fixes: 22.23.4, 24.22.1, 26.12.1 or later. Older releases have two known permission-model bypasses (CVE-2026-58043, CVE-2026-106073). The sandbox check passes on them anyway, so the launcher compares versions and warns.

### Text in the handoff

Text in the handoff reaches every later session. The skills tell Claude to keep secrets out and to record only what was observed. Still, anything a session was steered into writing will be read by the next one, framed as earlier notes rather than as your instructions. Review the handoff at session end (`/trailmark:session-end`).

### The environment and repo settings

The environment Claude Code or Codex starts the hooks with is otherwise trusted. That includes `CLAUDE_CONFIG_DIR`, which Claude Code itself uses to find its settings, and with them `autoMemoryDirectory`.

A repo's `.claude/settings.json` can set environment variables, and it can also add hooks of its own, which Trailmark can't stop. Review repo settings before you trust a repo.

### git and network shares

A repo's own files can send git to a network share even when the folder git runs in is local. git follows these whatever settings it is given:

- a `.git` file's `gitdir`;
- a worktree's `commondir`, and the folder recorded for another worktree in its `gitdir` file;
- `include.path` and `includeIf` paths;
- settings that name a file;
- `objects/info/alternates`;
- links on the way to any of them.

So before git runs in a folder, the launcher checks the `.git` git would use. It also checks every `.git` it passes over on the way up because git wouldn't accept it (a decoy). If anything leads to a network path, or the check can't be sure, git stays out of that repo.

How the check reads the repo:

- Paths are followed one part at a time, and a link is read as text, never followed blind. A link to a local place is followed and what it leads to is checked too. One that leads to a network path keeps git out. Following the links in a `.git`, or in one LFS or git-annex store, has a limit on the work, counted like the limit on a config's path values: about 3,500 links to nearby folders fit (1.5 seconds on Windows), fewer when their targets are deep, and past it git is kept out (`many-entries`). Before, 3,000 links to folders 40 levels down held a hook up for 9 seconds. This holds for links in the `.git` itself (except `hooks/`, which never runs) and for the folders of tracked files that `git status` looks through.
- Pointer text is taken exactly as git takes it, spaces included. A pointer that starts or ends with whitespace is refused.
- Config files with quotes, backslashes, includes or anything outside printable ASCII are parsed by git itself (`git config --file`, includes off, run from the plugin's own folder), so quoting, comments and subsections are read as git reads them. A plain one with none of those is read directly.
- Includes are followed ten deep, as git does, relative to the including file's path as git built it. At most 50 files are read. Past either limit, git is kept out. The two limits don't count the time the reading takes: a file with a quote in it is read by git itself, one git call each. A hook has 5 seconds for git, and the time is looked at before each config file is read. With too little left the check stops there, and the hook goes on as it does when git itself runs out of time (`git-timeout`). Too little is under 0.8 seconds in the checks of nested repos and submodules that come before `git status`, and under 0.25 seconds in the check before each git call, the least a call is started with. The git call for a file gets the time that is left, up to 3 seconds. When the time that is left stops it, the time has run out: the file isn't taken as unreadable. Before, a check read all its files whatever the time: two tracked files that had become folders, each with a `.git` file leading to a gitdir whose config included 48 files with a quote in them, held the PreCompact hook for 6.4 seconds, and now hold it for 4.4 (measured on Windows). The first check a hook makes, to find the repo's memory folder, counts against the same 5 seconds, and against 3 seconds in the hook that runs before a commit command. The look for commits no hook saw, when a session resumes or compacts and at `write-handoff`, makes the same check for each folder the session used, and there the check stops at least 0.8 seconds before the time for that look ends. With under 0.25 seconds left in the check, no further file is read and no git is started: the hook finds the repo from its `.git` entries and pointer files alone, as it does when git runs out of time. Following the links in a `.git` has no look at this time: its limit is on the work (`many-entries`), so a hook can pass its time by such walks, and a check that ran out of time is made again by the hook's next step. Before, that check had no look at the time: 8 folders above the session's folder, each with a `.git` whose config included 20 such files, held the PreCompact hook for 10 to 12 seconds, and now hold it for 5 (measured on Windows).
- Each different file or folder a setting names is checked once, and the work of checking them has a limit for each repo checked (the session's repo, and each submodule or nested repo on its own): a walk of a path counts by its length, its depth and each look at the disk that isn't already known, joining a value to each folder it is tried from counts too, and past about 8 million counted git is kept out (`many-config-paths`). On the way up from the session's folder git goes on past a `.git` it doesn't accept, so each one found there is checked, and all of them share one limit with the repo git stops at (where the folder as given and its real path differ, each of the two ways up has its limit). Before, each `.git` had a limit of its own, and eight folders, one inside the other, each with a `.git` that held only a config naming two `lfs.storage` folders of links, were let through after 10.5 seconds; now git is kept out after 1.6 (both on Windows). What a `.git` costs outside this limit still adds up for each one found: links in the `.git` folder itself or in its `worktrees` folder, and files its config includes. 2,000 submodule gitdirs count 1 to 4 million, the most in a repo at a path of 190 to 240 characters with the gitdirs there on disk, and about 6 million (three quarters of the limit) with names of 60 characters, a `core.worktree` and a session eight folders down. More than 16 different `core.worktree` values keep git out too. Without the limit, thousands of values held a hook up for seconds to minutes; with it, the slowest inputs found that it lets through take 1 to 2 seconds for one repo (Windows and Linux). An `lfs.storage` folder is looked into once however many values lead to the same path (one written in another case is looked into again, within the two limits below). The limit doesn't count that walk, so the stores have two limits of their own for each repo checked: more than 64 different existing `lfs.storage` folders keep git out, and so does a further one once those before it held 20,000 entries between them (the most that leaves is three stores with just under 30,000 entries looked at; the slowest found, with folders within folders or links in them, took up to 2.5 seconds on Windows and 0.9 on Linux). Many nested repos, each near the limit, still add up, and so does a `.git/config` that includes many files of 8 MB. The same goes for `.lfsconfig`. For the submodule gitdirs in `.git/modules` the time adds up about as far as the hook's time for git allows (5 seconds): it is looked at before each gitdir, and with under 0.8 seconds left git is kept out (`git-timeout`), so the last gitdir checked can end a little past it. 8 such gitdirs, each near the limit, ended that way after 4.2 to 4.9 seconds, and a later run starts over. They were not all put under one limit on the work: 2,000 of them with names of 60 characters and a `core.worktree` each count about 13 million between them, each under its own limit, so one limit with room for them would allow about as long as the time does. A limit on the following of links alone, which plain submodule gitdirs don't do, is left for a later version.
- A value starting with `%(prefix)` is refused, since git hands the absolute path after it on unchanged.
- Alternates are followed six deep, as git 2.43 reads them. Each alternate's own folders are walked for links like the `.git`'s. git-lfs looks for a store next to each alternate the repo itself names (the `lfs` folder beside it). Such a folder is walked once however many lines lead to it, and the stores found that way have the two limits of the `lfs.storage` folders, counted apart from those: more than 64 existing ones keep git out, and so does a further one once those before it held 20,000 entries between them (`many-config-paths`). Before, 20 lines next to one store of 10,100 folders were 40 walks. All of a repo's alternates and the stores next to them also share one limit on the work of following links, the one a config's path values have, less what those used (`many-config-paths`). So a repo's settings and its alternates can't each use all of it: before, two `lfs.storage` folders of 120 links and two more next to alternates were let through after 1.7 seconds. The alternates' own folders also share one count of entries: once those walked before held 100,000, git is kept out (`many-entries`). An alternate is known by the exact text of its path, so on Windows one folder named in 100 letter cases was walked 100 times: 10.8 seconds for 1,000 links in it, and 5.5 seconds for 12 stores of links, each within its own limit. Reading an alternates file counts toward the limit on the work by its length: 6 alternates that each named one folder in 3,000 letter cases, that folder's own alternates file being 62 KB of comment lines, were 18,000 reads in 8.3 seconds, and now keep git out (`many-config-paths`).
- A gitdir folder or link name that isn't valid UTF-8 keeps git out (`odd-path`): git opens the raw bytes, which Node can't name. A plain file with such a name (a branch or its reflog) is passed over, since the check never follows a file. So does such a byte in a pointer, a link's target or an alternates line.
- An alternates file is read entry by entry as git reads it, C-quoting and `\ooo` escapes included. Quoting git would reject, text after a closing quote, and a line starting with a space keep git out (`odd-config-path`), since git and the check would read different paths there. Only a `#` at the very start of a line is a comment, as for git. A BOM at the start of a quoted entry keeps git out; characters outside the Basic Multilingual Plane are read as git reads them.
- On macOS and Linux a backslash is part of a name, as it is for git, not a separator.
- A path with a missing folder followed by `..` keeps git out: the check can't look past the missing folder, and `..` taken as text would climb back into folders it never looked at.
- On macOS and Linux, a session folder whose path has a `..` after a link is refused (`odd-path`) when that `..` would lead somewhere else than it does as text. An include reached by two spellings that collapse to the same text is read under each.
- On Windows, a `.git` that is itself a link or junction keeps git out (`linked-gitdir`): git takes `..` in its relative pointers and includes as text from the `.git` it was given.
- A setting that names a file or folder (`core.attributesFile`, `core.excludesFile`, `mailmap.file`, `lfs.storage`, or any key whose name ends in file, path, dir, storage, template or worktree) is resolved the way git would. That means relative to the worktree, the gitdir and a `core.worktree`, with links followed and `..` also taken as text, as git-lfs does.
- `lfs.storage` and git-lfs's own `lfs/objects` folders are walked too, on a budget of their own (the first 10,000 entries), so a large LFS store can't use up the budget for git's own folders.
- While git-lfs runs as a filter, the repo's `.lfsconfig` must be a plain file with no includes. One that is only in the index or HEAD is read with `git config --blob` and held to the same rules.
- git tries a folder on the way up whose `HEAD` looks like a git head as a bare repo before refusing it. What git reads there (its `commondir` and the `objects` and `refs` folders) is checked, also when the folder has a `.git` git won't use. git older than 2.38 uses such a folder as a repo, so with that git the whole folder is checked like a gitdir.
- Each other worktree's `commondir` is checked too, and so is the folder recorded in its `gitdir` file, because git 2.56 opens that folder for `rev-list --all` (relative paths, written with `worktree.useRelativePaths`, included).
- A `worktrees` or `modules` folder in the gitdir, or an entry in `worktrees`, that is a link is resolved a part at a time before anything is listed or read through it, and its files are read where it leads.
- A working folder inside a `.git` (in any Windows spelling, such as `GIT~1`) is refused. So is a pointer that git and the check would resolve differently on Windows (`C:x`, `\x`). The same goes there for a name that ends in a dot or a space (`k.`), in the session folder's path or in a pointer or setting: Windows programs open it without them, so git run in `k.` runs in `k`, and git-lfs given `k.` as `lfs.storage` writes into `k`, while the check would look for a folder named `k.`. An alias or a log format (`[alias]`, `[pretty]`) is words, not a path, even under a name that ends like a path setting's (`adddir = add .`): its value is checked as before, without this rule.
- What the check has already read or walked is remembered by its exact path. Two names that differ only in a way JavaScript's lower case hides (`k` and the Kelvin sign, U+212A) are two files or folders on Windows, and both are checked. A config file named again in another case is read again, within the same limit as any other. A folder a link leads to is told by its name as the disk has it, so links that write one folder in many ways (another letter case, a short name, a stream's name after it) lead to one walk. A folder counts as walked only for the rules it was walked by: one seen as a repo's `objects` folder, where the folders of loose objects are passed over, is walked again in full where a link leads to it from `refs`.
- A gitdir with folders nested more than 64 deep keeps git out.
- A folder named in a command (`cd vend && git commit`) is checked for links to a share before anything looks into it.

Before the PreCompact hook's `git status`, the same checks run on each submodule's `.git` and on each submodule gitdir in `.git/modules`, since git may open one by its `.gitmodules` name. A tracked file that has become a folder with a `.git` is checked as well; it is looked up only once every folder on its way was checked for links. The hook's time for git (5 seconds) is looked at before each folder with a `.git` is checked, as it is before each submodule; with under 0.8 seconds left at that look, status isn't read (`git-timeout`). Before, it was looked at only once in every 500 folders of tracked files, and 12 folders with a slow `.git` held the hook for 12.4 seconds. The same 12 now take 5.1: the time, and the one check that was running. A check of a `.git` that is running also looks at the time before each config file it reads (see the bullet on included files above). The time is also looked at before each folder on the way to a tracked file is checked for being a link, since where a link leads is walked: 1,000 folders that are links to a very long path held the hook for 10.5 seconds with no look at the time, and now hold it for 4.2 seconds, after which status isn't read (measured on Windows). On Windows a tracked name that ends in a dot or a space (`d./f`) keeps status from being read (`odd-path`): git there opens `d`, and the check would look for `d.` and find nothing. So does a tracked path with a backslash, which git there takes as one more separator (`d\f` is read through a folder `d` the check would not look at), and one that starts with a drive letter (`C:d/f`). With submodules, `.gitmodules` may not be a link.

Untracked files aren't listed in the snapshot, since git would look inside untracked folders that are repos of their own.

`git status` covers the whole worktree even when the session works in a subfolder, so these checks and the switched-off filters cover the whole worktree too. When the repo's `core.worktree` names a folder that isn't the session's folder or above it, status isn't read.

Some addresses are allowed:

- A session that works on a share itself (`\\wsl$\...`, a company share) may let git reach that share, but no other.
- A remote's address (`remote.<name>.url`, `pushurl`, `url.<base>.insteadOf`, a submodule's `submodule.<name>.url`) isn't checked. The git calls made here have every transport off, so a remote on a share is never contacted.
- A Git LFS address (`lfs.url`, `remote.<name>.lfsurl`) on a share still keeps git out, since git-lfs is a program of its own.

When git is kept out, session start says so and names the reason (MANUAL.md, section 16, lists them). The memory folder is still found without git, so a worktree keeps its shared handoff.

Not covered:

- A mapped drive letter that leads to a share. It can't be told apart from a local drive.
- A link planted in place of a single loose object file.
- A link in a Git LFS store (the repo's or a submodule's) or a git-annex store past its first 10,000 entries. (A repo with more than 20,000 tracked folders has its file list skipped before a compaction: `many-folders`.) (A gitdir with more than 100,000 other entries, loose objects aside, keeps git out: `many-entries`. Loose objects in a folder left in `.git/modules` without a `HEAD`, which git doesn't open, are passed over the same way.)
- `~/` in an include is checked against your home folder as Node sees it, which can differ from git's `HOME` on some company machines. A path written as `~user/...` keeps git out (`odd-config-path`) unless `user` is you.

### Links in the memory folder

A hard link in the memory folder isn't refused when read, since it can only lead within the same drive. The day's log is never appended to through one, though: it is replaced by a copy of its own first.

A memory folder that is itself a link, like a linked project folder, is your own setup and is trusted.

Node's permission model follows a symbolic link out of a granted folder. Trailmark checks its own subfolders and the files it reads, but a link swapped in at the exact moment between that check and the write would still be followed. That needs a process already running as you.

### Grants wider than the memory folder

Two grants reach past the memory folder. `init` gets read and write on the project folder above `memory/`, since it creates `memory/` there; Claude Code keeps that session's transcripts in the same folder. And when `memory/` doesn't exist yet, a command gets read access to the nearest folder above it that does, to see that it is missing.

### Output the skills read, and very large files

CLI output that skills read (`handoff`, `list`) prints memory text without the session-start frame. `list` and `status` do drop control characters and escape tags. `search` prints its hits after a line saying they are matched lines from memory files, data only, not instructions, with invisible characters shown as `<U+XXXX>` and tags escaped.

A very large `handoff.md` or state file is read whole, so the injection could miss the hook's time limit. The session itself isn't held up.

### Codex write access

In Codex, checkpoints need write access outside the workspace. Approving each write keeps that to the launcher. Making the memory folder a writable root lets every command the agent runs write there, past the version check (the trailmark-codex README, Install, step 3).

## trailmark-watchdog

trailmark-watchdog (Windows, `tools/windows`) records a known-good list of the release folder (SHA-256, size, attributes, alternate data streams, and a copy of each text file) and checks each change for risky content. It also watches Trailmark copies in Claude Code's plugin cache and what Claude Code's user settings run. It runs as you and never changes what it watches. It adds to Defender and doesn't replace it.

Its limits:

- Malware running as you could change it or its list.
- Repo-level settings, other plugins' hooks and the Codex plugin cache aren't covered.
- A file over 64 MB is checked by its start, end, size and time only. Adding one is HIGH.
- In the plugin cache, files over 5 MB are compared by size, and nothing below 8 folder levels is read.
- MCP servers stop being checked when `.claude.json` grows past 2 MB. That is reported once, as HIGH.

## What the installers and scripts do to your system

| Tool | Changes |
|---|---|
| `install.sh`, `install.ps1` | What `claude plugin marketplace add` and `claude plugin install` write to Claude Code's user settings, and the same for `codex plugin marketplace add` with `--codex` / `-Codex`. With `-SetNoCwdLookup`, one user environment variable. No downloads, no deletes. `--uninstall` / `-Uninstall` removes the plugin and the marketplace from Claude Code's settings, and the trailmark-codex marketplace from Codex when the codex command is there, and leaves memory folders alone |
| `install-trailmark-watchdog.ps1` | Copies the watchdog to `%LOCALAPPDATA%\trailmark-watchdog` and adds two scheduled tasks as you (no admin). It saves what it prints to `install-trailmark-watchdog.log` in the same folder. `-Uninstall` removes both tasks and the copied script |
| Diagnostic scripts | The read-only ones change nothing. The test scripts create throwaway repos in the temp folder and their own projects folders, and delete only folders they marked as theirs |

None of the code in this release makes network requests. The `claude` and `codex` commands the installers run, and `claude -p` in the end-to-end tests, talk to their own services as usual.

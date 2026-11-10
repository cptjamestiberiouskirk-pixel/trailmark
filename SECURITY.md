# Security

Trailmark runs code as you at every Claude Code session start and compaction, and after every tool call and prompt. This file says what that code can and can't do, what it trusts, and what's left to you.

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

- Paths are followed one part at a time, and a link is read as text, never followed blind. A link to a local place is followed and what it leads to is checked too. One that leads to a network path keeps git out. This holds for links in the `.git` itself (except `hooks/`, which never runs) and for the folders of tracked files that `git status` looks through.
- Pointer text is taken exactly as git takes it, spaces included. A pointer that starts or ends with whitespace is refused.
- Config files with quotes, backslashes, includes or anything outside printable ASCII are parsed by git itself (`git config --file`, includes off, run from the plugin's own folder), so quoting, comments and subsections are read as git reads them. A plain one with none of those is read directly.
- Includes are followed ten deep, as git does, relative to the including file's path as git built it. At most 50 files are read. Past either limit, git is kept out.
- Each different file or folder a setting names is checked once, and the work of checking them has a limit for each repo checked (the session's repo, and each submodule or nested repo on its own): a walk of a path counts by its length, its depth and each look at the disk that isn't already known, joining a value to each folder it is tried from counts too, and past about 8 million counted git is kept out (`many-config-paths`). 2,000 submodule gitdirs count 1 to 3 million, the most in a repo at a path of 160 to 190 characters with the gitdirs there on disk. More than 16 different `core.worktree` values keep git out too. Without the limit, thousands of values held a hook up for seconds to minutes; with it, the slowest inputs found take about 1 second for one repo (Windows and Linux). Many nested repos, each near the limit, still add up, and so does a `.git/config` that includes many files of 8 MB. The same goes for `.lfsconfig`.
- A value starting with `%(prefix)` is refused, since git hands the absolute path after it on unchanged.
- Alternates are followed six deep, as git 2.43 reads them. Each alternate's own folders are walked for links like the `.git`'s.
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
- A working folder inside a `.git` (in any Windows spelling, such as `GIT~1`) is refused. So is a pointer that git and the check would resolve differently on Windows (`C:x`, `\x`).
- A gitdir with folders nested more than 64 deep keeps git out.
- A folder named in a command (`cd vend && git commit`) is checked for links to a share before anything looks into it.

Before the PreCompact hook's `git status`, the same checks run on each submodule's `.git` and on each submodule gitdir in `.git/modules`, since git may open one by its `.gitmodules` name. A tracked file that has become a folder with a `.git` is checked as well; it is looked up only once every folder on its way was checked for links. With submodules, `.gitmodules` may not be a link.

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

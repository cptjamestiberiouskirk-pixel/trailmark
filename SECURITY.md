# Security

Trailmark runs code at every Claude Code session start, after every commit command and before every compaction, as you. This file says what that code can and can't do, what it trusts, and what's left to you.

## Reporting a problem

For a security problem, report it privately through GitHub: on the [repository](https://github.com/cptjamestiberiouskirk-pixel/trailmark), open the Security tab and choose **Report a vulnerability** (https://github.com/cptjamestiberiouskirk-pixel/trailmark/security/advisories/new). Please don't open a public issue for anything that lets a repo, a web page or another program run code or change memory through Trailmark until a fix is out. Other bugs go in the repository's [issues](https://github.com/cptjamestiberiouskirk-pixel/trailmark/issues).

## What runs, and with what rights

Every hook and skill command enters through `plugins/trailmark/scripts/trailmark.js` (the launcher). The launcher only reads: it finds the repo's memory folder and collects a few git facts. It then runs the real script under Node's permission model:

| Right | Granted |
|---|---|
| Write | the repo's memory folder only |
| Read | the plugin folder and the memory folder, plus Claude Code's projects folder for the transcript command |
| Child processes, worker threads, native addons, WASI | none |

`node plugins/trailmark/scripts/trailmark.js --sandbox-check` proves this on the current machine, and the installers refuse to install when it fails. Node calls its permission model a seat belt: it stops trusted code from touching the wrong files, and it doesn't promise to contain malicious code. It also follows a symbolic link out of a granted folder.

git is run by the launcher, outside the sandbox, by full path (found on absolute PATH entries only), with no shell, with timeouts, and with every repo-controlled setting that can run a program switched off: fsmonitor, hooks, transports, signing programs, pagers, repo-configured filters. `plugins/trailmark/scripts/lib/gitbin.js` lists each setting and why.

## What it trusts and what it doesn't

| Input | Treated as | How |
|---|---|---|
| Command text Claude runs | Untrusted | Parsed to find where commits ran; never executed by Trailmark. Folders named in it are only passed to hardened git |
| The repo and its `.git` config | Untrusted | See git above. A `node.exe` in the repo is the one gap the plugin can't close itself on Windows: see the next section |
| Text saved in the handoff | Untrusted at the next session | Injected inside a frame marked as notes from earlier sessions, with a random marker per session; lines that imitate the frame are indented and tag-like text is escaped, so saved text can't close the frame or pose as markup |
| The memory folder's own subfolders and files | Untrusted | Subfolders must be real folders, never links, before anything is written or pruned there. Files are read, listed and dated only when they are plain files and never through a link (a link counts as missing, and a linked lock file is removed, never followed) (`O_NOFOLLOW` where the platform has it, a check that the open file is the one seen before it was opened elsewhere), since the launcher reads some of them outside the sandbox and a link could lead to a network share |
| The handoff's `Updated:` line (HEAD, agent) | Untrusted | Its HEAD reaches git only as 7 to 12 hex digits, checked by the launcher; anything else is ignored. The agent name is shown only when it is exactly `Claude Code` or `Codex` |
| Commit subjects listed at session start | Untrusted | Read by the launcher from `git log`, cut to one line of 80 characters, and injected in their own frame marked as repo data, with the same line and tag escaping as the handoff |
| The repo root recorded in the state file | Untrusted | Used only to compare paths and to check, outside the sandbox, whether a `.git` entry is there. A network path is never resolved, compared or checked. Shown with tag-like text escaped |
| `.jbmem.json` | Partly trusted | Budgets are clamped. `"sandbox": false` is ignored, because a session steered by text it read could write it |
| `JBMEM_SANDBOX=off` | Trusted | Only the environment turns the sandbox off, and every session start then warns |
| `NODE_OPTIONS`, other `NODE_*`, the launcher's own `JBMEM_*` | Untrusted | Not passed to the sandboxed script; the launcher sets its own |
| Network paths in command text, payloads or `--from` | Untrusted | Never touched unless the session works under that path |
| Claude Code's plugin cache | Untrusted | Read with limits on entries, bytes and time; network links never followed. Other Trailmark copies there are named at session start so Claude doesn't run them |
| The Codex rollout transcript | Untrusted | Read by session ID only, only for a session that started in this repo, streamed with a size limit |

## Known limits

The release folder is code. Claude Code reads a plugin from a local marketplace folder in place, so anyone who can write to that folder can change what runs at your next session start. The installers refuse a folder that broad groups can write to. trailmark-watchdog (Windows) reports any change to it.

On Windows, cmd.exe and Node's child_process look for `node` in the current folder before PATH. A `node.exe` committed to a repo could then run in place of Node, as you, before Trailmark starts, so Trailmark can't stop it. Set `NoDefaultCurrentDirectoryInExePath=1` for your user (MANUAL.md, section 9). Session start warns when the Node that ran it lives in the session's folder or repo, which catches a copied Node but not a malicious stand-in that never runs Trailmark.

Use a Node release with the October 2026 security fixes: 22.23.4, 24.22.1, 26.12.1 or later. Older releases have two known permission-model bypasses (CVE-2026-58043, CVE-2026-106073). The sandbox check passes on them anyway, so the launcher compares versions and warns.

Text in the handoff reaches every later session. The skills tell Claude to keep secrets out and to record only what was observed, but anything a session was steered into writing will be read by the next one, framed as earlier notes rather than as your instructions. Review the handoff at session end (`/trailmark:session-end`).

The environment Claude Code or Codex starts the hooks with is otherwise trusted. That includes `CLAUDE_CONFIG_DIR`, which Claude Code itself uses to find its settings, and with them `autoMemoryDirectory`. A repo's `.claude/settings.json` can set environment variables, and it can also add hooks of its own, which Trailmark can't stop; review repo settings before you trust a repo.

A repo's own files can send git to a network share even when the folder git runs in is local: a `.git` file's `gitdir`, a worktree's `commondir`, `include.path` and `includeIf` paths, settings that name a file, `objects/info/alternates`, and links on the way to any of them. git follows them whatever settings it is given, so before git runs in a folder the launcher checks the `.git` git would use, and every `.git` it passes over on the way up because git wouldn't accept it (a decoy), and stays out when anything leads to a network path or the check can't be sure. Paths are followed one part at a time and a link is read as text, never followed blind: a link to a local place is followed and what it leads to is checked too, and one that leads to a network path keeps git out. That holds for links in the `.git` itself (except `hooks/`, which never runs), and for the folders of tracked files that `git status` looks through. Pointer text is taken exactly as git takes it, spaces included, and a pointer that starts or ends with whitespace is refused. Config files are parsed by git itself (`git config --file`, includes off, run from the plugin's own folder), so quoting, comments and subsections are read as git reads them. Includes are followed ten deep, as git does, relative to the including file's path as git built it, and at most 50 files are read; past either limit git is kept out. A value starting with `%(prefix)` is refused, since git hands an absolute path after it on unchanged. Alternates are followed five deep, as git does. A working folder inside a `.git` (in any Windows spelling, such as `GIT~1`) is refused, and so is a pointer git and the check would resolve differently on Windows (`C:x`, `\x`). A session that works on a share itself (`\\wsl$\...`, a company share) may let git reach that share, but no other. Before the PreCompact hook's `git status`, each submodule's `.git` is checked the same way, and untracked files aren't listed, since git would look inside untracked folders that are repos of their own. When git is kept out, session start says so and the memory folder is still found without git, so a worktree keeps its shared handoff. Not covered: a mapped drive letter that leads to a share, which can't be told apart from a local drive; a link planted in place of a single loose object file, or in a gitdir past its first 20,000 entries, or among a repo's folders past the first 20,000. `~/` in an include is checked against your home folder as Node sees it, which can differ from git's `HOME` on some company machines.

Two grants are wider than the memory folder. `init` gets read and write on the project folder above `memory/`, since it creates `memory/` there; Claude Code keeps that session's transcripts in the same folder. And when `memory/` doesn't exist yet, a command gets read access to the nearest folder above it that does, to see that it is missing.

Not changed in this release, noted by the review: when looking for other Trailmark copies in Claude Code's plugin cache, only the last link on a path is checked for a network target; CLI output that skills read (`handoff`, `search`, `list`) prints memory text without the session-start frame; and a very large `handoff.md` or state file is read whole, so the injection could miss the hook's time limit (the session itself isn't held up).

Node's permission model follows a symbolic link out of a granted folder. Trailmark checks its own subfolders and the files it reads, but a link swapped in at the exact moment between that check and the write would still be followed. That needs a process already running as you.

In Codex, checkpoints need write access outside the workspace. Approving each write keeps that to the launcher. Making the memory folder a writable root lets every command the agent runs write there, past the version check (the trailmark-codex README, Install, step 3).

## trailmark-watchdog

trailmark-watchdog (Windows, `tools/windows`) records a known-good list of the release folder (SHA-256, size, attributes, alternate data streams, a copy of each text file) and checks each change for risky content. It also watches Trailmark copies in Claude Code's plugin cache and what Claude Code's user settings run. It runs as you and never changes what it watches. Its limits: malware running as you could change it or its list; repo-level settings, other plugins' hooks and the Codex plugin cache aren't covered; a file over 64 MB is checked by its start, end, size and time only (adding one is HIGH); in the plugin cache, files over 5 MB are compared by size and nothing below 8 folder levels is read; MCP servers stop being checked when `.claude.json` grows past 2 MB (that is reported once, as HIGH). It adds to Defender and doesn't replace it.

## What the installers and scripts do to your system

| Tool | Changes |
|---|---|
| `install.sh`, `install.ps1` | What `claude plugin marketplace add` and `claude plugin install` write to Claude Code's user settings; the same for `codex plugin marketplace add` with `--codex` / `-Codex`. With `-SetNoCwdLookup`, one user environment variable. No downloads, no deletes. `--uninstall` / `-Uninstall` removes the plugin and the marketplace from Claude Code's settings, and the trailmark-codex marketplace from Codex when the codex command is there, and leaves memory folders alone |
| `install-trailmark-watchdog.ps1` | Copies the watchdog to `%LOCALAPPDATA%\trailmark-watchdog` and adds two scheduled tasks as you (no admin). `-Uninstall` removes both tasks and the copied script. It also saves what it prints to `install-trailmark-watchdog.log` next to itself |
| Diagnostic scripts | The read-only ones change nothing. The test scripts create throwaway repos in the temp folder and their own projects folders, and delete only folders they marked as theirs |

None of the code in this release makes network requests. The `claude` and `codex` commands the installers run, and `claude -p` in the end-to-end tests, talk to their own services as usual.

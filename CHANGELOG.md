# Changelog

## 0.2.2 (jb-memory-codex): 2026-10-26

- A plainer plugin description and README opening, saying what the plugin is for and what it gives you. Claude Code is named only for using both in one repo.

## 0.2.1 (jb-memory-codex): 2026-10-26

- The `jbm-memory-setup` skill covers a repo used only from Codex: when the repo isn't set up, it asks whether Claude Code is used there too, and if not, shows the commands to set it up by hand (`init --force` with `JBMEM_CODEX_INIT=1` for that one command). It never sets the variable or runs `init` itself. The Codex README and MANUAL section 8 describe the same path.
- Every Codex skill that writes to the memory folder (setup's test note, checkpoint, session-end, park, recall's `note` and `undo-handoff`, prune) says what to do when Codex's sandbox refuses the write: run the same action again with escalated permissions, so Codex asks you to approve it, and stop only if you decline. Before, the setup check stopped at the first `EPERM` (seen on Windows, 2026-10-26) instead of asking.
- The Codex copy speaks in Codex terms. Its messages and skills no longer send the user to Claude Code: refusing `init` points to the jbm-memory-setup skill, "not set up" says to run it, and the unconfirmed-folder message says `--force` is expected for a Codex-only repo. The setup skill names Claude Code only when the user uses it in the repo; prune promotes to AGENTS.md, and to `.claude/rules` only when Claude Code is used there too. Claude Code is still named where it is the fact: the shared memory folder under `~/.claude`, and its plugin cache.
- Test scripts: `verify-jb-hooks.ps1` names the jb-memory under test and the copy Claude Code runs, and its Part 1 headings say which version added each group of checks; `test-jb-watchdog.ps1` keeps every scan on its stand-in Claude folder.

jb-memory stays 0.4.0 and jb-watchdog 1.6.0: neither changed.

## 0.4.0 (jb-memory), 0.2.0 (jb-memory-codex), 1.6.0 (jb-watchdog): 2026-10-25

First public release: one folder that is both the Claude Code marketplace (`jb-memory`) and the Codex marketplace (`jb-memory-codex`), with installers and a manual.

- Installers for macOS and Linux (`install.sh`) and Windows (`install.ps1`, `install.cmd`). They check Node against the security floors, git and Claude Code, refuse a folder broad groups can write to, run the sandbox check, refuse a second copy of jb-memory from another marketplace, then validate, add the marketplace and install. `--check`, `--uninstall` and opt-in Codex, watchdog and Windows lookup options.
- Skills speak of "the user" instead of a fixed name. Decision provenance is written `[user YYYY-MM-DD]`; older handoffs with a name in that place still read correctly.
- The checkpoint skill no longer carries a fixed model recommendation. It adds a model note to a next action only when the repo's CLAUDE.md or AGENTS.md, or the user, sets a model policy.
- jb-watchdog 1.6.0 understands the release layout (the watched folder is itself the marketplace) as well as the older one (a `jb-memory-marketplace` subfolder). It records the layout in the known-good list, so a later scan can't be switched to the other one by moving files, and says so when an accept would change it. It recognizes the Codex copy's hook commands exactly, ignores `*.log` in `tools\windows`, and `-Init -Root <folder>` now moves the watch to a new folder.
- install-jb-watchdog.ps1 takes `-Root`, and from `tools\windows` watches the release folder two levels up.
- Diagnostic scripts find the plugin in either layout and default `-Repo` to the current folder.
- Documentation: README, MANUAL, SECURITY. Machine-specific paths and notes removed from the plugin READMEs and comments.

Security fixes from an independent review of this release, before publishing:

- The launcher starts its sandboxed script without `NODE_OPTIONS` or any other `NODE_*` variable. Before, `NODE_OPTIONS=--permission --allow-fs-write=* ...` in the environment (which a repo's settings can set) undid the sandbox while the status still said `sandbox on`.
- Inherited `JBMEM_DIR` and the launcher's other internal variables are dropped, and `CLAUDE_CODE_PROJECT_DIR_NAME` must be one folder name. Either could otherwise choose the memory folder, and with it the sandbox's write grant.
- `snapshots/`, `archive/`, `archive/handoff-history/`, `archive/files/` and `parked/` must be real folders. A link planted in place of one made the hooks write, and prune old files, wherever it pointed, with the sandbox on.
- Files are read only when they are plain files, and `--from` refuses a FIFO before opening it: a FIFO in place of `handoff.md` blocked every session start. A hook's sandboxed script is killed before the host's own hook timeout.
- In the injected handoff, markup-like text gets a backslash after the `<`: every closing tag (also `＜/x＞`, `< /x>` and ones with invisible characters), and opening tags with a dash or underscore in the name or a role word (`<system-reminder>`, `<user>`). Code such as `Array<string>` or `i<n` is left alone. More look-alike dashes and brackets count as frame-like lines.
- A PR merge note keeps only the `gh pr merge` part of the command, and of that only flag names, the PR number or URL and short plain words; every flag value, quoted string and key-like word is replaced.
- A network folder (`\\server\share`, `//server/share`) named in command text is never touched unless the session works under it: even a stat would connect to the server from outside the host's sandbox.
- `--from` refuses a network path and any link before resolving it. Folders read back from the state file (`.jbmem-state.json`), which a session can write, go through the same network check before git runs in them.
- `notes/` is checked like the other subfolders before the day's log is created; `.jbmem.json` and the lock file are read only as plain files. A hook's sandboxed script gets what is left of the host's timeout, and says so when it is stopped.
- Codex: the payload-shape log and the debugging dump are never written through a link or into a file with other hard links; `transcript_path` is checked by name before anything resolves it, and only a plain file is read; printed text claiming an exit code no longer outranks the transcript; an argv-array command is quoted for the shell it is read as; a `tool_input.workdir` on a network path outside the session is ignored; the hook command accepts only a drive-letter or `/name` `PLUGIN_ROOT`, never a UNC or device path. The hook text changed, so Codex asks you to trust the hooks again.
- jb-watchdog: file names are compared exactly, and names that differ only by case are HIGH and can't be accepted (in a case-sensitive folder one could hide a change to another); `-Accept` keeps the recorded layout unless `-SetLayout` says otherwise, and the plugin folders of both layouts always count as plugin files; a file over 64 MB is hashed by its start and end, so one huge or sparse file can't stretch every scan past the task's limit, and adding one is HIGH; when no scan has finished for 30 minutes after one started, the next one raises a notice; `-Root` moves the watch only with `-Init`, and never to a link; `fileSuggestion`, `subagentStatusLine`, `processWrapper`, `policyHelpers` and other command settings are watched; a marketplace source of `./plugins/..` is reported.
- Installers: the conflict check runs from `tools/install-check.js` instead of JavaScript on the command line, which Windows PowerShell 5.1 broke silently, so a second jb-memory install went undetected through `install.cmd`; both installers stop if `claude plugin list` fails instead of taking that as nothing installed; install.sh no longer reports a conflict when no marketplace exists; install.sh refuses shared-group write access and a world-writable parent; install.sh also refuses links inside the release, parents that a shared group can write to, and parents owned by another user; install.ps1 checks every file and folder and the parent folders, allows write rights only for you, Administrators, SYSTEM, TrustedInstaller and CREATOR OWNER, checks owners, and skips inherit-only entries; install.ps1 parses only standard output, so a notice on stderr can't break the conflict check.
- The test scripts remove links inside their throwaway folders as links before deleting the folders.

No change to the handoff format or the skills' behavior.

## Earlier

0.3.x and Codex 0.1.x were private releases. The highlights, for anyone moving from them:

- 0.3.9 / 0.1.2: `init` creates the project folder only when it will proceed; transcripts are read as a stream.
- 0.3.8: `"sandbox": false` in `.jbmem.json` is ignored with a warning; session start warns when the Node running jb-memory sits in the session's folder or repo.
- 0.3.4: PreToolUse records where each commit command starts; PostToolUseFailure logs commits from a command that then failed.
- 0.3.0: version-checked handoff writes, so sessions can't undo each other's checkpoints.
- Codex 0.1.5: the exit code of a command comes from the session's transcript, since the hook payload doesn't carry one.

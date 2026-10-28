# Changelog

## 0.5.0 (Trailmark), 0.3.0 (trailmark-codex), 1.7.0 (trailmark-watchdog): 2026-10-28

jb-memory is now Trailmark, ahead of its first public release. Everything in 0.4.5 below is part of this release.

- Names: the plugin and its marketplace are `trailmark` (install `trailmark@trailmark`), the Codex copy and its marketplace are `trailmark-codex`, the watchdog is `trailmark-watchdog`, and the launcher is `scripts/trailmark.js`. Skills are `/trailmark:checkpoint` and so on; the Codex copy's skills are `tm-checkpoint` and so on. The status line reads `[trailmark]`. The Codex hook text changed, so Codex asks you to trust the hooks again.
- Unchanged on purpose, so existing repos need nothing: the memory folder's files (`.jbmem.json`, `.jbmem-state.json`, `.jbmem.lock`) and the `JBMEM_*` environment variables.
- A copy under the old name still counts as another copy: session start names a jb-memory copy in Claude Code's plugin cache (or any copy that holds the old `jbm.js`), the installers refuse while `jb-memory` is installed, and the watchdog watches cached jb-memory copies as well. Two copies would each run every hook.
- `install-trailmark-watchdog.ps1` removes the old `jb-watchdog` scheduled tasks and installed copy before it adds its own, and its `-Uninstall` removes both. The old watchdog's log and known-good list are left in `%LOCALAPPDATA%\jb-watchdog`.
- The Windows diagnostics recognize both names in older transcripts (`jbm.js`, `jb-memory:checkpoint`).
- MANUAL.md, section 15, has the steps for moving from jb-memory.
- New tests for the old-name checks.

Older entries below keep the names of their time.

## 0.4.5 (jb-memory), 0.2.4 (jb-memory-codex): 2026-10-28

Ahead of listing in Anthropic's plugin directory: the handoff is checked against git when it loads, and the docs say plainly what the plugin runs, writes and sends.

- Session start lists the commits made on HEAD since the handoff was written, the newest 10 with their subjects, in their own frame marked as repo data. A next-step item that shares two or more words with one of those subjects is named, so the session checks it before redoing the work. When the handoff's HEAD is on another branch or isn't in the checkout, the injection says that instead. The launcher reads the HEAD from the handoff's `Updated:` line and passes it to git only as 7 to 12 hex digits.
- The `Updated:` line ends with the agent that wrote it, `by Claude Code` or `by Codex`, and the session-start text names it.
- The whole injection, warnings and the commit list included, stays inside `injectChars` (8,500 by default). When the handoff is cut, the note says which sections were left out, as well as the full file's path.
- The first session start (or `init`) records which repo the memory folder serves. When a second repo that still exists turns out to map to the same folder, every session start warns, to you and to the model, and `dir` shows it. When the recorded repo is gone, the repo moved and the record follows.
- The daily log in `notes/` can be turned off with `"notes": false`, and a day's file is deleted 90 days after its date (`"notesKeepDays"`). It holds events and commit subjects only.
- READMEs open with what jb-memory doesn't do, show a before-and-after of a fresh session (`plugins/jb-memory/docs/session-start.png`), and have a section on what it runs, writes and sends. The Codex copy's README and MANUAL say how the handoff comes back after a Codex compaction and what hasn't been checked.
- A GitHub Actions workflow runs the sandbox check and both copies' tests on Linux, macOS and Windows with Node 22 and 24, and on Windows parses every PowerShell script with Windows PowerShell 5.1 and PowerShell 7. The actions are pinned to commits. Running the suites on macOS and Windows for the first time showed faults in the tests, not the code: they assumed the temp folder's own spelling (`/var` for `/private/var`, a short `RUNNER~1` name), expected `C:\` where jb-memory writes `C:/`, put unquoted Windows paths in bash commands, and sent bash syntax to the Codex copy, which reads commands as PowerShell on Windows. Those are fixed. Seven tests that plant a shell script in place of git, or need git to run one, skip themselves on Windows and say why; jb-memory runs only `git.exe` there.
- New tests in `tests/handoff-checks.test.js` (both copies), including one that no script loads a network module.
- The session-start warning line no longer ends some warnings with two periods.
- The smallest allowed `injectChars` is now 2,000 (it was 1,000): below that, the parts that are never cut, such as launcher warnings and the Codex copy's startup note, may not fit. When the whole doesn't fit, the handoff gives way first, then the optional lines go in a fixed order; the commit list shrinks to one line, and warnings are shortened, never dropped.

Fixed before release, from an independent review of this change:

- The recorded repo root comes from the state file, which a session can write. A network path there is never resolved or compared, since even that would reach the server from outside the sandbox; the warning says the path wasn't looked up. Both paths in the warning, and the one `dir` prints, have tag-like text escaped.
- The handoff's short SHA is resolved among objects only, so a branch or tag named like it can't stand in for the commit.

Fixed before release, from a second independent review of the whole release:

- Folder names from the state file (the commit sweep's record) and from command text (the end-folder check) were compared by resolving them, outside the sandbox, before any network check. A network path is now compared by name only, wherever a comparison happens. NT object paths (`\\??\\UNC\\server`) count as network paths too.
- A repo's own files could lead git to a share: a `.git` file's `gitdir`, `include.path`, settings that name a file, `objects/info/alternates`. Before git runs in a folder, the `.git` above it is read as text (included local config files too, five deep), and git stays out of a folder where any of them names a network path.
- Files in the memory folder are no longer read through a link, and a memory subfolder that is a link isn't read from. The launcher reads some of these outside the sandbox.
- `CLAUDE_CODE_PROJECT_DIR_NAME` may hold only letters, digits, `.`, `_` and `-`; a `*` there would have widened the sandbox's write grant, since Node reads `*` as a wildcard. The launcher also refuses to start a sandboxed script when any granted path contains `*`.
- Tag-like text is escaped in more forms: names with `.` or `:` or an invisible character in them, names that start with a role word (`<systemprompt>`, `<developer>`), and names with a letter outside ASCII. `Array<string>`, `<https://...>` and placeholders like `<repo>` are left alone.
- `install.cmd` and `install-jb-watchdog.cmd` start PowerShell by its full path, and `install.ps1` refuses a symbolic link or junction inside the release, as `install.sh` already did.
- A commit command's record in `pending/` is read the same careful way as other memory files.
- SECURITY.md now says which grants are wider than the memory folder, what the git-pointer check can't see (a mapped drive letter), and which review notes were left for later.

## 0.4.4 (jb-memory): 2026-10-28

- A new plugin icon: a ring of neurons joined by synapses, with a glowing signal running around the loop back to the node where it started, the way a new session picks up where the last one stopped.

## 0.4.3 (jb-memory): 2026-10-28

- A plugin icon (`plugins/jb-memory/.claude-plugin/icon.png`, 1024 x 1024) for plugin directory listings: an earlier session's note behind the next one, joined by a thread through milestone points.

## 0.4.2 (jb-memory): 2026-10-26

- A plainer plugin description, marketplace description and README opening, saying what the plugin is for and what it gives you, in the same style as the Codex copy.

## 0.4.1 (jb-memory), 0.2.3 (jb-memory-codex): 2026-10-26

- Plainer hook descriptions, the text shown when you review or trust the hooks: what each hook does for you, that hooks do nothing in repos where jb-memory isn't on, and what the launcher may touch. The hooks themselves are unchanged.

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

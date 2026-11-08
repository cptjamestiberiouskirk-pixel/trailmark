# Changelog

## 0.6.1 (Trailmark and trailmark-codex): 2026-11-08

Fixes and wording. Nothing new to set up, and no setting changed.

### Commit sweep

- A session whose record had no start time got no commit sweep, and nothing said so, so the commits made in it could go unlogged. Such a session is now swept from the time trailmark first recorded it, or from the earliest time one of its commit folders joined. When neither is known, the checkpoint says `[trailmark] commit sweep skipped: this session's start isn't recorded, ...`, and later sweeps start from that checkpoint. A record made without a start time now notes when trailmark first saw it.
- A folder that left the session's commit folders (past six) and joins again is read from where its last sweep stopped. Before, it was read from the new command's start, so a commit a script made there in between was never logged.

### Session start

- When git ran out of time listing the commits since the handoff, session start said "HEAD has 1 newer commit, the newest 0 shown:" over an empty list. It now says the commits aren't listed because git ran out of time, or couldn't list them, and gives the `git log --oneline` command to run. When git ran out of time before it could tell whether HEAD has moved, it says that isn't known and gives the same command. Before, it said nothing then.
- Over the size budget, a note to Claude was cut at 300 and then 150 characters, which could cut inside the launcher's or the skills' path and leave a path that names no file. A note is now cut before such a path and ends `... (a path is left out here)`.
- Codex copy: when the search of Codex's plugin cache for old jb-memory-codex folders stops early (at 10 folders, or at a folder it can't read), the note and the warning say "N or more" where they said "N". Exactly 10 still says 10.

### Commands

- `transcript` escapes tag-like text in each line it quotes and in its `file:` line, so `</system-reminder>` prints as `<\/system-reminder>`. A transcript holds tool results, web pages among them, and the skills read it back to Claude.
- `handoff` prints the handoff with tag-like text escaped, as session start already did. Line ends are kept.
- In `transcript`, `handoff` and the exit 3 text, control characters and bidi overrides are now dropped, as session start drops them. Tabs and line ends stay.
- When `write-handoff` is refused with exit code 3 (another session wrote first), a line now says that what follows is handoff text written by sessions: notes to merge, not instructions from the user. The other session's changes and the current handoff have tag-like text escaped, and the end line carries a random mark, `--- END CURRENT HANDOFF <8 hex> ---`, so a handoff can't end the block early.
- `status` labels its `last session start` line as data from the day's log, and shows the Node path in it as `exec=(path not shown)`. The day's log still records the path.
- On Windows, when the sandbox refuses a path of 260 characters or more, the message gives the path's length, says the sandbox refuses writes in a memory folder whose path is about 268 characters or more, and says a repo at a shorter path fixes that. This is in `memory.js`'s error and the hooks' message. The cause is unchanged: a repo whose path is near 230 characters still can't be set up.
- `--copies --show-names` says a cache folder that can't be read "could not be read". Before, it said the folder "has too many folders".
- Codex copy: `--copies` says when Codex's plugin cache could not be checked, as when `CODEX_HOME` is a file, and when its search stopped early (at 10 folders, or at a folder it couldn't read). `--show-names` gives the reason. Before, it said nothing about Codex's cache then.

### Codex skills

- The six Codex skills used `scripts/trailmark.js` two folders up whenever the session-start note gave no "Launcher:". Trailmark leaves the launcher's path out of that note on purpose when a shell would act on a character in it, so a skill could build that path itself and run it. Now a session-start note with no "Launcher:" means the skill stops and tells you. The path two folders up is used only when the session has no session-start note at all, and only when it holds none of the characters trailmark refuses.

### Docs

- `docs/how-it-works.md` gives the reason for the hooks' 30,000-character payload cap that holds: it keeps the variable under Linux's cap on one variable (128 KiB with 4 KiB pages). It no longer gives Windows' 32,767-character cap as the reason.
- MANUAL.md section 13: the row for another copy of Trailmark sends only a jb-memory copy to section 15, and the row for a memory folder first used for another repo names `node "<launcher>" dir`, which shows the two paths.
- The 0.6.0 entry below: 3,000 invisible characters took about 40 seconds, not minutes, and 0.5.1 had the same slow check.

### Tests

- Each fix in the code has a test that fails on the code before it.
- The commit-list tests, listed as failing on busy machines, now repeat when session start says git ran out of time. Each repeat checks, from a timing report the launcher writes only for the tests (`JBMEM_SHOW_SINCE=1`), that time really ran out. After three in a row the test skips, and only if the same lookup answers when given 30 s.

## 0.6.0 (Trailmark and trailmark-codex): 2026-11-06

### Context watch (Claude Code only)

- New: as a session's context nears the point where Claude Code auto-compacts it, Claude is asked to run `/trailmark:checkpoint` first, so the session's decisions and next steps are in the handoff before the compaction summarizes them. It asks at 85% of that point, and again at 90% and 95% only if no checkpoint was written since. You see `[trailmark] Context about ...` when it asks. It starts over after a compaction, and when the window grows past any it has asked in.
- The launcher reads the context size from the end of the session's transcript. It takes the window from `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then the settings files (their `env` block, then `modelSettings` or `autoCompactWindow`), then the model's own (1M or 200k), and honors `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. What came after the last request is estimated from the tool's result or the prompt; an image counts as 4,784 tokens, the most one costs on Claude's high-resolution tier. One tool call adds at most 25,000, while a prompt counts in full. Below 80% of the earliest point any setting allows, it exits before loading the rest of its code, and starts no git.
- `"contextWatch"` in `.jbmem.json` sets `on`, `steps` and `reserve` (MANUAL.md, section 7).
- The Codex copy has none: where Codex compacts by default isn't established, and its hooks have no prompt event.

### Hooks

- On macOS, a hook run for a tool call with a big result, such as an image Read or an Edit of a big file, could stop after 9 s ("took too long and was stopped"). Node's `spawnSync` sometimes deadlocks while it writes a big input to a child's stdin (seen in CI). The launcher now hands each hook's script only the payload fields it reads, in an environment variable, and nothing on stdin. A hook whose payload would be over 30,000 characters of JSON isn't started, and the launcher says so on stderr. A very long command is the usual cause, and quotes or line breaks in it count double. The tool call goes on. Both copies.
- `write-handoff` and `park` had the same exposure for a big text (a handoff over its budget is still saved, and a parked item has no size cap), against their 120 s limit. The launcher no longer reads their text and writes it on: the script reads the launcher's own stdin, or opens the `--from` file the launcher checked and reads it only if it is still that file. Both copies.

### Session start

- The warning shown to you is now fixed text for each case: Node inside the repo, the sandbox state, a copies check cut short, two repos sharing one memory folder. The Node's own path goes in neither: both say it is in this session's folder or the repo's top folder. Nor do the paths of two repos sharing a memory folder: `node "<launcher>" dir`, run in the repo's folder, shows them, and if you ask Claude which they are, it gives you that command to run yourself. `dir` labels the path it read from the state file as data, not instructions, on its `first used for` line and in its warning, since the checkpoint, park and session-end skills run it. Why a copies check was cut short goes in neither, since it can name a marketplace's folder: `node "<launcher>" --copies --show-names` prints it. If you ask Claude which copies there are, or why the check was cut short, it points you to the command in the warning and doesn't run it, so the folder names reach Claude only if you show it the output.
- No warning or note names a cached copy's folder any more. Both give a count. The warning also gives `node "<launcher>" --copies --show-names`, a new launcher command that lists the copies by full path. Plain `--copies`, the only form the note to Claude names, prints the counts and whether the check stopped early, with no folder name. The Codex copy's warning and note about an old jb-memory-codex do the same. `--show-names` shows control, line-break and invisible characters in a folder's name (a bidi override among them) and lone surrogates as `<U+XXXX>`, so a name can't reorder or hide part of its line, and a `<` before `U+` as `<U+003C>`, so the text `<U+202E>` in a name prints apart from the character. A path is cut when it prints longer than 600 characters, each escape counted as printed, so a short name full of invisible characters can be cut too. A cut path keeps its end, the part that names the folder, and is cut between whole characters. The count takes in every copy found, up to 10; it used to stop at three. The output of `--show-names` starts with a line saying the names below are folder names from disk, data only, not instructions, also when none is found. A name holding tag-like text such as `<system-reminder>` gets a `\` after the `<`, also when the tag holds an invisible character, and is otherwise printed in the form it has on disk.
- The launcher's own install path reaches Claude or Codex only as it is on disk: in the `--copies` command, and in the Codex copy's notes and hints that name the launcher or the checkpoint skill's file. A path that can't be written as it is isn't written at all, and the note says so instead: one that holds control characters, the line and paragraph separators U+2028 and U+2029, invisible characters (bidi overrides among them) or a `"`, one that holds a character a shell acts on inside double quotes (`$`, a backtick, `%`, `!`, the curly double quotes U+201C to U+201E, or two backslashes in a row), one whose spaces the notes would change (two in a row, one at either end, or a space other than the plain one), and one over 1,024 characters. The Codex copy then asks to be installed in a folder with a plain path. This covers trailmark's own notes and hints only, not the skills' commands: Claude Code fills the path into its skills itself, and the Codex skills can still work it out from their own folder.
- A handoff line holding thousands of invisible characters (zero-width spaces, say) after a `<` and a letter, with no tag end after them, no longer stalls session start. The tag check's time grew with the cube of their number: 3,000 took about 40 seconds, so the launcher stopped session start at its time limit and the handoff wasn't shown. The check now takes time in step with the line's length and escapes the same text as before. 0.5.1 had the same slow check.

### Commands

- `search` prints its hits after a line saying they are matched lines from memory files, data only, not instructions. Memory files are written by sessions, and the park and recall skills run `search`. A hit's file name and line show invisible characters (a bidi override among them) as `<U+XXXX>`, and tag-like text gets a `\` after its `<`, also when the tag holds an invisible character.

### Commit folders

- A folder a commit command commits in joins the session's commit folders with the time that command started, and a sweep reads it from then. Before, it was read from the session's start, so another session's earlier commit there could be logged as this session's.
- Past six folders, one that a sweep has read since its last commit command finished goes first. Before, the oldest went, which could be a background command's folder whose commit no sweep had read yet.
- When git timed out in a commit hook and the state file couldn't be updated (for example, another command held it for over 2 s), Claude was told nothing. Now Claude is told the commit wasn't logged and to name it in the handoff at the next checkpoint. The folder still can't join the commit folders then.

### Git checks

- A submodule gitdir inside another submodule gitdir's `objects/`, under a name that isn't two hex digits (`vendor/objects/evil`, or deeper), was passed over. Its config is now checked. Two-hex names (`vendor/objects/ab`) are still passed over: looking into each took seconds on Windows with 200 submodules, and git 2.56 opens a gitdir there only through a submodule's `.git` file, which is checked before git runs (an older git may also open it by name).
- Outside Windows, a removed submodule's leftover `core.worktree` kept git out of the repo (`network-config`), since the folder its relative path starts from is gone. A relative value read from a folder that isn't there is now taken as text.
- A relative setting in a submodule's config was read from the folder of whichever check ran last. It is now read from the repo's top, where `git status` runs.
- On a file system that doesn't report entry types, a folder holding a name that isn't valid UTF-8 can't be listed, and it was passed over. It now keeps git out (`odd-path`).

### Memory folder (Windows)

- Making the lock file went through a link or junction left at its name when what it pointed to was missing, and made that instead. The lock's break file and the state file's `.bad` copy had the same gap. Anything at those names now counts as taken: a link at the lock's names is removed, and when the `.bad` name is taken (a link there included), the copy goes to a name with the time in it.

### Tests

- 30 link tests that skipped on every Windows machine now run wherever links can be made, as on CI's Windows runners, and two hard-link tests run everywhere. The POSIX-only ones that still skip on Windows say why. On Windows, a test link to a network path is made without looking the share up.
- A POSIX test for a link inside a leftover module folder's `objects/ab`.
- The Windows junction test, and the links test that moves a `.git` the same way, now wait out a rename of `.git` or a junction refused with `EPERM` or `EBUSY` for up to 2 s, right after git has written it. A scanner holding the new files is the likely cause: the failure came in 7 of 24 runs in a scanned folder and in none of 24 in a folder excluded from Defender's scanning. A refusal that lasts, and any other error, still fails the test. Only the tests changed.

## 0.5.1 (Trailmark and trailmark-codex): 2026-11-03

### Commit sweep

- A commit sweep that runs out of time now says so: "commit sweep skipped: out of time" after a checkpoint, and as a warning at session start. Before, it was skipped without a trace. It runs out when git is slow, for example while other work keeps every core busy. Nothing is lost either way: the folders it didn't read keep their start, and the next sweep logs the commits it missed. The time limits are unchanged.
- When git was too slow to answer (it timed out) in a linked worktree or a subfolder, trailmark looked for the memory folder from that folder instead of the main checkout. Hooks then found nothing set up and did nothing, so a commit command's start went unrecorded. Setup (`init`) in a worktree could set up the worktree's own folder in place of the repo's. Now the repo is found from the `.git` entries on disk, as when git is kept out.
- When git ran out of time in a commit hook (`COMMIT_UNRESOLVED why=git-timeout`), Claude was told "Commit landed." when a reminder was due and nothing otherwise, and a commit in another folder was never logged, since no sweep read that folder. Now Claude is told the commit isn't logged yet and in how many folders (by count only, so a folder name can't read as an instruction from the plugin; the session-start warnings about other trailmark copies and an old jb-memory-codex now do the same, and the folder names are only in the note marked as data), and the folder joins the session's commit folders, so the next sweep logs it. (Not while another command holds the state file for more than 2 s: then only the log line is written, as before.)
- A commit command sent to the background (`run_in_background`) usually got no note, since its hook runs before the commit exists. The note that a later sweep logs its commits now comes then too, once per command, and each other folder it commits in (`git -C`) joins the session's commit folders, so that sweep reads it. That holds too when it had already committed in one of them by the time its hook ran.
- After git timed out, finding the repo from `.git` on disk could still start `git config --file` (3 s limit) for a config holding `//`. It now reads only the `.git` entries and pointer files, so no git starts and the caller's time limit holds.
- Tests: each test removes the temp folders it made when it ends (about 150 MB a full run were left behind), keeping and naming those of a failed test; `JBMEM_TEST_KEEP=1` keeps them all. `dev/release-check.sh` also points Node's temp folder (TEMP and TMP on Windows) at its own folder.
- Tests: the sweep test no longer depends on how fast git is. It repeats a sweep that ran out of time, for up to 90 s, and checks what all of them logged. If git stays too slow for any sweep to finish in that time, the test is skipped and says why. Two new tests run a sweep out of time on purpose (`JBMEM_TEST_SWEEP_MS`, which can only lower the time a sweep gets) and check the report, that nothing is logged and no start moves, and that the next sweep logs the commit.

### Git checks

- A branch whose name isn't valid UTF-8 (possible on Linux) kept git out of the repo (`odd-path`), though git handles it. A plain file with such a name is now passed over; a folder or link with one still keeps git out.
- A folder left in `.git/modules` by a removed submodule, with no `HEAD`, had its loose objects counted, so a large one kept git out (`many-entries`). They are now passed over, as for a real submodule's. Only a folder of plain files with no `HEAD` is passed over: anything else there is still checked, so a submodule named like `vendor/objects/ab` or `vendor/objects/ab/child` has its gitdir checked as before.
- In a repo with many submodules, the check of their gitdirs in `.git/modules` looked at the same folders again for every path (about 26,000 lookups for 200 submodules, 2 to 4 s of a hook's 5 s). Each folder is now looked at once per check: for 200 submodules, 2.1 to 2.4 s became about 0.4 s on an idle machine, and 17 to 27 s became 2.4 to 3.0 s with every core busy. So status is skipped with `git-timeout` less often. What one check found is never kept for the next.

## 0.5.0 (Trailmark and trailmark-codex), 1.7.0 (trailmark-watchdog): 2026-10-31

jb-memory is now Trailmark, and this is its first public release. Everything in 0.4.5 below is part of this release too.

### Names

- The plugin and its marketplace are `trailmark` (install `trailmark@trailmark`). Skills are `/trailmark:checkpoint`, `/trailmark:session-end` and so on. The status line reads `[trailmark]`, and the launcher is `scripts/trailmark.js`.
- The Codex copy and its marketplace are `trailmark-codex`, and its skills are `tm-checkpoint`, `tm-recall` and so on. It now shares Trailmark's version number, 0.5.0 (it was 0.2.4 as jb-memory-codex), so one number names one release.
- The Windows watchdog is trailmark-watchdog 1.7.0 (jb-watchdog before). It installs to `%LOCALAPPDATA%\trailmark-watchdog`, and its installer's log goes there as well.
- Kept on purpose, so existing repos need nothing: the memory folder's files (`.jbmem.json`, `.jbmem-state.json`, `.jbmem.lock`) and the `JBMEM_*` environment variables. Handoffs carry over as they are.

### Moving from jb-memory

- MANUAL.md, section 15, has the steps. `tools/migrate-from-jb-memory.js` (`migrate-from-jb-memory.cmd` on Windows) does them for Claude Code and Codex, then runs the installer. Quit Claude Code and the ChatGPT app and run it from a terminal of its own; `--dry-run` shows what it would do. It refuses to run inside a Claude Code or Codex session.
- It uninstalls jb-memory at every scope, removes the old marketplaces, moves old copies out of Claude Code's plugin cache into a backup folder, and tells you what is left to do in the ChatGPT app.
- Codex uninstalls plugins only in the app, and the app shows a plugin only through its marketplace. So the script keeps the `jb-memory-codex` marketplace until you've uninstalled the plugin there; run the script again afterwards. If that marketplace is already gone, it adds it back from your old release so the app can show the plugin. `--clean-codex-trust` removes Codex's leftover hook-trust records for jb-memory-codex.
- When an older trailmark-codex is installed, the script reminds you to choose Upgrade in the app. On Windows it also installs trailmark-watchdog when the old jb-watchdog is there.
- `install-trailmark-watchdog.ps1` removes the old `jb-watchdog` scheduled tasks and installed copy once the new known-good list is recorded, just before it adds its own tasks. Declining at that step leaves the old watchdog running. Its `-Uninstall` removes both. The old log and known-good list stay in `%LOCALAPPDATA%\jb-watchdog` until you delete them.
- Codex installs trailmark-codex under a new cache folder, and the hook text changed, so Codex asks you to trust the hooks again.
- You can also move by hand (section 15 again). Type the new skill names afterwards. A handoff that still mentions a `jb-memory:` skill changes nothing, since it's only text.

### Old copies are refused

A copy under the old name still counts as another copy, because two copies would each run every hook.

- The installers refuse while `jb-memory` is installed at any scope.
- Session start names a jb-memory copy in Claude Code's plugin cache, or any copy that holds the old `jbm.js`, even one Claude Code lists as installed.
- The Codex copy warns at each chat start while `jb-memory-codex` is still in Codex's plugin cache.
- trailmark-watchdog reports a cached jb-memory copy as HIGH at every scan, and that finding can't be accepted. It still reads the older nested layout with its old names (`jb-memory` marketplace entries, hooks that run `jbm.js`).
- The Windows diagnostics recognize both names in older transcripts.

### Installers

- `--preflight` (`-Preflight`) runs the checks with jb-memory not counted as another copy. The migration script runs it before it removes anything, so a refusal such as an old Node no longer leaves you without a plugin.
- `claude plugin validate` is now one of the checks, in `--check` and `--preflight` too.
- `install.sh --help` shows every option, and the installers' step lists name the jb-memory refusal.
- `install.ps1` exits 3 when Trailmark was installed but trailmark-watchdog wasn't. `--uninstall` / `-Uninstall` exit 2 when a step really failed, or when the trailmark-codex marketplace couldn't be removed or was kept. The `.cmd` wrappers pass the exit code on.
- Uninstalling keeps the trailmark-codex marketplace until you've uninstalled the plugin in the ChatGPT app, and keeps it when Codex's `config.toml` can't be read. Run the uninstall again afterwards (MANUAL.md, section 14).
- `install.ps1`, the watchdog and its installer work when started from PowerShell 7, including a copy installed from the Store or Scoop. Windows PowerShell 5.1 started from there used to stop with "could not read the permissions". PowerShell 7's module path is now dropped, the folder check falls back to .NET when `Get-Acl` still fails, and the message says why.
- The watchdog installer accepts `-Root D:\`, and a release reached through a junction or a `subst` drive matches its marketplace.

### Other changes you may notice

- When git is kept out of a repo, session start says so with a reason word: `git is kept out of this repo (<reason>)`. The snapshot taken before a compaction shows `not read (git kept out: <reason>)`. The handoff still loads, and the memory folder is found without git, so worktrees keep their shared handoff. MANUAL.md, section 16, lists each reason word and what to fix.
- A snapshot can also say `not read (<reason>)` when only its list of changed files was skipped. Reasons that come from checks added in this release include `odd-path` (a tracked path that isn't valid UTF-8), `outside-worktree` (a `core.worktree` that isn't the session's folder or above it), `lfs-config`, `submodule-pointer`, `linked-folder` and `many-submodules`. One submodule on a share skips only the file list.
- The snapshot no longer lists untracked files, since git would look inside untracked folders that are repos of their own. Its `git status` covers the whole worktree even when the session works in a subfolder.
- A branch git didn't report in time is shown as `unknown` rather than `detached`, and the `Updated:` line the model wrote is kept.
- The commit sweep finds commits that only the stash or another worktree holds, and ones on a custom ref. A file named `HEAD` no longer silences it. A commit command you denied at the permission prompt no longer holds the sweep back once the same thread of that session (its main conversation, or the same subagent) finishes a later commit (a record from Codex, which gives no subagent ID, and a command sent to the background still hold until their time is up). A commit-start record over 32 KB isn't read at all. A pointer file with a NUL in it keeps git out, since git reads only up to the NUL. So does a pointer, link target, alternates line (also one written with quoted `\ooo` escapes, which git turns into raw bytes) or name inside `.git` that isn't valid UTF-8 (`odd-path` for a name), since git opens raw bytes the check can't name, and a `.git` with more than 100,000 entries besides loose objects and the Git LFS and git-annex stores (`many-entries`), where before the rest went unchecked. Alternates are read entry by entry as git reads them; quoting git would reject, or text after a closing quote, keeps git out. A path with a missing folder followed by `..` keeps git out. An include reached by two spellings is read under each. On Windows a `.git` that is a link or junction keeps git out. A repo with more than 20,000 tracked folders has its file list skipped before a compaction (`many-folders`), where before the folders past that went unchecked. On macOS and Linux a backslash in a name is no longer taken for a separator.
- A session working on a share keeps its commit sweep and no longer gets a false "first used for another repo" warning. A remote on a share no longer keeps git out, since no transport runs. A project folder on another disk keeps commit locations right.
- Large repos keep their speed. Submodule gitdirs are checked only before `git status`, the one call that opens them, and tracked folders are looked up by name or listed once. A folder that holds a `HEAD` text file no longer costs a repo its git facts.
- Links in Claude Code's `MEMORY.md` index that go through a linked folder or leave the memory folder (`..`, an absolute path) aren't followed. They're listed on their own as not checked, not as dead, and so is a topic file that is itself a link. A link into a folder that is gone still counts as dead. Links with `#part` or `%20` are read the way a viewer reads them.
- A linked `MEMORY.md` no longer blocks `init`; `status`, `budget`, `prune-report` and `archive-file` say it isn't read.
- `list` and `status` print stored text escaped, and names with bidi or tag characters are shown quoted.
- A line starting with `JBMEM_EOF`, the end marker of the heredoc the skills pass text in, is refused on write, and the skill indents it and writes again. Session start and `handoff` show such a line indented, and so does the conflict output.
- `archive-file` refuses a name a shell's single quotes can't hold: a quote, the typographic single quotes, control characters or a leading dash.
- `transcript --file` takes only a transcript in Claude Code's projects folder. `transcript` no longer looks for a session's transcript in other projects' folders.
- When the lock file can't be created, the message names the likely cause. In the Codex copy that is Codex's sandbox, which refuses writes outside the workspace until you approve them; the old text blamed another program holding the file.
- Session start treats a transcript as Claude Code's own only when it is in Claude Code's projects folder, as the Codex copy already required, not just any folder named `projects`. The session's start folder comes from the first transcript record's own `cwd`, even when that line is longer than 64 KB.
- On Node 22 the sandbox could refuse to list the projects folder, because of the order its read grants were given in. That's fixed.
- The Codex copy's `budget` output describes Codex's hook limit.

### Documentation

- The README is now a landing page. The plugin README, the one the plugin directory lists, covers installing and everyday use. The technical reference moved to `docs/how-it-works.md`, and CONTRIBUTING.md is new, as are issue and pull request templates.
- CI now checks `SHA256SUMS`. The Codex manifests name the homepage and repository, and the plugin icon carries no embedded file metadata.

### Security

Before git runs in a folder, Trailmark checks the `.git` git would use for anything that leads to a network share, and keeps git out when it finds something or can't be sure. Even a stat would reach the server from outside the sandbox. It now fails closed on every gap that turned up before this release. SECURITY.md, "Known limits", describes the check in full.

- Config is read the way git reads it. Quotes are dropped and escapes undone, continued lines are joined, and pointer text keeps its spaces; a pointer that starts or ends with whitespace is refused. Config files with quotes, backslashes, includes or anything outside printable ASCII are parsed by git itself (`git config --file`, includes off). Values like `path = ""//server/x` or a `gitdir:` spelled `\/server/r` used to get past the check.
- Includes are followed ten deep, as git does, relative to the including file, and at most 50 files are read. Past either limit git is kept out. A value starting with `%(prefix)` is refused. Alternates are followed six deep, and each alternate's own folders are checked for links.
- Settings that name a file or folder (`core.attributesFile`, `core.excludesFile`, `core.worktree`, `mailmap.file`, `lfs.storage` and the like) are resolved the way git would, through links, before git runs.
- The check now also looks where git looks without being told. That means a decoy `.git` git passes over on the way up and a folder whose `HEAD` git would try as a bare repo. It also covers each other worktree's `commondir` and the folder recorded for it in `gitdir` (git 2.56 opens that for `rev-list --all`, relative paths included); a `worktrees` or `modules` folder, or a worktree entry, that is a link is resolved before anything is listed or read through it, each submodule's `.git` and its gitdir in `.git/modules`, a tracked file that has become a folder with a `.git`, and Git LFS's stores and `.lfsconfig`.
- Links are read as text and followed one step at a time, in the gitdir (except `hooks/`, which never runs) and in the folders of tracked files that `git status` looks through. A link to a local place is followed and what it leads to is checked, so Android `repo` and git-new-workdir layouts work. A link that leads to a share keeps git out. So does a FIFO in place of `HEAD` or a gitdir nested more than 64 folders deep, and so does a pointer or config file that is a link or can't be read.
- A folder named in a command (`cd vend && git commit`) is checked for links to a share before anything looks into it, and git is never run from a folder inside a `.git`. A session that works on a share may let git reach that share, but no other.
- Folder paths from the state file, which a session can write, are never resolved through a link that leads to a share, and a forged session folder there keeps git out. A transcript path in the state file is used only when it is this repo's (Claude Code) or carries the session's ID (Codex).
- Every transcript the launcher or the `transcript` command reads is opened as a plain file, never a FIFO and never through a link to a share. A transcript that is itself a link isn't read at session start. The plugin cache and plugins folder are never opened through a link to a share, and a chain of links there that ends on one is never followed. The `\\?\` form counts as a network path.
- Repo-configured filters stay switched off for the pre-compaction `git status` across the whole worktree. While Git LFS runs, a `.lfsconfig` that is a link or includes a file skips `git status`, and a tracked path that isn't valid UTF-8 skips it too, because the checks can't name the file git would open. A long `git -C` chain can't stall the commit hook.
- In the memory folder, subfolders (`pending/`, `notes/` and the rest) are never listed or read through a link anywhere on the way. Files are listed and dated only when they're plain files, and `.jbmem.json` is checked without following a link. A `MEMORY.md` link through a linked folder isn't followed, and the prune skill never opens a link that leaves the memory folder.
- The day's log is never appended to through a hard link: it is replaced by its own copy first. A hard link left by a backup tool no longer makes memory files read as missing.
- A link or FIFO in place of the lock file is removed, but only once the break lock is held. A leftover folder can't hold the lock forever, and a lock with a second hard link isn't broken while its holder runs.
- Text from earlier sessions is injected inside a frame, with tag-like text escaped. More ways of hiding a tag are caught now: control characters, a blank-looking braille space, combining marks, look-alike slashes and a tag split over two lines. Invisible tag characters and bidi overrides are dropped from what session start injects, while subdivision flags such as Scotland's are kept.
- The installers leave out PATH entries that aren't absolute folders (`.`, an empty entry, a relative folder, or a drive-relative one such as `\tools` or `C:`) for their own run, and say so. install.ps1's warning about an entry like `\tools` never matched before. install.sh also refuses a `node` or `claude` found through `.` in PATH.
- install.sh refuses access-list entries that let others write, on the release and on the folders above it. It counts a group named after you as shared when anyone else is in it, also as their main group, and no longer lets group write through on macOS, where no group is named after you. install.ps1 compares owners by SID and refuses one it can't identify.
- The migration script runs the installer's preflight before it removes anything. It removes project and local scopes first and user scope last. If a scope can't be removed or the installer can't run, jb-memory stays at every scope, and a scope it already removed is put back (turned off again if it was off). When Claude Code rewrote a repo's `settings.json` doing that, the list at the end says to check `git diff`. If the installer stops, jb-memory goes back at user scope and the script says how to finish or go back, using only a local copy of the old release.
- The script moves old cache copies to a backup folder rather than deleting them, and keeps every earlier backup. It leaves marketplaces and cache copies that other plugins still use alone, and never touches memory folders, handoffs or `.jbmem.json`. The one settings file it edits itself is Codex's `config.toml`, only with `--clean-codex-trust` and only while the ChatGPT app is closed. It backs that file up first, removes only hook-trust lines it understands, writes through a temporary file, and leaves a hard-linked `config.toml` alone.
- The script gives the programs it runs only absolute PATH folders and stops cmd.exe from running a program from a repo's folder. On macOS and Linux it waits for your answer at its prompt (before, it answered for you). It refuses an option where a folder should be. At the end it says plainly when Trailmark wasn't installed, and it's safe to run again.

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

Also fixed in this release:

- The recorded repo root comes from the state file, which a session can write. A network path there is never resolved or compared, since even that would reach the server from outside the sandbox; the warning says the path wasn't looked up. Both paths in the warning, and the one `dir` prints, have tag-like text escaped.
- The handoff's short SHA is resolved among objects only, so a branch or tag named like it can't stand in for the commit.

Further fixes in this release:

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

First release: one folder that is both the Claude Code marketplace (`jb-memory`) and the Codex marketplace (`jb-memory-codex`), with installers and a manual.

- Installers for macOS and Linux (`install.sh`) and Windows (`install.ps1`, `install.cmd`). They check Node against the security floors, git and Claude Code, refuse a folder broad groups can write to, run the sandbox check, refuse a second copy of jb-memory from another marketplace, then validate, add the marketplace and install. `--check`, `--uninstall` and opt-in Codex, watchdog and Windows lookup options.
- Skills speak of "the user" instead of a fixed name. Decision provenance is written `[user YYYY-MM-DD]`; older handoffs with a name in that place still read correctly.
- The checkpoint skill no longer carries a fixed model recommendation. It adds a model note to a next action only when the repo's CLAUDE.md or AGENTS.md, or the user, sets a model policy.
- jb-watchdog 1.6.0 understands the release layout (the watched folder is itself the marketplace) as well as the older one (a `jb-memory-marketplace` subfolder). It records the layout in the known-good list, so a later scan can't be switched to the other one by moving files, and says so when an accept would change it. It recognizes the Codex copy's hook commands exactly, ignores `*.log` in `tools\windows`, and `-Init -Root <folder>` now moves the watch to a new folder.
- install-jb-watchdog.ps1 takes `-Root`, and from `tools\windows` watches the release folder two levels up.
- Diagnostic scripts find the plugin in either layout and default `-Repo` to the current folder.
- Documentation: README, MANUAL, SECURITY. Machine-specific paths and notes removed from the plugin READMEs and comments.

Security fixes in this release:

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

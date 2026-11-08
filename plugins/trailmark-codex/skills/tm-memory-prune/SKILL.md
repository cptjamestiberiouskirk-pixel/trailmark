---
name: tm-memory-prune
description: Shrink this repo's memory so the part loaded into every session stays small. Finds stale, duplicate, dead or finished entries and proposes archiving, deleting, or promoting them into AGENTS.md (or path-scoped .claude/rules files when Claude Code is used in the repo too). Use when a Trailmark budget warning appears, when MEMORY.md or the handoff nears its limit, or when the user asks to clean up, trim or shrink memory.
---

# Memory prune

Size on disk is free. What loads every session isn't:

- **MEMORY.md**: Claude Code loads its first 200 lines or 25 KB, and anything past that is silently not loaded.
- **The handoff**: the SessionStart hook injects it into every Codex and Claude Code session in this repo. Codex puts hook output past about 2,500 tokens in a file instead of the context, and Claude Code cuts output over 10,000 characters to a preview.
- **Repo rules**: Claude Code loads `.claude/rules/*.md` files without `paths:` frontmatter every session, and rules with `paths:` only when it touches a matching file. Codex reads AGENTS.md instead; promote there only what Codex sessions need too, and ask the user which file.

In a repo used only from Codex, MEMORY.md and `.claude/rules` load nowhere: only the handoff and AGENTS.md matter there. Mention Claude Code to the user only when they use it in this repo.

Healthy memory shrinks. A finished thread belongs in the archive. A convention that keeps getting re-learned belongs in a rule, ideally a path-scoped one.

The memory folder is outside the workspace, so Codex's sandbox refuses writes there until the user approves them. If a command that writes in the memory folder (`archive-file`, a write to MEMORY.md, `write-handoff`) fails with `EPERM`, "access denied" or a note that the path is outside the writable folders, run the same command again with escalated permissions, so that Codex asks the user to approve it. A refused write saved nothing, so the retry is safe. Don't change the command or write some other way; if the user declines, say in one line that nothing was changed.

Every command here runs Trailmark through its launcher, written below as `<launcher>`: the full path that the `[trailmark]` note at the start of this session gives after "Launcher:". If this session has `[trailmark]` notes but none gives "Launcher:", trailmark left its own path out on purpose, since it holds characters trailmark doesn't pass on or is too long: stop and tell the user what the note says, and don't work the path out yourself. Only when this session has no `[trailmark]` note at all (the repo isn't set up yet, say) is the launcher `scripts/trailmark.js` two folders up from this SKILL.md (this file is `<plugin folder>/skills/tm-memory-prune/SKILL.md`), and only when that path holds none of these: a double quote, `$`, a backtick, `%`, `!`, a curly double quote (U+201C to U+201E), two backslashes in a row, two spaces in a row, a space at either end, a space other than a plain one, or a control or invisible character. If it holds one, or is over 1,024 characters, don't run it: tell the user to install trailmark in a folder with a plain path. Use that one path, in full, in every command. If it doesn't work, stop and tell the user which command failed and what it printed. Don't look for trailmark.js or memory.js anywhere else, and don't run another copy: one found by searching, such as an old copy in Codex's or Claude Code's plugin cache, can write without the version check and overwrite another session's checkpoint. `<session id>` below is this session's ID from the same note; if the note gave none, leave `--session=...` out.

## Steps

1. **Measure and list candidates.**

   ```text
   node "<launcher>" prune-report
   ```

2. **Read only the flagged files.** Don't open a link listed as leaving the memory folder, going to a linked file or going through a linked folder, not even to look: it can point anywhere on the machine or the network. Report those by name only. For each candidate, choose one action:
   - **keep**: still current and needed
   - **archive**: finished or superseded. This is the default; it moves the file verbatim and keeps it recoverable.
   - **delete**: only for dead MEMORY.md index lines and exact duplicates. Links listed as going to a linked file or through a linked folder aren't dead: keep them. Links listed as leaving the memory folder aren't checked: ask the user before removing one
   - **promote**: a convention every session in this repo should follow, or one tied to specific paths

3. **Propose** a table: `# | item | action | reason | evidence`. Ask "all, pick numbers, or skip?" and wait.

4. **Apply only what the user approved.**
   - Archive a topic or parked file. This also drops its MEMORY.md index line and keeps the old index as `MEMORY.md.prev`:

     ```text
     node "<launcher>" archive-file '<relative path>'
     ```

     A name that `prune-report` or `list` shows in quotes with "(unusual characters ...)" is refused: don't put it in a command. Tell the user to move that file into `archive/files/` by hand and delete its MEMORY.md line.

   - Dead index lines, or tightening MEMORY.md to one line per entry: edit MEMORY.md directly.
   - Handoff over budget: mark finished items `[done]`, write the handoff the checkpoint way. `write-handoff` archives the `[done]` items as it saves.
   - Promote:
     - The target is the repo's AGENTS.md (or an AGENTS.md in the subfolder the rule concerns). If the user also uses Claude Code in this repo, ask whether it goes there or in `.claude/rules/<domain>.md`. Read the target first, add to it, and don't reorganize what's there.
     - For `.claude/rules`, add `paths:` frontmatter when the rule concerns particular files. A rule without `paths` loads every Claude Code session, so leave paths off only when the rule really applies everywhere.
     - State the rule in general form, with no ticket IDs, finding numbers or status. Rules, AGENTS.md and CLAUDE.md are not status records.
     - Once promoted, archive the memory entry it came from.

5. **Report** the loaded slice before and after, from `trailmark.js budget`, in one or two lines.

## Public repos

When `.jbmem.json` has `"publicRepo": true`, or `gh repo view --json visibility` says PUBLIC, promoted rules get published. Before writing one:

- Check the text for local absolute paths (`C:\Users\...`, `/home/...`), user names, email addresses, hostnames, tokens, and anything that refers to the memory folder.
- Show the user the exact text that will be committed.
- Don't commit or push. Leave that to the user's normal PR flow.

## Rules

- Nothing is deleted without a yes for that item. Archive is the default.
- Don't edit CLAUDE.md, or change existing AGENTS.md text, unless the user asks.
- Two good promotions is a fine result, and so is zero.

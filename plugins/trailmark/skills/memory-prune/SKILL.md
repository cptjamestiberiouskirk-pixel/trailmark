---
name: memory-prune
description: Shrink this repo's memory so the part loaded into every session stays small. Finds stale, duplicate, dead or finished entries and proposes archiving, deleting, or promoting them into path-scoped .claude/rules files. Use on /memory-prune, when a Trailmark budget warning appears, when MEMORY.md or the handoff nears its limit, or when the user asks to clean up, trim or shrink memory.
---

# Memory prune

Size on disk is free. What loads every session isn't:

- **MEMORY.md**: Claude Code loads its first 200 lines or 25 KB, and anything past that is silently not loaded.
- **The handoff**: the SessionStart hook injects it, and hook output over 10,000 characters is cut to a 2,000-character preview.
- **Repo rules**: `.claude/rules/*.md` files without `paths:` frontmatter load every session. Rules with `paths:` load only when Claude touches a matching file.

Healthy memory shrinks. A finished thread belongs in the archive. A convention that keeps getting re-learned belongs in a rule, ideally a path-scoped one.

Every command here runs Trailmark from the path shown, `${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js`. If the trailmark.js path itself doesn't work (it still has a placeholder in braces in it, or node says it can't find trailmark.js), stop and tell the user which command failed and what it printed. A session started before Trailmark was updated can hold a path that is gone; suggest resuming or restarting the session. Don't look for trailmark.js or memory.js anywhere else, and don't run another copy: one found by searching, such as an older one left in Claude Code's plugin cache, can write without the version check and can overwrite another session's checkpoint.

## Steps

1. **Measure and list candidates.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" prune-report
   ```

2. **Read only the flagged files.** For each candidate, choose one action:
   - **keep**: still current and needed
   - **archive**: finished or superseded. This is the default; it moves the file verbatim and keeps it recoverable.
   - **delete**: only for dead MEMORY.md index lines and exact duplicates. Links listed as going through a linked folder aren't dead: keep them. Links listed as leaving the memory folder aren't checked: ask the user before removing one
   - **promote**: a convention every session in this repo should follow, or one tied to specific paths

3. **Propose** a table: `# | item | action | reason | evidence`. Ask "all, pick numbers, or skip?" and wait.

4. **Apply only what the user approved.**
   - Archive a topic or parked file. This also drops its MEMORY.md index line and keeps the old index as `MEMORY.md.prev`:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" archive-file '<relative path>'
     ```

     A name that `prune-report` or `list` shows in quotes with "(unusual characters ...)" is refused: don't put it in a command. Tell the user to move that file into `archive/files/` by hand and delete its MEMORY.md line.

   - Dead index lines, or tightening MEMORY.md to one line per entry: edit MEMORY.md directly.
   - Handoff over budget: mark finished items `[done]`, write the handoff the checkpoint way. `write-handoff` archives the `[done]` items as it saves.
   - Promote:
     - Write into `.claude/rules/<domain>.md` in the repo. Read the target first, add to it, and don't reorganize what's there.
     - Add `paths:` frontmatter when the rule concerns particular files. A rule without `paths` loads every session, so leave paths off only when the rule really applies everywhere.
     - State the rule in general form, with no ticket IDs, finding numbers or status. Rules and CLAUDE.md are not status records.
     - Once promoted, archive the memory entry it came from.

5. **Report** the loaded slice before and after, from `trailmark.js budget`, in one or two lines.

## Public repos

When `.jbmem.json` has `"publicRepo": true`, or `gh repo view --json visibility` says PUBLIC, promoted rules get published. Before writing one:

- Check the text for local absolute paths (`C:\Users\...`, `/home/...`), user names, email addresses, hostnames, tokens, and anything that refers to the memory folder.
- Show the user the exact text that will be committed.
- Don't commit or push. Leave that to the user's normal PR flow.

## Rules

- Nothing is deleted without a yes for that item. Archive is the default.
- Don't edit CLAUDE.md unless the user asks.
- Two good promotions is a fine result, and so is zero.

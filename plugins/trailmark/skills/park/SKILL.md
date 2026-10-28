---
name: park
description: Save an idea or side task for a later session without derailing the current one. Use on /park, or when the user says park this, save that for later, come back to it, or note this idea, in a repo set up with Trailmark.
---

# Park

Captures one idea with enough context to pick it up cold, then gets back to the current work. Parked files sit on disk, so they cost nothing per session. Each session start shows only the count.

Every command here runs Trailmark from the path shown, `${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js`. If the trailmark.js path itself doesn't work (it still has a placeholder in braces in it, or node says it can't find trailmark.js), stop and tell the user which command failed and what it printed. A session started before Trailmark was updated can hold a path that is gone; suggest resuming or restarting the session. Don't look for trailmark.js or memory.js anywhere else, and don't run another copy: one found by searching, such as an older one left in Claude Code's plugin cache, can write without the version check and can overwrite another session's checkpoint.

## Steps

1. **Work out what to park** from the argument, or else from the last topic discussed:
   - What: the idea or task in one or two sentences
   - Why: the problem it solves
   - Context: details from this conversation that would be lost otherwise (file names, numbers, the option you were weighing). Raw is better than polished here.
   - Next step: what to do first when picking it up

   If it's unclear what the user means, ask one short question.

2. **Check for duplicates.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" list parked
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" search '<keyword>'
   ```

   Keep the keyword in single quotes. Inside double quotes the shell would run `$(...)`, and in Bash backticks too; PowerShell would also expand `$name`. Write a single quote in it as `'\''` in Bash or `''` in PowerShell.

   If it's already parked or already in the handoff, say where and stop. If `park` later says the file exists, another session may have parked the same slug a moment ago: read it, and pick a new slug unless it is the same idea.

3. **Confirm.**

   ```text
   Park this?
     What: <one line>
     File: parked/<slug>.md
   Save? (yes/skip)
   ```

   The slug uses lowercase letters, digits and dashes, and can't be a Windows device name (con, prn, aux, nul, com1, lpt1 and so on). Wait for the answer.

4. **Write it.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" park --slug=<slug> <<'JBMEM_EOF_${CLAUDE_SESSION_ID}'
   ---
   name: <slug>
   description: <one searchable line>
   type: project
   ---
   ## What
   ## Why
   ## Context
   ## Next step
   Parked <YYYY-MM-DD> on branch <branch>.
   JBMEM_EOF_${CLAUDE_SESSION_ID}
   ```

   The end marker carries this session's ID, so a line in the text can't end the heredoc early. If the text itself contains that marker line, save it with the Write tool and use `--from` as described next, in Bash too.

   Use the Bash tool for this when you have it. PowerShell won't pipe text into a command without manual approval, so with PowerShell only: take the memory folder from the first line of `node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" dir`, save the note with the Write tool as `incoming-park-${CLAUDE_SESSION_ID}.md` in that folder, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" park --slug=<slug> --from="<memory folder>/incoming-park-${CLAUDE_SESSION_ID}.md"`. The session ID in the name keeps two sessions parking at once from overwriting each other's file. If the command shows a placeholder in braces where the ID belongs, name the file `incoming-park.md`. The file is removed once the idea is parked. Write each command with the full trailmark.js path as shown, not through a variable such as `$j`, so PowerShell can check the whole command before it runs.

5. **Receipt** in one line: `Parked: parked/<slug>.md`. Then continue with what you were doing.

## Rules

- One idea per park. If the user lists several, offer to park them one at a time.
- Parking doesn't end the session or change the handoff. A parked item goes into the handoff only if it blocks something, and then under Open questions.
- Evidence labels apply to anything stated as fact in the Context section.

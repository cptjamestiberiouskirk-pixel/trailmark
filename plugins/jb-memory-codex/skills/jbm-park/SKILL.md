---
name: jbm-park
description: Save an idea or side task for a later session without derailing the current one. Use when the user says park this, save that for later, come back to it, or note this idea, in a repo set up with jb-memory.
---

# Park

Captures one idea with enough context to pick it up cold, then gets back to the current work. Parked files sit on disk, so they cost nothing per session. Each session start shows only the count.

Every command here runs jb-memory through its launcher, written below as `<launcher>`: the full path that the `[jb-memory]` note at the start of this session gives after "Launcher:". If there is no such note, it is `scripts/jbm.js` two folders up from this SKILL.md (this file is `<plugin folder>/skills/jbm-park/SKILL.md`). Use that one path, in full, in every command. If it doesn't work, stop and tell the user which command failed and what it printed. Don't look for jbm.js or memory.js anywhere else, and don't run another copy: one found by searching, such as an old copy in Codex's or Claude Code's plugin cache, can write without the version check and overwrite another session's checkpoint. `<session id>` below is this session's ID from the same note; if the note gave none, leave `--session=...` out.

## Steps

1. **Work out what to park** from the argument, or else from the last topic discussed:
   - What: the idea or task in one or two sentences
   - Why: the problem it solves
   - Context: details from this conversation that would be lost otherwise (file names, numbers, the option you were weighing). Raw is better than polished here.
   - Next step: what to do first when picking it up

   If it's unclear what the user means, ask one short question.

2. **Check for duplicates.**

   ```text
   node "<launcher>" list parked
   node "<launcher>" search '<keyword>'
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

4. **Write it.** The note's text:

   ```text
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
   ```

   The text goes through a file, never through the shell: quoting long text in PowerShell or Bash is where it gets mangled. Get the memory folder from the first line of `node "<launcher>" dir`, then create the file `incoming-park-<session id>.md` in that folder with your file-editing tool (apply_patch). The memory folder is outside the workspace, so Codex's sandbox refuses these writes until the user approves them. If creating the file, or the command below, fails with `EPERM`, "access denied" or a note that the path is outside the writable folders, run the same action again with escalated permissions, so that Codex asks the user to approve it (justification: "jb-memory saves the parked idea in its memory folder"). That retry is safe: a refused write saved nothing, and the version check still applies. Don't change the command, write the file some other way or ask the user to edit Codex's settings. If the user declines, say in one line that nothing was saved. Then run:

   ```text
   node "<launcher>" park --slug=<slug> --from="<memory folder>/incoming-park-<session id>.md"
   ```

   The file is removed when the command exits 0. If the command fails, it stays: fix what the error names and run the command again. Write each command with the full launcher path, not through a variable such as `$j`.

5. **Receipt** in one line: `Parked: parked/<slug>.md`. Then continue with what you were doing.

## Rules

- One idea per park. If the user lists several, offer to park them one at a time.
- Parking doesn't end the session or change the handoff. A parked item goes into the handoff only if it blocks something, and then under Open questions.
- Evidence labels apply to anything stated as fact in the Context section.

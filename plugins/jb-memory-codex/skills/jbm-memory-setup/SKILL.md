---
name: jbm-memory-setup
description: Check that jb-memory works in this Codex environment for the current repo, or troubleshoot it. Use when the user asks to enable, set up, check or troubleshoot jb-memory or the session handoff in this project from Codex.
---

# Memory setup (Codex)

This copy of jb-memory shares Claude Code's memory folder for each repo, under `~/.claude/projects/`, so Codex and Claude Code sessions keep one handoff. A repo is set up from Claude Code (its jb-memory:memory-setup skill), which finds that folder by Claude Code's own rules. This skill checks that Codex can use it. Nothing is written inside the repo.

Every command here runs jb-memory through its launcher, written below as `<launcher>`: the full path that the `[jb-memory]` note at the start of this session gives after "Launcher:". If there is no such note, it is `scripts/jbm.js` two folders up from this SKILL.md (this file is `<plugin folder>/skills/jbm-memory-setup/SKILL.md`). Use that one path, in full, in every command. If it doesn't work, stop and tell the user which command failed and what it printed. Don't look for jbm.js or memory.js anywhere else, and don't run another copy.

## Steps

1. **Preflight.**

   ```text
   node --version
   git --version
   node "<launcher>" --sandbox-check
   ```

   Every hook runs `node`, so without it the hooks fail silently. The sandbox check proves Node's permission model works here. If it prints SANDBOX CHECK FAILED or SANDBOX UNAVAILABLE, report the output and stop. A WARN line about the Node version means Node should be updated.

2. **Find the memory folder.**

   ```text
   node "<launcher>" dir
   node "<launcher>" status
   ```

   - Set up (status says so): show the folder and the handoff's age, and go on.
   - Not set up, or `resolved by` is `formula-unverified`: tell the user to set the repo up from Claude Code (jb-memory:memory-setup there), then run this check again. Don't run `init` from here: a folder Codex guesses may not be the one Claude Code uses, and the two would then keep separate handoffs.

3. **Check that Codex can write there.** Commands Codex runs in its sandbox can write only in the workspace and in configured writable roots. Run `node "<launcher>" note '<one line: Codex setup check>'`. If Codex asks for approval, that is the expected default: each write to the memory folder is approved. The README's step 3 says how to skip the prompts, and what that costs; leave that choice to the user.

4. **Prove the hooks run.** Ask the user to start a new chat in this repo. The first reply should be able to quote the `[jb-memory]` note (launcher and session ID) and the handoff. If it can't:
   - Codex runs a plugin's hooks only after they are reviewed and trusted. Ask the user to check the plugin's hooks in the app (or `/hooks` in the Codex CLI) and trust them.
   - Check that `node` resolves in a new PowerShell window.
   - The plugin's data folder holds `payload-shapes.log`, one line per hook run. No line means the hooks didn't start.

5. **Report** in three lines: folder, hooks seen or not, and what's left to check.

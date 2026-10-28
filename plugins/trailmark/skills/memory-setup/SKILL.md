---
name: memory-setup
description: Set up Trailmark for the current repo, which is opt-in per repo, or check that its hooks work. Use on /memory-setup, or when the user asks to enable, set up, check or troubleshoot Trailmark or the session handoff in this project.
---

# Memory setup

Trailmark is installed once at user scope, but it touches only repos that have been set up. Setup writes a marker and a handoff skeleton into Claude Code's own auto-memory folder for this repo, under `~/.claude/projects/`. Nothing is written inside the repo.

Every command here runs Trailmark from the path shown, `${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js`. If the trailmark.js path itself doesn't work (it still has a placeholder in braces in it, or node says it can't find trailmark.js), stop and tell the user which command failed and what it printed. A session started before Trailmark was updated can hold a path that is gone; suggest resuming or restarting the session. Don't look for trailmark.js or memory.js anywhere else, and don't run another copy: one found by searching, such as an older one left in Claude Code's plugin cache, can write without the version check and can overwrite another session's checkpoint.

## Steps

1. **Preflight.**

   ```bash
   node --version; git --version
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" --sandbox-check
   ```

   A current Node LTS must be on PATH. Every hook runs `node`, so without it the hooks fail silently and setup is pointless. If it's missing, tell the user to install the Node.js LTS and check that `node --version` works in a new terminal, then stop.

   The sandbox check proves Node's permission model works on this machine: writes inside the memory folder succeed, and writes elsewhere, look-alike folder names and child processes are refused. If it prints SANDBOX CHECK FAILED or SANDBOX UNAVAILABLE, report the output and continue only if the user agrees to run without the sandbox: `JBMEM_SANDBOX=off` in the `env` block of `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows), which the user sets by hand. `"sandbox": false` in `.jbmem.json` no longer turns it off. A WARN line saying the Node running Trailmark is inside the session's folder or repo means a node program in that folder ran instead of the installed Node: stop and show the user the line.

2. **Find the memory folder.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" dir
   ```

   Show the path, the `resolved by` method and the `sandbox` line. If the method is `formula-unverified`, the folder couldn't be confirmed. Ask the user to run `/memory`, choose the option that opens the auto memory folder, and compare the paths. Continue only once they match, and use `init --force` in step 5.

3. **Public or private?** If `gh` is available, run `gh repo view --json visibility -q .visibility`. Otherwise ask. A public repo turns on the publish checks in memory-prune.

4. **Show the plan and wait.**

   ```text
   Set up trailmark for <repo>?
     Folder: <memory dir>
     Creates: .jbmem.json, handoff.md, archive/, parked/, notes/
     Repo files touched: none
   Proceed? (yes/skip)
   ```

5. **Initialize and measure.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" init [--public]
   node "${CLAUDE_PLUGIN_ROOT}/scripts/trailmark.js" budget
   ```

   If MEMORY.md already shows WARN or OVER, mention the trailmark:memory-prune skill.

6. **Prove the hook fires.** Ask the user to start a new session in this repo, or run `/clear`, and look for a status line starting `[trailmark]`. Seeing it confirms the SessionStart hook runs on that surface. Check the terminal and the desktop app separately, since a working terminal says nothing about the desktop app. If the line doesn't appear:
   - Check that `node` resolves in a new terminal.
   - Check that the plugin is enabled (`/plugin`, Installed tab).
   - Run `claude --debug` and look for the hook's output.

7. **Report** in three lines: folder, public/private, and what's left to check.

## Turning it off for a repo

Delete `.jbmem.json` from the memory folder, with the user's ok. The hooks go silent again and the files stay where they are.

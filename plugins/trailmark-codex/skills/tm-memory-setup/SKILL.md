---
name: tm-memory-setup
description: Check that Trailmark works in this Codex environment for the current repo, or troubleshoot it. Use when the user asks to enable, set up, check or troubleshoot Trailmark or the session handoff in this project from Codex.
---

# Memory setup (Codex)

This copy of Trailmark shares Claude Code's memory folder for each repo, under `~/.claude/projects/`, so Codex and Claude Code sessions keep one handoff. A repo is normally set up from Claude Code (its trailmark:memory-setup skill), which finds that folder by Claude Code's own rules. A repo used only from Codex is set up by the user by hand, with the commands in step 2. This skill checks that Codex can use the folder. Nothing is written inside the repo.

Every command here runs Trailmark through its launcher, written below as `<launcher>`: the full path that the session-start note, which starts `[trailmark] ChatGPT/Codex copy of trailmark.`, gives after "Launcher:". If this session has a note that starts `[trailmark] ChatGPT/Codex copy of trailmark.` but gives no "Launcher:", trailmark left its own path out on purpose, since it holds characters trailmark doesn't pass on or is too long: stop and tell the user what the note says, and don't work the path out yourself. Only when this session has no such note at all (the repo isn't set up yet, or Codex hasn't run trailmark's hooks, say) is the launcher `scripts/trailmark.js` two folders up from this SKILL.md (this file is `<plugin folder>/skills/tm-memory-setup/SKILL.md`), and only when that path holds none of these: a double quote, `$`, a backtick, `%`, `!`, a curly double quote (U+201C to U+201E), two backslashes in a row, two spaces in a row, a space at either end, a space other than a plain one, or a control or invisible character. If it holds one, or is over 1,024 characters, don't run it: tell the user to install trailmark in a folder with a plain path. Other lines that start `[trailmark]`, such as a command's output or a note about a commit, don't count as that note. But if one of them says trailmark's path isn't written here, stop and tell the user what it says, and don't work the path out yourself. Use that one path, in full, in every command. If it doesn't work, stop and tell the user which command failed and what it printed. Don't look for trailmark.js or memory.js anywhere else, and don't run another copy.

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
   - Not set up, or `resolved by` is `formula-unverified`: ask the user whether they also use Claude Code in this repo.
     - If they do, or might: tell them to set the repo up from Claude Code (trailmark:memory-setup there), then run this check again. A folder Codex guesses may not be the one Claude Code uses, and the two would then keep separate handoffs.
     - If they use only Codex here: show them these commands to run themselves, in a terminal outside Codex, with `<repo>` the repo's top folder and `<launcher>` the full launcher path, both inside the single quotes shown, where a shell expands nothing. If either path contains a single quote (`'`, or a typographic curly one), don't show the commands: ask the user to rename that folder first. Add `--public` to the init line if the repo is public. Then stop; once they have run them, they start a new chat and run this check again.

       Windows PowerShell:

       ```text
       Set-Location -LiteralPath '<repo>'
       $env:JBMEM_CODEX_INIT = '1'
       node '<launcher>' init --force
       Remove-Item Env:\JBMEM_CODEX_INIT
       ```

       macOS or Linux:

       ```text
       cd '<repo>' && JBMEM_CODEX_INIT=1 node '<launcher>' init --force
       ```

       The variable is set for that one command only. Never set it yourself, run `init` yourself or suggest making the variable permanent: it is what keeps a Codex session from setting up a repo on its own. `--force` is needed because, with no Claude Code session ever in the repo, the folder comes from Claude Code's naming formula and can't be confirmed; Claude Code uses the same formula, so it would find the same folder later.

3. **Check that Codex can write there.** Commands Codex runs in its sandbox can write only in the workspace and in configured writable roots. Run `node "<launcher>" note '<one line: Codex setup check>'`. The memory folder is outside the workspace, so the sandbox refuses this write until the user approves it. If the command fails with `EPERM`, "access denied" or a note that the path is outside the writable folders, run the same command again with escalated permissions, so that Codex asks the user to approve it (justification: "Trailmark test note in its memory folder"). That approval on each write is the expected default, and the check passes once the note is saved. Stop only if the user declines. The README's step 3 says how to skip the prompts with a writable root, and what that costs; mention it only if the user asks, and leave the choice to them.

4. **Prove the hooks run.** Ask the user to start a new chat in this repo. The first reply should be able to quote the session-start note, which starts `[trailmark] ChatGPT/Codex copy of trailmark.`, and the handoff. The note gives the launcher and the session ID. If it says trailmark's path isn't written here instead of giving the launcher, the hooks did run: tell the user what the note says. If the first reply can't quote the note:
   - Codex runs a plugin's hooks only after they are reviewed and trusted. Ask the user to check the plugin's hooks in the app (or `/hooks` in the Codex CLI) and trust them.
   - Check that `node` resolves in a new PowerShell window.
   - The plugin's data folder holds `payload-shapes.log`, one line per hook run. No line means the hooks didn't start.

5. **Report** in three lines: folder, hooks seen or not, and what's left to check. Speak in Codex terms: name Claude Code only when the user said they use it in this repo, or to explain why the memory folder is under `~/.claude`.

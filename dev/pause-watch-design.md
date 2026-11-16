# Pause watch: a checkpoint before a reboot (design note)

Written 2026-11-15 on branch `claude/upbeat-bouman-62d581`, from origin/main 79d0715. New scope, not a deferred item: a push or PR is asked of the user.

## The problem

On 2026-11-15 the user wrote "pause for reboot" in a Trailmark-enabled session, and that session did not checkpoint on its own (as relayed by the coordinating session, not seen here). After the reboot, SessionStart injected the handoff with its "Resumed session" notice, so resume works. The save before it depends on Claude choosing to run the checkpoint skill, and nothing in Trailmark asks for it at that moment: the milestone hints fire after commits, merges and subagents, and the context watch only near auto-compaction.

## Goal

When the user's prompt says they are about to reboot, restart, shut down or close the session, the UserPromptSubmit hook adds a note asking Claude to run `trailmark:checkpoint` before the turn ends. Checkable result: a set-up repo, the launcher run with `--hook pause-watch` and a payload whose prompt is "pause for reboot", prints a `hookSpecificOutput.additionalContext` that names the checkpoint skill; with "restart the server" it prints nothing.

Must not change: the context watch (its own hook entry and fast path stay as they are), every other hook, what the sandboxed scripts are handed (`hookInput` drops the prompt; that stays), and the Codex copy.

## Decisions

### A hook of its own

A second UserPromptSubmit entry in `hooks.json`, `trailmark.js --hook pause-watch`, not a branch inside the context watch. The context watch's fast path exits below 80% of the compaction point before it loads anything, and the pause check must run at any size; folding them together would change a path that took nine review rounds to settle. Claude Code runs the hooks of one event in parallel, so the second entry adds a process per prompt, not time in series.

### Where the prompt is read

The prompt is untrusted text of any size. The launcher reads it (it already reads the whole payload), and only the launcher: `hookInput` keeps the prompt out of what the sandboxed script gets, and that does not change. The match runs first thing, in a new `lib/pausewords.js`, before the launcher loads the rest of its code (like `contextwatch.fastPath`): no match, and it exits 0 with no git and no memory-folder lookup. On a match, the launcher finds the memory folder (`hookMemory`, as every hook does) and starts `hook-pause-watch.js` under the sandbox with one fact, `{ pause: { word } }`, where `word` is one of a fixed list of canonical words. No text of the prompt goes further: not to the script, not into the note, not to the user's message.

### The matcher

English only. Other languages would each need their own word lists and their own false hits; a user can say it in English or run `/trailmark:checkpoint`. Rules, in order:

1. Only a prompt of at most 2,000 characters is read at all. A statement that one is about to reboot is short; a long prompt that mentions a restart is usually a task, a log or a paste. A long prompt that ends with "then I'll reboot" is missed; that is the stated margin.
2. Text between backticks is dropped (split on the backtick, keep the even parts), so code and pasted commands don't count. Lines that start with `>` (a quote) are dropped.
3. The rest is lower-cased (curly apostrophes become straight), cut into clauses at sentence punctuation, commas, line breaks and brackets, and further at the words `and`, `then`, `so`, `but`, `also`, `plus`. Words are runs of `a-z` and `0-9`, with one apostrophe part (`i'm`, `let's`).
4. Two-word forms are joined first: `shut down`, `power off`/`down`, `log off`/`out`, `sign off`/`out`, `turn off` and their `-ing` forms.
5. A clause matches when it has a trigger word and every other word is on an allowed list, and it has at most 16 words. Triggers: `reboot`, `restart` (with `-s` and `-ing`), the joined forms above, and `close`, `quit`, `exit`, `end` (with `-ing`), the last four only with a session word in the same clause (`session`, `chat`, `conversation`, `claude`, `codex`, `terminal`, `window`, `ide`, `editor`, `vscode`). The allowed list holds pronouns and helpers (`i'm`, `going`, `to`, `about`, `need`, `gonna`, `let's`), time words (`now`, `soon`, `quick`, `in`, `minutes`, `night`, `day`, `brb`, `back`, and a number of one to three digits, as in "rebooting in 5 minutes"), filler (`ok`, `thanks`, `heads`, `up`), the machine and session (`my`, `the`, `pc`, `computer`, `laptop`, `machine`, `windows`, `mac`, `session`, `claude`, `code`) and the usual reasons (`for`, `update`, `updates`, `install`, `apply`, `changes`, `plugin`, `settings`).

What that gives, by design: "pause for reboot", "rebooting now", "about to restart my pc", "brb, quick reboot", "I need to restart Claude Code to load the plugin", "shutting down for the night" and "closing this session" match. "restart the server", "reboot the router", "can you restart the dev server", "don't reboot", "after the reboot, check the build", "I rebooted, carry on", "should I restart?" and "restart the app" don't: `server`, `router`, `dev`, `don't`, `after`, `rebooted` (a past form is no trigger), `should` and `app` are not on the allowed list. A negation needs no rule of its own: none of `not`, `don't`, `no`, `never`, `without` is allowed. `app`, `server`, `it` are left out on purpose: in a coding session "restart the app" or "restart it" is usually the project's own program.

The list will miss phrasings, and a miss costs what it costs today (Claude may still checkpoint on its own). A false hit costs one note, and the note asks Claude to judge, so the lists lean to matching less.

### The note

`hookSpecificOutput.additionalContext`, event `UserPromptSubmit`:

> [trailmark] The user's prompt may say they are about to reboot, restart, shut down or close this session (it has the word "reboot"). If it does, run the trailmark:checkpoint skill before this turn ends, after any short step they asked for first, so the handoff holds this session's state when the next session starts. If the word is about something else, such as restarting a server or starting a task over, ignore this note. (SKILL_RULE)

Claude is the last judge: the word list only decides whether to ask. The note quotes only the canonical word, from a fixed list. A `systemMessage` tells the user, as the context watch does: `[trailmark] Your prompt mentions a reboot: asked Claude to checkpoint first, if that is what you meant.`

### When it stays silent

- The repo is not set up (no memory folder): as every hook.
- A subagent's prompt (`agent_id` or `agent_type` in the payload): as the context watch.
- `"pauseWatch": {"on": false}` in `.jbmem.json`.
- This session wrote the handoff within `hints.freshCheckpointMinutes` (3 by default): the save is already there. The reminder throttle `hints.minMinutesBetween` does not apply: like the context watch, this is the last chance.

The script writes nothing (no state): a second "rebooting now" asks again, unless the handoff was written in the last few minutes.

### Codex

Codex's hooks page (developers.openai.com/codex/hooks, which redirects to learn.chatgpt.com/docs/hooks; read 2026-11-15 through a fetch agent, the event table verbatim and the field names from the fetch tool's summary of the rest) lists `UserPromptSubmit`, with the prompt in a `prompt` field and `hookSpecificOutput.additionalContext` or plain stdout added as developer context. So a Codex copy looks possible. It is not built here: the user has not yet seen the Codex copy's hooks run (handoff, next action 1), the field names come from a summary, not a quote, and the Codex copy's launcher is a file of its own. `docs/how-it-works.md` says Codex's "hooks have no prompt event"; that sentence looks stale (INFERRED from the page above) and goes to the deferred list as RS-D-codexprompt.

## Security

The prompt is untrusted (security row of `CLAUDE.md`'s review table, launcher change). What protects:

- The match is a fixed set of string compares over a bounded text (2,000 characters), with regexes that are single character classes or `[a-z0-9]+(?:'[a-z]+)?`: linear, no nested quantifiers.
- Nothing of the prompt leaves the launcher but one word from a fixed list, checked again in the sandboxed script against the same list.
- The payload the script gets is still `hookInput`'s, without the prompt.
- No new file is read and nothing new is written.

## Docs to change

`hooks.json` description, MANUAL.md section 5 (the hooks table, and a paragraph next to the context watch's) and section 7 (a `pauseWatch.on` row), `docs/how-it-works.md` (the hook table and a paragraph), `SECURITY.md` (a row for the prompt text), and `SHA256SUMS`. No CHANGELOG line until the release step (as for the deferred items).

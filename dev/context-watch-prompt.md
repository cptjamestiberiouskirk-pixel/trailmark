Add a new Trailmark hook, `context-watch`, that asks Claude to run trailmark:checkpoint before Claude Code's auto-compaction, so that a session's state is in handoff.md before the compaction summarizes it. Trailmark has no hook that watches context size today: the PreCompact snapshot runs too late to save decisions, and the milestone hints fire only on commits, PR merges and subagent results.

Follow this repo's CLAUDE.md, and read dev/release-state.md first.

## Where Trailmark stands (checked 2026-11-04, 14:34 to 14:38 UTC)

- v0.5.0 is published (2026-11-02). 0.5.1 is merged into main: PR 1, merge commit 71133ca, 2026-11-04 14:36 UTC. Its release commit is e26f148 and its zip is built, but it is not published yet (the latest release was still v0.5.0). Publishing it (steps 6 and 7 of the 0.5.1 checklist in dev/release-state.md) is mine to do.
- 0.5.1 changed the files this work touches (`scripts/trailmark.js`, `lib/store.js`, `lib/paths.js`, `hook-milestone.js`, in both plugin copies). Start a new branch from origin/main at 71133ca or later: the local main checkout was 26 commits behind origin/main when this was written. Leave the 0.5.1 release commit and zip alone.
- This is a new feature, so I expect 0.6.0. dev/release-state.md also has a deferred list for 0.5.2: ask me whether that ships first, or with this.

## A working prototype to port

`C:\Users\willi\.claude\hooks\trailmark-context-watch.js` is a user-level prototype that I run from `~/.claude/settings.json` on PostToolUse (all tools) and UserPromptSubmit. Read it before designing. Its transcript parsing and window lookup are tested, but its steps are percentages of the window, and the facts below show that this is the wrong basis (requirement 5 replaces it). Because it sits outside the plugin, it skips the sandbox, keeps its state in the temp folder, and loads `findMemoryDir` and `isEnabled` from the installed Trailmark. The plugin version must do these the Trailmark way (requirements 3 and 4). My auto-compact window is 400k (`autoCompactWindow` in `~/.claude/settings.json`). `C:\Users\willi\tools\trailmark` is the installed release copy, not a checkout: do not edit it.

## Facts from 2026-11-04 (starflight-unity-port, Claude Code desktop, Windows)

- CONFIRMED: each main-thread assistant entry in the session transcript (JSONL) has `message.usage`. That request's context size is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`. Skip entries with `isSidechain: true`, and entries whose `message.model` is `<synthetic>`. Quotes inside JSON strings are escaped, so the substring `"type":"assistant"` matches only real entries.
- CONFIRMED: reading the last 1 MB of a 200 MB transcript back to the last assistant entry takes 80 to 150 ms per run, Node startup included. The prototype reads up to 32 MB when the last entries are huge.
- CONFIRMED: hook calls for a subagent's tool calls carry `agent_id` and `agent_type`, with the main session's `session_id` and `transcript_path`. Skip them. A UserPromptSubmit also fires when a subagent hands its result back.
- CONFIRMED: the window comes from settings. `autoCompactWindow` is the top-level value (100000 to 1000000). `modelSettings.<model>.autoCompactWindow` (a number or "auto") replaces it for that model within the same file; `/autocompact N` writes this one. Files load in order: user, then project `.claude/settings.json`, then `.claude/settings.local.json`, and a later file wins. Settings keys match a model ID without its date or `[1m]`.
- CONFIRMED (strings in the Claude Code 2.1.317 binary): settings are not the only source. The environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` also sets the window and takes "200k" or "200000". The binary labels a window's source as "from CLAUDE_CODE_AUTO_COMPACT_WINDOW", "from settings", "default for this model" or "default for an unrecognized model", so the default depends on the model and is not one fixed number. A variable `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` also exists (INFERRED from its name: it moves the compaction point). The prototype reads neither. The order between the variable and the settings is compiled and not visible (HYPOTHESIZED: the variable wins); check the docs.
- CONFIRMED: the prototype's first real reminder came in a live session at 341k of 400k (14:35 UTC). The checkpoint was written at 14:39, and the session auto-compacted at 14:42.
- CONFIRMED: Claude Code compacts a fixed amount below the window, not at a share of it. Each compaction leaves a system entry with `"subtype":"compact_boundary"` in the transcript, and its `compactMetadata.preTokens` is the context size at that moment. That session's entries: 366,627 and 367,295 with the 400k window, and 966,985, 967,791 and 968,163 in October with a 1M window (INFERRED: the entries do not record the window). Both put the compaction point about 33k below the window.
- HYPOTHESIZED: the 33k is Claude Code's output reserve (20k) plus a 13k buffer, so it may change between Claude Code versions. Check the docs, or measure it again with `preTokens`. Also find out whether a model whose context is smaller than `autoCompactWindow` caps the window.
- So the prototype's steps (85%, 90% and 95% of the window) are wrong. At 400k its 95% step (380k) never fires and its 90% step (360k) leaves about 7k tokens. With a 200k window the compaction would come near 167k, before even its 85% step (170k).

## Requirements

1. Register `context-watch` in the `HOOKS` table of `scripts/trailmark.js` and in `hooks/hooks.json`: PostToolUse with no matcher, and UserPromptSubmit. Update the hooks.json description, which lists what every hook does.
2. Speed: this runs after every tool call. The launcher works out the context size and exits below the first step BEFORE `hookMemory` or anything else that may start git or walk folders. Measure a below-threshold run and report it.
3. Sandbox: a worktree session's transcript is in a different projects folder from the repo's memory folder, so the sandboxed script cannot read it. Read the transcript in the launcher (read-only, outside the sandbox) and pass the numbers on, as the launcher passes git facts. The sandbox keeps its reads and writes (plugin root and memory folder). Accept `transcript_path` only as a file directly in a folder of Claude Code's projects folder, as `paths.js` does in its transcript step. Treat everything read from the transcript as data.
4. State: this session's record in `.jbmem-state.json`, through `S.updateState` under the lock, not the temp folder. Keep the step already asked, when it first asked, and the last context size seen. A checkpoint counts once this session's `rec.lastWrite` is later than the first request (the milestone hints already use `rec.lastWrite`). Do not parse the handoff header as the prototype does.
5. Steps: measure them against the compaction point (the window minus a reserve, 33,000 by default), never against the window itself. Ask at the first step, again at the next ones only while this session has not written the handoff since the first request. Start over when the context shrinks by 20% or more from the last size seen (a compaction or /clear), or falls below 75% of the compaction point. Between 75% and the first step keep the state, so a large tool result that lifts the estimate over a step and drops back does not cause a second request. Add `tool_response` (PostToolUse) or `prompt` (UserPromptSubmit) at about 4 characters a token, since the last usage entry predates them.
6. Stay silent in subagents, in repos that are not set up (the same `hookMemory` lookup as the other hooks, with the session-home fallback), and when the transcript has no usable entry.
7. Output: `hookSpecificOutput.additionalContext` built with `S.CHECKPOINT_SKILL` and `S.SKILL_RULE`, like the milestone hint, plus a short `systemMessage` for the user. Give the size and the compaction point, and ask for the checkpoint now. Say that a step about to finish may finish first, but no long operation should start before the checkpoint. Decide whether this reminder ignores `hints.minMinutesBetween` (I think it should: it is the last chance before the compaction) and whether it sets `lastHintAt` so milestone hints don't pile on. Say what you chose.
8. Config in `.jbmem.json` through `CONFIG_RANGES`, clamped like the other numbers: the step percentages (85, 90 and 95 by default, now of the compaction point), the reserve below the window (33,000), the window to assume when neither settings nor `CLAUDE_CODE_AUTO_COMPACT_WINDOW` give a number (the prototype uses 200k; a per-model default is better if the docs give one), and an off switch. Honor `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` if the docs confirm what it does.
9. Codex (`plugins/trailmark-codex`): find out whether Codex's session files record token usage and where its compaction limit is set. Port the hook if that is straightforward. Otherwise ship it for Claude Code only and say so in the README and CHANGELOG. Files in the `for f in` list of `.github/workflows/tests.yml` must stay identical in both copies; decide whether the new hook script joins that list. Check that trailmark-watchdog does none of this already.

## Tests (node:test, plugins/trailmark/tests/trailmark.test.js)

Use a temporary CLAUDE_CONFIG_DIR and fake transcripts, and cover at least the prototype's cases:
1. Below 85%: silent.
2. Crossing 85%: asks.
3. The same step again: silent.
4. Crossing 90% with no checkpoint since: asks again, and says so.
5. Crossing 95% after this session wrote the handoff: silent.
6. Still high after that checkpoint: silent.
7. The context shrinks (a compaction): starts over.
8. Crossing 85% again: asks.
9. Repo not set up: silent.
10. A subagent payload: silent.
11. Trailmark turned off: silent.
12. A model whose entry is "auto": uses the fallback window.
13. A dated model ID: finds its settings entry.
14. Other events: silent.

Then add:
- Every step fires below the compaction point: at 400k all three come before 367k, and at a 200k window all three come before 167k.
- A sandbox case: a transcript outside the memory folder, with the sandbox on.
- A `transcript_path` outside the projects folder: refused.

Check with `dev/release-check.sh`, as CLAUDE.md describes.

## Finishing

- Reviews as CLAUDE.md's table says, scoped to this diff: Opus for design and regression, Fable for the `store.js` changes and the launcher's transcript reading, Sonnet for the docs. Reproduce each finding before acting on it.
- Docs: README.md, MANUAL.md (code and docs cite its sections by number, so do not renumber), docs/how-it-works.md, SECURITY.md if the launcher now reads a new kind of file, CHANGELOG.md, the version in the manifests, and SHA256SUMS through `dev/release-check.sh --sums`.
- Commits as CLAUDE.md says (author, no AI attribution). Ask me before pushing, opening the PR or tagging.
- Update dev/release-state.md for the next session.
- When done, remind me that once the new version is installed I must remove the prototype: the `hooks` block that runs trailmark-context-watch.js in `~/.claude/settings.json`, and the script. Otherwise every reminder comes twice. Do not edit my user settings yourself.

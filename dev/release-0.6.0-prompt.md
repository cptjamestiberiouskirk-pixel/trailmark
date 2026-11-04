Read CLAUDE.md and dev/release-state.md first. Plan and build the next release, 0.6.0, on one branch from the latest origin/main.

Scope:
1. The context-watch hook, as dev/context-watch-prompt.md describes. Its question about the 0.5.2 list is answered: that list ships with this, in 0.6.0.
2. Every open item under "Deferred to 0.5.2" and "Deferred to 0.5.1" in dev/release-state.md. Skip the items marked Fixed, and leave "Decided not to fix" alone. Before any code, list these items with their evidence labels and ask me to confirm the list.

Once I have confirmed it, add a "0.6.0 (in progress)" section to dev/release-state.md. List the scope items with their status, and add a release checklist modelled on 0.5.1's: version bumps (three manifests, MANUAL.md), CHANGELOG, reviews by the model table, dev/release-check.sh, the zip, then publishing. Work through the items one at a time, each with a test that fails on the old code, and update that section as each lands.

Ask me before pushing, opening the PR, merging, tagging or publishing. When the release is installed, remind me to remove the prototype (the hooks block in ~/.claude/settings.json and ~/.claude/hooks/trailmark-context-watch.js).

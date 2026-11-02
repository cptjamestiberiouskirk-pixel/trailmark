# Release state

Last updated 2026-11-02.

## 0.5.0

- Release commit: see the newest commit on `main` that `dev/release-check.sh --zip` was run on; the zip and its `.sha256` were copied to `D:\UserFiles\Downloads`, with the release notes as `trailmark-0.5.0-release-notes.md`.
- Review rounds 1 to 13 are done. The last round's follow-up review found nothing blocking. CI was green on all 9 jobs.

### Still to do by hand

1. Check the zip hash, then publish (from Downloads):

   ```powershell
   gh release create v0.5.0 trailmark-0.5.0.zip trailmark-0.5.0.zip.sha256 --repo cptjamestiberiouskirk-pixel/trailmark --target <release commit> --title "Trailmark 0.5.0" --notes-file trailmark-0.5.0-release-notes.md
   gh repo edit cptjamestiberiouskirk-pixel/trailmark --visibility public --accept-visibility-change-consequences
   gh api -X PUT repos/cptjamestiberiouskirk-pixel/trailmark/private-vulnerability-reporting
   ```

2. Update the installed copy: `Expand-Archive -LiteralPath D:\UserFiles\Downloads\trailmark-0.5.0.zip -DestinationPath C:\Users\willi\tools -Force`, then `install.ps1 -Check`, then the watchdog's `-Status` and `-Accept` (MANUAL.md, section 10), `/reload-plugins` in Claude Code, and Upgrade trailmark-codex in the ChatGPT app.
3. Submit to the plugin directory: https://claude.ai/directory/manage (Submit new, Plugin bundle). Checklist: https://claude.com/docs/plugins/pre-submission-checklist.md
4. Delete `C:\Users\willi\Documents\claude-plugins\tm-sandbox-test` (old build and sandbox scripts) and the leftovers of an early test run, after checking their contents: `C:\tmtest`, `C:\tmcfg`, `C:\fx`, `C:\shareroot`, `C:\tm`, and `%TEMP%\h1.txt`, `h2.txt`, `a b`.

### Not confirmed

- INFERRED: Git for Windows takes `..` in relative includes and pointers as text from a `.git` that is a junction, so the check (which starts where the junction leads) and git could read different files. Trailmark now keeps git out of such a repo on Windows, and a Windows CI test confirms that refusal. Confirming git's side needs a Windows PC: `mklink /J .git D:\elsewhere\gitdir`, add `[include] path = ../x` to that gitdir's config, put a config file at `<top>\x`, and watch which `x` git opens with Process Monitor while running `git config --list --show-origin`.

## Deferred to 0.5.1

Found in review, fail closed or harmless, left for the next version:

- A worktree `gitdir` file with trailing spaces keeps git out with the reason `network-gitdir`, which misleads (git trims it; git never writes one).
- A branch or file name inside `.git` that isn't valid UTF-8 keeps git out (`odd-path`), though git handles it.
- A leftover folder under `.git/modules` with no `HEAD` has its loose objects walked; a very large one gives `many-entries`.
- A pending commit-start record written by trailmark-codex 0.4.5 has no `host` field and can be released early, within 11 minutes of upgrading.
- A background commit's hook note is rarely printed, since the hook usually runs before the commit exists.
- The two test files don't remove their temp folders (about 150 MB a full run).
- `tools/windows` scripts and installers: no review findings open.

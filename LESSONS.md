# LESSONS

A dated log, newest first. For development only: `export-ignore` in `.gitattributes` keeps it out of the release zip and out of `SHA256SUMS`.

Add an entry each time something breaks, needs a redo or retry, surprises you, or the user corrects you. A lesson seen a second time, or clearly general, moves into `PLAYBOOK.md` as a checklist step and is marked "promoted to PLAYBOOK".

Format:

```
## YYYY-MM-DD: short title
- What went wrong:
- Why:
- Rule going forward:
- Status: open | promoted to PLAYBOOK
```

## 2026-11-13: A script that reads a test run's lines got none
- What went wrong: a scratch script for RS-A-redirect ran `node --test` on the parent's code and printed why each test fails, by reading lines that start with "not ok". It printed nothing: this Node (26) writes another report unless it is told to write TAP. The first run looked like "no test failed".
- Why: the script took the report's form for granted, and an empty result read the same as a pass.
- Rule going forward: a script that reads a test run passes `--test-reporter=tap`, and prints the run's pass and fail counts whatever else it finds, so that nothing found is told apart from nothing run.
- Status: open

## 2026-11-13: A check in the background ended with no result line
- What went wrong: the quick check for RS-A-filtername round 4 was started in the background by one command that also started the load sampler with `&` and wrote the check's output to a file renamed at the end. The app reported the command done within minutes while the check still ran, and 17 minutes after its start the check was gone, with `SHA256SUMS` rewritten and no result line anywhere.
- Why: not known. The check may have stopped with the shell that started it (HYPOTHESIZED). The run that passed the next morning was started as a command of its own, with the sampler as a second one.
- Rule going forward: a check in the background is one command that starts nothing else, and its output goes straight to the file the wait reads. A run without its "exit" line is untested, whatever it rewrote before it ended.
- Status: open

## 2026-11-12: The numbered keys were held for the first number only
- What went wrong: batch 3 answered "the assertion had two of the family's members" by adding `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0`, under a comment that says "a count with its numbered keys and values". Round 4 (Opus) widened `DROP_ENV` by the keys and values from 1 up and both tests passed. With that pattern git fails for a count of 2 ("missing config key GIT_CONFIG_KEY_1", exit 128, seen here with raw git).
- Why: the family has a number in its names, so it has no last member, and one member was written where the rule asks for each. The mutation list had the pattern `\d+` only, which the one case catches.
- Rule going forward: a family whose names carry a number is a loop over a stated range (here 0 to 100, so one, two and three digits). The comment gives the range and says that numbers above it are not told. The mutation list changes the pattern from the second member up and at each digit count. This is "A comment in a new assertion named a family, and the assertion had two of its members" again.
- Status: promoted (PLAYBOOK "Testing" step 8, one sentence added)

## 2026-11-12: A sentence added for clarity read as an exception to the wrong rule
- What went wrong: round 3's docs review said "keeps running (unless ...)" could be read as "the filter stops". The answer in batch 3 was a new sentence, "The exception is a filter named ...", put right after the sentence on filters from the user's own config. Round 4's docs review marked it wrong: there it reads as an exception to that case only, and the code skips `git status` for such a filter whichever config defines it, the repo's own included.
- Why: the sentence was written to fix the clause it replaced and was not read against the first sentence of its paragraph, which states the rule for the repo's own config.
- Rule going forward: a sentence that states an exception names what it is an exception to, and is read against every rule in its paragraph before it goes in. A clarity fix gets the same check against the code as a new claim.
- Status: open

## 2026-11-12: A class of variables was listed from git's pages, and the Windows build has three more
- What went wrong: for RS-A-filtername round 2 the variables that could make the checks and `git status` see different things were listed from git's pages and from memory, ten were tried, and the notes said only `GIT_CONFIG` splits the two. Round 3 (Fable) found `GIT_REDIRECT_STDIN` and `GIT_REDIRECT_STDERR`, which Git for Windows adds: with either in the session's environment a repo's filter ran (reproduced here, deferred as RS-A-redirect).
- Why: the list came from what is written about the program and not from the program. The three names are stored in `git.exe` as 16-bit text, so even a search of the file for plain text misses them.
- Rule going forward: a class of names a program reads (environment variables, config keys) is listed from the installed program itself, in plain and in 16-bit text, on each system it runs on, and the notes say which of the names were gone through and which were not.
- Status: open

## 2026-11-12: A comment in a new assertion named a family, and the assertion had two of its members
- What went wrong: the assertion on what `gitEnv` keeps said in its comment that the variables that add settings stay, and tried `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS`. The numbered `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` that go with the count were not in it, and a pattern that drops them passed both tests (Opus, round 3).
- Why: the members were written from the names remembered, the same day a lesson was logged about a test's comment naming a class.
- Rule going forward: this is "A test's comment named a class, and its cases tried one member" (2026-11-12) a second time. When a comment names a family, the members are taken from where the program lists them (its page, or the names found in the program), and the mutation list widens the pattern by each member left out.
- Status: promoted (PLAYBOOK "Testing" step 8, one sentence added)

## 2026-11-12: A commit script's expected line count was read while a mutation run had the file changed
- What went wrong: the commit script for RS-A-filtername round 2 checks that `gitbin.js` differs from HEAD by a known number of lines. The number (5 and 1) was read with `git diff --numstat` while the mutation run was on its first probe, which puts the old pattern line back. The real diff is 6 and 2. The script stopped before the commit, and nothing was committed.
- Why: the mutation run was in the background and the read looked harmless, since it changed nothing.
- Rule going forward: while a mutation run is going, nothing is read from the files it changes, not only nothing written. A number a later check will hold is read after the run printed "restored: true".
- Status: open

## 2026-11-12: A check asked git one way and git acted another, because of a variable in the environment
- What went wrong: round 2 of RS-A-filtername (Fable) found that with `GIT_CONFIG` set in the session's environment, `git config` reads that one file and nothing else, not the repo's config and not `-c`, while `git status` goes by the real configs. Reproduced here in real repos: with a file that holds `trailmark.asked`, the new call's answer counted as whole, a filter named `set` was not seen and ran; with either file an ordinary filter of the repo was not listed, so it was not switched off and ran (this part is older than the PR); with an empty file, 11391c1 read status in no repo at all (`filter-check`).
- Why: `gitEnv` dropped the variables that point git at another repo, and nobody had listed the variables that change what one git command reads and not another. The call's own setting was taken to prove "git answered in full", and it proves that only while `git config` reads the configs `git status` reads.
- Rule going forward: when one command is asked and another then acts on the answer, list what can make the two see different things, the environment first (read each command's page for variables that touch only that command), and drop or refuse each. A marker that proves an answer whole is tried against a source that can supply the marker without the tool having read what it should.
- Status: open

## 2026-11-12: Cases said a marker was absent that they could never have written
- What went wrong: round 1's batch added six cases in real repos and the notes said of them "each `odd-filter-name` with the marker absent". Four could not write the marker whatever the code did (Opus, round 2, CONFIRMED by Opus and read here in the test): the case with only `process` and the one under `[filter.set]` had no marker command, and `smudge` and `required` settings never run during `git status`.
- Why: the cases were made by a helper whose marker command sat in its `clean` form only, and the forced fault was run for the first case and taken to stand for the rest.
- Rule going forward: PLAYBOOK "Testing" step 8 a second time, now per case: each case that says "did not happen" carries the thing that would make it happen, and one that cannot does not say it. The notes say of each case what it asserts, not what the group was meant to.
- Status: promoted (PLAYBOOK "Testing" step 8, one clause added)

## 2026-11-12: The notes said a repo's own copy of the code's marker "changes nothing", and no case tried it
- What went wrong: 11391c1's notes say a repo that writes `trailmark.asked` in its own config "adds a line to the answer and changes nothing". That was read from the code. Round 2 (Fable) changed `continue` to `break` at the line that meets the marker, and both tests passed: with the repo's own `trailmark.asked` ahead of `[filter "set"]`, that change reads status and the filter runs.
- Why: the marker was thought of as the code's own, so no case gave it to the repo.
- Rule going forward: a sentence in the notes of the form "X changes nothing" gets a case that does X and a change in the mutation list at the line that makes it so. A name the code brings (a setting, a file name, a marker) is tried as the input's own, before and after the thing it guards.
- Status: open

## 2026-11-12: Two times in the notes were written from a guess
- What went wrong: the notes of RS-A-filtername round 1 and a handoff gave clock times ("seen 15:10", "not committed at 15:25") that were reckoned from how long the steps had seemed to take. The clock, read later for another reason, said 15:27 where the reckoning had 15:40. The notes were corrected before the commit by reading CI again with the clock; the handoff's time was wrong for one version.
- Why: the commands that read CI and the bot's state printed no time, and the note was written some steps later.
- Rule going forward: a command whose result goes in the notes with a time prints the time itself (`date +%H:%M:%S` in front). A time that was not printed is not written.
- Status: open

## 2026-11-12: A stand-in for git answered whatever it was asked
- What went wrong: the first test of RS-A-filtername asked `filterOverrides` with a stand-in for git that gave back the text of settings a case handed it, whatever the call's arguments were. Round 1 (Opus and Fable) found the test passing with the call narrowed to `clean` settings, with `--no-includes` and with `--local`: a filter named `set` with only a `process` setting, or one in an included file, would have run. The cases "its smudge", "its process" and "its required" held the code that reads the answer and nothing of the call. The real repos all defined the filter with `clean` in `.git/config`.
- Why: the stand-in was written for the code after the call. What the call asks (its pattern, its options) was taken as given, and the real repos were written from the fault's one example.
- Rule going forward: a stand-in for a program checks the question it gets (the arguments, all of them) and answers from the question as the program would. The cases with the real program have one for each way the thing asked about can come to be (here: each word that defines a filter, each place a config can come from). The mutation list changes the question too: its pattern narrowed, an option added.
- Status: promoted (PLAYBOOK "Testing" step 10). Stand-ins that held less than the thing they stood for were logged three times on 2026-11-11 (a clock, a stub that matched other paths, a stand-in stopped at one time only).

## 2026-11-12: A mutation list left out the swap a playbook step asks for
- What went wrong: RS-A-filtername adds a Set of four texts that is asked with a text from a repo. Its first mutation list had the Set without each text and no change of its kind. Round 1 (Opus) passed the test with the Set asked as a plain object, which would take `constructor` for "no filter". PLAYBOOK "Writing code and docs" step 11 asks for that swap and for names every object has, since the morning of the same day.
- Why: the lessons check before the list was run with the words for tests and mutations, and its lines were read for the layers (a change per key at each layer). The step on the kind of a table sits under "Writing code and docs" and was not read again when the list was written.
- Rule going forward: none new. A mutation list for a fix that adds a Map, a Set or an object starts with the swap of its kind, before the changes of its members, and the test has a name every object has.
- Status: open

## 2026-11-12: An exit status that also means a failure was read as an answer
- What went wrong: the new call of RS-A-filtername (`git config --get-regexp`) took exit status 1 for "no such setting". Round 1 (Fable) showed the same status for a git that gives up on the repo's config, and for a git ended from outside on Windows (reproduced here: `execFileSync` reports `status=1`, `signal=null`). Either was read as "no filter so named", the answer that lets status run.
- Why: git's page gives 1 for "nothing matched", and the older call in the same function reads it so. What else ends with 1 was not listed.
- Rule going forward: an answer that lets something run is never read from an exit status alone. The call brings something of its own that a whole answer must hold (here a setting given with `-c` that the pattern asks for), and its absence is a failure. Before an exit status is given a meaning, list what else ends with it (a signal, a kill from outside on Windows, the program giving up early).
- Status: open

## 2026-11-12: A commit went out in the same message as an edit it was meant to hold, and the edit failed
- What went wrong: the notes-only commit of RS-A-filterkey round 4 (358d3c3) was sent in one message with an edit that added the quick check's reading to `dev/release-state.md`. The edit was refused, since the file had changed on disk after it was last read. The commit script ran all the same, and the push went out without that line. Nothing in the commit is untrue, and the reading is recorded with the next item.
- Why: the two calls were sent together to save a step, the edit being one line. PLAYBOOK "Committing" step 1 says a commit goes in a later message than the edits it depends on. The commit script checks which files changed and not what a late edit was to add.
- Rule going forward: PLAYBOOK "Committing" step 1 holds for a one-line edit too. A commit script that follows an edit of the notes also looks for a text only that edit adds.
- Status: open

## 2026-11-12: Cases were taken out, and what two of them held at the place that asks went with them
- What went wrong: batch 2 of RS-A-filterkey moved the check of a value into a function, asked it with a table, and took 14 cases with real repos out. The notes said "what each held is in the table". Two of them ("process with more after it", "required with another word for true") also held that `filterOverrides` asks the function for `process` and for `required`. Round 3 found the test passing with either word taken without asking. The mutation list had the four words taken at once, which another case caught, and no change for one word alone.
- Why: each case was read for what it said of the value, and not for each layer it ran through (the place that asks, then the pattern). The change to the caller in the mutation list was made once for the whole table.
- Rule going forward: before a case is taken out or loosened, write down each thing it proves at each layer it runs through, and keep a case for each. For a table, the mutation list has one change for each key at each layer. This is "A case with real git was loosened, and its strict twin left out one value" (2026-11-11) a second time.
- Status: promoted (PLAYBOOK "Testing" step 8)

## 2026-11-12: A test's comment named a class, and its cases tried one member
- What went wrong: the comment of RS-A-filterkey's test said a value is not standard "with more after it or before it on its line", and the cases tried one text (` && true`). Round 3 found the test passing with a pattern that takes a `;` and more, or any text without a space. Round 2 had found the same kind: "a value with more after the standard one" over cases that put the more on the same line only. The briefs tell a reviewer that a member of a stated list that passes is a finding, so the wide word made each such change one.
- Why: the comment was written from the intent of the cases and not from the cases.
- Rule going forward: a test's comment says what its cases try in the cases' own terms ("with ` && true` after it"). A word for a class ("more after it", "any value") stands only over a loop that tries every member, and the comment gives the loop's bounds (here: every text one character away, over 133 characters) and says that nothing further is told. The same holds for a note about a test. On the same day the notes of round 3 said the loop "covers more after it for every kind of character", which the comment did not say, and round 4 passed the test with a pattern that asks for two characters first.
- Status: promoted (PLAYBOOK "Testing" step 10)

## 2026-11-12: A second round found more loose patterns, because each value cost a real git call
- What went wrong: RS-A-filterkey's test tried the values of the standard LFS settings through real `git status`, one setting of a real repo for each value. Round 1 found that the test passed with a pattern loosened, and its batch added 14 values. Round 2 then found two more changes of the kind inside the list the test stated: a pattern with an `m` flag let a standard line with another line after it through, and one with a `g` flag answered every other time. Of 14 such changes tried here, 10 passed.
- Why: the pattern that decides was reachable only through the slow path. A case took about a second, so the number of values tried followed the cost of a case and not the class of texts near a valid one.
- Rule going forward: a decision made from a text by a pattern or a table sits in a function of its own, and the test asks that function directly with every text near each valid one (more at either end, a line at either end, a space at either end, other capitals, cut short at either end, the same value under another key), each valid one asked twice. Cases with the real tool stay for the path a value takes to the function. When a second review beats the same list of cases, the test changes shape and gets no further cases of the old kind. This is "Three rounds each found a slower shape for the same bound" for a test.
- Status: promoted (PLAYBOOK "Testing" step 10)

## 2026-11-12: A new test left a program running that a machine may not have
- What went wrong: RS-A-filterkey's first test ran real `git status` in repos with `filter.lfs.process` set to `git-lfs filter-process`, with `filter.lfs.required` true in one case and left out in another. It passed here, where Git for Windows brings git-lfs. On a machine without git-lfs a required filter that cannot start stops `git status` (exit 128), and those cases would have read `git-error`. It was found by reading, before the first push: the sweep suite's test of the same setup skips without git-lfs. The test was changed, and the whole mutation list ran again.
- Why: the cases were chosen from the table of standard values, and what git does with each value when it runs was not asked. This machine has git-lfs, so no run here could show it.
- Rule going forward: a test that runs a real tool with something left on (a filter, a hook, a helper program) lists each program the tool may start. It then skips without that program the way the suite already does (`HAVE_LFS`), or sets things so the tool answers without it. Before the first push the test runs once on a system that lacks the program (WSL here has no git-lfs).
- Status: open

## 2026-11-12: A mutation list changed numbers and lines, and never the kind of table
- What went wrong: RS-A-deepindex put the folders of tracked files in a tree, each folder with a Map of names. Its 13 single changes moved limits, removed lines and changed arithmetic, and all were caught. Both reviewers then found a change of the table itself that the test passed: every folder sharing the top level's Map (a folder `b` unchecked after `a/b`), and a plain object in place of the Map (a folder `hasOwnProperty` never looked at, a file below `__proto__/x` throwing). The test's names were all different at every level and none was a name every object has. The batch that fixed those two covered those two, and the next round found two more of the kind (the folders of one depth sharing a Map, names compared in lower case).
- Why: the list was made from the lines of the fix, one change to each, and not from what the new structure has to keep apart.
- Rule going forward: a fix that adds a structure keyed by text from a repo (a Map, a Set, a tree) gets test names that repeat across levels and names every object has (`__proto__`, `constructor`, `hasOwnProperty`, `toString`), and its mutation list has the structure swapped for a plain object and for one shared by all. This is the 2026-11-10 rule on keys ("two things under one key, one thing under many keys") for a new shape.
- Status: promoted (PLAYBOOK "Writing code and docs" step 11)

## 2026-11-12: A hook timing read the same on the old code and the fix, because the hook had left early
- What went wrong: the first timing of RS-A-deepindex through the PreCompact hook gave 0.17 s for the parent and for the fix. The hook leaves at once in a repo not set up for Trailmark, so neither run reached the code being timed. The same day the new test failed on the parent commit only because the function it calls was not exported there, which proves nothing about the fix.
- Why: the harness had no sign that the timed code ran, and "fails on the parent" was taken as a property of the test without reading why it fails.
- Rule going forward: a timing harness shows something only the timed code can make (the hook's answer, or a time that differs between parent and fix), and equal times for both are read as "did not run" until shown otherwise. A test that cannot run on the parent (a new export, a new option) gets its proof from a mutation that puts the old code back in the new file, and the review brief says so.
- Status: open

## 2026-11-12: Three rounds each found a slower shape for the same bound
- What went wrong: RS-A-worktreeslinks put a time in SECURITY.md for what its limit lets through, and each of three review rounds beat it with a more unusual tree (4 KB pointers, a path of 16,130 characters, a path with characters outside Latin-1). Two rounds added a term to the count and each new term drew the next round. The new test also could not see a path longer than a link's target allows, so a count cut off at 4,096 passed it.
- Why: the shipped text ranked ("the slowest left") where it could only say what was measured, and each fix answered the last shape, not the family. The last two shapes need a path of thousands of characters, and the slowest of them one longer than git can open, which a cap on the path's length would refuse.
- Rule going forward: a shipped text gives times by shape and never a ranking. When a second review beats the same bound, stop and ask what the shapes have in common before adding a term; a cap on the input is preferred to another weight. A test of a term runs at the size that drew the fix, not at the size its fixture is easy to make.
- Status: promoted (PLAYBOOK "Testing" step 15)

## 2026-11-11: A reviewer's test run left a folder in the machine's temp folder
- What went wrong: after round 2 of RS-A-worktreeslinks, `E:/DevTemp` held `jbmem-far-wt-5gZt0i` (23:00, the fixtures of the round's test). The brief told each reviewer to set TMPDIR, TEMP and TMP to its clone's `tmp-review` before a test run, and each clone was checked clean and empty.
- Why: HYPOTHESIZED: one test run in a shell started after the variables were set (a new shell does not keep them), and the test failed there, so it kept its folders. The check of a clone looks only inside the clone.
- Rule going forward: a review brief says "before EVERY test run" and that a later shell does not keep the variables. After a round, the owner lists `jbmem-*` in the machine's temp folder next to the check of the clones. This is "A subagent's test output landed on C:" (2026-11-07) again; its step did not stop it. It came back on 2026-11-12 (round 1 of RS-A-filterkey: `jbmem-filterkey-Uwji9Y` in `E:/DevTemp`, with both clones clean), with "before EVERY test run" in the brief. So the brief now gives the test command as one line with the three variables in front of it, and says to run a test no other way.
- Status: promoted (PLAYBOOK "Reviewing" step 2)

## 2026-11-11: The second "slowest found" was beaten too, by the length of a path
- What went wrong: round 1's fix counted a pointer's text, and SECURITY.md said what is let through of that kind takes 0.6 seconds. Round 2's regression review measured 0.79 s for it (500 entries; the 0.6 was read at 390, not at the size where the refusals start), and the security review let 900 entries through after 4.3 to 4.8 s by putting the worktrees folder at a path of 16,130 characters: a look at the disk and `path.resolve(folder, text)` both take longer the longer the folder's path is, and neither count had a term for it.
- Why: step 13 (from round 1) asks for one search shape for each step before the counted line. The join was on that list, with the pointer at its largest size. The folder it is joined to, and the path a disk call names, were not thought of as inputs: every search shape sat in a temp folder of about 50 characters. And the time for a shape was read below the size where the limit stops it.
- Rule going forward: for each step before a counted line, list every input its time grows with (the text, the folder it is joined to, the path a disk call names), and search with each at its largest. Read "what is let through takes" at the last size that passes, three runs.
- Status: promoted to PLAYBOOK (step 13 extended)

## 2026-11-11: A reviewer beat "the slowest found" with work the search never tried
- What went wrong: SECURITY.md said the slowest worktrees folders the new limit lets through take 1 to 2 seconds. The security review of RS-A-worktreeslinks found one that takes 3 to 4: pointers of 4 KB made of `a/../` pairs, which Windows joins to next to nothing, so the walk counted about 67 for 190 microseconds of text work. The search here had five shapes, all of them differing in what is on disk. The same notes also said the parent repeated its looks at the disk, which the review showed was wrong (`withShare` already kept them).
- Why: the search varied the things the new count weighs (entries, files, links) and not the work done before the counted step. The cause of the parent's time was written from the fix's design, not from a profile.
- Rule going forward: before a time goes in a shipped text, list every step between reading an input and the first counted line, and give the search one shape for each (here: the text of a pointer at its largest size). The cause of a slow path is written from a profile or a probe, with its label, not from what the fix changes. This is "The time was in a call nobody profiled" (2026-11-10) again, so it is a PLAYBOOK step now ("Testing" step 13).
- Status: promoted to PLAYBOOK

## 2026-11-11: A per-entry weight was guessed at 3 disk lookups and real entries cost four times that
- What went wrong: the first draft of RS-A-worktreeslinks counted 3 looks at the disk for each worktrees entry. 100 worktrees made by `git worktree add` then counted 156,236 of 8,388,608 and took 0.08 to 0.33 s, so the limit would have let 4 to 17 s of them through. The weight went to 12 after the count and the time of real entries were measured.
- Why: the weight was read off the code (one lookup of the entry, two files) and not measured. Opening and reading a small file costs more than a lookup, and so does the first look at a folder that was just made.
- Rule going forward: none new. This is "A work count weighed text and not disk lookups" (2026-11-10) a third time, and its rule is PLAYBOOK "Testing" step 11: time the dearest thing one counted item can be, at the limit, before the weight is written. What this time adds is in the mutation list: the weight is held from both sides (10 and 14 both fail).
- Status: promoted to PLAYBOOK

## 2026-11-11: A probe's slow reading came once in four runs
- What went wrong: the search for the slowest worktrees folder the limit lets through read 2.22 and 3.64 s for one shape in its first run and under 0.8 s for the same shape in the three runs after it. The first reading alone would have put "up to 3.6 seconds" in SECURITY.md, and the later ones alone would have hidden it.
- Why: one run of a timing probe on a machine that does other work.
- Rule going forward: a timing that goes into a shipped text comes from at least three runs, one of them in the first run's order. A reading that does not come back is written in `dev/release-state.md` as unexplained, with what was ruled out, and the shipped text keeps its range with room.
- Status: promoted to PLAYBOOK ("Testing" step 14), after a second sighting in round 2 of RS-A-worktreeslinks: readings of 4.6 to 8.1 s for shapes that take about 1 s, not reproduced in two repeats with processor sampling

## 2026-11-11: A reviewer's failed probes kept 2,431 folders
- What went wrong: the round 2 regression reviewer of RS-A-firstcheck ran 34 probes that fail the test. A failed test keeps its folders, as designed, and they added up to 2,431 folders in the reviewer's `tmp-review`, past the 1,000 the brief allows for a tree. The reviewer removed them by name at the end.
- Why: the brief limits a tree the reviewer makes and says nothing about what failing tests keep from one probe to the next.
- Rule going forward: a brief that asks for probes that fail tests says to remove the kept folders by name after each probe, not at the end.
- Status: open

## 2026-11-11: A clock that never moved passed, because the test's clock moved once
- What went wrong: the sweep's lookup clock (`left: () => deadline - Date.now() - 800`) could be swapped for one that stands still and all three RS-A-firstcheck tests passed. The security review found it (round 1, F1) and measured session start at 20.2 s with the clock frozen (CONFIRMED by Fable, not re-run). The three survivors were reproduced here.
- Why: the test's stand-in clock moved once, at the first file, before the sweep made its own clock. The mutation list had "a clock that does not run" for the hook's clock and only "no clock" and "keeps nothing back" for the sweep's.
- Rule going forward: every clock handed down gets a case where time passes after that clock was made and before its last read. The mutation list has "does not run" for each clock, not only the first.
- Status: open

## 2026-11-11: "Every command is unchanged" was written without listing the callers
- What went wrong: the notes, the PR text and the review brief said a caller with no clock, every command, was unchanged. `write-handoff` with `--session` runs the same sweep as session start, so its lookups got a clock too (round 1, the security review's note; CONFIRMED here: `sweepFacts` has two callers).
- Why: the claim was written from `repoRoot`'s side (no `left`, no change), not from a list of who calls each changed function.
- Rule going forward: before "callers of this kind are unchanged" is written, grep the callers of every function the change touched and name each one that changes.
- Status: open

## 2026-11-11: A job that hung had no time limit and left no log
- What went wrong: on PR #50's last head the job "macos-latest, Node 22" sat in the step "trailmark tests" for 44 minutes, where that step takes 1 to 3. `tests.yml` sets no `timeout-minutes`, so GitHub's 6 hours applied and auto-merge waited on the job. A watcher here ran into its own time limit first, which says nothing about the job. A job that never answered leaves no log, so the cause could not be read afterwards: three reruns passed and it stays unproven.
- Why: nothing in the workflow bounds a job, and the step's usual time was written down nowhere to compare with.
- Rule going forward: a job that runs past three times its step's usual time is treated as hung. Take auto-merge off, cancel, ask for the log, compare the step's time on other heads, and rerun that job alone three times before anything merges. A watcher's own limit running out reads "still running", never "failed". A hang with no log and passing reruns is recorded as unexplained with its evidence, and the user decides the merge.
- Status: open

## 2026-11-11: A case with real git was loosened, and its strict twin left out one value
- What went wrong: round 2 let the two cases "real git is stopped at 1 ms" accept either answer and moved the strict check to a stand-in, but the stand-in was stopped at 2000 ms only. A change that reads git stopped at 1 ms as an empty file then passed the test, where the test before it failed (round 3's reviewer). A second gap had been there from the start: nothing showed that the time is asked again when git starts.
- Why: the stand-in cases were written from the reviewer's list of survivors, not from what the loosened cases used to prove.
- Rule going forward: before an assertion is loosened, write down each thing it proves (here: git stopped at 1 ms is a timeout, and a timeout of 0 never happens), and give each one a strict case that needs no real timing. Then run the whole mutation list, as the entry below says.
- Status: promoted (PLAYBOOK "Testing" step 8, after it came back on 2026-11-12)

## 2026-11-11: A probe that never ran was printed as a failed test
- What went wrong: during a mutation run winget updated Node on the PC (26.13.0 to 26.13.1, 16:17 to 16:19 in the Windows event log). Five probes found no `node` for some seconds. `release-check.sh` printed "FAIL ? failed of ?" in 0 s, and the probe script passed that on as FAIL, which in a mutation list reads as "caught". The 0 s and the "?" gave it away. In the same run a loosened assertion let one probe pass (git's timeout of at least 1 ms), which only showed because the whole list was run again after a change to the test alone.
- Why: the script took any FAIL line as the test failing, without asking whether the test had run.
- Rule going forward: a mutation script counts a probe as caught only when the result line has a count for the tests it ran ("N failed of 2"). Any other line is "no result": it is run again, and it holds the batch if it stays. Read the times too: a probe that ends in 0 s did not run. After a change that loosens an assertion, the whole mutation list runs again, not only the new probes.
- Status: open

## 2026-11-11: One call in a test had the clock stood still, and the next one ran on real time
- What went wrong: the RS-A-nestedone test stood the clock still for its 700 ms run and left it running for the call after it, which counts the checks that name no line. A check with under 800 ms left stops, so on a slow or busy machine the count came out short and the test failed with correct code (a reviewer: 3 of 3 with 24 busy processes). Two more cases expected real git to be stopped by a timeout of 1 ms. The mutation runs, all passing, showed none of it. While fixing it, a generator script went through an inline `node -e` and lost its line-break escapes, which the Constraints in `PLAYBOOK.md` already rule out.
- Why: the rule of 2026-11-07 (a test with a wall-clock budget forces the in-time path) was applied to the call it was written for and not to the call added beside it in the same batch. Mutation runs show that a test catches changes to the code; they say nothing about the test on a slower machine.
- Rule going forward: give each call with a real-time budget in a new test a third of its budget and run it once. A failure names an assertion tied to the machine's speed: stand the clock still for that call, or stand in for git. A case that needs real git to be stopped by a short timeout accepts git finishing too, and its strict form uses a stand-in.
- Status: promoted to PLAYBOOK (Testing 12). Seen before on 2026-11-07 ("A test's time budget was taken for a fault").

## 2026-11-11: A line copied from one caller cut another caller's smaller budget
- What went wrong: RS-A-nestedone's fix stopped every config check at 800 ms left, the line the status check's loops use with their 5 s. The same check also runs before each git call of a runner that has a second in all (the look into another session's folder), so that runner lost its calls after 200 ms and another command's commits were logged as this one's. A second fault in the same fix: git stopped by the shortened timeout was read as an unreadable file and kept, where the parent said the time ran out. A reviewer found both; the first test passed with them.
- Why: the line was taken from the nearest code that had one, without listing who else reaches the changed function and with what budget. The shortened timeout was added without asking what its own failure looks like to the code after it.
- Rule going forward: a limit handed down a call chain is named by each caller, and before it is written every runner that reaches the function is listed with its budget (`grep 'runner('`), smallest first. A timeout that is made shorter gets a case for the call being stopped by it: which word comes out, and whether it is kept.
- Status: open

## 2026-11-11: A fix was timed through the library, and the real hook paid the cost somewhere else
- What went wrong: RS-A-nestedone's fix was first timed only by calling `gitFacts` from a script: 8 folders above the session's folder with slow configs went from 10.0 s to 4.2 s. Started as a real PreCompact hook, the same shape took 10.2 s before and after. The launcher's own first check (`hookMemory`, to find the memory folder) reads the same config files with no time, before `gitFacts` starts, and keeps the answer. The docs sentence in draft would have claimed the 4.2 s for a hook.
- Why: the repro started at the function that was changed, not at what a user runs. The call that pays first in a hook is in another file.
- Rule going forward: a time claimed for a hook is measured by starting the hook as a process (`trailmark.js --hook <name>` with a payload on stdin), on the parent and on the fix. A library timing is written down as a library timing. Before a fix that hands a limit down a call chain, `grep` every caller of the changed function and say for each whether it has the limit.
- Status: open

## 2026-11-11: A test told a timeout by its word, and a later look gave the same word
- What went wrong: in RS-A-nestedone's test the mutation "the look only before the first file" passed. `config.worktree` is looked for after the included files, noticed the low clock there, and gave the same `git-timeout`. Later, when a first check out of time was made to read like any git timeout, the cases could no longer tell "stopped at the second file" from "read all six and ran out afterwards".
- Why: the cases asserted the answer, and several places give that answer once the clock is low.
- Rule going forward: a test of where a limit is looked at pins the place: a clock that is short at one ask only, or a count of what was touched after the limit was hit, asserted in each case. When the count surprises, trace the callers before changing the expectation (here each file is looked at twice for one read).
- Status: open

## 2026-11-11: A test's stub matched paths outside the test, and one of its branches never ran
- What went wrong: the RS-A-linkfolders test stubbed `fs.lstatSync` and told its four folders by the last part of the path (`d0` to `d3`). The walk of a link looks at every part of the temp folder's own path, so under a temp folder named `d7` the test counted 5 and failed. The same stub was to set its clock back at the look at `.gitmodules`, which never comes in that repo: the git calls after the loop ran with a real 900 ms timeout. Both found by the reviewer of PR #49 and reproduced here; the test had passed here and on the mutations.
- Why: the stub was copied from the RS-A-nestedtime test, where `.gitmodules` is looked at (a tracked file turned folder) and the names matched are two parts long. Nothing in the test showed whether the branch ran.
- Rule going forward: a stub on a shared function matches on the path from the test's own folder, not on a name alone. A stub branch that changes what the rest of the test sees (a clock, a counter) sets a flag, and the test asserts the flag in each case.
- Status: open

## 2026-11-11: A merge chained after a push went in before CI saw the push
- What went wrong: PR #47's round 1 batch (cb14d67: a test's stub clock, a SECURITY.md wording, the notes) was pushed and `gh pr merge 47 --auto --merge` ran in the same script. The PR merged at once as 8fd6b84 with all 9 jobs of cb14d67 still pending, so CI did not gate that commit. Its parent b82ab59 had passed CI, and `--sums --quick` had passed here on cb14d67.
- Why: right after a push the new head's jobs aren't registered yet, and `--auto` merges straight away when nothing is seen pending (admins are also exempt from the required jobs). PLAYBOOK.md already said a merge is run as its own command; the script chained it after the push.
- Rule going forward: after a push, the merge command goes in a later step, and only once `gh pr view <n> --json headRefOid,statusCheckRollup` shows the pushed head with its 9 jobs listed (pending or passed). If a merge does go in ungated, say so at once, watch the run on main for that merge commit, and fix forward on a failure.
- Status: open

## 2026-11-10: A test that made 33,600 folders stalled the drive
- What went wrong: the first RS-A-manylinks test made 840 folders 40 levels down for its links' targets. It passed, in 12 to 24 s, but in three runs it took 481, 961 and 1,308 s, and `rm` calls of the check script hung for minutes.
- Why: the stall is in the file system of drive E: (ReFS, the Dev Drive the temp folder is on), not in the code under test. CONFIRMED here: during the 481 s both test processes had no CPU time and no I/O count for 7 minutes (a sampler every 15 s), and Windows logged ReFS event 147 for `rm.exe` on E:, an I/O of 373 s. The same steps timed alone, 8 rounds, never took over 24 s. Each failed run also kept its 38,000 entries, 20 runs deep. Which ReFS work stalls is not known.
- Rule going forward: a test makes as few folders as show the fault. When work is counted by a model (here `localPath`'s), look for the input that costs most per entry before making many: one folder at the end of a 900-character path costs 27,000 per link, against 290 per folder made. For a slow run, sample CPU and I/O counts of the processes first: no CPU and no I/O means the wait is outside the code.
- Status: open

## 2026-11-10: A search that wanted text before each match missed the ones at a line's start
- What went wrong: I wrote in `dev/release-state.md` that no reference to another section by its place was left, and twenty were (Sonnet, PR #41 round 1; each seen here). My search asked for 60 characters before each match, to show context, and the twenty sat within 60 characters of a line's start.
- Why: the pattern that printed context also decided what counted as a match. I took an empty-looking result as "none left" and wrote the claim from it.
- Rule going forward: a search behind a "none left" claim matches the bare text, with context as optional (`.{0,60}`) or left to the tool's own context option. A claim that nothing remains names the search it rests on.
- Status: open

## 2026-11-10: An edit script went through a heredoc again
- What went wrong: a script of old/new pairs for the RS-A-altstores test was written with a heredoc. One old text held `\'`, the heredoc lost the backslash, and the script stopped with "not once" before writing anything. Redone with the Write tool.
- Why: the rule is in PLAYBOOK ("Writing code and docs", step 4) and was promoted twice. The script looked like plain wording, and the one escaped quote in it went unnoticed.
- Rule going forward: no new rule. Every script goes through the Write tool, whether or not a backslash is expected in it: checking for one is the step that fails.
- Status: open

## 2026-11-10: Section references by place went stale with each new section

- What went wrong: `dev/release-state.md` pointed at its sections as "top section" and "second section". A new section goes in at the top for each item, so every such reference moved. The docs reviewer of PR #40 found fourteen wrong ones, three of them wrong since earlier PRs; reviews of PRs #38 and #39 had found the same kind.
- Why: I fixed the references a review named each time and kept the way of pointing that makes them.
- Rule going forward: a reference to a section names it. The same fault found by a second review is a fault in the method, not in the lines.
- Status: promoted (PLAYBOOK, Writing code and docs, step 10)

## 2026-11-10: A deferred item's claim about git was half right

- What went wrong: RS-A-dottracked was written down as "git on Windows opens `d` for a tracked `d.`". Probing git itself showed it depends: a folder on the way (`d./f`) is opened under the plain name with every setting tried, a file (`u.`) only with `core.fscache=false`, and a name with a stream's name after it never. I also wrote an edit script through a heredoc again, which collapsed its backslashes; its "occurs once" check stopped it before it wrote.
- Why: the item's text came from a reviewer's report and had not been run here. The heredoc was habit, against a Windows note in CLAUDE.md.
- Rule going forward: before designing a fix for a deferred item, run the other program (git here) on the item's shapes, with a control that has a known answer and with the settings a repo can change. The rule then covers what was seen and no more. Scripts with a backslash in them are written with the Write tool, never a heredoc.
- Status: open

## 2026-11-10: A better key widened an older gap

- What went wrong: round 2 gave a folder a link led to the system's own path as its key, so the walks knew it under any spelling. A folder walked where part of it is passed over (a gitdir's `objects`) was then taken as seen where it is walked in full (`refs/x`, a junction to `objects` by its stream name). f97553a and edd988d refused that input; 734f14f answered `''`. Round 3 found it. With a plain target the gap was there on f97553a too, and I had deferred it one round earlier as older behavior.
- Why: I asked what the key stands for and not what "seen" is taken to mean where the set is read. The set was shared by places that walk by different rules, and only the keys' mismatches had kept them apart. I also deferred a gap in the very set I was changing.
- Rule going forward: before a set's key gets better at matching, list every place the set is read and what "seen" lets that place skip. If two places skip different things, they don't share entries. An older gap in code the change touches is fixed with the change or shown not to widen, not deferred on its age.
- Status: open

## 2026-11-10: A fix covered the reviewer's example, not its class

- What went wrong: round 1 showed one folder walked once for each letter case a junction named it in. My fix respelled a target only when it differed in case. Round 2 added `::$INDEX_ALLOCATION` to the targets and had the 605 listings back (7.6 s); a short name does the same. One more batch and round.
- Why: I fixed the input I was given and tested that input. I had tied the key to the text the walk goes on under, so the guard that keeps a `subst` drive's spelling also narrowed the key.
- Rule going forward: before fixing a reviewer's example, write down its class (here: every way two path texts name one folder: case, short name, stream name, a link, a drive made with `subst`) and say for each member whether the fix covers it, with a test or a reason. A value with two jobs (what is remembered, where the walk goes) gets a part for each.
- Status: promoted (PLAYBOOK "Writing code and docs" step 11)

## 2026-11-10: A refusal by a key's last letters hit values that are not paths

- What went wrong: RS-A-trailingdot refused any value with a name ending in a dot under a key that ends like a path setting. `[alias] adddir = add .` and `newworktree = worktree add ../wt` then kept git out. Review round 1 found it; one more batch and round.
- Why: I wrote "INFERRED never in a real repo" from what folder names Windows can make, and never listed what else sits under keys matched by their last letters. The 2026-11-09 lesson on a count limit said to list what real tools write; I read it as about limits only.
- Rule going forward: a new refusal gets the same list as a new limit: what real tools and users write in the matched class, sections with user-named keys first, run through the rule before the first review. PLAYBOOK "Writing code and docs" step 8.
- Status: promoted to PLAYBOOK

## 2026-11-10: The exact key made one folder many

- What went wrong: RS-A-foldkeys replaced lower-cased keys with the exact text. A junction keeps its target in the case its maker wrote, so 240 junctions to one folder were 240 keys: 605 listings and 4.8 s where the old code made 5. Review round 1 found it.
- Why: I fixed the direction the earlier lesson named (two things, one key) and tested only that. I wrote "walked again, within the limits" without timing what the limits let through.
- Rule going forward: a key for "already checked" is tested both ways: two things under one key, and one thing under many keys, with links making the many. The key is the name the system gives (here the path as the disk spells it). PLAYBOOK "Writing code and docs" step 9.
- Status: promoted to PLAYBOOK

## 2026-11-10: Test code appended through a heredoc lost a backslash

- What went wrong: the RS-A-foldkeys test was appended to the test file with an inline `cat >> file <<'EOF'`. The Bash tool collapsed `'k.\\a'` to `'k.\a'`, which JavaScript reads as `k.a`, and the new test failed on a value that is rightly accepted. One run lost.
- Why: the limit is in PLAYBOOK ("Constraints", and "Writing code and docs" step 4), and I read it as being about edit scripts. A heredoc that writes code is the same inline text.
- Rule going forward: code and tests are never written through an inline command, a heredoc included. New text goes in with the Edit or Write tool. PLAYBOOK's step 4 now says so.
- Status: promoted to PLAYBOOK

## 2026-11-10: A test's macOS branch expected what the file system did, not what the code does

- What went wrong: the `k` and Kelvin sign assertion (585e5ef) expected as many listings as folders the file system made. macOS made one folder, and the code, keyed by exact path text, listed it twice: `2 !== 1` in the three macOS jobs. The product was right and the test's guard was wrong.
- Why: this machine runs Windows only, and I reasoned about what macOS's file system does to the names without then asking what the code under test does with two texts for one folder. PLAYBOOK "Writing code and docs" step 3 covers error codes on the other systems, not name folding.
- Rule going forward: for a test branch that only another system runs, write down that system's input as the code sees it (here: two path texts, one folder) and derive the expected value from the code, not from the file system's view.
- Status: open

## 2026-11-10: A set of seen folders was keyed coarser than the file system

- What went wrong: RS-A-storagewalk's set of walked `lfs.storage` folders was keyed by `real.toLowerCase()` on Windows, copied from the sets around it. `k` and the Kelvin sign (U+212A) lower-case alike in JavaScript and are two folders on NTFS and ReFS, so a clean `k` named first left the second folder unwalked: refused before, accepted after (3dbc23c). Round 1 found it. The same key in `linkedEntries` is older and deferred (RS-A-foldkeys).
- Why: the key had lived for one value, where two folders could not meet in it. Making it live for a whole check changed what a collision costs, and I tested that a folder in two cases is walked once, the opposite of the risk.
- Rule going forward: a key that decides "already checked" is never coarser than what it stands for. Use the exact text, or an identity the system gives, and let the cost limits take the repeats. When a set starts to live longer, ask what two different things could share a key in it. PLAYBOOK "Writing code and docs" step 9, since the exact text proved too fine in turn (2026-11-10, "The exact key made one folder many").
- Status: promoted to PLAYBOOK

## 2026-11-10: A limit on a count of folders passed its probe and let 45 seconds through

- What went wrong: the first fix of RS-A-storagewalk limited `lfs.storage` to 64 different folders. The probe used folders of files (64 of 12,000 files each: 1.3 s). Laid out as git-lfs does it, folders within folders, one store's 10,000 looked-at entries take 0.65 s on Windows, and 64 were accepted in 45 s. Found before the commit, by timing the dearest layout on purpose.
- Why: an "entry" of the store budget is a name in a listing when it is a file and a listing of its own when it is a folder, about 30 times dearer. The cap was sized on the cheap kind.
- Rule going forward: a limit on a count is sized on the dearest thing one counted item can be, timed at the cap, before it is written down. This is the 2026-11-10 lesson "A work count weighed text and not disk lookups" a second time, so it is a PLAYBOOK step now.
- Status: promoted to PLAYBOOK

## 2026-11-10: A work count weighed text and not disk lookups

- What went wrong: the first work limit of RS-A-manyvalues (b665d71) counted mostly the length of each value's text. Round 3 showed both errors of that: 2,000 submodule gitdirs in a repo at a path of 160 characters were refused (a long repo path made every walk count more, though it adds little time), and 5,000 `.lfsconfig` values 50 existing folders down were accepted in 4.8 s (each look at the disk counted almost nothing, and `.lfsconfig` had no lookup cache).
- Why: the weights were chosen from the code's shape and checked against total time on a few inputs, not measured one cost at a time. The honest input was sized at one repo path only.
- Rule going forward: before setting the weights of a counted limit, measure units per second on the cheapest and the dearest kind of step (text only, parts, disk lookups that miss the cache) with an unlimited copy, and set the weights so the two rates are within a small factor. Size the honest inputs at the longest path and depth a real repo can have, and state the margin.
- Status: open

## 2026-11-10: "The slowest found" was written before anyone searched

- What went wrong: SECURITY.md, a code comment and the PR text gave one number for the slowest input (2.1 s, then 0.8 s, then 1.1 s) and one for the largest real repo (36% of the limit). Rounds 3, 4 and 5 each found a slower or larger one (1.5 s; 77%).
- Why: the numbers came from the probes written for the last fix, which hold the shapes already thought of, and were stated as a point.
- Rule going forward: a shipped text gives a limit's cost as a range with room ("1 to 2 seconds"), and only after a reviewer was asked to beat it. The exact numbers and who measured them go in `dev/release-state.md`.
- Status: open

## 2026-11-10: The time was in a call nobody profiled (`os.userInfo` per value)

- What went wrong: four batches of RS-A-manyvalues bounded the walking of path values, and each "slowest input" was timed end to end. Most of that time (5.4 s of 6.6 s for 40,000 values) was `os.userInfo`, called once for every value outside the walk. It was found by chance, from a probe written for a CI failure.
- Why: the cost was assumed to be where the code looked expensive (disk lookups, long texts), and total time agreed well enough. No profile was taken before the limit was designed.
- Rule going forward: before bounding slow code, profile the slow input (`node --cpu-prof`, top functions by self time) and account for most of the time by name. After the fix, profile the slowest accepted input again: what is left must be what the limit counts.
- Status: open

## 2026-11-10: A test bound moved with the temp folder's length

- What went wrong: 0bbd0f9 failed CI on the three Ubuntu jobs. A bound of "5 times the baseline's calls" on a refused case held on Windows, macOS and WSL and failed on the runner (5.5 times), one push after the same kind of bound was widened for `.lfsconfig` and this one was left.
- Why: the number of values walked before the work limit depends on the repo path's length, and the temp folder is part of that path. The first failure was fixed where it showed, without asking what made the number move.
- Rule going forward: when a counted bound fails or is close on one system, find what the count depends on, vary that across its range (shortest and longest temp path, both systems), and check every assertion of that kind in the test, not the one that failed. Catch a mutation by an answer that flips with a wide margin, not by a ratio near its bound.
- Status: open

## 2026-11-10: A promoted playbook step was skipped (pair script with `\n`)

- What went wrong: a third pair script for test text with `\n` in it failed with "occurs 0 times", after the rule against it was already step 4 of PLAYBOOK's wording checklist.
- Why: the lessons check was run for the step "change a test", and the edit's tool was chosen after it, out of habit.
- Rule going forward: none new. The step stands; the lessons check names the tool for an edit before the edit is written.
- Status: open (seen after promotion)

## 2026-11-09: Limits on three counts missed their product

- What went wrong: RS-A-manyvalues was first bounded by how many path values there are, then also by their length together and by the number of worktrees. A review after each showed an accepted input that still took minutes (4 worktrees of 16,000 characters with 2,000 short values: 110 s), and the limits refused real repos on the way (2,000 submodules and one more setting).
- Why: the cost of one value depends on the folders it is tried from, which come from other values. Each count was bounded alone, and the "slowest accepted input" was measured only on the shapes already thought of.
- Rule going forward: when the cost is a product of several inputs, bound the work itself (count it where it is done), not each input. Before calling a limit done, write the cost as a formula from the code and try the corner where every factor is at its limit at once.
- Status: open

## 2026-11-09: A count limit was set without listing what real tools write

- What went wrong: the first limit for RS-A-manyvalues was 200 different path values, chosen from "a real config has a handful". The review found that git 2.56 can write `submodule.<name>.gitdir` for every submodule, a key the check's pattern matches, so a repo with 201 submodules was refused where it had been accepted.
- Why: the limit came from how long the check takes, with no look at which keys match the pattern in a real repo. The record even said "a real config has a handful" with no label and no check behind it.
- Rule going forward: before a new limit refuses anything, list what real tools write that counts toward it (for a key pattern: search git's own config names for matches) and size the limit from the largest real case, with an existing limit for the same thing where there is one. A sentence like "a real repo has few" gets a label and a check like any other claim. PLAYBOOK "Writing code and docs" step 8.
- Status: promoted to PLAYBOOK

## 2026-11-09: Two mutations passed because the test's link cases were skipped here

- What went wrong: in the mutation run for RS-A-manyvalues, two of ten changes to the fix left the test passing. The assertions that cover them make symlinks, and the test returns before them on a Windows machine that can't.
- Why: the run was read as "the test passes" without asking which part of the test ran. The first run of the test also hid a mistake in that part (a name that wasn't defined), for the same reason.
- Rule going forward: when a test or a part of one is skipped on this machine, run it where it isn't (WSL for links) before its result or its mutations count, and say in the record which system each result came from.
- Status: open

## 2026-11-09: A line no test needed was removed, and it was holding time

- What went wrong: a mutation run showed that the length limit in `exactPointer` could go without any test failing, so it was removed as redundant. The next review found an input that then took 6 s here and 42 s on Linux: the line had kept megabytes of text away from `path.resolve`.
- Why: every test looked at the answer, and the answer was the same with and without the line. What the line saved was time, which no test measured.
- Rule going forward: a line that no test needs gets a look at what else it does (time, memory, what is handed to the next function) before it is removed, and if it stays it gets an assertion of its own. For time, count the work (calls, sizes) where that is possible, not seconds.
- Status: open
## 2026-11-09: A test's expected count was worked out by hand and was one off

- What went wrong: the RS-F-codexwalk test expected the search to look in 45 folders. It looks in 44, so the "one fewer" case passed where it should have been cut short, and the test failed with the fix in place.
- Why: the count was added up from the folder layout, and the folder that holds the old copy was counted although the search never walks into a marketplace's `jb-memory-codex` folder.
- Rule going forward: take a boundary number in a test from a run of the code (a counter, or the two sides of the boundary tried), not from adding it up, and say in the test's comment what is counted.
- Status: open

## 2026-11-09: An edit script's old text didn't match because of its own escapes

- What went wrong: a script of old/new pairs for `gitbin.js` stopped with "occurs 0 times": the old text held a regex with backslashes, written inside a template literal inside a heredoc. Nothing was written, since it checks before it writes.
- Why: three layers of escaping (the shell, the template literal, the regex) and no look at what text the script would search for.
- Rule going forward: for an edit whose old text holds backslashes, use the Edit tool on one copy and copy the file to the other, or anchor the pair on a nearby line without backslashes.
- Status: promoted to PLAYBOOK (seen again the same day: a pair script for test code with `\n` in it stopped the same way)
## 2026-11-09: A review's commit was copied from another reviewer's

- What went wrong: the release-state note for PR 33 said Copilot reviewed b37f215. GitHub records its review on e466077. Copilot found it on PR 34.
- Why: Codex's summary named b37f215, and the Copilot line was written with the same commit without reading that review's own `commit_id`.
- Rule going forward: take each review's commit from its own record (`gh api repos/<repo>/pulls/<n>/reviews`, field `commit_id`), one reviewer at a time.
- Status: open

## 2026-11-09: A red CI run had no failed job, and two jobs had never been created

- What went wrong: PR 31's run ended "failure" with 7 jobs listed, all passing. macOS Node 22 and Windows Node 26 had no job record and no log, so the required checks stayed missing and the merge was blocked. The `main` run for b970008 did the same with 6 of 9. Both ran inside GitHub's Actions incident of 18:12 to 18:59Z.
- Why: `gh pr checks` lists only the jobs that exist, so a short list reads as all green unless the jobs are counted.
- Rule going forward: read a run's result as a count, 9 jobs against the 9 required names. A red run with no failed job means reading GitHub's incident feed before suspecting the code.
- Status: open

## 2026-11-09: A deferred note named one route to a function that had others

- What went wrong: RS-A-newlines was deferred on the belief that its input was git's own small pointer files. `exactPointer` also takes config values, which reach it decoded from an 8 MB file, and that route stalls for tens of seconds.
- Why: the note looked at the six lines holding the regex and not at who calls the function around them.
- Rule going forward: before labeling how far an input can reach, list every caller of the function that holds the code, and find each one's size limit.
- Status: open

## 2026-11-09: A test input used an escape git does not have

- What went wrong: the new test's `attrs\n\r\n` made an invalid config, since git's parser has no `\r` escape, and it failed with the fix in place. The mutation runs built on it all reported failures that proved nothing.
- Why: the input was written from the regex's character class and not from what the format allows, and the first run's summary was read only after the mutations had run.
- Rule going forward: run a new test with the fix in place and see it pass before running any mutation against it.
- Status: open

## 2026-11-09: A new awk variable overwrote a counter

- What went wrong: the fence fix stored a line number in `opened`, already the count of open lessons. The summary printed "31 open" and "-15 promoted", and the format check still passed because counts don't affect it.
- Why: every awk variable is global unless it is a function parameter, and the name wasn't searched first.
- Rule going forward: search a script for a new variable's name before using it, and read the whole output of a check, not just its pass or fail.
- Status: open

## 2026-11-09: A new format check passed the shapes just outside the format

- What went wrong: `dev/lessons.sh --check` accepted a heading with no colon or no date, and the fields under it landed in the entry above, so one entry's rule showed under another's title. Copilot found it on PR #29. The probes had removed fields but never bent a heading.
- Why: the negative cases were chosen from what the check looks for, not from what could get past it.
- Rule going forward: a validator's negative cases include inputs one small edit away from valid, and what happens to the data after a line it doesn't recognize. An unclosed code fence, found on the next review of the same script, is the same gap: state left open when the input ends.
- Status: promoted to PLAYBOOK (Testing, step 10, second sighting)

## 2026-11-09: A test passed through a different reset than the one it meant to pin

- What went wrong: a new assertion that a bigger point starts over kept passing with that check removed. Its reading was low enough that the shrink rule cleared the state instead.
- Why: the assertion looked only at the result, and two rules give the same result.
- Rule going forward: when several rules give the same result, pick inputs where only the rule under test can give it. Removing the part alone is what found this.
- Status: open

## 2026-11-09: Moving a reset out of a guard let a hook with nothing to ask wipe a sibling

- What went wrong: the fix for Copilot's finding moved the bigger-point reset out of the `crossed` guard. A late hook at a bigger point with no step to ask then saved `{}` over its sibling's state, and the next hook made the same first request again. The regression review found it on 9733991.
- Why: the moved check was judged by the case it was moved for (a hook that asks), not by every case the guard used to skip.
- Rule going forward: moving code out of a condition is the same question as adding one: list what it now does in each case the condition used to cover.
- Status: promoted to PLAYBOOK (Writing code, step 7, second sighting)

## 2026-11-09: A negative probe removed the field from the format template

- What went wrong: to prove `dev/lessons.sh --check` catches a missing "Why", a `sed` removed the first such line in `LESSONS.md`. That line is in the format template at the top, so the check rightly passed and the probe looked like a bug in the script.
- Why: the probe checked that its edit applied, not where it applied.
- Rule going forward: a probe's edit names the exact entry or line it means to change.
- Status: open

## 2026-11-09: The lessons check left nothing to show it had happened

- What went wrong: the user asked for a formal process that checks lessons before decisions. The only process was a sentence in `CLAUDE.md` asking each session to re-read two files, and many general lessons had stayed "open" instead of becoming playbook steps.
- Why: a rule with no visible output can be skipped without anyone seeing it.
- Rule going forward: the check leaves a `Lessons checked:` line the user can read, and each rule named gets a result.
- Status: promoted to PLAYBOOK (The lessons check)

## 2026-11-09: An empty search of a CI log meant the download had failed

- What went wrong: `gh api .../logs` refused output holding escape sequences, so the log file was empty and a grep of it found nothing. That read as the line being absent.
- Why: the result of the search was read without checking its input.
- Rule going forward: show the input exists and has size before reading an empty search as an answer. `gh api` on job logs needs `--allow-escape-sequences`.
- Status: promoted to PLAYBOOK (Testing, step 9, second sighting)

## 2026-11-09: A cd in one Bash call moved the next one

- What went wrong: a `cd` inside a Bash call changed the working directory of the calls after it.
- Why: the main session's shell keeps a `cd` that succeeds inside the working directories.
- Rule going forward: use absolute paths or `git -C`.
- Status: promoted to PLAYBOOK (seen again 2026-11-09: a `cd` into `scripts/` moved the next call)

## 2026-11-09: A wider guard switched off an unrelated reset inside it

- What went wrong: RS-H-samesince widened `crossed`, which skips the whole start-over block. The block also held the check for a bigger compaction point, which has nothing to do with stale readings, so a 400k hook behind a 200k sibling asked nothing. `seenAt: now` could also move the saved value backward, since `now` is read before the lock. Copilot found both on PR #29, and tests on the old code reproduced both. No test here and no reviewer's report had covered a window change between two sibling hooks.
- Why: the guard was judged by the reason it was added for, not by everything it skips. The block's conditions were written as one `if`, so the unrelated one didn't stand out.
- Rule going forward: when a condition skips a block, list each thing the block does and ask whether the condition is about that thing. A value read before a lock can be older than the state under it: check what happens when two hooks land in the other order.
- Status: promoted to PLAYBOOK (Writing code, step 7)

## 2026-11-09: One edit in a batch failed and the commit in the same message still ran

- What went wrong: of several parallel Edits to `dev/release-state.md`, one failed because its text sat mid-paragraph. The commit sent in the same message ran anyway, so d54c4e9 had references to a section that wasn't there. 9284d1a fixed it.
- Why: calls sent together don't wait on each other, so nothing stopped the commit when an edit failed.
- Rule going forward: send a commit in a later message than the edits it depends on, or have the commit command check for the edited text first.
- Status: promoted to PLAYBOOK (Committing, seen twice)

## 2026-11-09: A new assertion failed for the wrong reason and looked like a pass

- What went wrong: the milestone test's new line used `S`, which that test's scope doesn't define. It failed on the old code with a ReferenceError, so "fails first" looked met until the list of failures was read. The check it was meant to add is a test gap, which passes on the old code.
- Why: the first run was read as a count of failures, not by each failure's reason.
- Rule going forward: read why each new test fails on the old code. A test for a gap proves itself by removing the code it guards.
- Status: promoted to PLAYBOOK (Testing, step 8)

## 2026-11-09: A fix for one regex left the same regex at three other sites

- What went wrong: the RS-H-addcommitdirs fix replaced the quadratic trailing-separator regex in `pathKey`. `folderKey` had the same line and could still stall session start, and `sameDir` and `nodeInside` had it too. Opus found `folderKey` in the review round.
- Why: the search that found the problem started from the function being fixed, not from the pattern.
- Rule going forward: after fixing a pattern, search the whole repo for that pattern before the first review.
- Status: promoted to PLAYBOOK (Writing code, step 6)

## 2026-11-09: A cost test's data never reached the branch it was guarding

- What went wrong: the count test for `addCommitDirs` still passed with the list cap removed. All its folders were settled, so each eviction stopped at the first one and the cost of a long list never showed (CONFIRMED by Opus and Fable, not re-run; 796 calls against 80,586 once the folders were unsettled, the second number also seen here).
- Why: the test was checked against the whole old code, which failed for another reason, and not against each part of the fix.
- Rule going forward: for a fix with two parts, remove each part alone and check that a test fails.
- Status: promoted to PLAYBOOK (Testing, step 8)

## 2026-11-09: A zip built a day before publishing went stale on its date

- What went wrong: the 0.6.2 zip was built and verified on 2026-11-08 and publishing waited until the next day. The checklist's date rule then meant a new commit, so that zip was dropped and the checks ran again on a new one. The session had told the user to publish before merging, and had to withdraw that advice.
- Why: the CHANGELOG date is inside the zip, and the date check sat at the end of the checklist, so nobody looked at it while giving the merge order.
- Rule going forward: before advising on release order, compare the CHANGELOG date with today. With the draft job, the release commit can carry the publish date, and any push to `main` before publishing replaces a draft that was already checked.
- Status: open

## 2026-11-09: A merge bundled into another yes was refused

- What went wrong: the session counted "Use the draft job" as the user's word to merge PR 26, because its message had said so. The app's permission check refused auto-merge as a merge without review. The merge was chained after a commit and push, so those didn't run either.
- Why: a yes to a plan isn't a yes to its one hard-to-undo step, and one long command fails as a whole.
- Rule going forward: ask for a merge, tag or publish by name, as its own question. Run it as its own command.
- Status: promoted to PLAYBOOK (Do not attempt)

## 2026-11-08: Reordering a delete made its list stale

- What went wrong: `release-draft.sh` was changed to create the new draft before deleting the old one. The list of drafts to delete was then read before the upload, so a draft published during the upload would have been deleted as a published release (CONFIRMED by Opus, round 2; the new test fails on the round 2 script).
- Why: the fix looked only at what happens when a step fails, not at what the longer gap between reading the list and acting on it allows.
- Rule going forward: when a fix puts a slow step between reading a thing and destroying it, look at the thing again just before destroying it. Read it into a variable first: `set -e` doesn't see a command that fails inside `[ "$(...)" = x ]` (round 3 found that in this fix).
- Status: open

## 2026-11-08: A throwaway test's negative checks passed because grep errored

- What went wrong: the fake-gh harness for `release-draft.sh` passed its "nothing was deleted or created" checks without checking anything. The pattern began with `-X DELETE`, so grep took it as an option and exited 2, and the check read that as "not found".
- Why: a check of the form `if grep ...; then fail` treats a broken grep the same as no match. The stderr line was the only sign.
- Rule going forward: `grep -- "$pattern"` for any pattern held in a variable. A harness of negative checks includes one control that must report a failure.
- Status: promoted to PLAYBOOK (Testing, step 9, second sighting)

## 2026-11-08: A promised report on a merge had nothing to trigger it

- What went wrong: after auto-merge was set on PR 25, the coordinating session said it would report back. The PR merged at 21:00:49Z and no report came, until the user asked what we were waiting for. When the user then asked for a fix, the session answered "No response requested", which was wrong.
- Why: the app wakes a session on CI failures, merge conflicts and review comments, and when a linked session ends a turn. A successful merge wakes nobody (CONFIRMED in the `set_monitor` tool description; no event arrived for PR 25). Sessions are also told not to poll CI. So the promise could not be kept.
- Rule going forward: never say "I'll report when X" unless something named will wake the session on X. A turn's closing line says who acts next and what triggers it.
- Status: promoted to PLAYBOOK

## 2026-11-08: Sessions that stopped or left the sidebar looked like lost work

- What went wrong: batch H's session ended on "Request timed out" during a review round, with its reviewer's report lost. Later it and batch W's session left the sidebar when their PRs merged, which looked like lost work. Separately, the coordinating session set auto-merge on PR 24 without telling batch H's session, which then questioned it.
- Why: no step said who resumes a session that ends on an error. The account setting "Auto-archive sessions when their pull request closes" was on. Nothing said to tell a branch's owner about a change made to its PR.
- Rule going forward: the session that started a session resumes it at once when it ends on an error, after checking that its branch and worktree are intact. A review whose report never arrived is run again, and sessions commit before a long review. Whoever changes another session's PR tells that session in the same step.
- Status: promoted to PLAYBOOK

## 2026-11-08: A read-only reviewer ran the sums script in the owner's worktree

- What went wrong: the 0.6.2 docs reviewer started `dev/release-check.sh --sums --quick`, which rewrites `SHA256SUMS`, in the worktree it was told not to change. It stopped the run itself, and nothing was left changed. Its finding 1 also did not reproduce: it took Windows' ENOENT for a path under a file as the answer for the file itself.
- Why: "read-only" named no commands, and `--sums` is the habit the project's docs teach. The finding came from a code comment, with no run behind it.
- Rule going forward: a review brief that says read-only names `dev/release-check.sh` as off limits. Reproduce a reviewer's finding before changing text for it, also when it is labeled CONFIRMED.
- Status: open

## 2026-11-08: A batch's changelog notes said more than the code does

- What went wrong: writing 0.6.2's CHANGELOG, two batch H notes didn't match the code. RS:658's note said setup "no longer writes through a link", while the batch's own re-check found the text was written nowhere and the change matters on Windows only. RS:638's note read as covering two hooks in general, while the fix covers only a record read with no `seenAt`.
- Why: the notes were written as a summary of the fixes, before the reviews narrowed what each one does.
- Rule going forward: write a CHANGELOG line from the merged code. A batch's note is a list of what to cover, not text to copy.
- Status: open

## 2026-11-08: A reviewer died on an API timeout and left its scratch worktree

- What went wrong: batch H's round 2 reviewer ended on "Request timed out" with no report. Its scratch worktree stayed registered in `git worktree list`.
- Why: a subagent that dies can't run its own cleanup.
- Rule going forward: when a reviewer fails, check that its report exists, remove its worktree and temp folder (`git worktree list`, then `git worktree remove --force`), and run the round again with a fresh one.
- Status: open

## 2026-11-08: An edit's trailing space was lost, twice

- What went wrong: batch H's Edit calls whose old and new text ended in a space shortened the line (`const listCmd =launcher`), and the fix for that moved the gap (`launcher ?` then a backtick). Both reviewers reported it.
- Why: a string ending in whitespace is not a safe edit anchor: the new text lost its trailing space.
- Rule going forward: an edit's old and new text end on a visible character.
- Status: open

## 2026-11-08: An assertion that something did not happen passed for the wrong reason

- What went wrong: batch H's `huge swept` test asserted a commit was not "found later". With the lookup it was meant to check broken, it still passed in 7 of 16 runs on Linux: the sweep reads only up to the current whole second, and the commit was in that second (Opus, review round 1).
- Why: the fail-first proof ran the whole test on the old code, where an earlier assertion failed first, so nothing showed this one could fail.
- Rule going forward: when a test holds several assertions, break the code each one guards, one at a time. An assertion that something didn't happen gets its own forced fault.
- Status: promoted to PLAYBOOK (Testing, step 8)

## 2026-11-08: Reviewers' proofs push out kept failed runs

- What went wrong: a review round's deliberate failures (a mutation per run) count against the 20 kept failed runs in the shared `trailmark-release-check` folder. Two reviewers reported older folders gone during their runs, three of them named (INFERRED: `prune_kept`; another session's run isn't ruled out).
- Why: every session and subagent on the machine shares that one cap, and a proof that fails on purpose looks like any other failed run.
- Rule going forward: when a failed run's output will be needed later, copy what matters out of that folder. To read a run's own output, take its folder from that run's summary, not from a listing of the shared folder.
- Status: open

## 2026-11-08: An exception to a skill's rule had no scope

- What went wrong: batch W added "if one of them says trailmark's path isn't written here, stop" after "other lines, such as a command's output or a note about a commit, don't count". "One of them" took in command output, and the stop applied even with a valid launcher note, so text a repo prints could switch off checkpoints (Opus, round 1).
- Why: the sentence came from a fix idea written for one case, and it was pinned by a test without walking the other cases the words reach.
- Rule going forward: before adding a sentence that changes what a model does, list every case its words cover, not only the one it was written for, and state its scope in the sentence. A test that pins exact text proves the text, not the behavior.
- Status: open

The entries below were seeded on 2026-11-07 from `dev/release-state.md`, `CLAUDE.md` and the project's saved notes. The 2026-11-07 entries from PR #10 came from the review-strategy session's messages and the speed-up session's notes. They were not re-run here.

## 2026-11-08: The Codex plugin page ignored `homepage`

- What went wrong: the ChatGPT app's page for trailmark-codex showed Website "Unavailable", though the manifests had set `homepage` since 0.5.x.
- Why: Codex returns the site as `interface.websiteUrl`, read from the manifest's `interface` block, and the app's Website row renders that value (CONFIRMED by Opus, not re-run). `homepage` is a separate field. The tests checked the manifests for name and version only, and `claude plugin validate --strict` doesn't read them: it passes with a corrupt Codex manifest (CONFIRMED).
- Rule going forward: when a Codex manifest changes, compare it with `plugin-creator/references/plugin-json-spec.md` under `~/.codex/.tmp/plugins` and look at the plugin's page in the app.
- Status: open

## 2026-11-08: A placeholder replace rewrote real tokens

- What went wrong: batch F's commit 2f5987b put its new commit's sha into `dev/release-state.md` with a global find-and-replace of a placeholder, `COMMIT`. It also rewrote every real `COMMIT` token in the file: `COMMIT_UNRESOLVED` became `bfa24ad_UNRESOLVED`, the "no COMMITS section" sign in "Load-sensitive tests" became "no bfa24adS section", 21 lines in all. The S5 session saw it on main, and the coordinating session confirmed it. Fixed in PR #20 from 2f5987b's own diff: only lines whose sole change was `COMMIT` to `bfa24ad`.
- Why: the placeholder was a word the file already used, and the commit went in without a look at its diff.
- Rule going forward: a placeholder that a replace fills in must be text that can't match real text (for example `@@SHA@@`), and the diff is read before the commit.
- Status: open

## 2026-11-08: Two sessions started the same four batch sessions

- What went wrong: the triage session asked the user "Push this branch as a dev-only PR, then start the four batch sessions?" in its own next-step box, and the coordinating session asked the same question. The user answered both. Each session then started D, F, O and S, so eight batch sessions ran at once, two per batch, writing the same files on separate branches (CONFIRMED by `list_sessions`, 01:17Z).
- Why: two sessions owned the same step, and neither checked the other's sessions before acting on a yes. A relayed approval arrives a turn late (the same cause as "A push went out before a batch instruction arrived").
- Rule going forward: one session owns each step that starts sessions or pushes. A side session reports and asks only its starter, never the user, about a step its starter owns. Before acting on a yes, `list_sessions {"linked": true}` checks whether that step has already been done.
- Status: promoted to PLAYBOOK (seen twice: relayed instructions arriving after the act)

## 2026-11-08: A size bound passed only on this machine's short paths

- What went wrong: batch F's F4 test asserted that 9 shortened notes fit in injectChars 2000. It passed here and failed on all 3 macOS and 2 Windows CI jobs (2,007 to 2,041 characters). The injection's cut note names the handoff's full path, and the memory path holds the temp path twice, so the framing grows with the temp folder. `TMPDIR=E:\DevTemp` is short. Reproduced here with 15 and 30 more characters of TMPDIR (2,016 to 2,059).
- Why: the bound was checked only with this machine's paths. The same "only checked here" blind spot as the POSIX error codes (above).
- Rule going forward: a test that bounds a text's size, where the text holds a path, is also run with a longer TMPDIR (`--only` with TMPDIR 30 characters longer) and keeps a margin.
- Status: promoted to PLAYBOOK (Writing code, step 3)

## 2026-11-07: Judged a CI cancel too early

- What went wrong: the coordinating session reported that `cancel-in-progress` didn't fire, after watching the older run for 3 minutes. GitHub had cancelled that run about 2.5 minutes after the newer run was created ("Canceling since a higher priority waiting request for tests-14 exists").
- Why: a run's status stays in_progress until every job has stopped, and the macOS and Windows jobs stop slowly.
- Rule going forward: judge a CI setting from the job list after it settles, not from the run status.
- Status: open

## 2026-11-07: A Windows-only check missed what POSIX returns

- What went wrong: batch F's F6 test (CODEX_HOME a file) passed here and would have failed on the 6 Linux and macOS CI jobs. Windows reports the cache under a file as missing (ENOENT), POSIX as not a folder (ENOTDIR), which F7 turned into a second reason. Opus found it in review round 1 by running the code in WSL.
- Why: the code and the test were checked only on Windows. The same blind spot as 0.6.0's F1 on 71d7a78 ("F1's test on Linux and macOS", `dev/release-state.md`).
- Rule going forward: a file-system error path lists what each system returns for it (ENOENT, ENOTDIR, EISDIR, EPERM, EACCES), and the test stubs the other systems' answer (`fs.opendirSync` throwing it) so every system runs the same check.
- Status: promoted to PLAYBOOK (second sighting)

## 2026-11-07: A control timed one step of the path that gives the sign

- What went wrong: batch F's commit-list control timed git's lookup alone (at least 900 ms), so a session start slowed before git (Opus's probe: 3.2 s before `sinceHandoff`) failed the test though only load was behind it. The first replacement, "each late session start took 1.2 s or more", sat 8 ms above the 1,192 ms a forced 0 ms budget's session start took at rest. The second (that floor plus a slow lookup) held at 8 and 16 busy loops only because the first of three starts came in under 1,200 ms (up to 1,184 ms); the duplicate batch-f-2 saw a whole-run floor let a forced 0 ms budget skip at 37 to 68% CPU (CONFIRMED by batch-f-2, not re-run). Fixed in batch F with the launcher's own report (`JBMEM_SHOW_SINCE=1`: time left, budget, git's time): a forced 0 ms budget then failed 14 of 14 at rest and under 16 and 32 busy loops.
- Why: the sign "git ran out of time" comes from the launcher's whole budget (`5000 - elapsed - 1500`, capped at 1.2 s), not from git alone. Any time measured from outside (whole runs, the test's own lookup) grows with load whatever the cause, so it can't tell load from a fault on a busy machine.
- Rule going forward: a time-sign control reads the product's own report of the time each step had and spent, and checks the budget arithmetic against it. Each forced fault is run at rest and under load, before it ships.
- Status: promoted to PLAYBOOK (third sighting, with the two entries below)

## 2026-11-07: A control's floor sat below what the control takes at rest

- What went wrong: batch F's commit-list tests skip when git ran out of time at three session starts in a row and a control (the same lookup, run in the test with 30 s) shows the machine is slow. The first floor, "the control took at least 300 ms", let a forced fault through: with the launcher's budget forced to 0 ms, all 14 tests skipped, since the same lookup took 300 to 744 ms on this machine at rest (other sessions' tests running).
- Why: the floor was a guess at "git is quick", not measured, and not tied to the budget the product had.
- Rule going forward: before choosing a control's bound, run the control at rest and under the forced fault, and tie the bound to the product's budget (here three quarters of the launcher's 1.2 s: the forced 0 ms budget then failed 13 of 14, and 16 busy loops skipped 14 of 14 with controls of 2.4 to 4.2 s).
- Status: promoted to PLAYBOOK (with the entry above, 2026-11-07)

## 2026-11-07: A script edited while a run of it was going

- What went wrong: in batch D, an edit to `dev/release-check.sh` landed while a background `--sums --quick` of it was still running. The run stopped with "syntax error near unexpected token" at a line that parses fine, and its result was lost. The same run's `--sums` had also reordered `SHA256SUMS` under the shell's UTF-8 locale (D4), which the coordinating session noticed in the worktree.
- Why: bash reads a script as it runs it, so an edit shifts the bytes under a running copy. A background check makes this easy to forget.
- Rule going forward: don't edit a script while a run of it is going. Wait for the run, or run a copy. A run that overlapped an edit doesn't count as a check: rerun it.
- Status: open

## 2026-11-07: A commit went in after a failed check (batch O)

- What went wrong: `release-check.sh --sums --quick 2>&1 | tail -9 && git commit ...` committed 8f7894c although the check printed FAIL (8 handoff-checks tests, the listed commit-list load sign; they passed 10 of 10 when rerun with `--only`). In the same batch the first `--sums` wrote `SHA256SUMS` in the locale's order, so 48 lines changed for 8 files (the review-strategy session caught it; batch D's D4).
- Why: a pipeline's status is its last command's, so `tail` hid the check's exit code. And `release-check.sh` sorts the list with a plain `sort`.
- Rule going forward: never chain a commit after a check piped into `tail` or `head`. Run the check, read its summary, then commit. D4 has landed (PR #17 sorts with `LC_ALL=C`); still check `git diff --stat -- SHA256SUMS` against the files you changed.
- Status: promoted to PLAYBOOK (Committing, seen twice)

## 2026-11-07: Escapes in a test's source didn't survive the edit (batch S)

- What went wrong: S1's new test in `codex.test.js` was written with `\u201c`, `\u202e` and similar escapes in an Edit call, and the file got the raw characters, a bidi override among them (Opus round 1, finding 5). A mutation probe's `sed` pattern with `\\u201e` lost its backslashes in a Bash heredoc, so the edit never applied and the test "passed" the mutation.
- Why: the edit tool wrote the escapes as the characters they name. The Bash tool collapses `\\` even in a quoted heredoc (PLAYBOOK's constraints).
- Rule going forward: build non-ASCII and backslash characters in test source with `String.fromCharCode`, and grep the diff for non-ASCII after writing it. A mutation probe checks that its edit applied (count the new text) before reading the result.
- Status: open

## 2026-11-07: The control was a cheaper call than the one it stood in for

- What went wrong: round 1's fix for the busy-lock skip ran the subagent hook as the lock-free control even when the commit hook was the one stopped. The subagent hook takes 30 to 40% of the commit hook's time, so under 24 to 30 busy loops the control would have failed the test on load alone (round 2, A). The same round found that F2's "five tries" also fired on time alone, since both copy walks share one budget (C: 2.4% to 90% of calls in a simulation).
- Why: the control was picked for convenience (one function for both calls), and the try count was picked without asking what else gives the same sign.
- Rule going forward: a control repeats the exact call it controls, with only the suspected cause removed. Before bounding a "can't tell" case by a try count, list every cause that gives that sign, simulate each at a few rates, and make the bound depend on evidence (here: any time reason seen in the window) rather than a count alone.
- Status: promoted to PLAYBOOK (Testing, step 7, 2026-11-07)

## 2026-11-07: A skip on the time sign hid faults that give the same sign

- What went wrong: two of the new load-proof helpers skipped on a fault, not only on load. Review round 1 of `claude/load-proof-tests` found both (F1, F2), and both were reproduced. `hookInTime` read a lock that hung the hook as "the machine is too slow" (with `updateState`'s wait at 20 s the busy-lock test skipped 2 of 2). `copiesInTime` repeated a session start cut short for a reason of its own until 30 s ran out, then skipped (1,708,788 tries in the probe).
- Why: a sign like "the hook was stopped" or "cut short" is what a slow machine shows, but a bug that makes the same call slow or stop shows it too. The every-call-late runs proved some test still fails, not that each skip fires only on load.
- Rule going forward: every skip on a time sign gets a control that only load passes, and a run with a forced non-time fault behind that sign (a hang, a throw) that must fail. Size the control from the budget arithmetic, not "it finished": the busy-lock control fails only when the lock-free run takes under the 9 s limit less the 2 s wait less 1 s. A plain "finished with the lock free" control would fail on a machine where hooks take 8 s, which brings the load sensitivity back.
- Status: promoted to PLAYBOOK (Testing, step 7, 2026-11-07)

## 2026-11-07: A quoted heredoc in the Bash tool still lost a backslash

- What went wrong: an edit script written with `cat > f <<'PYEOF'` in an inline Bash command had `\\n` in a Python literal. Python got `\n` (a real newline), so an anchor didn't match and the script stopped at its own assert before writing anything. A second pair would have written a real newline into a JS string.
- Why: the Bash tool collapses `\\` in the inline command before the shell sees it, quoted heredoc or not. CLAUDE.md says so ("Windows notes"), but only for inline commands in general.
- Rule going forward: any script holding a backslash goes through the Write tool, never a heredoc. The assert-before-write rule is what caught it.
- Status: promoted to PLAYBOOK (its first constraint covers it: a heredoc in the Bash tool is an inline command)

## 2026-11-07: The playbook pointed at an old version's checklist

- What went wrong: the first PLAYBOOK.md said to follow "Release checklist" in `dev/release-state.md`, but that heading appears once per version (0.6.0 at line 536, 0.5.1 at line 580), each with its own version numbers and paths. The docs reviewer caught it.
- Why: the heading was quoted without checking whether it was unique in the file.
- Rule going forward: before pointing a doc at a section by name, grep for the heading and check that it occurs once, or say which one.
- Status: open

## 2026-11-07: A subagent's test output landed on C:

- What went wrong: a review subagent's kept test output went to `C:\Users\willi\AppData\Local\Temp`, not the Dev Drive (`E:\DevTemp`). Reported by the review-strategy session (PR #10 round 5).
- Why: the subagent's Bash has TMPDIR on C:. The user's `TMPDIR=E:\DevTemp` doesn't reach it.
- Rule going forward: a brief that expects the Dev Drive sets `TMPDIR` itself.
- Status: promoted to PLAYBOOK

## 2026-11-07: A cleanup built only from variables was blocked

- What went wrong: `rm -rf "$B/$r"` was blocked by the safety check. Reported by the review-strategy session (PR #10 round 5).
- Why: an empty variable could expand the path toward the root.
- Rule going forward: delete by a literal path, or guard each variable with `${B:?}`.
- Status: open

## 2026-11-07: A reviewer used powershell.exe again

- What went wrong: a reviewer ran a read-only listing through `powershell.exe` instead of `pwsh` and redid it. This was the second slip across sessions. Reported by the review-strategy session.
- Why: the rule is in the user's global CLAUDE.md, but subagents only see their brief.
- Rule going forward: every review brief says to use `pwsh`.
- Status: promoted to PLAYBOOK

## 2026-11-07: A push went out before a batch instruction arrived

- What went wrong: c02207a (a record of the CI failure) was pushed while the coordinating session was writing that everything should go in one batch push with round 3. From the speed-up session's notes.
- Why: relayed instructions arrive a turn late, and Auto-fix had authorized the push itself.
- Rule going forward: while another session runs a review round on this branch, hold pushes for that round's batch unless the user says otherwise.
- Status: open

## 2026-11-07: Probes that measured themselves or the wrong thing

- What went wrong: four probe redos in one session (speed-up session's notes). `ps -ef | grep '[s]leep 26'` counted the probe's own inline command line, so a wait loop never ended. A `C:/...` scratch path in `PATH` split at the colon, so the fake `node` was never found. Git Bash rewrote `/mnt/c/...` arguments to `wsl.exe`. WSL's git couldn't read the worktree's Windows `gitdir`.
- Why: inline commands keep their text in the process list. MSYS treats `:` as the `PATH` separator and converts paths it passes to Windows programs. A worktree's `.git` file holds a Windows path.
- Rule going forward: write probes to script files, and check each probe's counts against a case with a known answer before trusting them. The MSYS and WSL facts are in PLAYBOOK's constraints.
- Status: promoted to PLAYBOOK

## 2026-11-07: Windows frees a stopped process's files late

- What went wrong: after a stop, the EXIT trap's single `rm -rf` left the stopped suite's temp folder in 4 of 5 runs, though no process of the suite was left (speed-up session's notes).
- Why: on Windows a terminated process gives back its file handles a moment after it is gone.
- Rule going forward: cleanup after stopping processes on Windows retries for a few seconds and says when it can't remove the folder.
- Status: promoted to PLAYBOOK

## 2026-11-07: A test's time budget was taken for a fault

- What went wrong: CI failed handoff-checks "copies: the command the note gives ..." once on windows-latest, Node 26 (5a1e1a4). Session start's copy check (`otherCopies`) ran past its 300 ms budget and said it stopped early, which the test didn't accept. The sign was not on the load-sensitive list. The first fix accepted "stopped early", and round 4 found it then also passed an early stop for a reason other than time. Reported by both PR #10 sessions.
- Why: the test checked only the success wording of a check with a time budget, and the loosened branches checked text that always comes with "stopped early".
- Rule going forward: a test that relies on a wall-clock budget handles the out-of-time path or forces the in-time path. When it accepts a designed early stop, it asserts the reason is the designed one, and a probe shows it fails on another reason (here `maxEntries` at 0). Reproduce a timing failure at the call that timed out (budget 0 at session start only), not everywhere: budget 0 everywhere moved the failure to another assertion.
- Status: open. The audit is done on `claude/load-proof-tests` (see "Load-proof tests" in `dev/release-state.md`): its rule held, and the three entries above add to it.

## 2026-11-07: A fix opened a hole next to it (`kill 0` and process groups)

- What went wrong: `release-check.sh`'s Ctrl-C trap ran `kill 0`. Started from another script, it killed that script too (Codex review, reproduced: the wrapper died with 143). PR #10 round 1 gave each suite its own process group (`set -m`). That stopped a terminal hangup (HUP) from reaching the suites, found in round 2 (CONFIRMED by the review-strategy session, not re-run: send HUP to the script's group, and the suites keep running). The stop then needed HUP, a bounded wait and the job table.
- Why: a script started without job control shares its caller's process group. Moving the children out of that group means every stopping signal has to be forwarded, and nobody listed what the old arrangement handled implicitly.
- Rule going forward: when a fix moves processes, files or signals, list what the old arrangement handled implicitly and test each. Never signal group 0 from a script that others call. Start background work in groups of its own, stop them for INT, TERM and HUP, read them from `jobs -rp`, bound the wait, and kill only groups still alive.
- Status: open

## 2026-11-07: Review rounds grew with every fix (PR #10)

- What went wrong: PR #10 (faster checks) took three review rounds in about an hour.
- Why: fixing INFERRED edge cases in `dev/` tooling grew each fix diff, and every relay hop through a coordinating session waited on a turn.
- Rule going forward: in `dev/` tooling, fix only CONFIRMED findings in the batch, and defer INFERRED ones with a repro unless they can change a test result. The owning session may run its review with fresh subagents.
- Status: open. The user approved it on 2026-11-07, to land in `CLAUDE.md` and `tests.yml` after PR #10 merges.

## 2026-11-06: Work stranded across sessions

- What went wrong: review reports sat untracked in worktrees, and a round-8 branch was never pushed. They were rescued into PR #7 by hand.
- Why: one session per item, with no step that checked the other sessions.
- Rule going forward: at each milestone, sweep every project session, branch, worktree and open PR. Every review brief names where its report lands.
- Status: promoted to PLAYBOOK

## 2026-11-06: Fix, scan, fix, scan never converged

- What went wrong: in 0.6.0 (PR #4), each approved scanner comment or finding added code that needed its own round. The user called it "an endless loop".
- Why: findings were fixed one at a time, and each push also cost about 42 minutes of testing (whole-file `--only` runs plus a full check that repeated them).
- Rule going forward: gather a round's findings and comments, fix them in one push, and review that diff once. Per push, run `--only` by test name, then `--sums --quick`, and leave the full suites to CI.
- Status: promoted to PLAYBOOK

## 2026-11-05: Test runs filled the temp folder

- What went wrong: `%TEMP%` held 3,071 `jbmem-*` folders.
- Why: plain `node --test` runs left the folders of failed tests in the system temp folder.
- Rule going forward: run single tests with `dev/release-check.sh --only`, never a plain `node --test`.
- Status: promoted to PLAYBOOK

## 2026-11-05: A timing comparison was confounded by run order

- What went wrong: a 0.6.0 comparison of two versions' timings pointed at the version, but the order of the runs decided which was slowest.
- Why: the runs went in a fixed order, so machine state lined up with one version.
- Rule going forward: alternate which version runs first (A B B A), and log CPU during the runs.
- Status: promoted to PLAYBOOK

## 2026-11-02: A failure was called "flaky"

- What went wrong: the `0.3.4 sweep` test failure was deferred as "flaky, cause hypothesized". The user rejected that.
- Why: the failure was parked without being reproduced or traced to code.
- Rule going forward: keep every run's output, loop the test under the failing conditions until it reproduces, and trace the assertion to code before labeling the cause CONFIRMED.
- Status: promoted to PLAYBOOK

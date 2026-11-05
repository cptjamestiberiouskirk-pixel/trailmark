#!/bin/bash
# Reproduces the git-timeout failures of three tests under load (0.6.0;
# dev/release-state.md, "Load-sensitive tests"): 16, 89 and 108 of the
# Codex trailmark.test.js (numbers at c7a194a) and the same tests in the
# Claude Code one. Clones the repo into a new folder at its HEAD
# (release-check.sh needs a repo) and runs the three tests in both copies
# three ways:
#   control: as cloned;
#   A: the launcher's two git-facts budgets (hook facts and commit facts)
#      cut from 5000 to 5 ms;
#   B: every git call in gitfacts.js made 500 ms slower, budgets as shipped
#      (a 2026-11-05 trace under load showed git calls about 420 ms apart).
# Prints result lines and the failing assertions only, no verdict. Changes
# nothing outside argv[2], which must not exist yet: sed and git checkout
# run only in the clone, and the real repo is only read (git clone). Each
# release-check.sh run gets TMPDIR=argv[2]/tmp, so it keeps its output under
# there and prunes nothing in the kept-output folder of the system temp
# (review round 8). On Windows argv[2] must be 80 characters or fewer as
# cygpath -m writes it (C:/...): the folder that holds a test's memory
# folder is about twice that length plus 83, and the sandbox refuses one
# past about 260 (dev/release-state.md, the long-path entry in the deferred
# list). Delete argv[2] yourself when done.
# Usage: bash dev/repro-git-timeout.sh <repo root> <new scratch folder>
set -u
REPO="$1"; W="$2"
[ -e "$W" ] && { echo "$W exists already"; exit 2; }
case "$W" in /*|[A-Za-z]:*) A="$W" ;; *) A="$PWD/$W" ;; esac
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*)
  # Measured in its Windows form (/tmp/x is C:/Users/<you>/AppData/Local/Temp/x),
  # the form the tests' paths are built from; as given where cygpath is
  # missing (round 8 on 91ca5c8).
  M=$(cygpath -m "$A" 2>/dev/null) && [ -n "$M" ] && A="$M"
  [ ${#A} -le 80 ] || { echo "$A is ${#A} characters: on Windows give a scratch folder of 80 or fewer"; exit 2; } ;;
esac
mkdir -p "$W/tree" "$W/out" "$W/tmp" || exit 2
# Absolute from here: the runs below work inside the clone, where a relative
# argv[2] would name another folder (Copilot on PR #4).
W=$(cd "$W" && pwd) || exit 2
HEAD=$(git -C "$REPO" rev-parse --short HEAD)
# A clone, not git archive: archive leaves out dev/ (export-ignore), and
# release-check.sh with it. The clone only reads the real repo.
git clone -q --no-hardlinks "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)" "$W/tree" || exit 2
cd "$W/tree" || exit 2
git checkout -q --detach "$HEAD" || exit 2
[ -f dev/release-check.sh ] || { echo "no dev/release-check.sh in the clone"; exit 2; }
echo "clone at $(git rev-parse --short HEAD) in $W/tree"
P='launcher: hooks run sandboxed with launcher-collected git facts|the PreCompact status runs no fsmonitor, hook or submodule git|commit in the same folder while a command ran is left to that session when git printed'
run() { # label, slug
  echo "== $1 ($(date +%H:%M:%S))"
  TMPDIR="$W/tmp" bash dev/release-check.sh --only "$P" > "$W/out/$2.txt" 2>&1
  grep -E '^(PASS|FAIL)' "$W/out/$2.txt" | sed 's/^/   /'
  kept=$(grep -o 'Output kept.*' "$W/out/$2.txt" | sed 's/.*): //')
  [ -n "$kept" ] && cp -R "$kept" "$W/out/$2-kept" && for t in "$kept"/*.tap; do
    echo "   -- $(basename "$t")"
    grep -E '^(not )?ok [0-9]+ - ' "$t" | cut -c1-110 | sed 's/^/   /'
    grep -A45 '^not ok' "$t" | grep -E "test\.js:[0-9]+:[0-9]+\)|did not match|the hook ran status: [0-9:. ]+|PRE_COMPACT|COMMIT_UNRESOLVED|^ +- [0-9:]+ COMMIT" | cut -c1-170 | sed 's/^/     /'
  done
  git checkout -q -- . && echo "   (clone restored: $(git status --porcelain | wc -l) changed files)"
}
run "control: as cloned" control

# A: 5 ms budgets. Each trailmark.js has the two lines once.
for c in trailmark trailmark-codex; do
  f=plugins/$c/scripts/trailmark.js
  n=$(grep -c 'budgetMs: Math.max(0, 5000 - (Date.now() - started))' "$f")
  sed -i 's/budgetMs: Math.max(0, 5000 - (Date.now() - started))/budgetMs: Math.max(0, 5 - (Date.now() - started))/' "$f"
  echo "A: $f, $n lines changed, $(grep -c 'budgetMs: Math.max(0, 5 - ' "$f") now at 5 ms"
done
run "A: git-facts budgets 5 ms" budget5ms

# B: each git call 500 ms slower, before its time left is worked out.
for c in trailmark trailmark-codex; do
  f=plugins/$c/scripts/lib/gitfacts.js
  sed -i 's/^  r\.run = (cwd, args, input) => {$/&\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); \/\/ scratch: slow git/' "$f"
  echo "B: $f, $(grep -c 'scratch: slow git' "$f") call sites slowed"
done
run "B: every git call 500 ms slower" slow500

echo "== done ($(date +%H:%M:%S)); outputs in $W/out"

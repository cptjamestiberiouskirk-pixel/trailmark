#!/usr/bin/env bash
# Every local release check in one run, with a one-screen summary.
#
#   dev/release-check.sh                 checks only
#   dev/release-check.sh --sums          regenerate SHA256SUMS first, then check
#   dev/release-check.sh --zip <dir>     also build <dir>/trailmark-<version>.zip
#                                        and its .sha256 from HEAD, and verify them
#   dev/release-check.sh --zip-only <dir>  check SHA256SUMS and build the zip, with
#                                        no other check (for the release-draft
#                                        job, which leaves the tests to tests.yml)
#   dev/release-check.sh --quick         skip the two long trailmark test suites
#   dev/release-check.sh --only <x>      run only the tests in file <x> (a path
#                                        from the repo's top folder), or else the
#                                        tests whose name matches the regular
#                                        expression <x> in every test file
#
# Run from anywhere inside the repo, in bash (Git Bash on Windows). It writes
# only SHA256SUMS (with --sums), its own temp folder (removed at the end), the
# zip folder you name and, when a test suite fails or --only runs, a folder
# under <temp>/trailmark-release-check with the suite's full TAP output and
# the folders its failed tests kept (the 20 newest failed runs' folders stay,
# and the 20 newest passing --only runs' apart from them). It
# makes no network requests. The test suites run at the same time, and each
# summary line gives the suite's own time.
#
# Each test has a limit, as in CI's test steps (enforce mode of
# .github/run-tests.sh). It ends two kinds of hang as a failure that names the
# test, and the suite goes on: a test that waits on something asynchronous,
# and a synchronous child call with no timeout of its own (the call fails with
# its command and line). Below Node 24 the first holds only for test() calls
# of the require('node:test') form (see .github/test-limits.js). A test
# blocked in its own code (a loop that never yields) is not ended, nor is a
# run whose test file has ended while a child it started still holds the
# file's output (stdio inherited): stop the run. A file whose tests pass but
# leave something open (a timer, a child) is let end, and its suite's line is
# followed by a WARN that names it.
# TRAILMARK_TEST_LIMIT_MS sets the limit in ms, up to 2147483647; the default
# is 400000, CI's limit on Windows, its largest; 0 runs the suites with no
# limit, with neither --test-force-exit nor the preload, so with no WARN
# either. The summary's first line names the limit (RS-T-localhang,
# dev/release-state.md).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

SUMS=0; QUICK=0; ZIPDIR=''; ONLY=''; ZIPONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sums) SUMS=1 ;;
    --quick) QUICK=1 ;;
    --zip) shift; ZIPDIR="${1:-}"; [ -n "$ZIPDIR" ] || { echo 'usage: --zip <dir>'; exit 2; } ;;
    --zip-only) shift; ZIPDIR="${1:-}"; ZIPONLY=1; [ -n "$ZIPDIR" ] || { echo 'usage: --zip-only <dir>'; exit 2; } ;;
    --only) shift; ONLY="${1:-}"; [ -n "$ONLY" ] || { echo 'usage: --only <test file or name pattern>'; exit 2; } ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
if [ -n "$ONLY" ] && { [ "$SUMS" = 1 ] || [ -n "$ZIPDIR" ]; }; then
  echo '--only runs tests alone: leave out --sums and --zip'; exit 2
fi
if [ "$ZIPONLY" = 1 ] && { [ "$SUMS" = 1 ] || [ "$QUICK" = 1 ]; }; then
  echo '--zip-only builds from HEAD as it is: leave out --sums and --quick'; exit 2
fi

T="$(mktemp -d 2>/dev/null || mktemp -d -t tmcheck)"
# Never go on without a temp folder: the cleanup below removes inside it.
[ -n "$T" ] && [ -d "$T" ] || { echo "no temp folder"; exit 2; }
# Retried: after a stop, Windows frees a stopped test's files a moment late.
clean_temp() {
  local i
  for i in 1 2 3 4 5; do
    rm -rf "$T" 2>/dev/null; [ -d "$T" ] || return 0; sleep 1
  done
  echo "could not remove $T" >&2
}
trap clean_temp EXIT
# Stopped (Ctrl-C, TERM or a hangup): stop the suites running in the background
# too, then clean up. Each suite runs in its own process group (set -m in
# start_suite), so this reaches the suites and their node processes, never
# whatever started this script: without job control a script shares its
# caller's group. The suites are read from the job table, which has a suite as
# soon as it starts; finished ones aren't listed. A suite still there after
# about 10 s is killed, and a second signal during the stop changes nothing.
# Then the script stops by the same signal, so a shell loop that runs it stops
# too (bash goes on with its loop after a child that only exited 130). A bash
# caller sees 128 + the signal's number; a Windows caller (pwsh, node) sees
# 256 times it (512 for INT).
stop_suites() { # status if the signal can't be raised again, the signal's name
  trap '' INT TERM HUP
  local groups p i alive
  jobs -rp > "$T/stopping" 2>/dev/null
  groups="$(cat "$T/stopping" 2>/dev/null)"
  for p in $groups; do kill -TERM -- "-$p" 2>/dev/null; done
  for (( i = 0; i < 50; i++ )); do
    alive=''
    for p in $groups; do kill -0 -- "-$p" 2>/dev/null && alive=1; done
    [ -z "$alive" ] && break
    sleep 0.2
  done
  # Only a group still there: a finished one's number may be in use again.
  if [ -n "$alive" ]; then
    for p in $groups; do kill -0 -- "-$p" 2>/dev/null && kill -KILL -- "-$p" 2>/dev/null; done
  fi
  # Let them end before the EXIT trap removes their folders.
  wait 2>/dev/null
  clean_temp; trap - EXIT "$2"
  kill -s "$2" $$
  exit "$1"
}
trap 'stop_suites 130 INT' INT
trap 'stop_suites 143 TERM' TERM
trap 'stop_suites 129 HUP' HUP
# Kept output goes next to $T, not inside it, so it outlives the run.
KEEPROOT="$(dirname "$T")/trailmark-release-check"
KEEP=''
export TMPDIR="$T"
# Node on Windows takes its temp folder from TEMP and TMP, not TMPDIR.
if command -v cygpath >/dev/null 2>&1; then TW="$(cygpath -w "$T")"; export TEMP="$TW" TMP="$TW"; fi
# The per-test limit, given to node --test as run-tests.sh gives it in enforce
# mode (see there for each part): --test-timeout on Node 24 and later, and on
# Node 22, where it would limit each file as a whole, the preload's own
# timeout for each test() call in its place; --test-force-exit, so a file
# whose test was ended doesn't wait on what that test left open; and the
# preload, which limits each synchronous child call with no timeout of its own.
# --zip-only runs no test, so it reads no limit and needs no node here.
LIMIT_FLAGS=()
LIMIT_SAID=''
if [ "$ZIPONLY" = 1 ]; then
  LIMIT_MS=0
else
  LIMIT_MS="${TRAILMARK_TEST_LIMIT_MS-400000}"
  # Digits only, at most 10 of them after leading zeros, and at most
  # 2147483647, the largest timeout Node takes (with a larger one node --test
  # throws ERR_OUT_OF_RANGE before any test file starts, on Node 26). Read as
  # decimal: 007 is 7.
  limit_digits="${LIMIT_MS#"${LIMIT_MS%%[!0]*}"}"
  case "$LIMIT_MS" in
    ''|*[!0-9]*) limit_bad=1 ;;
    *) limit_bad=0; [ ${#limit_digits} -gt 10 ] && limit_bad=1; [ $limit_bad = 0 ] && [ -n "$limit_digits" ] && [ "$limit_digits" -gt 2147483647 ] && limit_bad=1 ;;
  esac
  if [ $limit_bad = 1 ]; then
    echo "TRAILMARK_TEST_LIMIT_MS must be a whole number of ms from 0 (no limit) to 2147483647, not '$LIMIT_MS'"; exit 2
  fi
  LIMIT_MS="${limit_digits:-0}"
  if [ "$LIMIT_MS" -gt 0 ]; then LIMIT_SAID="per-test limit $LIMIT_MS ms"; else LIMIT_SAID='no per-test limit'; fi
fi
if [ "$LIMIT_MS" -gt 0 ]; then
  if [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]; then
    LIMIT_FLAGS=(--test-timeout="$LIMIT_MS"); export TRAILMARK_TEST_LIMIT_OPTION=0
  else
    export TRAILMARK_TEST_LIMIT_OPTION=1
  fi
  LIMIT_FLAGS+=(--test-force-exit --require ./.github/test-limits.js)
  export TRAILMARK_TEST_LIMIT_MS="$LIMIT_MS"
else
  # No limit: the preload is not loaded, and nothing passes one on.
  unset TRAILMARK_TEST_LIMIT_MS TRAILMARK_TEST_LIMIT_OPTION
fi
RESULTS=()
FAILED=0
record() { RESULTS+=("$(printf '%-4s  %s' "$1" "$2")"); if [ "$1" = FAIL ]; then FAILED=1; fi; return 0; }
# A path to print: C:/Users/... form on Windows, so bash and Windows tools both take it.
shown() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

heading() {
  echo "release-check${ONLY:+ --only $ONLY} at $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' (uncommitted changes)')${LIMIT_SAID:+, $LIMIT_SAID}"
}
# This run's folder for kept output, made on first use, with what was run
# where in run.txt. A passing --only run's folder is marked as it is made, so
# a prune in another run at that moment doesn't count it as failed.
keep_dir() { # 1 if the suite passed
  [ -n "$KEEP" ] && return 0
  KEEP="$KEEPROOT/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$KEEP" || { KEEP=''; return 1; }
  if [ "$1" = 1 ]; then : > "$KEEP/passed"; fi
  { heading; echo "commit $(git rev-parse HEAD)"; echo "started $(date)"; } > "$KEEP/run.txt"
  return 0
}
# The 20 newest failed runs' folders under $KEEPROOT stay, and apart from them
# the 20 newest passing --only runs' (marked by a file named passed), so a
# series of --only runs can't push out a failure's output. A folder without
# the mark counts as failed.
prune_kept() {
  local d i passed=() failed=()
  for d in "$KEEPROOT"/[0-9]*-[0-9]*-[0-9]*; do
    [ -d "$d" ] || continue
    if [ -e "$d/passed" ]; then passed+=("$d"); else failed+=("$d"); fi
  done
  for (( i = 0; i < ${#passed[@]} - 20; i++ )); do rm -rf -- "${passed[i]}"; done
  for (( i = 0; i < ${#failed[@]} - 20; i++ )); do rm -rf -- "${failed[i]}"; done
  return 0
}
# Keep a suite's full output and the folders its failed tests kept (they are
# in the suite's own folder in $T, which goes at the end of the run).
keep_suite() { # slug, output, the suite's folder, 1 if the suite passed
  keep_dir "$4" || { echo "      could not make $(shown "$KEEPROOT") to keep the output" >> "$T/failures"; return 0; }
  printf '%s\n' "$2" > "$KEEP/$1.tap"
  prune_kept
  local d
  for d in "$3/tmp"/jbmem-*; do
    [ -e "$d" ] || continue
    mkdir -p "$KEEP/$1-folders"
    mv "$d" "$KEEP/$1-folders/" 2>/dev/null || cp -R "$d" "$KEEP/$1-folders/" 2>/dev/null \
      || echo "      could not keep $(basename "$d")" >> "$T/failures"
  done
}
# The test suites run at the same time, each in its own temp folder under $T
# (s1, s2, ...: short, since a test's paths repeat it), so the folders a
# suite's failed tests kept are told apart from the others'.
# start_suite starts one in the background; finish_suites waits for them all
# and reports each in the order started.
SUITES=()
start_suite() { # name, slug for the kept output, then node --test arguments
  local name="$1" slug="$2"; shift 2
  local d="$T/s$(( ${#SUITES[@]} + 1 ))"; mkdir -p "$d/tmp"
  printf '%s\n' "$slug" > "$d/slug"
  printf '%s\n' "$name" > "$d/name"
  local dt="$d/tmp"; command -v cygpath >/dev/null 2>&1 && dt="$(cygpath -w "$d/tmp")"
  # Job control on just for this start: the suite gets a process group of its
  # own, which stop_suites stops.
  set -m
  (
    export TMPDIR="$d/tmp" TEMP="$dt" TMP="$dt"
    s=$(date +%s)
    # TAP named: newer Node prints the spec reporter even into a pipe.
    node --test --test-reporter=tap ${LIMIT_FLAGS[@]+"${LIMIT_FLAGS[@]}"} "$@" > "$d/out" 2>&1
    echo $(( $(date +%s) - s )) > "$d/secs"
  ) &
  set +m
  SUITES+=("$d")
}
finish_suites() {
  wait
  local d
  for d in ${SUITES[@]+"${SUITES[@]}"}; do
    report_suite "$(cat "$d/name")" "$(cat "$d/slug")" "$d" "$(cat "$d/secs" 2>/dev/null)"
  done
  SUITES=()
}
report_suite() { # name, slug, the suite's folder, seconds
  local name="$1" slug="$2" dir="$3" secs="${4:-?}" out; out="$(cat "$dir/out")"
  local tests pass fail skip cancelled
  tests="$(sed -n 's/^# tests //p' <<<"$out" | tail -1)"; pass="$(sed -n 's/^# pass //p' <<<"$out" | tail -1)"
  fail="$(sed -n 's/^# fail //p' <<<"$out" | tail -1)"; skip="$(sed -n 's/^# skipped //p' <<<"$out" | tail -1)"
  # A test the limit ended is counted as cancelled, not failed (Node 26 with
  # --test-timeout: "# fail 0", "# cancelled 3"), so a cancelled test fails
  # the suite too (RS-T-localhang).
  cancelled="$(sed -n 's/^# cancelled //p' <<<"$out" | tail -1)"
  if [ -n "$cancelled" ] && [ "$cancelled" != 0 ]; then fail=$(( ${fail:-0} + cancelled )); fi
  # A file in which no test ran (--only with a name) is listed as one passing
  # test named by the file's path: not a test.
  local empty; empty="$(grep -cE '^ok [0-9]+ - .*\.test\.js$' <<<"$out")"
  [ -n "$tests" ] && tests=$((tests - empty)); [ -n "$pass" ] && pass=$((pass - empty))
  local ok=0
  if [ "${fail:-1}" = 0 ] && [ "${tests:-0}" != 0 ]; then ok=1; record PASS "$name: $pass/$tests pass, $skip skipped ($secs s)"
  elif [ "${tests:-}" = 0 ]; then record FAIL "$name: no test ran ($secs s)"
  else record FAIL "$name: ${fail:-?} failed of ${tests:-?}$( [ -n "$cancelled" ] && [ "$cancelled" != 0 ] && echo ", $cancelled of them cancelled (the per-test limit, or a test ended early)") ($secs s)"; fi
  [ $ok = 1 ] || grep -E '^not ok' <<<"$out" | head -5 | sed "s|^|      $slug: |" >> "$T/failures"
  # --test-force-exit lets a file end with handles still open; the preload
  # names them on stderr (.github/test-limits.js), which CI turns into a
  # warning (tap-annotate.js). Here it is a WARN after the suite's line that
  # names each such file and what it left. node --test writes each line of a
  # file's stderr as a TAP comment with its `#` escaped, so the preload's line
  # is `# \# trailmark-test-limits: open at exit in ...`. When the file's last
  # stderr write had no newline, node --test joins that text in front of it
  # (`# progress 50%\# trailmark-test-limits: ...`), so the escaped text
  # counts anywhere in a top-level comment line. Any such line that holds the
  # escaped text counts too: a test's output, a top-level test's name (its
  # `# Subtest:` line) or a t.diagnostic() text. A plain mention of
  # `trailmark-test-limits:`, with no `\#` before it, does not count, nor does
  # an indented line (CI's tap-annotate.js counts the text anywhere). Some test
  # files leave a child or a write open today (CI on main names them too, run
  # 45013849055), so a passing full run can show this WARN. awk joins the
  # names, so a `;` in a name is kept, and a list over 300 characters is cut
  # and ends in "..." (under a C locale gawk counts bytes, and the cut can
  # split a UTF-8 character).
  local open n
  open="$(sed -n 's/^# .*\\# trailmark-test-limits: open at exit in //p' <<<"$out" | sed 's|\\#|#|g; s|^.*[\\/]||')"
  if [ -n "$open" ]; then
    n="$(grep -c . <<<"$open")"
    record WARN "$name: $n test file(s) left something open at exit: $(awk 'NR > 1 { s = s "; " } { s = s $0 } END { if (length(s) > 300) s = substr(s, 1, 297) "..."; print s }' <<<"$open")"
  fi
  # Kept when the suite failed, and always with --only: a skip's reason is in it too.
  if [ $ok = 0 ] || [ -n "$ONLY" ]; then keep_suite "$slug" "$out" "$dir" $ok; fi
  rm -rf "$dir" 2>/dev/null
}
summary() {
  echo
  heading
  printf '%s\n' ${RESULTS[@]+"${RESULTS[@]}"}
  [ -f "$T/failures" ] && cat "$T/failures"
  [ -n "$KEEP" ] && echo "Output kept (full TAP, and the folders failed tests kept): $(shown "$KEEP")"
  return 0
}
HC=(plugins/trailmark/tests/handoff-checks.test.js plugins/trailmark-codex/tests/handoff-checks.test.js)
# Each copy's other test files (CI picks them the same way).
TCC=(); TCX=()
for f in plugins/trailmark/tests/*.test.js; do [ "${f##*/}" = handoff-checks.test.js ] || TCC+=("$f"); done
for f in plugins/trailmark-codex/tests/*.test.js; do [ "${f##*/}" = handoff-checks.test.js ] || TCX+=("$f"); done
# Two files at a time in each trailmark suite, and in --only across every
# file. Measured 2026-11-06 on 16 cores (dev/release-state.md, "Faster local
# checks"): all files at once took 4.5 min but one full check in two failed a
# load-sensitive test, and three at a time skipped one in every run. Two at a
# time took 6.5 to 7 min: in three runs nothing failed and that test skipped
# once, in one copy.
AT_ONCE=2

# --only: the one suite file or the matching tests, and nothing else.
if [ -n "$ONLY" ]; then
  if [ -f "$ONLY" ]; then start_suite "--only $ONLY" only "$ONLY"
  else start_suite "--only (tests named like /$ONLY/, every test file)" only --test-concurrency=$AT_ONCE --test-name-pattern="$ONLY" "${HC[@]}" ${TCC[@]+"${TCC[@]}"} ${TCX[@]+"${TCX[@]}"}; fi
  finish_suites
  summary
  exit $FAILED
fi

# Files kept out of the release zip (export-ignore in .gitattributes) are
# left out of SHA256SUMS too, so the zip's own list verifies. Sorted bytewise
# (LC_ALL=C): a UTF-8 locale's order would rewrite the file with every --sums.
sums_list() {
  git ls-files | grep -v '^SHA256SUMS$' | git check-attr --stdin export-ignore \
    | grep -v ': export-ignore: set$' | sed 's/: export-ignore: .*$//' | LC_ALL=C sort | sed 's|^|./|'
}
if [ "$SUMS" = 1 ]; then sums_list | xargs sha256sum > SHA256SUMS; fi
if sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1 && [ "$(sums_list | wc -l)" = "$(wc -l < SHA256SUMS)" ]; then
  record PASS 'SHA256SUMS matches the files (and lists them all)'
else
  record FAIL 'SHA256SUMS is stale: run with --sums after staging your change'
fi

build_zip() {
  if [ -n "$(git status --porcelain)" ]; then
    record FAIL 'zip not built: the working tree has uncommitted changes (the zip is built from HEAD)'
  else
    ver="$(node -p "require('./plugins/trailmark/.claude-plugin/plugin.json').version")"
    mkdir -p "$ZIPDIR"; z="$ZIPDIR/trailmark-$ver.zip"
    # git archive writes each entry's DOS date and time in local time, so the
    # bytes follow the time zone. The release job runs in UTC: TZ=UTC here gives
    # its bytes on this PC at UTC-5 too (RS-T-ziptz).
    TZ=UTC git archive --format=zip --prefix=trailmark/ HEAD > "$z"
    (cd "$ZIPDIR" && sha256sum "trailmark-$ver.zip" > "trailmark-$ver.zip.sha256")
    mkdir "$T/zip" && (cd "$T/zip" && unzip -q "$z")
    if (cd "$T/zip/trailmark" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) && [ "$(find "$T/zip" -type l | wc -l)" = 0 ]; then
      record PASS "zip $(basename "$z") from $(git rev-parse --short HEAD): inner sums verify, no links"
      record INFO "sha256 $(cut -d' ' -f1 "$z.sha256")"
      record INFO "commit $(git rev-parse HEAD)"
    else record FAIL 'zip: inner SHA256SUMS or link check failed'; fi
  fi
}

# --zip-only: stale sums build nothing, and the other checks don't run.
if [ "$ZIPONLY" = 1 ]; then
  if [ "$FAILED" = 0 ]; then build_zip; fi
  summary
  exit $FAILED
fi

bash -n install.sh && record PASS 'install.sh parses' || record FAIL 'install.sh does not parse'
if node --check tools/migrate-from-jb-memory.js && node tools/migrate-from-jb-memory.js --help >/dev/null; then
  record PASS 'migration script parses and --help runs'
else record FAIL 'migration script'; fi

if out="$(bash dev/lessons.sh --check)"; then record PASS "LESSONS.md format: $(tail -1 <<<"$out")"
else record FAIL "LESSONS.md format: $(head -1 <<<"$out" | cut -c1-90)"; fi

# The shared-file list is read from CI, so the two can't drift apart.
SHARED="$(sed -n 's/^ *for f in \(.*\); do$/\1/p' .github/workflows/tests.yml | head -1)"
bad=''
for f in $SHARED; do cmp -s "plugins/trailmark/$f" "plugins/trailmark-codex/$f" || bad="$bad $f"; done
[ -z "$SHARED" ] && record FAIL 'shared-file list not found in tests.yml' \
  || { [ -z "$bad" ] && record PASS "shared files identical ($(echo $SHARED | wc -w))" || record FAIL "shared files differ:$bad"; }

# Each workflow job has its own time limit (RS-D-jobtimeout).
if out="$(node dev/check-workflow-timeouts.js 2>&1)"; then record PASS "workflow jobs have timeout-minutes ($(grep -c ' jobs (' <<<"$out") files)"
else
  why="$(grep -m1 -E '^(FAULT |self-test FAIL|no workflow)' <<<"$out")"
  [ -n "$why" ] || why="$(grep -m1 'Error' <<<"$out" | cut -c1-120)"
  record FAIL "workflow timeouts: ${why:-no fault line; last line: $(tail -1 <<<"$out")}"
fi

for c in trailmark trailmark-codex; do
  out="$(node plugins/$c/scripts/trailmark.js --sandbox-check 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then record FAIL "$c sandbox check"
  elif grep -q WARN <<<"$out"; then record WARN "$c sandbox check: $(grep -m1 WARN <<<"$out" | sed 's/^ *WARN *//' | cut -c1-90)"
  else record PASS "$c sandbox check"; fi
done

start_suite 'handoff-checks (both copies)' handoff-checks "${HC[@]}"
if [ "$QUICK" = 0 ]; then
  start_suite "trailmark tests (Claude Code, ${#TCC[@]} files)" trailmark-claude-code --test-concurrency=$AT_ONCE ${TCC[@]+"${TCC[@]}"}
  start_suite "trailmark tests (Codex, ${#TCX[@]} files)" trailmark-codex --test-concurrency=$AT_ONCE ${TCX[@]+"${TCX[@]}"}
fi
finish_suites
[ "$QUICK" = 1 ] && record SKIP 'trailmark test suites (--quick)'

if command -v claude >/dev/null 2>&1; then
  v=1; for d in . plugins/trailmark plugins/trailmark-codex; do claude plugin validate --strict "$d" >/dev/null 2>&1 || v=0; done
  [ $v = 1 ] && record PASS 'claude plugin validate --strict (3 manifests)' || record FAIL 'claude plugin validate --strict'
else record SKIP 'claude plugin validate (claude not on PATH)'; fi

if [ -n "$ZIPDIR" ]; then build_zip; fi

summary
exit $FAILED

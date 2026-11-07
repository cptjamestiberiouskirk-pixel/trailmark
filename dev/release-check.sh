#!/usr/bin/env bash
# Every local release check in one run, with a one-screen summary.
#
#   dev/release-check.sh                 checks only
#   dev/release-check.sh --sums          regenerate SHA256SUMS first, then check
#   dev/release-check.sh --zip <dir>     also build <dir>/trailmark-<version>.zip
#                                        and its .sha256 from HEAD, and verify them
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
# the folders its failed tests kept (the 20 newest such folders stay). It
# makes no network requests. The test suites run at the same time, and each
# summary line gives the suite's own time.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

SUMS=0; QUICK=0; ZIPDIR=''; ONLY=''
while [ $# -gt 0 ]; do
  case "$1" in
    --sums) SUMS=1 ;;
    --quick) QUICK=1 ;;
    --zip) shift; ZIPDIR="${1:-}"; [ -n "$ZIPDIR" ] || { echo 'usage: --zip <dir>'; exit 2; } ;;
    --only) shift; ONLY="${1:-}"; [ -n "$ONLY" ] || { echo 'usage: --only <test file or name pattern>'; exit 2; } ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
if [ -n "$ONLY" ] && { [ "$SUMS" = 1 ] || [ -n "$ZIPDIR" ]; }; then
  echo '--only runs tests alone: leave out --sums and --zip'; exit 2
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
# Stopped (Ctrl-C or TERM): stop the suites running in the background too, then
# clean up. Each suite runs in its own process group (set -m in start_suite), so
# this reaches the suites and their node processes, never whatever started this
# script: without job control a script shares its caller's group.
SUITE_PIDS=()
stop_suites() {
  local p
  for p in "${SUITE_PIDS[@]}"; do kill -TERM -- "-$p" 2>/dev/null; done
  # Let them end before the EXIT trap removes their folders.
  wait 2>/dev/null
  exit 130
}
trap stop_suites INT TERM
# Kept output goes next to $T, not inside it, so it outlives the run.
KEEPROOT="$(dirname "$T")/trailmark-release-check"
KEEP=''
export TMPDIR="$T"
# Node on Windows takes its temp folder from TEMP and TMP, not TMPDIR.
if command -v cygpath >/dev/null 2>&1; then TW="$(cygpath -w "$T")"; export TEMP="$TW" TMP="$TW"; fi
RESULTS=()
FAILED=0
record() { RESULTS+=("$(printf '%-4s  %s' "$1" "$2")"); if [ "$1" = FAIL ]; then FAILED=1; fi; return 0; }
# A path to print: C:/Users/... form on Windows, so bash and Windows tools both take it.
shown() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

heading() {
  echo "release-check${ONLY:+ --only $ONLY} at $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' (uncommitted changes)')"
}
# This run's folder for kept output, made on first use, with what was run
# where in run.txt. Only the 20 newest run folders under $KEEPROOT stay, so
# a failure stays through a few reruns of the test with --only.
keep_dir() {
  [ -n "$KEEP" ] && return 0
  KEEP="$KEEPROOT/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$KEEP" || { KEEP=''; return 1; }
  { heading; echo "commit $(git rev-parse HEAD)"; echo "started $(date)"; } > "$KEEP/run.txt"
  local old=("$KEEPROOT"/[0-9]*-[0-9]*-[0-9]*) i
  for (( i = 0; i < ${#old[@]} - 20; i++ )); do rm -rf -- "${old[i]}"; done
  return 0
}
# Keep a suite's full output and the folders its failed tests kept (they are
# in the suite's own folder in $T, which goes at the end of the run).
keep_suite() { # slug, output, the suite's folder
  keep_dir || { echo "      could not make $(shown "$KEEPROOT") to keep the output" >> "$T/failures"; return 0; }
  printf '%s\n' "$2" > "$KEEP/$1.tap"
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
    node --test --test-reporter=tap "$@" > "$d/out" 2>&1
    echo $(( $(date +%s) - s )) > "$d/secs"
  ) &
  SUITE_PIDS+=("$!")
  set +m
  SUITES+=("$d")
}
finish_suites() {
  wait
  SUITE_PIDS=()
  local d
  for d in "${SUITES[@]}"; do
    report_suite "$(cat "$d/name")" "$(cat "$d/slug")" "$d" "$(cat "$d/secs" 2>/dev/null)"
  done
  SUITES=()
}
report_suite() { # name, slug, the suite's folder, seconds
  local name="$1" slug="$2" dir="$3" secs="${4:-?}" out; out="$(cat "$dir/out")"
  local tests pass fail skip
  tests="$(sed -n 's/^# tests //p' <<<"$out" | tail -1)"; pass="$(sed -n 's/^# pass //p' <<<"$out" | tail -1)"
  fail="$(sed -n 's/^# fail //p' <<<"$out" | tail -1)"; skip="$(sed -n 's/^# skipped //p' <<<"$out" | tail -1)"
  # A file in which no test ran (--only with a name) is listed as one passing
  # test named by the file's path: not a test.
  local empty; empty="$(grep -cE '^ok [0-9]+ - .*\.test\.js$' <<<"$out")"
  [ -n "$tests" ] && tests=$((tests - empty)); [ -n "$pass" ] && pass=$((pass - empty))
  local ok=0
  if [ "${fail:-1}" = 0 ] && [ "${tests:-0}" != 0 ]; then ok=1; record PASS "$name: $pass/$tests pass, $skip skipped ($secs s)"
  elif [ "${tests:-}" = 0 ]; then record FAIL "$name: no test ran ($secs s)"
  else record FAIL "$name: ${fail:-?} failed of ${tests:-?} ($secs s)"; fi
  [ $ok = 1 ] || grep -E '^not ok' <<<"$out" | head -5 | sed "s|^|      $slug: |" >> "$T/failures"
  # Kept when the suite failed, and always with --only: a skip's reason is in it too.
  if [ $ok = 0 ] || [ -n "$ONLY" ]; then keep_suite "$slug" "$out" "$dir"; fi
  rm -rf "$dir" 2>/dev/null
}
summary() {
  echo
  heading
  printf '%s\n' "${RESULTS[@]}"
  [ -f "$T/failures" ] && cat "$T/failures"
  [ -n "$KEEP" ] && echo "Output kept (full TAP, and the folders failed tests kept): $(shown "$KEEP")"
  return 0
}
HC=(plugins/trailmark/tests/handoff-checks.test.js plugins/trailmark-codex/tests/handoff-checks.test.js)
# Each copy's other test files (CI picks them the same way).
TCC=(); TCX=()
for f in plugins/trailmark/tests/*.test.js; do [ "${f##*/}" = handoff-checks.test.js ] || TCC+=("$f"); done
for f in plugins/trailmark-codex/tests/*.test.js; do [ "${f##*/}" = handoff-checks.test.js ] || TCX+=("$f"); done

# --only: the one suite file or the matching tests, and nothing else.
if [ -n "$ONLY" ]; then
  if [ -f "$ONLY" ]; then start_suite "--only $ONLY" only "$ONLY"
  else start_suite "--only (tests named like /$ONLY/, every test file)" only --test-name-pattern="$ONLY" "${HC[@]}" "${TCC[@]}" "${TCX[@]}"; fi
  finish_suites
  summary
  exit $FAILED
fi

# Files kept out of the release zip (export-ignore in .gitattributes) are
# left out of SHA256SUMS too, so the zip's own list verifies.
sums_list() {
  git ls-files | grep -v '^SHA256SUMS$' | git check-attr --stdin export-ignore \
    | grep -v ': export-ignore: set$' | sed 's/: export-ignore: .*$//' | sort | sed 's|^|./|'
}
if [ "$SUMS" = 1 ]; then sums_list | xargs sha256sum > SHA256SUMS; fi
if sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1 && [ "$(sums_list | wc -l)" = "$(wc -l < SHA256SUMS)" ]; then
  record PASS 'SHA256SUMS matches the files (and lists them all)'
else
  record FAIL 'SHA256SUMS is stale: run with --sums after staging your change'
fi

bash -n install.sh && record PASS 'install.sh parses' || record FAIL 'install.sh does not parse'
if node --check tools/migrate-from-jb-memory.js && node tools/migrate-from-jb-memory.js --help >/dev/null; then
  record PASS 'migration script parses and --help runs'
else record FAIL 'migration script'; fi

# The shared-file list is read from CI, so the two can't drift apart.
SHARED="$(sed -n 's/^ *for f in \(.*\); do$/\1/p' .github/workflows/tests.yml | head -1)"
bad=''
for f in $SHARED; do cmp -s "plugins/trailmark/$f" "plugins/trailmark-codex/$f" || bad="$bad $f"; done
[ -z "$SHARED" ] && record FAIL 'shared-file list not found in tests.yml' \
  || { [ -z "$bad" ] && record PASS "shared files identical ($(echo $SHARED | wc -w))" || record FAIL "shared files differ:$bad"; }

for c in trailmark trailmark-codex; do
  out="$(node plugins/$c/scripts/trailmark.js --sandbox-check 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then record FAIL "$c sandbox check"
  elif grep -q WARN <<<"$out"; then record WARN "$c sandbox check: $(grep -m1 WARN <<<"$out" | sed 's/^ *WARN *//' | cut -c1-90)"
  else record PASS "$c sandbox check"; fi
done

# Two files at a time in each trailmark suite. Measured 2026-11-06 on 16
# cores (dev/release-state.md, "Faster local checks"): all files at once took
# 4.5 min but one full check in two failed a load-sensitive test, and three
# at a time skipped one in every run. Two at a time took 6.5 to 7 min: in
# three runs nothing failed and that test skipped once, in one copy.
AT_ONCE=2
start_suite 'handoff-checks (both copies)' handoff-checks "${HC[@]}"
if [ "$QUICK" = 0 ]; then
  start_suite "trailmark tests (Claude Code, ${#TCC[@]} files)" trailmark-claude-code --test-concurrency=$AT_ONCE "${TCC[@]}"
  start_suite "trailmark tests (Codex, ${#TCX[@]} files)" trailmark-codex --test-concurrency=$AT_ONCE "${TCX[@]}"
fi
finish_suites
[ "$QUICK" = 1 ] && record SKIP 'trailmark test suites (--quick)'

if command -v claude >/dev/null 2>&1; then
  v=1; for d in . plugins/trailmark plugins/trailmark-codex; do claude plugin validate --strict "$d" >/dev/null 2>&1 || v=0; done
  [ $v = 1 ] && record PASS 'claude plugin validate --strict (3 manifests)' || record FAIL 'claude plugin validate --strict'
else record SKIP 'claude plugin validate (claude not on PATH)'; fi

if [ -n "$ZIPDIR" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    record FAIL 'zip not built: the working tree has uncommitted changes (the zip is built from HEAD)'
  else
    ver="$(node -p "require('./plugins/trailmark/.claude-plugin/plugin.json').version")"
    mkdir -p "$ZIPDIR"; z="$ZIPDIR/trailmark-$ver.zip"
    git archive --format=zip --prefix=trailmark/ HEAD > "$z"
    (cd "$ZIPDIR" && sha256sum "trailmark-$ver.zip" > "trailmark-$ver.zip.sha256")
    mkdir "$T/zip" && (cd "$T/zip" && unzip -q "$z")
    if (cd "$T/zip/trailmark" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) && [ "$(find "$T/zip" -type l | wc -l)" = 0 ]; then
      record PASS "zip $(basename "$z") from $(git rev-parse --short HEAD): inner sums verify, no links"
      record INFO "sha256 $(cut -d' ' -f1 "$z.sha256")"
      record INFO "commit $(git rev-parse HEAD)"
    else record FAIL 'zip: inner SHA256SUMS or link check failed'; fi
  fi
fi

summary
exit $FAILED

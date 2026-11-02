#!/usr/bin/env bash
# Every local release check in one run, with a one-screen summary.
#
#   dev/release-check.sh                 checks only
#   dev/release-check.sh --sums          regenerate SHA256SUMS first, then check
#   dev/release-check.sh --zip <dir>     also build <dir>/trailmark-<version>.zip
#                                        and its .sha256 from HEAD, and verify them
#   dev/release-check.sh --quick         skip the two long trailmark.test.js suites
#
# Run from anywhere inside the repo, in bash (Git Bash on Windows). It writes
# only SHA256SUMS (with --sums), its own temp folder (removed at the end) and
# the zip folder you name. It makes no network requests.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

SUMS=0; QUICK=0; ZIPDIR=''
while [ $# -gt 0 ]; do
  case "$1" in
    --sums) SUMS=1 ;;
    --quick) QUICK=1 ;;
    --zip) shift; ZIPDIR="${1:-}"; [ -n "$ZIPDIR" ] || { echo 'usage: --zip <dir>'; exit 2; } ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done

T="$(mktemp -d 2>/dev/null || mktemp -d -t tmcheck)"
# Never go on without a temp folder: the cleanup below removes inside it.
[ -n "$T" ] && [ -d "$T" ] || { echo "no temp folder"; exit 2; }
trap 'rm -rf "$T"' EXIT
export TMPDIR="$T"
RESULTS=()
FAILED=0
record() { RESULTS+=("$(printf '%-4s  %s' "$1" "$2")"); if [ "$1" = FAIL ]; then FAILED=1; fi; return 0; }

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

run_suite() { # name, files...
  local name="$1"; shift
  # TAP named: newer Node prints the spec reporter even into a pipe.
  local out; out="$(node --test --test-reporter=tap "$@" 2>&1)"
  local tests pass fail skip
  tests="$(sed -n 's/^# tests //p' <<<"$out" | tail -1)"; pass="$(sed -n 's/^# pass //p' <<<"$out" | tail -1)"
  fail="$(sed -n 's/^# fail //p' <<<"$out" | tail -1)"; skip="$(sed -n 's/^# skipped //p' <<<"$out" | tail -1)"
  if [ "${fail:-1}" = 0 ] && [ -n "$tests" ]; then record PASS "$name: $pass/$tests pass, $skip skipped"
  else
    record FAIL "$name: ${fail:-?} failed of ${tests:-?}"
    grep -E '^not ok' <<<"$out" | head -5 | sed 's/^/      /' >> "$T/failures"
  fi
  rm -rf "$T"/jbmem-* 2>/dev/null
}
run_suite 'handoff-checks (both copies)' plugins/trailmark/tests/handoff-checks.test.js plugins/trailmark-codex/tests/handoff-checks.test.js
if [ "$QUICK" = 0 ]; then
  run_suite 'trailmark.test.js (Claude Code)' plugins/trailmark/tests/trailmark.test.js
  run_suite 'trailmark.test.js (Codex)' plugins/trailmark-codex/tests/trailmark.test.js
else record SKIP 'trailmark.test.js suites (--quick)'; fi

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

echo
echo "release-check at $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' (uncommitted changes)')"
printf '%s\n' "${RESULTS[@]}"
[ -f "$T/failures" ] && cat "$T/failures"
exit $FAILED

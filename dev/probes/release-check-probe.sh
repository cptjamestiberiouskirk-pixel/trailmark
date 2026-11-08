#!/usr/bin/env bash
# Checks for three behaviours of dev/release-check.sh (batch D of the next
# version), each against the script you name, so the same probe runs on the
# current script and on a parent commit's copy:
#
#   bash dev/probes/release-check-probe.sh [script]   (default dev/release-check.sh)
#   git show d86b628:dev/release-check.sh > <scratch>/old.sh
#   bash dev/probes/release-check-probe.sh <scratch>/old.sh
#
#   D1  after an INT to its caller's group, the script dies of INT, so a
#       calling loop stops instead of starting its next round
#   D2  a passing --only run does not push a failed run's kept folder out
#   D3  --only with a name pattern passes --test-concurrency to node
#   D4  --sums under a UTF-8 locale keeps SHA256SUMS in bytewise order (it
#       runs in the repo and puts SHA256SUMS back afterwards)
#
# Run from inside the repo. A fake `node` first on PATH stands in for the test
# runner (it logs its arguments, then sleeps or prints a passing TAP), so no
# test runs and the result doesn't depend on load. Everything it writes is in
# its own temp folder, removed at the end (JBMEM_TEST_KEEP=1 keeps it). It
# prints PASS or FAIL per check and exits 1 if any check failed.
set -u
TARGET="${1:-dev/release-check.sh}"
[ -f "$TARGET" ] || { echo "no script: $TARGET"; exit 2; }
TARGET="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
cd "$(git rev-parse --show-toplevel)" || exit 2

P="$(mktemp -d 2>/dev/null || mktemp -d -t rcprobe)"
[ -n "$P" ] && [ -d "$P" ] || { echo "no temp folder"; exit 2; }
cleanup() {
  # D4 runs --sums in the repo: put SHA256SUMS back as it was.
  [ -f "$P/SHA256SUMS.saved" ] && cat "$P/SHA256SUMS.saved" > SHA256SUMS
  if [ "${JBMEM_TEST_KEEP:-}" = 1 ]; then echo "kept $P"; return; fi
  local i; for i in 1 2 3 4 5; do rm -rf "${P:?}" 2>/dev/null; [ -d "$P" ] || return 0; sleep 1; done
  echo "could not remove $P" >&2
}
trap cleanup EXIT

mkdir -p "$P/bin" "$P/tmp"
cat > "$P/bin/node" <<'EOF'
#!/usr/bin/env bash
# Fake node for the probe: log the call, then act on PROBE_NODE.
printf '%s\n' "$*" >> "$PROBE_DIR/node-calls"
if [ "${PROBE_NODE:-}" = sleep ]; then sleep 30; exit 0; fi
printf 'TAP version 13\nok 1 - probe\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n'
EOF
chmod +x "$P/bin/node"
BIN="$P/bin"; command -v cygpath >/dev/null 2>&1 && BIN="$(cygpath -u "$BIN")"
export PATH="$BIN:$PATH" PROBE_DIR="$P" TMPDIR="$P/tmp"
FAILS=0
result() { echo "$1  $2"; [ "$1" = PASS ] || FAILS=1; }

# D1: a loop runs the script twice; INT goes to the loop's whole group (as a
# terminal's Ctrl-C would) while the first round's fake node sleeps.
cat > "$P/loop.sh" <<'EOF'
for i in 1 2; do bash "$1" --only probe-d1; echo "round $i rc=$?"; done
EOF
: > "$P/node-calls"
set -m
PROBE_NODE=sleep bash "$P/loop.sh" "$TARGET" > "$P/loop.out" 2>&1 &
pg=$!
set +m
for (( i = 0; i < 100; i++ )); do [ -s "$P/node-calls" ] && break; sleep 0.1; done
kill -INT -- "-$pg" 2>/dev/null
# The script's stop takes up to about 10 s; then a second round would start.
for (( i = 0; i < 150; i++ )); do kill -0 "$pg" 2>/dev/null || break; sleep 0.1; done
rounds="$(wc -l < "$P/node-calls" | tr -d ' ')"
if kill -0 "$pg" 2>/dev/null; then kill -TERM -- "-$pg" 2>/dev/null; sleep 1; kill -KILL -- "-$pg" 2>/dev/null; fi
wait "$pg" 2>/dev/null; rc=$?
if [ "$rounds" = 1 ] && ! grep -q 'round 1' "$P/loop.out"; then
  result PASS "D1: the loop stopped with the script (rc $rc, 1 round)"
else
  result FAIL "D1: the loop went on after INT ($rounds rounds; $(tr '\n' ' ' < "$P/loop.out"))"
fi
# The script's own temp folder (mktemp under TMPDIR) is gone after the stop.
left="$(ls "$P/tmp" 2>/dev/null | grep -v '^trailmark-release-check$' | tr '\n' ' ')"
[ -z "$left" ] && result PASS 'D1: no temp folder left after INT' || result FAIL "D1: left after INT: $left"
# TERM to the script alone: it stops by TERM too, with no fake node left.
: > "$P/node-calls"
set -m
PROBE_NODE=sleep bash "$TARGET" --only probe-d1 > "$P/term.out" 2>&1 &
sp=$!
set +m
for (( i = 0; i < 100; i++ )); do [ -s "$P/node-calls" ] && break; sleep 0.1; done
kill -TERM "$sp" 2>/dev/null
wait "$sp"; rc=$?
sleeping="$(ps -ef 2>/dev/null | grep -c '[s]leep 30')"
left="$(ls "$P/tmp" 2>/dev/null | grep -v '^trailmark-release-check$' | tr '\n' ' ')"
if [ "$rc" = 143 ] && [ "$sleeping" = 0 ] && [ -z "$left" ]; then
  result PASS 'D1: TERM stops it by TERM (rc 143), its suite and temp folder gone'
else
  result FAIL "D1: after TERM rc $rc, $sleeping fake node(s) left, temp left: ${left:-none}"
fi

# D2: 20 failed runs' folders (older, as a full run leaves them) and 20 passing
# --only runs' folders; one more passing --only run must keep all 20 failed.
KR="$P/tmp/trailmark-release-check"
for (( i = 1; i <= 20; i++ )); do
  f="$KR/20200101-0000$(printf '%02d' "$i")-1"; mkdir -p "$f"; echo failed > "$f/trailmark-codex.tap"
done
for (( i = 1; i <= 20; i++ )); do
  f="$KR/20210101-0000$(printf '%02d' "$i")-1"; mkdir -p "$f"; echo passed > "$f/only.tap"; : > "$f/passed"
done
bash "$TARGET" --only probe-d2 > "$P/d2.out" 2>&1
failed_left="$(ls -d "$KR"/20200101-* 2>/dev/null | wc -l | tr -d ' ')"
total="$(ls -d "$KR"/[0-9]*-[0-9]*-[0-9]* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$failed_left" = 20 ] && grep -q '^PASS' "$P/d2.out"; then
  result PASS "D2: all 20 failed runs' folders kept ($total folders in all)"
else
  result FAIL "D2: $failed_left of 20 failed runs' folders kept ($total in all)"
fi

# D3: the pattern form of --only must cap how many test files run at once.
: > "$P/node-calls"
bash "$TARGET" --only probe-d3 > "$P/d3.out" 2>&1
if grep -q -- '--test-concurrency=[0-9]' "$P/node-calls"; then
  result PASS "D3: --only passes $(grep -o -- '--test-concurrency=[0-9]*' "$P/node-calls" | head -1)"
else
  result FAIL 'D3: --only runs node --test without --test-concurrency'
fi

# D4: --sums under a UTF-8 locale must list the files in the same (bytewise)
# order as the committed SHA256SUMS. Only the order of the names is compared,
# so uncommitted edits to listed files don't matter. SHA256SUMS is saved first
# and put back by the cleanup.
cp SHA256SUMS "$P/SHA256SUMS.saved"
LC_ALL=en_US.UTF-8 bash "$TARGET" --sums --quick > "$P/d4.out" 2>&1
if cmp -s <(git show HEAD:SHA256SUMS | cut -c67-) <(cut -c67- SHA256SUMS); then
  result PASS 'D4: --sums under en_US.UTF-8 keeps the committed order'
else
  result FAIL "D4: --sums under en_US.UTF-8 reorders SHA256SUMS ($(diff <(git show HEAD:SHA256SUMS | cut -c67-) <(cut -c67- SHA256SUMS) | grep -c '^[<>]') lines move)"
fi
cat "$P/SHA256SUMS.saved" > SHA256SUMS
exit $FAILS

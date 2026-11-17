#!/usr/bin/env bash
# Runs node --test on the given test files, writes its TAP output to <tap
# file>, turns failures into annotations, and exits 1 when node --test failed.
# The test steps of tests.yml run it (RS-T-hang75, dev/release-state.md).
# TRAILMARK_TEST_LIMIT_MS is the per-test limit for the step's system, and
# TRAILMARK_TEST_LIMITS says what to do with it:
#   report   node --test runs as it did before; tap-annotate.js lists the
#            slowest tests and warns about each test that ran longer than the
#            limit. Nothing more can fail. The test steps use this for now
#            (PLAYBOOK "Pushing and CI" step 3).
#   enforce  the limit ends a hung test as a failure that names it:
#     --test-timeout     ends a test that waits on something asynchronous;
#     --test-force-exit  lets the file end once its tests are done, though the
#                        test that was ended left a child or a timer open;
#     --require test-limits.js  gives each synchronous child call with no
#                        timeout of its own the same limit (see that file).
#            .github/test-limits-check.js runs it this way.
# Usage: .github/run-tests.sh <tap file> <test file>...
# -e and pipefail as the step's own shell had them: a failure of
# tap-annotate.js fails the step (the node --test line is exempt, being an
# && || list).
set -euo pipefail
tap=${1:?usage: run-tests.sh <tap file> <test file>...}; shift
limit=${TRAILMARK_TEST_LIMIT_MS:?TRAILMARK_TEST_LIMIT_MS is not set}
case "${TRAILMARK_TEST_LIMITS:-}" in
  enforce) flags=(--test-timeout="$limit" --test-force-exit --require ./.github/test-limits.js) ;;
  report) flags=() ;;
  *) echo "run-tests.sh: TRAILMARK_TEST_LIMITS must be report or enforce" >&2; exit 2 ;;
esac
node --test --test-reporter=tap ${flags[@]+"${flags[@]}"} "$@" > "$tap" 2>&1 && ok=1 || ok=0
node .github/tap-annotate.js "$tap"
[ "$ok" = 1 ]

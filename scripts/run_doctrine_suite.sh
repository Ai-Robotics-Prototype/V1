#!/usr/bin/env bash
# scripts/run_doctrine_suite.sh — run the Program Doctrine tests.
#
# See docs/PROGRAM_DOCTRINE.md for the rules and coverage table.
# Each rule lives under
#   src/cobot_dashboard/frontend/tests/doctrine/D<N>_*.test.js
# and prefixes its failures with `DOCTRINE D<N> VIOLATED: <detail>`.
#
# Exit code:
#   0  every rule passed
#   1  at least one rule violated (rule number in the output)
#   2  invocation error (missing dir, node not on PATH, etc.)
#
# Deploy gate: scripts/deploy.sh runs this before the build. Manual
# invocation from the repo root:
#   bash scripts/run_doctrine_suite.sh

set -euo pipefail

WS="${WS:-/home/teddy/cobot_ws}"
FRONTEND="$WS/src/cobot_dashboard/frontend"
DOCTRINE_DIR="$FRONTEND/tests/doctrine"

RED=$'\e[31m'; GRN=$'\e[32m'; DIM=$'\e[2m'; BLD=$'\e[1m'; RST=$'\e[0m'

[[ -d "$DOCTRINE_DIR" ]] || {
  echo "doctrine suite not found: $DOCTRINE_DIR" >&2
  exit 2
}
command -v node >/dev/null || {
  echo "node not on PATH" >&2
  exit 2
}

printf "${BLD}▸ Program Doctrine — running tests/doctrine/${RST}\n"
printf "  See docs/PROGRAM_DOCTRINE.md for the rules.\n\n"

cd "$FRONTEND"

# Run every rule file. Collect fail counts per file so the summary
# names the exact rule(s) violated.
declare -a FAILED_RULES=()
declare -a PASSED_RULES=()
for f in tests/doctrine/D*.test.js; do
  [[ -f "$f" ]] || continue
  rule=$(basename "$f" | sed -n 's/^\(D[0-9][0-9]*\)_.*/\1/p')
  # node --test exit code is non-zero on any failure. Capture the
  # summary so we can print which rule(s) failed.
  if node --test "$f" >/tmp/doctrine_out.$$ 2>&1; then
    passed=$(grep -m1 '^# pass' /tmp/doctrine_out.$$ | awk '{print $NF}')
    tests=$(grep -m1 '^# tests' /tmp/doctrine_out.$$ | awk '{print $NF}')
    printf "  ${GRN}✓${RST} ${rule}  ${DIM}(${passed:-?}/${tests:-?} tests)${RST}\n"
    PASSED_RULES+=("$rule")
  else
    failed=$(grep -m1 '^# fail' /tmp/doctrine_out.$$ | awk '{print $NF}')
    tests=$(grep -m1 '^# tests' /tmp/doctrine_out.$$ | awk '{print $NF}')
    printf "  ${RED}✗${RST} ${rule}  ${DIM}(${failed:-?}/${tests:-?} tests failed)${RST}\n"
    # Extract the "DOCTRINE Dx VIOLATED: …" lines from the failures.
    grep -oE "DOCTRINE D[0-9]+ VIOLATED:[^\"]{0,240}" /tmp/doctrine_out.$$ \
      | head -3 | sed 's/^/      /'
    FAILED_RULES+=("$rule")
  fi
  rm -f /tmp/doctrine_out.$$
done

echo
if [[ ${#FAILED_RULES[@]} -eq 0 ]]; then
  printf "${GRN}════════  DOCTRINE: PASS  ════════${RST}\n"
  printf "  All %d rules satisfied.\n" "${#PASSED_RULES[@]}"
  exit 0
fi

printf "${RED}════════  DOCTRINE: FAIL  ════════${RST}\n"
printf "  Rules violated: %s\n" "${FAILED_RULES[*]}"
printf "  Fix the underlying code (or amend the rule, if the operator\n"
printf "  agrees the invariant has changed). Doctrine is HIS.\n"
exit 1

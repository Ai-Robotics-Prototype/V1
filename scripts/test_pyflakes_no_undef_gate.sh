#!/usr/bin/env bash
# Pinned regression for the 2026-08-03 no-undef backend gate.
#
# Contract: pyflakes across the four dashboard-touched packages must
# report zero `undefined name` findings; injecting a fresh undefined
# name must make the gate fail.
#
# Runs the same pyflakes invocation deploy.sh does, then repeats
# with an injected NameError to confirm the gate would fail on it.
# Restores the file at the end regardless of exit code.

set -euo pipefail

WS="${WS:-/home/teddy/cobot_ws}"
TARGETS=(
    "$WS/src/cobot_dashboard/cobot_dashboard"
    "$WS/src/estun_driver/estun_driver"
    "$WS/src/programming_by_demonstration/programming_by_demonstration"
    "$WS/src/object_detection/object_detection"
)

# 1. Baseline: current tree must be clean.
BASELINE=$(python3 -m pyflakes "${TARGETS[@]}" 2>&1 | grep 'undefined name' || true)
if [[ -n "$BASELINE" ]]; then
    echo "FAIL: baseline tree already has undefined-name findings —" >&2
    echo "$BASELINE" >&2
    exit 1
fi
echo "  ✓ baseline: zero undefined-name findings"

# 2. Injection: add a NameError-in-waiting to a scratch file and
#    confirm the gate catches it. Uses a copy so the tree stays
#    clean if pytest re-runs.
SCRATCH="$WS/src/cobot_dashboard/cobot_dashboard/_pyflakes_gate_scratch.py"
cat > "$SCRATCH" <<'PY'
# Scratch file for the pyflakes gate test. Deletes itself when the
# gate test finishes; do not import from anywhere.
def _would_crash_at_call_time():
    return this_name_is_not_defined_and_pyflakes_should_flag_it()
PY

INJECTED=$(python3 -m pyflakes "$SCRATCH" 2>&1 | grep 'undefined name' || true)
rm -f "$SCRATCH"

if [[ -z "$INJECTED" ]]; then
    echo "FAIL: pyflakes did NOT flag the injected undefined name —" >&2
    echo "  the deploy gate would silently ship a NameError." >&2
    exit 1
fi
echo "  ✓ injection: pyflakes flagged '$(echo "$INJECTED" | head -1)'"

echo "PASS: pyflakes no-undef gate is armed."

#!/usr/bin/env bash
# scripts/autodeploy_wrapper.sh — the systemd-invoked wrapper that
# turns a fresh commit into an actual deploy.
#
# Contract (per the 2026-07-31 auto-deploy directive):
#   1. A commit on the working branch that touches src/ or
#      frontend/ triggers this wrapper via the roboai-autodeploy
#      path unit.
#   2. Wrapper polls for arm idle (no active jog + no running
#      program) every 10s. Never restarts services under active
#      motion.
#   3. On idle → scripts/deploy.sh runs. Wrapper captures its
#      output + exit code and appends a JSONL entry to
#      /opt/cobot/deploy_log.jsonl.
#   4. If idle wait exceeds AUTODEPLOY_MAX_WAIT_S (default 600),
#      a "waiting" entry is written and the wrapper keeps polling
#      — never silently gives up. The UI's amber banner reads this
#      state.
#
# JSONL entry shape (one per line):
#   {
#     ts: <iso8601>,
#     phase: "start" | "waiting" | "building" | "ok" | "fail",
#     sha: <git rev-parse HEAD>,
#     step: <string when phase=fail>,
#     detail: <string>,
#     served_asset_before: <hash>,       # phase=ok / phase=fail
#     served_asset_after:  <hash>,       # phase=ok
#     duration_s: <float>,               # phase=ok / phase=fail
#     exit_code: <int>,                  # phase=fail
#   }
#
# Path-triggered by roboai-autodeploy.path; NOT run manually
# (scripts/deploy.sh is still available for manual invocation).

set -uo pipefail

WS="${WS:-/home/teddy/cobot_ws}"
LOG="/opt/cobot/deploy_log.jsonl"
MAX_WAIT_S="${AUTODEPLOY_MAX_WAIT_S:-600}"
POLL_S=10
DEPLOY_SCRIPT="$WS/scripts/deploy.sh"
DASHBOARD_URL="${DASHBOARD_URL:-https://127.0.0.1:8080}"

# Ensure the log file exists + is writable.
mkdir -p "$(dirname "$LOG")"
touch "$LOG" 2>/dev/null || { echo "cannot write $LOG" >&2; exit 2; }

log_entry() {
    # log_entry <phase> [k=v ...]
    local phase="$1"; shift
    local sha
    sha=$(cd "$WS" && git rev-parse HEAD 2>/dev/null || echo "unknown")
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local extras=""
    for kv in "$@"; do
        local k="${kv%%=*}"
        local v="${kv#*=}"
        # Escape backslashes + double quotes so JSONL stays valid.
        v="${v//\\/\\\\}"
        v="${v//\"/\\\"}"
        extras+=", \"$k\": \"$v\""
    done
    printf '{"ts": "%s", "phase": "%s", "sha": "%s"%s}\n' \
        "$ts" "$phase" "$sha" "$extras" >> "$LOG"
}

# Idle check — probes /api/state for active jog + running program.
# Returns 0 when idle, 1 when busy. Falls through as busy on any
# transport error so we don't clobber an in-flight run.
is_idle() {
    local body
    body=$(curl -sk --max-time 3 "$DASHBOARD_URL/api/state" 2>/dev/null) \
        || return 1
    python3 - "$body" <<'EOF'
import json, sys
try: b = json.loads(sys.argv[1])
except: sys.exit(1)
r = b.get('robot') or {}
if r.get('jog_active'): sys.exit(1)          # active hold
prog = r.get('program') or {}
if int(prog.get('state') or 0) == 2: sys.exit(1)  # running
sys.exit(0)
EOF
}

start_ts=$(date +%s)
log_entry "start" trigger=path_unit

waited=0
while ! is_idle; do
    if (( waited == 0 )); then
        log_entry "waiting" reason=arm_busy detail="jog_active or program.state==2"
    fi
    sleep "$POLL_S"
    waited=$(( waited + POLL_S ))
    # >600s → keep waiting but write a "still waiting" heartbeat
    # every minute so the UI banner can escalate to red.
    if (( waited >= MAX_WAIT_S )) && (( waited % 60 == 0 )); then
        log_entry "waiting" reason=long_wait detail="waited=${waited}s"
    fi
done

# Snapshot the served asset hash BEFORE deploy so we can prove it changed.
before=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
    "$WS/src/cobot_dashboard/mock_server/static/index.html" 2>/dev/null | head -1)
before="${before#/assets/index-}"
before="${before%.js}"

log_entry "building" served_asset_before="${before:-unknown}"

# Run the deploy. Capture stdout+stderr to a per-run log file so a
# failure trail is inspectable.
run_log="/tmp/autodeploy_$(date +%Y%m%d_%H%M%S).log"
bash "$DEPLOY_SCRIPT" > "$run_log" 2>&1
code=$?
after=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
    "$WS/src/cobot_dashboard/mock_server/static/index.html" 2>/dev/null | head -1)
after="${after#/assets/index-}"
after="${after%.js}"
end_ts=$(date +%s)
if [[ $code -eq 0 ]]; then
    log_entry "ok" \
        served_asset_before="${before:-unknown}" \
        served_asset_after="${after:-unknown}" \
        duration_s="$((end_ts - start_ts))"
    exit 0
elif [[ $code -eq 3 ]]; then
    # 2026-08-06 (silent-frontend-rebuild-skip class, operator
    # directive). deploy.sh exit code 3 = FRONTEND_STALE: source
    # hash advanced but the served asset did NOT change. Emit
    # phase=frontend_stale so /api/deploy_status can escalate the
    # banner to red — this class was silently passing before and
    # served the old UI to every open tab.
    step=$(grep -oE 'FRONTEND_STALE[^)]*' "$run_log" | head -1)
    log_entry "frontend_stale" \
        step="${step:-frontend_stale}" \
        exit_code="$code" \
        served_asset_before="${before:-unknown}" \
        served_asset_after="${after:-unknown}" \
        duration_s="$((end_ts - start_ts))" \
        detail="see $run_log; frontend source changed but vite did not advance the asset hash"
    exit "$code"
else
    # Best-effort: pull the first FAIL line from deploy.sh output so
    # the UI banner shows a specific failing step.
    step=$(grep -oE '(✗ [^—]+|FAIL[A-Z: ]*)' "$run_log" | head -1)
    log_entry "fail" \
        step="${step:-unknown}" \
        exit_code="$code" \
        served_asset_before="${before:-unknown}" \
        served_asset_after="${after:-unknown}" \
        duration_s="$((end_ts - start_ts))" \
        detail="see $run_log"
    exit "$code"
fi

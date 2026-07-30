#!/usr/bin/env bash
# scripts/deploy.sh — one-command atomic deploy for the roboai stack.
#
# Motivated by the FOURTH staleness episode on 2026-07-30. Manual
# restart is skippable; a script makes the correct sequence the
# path of least resistance:
#
#   1. Build the frontend if source has changed since the last built
#      asset (vite emits directly to mock_server/static, so "if
#      changed" is a git-timestamp check against static/index.html).
#   2. Restart roboai-dashboard AND roboai-estun so their in-memory
#      program_ops picks up whatever's on disk now.
#   3. Verify:
#        (a) boot_sha == disk_sha for the codegen module (the
#            /api/codegen/status endpoint's fresh view),
#        (b) served_asset_hash changed vs the pre-restart snapshot
#            (only checked when the build ran).
#   4. Print PASS or FAIL with a concrete pointer to what to fix.
#
# Never touches the operator's Run flow. Idempotent — a second run
# with no source changes still restarts services (that's the whole
# point — you can trust "did the deploy work?" without inspecting).
#
# Exit codes:
#   0  PASS  — services live, boot sha matches disk, and (if the
#              frontend was rebuilt) served asset hash changed.
#   1  FAIL  — one of the verifications did not pass; report says which.
#   2  usage/setup error — pre-flight blocked (bad workspace, no sudo,
#              service files missing).

set -euo pipefail

WS="${WS:-/home/teddy/cobot_ws}"
DASHBOARD_URL="${DASHBOARD_URL:-https://127.0.0.1:8080}"
FRONTEND_SRC="$WS/src/cobot_dashboard/frontend"
FRONTEND_OUT="$WS/src/cobot_dashboard/mock_server/static"
PROGRAM_OPS="$WS/src/estun_driver/estun_driver/program_ops.py"

RED=$'\e[31m'; GRN=$'\e[32m'; AMB=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m'

step() { printf "\n${DIM}▸${RST} %s\n" "$*"; }
pass() { printf "  ${GRN}✓${RST} %s\n" "$*"; }
warn() { printf "  ${AMB}⚠${RST} %s\n" "$*"; }
fail() { printf "  ${RED}✗${RST} %s\n" "$*"; exit_code=1; }

exit_code=0

# ── Pre-flight ────────────────────────────────────────────────────
[[ -d "$WS" ]] || { echo "workspace not found: $WS"; exit 2; }
[[ -f "$PROGRAM_OPS" ]] || { echo "program_ops.py not found: $PROGRAM_OPS"; exit 2; }
command -v systemctl >/dev/null || { echo "systemctl required"; exit 2; }
command -v curl >/dev/null || { echo "curl required"; exit 2; }
command -v sha256sum >/dev/null || { echo "sha256sum required"; exit 2; }

sha12() { sha256sum "$1" | cut -c1-12; }

# ── 1. Frontend build (if needed) ────────────────────────────────
step "Frontend build check"
FRONTEND_NEEDS_BUILD=0
if [[ ! -f "$FRONTEND_OUT/index.html" ]]; then
    FRONTEND_NEEDS_BUILD=1
    warn "no served bundle at $FRONTEND_OUT — building"
else
    # Newest source mtime under frontend/src vs served index.html.
    NEWEST_SRC=$(find "$FRONTEND_SRC/src" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
    SERVED_MT=$(stat -c '%Y' "$FRONTEND_OUT/index.html")
    if awk -v a="$NEWEST_SRC" -v b="$SERVED_MT" 'BEGIN { exit !(a > b) }'; then
        FRONTEND_NEEDS_BUILD=1
        pass "source newer than served bundle — will rebuild"
    else
        pass "served bundle up to date; skipping build"
    fi
fi

PRE_SERVED_ASSET=""
if [[ -f "$FRONTEND_OUT/index.html" ]]; then
    PRE_SERVED_ASSET=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
                       "$FRONTEND_OUT/index.html" | head -1)
fi

if [[ $FRONTEND_NEEDS_BUILD -eq 1 ]]; then
    step "npm run build"
    ( cd "$FRONTEND_SRC" && npm run build 2>&1 | tail -8 )
    pass "vite build complete"
fi

# ── 2. Restart services ──────────────────────────────────────────
step "Restart services (roboai-dashboard, roboai-estun)"
DISK_SHA=$(sha12 "$PROGRAM_OPS")
pass "disk program_ops sha=$DISK_SHA"

sudo systemctl restart roboai-dashboard roboai-estun
pass "systemctl restart issued"

# Wait for the HTTPS endpoint to come back — up to 30s.
step "Wait for dashboard readiness"
DEADLINE=$(($(date +%s) + 30))
while true; do
    if curl -sk --max-time 2 "$DASHBOARD_URL/api/systemcheck" >/dev/null 2>&1; then
        pass "dashboard responding"
        break
    fi
    if [[ $(date +%s) -ge $DEADLINE ]]; then
        fail "dashboard did not respond within 30s after restart"
        break
    fi
    sleep 0.5
done

# ── 3. Verify ────────────────────────────────────────────────────
step "Verify codegen boot_sha == disk_sha"
CODEGEN_STATUS=$(curl -sk "$DASHBOARD_URL/api/codegen/status")
BOOT_SHA=$(echo "$CODEGEN_STATUS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("boot_sha",""))')
API_DISK=$(echo "$CODEGEN_STATUS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("disk_sha",""))')
API_STALE=$(echo "$CODEGEN_STATUS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("stale",False))')
printf "    boot_sha : %s\n    disk_sha : %s (API) / %s (fs)\n    stale    : %s\n" \
    "$BOOT_SHA" "$API_DISK" "$DISK_SHA" "$API_STALE"
if [[ "$BOOT_SHA" == "$DISK_SHA" && "$API_STALE" == "False" ]]; then
    pass "codegen boot == disk ($BOOT_SHA)"
else
    fail "codegen still stale — boot=$BOOT_SHA disk=$DISK_SHA. \
Restart may have raced with the fs write; re-run scripts/deploy.sh."
fi

if [[ $FRONTEND_NEEDS_BUILD -eq 1 ]]; then
    step "Verify served asset hash changed"
    POST_SERVED_ASSET=""
    if [[ -f "$FRONTEND_OUT/index.html" ]]; then
        POST_SERVED_ASSET=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
                            "$FRONTEND_OUT/index.html" | head -1)
    fi
    printf "    pre  : %s\n    post : %s\n" \
        "${PRE_SERVED_ASSET:-<none>}" "${POST_SERVED_ASSET:-<none>}"
    if [[ -z "$POST_SERVED_ASSET" ]]; then
        fail "no served asset present after build"
    elif [[ "$PRE_SERVED_ASSET" == "$POST_SERVED_ASSET" && -n "$PRE_SERVED_ASSET" ]]; then
        # Same hash after a rebuild would mean sources hadn't actually
        # changed (vite is deterministic on identical input). Warn,
        # don't fail — the deploy is still correct, just a no-op.
        warn "served asset hash unchanged after rebuild — input identical"
    else
        pass "served asset hash advanced: $PRE_SERVED_ASSET → $POST_SERVED_ASSET"
    fi
fi

# ── 4. Verdict ───────────────────────────────────────────────────
echo
if [[ $exit_code -eq 0 ]]; then
    printf "${GRN}════════  DEPLOY: PASS  ════════${RST}\n"
    printf "  program_ops boot=%s\n" "$BOOT_SHA"
    [[ $FRONTEND_NEEDS_BUILD -eq 1 ]] && \
        printf "  frontend    asset=%s\n" "${POST_SERVED_ASSET#/assets/index-}"
    printf "  Operator can Run.\n"
else
    printf "${RED}════════  DEPLOY: FAIL  ════════${RST}\n"
    printf "  See errors above. The dashboard may still be running the OLD\n"
    printf "  codegen; do NOT let the operator Run until this is clean.\n"
fi
exit $exit_code

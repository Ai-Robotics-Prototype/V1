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
#
# Build-needed decision: CONTENT HASH of the frontend source tree
# vs the hash stamped by the previous build. Bugs the mtime
# heuristic hit (2026-07-30, twice in one hour):
#
#   * `npm run build` runs during `verify` steps INSIDE the same
#     script that later checks mtime → served/index.html gets
#     rewritten SECOND, so its mtime is LATER than any source
#     file, and the next deploy call sees "served newer than
#     source, skip build" even when the source has changed since.
#   * Any file touched between verify-build and commit
#     (rebase, formatter, IDE autosave, git-stash apply) breaks
#     the mtime comparison silently.
#   * `find -newer` and mtime comparisons are noisy on shared
#     filesystems (docker bind mounts, some COW filesystems).
#
# Content hash is the only heuristic that CAN'T be fooled by
# clock skew, autosaves, or in-script rebuilds. Stamp file at
# `frontend/.deploy-src-hash` records the hash that produced the
# current bundle; deploy.sh rebuilds when the current source hash
# differs.
#
# When in doubt, BUILD. A redundant vite build costs ~60s; a
# skipped one cost the operator an afternoon of "why isn't the
# new UI showing up?" twice today.
step "Frontend build check"
FRONTEND_NEEDS_BUILD=0
BUILD_STAMP="$FRONTEND_SRC/.deploy-src-hash"
# Content hash of every JS/JSX/CSS/HTML/JSON under frontend/src
# (excluding node_modules and build outputs). `find -type f`
# ordered by path so the hash is deterministic across invocations.
FRONTEND_SRC_HASH=$(
    cd "$FRONTEND_SRC" && \
    find src package.json vite.config.* index.html \
         -type f 2>/dev/null | sort | xargs sha256sum 2>/dev/null | \
    sha256sum | cut -c1-16
)
if [[ ! -f "$FRONTEND_OUT/index.html" ]]; then
    FRONTEND_NEEDS_BUILD=1
    warn "no served bundle at $FRONTEND_OUT — building"
elif [[ ! -f "$BUILD_STAMP" ]]; then
    FRONTEND_NEEDS_BUILD=1
    warn "no build stamp — treating as source-changed, will rebuild"
else
    LAST_HASH=$(cat "$BUILD_STAMP" 2>/dev/null | tr -d '[:space:]')
    if [[ "$FRONTEND_SRC_HASH" != "$LAST_HASH" ]]; then
        FRONTEND_NEEDS_BUILD=1
        pass "source hash changed ($LAST_HASH → $FRONTEND_SRC_HASH) — will rebuild"
    else
        pass "source hash unchanged ($FRONTEND_SRC_HASH); skipping build"
    fi
fi

PRE_SERVED_ASSET=""
if [[ -f "$FRONTEND_OUT/index.html" ]]; then
    PRE_SERVED_ASSET=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
                       "$FRONTEND_OUT/index.html" | head -1)
fi

if [[ $FRONTEND_NEEDS_BUILD -eq 1 ]]; then
    # Program Doctrine — the operator's standing rules. See
    # docs/PROGRAM_DOCTRINE.md. This gate runs BEFORE lint + build
    # because a doctrine failure is a violation of a hard invariant
    # (D1 derived-never-taught, D3 shown≠emitted-is-a-lie, etc.),
    # and shipping past it puts the operator's mental model out of
    # sync with what the app does.
    step "Program Doctrine (tests/doctrine/)"
    if ! bash "$WS/scripts/run_doctrine_suite.sh"; then
        fail "doctrine violated — refusing to build."
        printf "${RED}════════  DEPLOY: FAIL  ════════${RST}\n"
        printf "  Fix the doctrine violation(s) above OR amend the rule\n"
        printf "  (operator approves rule changes — see docs/PROGRAM_DOCTRINE.md).\n"
        exit 1
    fi
    pass "doctrine clean"

    # Lint FIRST — a ReferenceError in JSX (e.g. an undefined
    # identifier accidentally referenced in render scope) is a
    # build-time catchable, not a runtime discovery. The 2026-07-31
    # `palletFrameStatus` incident shipped because vite tolerates
    # undefined identifiers at build time; ESLint's `no-undef` does
    # not. Fail the deploy on ANY lint error before we bother
    # running vite.
    step "npm run lint"
    if ! ( cd "$FRONTEND_SRC" && npm run lint 2>&1 | tail -20 ); then
        fail "eslint reported errors — refusing to build."
        printf "${RED}════════  DEPLOY: FAIL  ════════${RST}\n"
        printf "  Fix the lint errors above and re-run scripts/deploy.sh.\n"
        exit 1
    fi
    pass "eslint clean"

    # Backend equivalent of the ESLint no-undef gate — pyflakes
    # catches the NameError-in-waiting class (2026-08-03: operator
    # hit `name 'program_ops' is not defined` inside the D11 check;
    # the check crashed and the frontend surfaced OUR bug as a
    # program-lint failure). Both backend and frontend now share
    # the same "undefined identifier fails the build" contract.
    #
    # Scope: dashboard + estun_driver + programming_by_demonstration
    # + object_detection — the packages that carry the code the
    # operator actually edits from the dashboard. Other packages
    # (perception_fusion, cuda_pointcloud, etc.) build fine via
    # colcon and their runtime lives outside the dashboard-touched
    # request path — we can extend the gate to them in a follow-up
    # if a NameError ever slips through in one of those.
    #
    # Pyflakes-only check (not full ruff): pyflakes flags undefined
    # names deterministically and has no style opinions. Style
    # cleanups can land in a separate PR without churning the gate.
    step "pyflakes (backend no-undef gate)"
    _PYFLAKES_TARGETS=(
        "$WS/src/cobot_dashboard/cobot_dashboard"
        "$WS/src/estun_driver/estun_driver"
        "$WS/src/programming_by_demonstration/programming_by_demonstration"
        "$WS/src/object_detection/object_detection"
    )
    _PYFLAKES_OUT=$(python3 -m pyflakes "${_PYFLAKES_TARGETS[@]}" 2>&1 \
                       | grep 'undefined name' || true)
    if [[ -n "$_PYFLAKES_OUT" ]]; then
        fail "pyflakes reported undefined-name errors — refusing to build."
        printf "${RED}%s${RST}\n" "$_PYFLAKES_OUT"
        printf "${RED}════════  DEPLOY: FAIL  ════════${RST}\n"
        printf "  A NameError-in-waiting shipped once (D11 validator, 2026-08-03).\n"
        printf "  Fix the undefined identifiers above and re-run scripts/deploy.sh.\n"
        printf "  Style-only pyflakes findings (unused vars, f-strings without\n"
        printf "  placeholders) are NOT gated — only undefined names are.\n"
        exit 1
    fi
    pass "pyflakes clean (no undefined names in dashboard/estun/pbd/object_detection)"

    step "npm run build"
    ( cd "$FRONTEND_SRC" && npm run build 2>&1 | tail -8 )
    pass "vite build complete"
    # Stamp the source hash the build ran on. Next deploy compares
    # against this to decide "changed since last build?". Missing
    # or stale stamp → treated as changed → build. Never skip
    # unless the hashes match exactly.
    echo "$FRONTEND_SRC_HASH" > "$BUILD_STAMP"
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

# Served asset check runs regardless of whether we built: the
# operator wants to see the current asset hash on EVERY deploy so
# they can compare against their tab's footer and confirm the tab
# reload will actually change what they see (2026-07-30 the
# operator hit two false-positive PASSes; showing the hash every
# time is cheap and rules out the "did it change?" ambiguity).
step "Served asset hash"
POST_SERVED_ASSET=""
if [[ -f "$FRONTEND_OUT/index.html" ]]; then
    POST_SERVED_ASSET=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
                        "$FRONTEND_OUT/index.html" | head -1)
fi
if [[ -z "$POST_SERVED_ASSET" ]]; then
    fail "no served asset present"
elif [[ $FRONTEND_NEEDS_BUILD -eq 1 ]]; then
    printf "    pre  : %s\n    post : %s\n" \
        "${PRE_SERVED_ASSET:-<none>}" "$POST_SERVED_ASSET"
    if [[ "$PRE_SERVED_ASSET" == "$POST_SERVED_ASSET" && -n "$PRE_SERVED_ASSET" ]]; then
        warn "served asset hash unchanged after rebuild — input identical (vite deterministic)"
    else
        pass "served asset hash advanced: $PRE_SERVED_ASSET → $POST_SERVED_ASSET"
    fi
else
    printf "    served : %s (build skipped — source hash unchanged)\n" \
        "$POST_SERVED_ASSET"
    pass "served asset $POST_SERVED_ASSET"
fi

# ── 4. Verdict ───────────────────────────────────────────────────
echo
if [[ $exit_code -eq 0 ]]; then
    printf "${GRN}════════  DEPLOY: PASS  ════════${RST}\n"
    printf "  program_ops boot=%s\n" "$BOOT_SHA"
    printf "  frontend    asset=%s\n" \
        "${POST_SERVED_ASSET#/assets/index-}"
    printf "  frontend    src_hash=%s\n" "$FRONTEND_SRC_HASH"
    printf "  Operator can Run.\n"
else
    printf "${RED}════════  DEPLOY: FAIL  ════════${RST}\n"
    printf "  See errors above. The dashboard may still be running the OLD\n"
    printf "  codegen; do NOT let the operator Run until this is clean.\n"
fi
exit $exit_code

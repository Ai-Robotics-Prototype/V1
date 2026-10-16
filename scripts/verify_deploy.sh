#!/usr/bin/env bash
# scripts/verify_deploy.sh — one-line deploy truth check.
#
# READ-ONLY. Inspects state; changes nothing. Prints a single line
# with git HEAD short-sha, the served frontend asset hash (same
# source the footer uses), and the backend boot / disk sha status.
# Suffix is DEPLOYED (match) or MISMATCH: <reason>.
#
# Example outputs:
#   HEAD=03786f3  served_js=iUFX_-4I  boot=deadbeef1234/disk=deadbeef1234  → DEPLOYED (match)
#   HEAD=cb83ed4  served_js=DbEn17aP  boot=cafebabe0000/disk=deadbeef1234  → MISMATCH: backend running stale program_ops (restart roboai-dashboard + roboai-estun)
#   HEAD=cb83ed4  served_js=DbEn17aP  boot=deadbeef1234/disk=deadbeef1234  → MISMATCH: deploy_log for HEAD not ok (last phase=frontend_stale)
#
# Intended use: after any commit, run this once to answer "did the
# deploy converge?" without inspecting logs / tabs / journals.

set -uo pipefail

WS="${WS:-/home/teddy/cobot_ws}"
DASHBOARD_URL="${DASHBOARD_URL:-https://127.0.0.1:8080}"
PROGRAM_OPS="$WS/src/estun_driver/estun_driver/program_ops.py"
FRONTEND_INDEX="$WS/src/cobot_dashboard/mock_server/static/index.html"
DEPLOY_LOG="/opt/cobot/deploy_log.jsonl"

# ── HEAD ───────────────────────────────────────────────────────────
head_sha=$(git -C "$WS" rev-parse --short HEAD 2>/dev/null || echo "?")

# ── Served JS asset hash — from the same source the footer reads.
# The footer's `served_asset` field comes from index.html's
# /assets/index-<HASH>.js reference. We do NOT curl the running
# server here; the file on disk is the source of truth after a
# deploy stamps it.
served_js="?"
if [[ -f "$FRONTEND_INDEX" ]]; then
    _tag=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$FRONTEND_INDEX" | head -1)
    _tag="${_tag#/assets/index-}"
    _tag="${_tag%.js}"
    [[ -n "$_tag" ]] && served_js="$_tag"
fi

# ── Backend boot/disk sha ──────────────────────────────────────────
# Boot sha is the 12-char sha256 the dashboard captured at process
# start (from /api/codegen/status); disk sha is the current file.
# Mismatch = the running dashboard is holding an old program_ops.
disk_sha="?"
if [[ -f "$PROGRAM_OPS" ]] && command -v sha256sum >/dev/null 2>&1; then
    disk_sha=$(sha256sum "$PROGRAM_OPS" | cut -c1-12)
fi
boot_sha="?"
if command -v curl >/dev/null 2>&1; then
    _json=$(curl -sk --max-time 3 "$DASHBOARD_URL/api/codegen/status" 2>/dev/null || echo '')
    if [[ -n "$_json" ]]; then
        boot_sha=$(python3 -c 'import sys,json
try:
    b=json.load(sys.stdin)
    print(b.get("boot_sha","?"))
except: print("?")' 2>/dev/null <<< "$_json" || echo "?")
    fi
fi

# ── Latest deploy_log entry for this HEAD ─────────────────────────
log_phase="?"
log_served="?"
if [[ -f "$DEPLOY_LOG" ]] && [[ "$head_sha" != "?" ]]; then
    _head_full=$(git -C "$WS" rev-parse HEAD 2>/dev/null || echo "")
    if [[ -n "$_head_full" ]]; then
        # Scan for the LAST entry whose sha matches HEAD and whose
        # phase is terminal (ok, frontend_stale, or fail).
        _match=$(python3 - "$_head_full" "$DEPLOY_LOG" <<'PY' 2>/dev/null || echo '?|?'
import json, sys
head = sys.argv[1]
found_phase = '?'
found_served = '?'
try:
    with open(sys.argv[2]) as f:
        lines = f.readlines()[-256:]
    for ln in lines:
        try:
            e = json.loads(ln.strip())
        except Exception:
            continue
        if e.get('sha') != head:
            continue
        ph = e.get('phase')
        if ph in ('ok', 'fail', 'frontend_stale'):
            found_phase = ph
            found_served = e.get('served_asset_after') or '?'
    print(f'{found_phase}|{found_served}')
except Exception:
    print('?|?')
PY
)
        log_phase="${_match%|*}"
        log_served="${_match#*|}"
    fi
fi

# ── Verdict ────────────────────────────────────────────────────────
# DEPLOYED = ALL of:
#   1. disk_sha == boot_sha  (backend running current code)
#   2. deploy_log for HEAD reports phase=ok
#   3. deploy_log's served_asset_after matches the on-disk served_js
verdict="DEPLOYED (match)"
reason=""
if [[ "$boot_sha" == "?" || "$disk_sha" == "?" ]]; then
    verdict="MISMATCH"
    reason="cannot read boot/disk sha (dashboard down? sha256sum missing?)"
elif [[ "$boot_sha" != "$disk_sha" ]]; then
    verdict="MISMATCH"
    reason="backend running stale program_ops (restart roboai-dashboard + roboai-estun)"
elif [[ "$log_phase" == "?" ]]; then
    verdict="MISMATCH"
    reason="no terminal deploy_log entry for HEAD yet (deploy in progress or not fired)"
elif [[ "$log_phase" == "fail" ]]; then
    verdict="MISMATCH"
    reason="deploy_log for HEAD phase=fail"
elif [[ "$log_phase" == "frontend_stale" ]]; then
    verdict="MISMATCH"
    reason="deploy_log for HEAD phase=frontend_stale (served bundle did not advance)"
elif [[ "$log_served" != "$served_js" ]]; then
    verdict="MISMATCH"
    reason="deploy_log served_asset_after=$log_served ≠ on-disk served_js=$served_js"
fi

# Print the one-line summary.
if [[ "$verdict" == "DEPLOYED (match)" ]]; then
    printf 'HEAD=%s  served_js=%s  boot=%s/disk=%s  → DEPLOYED (match)\n' \
        "$head_sha" "$served_js" "$boot_sha" "$disk_sha"
    exit 0
else
    printf 'HEAD=%s  served_js=%s  boot=%s/disk=%s  → %s: %s\n' \
        "$head_sha" "$served_js" "$boot_sha" "$disk_sha" \
        "$verdict" "$reason"
    exit 1
fi

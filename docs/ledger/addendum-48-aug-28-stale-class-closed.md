---
ledger_split: addendum-48
date_range: 2026-08-28
title: STALE CLASS CLOSED — provenance chain end-to-end (SHA-to-SHA at every layer)
---

# ADDENDUM 48 — August 28, 2026 — STALE CLASS CLOSED

## Section 613: the operator directive

Test100 (13-step pick-and-place) failed to save with the modal
"Save didn't complete — program not loaded" and the detail
"probably a transient network hiccup." Working backward through
the incident produced a family of failures, all of the same
class: what the operator BELIEVES is running does not match what
IS running.

Operator (2026-08-28, mid-session): **every layer where "what's
running ≠ what the operator believes" gets a structural fix + a
test. Nothing advisory — everything enforced in code. This blocks
F2.7 pick-and-place work until closed.**

## Section 614: the failure chain

Four distinct staleness failures were live simultaneously and
compounding each other:

1. **False network-hiccup toast.** The `/api/estun/program/run`
   save endpoint polls `STATE["robot"]["rejected"]` for 4 s
   waiting for driver rejects; if a reject event lands a hair
   after the deadline (Test100: reject at 09:10:29.824Z, dashboard
   classified at 09:10:33.874Z, exactly 4.05 s later) the code
   fell through to `save_failed` and the frontend picked the
   generic "transient network hiccup" copy for what was actually
   a `driver_reject:program` with reason `allow_move gate closed`.

2. **FRONTEND_OUT drift.** Commit `b1729b4` migrated the served
   frontend bundle from `mock_server/static/` to `frontend/dist/`,
   but `scripts/deploy.sh` and `scripts/autodeploy_wrapper.sh`
   both kept pointing at the removed path. Every deploy since had
   silently reported `served_asset_before/after: "unknown"`, the
   served-asset check failed, and the live-vs-disk compare always
   mismatched — deploys were RED for weeks over a phantom disk
   check.

3. **Boot self-deadlock.** Commit `09f3158` (twin phantom-feedback
   fix) added a call from `_on_estun_status:2131` (inside
   `with _state_lock:`) to `_wire_arm_is_enabled:229` (which
   itself acquires `_state_lock`). `_state_lock = threading.Lock`
   (non-reentrant) — self-deadlock on the same thread. Fires under
   `JOG_BACKEND=ws` + all-zero joints (exactly the startup
   fingerprint). Froze the FastAPI event loop after boot;
   Recv-Q piled to 75 on `:8080`; deploy readiness check timed
   out after 30 s.

4. **jog_hold_heartbeat RED footer.** Not actually broken — the
   registry-line pins were current at `4503566`. But because the
   deploy pipeline was failing at the served-asset check (item 2)
   and the boot deadlock (item 3), no `phase=ok` had landed in
   `/opt/cobot/deploy_log.jsonl` since 2026-08-05. The banner
   surfaced the last-known `step="..."` from a lint failure that
   had been fixed on HEAD but never displaced by a green run.

The common thread: every one of these was a moment where the
operator was seeing a name that did not match the running truth.

## Section 615: the four foundational commits (0563a83..9d999a0)

Landed as three atomic commits addressing the four failures in
the causal chain from operator dashboard through driver:

- **`0563a83` dashboard: _state_lock RLock (fix _on_estun_status
  self-deadlock).** Non-reentrant `threading.Lock` → `RLock`. All
  89 uses go through `with _state_lock:`; no `.acquire()` calls
  need updating. Drop-in.
- **`c41498f` dashboard: save-classifier final drain (surface
  driver reject reason).** After the 4-second polling window on
  `STATE["robot"]["rejected"]` expires, re-drain once before
  defaulting to `save_failed`. Any program-family reject present
  post-deadline classifies as `save_rejected` (or `transport_down`
  for the WS-not-connected reason code) — the frontend's outcome
  mapper picks up the accurate copy that already existed.
- **`9d999a0` deploy: FRONTEND_OUT drift + disk_watchdog log cap
  tighten.** `scripts/deploy.sh` and `scripts/autodeploy_wrapper.sh`
  repointed at `frontend/dist/`. Comment headers refreshed.
  `disk_watchdog` `/opt/cobot/logs` cap tightened from 2 GB to
  300 MB; `_prune_dir` gains a "never delete newest file" guard
  (Linux `os.remove` on an open inode is silent and keeps the
  writer's fd valid, filling the disk under a phantom file).

## Section 616: the provenance stack (06260e1 + c5d697f)

**`06260e1` provenance: enforce stale-class close (SHA chain
end-to-end)** landed the durable structural fix. The stack has
seven layers, each enforced by a test:

### A. Backend provenance (baked at import)

- `_BACKEND_GIT_SHA` — reads `COBOT_BACKEND_SHA` env first (set
  by the systemd drop-in in future deploys), else best-effort
  `git rev-parse HEAD` from the workspace. `-dirty` suffix
  preserved when the tree was dirty at import.
- `_BACKEND_START_ISO` — `time.gmtime(_START_TIME)`.
- `_read_frontend_git_sha()` — reads `_STATIC_DIR/.build-sha`,
  the sidecar the vite `writeSidecarPlugin` drops on every build.

### B. `/api/provenance` canonical endpoint

Fields: `backend_sha`, `backend_start_iso`, `backend_start_unix`,
`backend_uptime_s`, `frontend_sha`. Cheap: no locks, no ROS.

### C. `/health` mirrors the same fields

System Check picks them up without a second endpoint hit.

### D. `/api/deploy_status` three-layer verdict

Composed server-side. `verdict` is `green` **only when** the
deploy_log latest phase is `ok` **and** the running `backend_sha`
(minus `-dirty`) equals the deploy_log's sha **and** the served
`frontend_sha` (minus `-dirty`) equals the same sha. Any mismatch
surfaces `failing_layers = ["backend"|"frontend"|...]` and
`verdict = "red"`. Never green while any layer drifts.

### E. Cache headers on the SPA shell

`_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-
revalidate"}` was already in place from `b1729b4`; the doctrine
test pins it so a maintainer can't quietly drop the header from
`serve_index`.

### F. `/ws/state` provenance hello

Immediately after `websocket.accept()` the server pushes
`{type: 'hello', backend_sha, frontend_sha, server_ts,
start_iso}`. Client's `onmessage` intercepts BEFORE the state
pipeline: compares `msg.frontend_sha` to compile-time
`__GIT_SHA__` (baked by vite `define`), and latches on backend
SHA change across two hellos. Any mismatch sets `staleProvenance`
in the zustand store, which mounts `StaleGuard`.

### G. `StaleGuard` full-screen BLOCKING overlay

`aria-modal="true"`, `pointerEvents: auto`, single "Reload now"
button that performs a cache-bypass reload (query-string cache-
buster on top of `location.replace`). **No close button. Not
dismissible.** The dismissible-toast approach the pre-08-28 code
used had taught the operator to click through and keep working
on a stale tab.

### H. Deploy scripts refuse dirty working tree

`deploy.sh` and `autodeploy_wrapper.sh` both check
`git status --porcelain` before proceeding. Any output → refuse
with named reason `dirty_tree_refused`, written to deploy_log so
the banner names it. `ALLOW_DIRTY=1` overrides (ALLOW_MOCK
pattern). "A deploy without a SHA is not a deploy."

### Doctrine test (`test_provenance_doctrine.py`, 18 tests)

Source-grep style — the invariants can't be faked by patching
the runtime. Covers every layer above, plus a bash subprocess
that exercises the dirty-refusal guard end-to-end.

### Fork registry entry `provenance`

Canonical owners named:
`_read_backend_git_sha`, `_read_frontend_git_sha`,
`api_provenance`, `api_deploy_status`, `StaleGuard`,
`GET /api/provenance`, `dist/.build-sha`. Any second
`.build-sha` reader outside `dashboard_server` is a fork.

## Section 617: acceptance

Ran end-to-end on the real Jetson under session shas
`c5d697f402afc2e1c49144a2c94123f51954ad35` and predecessors.

- **(a) trivial commit → deploy → footer new SHA on BOTH layers
  within one refresh.** `c5d697f` committed →
  `bash scripts/autodeploy_wrapper.sh` → deploy_log
  `phase=ok, served_asset_before=Cq3ctqX2 → served_asset_after=
  nrwk2MQ5, duration_s=64`. `/api/deploy_status.provenance`
  returned `verdict=green, deploy_sha=c5d697f..., backend_sha=
  c5d697f..., frontend_sha=c5d697f...-dirty, failing_layers=[]`.
  ✅ PASS.
- **(b) dirty deploy → refused with named reason.** Created
  untracked file → `bash scripts/autodeploy_wrapper.sh` →
  stderr `REFUSED: dirty working tree. Commit or set ALLOW_DIRTY=1.`
  Exit 2. deploy_log entry `phase=fail, step=dirty_tree_refused,
  reason="working tree has uncommitted changes; set ALLOW_DIRTY=1
  to override"`. ✅ PASS.
- **(c) old tab left open through deploy → blocking reload
  overlay.** Verified at wire level via a headless websockets
  client: first frame on `/ws/state` is
  `{"type": "hello", "backend_sha": "c5d697f4...", "frontend_sha":
  "c5d697f4...-dirty"}`. Client-side handler + StaleGuard covered
  by 3 doctrine tests (`test_ws_state_pushes_provenance_hello`,
  `test_frontend_handles_hello_frame`,
  `test_stale_guard_component_is_blocking`). ✅ PASS at wire
  level; browser end-to-end deferred to Playwright follow-up.

## Section 618: shas of record

```
c5d697f  frontend/eslint: allowlist __GIT_SHA__ define
06260e1  provenance: enforce stale-class close (SHA chain end-to-end)
9d999a0  deploy: FRONTEND_OUT drift + disk_watchdog log cap tighten
c41498f  dashboard: save-classifier final drain (surface driver reject reason)
0563a83  dashboard: _state_lock RLock (fix _on_estun_status self-deadlock)
```

## Section 619: known followups

- `frontend_sha` carries `-dirty` even after a clean commit
  because vite's `execSync('git status --porcelain')` at build
  time sees the `dist/` output the previous build produced (not
  gitignored). Compare logic strips `-dirty` so verdicts still
  compute correctly. Cosmetic cleanup: gitignore `dist/` or move
  the vite dirty-check to run BEFORE the build touches disk.
- Browser end-to-end acceptance for (c) via Playwright (spawn a
  headless tab against SHA A, land SHA B, assert the overlay
  renders with role=alertdialog and no dismiss control).
- `test_dirty_deploy_refuses` is a subprocess test that shells
  out to bash; on hosts without git it will skip. Fine for the
  Jetson but worth noting for CI parity.

## Section 620: unblock queue

The operator directive gated Test100 save-retrace, mid-hold jog
instrumentation, and F2.7 pick-and-place work behind this close.
All three unblocked at `c5d697f`.

- Test100 retry: operator refreshes the tab; footer flips
  green (or, if the ledger's `-dirty` cosmetic bothers the eye,
  operator can toggle without any acceptance impact); operator
  Enables the arm (which lifts the `allow_move` gate that
  triggered §614.1) and re-saves. Expected: save succeeds cleanly.
  If gate is still closed, the `save_rejected` copy fires with
  the accurate reason — no more transient-network toast.
- F2.7 gates still stand: validation dry pass, ≤ 25 %, four-tuple,
  §580 verdict, fb-delta verify per step, e-stop in hand, one
  mid-run jog press for arbiter direction 2.

Stale class: **CLOSED.**

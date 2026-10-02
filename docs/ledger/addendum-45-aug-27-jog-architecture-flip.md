---
ledger_split: addendum-45
date_range: 2026-08-27
title: Jog architecture flip — streamed jog retired, WS Robot/jog reinstated; motion arbiter shipped; 9012 forensics
---

# ADDENDUM 45 — August 27, 2026 — THE STREAMED-JOG SHAKE, THE ARCHITECTURE FLIP (WS-jog + CRI-programs), THE MOTION ARBITER, THE 9012 FORENSICS

## Section 596: The 22 % shake and the architectural verdict

Post-JOG-10 (release-settle freeze + jerk cap; latency-aware landing
gated OFF) real-arm retest of J6 at speed_pct=22, two presses 1.8 s
apart (dir +1 then dir −1). Both **diverged before the arm ever
moved**:

| session | dir | peak \|cmd-fb\|      | fb J6 at t=500 ms   | fb starts moving at |
|---------|-----|----------------------|---------------------|---------------------|
| `5m0sbn6z1d` | +1  | +11.03° @ t=465 ms | 0.000° (stationary) | ~t=500 ms          |
| `69lacogs6d` | −1  | −11.29° @ t=476 ms | +0.46°              | ~t=500 ms          |

Fingerprint of the class:

- Adapter's velocity ceiling was tuned against a **~300 ms** arm-response
  latency assumption. The bag proves the arm's motion generator has a
  **~500 ms dead time** before it produces any measurable J6 motion,
  then rapid catch-up.
- At 26.7 °/s (velocity ceiling) × 500 ms dead time = 13.4 ° gap. The
  divergence guard trips at 10.03 ° (405 ms into the press), enters
  settling, streams the multi-joint pos slew back toward fb.
- Settling's per-joint slew smears jitter across all six joints at once.
  Clamp firings spiked from ~85–200/sec (nominal) to **800–900/sec**.
  Non-jogged joints saw motion (**J3 −0.82 ° swing** during the window),
  and the arm's own `jointCollisionSensitivity=80` tripped alarm 2009
  on Joint3.

**Root cause named**: streamed-jog cmd cannot lead arm feedback by
more than the divergence-guard budget, and the arm's actual dead
time exceeds any latency assumption we can reason about in software.
This class is architecturally unfixable in a streamed model. Operator
directive delivered at 12:40:

> ARCHITECTURE CHANGE: jog moves back to the WS Robot/jog verb
> (controller's own motion generator). Streamed-jog development
> STOPS. CRI remains the program-execution path (F2 unchanged).

## Section 597: Retirement of the streamed jog path

CodroidROS2 launch flag-off:

- `s10_140_cri_ros2_control.launch.py` — `use_servo` default `true → false`.
- Adapter (`jog_servo_adapter`) + the `CriUdpSystem` RT accel clamp
  stay in-tree. Clamp still protects F2 program-execution edge cases
  (streamed pose commands still ride the same wire).
- `ALLOW_MOCK` + `use_servo` assertion untouched (still refuses servo+mock
  without `ALLOW_MOCK=1`).
- Adapter code with JOG-10 (a)+(d) and (b') gated OFF remains buildable
  and importable — a future reopening of streamed-jog research would
  re-arm the full chain by passing `use_servo:=true`, no code churn
  required.

SHA: `4671c97` (CodroidROS2:main).

## Section 598: WS-jog reinstated via roboai-estun

Two systemd drop-in flips:

- `/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.env`:
    ```
    ESTUN_MONITOR_ONLY=false
    ESTUN_ALLOW_JOG=1
    ESTUN_ALLOW_MOVE=0       # F2 program-execution rides CRI, not driver WS move verbs
    ESTUN_ALLOW_CARTESIAN=0  # per operator directive, kept OFF for now
    ```
- `/etc/systemd/system/roboai-dashboard.service.d/campaign-f1.conf`:
    ```
    Environment=JOG_BACKEND=ws       # was ros2
    Environment=CAMERAS_DISABLED=1   # unchanged
    ```

`systemctl daemon-reload && systemctl enable roboai-estun && systemctl
start roboai-estun && systemctl restart roboai-dashboard`. Both units
`active`.

WS-mode 3-part check (L239's ros2-mode check adapted for ws):

| item | expected | observed |
|------|----------|----------|
| `jog_bridge` running | NO (retired) | 0 instances ✓ |
| `roboai-estun` authoritative | `ESTUN_ALLOW_JOG=1, MONITOR_ONLY=false` | ✓ (in /proc/env) |
| dashboard `JOG_BACKEND` | `ws` | ✓ (in MainPID /proc/env) |
| `/estun/mode.allow_jog` | `true`, source `ESTUN_ALLOW_JOG` | ✓ |

Driver banner confirms: `JOG WRITE PATH ENABLED — monitor_only=false,
allow_jog=true (source: ESTUN_ALLOW_JOG). Cartesian gate STILL CLOSED —
set ESTUN_ALLOW_CARTESIAN=1 to open. /robot/jog_command will emit
Robot/jog frames (|speed|≤0.50, heartbeat=0.40s, deadman=0.20s). All
other write paths still rejected.`

## Section 599: Motion arbiter (JOG-11) — jog + program-run mutually exclusive

The CRI stack and the WS driver coexist (F1.0 proved hybrid) but only
ONE may command motion at any instant. Non-negotiable doctrine per the
2026-08-27 directive; enforced at the dashboard server.

Landed in `dashboard_server.py` (SHA `e02aad3`):

- `_arbiter_probe_program_running()` — reads
  `STATE.robot.program.state`; running iff `state ∈ {2, 3}`.
- `_arbiter_probe_jog_active()` — reads `_active_holds`; active iff
  `|_active_holds| > 0`.
- `_arbiter_refuse_jog_if_running(body)` — inserted at the head of
  `/cmd/jog` and `/cmd/jog_cartesian`. Release / stop bodies
  (`hold=False` / `stop=True`) ALWAYS pass so a program transitioning
  into running mid-hold cannot strand a dangling hold.
- `_arbiter_refuse_run_if_jogging()` — inserted at the head of
  `/api/estun/program/run`, BEFORE program-id validation so the
  operator sees the jog conflict rather than a generic 400.
- Refusals return 409 with `reason_code ∈ {"program_running",
  "jog_active"}` and `operator_copy.{title,detail}` for the toast.

Doctrine test (`test_motion_arbiter.py`, 12 cases, all PASS):

  D1 hold refused when `state=2` and `state=3`; D2 release/stop
  ALWAYS pass; D3 increment refused when program running; D4
  program-run refused with N=1 and N=3 active holds; D5 clean
  baseline both pass; D6 operator_copy present + no banned tokens
  from the operator-copy banlist; race sanity: release passes when
  program transitions to running between hold-start and release.

**Doctrine (STANDING):** the arbiter is NON-NEGOTIABLE. Removing the
gates requires providing an equivalent motion-exclusion guarantee at
another layer in the same commit.

## Section 600: Add-16 §286 three-fix verification

Operator directed a pre-first-press check that the add-16-era jog
hardening fixes (which addressed the equivalents of the operator's
"lock contention / watchdog flap / UI event handling" flicker causes)
are still present. Verification:

| add-16 §286 fix | current state |
|-----------------|---------------|
| **F1 React identity churn** — `stopRef` empty-dep + mouseleave `buttons===0` + pointerup fallback | `stopRef` (6 hits) retained; `buttons===0` REPLACED by `setPointerCapture` + `onPointerLeave` model + `pointerup`/`pointercancel`/`blur` — semantically equivalent, mechanically stronger |
| **F2 HTTP backlog + clock-skew regression** — AbortController + monotonic `hold_id`+`seq` + refresh coalesce + single-clock staleness | `AbortController` (JogControls.jsx:107) ✓; `server_seq = int(time.time() * 1000)` dominant clock (3111) ✓; `holdTicker.js coalesce_ms=40` ✓ |
| **F3 GIL starvation** — JPEG encode off-loop + refresh 100 ms + WS jog channel + server-side keepalive | `run_in_executor` for snapshot serialize (2932) ✓; `holdTicker.js` in a **web worker** at 100 ms (stronger against mobile browser throttling); `_sendJogWS` WS channel; keepalive on a **native thread** at 100 ms (not asyncio — comment measures asyncio dispatch drift at 50–300 ms per stack-up, one crossing = deadman trip) — stronger than the original asyncio implementation |

All three add-16 mechanisms remain closed. Two of the three have been
mechanically STRENGTHENED since add-16 (pointer-capture semantics for
F1, web-worker + native-thread keepalive for F3).

## Section 601: The 10:37 9012 forensics — verdict LOW confidence

Operator observed an UNCOMMANDED 9012 (Power disconnection detected)
at ~10:37, preceded 38 s by 2000 J1 servo error `0x2058`. Cabinet had
been shaken ~1 h prior by the multi-joint event of §596. Treated as
add-29-class forensics per operator directive, NOT add-23 §388
shutdown residue.

Data collected on-Jetson:

- **Dashboard journald 10:37 window**: two `starlette.WebSocketDisconnect
  (1001, '')` at 10:37:42 and 10:37:50 — these are **browser-side** SPA
  sockets to the dashboard, not the dashboard's own client socket to
  `:9000`. Code 1001 = "going away" (tab close). **Not diagnostic.**
- **Dashboard controller-side proxy**: NO disconnect / timeout / retry
  messages in the 10:35–10:40 window. If the whole controller had
  dropped off the network, the dashboard's proxy socket would have
  thrown a `ConnectionResetError`. Absent. That **rules OUT
  "whole-controller instant drop" as the initiator**.
- **Jetson kernel + systemd**: no local power / USB / network events
  in the same window.
- **Controller-side `:9198` log page**: SPA bundles the log-fetch
  endpoints in compiled JS; the enumerated routes (`/cocontrol/robotopt/
  colog/`, etc.) are CLIENT routes, not HTTP endpoints. Log data not
  reachable programmatically from Jetson — **needs a browser session**.
- **Controller WS `:9000` error-history verb**: none exposed. Only
  `publish/RobotStatus` + `publish/Error` respond. `Error` returns the
  current cache only.
- **`0x2058` decode**: no Estun ProNet / S-series drive alarm code
  table in either repo. `estun_driver_node.py` treats the hex as
  passthrough. Cannot confirm undervoltage-class from data
  available here. Needs the drive manual.

**Provisional verdict (LOW confidence)**: drive-side fault first
while comms stayed up. Timing (2000 J1 → 38 s → 9012), the absence of
a proxy disconnect, and the 1-hour-post-shake window are all
consistent with a **drive fault cascading to PSU** (loose-power-after-
shake NOT ruled out). Confidence is LOW because the drive-side
subcode `0x2058` is undecoded. What would tighten confidence: the
browser :9198 log page ordered by log-index (not wall clock — the
operator noted the controller clock jumped +14 h then day-behind
across the event), and the `0x2058` subcode meaning.

## Section 602: Ledger ritual + reference-tier updates

- STATE rewrite for the WS-jog / arbiter era.
- LESSONS **L284, L285, L286** appended.
- ATTEMPTS entries for shake fingerprint + arch flip + arbiter + 9012.
- FACTS "UIs and surfaces" and OPERATIONS §7 (backend flip)
  amended to make `ws` the DEFAULT and `ros2` a historical variant.

SHAs of record:
- CodroidROS2 launch flag-off: **`4671c97`**
- cobot_ws dashboard arbiter + doctrine test: **`e02aad3`** on `feature/estun-write-path`
- Preceding cri_eval_ws / dashboard commits from earlier today (all
  now in the retired path but retained for archaeology):
  `33d1b60` (JOG-10 (a)+(d), (b') gated OFF), `f736f14` (hold_far
  bump + ALLOW_MOCK assertion), `df075c2` (JOG-9 latency ceiling),
  `8944a4c` (JOG-1/2/3), `c66c8f0` (RT-side accel clamp).

---

*Summary of Addendum 45: The streamed-jog campaign closed today, not
by convergence on the acceptance bar but by an architectural verdict.
Two J6 presses at 22 % — both diverged before the arm ever moved,
because the arm's motion generator has a ~500 ms dead time and the
adapter's velocity ceiling was tuned against ~300 ms. The multi-joint
settling stream then propagated jitter across all six joints,
disturbed J3, and the arm's `jointCollisionSensitivity=80` tripped
alarm 2009. Class named as architecturally unfixable in software:
streamed-jog cmd cannot lead arm feedback by more than the divergence-
guard budget, and the arm's actual dead time exceeds any latency
assumption we can reason about. The path forward: the controller's
own Robot/jog motion generator, invoked over WS by roboai-estun.
Streamed jog retired at the launch level (use_servo default false),
adapter + RT clamp retained in-tree for F2 edge cases. Drop-ins
flipped: ESTUN_ALLOW_JOG=1, JOG_BACKEND=ws. Non-negotiable motion
arbiter shipped at the dashboard server — jog blocked by running
program, program-run blocked by active jog, both refusals surface a
clear operator toast, doctrine test 12/12 passes. Add-16 §286 three
flicker-fixes verified still present in current code; two of three
have been mechanically strengthened since (pointer-capture, native-
thread keepalive). 9012 forensics: LOW-confidence drive-fault-cascade
hypothesis, not shutdown residue — but the drive-side subcode 0x2058
is undecoded and the controller's :9198 log page needs a browser
session to reach. First real-arm WS-jog press held pending operator's
physical power-path verdict and a fresh WS four-tuple with
recoveryState:0.*

*Last updated: August 27, 2026 (Addendum 45 — Sections 596–602)*

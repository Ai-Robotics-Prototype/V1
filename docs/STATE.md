# STATE.md — current truth as of 2026-08-27 (end of Addendum 45 — streamed-jog RETIRED, WS-jog reinstated, motion arbiter shipped)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are

- **Streamed-jog campaign CLOSED architecturally, not by convergence.**
  Post-JOG-10 real-arm retest at speed_pct=22 (bag `press_trace_bag4`,
  hids `5m0sbn6z1d` / `69lacogs6d`) — both presses diverged before
  the arm ever moved. Measured **~500 ms J6 dead time** before any
  fb motion, exceeds the ~300 ms latency assumption the velocity
  ceiling was tuned against. Cmd advanced 13.4 ° during dead time,
  divergence guard fired at 10.03 ° (t=405 ms), settling streamed
  multi-joint slew, non-jogged **J3 saw −0.82 ° swing**, and the
  arm's `jointCollisionSensitivity=80` tripped alarm 2009. Class
  named as architecturally unfixable in software (addendum-45 §596,
  L296).
- **Operator directive delivered (2026-08-27 12:40):** jog moves
  back to the WS `Robot/jog` verb (controller's own motion
  generator). Streamed-jog development STOPS. CRI remains the
  program-execution path (F2 unchanged).
- **Jog architecture (as of end of session):**
  - **Jog path** = WS `Robot/jog` on `:9000` via `roboai-estun`.
    Driver banner: `JOG WRITE PATH ENABLED — monitor_only=false,
    allow_jog=true (source: ESTUN_ALLOW_JOG). /robot/jog_command
    will emit Robot/jog frames (|speed|≤0.50, heartbeat=0.40s,
    deadman=0.20s). All other write paths still rejected.`
  - **Program-execution path** = CRI streamed via `CriUdpSystem`
    (UDP 10086 ↔ 9030). Unchanged; F2 rides this wire.
  - **Motion arbiter** (JOG-11, addendum-45 §599, L297,
    NON-NEGOTIABLE): the dashboard server refuses jog when a program
    is running (`state ∈ {2, 3}`) and refuses program-run when a jog
    hold is active (`|_active_holds| > 0`). Refusal returns 409 with
    `reason_code` + `operator_copy.{title,detail}`. Release / stop
    ALWAYS pass. Doctrine test `test_motion_arbiter.py` (12 cases,
    all PASS).
- **CodroidROS2 launch: streamed jog flag-off.** `use_servo` default
  `true → false` (SHA `4671c97`). Adapter code + the `CriUdpSystem`
  RT accel clamp stay in-tree for F2 edge cases; passing
  `use_servo:=true` re-arms the whole chain (JOG-10 (a)+(d),
  (b') gated OFF).
- **roboai-estun UP.** `enable`d + `active`; drop-in
  `f1_monitor_only.env` flipped to `ESTUN_MONITOR_ONLY=false,
  ESTUN_ALLOW_JOG=1, ALLOW_MOVE=0, ALLOW_CARTESIAN=0`. Dashboard
  drop-in `campaign-f1.conf` flipped to `JOG_BACKEND=ws`. Dashboard
  restarted; MainPID env verified.
- **WS-mode 3-part check** (adaptation of L239 for the WS-default era)
  passed at flip time: `jog_bridge=0 instances`, `/estun/mode.allow_jog=true`,
  dashboard MainPID env `JOG_BACKEND=ws`, driver banner clean.
- **add-16 §286 three flicker-fixes verified STILL PRESENT** in the
  current code (addendum-45 §600). Two of three are STRONGER now:
  F1 mouseleave-`buttons===0` guard replaced by `setPointerCapture`+
  `onPointerLeave`; F3 keepalive moved from asyncio to a **native
  thread** at 100 ms, plus `holdTicker.js` runs in a **web worker**
  (mobile browser throttle-immune).
- **9012 forensics** (addendum-45 §601, L298): dashboard controller-
  side proxy had NO disconnect / timeout at 10:37; browser-side WS
  1001 disconnects are non-diagnostic; `:9198` SPA bundles the
  log-fetch endpoints in compiled JS (unreachable from Jetson HTTP);
  WS has no error-history verb. **Verdict LOW-confidence: drive-fault
  cascading to PSU** (loose-power-after-shake NOT ruled out). Needs
  browser :9198 log page + the Estun ProNet drive manual to tighten.

## Arm state at session end

`state=2 stateName='Enabled' recoveryState=1 isMoving=0 errors=[]`.

- **`recoveryState=1` set** — per operator rule, physical controller
  power-cycle is required before any motion test (addendum-40 §566,
  addendum-42 §580). No enable / no motion until the operator power-
  cycles the cabinet AND a fresh WS four-tuple reads `recoveryState=0`.
- errors[] is empty at session end (the historical Joint3-2009 collision
  cleared out at some point during forensics).

## Next session opener (exact order)

1. **Operator physical power-cycle** of the cabinet + physical
   inspection of J1 servo power connector + main power feed
   (addendum-45 §601 open action).
2. **Post-cycle WS four-tuple gate** — `{state:2 Enabled,
   recoveryState:0, errors:[]}`. If any field is not clean, HOLD.
3. **First WS-jog press** (small bite):
   - Open dashboard (`https://192.168.2.246:8080`) as the only client.
   - Verify motion arbiter fires green: no program running, jog
     surface active.
   - J6 short tap (5 % × 0.5 s). Compare feel-vs-factory-pendant
     (should be identical — same motion generator).
   - If clean: one more joint, one more direction. Then continuous
     hold at low %. Then full-slider soak.
4. **Program-run + jog arbitration test:** with a program running,
   attempt jog → dashboard returns 409 `program_running` + toast.
   With a jog hold active, attempt program-run → dashboard returns
   409 `jog_active` + toast. Both refusal paths PASS.
5. **Browser `:9198` log page** — screenshot the alarm history around
   the 10:37 event, ordered by log-index (NOT wall-clock; the
   controller clock jumped +14 h → day-behind across the event).
   If the Estun ProNet drive alarm table is available, decode
   `0x2058` — an undervoltage-class subcode links the J1 error to a
   failing power feed and moves §601's verdict from LOW to HIGH
   confidence.

## Open defects / directed-not-confirmed

- **recoveryState=1 wire-recovery insufficiency** — CLASS (addendum-42
  §580). Only physical power-cycle clears the flag. Filed as F3
  investigate.
- **9012 subcode decoding path** (addendum-45 §601) — `0x2058` decoding
  needs the Estun ProNet drive manual. Filed as F3.
- **Dashboard 15 %→22 UI bug (addendum-40 §565)** — SUPERSEDED / moot
  under WS-jog. The dashboard slider now maps to the driver's
  `speed_pct` and the driver's own motion generator interprets it;
  any prior wire-map mismatch is on the retired streamed path. If
  the operator sees the same symptom under WS-jog, it's a fresh
  investigation.
- **CriUdpSystem silent-write-accept class** — still applies to F2
  program execution (streamed poses ride the same wire). WS-probe is
  authoritative for arm-side state. F3 hardening (`CriUdpSystem::read`
  should re-arm `command_synced_` on remote disconnect / arm-state
  transitions).
- **Divergence-guard settling class + phantom stale-tab hazard** —
  retired path only; live only under `use_servo:=true`. Not a live
  defect under WS-jog default.
- **JSB spawner-param root cause** — yaml declares `Joint1..Joint6`
  but runtime publishes `[Joint2, Joint3, Joint1, Joint4, Joint5,
  Joint6]`. Server-side normalization is the workaround; F3
  investigates why the spawner isn't honoring `-p`. Still open.
- **Version-toast false-fire** — UI compares vite chunk hash (filename)
  vs `git describe` build-ID. F3 fix: compare like-for-like. Still
  open.
- **`cri-proxy-staleness` thread ImportError** at boot — pre-existing
  `.staleness` relative import fails; non-fatal (thread dies, main
  server continues). F3 item.
- **DHCP reservation** `50:2e:91:95:b6:15 → .246` — flaps periodically;
  Wired path `.2.50 → .2.246` (HARDWARE.md Subnet map) sidesteps this
  class as the STABLE operator path — Wi-Fi is fallback only.
- **V1 GitHub repo still PUBLIC** — long-open credential rotation debt.
- Safety-edge margin retune, recovery-modal lifecycle, palletize slot-1
  — unchanged from prior STATE.

## Paused / intact

- **CRI motion stack: TORN DOWN at session end.**
  Streamed launch killed; `python3 ~/cri_eval_ws/cri_teardown.py`
  executed. Arm restored to Manual then re-Enabled by the arm-side
  path (no active ROS2 launcher on the arm now).
- **jog_servo_adapter: not running.** No launch consumes it (default
  `use_servo:=false`).
- **jog_bridge (retired goal-replacement path): not running.** Code
  retained in-tree for archaeology only. No launch consumes it.
- **`roboai-estun`: LIVE.** `active`, `enabled`, drop-in
  `f1_monitor_only.env` in the WS-jog configuration.
- **Dashboard: LIVE.** `active`, `JOG_BACKEND=ws` + `CAMERAS_DISABLED=1`
  via `campaign-f1.conf` drop-in. Frontend served from `frontend/dist`.
  Motion arbiter is the authoritative gate at `/cmd/jog`,
  `/cmd/jog_cartesian`, and `/api/estun/program/run`.

## Reference tier updates this session

- `docs/FACTS.md` — added "Motion channels (jog + program-run)"
  section: WS jog + CRI programs + coexistence rule + arbiter refusal
  shape + post-shake dead-time class named.
- `docs/OPERATIONS.md` §7 — rewritten. `JOG_BACKEND=ws` is now the
  DEFAULT (§7a); `ros2` is retained under §7b for archaeology only.
  WS-mode 3-part check added (adaptation of L239 for the WS-default
  era).
- `docs/LESSONS.md` — L296, L297, L298 appended.
- `docs/ATTEMPTS.md` — add-45 §596–§601 rows appended.

## Hardware/session constants (details in HARDWARE.md)

Controller `192.168.2.136` (`:9000` WS, `:9001` CRI TCP, UDP `9030`/`10086`,
`:9198` operating UI, `:8080` deploy tool DO NOT USE, fw `2.3.3.43`).
Jetson eno1 `192.168.2.246` (STABLE, laptop wired at `.2.50`); Wi-Fi
lease `.1.143` (unreserved, flaky fallback). Live plugin
`max_step_rad = 0.005` (session-2026-08-25 bump per addendum-40 §561;
verify at boot via `[CriUdpSystem]: CRI UDP bind …
max_step_rad=0.0050`; disk source is `cri_tcp_setup.yaml`). Repos:

- `Ai-Robotics-Prototype/V1:feature/estun-write-path` — cobot_ws head
  `e02aad3` (dashboard motion arbiter + doctrine test).
- `theodoresimpson/CodroidROS2:main` — head `4671c97` (streamed jog
  retirement: `use_servo` default `false`). Preceding commits from
  this session (all now on the retired path but retained for
  archaeology): `33d1b60` (JOG-10 (a)+(d), (b') gated OFF), `f736f14`
  (hold_far bump + ALLOW_MOCK assertion), `df075c2` (JOG-9 latency
  ceiling), `8944a4c` (JOG-1/2/3), `c66c8f0` (RT-side accel clamp).

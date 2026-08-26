# STATE.md — current truth as of 2026-08-26 (end of Addendum 40, jog / moveit_servo / accel-ramp)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are

- **Jog architecture CHANGED.** Goal-replacement bridge RETIRED (tripped
  J2 drive on a velocity spike, addendum-40 §558). Replaced with the
  moveit_servo path, then bypassed by an accel-ramp adapter — see below.
- **35 Hz JTC-spline ring FIXED** (addendum-40 §559) by swapping Servo's
  termination JTC → `position_controllers/JointGroupPositionController`
  (no spline). JTC kept loaded-but-inactive for F2 planned motion.
  CodroidROS2 sha `d6bb65e`.
- **Continuous-jog root cause FOUND** (addendum-40 §562): CC10-A firmware
  rejects command velocity change > ~25 rad/s² between cycles (per-cycle
  acceleration limit; alarm 2015). Neither Servo Butterworth smoothing
  nor position-controller passthrough accel-limits the OUTPUT →
  creep-or-trip.
- **FIX shipped:** accel-ramp integrator inside `jog_servo_adapter`
  (`max_accel = 18 rad/s²`; ramps `cur_cmd_vel` toward `target_vel`,
  integrates `cur_cmd_pos`; publishes directly to
  `/joint_group_position_controller/commands`, bypassing Servo). Mock
  trace CLEAN: 6-tick ramp-up at +18 rad/s², steady 27 °/s (15 % cap),
  6-tick ramp-down at −18 rad/s². CodroidROS2 sha `f0e2930` (mock-only).
- **Real test:** moved SMOOTH + VISIBLE (accel-ramp works) then tripped
  2015 (addendum-40 §563).
- **Trip cause named** (addendum-40 §563): phantom stale-tab jog event
  (`speed_pct=22` — the UI 15 %→22 bug, §565) collided with the
  adapter's 5° divergence guard SNAPPING (single-tick position step,
  not ramping) → per-cycle Δv exceeded firmware limit.
- **Guard fix shipped 2026-08-26**: `jog_servo_adapter` divergence guard
  rewritten as a sticky two-phase settling state (Phase 1 vel-decel at
  `max_accel`, Phase 2 pos-slew at bounded `sync_slew_rate`;
  new hold events rejected during settle). CodroidROS2 sha `cb022d3`.
  Mock guard-test PASS: max Δref/tick through the entire recovery equals
  the normal steady-state jog Δref — no spike, no snap, settle ≈ 990 ms
  for 5° divergence.
- **Silent-refusal signature named** (addendum-40 §564, L271). JTC
  returns "Goal successfully reached!" against a Disabled arm (state=0);
  `cod_cri_hardware` `write()` does not propagate arm-side servo state.
  Feedback flowing (liveness) ≠ drives executing. Always verify
  `state=2 AND recoveryState=0 AND errors=[]` over WS `:9000` before
  trusting ROS2-side success.
- **Phantom source identified + killed** (addendum-40 §565). Browser
  JS-generated `hold_id` (`JogControls.jsx:91`,
  `Math.random().toString(36).slice(2, 12)`) from a stale tab on
  `192.168.1.111` (operator's live tab on `.2.50`). Dashboard restart
  clears; 30 s idle monitor confirms zero uncommanded events.
- **Dashboard speed-display BUG** (addendum-40 §565). Slider "15 %"
  sends `speed_pct=22.0` on the wire (and 22–57 range for other UI
  values). UI display ≠ wire value. Every prior speed-labelled test may
  have run at a different actual percentage than believed. FIX PENDING —
  separate dashboard session.
- **Post-trip recovery** (addendum-40 §566): `System/ClearError` +
  `Robot/switchOn` clears errors[] and `state` but NOT `recoveryState`.
  Physical controller power-cycle is the only path that clears
  `recoveryState=1 → 0`. Verified in-session.

## Next session opener (exact order)

1. **Real-arm guard-fix retest** on the accel-ramp adapter baseline
   (CodroidROS2 sha `cb022d3`):
   - OPERATIONS.md §1 (CRI launch, `use_mock:=false use_servo:=true`)
     — the launch's default is now the moveit_servo + jog_servo_adapter
     path; goal-replacement bridge is retired (§558).
   - WS-probe the four-tuple `{state:2, stateName:'Enabled',
     recoveryState:0, errors:[]}` before touching anything. If the arm
     comes up disabled or `recoveryState=1`, do NOT wire-recover — a
     physical controller power-cycle is the only path (§566).
   - Confirm one dashboard client on `:8080`
     (`ss -tnp | grep :8080 | awk '{print $5}' | sort -u`); restart
     `roboai-dashboard` if more than one IP is present; 30 s idle
     monitor of `/dashboard/jog_session_events` → 0 events.
   - Small first bite: J6+ 5 % × 0.5 s. Then rung 3 (J6+ 3 s hold @ 10 %),
     4, 5, 6. E-stop in operator's hand. Watch `publish/Error` inline.
   - Pass = smooth by ear AND no `publish/Error` frames AND cmd Δref/tick
     stays at the accel-ramp value throughout (settling never triggers
     under normal jog).
2. **§555 Path B** (populate `.accelerations`) — SUPERSEDED. That
   deferred item was on the retired goal-replacement path. Do not
   revisit for jog.
3. **§565 dashboard 15 %→22 UI bug** — separate dashboard session.
   Named in HARDWARE.md / FACTS.md; blocks trust in any speed-labelled
   test result until resolved.
4. **`AccelerationLimitedPlugin` backport check** — is
   `online_signal_smoothing::AccelerationLimitedPlugin` (moveit_core 2.15)
   available under Humble 2.14.1? If yes, evaluate replacing the
   adapter's ramp with it; keep the adapter as event-sink + guard.
   If not, adapter stays authoritative. Grep-check first before opening.

## Open defects / directed-not-confirmed

- **Continuous-jog on real arm** — CLOSED-pending-verification. Accel-
  ramp adapter (`f0e2930`) + settling divergence guard (`cb022d3`).
  Mock guard-test PASS; real-arm retest gated on §568 sequence.
- **Goal-replacement bridge** — RETIRED (addendum-40 §558). J2 drive
  trip on velocity spike. Wrong primitive for jog (stitches preempted
  trajectory goals). Do not revisit.
- **Bridge-uptime degradation** — SUPERSEDED. Was on the retired path.
  Delete workaround from rung procedure.
- **CriUdpSystem silent-write-accept class** — extended (addendum-40
  §564): also applies to JTC "success" against Disabled arm, and to
  direct-write on `/joint_group_position_controller/commands`. WS-probe
  is authoritative for arm-side state. F3 hardening item
  (`CriUdpSystem::read` should re-arm `command_synced_` on remote
  disconnect / arm-state transitions).
- **Divergence-guard-snap trip cause (addendum-40 §563)** — FIXED. A
  guard that step-corrects position on an accel-limited controller
  becomes its own trip source. Settling substate ships in `cb022d3`.
- **Phantom stale-tab source (addendum-40 §565)** — FIXED
  operationally (dashboard restart); underlying browser lifecycle
  (queued hold state on WS reconnect) not yet debounced server-side.
  F3 item.
- **Dashboard 15 %→22 UI bug (addendum-40 §565)** — OPEN. Slider display
  ≠ wire value on `speed_pct`. Blocks trust in any prior speed-labelled
  result. F3 dashboard session.
- **JSB spawner-param root cause** — yaml declares `Joint1..Joint6` but
  runtime publishes `[Joint2, Joint3, Joint1, Joint4, Joint5, Joint6]`.
  Server-side normalization is the workaround; F3 investigates why the
  spawner isn't honoring `-p`.
- **Version-toast false-fire** — UI compares vite chunk hash (filename)
  vs `git describe` build-ID (baked constant), which are two identifiers
  of the same artifact. F3 fix: compare like-for-like.
- **`cri-proxy-staleness` thread ImportError** at boot — pre-existing
  `from .staleness import staleness_decide` relative import fails
  because `dashboard_server.py` runs as `__main__` not as a package.
  Non-fatal (thread dies, main server continues); flap-detection loop
  isn't running. F3 item.
- **DHCP reservation** `50:2e:91:95:b6:15 → .246` — FIFTH bite as of
  2026-08-25; Wi-Fi currently at `.1.143` (unreserved). Wired path
  `.2.50 → .2.246` (HARDWARE.md Subnet map) now sidesteps this class
  as the STABLE operator path — Wi-Fi is fallback only.
- **V1 GitHub repo still PUBLIC** — long-open credential rotation debt.
- Safety-edge margin retune, recovery-modal lifecycle, palletize slot-1
  — from earlier STATE, unchanged this session.

## Paused / intact

- **CRI motion stack: TORN DOWN at session end.**
  `python3 ~/cri_eval_ws/cri_teardown.py` executed after the guard
  mock-verification; arm restored to Manual mode. Do not restart without
  running the OPERATIONS.md §1 recipe (5-step TCP init).
- **jog_servo_adapter: not running** (the launch spawns it under
  `use_servo:=true`). Standalone runs during the guard test used a
  redirected topic (`/jog_test/pos_cmd`) — that mode is gone.
- **goal-replacement `jog_bridge`: RETIRED (§558).** Not running; not
  restarted. Code retained in-tree for jog_bridge tests / archaeology
  but no launch consumes it.
- **`roboai-estun` STOPPED** (with F1 drop-in
  `/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.env`
  forcing `ESTUN_MONITOR_ONLY=true`, `ESTUN_ALLOW_JOG=0`). Fallback:
  remove drop-in + `systemctl start roboai-estun` for `backend=ws`.
- **Dashboard: LIVE**, PID varies. Systemd active. `JOG_BACKEND=ros2` +
  `CAMERAS_DISABLED=1` via `campaign-f1.conf` drop-in. Frontend served
  from `frontend/dist` (single source of truth). Coherence assertion
  fires and passes at boot. Fanout publisher created eagerly in
  `__init__`.

## Reference tier built this session (always-loaded)

Per addendum-38 §545:

- `docs/HARDWARE.md` — full controller port table with role citations,
  joint/velocity/DH constants, systemd inventory with env-precedence
  gotcha, alarm code list.
- `docs/OPERATIONS.md` (NEW) — every procedure as numbered steps with
  exact commands + verification.
- `docs/FACTS.md` (NEW) — ambient truths (silent classes, wire quirks,
  "enabled" per surface).
- `docs/INDEX.md` — REFERENCE section added.
- `CLAUDE.md` — session-start load raised 5 → 8 files; new doctrine that
  "update the ledger" also updates the reference tier.

## Roadmap after F1

Unchanged from prior STATE. F2 (executor over MoveIt), F3 (everything
under systemd + hardening items collected here), F4 (white bowl over
CRI).

## Hardware/session constants (details in HARDWARE.md)

Controller `192.168.2.136` (`:9000` WS, `:9001` CRI TCP, UDP `9030`/`10086`,
`:9198` operating UI, `:8080` deploy tool DO NOT USE, fw `2.3.3.43`).
Jetson eno1 `192.168.2.246` (STABLE, laptop wired at `.2.50`);
Wi-Fi lease `.1.143` (unreserved, flaky fallback).
`max_step_rad 0.002` session override. Repos:
- `Ai-Robotics-Prototype/V1:feature/estun-write-path` — unchanged this
  session (all V1 patches for the retired goal-replacement path).
- `theodoresimpson/CodroidROS2:main` head `cb022d3` — jog moved to
  moveit_servo + `jog_servo_adapter`; adapter carries accel-ramp
  (`f0e2930`) + two-phase settling divergence guard (`cb022d3`).

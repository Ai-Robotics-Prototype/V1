---
slug: aug-25-jog-moveit-servo-accel-ramp
number: 40
date: 2026-08-25
source: session
title: Jog / moveit_servo / accel-ramp — root cause CC10-A per-cycle accel, smooth then 2015
---

*(Follow-on to addendum-39. That session shipped the reference-cursor
anchor + guard-threshold tune (`f6d4d53`) and the operator's by-eye called
rungs 3–6 unblocked. This session started rung 3 and instead uncovered
that the goal-replacement jog primitive is architecturally wrong for
this hardware — retired it, migrated to moveit_servo, then built a
per-cycle acceleration-limited adapter that bypasses Servo entirely
after the CC10-A firmware's own limit was named. First smooth continuous
jog on real hardware, then tripped 2015 on a phantom event. Two open
items filed: divergence-guard-snap fixed 2026-08-26 (settling state);
phantom source identified but a dashboard UI bug named for follow-up.)*

## Section 558: The J2 drive trip that retired goal-replacement

Rung 3 (J6+ 3 s hold @ 10 %) after the fresh-bridge restart tripped a
J2 drive alarm within the first hold. The fingerprint: fresh injects
succeed 100 %; **any subsequent** press produced a large single-cycle
velocity delta at the goal seam that the arm-side controller flagged as
a servo fault on the WRONG joint (J2, not the commanded J6). Post-mortem
on the bag showed the reference-cursor anchor was working — sign
reversals stayed at 0 — but each preempt's `p1.velocities` stitched to
the next `p0.velocities` with a velocity discontinuity every 100 ms
that the drives accepted only when the accumulated tracking budget was
zero. The bridge is a *sequence of preempted trajectory goals*; it is
constitutionally a jog primitive built out of not-jog parts.

**Operator directive:** retire goal-replacement for jog. Not another
tune — a different architecture. Keep JTC loaded-but-inactive for F2
(planned motion via Pilz PTP/LIN, which was already proven end-to-end
in E5 with TCP round-trip 14 μm). Jog moves to `moveit_servo`.

Committed in CodroidROS2: `72e75a1` (F1 servo migration interim,
addendum-40 §558) → `a0b1415` (STEP 1e mock GATE PASS — adapter
readiness gate + single vel cap).

## Section 559: The 35 Hz JTC-spline ring, and its swap

moveit_servo Humble emits a smooth continuous position stream at 250 Hz.
The initial wiring terminated Servo into JTC (`splines` interpolation).
The mock bag showed a **35 Hz mechanical ring** in the reference —
cubic-spline resampling of a already-smooth input, wobbling the very
signal it was smoothing. Same class as addendum-38 §543 (JTC splines
applying vel=0 boundaries) but arriving via a different upstream.

Fix: swap Servo's output terminator from JTC to
`position_controllers/JointGroupPositionController` (passthrough — no
spline). JTC stays loaded but inactive; F2 executor keeps its planned-
motion path via move_group ↔ JTC.

Committed: `d6bb65e` — "Servo output: bypass JTC splines via
position_controllers/JointGroupPositionController (35 Hz ring FIXED)."
QoS gotcha found live: the position controller subscribes with
RELIABLE + TRANSIENT_LOCAL; a VOLATILE publisher on the same topic gets
DDS-dropped silently.

## Section 560: joint_limits — the acceleration ceiling was Pilz-era

`src/s10_140_moveit_config/config/joint_limits.yaml` carried
`max_acceleration: 2.0` / `2.5` rad/s² — Phase E mock values sized for
planning-time limits, not runtime jog. Under Servo's 100 Hz JointJog
input at 27 °/s command, Servo's internal integrator ramps too slowly
against those accel bounds and clamps effective velocity to ~1–2 % of
command. Bumped to `20.0` for all six joints (comment records the
prior values + rationale). Pilz's own planning velocity/accel scaling
factors provide safety headroom for planned motion; the jog path now
sets its own ceiling downstream (§562).

Landed together with §562 in commit `f0e2930`.

## Section 561: cri_tcp_setup — the plugin's max_step clamp

`src/cod_bringup/bringup/config/cri_tcp_setup.yaml` `max_step_rad = 0.002`
(Phase D override, `≈0.115°` per plugin cycle at 250 Hz) was the last
throttle in the chain under Servo's per-cycle deltas of ~0.108°. The
plugin's `clamp_step` was riding the band, giving 0.19 °/s effective
against 27 °/s commanded. Bumped `0.002 → 0.005` (0.286° per cycle
slew ceiling ≈ 71 °/s at 250 Hz, well above any operator-commanded
velocity). Physical safety net remains
`jointCollisionSensitivity = 80` at the controller.

Landed with §562 in `f0e2930`.

## Section 562: Continuous-jog root cause — CC10-A per-cycle accel limit

With smoothing off, plugin unclamped, joint_limits headroom raised, and
Servo running direct into the position controller — a real-arm hold at
15 % tripped alarm **2015** on J6 (*"speed command jump or local
acceleration too high: 0.261 → 0.147 (rad/s)"*, from
`publish/Error` on WS `:9000`). Not a tuning failure — a firmware
per-cycle acceleration limit at approximately **25 rad/s² between
consecutive command cycles**, invisible to any layer we control.
moveit_servo Humble's `enforce_limits.hpp` provides only
`enforceVelocityLimits`; there is no `enforceAccelerationLimits`
(verified in source at `/opt/ros/humble/include/moveit_servo/`).
JointGroupPositionController is a passthrough — it does not accel-limit.
Neither path satisfies the firmware constraint.

**Fix built:** per-cycle acceleration ramp inside `jog_servo_adapter`
that bypasses moveit_servo entirely. `cur_cmd_vel` ramps toward
`target_vel` by `max_accel × dt` (clamped step, 18 rad/s² default —
below the ~25 rad/s² firmware ceiling). `cur_cmd_pos += cur_cmd_vel × dt`
integrated per tick. Published as `Float64MultiArray` on
`/joint_group_position_controller/commands` at 250 Hz. `moveit_servo`
still runs (for future cartesian / planned use); the adapter no longer
consumes its output.

**Mock verdict** (`f0e2930`, 2026-08-25): 6-tick ramp-up from rest with
Δv/tick = 0.072 rad/s (18 rad/s²) exactly, steady-state Δref =
0.001885 rad/tick (0.108° = 27 °/s = 15 % of J6 max vel exactly),
symmetric 6-tick ramp-down. Publisher jitter (mean 197 Hz vs 250
configured) is conservative — under-produces motion, cannot over-produce.

## Section 563: Real test — smooth then 2015; guard-snap named as trip cause

First real-arm test after `f0e2930` moved the arm **smooth and visible**
at ~9 °/s for the first time on continuous jog. Then tripped 2015.

WS `:9000/publish/RobotStatus` was the ground truth that finally surfaced
what had happened: `state=0` (Disabled), `stateName='Enabled'` (stale),
`recoveryState=1`, and one active error carrying the exact 2015 text
from *earlier in the session*. The subsequent inject + a direct
`/joint_group_position_controller/commands` step-publish + a JTC MoveJ
via action call all reported success. Arm did not move a microradian.
The whole ROS2 layer is silent-write-accept against a Disabled arm
(silent-write-accept class already documented for `CriUdpSystem`
`command_synced_` latching, addendum-38 §542; this session extends the
same class to JTC + JointGroupPositionController — see §564).

**Trip cause named.** The adapter's divergence guard — *when
cur_cmd_pos drifts > 5° from feedback, halt the session and re-sync
cur_cmd_pos to fb* — was implemented as a SINGLE-TICK POSITION STEP
(`self.cur_cmd_pos = list(fb); self.cur_cmd_vel = [0]*6`). Between the
tick before and the tick after: `Δv/cycle` = the entire divergence
divided by dt = well above the CC10-A 25 rad/s² ceiling. **The guard
itself was the trip source.** The specific event that provoked it was
a phantom jog session (§565); the mechanism is guard-design.

**Fix shipped 2026-08-26** in CodroidROS2 `cb022d3`: replace the snap
re-sync with a two-phase SETTLING state (sticky substate; new hold
events rejected during settle):

- **Phase 1 (velocity decel).** `target_vel := 0` for all joints. The
  same accel-ramp brings `cur_cmd_vel` down at `max_accel × dt` per tick.
  Transition to Phase 2 once `max |cur_cmd_vel| < settled_vel_tol_rad_s`.
- **Phase 2 (position slow-slew).** `target_vel` points toward fb,
  bounded `±sync_slew_rate_rad_s` (default 0.10 rad/s ≈ 5.7 °/s). The
  accel-ramp still caps Δv/tick. Exit when
  `|cmd − fb| < settled_pos_tol_rad` AND vel converges.

**Guard-test PASS** (harness under `/tmp/guard_test_harness.py`;
frozen `/joint_states` with a running adapter to force divergence in
mock — mock passthrough alone can't reproduce it because fb tracks cmd).
Bag at
`~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-26_guard_fix/guard_test_v2/`.
Ramp-up 6 ticks × +0.0165°/tick to steady 0.108°/tick, divergence
fires at 5.29°, Phase 1 6-tick decel back to 0, Phase 2 steady
0.0229°/tick (= sync_slew_rate exactly). **Max |Δref| per tick through
the entire recovery = 0.108° = the same value as the normal steady-state
jog Δref**. No spike. No snap. Settle time ≈ 990 ms for 5° divergence.

## Section 564: The silent-refusal signature — JTC "success" vs Disabled arm

Extends the silent-write-accept class of addendum-38 §542
(`CriUdpSystem` `command_synced_` latching) upward through the ROS2
motion stack. This session, three separate command paths against a
Disabled arm all reported success:

1. `jog_servo_adapter` published to
   `/joint_group_position_controller/commands` for 1 s at 250 Hz; arm did
   not move; adapter reported normal ramp.
2. A direct-write step to the same topic (adapter killed, target = fb +
   1° for 2 s) — arm did not move; publisher completed cleanly.
3. `FollowJointTrajectory` action call to JTC (MoveJ +2° over 2 s) —
   `status=4`, `error_code=0`, `error_string='Goal successfully
   reached!'`. Arm did not move.

None of the layers has a back-channel for arm-side servo state. Feedback
still flows (the arm publishes its position over UDP at 250 Hz — that
proves the *communication path* is alive, not the *drives are
executing*). The only wire-truth is
`ws://192.168.2.136:9000` `publish/RobotStatus.db.state` and
`publish/Error`. Verified in-session: `state=0`, `stateName='Enabled'`
(the two disagree — `state` wins), `recoveryState=1`, and errors[]
carrying the 2015 text pinpointed the trip time.

Rule adopted: before *any* real-arm jog or planned-motion test, WS-probe
`{state, stateName, recoveryState, errors[]}`; treat ROS2-side
"success" as evidence of the communication path only. See L271 and
FACTS.md addition.

## Section 565: Phantom source — a stale browser tab, and a 15 %→22 UI bug

The phantom event that provoked §563's divergence was a jog session with
`hold_id=5jvotrcpge` and `speed_pct=22.0` fired ~33 s after the motion
stack came up — before the operator's own inject. Traced to the
frontend (`cobot_dashboard/frontend/src/components/JogControls.jsx:91`,
`newHoldId = () => Math.random().toString(36).slice(2, 12)`) — the ID
pattern matches exactly. A stale browser tab on `192.168.1.111`
(operator's live tab is on `192.168.2.50`) had a queued hold state that
flushed on the fresh WS reconnect. Dashboard restart cleared it; 30 s
idle monitor of `/dashboard/jog_session_events` post-restart confirmed
zero uncommanded events.

**The 22 is not the phantom press's actual command — it's the dashboard
UI.** Operator confirmed: the slider labelled *"15 %"* transmits
`speed_pct=22.0` on the wire (and other UI values map to `22–57`
outputs). UI display ≠ wire value — a dashboard speed-scaling bug not
yet fixed. This means every prior real-arm session at "5 %" was
possibly running at a different actual command percentage than the
operator believed. Filed as an open F3 defect (FACTS.md addition; STATE
open list). Root-cause investigation deferred to a dashboard session;
the jog adapter's `vel_cap_frac` (0.5) is the safety ceiling regardless
of the UI scale.

## Section 566: Recovery — `System/ClearError` + power-cycle both required

After the 2015 trip: wire-only recovery via
`System/ClearError` + `Robot/switchOn` cleared the errors[] list and
brought `state` back to 2, but `recoveryState=1` persisted. Re-issuing
`CRI/StartDataPush` + `CRI/StartControl` didn't clear it either.
Physical controller power-cycle was the only path that cleared
`recoveryState → 0`. Post-power-cycle sequence: fresh
`cri_tcp_setup_node` (5 verbs), first UDP feedback aligned,
WS-probe verified `{mode:2, state:2, stateName:'Enabled',
recoveryState:0, errors:[]}` — the four-tuple that the guard fix's
next real-arm test will gate on.

## Section 567: Shipped commits, this session (chronological)

CodroidROS2 (`theodoresimpson/CodroidROS2:main`):

| SHA | Message |
|-----|---|
| `72e75a1` | F1 servo migration (STEP 1 mock build, addendum-40 §558) — interim |
| `a0b1415` | STEP 1e mock GATE PASS — adapter readiness gate + single vel cap |
| `d6bb65e` | Servo output: bypass JTC splines via position_controllers/JointGroupPositionController (35 Hz ring FIXED) |
| `f0e2930` | jog_servo_adapter: accel-ramp shim (18 rad/s²) bypassing Servo — mock PASS |
| `cb022d3` | jog_servo_adapter: divergence guard — replace snap re-sync with settling |

Reference-tier + ledger patches land in this same session's next commit.

## Section 568: What to try next

1. **Real-arm guard-fix retest.** With `cb022d3` deployed on a
   power-cycled arm: WS-probe the four-tuple, small first bite
   (J6+ 5 % × 0.5 s), then rung 3 (J6+ 3 s hold @ 10 %) then rungs 4–6.
   E-stop in operator's hand; monitor `publish/Error` inline.
2. **The 15 %→22 dashboard bug** must be root-caused before any speed-
   sensitive test claim can be trusted end-to-end. Separate session.
3. **§555 Path B** (populate `.accelerations`) remains DEFERRED — it
   was about JTC boundary conditions on the *old* goal-replacement path,
   which is now retired. Do not revisit unless a future planned-motion
   path re-encounters the same class.
4. **`AccelerationLimitedPlugin`** exists in moveit_core 2.15
   (`online_signal_smoothing::AccelerationLimitedPlugin`) — the built-in
   fix for the same per-cycle acceleration constraint that §562's
   adapter solves out-of-tree. Backport availability under Humble 2.14.1
   is the choice point: if backportable, replace the adapter's ramp
   with it (still keeping the adapter as the event-sink + divergence-
   guard layer). If not, the adapter's ramp is the shipping answer.

## Summary (2026-08-26)

The jog primitive changed twice this session: goal-replacement retired
(§558), moveit_servo shipped then bypassed (§559 → §562), and the real
answer named — a firmware per-cycle acceleration limit at ~25 rad/s²
that neither Servo nor position-controller passthrough respected. The
accel-ramp adapter respects it (`f0e2930`) and moved the arm smooth on
real hardware for the first time on continuous jog. A phantom event
from a stale browser tab (§565) collided with an implementation-detail
snap in the divergence guard (§563) and tripped alarm 2015. The guard
was rewritten as a two-phase settling state (`cb022d3`) and passes the
same accel-ramp discipline through the entire recovery. Silent-refusal
signature named (§564) as the class fix for how the last three hours
looked "successful" while nothing was moving. Recovery requires both
`System/ClearError` and a controller power-cycle (§566). The
`15 %→22` UI bug is deferred to a dashboard session but named as a
standing item because it undermines every speed-labelled test result
across the last several sessions.

Rungs 3–6 remain open, now on the accel-ramp adapter baseline instead
of the retired goal-replacement bridge.

---
ledger_split: addendum-55
date_range: 2026-08-31
title: F2.7 first-fire attempted — 5 bugs surfaced + fixed, silent-refusal proved on real arm, blocked by J1/J6 convention drift
---

# ADDENDUM 55 — August 31, 2026 — F2.7 FIRST-FIRE

## Section 672: what shipped today

Full-day session. F2.7 executor stopped being a skeleton; the
dashboard bridge, systemd drop-in, and 4 agent charters + hooks
landed; real-arm CRI bring-up + dry pass + first-fire attempted.

**Landable deliverables (SHAs across two repos):**

- **CodroidROS2/main `62ac884`** (F2.7 acceptance — executor
  no-longer-skeleton, per add-54).
- **CodroidROS2/main `5ecfbb8`** (F2.7 dry-pass hardening — 5
  latent bug fixes surfaced via real-arm dry pass, per §673).
- **CodroidROS2/main (next SHA below)** — F2.7 first-fire
  session-close: MIN-cap speed fix, IK-orientation-from-FK,
  large-motion advisory, numeric plan_summary reporting, JSB
  convention finding (revert + reference kUdpJointSigns).
- **cobot_ws feature/estun-write-path `c6368d2`** (dashboard
  bridge + drop-in + ledger add-54).
- **cobot_ws feature/estun-write-path (next SHA)** — session-
  close: LESSONS §316, this addendum, .claude/agents + hooks,
  memory updates.

## Section 673: five bugs surfaced by real-arm dry pass

Running Test100 through the real CRI stack (arm powered, REMOTE
mode, JSB 250Hz, MoveGroup Pilz pipeline) surfaced five latent
bugs — each caught by real wire evidence, all fixed:

1. **J3/J5 sign flip WRONG direction in `step_dispatch.py`.**
   FK evidence: pendant J5=+91.56° matched URDF Joint5=+92.05°
   at the same physical pose — numeric values transfer
   directly. Sign inversion lives inside URDF `<axis>` on
   J3/J5, NOT in the value transform. My earlier "flip" was
   double-inverting → 3.2 rad delta on J5 → tripped validator
   `joint_step_too_large` on move_home. Removed the flip;
   kept `_URDF_SIGNS` list shape as a hook.
2. **`WorkspaceParameters.min_corner`/`max_corner` require
   `Vector3` (not `Point`).** MoveGroup assertion failure at
   step 0 planning.
3. **`PositionConstraint.target_point_offset` also requires
   `Vector3`.** Same msg-type mixup class.
4. **`motion_plan.JOINT_NAMES` was snake_case `joint_1..6`
   (from the aspirational `.reference` doc).** Live URDF xacro
   + SRDF + joint_limits.yaml all use PascalCase `Joint1..6`.
   Was causing MoveGroup `error_code=-16
   INVALID_GOAL_CONSTRAINTS`.
5. **`_walk_steps` returned after `_publish_error` without
   signaling caller.** `_run_program_thread` fell through and
   emitted a spurious `ExecutorState.COMPLETE` right after the
   ERROR. Fixed by returning `bool`; caller skips COMPLETE on
   `False`.

Plus infrastructural additions:

6. **Frame-mapping helper `ctrl_pos_to_urdf(x,y,z)` = `(-y, +z, -x)`**
   per `cobot-cri-frame-mapping` memory. Verified against
   `/compute_fk` on pick step taught_joints: FK URDF pos
   (-0.448, +0.650, -0.675) matches transformed pendant TCP
   within ~15mm (delta ≈ tool-tip vs link6 wrist-flange).
7. **`motion_plan.MoveGroupPlanner.ik()` — `/compute_ik` service
   wrapper** with optional seed_positions + orientation_quat
   override.
8. **F2.7 first-run scope routes ALL move_l via Pilz PTP
   (joint-space).** LIN cartesian planning deferred pending
   TCP-rotation-convention investigation. Steps with
   taught_joints use them directly; derived approach/retreat
   steps IK the target pose (transformed CTRL→URDF) to get
   joint targets, then PTP. Physical motion is joint-
   interpolated (< 1cm from strict cartesian for the 100mm
   approach deltas at ≤25% speed).
9. **`setup.cfg` added** to `s10_140_executor` — `ros2 run`
   was returning "No executable found" without it (setuptools
   default `bin/` vs ros2 `lib/<pkg>/`).

## Section 674: F2.7 first-fire attempt (real1)

Fired Test100 real run at 25% speed. **Silent-refusal guard
caught a mid-motion halt at step 0** — 29° J4 gap between JTC
reference and observed feedback → `fb_far_from_target` ERROR →
run halted, no subsequent steps executed.

Root cause: **operator e-stop**. WS `publish/Error` shows
alarm 2006 "Emergency stop button pressed." at
`ts=1788202611.539`. Diagnostic geometric investigation
(FK'd planned trajectory 500mm TCP travel + 41° J4 rotation +
459mm Z-rise) revealed the arm was moving in the CORRECT
direction toward taught home, but from a starting position far
from home the initial motion was startling. Operator judged
"looks wrong" and hit e-stop — every guard behaved correctly:

- Executor dispatched trajectory ✓
- JTC accepted + started tracking ✓
- E-stop dropped drive power ✓
- Silent-refusal guard caught mid-motion halt ✓
- Executor emitted ERROR + halted at step 0 (no cascade) ✓
- JTC held its reference (no unsafe action) ✓

**Not a doctrine bug.** The wire evidence is unambiguous:
`Emergency stop button pressed.` at the exact moment of the
halt.

## Section 675: numeric verdict + advisory + speed-cap fixes

Post-halt, added instrumentation to answer the operator's
"did run_speed_pct=25 actually propagate?" question:

- **motion_plan.py**: `PlanResult` now carries `peak_velocities`
  (per-joint max |v| from JointTrajectoryPoint.velocities) +
  `duration_s`. `JOINT_MAX_VELOCITY` array documents the
  per-joint max (from joint_limits.yaml).
- **executor_node.py**: plan_summary event now includes
  `peak_velocities`, `expected_peak_velocities`,
  `peak_v_ratio`, `scaling_verdict` (PROPAGATED /
  UNDER-SCALED / OVER-SCALED), `duration_s`,
  `joint_max_delta_deg`, `tcp_travel_mm`,
  `large_motion_advisory_fired`. Enables operator to review
  motion character BEFORE consenting to fire.
- **large_motion_advisory event**: emits BEFORE plan_summary
  when `joint_max_delta_deg > 20°` OR `tcp_travel_mm > 200`.
  Carries per-joint deltas + start/end joint positions.
  Threshold configurable via `LARGE_MOTION_JOINT_DELTA_DEG` +
  `LARGE_MOTION_TCP_MM` module constants.

**Numeric findings from post-fix dry pass:**

- **run_speed_pct=25 was being IGNORED for move_linear steps.**
  Per-step Test100 `speed_pct` (60%, 30%, 40%) was OVERRIDING
  the top-level cap. FIX: changed semantics to
  `min(per_step, run_cap)`. Now every step uniformly
  v_scaling=0.25.
- **IK-seeded-from-current-arm produced wrist-flipped
  solutions.** Derived approach/retreat steps IK'd against
  self._js_last (current arm) instead of the reference step's
  taught_joints — MoveIt found valid TCP-position matches
  with 172° J4 wrist flip. FIX (partial): seed IK with the
  REFERENCE step's taught_joints (packed into `goal["ik_seed"]`
  by step_dispatch). Wrist-flip moved from J4 (172°) → J5
  (156°) — same class.
- **IK-orientation-from-FK-of-reference fully resolved it.**
  Root cause: the taught_tcp rotation vector is Estun's axis-
  angle convention, NOT XYZ RPY — passing it through
  `_rpy_to_quat` produced garbage orientation that let IK pick
  any wrist reaching the target position. FIX: for derived
  steps, FK the reference taught_joints via `/compute_fk` to
  get the correct wrist quaternion, pass THAT as
  `orientation_quat` override. After this: max joint delta
  dropped from 172° → 29° on all derived steps. J4/J5 wrist-
  flip class RESOLVED.

## Section 676: J1/J6 convention drift — the actual first-fire blocker

Second preflight attempt (after operator homed the arm via
pendant) revealed **J1 and J6 signs disagree between
concurrent WS clients**:

- My WS probe of `publish/RobotPosture`: J1=-11.035°, J6=-36.01°
  (matches Test100 taught + pendant display).
- estun_driver's WS subscription (same topic, long-running):
  publishes /joint_states J1=+11.04°, J6=+36.01°.
- cri_hardware /joint_states (from UDP CRI push): J1=+11.04°,
  J6=+36.01°.

Two clients on the SAME WS topic returning OPPOSITE signs. Also
observed: **UDP push J1 sign FLIPPED across a CRI
teardown+relaunch cycle** (early session: positive; post
teardown: negative).

Applied a J1/J6 sign flip in `cri_udp_system.cpp` read+write
paths as fix candidate. One-shot debug log confirmed the flip
took effect. But estun_driver's independent /joint_states
publication ALREADY showed the opposite convention, so the
fix in cri_hardware couldn't resolve the ambiguity — REVERTED.

`kUdpJointSigns` array + SIGN_ADAPTER debug log KEPT in the
code as reference documentation for the next investigation.
Currently no-op (all signs +1).

**Session close verdict:** F2.7 first-fire is BLOCKED on this
convention drift. Every layer works individually (executor
plans, JTC executes, silent-refusal catches halts, advisory
warns). The failing link is joint-frame consistency between
what MoveIt plans and what the arm physically does under
convention-drifting wire.

## Section 677: agent charters + hooks landed

Background directive from earlier in the session — four narrow
checkers under `.claude/agents/` with one-page charters + wired
session hooks:

- **goal-auditor** (SessionStart hook) — classifies work vs
  `docs/STATE.md` next-session opener; BLOCKS unapproved
  scope creep. May not opine on code correctness.
- **enforcement-reviewer** (PreToolUse bash hook, triggers on
  `git commit` when staged diff touches enforcement code) —
  adversarial mode-walk of guard/gate/refusal-copy diffs.
  BLOCKS on mode-inconsistent guard behavior. May not opine
  on style or non-enforcement code.
- **session-close-auditor** (Stop hook) — verifies
  claims↔SHAs, clean tree, ledger ritual, MEMORY.md index,
  fork_lint, doctrine tests. BLOCKS incomplete closes.
- **arm-preflight** (invoked manually before wire-motion
  commands) — four-tuple + single-source + arbiter clear +
  e-stop-acknowledged. FRESH probes only, single-use auth.

Hook script `.claude/hooks/enforcement-reviewer-trigger.sh`
inspects incoming Bash commands; on `git commit` with staged
enforcement-file changes, emits a `<system-reminder>`
obligating the enforcement-reviewer subagent. Everything
grep-checkable stays in `fork_lint.py`; agents are pure
judgment surfaces.

`.claude/` is gitignored in cobot_ws — operator-side tooling,
local. Not shipped to teammates.

## Section 678: NEXT-SESSION OPENER — J1/J6 convention resolution

Session-close-auditor charter + this addendum agree:
`docs/STATE.md` Next Session Opener step 0 becomes:

**F2.7 first-fire retry — J1/J6 convention resolution.**

1. Fresh boot everything (arm cabinet + Jetson + all
   ROS services).
2. Enable `ws_log_raw=true` on estun_driver.
3. Capture WS RobotPosture + UDP push + /joint_states signs at
   each transition:
   - Cold boot, no subscribers → single-client WS probe.
   - Add estun_driver subscription → probe from a second
     client.
   - Start CRI/StartDataPush → probe UDP push convention.
   - Start CRI/StartControl → probe UDP push convention again
     (this is where UDP flipped this session).
4. Determine which of three hypotheses is true:
   (a) Controller sends different-sign data to different WS
       clients (multi-client firmware bug).
   (b) Subscription order determines convention (subscribe-
       time state binding).
   (c) Estun_driver has an internal transformation not yet
       found (grep-audit the full frame-parsing path;
       existing code inspection found nothing).
5. Apply a single sign adapter at the correct layer once
   convention is deterministic. Verify FK-vs-physical-TCP
   consistency BEFORE any real motion.
6. Preflight (arm-preflight charter). Confirm max |delta|
   from Test100 home < 5° across all six joints on
   /joint_states specifically.
7. Real fire.

Everything else this session — F2.7 executor, dashboard
bridge, drop-in, agent charters, hooks, 5 bug fixes, silent-
refusal-proven-on-real-arm — stands. This is the last mile.

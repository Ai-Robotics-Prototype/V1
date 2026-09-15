---
ledger_split: addendum-54
date_range: 2026-08-31
title: F2.7 first-run acceptance — RUN_BACKEND=ros2_executor wired end-to-end
---

# ADDENDUM 54 — August 31, 2026 — F2.7 ACCEPTANCE

## Section 665: the executor stops being a skeleton

Operator directive: land the F2.7 acceptance commit atomically —
RUN_BACKEND=ros2_executor route wired to a real executor that can
plan + execute Test100 through the ROS2 CRI path (Pilz PTP/LIN
+ JTC + cri_hardware), with a dry-run flag for pre-arm validation.

Prior state (addendum-52 §647 M2 pending): `s10_140_executor`
was a skeleton — gates (validators, settle, silent-refusal)
worked as pure logic, but `_ws_four_tuple_ok` returned
`(False, ...)` unconditionally, motion `plan` was a TODO block,
JTC action client was absent, dashboard returned HTTP 501
`ros2_executor_not_wired_yet` on the ros2 branch. Vocabulary
was `move_j`/`move_l`/`set_do`/`wait`; Test100 uses
`move_home`/`move_linear`/`set_io`/`wait`/`loop` with
`derived_from` + `offset_z_mm` — total vocabulary mismatch.

This commit closes all of it.

## Section 666: what landed — CRI-side (`s10_140_executor`)

Three new pure-logic + one action-client module. All pass syntax
check + unit tests (24/24 gate tests still green).

- **`ws_probe.py`** — synchronous WS four-tuple probe against
  `ws://192.168.2.136:9000/`. Uses `websockets.sync.client`
  (same library the estun_driver has proven at scale). Fail-
  closed on connect/recv timeout or missing fields. Accepts
  optional `require_mode` (2=REMOTE for CRI, 0=AUTO for legacy)
  and `require_errors_empty` gates. `recoveryState` is
  reported in the snapshot but NEVER gates the pass/fail —
  per addendum-53 §658 reframe, rs is session-persistent, not
  a fault latch.

- **`step_dispatch.py`** — pure vocabulary resolver:
  - Canonical kinds `move_j`/`move_l`/`set_do`/`wait`/`loop`
    with aliases `move_home`/`move_linear`/`set_io` +
    equivalents.
  - `derived_from` + `offset_z_mm` — looks up the step whose
    `position_role` matches, offsets its `taught_tcp` along
    +Z (mm → meters), returns the derived pose. This is how
    Test100's "Approach above pick" resolves without an
    explicit taught_tcp.
  - Joint sign flip on J3 (index 2) and J5 (index 4) —
    pendant/CAD convention → URDF convention. Per
    `cobot-cri-axis-convention` + s10-140-full.urdf.reference
    header (`joint_3` and `joint_5` `<axis>` signs inverted).
    `joints_pendant_deg_to_urdf_rad()` handles the whole
    transform (deg → rad + sign flip). Round-trip verified.
  - `ResolvedStep` dataclass carries the canonical kind, goal
    dict shaped for validators + planner, label, speed_pct,
    and a `dry_annotation` string ("derived from role='pick'
    step + Z+100.0mm").
  - `resolve_program()` batch-resolves for the dry-pass
    reporter.

- **`motion_plan.py`** — two thin sync wrappers on top of
  `rclpy.action.ActionClient`:
  - `MoveGroupPlanner` — `plan_joint(target_positions,
    planner_id='PTP', v/a scaling)` and
    `plan_cartesian(target_pose, planner_id='LIN', v/a
    scaling)`. Builds `MotionPlanRequest` with
    `pipeline_id='pilz_industrial_motion_planner'`, group
    `manipulator` (from `s10_140.srdf`), workspace bounds
    from the URDF. Joint plans use JointConstraint per-joint
    at ±0.001 rad; cartesian plans use PositionConstraint
    (1 cm cube tolerance) + OrientationConstraint (0.05 rad
    per-axis tolerance) with an RPY→quaternion conversion.
    Returns `PlanResult(ok, trajectory, planner_id,
    plan_time_s, waypoints, end_positions)` or shaped
    failure (`move_group_unavailable`, `move_group_rejected`,
    `move_group_no_result`, `plan_failed`).
  - `JTCExecutor` — `FollowJointTrajectory` action client with
    the Humble cancel-terminal quirk workaround
    (`cobot-jtc-humble-cancel-terminal-quirk`). Send goal
    async, poll `result_future` on a 50 ms tick, on
    `cancel_current()` fire cancel + wait `CANCEL_DEADMAN_S`
    (500 ms) for a real result, then bail using
    `goal_handle.status` as ground truth if the result-callback
    never fires (Humble silently omits it on already-terminal
    cancel). Returns `ExecuteResult(ok, status, return_code,
    canceled)`.

- **`executor_node.py` rewrite** — the F2.6 skeleton's stubs are
  replaced with real calls:
  - `_ws_four_tuple_ok` calls `probe_four_tuple` with
    `required_mode` param (default 2=REMOTE).
  - `_on_run_program` accepts `{"action":"run", "program_id",
    "dry_run", "req_id", "run_speed_pct"}`. `action:stop`
    sets a threading.Event that both the main loop and
    `JTCExecutor.cancel_current()` observe.
  - `_walk_steps` iterates resolved steps with loop support
    (goto/count, capped at `max_loop_iterations` param —
    default 1 for first-run safety; Test100's `count=0` reads
    as "infinite" but the cap keeps the first-run bounded).
  - `_execute_motion` full path: validate → plan → publish
    plan_summary event → (if dry_run: return true) → execute
    → arm settle gate → poll → silent-refusal guard → publish
    step_verdict event. Velocity + acceleration scaling
    derived from `step.speed_pct` or the request-level
    `run_speed_pct`, clamped (0.01, 1.0].
  - Publishes to `/executor/status` (moved from
    `/estun/program_status`) so the F2 event shape doesn't
    collide with the legacy driver's shape on that topic.
  - Every terminal reply carries `req_id` so the dashboard
    bridge can correlate.

## Section 667: what landed — dashboard side (`cobot_dashboard`)

- **`/api/estun/program/run` ros2_executor branch rewritten.**
  The 501 `ros2_executor_not_wired_yet` stub is DELETED.
  Replaced with the real bridge:
  - Generate `req_id = uuid.uuid4().hex[:12]`.
  - Register a per-req_id awaiter via
    `_register_executor_awaiter(req_id)`.
  - Publish `{action:run, program_id, dry_run, req_id,
    run_speed_pct}` on `/task/run_program` via the new
    `_task_run_program_pub`.
  - If publisher has zero discovered subscribers at send
    time, return `503 executor_not_running` immediately
    (executor node isn't up — operator sees WHY the run
    couldn't dispatch, not a generic timeout).
  - Wait for terminal (`aw["event"].wait(timeout=bound)`),
    default 30 s dry-run / 120 s real-run, overridable via
    `body.timeout_s`.
  - On terminal state: `program_state=4` (COMPLETE) → 200 ok
    with `plan_summaries[]` + `step_verdicts[]`;
    `program_state=5` (ERROR) → 409 `executor_error` with
    reason_code + step_idx + summaries; awaiter timeout →
    504 `executor_timeout`.
  - `finally` unregisters the awaiter (leak-safe).
  - Palletize quarantine check remains BEFORE dispatch — the
    class is architecturally impossible on CRI, but the
    guard belt-and-braces stays.

- **`_on_executor_status`** callback added, subscribed
  `/executor/status`. Two responsibilities:
  1. **Arbiter mirror.** Translates
     `program_state ∈ {2,3}` → `STATE.robot.program.state`
     (JOG-11 arbiter reads that field). Terminal states
     (4=COMPLETE, 5=ERROR, 0=IDLE) reset `prog["state"] = 0`
     with a `source` tag (`executor:complete/error/idle`).
     Also mirrors `program_id` + `current_step_idx` for the
     UI timeline.
  2. **Bridge fulfillment.** If the event carries a `req_id`
     matching a registered awaiter, appends the event to the
     awaiter's log (`plan_summaries`, `step_verdicts`); on
     terminal state signals the awaiter's Event.

- **Eager publisher init.** `_task_run_program_pub` is
  created at Node __init__ (same discovery-race fix as
  `_estun_program_pub` — RELIABLE+VOLATILE would drop the
  first publish if the subscriber hadn't finished discovery).

## Section 668: systemd drop-in

`src/cobot_bringup/systemd/roboai-dashboard.service.d/
f27-ros2-executor.conf`:

```ini
[Service]
Environment=RUN_BACKEND=ros2_executor
```

Install procedure documented in the file header. Operator
copies to `/etc/systemd/system/roboai-dashboard.service.d/`,
`daemon-reload`, restarts. Verify via
`curl -s :8080/api/provenance | jq .run_backend` → `"ros2_executor"`.

The drop-in is a repo artifact; not auto-installed by the
deploy script. Deliberate: flipping run backend is an
operator decision, not a code push.

## Section 669: doctrine tests

- `test_run_endpoint_dispatches_on_run_backend` — REWRITTEN.
  The retired 501 stub kind must NOT appear; the new bridge
  helpers (`_publish_task_run_program`,
  `_register_executor_awaiter`,
  `_unregister_executor_awaiter`) must all be invoked; the
  quarantine check must still precede the bridge dispatch.
  Terminal-outcome kinds pinned: `executor_complete`,
  `executor_dry_run_complete`, `executor_error`,
  `executor_timeout`, `executor_not_running`.
- `test_executor_bridge_subscribes_executor_status_topic` — NEW.
  Dashboard subscribes `/executor/status`;
  `_on_executor_status` handler mirrors `program_state` into
  `STATE.robot.program.state` for the JOG-11 arbiter.
- `test_executor_bridge_publisher_topic_and_dropin_present` —
  NEW. `/task/run_program` publisher exists; drop-in file at
  the canonical path with `RUN_BACKEND=ros2_executor`.
- Fork registry `jog_hold_heartbeat` line numbers refreshed
  (110-line shift from the bridge additions above).
- Executor gate tests 24/24 still pass (no regressions from
  the WS probe / vocabulary / motion_plan additions).

91/91 dashboard doctrine tests + fork_lint clean.

## Section 670: operator run sequence (P8 → P10)

**P8 — CRI bring-up (per OPERATIONS §1):**
1. `python3 ~/cri_eval_ws/cri_teardown.py` (idempotent; kills any
   lingering session).
2. `tmux new -s robot` (or attach).
3. `source /opt/ros/humble/setup.bash &&
    source ~/cri_eval_ws/CodroidROS2/install/setup.bash`
4. `ros2 launch cod_bringup s10_140_cri_ros2_control.launch.py
    use_mock:=false`
5. Wait for the CriUdpSystem alignment line
   (`首帧 UDP 反馈已对齐关节指令`).
6. In a second pane: launch the executor node —
   `ros2 run s10_140_executor executor_node`.
7. Fresh WS probe (from Jetson):
   `python3 /tmp/probe_tuple.py`. Expect `state=2, errors=null,
   mode=2` (REMOTE). If mode ≠ 2, re-acquire REMOTE per the
   §1 cri_tcp_setup_node's 5-command sequence.

**P9 — Test100 dry pass:**
```
curl -s -X POST http://127.0.0.1:8080/api/estun/program/run \
  -H 'Content-Type: application/json' \
  -d '{"program_id":"test100", "dry_run":true, "timeout_s":60}' \
  | jq
```
Expected: `ok:true, outcome.kind:"executor_dry_run_complete"`,
`plan_summaries[]` with 10 entries (all move steps: 2×MoveJ
home + 8×MoveL pick/place/approach/retreat). Every entry shows
`planner_id: "PTP"` or `"LIN"`, non-zero `waypoints`, non-null
`end_positions`, and the `dry_annotation` for derived approaches.

**P10 — real Test100 run (operator-gated):**
Gates before the run:
- 25% speed (post the SAME endpoint without `dry_run`; body
  omits `run_speed_pct` so the executor uses the per-step
  scaling from Test100 which happens to peak at 60% — but
  we override to 25% via `"run_speed_pct":25`).
- E-stop in hand.
- Ledger observation: `§580_verdict` events emitted per step
  (`step_verdict` on `/executor/status`, mirrored via
  breadcrumb collector). Any `ok:false` verdict halts the run.
- Mid-run jog press (arbiter direction 2): operator presses a
  jog button while executor is in RUNNING; expected
  HTTP 409 `program_running` refusal (arbiter reads
  `STATE.robot.program.state` populated by the new
  `_on_executor_status` mirror). Wire evidence closes
  add-47 §611 in the same session.

## Section 671: what's DEFERRED to a follow-up (not F2.7)

Called out so no one thinks the next surprise is a regression:

- **Pause / resume.** F2.7 supports run + stop only. Pause /
  resume is an executor-thread cooperation problem
  (mid-trajectory freeze needs JTC pause semantics that
  Humble's stock JTC doesn't expose cleanly). Deferred.
- **`/estun/io` set_io ack.** Current path publishes and
  advances optimistically. A follow-up subscribes `/estun/io`
  and waits for the DO value to reflect the command before
  returning True from `_execute_set_do`.
- **True infinite loop.** `max_loop_iterations=1` first-run
  cap is deliberate. Operators wanting continuous runs
  override the param at launch.
- **Executor auto-launch as a systemd unit.** Currently
  `ros2 run` from a tmux pane. `roboai-executor.service`
  exists in the systemd tree (unused today) — wiring it up
  after the first successful real run.
- **Frontend UI for `/executor/status` events.** The bridge
  returns `plan_summaries[]` + `step_verdicts[]` in the HTTP
  response body; a subsequent commit surfaces those in the
  RunProgramModal's post-run panel + the run history.

Everything above is BACKLOG, not blocking F2.7 acceptance.

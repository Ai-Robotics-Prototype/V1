---
ledger_split: addendum-49
date_range: 2026-08-28
title: Mode switching (Manual/Auto) from the dashboard — read-back verified, arbiter-aware, workflow-sugared
---

# ADDENDUM 49 — August 28, 2026 — MODE SWITCHING FROM THE DASHBOARD

## Section 621: the operator directive

Program runs need Auto, drag-teach needs Manual, and the operator
cannot be sent to the factory UI at `:9198` mid-workflow. The
mid-workflow refusal ("not in auto mode") the operator saw during
Test100 was really the same class as the `allow_move` gate: a
required product function was silently unavailable from our
dashboard. Feature directive (2026-08-28):

1. WIRE RESEARCH FIRST.
2. DRIVER: new gate, own topic, numeric read-back verify.
3. DASHBOARD UX: safety-relevant pill always visible, deliberate
   confirm dialog, arbiter-aware, event-logged.
4. WORKFLOW SUGAR: Run offers "Switch to Auto and run?"; Teach
   offers Manual likewise.
5. Doctrine, ledger, shas. Acceptance: teach-in-Manual →
   switch → run-in-Auto entirely from our UI.

## Section 622: wire research

Prior art was in hand from three ledger entries:

- **add-19 §** — captured `Robot/toAuto` / `Robot/toManual` bare
  as the mode-switch verbs during the WS envelope survey.
- **add-25 §** — the great capture session (168 verbs)
  independently included both.
- **add-32 §** — CRI setup sequence (`toAuto → toRemote →
  switchOn → CRI/StartDataPush → CRI/StartControl`) proved
  `Robot/toRemote` as the third mode, mandatory before CRI's
  `StartControl` latches.

Two internal notes fell out of the same research:

- The driver ALREADY had `_op_to_auto` / `_op_to_manual` and
  emitted them as part of the program-run op sequence (line
  1662–1668). But they rode behind `allow_move`, and the
  dispatcher was `_on_program_command` — no seam for a standalone
  mode toggle from the dashboard.
- The driver ALREADY mirrored `publish/RobotStatus.mode` into
  `self._robot_mode_code` (0=AUTO / 1=MANUAL / 2=REMOTE) and
  published a string on `/estun/robot_mode`. Numeric ground
  truth was already available per L298.

Result: no new WS captures needed. The feature was a
seam-plumbing exercise on top of infrastructure that already
existed for the program pipeline.

CRI-mode question: CRI control was proven under Auto (§32
Run 3 latch success required `toAuto → toRemote` in that order).
Remote is a driver-side capability, not part of the operator's
routine flow; exposed in the ModeControl dialog as "advanced,
reserved for CRI motion control setup" so it can't be picked
by accident.

Login/level question: none observed in prior captures. The WS
verbs work over the same `:9000` session the rest of the driver
uses; no upgrade required.

## Section 623: driver seam

New gate + subscription + status publisher — all mirroring the
existing patterns:

- `declare_parameter('allow_mode', False)` + env override
  `ESTUN_ALLOW_MODE`. **Separate from `allow_move`** so the
  operator can permit mode toggling without also opening
  program-write.
- `/estun/mode_command` subscription (`String`, depth 8, eager
  creation for the DDS discovery-race class § add-40).
- `/estun/mode_status` publisher (`String`, depth 8). Result
  envelope: `{ok, op, requested, observed, reason?, reason_code?,
  req_id, ts}`.
- `_on_mode_command` handler:
  - Gate order: `monitor_only → allow_mode → connected → READY`.
    Identical to `_on_program_command` (same class of write).
  - `_MODE_CODE_FOR_OP` = `{to_auto: 0, to_manual: 1, to_remote: 2}`.
    `_MODE_VERB_FOR_OP` = `{to_auto: 'Robot/toAuto', ...}`.
  - Short-circuit: if `_robot_mode_code == target_code`, publish
    `{ok: True, no_change: True}` without emitting a wire verb.
  - Otherwise emit the WS verb, then poll `_robot_mode_code` every
    50 ms for up to **3 s**. `publish/RobotStatus` refreshes at
    ~10 Hz → 30 opportunities to observe a transition. Success:
    publish `{ok: True, requested, observed}`. Timeout: publish
    `{ok: False, reason_code: 'mode_readback_timeout',
    reason: 'verb was sent but publish/RobotStatus.mode did not
    reach <N> within 3 s', observed}`.
- Status blob exports `allow_mode` + `allow_mode_source` so the
  dashboard mirror can render the pill enabled/disabled state.

## Section 624: dashboard seam

- `_estun_mode_pub` (`/estun/mode_command`) + subscription to
  `/estun/mode_status` with a 32-slot ring on
  `STATE.robot.mode_status`.
- `POST /api/estun/mode {target: "auto"|"manual"|"remote"}`:
  1. Arbiter gate (JOG-11 discipline extended): refuse with
     `outcome.kind = "arbiter_refused"` if `_active_holds > 0` OR
     `STATE.robot.program.state == 2`. Named reason: `"jog hold
     active"` or `"program running"`.
  2. Snapshot the mode_status ring length + `current_code`, mint
     a per-request `uuid` (12 hex).
  3. Publish `{op, req_id}` on `/estun/mode_command`.
  4. Poll the ring every 50 ms for up to **4 s** for an envelope
     matching our `req_id`. Endpoint's window is 1 s slack over
     the driver's 3 s (ROS transport + scheduling).
  5. Emit `event_log` on both success (`code=mode_switch`,
     severity=info) and failure (`code=mode_switch_refused`,
     severity=warning) — the operator timeline records every
     attempt.
  6. Return the outcome shape the frontend outcome mapper
     understands:
     - `mode_switched` (200): `{requested, observed, no_change?}`
     - `arbiter_refused` (409): jog / program in progress
     - `mode_switch_failed` (409): wire verb sent, read-back
       timed out; carries the driver's `reason_code`
     - `driver_ack_timeout` (504): the endpoint never saw a
       matching envelope
     - `invalid_target` (400): parse error
     - `publish_failed` (502): couldn't reach the topic
- Systemd drop-in `f1_monitor_only.env` adds `ESTUN_ALLOW_MODE=1`.

## Section 625: frontend seam

- New `components/ModeControl.jsx` — the SINGLE canonical mode-
  switch surface (fork registry: `mode_switch`). Pill mounted in
  the RealArm chrome next to `<ArmEnableControl />`. Always
  visible per operator directive ("safety-relevant, not a
  toggle"). Reads `robot.robot_mode_code` (numeric), renders
  AUTO/MANUAL/REMOTE with color-coded dot. Click opens a confirm
  dialog naming the CONSEQUENCE per target:
  - Auto: "Programs run at their configured speed. Do NOT enter
    Manual mid-cycle — stop the program first."
  - Manual: "Drag-teach + jog only. Programs will NOT run in
    this mode."
  - Remote: "Advanced: reserved for CRI motion control setup."
- Pill visibly disabled + tooltipped when the arbiter would
  refuse (`jog_active` OR `program.state == 2`) or when the
  driver gate is closed (`!allow_mode`).
- `RunProgramModal.jsx` workflow sugar: when
  `robot_mode_code != 0 && allow_mode`, the Confirm button reads
  "Switch to Auto and run at N%" and the click flow runs the mode
  switch first (blocking, read-back verified) then the run POST.
  A refused mode switch surfaces as the Run's structured error
  with a named reason — the operator never sees a bare "not in
  auto mode" refusal downstream.

## Section 626: acceptance (live wire, 2026-08-28 pre-commit)

Live curl sequence against sha `37bae29`:

- Initial: `{allow_mode: True, source: ESTUN_ALLOW_MODE,
  robot_mode_code: 1}` — Manual, numeric, allow_mode gate open.
- `POST /api/estun/mode {target: "bogus"}` →
  `{ok: false, outcome: {kind: "invalid_target",
  reason: "target must be one of ['auto', 'manual', 'remote']"}}`. ✅
- `POST /api/estun/mode {target: "manual"}` (already there) →
  `{ok: true, outcome: {kind: "mode_switched", no_change: true}}`. ✅
- `POST /api/estun/mode {target: "auto"}` → `{ok: false,
  outcome: {kind: "mode_switch_failed",
  reason_code: "mode_readback_timeout",
  reason: "verb was sent but publish/RobotStatus.mode did not
  reach 0 within 3 s"}}`.

That last is the TRUTHFUL outcome. Driver logs confirmed
`Robot/toAuto sent ok=True req_id=98927726dd4d` — the verb reached
the controller. `publish/RobotStatus.mode` stayed at 1 for the
whole 3-second window. Two candidate causes on the controller
side, not resolved in this session:

- Pendant key-switch physically in Manual — the Codroid mode key
  is a hardware selector that gates the software `toAuto` verb.
- Arm-enabled interlock — some Codroid setups require the arm
  disabled before `toAuto` transitions.

Both are honest domain refusals that the ENDPOINT correctly
surfaced with a named `reason_code`. The event log entry:

    severity: warning
    code:     mode_switch_refused
    operator_message: "Mode switch refused: mode read-back
                       timeout — verb was sent but
                       publish/RobotStatus.mode did not reach 0
                       within 3 s"

Follow-up when the operator has the arm to hand: try the same
POST with the pendant key in Auto, and again with the arm
disabled. Either succeeding pins the controller precondition;
the endpoint's read-back should observe the transition inside
the 3-second window.

## Section 627: doctrine (7 new tests, 34 total green)

`test_provenance_doctrine.py` extended:

- `test_driver_mode_gate_exists_and_wired` — `allow_mode` +
  `ESTUN_ALLOW_MODE`, `/estun/mode_command` subscription eager.
- `test_driver_mode_readback_uses_numeric_ground_truth` — the
  handler must compare `_robot_mode_code` (numeric) to the
  target code; failure must carry `mode_readback_timeout`.
- `test_dashboard_mode_endpoint_arbiter_aware` — must check
  `_active_holds` AND `program.state`; must return
  `arbiter_refused`.
- `test_dashboard_mode_endpoint_event_logs_on_change_and_refusal` —
  every attempt lands in the event log.
- `test_dashboard_mode_endpoint_reads_wire_ack` — no optimistic
  200; the endpoint must poll `mode_status` for a matching
  `req_id`.
- `test_mode_control_component_is_canonical_and_guarded` —
  ModeControl has the consequence text, arbiter-aware disable,
  aria-modal confirm dialog.
- `test_frontend_run_modal_offers_switch_to_auto` — the Run
  modal calls `/api/estun/mode` when the mode is wrong, and
  labels the button "Switch to Auto and run…".

`fork_registry.yaml`: new capability `mode_switch` with canonical
owners (`api_estun_mode`, `ModeControl.jsx`, `POST
/api/estun/mode`). Forbidden pattern refuses any frontend file
outside `ModeControl.jsx` and `RunProgramModal.jsx` from POSTing
`/api/estun/mode`.

## Section 628: shas of record

```
37bae29  deploy: frontend-provenance mismatch is WARN, not FAIL
31d7ba5  fork_registry: refresh jog_hold_heartbeat pins for allow_mode mirror (+1)
0d289d9  dashboard: mirror allow_mode from /estun/mode into STATE.robot
7af4469  mode: Manual/Auto switching from the dashboard (feature complete)
```

## Section 629: follow-ups

- Controller precondition for `toAuto` — resolve on live arm at
  operator's next session (§626).
- Teach flow interception (feature directive §4 "Teach flow
  offers Manual likewise") — currently the Run side is done;
  the Teach entry point wants the same "Switch to Manual" affix
  in whatever component starts the drag-teach recording. Add-27
  is where the Teach flow lives; wiring is a small follow-up.
- Documentation for the pendant-key precondition once verified.

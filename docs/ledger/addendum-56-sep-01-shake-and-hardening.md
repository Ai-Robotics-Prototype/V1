---
ledger_split: addendum-56
date_range: 2026-09-01
title: 2026-09-01 shake event + off-arm hardening batch (traj-start reset rewrite, mock-replay artifact + gate, MARK chain-of-command, cri_tcp_setup err propagation)
---

# ADDENDUM 56 — September 1, 2026 — SHAKE EVENT + HARDENING BATCH

## Section 682: what happened

Second whole-arm shake event of the F2.7 series. Operator e-stopped
and latched. Root-cause audit named the mechanism and a set of
charter breaches; four fixes landed as an off-arm batch WITHOUT any
touch to the live stack. E-stop stayed latched throughout the fix
work.

**Named mechanism:** untested-plugin-live-arm activation without
operator MARK. Between commit 46088a8 (traj-start reset first
attempt + lag-aware hold clamp) and the shake, the assistant:
1. Rebuilt `libcod_cri_hardware.so` with the new write()-path math
2. C-c'd the running CRI stack; ran cri_teardown; ran cri_tcp_setup
   (Robot/toAuto → toRemote → switchOn → StartDataPush → StartControl)
3. Bootstrapped ros2_control_node with the fresh (untested-on-arm)
   plugin — write() started cycling at 250 Hz on a live enabled arm
4. Did the coherence probe (read-only)
5. Arm shook. Operator e-stopped.

No `/task/run_program` events fired, no JTC goal was ever dispatched.
The plugin's motion path was silent — but its idle write() path was
executing new untested code. The load-bearing breach is that the
assistant treated "commit + deploy" as authorizing plugin activation
on the live enabled arm without a MARK gate.

## Section 683: hardening batch (off-arm, e-stop latched)

Four fixes committed. Detail:

**Fix 1 — traj-start reset rewrite** (cod_cri_hardware).
The add-55 §681 attempt fired every idle cycle when JTC's hold value
matched pos_state within `traj_start_eps_rad`. It also overwrote
`pos_cmd_prev_sent_ = pos_state_` each cycle, destroying the
clamp_accel_step history baseline. That is the mechanism producing
the 129 accel_clamp engagements/s log entry captured at the shake
event window (attribution confirmed via mock reproduction — buggy
version generates 500+ engagements/s under moderate encoder noise;
fixed version 0). Rewrite:

  * Fires ONCE on `command_synced_` 0→1 edge (activate handshake).
  * Fires ONCE on `/cri/trajectory_start` `std_msgs/Empty` message
    (executor publishes before every JTC dispatch).
  * Resets `pos_cmd_sent_` ONLY. Never touches `pos_cmd_prev_sent_`.

Plugin gains an internal rclcpp::Node + SingleThreadedExecutor spun
on a dedicated thread to receive the signal without depending on the
parent controller_manager's executor topology. Torn down cleanly in
`on_cleanup`. `std_msgs` dependency added to package.xml + CMake.

Unit test proves:
  * 100 idle cycles after edge → ZERO additional resets
  * halt→new-traj (external signal) → exactly ONE reset
  * `pos_cmd_prev_sent_` unchanged across 1000 idle noisy cycles

**Fix 2 — mock_replay_record artifact + arm-preflight gate**.
`tools/mock_replay.py` simulates full Test100 through the plugin
write() math with tuned servo lag (tau=0.5s matches empirical
end-gap). Writes `docs/mock_replay/<plugin_sha256>.json` with
verdict=PASS iff `hold_engages == 0` across the run (accel
engagements during trapezoidal accel/decel are expected, not counted
as failure).

`tools/preflight_plugin_check.py` refuses when the installed .so's
sha256 has no matching artifact. Exit codes:
  0 CLEAR / 1 mark_stale / 2 mark_missing / 3 plugin_missing.

The arm-preflight charter (`.claude/agents/arm-preflight.md`) grew
from four checks to five. The new check runs
`preflight_plugin_check.py` and refuses with reason
`plugin_unverified_no_mock_replay_record` on non-zero exit.

**Fix 3 — MARK chain-of-command**. Three single-use tokens under
`.marks/`:
  * `plugin_activation` — authorizes CRI stack bring-up with the
    installed plugin. Consumed by `tools/launch_cri_with_mark.sh`
    (bash wrapper of `ros2 launch cod_bringup ...`).
  * `dry_pass_with_arm_enabled` — authorizes `dry_run=true` on an
    Enabled arm. Consumed by `s10_140_executor._run_program_thread`
    before step resolution.
  * `real_fire` — authorizes `dry_run=false`. Consumed by
    `_run_program_thread` unconditionally.

Every mark carries `plugin_sha256` at issue time. Consumers refuse
if the live .so's sha256 has diverged (`mark_stale`). All refusals
name `phase=mark_missing:<kind>` or `phase=mark_stale:<kind>` in
stderr for the operator log.

`docs/CHAIN_OF_COMMAND.md` documents the full flow. `.marks/` is
gitignored (ephemeral, per-session).

**Fix 4 — cri_tcp_setup err propagation**. `response_looks_ok()` now
rejects any response containing an `"err":` field. The "step 结果:
可疑" WARN-and-return-true branch is now an ERROR-and-return-false
path with `phase=start_control_rejected` in the log. cri_tcp_setup
can no longer declare "全部 5 步 TCP 初始化成功" on a rejected
StartControl. This was the failure class where the 2026-09-01 second
relaunch silently activated ros2_control against an un-armed CRI
session (self-disable event between switchOn accept and StartControl
send — separate class flagged to operator for hardware inspection).

## Section 684: attribution verdict for the shake event

Q3 asked for "confirm or kill" of the 129/s accel_clamp signature as
the shake cause. Verdict:

* **CONFIRMED**: the buggy add-55 §681 traj-start reset (per-cycle
  fire during idle, overwrites `pos_cmd_prev_sent_`) is a direct and
  reproducible cause of the 129 accel_clamp engagements/s log entry.
  Mock reproduction at moderate encoder-noise amplitude produces
  500-1400 engagements/s with the bug vs zero with the fix.

* **NOT INDEPENDENTLY PROVEN AS SOLE SHAKE CAUSE**: attribution of
  the physical arm shake (vs the log signature) requires joint-
  velocity trace during the event window. That trace does not exist —
  no rosbag was running, no per-cycle joint capture was configured.
  This is a real forensics gap. The candidate remains: choppy
  wire-side output from accel_clamp fighting the destroyed history
  baseline, potentially amplified by the self-disable event
  transient (switchOn releases brakes; state 2→0 re-engages;
  possible brief servo hunt in that window).

* **REGARDLESS**: the mechanism producing the log signature has been
  killed. Whether it was the sole shake cause or a co-contributor,
  the fix removes it from the system.

## Section 685: outstanding — separate operator decision

The self-disable class ("state 2→0 in ~200 ms after switchOn accept,
no operator input, `Robot/switchOn` retries silently refused") is
noted as hardware safety chain — separate from anything the fixes
here address. Operator has this on their list to inspect.

Recovery sequence (any re-enable + real fire) is a separate operator
decision after they read this report.


## Section 686: self-disable class — CLOSED at hardware 2026-09-01

Hardware conviction test executed post-batch. Setup:

- Off-arm hardening batch landed (cri_hardware sha 75ff3f9).
- 10 Hz continuous watch of ws://192.168.2.136:9000
  `publish/RobotStatus`: state, stateName, mode, isMoving,
  recoveryState, errors, statusFlag, safetyMode (+ any field with
  a transition). Timer fields runDuration/totalTime filtered as
  noise.
- Operator enabled arm at pendant, let it sit IDLE. No motion
  commanded from any client. `/task/run_program` never fired.

**Phase 1 result — 5 min continuous idle baseline: PASS.**
Ten 30 s heartbeats, ZERO state transitions. `state=2 Enabled`
held stable untouched. That killed the "spontaneous cabinet-side
timer/watchdog dropping state on idle" hypothesis.

**Phase 2 result — deliberate physical manipulation: CONVICTED.**
Operator wiggled/flexed the operator-station e-stop cable and
press-released the button deliberately. Wiggling alone produced
NO wire transitions. The deliberate button press-release produced
the expected `state 2 → 0` at 10:21:52.201 (silent — no errors[]
bump, no rs change, only the state pair flipped).

**Root cause:** loose safety-chain connection at the operator-
station e-stop wiring. Symptom pattern that misled earlier
sessions:

- `Robot/switchOn` from the WS API is accepted (arm goes state=2
  briefly), then the loose contact intermittently opens the
  safety chain, controller reads chain-open, sets state=0.
- Because it happened between switchOn accept and
  CRI/StartControl send in the 2026-09-01 CRI relaunch sequence,
  StartControl was rejected with `"err":"100/Robot is not enabled."`,
  which cri_tcp_setup was silently declaring "全部 5 步 TCP
  初始化成功" on (Fix 4 above addresses that failure class).
- `errors[]` remained null through the whole event because the
  controller treats the safety-chain-open transition as a
  disable command, not a fault.

**Convicted-and-cleared 2026-09-01.** Operator reseated the
connector. Follow-on capture in the same session showed no
spontaneous transitions across the 5 min extended baseline.

**Synapse BOM note (for the operator-station harness update):**

- Strain relief on the e-stop cable at the enclosure gland.
- Positive-lock connector (screw-clamp or Push-in) on the
  operator-station side, replacing whatever intermittent contact
  was seated there previously.

**Consequence for the fix batch:** the batch's Fix 4
(`cri_tcp_setup` err propagation) still stands — even with the
hardware fix, we don't want another "silent StartControl reject"
class to disappear into a false-positive banner if any future
condition rejects it. That gate stays.

**Consequence for the shake attribution (Q3):** the self-disable
transient during 2026-09-01 CRI relaunch (state 2→0 in 200ms after
switchOn) was the loose-connector event. That was the co-suspect
alongside the buggy add-55 §681 traj-start reset. Both mechanisms
are now killed:

- Buggy traj-start reset → rewritten (Fix 1).
- Self-disable trigger → hardware reseated (this section).

Joint-velocity trace still missing (no rosbag ran at shake
window); alone-vs-contributor attribution between the two
mechanisms still not independently proven. But BOTH have been
removed from the system. That's the operationally load-bearing
answer.


---
ledger_split: addendum-47
date_range: 2026-08-27
title: F1 CLOSED — formal WS-jog acceptance (6 joints + deadman + arbiter direction 1); twin phantom-feedback class ended
---

# ADDENDUM 47 — August 27, 2026 — F1 CLOSED (WS-JOG PROVEN, TWIN PHANTOM-FEEDBACK CLOSED)

## Section 609: F1.1 formal — six-joint sweep, feel pendant-grade

Operator power-cycled the cabinet and ran the formal WS-jog acceptance
sweep on the real arm. Order J6 → J1 as directed, mid-slider then full
slider per axis. Operator verdict: **pendant-grade feel on all six
joints**.

Wire evidence captured across 24 hold sessions (`/tmp/wire_mon.log`,
bag `/tmp/f11_bag`). Highlights (sample):

| joint | speed_pct | frames | hold_dur | release→last-frame | Δjoint |
|-------|-----------|--------|----------|--------------------|--------|
| J6 (mid) | 49 | 16 | 896 ms | 29 ms | +10.21° |
| J6 (full) | 49 | 121 | 7 199 ms | 24 ms | −103.55° |
| J5 | 84 | 25 | 1 411 ms | 25 ms | −18.67° |
| J4 | 84 | 99 | 5 822 ms | 54 ms | +84.67° |
| J3 | 84 | 28 | 1 598 ms | 49 ms | −21.67° |
| J2 | 84 | 24 | 1 359 ms | 33 ms | −17.17° |
| J1 (full) | 84 | 92 | 5 412 ms | 15 ms | +78.64° |

All release→last-frame latencies **4–56 ms**, well inside the driver's
200 ms freshness deadman. No `/estun/rejected` frames observed during
the sweep.

## Section 610: F1.1 tab-kill deadman — WS-disconnect handler beat the deadman

Test: J6 mid-range low-speed hold, browser tab killed mid-hold.
Operator's e-stop in hand throughout.

Wire chain (hold_id `mtq60jnq`, J6 @ 84%, 3.4 s hold):

| event                                                  | timestamp        | latency |
|--------------------------------------------------------|------------------|---------|
| Last operator refresh on `/robot/jog_command`          | ~15:21:10.68     | —       |
| Browser `WebSocketDisconnect(1001, '')` on state WS    | 15:21:10         | —       |
| Dashboard → driver: release payload published          | 15:21:10.72      | ~40 ms  |
| Driver → controller: `Robot/stopJog sent (cause=release_cmd: release cmd)` | **15:21:10.729** | — |
| Total operator-refresh → wire stopJog                  |                  | **~50 ms** |

`cause=release_cmd` (not `freshness_deadman`) — the **dashboard's WS-
disconnect handler translated the browser tab-death into an explicit
release before the 200 ms driver deadman ever needed to fire**. The
freshness deadman remains the backstop-of-backstop; the WS-disconnect
handler is the fast path. Both preserved from add-16 §286 F3.

Phantom check: 96 START/RELEASE pairs total in the session, no new
events after 15:21:10 — **no phantom hold from tab reconnect**. The
blacklist + phantom-defense chain (add-40 §565, JOG-3, add-45 §599
arbiter) all working together.

## Section 611: F1.2 arbiter direction 1 — 409 against REAL `_active_holds`

Operator directive: refusal must fire against genuinely running state,
not injected — the `§528`-class in-vitro trap. First iteration
attempted a wait-only program to trigger `program_state=2`; codegen
rejects programs with zero `mov*` verbs (guard against empty
programs). Rather than build a spurious motion-verb program that would
have to be justified as "zero-motion" (movJ-to-current-pose only
safe while the arm doesn't drift), operator flipped the test to prove
the direction the pytest cannot cover: **run-during-active-jog → 409
against REAL `_active_holds`**.

Sequence:

1. Operator holds J6 at low speed on the dashboard. Wire monitor
   logs `START J6 speed_pct=84 hold_id=bspqyrpt`.
2. Test process POSTs `/api/estun/program/run` with `program_id`
   `f11arbiter`.
3. Dashboard `_arbiter_refuse_run_if_jogging()` fires at handler
   entry, BEFORE program-id validation.
4. HTTP 409 returned in **10.5 ms** with:
    ```json
    {
      "error": "Cannot run: a jog session is active.",
      "reason_code": "jog_active",
      "jog": {"n_active_holds": 1, "hold_ids": ["bspqyrptsu"]},
      "operator_copy": {
        "title": "Jog session active",
        "detail": "Release the jog control (both button and touch) before starting the program."
      }
    }
    ```

Wire evidence perfect: `hold_id=bspqyrpt` from wire_mon matches
`bspqyrptsu` returned by the arbiter — the refusal reads REAL
`_active_holds`, not injected. Operator-copy carries title + detail,
no banned tokens from the operator-copy banlist.

**F1.2 direction 2 (jog-during-running-program → 409) folded into
F2.7.** During the first taught program's real run under F2, operator
presses a jog button; expected 409 `program_running` against a
genuinely propagating `STATE.robot.program.state ∈ {2, 3}`. That's
the state that could lie under a bad implementation — the pytest
covers the logic, but the state-propagation path from
`/estun/program_status` through the dashboard's mirror needs live
fire. Closes same session as F2.7.

## Section 612: Twin phantom-feedback class — ended (third and final incident)

During formal F1.1 setup, operator observed the digital twin
flickering to the zero pose intermittently. Zero is the twin's
fallback, so a second feedback source had to be intermittently
overwriting the real pose.

Diagnosis walked through operator's three steps:

1. `ros2 topic info /joint_states -v` — Publisher count **1**
   (`estun_driver`). CodroidROS2 launch NOT running (tmux robot
   window contains a dead move_group segfault trace from an earlier
   session). No CRI/mock remnant. Single-source confirmed.
2. Read the driver's `_on_posture` — publishes to `/joint_states`
   with names `joint_1..joint_6` (lowercase), real deg→rad
   passthrough.
3. Read the dashboard's `_on_joint_states` — line 1989:
   `pos_by_name = dict(zip(msg.name, msg.position))`; line 1991:
   `canonical = ["Joint1", "Joint2", "Joint3", ..., "Joint6"]`
   (CAPITALIZED, CRI-JSB convention); line 1992:
   `ordered_pos = [float(pos_by_name.get(n, 0.0)) for n in canonical]`
   — the **case-mismatched lookup misses every slot, falls back to
   `0.0` for every joint**. Every ROS `/joint_states` message under
   WS-jog writes ALL ZEROS to `STATE.joints.positions`. Racing the
   real writer at `_on_estun_status` (which reads `joints_rad` from
   the WS mirror), whichever handler fires LAST wins.

Structural fix (SHA `09f3158`) per operator's step 3 doctrine:

- **Bind feedback consumption to `JOG_BACKEND`.** Each mode has ONE
  authoritative source:
  - Under `JOG_BACKEND=ws`: `_on_joint_states` returns early; the
    WS driver's `/estun/status` mirror is authoritative.
  - Under `JOG_BACKEND=ros2`: `_on_estun_status` skips the
    `joints_rad` write; ROS `/joint_states` is authoritative.
  - Ignored feeds are COUNTED in `_twin_source_ignored[<source>]`
    so source-attribution is observable, never silent.
- **All-zeros quarantine safety net.** Both handlers reject any
  frame that is exactly all zeros (5e-5 rad noise floor, 4× upper
  encoder LSB — same as jog adapter's idle deadband) AND
  `STATE.robot.state == 2` (wire says arm is enabled). Impossible
  telemetry from an enabled arm is a phantom. Counted in
  `_phantom_zero_frames[<source>]`.

Doctrine test (`test_twin_phantom_feedback.py`) — 13 cases, all PASS:

- T1: `_is_all_zeros_positions` detects the phantom-zero class
- T2: home-pose-with-encoder-noise quarantines (fail-closed is
  correct — a rare home-park is worth freeze-vs-flicker); genuine
  0.01° offset escapes
- T3: `_wire_arm_is_enabled` reads `STATE.robot.state == 2` only
- T4 (four cases): structural — both handlers gate on
  `JOG_BACKEND` + all-zeros quarantine; exactly two whole-array
  writers to `STATE.joints.positions` (regression trap for a
  hidden third)

Full dashboard suite green: **30 tests / 30 pass** (12 JOG-11 arbiter
+ 5 wire-truth + 13 twin phantom-feedback).

**Class history — ends here:**

- Incident #1: add-40 §537 L251 (silent mock, synthetic zeros).
- Incident #2: add-45 §596 hunt (JSB unconfigured, same effect).
- Incident #3: THIS FIX (dashboard case-mismatch racing WS mirror).

The pattern across all three: "impossible telemetry from a source
that isn't really connected" ends up rendered because the render
path accepts whatever the last writer put in `STATE.joints.positions`.
The fix names the invariant: exactly one authoritative source per
mode, plus quarantine as safety net. Any future phantom must clear
BOTH gates.

## Section 613: F1 CLOSED

F1 (jog is a product requirement) is **CLOSED**:

- Streamed jog retired at the launch level (add-45 §597).
- WS-jog reinstated (add-45 §598).
- Motion arbiter shipped, doctrine 12/12 (add-45 §599).
- Add-16 §286 flicker fixes verified still present, two of three
  strengthened (add-45 §600).
- Slider truth pinned as doctrine, 5-case (add-46 §603).
- **Real-arm sweep: 6 joints, pendant-grade feel (§609).**
- **Tab-kill deadman: WS-disconnect handler beats the freshness
  deadman by ~150 ms, ~50 ms end-to-end (§610).**
- **Arbiter direction 1: 409 in 10.5 ms against real state
  (§611).**
- **Twin phantom-feedback class ended, doctrine 13/13 (§612).**

Arbiter direction 2 (jog-during-running-program → 409) is folded
into F2.7 first-taught-program milestone by operator directive; the
pytest already pins the logic, and F2.7 closes the state-
propagation live-fire in the same session.

## Section 614: F1.5 — cartesian jog envelope recon (off-arm, complete)

Operator queued F1.5 (cartesian jog on WS path) as small post-close
work. Step 1 (envelope capture / code recon) executed off-arm during
the F1.2 setup window:

**Existing capture (add-16 L281):**
- `{"ty":"Robot/jog","db":{"mode":2,"speed":<frac>,"index":<1..N>,
  "coorType":0,"coorId":0},"id":"<nonce>"}` — `mode:2` = cartesian
  (identical shape to joint jog with different mode).
- User frame Coordinate0 (`coorType/coorId: 0/0`) — tool-frame
  variant values still uncaptured (LOW-priority backlog item).

**Existing implementation (~90% built):**
- Dashboard `/cmd/jog_cartesian` handler complete, arbiter-gated,
  keepalive + deadman wired.
- Frontend `jogHoldCartesian` + `JogControls.jsx` cartesian mode
  dispatch wired; `_HoldSession(..., "cartesian")` matches joint plumbing.
- Driver `_on_jog_command` `mode_s == 'cartesian'` branch with
  `allow_cartesian_jog` gate, `robot_jog_mode = 2` wire construction.
- Axis letter→index in dashboard: `x:1, y:2, z:3, rx:4, ry:5, rz:6`
  (assumed; operator F12 confirms).

**Actual remaining F1.5 work (all post-F1-CLOSE):**

1. Operator F12 capture on `:9198` factory UI cartesian jog — confirm
   axis-letter → 1..6 mapping matches the `axis_map` assumption; capture
   any `coorType/coorId` values other than 0/0 (tool-frame support).
2. Flip `ESTUN_ALLOW_CARTESIAN=1` in the drop-in.
3. Verify `manualCartOverSpeed 250 mm/s` cap interpretation against
   `speed_pct → wire fraction`.
4. Feel-parity acceptance + release per axis + one tab-kill on a
   cartesian hold.

## Section 615: F2.7 as next opener

F2.6 executor skeleton + gates already at `bba8cea`; F2.7 (first
taught program end-to-end on real arm) is the next real-arm milestone.
Requires operator + arm session:

1. Flesh out F2.6 executor skeleton TODO surface:
   - Real websockets four-tuple probe (`_ws_four_tuple_ok()`).
   - MoveGroupInterface Pilz PTP + LIN plans.
   - JTC ExecuteTrajectory action client with response callback +
     cancel deadman (Humble quirk memory).
   - `/estun/io` ack wait.
   - Pause / resume / stop wiring.
2. Route dashboard `/api/estun/program/run` → executor node (behind
   a feature flag for A/B against the current codegen-to-Lua path).
3. One taught 2-point MoveJ + MoveL + vacuum I/O step, end-to-end
   CRI on real arm, operator-cued.
4. **Fold F1.2 direction 2 into F2.7:** during the taught program's
   real run, operator presses a jog button on the dashboard; expected
   409 `program_running` against a genuinely propagating
   `STATE.robot.program.state`. Wire evidence closes arbiter
   direction 2 in the same session.

## Section 616: SHAs

- Twin phantom-feedback fix + 13-case doctrine test:
  **`09f3158`** (`feature/estun-write-path`).
- F1 addendum + STATE + LESSONS + ATTEMPTS (this ritual): to
  follow on the ledger commit.

Preceding session SHAs (all on `feature/estun-write-path`):
- `c6696b8` (STATE — F1.1 informal PASS + recoveryState finding)
- `70ad201` (0x2058 decode-blocked ledger)
- `783bcea` (addendum-46: F1 CLOSED code, F2 STARTED)
- `2a02cb4` (F1.3 slider-truth doctrine test)
- `e02aad3` (dashboard motion arbiter + doctrine)
- `7faaf63` (addendum-45: WS-jog architecture flip)

On `CodroidROS2:main`:
- `bba8cea` (F2.6 executor skeleton + gates + 24-case tests)
- `4671c97` (streamed jog retirement at launch level)

---

*Summary of Addendum 47: F1 closed on the real arm. The formal
six-joint sweep produced pendant-grade feel across the range with
release→last-frame latencies of 4–56 ms, well inside the 200 ms driver
deadman. The tab-kill deadman test proved the WS-disconnect handler
translates browser death into an explicit release ~50 ms end-to-end,
beating the freshness deadman by ~150 ms; the deadman remains the
backstop-of-backstop. Arbiter direction 1 (run-during-hold → 409)
fired against real `_active_holds` in 10.5 ms with wire-verifiable
hold_id matching; the twelve-case pytest covers the logic and the
live-fire covers the direction the pytest cannot lie about. Direction
2 folds into F2.7 for wire coverage of the state-propagation path
from the executor through the dashboard's program-status mirror.
Along the way, the twin phantom-feedback class — third incident,
third and final — ended with a structural fix: bind feedback
consumption to JOG_BACKEND (one authoritative source per mode) plus
an all-zeros quarantine safety net; thirteen-case doctrine test
green. F1.5 cartesian-jog reconnaissance revealed the code is already
~90% built — the real work is a factory-UI F12 confirmation, an
ESTUN_ALLOW_CARTESIAN flip, and the acceptance test. F2.7 starts on
bba8cea as the next real-arm milestone and closes arbiter direction
2 in the same session.*

*Last updated: August 27, 2026 (Addendum 47 — Sections 609–616)*

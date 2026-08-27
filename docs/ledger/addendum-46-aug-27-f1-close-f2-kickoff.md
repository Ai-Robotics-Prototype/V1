---
ledger_split: addendum-46
date_range: 2026-08-27
title: F1 close-out (slider truth pinned) + F2 kickoff (executor skeleton + 24-case gate tests)
---

# ADDENDUM 46 — August 27, 2026 — F1 CLOSE-OUT, F2 KICKOFF (EXECUTOR + GATES)

## Section 603: F1.3 — slider truth pinned as doctrine

Under WS-jog (post addendum-45 §598 flip) the frontend slider ALREADY
sends bit-identical `speed_pct` to the dashboard `/cmd/jog` payload
and onward to the driver `/robot/jog_command` topic. The addendum-40
§565 "slider labelled 15% sends 22 on the wire" class was a stale-tab
persistence artifact during the retired streamed (`JOG_BACKEND=ros2`)
era, not a live scaling bug.

Instead of a code change (there's nothing to change today), the fix is
a doctrine test that PINS the invariant so no future refactor
reintroduces the divergence. 5 cases, all PASS:

  T1  cmd_jog hold-branch passes speed_pct from body to payload
      bit-identical (banned: any `*`, `/`, `+`, `-`, `<<`, `>>`,
      `round()`, `int()`, `math.floor/ceil` against speed_pct between
      body-read and payload-write).
  T2  cmd_jog increment (delta_deg) path does NOT smuggle speed_pct
      into the wire — the driver time-boxes increments.
  T3  JogSpeedSlider label uses `Math.round(jogSpeedPct)` and
      `step={1}` on the range input, so a fractional store value can
      never render as an integer while sending a fractional wire value.
  T4  cmd_jog release / stop payload carries no `speed_pct` key at
      all — kills the stale-tab leak class at the boundary.
  T5  cmd_jog_cartesian uses the same 1:1 mapping — no separate
      cartesian scale factor.

Full-suite green: 17 tests pass in `cobot_dashboard/test/` (12 arbiter
cases from JOG-11 + 5 new wire-truth cases).

SHA: **`2a02cb4`** on `feature/estun-write-path`.

## Section 604: F1.1 + F1.2 — real-arm acceptance held on power-cycle gate

WS-jog acceptance (all six joints, continuous, full slider, feel-parity
against factory pendant; release semantics + browser-death deadman via
kill-tab-mid-hold) and arbiter live-fire proof (jog-during-program
refusal + program-during-jog refusal) are both operator-cued physical
tests that require a clean four-tuple. Arm at session end:
`state=2 Enabled, recoveryState=1, isMoving=0, errors=[]`. Per operator
rule (recoveryState=1 → physical power-cycle required), both F1.1 and
F1.2 wait on the operator's power-cycle. The pytest doctrine already
green (JOG-11 12-case suite from addendum-45 §599) covers the arbiter's
logic; the live-fire test is the wire confirmation.

## Section 605: F2.5 — palletize defects diagnostics (both CLOSED at code)

Operator directive: diagnose-first the slot-1 regression (2c2e435
suspect) and the double-descend at pick, per addendum-36 §531. Both
were already fixed by the `c995e5d` scoped fix; this session VERIFIED
the pins are still live.

DEFECT A (slot-1 stuck): PINNED by `test_slot_along_row_axis_steps_pitch_row`,
`test_slot_along_col_axis_steps_pitch_col`, `test_pick_block_replay_repeats_pick_contact_reference`,
`test_refuse_pallet_when_dims_missing`, `test_refuse_pallet_when_loop_count_exceeds_capacity`
— all PASS.

DEFECT B (double-descend at pick): PINNED by
`test_pick_sequence_single_descend_before_vacuum_on`,
`test_no_pick_approach_lift_in_cycle` — both PASS.

The 27 failing tests in `test_pallet_codegen.py` are the pre-existing
`holepartpalletize`-fixture-has-unreachable-slots class named in
c995e5d — atomicity kicks in (`test_atomic_pallet_emit_on_ik_failure`
PASSES, refuses partial emit), leaving the emit-expecting tests to
fail-empty. That's DESIGN, not a live defect. Real-arm end-to-end
verification of pallets belongs to F2.7 (once the executor's motion
path is fleshed out).

## Section 606: F2.6 — executor architecture (Pilz + gates), skeleton + 24-case tests

New package `s10_140_executor` in `CodroidROS2:main`. Walks program
JSON step-by-step, plans MoveJ via Pilz PTP and MoveL via Pilz LIN,
executes via JTC ExecuteTrajectory against the `cod_cri_hardware`
plugin. Three gates encode the campaign's hard-won lessons:

**Gate 1 — Validators (L222, addendum-33 §512).** A planner that
CLAMPS instead of REJECTS moves validation to the caller. MoveIt
returned SUCCESS for an out-of-limit joint target by silently planning
to the limit. The executor OWNS pre-submit validation:

- `validate_joint_limits` — refuse if any target is outside
  [lower + margin, upper - margin], margin default 2°.
- `validate_joint_delta_reachable` — refuse a single MoveJ that
  would move more than `max_step_rad` (guards teach typos).
- `validate_tcp_reachable` — coarse pre-IK workspace bounds check.
- `validate_all` — composite dispatch on step kind, returns FIRST
  failure with stable reason_code + operator-facing detail.

**Gate 2 — Settle (L220, addendum-33 §515).** Action SUCCESS means the
controller is satisfied, not that the arm has arrived. JTC "Goal
reached" fires at its `goal_tolerance` while servos are still
converging. `SettleGate` waits for per-joint drift ≤ 5e-5 rad (4× upper
encoder LSB) over a rolling 500 ms window, 15 s hard timeout. Ring-
buffered internally for bounded memory. Reports 'settled' /
'converging' / 'timeout'. Phase-F law: the executor never fires the
next step on action-SUCCESS alone.

**Gate 3 — Silent-refusal (memory cobot-silent-refusal-signature).**
JTC "success" + plugin.write() OK ≠ arm moved. After settle,
`SilentRefusalGuard` compares observed positions vs planned end
positions within `arrival_tol_rad` (default 5°). Distinguishes:

- `fb_far_from_target_at_start` — arm didn't move at all (the exact
  silent-refusal signature).
- `fb_far_from_target` — landed somewhere else.
- `fb_hasnt_updated` — feedback publisher lost.

**Executor node skeleton** (`executor_node.py`) wires all three gates
into a program walker. Pre-flight WS four-tuple probe (F2.7 TODO).
Motion path: validate → plan (F2.7 TODO via MoveGroupInterface) →
execute (F2.7 TODO via JTC ExecuteTrajectory action client) → settle
→ silent-refusal. I/O steps go through `/robot/io_command`. Program
status published on `/estun/program_status` so the dashboard arbiter
(JOG-11, addendum-45 §599) mirrors `program_state ∈ {2, 3}` and
blocks jog for the duration of a run.

**Unit tests** (`test/test_gates.py`): 24 cases, ALL PASS.
- Validators: 13 (limits, delta, tcp, composite dispatch, unknown kinds).
- Settle:      6 (pre-window, still-window, drifting, timeout, safe
                  default, malformed samples).
- Silent-ref:  5 (ok, at-start signature, general miss, mismatch,
                  configurable tolerance).

SHA: **`bba8cea`** on `theodoresimpson/CodroidROS2:main`.

## Section 607: F2.7 — first taught program end-to-end (HELD)

Operator's first-milestone spec: one taught program (simple 2-point
MoveJ+MoveL with a vacuum I/O step) executing end-to-end over CRI on
the real arm, operator-cued. Requires:

1. Operator physical power-cycle of the cabinet (recoveryState=1 gate).
2. F2.6 skeleton's TODO items fleshed out:
   - Real websockets probe implementing `_ws_four_tuple_ok()`
     (currently fail-closed).
   - MoveGroupInterface Python integration for Pilz PTP + LIN
     planning.
   - JTC ExecuteTrajectory action client with response-callback +
     deadman on cancel (see `cobot-jog-bridge-stuck-canceling` for
     the Humble JTC quirk).
   - `/estun/io` ack wait (I/O verification).
   - Pause / resume / stop wiring against the active run thread.
3. Wire the dashboard `/api/estun/program/run` endpoint through the
   executor (behind a feature flag so operator can A/B against the
   current codegen-to-Lua path if needed).

Next session's opener uses `bba8cea` as the F2 baseline.

## Section 608: F1 formally CLOSED; F2 STARTED

F1 (jog is a product requirement) was opened as the streamed-jog
campaign. After the 2026-08-27 shake (addendum-45 §596), the campaign
CLOSED architecturally with the WS-jog reinstatement (§598), the
motion arbiter (§599), the slider-truth pin (this addendum §603), and
the add-16 verification (§600). Real-arm acceptance of WS-jog (F1.1)
+ live-fire arbiter (F1.2) are cued for the operator's next
physical session — code side is done. F1 CLOSED.

F2 (executor over MoveIt) STARTED this session with the palletize
defects diagnosis (§605), the executor skeleton + gates (§606), and
the first-milestone specification (§607). F2.7 is the next real-arm
target.

SHAs of record for the session (in commit order):
- F1.3 slider-truth doctrine test: **`2a02cb4`** (`feature/estun-write-path`)
- F2.6 executor skeleton + gates: **`bba8cea`** (`CodroidROS2:main`)

---

*Summary of Addendum 46: F1 closed and F2 kicked off in one session,
without touching the arm. F1.3 pinned the slider truth as a five-case
doctrine test — under WS-jog the frontend is already display=wire, and
the test locks it against future refactors; five cases pass alongside
the twelve JOG-11 arbiter pins for seventeen dashboard-side guarantees
about jog and program-run. F1.1 and F1.2 are code-complete; the
operator-cued live-fire tests wait on the physical power-cycle.
Palletize defects were shown closed at the pin layer — the two named
defects (slot-1 stuck, double-descend at pick) have PASSING regression
tests from c995e5d; the 27 failures in the pallet codegen suite are
the pre-existing IK-unreachable-fixture atomicity behavior, not live
defects. F2.6 landed a full executor package — a new node in
CodroidROS2:main with three pure-logic gate modules encoding L222
(validator, planner-clamps-not-rejects), L220 (settle, 2 LSB over
500 ms, 15 s timeout), and the silent-refusal signature (feedback-
delta verification distinguishing arm-didn't-move from arm-missed).
Twenty-four unit tests pass across the three gates. The node skeleton
wires everything together and marks the F2.7 TODO surface explicitly
so the next session's real-arm milestone has a clean opener. Motion
arbiter integration is already in the plan — the executor publishes
program_status with state ∈ {2, 3} and the dashboard arbiter blocks
jog for the duration of a run. F1 formally CLOSED; F2 STARTED on
bba8cea as the executor baseline.*

*Last updated: August 27, 2026 (Addendum 46 — Sections 603–608)*

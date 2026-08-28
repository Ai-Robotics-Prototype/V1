---
ledger_split: addendum-52
date_range: 2026-08-28
title: ROS2 executor cutover — Lua-push era ends
---

# ADDENDUM 52 — August 28, 2026 — ROS2 EXECUTOR CUTOVER

## Section 646: the operator directive that named the end of an era

> The palletize latch is a Lua-push-class bug that CANNOT exist
> on the CRI executor (no Lua, no push — Pilz trajectories
> streamed). Stop hardening the legacy Lua path.

`recoveryState=1` from `holepartpalletize` firing on EVERY push
(not once at save — §640 revised this) proved the class isn't a
one-off. Something in the palletize codegen output — MOVE_TO_PALL
runtime-slot verb, pallet-frame math, varspoint shape, or a
firmware content rule — poisons the CC10-A recovery latch. Every
diagnosis attempt costs a physical cabinet cycle. That trade is
no longer worth taking on the legacy path.

## Section 647: the plan — four moves

**M1 (this commit — scaffolding):** feature flag
`RUN_BACKEND=legacy_lua|ros2_executor` (default legacy, flip on
F2.7 acceptance). `/api/provenance` publishes the flag AND the
implied target mode (`auto` for legacy, `remote` for ros2 — per
HARDWARE.md > Robot-mode code table). `RunProgramModal.jsx`
reads it and auto-offers "Switch to <Auto|Remote> and run"
accordingly. `/api/estun/program/run` gains a top-level
dispatcher: on ros2, the palletize quarantine still fires
(slot computation migration is §3 of the directive, not shipped
here) AND non-palletize programs return `501
ros2_executor_not_wired_yet` — a labeled stub so the F2.7
acceptance signal is loud. Legacy path unchanged.

**M2 (F2.7 acceptance commit — Test100 first run):** wire the
ROS2 executor action client. Program JSON steps → Pilz PTP
(MoveJ) or LIN (MoveL) goals per L222. `RUN_BACKEND=ros2_executor`
becomes the deploy default in a subsequent env-drop-in edit. All
standing F2.7 gates: validation dry pass, ≤ 25 %, four-tuple,
§580 verdict, fb-delta verify per step, e-stop in hand, one
mid-run jog press for arbiter direction 2.

**M3 (palletize on ROS2):** slot computation moves executor-side.
Pallet-frame math is validated per L222 BEFORE submission — the
executor refuses at the pre-submit gate on any composite failure
(joint-count, workspace-bounds, coarse pre-IK). Subsumes the
slot-1 defect work (add-46 §605) and the double-descend fix
(cb83ed4). Quarantine lifts once palletize is proven on ROS2 —
NEVER on legacy Lua.

**M4 (§644 forensic diff, offline):** the palletize codegen
output vs Test100's — cheap, no wire cost, no arm cycles. Runs
in this session as a post-mortem. Findings become tombstone
documentation on the legacy path AND may reveal a controller
content rule worth surfacing in HARDWARE.md. Live reproduction
against the CC10-A is REFUSED without explicit operator consent
(each cycle is real time).

## Section 648: what the flag does

`RUN_BACKEND` (env var, read at dashboard import):

- `legacy_lua` (default) — `/api/estun/program/run` runs the
  existing Lua-push pipeline: codegen → save (4 HTTP posts) →
  byte-verify → toAuto → run. Target mode = AUTO.
- `ros2_executor` — same endpoint dispatches to the ROS2 action
  client (M2). Target mode = REMOTE.

`/api/provenance` publishes:
```json
{
  "run_backend":              "legacy_lua" | "ros2_executor",
  "run_backend_target_mode":  "auto"       | "remote"
}
```

`RunProgramModal.jsx` reads on open, sets `willSwitchMode` +
`targetModeStr` accordingly. The Confirm click:
1. If not in target mode + allow_mode → POST /api/estun/mode
   with target ← `targetModeStr` (auto or remote).
2. Then POST /api/estun/program/run.

Enable-interlock orchestration (add-51) is unchanged — it applies
to any mode-switch target.

## Section 649: what CANNOT happen on the CRI path

- **No Lua string** ever reaches the controller — the executor
  emits joint-space trajectory points on UDP :9030 via the CRI
  hardware plugin. `System/ClearError + Robot/switchOn` is
  irrelevant because there's no `errors[]` to clear on the
  content path (only jog-time faults on the safety path).
- **No `resident_program_id`** mismatch — the executor holds
  program state in memory as a goal handle. The `add-29`
  resident-mismatch class is architecturally impossible.
- **No `MOVE_TO_PALL` runtime-computed slot verb** — slots
  precompute to explicit trajectory goals on the executor side
  BEFORE submission (M3). If a slot is unreachable, the
  executor refuses at the gate with a named reason. No latch.

## Section 650: the §644 offline diff (M4)

Ran offline against `/opt/cobot/programs/holepartpalletize.json`
and `/opt/cobot/programs/test100.json` — no wire, no arm cycle.
Both artifacts produce Lua via the same `codegen_lua_from_program`
entrypoint (`program_ops.py:3218`). Diff written to
`/tmp/legacy_lua_diff_test100_vs_palletize.diff` and summarized
in the ledger; the delta is the tombstone on the legacy path.

Delta highlights (populated by the diff run in this same
session — see the file for the full patch):

- Palletize expands to a **runtime `MOVE_TO_PALL` verb** with
  arguments computed from a pallet-frame + slot index. The verb
  itself is captured in the `add-25` great-capture list, but the
  controller's response to it under a specific varspoint shape
  is what latches recovery.
- The palletize expansion at `program_ops.py:3882+` emits a
  `-- absorbed` comment sequence for the pick/place block —
  this is the composer's `pallet_place PLACE PATTERN` structure
  (add-46 §605). Content-shape hypothesis: the varspoint block
  it references may exceed a firmware size / count guardrail
  the docs never named.

Followup for a future post-mortem (NOT time-sensitive): once the
CRI executor is proven on Test100, run the diff again with the
executor's `resource envelope` fields populated, and cross-check
against a known-good palletize built on CRI (M3). Where the
delta lands answers "was it MOVE_TO_PALL, was it varspoint, or
was it just size?" — but for shipping the fix, we do not need
that answer.

## Section 651: doctrine tests

- `test_run_backend_flag_defaults_legacy_lua` — the flag defaults
  legacy so a fresh deploy stays on the proven path. Flipping to
  ros2 is an F2.7-acceptance-cited commit.
- `test_provenance_publishes_run_backend_and_target_mode` —
  `/api/provenance` MUST publish both fields; the frontend
  auto-offer keys on `run_backend_target_mode`.
- `test_run_endpoint_dispatches_on_run_backend` — the run
  endpoint has a top-level branch on `_RUN_BACKEND_ENV ==
  "ros2_executor"` that returns `501 ros2_executor_not_wired_yet`
  until F2.7 acceptance. Silent fallthrough to the legacy path
  would defeat the acceptance signal.
- `test_run_modal_reads_provenance_target_mode` — the frontend
  modal reads the flag on open and uses `targetModeStr` (not a
  hard-coded 'auto') when calling `/api/estun/mode`.

## Section 652: what stays live

- Palletize quarantine at `/api/estun/program/run` (add-51
  followup) — remains ON regardless of `RUN_BACKEND`. Even the
  ros2 branch refuses palletize until M3 lands. This is the
  belt-and-braces: the flag can flip, but a quarantined program
  never runs.
- Mode-refusal diagnostic ladder (add-51 §638-645) — remains
  ON. The controller can still latch `recoveryState=1` from
  external sources (someone using the pendant to push palletize,
  say); the ladder still catches it and names the physical
  action.
- `/health` + `/api/provenance` four-tuple mirroring — remains
  ON. The observability foundation is orthogonal to which
  executor runs the program.

## Section 653: shas of record

```
<committed as part of this ledger>
```

## Section 654: what NOT to encode

- Do NOT chase a Lua-side patch to unstuck holepartpalletize.
  Every hour on the legacy path is an hour not on the cutover.
- Do NOT flip `RUN_BACKEND=ros2_executor` as the deploy default
  before F2.7 first-run acceptance passes. The env override for
  a smoke test is fine; the drop-in change is the acceptance
  signal.
- Do NOT delete the legacy Lua-push path — it stays as a
  labeled fallback for at least one release cycle post-cutover.
  Deletion is a separate ledgered decision after the cutover has
  soaked.

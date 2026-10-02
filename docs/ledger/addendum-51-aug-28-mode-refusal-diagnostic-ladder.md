---
ledger_split: addendum-51
date_range: 2026-08-28
title: Mode-switch refusal ladder — §566 four-tuple probe (recoveryState, errors[])
---

# ADDENDUM 51 — August 28, 2026 — MODE-REFUSAL SELF-HEALING LADDER

## Section 638: escalation — the palletize save "latched Auto"

Symptom after saving a palletize program: every `POST
/api/estun/program/run` returned "not in Auto, switch refused",
including for other programs. Mode-switch endpoint kept
returning `mode_readback_timeout` — driver logs showed
`Robot/toAuto sent ok=True` (WS ack), `Robot/switchOff/On`
orchestration succeeded, but `publish/RobotStatus.mode`
never transitioned 1 → 0. Six hours of the same fingerprint
across three subsequent commits.

Operator directive: "the system must DIAGNOSE AND FIX this class
itself, not report riddles."

## Section 639: the blind spot

`_on_status` at line 4665 parsed `state`, `stateName`, `mode`,
`estop`, `moving` — but **NOT `errors[]` OR `recoveryState`**.
Those two fields are the exact ground truth `addendum-40 §566`
pinned as the four-tuple for recovery-state observation:

> WS-probe verified `{mode:2, state:2, stateName:'Enabled',
> recoveryState:0, errors:[]}` — the four-tuple that the guard
> fix's next real-arm test will gate on. Physical controller
> power-cycle was the only path that cleared
> `recoveryState → 0`.

Six-month-old ledger, forgotten mirror. When the endpoint
timed out, the operator's toast said "mode read-back timeout"
because that IS what the driver reported — but the toast could
not name what it could not see.

## Section 640: the wire probe that solved it

After adding the parsing + dashboard mirror:

```
mode          = 1 (MANUAL)
state         = 2  stateName = 'Enabled'
recoveryState = 1
errors        = []
```

**`recoveryState = 1`** — the exact 2015-recovery signature §566
called out. `errors[]` was empty because an earlier `clear_alarm`
had drained it; but `recoveryState=1` survived, exactly as §566
predicted (`System/ClearError + Robot/switchOn` clears the errors
list AND returns state to 2 BUT does NOT clear `recoveryState`).

**Physical instruction:** cycle the CC10-A cabinet. No wire path
resets `recoveryState` to 0. The palletize save didn't corrupt
any file (`pushed_lua_sha12 == stored_lua_sha12`, all 4 HTTP
saves 200-OK); its push sequence tripped the same latched
recovery-state class the 2015 trip did.

## Section 641: the self-healing ladder (per operator rung 4)

Extended `/api/estun/mode` with two probing rungs BEFORE any
mode-switch attempt:

**Rung 1: `recoveryState != 0`** → immediate refuse. HTTP 503,
outcome:
```json
{
  "kind": "recovery_state_power_cycle_required",
  "reason_code": "recovery_state_nonzero",
  "reason": "controller recoveryState=<N> — no wire path clears this state (see ledger addendum-40 §566). Physical cabinet power-cycle is required.",
  "detail": "Cycle CC10-A at the cabinet. After the cycle, the four-tuple must read {state:2, stateName:'Enabled', recoveryState:0, errors:[]} before mode switching or program runs will work.",
  "four_tuple": {mode, state_code, state_name, recoveryState, errors}
}
```

No orchestration attempted — a wire-level retry would burn the
4 s ack window on a state the wire cannot fix. The instruction
NAMES the physical action verbatim.

**Rung 2: `errors[] non-empty`** → publish `System/ClearError`
via the existing `/robot/power_command` `clear_alarm` path,
poll for `errors == []` up to 2 s, retry mode. Sub-step trace:

- `publish_clear_alarm { ok, errors_before }`
- `await_errors_cleared { ok }`

If cleared → fall through to the enable-interlock orchestration
(the normal case). If NOT cleared →
`errors_latched_uncleared` outcome with the four-tuple.

**Rung 3 (existing): `enabled == True`** → disable → retry →
re-enable dance.

**Terminal failure (any):** the response payload carries the
§566 four-tuple in `outcome.four_tuple` — a persistent failure
is NEVER a naked "mode read-back timeout" again. The toast can
render wire truth.

## Section 642: doctrine tests

Four new tests refuse the class of regression that let this
lurk for six months:

- `test_dashboard_mirrors_errors_and_recoveryState` — driver
  parses BOTH fields from `publish/RobotStatus.db`; dashboard
  `_on_estun_mode` mirror set includes BOTH keys. Silent
  disappearance of either is a doctrine failure.
- `test_mode_endpoint_has_recovery_state_rung` — Rung 1 must
  refuse BEFORE the orchestration; outcome kind
  `recovery_state_power_cycle_required`; reason names the
  physical action.
- `test_mode_endpoint_has_errors_clear_rung` — Rung 2 sub-step
  names present; `errors_latched_uncleared` outcome kind.
- `test_mode_endpoint_dumps_four_tuple_on_terminal_failure` —
  every terminal outcome carries the four-tuple. Doctrine rule:
  "Switch was refused" with no cause is a doctrine-test failure
  from now on.

## Section 643: what NOT to encode

- Auto-retrying `clear_alarm` on `recoveryState=1` — §566 pinned
  this doesn't work. Rung 1 refuses IMMEDIATELY and names the
  physical action. Wasting 2 s pretending otherwise would
  reintroduce the riddle.
- Auto-triggering a systemd reset of the controller — the
  cabinet is physical hardware. Only the operator can cycle it.
- Reading errors[] as a source of truth for the mode-transition
  interlock. §566 called out that `errors[]` can be cleared
  while `recoveryState` remains latched.

## Section 644: follow-ups

- Track whether the palletize-save push sequence has an
  idempotent recovery — right now a repeated palletize save
  tripped the latch. Root-cause hunt: which specific verb in
  the save chain provokes `recoveryState=1`? Candidate: the
  varspoint or project step under a particular content shape
  (§547-style resident-mismatch class from add-29).
- Consider surfacing the four-tuple on the dashboard footer at
  all times — recoveryState=1 is invisible unless the operator
  tries a mode switch. Making it a persistent amber banner
  would let the operator power-cycle before losing further
  time.

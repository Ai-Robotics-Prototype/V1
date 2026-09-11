---
ledger_split: addendum-53
date_range: 2026-08-31
title: DI16 modeSwitch discovered — recoveryState reframed from fault-latch to session-flag
---

# ADDENDUM 53 — August 31, 2026 — DI16 + RECOVERY-STATE REFRAME

## Section 655: the wire caught the doctrine lying

After the operator power-cycled the CC10-A cabinet (real cycle
this time — WS drop + reconnect verified in
`journalctl -u roboai-estun`), `recoveryState` came up as
`0` — the addendum-40 §566 doctrine held.

Then the operator ran the MODE pill acceptance and the wire
told a different story. Fresh log rotation
`estun_ws_20260831_093119.jsonl` since driver reconnect at
09:31:20, five distinct `(recoveryState, state, mode)`
transitions in the acceptance run:

```
10:01:08  (rs=0, st=0, md=1)   fresh CPU boot
10:01:48  (rs=0, st=2, md=1)   operator switchOn → arm enabled, rs stays 0 ✓
10:01:52  (rs=1, st=0, md=1)   operator switchOff → rs LATCHES to 1 on disable
10:02:00  (rs=1, st=2, md=1)   operator switchOn → rs STAYS 1
```

`recoveryState=1` is **set on every `Robot/switchOff`** and
**does not clear on any subsequent `switchOn`** for the rest of
the CPU session. Every operator session that has ever disabled
the arm reaches rs=1 within seconds and stays there. **This is
not a fault latch. It is a session-persistent "servos were off at
some point" flag.**

Everything §566 pinned as "the exact recovery signature" —
`{state:2, recoveryState:1, errors:[]}` — is the routine state
after any operator disable. The mode-ladder's Rung 1
(`recoveryState != 0 → power-cycle required`) was over-firing
on trivially normal conditions.

## Section 656: the DI16 modeSwitch smoking gun

With rs=1 clearly non-blocking, the actual `Robot/toAuto` failure
had a different cause. Wire evidence in the same acceptance run:

```
10:01:53  TX Robot/toAuto  → RX ty=Robot/toAuto db=null  (empty ACK, success shape)
10:01:53  TX Robot/toAuto  → RX ty=Robot/toAuto db=null  (again — echo)
10:01:54  RX RobotStatus → mode=1  (UNCHANGED)
10:01:57  TX Robot/toAuto  → RX ty=Robot/toAuto db=null  (empty ACK)
10:01:57  RX RobotStatus → mode=1  (UNCHANGED)
```

The firmware ACKs `Robot/toAuto` with an empty `db` — the same
success shape `Robot/switchOn` / `switchOff` receive when they
succeed — but the mode does not transition. Same shape,
different behavior.

Probed I/O via `IOManager/GetIOInfo + GetIOValue`:

```
DI 16  defaultName='modeSwitch'   name='modeSwitch'    forced=0   value=0
DI 17  defaultName='enableButton' name='enableButton'  forced=0   value=0
```

**`DI16` is factory-named `modeSwitch` and reads `0`** while
mode is `1 MANUAL`. The firmware silently no-ops `Robot/toAuto`
when this hardware DI is open. No wire remediation moves the
mode until `DI16 → 1`.

Currently no visible cabinet selector — likely a terminal
expecting a jumper OR wired to the pendant's mode-selector key.
Ruled out: (b) login/session — the v2.3 protocol has no auth
step (never captured); (c) different payload — the empty-db ACK
is the same success shape used by verbs that DO change state.

## Section 657: Rung 0 shipped — DI16 pre-check

`dashboard_server.py:7534` — new Rung 0 reads `STATE['io_live']`
(mirror populated by the driver's `IOManager/GetIOValue` poll,
refreshed ~every 500 ms) and, when `target == 'auto'` and
DI16 == 0, refuses immediately with:

```json
{
  "outcome": {
    "kind":        "mode_selector_manual",
    "reason_code": "hardware_mode_selector_manual",
    "reason":      "hardware mode-selector DI16 (factory name 'modeSwitch') reads 0 — firmware silently no-ops Robot/toAuto with this DI open.",
    "detail":      "Mode selector at the cabinet is in MANUAL — turn the physical selector to AUTO, then retry. No wire remediation clears this.",
    "di16":        {"port": 16, "value": 0, "name": "modeSwitch"},
    "four_tuple":  {mode, state_code, state_name, recoveryState, errors}
  }
}
```

Only fires for `target == 'auto'` — Manual is always reachable.
If the `io_live` mirror hasn't been populated yet (fresh boot
before first `/estun/io` publish), Rung 0 does NOT refuse — a
stale-mirror block would be exactly the "refusal quoting stale
data is a lie with good grammar" case the freshness doctrine
warns against. In that case, the orchestration attempts the
switch and any real refusal surfaces through later rungs.

`namedModeError` frontend mapper (`modeOutcome.js`) gains a
`mode_selector_manual` branch with the physical-action title
verbatim.

## Section 658: Rung 1 retired — recoveryState observation only

`dashboard_server.py:7527` — the `recovery_state_power_cycle_
required` block is **DELETED**. `recoveryState` is retained in
every outcome's `four_tuple` for observability; it never gates a
refusal on its own.

The real power-cycle-only condition is Rung 2's failure mode
(`errors_latched_uncleared`): errors\[\] non-empty AND
`System/ClearError` did not drain within 2 s. That IS an
uncleared fault where wire retry is futile. `recoveryState=1`
sitting alone with empty errors\[\] is not.

Frontend `modeOutcome.js` keeps `recovery_state_power_cycle_
required` as a mapped kind (backward-compat with older backends)
but its copy explicitly says "Legacy refusal — this backend
version is out-of-date" so an operator seeing it knows to update
the server, not cycle the cabinet.

## Section 659: blast-radius audit — what still references rs?

Sweep `grep -rn 'recoveryState\|_recovery_state' src/`:

- `estun_driver_node.py:774,4732-4738` — driver parses + stores
  rs from `RobotStatus.db.recoveryState` **[KEEP — observation]**
- `dashboard_server.py:2511` — dashboard subscribes to the field
  in `_on_estun_status` **[KEEP — observation]**
- `dashboard_server.py:6501,7527` — ladder Rung 1 + palletize
  quarantine comment **[REWRITTEN — this addendum]**
- `estun_driver_node.py:3730` — driver publishes rs in
  `/estun/status` snapshot **[KEEP — observation]**
- `modeOutcome.js` — the retired branch **[KEPT with
  legacy-marker copy]**
- Test suite — `test_operator_refusal_copy.py`,
  `test_provenance_doctrine.py` **[REWRITTEN — this addendum]**

No self-poisoning found: no code path both writes rs (via
disable) AND gates on rs==0 for the same operator action. The
mode-ladder's own disable step (Rung 3 orchestration) SETS
rs=1, but nothing downstream in the ladder read rs after that
point — the failure was purely in the never-should-have-existed
Rung 1 pre-check.

## Section 660: §644 palletize verdict — never a firmware latch

Re-read of §638-645 through the DI16 + session-rs lens:

**§640 wire trace (verbatim from the addendum):**
```
mode          = 1 (MANUAL)
state         = 2  stateName = 'Enabled'
recoveryState = 1
errors        = []
```

This is **the exact tuple every operator session reaches** after
any disable, minus a mode-switch verb accepting-but-not-
transitioning. The palletize save chain's next step after save
is `Robot/toAuto → project/run`. In the §640 environment:
1. Palletize save succeeded (`pushed_lua_sha12 == stored_lua_sha12`, all 4 HTTP saves 200-OK — §640 itself notes this).
2. Then `Robot/toAuto` was invoked. **DI16 = 0 at the time (unverified in §640 — the doctrine never checked; but consistent with the pattern).**
3. Firmware ACKed toAuto but did not transition mode.
4. Mode stuck at 1 → run refused with "mode did not transition."
5. Diagnostic ladder saw rs=1 (which was already 1 from an earlier disable, not from palletize) and misattributed the refusal to a firmware fault-latch.

**Verdict:** palletize NEVER latched anything at the firmware
level. The observed symptom was DI16=0 (hardware) + rs=1 (session
normal) stacked. Two things the pre-2026-08-31 diagnostic ladder
had NO instrumentation for.

**Corollaries:**
- The palletize quarantine (add-52 §646-654) stays ON as
  belt-and-braces per that directive, but the reason string
  updates: the real defect is the §644 offline finding
  (transit_over_slot IK-refuse + partial expansion in
  `program_ops.py:3882+`), NOT a firmware "recovery-state
  class." The `_QUARANTINE_REASON` in `dashboard_server.py:6514`
  now reflects this.
- Every physical cabinet cycle burned since §640 chasing "the
  palletize latch" was answering a question the wire was not
  asking. Number of cycles: unclear (operator's judgment); the
  time cost is real regardless.
- The ROS2 executor cutover (add-52) is still the right long-
  term fix — L222 pre-submit validation refuses the IK-fail
  composite before any dispatch — but the urgency framing
  "cabinet cycles compound" no longer applies. Palletize on
  legacy Lua will not brick the cabinet; it will refuse honestly
  once the ladder catches the codegen defect.

## Section 661: doctrine tests — pins for the reframe

- `test_mode_endpoint_has_di16_rung_zero` — Rung 0 present,
  gated on `target == 'auto'`, reads `STATE['io_live']`, emits
  `mode_selector_manual` + `hardware_mode_selector_manual`
  reason_code, names MANUAL/AUTO in copy.
- `test_mode_endpoint_does_not_gate_on_recovery_state_alone` —
  negative assertion: `"recovery_state_nonzero"` and
  `"recovery_state_power_cycle_required"` MUST NOT appear as
  emitted outcomes in the mode endpoint. `recoveryState` still
  appears in `four_tuple` (observability retained).
- `test_named_mode_error_selector_manual_names_physical_selector`
  — frontend copy names the physical selector + direction
  (MANUAL/AUTO), does NOT prescribe a power-cycle.
- `test_named_mode_error_retired_recovery_state_branch_is_marked_legacy`
  — retired branch's copy explicitly says "out-of-date" +
  cites `addendum-53` so operators know it's a legacy shape.
- Existing `test_mode_endpoint_dumps_four_tuple_on_terminal_failure`
  updated to count Rung 0 (DI16) instead of retired Rung 1.

## Section 662: operator retry (the standing sequence)

1. Cabinet mode selector → AUTO (find the hardware selector — key
   switch on pendant or wire jumper on cabinet DI-16 terminal).
2. Verify `DI16 = 1` via probe (I'll re-run `probe_io.py`).
3. MODE pill acceptance: MANUAL → AUTO → MANUAL, wire evidence
   green.
4. Test100 at 25 % (F2.7 first-run default; no artificial cap).
5. Run.

## Section 663: DI16 hunt RETIRED — 2026-08-31 add-54 follow-up

The §662 retry sequence above is superseded by the CC10-A
**software manual absorb** (same day, later). The manual
documents that general-purpose DIs (DI0–DI15) can be assigned
**function aliases** at `:9198 → Configuration → IO`, with
"Switch to Auto Mode" / "Switch to Manual Mode" being two of
the aliases available. A bound DI's **rising edge** fires the
alias action, effect is immediate (no Save, no restart).

Combined with the wire-proven `IOManager/SetIOForcedFlag` write
path, this means the driver can trigger mode transitions by
force-pulsing a bound spare DI — **entirely bypassing DI16**
and its unknown hardware routing.

Shipped in add-54 (same session):
- `ESTUN_MODE_VIA_DI` env on `roboai-estun` (default 0). When
  1, the driver's `_on_mode_command` replaces `Robot/toAuto`
  / `Robot/toManual` with a `SetIOForcedFlag` pulse on the
  bound DI (defaults DI6 / DI7, overridable). Envelope on
  `/estun/mode_status` carries `via='bound_di_<port>'`.
- Dashboard `/api/estun/mode` Rung 0 (DI16 pre-check)
  automatically SKIPS when `ESTUN_MODE_VIA_DI=1` is set on
  the environment.
- `/tmp/probe_mode_via_di.py` stages TEST A for operator
  execution once DI6/DI7 are bound in the factory UI.

**Retry sequence (superseding §662):**
1. Operator binds DI6/DI7 at `:9198` (login `codroidsafety`).
2. Run TEST A (`/tmp/probe_mode_via_di.py`). Expect mode
   `1→0` on DI6 pulse, `0→1` on DI7 pulse.
3. On pass: enable `ESTUN_MODE_VIA_DI=1` on roboai-estun.
4. MODE pill acceptance — same ladder, new trigger.
5. Test100 at 25 % → Run.
6. On fail (TEST A does not move mode): TEST B — labeled
   loopback DO_x→DI6 + DO_y→DI7, driver pulses `setDO`
   (L200-compliant labeled general-purpose I/O). Document
   before cutting any wire.

The DI16 modeSwitch input remains observation-only. If a
future firmware update or manual clarification wires the HC
modeSwitch input to a jack we can access, the direct-DI
path can be re-enabled by unsetting `ESTUN_MODE_VIA_DI`;
until then, DI16 is a reserved input we do not need to solve
for.

**Long-term:** the outstanding Patrick request for the Estun
"Remote Control Manual" + "Register Protocol Table" may
reveal a Modbus register path (an external PLC would drive
Run/Stop/Reset/mode via Modbus TCP registers, no factory-UI
configuration per install). If those registers exist and
work, the bound-DI path might retire in favor of Modbus for
shipped units.

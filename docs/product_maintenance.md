# Product Maintenance — backlog

_Owner: TBD. Scope: preventive-maintenance tasks a customer or
integrator would run on a shipped Synapse-enclosed cobot cell._

This is the backlog draft. Items marked **[BACKLOG]** are not
yet in a customer-facing maintenance manual; they land here so
they don't get forgotten when the product doc is authored.

## Monthly safety functional tests **[BACKLOG]**

_Added 2026-08-31 (add-53 absorb). Cadence: monthly, per site.
Owner: site safety officer / integrator. Log to the site's
maintenance record._

### 1. E-stop functional test

**Scope:** every e-stop button in the cell (cabinet-side +
enclosure-mounted + any pendant-mounted).

**Procedure:**
1. Arm enabled, in a safe pose (away from workspace edges).
2. Press each e-stop in turn. Verify: motion stops
   immediately, servo power drops (arm goes limp on brake),
   `RobotStatus.state=0`, `errors[]` populated with the
   corresponding e-stop code.
3. Release the e-stop. Verify: `System/ClearError` succeeds,
   arm re-enables, motion resumes on operator command.
4. Time from press to servo-power-drop MUST be ≤ 500 ms per
   ch3-4 Cat-1 spec (HARDWARE.md > Safety-relay I/O).

**Recording:** timestamp + operator + which e-stop was
pressed + measured stop time + any anomalies. If any e-stop
does not stop the arm, isolate the cell IMMEDIATELY.

### 2. Drag / freedrive functional test (flange DI18)

**Scope:** the flange aviation-plug `robotDrag` button.

**Procedure:**
1. Arm enabled, in MANUAL mode.
2. Hold the flange drag button. Verify: arm becomes
   back-drivable (gravity comp active), can be positioned
   by hand without alarm.
3. Release the button. Verify: arm locks in place, does not
   drift, no residual back-drive.
4. In AUTO mode, verify the drag button is IGNORED (drag is
   a Manual-mode-only affordance).

**Recording:** timestamp + operator + any hitching, alarm
codes, or unexpected back-drive when released.

### 3. Safety I/O functional test (both channels per pair)

**Scope:** every dual-channel safety input in use (protective
ch1-2 and e-stop ch3-4). This test exercises the
dual-channel discrepancy detection.

**Procedure per pair:**
1. Both channels closed (nominal safe). Arm enables + moves
   as expected.
2. Open channel A only, leave B closed. Verify: safety chain
   opens (motion stops, 24V drops, appropriate error code).
3. Re-close A. Verify: `System/ClearError` succeeds, arm
   re-enables.
4. Repeat opening channel B only. Same expected behavior.
5. Open BOTH simultaneously — nominal e-stop / interlock
   trip.

**Recording:** per pair, per channel, timestamp + measured
open-to-24V-drop time + any discrepancy-detection alarms.

### 4. Cabinet indicators sanity check

**Scope:** the mode light strip (HARDWARE.md > light-strip
mode indication).

**Procedure:**
1. Manual + enabled → verify BLUE.
2. Auto/Remote → verify GREEN.
3. Disabled → verify OFF / dim.

If the strip disagrees with wire state, escalate — the strip
is driven from the wire, so disagreement is either a wiring
fault or a firmware issue.

## Non-safety maintenance items (draft — capture but not
scoped yet)

- Air/vacuum filter inspection — cadence TBD (depends on
  end-effector duty cycle).
- Gripper jaw wear inspection — cadence TBD.
- Cable strain-relief inspection — quarterly starter.
- Log rotation / disk-space check — automated (disk-watchdog
  on the Jetson emits a banner < 2 GB free), but a manual
  eye on it monthly is worth doing.

## Not maintenance, but adjacent

- **Factory-short removal audit.** For any cabinet in the
  field, verify no factory shorts remain across safety input
  pairs. If any short is found intact on a customer site,
  that cabinet was shipped in violation of the integration
  gate (see `safety_relay_deck_slide4.md`). Photograph and
  escalate — this is a safety-critical field bulletin
  candidate.

## Handoff

When the customer-facing maintenance manual is authored, the
safety-functional-tests section above is the load-bearing
starter content. Everything else is placeholder — the tests
above are non-negotiable per any reasonable functional-
safety regime for a cobot.

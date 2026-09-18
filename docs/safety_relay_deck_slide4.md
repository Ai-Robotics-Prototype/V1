# Safety-relay deck — slide 4 CONFIRMED-BY-MANUAL update

_2026-08-31 manual absorb. This doc mirrors the slide-4 content
so the operator can paste it into the actual deck (Slides / PDF
lives elsewhere)._

## Prior slide-4 status

Slide 4 listed items as **TO CONFIRM (bench session)** —
speculative, awaiting hands-on verification.

## Now: CONFIRMED BY MANUAL §5.2.2

All previously TO-CONFIRM items are now **CONFIRMED-BY-MANUAL**
with the citations below. The bench session is **re-scoped**
away from "confirm-what-it-is" to **behavioral verification +
factory-short removal**.

| # | Prior TO-CONFIRM | Now CONFIRMED | Citation |
|---|------------------|---------------|----------|
| 1 | Number of safety inputs | **4 dual-channel inputs** | Estun CC10-A manual §5.2.2 |
| 2 | Channel assignment | **Ch1–2 = protective stop (guard/interlock)**; **Ch3–4 = emergency stop** | §5.2.2 |
| 3 | External safety relays required? | **NO — internal safety relays** in the CC10-A block drive redundant contacts | §5.2.2 |
| 4 | E-stop category | **Category-1** (controlled stop → power removal) | §5.2.2 |
| 5 | Servo power removal path on safety trip | **24V drop output** to servo enable circuit; hardware path independent of the WS `Robot/switchOff` verb | §5.2.2 |
| 6 | Cabinet ships open-safety or closed-safety? | **Ships with factory shorts across all safety-input pairs** — cabinet runs out of the box with no external safety wired | §5.2.2 |

## Re-scoped bench session

**Deliverables (both required):**

### A) Behavioral verification of the safety chain

For each input pair (protective + e-stop), verify:

1. **Factory-shorted state (baseline).** With shorts in place,
   confirm arm enables, jog works, program runs. Note the 24V
   rail state (present).
2. **Short removed, unconnected.** Open the pair. Confirm the
   arm refuses enable OR drops to disabled if enabled at open
   moment. Confirm the 24V drop output fires.
3. **Short removed, connected to external device.** Wire an
   external safety-rated switch to the pair. Verify closed →
   safe, open → stop. Both channels must be exercised for
   dual-channel discrepancy detection.

**Recording:** wire captures on `/estun/status` +
`journalctl -u roboai-estun` timestamps for every transition;
`RobotStatus.errors[]` content on each event; time from
open-event to 24V drop.

### B) Factory-short removal plan

**Rule:** no Synapse enclosure ships with any factory short in
place. This is a hard gate on customer-facing units.

Removal procedure (draft — refine on-bench):
1. Cabinet POWERED DOWN via the POWER KEY (see HARDWARE.md >
   Cabinet power controls). Rocker off alone is insufficient
   for terminal-block access.
2. Photograph the safety-input terminal block BEFORE any
   change — one still to attach to the integration file.
3. Remove factory jumper wires from ch1-2 and ch3-4 pairs.
4. Wire ch3-4 to the external e-stop (customer-supplied or
   Synapse-panel-supplied) — verify polarity + dual-channel
   independence.
5. Wire ch1-2 to the guard/interlock chain (door switches,
   light curtains, presence sensors — per site risk
   assessment).
6. Power back on via POWER KEY. Verify new `Connected ws`
   line in `journalctl -u roboai-estun` (confirms real CPU
   reboot, not just rocker cycle).
7. Run behavioral verification (A) end-to-end before releasing
   the cabinet for integration.

**Sign-off:** the person who removed the shorts photographs
the empty terminal block AFTER removal and attaches to the
integration file. No verbal sign-off; the two photos (before
+ after) are the evidence.

## Cross-references

- Wire truth for cabinet power: `HARDWARE.md` > "Cabinet power
  controls — ON/OFF rocker vs POWER key"
- Reserved-DI provenance (why DI16 is NOT jumper-able):
  `HARDWARE.md` > "I/O vocabulary" > DI16/17/18 block
- Ladder Rung 0 (DI16 hardware gate): `dashboard_server.py:7534`,
  addendum-53 §657
- Monthly maintenance backlog:
  `docs/product_maintenance.md` (see safety functional tests
  section)

## Handoff to the deck

Copy the "CONFIRMED BY MANUAL §5.2.2" table + the "Re-scoped
bench session" section into slide 4. Delete the old
TO-CONFIRM bullets. Cite manual §5.2.2 in the slide footer.

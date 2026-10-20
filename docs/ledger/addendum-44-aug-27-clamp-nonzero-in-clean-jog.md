---
slug: aug-27-clamp-nonzero-in-clean-jog
number: 44
date: 2026-08-27
source: session
title: Clamp counter 196 during a clean 5 % × 0.5 s small bite — RT-safety-net is being tapped in normal operation; class named + escalated
---

*(Follow-on to addendum-43. After the controller power-cycle cleared
`recoveryState=1` (addendum-42 §580), a fresh launch on `8944a4c`
brought the acceptance stack up cleanly. Small bite J6+ 5 % × 0.5 s
moved the arm exactly to command (Δ = +1.97 ° cmd vs. +1.97 ° actual)
with zero alarms, zero flicker, guard silent. But the plugin's per-
cycle acceleration clamp fired **196 times** during the ~1 s session
— violating the operator's acceptance criterion "clamp counter and
divergence_halts both must be 0 in normal operation." STOPPED per
operator directive; escalating to the WS-fallback discussion with
this evidence in hand.)*

## Section 591: Small-bite verdict — arm perfect, clamp counter nonzero

Bag `evidence/2026-08-27_accept/small_bite/`:

| metric | value |
|---|---|
| cmd Δ                          | +1.9707 ° |
| **actual arm Δ**               | **+1.9727 °** (identical to cmd) |
| max Δref/tick                  | **0.0360 °** = 5 % × π × dt (spec exactly) |
| \|cmd-fb\| SS median          | **0.0000 °** (perfect tracking) |
| max \|cmd-fb\|                | +1.41 ° (well under 10 ° threshold) |
| errors[]                       | [] |
| **divergence_halts**           | **0** ✓ |
| JS max Δt                      | 37.9 ms (no comm loss) |
| adapter events                 | START → STOP clean |
| **accel_clamp engagements**    | **196** ✗ over the ~1 s session |

Boot lines confirmed the stack:

    [CriUdpSystem] CRI UDP bind :10086 -> 192.168.2.136:9030
      max_step_rad=0.0050 max_err_vs_fb_rad=0.5000 hold_far=0.1500
      max_accel_step_rad=0.00032 (0=disabled)
    [jog_servo_adapter] ║   plugin_max_slew_rate    = 1.250 rad/s [from cri_tcp_setup.yaml]
    [jog_servo_adapter] ║   velocity_ceiling        = 1.000 rad/s [80% of plugin ceiling]

Pre-flight gates all PASS: WS four-tuple `{state:2, stateName:'Enabled',
recoveryState:0, errors:[]}`, dashboard 1 IP, 30 s idle-monitor 0 events.

## Section 592: Jitter fingerprint from the bag

Same class as addendum-42 §577 — Python-timer jitter — still present
even at 5 %:

| stat | value |
|---|---|
| cmd msgs                       | 1315 (186 Hz mean) |
| median inter-msg dt            | **4.10 ms** (matches design 250 Hz) |
| p90 inter-msg dt               | 8.12 ms |
| **p99 inter-msg dt**           | **18.54 ms** |
| max inter-msg dt               | **28.13 ms** |
| msgs within <1 ms of prior msg | **34 of 692** (jitter bursts, ~4.9 %) |

The plugin's RT-side clamp caught each of those 34 bursts (plus other
adjacent-step accel violations) and shaped the setpoint stream into a
firmware-safe form. Adapter's OWN accel-ramp at 12 rad/s² is honestly-
honored on a per-tick basis, but the timer's stalls (up to 28 ms) →
2 - 4 msgs bursted → 2 - 4 × the intended Δref → 2 - 4 × the intended
Δv/cycle when read at the plugin's write() cycle. That's the class
the RT-clamp exists for; it fired 196 times to keep this session
alive.

## Section 593: The acceptance-criterion violation

Operator's stack directive (addendum-43 §589): "Every jog session's
clamp counter and divergence_halts reported — both must be 0 in
normal operation. If ANY flicker or alarm survives this stack,
capture the bag and STOP — that's a new class and we escalate to the
WS-fallback discussion with evidence in hand."

Read strictly, this session is a **PASS** on flicker (no oscillation)
and alarms (no 2015), but a **FAIL** on the observability criterion
("clamp counter must be 0"). No hardware harm occurred: the arm moved
exactly to command, tracking error 0.000 ° at steady state, and the
plugin clamp intervening 196 times is what kept the arm safe from the
firmware's per-cycle Δv ceiling.

The clamp is doing its intended job. But its firing during a nominally
clean run confirms the Python-timer jitter has NOT been eliminated —
it has been safely absorbed by the RT-side backstop. The upstream
Python control loop is fundamentally not RT-capable on this Jetson (or,
at minimum, not without dedicated `SCHED_FIFO` priority, tickless-CPU
isolation, and a pinned event-loop budget).

Two response classes are on the table:

1. **Accept the clamp as the operational safety net.** Redefine
   "normal operation" to allow the clamp doing its job; report
   engagement counts per session; treat divergence_halts and
   publish/Error as the real fail signals; treat clamp-engagement
   rate as a monitor-only metric that would trigger investigation
   only if it grew over time.
2. **Escalate to a WS-fallback (Estun native) jog path.** The
   controller's own :9000 WS interface has a jog API used by the
   factory UI on :9198; that path bypasses the Python-timer entirely
   and runs at the controller's native RT rate. Addendum-43 §587's
   CRI :9001 enumeration found NO native jog verb on the CRI protocol
   itself, but the WS :9000 protocol (already used by the dashboard
   for RobotStatus + Error probes) is the other authenticated
   surface and is known to carry jog primitives at the factory UI.

Per operator directive, this session STOPS and escalates. Class name:
"upstream Python-timer jitter absorbed by RT-side backstop — the
backstop works, but the upstream cannot be trusted RT-clean."

## Section 594: What the small bite proved

- **The plugin per-cycle accel clamp (addendum-42 §578) is correct
  and effective.** Without it, this run would very likely have tripped
  2015 the way the 24 % jog did on the same code path minus the clamp.
- **The adapter velocity ceiling (addendum-43 §584) is honored:**
  1.0 rad/s cap enforced from launch config; adapter never commanded
  above it (banner confirmed at boot, bag Δref/tick at 5 % well under
  the ceiling).
- **The guard-readopt blacklist (addendum-43 §585) is silent under
  clean operation** — 0 READOPT-REJECT events, exactly as designed
  (nothing halted, so nothing to block).
- **`divergence_halts = 0`** — the divergence threshold's 10 ° margin
  + the velocity ceiling's 0.8 × plugin_slew both closed the flicker
  class from addendum-41 §571.
- **The Python-timer jitter class is NOT closed.** 34 sub-1-ms msg-
  bursts out of 692 inter-msg intervals proves the adapter's own
  publish cadence is not RT-clean. The plugin's RT-clamp absorbs it
  every time, but the class remains upstream.

## Section 595: Escalation options — WS-fallback jog

The escalation is to the `:9000` WS interface. It:

- Already carries `publish/RobotStatus` and `publish/Error` used
  in the four-tuple gate.
- Is what the factory UI on `:9198` uses (browser-side jog is
  known to work at that surface).
- Bypasses the Python-timer entirely — jog primitives execute in
  the controller's own real-time loop.

The tradeoff: it requires implementing a controller-side jog client
in a language and QoS that matches the WS surface, and it discards
the ROS2 topology's testability and integration with move_group.
Investigation cost: a full grep of the browser-UI JS bundle at
:9198 for jog verb usage + a WS probe session to enumerate the
`jog/*` and `manual/*` verbs on :9000 (contrast with :9001 CRI
which we already know has none — addendum-43 §587).

## Section 596: Shipped commits, this session

`theodoresimpson/CodroidROS2:main`: no new commits (`8944a4c`
baseline unchanged — the pre-flight code and clamp stack shipped in
prior addenda are what enabled this diagnosis).

Ledger + reference-tier patch commits in this same session's ledger
push.

## Section 597: What to try next

1. **Grep the :9198 browser UI bundle for jog verbs** — that gives
   us the actual WS jog primitives without probing blind. Read only;
   no arm motion.
2. **Compare-and-contrast: the WS-jog path vs. the current
   CRI-UDP-setpoint path.** Class attributes: RT-cleanliness,
   testability, ROS2 topology integration, safety-net requirements.
3. **If WS-jog is adopted:** design a minimum-viable adapter that
   translates `/dashboard/jog_session_events` to WS jog verbs,
   preserving the existing dashboard UX. `jog_servo_adapter`
   remains the ROS2 planning-integration path for `move_group`-
   compatible motion; the WS path is jog-only.
4. **If the current stack is retained:** commit to the "clamp is
   the safety net" reading and add a clamp-engagement-rate SLO
   (target: <5 % of ticks) as the observability criterion, not <1.

## Summary (2026-08-27)

Small bite J6+ 5 % × 0.5 s on `8944a4c`: **arm moved exactly to
command with zero alarm, zero flicker, zero divergence** — but the
RT-side plugin clamp fired 196 times, violating the operator's
acceptance criterion "clamp counter must be 0 in normal operation."
The class named (§593): Python-timer jitter absorbed by the RT-side
backstop; the backstop works, but the upstream is not RT-capable and
therefore cannot be trusted RT-clean. Two response classes on the
table (§593): accept the clamp as the operational safety net and
redefine the SLO, or escalate to a WS-fallback jog path via
`:9000`. Per operator directive, this session STOPS + escalates.

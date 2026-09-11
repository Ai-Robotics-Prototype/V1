---
slug: aug-26-plugin-accel-clamp-trip
number: 42
date: 2026-08-26
source: session
title: Alarm 2015 trip at 24 % — bursty adapter delivery diagnosed, plugin-side per-cycle accel clamp shipped, adapter interim 18 → 12
---

*(Follow-on to addendum-41. The `af24198` divergence-threshold bump
(5 ° → 10 °) closed the flicker at 22 %, and the operator resumed real-
arm testing at higher wire speeds. At speed_pct 24 % on hold
`j8t5vcij3v`, alarm 2015 tripped again — but this time NOT from a
snap-guard or a phantom-hold. This addendum names the mechanism as
`clamp_accel_step` bypass under upstream Python-timer jitter, ships
the RT-side plugin clamp that eliminates the class, and drops the
adapter accel to 12 rad/s² as a belt-and-suspenders interim.)*

## Section 576: The trip event — 25.5 rad/s² Δv at the wire

WS `:9000/publish/Error` frame reported by the operator:

    Joint6 speed command jump or local acceleration too high:
        0.247 → 0.349 (rad/s)

  Δv/cycle = 0.102 rad/s.  At the plugin's 4 ms cycle that's
  25.5 rad/s² — 1.42 × the adapter's design step of 0.072 rad/s
  (18 rad/s² × dt) and just over the CC10-A's ~25 rad/s² ceiling.

Adapter log around the trip:

    17:23:12.204  START hold=j8t5vcij3v joint=6 dir=+1 speed_pct=24.0
    17:23:12.463  DIVERGENCE hold=j8t5vcij3v |cmd-fb|=10.117° > 10.03°
                  → entering SETTLING

WS RobotStatus after: `state=0 stateName='Disabled' recoveryState=1`.

## Section 577: Diagnosis — bursty adapter delivery, not saturation or clamp boundary

The user proposed two hypotheses:

**(a) Bursty adapter delivery** — two Python-timer ticks landing inside
one plugin write() cycle so the plugin's next write sees a
multi-tick position delta as a single cmd_pos_ update.

**(b) `clamp_step` engage/release boundary** — commanded velocity
near `max_step_rad / dt` (1.25 rad/s at 250 Hz), plugin's clamp state
transitioning.

Analysis of `evidence/2026-08-26_F1_close/flicker_diag/` (same 22 %
regime, same code path — the trip session itself wasn't bagged):

| stat | value | notes |
|:---|---:|---|
| inter-msg dt median | 3.96 ms | matches 250 Hz design |
| inter-msg dt p90 | 7.60 ms | mild jitter |
| inter-msg dt p99 | 14.97 ms | notable jitter |
| inter-msg dt max | **60.16 ms** | pathological stall |
| msgs within <1 ms of prior msg | **92** | bursts across a 5.8 s window |
| peak Δv between adjacent msg-pairs | **9.6 rad/s** | 2400 rad/s² equivalent |
| peak Δv in 2-msg sliding window | 9.59 rad/s | firmware-averaging still trips |

Hypothesis (a) **CONFIRMED**. Hypothesis (b) ruled out — commanded
velocity at 24 % was 0.754 rad/s, far below the 1.25 rad/s
`max_step_rad` ceiling; the plugin's clamp was never engaged.

Mechanism: Python 250 Hz timer intermittently stalls (worst observed
60 ms), then bursts 2-4 msgs within <1 ms. The position controller
stores the LATEST message per plugin write() cycle in the command
interface. When a burst lands, the plugin's next write() sees a
multi-tick position delta as a single `pos_cmd_` update. Neither
`clamp_step` (per-cycle position slew, correct for firmware velocity
ceiling but 1.25 rad/s allows single-cycle Δv far above the accel
ceiling) nor the upstream `jog_servo_adapter`'s accel-ramp (which
assumes honest per-tick delivery that jitter violates) closes this
seam.

## Section 578: Durable fix — RT-side per-cycle acceleration clamp

`CriUdpSystem::clamp_accel_step`:

```
prev_step   = pos_cmd_sent_[i]   - pos_cmd_prev_sent_[i]
this_step   = cmd[i]             - pos_cmd_sent_[i]
clamped     = clamp(this_step, prev_step ± max_accel_step_rad)
cmd[i]      = pos_cmd_sent_[i] + clamped
```

Enforced in `write()` after `clamp_step`, at the RT rate. New state
field `pos_cmd_prev_sent_` seeded from feedback in
`sync_commands_to_feedback()` (so the first sent cycle's step is 0,
not some latched value). Xacro param `max_accel_step_rad:=0.00032`
threaded through `s10_140_cri.ros2_control.xacro`. Default 0.00032 =
20 rad/s² × (1/250 Hz)² — margin under CC10-A's 25 rad/s² ceiling.
`max_accel_step_rad=0` disables the clamp for A/B testing.

Standalone unit test at
`src/cod_cri_hardware/test/test_clamp_accel_step.cpp` — 10 cases, all
PASS. Cases cover: at-rest no-op; steady-vel pass-through; accel-
within-limit pass-through; forward burst; decel burst; reversal;
disabled (limit=0 and limit<0); per-joint independence; negative-
velocity regime with burst decel. Compiles as a standalone `g++ -std=
c++17` binary — no ROS deps — so the clamp math is testable without
the plugin lifecycle.

## Section 579: Interim — jog_servo_adapter `max_accel_rad_s2` 18 → 12

Belt-and-suspenders for the interval where the plugin clamp is unproven
on hardware:

- `max_accel_rad_s2` 18 → 12 in both adapter default and launch param.
- 12 rad/s² × 1.4-jitter = 16.8 rad/s² per cycle — comfortably under
  25.
- Revisit to 18 or higher after the plugin clamp is verified on the
  real arm (the plugin clamp is the durable enforcement; adapter's
  ramp is now a soft-hint upstream).

## Section 580: Recovery gate — power-cycle required

WS `:9000/publish/RobotStatus` after the trip: `state=0`,
`stateName='Disabled'`, `recoveryState=1`. Applied wire-only
`System/ClearError + Robot/switchOn`; result: `state=2` but
`recoveryState=1` PERSISTS. Per addendum-40 §566, physical controller
power-cycle is the only path that clears `recoveryState=1 → 0`.
No hardware action taken from this session beyond that probe;
retest deferred.

## Section 581: Shipped commits, this session

`theodoresimpson/CodroidROS2:main`:

| SHA | Message |
|-----|---|
| `c66c8f0` | cri_udp_system: per-cycle accel clamp (durable fix for alarm 2015 under upstream jitter) + adapter interim 18→12 rad/s² |

Reference-tier + LESSONS + STATE patches land on
`Ai-Robotics-Prototype/V1:feature/estun-write-path` in this same
session's next commit.

## Section 582: What to try next

1. **Power-cycle recovery** → re-verify four-tuple
   `{state:2, stateName:'Enabled', recoveryState:0, errors:[]}`.
2. **Retest at the SAME speed that tripped** — speed_pct 24 % —
   watching `publish/Error` inline. With `max_accel_step_rad=0.00032`
   enforced at the RT rate AND adapter's ramp at 12 rad/s², the wire
   Δv/cycle CANNOT exceed 20 rad/s² regardless of upstream jitter.
   Pass = no 2015 frame across the whole hold. If pass, revisit
   adapter's `max_accel_rad_s2` upward toward 18.
3. **A/B — plugin clamp disabled** at a known-safe speed (5 %) as a
   regression sanity: confirm the clamp is not itself adding
   overhead / stutter when unnecessary.
4. **Dashboard 15 %→22 UI bug** (addendum-40 §565) still unresolved;
   the plugin clamp defangs the wire-side symptom but the UI-to-wire
   mismatch remains. Belongs to a dashboard session.

## Summary (2026-08-26 late)

L271's "wire-side acceleration invariant" was previously enforced
only in the upstream adapter, and that layer's Python-timer jitter
occasionally bursted 2-4 ramp-steps into a single plugin cycle,
passing the accumulated Δv straight to firmware where it tripped
2015. The class fix ships as a per-cycle clamp inside
`CriUdpSystem::clamp_accel_step`, enforced at the RT rate — upstream
jitter is now irrelevant. Adapter's `max_accel_rad_s2` lowered 18 →
12 as belt-and-suspenders. 10-case unit test PASS. Hardware retest
gated on physical power-cycle (`recoveryState=1` persists after wire
recovery).

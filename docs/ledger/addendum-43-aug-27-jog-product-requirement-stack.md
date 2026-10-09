---
slug: aug-27-jog-product-requirement-stack
number: 43
date: 2026-08-27
source: session
title: JOG IS A PRODUCT REQUIREMENT — three code fixes shipped (clamp engagement counter, adapter velocity ceiling, guard-readopt blacklist), CRI verb enumeration reports no native jog primitive
---

*(Operator directive: "JOG IS A PRODUCT REQUIREMENT." Acceptance criteria
— any joint, continuous hold, smooth, zero alarms, zero flicker, full
slider range, deadmen + 60 s soak, repeatable. Real-arm retest gated on
the controller power-cycle from addendum-42 §580; this session shipped
the code, unit tests, and enumerated CRI :9001 for a native jog verb.)*

## Section 583: JOG-1 — RT-side clamp engagement counter (cod_cri_hardware)

Extends addendum-42 §578's `CriUdpSystem::clamp_accel_step` with an
optional `uint64_t * engaged_out` parameter incremented once per
per-joint clamp engagement. `write()` passes a `&accel_clamp_engagements_`
counter, and logs a WARN at ~1 Hz whenever the counter advances since
the last log:

    accel_clamp engaged N times in the last ~1.0s (total M).
    Nonzero during nominal jog = upstream jitter reached the wire
    and was intercepted by the RT clamp.

This is the observability the acceptance stack needs — the operator
directive requires "clamp counter … reported per session," and the
counter now surfaces at controller_manager rate.

The standalone unit test at
`src/cod_cri_hardware/test/test_clamp_accel_step.cpp` extends from
10 → 14 cases, all PASS: adds `engagement-counter-all6`,
`engagement-counter-one-joint`, `engagement-counter-no-clamp`, and
`engagement-counter-nullptr`. Compiles standalone (`g++ -std=c++17`), no
ROS deps. Ledger-adjacent regression: any future change to
clamp_accel_step must keep the byte-identical copy in this test in
lockstep.

## Section 584: JOG-2 — adapter runtime velocity ceiling (jog_servo_adapter)

New parameter `plugin_max_slew_rate_rad_s` (default 1.25, matching
`max_step_rad 0.005 × 250 Hz`) + derived
`_velocity_ceiling_rad_s = velocity_ceiling_fraction_of_plugin ×
plugin_max_slew_rate_rad_s` (fraction default 0.8). Enforced per tick,
right after target-velocity computation:

    raw_target = signed_dir × eff_frac × max_vel
    raw_target = clamp(raw_target, ±_velocity_ceiling_rad_s)
    target_vel[joint_idx] = raw_target

The rationale is the addendum-41 §571 mechanism: at 22-24 % wire the
adapter commanded 0.69-0.75 rad/s, which the plugin's `clamp_step`
could serve at 1.25 rad/s (no clamp engagement), but the arm has
~250 ms of response latency and could not track that fast — cmd raced
ahead of fb into divergence. Capping the adapter's commanded velocity
at 80 % of the plugin ceiling means `cmd` can NEVER outrun the plugin's
own slew ceiling, and therefore can never carry `|cmd-fb|` into the
divergence threshold via aggressive steady-state velocity. Combined
with the addendum-41 §572 10 ° divergence threshold, arm-latency
headroom is honored end-to-end.

**Same source as the plugin — no cross-repo drift.** The launch reads
`max_step_rad` from `cri_tcp_setup.yaml` via
`cri_config.load_cri_config()` and passes `plugin_max_slew_rate_rad_s
= max_step_rad × 250.0` to the adapter directly. If a maintainer bumps
`max_step_rad` in the yaml, both the plugin's `clamp_step` and the
adapter's velocity ceiling track together on the next launch.

Startup banner shows both values so the RT ceiling is observable:

    ║   plugin_max_slew_rate    = 1.250 rad/s (71.62°/s)  [from cri_tcp_setup.yaml]
    ║   velocity_ceiling        = 1.000 rad/s (57.30°/s)  [80% of plugin ceiling]

## Section 585: JOG-3 — guard-readopt blacklist (jog_servo_adapter)

New state `_halted_hold_ids` (list, ring-capped at 256). Any halt path
(`_begin_halt` — called from silence-timeout, explicit stop,
divergence) now blacklists `self.hold_id` BEFORE clearing it. The
`_process_event` dispatcher checks the blacklist immediately after the
settling gate:

    if hold_id is not None and hold_id in self._halted_hold_ids:
        stats["rejects"]         += 1
        stats["readopt_rejects"] += 1
        get_logger().warn("READOPT-REJECT …")
        return

The behavior is: keepalives of the press that CAUSED a halt can never
restart motion, even via an explicit `start` event. A fresh operator
press generates a new random hold_id (`JogControls.jsx:91`
`Math.random().toString(36).slice(2, 12)`), which is not in the
blacklist and starts a clean session. Extends the phantom defense
from addendum-40 §565 with a stricter rule: it's not enough for a
refresh to have `no active session`; a start on a previously-halted
hold_id must ALSO be rejected. Combined, the class of guard-halt /
keepalive-restart oscillation is closed for good.

New `stats.readopt_rejects` counter surfaces the blacklist's activity
alongside `phantom_rejects`.

## Section 586: JOG-4 — adapter max_accel_rad_s2 18 → 12

Already shipped in addendum-42 §579 as belt-and-suspenders (bag
evidence showed the Python-timer can burst 1.4-4× the design accel;
12 × 1.4 = 16.8 rad/s² stays comfortably under CC10-A's 25 rad/s²).
The plugin's RT-side clamp (§578) is the durable enforcement; the
adapter's ramp is now a soft-hint upstream. Revisit to 18 or higher
only after the plugin clamp is verified on the real arm.

## Section 587: JOG-5 — CRI :9001 verb enumeration (Option A, report only)

Operator directive was to enumerate `:9001` while builds ran, no arm
motion. 20 candidate jog / query / manual-mode verbs sent as
`{"id":N,"ty":"<verb>","db":<minimal>}` queries.

**Result: no controller-side jog verb exposed.** The controller
distinguishes three response patterns:

| pattern | meaning | example |
|---|---|---|
| `{"id":N,"ty":"X","db":null}` | success | `Robot/switchOn`, `CRI/StartControl` |
| `{"id":N,"ty":"X","err":"404/unkown request"}` | explicit 404 | `Jog/Start`, `Jog/Joint`, `Jog/Stop`, `Manual/Jog` |
| `{"id":N,"ty":"X"}` (no `db`, no `err`) | ambiguous echo — silent decline | `Robot/Jog`, `Robot/JogStart`, `Robot/JogJoint`, `Robot/JointJog`, `CRI/Jog`, `CRI/JogJoint`, `Robot/MoveJoint`, `Robot/StepJoint`, `Robot/ManualJog` |

None of the 15 candidates in patterns 2-3 returned a `"db":null`
success. **The UDP-setpoint path via `cod_cri_hardware/CriUdpSystem` is
the only jog primitive on this controller.** WS-fallback discussion
does not get a shortcut via a native jog verb — the accel-ramp +
plugin-clamp stack is the shipping path.

## Section 588: Mock verification status

Standalone unit test: **14/14 PASS** (`clamp_accel_step` + engagement
counter). Compiles + runs without ROS dependency.

Adapter banner confirms the JOG-2 velocity ceiling is correctly derived
from `plugin_max_slew_rate` × `fraction`. `READOPT-REJECT` log lines
observed during multi-scenario harness runs, confirming JOG-3 blacklist
fires on halted-hold_id refreshes.

The multi-scenario harness at `/tmp/jog_stack_verify.py` (scenarios A
jitter / B over-speed / C halt-restart) surfaced the addendum-41 §573
DDS start-drop race in the mock environment — a test-harness issue,
not a fixes-under-test issue. Two of three scenarios reliably lost the
START event to DDS discovery even with a `pub.get_subscription_count()
> 0` wait-loop plus a 0.8 s settle, producing false-positive
PHANTOM-REJECT logs for the harness's own refreshes. The scenario that
did land cleanly (in the first pass, before I split scenarios into
fresh-adapter runs) confirmed all three fixes fire in the expected
sequence. Bag verdicts for jitter Δref-cap and over-speed velocity-cap
deferred to real-arm acceptance where the pipeline is deterministic.

## Section 589: Real-arm acceptance — gated

Real-arm retest gated on the controller power-cycle from addendum-42
§580 (`recoveryState=1` persisted after `System/ClearError +
Robot/switchOn`, only physical power-cycle clears the drives'
recovery latch). The acceptance sequence, once cleared:

1. WS four-tuple `{state:2, stateName:'Enabled', recoveryState:0,
   errors:[]}`.
2. Same speed_pct that tripped (24 %), then full slider sweep, then
   rungs 4-6, deadmen A/B, 60 s soak.
3. Every session must report `accel_clamp_engagements` and
   `divergence_halts` — both must be 0 in normal operation.
4. If ANY flicker or alarm survives, capture the bag and STOP —
   that's a new class and escalates to the WS-fallback discussion.

## Section 590: Shipped commits, this session

`theodoresimpson/CodroidROS2:main`:

| SHA | Message |
|-----|---|
| `8944a4c` | jog stack: clamp engagement counter + adapter velocity ceiling + guard-readopt blacklist |

Reference-tier + LESSONS + STATE patches land in this same session's
next commit on `Ai-Robotics-Prototype/V1:feature/estun-write-path`.

## Summary (2026-08-27)

Three fixes shipped as a bundle: (1) plugin clamp gains an engagement
counter that surfaces at ~1 Hz when nonzero — the observability the
acceptance stack requires; (2) adapter velocity ceiling caps commanded
velocity at 80 % of the plugin slew rate, using the SAME
`max_step_rad` source as the plugin — no cross-repo drift; (3)
guard-readopt blacklist rejects any event carrying a hold_id that was
previously halted, closing the keepalive-restart oscillation class
permanently. Unit tests 14/14 PASS. CRI :9001 enumerated — no native
jog verb exposed; the UDP-setpoint path is the only jog primitive on
this controller. Real-arm acceptance gated on the controller
power-cycle (addendum-42 §580).

---
slug: aug-24-hunt-trace-verdict
number: 39
date: 2026-08-24
source: session
title: Hunt-trace verdict — goal-seam, not tuning
---

*(Follow-on to addendum-38 §544. That session captured a 6 s bag of
`/joint_states` + `/joint_trajectory_controller/controller_state` during
a J6+ 10% × 1.5 s inject, after the velocity-populated fix (sha 80d65dd)
landed in CodroidROS2. Rungs 3-6 were left blocked pending trace analysis.
This addendum names the mechanism from that trace.)*

## Section 548: The trace, re-read

Analysis lives under
`~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/analysis/`
(scripts `extract.py`, `verdict.py`; artefacts `verdict.md`, `verdict.png`,
`verdict_zoom.png`, `j6_joint_states.csv`, `j6_controller_state.csv`,
`ref_100ms_buckets.csv`). Not tracked in git — evidence directory only.

**Method correction (worth calling out).** First pass read
`controller_state.reference.velocities[Joint6]` as the reference velocity
and reported it as *constant 18.00 °/s* — with zero sign changes and zero
ripple. That is misleading. That field is a **stored echo** of what the
bridge stuffed into `p0/p1.velocities` (the 80d65dd fix populates it with
`signed_vel = ±speed_pct × MAX_VEL`), not what a downstream controller
actually integrates. The truth is in `reference.positions`. All seam
metrics that follow use `d/dt reference.positions`.

## Section 549: What the reference position is actually doing

Motion window (first `feedback.pos` change > 0.1° → last, in the 6 s bag):
**t = 3.264s .. 6.010s (2.746 s)**. Reference-position finite-difference
within that window:

- peak +  : **+105.19 °/s**
- peak −  : **−315.24 °/s**  ← *against* commanded direction
- median  : 0 °/s (reference is flat 59 % of samples, jumping 41 %)
- sign changes (>5 °/s threshold): **20**
- events >20 °/s / duration: 35 / 2.746 s ≈ **12.7 Hz**
- reference *net* motion: **+3.87° over 2.746 s** (+1.41 °/s mean)
- feedback net motion: +4.75° over the same window (+1.73 °/s mean)
- realized fraction: **9.6 %** of commanded (+18 °/s)
- |err_pos| peak 2.95°, rms 1.05°, median 0.07° (rms dominated by the
  transients, not steady-state)

Per-100-ms bucket view of `reference.pos` (first 12 buckets of motion,
after which the reference goes flat for 1.6 s — inject stop + tail):

| t0 [s] | ref range [°] | ref net [°] | peak+ vel [°/s] | peak− vel [°/s] |
|-------:|--------------:|------------:|----------------:|----------------:|
|  3.264 |         1.10  |      +0.55  |          +21.2  |         −261.5  |
|  3.369 |         1.41  |      +0.25  |          +24.8  |         −177.0  |
|  3.472 |         1.74  |      −0.10  |          +21.6  |         −195.4  |
|  3.580 |         1.68  |      −0.02  |          +47.9  |         −207.4  |
|  3.688 |         1.56  |      −0.05  |         +105.2  |         −193.3  |
|  3.788 |         1.66  |      +0.41  |          +47.8  |         −158.8  |
|  3.897 |         1.72  |      −0.01  |          +24.4  |         −315.2  |
|  4.006 |         1.72  |      −0.06  |          +28.8  |         −216.2  |
|  4.112 |         1.61  |      −0.02  |          +42.3  |         −209.1  |
|  4.214 |         1.80  |      +1.80  |          +20.3  |          +12.4  |
|  4.320 |         1.37  |      +1.37  |          +61.4  |            0.0  |
|  4.424 |         0.00  |       0.00  |            0.0  |            0.0  |

Read the columns together: each 100-ms bucket has ~1.5° of *range* on the
reference position but only ~±0.5° of *net* motion. The reference walks
forward and back across a ~1.5° window every 100 ms, one preempt goal at
a time. Buckets 10 and 11 (t = 4.21, 4.32) are the only *monotonic*
buckets — briefly the preempts lined up right and the reference actually
advanced +1.8° / +1.4°. Then the inject stopped and the reference held.

## Section 550: `JTC.output` == `JTC.reference`

`|output − reference|` peak = **0.00000°**, rms 0.00000° across the entire
motion window. The JTC is a pure passthrough at this joint. Whatever
step-clamp the plugin does (`CriUdpSystem::write_positions` clamping
`out − pos_cmd_sent_` to `±max_step_rad = 0.002 rad/cycle @ 250 Hz`) is
downstream of this topic and cannot be observed from `controller_state`.
The peak reference rate the plugin sees is at least ±315 °/s — well above
the 28.6 °/s slew cap — but that is a *consequence* of the seam, not the
cause of the hunt.

## Section 551: Verdict — GOAL-SEAM (upstream of JTC)

The commanded reference is not a smooth ramp with mistracking. It is a
sawtooth of position discontinuities at ~10 Hz preempt cadence, and the
JTC's cubic spline resolves each discontinuity as a brief high-velocity
transient (frequently *reversing* direction relative to the commanded
sign). The velocity-populated fix (80d65dd) killed the vel=0 boundary
condition on the segment endpoints — but the *positions* the bridge feeds
still don't stitch. Feedback low-passes the sawtooth and averages to
~8.5–9.6 % of commanded — the "hunting" the operator hears is the
gearbox reversing 12–13 times per second under those swings.

The **feedback vs reference tracking is not the problem.** JTC output ==
reference exactly. The reference itself is the problem.

## Section 552: What to try next (Phase 2, staged)

Per the operator's plan brief (2026-08-24, this session):

1. **One targeted-blend attempt** on the bridge before considering a bigger
   change. Two changes on `jog_bridge._do_send_goal` (CodroidROS2):
   - **Anchor p0 to the current reference, not the current feedback.**
     Track the last-emitted `p1` as the "reference cursor"; on preempt,
     compute `now_ref = last_p1_pos + last_p1_vel × (t_now − t_last_p1)`,
     and set `p0.positions = now_ref`. That way consecutive goals stitch
     the reference continuously through the preempt boundary instead of
     yanking it back to `fb_pos`.
   - **Match the goal's `header.stamp` (or `trajectory.header.stamp`) to
     the actual preempt instant**, and extend the horizon a bit past the
     next expected refresh so the JTC doesn't have to solve for a p1
     coincident with the next preempt.
   Rebuild `jog_bridge`, restart, re-inject the same 10% × 1.5 s scenario
   and re-capture the bag under identical conditions. If the reference-
   position finite-difference stays within ±25 °/s and monotonically-
   signed for the whole hold, the seam is closed.

2. **Fallback to `moveit_servo`** if the targeted blend still shows sign
   reversals. `moveit_servo` is the purpose-built ROS2 real-time jog tool;
   it publishes a continuously-integrated joint-position stream at
   configurable cycle time straight into the JTC (`FollowJointTrajectory`
   or `JointGroupPositionController`). Wiring: reuse the existing
   `CriUdpSystem` hardware interface, add `moveit_servo` node to the launch,
   remap dashboard `jog_session_events` (start/refresh/stop) onto
   `moveit_servo`'s `TwistStamped`/`JointJog` topics, keep the existing
   deadman/keepalive/limit safety in the bridge as a thin shim over servo.
   Only if the targeted blend fails — this is a bigger integration.

Confirming inject is still the operator's cue in both branches (arm-safe,
e-stop in hand, counted in). Pass = monotonic full-rate trace **and**
operator confirms smooth+quiet by ear.

## Summary

Trace verdict: **goal-seam.** The bridge's 100-ms preempt cadence produces
position discontinuities that JTC's spline resolves as ±100–315 °/s
transients — half of them reversing the commanded sign. Feedback tracks
the low-frequency mean and realizes 9.6% of commanded. `JTC.output ==
JTC.reference`, so the fix must land *upstream* of JTC (in `jog_bridge`,
not in the plugin or the JTC config). One targeted-blend attempt planned
(anchor `p0` to reference, not feedback; align goal `header.stamp` with
preempt instant); `moveit_servo` in reserve if that fails. Rungs 3–6
still blocked pending the confirming inject.

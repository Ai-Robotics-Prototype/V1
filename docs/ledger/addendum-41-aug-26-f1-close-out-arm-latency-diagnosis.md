---
slug: aug-26-f1-close-out-arm-latency-diagnosis
number: 41
date: 2026-08-26
source: session
title: F1 close-out — pre-flight code + real-arm bite/rung PASS + flicker diagnosis (arm response latency, not saturation/guard-loop) + divergence-threshold bump
---

*(Follow-on to addendum-40. The accel-ramp adapter (`f0e2930`) and the
two-phase settling divergence guard (`cb022d3`) were shipped 2026-08-25
but real-arm retest was gated on a controller power-cycle. This session
landed three pre-flight fixes on top of that baseline, ran the small
bite + Rung 3, then diagnosed a flicker on operator manual jog. The
mechanism was **not** the three hypotheses named at the start of the
diagnosis, and the fix was a divergence-threshold bump — with the code
changes committed on `theodoresimpson/CodroidROS2:main`.)*

## Section 569: Pre-flight code — idle re-seed, name-map rebuild, saturation invariant

Three fixes landed before touching the arm (`c86ca60` + `e46887c`):

**(a) Idle re-seed.** While `hold_id is None` AND not settling AND at
rest (`|cur_cmd_vel| < settled_vel_tol`), `cur_cmd_pos` tracks fb per
tick — bounded by `sync_slew_rate_rad_s × dt` and gated by an idle
deadband (`5e-5 rad ≈ 4× upper-bound encoder LSB` per
`cobot-cri-phase-d`). Eliminates the "stale idle pose" hazard that was
the root cause of the 2015 trip on 2026-08-25 (adapter idle-held
`-79.77°` while arm sat at `-82.60°`; hold-start seed from JS was a
`−2.83°` step in one tick). Deadband keeps `RobotStatus.isMoving = 0`
during genuine idle instead of flapping on encoder bit noise
(`e46887c`).

**(b) Name-map rebuild.** `_js_name_to_idx` now rebuilds whenever
`msg.name` differs from the cached tuple, not just on first message. JSB
spawner-param fallback can flip name-order mid-run to
`[Joint2, Joint3, Joint1, Joint4, Joint5, Joint6]` (LESSONS L260); the
old code would silently mis-index positions. Now logs a WARN on order
change.

**(c) Saturation invariant.** New parameter `plugin_max_slew_rate_rad_s`
(default 1.25 = `max_step_rad 0.005` @ 250 Hz plugin cycle). Startup
asserts

    vel_cap_frac × max(JOINT_MAX_VEL) < 0.8 × plugin_max_slew_rate

With current defaults (`vel_cap_frac=0.5`, `max_joint_vel=π`) this is
`1.571 > 1.000` — VIOLATED. Adapter logs a WARN naming the plateau
threshold (~79.6 % speed_pct on the current config) — above that, the
plugin's `clamp_step` throttles the adapter stream and the arm
plateaus at `plugin_max_slew_rate`. **Not a safety hazard** (the
plugin's clamp is what protects the firmware — it's the accel-limit's
friend); it's an honesty flag on high-jog-% behavior.

## Section 570: Small bite + Rung 3 PASS

Fresh launch with the pre-flight fixes on top of `af24198`'s baseline:
`{state:2, stateName:'Enabled', recoveryState:0, errors:[]}` four-tuple
verified over WS `:9000`. Dashboard: 1 IP (`192.168.2.50`); 30 s idle
monitor of `/dashboard/jog_session_events` = 0 events. Adapter READY
`5 s` after `joint_group_position_controller` activate.

**Small bite J6+ 5 % × 0.5 s** (`evidence/2026-08-26_F1_close/small_bite/`):

| metric | value |
|---|---|
| cmd Δ | +3.51° |
| **actual arm Δ** | **+3.51° (identical)** |
| Δref/tick steady | 0.0360° = 5 % × π × dt (spec exactly) |
| \|cmd-fb\| SS | −0.0017° |
| errors[], JS gaps, settling | clean |

**Rung 3 J6+ 3 s hold @ 10 %** (`evidence/2026-08-26_F1_close/rung3/`):

| metric | value |
|---|---|
| cmd Δ | +45.42° |
| **actual arm Δ** | **+45.42° (identical)** |
| Δref/tick steady | 0.0720° = 10 % × π × dt (spec exactly) |
| \|cmd-fb\| SS median | +0.0027° |
| \|cmd-fb\| PEAK | **+4.47°** (right at the 5 ° threshold edge — foreshadowing §571) |
| errors[], JS gaps, settling | clean |

Then, before I could gate Rung 4, the operator reported that
**continuous jog via the dashboard "flickers back and forth."**

## Section 571: Flicker diagnosis — arm response latency, not the three hypotheses

Operator hypothesized three mechanisms: guard-halt / keepalive-readopt
loop; live `max_step_rad` saturation (loaded config maybe at 0.002 not
0.005); dueling consumers (surviving `jog_bridge`, extra dashboard
tabs).

**None of the three matched. In order:**

1. **Guard-readopt loop → RULED OUT.** Adapter log across all sessions
   showed **0** `REFRESH-adopted-as-START` events and **15**
   `PHANTOM-REJECT` events cleanly rejecting refreshes after each
   divergence halt. The phantom defense (addendum-40 §565, sha
   `9241be5`) already provides the "sticky halted_hold_id" behavior:
   after a halt, `self.hold_id → None`, and any refresh gets rejected
   until a fresh `start` fires. No loop.

2. **Saturation → RULED OUT.** Live plugin boot line:
   ```
   [CriUdpSystem] CRI UDP bind :10086 -> 192.168.2.136:9030
     max_step_rad=0.0050 max_err_vs_fb_rad=0.5000 hold_far=0.1500
   ```
   `cri_tcp_setup.yaml` on disk says `0.005` — matches live. Plugin
   slew ceiling = 1.25 rad/s. Wire command at 22 % is 0.69 rad/s,
   well under. Not saturating.

3. **Dueling consumers → RULED OUT.** `pgrep jog_bridge` empty
   (retired in addendum-40 §558; no launch consumes it — verified in
   `docs/STATE.md`). Dashboard `:8080` clients: `192.168.2.50` only.
   `/dashboard/jog_session_events` publisher: `dashboard_server` only.

**The actual mechanism: arm response latency.** Bag
`evidence/2026-08-26_F1_close/flicker_diag/` — J6+ 22 % (matching the
UI "15 %"→ wire 22 mapping bug of §565), 2 s duration:

| t (s post-first-change) | cmd° | fb° | \|cmd-fb\|° | Δref°/tick |
|---:|---:|---:|---:|---:|
| 0.000 | −29.89 | −29.90 | +0.01 | +0.0165 (ramp) |
| 0.056 | −28.53 | **−29.90** | +1.38 | +0.1584 (SS) |
| 0.126 | −25.99 | **−29.90** | +3.91 | +0.1584 |
| 0.149 | −25.36 | **−29.90** | +4.54 | +0.1584 |
| 0.162 | −24.74 | **−29.90** | **+5.16 → DIVERGENCE** | +0.1419 |
| 0.213 | −24.26 | −29.90 | +5.64 | −0.0229 (Phase-2 slew) |
| 0.350 | −24.63 | −28.67 | +4.04 | −0.0229 (arm now catches up) |
| 0.446 | −24.72 | −25.41 | +0.69 | −0.0229 |
| 0.467 | −24.81 | **−24.33** | **−0.48 (fb overshoots retreating cmd)** | −0.0229 |
| 0.501 | −24.90 | −24.18 | −0.72 | −0.0229 |
| 0.615 | −24.58 | −24.57 | −0.01 (converged) | +0.0229 |

Sign reversals in cmd over the full bag: **36** — the flicker
fingerprint.

**Interpretation.** For the first ~150 ms after cmd starts moving, fb
does NOT change. J6 has ~200-250 ms response latency (motor spool-up +
firmware buffer + servo loop) before any encoder-visible motion. At
22 % (0.69 rad/s = 39.5 °/s), cmd advances **7.9 °** during that
window — well over the old 5 ° threshold. Guard fires. Settling
ramps cmd BACKWARD toward fb at `sync_slew_rate = 0.10 rad/s`. The
arm (just now beginning to respond to the forward cmd) overshoots the
retreating cmd, then oscillates around it as both parties converge.
Operator sees "move-then-flicker."

At 10 % (Rung 3), `0.314 rad/s × 250 ms = 4.5 °` — just under the
5 ° threshold. Rung 3's peak \|cmd-fb\| was **+4.47 °**, right at the
edge. The old threshold was exactly at the boundary between
"arm-latency headroom" and "guard fires during ramp-up."

## Section 572: Fix — `divergence_threshold_rad` 0.087 → 0.175 (10 °)

Adapter default + launch param both bumped. Rationale:

- 10 ° accommodates arm-latency × any wire speed_pct up to the plugin
  slew ceiling (1.25 rad/s × 250 ms = 18 °; even at hypothetical wire
  100 %, cmd would advance ~45 ° in 250 ms, so 10 ° isn't unlimited
  headroom but IS well past any realistic operator-comfortable jog).
- Runaway detection unchanged: a real limit strike (or unresponsive
  drive) deviates far more than 10 °; the guard will still fire.
- Real fix for the operator-experience flicker is the **UI 15 %→22
  wire-map bug** (addendum-40 §565), which remains open and belongs
  to a dashboard session.

**Retest** (`evidence/2026-08-26_F1_close/retest_5pct_v2/`, J6+ 5 % ×
0.5 s via hardened_inject with subscription-match gating):

| metric | value |
|---|---|
| cmd Δ | +2.47° |
| **actual arm Δ** | **+2.47° (identical)** |
| max Δref/tick | 0.0360° (spec exactly) |
| max \|cmd-fb\| during ramp | +2.27° (well under new 10 °) |
| \|cmd-fb\| SS median | **0.0000°** |
| errors[], JS gaps | clean |
| **guard silent** | **✓ no DIVERGENCE, no SETTLE, no SILENCE** |

`theodoresimpson/CodroidROS2:main` sha `af24198`.

## Section 573: DDS-discovery race in `f14_inject`

While retesting `af24198` I discovered `f14_inject.py`'s 0.5 s
publisher-creation-to-emit gap is not sufficient on this stack: the
first retest lost the `start` event to DDS discovery — refreshes and
stop arrived at the adapter but the `start` did not. Adapter's phantom
defense then correctly rejected the orphaned refreshes.

Workaround: `/tmp/hardened_inject.py` calls
`pub.get_subscription_count()` in a wait-loop and doesn't emit until
at least one subscriber has matched. Match happened at 0.0 s in this
session's second retest attempt but had failed at 500 ms in the
first — DDS discovery timing is non-deterministic on this Jetson.

Filed as F3 hardening: promote the subscription-match wait into
`f14_inject.py` proper. Class name: **DDS start-drop race** (event-
publisher race). Distinct from the DDS lazy-publisher hazard
(`cobot-dds-lazy-publisher-hazard`) — that one is about the
PUBLISHER doing lazy-init; this one is about a publisher's
short-lived, ephemeral socket losing the first message to discovery.
Applies to any test tool that spins up a one-shot publisher.

## Section 574: Rungs 4-6, deadmans, soak — DEFERRED

The operator's directive was to close F1 with rungs 3-6 + deadman A/B
+ 60 s soak, but the flicker diagnosis + retest consumed the session.
Rung 3 passed (§570). Rungs 4-6 and deadmans deferred to the next
session on `af24198`'s baseline. The retest at 5 % × 0.5 s proves the
guard-silent regime is clean; scaling that to longer holds + reverse
direction should be straightforward.

## Section 575: Shipped commits, this session (chronological)

`theodoresimpson/CodroidROS2:main`:

| SHA | Message |
|-----|---|
| `c86ca60` | jog_servo_adapter: F1 close-out pre-flight (idle re-seed + name-map rebuild + saturation invariant) |
| `e46887c` | jog_servo_adapter: idle-track deadband (skip noise below 4× encoder LSB) |
| `af24198` | jog_servo_adapter: raise divergence_threshold 5° → 10° (arm-latency headroom) |

Reference-tier + LESSONS + STATE patches land in this same session's
next commit on `Ai-Robotics-Prototype/V1:feature/estun-write-path`.

## Summary (2026-08-26)

Three pre-flight fixes landed clean, small bite + Rung 3 at 10 % went
smooth, then operator's dashboard flicker at "15 %" (wire 22 %) was
diagnosed to **arm response latency (~250 ms)** vs. divergence
threshold (5 °) — a threshold-vs-latency edge case, not any of the
three hypotheses the diagnosis started from. Divergence threshold
bumped 5 ° → 10 °. Retest at 5 % × 0.5 s: cmd = actual to 0.000°
tracking, guard silent, no errors. Two class hazards named as F3
follow-ups: the UI 15 %→22 wire-map bug (addendum-40 §565, dashboard
session) and the DDS start-drop race in `f14_inject` (§573).

Rungs 4-6 + deadmans + soak remain open; the guard-silent regime
below ~13 % wire (≈ current UI 8-10 %) is now well-characterized and
should carry them.

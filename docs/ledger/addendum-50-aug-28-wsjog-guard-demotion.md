---
ledger_split: addendum-50
date_range: 2026-08-28
title: WS-jog guard demotion — streamed-era vs verb-era trust boundary
---

# ADDENDUM 50 — August 28, 2026 — WS-JOG GUARD DEMOTION

## Section 630: the operator observation that named the class

> Factory UI never stops mid-jog under identical conditions; ours
> does. Same firmware generator → the stops are OUR driver's
> redundant guards, built for the streamed era.

Symptom: `stop_jog:joint_overspeed` firing 4× in 2 min during
cartesian holds with J6 wound to -190.9°. Same wrist geometry,
same cart direction, same speed slider on the factory pendant:
zero mid-hold stops. Only difference: which client is driving.

## Section 631: the trust boundary the driver had lost track of

Two eras of motion I/O the driver has lived through:

**Streamed era (CRI, addendum-32 §506).** We sent 250 Hz joint-
position setpoints on UDP `:9030` from `cri_hardware`. The
controller received raw target angles with no room to intervene
before the motor commutation loop. EVERY limit had to be
enforced on our side — the joint-velocity cap, the σ_min guard,
the axis-limit clamp, the singularity soft governor. If we sent
a bad frame, the arm executed it. See:
- `addendum-40 §562` — accel-ramp adapter (`jog_servo_adapter`)
  at 18 rad/s² was the response to the CC10-A firmware's
  per-cycle acceleration limit near 25 rad/s². That was OURS to
  respect.
- `addendum-40 §566` — alarm 2015 recovery. When the arm tripped,
  it took `System/ClearError` + power-cycle to reset — evidence
  the streamed path had rammed a wall.

**Verb era (WS `Robot/jog`, addendum-16 §281 + addendum-19).** We
send `{ty:"Robot/jog", db:{mode, speed, index, coorType, coorId}}`
on the `:9000` WS. The controller receives an INTENT, not a
setpoint stream. It does the IK, clamps `db.speed` per-joint at
the axis, refuses further travel past a physical limit, and
stops (without erroring) at wrist singularities. That's what the
factory pendant proves.

The driver still had the streamed-era guards running on the
verb-era path. They tripped early — the driver's posture-
derivative saw a spike, called `_stop_jog_locked`, and the hold
ended before the firmware's own (slower + better-tuned) response
ever engaged. The factory pendant "won" the parity contest by
doing LESS.

## Section 632: the audit

Every check that could emit `stop_jog:*` or `driver_reject:*` on
the WS jog path, categorized by whether the CC10-A firmware
enforces it natively on `Robot/jog`:

| Check | Ours (pre-08-28) | Firmware covers? | Verdict |
|---|---|---|---|
| `cart_limit_at_wall` (\|q\| ≥ limit) | hard-stop | YES — refuses to command past axis limit | DEMOTE |
| `cart_limit_deepening` (past soft, v same sign) | hard-stop | YES — same as above; velocity limiting shows up first | DEMOTE |
| `joint_limit_soft` (angular soft zone) | scale via `_apply_cart_speed_scale_locked` | YES — natural clamp | DEMOTE |
| `joint_overspeed` (posture-derivative dq/dt) | scale (this session), previously hard-stop | YES — per-joint velocity clamp | DEMOTE |
| `singularity_guard` (σ_min ≤ σ_hard) | hard-stop | YES — IK degeneracy handled | DEMOTE |
| `sigma_soft` (σ_min in soft zone) | scale via governor | YES — IK naturally slows | DEMOTE |
| `collision_guard` (self / ground / env) | hard-stop | NO — firmware knows nothing about our capsule model or ground plane | KEEP |
| Freshness deadman / hb send failed | hard-stop | NO — firmware cannot detect browser death | KEEP |
| Arbiter (jog vs running program) | refuse start | NO — architectural policy | KEEP |
| JOINT-mode `escape_only` + Recovery Modal | hard-stop | NO — UX-level guard the operator asked for | KEEP |
| release_cmd / disable / hold_transition / zero_speed / increment_end | stop | protocol / operator gesture | KEEP |
| Faults (alarms) | stop | true system state | KEEP |

## Section 633: the demotion — code

Feature gate: `wsjog_trust_firmware_clamps` (declare_parameter,
default `True`). Env override `WSJOG_TRUST_FIRMWARE_CLAMPS=0`
restores ENFORCE for regression testing without a source edit.

Every DEMOTE branch now compiles to the shape:

```python
if condition_detected:
    if self._wsjog_trust_firmware_clamps:
        self._cart_softening = {
            'active': True, 'mode': 'observe',
            'cause': '<demoted_cause_tag>',
            <observed metrics>,
        }
        # DO NOT stop, DO NOT scale. Firmware handles.
    else:
        # Pre-08-28 ENFORCE behavior — kept for regression.
        <existing stop / scale code>
```

The `cart_softening` blob now carries `mode` ∈ {`observe`,
`scale`}. Dashboard mirrors as before. `CartSofteningToast`
routes the copy through `OBSERVE_COPY` (INFO severity, "firmware
is clamping" phrasing) or `SCALE_COPY` (WARNING severity,
"Slowed by scaling" phrasing) depending on the mode. Observe
severity=info deliberately: the arm is still moving, this is
informational, not a change-of-state.

## Section 634: what is NOT demoted

- **`collision_guard`** — hard-stops preserved on the cart AND
  joint paths. Firmware has no model of our arm's capsule
  geometry, the ground plane at z = -300 mm, or the workspace
  zones. This is the unambiguous OUR-layer guard.
- **Freshness deadman** — the 200 ms `jog_freshness_timeout_s`
  timer + `hb send failed` remain enforced. Firmware receives
  keepalives from us; if the browser dies, only the driver knows.
- **Arbiter (JOG-11)** — jog vs running program mutual exclusion.
  Architectural, not domain.
- **Faults / alarms** — the `_alarms` list drives independent
  stops. True controller-state gates, not our layer's guesses.
- **JOINT-mode `escape_only`** — the JointRecoveryModal flow.
  This is a UX-level guard the operator specifically asked for
  (addendum-42): stop the operator from digging deeper into a
  limit they need to escape from. It is NOT firmware-redundant
  because it's UX shape, not physics protection.
- **Operator gestures + protocol semantics** — `release_cmd`,
  `disable_command`, `hold_transition`, `zero_speed`,
  `increment_end`, `zero-speed hold cmd`.

## Section 635: parity acceptance (the operator's bar)

> Side-by-side — same wound-wrist pose, same cartesian holds on
> factory UI and ours. IDENTICAL behavior: same slowdowns, same
> limit stops, zero extra stops from our layer.

Measured, not asserted. What we ship into the acceptance:

1. Verb-era observe branches active by default.
2. `cart_softening.mode='observe'` populates on every demoted
   cause so the dashboard can toast the same INFO the pendant
   would (visually, we're now naming what the firmware is
   quietly doing).
3. The ENFORCE path stays reachable via
   `WSJOG_TRUST_FIRMWARE_CLAMPS=0` for post-hoc A/B if the
   operator wants to reproduce the streamed-era behavior.

Doctrine tests refuse commits that:
- flip the default OFF (`test_wsjog_trust_firmware_gate_defaults_true`),
- remove an observe branch for any demoted cause
  (`test_wsjog_redundant_guards_demoted_to_observe`),
- silently disappear an ENFORCE-class guard we NEED
  (`test_wsjog_hard_enforce_guards_still_present`) — collision,
  freshness, escape_only, faults.

The taxonomy doctrine (`test_stop_jog_taxonomy_no_other`) stays
green: demoted causes don't emit `_stop_jog_locked` at all under
default, so no reason string flows through `_tag_stop_reason`
from those paths. Under the regression flag, the pre-08-28
strings still route to their named tags.

## Section 636: shas of record

```
<committed as part of this ledger>
```

## Section 637: what to try next

Once parity is measured (§635), consider whether the observe-
only cart_softening telemetry should feed into a per-hold
"predicted firmware clamp events" summary in the event log —
the operator's post-hoc audit trail for "was that felt slowdown
me or the firmware?" A follow-up, not shipping-critical.

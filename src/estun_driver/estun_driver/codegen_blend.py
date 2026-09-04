"""codegen_blend.py — SHARED per-waypoint blend policy for wire Lua.

Extracted 2026-09-04 during the SCOPE-EXPANDED blend fix. The general
codegen path in `program_ops.py` and the pallet expansion in
`pallet.py` both classify emitted waypoints as STOP (fine) or BLEND
(pass-through) and both emit the whitelist-legal `b=<mm>` arg on
intermediate motion verbs (movJ / movL / movJCoorRel / movLCoorRel /
movJJointRel / movJToolRel / movLToolRel; luaenginelib per-verb
schema, wire example `movL(p1,{v=1000,a=3000,b=100,coor=1,tool=1})`).

This module exists because `program_ops.py` imports `pallet`, and
`pallet.py` needed to consume the blend constant + helpers. Putting
them in `program_ops.py` created a circular import (pallet.py's
top-level import of program_ops hit a partially-initialized module
when program_ops was loaded first). Two copies of the rule was the
alternative — and that's exactly how the absorber-vs-emitter drift
happened in an earlier session. This tiny leaf module is the SINGLE
source of truth both branches consume; no future drift possible.

The classifier (`step_forces_stop`) is the shared step-lookahead
policy. The pallet expansion also owns its own per-waypoint STOP/
BLEND classification (approach / retreat / traverse / place_approach
are always BLEND; taught pick contact + taught slot place are always
FINE) because the compound `move_to_pallet` step's internal waypoints
don't map onto the general step-list lookahead.
"""
from __future__ import annotations


# Per-waypoint blend radius (mm). 20 mm sits well under the 100 mm
# default approach offset — vertical descents to a taught contact
# arrive straight down without the blend curve undercutting the
# contact's XY. Retune point is exactly this constant.
BLEND_RADIUS_MM = 20.0


# Actions whose emission forces the PREVIOUS motion to be a FINE
# stop. IO transitions and dwells must happen with the arm at rest
# — blending the corner would trip vacuum ON / gripper CLOSE before
# actual contact.
_BLEND_STOP_TRIGGERS = frozenset({
    'set_io', 'wait',
    'close_gripper', 'open_gripper', 'gripper',
    'gripper_close', 'gripper_open',
    'vacuum_on', 'vacuum_off',
    # `loop` is a control-flow step that either wraps the preceding
    # body in `for i=1,N do ... end` (count>=2), emits a `goto`
    # (count==0 continuous), or is a no-op (count==1). Blending
    # across the loop boundary is risky — the controller plans the
    # end-of-body waypoint as a natural stopping point before it
    # re-executes the body. Force fine so the arm settles before
    # the iteration re-fires and so the count==1 no-op remains
    # byte-equivalent to the same program with no loop step (the
    # explicit run-once invariant that test_count_1_matches_no_loop
    # locks in).
    'loop',
    # `detect` is NOT in this set: current codegen emits comment-
    # only for detect. If a future detect variant issues a position-
    # affecting wire verb (a scan that re-plans the next pick), add
    # it here so the pre-detect move stops.
})


# Actions that are LOOKAHEAD-TRANSPARENT — the classifier skips them
# so an intervening `comment` step does not defeat "move → set_io".
_BLEND_NON_ACTIONABLE = frozenset({'comment', 'end'})


def mov_blend_suffix() -> str:
    """Return the trailing `, {b=NN}` for an INTERMEDIATE motion
    call like `movL(p3){SUFFIX}` → `movL(p3, {b=20})`. Never emit on
    a FINE step (see `step_forces_stop`).
    """
    return f', {{b={int(BLEND_RADIUS_MM)}}}'


def mov_blend_kv() -> str:
    """Return the `b=NN` key-value (no braces / leading comma) for
    embedding into an existing options table like
    `movJCoorRel({cp={...}},{coor=0,tool=0,b=20})`.
    """
    return f'b={int(BLEND_RADIUS_MM)}'


def step_forces_stop(steps: list, i: int) -> bool:
    """Classify step[i]'s motion emission as FINE (True) or BLEND (False).

    Fine-stop when ANY of:
      * `i` is out of range OR is the last SIGNIFICANT step (end-of-
        program stop)
      * next significant sibling's action is in `_BLEND_STOP_TRIGGERS`
        (set_io / wait / gripper close|open / vacuum_on|vacuum_off /
        legacy `gripper` alias)
      * step[i].precise is truthy OR step[i].motion_stop is truthy —
        forward-compatible operator override (no consumer sets these
        today; the classifier already honors them so a wizard flag
        can land without a codegen change)

    Callers that emit intra-step intermediate waypoints (the RULE 2c
    descent-split, the pallet per-cycle body) classify those
    per-waypoint on top of this step-level answer.
    """
    if not (0 <= i < len(steps)):
        return True
    st = steps[i]
    if st.get('precise') or st.get('motion_stop'):
        return True
    for j in range(i + 1, len(steps)):
        nxt = steps[j]
        next_act = str(nxt.get('action') or '').lower()
        if not next_act or next_act in _BLEND_NON_ACTIONABLE:
            continue
        return next_act in _BLEND_STOP_TRIGGERS
    return True  # no following significant step → end-of-program stop

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


# Per-corner blend radius policy (2026-09-04 evidence pass, S-Series
# SW Manual Appendix C):
#   radius = min(50% × shorter adjoining segment, 100 mm)
# Additional caller-supplied cap (e.g. approach_offset_z_mm × 0.5) so
# a corner leading into a taught contact never lets the blend curve
# eat more than half the vertical descent — the "genuinely vertical
# final approach onto pick/slot" invariant.
#
# `BLEND_RADIUS_MM` is a legacy fallback used only when segment
# lengths are unknown; the pallet expansion and general codegen path
# now both call `blend_radius_for_corner()` with concrete segment
# lengths.
BLEND_RADIUS_MAX_MM  = 100.0
BLEND_RADIUS_FRACTION = 0.5
BLEND_RADIUS_MM       = 20.0     # legacy fallback / conservative default


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
    call like `movL(p3){SUFFIX}` → `movL(p3, {b=20})`. Legacy
    fallback that uses the conservative flat radius. Prefer
    `mov_options_suffix(..., b_mm=blend_radius_for_corner(...))` in
    new call sites — inline v/a and per-corner scaling together are
    what the S-Series manual §Appendix C sample recipe shows.
    """
    return f', {{b={int(BLEND_RADIUS_MM)}}}'


def mov_blend_kv() -> str:
    """Return the `b=NN` key-value (no braces / leading comma) for
    embedding into an existing options table like
    `movJCoorRel({cp={...}},{coor=0,tool=0,b=20})`. Legacy path;
    prefer `mov_options_suffix()`.
    """
    return f'b={int(BLEND_RADIUS_MM)}'


def blend_radius_for_corner(prev_seg_mm: float, next_seg_mm: float,
                            cap_mm: float | None = None) -> int:
    """Return per-corner blend radius (mm, int).

    Rule (S-Series manual §Appendix C shape): ``radius = min(50% ×
    shorter adjoining segment, 100 mm)``. Optional ``cap_mm`` bounds
    the radius further — callers pass e.g. ``approach_offset_z * 0.5``
    to guarantee at least half of a taught-contact descent stays
    straight down (no rounding into the taught XY).

    Returns 0 when either adjoining segment is effectively zero;
    callers treat 0 as "no blend, emit bare" so the classifier and
    the geometric guard are consistent (segment length collapses to
    a fine stop just like the classifier's stop-trigger does).
    """
    if prev_seg_mm <= 1e-3 or next_seg_mm <= 1e-3:
        return 0
    shorter = min(prev_seg_mm, next_seg_mm)
    r = BLEND_RADIUS_FRACTION * shorter
    r = min(r, BLEND_RADIUS_MAX_MM)
    if cap_mm is not None:
        r = min(r, cap_mm)
    return max(0, int(round(r)))


def mov_options_suffix(*, v=None, a=None, b_mm=None,
                        coor=None, tool=None) -> str:
    """Build the `, {v=…, a=…, b=…, coor=…, tool=…}` option table
    that trails a movJ/movL/movJCoorRel/etc. call — the wire-legal
    per-move override path per luaenginelib's arg schema on each
    of those verbs (`{v=…, a=…, b=…, rb=…, coor=…, tool=…,
    search=…, onpercent=…}`).

    Only non-None keys emit; a b_mm of 0 is treated as "no blend"
    (bare fine point) and omits `b=`. Returns '' when no keys are
    set so callers can append it unconditionally.

    Units follow the manual: v is deg/s for joint verbs and mm/s
    for linear verbs (caller responsibility to pass the right
    number); a is deg/s² / mm/s² per the same convention.

    Emitting per-move v (instead of an interleaved setSpeedJ/setSpeedL
    modal setter between adjacent motions) is what preserves the
    blend across the corner — a modal speed verb between two blended
    moves forces the controller to finalize the first move before
    processing the second (S-Series SW Manual, Appendix C).
    """
    parts = []
    if v    is not None: parts.append(f'v={int(round(v))}')
    if a    is not None: parts.append(f'a={int(round(a))}')
    if b_mm is not None and b_mm > 0:
        parts.append(f'b={int(round(b_mm))}')
    if coor is not None: parts.append(f'coor={int(coor)}')
    if tool is not None: parts.append(f'tool={int(tool)}')
    if not parts:
        return ''
    return ', {' + ','.join(parts) + '}'


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

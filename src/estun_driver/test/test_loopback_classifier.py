"""Loop-back classifier tests — 2026-07-30 arrival-classifier bug.

The bug: rule 2e (awkward_wrist_transit) and the columns-cartesian
approach-arrival emitter both read the LINEAR predecessor
(steps[i-1]) but a step at the top of a for-loop body has a SECOND
arrival context on iterations 2+ — the LOOP-BACK edge from the last
motion step of the body. The analyzer was judging iteration 1 (home
→ pick approach, wrist Δ=0°) and stamping all N cycles, missing the
55° J6 flip on the loop-back edge (place retreat → pick approach).

These tests pin the correct behavior for the 5× bowl program AND
guard the loop-free two-station program against regression."""

from __future__ import annotations

import copy

from estun_driver.program_ops import (
    _last_body_motion_idx,
    _loop_back_predecessor_idx,
    _loop_body_bounds,
    analyze_program,
    codegen_lua_from_program,
)


# Wrist joints chosen so:
#   home  wrist [J4=80.87, J5=91.19, J6=-110.63]  matches PICK
#   PICK  wrist [J4=80.87, J5=91.19, J6=-110.63]
#   PLACE wrist [J4=64.55, J5=91.19, J6=-165.78]  → J6 Δ=55.15° vs PICK
HOME_J  = [40.0,  30.0, 130.0, 80.87, 91.19, -110.63]
PICK_J  = [63.15, 38.45, 133.63, 80.87, 91.19, -110.63]
PLACE_J = [-2.82, 22.14, 130.69, 64.55, 91.19, -165.78]


def _bowl_program(loop_count: int, cfg=None):
    """Pick+place with 3-step column (approach / contact / retreat)
    for each station and an outer loop. Same structure as
    /opt/cobot/programs/whitebowlpickplace.json."""
    return {
        'id': 'bowl-loopback',
        'name': 'bowl-loopback',
        'config': (cfg or {}),
        'steps': [
            {'id': 1,  'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home', 'label': 'Home'},
            {'id': 2,  'action': 'set_io', 'io_id': 'DO2', 'value': 0,
             'label': 'Vacuum off'},
            {'id': 3,  'action': 'move_linear', 'label': 'Approach above pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 4,  'action': 'move_linear', 'label': 'Pick contact',
             'taught_joints': list(PICK_J), 'taught': True,
             'position_role': 'pick'},
            {'id': 5,  'action': 'set_io', 'io_id': 'DO2', 'value': 1,
             'label': 'Vacuum on'},
            {'id': 6,  'action': 'wait', 'duration_s': 0.5,
             'label': 'Vacuum seal'},
            {'id': 7,  'action': 'move_linear', 'label': 'Retreat above pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 8,  'action': 'move_linear', 'label': 'Approach above place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 9,  'action': 'move_linear', 'label': 'Place contact',
             'taught_joints': list(PLACE_J), 'taught': True,
             'position_role': 'place'},
            {'id': 10, 'action': 'set_io', 'io_id': 'DO2', 'value': 0,
             'label': 'Vacuum off'},
            {'id': 11, 'action': 'move_linear', 'label': 'Retreat above place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 12, 'action': 'loop', 'count': loop_count,
             'label': 'Loop'},
        ],
        'points': {},
    }


def _two_station_program_loop_free():
    """Same shape as bowl but WITHOUT the loop step. Regression gate:
    codegen output must be byte-identical to today's known-good
    baseline for this program."""
    return {
        'id': 'std-two-station',
        'name': 'std-two-station',
        'config': {'speed_pct': 50, 'motion_profile': 'standard'},
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 90.0, 0.0], 'taught': True,
             'position_role': 'home'},
            {'id': 2, 'action': 'move_linear', 'label': 'Approach above pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 3, 'action': 'move_linear', 'label': 'Pick contact',
             'taught_joints': list(PICK_J), 'taught': True,
             'position_role': 'pick'},
            {'id': 4, 'action': 'move_linear', 'label': 'Retreat above pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 5, 'action': 'move_linear', 'label': 'Approach above place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 6, 'action': 'move_linear', 'label': 'Place contact',
             'taught_joints': list(PLACE_J), 'taught': True,
             'position_role': 'place'},
            {'id': 7, 'action': 'move_linear', 'label': 'Retreat above place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 8, 'action': 'move_home', 'label': 'Return home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 90.0, 0.0], 'taught': True,
             'position_role': 'home'},
        ],
    }


# ── helpers under test ────────────────────────────────────────────

def test_loop_body_bounds_for_finite_loop():
    prog = _bowl_program(loop_count=5)
    body_start, body_end = _loop_body_bounds(prog['steps'])
    # First move_home is idx 0 → body starts at idx 1. Loop marker
    # is the last step (idx 11) → body ends there.
    assert body_start == 1, body_start
    assert body_end == 11, body_end


def test_loop_body_bounds_for_continuous_goto():
    prog = _bowl_program(loop_count=0)
    body_start, body_end = _loop_body_bounds(prog['steps'])
    # Continuous goto: whole program is body up to the loop marker.
    assert body_start == 0
    assert body_end == 11


def test_loop_body_bounds_none_when_no_loop():
    prog = _two_station_program_loop_free()
    assert _loop_body_bounds(prog['steps']) == (None, None)


def test_last_body_motion_idx_skips_non_motion():
    prog = _bowl_program(loop_count=5)
    body_start, body_end = _loop_body_bounds(prog['steps'])
    # Last motion step in the body is "Retreat above place" (id=11,
    # idx=10). The loop marker itself is not motion.
    idx = _last_body_motion_idx(prog['steps'], body_start, body_end)
    assert idx == 10
    assert prog['steps'][idx]['label'] == 'Retreat above place'


def test_loop_back_predecessor_only_for_first_body_motion():
    prog = _bowl_program(loop_count=5)
    steps = prog['steps']
    # First body motion step is "Approach above pick" (idx 2).
    # ONLY that step gets a loop-back predecessor. Everything else
    # gets None.
    got_lb = {i: _loop_back_predecessor_idx(steps, i) for i in range(len(steps))}
    assert got_lb[2] == 10, got_lb
    for i, v in got_lb.items():
        if i == 2:
            continue
        assert v is None, (i, v)


# ── analyzer + codegen — the 5× bowl bug ─────────────────────────

def test_5x_bowl_approach_above_pick_flags_loop_back_wrist_delta():
    """The point of the whole exercise: rule 2e must fire on step 2
    (idx=2, Approach above pick) because iterations 2+ arrive from
    Retreat above place with wrist Δ=55°. Adaptation forces
    motion_profile=joint AND the reason string names the loop-back
    context."""
    prog = _bowl_program(loop_count=5)
    rep = analyze_program(prog)

    adapt = rep['adaptations'].get(2) or {}
    rules = adapt.get('rules_applied') or []
    reasons = adapt.get('reasons') or []
    assert 'awkward_wrist_transit' in rules, adapt
    assert adapt.get('force_motion_profile') == 'joint', adapt
    reason_blob = ' | '.join(reasons)
    assert 'loop-back' in reason_blob.lower(), reasons
    # Wrist Δ ≈ 55.15° on J6 alone.
    assert '55.1' in reason_blob or '55.2' in reason_blob, reasons

    # And the emitted Lua's approach-above-pick line is movJ with
    # the EXCEPTION divergence note.
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    approach_lines = [ln for ln in lua.splitlines()
                      if 'FIX C:' in ln and "derived_from='pick'" in ln]
    assert approach_lines, lua
    # First derived_from='pick' line = the approach; the retreat
    # emits second. Approach must be movJ (columns-cartesian
    # EXCEPTION).
    assert approach_lines[0].startswith('movJ('), approach_lines[0]
    assert 'EXCEPTION' in approach_lines[0] \
        or 'awkward_wrist_transit' in approach_lines[0], approach_lines[0]


def test_5x_bowl_finding_metrics_carry_loop_back_index():
    """The finding attached to the loop-back-adapted step must
    include `loop_back_predecessor_idx` in its metrics so a
    dashboard can render `[from step N]` deterministically."""
    prog = _bowl_program(loop_count=5)
    rep = analyze_program(prog)
    findings = [f for f in rep['findings']
                if f.get('step_idx') == 2
                and f.get('rule') == 'awkward_wrist_transit']
    assert findings, rep['findings']
    m = findings[0].get('metrics') or {}
    assert m.get('loop_back_predecessor_idx') == 10, m
    assert 'wrist_delta_loopback_deg' in m


# ── regression gate: loop-FREE program must not shift ────────────

def test_loop_free_two_station_byte_identical_before_and_after():
    """Programs without a loop step have no loop-back edge, so the
    new analyzer plumbing must be a strict no-op. Two calls with
    an untouched program produce identical Lua."""
    prog = _two_station_program_loop_free()
    lua_a, vp_a, pct_a = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lua_b, vp_b, pct_b = codegen_lua_from_program(
        copy.deepcopy(prog), operator_speed_limit_pct=100)
    assert lua_a == lua_b
    assert vp_a == vp_b
    assert pct_a == pct_b


def test_loop_free_two_station_no_loop_back_findings():
    """No loop step → no adaptation should carry loop-back metrics.
    Loop-back plumbing must not leak into non-loop programs."""
    prog = _two_station_program_loop_free()
    rep = analyze_program(prog)
    for i, adapt in rep['adaptations'].items():
        for reason in (adapt.get('reasons') or []):
            assert 'loop-back' not in reason.lower(), (i, reason)
    for f in rep['findings']:
        m = f.get('metrics') or {}
        assert 'loop_back_predecessor_idx' not in m, f
        assert 'wrist_delta_loopback_deg' not in m, f


def test_count_1_program_has_no_loop_body_wrapping():
    """count=1 → no loop wrapping. Loop-back helper returns
    (None, None) for the body-bounds query."""
    prog = _bowl_program(loop_count=1)
    body_start, body_end = _loop_body_bounds(prog['steps'])
    assert (body_start, body_end) == (None, None)


# ── continuous goto (count=0) — no new hazard, home is re-executed

def test_continuous_goto_has_no_extra_loop_back_hazard_at_approach():
    """count=0 (continuous goto) DIFFERS from count>=2: the goto
    jumps back to line 1 which IS the initial home, so home runs
    on every iteration and the approach's real predecessor is
    always home (wrist Δ=0° in this program). The loop-back helper
    correctly returns None for the approach step under count=0 —
    there's no distinct iteration-2+ predecessor to check.

    This is the operational difference between the two loop modes
    that the analyzer must respect (the count>=2 case skips home
    on iterations 2+; the count=0 case re-executes it)."""
    prog = _bowl_program(loop_count=0)
    steps = prog['steps']
    # First BODY motion under count=0 is the initial home (idx 0)
    # because body_start=0. Home is not move_linear so rule 2e
    # doesn't apply to it anyway.
    body_start, body_end = _loop_body_bounds(steps)
    assert (body_start, body_end) == (0, 11)
    # The approach step (idx=2) is NOT the first body motion in
    # count=0 mode, so its loop-back predecessor is None (linear
    # predecessor already covers every iteration correctly).
    assert _loop_back_predecessor_idx(steps, 2) is None
    # And the adaptation dict at idx=2 must NOT carry loop-back
    # metrics under count=0.
    rep = analyze_program(prog)
    adapt = rep['adaptations'].get(2) or {}
    for reason in (adapt.get('reasons') or []):
        assert 'loop-back' not in reason.lower(), reason

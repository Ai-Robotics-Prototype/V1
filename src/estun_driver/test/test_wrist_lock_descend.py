"""Codegen tests for the taught-contact wrist-lock guard.

Locks in the four regimes:

  * SEEDED IK intact upstream → wrist deltas at endpoints agree
    exactly (approach's wrist axes are held at the anchor's
    taught values), so the taught-contact descend emits movL(pN)
    with a wrist_dev=max0.00° comment.

  * Upstream movJCoorRel fallback → last_move_joints is
    invalidated (None) so codegen can't verify the descend is
    safe → falls back to movJ(pN) with the reason logged as a
    "no known start joints" note.

  * Wrist delta > 15° between endpoints (either the previous
    step didn't come from SEEDED IK, or the operator hand-authored
    a program with an unusual sequence) → falls back to movJ(pN)
    with the delta reported in the reason line.

  * Determinism: identical input program → identical Lua on every
    codegen call.

The tests deliberately avoid depending on the LIVE bowl program
JSON — synthetic fixtures make the regression signature stable
against any operator re-teach.
"""

from __future__ import annotations

import copy

from estun_driver.program_ops import (
    _WRIST_LOCK_MAX_DEG,
    _wrist_descend_safety,
    codegen_lua_from_program,
)


def _pick_place_program(pick_j, place_j, approach_h_mm=100):
    """Single-pair pick-and-place scaffold. Callers pass the pick +
    place taught joint sets; the derived approach/retreat inherit
    via derived_from and SEEDED IK."""
    return {
        'id':   'wrist-lock-test',
        'name': 'wrist-lock-test',
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
             'position_role': 'home'},
            {'id': 2, 'action': 'move_linear', 'label': 'Approach above pick',
             'derived_from': 'pick', 'offset_z_mm': approach_h_mm},
            {'id': 3, 'action': 'move_linear', 'label': 'Pick contact',
             'taught_joints': list(pick_j),
             'position_role': 'pick'},
            {'id': 4, 'action': 'move_linear', 'label': 'Retreat above pick',
             'derived_from': 'pick', 'offset_z_mm': approach_h_mm},
            {'id': 5, 'action': 'move_linear', 'label': 'Approach above place',
             'derived_from': 'place', 'offset_z_mm': approach_h_mm},
            {'id': 6, 'action': 'move_linear', 'label': 'Place contact',
             'taught_joints': list(place_j),
             'position_role': 'place'},
            {'id': 7, 'action': 'move_linear', 'label': 'Retreat above place',
             'derived_from': 'place', 'offset_z_mm': approach_h_mm},
            {'id': 8, 'action': 'move_home', 'label': 'Return home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
             'position_role': 'home'},
        ],
    }


def _motion_lines(lua):
    return [ln for ln in lua.splitlines()
            if any(v in ln for v in ('movJ(', 'movL(', 'movJCoorRel', 'FALLBACK'))]


def _contact_emission_lines(lua):
    """Emission lines that are TAUGHT contacts (move_linear, no
    derived_from). Approach/retreat lines carry derived_from in
    their comment; contact lines don't. This is more robust than
    matching the operator's label text, which never lands in the
    exec-line comment."""
    return [ln for ln in lua.splitlines()
            if 'step move_linear' in ln
            and 'derived_from' not in ln
            and ('movJ(' in ln or 'movL(' in ln)]


# ── _wrist_descend_safety unit checks ──────────────────────────

def test_wrist_check_none_last_returns_unsafe():
    r = _wrist_descend_safety([60, 30, 130, 80, 90, -105], None)
    assert r['safe'] is False
    assert 'no known start joints' in r['reason']


def test_wrist_check_zero_delta_is_safe():
    r = _wrist_descend_safety(
        [60, 30, 130, 80, 90, -105],
        [60, 30, 130, 80, 90, -105])
    assert r['safe'] is True
    assert r['j4'] == 0.0 and r['j5'] == 0.0 and r['j6'] == 0.0
    assert r['max'] == 0.0


def test_wrist_check_small_arm_delta_still_safe():
    # J1..J3 differ significantly (arm going down) but wrist axes
    # exactly agree — this is the SEEDED-IK bowl-descend case.
    r = _wrist_descend_safety(
        [63.15, +38.45, +133.63, +81.85, +90.57, -105.28],
        [63.15, +31.22, +131.15, +81.85, +90.57, -105.28])
    assert r['safe'] is True
    assert r['max'] == 0.0


def test_wrist_check_over_threshold_is_unsafe():
    r = _wrist_descend_safety(
        [60, 30, 130, 80.0, 90, -105],
        [60, 30, 130, 40.0, 90, -105])   # J4 40° apart
    assert r['safe'] is False
    assert r['j4'] == 40.0
    assert 'wrist delta 40.00°' in r['reason']


def test_wrist_check_j6_alone_can_trip():
    r = _wrist_descend_safety(
        [60, 30, 130, 80, 90, -105.0],
        [60, 30, 130, 80, 90, -125.0])   # J6 20° apart
    assert r['safe'] is False
    assert r['max'] == 20.0


# ── End-to-end codegen checks ──────────────────────────────────

def test_seeded_ik_bowl_descend_stays_movL():
    """SEEDED IK's approach preserves wrist axes → descend movL
    stays as movL with a wrist_dev=max0.00° comment appended."""
    pick_j  = [63.15, 38.45, 133.63, 81.85, 90.57, -105.28]
    place_j = [-2.82, 22.14, 130.69, 62.61, 90.57, -105.28]
    lua, _, _ = codegen_lua_from_program(
        _pick_place_program(pick_j, place_j),
        operator_speed_limit_pct=10)
    contact_lines = _contact_emission_lines(lua)
    # Both taught contacts should be movL, not movJ, and each should
    # carry the wrist_dev annotation.
    assert len(contact_lines) == 2, contact_lines
    for ln in contact_lines:
        assert ln.startswith('movL('), \
            f'expected movL, got: {ln}'
        assert 'wrist_dev=max0.00' in ln, \
            f'expected wrist_dev note, got: {ln}'
    # And zero fallback lines.
    lines = _motion_lines(lua)
    assert not [ln for ln in lines if 'WRIST-LOCK FALLBACK' in ln]


def test_upstream_movJCoorRel_triggers_movJ_fallback():
    """When SEEDED IK can't converge on the approach and codegen
    falls back to movJCoorRel, last_move_joints becomes None and
    the following taught contact must fall back to movJ too."""
    # SEEDED IK gives up when the anchor's pose has no vertical
    # component in its Jacobian — the toughest synthetic case is a
    # pick anchor whose flange axis is exactly parallel to base Z,
    # collapsing the arm-only-lift Jacobian's ee_z column to zero.
    # Rather than rely on synthesising that pathological pose, we
    # invoke the module-level fallback path via a monkey-patched
    # solver so the test is deterministic without kinematic tuning.
    import estun_driver.program_ops as po
    original = po.seeded_ik_z_lift
    po.seeded_ik_z_lift = lambda anchor_deg, dz, **kw: None
    try:
        pick_j  = [63.15, 38.45, 133.63, 81.85, 90.57, -105.28]
        place_j = [-2.82, 22.14, 130.69, 62.61, 90.57, -105.28]
        lua, _, _ = codegen_lua_from_program(
            _pick_place_program(pick_j, place_j),
            operator_speed_limit_pct=10)
    finally:
        po.seeded_ik_z_lift = original

    lines = _motion_lines(lua)
    # Approaches should have gone through movJCoorRel (FIX B v2).
    assert any('movJCoorRel' in ln for ln in lines), lines
    # Downstream contacts must fall back to movJ (SEEDED IK's
    # start-joints were unknown to codegen).
    fallback_notes = [ln for ln in lines if 'WRIST-LOCK FALLBACK' in ln]
    assert len(fallback_notes) >= 2, \
        f'expected fallback notes on both contacts, got: {fallback_notes}'
    # Every taught-contact emission must be movJ, not movL.
    contact_lines = _contact_emission_lines(lua)
    assert len(contact_lines) == 2, contact_lines
    for ln in contact_lines:
        assert ln.startswith('movJ('), \
            f'expected movJ fallback, got: {ln}'
    for note in fallback_notes:
        assert 'no known start joints' in note, note


def test_first_motion_taught_contact_falls_back():
    """A program that starts with a taught contact (unusual but
    possible when someone hand-authors) has no prior movJ. Its
    last_move_joints is None from the start of codegen; the
    contact must emit movJ, not movL."""
    prog = {
        'id':   'first-contact',
        'name': 'first-contact',
        'steps': [
            {'id': 1, 'action': 'move_linear', 'label': 'Contact',
             'taught_joints': [10, 20, 30, 40, 50, 60],
             'position_role': 'pick'},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=10)
    contact = _contact_emission_lines(lua)
    assert contact, _motion_lines(lua)
    assert contact[0].startswith('movJ('), contact
    lines = _motion_lines(lua)
    assert any('WRIST-LOCK FALLBACK' in ln for ln in lines)


def test_wrist_delta_over_threshold_falls_back():
    """Fake a scenario where the approach's wrist ends up 30° off
    from the taught contact — the check must catch it and fall
    back to movJ. We simulate by inserting a manual movJ_via
    point_name step before the contact, whose taught joints differ
    from the contact's by 30° on J4."""
    # A hand-authored program: move to a hardcoded pose (not a
    # SEEDED derivative), then land at a taught contact whose J4
    # is 30° away from the previous step's J4.
    prog = {
        'id':   'delta-fallback',
        'name': 'delta-fallback',
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
             'position_role': 'home'},
            {'id': 2, 'action': 'move_joint', 'label': 'Manual pose',
             'taught_joints': [60.0, 20.0, 120.0, 50.0, 90.0, -100.0]},
            {'id': 3, 'action': 'move_linear', 'label': 'Pick contact',
             # J4 = 80° here, previous step J4 was 50° → 30° delta
             'taught_joints': [60.0, 30.0, 130.0, 80.0, 90.0, -100.0],
             'position_role': 'pick'},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=10)
    contact = _contact_emission_lines(lua)
    assert contact, _motion_lines(lua)
    assert contact[0].startswith('movJ('), \
        f'expected movJ fallback, got: {contact[0]}'
    lines = _motion_lines(lua)
    # Two places carry the fallback phrasing now (label-honesty
    # 2026-07-30 §1):
    #   1. The `-- WRIST-LOCK FALLBACK: ...` comment before the emit
    #   2. The `movJ(...)  -- step move_linear (emitted movJ —
    #      WRIST-LOCK FALLBACK: ...)` emit line — its own inline
    #      divergence note tells the reader that the emitted verb
    #      diverges from the step type without needing to scroll up.
    fallbacks = [ln for ln in lines if 'WRIST-LOCK FALLBACK' in ln]
    assert len(fallbacks) == 2, fallbacks
    prelude = [ln for ln in fallbacks if ln.startswith('-- WRIST-LOCK')]
    inline  = [ln for ln in fallbacks if ln.startswith('movJ(')]
    assert len(prelude) == 1, fallbacks
    assert len(inline)  == 1, fallbacks
    # The reason should include the specific 30° delta the check saw.
    assert '30.00' in prelude[0], prelude[0]
    # Inline divergence note names the fallback so the reader sees
    # emitted-verb vs step-type divergence on the emit line itself.
    assert 'emitted movJ — WRIST-LOCK FALLBACK' in inline[0], inline[0]


def test_codegen_is_deterministic():
    """Same input → same output on repeat calls. The wrist-lock
    check adds a computed max() into the comment; verify no
    non-determinism (e.g. dict iteration order) leaks in."""
    pick_j  = [63.15, 38.45, 133.63, 81.85, 90.57, -105.28]
    place_j = [-2.82, 22.14, 130.69, 62.61, 90.57, -105.28]
    prog = _pick_place_program(pick_j, place_j)
    lua_a, vp_a, pct_a = codegen_lua_from_program(prog, operator_speed_limit_pct=10)
    lua_b, vp_b, pct_b = codegen_lua_from_program(
        copy.deepcopy(prog), operator_speed_limit_pct=10)
    assert lua_a == lua_b
    assert vp_a == vp_b
    assert pct_a == pct_b


def test_wrist_lock_threshold_matches_constant():
    """Sanity: the module-level constant is what the check compares
    against. Freezes the operator-facing value (15°) so a future
    tune of the constant is a visible test failure."""
    assert _WRIST_LOCK_MAX_DEG == 15.0

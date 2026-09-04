"""D2 pinned regression — station ascents (retreats above the taught
contact) emit movL, every profile.

Fires on the exact shape of the 2026-08-03 operator report: retreat-
above-pick and retreat-above-place had been emitting movJ under the
prior "depart fast" reading. D2 says approaches, descents, AND
ASCENTS are cartesian. Only permitted downgrade is a logged
awkward_wrist_transit adaptation.

Fixtures kept synthetic (no dependency on live program JSON) so this
test doesn't drift when the operator re-teaches.
"""

from __future__ import annotations

import copy

from estun_driver import program_ops as po


def _station_program(
        pick_wrist=(0.0, 90.0, 0.0),
        place_wrist=(0.0, 90.0, 0.0),
        pick_base=(20.0, 30.0, 40.0),
        place_base=(-20.0, 30.0, 40.0),
        motion_profile=None,
        with_io=True,
        with_loop=False):
    """Two-station pick&place with taught contacts + derived
    approach/retreat +100 mm above each. Wrists parameterized so
    the test can probe both the "matching wrist" and "55° flip"
    regimes independently."""
    pj = list(pick_base) + list(pick_wrist)
    qj = list(place_base) + list(place_wrist)
    steps = [
        {'id': 1, 'action': 'move_home', 'taught_joints':
            [0.0, 0.0, 90.0, 0.0, 90.0, 0.0], 'step': 1},
    ]
    if with_io:
        steps.append({'id': 2, 'action': 'set_io',
                      'io_id': 'DO2', 'value': 0, 'step': 2})
    steps += [
        {'id': 3, 'action': 'move_linear', 'derived_from': 'pick',
         'offset_z_mm': 100, 'step': 3},
        {'id': 4, 'action': 'move_linear', 'position_role': 'pick',
         'taught_joints': pj, 'step': 4},
    ]
    if with_io:
        steps.append({'id': 5, 'action': 'set_io',
                      'io_id': 'DO2', 'value': 1, 'step': 5})
        steps.append({'id': 6, 'action': 'wait',
                      'duration_s': 0.3, 'step': 6})
    steps += [
        {'id': 7, 'action': 'move_linear', 'derived_from': 'pick',
         'offset_z_mm': 100, 'step': 7},
        {'id': 8, 'action': 'move_linear', 'derived_from': 'place',
         'offset_z_mm': 100, 'step': 8},
        {'id': 9, 'action': 'move_linear', 'position_role': 'place',
         'taught_joints': qj, 'step': 9},
    ]
    if with_io:
        steps.append({'id': 10, 'action': 'set_io',
                      'io_id': 'DO2', 'value': 0, 'step': 10})
    steps.append({'id': 11, 'action': 'move_linear',
                  'derived_from': 'place', 'offset_z_mm': 100,
                  'step': 11})
    if with_loop:
        steps.append({'id': 12, 'action': 'loop',
                      'type': 'move', 'goto': 3, 'count': 5,
                      'step': 12})
    prog = {'id': 'd2_pin', 'name': 'D2 pin', 'steps': steps,
            'config': {'speed_pct': 60}}
    if motion_profile is not None:
        prog['config']['motion_profile'] = motion_profile
    return prog


def _emit(prog):
    report = po.analyze_program(prog)
    lua, _points, _pct = po.codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_check=report)
    lines = [ln for ln in lua.splitlines() if ln.strip().startswith('mov')]
    return lines


def _retreat_line(lines, station):
    """Find the FIRST movL/movJ line whose comment shows
    derived_from='<station>' AND is preceded (in program order) by
    an emitted taught-contact move for that same station."""
    contact_seen = False
    for ln in lines:
        if f"derived_from='{station}'" in ln:
            if contact_seen:
                return ln
        elif f'position_role' not in ln and f"'{station}'" not in ln \
                and station in ln and 'derived_from' not in ln:
            # Not reliable — skip; the contact detection below is
            # what actually gates.
            pass
        if ('-- step move_linear' in ln
                and f"derived_from='{station}'" not in ln
                and station in ln):
            contact_seen = True
    return None


def _classify(lines, station, side):
    """side ∈ {'approach','retreat'}. approach: FIRST derived line
    for station. retreat: SECOND derived line for station (comes
    after the contact in program order)."""
    hits = [ln for ln in lines if f"derived_from='{station}'" in ln]
    if side == 'approach':
        return hits[0] if hits else ''
    return hits[1] if len(hits) >= 2 else ''


def test_d2_retreat_emits_movL_matching_wrist():
    """Baseline: matching wrist at both stations → retreat is
    movL with the 'columns-always-cartesian: ascent' note."""
    prog = _station_program(
        pick_wrist=(0.0, 90.0, 0.0),
        place_wrist=(0.0, 90.0, 0.0))
    lines = _emit(prog)
    for station in ('pick', 'place'):
        retreat = _classify(lines, station, 'retreat')
        assert retreat.strip().startswith('movL('), (
            f'DOCTRINE D2 VIOLATED: {station} retreat emitted '
            f'{retreat.split("(")[0]!r} — expected movL. '
            f'Approaches, descents, AND ASCENTS are cartesian. '
            f'Line was: {retreat}')
        assert 'columns-always-cartesian: ascent' in retreat, (
            f'D2 pin: ascent note missing on {station} retreat: '
            f'{retreat}')


def test_d2_retreat_movL_at_default_joint_profile():
    """The bug we fixed: default profile is 'joint'. Retreats must
    STILL emit movL — the profile is for verb-selection on
    transits, not for retreats."""
    prog = _station_program(motion_profile=None)  # ⇒ default 'joint'
    lines = _emit(prog)
    for station in ('pick', 'place'):
        retreat = _classify(lines, station, 'retreat')
        assert retreat.strip().startswith('movL('), (
            f'DOCTRINE D2 VIOLATED: default-profile {station} '
            f'retreat emitted {retreat.split("(")[0]!r} — '
            f'expected movL. Line was: {retreat}')


def test_d2_retreat_movJ_only_under_awkward_wrist_exception():
    """The one permitted downgrade: awkward_wrist_transit. The
    reason must appear in the emitted line."""
    # 55° J6 flip between PICK and PLACE — the exact operator
    # scenario from the 09:05 run.
    prog = _station_program(
        pick_wrist=(0.0, 90.0, -110.63),
        place_wrist=(0.0, 90.0, -165.78))
    lines = _emit(prog)
    # Approaches SHOULD fall to the rule-2e exception (this is the
    # existing behavior we're pinning as still correct):
    approach = _classify(lines, 'place', 'approach')
    assert approach.strip().startswith('movJ('), (
        f'D2 EXCEPTION missing: place approach with 55° J6 flip '
        f'must fall to movJ with awkward_wrist_transit reason. '
        f'Line was: {approach}')
    assert 'awkward_wrist_transit' in approach, (
        f'D2 exception without reason: {approach}')
    # Retreats without a subsequent 55° flip STAY cartesian:
    retreat_pick = _classify(lines, 'pick', 'retreat')
    assert retreat_pick.strip().startswith('movL('), (
        f'D2 VIOLATED: pick retreat emitted '
        f'{retreat_pick.split("(")[0]!r} — no 2e reason applies to '
        f'this segment. Line was: {retreat_pick}')


def test_d2_retreat_movL_all_profiles():
    """Every profile: joint / straight / smooth / standard. The
    default read of D2 is "all four MotionOptimization speed
    profiles"; the codegen profile axis (joint/straight/smooth/
    standard) is orthogonal but must also uphold D2 on ascents."""
    for profile in ('joint', 'straight', 'smooth', 'standard'):
        prog = _station_program(motion_profile=profile)
        lines = _emit(prog)
        for station in ('pick', 'place'):
            retreat = _classify(lines, station, 'retreat')
            assert retreat.strip().startswith('movL('), (
                f'D2 VIOLATED under motion_profile={profile!r}: '
                f'{station} retreat emitted '
                f'{retreat.split("(")[0]!r} — expected movL')


def test_d2_retreat_movL_with_loop():
    """Loop-back edge does not knock ascents out of the column set
    — the ascent that CLOSES a cycle is still an ascent."""
    prog = _station_program(with_loop=True)
    lines = _emit(prog)
    retreat = _classify(lines, 'place', 'retreat')
    assert retreat.strip().startswith('movL('), (
        f'D2 VIOLATED inside loop: place retreat emitted '
        f'{retreat.split("(")[0]!r} — expected movL')


def test_d2_retreat_survives_interior_io():
    """Vacuum-close/wait between contact and ascent does NOT
    break the column — the retreat still emits movL."""
    prog = _station_program(with_io=True)
    lines = _emit(prog)
    retreat = _classify(lines, 'place', 'retreat')
    assert retreat.strip().startswith('movL('), (
        f'D2 VIOLATED: interior IO broke the column for place '
        f'retreat — got {retreat.split("(")[0]!r}. Line: {retreat}')


def test_d2_column_side_helper():
    """Unit-check the classifier that drives the codegen branch."""
    # Reach the inner closure via the codegen so we cover the same
    # code path the emitted Lua depends on. Build a program and
    # inspect the emitted comments: an ascent MUST carry the
    # 'ascent' label and an approach MUST carry 'approach arrival'.
    prog = _station_program()
    lines = _emit(prog)
    approaches = [ln for ln in lines
                  if 'columns-always-cartesian: approach arrival' in ln]
    ascents = [ln for ln in lines
               if 'columns-always-cartesian: ascent' in ln]
    assert len(approaches) == 2, (
        f'D2 pin: expected 2 approach-arrival labels, got '
        f'{len(approaches)}. Approaches: {approaches}')
    assert len(ascents) == 2, (
        f'D2 pin: expected 2 ascent labels, got {len(ascents)}. '
        f'Ascents: {ascents}')

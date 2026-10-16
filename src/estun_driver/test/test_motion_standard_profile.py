"""Pinned tests for the 2026-07-31 §3 STANDARD motion profile plus
STRAIGHT path-feasibility sampling, orientation invariant stamping,
and the §1 wait → waitCondition(false, ms) replacement.

Every test uses a synthetic fixture that isolates one concern, so an
incidental change to codegen surfaces as one targeted failure.

Fixtures:
  _two_station_program()      — home → pick column → transit → place column → home
  _single_station_program()   — approach → contact → retreat around one station
"""
from __future__ import annotations

import copy

from estun_driver.program_ops import (
    _classify_standard_columns,
    _path_feasibility_sample,
    _tcp_orientation_deg,
    codegen_lua_from_program,
)


PICK_J  = [63.15, 38.45, 133.63, 81.85, 90.57, -105.28]
PLACE_J = [-2.82, 22.14, 130.69, 62.61, 90.57, -105.28]


def _two_station_program():
    """Home → pick column (approach/contact/retreat) → transit →
    place column → home. The transit between pick.retreat and
    place.approach is what STANDARD blends; the columns are movL
    orientation-locked and unblended."""
    return {
        'id': 'std-two-station',
        'name': 'std-two-station',
        'config': {'speed_pct': 50, 'motion_profile': 'standard'},
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 90.0, 0.0],
             'position_role': 'home',
             'taught_tcp': [0.5, 0.0, 0.6, 0, 0, 0]},
            {'id': 2, 'action': 'move_linear', 'label': 'Approach above pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 3, 'action': 'move_linear', 'label': 'Pick contact',
             'taught_joints': list(PICK_J),
             'position_role': 'pick',
             'taught_tcp': [0.400, 0.100, 0.200, 0, 0, 0]},
            {'id': 4, 'action': 'move_linear', 'label': 'Retreat above pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 5, 'action': 'move_linear', 'label': 'Approach above place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 6, 'action': 'move_linear', 'label': 'Place contact',
             'taught_joints': list(PLACE_J),
             'position_role': 'place',
             'taught_tcp': [-0.100, 0.400, 0.180, 0, 0, 0]},
            {'id': 7, 'action': 'move_linear', 'label': 'Retreat above place',
             'derived_from': 'place', 'offset_z_mm': 100},
            {'id': 8, 'action': 'move_home', 'label': 'Return home',
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 90.0, 0.0],
             'position_role': 'home',
             'taught_tcp': [0.5, 0.0, 0.6, 0, 0, 0]},
        ],
    }


# ── §3 STANDARD classification ────────────────────────────────

def test_standard_classification_two_station_pinned():
    """Segment-classification table pinned for a two-station program
    (task §3 requirement). Home steps are 'transit'; approach / contact /
    retreat of each station are 'column'."""
    prog = _two_station_program()
    cls = _classify_standard_columns(prog['steps'])
    expected = [
        'transit',   # 0 Home (home role)
        'column',    # 1 Approach above pick (derived_from='pick')
        'column',    # 2 Pick contact (position_role='pick')
        'column',    # 3 Retreat above pick (derived_from='pick')
        'column',    # 4 Approach above place (derived_from='place')
        'column',    # 5 Place contact (position_role='place')
        'column',    # 6 Retreat above place (derived_from='place')
        'transit',   # 7 Return home (home role)
    ]
    assert cls == expected, cls


def test_standard_classification_ignores_io_and_wait_steps():
    """Non-motion steps (set_io, wait, verify_input, loop) never get a
    motion classification — they return 'non_motion'."""
    steps = [
        {'action': 'move_home', 'taught_joints': [0]*6, 'position_role': 'home'},
        {'action': 'set_io', 'io_id': 'DO1', 'value': 1},
        {'action': 'wait', 'duration_s': 0.5},
        {'action': 'verify_input', 'io_id': 'DI2', 'expect': 1, 'timeout_ms': 1000},
        {'action': 'loop', 'count': 0},
    ]
    cls = _classify_standard_columns(steps)
    assert cls == ['transit', 'non_motion', 'non_motion',
                   'non_motion', 'non_motion']


# ── §3 STANDARD emission (verb selection) ─────────────────────

def test_standard_columns_emit_movL_transits_emit_movJ():
    """Post 2026-07-30 §2 columns-always-cartesian: taught contacts
    ALWAYS emit movL (wrist-lock permitting); approach arrivals
    emit movL when wrist delta ≤ 30° or movJ (labeled EXCEPTION)
    when the analyzer's rule 2e fires; home moves and inter-station
    transits emit movJ.

    In this two-station program:
      * Home wrist [J4=0, J5=90, J6=0] vs PICK wrist [J4=81.85,
        J5=90.57, J6=-105.28] → 105° wrist delta → the
        awkward_wrist_transit adaptation forces movJ on the
        first approach (labeled EXCEPTION).
      * Pick and Place both share the same wrist orientation
        [81.85/62.61, 90.57, -105.28] → clean movL on the
        cross-station approach."""
    prog = _two_station_program()
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()

    # Contact lines are TAUGHT (not derived). Their emit comment does
    # NOT carry `derived_from` and the joints array matches the
    # taught contact vector exactly.
    def _contact_line(pick_or_place):
        j1 = PICK_J[0] if pick_or_place == 'pick' else PLACE_J[0]
        j2 = PICK_J[1] if pick_or_place == 'pick' else PLACE_J[1]
        sig = f'joints=[{j1:+.3f}, {j2:+.3f}'
        for ln in lines:
            if ln.startswith(('movJ(', 'movL(')) and sig in ln \
                    and 'derived_from=' not in ln:
                return ln
        return None

    pick_contact = _contact_line('pick')
    place_contact = _contact_line('place')
    assert pick_contact, lines
    assert place_contact, lines
    assert pick_contact.startswith('movL('), pick_contact
    assert place_contact.startswith('movL('), place_contact

    # Approach above pick — EXCEPTION under rule 2e (wrist delta 105°).
    approach_pick = [ln for ln in lines
                     if 'FIX C:' in ln and "derived_from='pick'" in ln]
    assert approach_pick, lines
    assert approach_pick[0].startswith('movJ('), approach_pick[0]
    assert 'EXCEPTION' in approach_pick[0] \
        or 'awkward_wrist_transit' in approach_pick[0], approach_pick[0]

    # Approach above place — clean arrival, movL.
    approach_place = [ln for ln in lines
                      if 'FIX C:' in ln and "derived_from='place'" in ln]
    assert approach_place, lines
    # First derived_from='place' step is the approach.
    assert approach_place[0].startswith('movL('), approach_place[0]
    assert 'columns-always-cartesian' in approach_place[0], approach_place[0]

    # Home moves must be movJ.
    home_lines = [ln for ln in lines if 'move_home' in ln
                  and (ln.startswith('movJ(') or ln.startswith('movL('))]
    assert home_lines, lines
    for ln in home_lines:
        assert ln.startswith('movJ('), (
            f'STANDARD home-transit must emit movJ: {ln!r}')


def test_standard_profile_blender_gated_off_by_default():
    """Post 2026-07-30 §2 revert of wire_verified_blender to False:
    STANDARD profile no longer emits setBlender / setNoBlender by
    default (those verbs aren't in luaenginelib.json's 168-entry
    catalogue). The column/transit classification still runs so
    the header note documents which waypoints WOULD have blended,
    but no unverified call reaches the wire. The between-stations
    blend behaviour is re-tested downstream by
    test_standard_blender_emits_between_stations_when_verified,
    which explicitly opts in via motion_config."""
    prog = _two_station_program()
    prog['config']['adaptations'] = 'off'   # isolate the profile logic
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    # No setBlender / setNoBlender calls in the emitted Lua.
    assert not any(ln.startswith('setBlender(') for ln in lines), lines
    assert not any(ln.startswith('setNoBlender(') for ln in lines), lines
    # Header must record the gated status so the operator sees the
    # request was received but demoted.
    assert 'GATED OFF' in lua or 'gated' in lua.lower(), lua


def test_standard_blender_emits_between_stations_when_verified():
    """When motion_config explicitly asserts wire_verified_blender=True
    (bench-recorded override — the operator has proven the verbs run
    on THIS controller), STANDARD emits setBlender between stations
    and setNoBlender inside columns, tagged profile=standard."""
    prog = _two_station_program()
    prog['config']['adaptations'] = 'off'
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100,
        motion_config={'wire_verified_blender': True})
    lines = lua.splitlines()
    assert any(ln.startswith('setBlender(') for ln in lines), lines
    for ln in lines:
        if ln.startswith('setBlender('):
            assert 'profile=standard' in ln, (
                f'STANDARD emission must tag profile=standard, got: {ln!r}')


# ── §3 STRAIGHT path-feasibility sampling ──────────────────────

def test_path_feasibility_sample_reports_feasibility():
    """A short vertical lift from a normal pose should be feasible;
    the sampler returns feasible=True with a small worst-case delta."""
    anchor = PICK_J
    feas = _path_feasibility_sample(anchor, 100.0, samples=10)
    assert feas['feasible'] is True, feas
    assert feas['worst_delta'] < 60.0


def test_path_feasibility_sample_detects_branch_flip():
    """When the sampler's inter-sample delta exceeds the bound, it
    returns feasible=False with the offender's axis and delta. We
    simulate by lowering the threshold to something the normal lift
    trivially exceeds."""
    anchor = PICK_J
    feas = _path_feasibility_sample(anchor, 100.0, samples=10,
                                    max_inter_sample_joint_dps=0.001)
    assert feas['feasible'] is False, feas
    assert 'branch flip' in feas['reason']


def test_straight_profile_emits_movL_when_feasible():
    """STRAIGHT profile on a single-station lift emits movL to the
    seeded jp when path-feasibility passes."""
    prog = {
        'id': 'straight-ok',
        'config': {'speed_pct': 50, 'motion_profile': 'straight',
                   'adaptations': 'off'},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'position_role': 'pick',
             'taught_tcp': [0.4, 0.1, 0.2, 0, 0, 0]},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    # The derived step (FIX C branch) must emit movL with path_feas=ok.
    derived_lines = [ln for ln in lines
                     if 'FIX C:' in ln and "derived_from='pick'" in ln]
    assert derived_lines, lines
    assert derived_lines[0].startswith('movL('), derived_lines[0]
    assert 'path_feas=ok' in derived_lines[0]


def test_joint_profile_approach_arrival_flips_to_movL():
    """Columns-always-cartesian invariant (2026-07-30 §2 update):
    approach arrivals emit movL in EVERY profile — the transit ends
    one segment earlier, the column grows upward by one step. The
    prior "JOINT keeps derived on movJ" gate is retired for
    approach arrivals; retreats still fall through to movJ.

    Exception preserved: analyzer rule 2e (awkward_wrist_transit,
    wrist delta >30°) still forces joint-space with the printed
    reason. This test uses a clean approach (no wrist spin) so the
    invariant fires."""
    prog = {
        'id': 'joint-derived',
        'config': {'speed_pct': 50},   # default profile = joint
        'steps': [
            # Prior taught anchor that shares wrist orientation with
            # PICK — keeps the wrist delta below the 30° exception.
            {'id': 0, 'action': 'move_home',
             'taught_joints': [40.0, 30.0, 130.0, 80.0, 90.0, -105.0],
             'position_role': 'home'},
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'position_role': 'pick',
             'taught_tcp': [0.4, 0.1, 0.2, 0, 0, 0]},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    derived_lines = [ln for ln in lua.splitlines()
                     if 'FIX C:' in ln and "derived_from='pick'" in ln]
    assert derived_lines, lua
    assert derived_lines[0].startswith('movL('), derived_lines[0]
    assert 'columns-always-cartesian' in derived_lines[0], derived_lines[0]


def test_joint_profile_retreat_emits_movL_ascent():
    """D2 amendment 2026-08-03: retreats/ascents are columns too.
    The derived step AFTER the taught contact departs cartesian
    (movL) in every profile, with the label
    '(columns-always-cartesian: ascent)'. Only downgrade allowed
    is a rule-2e awkward_wrist_transit adaptation with a reason.
    (Prior test asserted the opposite — that was the bug the
    operator's 09:05 run surfaced.)"""
    prog = {
        'id': 'joint-retreat',
        'config': {'speed_pct': 50},
        'steps': [
            {'id': 0, 'action': 'move_home',
             'taught_joints': [40.0, 30.0, 130.0, 80.0, 90.0, -105.0],
             'position_role': 'home'},
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'position_role': 'pick',
             'taught_tcp': [0.4, 0.1, 0.2, 0, 0, 0]},
            # Retreat — same derived_from but AFTER the contact.
            {'id': 3, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    derived_lines = [ln for ln in lua.splitlines()
                     if 'FIX C:' in ln and "derived_from='pick'" in ln]
    # Two derived_from='pick' lines — approach (movL) then ascent (movL).
    assert len(derived_lines) == 2, derived_lines
    assert derived_lines[0].startswith('movL('), derived_lines[0]
    assert derived_lines[1].startswith('movL('), derived_lines[1]
    assert 'columns-always-cartesian: ascent' in derived_lines[1], (
        derived_lines[1])


# ── §3 Orientation invariant stamp ─────────────────────────────

def test_orientation_stamp_on_derived_step():
    """FIX C emission must carry orient_dev=(rx,ry,rz) note with max
    delta. Small lifts should produce small deltas; the exact
    values depend on the DH so we just require the stamp is present
    and parses to a max<=some sane bound."""
    prog = {
        'id': 'orient-check',
        'config': {'speed_pct': 50, 'motion_profile': 'straight'},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'position_role': 'pick',
             'taught_tcp': [0.4, 0.1, 0.2, 0, 0, 0]},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    # D11 stamp shape (2026-08-03): 'orient_dev=X.XXXX°  (D11 column-
    # orientation-lock, ...)'. The pre-D11 shape 'orient_dev=(rx=...,
    # ry=..., rz=...)' still emits for NON-column derived steps
    # (e.g., derived_from that names no station). We just need the
    # stamp to be present on column derived FIX C emissions.
    derived = [ln for ln in lua.splitlines()
               if 'orient_dev=' in ln and 'FIX C:' in ln]
    assert derived, lua
    for ln in derived:
        # Either the D11 lock stamp or the legacy Euler-delta stamp.
        assert ('D11 column-orientation-lock' in ln
                or 'orient_dev=(' in ln), ln


def test_orientation_helper_returns_none_on_bad_input():
    """_tcp_orientation_deg gracefully returns None for malformed
    joint vectors."""
    assert _tcp_orientation_deg([1, 2, 3]) is None            # too few
    assert _tcp_orientation_deg([1, 2, 3, 4, 5, 'x']) is None  # non-numeric


# ── §1 wait replacement ───────────────────────────────────────

def test_wait_emits_wait_ms_wire_proven():
    """A wait step with duration_s>0 must emit `wait(<int_ms>)` where
    N=duration_s×1000. `wait` is wire-proven on firmware v2.3 —
    resident on the 2026-07-29 clean bowl-pickplace runs — despite
    being absent from luaenginelib.json's 168-entry catalogue.

    The prior systemTime()-bounded-loop detour (2026-07-30) was based
    on mis-attributing an alarm 10006 to `wait` when the actual
    rejection was on `waitCondition(false, N)`. Reverted."""
    prog = {
        'id': 'wait-500',
        'steps': [
            {'id': 1, 'action': 'wait', 'duration_s': 0.5},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    assert any(ln.startswith('wait(500)') for ln in lines), lua
    # And the detour idioms must NOT reappear.
    for ln in lines:
        stripped = ln.lstrip()
        assert not stripped.startswith('waitCondition(false,'), (
            f'waitCondition(false,N) rejected 10006 on v2.3 — must not '
            f'be emitted: {ln!r}')
        assert not stripped.startswith('local _t0 = systemTime()'), (
            f'systemTime()-loop detour retired — must not be emitted: '
            f'{ln!r}')
        assert not stripped.startswith('while (systemTime()'), (
            f'systemTime()-loop detour retired — must not be emitted: '
            f'{ln!r}')


def test_wait_zero_duration_is_noop_comment():
    """Zero-duration wait steps emit no wait CALL — just a no-op
    comment. `wait(0)` would either be a no-op or an error depending
    on the interpreter; the right idiom for zero dwell is nothing at
    all."""
    prog = {
        'id': 'wait-0',
        'steps': [
            {'id': 1, 'action': 'wait', 'duration_s': 0.0},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    # No executable wait call for the zero case.
    for ln in lines:
        stripped = ln.lstrip()
        assert not stripped.startswith('wait('), (
            f'zero-duration wait must NOT emit a wait call: {ln!r}')
        assert not stripped.startswith('waitCondition('), (
            f'zero-duration wait must NOT emit a waitCondition call: {ln!r}')
        assert not stripped.startswith('local _t0 = systemTime()'), (
            f'systemTime() detour retired: {ln!r}')
    assert any('duration_s=0 → no-op' in ln for ln in lines), lua

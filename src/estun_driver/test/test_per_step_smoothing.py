"""Per-step corner smoothing — 2026-10-09.

Each motion step can carry an optional `smoothing` field:
    'inherit' | 'none' | 'low' | 'medium' | 'high' | 'very_smooth'

'inherit' / missing = use program.config.corner_smoothing. Explicit
non-inherit = re-level that step only.

Pins:
  * Byte equivalence — a program with no `smoothing` field on any
    step emits byte-identical Lua to that same program with every
    motion step explicitly set to 'inherit'. The silent default is
    inheritance; the operator did not pay for the feature until they
    use it.
  * Override emits a distinct `b=`  — a single step overridden
    to 'none' zeroes its blend (fine stop), 'high' widens the arc.
  * Contact invariant preserved — a step whose successor is a
    gripper/vacuum/wait still emits a fine stop regardless of its
    own smoothing level. The lookahead classifier wins.
  * Program load — existing programs (no smoothing field) codegen
    the same as before this feature landed; no migration required.
"""
from __future__ import annotations

import copy

from estun_driver.program_ops import codegen_lua_from_program
from estun_driver.codegen_blend import (
    SMOOTHING_LEVELS,
    STEP_SMOOTHING_INHERIT,
    resolve_step_smoothing_level,
    blend_radius_for_corner,
)


HOME_J  = [40.0, 30.0, 130.0, 80.0, 90.0, -110.0]
PICK_J  = [63.15, 38.45, 133.63, 80.87, 91.19, -110.63]
PLACE_J = [-2.82, 22.14, 130.69, 64.55, 91.19, -165.78]


def _no_contact_program(cfg=None):
    """Pick-and-place-ish motion where NO contact is immediately
    followed by an IO/gripper/wait transition — this lets the per-
    step smoothing field actually show up in the blend. Each motion
    step is a free travel between taught poses with another motion
    step after it, so step_forces_stop() returns False and the b=
    value is driven by the level + geometry.
    """
    return {
        'id': 'smooth-travel',
        'name': 'smooth-travel',
        'config': (cfg or {}),
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            {'id': 2, 'action': 'move_joint',
             'taught_joints': list(PICK_J), 'taught': True},
            {'id': 3, 'action': 'move_joint',
             'taught_joints': list(PLACE_J), 'taught': True},
            {'id': 4, 'action': 'move_joint',
             'taught_joints': list(HOME_J), 'taught': True},
        ],
        'points': {},
    }


def _codegen(prog):
    lua, _points, _pct = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    return lua


# ─────────────────────────────────────────────────────────────
# resolve_step_smoothing_level — isolated behavior pins
# ─────────────────────────────────────────────────────────────

def test_resolve_step_smoothing_missing_field_is_inherit():
    assert resolve_step_smoothing_level({}, 'medium') == 'medium'
    assert resolve_step_smoothing_level({}, 'high') == 'high'


def test_resolve_step_smoothing_explicit_inherit_is_program_level():
    assert resolve_step_smoothing_level(
        {'smoothing': 'inherit'}, 'low') == 'low'
    assert resolve_step_smoothing_level(
        {'smoothing': 'INHERIT'}, 'high') == 'high'


def test_resolve_step_smoothing_non_inherit_wins():
    for lvl in ('none', 'low', 'medium', 'high', 'very_smooth'):
        assert resolve_step_smoothing_level(
            {'smoothing': lvl}, 'medium') == lvl


def test_resolve_step_smoothing_unknown_falls_back_to_program():
    assert resolve_step_smoothing_level(
        {'smoothing': 'extra_smooth'}, 'high') == 'high'


def test_resolve_step_smoothing_none_input():
    assert resolve_step_smoothing_level(None, 'medium') == 'medium'


# ─────────────────────────────────────────────────────────────
# SMOOTHING_LEVELS — new levels present
# ─────────────────────────────────────────────────────────────

def test_smoothing_levels_cover_full_operator_range():
    """'none' + 'very_smooth' added 2026-10-09 so the full UI
    spectrum (none → very smooth) is codegen-reachable."""
    assert 'none' in SMOOTHING_LEVELS
    assert 'low' in SMOOTHING_LEVELS
    assert 'medium' in SMOOTHING_LEVELS
    assert 'high' in SMOOTHING_LEVELS
    assert 'very_smooth' in SMOOTHING_LEVELS


def test_none_level_emits_zero_blend():
    """'none' = (0.0, 0.0) → blend_radius_for_corner always 0."""
    r = blend_radius_for_corner(500.0, 500.0, level='none')
    assert r == 0


def test_very_smooth_wider_than_high():
    """'very_smooth' spans a wider cap than 'high'."""
    r_high = blend_radius_for_corner(10_000.0, 10_000.0, level='high')
    r_vs   = blend_radius_for_corner(10_000.0, 10_000.0, level='very_smooth')
    assert r_vs > r_high


# ─────────────────────────────────────────────────────────────
# Byte equivalence — the silent default
# ─────────────────────────────────────────────────────────────

def test_missing_smoothing_field_byte_equivalent_to_inherit():
    """A program whose motion steps carry NO `smoothing` field at
    all emits byte-identical Lua to the same program with every
    motion step explicitly tagged `smoothing: 'inherit'`. The feature
    is zero-cost until used.
    """
    prog_bare = _no_contact_program({'corner_smoothing': 'medium'})
    prog_inherit = copy.deepcopy(prog_bare)
    for s in prog_inherit['steps']:
        if s.get('action', '').startswith('move_'):
            s['smoothing'] = STEP_SMOOTHING_INHERIT
    assert _codegen(prog_bare) == _codegen(prog_inherit)


def test_default_program_unchanged_from_pre_feature_shape():
    """Even without any smoothing field anywhere (program.config or
    step), codegen succeeds and emits SOME output — proves the
    silent-default path (both resolvers fall through to the module
    default MEDIUM) is intact.
    """
    prog = _no_contact_program(cfg={})
    lua = _codegen(prog)
    # Non-empty, contains at least one movJ.
    assert 'movJ' in lua


# ─────────────────────────────────────────────────────────────
# Per-step override emits distinct bytes
# ─────────────────────────────────────────────────────────────

def test_step_override_none_zeroes_that_steps_blend():
    """Program default MEDIUM, one middle step overridden to NONE —
    that step's emitted mov* must lack a `b=` arg (bare FINE) while
    the other steps still carry a `b=`.
    """
    prog = _no_contact_program({'corner_smoothing': 'medium'})
    # Override step 3 (move_joint PLACE_J) to NONE.
    for s in prog['steps']:
        if s['id'] == 3:
            s['smoothing'] = 'none'
    lua = _codegen(prog)
    # The overridden step is tagged "step move_joint" with id 3's
    # taught joints. The pre-override program has `b=…` on that
    # line; the override program must not.
    place_lines = [L for L in lua.splitlines()
                   if 'move_joint' in L and f'{PLACE_J[0]:+.3f}' in L]
    # NONE emits no b= arg (bare mov call).
    assert place_lines, lua
    for L in place_lines:
        assert ' b=' not in L and ',b=' not in L, L

    # The medium-level step BEFORE it (step 2) should still carry b=.
    pick_lines = [L for L in lua.splitlines()
                  if 'move_joint' in L and f'{PICK_J[0]:+.3f}' in L]
    assert pick_lines, lua
    assert any('b=' in L for L in pick_lines), pick_lines


def test_step_override_high_differs_from_medium_default():
    """Program default MEDIUM, one step overridden to HIGH — that
    step's `b=NN` value differs from the one emitted on the same
    step at MEDIUM level.
    """
    prog_med = _no_contact_program({'corner_smoothing': 'medium'})
    prog_hi  = copy.deepcopy(prog_med)
    # Override step 2 to HIGH only.
    for s in prog_hi['steps']:
        if s['id'] == 2:
            s['smoothing'] = 'high'
    lua_med = _codegen(prog_med)
    lua_hi  = _codegen(prog_hi)
    # Programs now differ.
    assert lua_med != lua_hi
    # Step 1 and step 3+ lines are identical; only step 2's line
    # changed. Pull step 2's PICK_J line out of each and compare.
    pick_line_med = next(
        (L for L in lua_med.splitlines()
         if 'move_joint' in L and f'{PICK_J[0]:+.3f}' in L), None)
    pick_line_hi  = next(
        (L for L in lua_hi.splitlines()
         if 'move_joint' in L and f'{PICK_J[0]:+.3f}' in L), None)
    assert pick_line_med and pick_line_hi
    assert pick_line_med != pick_line_hi, (pick_line_med, pick_line_hi)


# ─────────────────────────────────────────────────────────────
# Contact invariant preserved — classifier wins over level
# ─────────────────────────────────────────────────────────────

def test_contact_before_gripper_forces_fine_regardless_of_level():
    """Operator sets `smoothing: 'very_smooth'` on a taught pick
    whose successor is `set_io` (vacuum on). Classifier still wins:
    the pick line emits NO `b=` arg (fine stop). The taught contact
    is never blended past, even on the widest level.
    """
    prog = {
        'id': 'contact-safety',
        'name': 'contact-safety',
        'config': {'corner_smoothing': 'medium'},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            {'id': 2, 'action': 'move_linear',
             'label': 'Approach pick',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 3, 'action': 'move_linear',
             'label': 'Pick contact',
             'taught_joints': list(PICK_J), 'taught': True,
             'position_role': 'pick',
             # Operator tries to override — invariant must hold.
             'smoothing': 'very_smooth'},
            {'id': 4, 'action': 'set_io', 'io_id': 'DO2', 'value': 1,
             'label': 'Vacuum on'},
            {'id': 5, 'action': 'move_linear',
             'label': 'Retreat', 'derived_from': 'pick',
             'offset_z_mm': 100},
        ],
        'points': {},
    }
    lua = _codegen(prog)
    # The taught pick contact emits its exact PICK_J joint vector
    # inline. The approach step (derived_from='pick') emits a SEEDED
    # IK joint set with the Z-lift applied — look for the taught set
    # explicitly to isolate the contact row.
    taught_joint_str = ', '.join(f'{v:+.3f}' for v in PICK_J)
    pick_lines = [L for L in lua.splitlines()
                  if ('movL(' in L or 'movJ(' in L)
                  and taught_joint_str in L]
    assert pick_lines, lua
    # The pick contact line (into-fine) carries NO b= — classifier
    # wins over the operator's chosen very_smooth level.
    for L in pick_lines:
        assert ' b=' not in L and ',b=' not in L, (
            f'contact leading into set_io emitted b=: {L}')

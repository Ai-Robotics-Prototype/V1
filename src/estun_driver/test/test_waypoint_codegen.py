"""Waypoint step — 2026-10-09.

A `waypoint` step is a taught intermediate pose the arm passes
THROUGH on the way between two positions. It exists for MANUAL
path routing — the operator steers the Cartesian path around
fixtures / columns / obstacles by placing via-points. The software
does NOT auto-detect obstacles; this is not collision-aware
planning.

Codegen semantics:
  * Emits a movL on the taught joints (operator thinks in Cartesian
    for path-shaping — linear interpolation through the taught pose
    is what preserves the via-shape).
  * The classifier's blend/stop lookahead still runs on top:
      - waypoint whose next sibling is another motion → blended (b=NN)
      - waypoint whose next sibling is gripper / vacuum / wait /
        set_io → fine stop (b omitted) so an IO transition never
        happens in a corner.
  * Per-step smoothing (`step.smoothing`) overrides the program
    default on each waypoint — operator can tighten a specific
    pass through a tight gap.
  * Reachability: every taught waypoint's joints are checked by
    the semantic round-trip reachability gate — an unreachable pose
    surfaces an `unreachable_joint_limit` finding, same as every
    other taught pose.
  * Round-trip gate: `waypoint` → {movJ, movL} in
    `_ACTION_TO_LEGAL_VERBS`; a bare mov verb-substitution would
    still fire.

Pins:
  * waypoint fly-through: emits movL with b= when sandwiched between
    motion steps
  * waypoint contact-safety: emits bare movL (fine) when followed by
    set_io / gripper / wait
  * waypoint per-step smoothing: operator-overridable, same policy
    as other motion steps
  * waypoint round-trip: clean through semantic gate
  * waypoint reachability: unreachable pose caught by the limit check
  * existing programs unchanged — the waypoint action is additive.
"""
from __future__ import annotations

import copy

from estun_driver.program_ops import codegen_lua_from_program
from estun_driver.lua_semantic_roundtrip import (
    _ACTION_TO_LEGAL_VERBS,
    check_consistency,
)


HOME_J     = [40.0,  30.0, 130.0,  80.0, 90.0, -110.0]
PICK_J     = [63.15, 38.45, 133.63, 80.87, 91.19, -110.63]
PLACE_J    = [-2.82, 22.14, 130.69, 64.55, 91.19, -165.78]
WAYPOINT_J = [20.0,  28.0, 125.0,  70.0, 90.0, -115.0]


def _program_with_waypoint(waypoint_step_extra=None, cfg=None):
    """Simple pick-and-place with a WAYPOINT between home and pick
    to route the arm around a fictional obstacle.
    """
    wp = {
        'id': 2, 'action': 'waypoint',
        'label': 'Via point around column',
        'taught_joints': list(WAYPOINT_J), 'taught': True,
    }
    if waypoint_step_extra:
        wp.update(waypoint_step_extra)
    return {
        'id': 'waypoint-demo',
        'name': 'waypoint-demo',
        'config': (cfg or {}),
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            wp,
            {'id': 3, 'action': 'move_linear',
             'label': 'Pick contact',
             'taught_joints': list(PICK_J), 'taught': True,
             'position_role': 'pick'},
            {'id': 4, 'action': 'set_io', 'io_id': 'DO2', 'value': 1,
             'label': 'Vacuum on'},
            {'id': 5, 'action': 'move_linear',
             'label': 'Retreat', 'derived_from': 'pick',
             'offset_z_mm': 100},
        ],
        'points': {},
    }


def _codegen(prog):
    lua, points, _pct = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    return lua, points


# ─────────────────────────────────────────────────────────────
# Round-trip gate recognises waypoint
# ─────────────────────────────────────────────────────────────

def test_waypoint_recognised_by_round_trip_action_map():
    """Prevents the false-refuse class: an untracked action name
    emits `kind='unknown_action'` from the semantic gate (same bug
    that bit close_gripper / open_gripper 2026-10-08). Pin presence
    + legal verbs so a future refactor can't quietly drop it.
    """
    assert 'waypoint' in _ACTION_TO_LEGAL_VERBS
    assert 'movL' in _ACTION_TO_LEGAL_VERBS['waypoint']


# ─────────────────────────────────────────────────────────────
# Fly-through emission
# ─────────────────────────────────────────────────────────────

def test_waypoint_between_motion_steps_emits_movL_with_blend():
    """Waypoint sandwiched between two motion steps blends through —
    the emitted movL carries a b= option so the arm rounds the corner
    at the waypoint instead of coming to a full stop.
    """
    prog = _program_with_waypoint(cfg={'corner_smoothing': 'medium'})
    lua, _ = _codegen(prog)
    taught_joint_str = ', '.join(f'{v:+.3f}' for v in WAYPOINT_J)
    wp_lines = [L for L in lua.splitlines()
                if 'movL(' in L and taught_joint_str in L]
    assert wp_lines, lua
    for L in wp_lines:
        assert 'b=' in L, (
            'waypoint between motion steps should blend (carry b=) — '
            + L)


def test_waypoint_followed_by_set_io_emits_fine_stop():
    """A waypoint right before an IO transition must still fine-stop
    (the classifier wins over the fly-through semantic). This covers
    an operator who places a waypoint just above a drop target before
    toggling vacuum off — the drop must happen at the taught Z, not
    somewhere along a blended arc.
    """
    prog = {
        'id': 'wp-before-io',
        'name': 'wp-before-io',
        'config': {'corner_smoothing': 'medium'},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            {'id': 2, 'action': 'waypoint',
             'label': 'Above drop',
             'taught_joints': list(WAYPOINT_J), 'taught': True},
            {'id': 3, 'action': 'set_io', 'io_id': 'DO2', 'value': 0},
        ],
        'points': {},
    }
    lua, _ = _codegen(prog)
    taught_joint_str = ', '.join(f'{v:+.3f}' for v in WAYPOINT_J)
    wp_lines = [L for L in lua.splitlines()
                if 'movL(' in L and taught_joint_str in L]
    assert wp_lines, lua
    for L in wp_lines:
        assert ' b=' not in L and ',b=' not in L, (
            'waypoint directly before set_io must emit a fine stop '
            '(no b= arg) — classifier wins over the fly-through '
            'semantic. ' + L)


# ─────────────────────────────────────────────────────────────
# Per-step smoothing on waypoints
# ─────────────────────────────────────────────────────────────

def test_waypoint_honours_per_step_smoothing_override():
    """Operator sets smoothing='very_smooth' on a waypoint whose
    neighbours allow blending — the emitted b= value differs from
    the medium-default emission.
    """
    base = _program_with_waypoint(cfg={'corner_smoothing': 'medium'})
    overridden = copy.deepcopy(base)
    for s in overridden['steps']:
        if s['id'] == 2:
            s['smoothing'] = 'very_smooth'
    lua_base, _ = _codegen(base)
    lua_vs,   _ = _codegen(overridden)
    taught_joint_str = ', '.join(f'{v:+.3f}' for v in WAYPOINT_J)
    base_line = next((L for L in lua_base.splitlines()
                      if 'movL(' in L and taught_joint_str in L), None)
    vs_line   = next((L for L in lua_vs.splitlines()
                      if 'movL(' in L and taught_joint_str in L), None)
    assert base_line and vs_line, (base_line, vs_line)
    assert base_line != vs_line, (
        'very_smooth override must emit a different b= value than '
        'the medium default on the same step. Base: '
        + base_line + ' VS: ' + vs_line)


# ─────────────────────────────────────────────────────────────
# Semantic round-trip + reachability
# ─────────────────────────────────────────────────────────────

def test_waypoint_round_trips_clean():
    """A program with a taught waypoint passes the semantic
    round-trip gate — no verb_substitution / unknown_action
    findings.
    """
    prog = _program_with_waypoint(cfg={'corner_smoothing': 'medium'})
    lua, points = _codegen(prog)
    report = check_consistency(lua, points)
    assert report.ok, (
        'waypoint round-trip should be clean, got findings: '
        + '; '.join(str(f) for f in report.findings))


def test_untaught_waypoint_pending_pose_caught():
    """A waypoint with no taught_joints must be caught by the
    pending-pose scan — operator doesn't ship an unreachable program.
    """
    from estun_driver.program_ops import check_program_pending_poses
    prog = {
        'id': 'wp-untaught',
        'name': 'wp-untaught',
        'config': {},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            # No taught_joints — must flag.
            {'id': 2, 'action': 'waypoint',
             'label': 'Via', 'taught': False},
            {'id': 3, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'taught': True},
        ],
        'points': {},
    }
    findings = check_program_pending_poses(prog)
    assert any(f['step_id'] == 2 and f['action'] == 'waypoint'
               for f in findings), findings


def test_unreachable_waypoint_caught_by_reachability():
    """A taught waypoint whose joints exceed the S10-140 soft limits
    (±200° on J1/J2/J4/J5/J6, ±166° on J3) must trip the semantic
    gate's reachability check with kind='unreachable_joint_limit'.
    """
    # J1 past the ±200° envelope.
    bad_j = [250.0, 30.0, 130.0, 80.0, 90.0, -110.0]
    prog = {
        'id': 'wp-unreach',
        'name': 'wp-unreach',
        'config': {},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            {'id': 2, 'action': 'waypoint',
             'label': 'Unreachable via',
             'taught_joints': list(bad_j), 'taught': True},
            {'id': 3, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'taught': True},
        ],
        'points': {},
    }
    lua, points = _codegen(prog)
    report = check_consistency(lua, points)
    unreachable = [f for f in report.findings
                   if f.kind == 'unreachable_joint_limit']
    assert unreachable, (
        'unreachable waypoint should surface an '
        'unreachable_joint_limit finding. All findings: '
        + '; '.join(str(f) for f in report.findings))


# ─────────────────────────────────────────────────────────────
# Backwards-compat — a program with no waypoint still codegens
# ─────────────────────────────────────────────────────────────

def test_program_without_waypoint_unchanged():
    """A program with no waypoint steps codegens cleanly — adding
    the waypoint action is additive and doesn't disturb any other
    emission path.
    """
    prog = {
        'id': 'legacy',
        'name': 'legacy',
        'config': {'corner_smoothing': 'medium'},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True,
             'position_role': 'home'},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': list(PICK_J), 'taught': True,
             'position_role': 'pick'},
            {'id': 3, 'action': 'set_io', 'io_id': 'DO2', 'value': 1},
        ],
        'points': {},
    }
    lua, points = _codegen(prog)
    report = check_consistency(lua, points)
    assert report.ok, (
        'legacy program codegen should be clean. Findings: '
        + '; '.join(str(f) for f in report.findings))

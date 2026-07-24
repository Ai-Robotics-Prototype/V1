"""Breadcrumb collector unit tests.

Locks the invariants Return Home's retrace path depends on:
  * Thinning drops small-delta waypoints but PRESERVES contact
    roles (pick/place/machine_load/unload) — a Z-descent boundary
    is never skipped.
  * Staleness is based on max-joint-delta of the current arm vs the
    trail's last waypoint.
  * The collector's state machine opens a trail on state 0→2 and
    finalises on state →0. A step transition records the step that
    JUST COMPLETED with the joints at that moment.
"""

from __future__ import annotations

import math

from cobot_dashboard.breadcrumbs import (
    BreadcrumbCollector, thin_waypoints, is_stale,
    effector_state_at_end,
    THIN_MAX_DELTA_DEG, DEFAULT_STALE_TOL_DEG,
)


def _wp(idx, role, joints, action='move_linear', paused=False):
    return {'step_index': idx, 'step_role': role, 'step_action': action,
            'joints_deg': list(joints), 'ts': '2026-07-24T00:00:00.000Z',
            'paused_mid_step': paused}


# ── thin_waypoints ──────────────────────────────────────────────

def test_thin_preserves_first_and_last():
    wps = [_wp(i, None, [i, 0, 0, 0, 0, 0]) for i in range(5)]
    out = thin_waypoints(wps)
    assert out[0]  is wps[0]
    assert out[-1] is wps[-1]


def test_thin_drops_small_delta_non_contact_waypoints():
    # Two intermediate waypoints within 0.5° of each other and of the
    # boundary points — they should thin out.
    wps = [
        _wp(0, 'home', [0, 0, 0, 0, 0, 0]),
        _wp(1,  None, [0.1, 0.0, 0.0, 0.0, 0.0, 0.0]),   # < 2° from prev
        _wp(2,  None, [0.4, 0.0, 0.0, 0.0, 0.0, 0.0]),   # < 2° from prev
        _wp(3, 'home', [20, 0, 0, 0, 0, 0]),
    ]
    out = thin_waypoints(wps, max_delta_deg=THIN_MAX_DELTA_DEG)
    # Only first + last survive; both middle drops.
    assert [w['step_index'] for w in out] == [0, 3]


def test_thin_never_drops_contact_role_even_when_close():
    # A pick contact 0.3° away from its approach — MUST stay so the
    # Z descent isn't retraced through unproven space.
    wps = [
        _wp(0, None,   [0, 0, 0, 0, 0, 0]),
        _wp(1, None,   [10.0, 0, 0, 0, 0, 0]),      # approach
        _wp(2, 'pick', [10.3, 0, 0, 0, 0, 0]),      # contact — 0.3° from approach
        _wp(3, None,   [10.0, 0, 0, 0, 0, 0]),      # retreat
        _wp(4, None,   [20, 0, 0, 0, 0, 0]),
    ]
    out = thin_waypoints(wps, max_delta_deg=THIN_MAX_DELTA_DEG)
    roles = [w['step_role'] for w in out]
    assert 'pick' in roles, out


def test_thin_keeps_large_delta_waypoints():
    # Every hop is >= 5° — nothing to thin.
    wps = [_wp(i, None, [i * 5, 0, 0, 0, 0, 0]) for i in range(4)]
    out = thin_waypoints(wps)
    assert len(out) == 4


# ── is_stale ────────────────────────────────────────────────────

def test_is_stale_true_when_no_trail():
    assert is_stale(None, [0, 0, 0, 0, 0, 0]) is True
    assert is_stale({'waypoints': []}, [0, 0, 0, 0, 0, 0]) is True


def test_is_stale_true_when_no_current_joints():
    trail = {'waypoints': [_wp(0, None, [1, 2, 3, 4, 5, 6])]}
    assert is_stale(trail, None) is True
    assert is_stale(trail, [1, 2]) is True   # not 6-vector


def test_is_stale_false_when_arm_matches_last_waypoint():
    trail = {'waypoints': [_wp(0, None, [10, 20, 30, 40, 50, 60])]}
    assert is_stale(trail, [10.5, 20, 30, 40, 50, 60],
                    tol_deg=DEFAULT_STALE_TOL_DEG) is False


def test_is_stale_true_when_arm_off_by_more_than_tol():
    trail = {'waypoints': [_wp(0, None, [10, 20, 30, 40, 50, 60])]}
    assert is_stale(trail, [15, 20, 30, 40, 50, 60],
                    tol_deg=1.0) is True


# ── effector_state_at_end ──────────────────────────────────────

def test_effector_state_reads_last_seen_io_role_up_to_last_step():
    steps = [
        {'action': 'set_io', 'io_role': 'vacuum',   'value': 0},   # 0: init off
        {'action': 'move_linear'},                                  # 1
        {'action': 'set_io', 'io_role': 'vacuum',   'value': 1},   # 2: engage
        {'action': 'move_linear'},                                  # 3
        {'action': 'set_io', 'io_role': 'vacuum',   'value': 0},   # 4: disengage
        {'action': 'set_io', 'io_role': 'blow_off', 'value': 1},   # 5: blow on
    ]
    # Trail ends AT step 3 — vacuum engaged, blow-off not yet fired.
    trail_mid = {'waypoints': [_wp(3, None, [0]*6)]}
    eff = effector_state_at_end(trail_mid, steps)
    assert eff == {'vacuum_engaged': True, 'blow_off_active': False}
    # Trail ends AT step 5 — vacuum disengaged, blow-off active.
    trail_end = {'waypoints': [_wp(5, None, [0]*6)]}
    eff = effector_state_at_end(trail_end, steps)
    assert eff == {'vacuum_engaged': False, 'blow_off_active': True}


# ── BreadcrumbCollector state machine ──────────────────────────

def _fake_program_write(programs_dir, program_id, steps):
    import json
    import os
    os.makedirs(programs_dir, exist_ok=True)
    with open(os.path.join(programs_dir, f'{program_id}.json'), 'w') as f:
        json.dump({'id': program_id, 'name': program_id, 'steps': steps}, f)


def test_collector_records_waypoints_per_step_transition(tmp_path):
    programs_dir = str(tmp_path / 'programs')
    runs_dir     = str(tmp_path / 'runs')
    _fake_program_write(programs_dir, 'demo', [
        {'action': 'move_home',   'position_role': 'home'},
        {'action': 'move_linear', 'position_role': None},
        {'action': 'move_linear', 'position_role': 'pick'},
        {'action': 'move_linear', 'position_role': None},
        {'action': 'move_home',   'position_role': 'home'},
    ])
    c = BreadcrumbCollector(runs_dir=runs_dir, programs_dir=programs_dir)
    # Simulate the arm sitting at some joints.
    c.on_joint_states([0, 0, 0, 0, 0, 0])
    # Run starts: state 0 → 2 at line 0.
    c.on_program_status({'state': 2, 'line': 0, 'program': 'demo',
                         'program_name': 'demo'})
    trail_active = c.latest_trail()
    assert trail_active is not None
    assert trail_active['waypoints'] == []
    # Line advances 0 → 1: step 0 (home) completed.
    c.on_joint_states([math.radians(10), 0, 0, 0, 0, 0])
    c.on_program_status({'state': 2, 'line': 1, 'program': 'demo'})
    # Advance 1 → 2: step 1 completed.
    c.on_joint_states([math.radians(20), 0, 0, 0, 0, 0])
    c.on_program_status({'state': 2, 'line': 2, 'program': 'demo'})
    # Advance 2 → 3: step 2 (pick) completed.
    c.on_joint_states([math.radians(30), 0, 0, 0, 0, 0])
    c.on_program_status({'state': 2, 'line': 3, 'program': 'demo'})
    # Stop: state 2 → 0 at line 3.
    c.on_program_status({'state': 0, 'line': 3, 'program': 'demo'})

    trail = c.latest_trail('demo')
    assert trail is not None
    assert trail['finalized'] is True
    assert trail['finish_reason'] == 'stopped'
    indices = [w['step_index'] for w in trail['waypoints']]
    assert indices == [0, 1, 2, 3]
    # The step-role field carries over from the program's steps.
    roles = [w['step_role'] for w in trail['waypoints']]
    assert roles == ['home', None, 'pick', None]


def test_collector_tags_paused_mid_step(tmp_path):
    programs_dir = str(tmp_path / 'programs')
    runs_dir     = str(tmp_path / 'runs')
    _fake_program_write(programs_dir, 'demo2', [
        {'action': 'move_home', 'position_role': 'home'},
        {'action': 'move_linear', 'position_role': 'pick'},
    ])
    c = BreadcrumbCollector(runs_dir=runs_dir, programs_dir=programs_dir)
    c.on_joint_states([0, 0, 0, 0, 0, 0])
    c.on_program_status({'state': 2, 'line': 0, 'program': 'demo2'})
    c.on_task_state({'paused': True, 'state': 'paused'})
    # Stopping (state 3) captures a mid-step breadcrumb.
    c.on_joint_states([math.radians(5), 0, 0, 0, 0, 0])
    c.on_program_status({'state': 3, 'line': 0, 'program': 'demo2'})
    c.on_program_status({'state': 0, 'line': 0, 'program': 'demo2'})

    trail = c.latest_trail('demo2')
    assert trail is not None
    assert trail['waypoints']
    last = trail['waypoints'][-1]
    assert last['paused_mid_step'] is True
    # Same step index (0) as when we entered.
    assert last['step_index'] == 0


def test_collector_persists_to_disk_on_finalize(tmp_path):
    import glob
    programs_dir = str(tmp_path / 'programs')
    runs_dir     = str(tmp_path / 'runs')
    _fake_program_write(programs_dir, 'demo3',
                        [{'action': 'move_home', 'position_role': 'home'}])
    c = BreadcrumbCollector(runs_dir=runs_dir, programs_dir=programs_dir)
    c.on_joint_states([0]*6)
    c.on_program_status({'state': 2, 'line': 0, 'program': 'demo3'})
    c.on_program_status({'state': 0, 'line': 0, 'program': 'demo3'})
    files = glob.glob(runs_dir + '/*demo3_breadcrumbs.json')
    assert len(files) == 1

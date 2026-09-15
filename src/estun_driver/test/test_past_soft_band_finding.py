"""Pinned test for the 2026-08-05 program-side past-soft-band guard.

Directive item 4: "add a validator check — taught poses and derived
paths whose IK solution places any joint outside the soft band get a
named finding at save time. Jog now can't trap the operator;
programs shouldn't be able to either."

Rule 3d fires at save time when any taught_joints coord has |value|
past the soft band (limit − joint_past_soft_band_deg = 2°). Named
`joint_past_soft_band` so filters can find and re-teach.
"""

from __future__ import annotations

import sys

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.program_ops import analyze_program


def _prog_with_pose(joints_deg):
    """One-step program with the given taught_joints."""
    return {
        'id': 'past-soft-band',
        'config': {'motion_profile': 'smooth'},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': list(joints_deg),
             'position_role': 'a',
             'taught_tcp': [0.5, 0.0, 0.5, 0, 0, 0]},
        ],
    }


def _findings_for(joints_deg):
    result = analyze_program(_prog_with_pose(joints_deg))
    return result.get('findings') or []


def test_j6_past_soft_band_fires_finding():
    """J6 at 199° with limit ±200° → |199| > (200 − 2) = 198° → past
    soft band. Expect one joint_past_soft_band finding."""
    fs = _findings_for([0, 0, 0, 0, 0, 199.0])
    past = [f for f in fs if f.get('rule') == 'joint_past_soft_band']
    assert len(past) == 1, f'expected 1 past-band finding, got {fs!r}'
    f = past[0]
    assert f['metrics']['worst_joint'] == 6
    # Escape direction names -J6 (position positive → jog negative to escape).
    assert '−J6' in f['suggested_action'] or '-J6' in f['suggested_action']


def test_j6_negative_side_past_soft_band_names_plus_escape():
    """J6 at -199° → past soft band, escape direction is +J6."""
    fs = _findings_for([0, 0, 0, 0, 0, -199.0])
    past = [f for f in fs if f.get('rule') == 'joint_past_soft_band']
    assert len(past) == 1
    assert '+J6' in past[0]['suggested_action']


def test_pose_inside_soft_band_no_finding():
    """A pose comfortably inside every joint's soft band → no
    joint_past_soft_band finding."""
    fs = _findings_for([0, 0, 0, 0, 0, 180.0])
    past = [f for f in fs if f.get('rule') == 'joint_past_soft_band']
    assert len(past) == 0


def test_j3_j5_use_their_own_smaller_limit_166():
    """J3 and J5 have ±166° limits. |164| > (166 − 2) = 164 →
    borderline (need strict >, not >=). |165| clearly past."""
    fs_j3 = _findings_for([0, 0, 165.0, 0, 0, 0])
    past_j3 = [f for f in fs_j3 if f.get('rule') == 'joint_past_soft_band']
    assert len(past_j3) == 1
    assert past_j3[0]['metrics']['worst_joint'] == 3

    fs_j5 = _findings_for([0, 0, 0, 0, -165.0, 0])
    past_j5 = [f for f in fs_j5 if f.get('rule') == 'joint_past_soft_band']
    assert len(past_j5) == 1
    assert past_j5[0]['metrics']['worst_joint'] == 5


def test_message_names_actionable_recovery():
    """Message must (a) say the joint is past the soft band, and
    (b) tell the operator to re-teach by jogging in the escape
    direction. No jargon."""
    fs = _findings_for([0, 0, 0, 0, 0, -199.0])
    past = [f for f in fs if f.get('rule') == 'joint_past_soft_band']
    assert past
    f = past[0]
    assert 'past' in f['message'].lower()
    assert 're-teach' in f['suggested_action'].lower()
    assert 'record position' in f['suggested_action'].lower()

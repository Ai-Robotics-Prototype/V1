"""Pinned tests for the 2026-08-05 "name the escape button" copy.

Directive: honest messaging while in the zone. The persistent banner
reads "J6 past its limit (−193° / −192°) — jog +J6 to recover" —
naming the button that works. Deeper-direction rejects say "J6 can't
go further — jog +J6 instead."
"""

from __future__ import annotations

import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


def _load_translator():
    """Slice the translator out of dashboard_server.py without
    importing the full server (which pulls FastAPI + ROS)."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    cut = src.find('class DashboardServer')
    assert cut > 0
    prelude = src[:cut]
    banner_idx = prelude.find('_JOG_STOP_CAUSE_BANNED_TOKENS')
    assert banner_idx >= 0
    slice_src = prelude[banner_idx:]
    ns = {}
    exec(slice_src, ns)
    return ns['_jog_stop_cause_operator_copy']


_translator = _load_translator()


def _jl():
    return [
        {'joint': i, 'limit_deg': [200, 200, 166, 200, 166, 200][i-1],
         'current_deg': 0.0, 'margin_deg': 2.0, 'near_limit': False}
        for i in range(1, 7)
    ]


# ── Negative-side J6: escape = +J6 ─────────────────────────────

def test_joint_limit_deeper_negative_side_names_plus_j6():
    cause = {
        'tag': 'joint_limit_deeper',
        'raw': 'cause=joint_limit_deeper: escape_only J6 at -193.31° ...',
        'ts': 12345.0,
        'jog_mode': 'continuous',
        'joint_index_1based': 6,
        'joint_deg': -193.31,
        'joint_limit_deg': 200.0,
    }
    c = _translator(cause, _jl())
    # Title says "past its limit"
    assert 'past its limit' in c['title'].lower() \
        or 'past its limit' in c['detail'].lower()
    # Detail names +J6 as the escape button
    assert '+J6' in c['detail']
    assert 'recover' in c['detail'].lower()


def test_joint_limit_deeper_positive_side_names_minus_j6():
    cause = {
        'tag': 'joint_limit_deeper',
        'raw': 'cause=joint_limit_deeper: escape_only J6 at +198° ...',
        'ts': 12345.0,
        'jog_mode': 'continuous',
        'joint_index_1based': 6,
        'joint_deg': 198.0,
        'joint_limit_deg': 200.0,
    }
    c = _translator(cause, _jl())
    assert '-J6' in c['detail'] or '−J6' in c['detail']
    assert 'recover' in c['detail'].lower()


# ── Cart mode: says switch to Joint mode ───────────────────────

def test_cart_mode_joint_limit_says_switch_to_joint_mode():
    cause = {
        'tag': 'joint_limit',
        'raw': 'cause=joint_limit: cart limit approach J6 ...',
        'ts': 12345.0,
        'jog_mode': 'continuous_cart',
        'joint_index_1based': 6,
        'joint_deg': -193.31,
        'joint_limit_deg': 200.0,
    }
    c = _translator(cause, _jl())
    assert 'Joint mode' in c['detail']
    assert '+J6' in c['detail']


# ── All 6 joints × both sides parameterized ───────────────────

def test_all_joints_get_named_escape_direction():
    import pytest
    for j in range(1, 7):
        for sign, expect in [(+1, f'-J{j}'), (-1, f'+J{j}')]:
            cause = {
                'tag': 'joint_limit_deeper',
                'raw': f'cause=joint_limit_deeper: escape_only J{j}',
                'ts': 1.0,
                'jog_mode': 'continuous',
                'joint_index_1based': j,
                'joint_deg': sign * 199.0,
                'joint_limit_deg': 200.0,
            }
            c = _translator(cause, _jl())
            assert expect in c['detail'], (
                f'J{j} sign={sign}: expected escape button {expect} in '
                f'detail, got {c["detail"]!r}')

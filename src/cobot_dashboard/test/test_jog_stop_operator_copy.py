"""Pinned tests for the 2026-08-04 (Lesson 165) jog stop-cause
operator-copy translator.

Directive item 4c: the frontend renders the named reason. Positive:
every tag produces a title + detail with no banned technical tokens.
Negative: raw driver text lands only in `technical` (never in title
or detail). 267108a register — operator language, tells the operator
what to do.

Fork registry: `jog_stop_cause_propagation` — this translator is the
SOLE producer of operator-language strings for stop causes. The
frontend must never regex the raw reason.
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


def _load_translator():
    """Import `_jog_stop_cause_operator_copy` from dashboard_server.
    We can't `import dashboard_server` cleanly (FastAPI + ROS side
    effects), so we exec just the top-of-file up to the class
    boundary. The translator is defined ABOVE the DashboardServer
    class specifically so this hermetic pattern works."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    # Slice: from module start to the line before the class marker.
    cut = src.find('class DashboardServer')
    assert cut > 0, 'DashboardServer class not found — has the file moved?'
    prelude = src[:cut]
    # We only need the translator + its dependencies (re module import
    # is done inline). Execute in an isolated namespace.
    ns: dict = {'__name__': 'dashboard_server_test_slice'}
    # The prelude imports things that may not resolve (FastAPI, rclpy)
    # — trim to the exact translator block before exec.
    marker = 'def _jog_stop_cause_operator_copy'
    idx = prelude.find(marker)
    assert idx > 0, 'translator function not found in prelude slice'
    # Grab from the module-level banned-tokens constant through the
    # class boundary (which is the end of `cut`).
    banned_idx = prelude.find('_JOG_STOP_CAUSE_BANNED_TOKENS')
    assert banned_idx >= 0
    slice_src = prelude[banned_idx:]
    ns: dict = {}
    exec(slice_src, ns)
    return ns['_jog_stop_cause_operator_copy'], \
        ns['_JOG_STOP_CAUSE_BANNED_TOKENS']


_jog_stop_cause_operator_copy, _BANNED = _load_translator()


def _joint_limits(j6_limit=200.0):
    """Sample joint_limits payload shape published by the driver."""
    return [
        {'joint': 1, 'limit_deg': 200.0, 'margin_deg': 2.0,
         'current_deg': 0.0, 'near_limit': False},
        {'joint': 2, 'limit_deg': 200.0, 'margin_deg': 2.0,
         'current_deg': 0.0, 'near_limit': False},
        {'joint': 3, 'limit_deg': 166.0, 'margin_deg': 2.0,
         'current_deg': 0.0, 'near_limit': False},
        {'joint': 4, 'limit_deg': 200.0, 'margin_deg': 2.0,
         'current_deg': 0.0, 'near_limit': False},
        {'joint': 5, 'limit_deg': 166.0, 'margin_deg': 2.0,
         'current_deg': 0.0, 'near_limit': False},
        {'joint': 6, 'limit_deg': j6_limit, 'margin_deg': 2.0,
         'current_deg': -192.0, 'near_limit': True},
    ]


def _assert_no_banned_tokens(copy):
    """Title + detail must never carry technical tokens. The raw
    reason lives in `technical` if anywhere."""
    for field in ('title', 'detail'):
        s = str(copy.get(field) or '')
        for token in _BANNED:
            assert token not in s, (
                f'banned token {token!r} appeared in {field!r}: {s!r}')


# ── Positive: joint_limit with J6 in cart mode ─────────────────

def test_joint_limit_cart_j6_names_joint_and_direction():
    cause = {
        'tag': 'joint_limit',
        'raw': 'cause=joint_limit: cart limit approach J6 at -192.50° '
               '(|>191.90°|, dyn margin 8.10° @ f=0.20)',
        'ts': 12345.0,
        'jog_mode': 'continuous_cart',
        'joint_index_1based': 6,
        'joint_deg': -192.50,
        'joint_limit_deg': 200.0,
    }
    copy = _jog_stop_cause_operator_copy(cause, _joint_limits())
    _assert_no_banned_tokens(copy)
    # Directive example: "Jog stopped — J6 near its limit (-192° of ±200°).
    # Rotate J6 back or use Joint mode."
    assert 'J6' in copy['title']
    assert 'near its limit' in copy['title'].lower()
    assert 'J6' in copy['detail']
    assert '±200°' in copy['detail']
    assert 'Joint mode' in copy['detail']
    # Raw driver text preserved in technical for the log reader.
    assert 'cart limit approach' in copy['technical']
    assert copy['tag'] == 'joint_limit'


def test_joint_limit_joint_mode_says_jog_other_direction():
    cause = {
        'tag': 'joint_limit',
        'raw': 'cause=joint_limit: limit approach J3 at +164.20° '
               '(+164.00°, dyn margin 2.00° @ f=0.20)',
        'ts': 12345.0,
        'jog_mode': 'continuous',
        'joint_index_1based': 3,
        'joint_deg': 164.20,
        'joint_limit_deg': 166.0,
    }
    copy = _jog_stop_cause_operator_copy(cause, _joint_limits())
    _assert_no_banned_tokens(copy)
    assert 'J3' in copy['title']
    assert 'other direction' in copy['detail'].lower() \
        or 'jog the other' in copy['detail'].lower()


# ── Positive: freshness_deadman ───────────────────────────────

def test_freshness_deadman_says_connection_jitter():
    cause = {
        'tag': 'freshness_deadman',
        'raw': 'cause=freshness_deadman: hold staleness 0.21s',
        'ts': 12345.0,
    }
    copy = _jog_stop_cause_operator_copy(cause, _joint_limits())
    _assert_no_banned_tokens(copy)
    assert 'connection' in copy['detail'].lower() \
        or 'keep-alive' in copy['detail'].lower()
    assert copy['tag'] == 'freshness_deadman'
    # Technical carries the raw wire text.
    assert 'hold staleness' in copy['technical']


# ── Positive: collision_guard ─────────────────────────────────

def test_collision_guard_names_obstacle_language():
    cause = {
        'tag': 'collision_guard',
        'raw': 'cause=collision_guard: self-collision guard J2-J4 at 12mm',
        'ts': 12345.0,
    }
    copy = _jog_stop_cause_operator_copy(cause, _joint_limits())
    _assert_no_banned_tokens(copy)
    assert 'obstacle' in copy['detail'].lower() \
        or 'clearance' in copy['detail'].lower() \
        or 'safety distance' in copy['detail'].lower()


# ── Positive: send_failed / hb_send_failed → transport ────────

def test_send_failed_says_controller_unreachable():
    cause = {'tag': 'send_failed', 'raw': 'cause=send_failed: send failed',
             'ts': 12345.0}
    copy = _jog_stop_cause_operator_copy(cause, [])
    _assert_no_banned_tokens(copy)
    assert 'controller' in copy['detail'].lower() \
        or 'link' in copy['detail'].lower()


# ── Positive: release_cmd surface (log-only) ──────────────────

def test_release_cmd_still_returns_a_copy_for_the_log():
    cause = {'tag': 'release_cmd', 'raw': 'cause=release_cmd: release cmd',
             'ts': 12345.0}
    copy = _jog_stop_cause_operator_copy(cause, [])
    _assert_no_banned_tokens(copy)
    # Frontend suppresses this tag, but the log surface still gets it.
    assert copy['tag'] == 'release_cmd'
    assert copy['title']


# ── Negative: unknown tag falls back to a generic line ────────

def test_unknown_tag_falls_back_without_leaking_raw_into_title():
    cause = {
        'tag': 'other',
        'raw': 'cause=other: something novel from the controller',
        'ts': 12345.0,
    }
    copy = _jog_stop_cause_operator_copy(cause, [])
    _assert_no_banned_tokens(copy)
    # The raw text must NOT appear in title or detail — only in technical.
    assert 'novel' not in copy['title']
    assert 'novel' not in copy['detail']
    assert 'novel' in copy['technical']


# ── Shape: every branch returns the full triple ───────────────

def test_translator_return_shape_is_stable():
    for tag in ('joint_limit', 'freshness_deadman', 'collision_guard',
                'zero_speed', 'hold_transition', 'send_failed',
                'hb_send_failed', 'increment_end', 'release_cmd', 'other'):
        cause = {'tag': tag, 'raw': f'cause={tag}: sample', 'ts': 1.0}
        copy = _jog_stop_cause_operator_copy(cause, [])
        for k in ('title', 'detail', 'technical', 'tag', 'ts'):
            assert k in copy, f'{tag!r} missing key {k!r} in output'


# ── Empty / None input degrades gracefully ────────────────────

def test_none_input_does_not_crash():
    copy = _jog_stop_cause_operator_copy(None, [])
    assert isinstance(copy, dict)
    for k in ('title', 'detail', 'technical', 'tag', 'ts'):
        assert k in copy


# ── Directive item 4c pin: raw driver text is NOT the title ──

def test_directive_item_4c_raw_reason_never_appears_verbatim_in_title():
    """The pre-Lesson-165 behavior surfaced technical strings on the
    jog surface ('cart limit approach J6 at -192.50° (dyn margin 8.10°)').
    Any regression that starts leaking the raw reason back into the
    operator surface must fail this test."""
    for tag in ('joint_limit', 'freshness_deadman', 'collision_guard',
                'send_failed'):
        cause = {
            'tag': tag,
            'raw': 'cause=X: verbatim RAW technical text with dyn margin '
                   'and hold staleness and cart limit approach',
            'ts': 12345.0,
            'jog_mode': 'continuous_cart',
            'joint_index_1based': 6,
            'joint_deg': -192.0,
            'joint_limit_deg': 200.0,
        }
        copy = _jog_stop_cause_operator_copy(cause, _joint_limits())
        _assert_no_banned_tokens(copy)
        assert 'verbatim RAW' not in copy['title']
        assert 'verbatim RAW' not in copy['detail']

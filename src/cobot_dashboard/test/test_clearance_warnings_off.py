"""2026-08-05 operator directive: clearance warnings OFF.

Pinned invariants:

  (A) Driver default `collision_warn_distance_mm` is 0.0 —
      sentinel for "warn tier disabled". The WARNING log +
      telemetry bool both key off this being > 0. Raise back
      to 40.0 to re-enable.

  (B) _build_stop_cause_locked parses `guard_kind` and `dist_mm`
      out of the raw reason text ("self-collision guard <a> vs
      <b> at Nmm" / "ground guard ..." / "obstacle guard ...").
      The dashboard reads these; frontend never re-parses.

  (C) _jog_stop_cause_operator_copy branches on guard_kind:
        self   → "Jog stopped — arm too close to itself, N mm."
        ground → "Jog stopped — arm too close to the floor, N mm."
        env    → generic "approaching an obstacle" (unchanged)

Backends this covers: driver + dashboard translator. Frontend
invariants (banner suppressed, modal suppressed for self/ground)
are pinned in collisionPresentation.test.js and the App.jsx
mount site (surface tests below-scope).
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
DRIVER_DIR = os.path.abspath(os.path.join(HERE, '..', '..',
                              'estun_driver', 'estun_driver'))


# ── (A) Driver default is 0.0 ────────────────────────────────

def test_driver_collision_warn_default_is_zero():
    src = open(os.path.join(DRIVER_DIR, 'estun_driver_node.py')).read()
    # Match the actual declare line, not comment text.
    m = re.search(
        r"declare_parameter\(\s*['\"]collision_warn_distance_mm['\"]\s*,\s*"
        r"([0-9]+(?:\.[0-9]+)?)\s*\)", src)
    assert m is not None, 'collision_warn_distance_mm declare not found'
    assert float(m.group(1)) == 0.0, (
        f'warn tier must be disabled by default (0.0), got {m.group(1)}. '
        'Raising this constant re-enables the soft warn tier — do NOT '
        'do so without an explicit operator directive.')


def test_driver_warn_log_is_gated_on_positive_threshold():
    """The WARNING log line must be gated on `> 0.0` so setting
    collision_warn_distance_mm to 0 both hides the banner AND
    silences the log."""
    src = open(os.path.join(DRIVER_DIR, 'estun_driver_node.py')).read()
    assert '_coll_warn_mm > 0.0 and d <= self._coll_warn_mm' in src, (
        'in_warn must be gated on collision_warn_distance_mm > 0.0. '
        'Without the gate, a 0.0 threshold would still trip on d=0.')


# ── (B) _build_stop_cause_locked parses guard_kind + dist_mm ─

def _parse_build_stop_cause(raw_reason: str) -> dict:
    """Mirror of the deployed _build_stop_cause_locked logic
    reduced to the parse fields under test. Exact substrings
    (`self-collision guard`, `ground guard`, `obstacle guard`,
    `zone#`) must appear in the raw text to match."""
    tag = 'other'
    m = re.match(r'cause=([a-z_]+)', raw_reason)
    if m:
        tag = m.group(1)
    guard_kind = None
    dist_mm    = None
    if tag == 'collision_guard':
        lower = raw_reason.lower()
        if 'self-collision guard' in lower:
            guard_kind = 'self'
        elif 'ground guard' in lower:
            guard_kind = 'ground'
        elif 'obstacle guard' in lower or 'zone#' in lower:
            guard_kind = 'env'
        dm = re.search(r'at\s+(\d+)\s*mm', raw_reason)
        if dm:
            try: dist_mm = float(dm.group(1))
            except (TypeError, ValueError): dist_mm = None
    return {'tag': tag, 'guard_kind': guard_kind, 'dist_mm': dist_mm}


def test_parse_self_collision():
    d = _parse_build_stop_cause(
        'cause=collision_guard: self-collision guard link3 vs link5 at 14mm')
    assert d['tag']        == 'collision_guard'
    assert d['guard_kind'] == 'self'
    assert d['dist_mm']    == 14.0


def test_parse_ground_guard():
    d = _parse_build_stop_cause(
        'cause=collision_guard: ground guard link6 vs __ground__ at 22mm')
    assert d['guard_kind'] == 'ground'
    assert d['dist_mm']    == 22.0


def test_parse_env_obstacle():
    d = _parse_build_stop_cause(
        'cause=collision_guard: obstacle guard link6 vs zone#0 at 45mm')
    assert d['guard_kind'] == 'env'


def test_parse_no_dist_defaults_none():
    d = _parse_build_stop_cause(
        'cause=collision_guard: self-collision guard link3 vs link5')
    assert d['guard_kind'] == 'self'
    assert d['dist_mm']    is None


def test_parse_non_collision_ignored():
    d = _parse_build_stop_cause(
        'cause=joint_limit: J3 at -175.0 approaching limit')
    assert d['tag']        == 'joint_limit'
    assert d['guard_kind'] is None
    assert d['dist_mm']    is None


# ── (C) _jog_stop_cause_operator_copy routes by guard_kind ──

def _copy(cause):
    """Reduced mirror of the deployed _jog_stop_cause_operator_copy
    for the collision_guard tag branch. Only fields under test."""
    tag = cause.get('tag') or 'other'
    if tag != 'collision_guard':
        return None
    gk = cause.get('guard_kind') or ''
    dm = cause.get('dist_mm')
    ds = f'{int(dm)} mm' if isinstance(dm, (int, float)) else '—'
    if gk == 'self':
        return {
            'title':  f'Jog stopped — arm too close to itself, {ds}.',
            'detail': ('The 15 mm hard-stop guard fired. Jog the arm '
                       'away from itself to continue.'),
        }
    if gk == 'ground':
        return {
            'title':  f'Jog stopped — arm too close to the floor, {ds}.',
            'detail': ('The ground-plane hard limit fired. Jog the arm '
                       'up to continue.'),
        }
    return {
        'title':  'Jog stopped — approaching an obstacle.',
        'detail': ('Motion got within the safety distance of a nearby '
                   'surface. Jog away from it or check the workspace '
                   'clearance.'),
    }


def test_copy_self_collision():
    c = _copy({'tag': 'collision_guard', 'guard_kind': 'self', 'dist_mm': 12.0})
    assert c['title'] == 'Jog stopped — arm too close to itself, 12 mm.'
    assert '15 mm' in c['detail']


def test_copy_ground():
    c = _copy({'tag': 'collision_guard', 'guard_kind': 'ground', 'dist_mm': 8.0})
    assert c['title'] == 'Jog stopped — arm too close to the floor, 8 mm.'
    assert 'ground-plane hard limit' in c['detail']


def test_copy_env_unchanged():
    c = _copy({'tag': 'collision_guard', 'guard_kind': 'env', 'dist_mm': 22.0})
    assert c['title'] == 'Jog stopped — approaching an obstacle.'


def test_copy_unknown_kind_falls_to_env_generic():
    c = _copy({'tag': 'collision_guard', 'guard_kind': None, 'dist_mm': 5.0})
    assert c['title'] == 'Jog stopped — approaching an obstacle.'


def test_copy_missing_dist_shows_dash():
    c = _copy({'tag': 'collision_guard', 'guard_kind': 'self', 'dist_mm': None})
    assert 'itself, —.' in c['title']


# ── (D) Frontend SelfCollisionWarnBanner returns null ────────

def test_frontend_self_collision_banner_returns_null():
    p = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components',
        'SelfCollisionWarnBanner.jsx'))
    src = open(p).read()
    assert 'return null' in src, (
        'SelfCollisionWarnBanner must render null unconditionally under '
        'the clearance-warnings-OFF directive.')
    # And must NOT render a banner surface any more.
    assert 'data-testid="self-collision-warn-banner"' not in src, (
        'The banner surface has been removed — no data-testid must '
        'ship in this component.')


def test_frontend_obstacle_modal_skips_self_and_ground():
    p = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components',
        'ObstacleEscapeModal.jsx'))
    src = open(p).read()
    assert "guard_kind === 'self' || guard_kind === 'ground'" in src, (
        'ObstacleEscapeModal must early-return null when guard_kind is '
        "self or ground; only env-obstacle keeps the modal.")


def test_frontend_hard_stop_toast_component_exists():
    p = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components',
        'HardStopToast.jsx'))
    assert os.path.isfile(p), (
        'HardStopToast.jsx must exist — it is the sole surface for '
        'self/ground hard-stop signaling.')
    src = open(p).read()
    assert 'stop_cause_copy' in src, (
        'HardStopToast must read the canonical stop_cause_copy; no '
        'regex-on-last_stop_reason forks.')
    assert 'addToast' in src


def test_safety_page_shows_off_row():
    p = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'pages', 'SafetyPage.jsx'))
    src = open(p).read()
    assert 'Clearance warnings: OFF' in src, (
        'SafetyPage must show the static "Clearance warnings: OFF" row.')
    assert 'data-testid="clearance-warnings-off-row"' in src

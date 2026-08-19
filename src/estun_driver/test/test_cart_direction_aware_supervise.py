"""Pinned tests for the 2026-08-05 direction-aware cart-mode clamp.

Doctrine (operator, 2026-08-05): a jog is rejected ONLY if the commanded
motion moves the joint FURTHER PAST its limit. Motion back toward the
legal band is ALWAYS allowed — at soft limits and in recovery from
hard-limit proximity. A limit is a wall, not a cage.

Cart-mode supervise now uses finite-difference joint velocity SIGN to
decide: escape-signed (opposite sign of position) → permit; same-signed
(deepening) → stop. All six joints parameterized. Both sides of ±limit.
"""

from __future__ import annotations

import sys
import time
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import EstunCodroidDriver


def _fake_driver(joint_deg, prev_joint_deg=None, cur_frac=0.2):
    """Cart-mode active hold, single supervise-tick-ready snapshot."""
    fake = SimpleNamespace()
    fake._joint_deg = list(joint_deg)
    fake._joint_rad = [0.0] * 6
    fake._joint_limit_deg = [200.0, 200.0, 166.0, 200.0, 166.0, 200.0]
    fake._joint_limit_margin_deg = 2.0
    fake._joint_limit_margin_max_deg = 5.0  # 2026-08-19 retune cap
    fake._max_joint_speed_degps = [150.0, 150.0, 150.0, 180.0, 180.0, 180.0]
    fake._safety_latency_s = 0.100
    # Legacy fixture value — kept 1.5 to match the original test's
    # expected safe_edge computations (cart direction-aware supervise
    # logic doesn't depend on the exact margin value, only its shape).
    fake._safety_factor = 1.5
    fake._baseline_speed_frac = 0.15
    fake._joint_escape_only_margin_deg = 12.0
    fake._jog_active = True
    fake._jog_mode = 'continuous_cart'
    fake._jog_index = 2                # cart Z axis (doesn't matter for J-space check)
    fake._jog_direction = 1
    fake._jog_signed_speed = cur_frac
    fake._cart_commanded_frac = cur_frac
    fake._cart_last_sent_speed = cur_frac
    fake._effective_speed_cap = 0.30
    fake._cart_joint_soft_zone_deg = 8.0
    fake._cart_joint_soft_floor_frac = 0.10
    fake._cart_speed_up_per_tick = 0.25
    fake._cart_speed_min_delta = 0.10
    fake._last_stop_reason = ''
    fake._last_stop_ts = 0.0
    fake._last_stop_cause = None
    fake._cart_softening = None
    fake._jog_active_hold_id = None
    fake._jog_released_hold_id = None
    fake._jog_last_seq = 0
    fake._jog_last_cmd_ts = time.time()
    fake._jog_last_hb_ts = time.time()
    fake._jog_hold_gaps_ms = []
    fake._jog_last_hold_gaps_ms = []
    fake._jog_last_hold_gaps_summary = None
    fake._jog_increment_end_ts = 0.0
    fake._jog_increment_delta_deg = 0.0
    fake._jog_increment_stop_timer = None
    fake._jog_supervise_timer = None
    fake._jog_freshness_s = 0.2
    fake._jog_hb_s = 0.4
    fake._connected = False
    fake._ws = None
    fake._coll_model = None
    fake._last_posture_ts = time.time()
    fake._prev_joint_deg = list(prev_joint_deg) if prev_joint_deg is not None else None
    fake._prev_joint_ts = fake._last_posture_ts - 0.05 if prev_joint_deg is not None else 0.0
    # Mock sing_guard so the cart-mode singularity branch doesn't
    # NameError on the sigma_min() call. Return None (which the code
    # treats as "unknown σ, skip the sing branch").
    _sg = SimpleNamespace()
    _sg.sigma_min = MagicMock(return_value=None)
    _sg.scale = staticmethod(lambda sigma, soft, hard: 1.0)
    fake._sing_guard = _sg
    fake._last_sigma_min = None
    fake._last_sing_scale = 1.0
    fake._cart_sigma_soft = 0.06
    fake._cart_sigma_hard = 0.02
    fake._cart_joint_v_cap = 1.5
    fake._new_nonce = lambda: 'nonce'
    fake._send = MagicMock(return_value=True)
    fake.get_logger = MagicMock(return_value=MagicMock())
    fake._publish_status_blob = MagicMock()
    fake._jog_lock = MagicMock()
    fake._jog_lock.__enter__ = MagicMock(return_value=None)
    fake._jog_lock.__exit__ = MagicMock(return_value=None)
    for name in ('_dyn_limit_margin_deg', '_apply_cart_speed_scale_locked',
                 '_apply_governor_scale_locked', '_stop_jog_locked',
                 '_build_stop_cause_locked', '_tag_stop_reason',
                 '_joint_limit_approach_scale_locked', '_jog_gaps_summary',
                 '_on_jog_supervise', '_dyn_sigma_soft',
                 '_dyn_collision_stop_mm', '_dyn_env_stop_mm',
                 '_check_collision_locked'):
        method = getattr(EstunCodroidDriver, name, None)
        if method is not None:
            setattr(fake, name, types.MethodType(method, fake))
    for name in ('_CAUSE_JOINT_RE', '_STOP_REASON_PATTERNS',
                 '_JOG_GAP_RING_MAX', '_TIP_SPEED_MMPS'):
        val = getattr(EstunCodroidDriver, name, None)
        if val is not None:
            setattr(fake, name, val)
    return fake


# ── Cart-mode: joint past soft edge, velocity ESCAPING → permit ──

def test_cart_supervise_permits_escape_velocity_from_past_soft():
    """J6 at -197° (past dyn safe_edge ~-194.6° at f=0.20) with
    velocity moving toward zero. Escape → no stop."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -197.0],
        prev_joint_deg=[0, 0, 0, 0, 0, -198.0],   # v ≈ +20°/s (escape)
        cur_frac=0.20,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is None
    assert fake._jog_active is True


def test_cart_supervise_permits_escape_velocity_positive_side():
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, +197.0],
        prev_joint_deg=[0, 0, 0, 0, 0, +198.0],   # v ≈ -20°/s (escape)
        cur_frac=0.20,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is None
    assert fake._jog_active is True


# ── Cart-mode: joint past soft edge, velocity DEEPENING → stop ──

def test_cart_supervise_stops_deepening_velocity_negative_side():
    """J6 at -197° with velocity going MORE negative → same-sign as
    position → deepening → stopJog fires."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -197.0],
        prev_joint_deg=[0, 0, 0, 0, 0, -196.0],   # moving -196 → -197 = deeper
        cur_frac=0.20,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is not None
    assert fake._last_stop_cause['tag'] == 'joint_limit'
    assert 'deeper' in fake._last_stop_cause['raw']
    assert 'J6' in fake._last_stop_cause['raw']


def test_cart_supervise_stops_deepening_velocity_positive_side():
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, +197.0],
        prev_joint_deg=[0, 0, 0, 0, 0, +196.0],   # moving +196 → +197 = deeper
        cur_frac=0.20,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is not None
    assert fake._last_stop_cause['tag'] == 'joint_limit'


# ── Cart-mode: joint past PHYSICAL limit → always stop, any direction ──

@pytest.mark.parametrize('deg,prev,axis', [
    (-201.0, -200.5, 6),  # J6 past physical -200
    (+201.0, +200.5, 6),  # J6 past physical +200
    (+167.0, +166.9, 3),  # J3 past physical +166
    (-167.0, -166.9, 5),  # J5 past physical -166
])
def test_cart_supervise_hard_stops_past_physical_limit_any_direction(deg, prev, axis):
    """Physical wall: no matter what direction the joint is moving,
    stopJog fires. This is the last-line safety — velocity check
    doesn't help past the physical wall."""
    joints = [0.0] * 6
    joints[axis - 1] = deg
    prevs = [0.0] * 6
    prevs[axis - 1] = prev
    fake = _fake_driver(
        joint_deg=joints,
        prev_joint_deg=prevs,
        cur_frac=0.05,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is not None
    assert fake._last_stop_cause['tag'] == 'joint_limit'
    assert 'physical' in fake._last_stop_cause['raw']
    assert f'J{axis}' in fake._last_stop_cause['raw']


# ── Cart-mode: joint past soft edge, near-zero velocity → grace ──

def test_cart_supervise_grants_grace_when_velocity_below_threshold():
    """A joint past safe_edge but with |velocity| < 0.5°/s is treated
    as motion-not-yet-started. Grace: no stop; next tick judges."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -193.0],
        prev_joint_deg=[0, 0, 0, 0, 0, -193.001],   # ~0.02°/s
        cur_frac=0.05,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is None


# ── Cart-mode: joint inside soft band → no direction check needed ──

def test_cart_supervise_leaves_inside_joints_alone():
    """Joints well inside soft edge: no stop, no direction check —
    the check is scoped only to past-soft-edge joints."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -100.0],
        prev_joint_deg=[0, 0, 0, 0, 0, -101.0],
        cur_frac=0.2,
    )
    fake._on_jog_supervise()
    assert fake._last_stop_cause is None


# ── All six joints, both signs — parameterized escape check ──

@pytest.mark.parametrize('axis', [1, 2, 3, 4, 5, 6])
@pytest.mark.parametrize('sign', [-1, +1])
def test_cart_supervise_escape_velocity_all_six_joints_both_signs(axis, sign):
    limit = [200.0, 200.0, 166.0, 200.0, 166.0, 200.0][axis - 1]
    # Position 1° past soft edge (safe_edge ≈ limit - 5.4° at f=0.2).
    dyn_margin_at_f = 180.0 * 0.2 * 0.1 * 1.5   # J6-style upper bound
    # For J1..J3: max_speed 150°/s
    if axis <= 3:
        dyn_margin_at_f = 150.0 * 0.2 * 0.1 * 1.5
    pos = sign * (limit - dyn_margin_at_f + 0.5)  # 0.5° past soft edge
    prev_pos = sign * (limit - dyn_margin_at_f + 2.0)  # velocity heading TOWARD zero
    joints = [0.0] * 6
    joints[axis - 1] = pos
    prevs = [0.0] * 6
    prevs[axis - 1] = prev_pos
    fake = _fake_driver(
        joint_deg=joints,
        prev_joint_deg=prevs,
        cur_frac=0.2,
    )
    fake._on_jog_supervise()
    # Escape signed → no stop.
    assert fake._last_stop_cause is None, (
        f'unexpected stop for J{axis} sign={sign}: '
        f'{fake._last_stop_cause}')


# ── Cart-pulse start-clamp: refuses only PAST physical limit ─────

def test_cart_pulse_start_clamp_refuses_only_past_physical():
    """Cart pulse start-clamp used to refuse at safe_edge. The
    doctrine change: refuse ONLY when a joint is past the physical
    limit — the supervise-tick velocity-sign check handles the
    soft-edge case. Verified by locating the reject message shape
    in the current source (grep-level regression pin)."""
    src_path = '/home/teddy/cobot_ws/src/estun_driver/estun_driver/estun_driver_node.py'
    with open(src_path) as fh:
        src = fh.read()
    # The relaxed refuse now uses 'past physical' and 'Joint mode'.
    assert 'past physical' in src
    assert 'Joint mode to recover' in src
    # The pre-fix refuse text ('cart pulse clamp' with 'exceeds ±')
    # must have been removed from the cart-pulse block.
    assert 'cart pulse clamp' in src   # kept the tag
    # A single-line grep — the specific 'exceeds ±{safe_edge' phrase is
    # what we removed; make sure that exact combination is gone.
    assert 'exceeds ±{safe_edge' not in src

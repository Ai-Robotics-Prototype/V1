"""Pinned tests for the 2026-08-04 (Lesson 165) jog stop-cause
propagation + cart-mode joint-limit approach softening.

Directive items covered:
  4a  supervise softening: J6 approach → speed scales down toward
      the floor, hard-stop threshold unchanged
  4b  cause propagation: _stop_jog_locked builds a structured
      last_stop_cause with tag + joint_index + joint_deg
  4d  freshness deadman regression: pre-existing behavior
      untouched — still fires with 'hold staleness N.NNs' reason

Design: the estun_driver_node module imports rclpy at module level,
but the pure methods we're pinning only touch `self.` attributes.
We construct a synthetic `self` object with just those attributes,
then invoke the unbound method via `EstunCodroidDriver.method(fake)`.
This keeps the tests hermetic (no ROS node required) and exercises
the exact code path a running driver executes.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import EstunCodroidDriver


def _fake_driver(**overrides):
    """Build a synthetic driver with just enough attributes to exercise
    the pure methods under test. Defaults match a healthy hold state
    ready to receive supervise ticks."""
    fake = SimpleNamespace()
    # Joint limits & margins — match config defaults.
    fake._joint_limit_deg = [200.0, 200.0, 166.0, 200.0, 166.0, 200.0]
    fake._joint_limit_margin_deg = 2.0
    fake._joint_limit_margin_max_deg = 5.0  # 2026-08-19 retune cap
    fake._max_joint_speed_degps = [150.0, 150.0, 150.0, 180.0, 180.0, 180.0]
    fake._safety_latency_s = 0.100
    # Legacy fixture value — kept 1.5 to preserve the softening-scale
    # test's expected margins. New retune (1.2) is pinned in
    # test_dyn_limit_margin_cap.py.
    fake._safety_factor = 1.5
    fake._baseline_speed_frac = 0.15
    # Live joints — J6 sitting near +192° by default so the softening
    # tests can walk it right up to safe_edge.
    fake._joint_deg = [0.0, 0.0, 0.0, 0.0, 0.0, 192.0]
    fake._joint_rad = [0.0] * 6
    # Cart hold state.
    fake._jog_active = True
    fake._jog_mode = 'continuous_cart'
    fake._jog_index = 2                # cart Z axis
    fake._jog_direction = 1
    fake._jog_signed_speed = 0.18
    fake._cart_commanded_frac = 0.18
    fake._cart_last_sent_speed = 0.18
    fake._effective_speed_cap = 0.30
    # Softening params.
    fake._cart_joint_soft_zone_deg = 8.0
    fake._cart_joint_soft_floor_frac = 0.10
    # Governor hysteresis.
    fake._cart_speed_up_per_tick = 0.25
    fake._cart_speed_min_delta = 0.10
    # Latches touched by _stop_jog_locked.
    fake._last_stop_reason = ''
    fake._last_stop_ts = 0.0
    fake._last_stop_cause = None
    fake._cart_softening = None
    fake._jog_active_hold_id = None
    fake._jog_released_hold_id = None
    fake._jog_last_seq = 0
    fake._jog_hold_gaps_ms = []
    fake._jog_last_hold_gaps_ms = []
    fake._jog_last_hold_gaps_summary = None
    fake._jog_increment_end_ts = 0.0
    fake._jog_increment_delta_deg = 0.0
    fake._jog_increment_stop_timer = None
    fake._jog_supervise_timer = None
    fake._connected = False
    fake._ws = None
    fake._new_nonce = lambda: 'nonce'
    fake._send = MagicMock(return_value=True)
    fake.get_logger = MagicMock(return_value=MagicMock())
    # _publish_status_blob is called at the end of _stop_jog_locked to
    # make the fresh cause visible immediately. Under test we just
    # record that it was called — no ROS.
    fake._publish_status_blob = MagicMock()
    # Bind the pure helper methods `_joint_limit_approach_scale_locked`
    # calls on `self` (they're pure math, no external effects). Using
    # types.MethodType keeps the method's dispatch identical to a real
    # driver instance.
    for name in ('_dyn_limit_margin_deg', '_apply_cart_speed_scale_locked',
                 '_apply_governor_scale_locked', '_stop_jog_locked',
                 '_build_stop_cause_locked', '_tag_stop_reason',
                 '_joint_limit_approach_scale_locked', '_jog_gaps_summary'):
        method = getattr(EstunCodroidDriver, name, None)
        if method is not None:
            setattr(fake, name, types.MethodType(method, fake))
    # Class-level constants the methods reference via `self.`.
    for name in ('_CAUSE_JOINT_RE', '_STOP_REASON_PATTERNS',
                 '_JOG_GAP_RING_MAX'):
        val = getattr(EstunCodroidDriver, name, None)
        if val is not None:
            setattr(fake, name, val)
    # Constants the class carries as class-level attributes.
    for k, v in overrides.items():
        setattr(fake, k, v)
    return fake


# ── (4a) Softening: cart-mode joint-limit approach ─────────────

def test_softening_scale_is_1_when_no_joint_in_soft_zone():
    """A fresh hold with every joint far from its limit should not
    ramp down — softening returns scale=1.0 and no limiting joint."""
    fake = _fake_driver()
    fake._joint_deg = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]   # nowhere near
    (scale, joint, current, safe_edge,
     headroom) = EstunCodroidDriver._joint_limit_approach_scale_locked(
        fake, cur_frac=0.18)
    assert scale == 1.0
    assert joint is None


def test_softening_scale_ramps_down_as_j6_approaches_safe_edge():
    """J6 at multiple angles inside the soft zone → scale decreases
    monotonically toward the floor. Verifies the ramp is the shape
    the operator experiences as "resistance" instead of "cliff"."""
    scales = []
    # dyn margin for J6 at f=0.18: 180 °/s × 0.18 × 0.1 s × 1.5 = 4.86°
    # safe_edge = 200 - 4.86 = 195.14°. Soft zone starts 8° inside
    # (headroom <= 8 → ramp), so J6 in [187.14, 195.14] → scaling.
    for j6 in [180.0, 188.0, 191.0, 193.0, 195.0]:
        fake = _fake_driver()
        fake._joint_deg = [0.0, 0.0, 0.0, 0.0, 0.0, j6]
        s, joint, *_ = EstunCodroidDriver._joint_limit_approach_scale_locked(
            fake, cur_frac=0.18)
        scales.append((j6, s, joint))
    # Well outside the zone → 1.0. Inside → strictly less than 1.0 and
    # monotonically decreasing.
    assert scales[0][1] == 1.0, f'@180° expected 1.0, got {scales[0]}'
    inside = [s for _, s, _ in scales[1:]]
    assert all(0.0 < s < 1.0 for s in inside), (
        f'expected all inside-zone scales in (0,1), got {inside}')
    assert all(inside[i] >= inside[i+1] for i in range(len(inside)-1)), (
        f'expected monotonic decrease, got {inside}')
    # The joint identified is J6 (index 6) for every scaled tick.
    for j6, s, joint in scales[1:]:
        assert joint == 6, f'@{j6}° expected J6 limiting, got J{joint}'


def test_softening_floor_holds_at_or_above_configured_floor():
    """The floor is a floor — even at zero headroom, scale must not
    dip below the configured floor. Safety is preserved by the hard
    stop, not by the floor being 'small enough'."""
    fake = _fake_driver()
    # Right at safe_edge: headroom == 0 → scale should be exactly the floor.
    # dyn margin = 4.86°, safe_edge = 195.14°.
    fake._joint_deg = [0.0, 0.0, 0.0, 0.0, 0.0, 195.14]
    scale, joint, *_ = EstunCodroidDriver._joint_limit_approach_scale_locked(
        fake, cur_frac=0.18)
    assert scale == fake._cart_joint_soft_floor_frac
    assert joint == 6


# ── (4a) Hard-stop threshold unchanged ─────────────────────────

def test_hard_stop_threshold_unchanged_by_softening():
    """The softening reshape is above safe_edge only. At-or-past
    safe_edge behavior is unchanged: no scale is returned; the
    supervise loop's existing hard-stop branch fires."""
    fake = _fake_driver()
    # Push J6 to safe_edge - 0.01° (still inside) → soft returns floor.
    fake._joint_deg = [0.0, 0.0, 0.0, 0.0, 0.0, 195.13]
    scale_inside, *_ = EstunCodroidDriver._joint_limit_approach_scale_locked(
        fake, cur_frac=0.18)
    assert 0.0 < scale_inside <= 1.0
    # Push J6 past safe_edge — the soft path returns floor but the
    # supervise loop's hard-stop branch (checked BEFORE softening)
    # would have already fired. This test asserts the softening
    # function itself doesn't NaN or crash when past safe_edge.
    fake._joint_deg = [0.0, 0.0, 0.0, 0.0, 0.0, 199.9]
    scale_past, joint, *_ = EstunCodroidDriver._joint_limit_approach_scale_locked(
        fake, cur_frac=0.18)
    assert scale_past == fake._cart_joint_soft_floor_frac
    assert joint == 6


# ── (4b) Cause propagation: _build_stop_cause_locked ───────────

def test_build_stop_cause_extracts_joint_from_cart_limit_reason():
    fake = _fake_driver()
    fake._last_stop_ts = 12345.0
    tagged = 'cause=joint_limit: cart limit approach J6 at -192.50° ' \
             '(|>191.90°|, dyn margin 8.10° @ f=0.20)'
    cause = EstunCodroidDriver._build_stop_cause_locked(
        fake, tagged, prev_mode='continuous_cart', prev_index=2)
    assert cause['tag'] == 'joint_limit'
    assert cause['joint_index_1based'] == 6
    assert cause['joint_deg'] == -192.50
    assert cause['joint_limit_deg'] == 200.0
    assert cause['jog_mode'] == 'continuous_cart'
    assert cause['raw'] == tagged
    assert cause['ts'] == 12345.0


def test_build_stop_cause_freshness_deadman_has_no_joint():
    fake = _fake_driver()
    tagged = 'cause=freshness_deadman: hold staleness 0.21s'
    cause = EstunCodroidDriver._build_stop_cause_locked(
        fake, tagged, prev_mode='continuous_cart', prev_index=2)
    assert cause['tag'] == 'freshness_deadman'
    assert cause['joint_index_1based'] is None
    assert cause['joint_deg'] is None


def test_build_stop_cause_release_cmd_tag():
    fake = _fake_driver()
    tagged = 'cause=release_cmd: release cmd'
    cause = EstunCodroidDriver._build_stop_cause_locked(
        fake, tagged, prev_mode='continuous', prev_index=1)
    assert cause['tag'] == 'release_cmd'
    assert cause['joint_index_1based'] is None


# ── (4d) Freshness-deadman regression ─────────────────────────

def test_tag_stop_reason_freshness_deadman_unchanged():
    """The freshness-deadman reason string is the one thing today's
    3 residual stops-per-3-hours look like. This test pins the tag
    so a refactor of _STOP_REASON_PATTERNS doesn't drift it into a
    different bucket."""
    fake = _fake_driver()
    tagged = EstunCodroidDriver._tag_stop_reason(
        fake, 'hold staleness 0.21s')
    assert tagged.startswith('cause=freshness_deadman:')
    # And the round-trip through _build_stop_cause_locked keeps the tag.
    cause = EstunCodroidDriver._build_stop_cause_locked(
        fake, tagged, prev_mode='continuous_cart', prev_index=2)
    assert cause['tag'] == 'freshness_deadman'


def test_tag_stop_reason_cart_limit_still_maps_to_joint_limit():
    fake = _fake_driver()
    tagged = EstunCodroidDriver._tag_stop_reason(
        fake, 'cart limit approach J6 at -192.50°')
    assert tagged.startswith('cause=joint_limit:')


# ── Immediate publish on stop (Lesson 165: loud, not silent) ──

def test_stop_jog_locked_publishes_status_blob_immediately():
    """After the safety action lands, _stop_jog_locked calls
    _publish_status_blob() so the dashboard sees the fresh cause
    within one broadcast cycle (~40 ms) — not the up-to-1-second
    latency the 1 Hz mode-publish would impose."""
    fake = _fake_driver()
    # Simulate an active cart hold that gets stopped by the driver's
    # joint-limit hard-stop path.
    EstunCodroidDriver._stop_jog_locked(
        fake,
        reason='cart limit approach J6 at -192.50° (dyn margin 8.10°)')
    fake._publish_status_blob.assert_called_once()
    assert fake._last_stop_cause is not None
    assert fake._last_stop_cause['tag'] == 'joint_limit'
    assert fake._last_stop_cause['joint_index_1based'] == 6
    # Softening telemetry cleared on stop.
    assert fake._cart_softening is None

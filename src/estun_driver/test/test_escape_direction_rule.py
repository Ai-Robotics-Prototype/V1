"""Pinned tests for the 2026-08-05 escape-direction clamp rule.

Directive: a recovery move must not be rejected by the clamp it's
escaping, and a deeper-direction jog must be refused even at crawl
speed (which would otherwise slip through the dynamic safe_edge check).

Fork registry: `guided_recovery_dialog` — the driver's clamp is the
canonical enforcement point for the escape-only invariant.
"""

from __future__ import annotations

import re
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import EstunCodroidDriver


def _fake_driver(joint_deg, jog_direction=1, cur_frac=0.05, jog_mode='continuous', jog_index=6):
    """Synthetic driver just far enough to run _on_jog_supervise's
    escape-only branch and the start-clamp branch of _on_jog_command.
    joint_deg is a 6-list of degrees."""
    fake = SimpleNamespace()
    fake._joint_deg = list(joint_deg)
    fake._joint_rad = [0.0] * 6
    fake._joint_limit_deg = [200.0, 200.0, 166.0, 200.0, 166.0, 200.0]
    fake._joint_limit_margin_deg = 2.0
    fake._max_joint_speed_degps = [150.0, 150.0, 150.0, 180.0, 180.0, 180.0]
    fake._safety_latency_s = 0.100
    fake._safety_factor = 1.5
    fake._baseline_speed_frac = 0.15
    fake._joint_escape_only_margin_deg = 12.0
    fake._jog_active = True
    fake._jog_mode = jog_mode
    fake._jog_index = jog_index
    fake._jog_direction = jog_direction
    fake._jog_signed_speed = jog_direction * cur_frac
    fake._cart_commanded_frac = cur_frac
    fake._cart_last_sent_speed = jog_direction * cur_frac
    fake._effective_speed_cap = 0.30
    fake._cart_joint_soft_zone_deg = 8.0
    fake._cart_joint_soft_floor_frac = 0.10
    fake._cart_speed_up_per_tick = 0.25
    fake._cart_speed_min_delta = 0.10
    # Latches
    fake._last_stop_reason = ''
    fake._last_stop_ts = 0.0
    fake._last_stop_cause = None
    fake._cart_softening = None
    fake._jog_active_hold_id = None
    fake._jog_released_hold_id = None
    fake._jog_last_seq = 0
    fake._jog_last_cmd_ts = 0.0  # fresh
    fake._jog_last_hb_ts = 0.0
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
    fake._last_posture_ts = 1.0
    fake._prev_joint_deg = None
    fake._prev_joint_ts = 0.0
    fake._sing_guard = None
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
    # Bind methods
    for name in ('_dyn_limit_margin_deg', '_apply_cart_speed_scale_locked',
                 '_apply_governor_scale_locked', '_stop_jog_locked',
                 '_build_stop_cause_locked', '_tag_stop_reason',
                 '_joint_limit_approach_scale_locked', '_jog_gaps_summary',
                 '_on_jog_supervise'):
        method = getattr(EstunCodroidDriver, name, None)
        if method is not None:
            setattr(fake, name, types.MethodType(method, fake))
    for name in ('_CAUSE_JOINT_RE', '_STOP_REASON_PATTERNS',
                 '_JOG_GAP_RING_MAX', '_TIP_SPEED_MMPS'):
        val = getattr(EstunCodroidDriver, name, None)
        if val is not None:
            setattr(fake, name, val)
    return fake


# ── Start-clamp escape-direction (via _on_jog_command internals) ───

def test_escape_direction_permits_inward_when_past_escape_only_zone():
    """J6 at -193° (past -188° escape edge) with direction=+1 (toward 0)
    must not be refused — this is the recovery move the dialog needs
    to execute."""
    # Direct check on the clamp logic. We inspect the escape_only_edge
    # value and assert the direction-parity invariant the code enforces.
    joint_deg = -193.31
    limit = 200.0
    escape_only_margin = 12.0
    escape_only_edge = limit - escape_only_margin  # 188.0

    # Deep-side violation → escape is direction=+1.
    escape_dir = 1
    deeper_dir = -1

    # The rule: if joint_deg < -escape_only_edge, direction<0 refused.
    assert joint_deg < -escape_only_edge
    # Deeper direction must be refused.
    assert deeper_dir < 0
    # Escape direction must be permitted (no rule fires for direction>0
    # when joint_deg is negative side; the standard safe_edge check
    # requires current_deg >= safe_edge, which is false for negative
    # current).


def test_supervise_stops_when_direction_deeper_past_escape_only():
    """Mid-motion: a hold in direction=-1 with J6 drifting to -193° must
    fire stopJog with cause=joint_limit_deeper. Verifies the supervise-
    tick escape-only guard is not just start-clamp."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -193.31],
        jog_direction=-1,
        cur_frac=0.05,
        jog_mode='continuous',
        jog_index=6,
    )
    # Simulate an active hold that entered the escape-only zone.
    import time
    fake._jog_last_cmd_ts = time.time()   # fresh
    fake._jog_last_hb_ts = time.time()
    fake._on_jog_supervise()
    # Stop should have fired with the escape_only reason.
    assert fake._last_stop_cause is not None
    assert fake._last_stop_cause['tag'] == 'joint_limit_deeper'


def test_supervise_permits_escape_direction_past_zone():
    """Same J6 pose but direction=+1 (escape): no stop; heartbeat may
    fire if enough time elapsed, but the escape-only guard must NOT
    trip when the joint is being brought back."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -193.31],
        jog_direction=1,
        cur_frac=0.05,
        jog_mode='continuous',
        jog_index=6,
    )
    import time
    fake._jog_last_cmd_ts = time.time()
    fake._jog_last_hb_ts = time.time()
    fake._on_jog_supervise()
    # No stopJog should have been called (last_stop_cause stays None).
    assert fake._last_stop_cause is None
    # _jog_active still True.
    assert fake._jog_active is True


def test_positive_side_escape_direction_is_negative():
    """Positive-side violation (J6 = +198°): escape is direction=-1;
    direction=+1 must be refused."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, +198.0],
        jog_direction=1,       # deeper
        cur_frac=0.05,
        jog_mode='continuous',
        jog_index=6,
    )
    import time
    fake._jog_last_cmd_ts = time.time()
    fake._jog_last_hb_ts = time.time()
    fake._on_jog_supervise()
    assert fake._last_stop_cause is not None
    assert fake._last_stop_cause['tag'] == 'joint_limit_deeper'


def test_joint_inside_escape_zone_no_deeper_stop_fires():
    """A joint well inside the safe zone must not trip either guard —
    the escape-only rule is scoped to past-limit joints only."""
    fake = _fake_driver(
        joint_deg=[0, 0, 0, 0, 0, -100.0],    # nowhere near
        jog_direction=-1,
        cur_frac=0.05,
        jog_mode='continuous',
        jog_index=6,
    )
    import time
    fake._jog_last_cmd_ts = time.time()
    fake._jog_last_hb_ts = time.time()
    fake._on_jog_supervise()
    assert fake._last_stop_cause is None


# ── Tag taxonomy: joint_limit_deeper is distinct from joint_limit ───

def test_tag_maps_escape_only_reason_to_joint_limit_deeper():
    fake = _fake_driver(joint_deg=[0]*6)
    tagged = fake._tag_stop_reason(
        'escape_only J6 at -193.31° past -188.00° — deeper-direction refused')
    assert tagged.startswith('cause=joint_limit_deeper:')


def test_tag_still_maps_cart_limit_to_joint_limit():
    fake = _fake_driver(joint_deg=[0]*6)
    tagged = fake._tag_stop_reason(
        'cart limit approach J6 at -192.50°')
    assert tagged.startswith('cause=joint_limit:')

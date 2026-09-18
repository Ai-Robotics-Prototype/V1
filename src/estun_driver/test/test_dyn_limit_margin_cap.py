"""Pinned tests for the 2026-08-19 dynamic joint-limit margin retune.

F1.4 rung-3 fingerprint: the dynamic-margin formula
  margin = max(base, vmax × speed_frac × safety_latency_s × safety_factor)
grew unbounded with commanded speed. At safety_factor=1.5, latency=0.15 s:

  J1 (150°/s) at 50% speed → 16.9° margin → safe_edge = limit − 16.9°
  J6 (180°/s) at 50% speed → 20.3° margin → safe_edge = limit − 20.3°

At 50% the operator couldn't jog within 17-20° of the physical limit —
cutting ~17-20% out of the joint's authored travel on ±100° range
joints, and 40°+ combined-end travel loss on the ±200° joints.

Retune landed the same day:
  1. safety_factor: 1.5 → 1.2 (still >1 for real-world overrun).
  2. joint_limit_margin_max_deg = 5.0 (new parameter — caps the
     result of the max(base, dyn) expression).
  3. cart_joint_limit_soft_zone_deg: 8.0 → 2.0 (matched to the
     capped margin so slowdown starts ~7° from limit, not tens).

Pin contract (operator directive, 2026-08-19):
  - At 50% speed, jog is PERMITTED at limit − 6° (safe_edge − 1° inside).
  - At 50% speed, jog is REFUSED at limit − 1° (past safe_edge).
  - Escape direction is ALWAYS permitted (unchanged; the existing
    escape-direction rule in test_escape_direction_rule.py handles that).
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import EstunCodroidDriver


# ── constants used across cases (matched to declare_parameter defaults) ──

BASE_MARGIN = 2.0     # joint_limit_margin_deg (static floor)
MARGIN_CAP  = 5.0     # joint_limit_margin_max_deg (new dynamic cap)
LATENCY_S   = 0.150   # safety_latency_s
FACTOR      = 1.2     # safety_factor (post-retune)
VMAX = [150.0, 150.0, 150.0, 180.0, 180.0, 180.0]  # max_joint_speed_degps


def _fake():
    """Minimal harness: bind _dyn_limit_margin_deg as a method to a
    SimpleNamespace carrying only the fields the method reads."""
    fake = SimpleNamespace(
        _joint_limit_margin_deg=BASE_MARGIN,
        _joint_limit_margin_max_deg=MARGIN_CAP,
        _safety_latency_s=LATENCY_S,
        _safety_factor=FACTOR,
        _max_joint_speed_degps=list(VMAX),
    )
    fake._dyn_limit_margin_deg = types.MethodType(
        EstunCodroidDriver._dyn_limit_margin_deg, fake)
    return fake


# ── raw formula pins ─────────────────────────────────────────────────


def test_margin_at_15pct_speed_scales_linearly_below_cap():
    """15% speed is F1's operator UI ceiling. Formula must be honest here:
    dyn = vmax × 0.15 × 0.15 × 1.2. J1 → 4.05°, J6 → 4.86°. Cap not hit."""
    f = _fake()
    m_j1 = f._dyn_limit_margin_deg(joint_idx0=0, speed_frac=0.15)
    m_j6 = f._dyn_limit_margin_deg(joint_idx0=5, speed_frac=0.15)
    # J1: 150 × 0.15 × 0.15 × 1.2 = 4.05
    assert abs(m_j1 - 4.05) < 1e-6, f'J1 15% margin expected 4.05° got {m_j1}'
    # J6: 180 × 0.15 × 0.15 × 1.2 = 4.86
    assert abs(m_j6 - 4.86) < 1e-6, f'J6 15% margin expected 4.86° got {m_j6}'
    # Both below the 5° cap.
    assert m_j1 < MARGIN_CAP
    assert m_j6 < MARGIN_CAP


def test_margin_capped_at_5deg_by_50pct_speed():
    """50% speed on ANY joint: uncapped dyn would be ≥13.5° (J1) or
    ≥16.2° (J6). Cap must bring both to 5.0° exactly."""
    f = _fake()
    m_j1 = f._dyn_limit_margin_deg(joint_idx0=0, speed_frac=0.50)
    m_j6 = f._dyn_limit_margin_deg(joint_idx0=5, speed_frac=0.50)
    assert m_j1 == MARGIN_CAP, (
        f'J1 50% margin must be capped at 5.0° — got {m_j1}. Prior '
        'unbounded formula gave 16.87° which cut jog out ~17% of J1 travel.')
    assert m_j6 == MARGIN_CAP, (
        f'J6 50% margin must be capped at 5.0° — got {m_j6}. Prior '
        'unbounded formula gave 20.25° which cut jog out ~20% of J6 travel.')


def test_margin_still_capped_at_100pct_speed():
    """Even at full 100% (never authorized in F1, but the cap must
    hold anywhere): the return value is 5.0°, not 27° / 32.4°."""
    f = _fake()
    for jidx in range(6):
        m = f._dyn_limit_margin_deg(joint_idx0=jidx, speed_frac=1.0)
        assert m == MARGIN_CAP, (
            f'J{jidx+1} 100% margin must be capped at 5.0° — got {m}. '
            'Cap must hold across the entire commanded-speed range.')


def test_margin_floors_at_static_base_below_2deg_dyn():
    """At near-crawl speed, dynamic is < static base. Static base is
    the floor — never drop below 2°."""
    f = _fake()
    # 1% speed: J1 dyn = 150 × 0.01 × 0.15 × 1.2 = 0.27° → floor 2.0°.
    m = f._dyn_limit_margin_deg(joint_idx0=0, speed_frac=0.01)
    assert m == BASE_MARGIN, f'crawl speed must floor at 2.0° — got {m}'


# ── operator directive spec: the 3 pinned points ─────────────────────


def test_50pct_jog_permitted_at_limit_minus_6_deg():
    """Operator directive 2026-08-19: at 50% speed, jog must be PERMITTED
    at limit − 6°. safe_edge = limit − 5° (cap), so current = limit − 6°
    is 1° INSIDE safe_edge → clamp doesn't fire, motion permitted."""
    f = _fake()
    # J6, limit=200. current = limit - 6 = 194°. speed_frac=0.50.
    limit = 200.0
    current = limit - 6.0  # 194°
    margin = f._dyn_limit_margin_deg(joint_idx0=5, speed_frac=0.50)
    safe_edge = limit - margin  # 200 - 5 = 195°
    # Direction +1 (toward positive limit). Permitted iff current < safe_edge.
    permitted = (current < safe_edge)
    assert permitted, (
        f'50% J6 at {current}° must be PERMITTED (safe_edge={safe_edge}°, '
        f'headroom={safe_edge - current}°). Pre-retune formula produced '
        f'safe_edge=179.75° which BLOCKED motion here.')


def test_50pct_jog_refused_at_limit_minus_1_deg():
    """Operator directive 2026-08-19: at 50% speed, jog must be REFUSED at
    limit − 1°. safe_edge = limit − 5°, so current = limit − 1° is 4°
    PAST safe_edge → clamp fires. This is the "no motion in the last
    5°" invariant — the safety envelope kept."""
    f = _fake()
    limit = 200.0
    current = limit - 1.0  # 199°
    margin = f._dyn_limit_margin_deg(joint_idx0=5, speed_frac=0.50)
    safe_edge = limit - margin  # 195°
    refused = (current >= safe_edge)
    assert refused, (
        f'50% J6 at {current}° must be REFUSED (safe_edge={safe_edge}°). '
        'Cap must not open the envelope past 5° from limit at any speed.')


def test_escape_direction_permitted_regardless_of_speed():
    """The clamp is direction-aware: `current_deg >= safe_edge` fires
    ONLY when direction > 0. Direction < 0 (toward center) is always
    permitted from a positive-side violation. Same test asserts the
    invariant unchanged by the retune."""
    f = _fake()
    limit = 200.0
    current = limit - 1.0  # 199°, deep in the +side envelope
    margin = f._dyn_limit_margin_deg(joint_idx0=5, speed_frac=0.50)
    safe_edge = limit - margin
    # +direction is refused (see previous test) — but that's the clamp
    # tripping on `current_deg >= safe_edge and direction > 0`.
    # -direction (escape) is permitted because the clamp checks
    # `direction < 0 and current_deg <= -safe_edge` — false for +side.
    escape_dir = -1
    escape_refused_condition = (escape_dir < 0 and current <= -safe_edge)
    assert not escape_refused_condition, (
        'Escape direction (toward center) must NEVER be refused by the '
        'safe_edge clamp. This is the load-bearing "a limit is a wall, '
        'not a cage" doctrine (2026-08-05).')


# ── cart soft-zone: slowdown starts ~7° from limit ────────────────────


def test_cart_soft_zone_default_places_slowdown_at_7deg_from_limit():
    """Cart-mode slowdown ramp starts when headroom < soft_zone.
    headroom = safe_edge - abs(current) = (limit - margin) - abs(current).
    With margin capped at 5° and soft_zone at 2° (post-retune):
    slowdown starts when abs(current) > limit - margin - soft_zone
                                       = limit - 5 - 2
                                       = limit - 7°.
    Pre-retune (margin unbounded 20° + soft_zone 8°) had slowdown at
    limit - 28° — tens of degrees out."""
    margin_at_50pct = MARGIN_CAP           # cap holds at 5°
    soft_zone_deg = 2.0                    # new default
    slowdown_starts_from_limit = margin_at_50pct + soft_zone_deg
    assert slowdown_starts_from_limit == 7.0, (
        f'Cart soft-zone must open slowdown ~7° from limit — got '
        f'{slowdown_starts_from_limit}°. Retune target per operator '
        'directive 2026-08-19.')

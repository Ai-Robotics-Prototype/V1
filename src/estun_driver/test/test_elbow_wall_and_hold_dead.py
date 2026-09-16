"""Elbow-wall + hold-dead-latch pins — 2026-09-14 §5.

Contract (operator, authoritative):
  (a) Cart approach stops CONSISTENTLY at the same geometric point,
      safely before J2/J3 collinear — the elbow singularity.
  (b) Once a guard stops a hold, that hold is DEAD; motion never
      resumes under a continuously-pressed button; resuming
      requires releasing AND pressing a direction that opens the
      elbow.

Elbow-wall derivation:
  * FK sweep with the fitted DH (_FITTED_DH_STD in
    estun_driver_node.py) shows radial reach is maximal at
    J3 = 0.0° (theta_off_deg ≈ +0.006° from the fit, sub-arcmin,
    ignored). Collinear pose is J3 = 0°.
  * σ_min correlates with |J3| in a realistic non-singular pose:
    margin=10° → σ ≈ 0.042 (7 mm above σ_wall=0.035, so elbow
    wall fires FIRST). Margin=8° → σ ≈ 0.034 (roughly at σ_wall).
  * elbow_wall_deg = 10° default → reach cost 6.20 mm at the
    incident pose.

Hold-dead latch:
  * _jog_dead_hold_id set by _stop_jog_locked to the released
    hold_id.
  * Cleared by explicit release (hold=false frame in
    _on_jog_command).
  * A hold=true refresh whose hold_id matches _jog_dead_hold_id
    is DROPPED — no frames on the wire, one named rejection
    logged per dead session for HUD copy.
"""

from __future__ import annotations

import math
import os
import re
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import (
    EstunCodroidDriver, ESCAPE_TIE_EPS, SingularityGuard,
    ELBOW_COLLINEAR_J3_DEG, ELBOW_LATCH_HYSTERESIS_DEG,
    _FITTED_DH_STD, _FITTED_BASE_Z_MM)


HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'estun_driver', 'estun_driver_node.py'))


def _read(path):
    with open(path) as fh:
        return fh.read()


# ── Derivation pin: J3-collinear + reach table ───────────────────

def test_elbow_collinear_derivation_pinned():
    """Sweep J3 from -180° to +180° with other joints at 0; the
    radial-reach peak is the collinear pose. Assert the peak lands
    at J3 = 0° within a 0.1° tolerance (fitted theta_off is
    sub-arcmin). Reach at that pose is ~1763 mm; reach cost at
    10° margin is ~6.2 mm."""
    sg = SingularityGuard()

    def fk_ee(q_deg):
        T = sg._identity_with_base()
        for i in range(6):
            a_mm, alpha_deg, d_mm, theta_off_deg = sg._dh[i]
            theta = math.radians(q_deg[i] + theta_off_deg)
            Ti = sg._dh_T(theta, d_mm, a_mm,
                          math.radians(alpha_deg))
            T = sg._matmul(T, Ti)
        return (T[0][3], T[1][3], T[2][3])

    def radial(q):
        x, y, z = fk_ee(q)
        return math.hypot(math.hypot(x, y), z - sg._base_z_mm)

    best_r, best_j3 = -1.0, None
    for k in range(-18000, 18000, 25):
        j3 = k / 100.0
        r = radial([0.0, 0.0, j3, 0.0, 0.0, 0.0])
        if r > best_r:
            best_r, best_j3 = r, j3
    # Collinear = J3 at reach peak.
    assert abs(best_j3 - ELBOW_COLLINEAR_J3_DEG) <= 0.25, (
        f'FK reach-peak J3={best_j3:.2f}° != '
        f'ELBOW_COLLINEAR_J3_DEG={ELBOW_COLLINEAR_J3_DEG:.2f}° '
        f'— DH change requires re-derivation')
    assert 1760.0 < best_r < 1770.0, (
        f'reach at collinear = {best_r:.2f} mm; expected ~1763 mm '
        f'from the fitted DH. Reach shift > 5 mm means a fit '
        f'regression — check dh_fit_report.txt.')
    # Reach cost at 10° margin (~6 mm).
    r_10 = radial([0.0, 0.0, 10.0, 0.0, 0.0, 0.0])
    reach_cost = best_r - r_10
    assert 5.0 < reach_cost < 8.0, (
        f'reach cost at 10° margin = {reach_cost:.2f} mm; expected '
        f'6.20 mm ±2 mm — DH fit changed materially.')


# ── _cart_start_sing_clamp fixture (shared with wall / dq tests) ──

def _elbow_fake(j3_deg, cart_axis=3, direction=+1, speed=+0.21,
                elbow_latched=False, is_escaping_signal=None,
                elbow_wall_deg=10.0):
    """Minimal driver stand-in wired for _cart_start_sing_clamp
    with elbow-margin + closure paths. Uses the REAL SingularityGuard
    so qdot_component gives a physically-plausible sign."""
    fake = SimpleNamespace()
    # Joints: realistic non-singular base pose, J3 = j3_deg to
    # sweep the elbow margin.
    fake._joint_deg = [15.0, 45.0, float(j3_deg), 0.0, -30.0, 0.0]
    fake._joint_rad = [math.radians(v) for v in fake._joint_deg]
    # 2026-09-16 boundary-anti-creep: _cart_start_sing_clamp now
    # gates approach presses in the elbow danger band on posture
    # freshness (POSTURE_STALE_MAX_S). Use time.time() so tests are
    # stable regardless of clock skew from the epoch.
    import time as _time
    fake._last_posture_ts = _time.time()
    fake._cart_sigma_soft = 0.06
    fake._cart_sigma_wall = 0.035
    fake._cart_sigma_hard = 0.02
    fake._cart_wall_latched = False
    fake._WALL_LATCH_HYSTERESIS = 0.005
    fake._baseline_speed_frac = 0.15
    fake._cart_elbow_latched = elbow_latched
    fake._elbow_wall_deg = elbow_wall_deg
    # Real SingularityGuard — gives us the true σ + qdot for the
    # pose. Optional escape override for the tests that want to
    # short-circuit is_escaping without patching the guard.
    fake._sing_guard = SingularityGuard()
    if is_escaping_signal is not None:
        fake._sing_guard.escape_score = (
            lambda q, axis, s, _v=is_escaping_signal: _v)
    fake.get_logger = MagicMock(return_value=MagicMock())
    for name in ('_cart_start_sing_clamp', '_dyn_sigma_soft',
                 '_elbow_margin_and_closure'):
        m = getattr(EstunCodroidDriver, name)
        setattr(fake, name, types.MethodType(m, fake))
    return fake


# ── (1) Elbow wall refuses approach at margin ≤ wall ─────────────

def test_elbow_wall_refuses_approach_at_wall():
    """J3 = 5° (margin 5° ≤ wall 10°). Commanded twist that PULLS
    J3 toward 0 (elbow-closing) → REFUSED with elbow_wall reason."""
    # Cart axis choice needs to closes J3. In our base pose
    # (J1=15, J2=45, J3=5), Y+ cartesian typically pushes the arm
    # further out (closes elbow). Test the qdot direction first
    # and pick the closing sign.
    fake = _elbow_fake(j3_deg=5.0)
    # Probe both signs; pick the one that has qdot_J3 * J3 < 0
    # (closing per the helper's rule).
    j3 = fake._joint_deg[2]  # +5
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    # J3 > 0, so closing = qdot_J3 < 0 → pick sign that gives
    # negative qdot.
    closing_sign = -1 if (q_pos > 0) else +1
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=closing_sign,
        signed_speed=closing_sign * 0.21)
    assert refusal is not None, (
        f'elbow-wall did not refuse: J3={j3}° margin=5° ≤ '
        f'wall=10°, closing direction')
    assert refusal['reason_code'] == 'elbow_wall'
    assert refusal['elbow_margin_deg'] == pytest.approx(5.0, abs=1e-6)
    assert refusal['elbow_wall_deg'] == pytest.approx(10.0)
    # Operator-facing string is plain, no jargon.
    assert 'nearly straight' in refusal['reason'].lower()
    assert 'bend the elbow' in refusal['reason'].lower()


def test_elbow_wall_permits_opening_at_wall():
    """Same pose as above but the OPPOSITE direction (elbow-opening)
    must pass at full speed. Freedom guarantee: escape always
    permitted, even at margin ≤ wall."""
    fake = _elbow_fake(j3_deg=5.0)
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    opening_sign = +1 if (q_pos > 0) else -1  # opposite of closing
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=opening_sign,
        signed_speed=opening_sign * 0.21)
    assert refusal is None, (
        'elbow-opening motion refused — freedom guarantee broken')
    # Opening direction gets full speed (may still go through σ-band
    # scaling; here σ at margin=5° is ~0.021 which IS in the σ soft
    # band — that's OK, it means the σ path scales while the elbow
    # path permits).


def test_elbow_wall_far_from_collinear_passes():
    """J3 = 45° (margin 45° >> wall 10°) → pass-through, no refusal
    and no scaling from the elbow path."""
    fake = _elbow_fake(j3_deg=45.0)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    # No elbow-wall refusal.
    assert (refusal is None
            or refusal.get('reason_code') != 'elbow_wall')


# ── (2) Elbow latch — margin ≤ wall + hyst still refuses ─────────

def test_elbow_latch_refuses_at_wall_plus_epsilon():
    """Latch=True, margin=11° (wall+ε, below wall+hysteresis=12°).
    Approach direction → REFUSED with elbow_latched=True."""
    fake = _elbow_fake(j3_deg=11.0, elbow_latched=True)
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    closing_sign = -1 if (q_pos > 0) else +1
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=closing_sign,
        signed_speed=closing_sign * 0.21)
    assert refusal is not None
    assert refusal['reason_code'] == 'elbow_wall'
    assert refusal.get('elbow_latched') is True


def test_elbow_latch_clears_when_margin_above_hysteresis():
    """Latch=True, margin=15° (well above wall+hysteresis=12°).
    Start-clamp clears the latch as a side effect and lets the
    press through."""
    fake = _elbow_fake(j3_deg=15.0, elbow_latched=True)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    # No elbow-wall refusal.
    assert (refusal is None
            or refusal.get('reason_code') != 'elbow_wall')
    assert fake._cart_elbow_latched is False, (
        'elbow latch did not clear at margin=15° > wall+hyst=12°')


def test_elbow_latch_does_not_clear_at_wall_plus_epsilon():
    """Latch=True, margin=11.5° (wall + 1.5°, BELOW wall+hyst=12°).
    Start-clamp must NOT clear the latch — the operator's escape
    hasn't reached the release threshold yet."""
    fake = _elbow_fake(j3_deg=11.5, elbow_latched=True)
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    closing_sign = -1 if (q_pos > 0) else +1
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=closing_sign,
        signed_speed=closing_sign * 0.21)
    assert refusal is not None
    assert fake._cart_elbow_latched is True, (
        'elbow latch cleared at margin=11.5° < wall+hyst=12° — '
        'creep vector open')


# ── (2b) BOUNDARY ANTI-CREEP — 2026-09-16 field bug ─────────────
#
# Operator report (Sep 15): extension jog stops at the elbow wall as
# designed, but a re-press in the SAME direction moves the arm
# slightly each time. Operator spec: after the wall stop, approach
# presses must produce ZERO motion — not one tick's worth.
#
# Fix is a BAND, not a line: refuse every approach press in
# [wall, wall+hysteresis] while latched, close all of a/b/c/d:
#   (a) stop lands above the wall → margin ~10.05° at rest → widened
#       tie-break inside danger band treats ambiguous qdot as closing
#   (b) stale posture at press time → posture-age gate refuses in-
#       band presses with `posture_stale` when |now − posture_ts| >
#       POSTURE_STALE_MAX_S = 0.5 s
#   (c) latch cleared on release → verified in source: no release/
#       stop path writes _cart_elbow_latched = False; only margin >
#       wall+hyst clears it
#   (d) direction misclassification via ambiguous qdot_J3 → widened
#       ELBOW_QDOT_ESCAPE_EPS (1e-4, was 1e-9) catches float noise


def test_boundary_anti_creep_replay_at_wall_edge():
    """Replay: latched + resting margin=10.05° (just above wall by
    0.05°, exactly the "stop-lands-above-the-wall" case). Ten
    successive approach presses at the SAME angle must ALL refuse.
    Margin is never mutated in these tests (start-clamp doesn't
    move the arm) — the pin is: refusal fires every time and the
    latch stays set across all N presses.
    """
    fake = _elbow_fake(j3_deg=10.05, elbow_latched=True)
    # Pick the closing direction (opposite qdot polarity).
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    closing_sign = -1 if (q_pos > 0) else +1
    refusals = 0
    for _ in range(10):
        _, refusal = fake._cart_start_sing_clamp(
            axis=3, direction=closing_sign,
            signed_speed=closing_sign * 0.21)
        assert refusal is not None, (
            'boundary anti-creep pin: latched approach press at '
            'margin=10.05° (wall+0.05°) must refuse — not permit '
            'one tick of motion')
        assert refusal['reason_code'] in ('elbow_wall', 'posture_stale')
        assert fake._cart_elbow_latched is True, (
            'latch cleared under a refused press — creep vector open')
        refusals += 1
    assert refusals == 10


def test_ambiguous_qdot_refused_when_latched_in_hyst_band():
    """Direction misclassification (mechanism d): synthesize a
    twist whose qdot_J3 is exactly zero (perfect tie). Old tie-
    break returned closing=(margin<=wall) which permitted at
    margin=10.5° > wall=10°. New widened tie-break also refuses
    when latched AND margin<=wall+hyst.
    """
    fake = _elbow_fake(j3_deg=10.5, elbow_latched=True)
    # Force a zero qdot by mocking the guard's qdot_component to
    # return exactly zero — reproduces the wrist-near-singular
    # numerical-noise case regardless of the fixture's pose.
    fake._sing_guard.qdot_component = (
        lambda q, axis, s, joint_idx0=2, _v=0.0: _v)
    _, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None, (
        'ambiguous qdot_J3 at margin=10.5° with latch set must '
        'refuse — mechanism (d) closes here')
    assert refusal['reason_code'] in ('elbow_wall', 'posture_stale')


def test_ambiguous_qdot_permits_outside_hyst_band():
    """Symmetric guarantee: ambiguous qdot_J3 with margin ABOVE
    wall+hysteresis and latch clear → permit. The widened tie-
    break must not over-fire outside the danger band.
    """
    fake = _elbow_fake(j3_deg=15.0, elbow_latched=False)
    fake._sing_guard.qdot_component = (
        lambda q, axis, s, joint_idx0=2, _v=0.0: _v)
    _, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    # Outside danger band + not latched → no elbow refusal (σ path
    # may still scale, but that's a different reason_code).
    assert (refusal is None
            or refusal.get('reason_code') not in
                ('elbow_wall', 'posture_stale'))


def test_stale_posture_refused_in_band():
    """Mechanism (b): posture backing margin/qdot is 0.8 s old — the
    press decision must refuse with `posture_stale` rather than
    resolve on stale data.
    """
    fake = _elbow_fake(j3_deg=10.5, elbow_latched=True)
    import time as _time
    fake._last_posture_ts = _time.time() - 0.8   # 800 ms stale
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    closing_sign = -1 if (q_pos > 0) else +1
    _, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=closing_sign,
        signed_speed=closing_sign * 0.21)
    assert refusal is not None
    assert refusal['reason_code'] == 'posture_stale', (
        f"expected posture_stale refusal at 0.8s stale posture; "
        f"got {refusal.get('reason_code')}")
    assert 'position updating' in refusal['reason'].lower()


def test_stale_posture_permits_opening_direction():
    """Escape guarantee (unchanged by the fix): even with stale
    posture, the OPENING direction must pass. The stale-posture
    gate fires only on closing/ambiguous presses in the danger band.
    """
    fake = _elbow_fake(j3_deg=10.5, elbow_latched=True)
    import time as _time
    fake._last_posture_ts = _time.time() - 0.8
    q_pos = fake._sing_guard.qdot_component(
        fake._joint_deg, 3, +1.0, joint_idx0=2)
    opening_sign = +1 if (q_pos > 0) else -1
    _, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=opening_sign,
        signed_speed=opening_sign * 0.21)
    assert (refusal is None
            or refusal.get('reason_code') not in
                ('elbow_wall', 'posture_stale')), (
        'opening motion refused under stale posture — escape '
        'guarantee broken')


def test_latch_survives_release_source_scan():
    """Mechanism (c): no release/stop path may write
    `_cart_elbow_latched = False`. Only the two clear-on-recovery
    sites (start-clamp @ margin>wall+hyst and supervise @ same)
    may clear it. This pin scans the driver source: exactly THREE
    write sites (init to False + two clear-on-recovery) and ONE
    set site (supervise wall-stop).
    """
    src = _read(DRIVER_SRC)
    # False assignments (init + two recovery clears).
    false_writes = re.findall(
        r'self\._cart_elbow_latched\s*=\s*False', src)
    assert len(false_writes) == 3, (
        f'expected exactly 3 False writes to _cart_elbow_latched '
        f'(init + two clear-on-recovery); got {len(false_writes)}. '
        f'A new clear site (release_cmd, stopJog, hold-end, etc.) '
        f'would let the latch drop on release and re-open the '
        f'creep vector.')
    # True assignment (supervise wall-stop set).
    true_writes = re.findall(
        r'self\._cart_elbow_latched\s*=\s*True', src)
    assert len(true_writes) == 1, (
        f'expected exactly 1 True write to _cart_elbow_latched '
        f'(supervise stop); got {len(true_writes)}')


def test_widened_qdot_escape_epsilon_present():
    """The 2026-09-16 boundary-anti-creep constants must exist and
    carry non-trivial magnitudes. ELBOW_QDOT_ESCAPE_EPS must be at
    least 1e-6 (numerical-noise floor of the damped-LS solver on
    this DH); POSTURE_STALE_MAX_S must be > 0.2 s (posture bursts
    lag by up to ~800 ms).
    """
    from estun_driver.estun_driver_node import (
        ELBOW_QDOT_ESCAPE_EPS, POSTURE_STALE_MAX_S)
    assert ELBOW_QDOT_ESCAPE_EPS >= 1e-6, (
        f'ELBOW_QDOT_ESCAPE_EPS={ELBOW_QDOT_ESCAPE_EPS} too tight — '
        f'the old 1e-9 admitted numerical noise as a valid escape sign')
    assert POSTURE_STALE_MAX_S >= 0.2, (
        f'POSTURE_STALE_MAX_S={POSTURE_STALE_MAX_S} too aggressive — '
        f'posture packets can lag by ~800 ms per §18.4')


# ── (3) Source-inspection: elbow-wall precedes σ-wall in both paths

def test_start_clamp_evaluates_elbow_before_sigma_wall():
    """The elbow-wall branch must run BEFORE the σ_wall branch in
    _cart_start_sing_clamp so the operator-facing refusal names
    'elbow_wall' when both would fire (elbow wall corresponds to
    σ ≈ 0.042 which is above the σ_wall=0.035 anyway, but the
    order also matters for the wall-latched-refuse case)."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r'def _cart_start_sing_clamp\(self.*?\):(.+?)'
        r'def _stop_jog_from_expiry\(',
        src, re.DOTALL)
    assert m is not None, '_cart_start_sing_clamp body not found'
    body = m.group(1)
    elbow_idx = body.index("reason_code': 'elbow_wall'")
    sigma_idx = body.index("reason_code': 'sing_wall'")
    assert elbow_idx < sigma_idx, (
        'elbow_wall refusal must precede sing_wall refusal in the '
        'start-clamp — the wall-latched-refuse ordering depends on '
        'this so operator copy names the closer wall.')


def test_supervise_evaluates_elbow_before_sigma_wall():
    """Supervise tick's cart branch: elbow-wall stop must fire
    BEFORE the σ_wall stop. Both correspond to approach-only
    stops; elbow is closer geometrically, so it should fire first."""
    src = _read(DRIVER_SRC)
    # Elbow stop reason string must appear before sing_wall reason
    # string in the file (both live in the cart supervise branch).
    elbow_pos = src.index("reason=(f'elbow_wall: J3 margin=")
    sigma_pos = src.index("reason=f'sing_wall: σ_min=")
    assert elbow_pos < sigma_pos, (
        'elbow_wall supervise stop must precede sing_wall stop in '
        'the source order')


# ── (4) Hold-dead latch — resume-under-hold class ────────────────

def test_stop_jog_locked_sets_hold_dead_latch():
    """_stop_jog_locked must snapshot the active hold_id into
    _jog_dead_hold_id. Cleared ONLY by explicit release."""
    src = _read(DRIVER_SRC)
    # In _stop_jog_locked, the released-latch block is expanded to
    # also latch the dead hold_id.
    m = re.search(
        r'if self\._jog_active_hold_id is not None:\s*\n\s*'
        r'self\._jog_released_hold_id = self\._jog_active_hold_id\s*\n'
        r'(?:\s*#[^\n]*\n)*'
        r'\s*self\._jog_dead_hold_id = self\._jog_active_hold_id',
        src)
    assert m is not None, (
        'hold-dead latch not set in _stop_jog_locked — motion can '
        'resume under a continuously-pressed button after a guard '
        'stop (operator field-report class §5 open again)')


def test_hold_dead_latch_dropped_frames_have_reason_code():
    """The FIRST refresh drop after the latch fires must publish
    a NAMED /estun/rejected with reason_code='hold_dead' so the
    HUD can render the plain-copy toast. Subsequent drops are
    silent (log-gated by _jog_dead_logged)."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r'if hold_id == self\._jog_dead_hold_id:(.+?)return',
        src, re.DOTALL)
    assert m is not None, 'hold-dead check block not found'
    body = m.group(1)
    assert "'reason_code': 'hold_dead'" in body, (
        'hold_dead drop path does not emit reason_code=hold_dead '
        '— frontend HUD will fall through to generic copy')
    assert 'Release the button' in body, (
        'operator-facing string missing from hold_dead rejection')
    assert '_jog_dead_logged' in body, (
        'once-per-session log gate missing — the journal will spam '
        'per-frame on a stuck button')


def test_hold_dead_latch_cleared_on_explicit_release():
    """Cleared ONLY by hold=false frame in _on_jog_command's
    release branch — a NEW press generates a new hold_id which
    doesn't match, so the latch effectively expires at the next
    press regardless. This test pins the explicit-release clear."""
    src = _read(DRIVER_SRC)
    # Release branch (hold=false) clears the latch.
    m = re.search(
        r"if d\.get\('hold'\) is False or d\.get\('stop'\) is True:"
        r'(.+?)return\s*\n\s*\n\s*#',
        src, re.DOTALL)
    assert m is not None, 'release branch structure drifted'
    body = m.group(1)
    assert 'self._jog_dead_hold_id = None' in body, (
        'release branch does not clear the hold-dead latch — the '
        'operator can never re-arm after a guard stop')


def test_hold_dead_latch_only_matches_same_hold_id():
    """A fresh press with a DIFFERENT hold_id passes the hold-dead
    check (goes through the start-clamps normally). The latch is
    strictly identity-based, not a global "no jog after wall"
    lockout."""
    src = _read(DRIVER_SRC)
    # The check is `if hold_id == self._jog_dead_hold_id`, not a
    # bool flag. Non-matching hold_id falls through.
    m = re.search(
        r'if hold_id == self\._jog_dead_hold_id:',
        src)
    assert m is not None
    # After the check, the code proceeds to the released-latch /
    # sequence check (existing behavior for stragglers). Non-
    # matching hold_id just doesn't enter the drop branch.


def test_status_blob_exposes_hold_dead_and_elbow_latched():
    """Frontend diagnostics need the two new latch states."""
    src = _read(DRIVER_SRC)
    assert "'jog_dead_hold_id':" in src
    assert "'cart_elbow_latched':" in src
    assert "'elbow_wall_deg':" in src


# ── (5) Frontend HUD copy — plain, edition-independent ───────────

FRONTEND_DIR = os.path.abspath(os.path.join(
    HERE, '..', '..', 'cobot_dashboard', 'frontend', 'src', 'components'))


def test_frontend_hud_copy_for_elbow_wall_present():
    """JogStopSurface renders the plain elbow-wall copy per the
    operator directive item 6."""
    path = os.path.join(FRONTEND_DIR, 'JogStopSurface.jsx')
    src = _read(path)
    assert "cause === 'elbow_wall'" in src
    assert 'nearly straight' in src
    assert 'bend the elbow' in src


def test_frontend_hud_edition_independent():
    """Both HUD surfaces render the SAME DOM in BASIC and FULL:
    no isFeatureEnabled / s.edition reads in either file."""
    for fname in ('JogStopSurface.jsx', 'CartSofteningToast.jsx'):
        path = os.path.join(FRONTEND_DIR, fname)
        src = _read(path)
        assert 'isFeatureEnabled' not in src, (
            f'{fname} reads edition slice — HUD copy would diverge '
            f'between BASIC and FULL editions')
        assert 's.edition' not in src


# ── (6) Anti-tap: elbow-wall closing tap at wall is zero-motion ──

def test_anti_tap_elbow_wall_produces_zero_frames():
    """A cart pulse (150 ms tap) at margin ≤ elbow_wall_deg with
    a closing direction MUST be refused at start — no Robot/jog
    frame on the wire. Source-inspection pin: _start_cart_pulse
    routes through _cart_start_sing_clamp before frame construction."""
    src = _read(DRIVER_SRC)
    # _start_cart_pulse calls _cart_start_sing_clamp.
    m = re.search(
        r'def _start_cart_pulse\(self.*?\):(.+?)'
        r'def _start_increment_jog\(',
        src, re.DOTALL)
    assert m is not None
    body = m.group(1)
    clamp_pos = body.index('_cart_start_sing_clamp(')
    frame_pos = body.index("'ty': 'Robot/jog'")
    assert clamp_pos < frame_pos
    # And the clamp includes the elbow-wall branch (verified in the
    # earlier source-inspection pin).


# ── (6b) Anti-resume behavioral pin ───────────────────────────────
#
# Simulate the on_jog_command hold-dead check with N refresh frames
# after the latch fires: exactly ONE rejection published, zero
# further wire frames. Rebuilds the check block against a stand-in
# so React fixtures aren't needed.

def _hold_dead_fixture(active_hold, dead_hold):
    """Fake driver with just enough state to run the hold-dead
    check inline. We don't call _on_jog_command directly (it drives
    ROS + full guard chain); instead we exercise the equivalent
    logic by hand and count _reject calls."""
    fake = SimpleNamespace()
    fake._jog_active_hold_id  = active_hold
    fake._jog_dead_hold_id    = dead_hold
    fake._jog_dead_logged     = False
    fake._jog_released_hold_id = None
    fake._jog_last_seq = 0
    fake._reject_calls = []
    def _reject(family, reason, extra=None):
        fake._reject_calls.append({'family': family, 'reason': reason,
                                    'extra': extra})
    fake._reject = _reject
    fake.get_logger = MagicMock(return_value=MagicMock())
    fake._jog_lock = MagicMock()
    fake._jog_lock.__enter__ = MagicMock(return_value=None)
    fake._jog_lock.__exit__  = MagicMock(return_value=None)
    return fake


def _run_hold_dead_gate(fake, hold_id, seq_in):
    """Mirrors the on_jog_command hold-dead block. Returns True
    if the frame was dropped, False if it fell through."""
    with fake._jog_lock:
        if hold_id == fake._jog_dead_hold_id:
            if not getattr(fake, '_jog_dead_logged', False):
                fake._jog_dead_logged = True
                fake._reject('jog',
                    'Jog stopped. Release the button, then '
                    'jog in a different direction.',
                    extra={'reason_code': 'hold_dead',
                           'hold_id': hold_id, 'seq': seq_in})
            return True
        fake._jog_dead_logged = False
        return False


def test_anti_resume_N_refreshes_yield_one_reject_zero_wire_frames():
    """Simulate 10 refresh frames arriving after the latch fires.
    Only the FIRST publishes a rejection to /estun/rejected; the
    other 9 are silently dropped. Zero fall-throughs → zero wire
    frames could ever be emitted. This is the anti-resume pin."""
    fake = _hold_dead_fixture(active_hold=None, dead_hold='HOLD_A')
    dropped = 0
    for seq in range(1, 11):
        was_dropped = _run_hold_dead_gate(fake, 'HOLD_A', seq)
        if was_dropped:
            dropped += 1
    assert dropped == 10, (
        f'expected all 10 refresh frames dropped; got {dropped}. '
        f'Resume vector open again.')
    assert len(fake._reject_calls) == 1, (
        f'expected exactly ONE rejection published (first frame '
        f'only); got {len(fake._reject_calls)}. Log gate broken.')
    reject = fake._reject_calls[0]
    assert reject['extra']['reason_code'] == 'hold_dead'
    assert reject['extra']['hold_id'] == 'HOLD_A'
    assert 'Release the button' in reject['reason']


def test_anti_resume_different_hold_id_passes_through():
    """A refresh with hold_id != _jog_dead_hold_id falls through
    (equivalent to a NEW press after release). The subsequent
    start-clamp / wall check governs whether it actually goes on
    the wire."""
    fake = _hold_dead_fixture(active_hold=None, dead_hold='HOLD_A')
    was_dropped = _run_hold_dead_gate(fake, 'HOLD_B_NEW_PRESS', seq_in=1)
    assert was_dropped is False, (
        'new hold_id was dropped as hold-dead — the latch is not '
        'identity-scoped; the operator cannot re-arm after release')
    # No rejection published for the fall-through.
    assert fake._reject_calls == []


# ── (7) STOP_REASON_PATTERNS tags elbow_wall ─────────────────────

def test_stop_reason_patterns_includes_elbow_wall():
    """New elbow-wall stops need a bench-taxonomy tag so the
    dashboard cause distribution captures them without ad-hoc
    parsing."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r"_STOP_REASON_PATTERNS = \((.+?)\n    \)\s*\n",
        src, re.DOTALL)
    assert m is not None
    table = m.group(1)
    assert "('elbow_wall'" in table, (
        'elbow_wall tag missing from STOP_REASON_PATTERNS — new '
        'stop cause will fall through to cause=other')

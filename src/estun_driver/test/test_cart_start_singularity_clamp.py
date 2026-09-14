"""Field-incident regression pin — cart start-time singularity clamp.

Incident 2026-09-14 (operator: alarm 2015 on J3 after repeated
Cartesian presses at full arm extension):

  The continuous-cartesian start path (_start_or_refresh_continuous
  cart branch + _start_cart_pulse) committed the initial Robot/jog
  frame at the operator-requested speed WITHOUT running the σ
  singularity governor. Between the initial frame and the first
  supervise tick (~50 ms cadence) the controller's IK amplified
  per-joint velocity into an acceleration-jump alarm at σ ≈ 0.02.

  Log evidence:
    * driver log 10:33:36..10:33:43 shows σ trajectory
      0.0838 → 0.0729 → 0.0560 → 0.0432 → 0.0399 → 0.0394 → 0.0292
      → 0.0256 → 0.0255 → 0.0229 → alarm 2015 on J3 → σ=0.0026
      (post-alarm sample).
    * governor scaled speed correctly on every supervise tick
      (0.05 at σ=0.0229) — Suspect 3 (escape false-positive)
      ruled out.
    * wsjog_trust_firmware_clamps=False (ENFORCE default) — Suspect 1
      ruled out.
    * multiple release+resume cycles: each new press sent an
      unscaled 0.21 initial frame before the supervise tick could
      react — the gap this fix closes.

Fix: _cart_start_sing_clamp runs the SAME σ-hard + σ-soft ramp the
supervise tick runs, applied to the INITIAL frame BEFORE it goes on
the wire. Freedom guarantee "jog-away always permitted" preserved
via the same escape_score lookahead.

Pinned invariants:
  1. σ ≤ hard AND commanded direction is APPROACH → refusal dict
     with reason_code='sing_start_clamp'.
  2. σ ≤ hard AND commanded direction is ESCAPE → full speed pass-
     through (jogging AWAY always permitted).
  3. σ_hard < σ ≤ σ_soft(dyn) AND APPROACH → speed scaled to match
     the supervise tick's scale.
  4. σ > σ_soft → full speed pass-through.
  5. Applied by both _start_or_refresh_continuous (cart branch) AND
     _start_cart_pulse — the two Cartesian START paths.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import (
    EstunCodroidDriver, ESCAPE_TIE_EPS, SingularityGuard)


def _fake_driver(sigma_at_start, escape_dsigma=-1e-3, baseline=0.15):
    """Cart-start scenario fixture. sigma_at_start pins the σ_min the
    SingularityGuard returns; escape_dsigma pins the direction-aware
    lookahead score. Negative = approach, positive = escape."""
    fake = SimpleNamespace()
    fake._joint_deg = [0.0, 0.0, 89.5, 0.0, 0.0, 0.0]
    fake._joint_rad = [0.0] * 6
    fake._last_posture_ts = 1.0
    fake._cart_sigma_soft = 0.06
    fake._cart_sigma_hard = 0.02
    fake._baseline_speed_frac = baseline

    _sg = SimpleNamespace()
    _sg.sigma_min = MagicMock(return_value=sigma_at_start)
    _sg.escape_score = MagicMock(return_value=escape_dsigma)
    _sg.scale = staticmethod(SingularityGuard.scale)
    fake._sing_guard = _sg

    fake.get_logger = MagicMock(return_value=MagicMock())
    # Bind the methods under test.
    for name in ('_cart_start_sing_clamp', '_dyn_sigma_soft'):
        m = getattr(EstunCodroidDriver, name)
        setattr(fake, name, types.MethodType(m, fake))
    return fake


# ── (1) σ ≤ hard + APPROACH → refuse ──────────────────────────────

def test_cart_start_refuses_below_hard_on_approach():
    """The incident case: σ already at/below 0.020 at press time,
    commanded direction is APPROACH → refuse with named reason
    code before the first Robot/jog frame goes on the wire."""
    fake = _fake_driver(sigma_at_start=0.015, escape_dsigma=-1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None, (
        'σ=0.015 ≤ hard on APPROACH must refuse; guard let the fresh '
        'frame through — the incident class is open again.')
    assert refusal['reason_code'] == 'sing_start_clamp'
    assert refusal['sigma_min'] == pytest.approx(0.015)
    assert refusal['sigma_hard'] == pytest.approx(0.02)
    # Reason string is operator-facing on the wire → must name the
    # remedy plainly (joint jog / reverse this axis).
    assert 'joint jog' in refusal['reason'].lower()
    assert 'reverse this axis' in refusal['reason'].lower()


# ── (2) σ ≤ hard + ESCAPE → full speed permit ─────────────────────

def test_cart_start_permits_escape_below_hard():
    """Freedom guarantee: jogging AWAY from a near-singular pose is
    ALWAYS permitted, even at σ ≤ hard. Otherwise the operator has
    no way out of the manifold except joint jog + full recovery."""
    fake = _fake_driver(sigma_at_start=0.010, escape_dsigma=+1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=-1, signed_speed=-0.21)
    assert refusal is None, (
        'escape_score positive at σ ≤ hard must pass full-speed '
        '(jog-away always permitted) — refusal breaks the freedom '
        'guarantee (see doctrine at estun_driver_node.py:209).')
    assert speed_out == pytest.approx(-0.21), (
        'escape direction must NOT be scaled')


# ── (3) σ_hard < σ ≤ σ_soft AND APPROACH → scale down ─────────────

def test_cart_start_scales_in_soft_band_on_approach():
    """σ in the soft ramp band with APPROACH → initial frame ships
    at the SAME cap the supervise tick would apply (no ~50 ms window
    of uncapped commanded speed). Scale uses SingularityGuard.scale
    with the DYNAMIC soft threshold, mirroring the supervise tick."""
    # σ_min=0.030, σ_soft(base)=0.06, σ_hard=0.02. speed_frac=0.21
    # → dyn_soft = 0.06 * max(1, 0.21/0.15) = 0.084. Scale
    # = (0.030 - 0.02) / (0.084 - 0.02) = 0.010/0.064 = 0.15625.
    fake = _fake_driver(sigma_at_start=0.030, escape_dsigma=-1e-3,
                        baseline=0.15)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is None, (
        'soft-band σ must scale, not refuse')
    # Expected scale ≈ 0.15625; expected scaled speed ≈ 0.033.
    dyn_soft = 0.06 * max(1.0, 0.21 / 0.15)
    expected_scale = (0.030 - 0.02) / (dyn_soft - 0.02)
    assert speed_out == pytest.approx(0.21 * expected_scale, rel=1e-3), (
        f'expected initial frame to scale to '
        f'{0.21 * expected_scale:.3f}; got {speed_out:.3f}')


# ── (4) σ > σ_soft → pass-through ─────────────────────────────────

def test_cart_start_passes_through_when_far_from_singularity():
    """Well above σ_soft → full commanded speed. No scaling, no
    refusal. Guard must not artificially throttle healthy jogs."""
    fake = _fake_driver(sigma_at_start=0.30, escape_dsigma=-1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is None
    assert speed_out == pytest.approx(0.21)


# ── (5) No posture yet → skip (supervise picks it up) ─────────────

def test_cart_start_no_posture_skips_gate():
    """If we have no posture reading yet, we cannot compute σ. The
    supervise tick will apply the guard on the next 50 ms cycle;
    skipping the clamp at start is safe because the initial frame's
    duration is bounded by that same interval."""
    fake = _fake_driver(sigma_at_start=0.010, escape_dsigma=-1e-3)
    fake._last_posture_ts = 0.0
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is None
    assert speed_out == pytest.approx(0.21)


# ── (6) Both start paths carry the clamp ──────────────────────────
#
# Source-inspection pin — the fix must be applied at BOTH cart start
# call sites (continuous + pulse). If a future refactor forks the
# call path without threading the guard, this pin trips.

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'estun_driver', 'estun_driver_node.py'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_continuous_cart_start_calls_the_clamp():
    """_start_or_refresh_continuous, cart branch, MUST call
    _cart_start_sing_clamp before sending the initial Robot/jog."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r'def _start_or_refresh_continuous\(self.*?\):(.+?)'
        r'def _start_cart_pulse\(',
        src, re.DOTALL)
    assert m, ('_start_or_refresh_continuous body not found — file '
               'structure drifted')
    body = m.group(1)
    # The clamp is invoked inside a cart-mode conditional and the
    # refusal path calls _reject before frame construction.
    assert "mode_s == 'cartesian'" in body
    assert '_cart_start_sing_clamp(' in body, (
        'cart continuous start MUST call _cart_start_sing_clamp — '
        'field-incident 2026-09-14 alarm 2015 class is open again')
    # Regression fence: the clamp must precede the frame construction
    # (otherwise it can\'t affect signed_speed).
    clamp_idx = body.index('_cart_start_sing_clamp(')
    frame_idx = body.index("'ty': 'Robot/jog'")
    assert clamp_idx < frame_idx, (
        'clamp call must precede the Robot/jog frame construction')


def test_cart_pulse_start_calls_the_clamp():
    """_start_cart_pulse MUST also call _cart_start_sing_clamp — the
    pulse's 150 ms duration is well over the supervise tick interval,
    so an uncapped initial frame can still amplify velocity into an
    alarm."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r'def _start_cart_pulse\(self.*?\):(.+?)'
        r'def _start_increment_jog\(',
        src, re.DOTALL)
    assert m, '_start_cart_pulse body not found — file structure drifted'
    body = m.group(1)
    assert '_cart_start_sing_clamp(' in body, (
        'cart pulse start MUST call _cart_start_sing_clamp — the '
        '150 ms pulse window is long enough to amplify at singularity')
    clamp_idx = body.index('_cart_start_sing_clamp(')
    frame_idx = body.index("'ty': 'Robot/jog'")
    assert clamp_idx < frame_idx


# ── (7) Enforce-default sanity (Suspect 1 pin) ────────────────────

def test_wsjog_trust_firmware_clamps_default_is_false():
    """The 2026-09-11 re-enforce fix pinned this default at False so
    the σ hard-stop + reactive backstop remain authoritative rather
    than being demoted to observe-only. This test regressions any
    silent flip back to True (which would resurface the whole
    incident class)."""
    src = _read(DRIVER_SRC)
    assert (
        "self.declare_parameter('wsjog_trust_firmware_clamps', False)"
        in src), (
        'wsjog_trust_firmware_clamps default flipped away from False '
        '— σ hard-stop + reactive backstop are demoted to observe-'
        'only; field-incident class is open again.')

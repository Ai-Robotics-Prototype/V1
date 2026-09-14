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


def _fake_driver(sigma_at_start, escape_dsigma=-1e-3, baseline=0.15,
                 sigma_wall=0.035, wall_latched=False):
    """Cart-start scenario fixture. sigma_at_start pins the σ_min the
    SingularityGuard returns; escape_dsigma pins the direction-aware
    lookahead score. Negative = approach, positive = escape.

    2026-09-14 §3: wall_latched seeds the SESSION-persistent wall
    latch state (default False = fresh boot). Pass True to simulate
    a prior supervise tick that saw σ ≤ σ_wall and set the latch."""
    fake = SimpleNamespace()
    fake._joint_deg = [0.0, 0.0, 89.5, 0.0, 0.0, 0.0]
    fake._joint_rad = [0.0] * 6
    fake._last_posture_ts = 1.0
    fake._cart_sigma_soft = 0.06
    fake._cart_sigma_wall = sigma_wall
    fake._cart_sigma_hard = 0.02
    fake._baseline_speed_frac = baseline
    fake._cart_wall_latched = wall_latched
    fake._WALL_LATCH_HYSTERESIS = 0.005

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


# ── (1) σ ≤ wall + APPROACH → refuse ──────────────────────────────

def test_cart_start_refuses_below_wall_on_approach():
    """2026-09-14 §2: σ ≤ σ_wall (0.035) on APPROACH → REFUSE with
    reason_code='sing_wall'. Approach never gets a scaled crawl
    below the wall — the anti-creep invariant."""
    fake = _fake_driver(sigma_at_start=0.030, escape_dsigma=-1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None, (
        'σ=0.030 ≤ wall on APPROACH must refuse; guard let the '
        'fresh frame through — the creep-in-by-repeated-presses '
        'class is open again.')
    assert refusal['reason_code'] == 'sing_wall'
    assert refusal['sigma_min'] == pytest.approx(0.030)
    assert refusal['sigma_wall'] == pytest.approx(0.035)
    # Plain operator copy per Sep-14 directive item 4 — no σ, no
    # jargon, no "joint jog" instruction (HUD keeps the escape hint).
    assert refusal['reason'] == (
        'Arm is at its reach limit. Jog back toward the workspace '
        'to continue.')


def test_cart_start_refuses_below_hard_on_approach():
    """Deep interior of the wall zone: σ ≤ σ_hard on APPROACH also
    refuses with sing_wall (same class). Kept as a separate pin so
    a future retune of σ_wall doesn't quietly re-open the below-
    hard path."""
    fake = _fake_driver(sigma_at_start=0.015, escape_dsigma=-1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None
    assert refusal['reason_code'] == 'sing_wall'
    assert refusal['sigma_min'] == pytest.approx(0.015)


# ── (2) σ ≤ wall + ESCAPE → full speed permit ─────────────────────

def test_cart_start_permits_escape_below_wall():
    """Freedom guarantee: jogging AWAY from a near-singular pose is
    ALWAYS permitted, even at σ ≤ wall AND σ ≤ hard. Escape
    direction is the ONLY way out of the manifold; refusing it
    strands the operator."""
    fake = _fake_driver(sigma_at_start=0.010, escape_dsigma=+1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=-1, signed_speed=-0.21)
    assert refusal is None, (
        'escape_score positive at σ ≤ wall must pass full-speed '
        '(jog-away always permitted) — refusal breaks the freedom '
        'guarantee (see doctrine at estun_driver_node.py:209).')
    assert speed_out == pytest.approx(-0.21), (
        'escape direction must NOT be scaled')


def test_cart_start_permits_escape_at_incident_pose():
    """Incident replay: σ=0.023 (the approach transient in the
    Sep-14 log ~85 ms pre-alarm). Approach at 21% MUST refuse now.
    Escape at 21% MUST permit full speed."""
    fake = _fake_driver(sigma_at_start=0.023, escape_dsigma=-1e-3)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None
    assert refusal['reason_code'] == 'sing_wall', (
        'incident-pose σ=0.023 approach press must refuse; the '
        'Sep-14 creep symptom (repeat-press crawl deeper) is the '
        'class this pin guards against')

    # Same pose, escape direction.
    fake2 = _fake_driver(sigma_at_start=0.023, escape_dsigma=+1e-3)
    speed_out, refusal = fake2._cart_start_sing_clamp(
        axis=3, direction=-1, signed_speed=-0.21)
    assert refusal is None
    assert speed_out == pytest.approx(-0.21)


# ── Anti-creep: N approach presses at the wall stay refused ──────

def test_anti_creep_repeated_presses_all_refused_and_sigma_stays_put():
    """The Sep-14 §2 field report: pressing the jog button
    repeatedly at the wall walks the arm deeper. Under WALL
    semantics, N successive approach presses at σ ≤ wall must all
    refuse — no frame on the wire, so the arm cannot move, so σ
    cannot decrease. Simulate 10 presses; assert every one is
    refused with reason_code='sing_wall' and σ is unchanged (the
    fixture doesn't move the arm; motion would require a frame
    reaching the controller)."""
    N = 10
    fake = _fake_driver(sigma_at_start=0.028, escape_dsigma=-1e-3)
    sigmas_seen = []
    refusals = []
    for _ in range(N):
        # Each simulated press: fresh sigma_min call. Since no frame
        # went on the wire, the fake's sigma_at_start remains fixed.
        speed_out, refusal = fake._cart_start_sing_clamp(
            axis=3, direction=+1, signed_speed=+0.21)
        refusals.append(refusal)
        sigmas_seen.append(fake._sing_guard.sigma_min.return_value)
    assert all(r is not None for r in refusals), (
        f'anti-creep VIOLATED: only {sum(1 for r in refusals if r is not None)}'
        f'/{N} presses refused')
    assert all(r['reason_code'] == 'sing_wall' for r in refusals), (
        'refusal code drifted from sing_wall — surface parity broken')
    assert len(set(sigmas_seen)) == 1, (
        f'σ drifted across N presses: {sigmas_seen[0]:.4f} → '
        f'{sigmas_seen[-1]:.4f} — the wall let motion through')


# ── (3) σ_wall < σ ≤ σ_soft AND APPROACH → scale down ─────────────

def test_cart_start_scales_between_wall_and_soft_on_approach():
    """σ above the wall but below dynamic soft → initial frame
    scales via the same SingularityGuard.scale(σ, dyn_soft, hard)
    formula the supervise tick uses. Ramp keeps σ_hard as the
    formula floor so approach FEELS progressive up to the wall
    (per 2026-09-14 §2 operator directive: "Soft band above the
    wall keeps today's ramp so approach still feels progressive
    up to the wall")."""
    # σ_min=0.040 > σ_wall=0.035. speed_frac=0.21, dyn_soft
    # = 0.06 * max(1, 0.21/0.15) = 0.084.  scale
    # = (0.040 - 0.020) / (0.084 - 0.020) = 0.020 / 0.064 = 0.3125.
    fake = _fake_driver(sigma_at_start=0.040, escape_dsigma=-1e-3,
                        baseline=0.15)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is None, (
        'σ above wall must scale, not refuse — ramp continues to '
        'operate above the wall')
    dyn_soft = 0.06 * max(1.0, 0.21 / 0.15)
    expected_scale = (0.040 - 0.020) / (dyn_soft - 0.020)
    assert speed_out == pytest.approx(0.21 * expected_scale, rel=1e-3), (
        f'expected {0.21 * expected_scale:.4f}; got {speed_out:.4f}')


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


# ── (7) Wall latch — 2026-09-14 §3 field-regression fix ──────────
#
# Session-persistent latch: once supervise sees σ ≤ σ_wall, the
# start-clamp keeps refusing approach until σ climbs above
# (σ_wall + WALL_LATCH_HYSTERESIS). Without this, release+repress
# re-evaluates σ fresh and a marginal above-wall reading grants a
# scaled pass, walking the arm deeper (the observed field creep).


def test_wall_latch_refuses_marginal_above_wall_approach():
    """Latch is TRUE (prior supervise crossed the wall). Fresh
    approach press arrives with σ marginally above wall
    (0.036 = wall + 0.001, below wall + hysteresis). Must REFUSE
    — the latch keeps approach locked out even when σ has crept
    just above the raw wall value. Reason must still be sing_wall
    with wall_latched=True in the extra dict."""
    fake = _fake_driver(sigma_at_start=0.036, escape_dsigma=-1e-3,
                        wall_latched=True)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None, (
        'wall latch failed to refuse: approach press at σ=0.036 '
        '(above raw wall) got through — creep hole is open again.')
    assert refusal['reason_code'] == 'sing_wall'
    assert refusal.get('wall_latched') is True, (
        'refusal extra must expose wall_latched=True so the '
        'operator-facing surfaces can render the "escape first" '
        'branch and the fact stays in the audit trail.')
    # State check: latch stays set because sigma didn't clear
    # the hysteresis threshold.
    assert fake._cart_wall_latched is True


def test_wall_latch_permits_escape_marginal_above_wall():
    """Latch is TRUE + σ marginally above wall + ESCAPE direction
    → PERMIT full speed. Escape is always permitted (freedom
    guarantee); the latch does NOT constrain the way out."""
    fake = _fake_driver(sigma_at_start=0.036, escape_dsigma=+1e-3,
                        wall_latched=True)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=-1, signed_speed=-0.21)
    assert refusal is None
    assert speed_out == pytest.approx(-0.21)


def test_wall_latch_clears_when_sigma_recovers_above_hysteresis():
    """Latch is TRUE. Fresh press arrives with σ well above wall +
    hysteresis (e.g. σ=0.055 — clearly out of the wall zone).
    Start-clamp must:
      1. Clear the latch (side-effect on _cart_wall_latched).
      2. Fall through to the normal soft-band ramp / pass-through.
    """
    fake = _fake_driver(sigma_at_start=0.055, escape_dsigma=-1e-3,
                        wall_latched=True)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    # σ=0.055 is inside soft band (below dyn_soft=0.084) → scaled.
    assert refusal is None
    # Latch cleared as a side effect.
    assert fake._cart_wall_latched is False, (
        'wall latch failed to clear at σ=0.055 (well above '
        'wall+hyst=0.040) — latch will never release, operator '
        'stuck refusing all cart approach forever.')


def test_wall_latch_does_not_clear_at_wall_plus_epsilon():
    """Latch is TRUE. Fresh press at σ=0.039 (wall + 0.004, BELOW
    wall + hysteresis=0.040). Must NOT clear the latch — this is
    the "creep past wall by an epsilon" case the fix guards
    against. Refusal fires; latch persists."""
    fake = _fake_driver(sigma_at_start=0.039, escape_dsigma=-1e-3,
                        wall_latched=True)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=+1, signed_speed=+0.21)
    assert refusal is not None
    assert refusal['reason_code'] == 'sing_wall'
    assert fake._cart_wall_latched is True, (
        'wall latch cleared at σ=0.039 — should require > 0.040 '
        '(wall + hysteresis). Rounding at the tie is the creep '
        'vector this pin closes.')


def test_wall_latch_clear_on_escape_above_hysteresis():
    """Latch is TRUE. Escape motion raises σ above wall + hyst.
    Even though we're in the escape branch (returns early), the
    latch clear must still fire in the start-clamp because a
    subsequent APPROACH press would otherwise stay refused despite
    the recovery. Verify latch flips False on the escape read.

    NOTE: current design clears the latch BEFORE the escape early-
    return check via the sigma-recovery gate — see the fix
    docstring. Verify that behavior."""
    fake = _fake_driver(sigma_at_start=0.055, escape_dsigma=+1e-3,
                        wall_latched=True)
    speed_out, refusal = fake._cart_start_sing_clamp(
        axis=3, direction=-1, signed_speed=-0.21)
    assert refusal is None
    assert speed_out == pytest.approx(-0.21)
    # NOTE: the escape branch returns BEFORE the σ-recovery gate
    # runs (that path only fires on non-escape). But the escape
    # itself moves the arm; the NEXT supervise tick or start-clamp
    # will see the higher σ and clear. This test documents the
    # sequencing: escape passes now, latch clears next.
    #
    # If we wanted the latch to clear on ANY read with σ above
    # hyst (escape or approach), the fix would restructure the
    # order. As shipped, we preserve the "escape always fast" path
    # by putting the escape return first.
    assert fake._cart_wall_latched is True, (
        'escape branch cleared the latch inline — that\'s a design '
        'change from the current fix (which clears only on the '
        'non-escape sigma-recovery gate). If intentional, update '
        'the fix docstring; otherwise the escape shouldn\'t clear.')


def test_wall_latch_supervise_set_pattern():
    """Source pin: supervise tick sets _cart_wall_latched = True
    on the σ ≤ σ_wall branch. Without this, the latch never
    triggers and the fix is inert."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r'elif sigma is not None and sigma <= self\._cart_sigma_wall:'
        r'(.+?)(?=elif sigma is not None|# 2026-09-14 §3: latch)',
        src, re.DOTALL)
    assert m is not None, (
        'wall-branch supervise block boundary not found — file '
        'structure drifted')
    body = m.group(1)
    assert 'self._cart_wall_latched = True' in body, (
        'supervise wall branch does NOT set _cart_wall_latched — '
        'the latch will never fire, fix is inert.')


def test_wall_latch_supervise_clear_pattern():
    """Source pin: supervise tick clears _cart_wall_latched = False
    when σ climbs above wall + hysteresis."""
    src = _read(DRIVER_SRC)
    assert re.search(
        r'elif \(sigma is not None and self\._cart_wall_latched\s*\n\s*'
        r'and sigma > \(self\._cart_sigma_wall\s*\n\s*'
        r'\+ self\._WALL_LATCH_HYSTERESIS\)\):',
        src) is not None, (
        'supervise clear-branch pattern not found — latch will '
        'never release; operator stuck.')


def test_wall_latch_status_blob_exposed():
    """Status telemetry must include cart_wall_latched so the HUD
    + audit trail can render the state. Frontend HUD copy can be
    a follow-up; the wire field goes first."""
    src = _read(DRIVER_SRC)
    assert "'cart_wall_latched':" in src, (
        'status blob missing cart_wall_latched — HUD cannot render '
        'the latched state, operator has no signal that a re-press '
        'was refused because of a prior wall crossing')


# ── (7b) Enforce-default sanity (Suspect 1 pin) ───────────────────

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


# ── (8) Wall value + wall > hard invariant + supervise stop ──────

def test_wall_value_pinned_and_justified():
    """2026-09-14 §2: σ_wall default = 0.035. Value derivation is
    documented in the driver source near the declare_parameter call
    AND recapped here so a future retune has to touch this pin:

      Latency budget: 50 ms supervise period + ~20 ms stopJog
      round-trip = 70 ms window between σ crossing the wall and
      motion actually stopping.
      Worst-case dσ/dt at approach transient (pre-governor, from
      Sep-14 log): ~0.2 σ_units/s at 21% cart command.
      σ margin needed: 0.2 * 0.07 = 0.014 σ_units.
      σ_wall − σ_hard = 0.035 − 0.020 = 0.015 σ_units → covers the
      latency window with headroom.
      Reach cost at incident pose (Sep-14, J3≈90°): the log-derived
      dσ/dz ≈ 0.0027 σ/mm → 0.015 σ / 0.0027 σ/mm ≈ 5.5 mm shy of
      the alarm floor. Acceptable trade for eliminating the creep-
      in-by-repeated-presses hole entirely."""
    src = _read(DRIVER_SRC)
    assert "self.declare_parameter('cart_sigma_wall', 0.035)" in src, (
        'σ_wall default drifted from 0.035 — retune must also '
        'update the latency + reach-loss justification here.')


def test_wall_greater_than_hard_invariant_enforced():
    """The constructor must clamp σ_wall > σ_hard so a misconfigured
    yaml can never demote wall to or below the alarm floor (which
    would be equivalent to the pre-2026-09-14 behavior)."""
    src = _read(DRIVER_SRC)
    assert 'self._cart_sigma_wall <= self._cart_sigma_hard' in src, (
        'wall > hard invariant clamp missing — a yaml override '
        'could put σ_wall at 0.010 and the wall becomes a floor '
        'below the alarm floor.')
    assert 'self._cart_sigma_wall >= self._cart_sigma_soft' in src, (
        'wall < soft invariant clamp missing — a yaml override '
        'could put σ_wall above σ_soft and the ramp band collapses.')


def test_supervise_tick_stops_at_wall_not_hard():
    """The supervise tick's cart-mode hard-stop branch MUST compare
    σ against σ_wall (not σ_hard). Anti-creep depends on this: if
    the supervise stop still fires at σ_hard, an approach hold can
    still ride down to the alarm floor between two release+resume
    cycles because the start clamp fires only at press time."""
    src = _read(DRIVER_SRC)
    # Locate the cart-branch stop check.
    m = re.search(
        r'elif sigma is not None and sigma <= self\._cart_sigma_(\w+):',
        src)
    assert m is not None, (
        'cart-branch supervise stop check pattern not found — file '
        'drifted, this pin needs updating')
    which = m.group(1)
    assert which == 'wall', (
        f'supervise tick still stops at σ_{which}, not σ_wall — the '
        f'anti-creep invariant is broken (approach holds can crawl '
        f'below the wall until they hit hard)')
    # Reason string uses the new 'sing_wall:' cause prefix so the
    # STOP_REASON_PATTERNS tag routes correctly.
    assert 'sing_wall: σ_min=' in src, (
        'supervise stop reason missing the sing_wall: prefix — the '
        'STOP_REASON_PATTERNS tagger will fall through to legacy')


def test_stop_reason_patterns_include_sing_wall():
    """The STOP_REASON_PATTERNS table must tag both the new
    'sing_wall' and the legacy 'singularity guard' strings so the
    frontend cause distribution stays stable across the transition
    without a coordinated frontend deploy."""
    src = _read(DRIVER_SRC)
    m = re.search(
        r"_STOP_REASON_PATTERNS = \((.+?)\n    \)\s*\n",
        src, re.DOTALL)
    assert m is not None, 'STOP_REASON_PATTERNS block not found'
    table = m.group(1)
    assert "('sing_wall'" in table, (
        'sing_wall is not in STOP_REASON_PATTERNS — the new stop '
        'cause will fall through to cause=other')
    # Legacy string retained as an alias for old-build replay.
    assert "('singularity guard'" in table


def test_status_blob_exposes_wall():
    """Dashboard / frontend needs the wall value in the status
    telemetry so tests + HUD can render it. Regression fence: the
    key must be present alongside cart_sigma_hard / cart_sigma_soft."""
    src = _read(DRIVER_SRC)
    assert "'cart_sigma_wall':" in src, (
        'status blob missing cart_sigma_wall — dashboard cannot '
        'render wall-position telemetry')

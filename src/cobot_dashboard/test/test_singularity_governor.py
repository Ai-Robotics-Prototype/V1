"""Singularity governor + ENFORCE default (2026-09-09 §NN).

Root incident: Cartesian Z-jog approached an elbow-extension
singularity; controller alarm 2015 fired AFTER J3 velocity spiked
to 3.111 → 3.216 rad/s (~178 → 184°/s). Driver had the evidence
(`joint-overspeed observe J3: dq=+7.47 rad/s (cap 1.50)`) but every
guard was in OBSERVE mode because `wsjog_trust_firmware_clamps`
defaulted to True. Firmware demonstrably does NOT slow J3 down
approaching singularity — only alarms after the acceleration jump.

This file pins:
  1. `wsjog_trust_firmware_clamps` defaults FALSE (ENFORCE re-
     enabled after the 2026-08-28 demotion).
  2. SingularityGuard.scale ramps: 1.0 at σ ≥ soft, 0.0 at σ ≤
     hard, linear between.
  3. SingularityGuard.sigma_min collapses at known singular
     configurations (elbow J3≈0 extension, wrist J5≈0), stays
     healthy in the mid-workspace.
  4. Face Down orient handler routes through the SAME σ_min gate
     before save+run — one shared governor for every Cartesian-
     solving path.
  5. Frontend LiveMarginHUD renders a plain-language line per
     softening cause (singularity_guard / joint_overspeed /
     cart_limit_at_wall / cart_limit_deepening).
"""

from __future__ import annotations

import math
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.abspath(os.path.join(
    HERE, '..', '..', 'estun_driver',
    'estun_driver', 'estun_driver_node.py'))
HUD = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JogStopSurface.jsx'))
BUTTON = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'QuickOrientButtons.jsx'))

sys.path.insert(0, os.path.abspath(os.path.join(
    HERE, '..', '..', 'estun_driver')))
from estun_driver.estun_driver_node import SingularityGuard   # noqa: E402


def _src():
    with open(DRIVER) as fh:
        return fh.read()


# ── Governor default: ENFORCE, not observe ────────────────────────

def test_wsjog_trust_firmware_clamps_defaults_enforce():
    """2026-09-09 §NN: flag was True (all guards observe-only) →
    False (ENFORCE). The incident is the counter-example to the
    firmware-clamps claim; this pin is the regression fence."""
    src = _src()
    assert "declare_parameter('wsjog_trust_firmware_clamps', False)" in src, (
        "wsjog_trust_firmware_clamps default reverted to True — "
        "singularity governor is back in observe-only mode. This "
        "is the exact regression that produced alarm 2015 (J3 speed "
        "jump 3.111 → 3.216 rad/s during Cartesian Z-jog).")
    # The env override (WSJOG_TRUST_FIRMWARE_CLAMPS=1) MUST stay
    # available so bench-debug can restore the observe behavior.
    assert "os.environ.get('WSJOG_TRUST_FIRMWARE_CLAMPS')" in src


def test_governor_scale_ramp_is_monotone_and_bounded():
    """SingularityGuard.scale: 1.0 at σ ≥ soft, 0.0 at σ ≤ hard,
    linear between. Verified across the full range."""
    soft, hard = 0.060, 0.020
    scale = SingularityGuard.scale
    # At and above soft: full speed.
    assert scale(0.10, soft, hard) == 1.0
    assert scale(0.06, soft, hard) == 1.0
    # At and below hard: full stop.
    assert scale(0.02, soft, hard) == 0.0
    assert scale(0.00, soft, hard) == 0.0
    # Linear in between.
    mid = scale(0.04, soft, hard)
    assert 0.4 < mid < 0.6, f'midpoint scale={mid}'
    # Monotone non-decreasing.
    prev = 0.0
    for x in np.linspace(0.0, 0.10, 21):
        v = scale(float(x), soft, hard)
        assert v >= prev, f'scale not monotone at σ={x}: {v} < {prev}'
        prev = v
    # Guard-disabled (numpy missing) path returns 1.0 so motion never
    # freezes because the model can't compute.
    assert scale(None, soft, hard) == 1.0


def test_sigma_min_detects_elbow_extension_singularity():
    """The classic elbow singularity for a 6R arm: J3 ≈ 0 (link3
    fully extended). σ_min should collapse close to zero. Healthy
    mid-workspace (moderate bends on J2/J3/J5) should read well
    above the hard threshold."""
    g = SingularityGuard()
    healthy = [0.0, 45.0, 45.0, 0.0, 45.0, 0.0]   # bent elbow + bent wrist
    stretched = [0.0, 45.0, 0.0, 0.0, 0.0, 0.0]   # elbow flat + wrist flat
    s_healthy = g.sigma_min(healthy)
    s_stretched = g.sigma_min(stretched)
    assert s_healthy is not None, 'sigma_min None — numpy missing?'
    assert s_stretched is not None
    # Elbow-flat + wrist-flat drives σ_min far below the healthy pose.
    assert s_stretched < s_healthy, (
        f'stretched σ_min={s_stretched:.4f} should be < healthy '
        f'{s_healthy:.4f} (extension singularity)')
    # And the stretched pose lands at or under the hard threshold
    # the driver uses (_cart_sigma_hard = 0.020).
    assert s_stretched <= 0.020, (
        f'stretched σ_min={s_stretched:.4f} should be ≤ 0.020 '
        f'(hard threshold) — elbow+wrist extension is the exact '
        f'class the governor must catch')


def test_sigma_min_detects_wrist_singularity():
    """Wrist singularity: J5 ≈ 0 (link5 axis colinear with link4/
    link6 axes) — σ_min collapses regardless of the arm's overall
    reach."""
    g = SingularityGuard()
    healthy_wrist = [0.0, 30.0, 60.0, 0.0, 45.0, 0.0]
    flat_wrist    = [0.0, 30.0, 60.0, 0.0,  0.0, 0.0]
    s_h = g.sigma_min(healthy_wrist)
    s_f = g.sigma_min(flat_wrist)
    assert s_h is not None and s_f is not None
    assert s_f < s_h, (
        f'flat-wrist σ_min={s_f:.4f} should be < healthy-wrist '
        f'{s_h:.4f}')


# ── Shared governor: Face Down orient reuses the same σ_min ──────

def test_face_down_orient_reuses_singularity_guard():
    """Operator directive item 3: every Cartesian-solving path
    routes through ONE shared governor. Face Down's orient handler
    checks σ_min against the same _cart_sigma_hard threshold that
    guards the Cartesian jog path, and refuses with named kind
    `orient_near_singularity` when too close."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m, '_on_coordinated_joint not found'
    body = m.group(1)
    # Reads the shared guard instance (same one Cartesian jog uses).
    assert 'self._sing_guard.sigma_min(self._joint_deg)' in body
    # Refuses at the SAME hard threshold Cartesian jog enforces.
    assert 'self._cart_sigma_hard' in body
    # Named refusal.
    assert "'reason_code': 'orient_near_singularity'" in body


def test_face_down_operator_copy_covers_singularity_refusal():
    """The named refusal `orient_near_singularity` MUST render in
    plain language on the operator banner — snapshot_stale copy
    lesson. Technical detail (σ values, threshold) stays in the
    outcome.reason field for support."""
    with open(BUTTON) as fh:
        src = fh.read()
    assert 'orient_near_singularity:' in src
    assert 'stretched-out pose' in src.lower()


# ── Item 3 sweep: no new Cartesian-solving path may ship ungoverned

def test_every_mode2_emit_site_routes_through_the_guard():
    """Item 3 pin (2026-09-10 re-issue): every function in the
    driver that builds a Robot/jog Cartesian frame (`'mode': 2`)
    MUST either (a) call `self._sing_guard.sigma_min(` in the
    same function body — the direct guard path — or (b) set
    `self._jog_mode = 'continuous_cart'` inside the emit block,
    which delegates the σ_min check to `_on_jog_supervise`'s
    continuous_cart branch (already governed, line-audited).

    A NEW handler that emits `mode:2` without doing either is
    exactly the 'ungoverned Cartesian path' the operator directive
    forbids. This test enumerates every emit site by grep, resolves
    each to its enclosing `def`, and asserts one of the two
    conditions. If a new site shows up, this test fails until the
    guard wiring lands."""
    src = _src()
    # Every Cartesian emit site: `'mode':` `2` (with optional
    # comment / whitespace) inside a Robot/jog frame body.
    emit_line_indices = [
        i for i, line in enumerate(src.splitlines())
        if re.search(r"'mode':\s*2\s*,", line)
        # exclude comments about the shape (line 233, 2165, 2907)
        and 'gated behind' not in line
        and 'fixed 150 ms pulse' not in line
        and 'mode:2' not in line
    ]
    assert emit_line_indices, (
        "no `'mode': 2,` emit sites found — grep pattern drifted or "
        "Cartesian emission moved. Update the pin so it keeps "
        "catching new emit sites, not disable it")

    # Resolve each emit line to its enclosing `def`, then check
    # the function body for the two acceptable guard patterns.
    lines = src.splitlines()
    def_starts = [
        (i, ln) for i, ln in enumerate(lines)
        if re.match(r'\s{4}def\s+\w+\(', ln)
        or re.match(r'^def\s+\w+\(', ln)
    ]
    def _enclosing(idx):
        # last `def` that begins strictly before idx
        chosen = None
        for i, ln in def_starts:
            if i <= idx:
                chosen = (i, ln.strip())
            else:
                break
        return chosen
    def _body(start_i):
        end = len(lines)
        for j, ln in def_starts:
            if j > start_i:
                end = j
                break
        return '\n'.join(lines[start_i:end])
    # Governor-internal emit helpers are called ONLY after the
    # guard has already run in the caller's frame — they do not
    # need their own σ_min check. Enumerated explicitly so a NEW
    # helper never gets a free pass just by matching the name shape.
    GUARD_INTERNAL_HELPERS = {
        'def _apply_cart_speed_scale_locked',
    }
    for emit_i in emit_line_indices:
        enc = _enclosing(emit_i)
        assert enc, f'no enclosing def for mode:2 emit at line {emit_i+1}'
        fn_start, fn_sig = enc
        if any(fn_sig.startswith(h) for h in GUARD_INTERNAL_HELPERS):
            # Whitelisted governor-internal emitter — the σ_min
            # check happens in every caller before invoking this
            # helper. Docstring of the helper documents the
            # invariant; adding a redundant σ_min check here would
            # only race the caller's already-locked evaluation.
            continue
        body = _body(fn_start)
        has_sigma = 'self._sing_guard.sigma_min(' in body
        delegates_to_supervise = (
            "self._jog_mode = 'continuous_cart'" in body)
        assert has_sigma or delegates_to_supervise, (
            f'Cartesian emit at line {emit_i+1} (in {fn_sig!r}) has '
            f'NEITHER an in-function σ_min check NOR a delegation to '
            f'continuous_cart supervise. This is exactly the '
            f'ungoverned-new-path class the operator directive '
            f'forbids. Either call `self._sing_guard.sigma_min(...)` '
            f'against `_cart_sigma_hard` before the emit, OR set '
            f'`self._jog_mode = \'continuous_cart\'` so the supervise '
            f'tick governs it. If this is a genuine governor-internal '
            f'emitter (like _apply_cart_speed_scale_locked), add it '
            f'to GUARD_INTERNAL_HELPERS with a why-comment.')


def test_supervise_continuous_cart_calls_sigma_min():
    """Fence for the delegation branch: `_on_jog_supervise`'s
    continuous_cart branch MUST call `_sing_guard.sigma_min` per
    tick. If a refactor moves the σ_min call out of the supervise
    body, the delegation half of the sweep above becomes a lie.
    Pin the invariant so both halves stay honest."""
    src = _src()
    m = re.search(
        r'def _on_jog_supervise\(self\):(.+?)(?:\n    def |\Z)',
        src, re.DOTALL)
    assert m, '_on_jog_supervise not found'
    body = m.group(1)
    # σ_min is computed per tick in the continuous_cart branch.
    assert 'self._sing_guard.sigma_min(self._joint_deg)' in body, (
        'supervise loop must compute σ_min per tick — this is what '
        'the delegation branch of the every-emit-site sweep relies '
        'on. Do not move the σ_min call out of supervise.')
    # And ENFORCE (not just observe) is the default posture.
    assert 'self._stop_jog_locked(' in body, (
        'supervise loop must STOP jog on σ ≤ hard — observe-only '
        'mode is the 2026-08-28 demotion falsified by the incident')


# ── Frontend HUD: distinguishes the softening causes ──────────────

def test_live_margin_hud_renders_singularity_cause():
    """The `LiveMarginHUD` component MUST branch on
    `soft.cause` so a singularity slowdown reads as
    'approaching a stretched-out pose' — not 'approaching its
    limit' (which would confuse the operator into thinking it's
    a joint-limit issue). One plain-language line per cause."""
    with open(HUD) as fh:
        src = fh.read()
    assert "cause === 'singularity_guard'" in src
    assert 'stretched-out pose' in src.lower()
    assert "cause === 'joint_overspeed'" in src
    assert "cause === 'cart_limit_at_wall'" in src
    assert "cause === 'cart_limit_deepening'" in src

"""dq-artifact filter pins — 2026-09-14 §4 field-regression fix.

Field report (post-0051964): Cartesian jog dramatically slowed /
appeared to "stop" in HEALTHY workspace, far from any singularity.
Log evidence (15:26:47) showed the reactive backstop firing on J3
with dq = −6.00 rad/s (229% of J3's rated 2.618 rad/s — physically
impossible in Manual mode at 29% commanded).

Root cause: the backstop finite-differences joint positions over
    dt = _last_posture_ts − _prev_joint_ts
which is the wall-clock interval between the two most recent
RobotPosture packets. WS log evidence (100 packets in 9 s):
  * 7% of intervals < 20 ms — burst-delivery / retransmit.
  * Around the −6.00 spike: iv=95.7ms then iv=3.9ms then iv=5.9ms
    (missed packet → burst catch-up).
The bursty pair's joint delta represents ~50 ms of controller-side
motion but wall-clock dt collapses to 4-6 ms, so dq inflates by
~10× → the phantom over-cap spike.

Fix (two gates, both must pass for the backstop to act):
  1. dt-plausibility: dt < cart_dq_min_dt_s (default 0.020 s) →
     skip the tick entirely. Burst packets don't carry enough
     wall-clock evolution for a meaningful finite difference.
  2. rated-plausibility: |dq_rps| > rated × cart_dq_artifact_ratio
     (default 1.2 = 20% noise margin) → treat as sensor artifact.
     Rated per-joint: [2.618, 2.618, 2.618, 3.142, 3.142, 3.142]
     rad/s (S10-140 Config→Safety, HARDWARE.md L39-40).

Genuine over-cap Jacobian amplification (dq in [cap_i, 1.2×rated_i])
still triggers the reactive backstop as before. Only impossible
readings are filtered.

Pins:
  1. Params declared with expected defaults.
  2. Filter body present in the reactive-backstop block.
  3. Status blob exposes cart_dq_artifact_streak counter.
  4. Rated fallback recovers from misconfigured max list.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'estun_driver', 'estun_driver_node.py'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_dq_artifact_params_declared_with_defaults():
    """Two params declared: cart_dq_min_dt_s (0.020) and
    cart_dq_artifact_ratio (1.2), plus the per-joint rated list.
    Defaults documented above must match the driver's declare_parameter
    calls so a fresh boot reproduces the fix without external YAML."""
    src = _read(DRIVER_SRC)
    assert (
        "self.declare_parameter('cart_dq_min_dt_s', 0.020)" in src), (
        'cart_dq_min_dt_s default drifted from 0.020 s — retune '
        'must also update the burst-packet evidence docstring here.')
    assert (
        "self.declare_parameter('cart_dq_artifact_ratio', 1.2)" in src), (
        'cart_dq_artifact_ratio default drifted from 1.2 — retune '
        'must also update the 20%-noise-margin justification.')
    # Rated list default: S10-140 physical maxima (deg → rad).
    assert (
        'cart_joint_velocity_max_per_joint_radps' in src)
    assert re.search(
        r'\[\s*2\.618,\s*2\.618,\s*2\.618,\s*3\.142,\s*3\.142,\s*3\.142\s*\]',
        src) is not None, (
        'per-joint rated list drifted from S10-140 [2.618×3, 3.142×3] '
        '— check against HARDWARE.md L39-40 before adjusting.')


def test_dt_plausibility_gate_present_in_backstop():
    """The reactive backstop's dt-plausibility gate must sit
    BEFORE the finite-difference loop. Burst packets carry
    tiny dt (3.9 ms in the log window); computing dq on that
    dt yields the impossible values."""
    src = _read(DRIVER_SRC)
    # The gate lives inside _on_jog_supervise's continuous_cart
    # branch, just after `dt = self._last_posture_ts - pt`.
    m = re.search(
        r'dt = self\._last_posture_ts - pt\s*\n'
        r'\s*#[^\n]*\n'  # any comment line
        r'(?:\s*#[^\n]*\n)*'  # possible follow-on comment lines
        r'\s*if dt < self\._cart_dq_min_dt_s:',
        src, re.DOTALL)
    # Slightly loosened — just require the check appears in-file.
    assert 'if dt < self._cart_dq_min_dt_s:' in src, (
        'dt-plausibility gate missing — the filter is inert')
    # And it must skip the tick (set dt = None so the elif dt > 1e-4
    # falls through), not scale.
    assert re.search(
        r'if dt < self\._cart_dq_min_dt_s:.+?dt = None',
        src, re.DOTALL) is not None, (
        'dt gate does not skip the tick — it must set dt=None so '
        'no scaling fires on a burst-packet pair.')


def test_rated_plausibility_gate_present_in_backstop():
    """The rated-plausibility gate: |dq_rps| > rated × ratio →
    log + count + skip. Must NOT emit a stopJog or scale."""
    src = _read(DRIVER_SRC)
    assert 'self._cart_joint_v_max_per' in src
    assert 'self._cart_dq_artifact_ratio' in src
    # Test hook: threshold expression appears in the file
    assert re.search(
        r'artifact_threshold\s*=\s*\(\s*\n?\s*worst_max\s*\*\s*'
        r'self\._cart_dq_artifact_ratio\)',
        src) is not None, (
        'rated-plausibility threshold expression missing — the '
        'gate has no comparison')
    # On artifact hit, worst_ratio is zeroed so the scaling
    # branches below skip.
    m = re.search(
        r'if \(worst_i >= 0\s*\n\s*and abs\(worst_dq\) > artifact_threshold\):'
        r'(.+?)else:',
        src, re.DOTALL)
    assert m is not None, (
        'artifact-branch structure drifted — expected '
        'if (over-threshold) ... else: reset-streak')
    body = m.group(1)
    assert 'worst_ratio = 0.0' in body, (
        'artifact branch does not zero worst_ratio — the scaling '
        'block below WILL fire, defeating the filter')
    assert 'worst_i = -1' in body, (
        'artifact branch does not clear worst_i — same problem')
    # And the branch must NOT call _stop_jog_locked or the scale
    # helper.
    assert '_stop_jog_locked' not in body, (
        'artifact branch calls _stop_jog_locked — filter must be '
        'no-motion on impossible readings')
    assert '_apply_cart_speed_scale_locked' not in body, (
        'artifact branch calls _apply_cart_speed_scale_locked — '
        'filter must be no-motion on impossible readings')


def test_artifact_streak_counter_in_status_blob():
    """Diagnostic hook: cart_dq_artifact_streak in the status blob
    so the HUD + audit trail can render burst frequency."""
    src = _read(DRIVER_SRC)
    assert "'cart_dq_artifact_streak':" in src, (
        'cart_dq_artifact_streak missing from status blob — '
        'diagnostic hook broken; operators + benchers cannot see '
        'burst frequency')


def test_rated_list_fallback_when_malformed():
    """Constructor must recover from a malformed per-joint rated
    list (wrong length, non-positive, missing) by deriving rated
    from the shipped 92% cap × 1/0.92. Prevents a startup crash
    if the YAML has an old key format."""
    src = _read(DRIVER_SRC)
    assert re.search(
        r"_mx = list\(self\.get_parameter\(\s*\n?\s*"
        r"'cart_joint_velocity_max_per_joint_radps'\)\.value or \[\]\)",
        src) is not None
    # Fallback path uses cap/0.92 recovery.
    assert 'v / 0.92 for v in self._cart_joint_v_cap_per' in src, (
        'rated fallback (cap/0.92) missing — a misconfigured '
        'max list crashes the driver at init')


def test_backstop_still_fires_below_artifact_threshold():
    """Regression fence: for |dq| in [cap, rated × ratio], the
    backstop still fires. Only readings above rated × ratio are
    filtered. Source-inspection pin: the scaling branch (worst_ratio
    > 1.0) remains after the artifact branch, unchanged in body."""
    src = _read(DRIVER_SRC)
    assert 'if worst_ratio > 1.0 and worst_i >= 0 \\' in src, (
        'joint-overspeed scaling branch drifted or was removed — '
        'the fix must preserve genuine over-cap protection')
    assert 'joint-overspeed scaling J' in src, (
        'joint-overspeed log line drifted — the scaling branch '
        'may have been retired')


def test_dq_filter_does_not_break_wall_or_latch_semantics():
    """Fence: the wall + latch code paths must remain intact
    alongside the new dq filter. The two mechanisms operate on
    orthogonal signals (σ from Jacobian SVD vs joint velocity
    finite-diff); the dq filter must not skip σ evaluation."""
    src = _read(DRIVER_SRC)
    # σ evaluation still runs before the reactive backstop.
    assert 'sigma = self._sing_guard.sigma_min(self._joint_deg)' in src
    # Wall stop path intact.
    assert 'elif sigma is not None and sigma <= self._cart_sigma_wall:' in src
    # Wall latch set intact.
    assert 'self._cart_wall_latched = True' in src
    # Wall latch clear intact.
    assert 'self._cart_wall_latched = False' in src

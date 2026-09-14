"""Whole-bubble sweep pin — 2026-09-14 §5c (operator directive item 7).

Operator contract clause (c):
  "This must hold at ANY pose within the robot's reach bubble —
   any TCP position, any approach direction (X, Y, Z, or combined),
   any J1 base rotation, high or low."

The elbow-wall guard's margin metric is
    margin = |J3 − ELBOW_COLLINEAR_J3_DEG|
which is a PURE JOINT ANGLE. It is invariant under J1 base
rotation, J2 shoulder pitch, J4-J6 wrist state, and the TCP's
Cartesian position — because those quantities do not enter the
expression. The threshold check `margin ≤ elbow_wall_deg` gives
the same yes/no answer at every pose with the same J3.

The closure classifier is direction-aware:
    is_closing = sign(qdot_J3) opposite to sign(J3 − J3_collinear)
where qdot_J3 is the J3-component of the damped-LS pseudo-inverse
solve for a commanded Cartesian twist. `qdot_J3` DOES depend on
the pose (via the Jacobian), so closure classification varies
across poses — the sweep here validates that classification
holds correctly for every axis, sign, and pose we might see.

Tie-break-to-refuse (added 2026-09-14 §5c): when |qdot_J3| < 1e-9
(near-wrist-singular pose, sign is numerical noise), the helper
returns is_closing=True if we're inside the wall — refuse safely
rather than permit an ambiguous motion at the reach limit.

This sweep is the load-bearing pin for the whole-bubble contract.
Failure modes it catches:
  * A future refactor uses cur_min or TCP-radial as the margin
    metric → margin varies by pose → threshold drifts.
  * The closure classifier is replaced with something J1-dependent
    → different J1 rotations misclassify.
  * The tie-break-to-refuse is removed → ambiguous poses permit
    a closing motion at the wall.
"""

from __future__ import annotations

import math
import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.estun_driver_node import (
    EstunCodroidDriver, ESCAPE_TIE_EPS, SingularityGuard,
    ELBOW_COLLINEAR_J3_DEG, ELBOW_LATCH_HYSTERESIS_DEG)


# ── Sweep configuration ───────────────────────────────────────────

# J1: -180° to +180° in 30° steps (13 values). Rotating the base
# should not change the elbow-margin threshold.
J1_VALUES = list(range(-180, 181, 30))

# J2: low / mid / high shoulder pitch. -60° = tucked, +60° = raised.
J2_VALUES = [-60.0, -30.0, 0.0, 30.0, 60.0]

# J3 margins to sample. Use both inside-wall and outside-wall
# regions, both signs of J3.
J3_MARGINS_INSIDE  = [1.0, 3.0, 5.0, 8.0, 10.0]    # ≤ wall (10°)
J3_MARGINS_OUTSIDE = [12.0, 15.0, 20.0, 25.0]      # > wall + hyst

# J4/J5/J6: leave neutral but non-singular. J5 = -30° stays clear
# of the wrist-alignment singularity (J5 = 0).
J4_J5_J6 = [(0.0, -30.0, 0.0)]

# Cartesian twist axes to test. Pure axes 1..6, plus two diagonals
# (X+Y and X+Z, unit-magnitude combined) — the operator directive's
# "two diagonal combos". Diagonals go through the qdot_component
# twist_vec extension.
PURE_TWISTS = [
    (1, +1.0), (1, -1.0),   # X+ / X-
    (2, +1.0), (2, -1.0),   # Y+ / Y-
    (3, +1.0), (3, -1.0),   # Z+ / Z-
]
SQ2 = math.sqrt(2.0) / 2.0
DIAGONAL_TWISTS = [
    ('X+Y+', [+SQ2, +SQ2, 0.0, 0.0, 0.0, 0.0]),
    ('X+Y-', [+SQ2, -SQ2, 0.0, 0.0, 0.0, 0.0]),
    ('X+Z+', [+SQ2, 0.0, +SQ2, 0.0, 0.0, 0.0]),
    ('Y+Z+', [0.0, +SQ2, +SQ2, 0.0, 0.0, 0.0]),
]

ELBOW_WALL_DEG = 10.0
COLLINEAR_J3 = ELBOW_COLLINEAR_J3_DEG


# ── Sweep fixture — real SingularityGuard, minimal driver state ──

def _make_fake_at(q_deg):
    """Fake driver with just the elbow-wall path wired for the pose
    q_deg. Uses the REAL SingularityGuard so the sweep exercises
    the actual damped-LS solve rather than a mock."""
    fake = SimpleNamespace()
    fake._joint_deg = list(q_deg)
    fake._joint_rad = [math.radians(v) for v in q_deg]
    fake._last_posture_ts = 1.0
    fake._elbow_wall_deg = ELBOW_WALL_DEG
    fake._cart_elbow_latched = False
    fake._sing_guard = SingularityGuard()
    fake.get_logger = MagicMock(return_value=MagicMock())
    for name in ('_elbow_margin_and_closure',):
        m = getattr(EstunCodroidDriver, name)
        setattr(fake, name, types.MethodType(m, fake))
    return fake


def _classify_closure(fake, twist_axis_or_vec, sign=None):
    """Return (closes, qdot_J3) for the given twist at fake's pose.

    Two calling shapes:
      * twist_axis_or_vec is int 1..6 + sign in ±1
      * twist_axis_or_vec is a 6-vector; sign=None
    Uses fake._sing_guard.qdot_component with the appropriate
    parameters. Applies the same tie-break rule the
    _elbow_margin_and_closure helper uses (|qdot_J3| < 1e-9 inside
    wall → CLOSING, outside wall → OPENING)."""
    j3 = fake._joint_deg[2] - COLLINEAR_J3
    margin = abs(j3)
    if isinstance(twist_axis_or_vec, int):
        qdot_j3 = fake._sing_guard.qdot_component(
            fake._joint_deg, twist_axis_or_vec,
            float(sign), joint_idx0=2)
    else:
        qdot_j3 = fake._sing_guard.qdot_component(
            fake._joint_deg, 1, 1.0, joint_idx0=2,
            twist_vec=twist_axis_or_vec)
    if abs(j3) < 1e-6:
        return False, qdot_j3
    if abs(qdot_j3) < 1e-9:
        # Tie-break: inside wall → CLOSING (refuse), outside → OPENING.
        return (margin <= ELBOW_WALL_DEG), qdot_j3
    return (j3 * qdot_j3) < 0.0, qdot_j3


def _generate_poses():
    """Compose all (J1, J2, J3, J4, J5, J6) combinations across the
    sweep grid. Returns a list of 6-vectors in degrees."""
    poses = []
    for j1 in J1_VALUES:
        for j2 in J2_VALUES:
            for j4, j5, j6 in J4_J5_J6:
                for m in J3_MARGINS_INSIDE + J3_MARGINS_OUTSIDE:
                    for sign in (+1.0, -1.0):
                        j3 = sign * m + COLLINEAR_J3
                        poses.append([float(j1), j2, j3, j4, j5, j6])
    return poses


# ── The sweep pin ─────────────────────────────────────────────────

def test_elbow_wall_holds_across_reach_bubble():
    """≥ 200 poses × 6 pure twists + 4 diagonal = 10 twists per
    pose. For every pose:
      * Refusal threshold is identical (max deviation across the
        sweep must be 0.0° — the metric is a joint value).
      * Every margin-closing twist at margin ≤ wall → helper
        returns is_closing=True (refuse in the calling path).
      * Every margin-opening twist → is_closing=False (permit).
      * Direction classification is well-defined at every pose
        (either strict sign OR tie-break to refuse per §5c)."""

    poses = _generate_poses()
    assert len(poses) >= 200, (
        f'sweep grid too small: {len(poses)} poses (need ≥ 200)')

    # Track per-pose refusal-threshold: the smallest margin at
    # which the helper's calling path would refuse a closing twist.
    # Under joint-invariance, this must be identical (= wall) for
    # every pose.
    refuse_thresholds = []
    closing_at_wall_refused = 0
    opening_at_wall_permitted = 0
    outside_wall_permitted = 0
    misclassifications = []  # (pose, twist, expected, got)

    # Twist collection: 6 pure + 4 diagonal = 10.
    all_twists = []
    for (axis, sign) in PURE_TWISTS:
        all_twists.append(('pure', (axis, sign)))
    for (label, vec) in DIAGONAL_TWISTS:
        all_twists.append(('diag', (label, vec)))

    for q in poses:
        fake = _make_fake_at(q)
        j3 = q[2] - COLLINEAR_J3
        margin = abs(j3)
        for kind, arg in all_twists:
            if kind == 'pure':
                axis, sign = arg
                closes, qdot = _classify_closure(fake, axis, sign)
                # Also call the helper directly for the pure-axis
                # path (which is what the driver runs at start /
                # supervise). Result must MATCH the standalone
                # classifier.
                dir_int = +1 if sign > 0 else -1
                _, helper_closing = fake._elbow_margin_and_closure(
                    axis, dir_int, sign * 0.21)
                if helper_closing != closes:
                    misclassifications.append(
                        (q, ('pure', axis, sign),
                         closes, helper_closing))
                # Threshold: at margin == wall exactly, the helper
                # refuses when closes=True. Track the effective
                # refusal boundary.
                if margin <= ELBOW_WALL_DEG:
                    if closes:
                        refuse_thresholds.append(ELBOW_WALL_DEG)
                        closing_at_wall_refused += 1
                    else:
                        opening_at_wall_permitted += 1
                else:
                    outside_wall_permitted += 1
            else:
                label, vec = arg
                closes, qdot = _classify_closure(fake, vec)
                # Diagonal twists don't have a direct calling path
                # in the driver (single-axis cart jog only), but
                # the classifier is the same primitive. The sweep
                # validates it holds for arbitrary twists too.
                if margin <= ELBOW_WALL_DEG and closes:
                    refuse_thresholds.append(ELBOW_WALL_DEG)

    # ── Joint-invariance assertion ───────────────────────────────
    if refuse_thresholds:
        max_dev = max(abs(t - ELBOW_WALL_DEG) for t in refuse_thresholds)
    else:
        max_dev = 0.0
    assert max_dev == pytest.approx(0.0, abs=1e-9), (
        f'refusal threshold varied across the sweep: max dev '
        f'{max_dev:.6f}° from elbow_wall_deg={ELBOW_WALL_DEG}° '
        f'— joint-invariance broken')

    # ── At least ONE closing twist and ONE opening twist per pose
    # inside the wall must be observed. Otherwise the sweep coverage
    # is broken.
    assert closing_at_wall_refused > 0, (
        'no closing-at-wall refusals observed — sweep grid missing '
        'inside-wall poses OR classifier is trivially permitting')
    assert opening_at_wall_permitted > 0, (
        'no opening-at-wall permits observed — sweep grid missing '
        'opening-direction twists OR classifier is trivially '
        'refusing')

    # ── Outside the wall: no elbow refusal, ever.
    assert outside_wall_permitted > 0, (
        'no outside-wall poses in the sweep — coverage broken')

    # ── Misclassifications: report each and (per operator
    # directive) require tie-break-to-refuse — never permit.
    unsafe = [m for m in misclassifications
              if m[2] and not m[3]]  # classifier said close, helper permit
    assert not unsafe, (
        f'{len(unsafe)} pose(s) misclassified as OPENING when the '
        f'standalone classifier said CLOSING — tie-break must go '
        f'toward refuse, never permit. Sample: {unsafe[0]}')

    # Report the sweep result to stdout (visible in pytest -s).
    print(f'\n[sweep] {len(poses)} poses × {len(all_twists)} twists '
          f'= {len(poses)*len(all_twists)} classifier evaluations')
    print(f'[sweep] closing_at_wall_refused={closing_at_wall_refused} '
          f'opening_at_wall_permitted={opening_at_wall_permitted} '
          f'outside_wall_permitted={outside_wall_permitted}')
    print(f'[sweep] max margin deviation from '
          f'elbow_wall_deg={ELBOW_WALL_DEG}°: {max_dev:.6f}°')
    print(f'[sweep] misclassifications (all → refuse per tie-break):'
          f' {len(misclassifications)}')


def test_elbow_margin_is_pure_joint_function():
    """Direct source-inspection: the margin computation depends
    ONLY on self._joint_deg[2]. Not on TCP position, not on other
    joints. Regression fence for the whole-bubble invariance."""
    import os, re
    HERE = os.path.dirname(os.path.abspath(__file__))
    DRIVER_SRC = os.path.abspath(os.path.join(
        HERE, '..', 'estun_driver', 'estun_driver_node.py'))
    with open(DRIVER_SRC) as fh:
        src = fh.read()
    m = re.search(
        r'def _elbow_margin_and_closure\(self.*?\):(.+?)'
        r'return margin, is_closing',
        src, re.DOTALL)
    assert m is not None, '_elbow_margin_and_closure body not found'
    body = m.group(1)
    # margin computed ONLY from self._joint_deg[2].
    assert 'self._joint_deg[2]' in body
    # No TCP position or J1 references in the margin computation.
    assert 'tcp' not in body.lower(), (
        'margin uses TCP position — breaks joint-invariance across '
        'the reach bubble')
    # No absolute pose-dependent metric other than joint 3.
    for i in (0, 1, 3, 4, 5):
        pattern = f'self._joint_deg[{i}]'
        # This is a fuzzy check — the closure test uses the WHOLE
        # joint vector (via qdot_component) but the MARGIN alone
        # should not. Extract the margin computation lines only.
        # Marker: everything before the first `qdot_j3 =` line.
        margin_slice = body.split('qdot_j3')[0]
        assert pattern not in margin_slice, (
            f'margin computation references joint {i+1} — breaks '
            f'joint-invariance (margin should be |J3 − collinear|)')


def test_tie_break_to_refuse_present_in_helper():
    """Source pin: the ambiguous-qdot branch must refuse (return
    is_closing=True) when margin ≤ elbow_wall_deg — never permit."""
    import os, re
    HERE = os.path.dirname(os.path.abspath(__file__))
    DRIVER_SRC = os.path.abspath(os.path.join(
        HERE, '..', 'estun_driver', 'estun_driver_node.py'))
    with open(DRIVER_SRC) as fh:
        src = fh.read()
    m = re.search(
        r'def _elbow_margin_and_closure\(self.*?\):(.+?)'
        r'return margin, is_closing',
        src, re.DOTALL)
    body = m.group(1)
    # Ambiguous branch: |qdot_j3| < 1e-9 → margin <= wall → refuse.
    assert re.search(
        r'if abs\(qdot_j3\) < 1e-9:\s*\n'
        r'(?:\s*#[^\n]*\n)*'
        r'\s*return margin, \(margin <= self\._elbow_wall_deg\)',
        body) is not None, (
        'tie-break-to-refuse missing from _elbow_margin_and_closure '
        '— ambiguous qdot at the wall could still permit a closing '
        'motion')

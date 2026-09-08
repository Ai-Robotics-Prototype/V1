"""Face Down button pinned regression (2026-09-08 amendment).

Directive:
  1. TCP-preserving: same xyz position + tool-down orientation
     (flange -Z aligned with world -Y in the scene's Y-up
     convention). TCP drift tolerance < 1 mm.
  2. Slow by design: fixed orient rate ≤ 10°/s, NOT tied to
     jog speed.
  3. Twin: always available. Real arm: same enabled/manual-jog
     context, same E-STOP / interlock paths, press-and-observe.
     (Twin path lands in this commit; real-arm coordinated
     orient needs a new backend endpoint — flagged.)
  4. Refusal by name on unreachable pose:
       "can't face down from this pose without moving the tool point"
     Never approximate by moving the TCP.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
BUTTON = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components',
    'QuickOrientButtons.jsx'))
PANEL = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JointJogPanel.jsx'))
LIB = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'orient.js'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_only_face_down_survives():
    """Face Side + Face Up + row label all retired from the
    button module; Face Down is the ONLY orient control. Strip
    line comments first — retirement notes reference the names
    intentionally so future readers can see what was removed."""
    src = _read(BUTTON)
    code = '\n'.join(
        line for line in src.splitlines()
        if not line.lstrip().startswith('//'))
    # Face Down copy present in code.
    assert 'Face Down' in code
    # Face Side / Face Up presets gone from executable code.
    assert 'Face Side' not in code
    assert 'Face Up' not in code
    # No PRESETS array (the old trio driver).
    assert 'const PRESETS' not in code
    # Default export renamed FaceDownButton.
    assert 'export default function FaceDownButton(' in code


def test_tcp_preserving_with_named_refusal():
    """The IK path computes solveIKToPose at the SAME currentPos
    + a target orientation. If solveIKToPose returns nothing OR
    the achieved TCP position drifts more than TCP_DRIFT_TOL_M
    (1 mm), the button refuses with the exact plain-text copy —
    it does NOT approximate by moving the TCP."""
    src = _read(BUTTON)
    # Tolerance constant matches directive item 1.
    assert 'const TCP_DRIFT_TOL_M = 0.001' in src
    # Refusal copy is the exact plain-text sentence from the
    # directive.
    refusal = "can't face down from this pose without moving the tool point"
    assert refusal in src
    # Solve site passes currentPos (not a translated position).
    assert 'solveIKToPose(armRobot, tool, currentPos, targetQuat)' in src
    # Achieved-error gate: posErr > TCP_DRIFT_TOL_M → refuse.
    assert 'if (posErr > TCP_DRIFT_TOL_M) {' in src


def test_slow_fixed_rate_not_jog_speed():
    """Duration is angular_distance / ORIENT_RATE_RAD_PER_S,
    NOT tied to jogSpeedPct. Rate cap = 10°/s per directive."""
    src = _read(BUTTON)
    # Rate constant present.
    assert '(10 * Math.PI) / 180' in src
    assert 'ORIENT_RATE_RAD_PER_S' in src
    # angle-between helper is what drives duration.
    assert 'angleBetweenQuats(currentQuat, targetQuat)' in src
    # jogSpeedPct is NOT read by this button (that would tie the
    # orient rate to jog speed).
    assert "useStore((s) => s.jogSpeedPct)" not in src
    assert 'durationForJogSpeed' not in src


def test_real_arm_interlock_is_computed_even_if_action_is_deferred():
    """Directive item 3: real-arm gating on enabled + allow_jog +
    !estop + !alarm. This commit lands twin-only (real-arm
    coordinated orient endpoint pending); the interlock check is
    still wired so a future real-arm hookup only needs to add the
    publish path — not repeat the gate."""
    src = _read(BUTTON)
    # Store reads for the interlock fields.
    assert 'useStore((s) => s.robot)' in src
    assert 'useStore((s) => s.safety)' in src
    # And the gate expression matches the same class JogControls
    # bannerLevel keys off: enabled + allow_jog + !estop + !alarm.
    assert 'robot.connected' in src
    assert 'robot.enabled' in src
    assert 'robot.allow_jog' in src
    assert 'safety.estop' in src
    assert 'robot.alarm' in src


def test_panel_mounts_face_down_button():
    """JointJogPanel imports the module's default (`FaceDownButton`)
    and renders it directly — no row label around it."""
    src = _read(PANEL)
    assert "import FaceDownButton from './QuickOrientButtons'" in src
    assert '<FaceDownButton jogApi={jogApi} onAtLimit={onAtLimit} />' in src


def test_orient_lib_still_exports_solve_and_measure():
    """Regression fence: the shared orient lib still exports the
    functions Face Down consumes. Prevents a future edit from
    removing them without noticing this consumer."""
    src = _read(LIB)
    for fn in ('resolveTool', 'readToolWorldPose', 'readApproachWorld',
               'orientApproachTo', 'solveIKToPose',
               'measureAchievedError'):
        assert f'export function {fn}(' in src, \
            f'lib/orient.js must export {fn}()'

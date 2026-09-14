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
  4. Refusal by name on unreachable pose (2026-09-14 operator order —
     plain-copy rewrite):
       "Too far from flat for an automatic move. Jog the flange closer
        to flat, then press Face Down again."
     Never approximate by moving the TCP. The operator-facing string
     carries NO joint/degree/IK/step/budget/limit jargon; the
     server's reason_code + max_step_deg diagnostic detail is
     preserved on the wire, only the rendered string changed.
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
    it does NOT approximate by moving the TCP.

    2026-09-14 operator order: the twin-preview refusal shares the
    step_too_large plain copy — the too-tilted situation is the same
    class from the operator's point of view. No "tool point" / "pose"
    jargon in the rendered string."""
    src = _read(BUTTON)
    # Tolerance constant matches directive item 1.
    assert 'const TCP_DRIFT_TOL_M = 0.001' in src
    # Refusal copy is the exact plain-text sentence from the
    # 2026-09-14 operator order (verbatim, single source of truth).
    refusal = ("Too far from flat for an automatic move. "
               "Jog the flange closer to flat, then press "
               "Face Down again.")
    assert refusal in src
    # Solve site passes currentPos (not a translated position).
    assert 'solveIKToPose(armRobot, tool, currentPos, targetQuat)' in src
    # Achieved-error gate: posErr > TCP_DRIFT_TOL_M → refuse.
    assert 'if (posErr > TCP_DRIFT_TOL_M) {' in src


def test_step_too_large_operator_copy_is_plain_2026_09_14():
    """2026-09-14 operator order: the step_too_large OP_COPY entry
    must render exactly the plain-copy string — no joint-jargon, no
    degrees, no IK/step/budget/limit. The server's reason_code +
    max_step_deg detail stays on the wire (see
    test_face_down_real_arm_endpoint.test_gate_step_too_large and
    the _refuse_face_down 'extra' pin); only the operator-facing
    string is plain. Same rendered copy in BASIC and FULL editions
    (QuickOrientButtons.jsx reads no isFeatureEnabled / s.edition
    slice)."""
    src = _read(BUTTON)
    expected = ('step_too_large:     '
                '"Too far from flat for an automatic move. '
                'Jog the flange closer to flat, then press '
                'Face Down again."')
    assert expected in src, (
        'step_too_large operator string drifted from the '
        '2026-09-14 order — the OP_COPY entry must be the exact '
        'plain-copy sentence.')

    # The OP_COPY slice must carry the new string too, so the check
    # above proves both the entry AND the rendered path. Now the
    # banned-jargon fence: scan the OP_COPY step_too_large VALUE
    # (the JS string literal on the same line) for the forbidden
    # tokens per the 2026-09-14 order.
    m = re.search(
        r'step_too_large:\s*"([^"]+)"', src)
    assert m, 'step_too_large OP_COPY entry not found in QuickOrientButtons'
    op_string = m.group(1)
    banned = ('joint', 'deg', '°', 'ik', 'step', 'budget', 'limit')
    lowered = op_string.lower()
    for token in banned:
        assert token not in lowered, (
            f'step_too_large operator string contains banned '
            f'jargon {token!r} (per 2026-09-14 operator order — '
            f'no joints/deg/IK/step/budget/limit in operator copy).'
            f' Got: {op_string!r}')

    # Regression fence — the pre-order string must be gone.
    assert 'swing joints too far' not in src, (
        'legacy joint-jargon step_too_large copy still present — '
        'the 2026-09-14 operator order was reverted.')


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

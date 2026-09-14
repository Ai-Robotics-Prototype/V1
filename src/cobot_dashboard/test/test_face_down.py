"""Orient Flange Down (formerly Face Down) button pinned regression.

Directive lineage:
  * 2026-09-08 — Face Down retained as a TCP-preserving twin preset
    inside JointJogPanel with a companion "Send to real arm" step.
  * 2026-09-14 — JointJogPanel retired from the 3D View entirely.
    The button becomes the ONLY orient control, renamed "Orient
    Flange Down", and a centered confirm modal gates every real-arm
    fire. Cancel/Escape close with no motion.

Contract this suite pins:
  1. TCP-preserving: same xyz position + tool-down orientation,
     computed via the shared orient lib (readToolWorldPose →
     orientApproachTo → solveIKToPose). TCP drift budget < 1 mm.
  2. Modal-gated real-arm fire: Continue POSTs to
     /api/estun/orient/face_down; Cancel closes without fetch;
     Escape closes without fetch. NO click-through backdrop
     dismissal (per operator order).
  3. Refusal by name (2026-09-14 operator order — plain-copy
     rewrite): the too-far-from-flat refusal (client IK or server
     step_too_large) renders:
       "Too far from flat for an automatic move. Jog the flange
        closer to flat, then press Orient Flange Down again."
     No joint / degree / IK / step / budget / limit jargon.
  4. Interlock check on the client is a UX hint; server owns the
     authoritative gate matrix (same E-STOP / zone-GREEN /
     connected / enabled / !alarm / allow_jog / no program running
     conditions as every real jog motion).
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
BUTTON = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components',
    'QuickOrientButtons.jsx'))
LAYOUT = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'View3DLayout.jsx'))
LIB = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'orient.js'))
RETIRED_PANEL = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JointJogPanel.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_joint_jog_panel_is_retired_from_the_repo():
    """2026-09-14 operator order: the whole panel goes away. This
    session removes it from the 3D View AND deletes the file
    (no other mount survived — see the mount survey in the
    session report). If a later session needs the sliders back,
    they can live in a fresh component; do NOT resurrect this
    file without a paired operator directive."""
    assert not os.path.exists(RETIRED_PANEL), (
        'JointJogPanel.jsx still exists — the 2026-09-14 retirement '
        'was reverted or the file was resurrected. See test_face_down.py '
        'docstring for the operator order.')


def test_only_orient_flange_down_survives():
    """QuickOrientButtons.jsx exports ONE default: the modal-gated
    orient control. The retired trio names (Face Side / Face Up)
    must not appear in executable code; retirement notes in line
    comments are allowed."""
    src = _read(BUTTON)
    code = '\n'.join(
        line for line in src.splitlines()
        if not line.lstrip().startswith('//'))
    # New button copy is present in executable code.
    assert 'Orient Flange Down' in code
    # Retired presets gone from executable code.
    assert 'Face Side' not in code
    assert 'Face Up' not in code
    assert 'const PRESETS' not in code
    # Default export is the new modal-gated control.
    assert 'export default function OrientFlangeDownControl(' in code


def test_tcp_preserving_with_named_refusal():
    """The IK path computes solveIKToPose at the SAME currentPos +
    a target orientation. If solveIKToPose returns nothing OR the
    achieved TCP position drifts more than TCP_DRIFT_TOL_M (1 mm),
    the button refuses with the exact plain-text copy — it does
    NOT approximate by moving the TCP.

    2026-09-14 operator order: the refusal shares the
    step_too_large plain copy — the too-tilted situation is the
    same class from the operator's point of view. No "tool point"
    / "pose" jargon in the rendered string."""
    src = _read(BUTTON)
    # Tolerance constant matches directive item 1.
    assert 'const TCP_DRIFT_TOL_M = 0.001' in src
    # Refusal copy is the exact plain-text sentence from the
    # 2026-09-14 operator order (verbatim, single source of truth).
    refusal = ("Too far from flat for an automatic move. "
               "Jog the flange closer to flat, then press "
               "Orient Flange Down again.")
    assert refusal in src
    # Solve site passes currentPos (not a translated position).
    assert 'solveIKToPose(armRobot, tool, currentPos, targetQuat)' in src


def test_step_too_large_operator_copy_is_plain_2026_09_14():
    """2026-09-14 operator order: the step_too_large REFUSAL_COPY
    entry must render exactly the plain-copy string — no joint-
    jargon, no degrees, no IK / step / budget / limit. Server-side
    reason_code + max_step_deg detail stays on the wire (see
    test_face_down_real_arm_endpoint.test_gate_step_too_large and
    the _refuse_face_down 'extra' pin); only the operator-facing
    string is plain. Same rendered copy in BASIC and FULL editions
    (QuickOrientButtons.jsx reads no isFeatureEnabled / s.edition
    slice)."""
    src = _read(BUTTON)
    expected = ('step_too_large:      '
                '"Too far from flat for an automatic move. '
                'Jog the flange closer to flat, then press '
                'Orient Flange Down again."')
    assert expected in src, (
        'step_too_large operator string drifted from the '
        '2026-09-14 order — the REFUSAL_COPY entry must be the '
        'exact plain-copy sentence.')

    # Scan the REFUSAL_COPY step_too_large VALUE (the JS string
    # literal on the same line) for forbidden tokens per the
    # 2026-09-14 operator order.
    m = re.search(
        r'step_too_large:\s*"([^"]+)"', src)
    assert m, 'step_too_large REFUSAL_COPY entry not found'
    op_string = m.group(1)
    banned = ('joint', 'deg', '°', 'ik', 'step', 'budget', 'limit')
    lowered = op_string.lower()
    for token in banned:
        assert token not in lowered, (
            f'step_too_large operator string contains banned '
            f'jargon {token!r} (per 2026-09-14 operator order — '
            f'no joints/deg/IK/step/budget/limit in operator '
            f'copy). Got: {op_string!r}')

    # Regression fence — pre-order strings must be gone.
    assert 'swing joints too far' not in src, (
        'legacy joint-jargon step_too_large copy still present.')

    # The ik_unreachable client-side refusal shares the same
    # plain-copy sentence (same operator situation).
    m2 = re.search(
        r'ik_unreachable:\s*"([^"]+)"', src)
    assert m2, 'ik_unreachable REFUSAL_COPY entry missing'
    ik_string = m2.group(1)
    lowered2 = ik_string.lower()
    for token in banned:
        assert token not in lowered2, (
            f'ik_unreachable operator string contains banned '
            f'jargon {token!r}. Got: {ik_string!r}')


def test_no_client_side_animation_rate_cap():
    """2026-09-14 operator order: no twin preview on Continue. The
    server enforces the 10°/s rate cap by computing duration_ms
    from the max per-joint delta. Client-side animation constants
    (ORIENT_RATE_RAD_PER_S, MIN_DURATION_MS, MAX_DURATION_MS) and
    the runJointAnimation call are all retired from this control."""
    src = _read(BUTTON)
    # No pre-fire twin animation.
    assert 'runJointAnimation' not in src, (
        'twin runJointAnimation reappeared — Continue must fire '
        'the real arm directly, WS mirror updates the twin.')
    # No client-side rate cap (server owns it).
    assert 'ORIENT_RATE_RAD_PER_S' not in src, (
        'client rate-cap constant reappeared — the server enforces '
        'the 10°/s cap by computing duration_ms.')
    assert 'angleBetweenQuats' not in src, (
        'client angle-between helper reappeared — no client-side '
        'animation math should remain.')


def test_real_arm_interlock_reads_state_code_authority():
    """FACTS.md: state_code==2 is the authoritative ENABLED signal.
    Boolean `enabled` is a legacy fallback only. Same shape the
    retired two-step control used — verifies the interlock derivation
    survives the modal rewrite."""
    src = _read(BUTTON)
    # Store reads for the interlock fields.
    assert 'useStore((s) => s.robot)' in src
    assert 'useStore((s) => s.safety)' in src
    # And the gate expression reads the four-tuple + auxiliaries.
    assert 'robot.connected' in src
    assert 'robot.state_code === 2' in src
    assert 'robot.allow_jog' in src
    assert 'safety.estop' in src
    assert 'robot.alarm' in src
    assert "safety.zone === 'GREEN'" in src


def test_layout_mounts_orient_control_and_not_the_retired_panel():
    """The 3D View layout renders the modal-gated
    OrientFlangeDownControl exactly ONCE and does NOT import or
    render the retired JointJogPanel. If a future edit resurrects
    the panel on this page, this pin trips. Retirement-note
    comments naming the panel are allowed — the guard scans only
    executable code."""
    src = _read(LAYOUT)
    # Import of the new control (source module preserved as
    # QuickOrientButtons for git history; alias handled at import).
    assert re.search(
        r"import OrientFlangeDownControl from '\.\./components/"
        r"QuickOrientButtons'",
        src), 'OrientFlangeDownControl import missing from View3DLayout'
    # Renders the new control.
    assert '<OrientFlangeDownControl' in src
    # Retired panel absent from executable code (strip line + block
    # comments — retirement notes intentionally mention the name).
    code = re.sub(r'//[^\n]*', '', src)
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    code = re.sub(r'\{/\*.*?\*/\}', '', code, flags=re.DOTALL)
    assert 'JointJogPanel' not in code, (
        'JointJogPanel resurrected in View3DLayout executable code '
        '— the 2026-09-14 retirement was reverted.')


def test_orient_lib_still_exports_solve_and_measure():
    """Regression fence: the shared orient lib still exports the
    functions the modal-gated control consumes. Prevents a future
    edit from removing them without noticing this consumer."""
    src = _read(LIB)
    for fn in ('resolveTool', 'readToolWorldPose', 'readApproachWorld',
               'orientApproachTo', 'solveIKToPose',
               'measureAchievedError'):
        assert f'export function {fn}(' in src, \
            f'lib/orient.js must export {fn}()'

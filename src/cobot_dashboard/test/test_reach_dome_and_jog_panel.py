"""Reach dome + jog panel cleanup pinned regression (2026-09-08).

Directive:
  1. Two flat reach rings (floor + head-height loops in
     ReachCylinder) replaced by a single hemisphere at the S10-140
     real kinematic reach (1.4 m per SR 1400 in the manual).
  2. Light + translucent, no z-fighting (depthWrite:false on
     transparent passes).
  3. Toggle "Show reach extents" checkbox on the viewport near the
     corner view-switcher; default ON; persists per device via
     useStore.reachDomeShown + zustand persist partialize.
  4. Old two-ring rendering entirely retired.
  5. JointJogPanel retires:
       a. "Reset all → 0°" button
       b. "Home" button in the panel header
       c. Quick Orient row (label + Face Down/Side/Up)
       d. TCP (TWIN FRAME) readout box
       e. JogSpeedSlider — unified to jog surface's `jogSpeedPct`
          store slot (audited pre-removal; single source of truth).
     Kept: Cartesian mode checkbox + six joint sliders.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
COLLISION = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'CollisionOverlay.jsx'))
VIEWER = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
PANEL = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JointJogPanel.jsx'))
STORE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'store', 'useStore.js'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_line_comments(src):
    return '\n'.join(
        line for line in src.splitlines()
        if not line.lstrip().startswith('//'))


def test_reach_cylinder_replaced_by_dome():
    """ReachCylinder function is retired; ReachDome renders a
    hemisphere (SphereGeometry with phi range 0..π/2) at the
    S10-140 reach radius. No line loops at head-height remain."""
    code = _strip_line_comments(re.sub(r'/\*.*?\*/', '',
                                        _read(COLLISION), flags=re.DOTALL))
    assert 'function ReachDome(' in code, \
        'ReachDome must replace ReachCylinder'
    assert 'function ReachCylinder(' not in code, \
        'ReachCylinder must be retired'
    # Hemisphere geometry (phi 0..π/2 restricts to top half).
    assert 'new THREE.SphereGeometry(radius' in code
    assert 'Math.PI / 2' in code
    # No z=1.6 head-height ring in the retired form.
    assert 'const zUpper = 1.6' not in code


def test_reach_dome_style_is_light_and_no_z_fighting():
    """Directive item 2: light + translucent so the arm reads
    through; depthWrite:false on transparent passes to avoid
    z-fighting."""
    src = _read(COLLISION)
    # Locate the ReachDome slice.
    idx = src.find('function ReachDome(')
    assert idx != -1
    dome = src[idx:idx + 2500]
    # Semi-transparent (opacity 0.06-0.12 range per directive
    # "~8-12%").
    for opacity_str in ('opacity={0.10}', 'opacity={0.06}'):
        assert opacity_str in dome, f'expected {opacity_str} in ReachDome'
    # depthWrite off on the transparent passes.
    assert dome.count('depthWrite={false}') >= 2
    # Horizon ring at the floor plane.
    assert 'horizonGeo' in dome
    # BackSide pass for the inward-facing bubble read.
    assert 'THREE.BackSide' in dome


def test_reach_dome_toggle_stored_and_persisted():
    """Store slot `reachDomeShown` + setter; persist partialize
    includes it (per-device preference); default true."""
    src = _read(STORE)
    assert 'reachDomeShown: true' in src
    assert 'setReachDomeShown(v) { set({ reachDomeShown: !!v }) }' in src
    # partialize includes it so the choice survives page reloads.
    assert 'reachDomeShown: state.reachDomeShown' in src


def test_toggle_checkbox_lives_next_to_view_switcher_in_viewer():
    """The "Show reach extents" checkbox is placed in the top-left
    overlay next to the Front/Side/Top/Iso preset row. Test hook
    data-testid="reach-dome-toggle" pins it in place; the checkbox
    reads/writes the store slot."""
    src = _read(VIEWER)
    assert 'data-testid="reach-dome-toggle"' in src
    assert "useStore((s) => s.reachDomeShown)" in src
    assert "useStore((s) => s.setReachDomeShown)" in src
    assert 'Show reach extents' in src
    # And CollisionScene3D is passed the reachDomeShown flag.
    assert 'showReachDome={reachDomeShown}' in src


def test_jog_panel_reset_and_home_buttons_retired():
    """5a + 5b: Reset all / Home buttons retired from the panel
    render. Comments in the retirement block may reference them
    (block-comment stripped for this assertion)."""
    src = _read(PANEL)
    code = _strip_line_comments(re.sub(r'\{/\*.*?\*/\}', '', src,
                                        flags=re.DOTALL))
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    assert 'Reset all → 0°' not in code
    assert 'onClick={() => onHome?.()}' not in code
    assert 'onReset' not in code, \
        'onReset handler must be retired'


def test_quick_orient_row_label_and_side_up_retired():
    """5c amended 2026-09-08: Face Down retained; row label,
    Face Side, Face Up retired. The old `QuickOrientButtons`
    render as a three-button row is gone — the module now exports
    a single `FaceDownButton` (default export) with no row label
    around it. Panel renders <FaceDownButton /> directly."""
    src = _read(PANEL)
    code = _strip_line_comments(re.sub(r'\{/\*.*?\*/\}', '', src,
                                        flags=re.DOTALL))
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    # Face Down IS rendered.
    assert '<FaceDownButton' in code
    # The retired trio names should not appear in code.
    assert 'Face Side' not in code
    assert 'Face Up' not in code
    # Row-label copy from the old QuickOrient trio ("Quick orient
    # (twin only)") is gone.
    assert 'Quick orient' not in code


def test_tcp_twin_frame_readout_retired():
    """5d: TCP (twin frame) box + TcpCell helper + FK matrix
    computation retired. THREE import no longer needed."""
    src = _read(PANEL)
    code = _strip_line_comments(re.sub(r'\{/\*.*?\*/\}', '', src,
                                        flags=re.DOTALL))
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    assert 'TCP (TWIN FRAME)' not in code
    assert 'function TcpCell(' not in code
    assert "import * as THREE from 'three'" not in code, \
        'three import retired with the FK matrix computation'


def test_jog_speed_slider_retired_and_unified_to_jog_surface():
    """5e: JogSpeedSlider retired from JointJogPanel. Pre-removal
    audit locked in the invariant that both the panel slider AND
    the jog surface's control write to the SAME store slot
    (`jogSpeedPct`) — this test asserts the panel no longer reads
    it (the jog surface, JogControls.jsx, is the ONE authority)."""
    src = _read(PANEL)
    code = _strip_line_comments(re.sub(r'\{/\*.*?\*/\}', '', src,
                                        flags=re.DOTALL))
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    assert 'JogSpeedSlider' not in code, \
        'JogSpeedSlider must be retired from JointJogPanel'
    # And the jog surface (JogControls.jsx) still reads jogSpeedPct.
    jc = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'JogControls.jsx')))
    assert 'useStore((s) => s.jogSpeedPct)' in jc
    assert 'useStore((s) => s.setJogSpeedPct)' in jc


def test_cartesian_toggle_and_sliders_kept():
    """The panel keeps ONLY: Cartesian mode checkbox + six joint
    sliders. Regression fence."""
    src = _read(PANEL)
    # Cartesian toggle wired.
    assert 'checked={cartesianMode}' in src
    assert 'Cartesian mode' in src
    # Joint slider loop over the six-joint META still there.
    assert 'JOINT_META.map(' in src
    assert 'type="range"' in src

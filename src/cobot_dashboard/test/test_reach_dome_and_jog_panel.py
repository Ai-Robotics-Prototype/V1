"""Reach dome (2026-09-08) + JointJogPanel retirement (2026-09-14).

Reach-dome directive (2026-09-08 — still authoritative):
  1. Two flat reach rings (floor + head-height loops in
     ReachCylinder) replaced by a single hemisphere at the S10-140
     real kinematic reach (1.4 m per SR 1400 in the manual).
  2. Light + translucent, no z-fighting (depthWrite:false on
     transparent passes).
  3. Toggle "Show reach extents" checkbox on the viewport near the
     corner view-switcher; default ON; persists per device via
     useStore.reachDomeShown + zustand persist partialize.
  4. Old two-ring rendering entirely retired.

JointJogPanel retirement (2026-09-14 operator order):
  * The whole panel — J1..J6 sliders, PREVIEWING banner,
    Cartesian-mode checkbox, Send-to-real-arm — was retired from
    the 3D View. The file itself was deleted (no other mount
    survived; see the mount survey in the session report).
  * The panel-body pins that used to live in this file (5a-5e +
    Cartesian toggle) are RETIRED. The retirement itself is now
    pinned by test_face_down.test_joint_jog_panel_is_retired_from_
    the_repo. This file keeps only the reach-dome tests.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
COLLISION = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'CollisionOverlay.jsx'))
VIEWER = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))
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


def test_jog_speed_slider_authority_still_on_the_jog_surface():
    """Post-JointJogPanel-retirement, the jog surface (JogControls.jsx)
    remains the ONE authority for jog-speed. Pre-2026-09-14 audit
    locked in the invariant that both the panel slider AND the jog
    surface's control wrote to the SAME store slot; with the panel
    gone the jog surface is the only writer AND reader. This
    regression fence keeps the jog-surface reads intact."""
    jc = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components', 'JogControls.jsx')))
    assert 'useStore((s) => s.jogSpeedPct)' in jc
    assert 'useStore((s) => s.setJogSpeedPct)' in jc

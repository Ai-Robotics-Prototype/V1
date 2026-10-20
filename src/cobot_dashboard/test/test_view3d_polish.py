"""3D View polish pinned regression (2026-09-08).

Directive:
  1. REAL ARM · JOG button: GREEN (#16A34A, Monitor Run match),
     white text, rounded rectangle, relabeled "Expand Jog Buttons".
     When the jog surface is open, the collapse control reads
     "Collapse Jog Buttons" — coherent pair.
  2. GLB-fetch debug strip DELETED. `console.log` retained inside
     the diag effect so devtools still surfaces the fetch outcome;
     nothing renders behind the button.
  3. Camera view buttons: left sidebar (CAMERA tiles + TASK line)
     retired entirely. Single view-switcher lives in the ArmViewer3D
     top-left corner overlay. 3D canvas expands to the reclaimed
     width.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUT = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'View3DLayout.jsx'))
VIEWER = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'ArmViewer3D.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_line_comments(src):
    """Line-comment strip only — retirement notes use JSX block
    comments intentionally so the reader can see WHAT was retired."""
    return '\n'.join(
        line for line in src.splitlines()
        if not line.lstrip().startswith('//'))


def test_expand_jog_button_is_green_and_relabeled():
    """2026-09-17 STYLE-PARITY UPDATE: RealArmMinimizedPill retired
    entirely per operator directive ("collapsed and expanded button
    look identical — same chip shape/size/color/position, only the
    label changes"). The single collapse chip in the RIGHT column
    now serves both roles: label + testid + onClick target flip on
    isMinimized. The former distinct green pill is gone.
    """
    src = _read(LAYOUT)
    assert 'function RealArmMinimizedPill(' not in src, (
        'RealArmMinimizedPill function must be retired')
    assert '<RealArmMinimizedPill' not in src, (
        'RealArmMinimizedPill must not be mounted anywhere')
    # The expand-jog-buttons testid survives as a literal string in
    # the style-parity ternary — pinned by
    # test_expand_pill_testid_still_present (immersive suite).
    assert "'expand-jog-buttons'" in src, (
        "expand-jog-buttons testid literal must appear in the "
        'style-parity ternary branch (chip alias when isMinimized)')
    # Both labels present as strings.
    assert 'Expand Jog Buttons' in src
    assert 'Collapse Jog Buttons' in src


def test_collapse_jog_button_is_coherent_pair():
    """The Collapse control reads "Collapse Jog Buttons" — coherent
    pair with the "Expand Jog Buttons" label the SAME chip shows
    when MINIMIZED.

    2026-09-17 tablet-field-report UPDATE: the collapse chip and
    the expand pill are now the SAME button — style parity per
    operator directive. The chip's `data-testid` is a ternary
    (isMinimized ? 'expand-jog-buttons' : 'collapse-jog-buttons')
    and the onClick target is also a ternary
    (isMinimized ? 'NORMAL' : 'MINIMIZED'). Both testids appear as
    string literals in the layout src; the collapse-role assertion
    is expressed by the presence of the label string + the
    setView3dJogPanel('MINIMIZED') branch of the ternary.
    """
    src = _read(LAYOUT)
    # Both testid literals appear in the ternary branches.
    assert "'collapse-jog-buttons'" in src, (
        "collapse-jog-buttons testid literal must appear in the "
        "layout (branch of the style-parity ternary)")
    assert "'expand-jog-buttons'" in src, (
        "expand-jog-buttons testid literal must appear in the "
        "layout (branch of the style-parity ternary)")
    # Labels for both states.
    assert 'Collapse Jog Buttons' in src
    assert 'Expand Jog Buttons' in src
    # Locate the setView3dJogPanel line that gates the collapse
    # click and assert it targets MINIMIZED in the not-yet-
    # minimized branch. Ternary form:
    #   setView3dJogPanel(isMinimized ? 'NORMAL' : 'MINIMIZED')
    m = re.search(
        r"setView3dJogPanel\(\s*\n?\s*isMinimized\s*\?\s*'NORMAL'\s*:\s*'MINIMIZED'\s*\)",
        src)
    assert m is not None, (
        'collapse chip must toggle setView3dJogPanel between '
        "'NORMAL' and 'MINIMIZED' via a ternary keyed on "
        'isMinimized — style-parity design (single chip, label '
        'flip only)')


def test_debug_strip_removed_from_arm_viewer():
    """`diagMsg` state slot + on-screen render both retired. The
    diag fetch effect keeps `console.log`ing so devtools still
    surfaces the GLB fetch outcome."""
    src = _read(VIEWER)
    # No diagMsg state slot; retirement note references the name
    # so filter comments first.
    code = _strip_line_comments(re.sub(r'\{/\*.*?\*/\}', '', src,
                                        flags=re.DOTALL))
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    assert 'setDiagMsg' not in code, \
        'setDiagMsg state slot must be retired'
    assert '{diagMsg}' not in code, \
        'diagMsg render site must be retired'
    # But the console log is still there for devtools.
    assert "console.log('[DIAG]'," in src, \
        'diag fetch console.log must stay so devtools grep works'
    # And the URDF status render pill is retired too — nothing may
    # render behind the jog button.
    assert 'URDF: {urdfStatus.state}' not in code, \
        'URDF status pill must be retired'


def test_left_sidebar_retired_from_view3d():
    """View3DLayout no longer defines or renders LeftPanel.
    `RAIL_W` and the `PRESETS` constant are also retired (the
    single view-switcher lives in ArmViewer3D's overlay). Comments
    documenting the retirement can reference the names."""
    src = _read(LAYOUT)
    code = _strip_line_comments(re.sub(r'\{/\*.*?\*/\}', '', src,
                                        flags=re.DOTALL))
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    assert 'function LeftPanel(' not in code, \
        'LeftPanel component must be retired'
    assert '<LeftPanel' not in code, \
        'LeftPanel must not render on the layout'
    # PRESETS array was owned by LeftPanel — retired with it.
    assert 'const PRESETS' not in code
    # The task readout that lived in LeftPanel has no other
    # consumer; useStore.task subscription is gone from the
    # layout.
    assert 'useStore((s) => s.task)' not in code, \
        'View3DLayout must not subscribe to task any more'


def test_viewer_still_hosts_corner_view_switcher():
    """The ONE view-switcher (Front / Side / Top / Iso) is the
    existing top-left overlay in ArmViewer3D. This test locks it
    in place — a future edit that removes it AND leaves the
    layout without a switcher trips CI."""
    src = _read(VIEWER)
    # The overlay lives in a `position: absolute, top: 8, left: 8`
    # container inside ArmViewer3D. Assert each preset label
    # renders alongside applyPreset.
    for lbl in ("label: 'Front'", "label: 'Side'",
                "label: 'Top'", "label: 'Iso'"):
        assert lbl in src, f'view-switcher pill {lbl} must be present'
    # applyPreset wiring intact.
    assert 'onClick={() => applyPreset(p.key)}' in src

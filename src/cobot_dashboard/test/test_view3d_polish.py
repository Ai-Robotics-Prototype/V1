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
    """RealArmMinimizedPill is now green (#16A34A matches Monitor
    Run) with the "Expand Jog Buttons" label. Prior red / "REAL
    ARM · Jog" copy is retired."""
    src = _read(LAYOUT)
    # Test hook present.
    assert 'data-testid="expand-jog-buttons"' in src
    # Locate the pill body and assert the load-bearing pieces.
    idx = src.find('function RealArmMinimizedPill(')
    assert idx != -1
    body = src[idx:idx + 2500]
    assert "background: '#16A34A'" in body, \
        'expand-jog-buttons pill must use Monitor Run green #16A34A'
    assert 'Expand Jog Buttons' in body, \
        'pill copy must read "Expand Jog Buttons"'
    assert "color: '#fff'" in body
    # Old REAL_ARM_RED background retired from the pill; the
    # RealArmChrome borderTop still uses it as an accent, so the
    # constant stays defined.
    assert 'REAL_ARM_RED' in src   # constant kept
    assert "'REAL ARM · Jog'" not in body, \
        'stale "REAL ARM · Jog" copy must be gone from the pill'


def test_collapse_jog_button_is_coherent_pair():
    """Chrome header's minimize control (formerly '−' glyph) reads
    "Collapse Jog Buttons" — coherent pair with the expand pill.
    The full-width expand/restore ⛶/✕ glyph stays; that's a
    layout modifier, not the jog-visibility toggle."""
    src = _read(LAYOUT)
    assert 'data-testid="collapse-jog-buttons"' in src
    idx = src.find('data-testid="collapse-jog-buttons"')
    slice_ = src[max(0, idx - 200):idx + 400]
    assert 'Collapse Jog Buttons' in slice_
    assert "setMode('MINIMIZED')" in slice_, \
        'collapse button must set MINIMIZED, mirroring the expand pill'


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

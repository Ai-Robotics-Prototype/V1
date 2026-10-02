"""Jog surface RIGHT column retirement pinned regression (2026-09-08).

Directive:
  2. REMOVE from the jog surface: Run…, Pause, STOP, Home, IDLE·1/5 —
     program execution lives on Monitor.
  3. E-STOP: remove the duplicate (top-bar E-STOP is provably always
     visible via App's grid `topbar` row; jog EXPANDED only expands
     inside the `content` row, so the topbar row still renders).
  4. TEACH POSITION: retired — the only mount site (View3DLayout) never
     passed `onTeach`, so the button was permanently disabled; teach
     flows have their own bespoke buttons (PointsPanel.onTeach,
     ProgramEditor's RecordPad wrapping the shared HoldButton).
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
JOG = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JogControls.jsx'))
VIEW = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'View3DLayout.jsx'))
APP = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'App.jsx'))
TOPBAR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'TopBar.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_all_comments(src):
    """Strip JSX block comments, C block comments, and JS line
    comments — retirement blocks intentionally reference the removed
    names so a code-only view is required for the assertions below."""
    s = re.sub(r'\{/\*.*?\*/\}', '', src, flags=re.DOTALL)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
    s = '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))
    return s


def test_jog_signature_no_longer_takes_onteach_or_runconfirm():
    """Signature is now `JogControls({ maximized = false })` — the two
    dead props (`onTeach`, `runConfirm`) are removed. Prevents a
    future edit from re-adding them without noticing the surface no
    longer renders any button that would consume them."""
    code = _strip_all_comments(_read(JOG))
    assert 'function JogControls({ maximized = false })' in code, \
        'JogControls signature must be `{ maximized = false }` only'
    assert 'onTeach' not in code, \
        'onTeach prop retired — right-column Teach button is gone'
    assert 'runConfirm' not in code, \
        'runConfirm prop retired — right-column Run button is gone'


def test_right_column_render_and_confirm_modal_gone():
    """The RIGHT-column render (Run/Pause/STOP/Home/IDLE·N/M/E-STOP/
    Teach Position) is gone from JogControls, and so is the
    runConfirm modal ("Start the program?"). Copy strings serve as
    the fence — they're distinctive to that render and appear
    nowhere else legitimate in this file."""
    code = _strip_all_comments(_read(JOG))
    # Run/Pause/STOP labels — the exact right-column button copy.
    assert '▶ Run' not in code, 'Run button retired'
    assert '▶ Resume' not in code, 'Resume state retired with Run button'
    assert '⏸ Pause' not in code, 'Pause button retired'
    assert '⌂ Home' not in code, 'Home button retired'
    # STOP appears also in the banner text ("press STOP to jog") — so
    # look for the standalone button label between button tags. The
    # right-column STOP button's onClick wired cancelProgram.
    assert 'cancelProgram' not in code, \
        'cancelProgram (STOP button handler) retired'
    # IDLE·N/M readout used `{program_step + 1}/{program_total}` in the
    # right column. It stays in the banner path via `program_step` (for
    # the "PROGRAM RUNNING (…)" copy) — but the standalone readout is
    # gone. Fence: the standalone div's border strip is unique.
    assert "borderTop: '1px solid #e5e7eb', borderBottom" not in code, \
        'IDLE·N/M readout div (border-top+border-bottom strip) retired'
    # Local E-STOP button — its title='Emergency stop' attribute was
    # unique to this button. Copy 'Emergency stop' also appears in an
    # alarm-code translator elsewhere in the file, so we fence on the
    # attribute form + on the triggerEstop handler.
    assert 'title="Emergency stop"' not in code, \
        'Local E-STOP button retired (top-bar E-STOP owns the surface)'
    assert 'triggerEstop' not in code, \
        'triggerEstop store handler retired from JogControls'
    # Teach Position button + label.
    assert 'Teach Position' not in code, 'Teach Position button retired'
    assert 'Save current pose as a teach point' not in code, \
        'Teach button tooltip retired'
    # Run-confirm modal copy.
    assert 'Start the program?' not in code, \
        'Run-confirm modal retired'
    assert 'Run program' not in code, \
        'Run-confirm modal CTA retired'


def test_dead_store_hooks_and_helpers_removed():
    """These store hooks + local helpers ONLY fed the RIGHT column and
    its confirm modal. Regression fence prevents them from creeping
    back as re-imports that never render anything."""
    code = _strip_all_comments(_read(JOG))
    for symbol in (
        'useStore((s) => s.triggerEstop)',
        'useStore((s) => s.homeRobot)',
        'useStore((s) => s.runProgram)',
        'useStore((s) => s.pauseProgram)',
        'useStore((s) => s.resumeProgram)',
        'useStore((s) => s.cancelProgram)',
        'useStore((s) => s.program)',
        'stepCount',
        'programLabel',
        'handleRun',
        'runClick',
        'confirmRun',
        'confirmingRun',
        'setConfirmingRun',
        'runBtnBase',
        'rightColW',
        'actionMinW',
        'actionMinH',
        'actionFont',
        'actionGap',
    ):
        assert symbol not in code, \
            f'{symbol} must be retired from JogControls (right-column dependency)'


def test_view3d_drops_runconfirm_prop():
    """View3DLayout was the only JogControls mount site. It no longer
    passes `runConfirm` because the surface has no Run button."""
    code = _strip_all_comments(_read(VIEW))
    assert '<JogControls maximized={isExpanded} />' in code, \
        'View3DLayout must mount JogControls with only `maximized` — ' \
        'no `runConfirm`, no `onTeach`.'
    assert 'runConfirm' not in code, \
        'View3DLayout must not pass runConfirm — the prop no longer exists'


def test_topbar_estop_survives_and_lives_outside_the_content_grid_row():
    """Item 3 pause condition: local E-STOP removal is only safe if
    the top-bar E-STOP is always visible when the jog surface is
    EXPANDED. Two-part fence:
       a. TopBar.jsx renders an E-STOP button (unconditionally, not
          gated behind a jog-mode flag).
       b. App.jsx puts TopBar in its own grid row (`topbar`) OUTSIDE
          the `content` row where the jog surface expands. So even
          under `isExpanded ? height:'100%'` inside content, the
          outer grid still allocates the topbar row above.
    """
    topbar = _read(TOPBAR)
    # E-STOP button copy is present. (TopBar is the ONE surface that
    # renders it now — no other unconditional mount.)
    assert 'E-STOP' in topbar, \
        'TopBar must still render an E-STOP button'
    app = _read(APP)
    # The outer grid has topbar / content / statusbar rows.
    assert "gridTemplateAreas: '\"topbar\" \"content\" \"statusbar\"'" in app, \
        'App must keep the three-row grid so topbar renders above content'
    # TopBar renders in the topbar grid area.
    assert "gridArea: 'topbar'" in app, \
        'TopBar must render in the topbar grid area (outside content)'


def test_jog_module_still_exports_holdbutton_for_teach_flows():
    """ProgramEditor's teach flow imports HoldButton from JogControls
    as a shared primitive (see ProgramEditor.jsx: `import { HoldButton }
    from './JogControls'`). Removing the right column must NOT break
    that named export — Teach Position button retirement is only
    about the SURFACE button, not the underlying primitive."""
    src = _read(JOG)
    assert re.search(r'export\s+function\s+HoldButton\s*\(', src) \
        or re.search(r'export\s+const\s+HoldButton\s*=', src) \
        or 'export { HoldButton }' in src, \
        'HoldButton must still be exported from JogControls for the ' \
        "teach flow's RecordPad wrapper"

"""Configure tab cleanup regression (2026-09-04 operator directive).

Directive:
  1. Retire from Configure: OPERATOR MODE toggle, PROVENANCE card,
     THIS DEVICE card (as a prime card).
  2. KEEP Setup Wizard - Cells as centerpiece.
  3. RELOCATE (do not delete):
       a. Self-collision guard row inside the cell / commissioning
          area — always visible, red-when-OFF invariant preserved.
       b. cam0 extrinsic calibration behind a "Camera calibration"
          disclosure, closed by default, full tool intact when open.
  4. Operator/Engineer mode toggle: audited as VESTIGIAL — only
     ControlStrip.jsx read useStore.mode, and ControlStrip is not
     mounted. Plumbing (`mode`/`setMode` slots in useStore, persist
     partialize entry) deleted along with the UI.
  5. Device rename affordance moved into an "Advanced" disclosure
     at the bottom — device_id/name plumbing (event log + teach-
     lock banners depend on it) stays intact.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
CFG  = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'ConfigureLayout.jsx'))
STORE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'store', 'useStore.js'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_comments(src):
    """Strip line comments, C-style block comments, and JSX block
    comments so my own retirement notes don't false-match the
    tests."""
    s = re.sub(r'/\*.*?\*/',   '', src, flags=re.DOTALL)
    s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.DOTALL)
    return '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))


def test_operator_mode_toggle_retired_from_configure():
    """Toggle UI + its store reads (`useStore((s) => s.mode)`,
    `useStore((s) => s.setMode)`) must be gone from ConfigureLayout.
    Rendered `Operator Mode` label + the .map over ['operator',
    'engineer'] both must be absent from the code (comments allowed
    to reference them for the retirement note)."""
    code = _strip_comments(_read(CFG))
    assert "useStore((s) => s.mode)" not in code
    assert "useStore((s) => s.setMode)" not in code
    assert 'Operator Mode' not in code
    assert "['operator', 'engineer']" not in code


def test_provenance_section_retired():
    """No function ProvenanceSection() and no <ProvenanceSection />
    render in the default view."""
    code = _strip_comments(_read(CFG))
    assert 'function ProvenanceSection(' not in code
    assert '<ProvenanceSection' not in code
    # /api/deploy_status is still referenced ONLY in the retirement
    # comment; DeployStatusBanner (a separate component) owns the
    # live surface — Configure no longer duplicates it.


def test_device_identity_relocated_into_advanced_disclosure():
    """DeviceIdentitySection still exists and still renders — but
    inside the Advanced <details> disclosure, not as a prime card
    at the top level of Configure."""
    code = _strip_comments(_read(CFG))
    # Function still defined (rename affordance still available).
    assert 'function DeviceIdentitySection(' in code
    # Rendered exactly once — inside a <details> block whose
    # <summary> reads "Advanced".
    render_idx = code.find('<DeviceIdentitySection')
    assert render_idx != -1, 'DeviceIdentitySection must still render'
    # There should be no SECOND render (would mean the retired
    # top-level call site slipped back in).
    assert code.count('<DeviceIdentitySection') == 1
    # Search backwards ~1500 chars for the <summary> Advanced.
    window = code[max(0, render_idx - 1500):render_idx]
    assert '<details' in window
    assert '>\n          Advanced\n' in window or 'Advanced\n' in window


def test_camera_calibration_wrapped_in_closed_disclosure():
    """Cam0CalibrationCard renders INSIDE a <details> whose
    <summary> is 'Camera calibration'. Collapsed by default (no
    `open` attribute on the <details>)."""
    code = _strip_comments(_read(CFG))
    render_idx = code.find('<Cam0CalibrationCard')
    assert render_idx != -1
    # ~800 char window looks back to the enclosing <details>.
    window = code[max(0, render_idx - 800):render_idx]
    assert '<details' in window
    m = re.search(r'<details([^>]*)>', window)
    assert m, 'no <details> tag before <Cam0CalibrationCard />'
    assert 'open=' not in m.group(1), \
        'Camera calibration disclosure must be collapsed by default'
    # Summary text present in the window.
    assert 'Camera calibration' in window


def test_self_collision_guard_visible_and_relocated():
    """SelfCollisionGuardSection is still rendered — the guard's
    always-visible-when-OFF invariant is load-bearing per operator
    directive. Its position in the render tree must sit AFTER the
    CellSetupSection (relocated into the cell / commissioning
    area)."""
    code = _strip_comments(_read(CFG))
    cell_idx = code.find('<CellSetupSection')
    guard_idx = code.find('<SelfCollisionGuardSection')
    assert cell_idx != -1 and guard_idx != -1
    assert guard_idx > cell_idx, \
        ('SelfCollisionGuardSection must render inside/after the '
         'CellSetupSection area, not before it')
    # And the section internals must still carry the red-when-OFF
    # test hook (`collision-guard-toggle` data-testid).
    assert 'data-testid="collision-guard-toggle"' in _read(CFG)


def test_no_top_level_provenance_or_this_device_card():
    """Regression fence: Configure's outer render tree must not
    contain <ProvenanceSection /> or a top-level
    <DeviceIdentitySection /> before the Advanced disclosure. Only
    the four operator-approved surfaces render at the top level
    (SystemCheckSection + CellSetupSection + guard row + Camera
    calibration disclosure + Motion recordings + Advanced). This
    test is order-agnostic beyond guard-after-cell (covered above)
    — it only asserts what MUST NOT be there."""
    code = _strip_comments(_read(CFG))
    # These retired imports/renders would fail the acceptance:
    assert '<ProvenanceSection' not in code
    # DeviceIdentitySection renders exactly once, inside Advanced —
    # covered by test_device_identity_relocated_into_advanced_disclosure.


def test_usestore_mode_plumbing_retired():
    """The vestigial `mode` slot (default 'operator') + `setMode`
    action + persist partialize entry are removed from useStore."""
    code = _strip_comments(_read(STORE))
    # `mode: 'operator'` slot at store init retired.
    assert "mode: 'operator'," not in code
    # setMode(mode) action retired.
    assert 'setMode(mode) {' not in code
    # persist partialize no longer lists `mode: state.mode`.
    assert 'mode: state.mode' not in code


def test_pause_condition_reported_not_violated():
    """The audit that gave us permission to delete the mode
    plumbing rests on ControlStrip.jsx being unmounted. Pin that
    invariant so a future edit that remounts ControlStrip without
    reintroducing `mode` in the store fails CI (either bring back
    `mode`, or delete ControlStrip)."""
    root = os.path.abspath(os.path.join(HERE, '..', 'frontend', 'src'))
    hits = []
    for base, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith(('.jsx', '.js')):
                continue
            # Skip the component's own definition and any test file.
            if fn == 'ControlStrip.jsx' or 'test' in fn.lower():
                continue
            p = os.path.join(base, fn)
            with open(p) as fh:
                src = fh.read()
            if re.search(r'<ControlStrip\b', src):
                hits.append(p)
    assert not hits, (
        'ControlStrip.jsx has been remounted at: ' + ', '.join(hits)
        + '. Either bring back useStore.mode + setMode + persist '
          'entry, or delete ControlStrip.jsx.')

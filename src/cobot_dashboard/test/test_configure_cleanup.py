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


def test_device_identity_and_advanced_disclosure_retired():
    """2026-09-04 Configure additions (item 7): Advanced disclosure
    is retired entirely — no UI for device rename anywhere. The
    plumbing survives at the store layer (_teachDeviceLabel /
    setTeachDeviceLabel) so event-log tagging + teach-lock
    banners keep reading the label; this test pins that the UI is
    gone AND the store hooks are intact."""
    code = _strip_comments(_read(CFG))
    # DeviceIdentitySection is NEVER rendered.
    assert '<DeviceIdentitySection' not in code, \
        'DeviceIdentitySection must not render on Configure'
    # No Advanced disclosure anywhere.
    assert 'Advanced' not in code, \
        'Advanced <details> disclosure must be retired'
    # Store plumbing still present.
    store_src = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'store', 'useStore.js')))
    assert 'setTeachDeviceLabel(label)' in store_src
    assert '_teachDeviceLabel' in store_src


def test_camera_calibration_retired_but_backend_intact():
    """2026-09-04 Configure additions (item 8): the camera
    calibration section is retired from the UI entirely. Backend
    calibration endpoints stay intact (dormant) so the tool can be
    re-exposed when a camera is remounted; the component file
    (Cam0CalibrationCard.jsx) also stays on disk for the same
    reason."""
    code = _strip_comments(_read(CFG))
    assert '<Cam0CalibrationCard' not in code, \
        'Cam0CalibrationCard must not render on Configure'
    assert 'Camera calibration' not in code, \
        'Camera calibration disclosure retired — no UI'
    # Component file stays on disk for future re-exposure.
    card = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'components',
        'Cam0CalibrationCard.jsx'))
    assert os.path.isfile(card), \
        'Cam0CalibrationCard.jsx must stay on disk (dormant)'


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


def test_full_configure_is_exactly_cell_wizard_plus_guard():
    """2026-09-04 Configure additions item 10 acceptance: FULL
    Configure = cell wizard + collision guard row, nothing else.
    SystemCheckSection (services health), RecentRunsCard (motion
    recordings), Cam0CalibrationCard, and DeviceIdentitySection
    (Advanced) are all retired from the render tree."""
    code = _strip_comments(_read(CFG))
    # The only two rendered sections in the outer render tree:
    assert '<CellSetupSection' in code
    assert '<SelfCollisionGuardSection' in code
    # Retired renders — none of these may appear.
    for retired in ('<SystemCheckSection', '<RecentRunsCard',
                    '<Cam0CalibrationCard', '<DeviceIdentitySection',
                    '<ProvenanceSection'):
        assert retired not in code, \
            f'{retired} must be retired from Configure per item 10'


def test_configure_tab_flipped_full_only():
    """Item 10 acceptance: the Configure tab hides on basic devices.
    Flipped via FEATURE_MAP['configure'] = 'full'; TAB_TO_FEATURE
    already points at 'configure' so the TopBar tab filter does
    the hiding without touching the mapping."""
    import sys as _sys
    _sys.path.insert(0, os.path.abspath(os.path.join(
        HERE, '..', 'cobot_dashboard')))
    import edition as _ed
    assert _ed.FEATURE_MAP.get('configure') == 'full'
    assert not _ed.is_feature_enabled('configure', 'basic')
    assert _ed.is_feature_enabled('configure', 'full')


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

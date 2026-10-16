"""Pinned tests for the 2026-08-05 pallet teaching semantics doctrine.

OPERATOR DOCTRINE RULING (canonical):
  * Corners 1-3 define the pallet FRAME ONLY (origin + row axis +
    column axis + plane).
  * Point 4 is the CENTER of slot [1,1] (first-part datum).
  * Slot spacing comes EXCLUSIVELY from typed pitch values:
      slot[i,j] = datum
                + (i-1) · pitch_row · row_axis
                + (j-1) · pitch_col · col_axis
                + layer · layer_height · plane_normal
  * Corner-to-corner distance has NO required relationship to pitch.

These tests are the CI-enforceable form of the doctrine. Any future
refactor that reintroduces "measured pitch overrides typed" (pre-ruling
behavior) fails at least one of these tests.
"""

from __future__ import annotations

import pytest

from programming_by_demonstration.pallet_geometry import (
    validate_frame,
    _effective_pitches,
    derive_slot_tcps,
    compute_slot_offsets,
    _grid_extent_vs_frame_extent,
    _GRID_FIT_TOLERANCE_M,
    _GRID_FIT_ERROR_RATIO,
)
from programming_by_demonstration.schema import PalletPlaceSpec


def _spec(**kw):
    """Build a PalletPlaceSpec from keyword overrides — a compact
    helper for readable fixtures."""
    base = {
        'rows':   2,
        'cols':   2,
        'layers': 1,
    }
    base.update(kw)
    return PalletPlaceSpec.from_dict(base)


# ── The LIVE case: pitch 150 mm, corners ~341/368 mm apart ────

def test_live_case_promote_passes_verbatim():
    """The operator's real case, verbatim: typed pitch 150 mm,
    corner-to-corner distances 341 mm (row) and 368 mm (col),
    2x2 grid. Pre-ruling: refused promote with a pitch-mismatch
    warning. Post-ruling: no findings; grid extent (1×150 = 150 mm)
    is well inside the frame extent (341 mm / 368 mm)."""
    spec = _spec(
        corner1_tcp=[0.000, 0.000, 0.000, 0, 0, 0],
        corner2_tcp=[0.341, 0.000, 0.000, 0, 0, 0],   # 341 mm along row axis
        corner3_tcp=[0.000, 0.368, 0.000, 0, 0, 0],   # 368 mm along col axis
        part_tcp=[0.010, 0.010, -0.020, 0, 0, 0],
        rows=2, cols=2, layers=1,
        pitch_row_mm=150.0,
        pitch_col_mm=150.0,
    )
    findings = validate_frame(spec)
    # No pitch-mismatch (retired). No grid-exceeds-frame (grid fits).
    codes = [f.get('code') for f in findings]
    assert 'row_pitch_mismatch' not in codes, (
        f'The RETIRED pitch-mismatch warning fired — doctrine '
        f'violation. Findings: {findings!r}')
    assert 'col_pitch_mismatch' not in codes
    assert 'row_grid_exceeds_frame' not in codes
    assert 'col_grid_exceeds_frame' not in codes


# ── _effective_pitches: typed-only, never measured ────────────

def test_effective_pitches_uses_typed_never_measured():
    """The core doctrine invariant: slot pitch = typed pitch,
    regardless of corner spacing. Pre-ruling, _effective_pitches
    overrode typed with measured when the frame was taught."""
    spec = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.400, 0.0, 0.0, 0, 0, 0],   # measured pitch would be 400 mm
        corner3_tcp=[0.0, 0.500, 0.0, 0, 0, 0],   # measured pitch would be 500 mm
        rows=2, cols=2, layers=1,
        pitch_row_mm=150.0,
        pitch_col_mm=200.0,
    )
    pr_m, pc_m, lh_m = _effective_pitches(spec)
    assert pr_m == 0.150, (
        f'Row pitch is not the TYPED value. Got {pr_m} m, expected 0.150 m.')
    assert pc_m == 0.200, (
        f'Column pitch is not the TYPED value. Got {pc_m} m, expected 0.200 m.')


def test_effective_pitches_taught_frame_does_not_override():
    """The specific pre-ruling failure mode: has_taught_frame → True
    used to trigger measured-override. Confirm has_taught_frame no
    longer changes _effective_pitches output."""
    typed = _spec(
        rows=3, cols=3, pitch_row_mm=100.0, pitch_col_mm=100.0)
    with_frame = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.300, 0.0, 0.0, 0, 0, 0],
        corner3_tcp=[0.0, 0.300, 0.0, 0, 0, 0],
        rows=3, cols=3, pitch_row_mm=100.0, pitch_col_mm=100.0,
    )
    assert _effective_pitches(typed) == _effective_pitches(with_frame), (
        'Teaching a frame changed the effective pitch — doctrine '
        'violation. Typed value must be authoritative regardless.')


# ── derive_slot_tcps: canonical formula ────────────────────────

def test_derive_slot_tcps_uses_datum_plus_i_times_typed_pitch():
    """slot[i,j] = datum + (i-1)·pitch_row·row_axis
                        + (j-1)·pitch_col·col_axis
    Verify against a hand-computed 2x2 grid with pitch 150 mm on
    axis-aligned corners. Expected slot centers:
       [1,1] = datum
       [1,2] = datum + 150 mm along row axis
       [2,1] = datum + 150 mm along col axis
       [2,2] = datum + 150 mm on both."""
    spec = _spec(
        corner1_tcp=[0.000, 0.000, 0.000, 0, 0, 0],
        corner2_tcp=[0.400, 0.000, 0.000, 0, 0, 0],   # 400 mm frame
        corner3_tcp=[0.000, 0.400, 0.000, 0, 0, 0],
        part_tcp=[0.0, 0.0, 0.0, 0, 0, 0],            # datum at origin
        rows=2, cols=2, layers=1,
        pitch_row_mm=150.0,
        pitch_col_mm=150.0,
    )
    slots = derive_slot_tcps(spec, anchor_tcp_m=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0))
    by_rc = {(s['row'], s['col']): s['tcp_m'] for s in slots}
    def _xyz(tcp): return (round(tcp[0], 6), round(tcp[1], 6), round(tcp[2], 6))
    assert _xyz(by_rc[(0, 0)]) == (0.0, 0.0, 0.0)
    assert _xyz(by_rc[(0, 1)]) == (0.150, 0.0, 0.0), (
        f'slot[1,2] should be at datum + 150mm along row axis, got '
        f'{by_rc[(0, 1)]!r}')
    assert _xyz(by_rc[(1, 0)]) == (0.0, 0.150, 0.0)
    assert _xyz(by_rc[(1, 1)]) == (0.150, 0.150, 0.0)


# ── Grid-fits-frame: warning + error ──────────────────────────

def test_grid_extent_warning_fires_when_grid_overshoots_frame_small():
    """Row grid needs (N-1)·pitch = 3·200 = 600 mm; frame is 400 mm.
    Ratio 1.5 → threshold — set the frame slightly smaller so we
    are inside the warning band (ratio < 1.5) yet clearly over the
    tolerance (5 mm slack)."""
    spec = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.500, 0.0, 0.0, 0, 0, 0],   # 500 mm frame
        corner3_tcp=[0.0, 0.500, 0.0, 0, 0, 0],
        part_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        rows=3, cols=4,      # grid extent = 3·pitch_row (row) + 2·pitch_col (col)
        pitch_row_mm=200.0,  # 3·200 = 600 mm (over 500 by 100, ratio 1.2)
        pitch_col_mm=100.0,  # 2·100 = 200 mm (fits)
    )
    findings = _grid_extent_vs_frame_extent(spec)
    codes = [f['code'] for f in findings]
    assert 'row_grid_exceeds_frame' in codes, (
        f'Grid-fits-frame warning did not fire. Findings: {findings!r}')
    row_f = next(f for f in findings if f['code'] == 'row_grid_exceeds_frame')
    assert row_f['severity'] == 'warning'
    # Numbers are surfaced in the message.
    assert '600 mm' in row_f['message']
    assert '500 mm' in row_f['message']
    assert '100 mm' in row_f['message']   # overshoot
    # Column axis fits — no col finding.
    assert 'col_grid_exceeds_frame' not in codes


def test_grid_extent_error_fires_on_pitch_typo_wildly_over():
    """Simulate a pitch typo: pitch 1500 mm on a 300 mm frame with
    2 slots. Grid extent = 1·1500 = 1500 mm, ratio = 5.0 →
    ERROR (above _GRID_FIT_ERROR_RATIO = 1.5)."""
    spec = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.300, 0.0, 0.0, 0, 0, 0],
        corner3_tcp=[0.0, 0.300, 0.0, 0, 0, 0],
        part_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        rows=2, cols=2,
        pitch_row_mm=1500.0,   # typo: 150 mm intended, 1500 typed
        pitch_col_mm=150.0,
    )
    findings = _grid_extent_vs_frame_extent(spec)
    codes = [f['code'] for f in findings]
    assert 'row_grid_exceeds_frame' in codes
    row_f = next(f for f in findings if f['code'] == 'row_grid_exceeds_frame')
    assert row_f['severity'] == 'error', (
        f'A 5x-frame pitch typo must be an ERROR, not a warning. '
        f'Got: {row_f!r}')
    assert row_f['ratio'] > _GRID_FIT_ERROR_RATIO


def test_grid_extent_no_finding_when_grid_fits():
    """The live case: grid extent 150 mm fits in a 341 mm frame."""
    spec = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.341, 0.0, 0.0, 0, 0, 0],
        corner3_tcp=[0.0, 0.368, 0.0, 0, 0, 0],
        part_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        rows=2, cols=2,
        pitch_row_mm=150.0,
        pitch_col_mm=150.0,
    )
    findings = _grid_extent_vs_frame_extent(spec)
    assert findings == [], (
        f'Legitimate config with grid inside frame triggered '
        f'grid-exceeds-frame — false positive. Findings: {findings!r}')


def test_grid_extent_tolerance_prevents_off_by_epsilon_warning():
    """When corners are taught a hair inside the last-slot centers
    (say, 3 mm inside a 200 mm pitch × 1 slot), the 5 mm slack
    absorbs it — no nuisance warning."""
    spec = _spec(
        corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        corner2_tcp=[0.197, 0.0, 0.0, 0, 0, 0],   # 3 mm short of 200
        corner3_tcp=[0.0, 0.400, 0.0, 0, 0, 0],
        part_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
        rows=2, cols=2,
        pitch_row_mm=200.0,
        pitch_col_mm=200.0,
    )
    findings = _grid_extent_vs_frame_extent(spec)
    assert findings == [], (
        f'{_GRID_FIT_TOLERANCE_M*1000:.0f}mm tolerance should absorb a '
        f'3mm off-by-epsilon; got {findings!r}')


# ── Retired code doesn't fire under any spec ────────────────

def test_row_pitch_mismatch_never_fires_anymore():
    """The RETIRED validator's code must not appear anywhere in the
    findings list. If any future refactor reintroduces it, this
    test alerts."""
    for teach_mode in ('near_slot', 'far_slot'):
        spec = _spec(
            corner1_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
            corner2_tcp=[0.500, 0.0, 0.0, 0, 0, 0],
            corner3_tcp=[0.0, 0.500, 0.0, 0, 0, 0],
            part_tcp=[0.0, 0.0, 0.0, 0, 0, 0],
            rows=2, cols=2,
            pitch_row_mm=100.0,          # measured would be 500 mm — big diff
            pitch_col_mm=100.0,
            teach_mode=teach_mode,
        )
        findings = validate_frame(spec)
        codes = [f.get('code') for f in findings]
        assert 'row_pitch_mismatch' not in codes, (
            f'RETIRED validator fired with teach_mode={teach_mode!r}. '
            f'Findings: {findings!r}')
        assert 'col_pitch_mismatch' not in codes


# ── Copy pinning: doctrine language in the wizard + editor ─────

def test_wizard_step4_says_center_of_first_part_position():
    """The teach-step-4 prompt must teach the doctrine — 'CENTER
    of the first place position' (not 'tool contact pose')."""
    import os
    HERE = os.path.dirname(os.path.abspath(__file__))
    WIZARD = os.path.abspath(os.path.join(
        HERE, '..', '..', 'cobot_dashboard', 'frontend', 'src',
        'components', 'ProgramWizard.jsx'))
    with open(WIZARD) as fh:
        src = fh.read()
    assert 'CENTER of' in src or 'center of' in src.lower(), (
        'ProgramWizard step-4 copy does not mention CENTER — the '
        'operator has to infer the doctrine.')
    # And it must reference "first place position" or "first-part
    # datum" or similar per-ruling wording.
    assert 'first place position' in src.lower() \
        or 'first-part datum' in src.lower() \
        or 'first part center' in src.lower() \
        or 'slot [1,1] datum' in src.lower()


def test_pallet_config_editor_labels_pitch_as_center_to_center():
    """The parameters dialog must label pitch as 'center-to-center
    spacing between parts' — so the operator sees what pitch means
    without opening the docs."""
    import os
    HERE = os.path.dirname(os.path.abspath(__file__))
    EDITOR = os.path.abspath(os.path.join(
        HERE, '..', '..', 'cobot_dashboard', 'frontend', 'src',
        'components', 'ProgramEditor.jsx'))
    with open(EDITOR) as fh:
        src = fh.read()
    assert 'center-to-center between parts' in src, (
        'PalletConfigEditor pitch labels do not include the '
        '"center-to-center between parts" copy required by the '
        '2026-08-05 doctrine ruling.')


def test_wizard_corner_prompts_say_pitch_is_typed_not_derived():
    """The three CORNER prompts must clarify that they lock only
    direction — pitch is typed. Prevents the operator from thinking
    corners set slot count/spacing."""
    import os
    HERE = os.path.dirname(os.path.abspath(__file__))
    WIZARD = os.path.abspath(os.path.join(
        HERE, '..', '..', 'cobot_dashboard', 'frontend', 'src',
        'components', 'ProgramWizard.jsx'))
    with open(WIZARD) as fh:
        src = fh.read()
    # At least one of the corner-2/3 prompts must reference pitch
    # being typed / not derived from corners.
    assert 'ROW DIRECTION only' in src or 'row direction only' in src.lower()
    assert 'COLUMN DIRECTION only' in src or 'column direction only' in src.lower()
    # And the redirect to typed pitch (parameters dialog).
    assert 'parameters dialog' in src.lower() \
        or 'typed pitch' in src.lower() \
        or 'pitch is typed' in src.lower()

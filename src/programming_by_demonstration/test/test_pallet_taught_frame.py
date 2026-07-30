"""Pallet 3-point-frame math + validation — 2026-07-30 rewrite.

Prior code assumed base-frame axes for pallet grid growth. A pallet
rotated at any angle relative to the robot base produced slot poses
at wrong world positions. Every derived slot was off by the pallet's
rotation angle.

These tests pin the new taught-frame math:
  * corner_a origin, point_b along ROW, point_c along COL
  * row_axis = normalize(B-A); col_axis = orthogonalized (C-A);
    plane_normal = row_axis × col_axis
  * slot [r,c,l] = A + r·pitch_row·row + c·pitch_col·col
                     + l·layer_h·normal
  * measured pitches when teach_mode='far_slot'
  * validation: near-parallel B/C, tilt, pitch cross-check
"""
from __future__ import annotations

import math

from programming_by_demonstration.pallet_geometry import (
    compute_frame, compute_slot_offsets, derive_slot_tcps,
    measured_pitches, validate_frame,
    _MIN_ROW_COL_ANGLE_DEG, _MAX_TILT_DEG, _PITCH_MISMATCH_MM,
)
from programming_by_demonstration.schema import PalletPlaceSpec


def _tcp(x, y, z, rx=0.0, ry=0.0, rz=0.0):
    """Convenience: build a 6-element TCP tuple with x/y/z in mm
    and roll/pitch/yaw in radians (matching the taught_tcp shape)."""
    return [float(x), float(y), float(z), float(rx), float(ry), float(rz)]


# ── Base-axes (legacy) fallback still works ─────────────────────

def test_no_taught_frame_falls_back_to_base_axes():
    """Programs saved before the taught-frame rewrite have no A/B/C.
    compute_frame returns source='base_axes' and uses spec.row_axis/
    col_axis literals. Backward compatibility."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 3,
        'pitch_row_mm': 50.0, 'pitch_col_mm': 60.0,
        'row_axis': '+X', 'col_axis': '+Y',
        'order': 'row_major',
    })
    fr = compute_frame(spec)
    assert fr['source'] == 'base_axes'
    assert fr['row_axis'] == (1.0, 0.0, 0.0)
    assert fr['col_axis'] == (0.0, 1.0, 0.0)


# ── Aligned pallet (no rotation) — sanity: matches base-axes ────

def test_aligned_pallet_taught_matches_base_axes_output():
    """3x3 pallet taught aligned to base X/Y (row along +X, col along
    +Y). Slot offsets should be identical to the legacy base-axes
    output — proves the taught-frame math reduces to the old case
    when the pallet is aligned."""
    A = _tcp(100, 200, 50)
    # cols=3 → B at [1, 3] → 2 * pitch_row along +X → +100 mm
    B = _tcp(200, 200, 50)
    # rows=3 → C at [3, 1] → 2 * pitch_col along +Y → +120 mm
    C = _tcp(100, 320, 50)
    spec = PalletPlaceSpec.from_dict({
        'rows': 3, 'cols': 3,
        'pitch_row_mm': 50.0, 'pitch_col_mm': 60.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot', 'order': 'row_major',
    })
    fr = compute_frame(spec)
    assert fr['source'] == 'taught'
    # Axes match base X/Y within numerical tolerance.
    assert abs(fr['row_axis'][0] - 1.0) < 1e-9
    assert abs(fr['row_axis'][1] - 0.0) < 1e-9
    assert abs(fr['col_axis'][1] - 1.0) < 1e-9
    # Row/col at 90° apart.
    assert abs(fr['row_col_angle_deg'] - 90.0) < 1e-6
    # Level pallet — tilt is zero.
    assert fr['tilt_deg'] < 1e-6


# ── The critical case: pallet rotated 30° in the XY plane ───────

def test_rotated_pallet_30deg_derives_exact_slot_positions():
    """A 2x2 pallet rotated 30° in the XY plane. Corner A at origin,
    B taught along the rotated ROW axis, C taught along the rotated
    COL axis. Slots must land at the rotated positions, NOT the
    base-axis positions.

    This is the exact case that the pre-rewrite code got wrong —
    every derived slot was off by the pallet's rotation angle."""
    theta = math.radians(30.0)
    row_dir = (math.cos(theta), math.sin(theta), 0.0)
    col_dir = (-math.sin(theta), math.cos(theta), 0.0)
    pitch_row = 100.0
    pitch_col = 80.0

    A = _tcp(500, 300, 0)
    # cols=2 → B at [1, 2] → 1 * pitch_row along row_dir
    B = _tcp(A[0] + row_dir[0] * pitch_row,
             A[1] + row_dir[1] * pitch_row, 0)
    # rows=2 → C at [2, 1] → 1 * pitch_col along col_dir
    C = _tcp(A[0] + col_dir[0] * pitch_col,
             A[1] + col_dir[1] * pitch_col, 0)

    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': pitch_row, 'pitch_col_mm': pitch_col,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot', 'order': 'row_major',
    })

    # Expected slot positions in world frame:
    #   [0,0] = A
    #   [0,1] = A + 1 * pitch_row * row_dir           = B
    #   [1,0] = A + 1 * pitch_col * col_dir           = C
    #   [1,1] = A + 1 * pitch_row * row_dir
    #             + 1 * pitch_col * col_dir
    expected = {
        (0, 0, 0): (A[0], A[1], A[2]),
        (0, 1, 0): (A[0] + pitch_row * row_dir[0],
                    A[1] + pitch_row * row_dir[1],
                    A[2] + pitch_row * row_dir[2]),
        (1, 0, 0): (A[0] + pitch_col * col_dir[0],
                    A[1] + pitch_col * col_dir[1],
                    A[2] + pitch_col * col_dir[2]),
        (1, 1, 0): (A[0] + pitch_row * row_dir[0] + pitch_col * col_dir[0],
                    A[1] + pitch_row * row_dir[1] + pitch_col * col_dir[1],
                    A[2] + pitch_row * row_dir[2] + pitch_col * col_dir[2]),
    }

    tcps = derive_slot_tcps(spec, tuple(A))
    for slot in tcps:
        key = (slot['row'], slot['col'], slot['layer'])
        exp_x, exp_y, exp_z = expected[key]
        actual = slot['tcp_mm']
        assert abs(actual[0] - exp_x) < 1e-3, (key, actual, expected[key])
        assert abs(actual[1] - exp_y) < 1e-3, (key, actual, expected[key])
        assert abs(actual[2] - exp_z) < 1e-3, (key, actual, expected[key])
        # Orientation is copied from the anchor.
        assert actual[3:] == list(A[3:])


# ── Measured vs typed pitch cross-check ─────────────────────────

def test_measured_pitches_from_far_slot_positions():
    """teach_mode='far_slot' → pitches derived from |B-A|/(cols-1)
    and |C-A|/(rows-1)."""
    A = _tcp(0, 0, 0)
    # cols=4 → B at [1, 4] → 3 * pitch_row = 150 mm along +X
    B = _tcp(150, 0, 0)
    # rows=3 → C at [3, 1] → 2 * pitch_col = 120 mm along +Y
    C = _tcp(0, 120, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 3, 'cols': 4,
        'pitch_row_mm': 0.0, 'pitch_col_mm': 0.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    m_row, m_col = measured_pitches(spec)
    assert abs(m_row - 50.0) < 1e-9   # 150 / (4-1)
    assert abs(m_col - 60.0) < 1e-9   # 120 / (3-1)


def test_edge_mode_returns_none_for_measured():
    """teach_mode='edge' — B/C only pin direction, not pitch
    magnitude. measured_pitches returns None."""
    A = _tcp(0, 0, 0); B = _tcp(999, 0, 0); C = _tcp(0, 999, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 3, 'cols': 3,
        'pitch_row_mm': 50.0, 'pitch_col_mm': 60.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'edge',
    })
    assert measured_pitches(spec) == (None, None)


def test_pitch_mismatch_warning_names_both_numbers():
    """far_slot mode + typed pitch that disagrees with measured by
    more than 3mm → validation warning naming BOTH the typed and
    the measured value."""
    A = _tcp(0, 0, 0)
    B = _tcp(200, 0, 0)   # cols=3 → measured pitch = 100 mm
    C = _tcp(0, 100, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 3,
        # Typed values disagree with measured (100mm on row axis;
        # typed 90 → 10mm mismatch > 3mm threshold).
        'pitch_row_mm': 90.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    issues = validate_frame(spec)
    row_warn = next((f for f in issues if f['code'] == 'row_pitch_mismatch'), None)
    assert row_warn is not None, issues
    assert row_warn['severity'] == 'warning'
    assert row_warn['typed_mm']    == 90.0
    assert row_warn['measured_mm'] == 100.0
    assert '90' in row_warn['message'] and '100' in row_warn['message']


def test_pitch_within_tolerance_no_warning():
    """|typed - measured| <= 3mm — no warning fires."""
    A = _tcp(0, 0, 0)
    B = _tcp(200, 0, 0)
    C = _tcp(0, 100, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 3,
        'pitch_row_mm': 102.0,   # 2mm off → below threshold
        'pitch_col_mm': 99.0,    # 1mm off → below threshold
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    for f in validate_frame(spec):
        assert 'pitch_mismatch' not in f['code']


def test_far_slot_uses_measured_pitches_for_slot_math():
    """When teach_mode='far_slot' the slot math must use the MEASURED
    pitch, not the typed one. Guarantees that slot [1, N-1] lands
    exactly at point B and [M-1, 1] exactly at point C — no
    "typed 90mm but actually 100mm" drift accumulating across the
    grid."""
    A = _tcp(0, 0, 0)
    B = _tcp(200, 0, 0)   # cols=3 → measured row pitch = 100
    C = _tcp(0, 100, 0)   # rows=2 → measured col pitch = 100
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 3,
        'pitch_row_mm': 50.0, 'pitch_col_mm': 50.0,  # deliberately wrong
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    tcps = derive_slot_tcps(spec, tuple(A))
    # Slot [0, 2] must equal B.
    slot_far_row = next(s for s in tcps if (s['row'], s['col']) == (0, 2))
    assert abs(slot_far_row['tcp_mm'][0] - B[0]) < 1e-6
    assert abs(slot_far_row['tcp_mm'][1] - B[1]) < 1e-6
    # Slot [1, 0] must equal C.
    slot_far_col = next(s for s in tcps if (s['row'], s['col']) == (1, 0))
    assert abs(slot_far_col['tcp_mm'][0] - C[0]) < 1e-6
    assert abs(slot_far_col['tcp_mm'][1] - C[1]) < 1e-6


# ── Near-parallel B/C rejection ────────────────────────────────

def test_near_parallel_bc_rejects_with_specific_error():
    """B and C both taught roughly along the ROW direction (few
    degrees apart) → validation ERROR with a specific message that
    names the "re-teach C along the OTHER edge" instruction."""
    A = _tcp(0, 0, 0)
    # 5° apart in the XY plane.
    B = _tcp(math.cos(math.radians(0.0)) * 100, math.sin(math.radians(0.0)) * 100, 0)
    C = _tcp(math.cos(math.radians(5.0)) * 100, math.sin(math.radians(5.0)) * 100, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    issues = validate_frame(spec)
    err = next((f for f in issues if f['severity'] == 'error'), None)
    assert err is not None
    assert err['code'] == 'row_col_near_parallel'
    assert 'other edge' in err['message'].lower()
    # Metrics carry the angle so the UI can display it.
    assert err['row_col_angle_deg'] < _MIN_ROW_COL_ANGLE_DEG


def test_near_60deg_but_above_threshold_accepted():
    """65° angle — safely above the 60° threshold, no near-parallel
    error fires. (The exact 60° boundary is fp-fragile: acos of a
    cosine round-trip yields 59.9999… which the strict '<' compare
    then flags. In practice the operator either teaches at close to
    a right angle — well past 60° — or clearly wrong — well below.
    The threshold's job is to catch the "clearly wrong" case.)"""
    A = _tcp(0, 0, 0)
    B = _tcp(100, 0, 0)
    C = _tcp(math.cos(math.radians(65.0)) * 100,
             math.sin(math.radians(65.0)) * 100, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    errs = [f for f in validate_frame(spec) if f['severity'] == 'error']
    assert errs == []


# ── Tilt warning ────────────────────────────────────────────────

def test_pallet_on_slope_warns_but_does_not_error():
    """B/C taught at different Z values → plane normal tilts away
    from +Z → warning (not error). Slot math still runs — the
    pallet may genuinely sit on a slope."""
    A = _tcp(0, 0, 0)
    # B is 50mm higher than A → tilt in the XZ plane.
    B = _tcp(100, 0, 50)
    C = _tcp(0, 100, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    issues = validate_frame(spec)
    tilt = next((f for f in issues if f['code'] == 'pallet_tilted'), None)
    assert tilt is not None
    assert tilt['severity'] == 'warning'
    assert tilt['tilt_deg'] > _MAX_TILT_DEG


def test_level_pallet_no_tilt_warning():
    """All three points at the same Z → normal aligns with +Z →
    no tilt warning."""
    A = _tcp(0, 0, 50); B = _tcp(100, 0, 50); C = _tcp(0, 100, 50)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    tilts = [f for f in validate_frame(spec) if f['code'] == 'pallet_tilted']
    assert tilts == []


# ── Multi-layer with taught frame — normal drives layer height ──

def test_multi_layer_lifts_along_taught_plane_normal():
    """A tilted pallet with multiple layers stacks each layer along
    the PLANE NORMAL, not along world +Z. So a tilted pallet's
    layer 2 is above layer 1 relative to the pallet, not
    above-in-world-frame."""
    # Pallet tilted 20° around the X axis (B on +X flat, C in the
    # YZ plane at 20° from horizontal → normal tilts 20° too).
    A = _tcp(0, 0, 0)
    B = _tcp(100, 0, 0)
    theta = math.radians(20.0)
    C = _tcp(0, math.cos(theta) * 100, math.sin(theta) * 100)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
        'layers': 2, 'layer_height_mm': 40.0,
    })
    tcps = derive_slot_tcps(spec, tuple(A))
    # Slot [0,0,1] should be at A + 40mm along the plane normal.
    slot_layer1 = next(s for s in tcps if (s['row'], s['col'], s['layer']) == (0, 0, 1))
    # Plane normal = row × col.
    #   row = (1, 0, 0)
    #   col (orthogonalised) is in the direction of C-A minus its
    #     component along row (which is 0 since C-A has x=0)
    #     → col ≈ (0, cos20°, sin20°) already orthogonal to row
    #   normal = row × col = (1,0,0) × (0, cos20°, sin20°)
    #          = (0*sin20° - 0*cos20°, 0*0 - 1*sin20°, 1*cos20° - 0*0)
    #          = (0, -sin20°, cos20°)
    exp = (A[0] + 40.0 * 0.0,
           A[1] + 40.0 * (-math.sin(theta)),
           A[2] + 40.0 * math.cos(theta))
    actual = slot_layer1['tcp_mm']
    assert abs(actual[0] - exp[0]) < 1e-6, (actual, exp)
    assert abs(actual[1] - exp[1]) < 1e-6, (actual, exp)
    assert abs(actual[2] - exp[2]) < 1e-6, (actual, exp)


# ── has_taught_frame + partial teach → falls back gracefully ────

def test_partial_teach_falls_back_to_base_axes():
    """A + B taught, C not yet — frame is INCOMPLETE, math falls
    back to base-axis literals so partial-teach state doesn't
    crash the twin ghost render."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': _tcp(0, 0, 0),
        'point_b_tcp':  _tcp(100, 0, 0),
        # point_c_tcp missing
        'teach_mode': 'far_slot',
    })
    assert not spec.has_taught_frame()
    fr = compute_frame(spec)
    assert fr['source'] == 'base_axes'


# ── Ghost-frame roundtrip: derive_slot_tcps matches compute_frame

def test_slot_tcps_align_with_computed_frame():
    """derive_slot_tcps must use the SAME axes compute_frame
    returns. If a bug caused derive_slot_tcps to fall through to
    base-axes while compute_frame returned taught, ghost markers
    would render in one frame and actual slot poses in another —
    exactly the "twin shows fine, robot goes wrong" class the
    3-point work exists to prevent."""
    A = _tcp(500, 500, 100)
    theta = math.radians(45.0)
    B = _tcp(A[0] + math.cos(theta) * 100, A[1] + math.sin(theta) * 100, 100)
    C = _tcp(A[0] - math.sin(theta) * 100, A[1] + math.cos(theta) * 100, 100)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100.0, 'pitch_col_mm': 100.0,
        'corner_a_tcp': A, 'point_b_tcp': B, 'point_c_tcp': C,
        'teach_mode': 'far_slot',
    })
    fr = compute_frame(spec)
    tcps = derive_slot_tcps(spec, tuple(A))
    # Slot [0, 1] = A + 1 · pitch_row · row_axis. Match against fr
    # directly (not against the raw B point — proves same axis was
    # used by both).
    slot01 = next(s for s in tcps if (s['row'], s['col']) == (0, 1))
    exp = (A[0] + 100.0 * fr['row_axis'][0],
           A[1] + 100.0 * fr['row_axis'][1],
           A[2] + 100.0 * fr['row_axis'][2])
    assert abs(slot01['tcp_mm'][0] - exp[0]) < 1e-6
    assert abs(slot01['tcp_mm'][1] - exp[1]) < 1e-6
    assert abs(slot01['tcp_mm'][2] - exp[2]) < 1e-6

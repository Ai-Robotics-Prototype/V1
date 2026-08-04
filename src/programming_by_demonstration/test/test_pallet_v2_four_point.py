"""Pallet v2 4-point taught frame — 2026-07-30 rewrite.

v1 (3-point A/B/C) conflated "pallet corner" with "first-part pose"
into a single taught point — the operator had to choose between
teaching the fixture corner (unambiguous geometry) and the tool's
actual contact pose (real Z + real orientation for the part). v2
splits: three CORNERS (①②③) define the frame; a fourth POINT (④)
captures the part pose at slot [0,0]. Every slot's position =
frame position + part-datum offset (④ - ①); every slot's
orientation = ④'s orientation.

Pinned here:
  * 4-point rotated-pallet math (slots land correctly)
  * measured pitches from corner distances
  * v1 → v2 migration seeds ①=corner_a, ②=B, ③=C, ④=A; emits an
    info finding "re-teach ④"
  * part-datum offset applied to every slot
  * part-datum-far warning when |④-①| > 1.5×max_pitch
  * orientation of every slot comes from ④ (not ①)
"""
from __future__ import annotations

import math

from programming_by_demonstration.pallet_geometry import (
    compute_frame, derive_slot_tcps, measured_pitches, validate_frame,
    _part_datum_offset, _PART_DATUM_MAX_SLOTS,
)
from programming_by_demonstration.schema import PalletPlaceSpec


def _tcp(x_mm, y_mm, z_mm, rx=0.0, ry=0.0, rz=0.0):
    """Test helper: mm inputs → METERS taught_tcp (pose-unit canon
    fix, 2026-08-04). Every literal in this file expresses
    distances as mm for readability; the helper converts to the
    canonical meters unit at construction."""
    return [x_mm / 1000.0, y_mm / 1000.0, z_mm / 1000.0,
            float(rx), float(ry), float(rz)]

def _tcp_m(x_m, y_m, z_m, rx=0.0, ry=0.0, rz=0.0):
    return [float(x_m), float(y_m), float(z_m),
            float(rx), float(ry), float(rz)]


# ── has_taught_frame + has_taught_part_datum ────────────────────

def test_has_taught_frame_v2_requires_three_corners():
    """v2's has_taught_frame checks corner1/2/3 — enough to compute
    axes/pitches even before ④ is taught."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': _tcp(0, 0, 0),
        'corner2_tcp': _tcp(100, 0, 0),
        'corner3_tcp': _tcp(0, 100, 0),
    })
    assert spec.has_taught_frame() is True
    assert spec.has_taught_part_datum() is False   # part_tcp missing


def test_has_taught_part_datum_ignores_zero_offset_seed():
    """v1 migration seeds part_tcp = corner1. has_taught_part_datum
    returns False in that case so the code can distinguish "operator
    taught a real part pose" from "we defaulted to the corner"."""
    A = _tcp(0, 0, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': A,
        'corner2_tcp': _tcp(100, 0, 0),
        'corner3_tcp': _tcp(0, 100, 0),
        'part_tcp':    list(A),           # seeded to same value
    })
    assert spec.has_taught_part_datum() is False


def test_has_taught_part_datum_true_when_distinct():
    A = _tcp(0, 0, 0)
    P = _tcp(5, 3, -10)     # 10mm below the corner, 3-5mm inset
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': A,
        'corner2_tcp': _tcp(100, 0, 0),
        'corner3_tcp': _tcp(0, 100, 0),
        'part_tcp':    P,
    })
    assert spec.has_taught_part_datum() is True


# ── v1 → v2 migration ──────────────────────────────────────────

def test_v1_program_migrates_corners_and_seeds_part_tcp():
    """Programs saved with the v1 schema (corner_a/point_b/point_c
    only, no corner1/corner2/corner3/part_tcp) load into a v2
    spec with the fields seeded: ①←corner_a, ②←B, ③←C, ④←corner_a.
    migrated_from_v1 goes True."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner_a_tcp': _tcp(1, 2, 3, 0.1, 0.2, 0.3),
        'point_b_tcp':  _tcp(100, 2, 3),
        'point_c_tcp':  _tcp(1, 100, 3),
    })
    assert spec.migrated_from_v1 is True
    # Canonical unit is METERS (2026-08-04): _tcp(1, 2, 3, …)
    # returns [0.001, 0.002, 0.003, 0.1, 0.2, 0.3].
    assert spec.corner1_tcp == [0.001, 0.002, 0.003, 0.1, 0.2, 0.3]
    assert spec.corner2_tcp[0] == 0.100    # 100 mm → 0.100 m
    assert spec.corner3_tcp[1] == 0.100
    # part_tcp seeded from corner_a — has_taught_part_datum stays
    # False so validation can nudge the operator to re-teach.
    assert spec.part_tcp == [0.001, 0.002, 0.003, 0.1, 0.2, 0.3]
    assert spec.has_taught_part_datum() is False


def test_v2_program_does_not_flip_migration_flag():
    """A fully-v2 program (all four v2 fields present, no v1
    fields) does NOT get migrated_from_v1=True — the migration
    finding is meant for legacy programs only."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': _tcp(0, 0, 0),
        'corner2_tcp': _tcp(100, 0, 0),
        'corner3_tcp': _tcp(0, 100, 0),
        'part_tcp':    _tcp(5, 5, -10),
    })
    assert spec.migrated_from_v1 is False


def test_migration_finding_emitted_on_v1_program():
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner_a_tcp': _tcp(0, 0, 0),
        'point_b_tcp':  _tcp(100, 0, 0),
        'point_c_tcp':  _tcp(0, 100, 0),
    })
    findings = validate_frame(spec)
    codes = [f['code'] for f in findings]
    assert 'part_datum_needs_reteach' in codes, codes
    reteach = next(f for f in findings if f['code'] == 'part_datum_needs_reteach')
    assert reteach['severity'] == 'info'
    assert 're-teach' in reteach['message'].lower()


# ── Rotated pallet math — the critical case ────────────────────

def test_rotated_pallet_30deg_derives_exact_slot_positions():
    """A 2×2 pallet rotated 30° in the XY plane. Corners at rotated
    positions; part_tcp taught 5mm below and inset by (5, 5). Every
    derived slot lands at the correct rotated position AND carries
    the part-datum offset."""
    theta = math.radians(30.0)
    row_dir = (math.cos(theta), math.sin(theta), 0.0)
    col_dir = (-math.sin(theta), math.cos(theta), 0.0)
    # Canonical unit is meters (2026-08-04 pose-unit fix).
    pitch_row_m = 0.100      # 100 mm
    pitch_col_m = 0.080      # 80 mm

    C1 = _tcp(500, 300, 0)   # 0.5, 0.3, 0.0 m after conversion
    C2 = _tcp_m(C1[0] + row_dir[0] * pitch_row_m,
                C1[1] + row_dir[1] * pitch_row_m, 0)
    C3 = _tcp_m(C1[0] + col_dir[0] * pitch_col_m,
                C1[1] + col_dir[1] * pitch_col_m, 0)
    # Part-datum: 5 mm inset (5 mm = 0.005 m) and 10 mm below.
    part = _tcp_m(C1[0] + 0.005, C1[1] + 0.005, C1[2] - 0.010,
                  0.0, 0.0, 1.57)

    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        # Schema pitches remain mm (operator UI unit).
        'pitch_row_mm': pitch_row_m * 1000.0,
        'pitch_col_mm': pitch_col_m * 1000.0,
        'corner1_tcp': C1, 'corner2_tcp': C2, 'corner3_tcp': C3,
        'part_tcp':    part,
        'order': 'row_major',
    })

    tcps = derive_slot_tcps(spec, tuple(C1))
    # Slot (0, 0) = corner1 + part-datum offset = part_tcp position.
    slot00 = next(s for s in tcps if (s['row'], s['col']) == (0, 0))
    assert abs(slot00['tcp_m'][0] - part[0]) < 1e-6, slot00
    assert abs(slot00['tcp_m'][1] - part[1]) < 1e-6, slot00
    assert abs(slot00['tcp_m'][2] - part[2]) < 1e-6, slot00
    slot01 = next(s for s in tcps if (s['row'], s['col']) == (0, 1))
    assert abs(slot01['tcp_m'][0] - (part[0] + pitch_row_m * row_dir[0])) < 1e-6
    assert abs(slot01['tcp_m'][1] - (part[1] + pitch_row_m * row_dir[1])) < 1e-6
    # Slot (1, 0) = slot00 + 1·pitch_col·col_dir.
    slot10 = next(s for s in tcps if (s['row'], s['col']) == (1, 0))
    assert abs(slot10['tcp_m'][0] - (part[0] + pitch_col_m * col_dir[0])) < 1e-6
    assert abs(slot10['tcp_m'][1] - (part[1] + pitch_col_m * col_dir[1])) < 1e-6
    # Every slot's orientation = part_tcp's orientation.
    for s in tcps:
        assert s['tcp_m'][3:] == list(part[3:]), s


# ── Measured pitches from corner distances ─────────────────────

def test_measured_pitches_from_corner_distances():
    """v2: pitch_row = |C2 - C1| / (cols - 1); pitch_col = |C3 -
    C1| / (rows - 1). Corners are unambiguously at slot boundaries
    so no teach_mode ambiguity."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 4, 'cols': 5,
        'corner1_tcp': _tcp(0, 0, 0),
        'corner2_tcp': _tcp(200, 0, 0),        # 5 cols → 4 pitches → 50mm each
        'corner3_tcp': _tcp(0, 300, 0),        # 4 rows → 3 pitches → 100mm each
    })
    m_row, m_col = measured_pitches(spec)
    # measured_pitches returns METERS. |c2-c1|=200 mm=0.2 m,
    # cols=5 → 4 pitches → 0.05 m each; |c3-c1|=300 mm=0.3 m,
    # rows=4 → 3 pitches → 0.1 m each.
    assert abs(m_row - 0.050) < 1e-9
    assert abs(m_col - 0.100) < 1e-9


# ── Part-datum offset applied to every slot ────────────────────

def test_part_datum_offset_applied_to_every_slot():
    """The part-datum vector (part_tcp - corner1) is applied to
    EVERY derived slot — not just slot [0,0]. Otherwise slots
    would land on the pallet fixture corners, not where the tool
    actually contacts the parts."""
    C1 = _tcp(0, 0, 0)
    C2 = _tcp(100, 0, 0)
    C3 = _tcp(0, 200, 0)
    # part_offset in METERS (5 mm, 8 mm, -12 mm).
    part_offset = (0.005, 0.008, -0.012)
    part = _tcp_m(C1[0] + part_offset[0],
                  C1[1] + part_offset[1],
                  C1[2] + part_offset[2])
    spec = PalletPlaceSpec.from_dict({
        'rows': 3, 'cols': 2,
        'corner1_tcp': C1, 'corner2_tcp': C2, 'corner3_tcp': C3,
        'part_tcp':    part, 'order': 'row_major',
    })
    # _part_datum_offset returns METERS.
    got = _part_datum_offset(spec)
    for i in range(3):
        assert abs(got[i] - part_offset[i]) < 1e-9
    # Every slot carries the offset. Frame contribution c * 0.100 m + r * 0.100 m.
    tcps = derive_slot_tcps(spec, tuple(C1))
    for s in tcps:
        r, c = s['row'], s['col']
        exp = (
            C1[0] + c * 0.100 + part_offset[0],
            C1[1] + r * 0.100 + part_offset[1],
            C1[2] + part_offset[2],
        )
        for i in range(3):
            assert abs(s['tcp_m'][i] - exp[i]) < 1e-6, (s, exp)


# ── part-datum-far warning ─────────────────────────────────────

def test_part_datum_far_from_corner_warns():
    """④ far from ① → warning naming both the distance and the
    slot-fraction threshold. Operator's "is the part in the first
    slot?" nudge."""
    C1 = _tcp(0, 0, 0)
    C2 = _tcp(100, 0, 0)
    C3 = _tcp(0, 100, 0)
    # Part-datum offset of 500mm — way beyond 1.5 × 100 = 150.
    P  = _tcp(500, 0, 0)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': C1, 'corner2_tcp': C2, 'corner3_tcp': C3,
        'part_tcp':    P,
    })
    findings = validate_frame(spec)
    far = next((f for f in findings if f['code'] == 'part_datum_far_from_corner'), None)
    assert far is not None, findings
    assert far['severity'] == 'warning'
    # Canonical unit is meters (2026-08-04).
    # 500 mm = 0.5 m; threshold = 1.5 × 100 mm = 1.5 × 0.100 = 0.150 m.
    assert far['distance_m'] > _PART_DATUM_MAX_SLOTS * 0.100
    assert '500' in far['message']


def test_part_datum_within_one_slot_no_warning():
    """④ within 1 slot of ① → no warning."""
    C1 = _tcp(0, 0, 0)
    C2 = _tcp(100, 0, 0)
    C3 = _tcp(0, 100, 0)
    P  = _tcp(20, 20, -5)   # small offset within slot
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': C1, 'corner2_tcp': C2, 'corner3_tcp': C3,
        'part_tcp':    P,
    })
    for f in validate_frame(spec):
        assert f['code'] != 'part_datum_far_from_corner', f


# ── Orientation source: part_tcp not corner1 ───────────────────

def test_orientation_of_every_slot_comes_from_part_tcp():
    """Corner1 might be taught with the tool at a fixture point in
    a totally different pose than the part contact. The tool's
    actual orientation for the part is on part_tcp. Every slot
    inherits part_tcp's orientation, not corner1's."""
    C1 = _tcp(0, 0, 0, 3.14, 0.0, 0.0)         # tool upside-down at corner
    C2 = _tcp(100, 0, 0)
    C3 = _tcp(0, 100, 0)
    # Part taught tool-right-side-up.
    P  = _tcp(10, 10, -5, 0.0, 0.0, 1.57)
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'corner1_tcp': C1, 'corner2_tcp': C2, 'corner3_tcp': C3,
        'part_tcp':    P,
    })
    tcps = derive_slot_tcps(spec, tuple(C1))
    for s in tcps:
        assert s['tcp_m'][3] == 0.0
        assert s['tcp_m'][4] == 0.0
        assert abs(s['tcp_m'][5] - 1.57) < 1e-9


# ── Backward-compat: pre-taught-frame programs still render ───

def test_no_frame_no_part_falls_back_to_base_axes():
    """Program with no taught points at all → base-axes fallback,
    no findings related to part datum (the frame isn't taught, so
    the part-datum check has nothing to compare against)."""
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2,
        'pitch_row_mm': 100, 'pitch_col_mm': 100,
    })
    assert compute_frame(spec)['source'] == 'base_axes'
    # No part_datum_* findings — the info-nudge is meant for
    # programs that have started teaching.
    for f in validate_frame(spec):
        assert not f['code'].startswith('part_datum_'), f

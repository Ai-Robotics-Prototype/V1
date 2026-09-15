"""Pose-unit canon regression pins (2026-08-04).

The pallet_geometry module was mis-treating taught_tcp values —
which the record path stores in METERS + RADIANS (matching driver
tcp_m and every taught_tcp already on disk) — as MILLIMETRES.
Symptom: an operator taught pallet corners physically 325 / 387 /
534 mm apart; validate_frame reported them as 0.33 / 0.39 mm apart
and refused corner 3 as coincident.

Root cause: `_MIN_EDGE_LEN_MM = 1.0` compared against the raw
Euclidean length in meters (0.325 < 1.0 → tripped
`corner_coincident`). Similar unit lies in the pitch-mismatch and
slot-derivation paths.

Fix (this commit): pallet_geometry works entirely in METERS +
RADIANS internally. Thresholds renamed to `_M` suffix. Findings
carry `distance_m` (was `distance_mm` holding meters). Operator
copy at the dashboard endpoint converts m→mm for display. The
pallet_slots endpoint keeps its `tcp_mm` output contract by
converting m→mm at the response boundary.

These tests pin the invariants:

  (1) The LIVE operator case: three physically well-separated
      corners must validate CLEAN (no coincident finding).
  (2) The measured pitches must equal the physical distances
      in the canonical unit (meters).
  (3) derived slot TCPs land at physically correct XYZ positions
      in meters, not collapsed on the anchor.
  (4) No finding key on this module holds a meters value under a
      `_mm`-suffixed name.
"""

from __future__ import annotations

import math

import pytest


# The exact draft values captured on 2026-08-04 when the operator
# hit the coincident bug. taught_tcp = [x_m, y_m, z_m, rx_rad,
# ry_rad, rz_rad].
CORNER1 = [0.532263, 0.138846, 0.114584, 3.125221, 0.014765, 1.4513983]
CORNER2 = [0.527422, 0.463869, 0.114601, 3.125204, 0.014713, 1.4513634]
# corner3 wasn't stored (record-through refused it). Reconstructed
# from the driver ws log (position after operator's jog just before
# they hit Record): x=917.04 mm, y=99.31 mm, z=114.63 mm.
CORNER3 = [0.917040, 0.099307, 0.114630, 3.125220, 0.014700, 1.4513500]

# Physical distances (mm) from the arm's own end.x/y/z telemetry:
EXPECTED_C1_C2_MM = 325.06     # |c2 - c1|
EXPECTED_C1_C3_MM = 386.81     # |c3 - c1|
EXPECTED_C2_C3_MM = 533.55     # |c3 - c2|


def _spec(**overrides):
    """Build a PalletPlaceSpec with the operator's real corners as
    default; caller overrides individual fields."""
    from programming_by_demonstration.schema import PalletPlaceSpec
    place = {
        'rows': 2, 'cols': 2, 'layers': 1,
        'corner1_tcp': list(CORNER1),
        'corner2_tcp': list(CORNER2),
        'corner3_tcp': list(CORNER3),
    }
    place.update(overrides)
    return PalletPlaceSpec.from_dict(place)


# ── (1) The live case: coincident MUST NOT fire ─────────────────

def test_live_case_no_coincident_finding():
    """The three real taught corners are 325 / 387 / 534 mm apart.
    validate_frame must emit ZERO coincident findings."""
    from programming_by_demonstration.pallet_geometry import validate_frame
    spec = _spec()
    findings = validate_frame(spec)
    coincidents = [f for f in findings
                   if f.get('code') == 'corner_coincident']
    assert coincidents == [], (
        'validate_frame emitted coincident finding(s) on the '
        'operator\'s real, physically well-separated corners: '
        f'{coincidents!r}. The unit-mismatch bug has returned.')


def test_live_case_row_col_angle_is_finite():
    """Sanity: the raw row/col angle is ~90° for this frame (rows
    perpendicular to cols). No near-parallel finding."""
    from programming_by_demonstration.pallet_geometry import (
        compute_frame, validate_frame)
    spec = _spec()
    fr = compute_frame(spec)
    assert 60.0 < fr['row_col_angle_deg'] < 120.0, (
        f'row/col angle {fr["row_col_angle_deg"]:.1f}° outside '
        'the plausible range for a well-taught pallet — the '
        'meters-vs-mm math is broken')
    parallels = [f for f in validate_frame(spec)
                 if f.get('code') == 'row_col_near_parallel']
    assert parallels == []


# ── (2) Measured pitches match physical distances ───────────────

def test_measured_pitches_return_meters_at_the_physical_scale():
    """measured_pitches is documented to return meters; the values
    must equal |c2-c1|/(cols-1) and |c3-c1|/(rows-1) in the same
    unit as the input taught_tcp."""
    from programming_by_demonstration.pallet_geometry import measured_pitches
    spec = _spec()   # 2x2 grid — pitch = full edge (since cols-1 = rows-1 = 1)
    pr_m, pc_m = measured_pitches(spec)
    assert pr_m is not None and pc_m is not None
    assert abs(pr_m - EXPECTED_C1_C2_MM / 1000.0) < 0.001, (
        f'pitch_row_m = {pr_m!r} but physical |c2-c1| is '
        f'{EXPECTED_C1_C2_MM / 1000.0} m')
    assert abs(pc_m - EXPECTED_C1_C3_MM / 1000.0) < 0.001, (
        f'pitch_col_m = {pc_m!r} but physical |c3-c1| is '
        f'{EXPECTED_C1_C3_MM / 1000.0} m')


# ── (3) Slot derivation lands at physical positions ─────────────

def test_derive_slot_tcps_produces_physically_reasonable_positions():
    """For a 2x2 grid taught at the operator's real corners, the
    four slot centers must land within a few mm of the corners
    themselves (there's no part-datum offset here). Pre-fix,
    slots collapsed onto the anchor because pallet_geometry
    treated meters as mm — the derived offset was 1000× too
    small.

    Slot ordering with default snake fill: (0,0)→(0,1)→(1,1)→
    (1,0). So slot indices correspond to corner-adjacent
    positions."""
    from programming_by_demonstration.pallet_geometry import derive_slot_tcps
    spec = _spec()
    slots = derive_slot_tcps(spec, tuple(CORNER1))
    assert len(slots) == 4
    for s in slots:
        tcp = s['tcp_m']
        # X should be between the two X-extents (532 mm and 917 mm
        # in meters: 0.5 to 0.95).
        assert 0.5 < tcp[0] < 1.0, (
            f'slot {s["index"]} X={tcp[0]} outside workspace — '
            'unit conversion still wrong')
        # Y similarly between 99 mm and 464 mm.
        assert 0.05 < tcp[1] < 0.55, (
            f'slot {s["index"]} Y={tcp[1]} outside workspace')
        # Z near the surface at ~0.115 m.
        assert 0.09 < tcp[2] < 0.13, (
            f'slot {s["index"]} Z={tcp[2]} outside surface plane')
    # tcp_m field explicitly named — no *_mm holding meters.
    assert 'tcp_m' in slots[0]
    assert 'tcp_mm' not in slots[0], (
        'derive_slot_tcps returned tcp_mm; the fix renamed it to '
        'tcp_m (the endpoint converts to mm at the response '
        'boundary). Reintroducing tcp_mm here would be a unit lie.')


# ── (4) No *_mm-suffixed field holds meters value in findings ──

def test_findings_use_canonical_unit_names():
    """Every distance-carrying finding key on this module must
    say `_m` (meters) or be OMITTED. `_mm` values only appear at
    the dashboard endpoint layer's operator-copy strings — never
    on the finding itself."""
    from programming_by_demonstration.pallet_geometry import validate_frame
    # Craft a near-coincident case that WILL fire the finding.
    spec = _spec(
        corner3_tcp=[CORNER1[0] + 0.0005, CORNER1[1], CORNER1[2],
                     CORNER1[3], CORNER1[4], CORNER1[5]],
    )
    findings = validate_frame(spec)
    coincidents = [f for f in findings
                   if f.get('code') == 'corner_coincident']
    assert coincidents, 'test fixture failed to trip the check'
    for f in coincidents:
        assert 'distance_m' in f, (
            f'coincident finding missing distance_m: {f!r}')
        assert 'distance_mm' not in f, (
            'coincident finding uses distance_mm — pre-fix name '
            'held meters, guaranteed operator-visible unit lie')
        # Sanity: the value is in the expected order (~0.5 mm here).
        assert 0 < f['distance_m'] < 0.002, (
            f'distance_m={f["distance_m"]} is not in meters '
            '(0.5 mm expected → 0.0005 m)')


# ── (5) Dashboard endpoint boundary conversion ─────────────────
# The /api/pallet/validate_frame and /api/programs/{id}/pallet_slots
# endpoints are the ONLY places mm crosses the wire. This test
# looks at the source directly (a live HTTP hit needs the running
# server) to prove the boundary conversion is present.

def test_dashboard_boundary_converts_meters_to_mm_on_pallet_slots():
    import os
    from pathlib import Path
    WS = Path('/home/teddy/cobot_ws')
    src = (WS / 'src/cobot_dashboard/cobot_dashboard/dashboard_server.py'
           ).read_text()
    # The endpoint must multiply meter values by 1000 for the
    # tcp_mm response field.
    assert 'tcp_m[0] * 1000.0' in src, (
        '/api/programs/{id}/pallet_slots does not convert '
        'meters → mm at the tcp_mm boundary. The 3D twin would '
        'render slots 1000× too close to the anchor.')
    assert 'anchor_tcp[0] * 1000.0' in src, (
        'anchor_tcp_mm response field is not converted from '
        'meters — the twin\'s anchor marker would be at (0.53 '
        'mm, 0.14 mm) instead of (532 mm, 139 mm)')
    assert 'm_row_m * 1000.0' in src, (
        'measured_pitches_mm response field is not converted '
        'from meters — the wizard\'s pitch cross-check would '
        'compare 0.325 mm vs the typed 325 mm and always flag '
        'a mismatch')


def test_operator_copy_renders_mm_from_distance_m():
    import os
    from pathlib import Path
    WS = Path('/home/teddy/cobot_ws')
    src = (WS / 'src/cobot_dashboard/cobot_dashboard/dashboard_server.py'
           ).read_text()
    # _pallet_finding_operator_copy must read distance_m and
    # multiply by 1000 for the mm display.
    assert 'dist_m*1000.0' in src or 'dist_m * 1000.0' in src, (
        '_pallet_finding_operator_copy no longer renders mm from '
        'meters; operator toasts would say "0.33 m apart" or '
        'similar')
    # And it must accept distance_m as the primary field name.
    assert "f.get('distance_m')" in src, (
        '_pallet_finding_operator_copy does not read distance_m — '
        'the canonical field. Falling back to distance_mm '
        'always would resurrect the unit lie.')

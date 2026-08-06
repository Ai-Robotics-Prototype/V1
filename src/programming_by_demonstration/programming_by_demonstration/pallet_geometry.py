"""Pallet-place slot derivation + reachability sweep.

2026-08-06 §1 shipped assume-base-axes: derived slots followed
world-frame literals (`+X`/`-Y`) regardless of how the pallet
actually lay in the workspace. Any pallet not aligned to the robot
base — the common case — produced slots at wrong world positions.
Operator-caught.

2026-07-30 rewrite: derive the pallet frame from THREE taught
points on the pallet itself. Corner A (origin), point B (row
direction), point C (column direction). Slot positions are then
world-frame vectors in the taught frame — rotation, tilt, offset
all captured by construction. Base-axis literals stay as the
backward-compat fallback for programs that pre-date the taught
frame.

Public surface:

  * `compute_frame(spec)`                → {row_axis, col_axis,
                                            plane_normal, tilt_deg,
                                            row_col_angle_deg,
                                            source: 'taught' | 'base_axes'}
  * `measured_pitches(spec)`             → (pitch_row_mm, pitch_col_mm)
                                            or (None, None) when the
                                            frame isn't taught
  * `validate_frame(spec)`                → [{severity, code, message}]
                                            with row/col-angle, tilt,
                                            pitch-typed-vs-measured
                                            cross-check
  * `compute_slot_offsets(spec)`          → per-slot Δ(x,y,z) in mm in
                                            the ANCHOR's base frame,
                                            ordered per spec.order
  * `derive_slot_tcps(spec, anchor_tcp)`  → per-slot absolute TCP list
                                            (anchor_tcp + offset), same
                                            order — orientation copied
                                            from anchor
  * `reachability_sweep(spec, anchor_joints_deg)`  → seeded-IK sweep
                                            report unchanged from §1
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from .schema import PalletPlaceSpec


# Base-frame axis literals — the pre-taught-frame fallback. Kept in
# both directions so old programs specifying '+X'/'-Y' still resolve.
_AXIS_TO_DXYZ_MM_PER_MM = {
    '+X': (1.0, 0.0, 0.0),
    '-X': (-1.0, 0.0, 0.0),
    '+Y': (0.0, 1.0, 0.0),
    '-Y': (0.0, -1.0, 0.0),
}

# ── Canonical pose unit (2026-08-04, unit-mismatch fix) ─────────
#
# taught_tcp and every pose value flowing through this module are
# METERS + RADIANS. This matches:
#   * the Estun driver's tcp_m field (source of state.tcp_pose),
#   * the record-through path (state.tcp_pose → draft store),
#   * every taught_tcp already on disk (e.g. whitebowlpickplace.json
#     step 0: [0.139152, 0.709405, 0.116923, 3.09, -0.08, 1.45]),
#   * ROS convention (geometry_msgs/PoseStamped is meters + quat).
#
# mm+deg exists ONLY at two boundaries:
#   1. Operator-facing UI rendering ("325.1 mm apart" in toasts,
#      pitch fields in the PalletConfigEditor), which callers
#      convert m→mm at the render layer.
#   2. Codegen emit boundary (movJCoorRel({cp={0,0,z_mm,0,0,0}}))
#      lives in estun_driver.program_ops; that path already
#      handles unit conversion via magnitude sniffing
#      (program_ops.py:1499-1503, |value|<10 → meters × 1000).
#
# Pre-2026-08-04 this module treated taught_tcp as mm, silently
# dividing every real distance by 1000. Symptom: corners 325 mm
# apart reported as 0.325 mm apart and refused as coincident.

# Validation thresholds — all in the CANONICAL unit.
_MIN_ROW_COL_ANGLE_DEG = 60.0    # row·col angle must exceed this
_MAX_TILT_DEG          = 10.0    # warn beyond
_MIN_EDGE_LEN_M        = 0.001   # 1 mm coincident-corner threshold
_PITCH_MISMATCH_M      = 0.003   # 3 mm typed-vs-measured warn (RETIRED 2026-08-05)
_PART_DATUM_MAX_SLOTS  = 1.5     # dimensionless — × max_pitch
# 2026-08-05 (grid-fits-frame check, operator doctrine ruling):
# Warn when the derived slot grid extent overshoots the taught frame
# in either axis; error when it wildly overshoots. The frame extent
# is the length of the corner1→corner2 vector (row axis) or
# corner1→corner3 (col axis); the grid extent for N slots is
# (N-1)·pitch. A tolerance of 5 mm avoids nuisance warnings when
# corners are taught a hair inside the last-slot centers.
_GRID_FIT_TOLERANCE_M  = 0.005   # 5 mm slack
_GRID_FIT_ERROR_RATIO  = 1.5     # >1.5× frame extent → error (catches pitch typos)

# The pre-2026-08-04 names `_MIN_EDGE_LEN_MM` and
# `_PITCH_MISMATCH_MM` are RETIRED (not aliased) — an alias
# holding a meters value under a mm-suffixed name would be the
# exact class of unit lie this fix is closing.


# ── Vector helpers — no numpy dependency ────────────────────────

def _sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def _add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def _scale(a, s): return (a[0] * s, a[1] * s, a[2] * s)
def _dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def _len(a): return math.sqrt(_dot(a, a))
def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])
def _norm(a):
    L = _len(a)
    if L < 1e-9:
        return (0.0, 0.0, 0.0)
    return (a[0] / L, a[1] / L, a[2] / L)


def _xyz(tcp):
    """Extract (x, y, z) in METERS from a taught_tcp 6-vector.

    taught_tcp is the canonical pose slot on both saved programs
    and mid-teach drafts — always meters + radians (see the file
    header). Callers must gate on `spec.has_taught_frame()`;
    malformed input returns (0,0,0) so the math doesn't crash on
    the placeholder branch."""
    if not isinstance(tcp, (list, tuple)) or len(tcp) < 3:
        return (0.0, 0.0, 0.0)
    return (float(tcp[0]), float(tcp[1]), float(tcp[2]))


# ── Frame computation ───────────────────────────────────────────

def compute_frame(spec: PalletPlaceSpec) -> Dict[str, Any]:
    """Return the pallet's local frame:

        {
          'row_axis':          (x, y, z) unit vector in base frame,
          'col_axis':          (x, y, z) unit vector, orthogonal to row
                               (Gram-Schmidt projection removed the
                               row component so row·col == 0 exactly),
          'plane_normal':      row_axis × col_axis  (unit vector; the
                               pallet's up direction; layer_height
                               offset is applied along this),
          'tilt_deg':          angle between plane_normal and world +Z,
                               in degrees — 0 for a perfectly level
                               pallet; > _MAX_TILT_DEG warns,
          'row_col_angle_deg': angle between raw (corner2-corner1)
                               and (corner3-corner1) BEFORE
                               orthogonalization, in degrees. Below
                               _MIN_ROW_COL_ANGLE_DEG the taught
                               points don't describe two directions
                               and validate_frame emits an error.
          'source':            'taught' when frame came from
                               corner1/2/3, 'base_axes' when we fell
                               back to `spec.row_axis` /
                               `spec.col_axis` literals for legacy
                               programs.
        }

    When the taught frame is INCOMPLETE (any of corner1/2/3 missing),
    the function falls back to base-axis literals so pre-frame
    programs continue to render at all — with source='base_axes'
    so the caller can flag the fallback in the UI."""
    if not spec.has_taught_frame():
        rax = _AXIS_TO_DXYZ_MM_PER_MM.get(spec.row_axis.upper(), (1.0, 0.0, 0.0))
        cax = _AXIS_TO_DXYZ_MM_PER_MM.get(spec.col_axis.upper(), (0.0, 1.0, 0.0))
        raw_angle = math.degrees(math.acos(max(-1.0, min(1.0, _dot(rax, cax)))))
        n = _norm(_cross(rax, cax))
        tilt = math.degrees(math.acos(abs(max(-1.0, min(1.0, _dot(n, (0.0, 0.0, 1.0)))))))
        return {
            'row_axis':          rax,
            'col_axis':          cax,
            'plane_normal':      n,
            'tilt_deg':          tilt,
            'row_col_angle_deg': raw_angle,
            'source':            'base_axes',
        }
    A = _xyz(spec.corner1_tcp)
    B = _xyz(spec.corner2_tcp)
    C = _xyz(spec.corner3_tcp)
    ba = _sub(B, A)
    ca = _sub(C, A)
    la, lb = _len(ba), _len(ca)
    # Angle BEFORE orthogonalisation — this is what validate_frame
    # checks: if B and C describe the same direction the operator
    # gets a specific error saying so.
    raw_angle_deg = 0.0
    if la > 1e-6 and lb > 1e-6:
        cos_t = max(-1.0, min(1.0, _dot(ba, ca) / (la * lb)))
        raw_angle_deg = math.degrees(math.acos(cos_t))
    row_axis = _norm(ba)
    # Gram-Schmidt: subtract the component of C-A along row_axis so
    # col_axis is exactly orthogonal to row_axis.
    ca_along_row = _scale(row_axis, _dot(ca, row_axis))
    col_raw = _sub(ca, ca_along_row)
    col_axis = _norm(col_raw)
    plane_normal = _norm(_cross(row_axis, col_axis))
    # 2026-08-06 (operator directive: layer direction canonical).
    # Layer N sits ABOVE layer N-1 — layer_height along
    # plane_normal must move the tool AWAY from the pallet surface
    # (upward in the base frame). row×col can go either way
    # depending on corner ordering; sign-adjust here so the normal
    # always has a non-negative +Z_base component. The pallet is
    # commissioned on a level (or near-level) surface, so +Z_base
    # is the physically-up direction the operator expects for
    # stacking.
    if plane_normal[2] < 0:
        plane_normal = (-plane_normal[0], -plane_normal[1], -plane_normal[2])
    # Tilt: angle between plane_normal and +Z. After the sign fix
    # above, plane_normal.z >= 0, so a level pallet reads tilt=0
    # without abs().
    tilt_dot = max(-1.0, min(1.0, _dot(plane_normal, (0.0, 0.0, 1.0))))
    tilt_deg = math.degrees(math.acos(tilt_dot))
    return {
        'row_axis':          row_axis,
        'col_axis':          col_axis,
        'plane_normal':      plane_normal,
        'tilt_deg':          tilt_deg,
        'row_col_angle_deg': raw_angle_deg,
        'source':            'taught',
    }


def measured_pitches(spec: PalletPlaceSpec
                     ) -> Tuple[Optional[float], Optional[float]]:
    """Return (pitch_row_m, pitch_col_m) DERIVED from the taught
    corner positions.

    v2 (2026-07-30): corner2 is the pallet corner at [row 1, col N],
    corner3 at [row M, col 1]. Corners are ALWAYS at slot boundaries
    (the operator touched the fixture, not "somewhere along an
    edge"), so:

        pitch_row = |corner2 - corner1| / (cols - 1)
        pitch_col = |corner3 - corner1| / (rows - 1)

    Return unit: METERS (matches the canonical taught_tcp unit).
    Callers rendering to the operator multiply by 1000.

    Missing frame → (None, None). 1-row or 1-col pallet → None
    for that pitch."""
    if not spec.has_taught_frame():
        return (None, None)
    A = _xyz(spec.corner1_tcp)      # meters
    B = _xyz(spec.corner2_tcp)      # meters
    C = _xyz(spec.corner3_tcp)      # meters
    pitch_row_m = None
    if spec.cols and spec.cols > 1:
        pitch_row_m = _len(_sub(B, A)) / float(spec.cols - 1)
    pitch_col_m = None
    if spec.rows and spec.rows > 1:
        pitch_col_m = _len(_sub(C, A)) / float(spec.rows - 1)
    return (pitch_row_m, pitch_col_m)


# ── Frame validation ────────────────────────────────────────────

def validate_frame(spec: PalletPlaceSpec) -> List[Dict[str, Any]]:
    """Return validation findings ordered by severity (error first).
    Empty list = frame passes.

    Rules:
      * row/col angle < _MIN_ROW_COL_ANGLE_DEG        → error
      * plane tilt > _MAX_TILT_DEG                    → warning
      * far_slot mode + |typed - measured| > _PITCH_MISMATCH_MM
                                                      → warning per axis
      * taught-frame incomplete + non-default axes    → info (falling
                                                        back to literals)

    Return shape: [{'severity','code','message', metrics...}, ...]."""
    out: List[Dict[str, Any]] = []
    if not spec.has_taught_frame():
        if (spec.row_axis, spec.col_axis) != ('+X', '+Y'):
            out.append({
                'severity': 'info',
                'code':     'taught_frame_missing',
                'message': (
                    'Pallet frame is not fully taught (corner A + '
                    'points B & C). Falling back to base-axis literals '
                    f'row={spec.row_axis} col={spec.col_axis}. The '
                    'derived slots assume the pallet is aligned to '
                    'the robot base; re-teach the three points to '
                    'get rotation-safe slot positions.'),
            })
        return out
    # §465 fork-1 (2026-08-04): coincident-corner check — if either
    # row (c1→c2) or col (c1→c3) is under _MIN_EDGE_LEN_M the
    # operator taught two corners at the same pose. Emitted BEFORE
    # the near-parallel angle check because that check reports
    # angle=0 on coincident inputs, and "same direction" is a
    # confusing operator message when the real problem is "same
    # point".
    #
    # Findings expose `distance_m` (meters) — the canonical unit
    # throughout this module. Operator copy at the endpoint
    # boundary converts to mm for display ("325.1 mm apart");
    # this module NEVER labels a meters value with `_mm` (that
    # was the pre-2026-08-04 unit-lie bug — 325 mm reported as
    # 0.325 mm because the field said `distance_mm` while the
    # code path fed it meters).
    A = _xyz(spec.corner1_tcp)      # meters
    B = _xyz(spec.corner2_tcp)      # meters
    C = _xyz(spec.corner3_tcp)      # meters
    row_len_m = _len(_sub(B, A))    # meters
    col_len_m = _len(_sub(C, A))    # meters
    if row_len_m < _MIN_EDGE_LEN_M:
        out.append({
            'severity':         'error',
            'code':             'corner_coincident',
            'involves_corners': ['c1', 'c2'],
            'distance_m':       row_len_m,
            'message': (
                f'Corners 1 and 2 appear coincident '
                f'({row_len_m*1000.0:.2f} mm apart) — jog to the '
                f'actual pallet corner and re-teach.'),
        })
    if col_len_m < _MIN_EDGE_LEN_M:
        out.append({
            'severity':         'error',
            'code':             'corner_coincident',
            'involves_corners': ['c1', 'c3'],
            'distance_m':       col_len_m,
            'message': (
                f'Corners 1 and 3 appear coincident '
                f'({col_len_m*1000.0:.2f} mm apart) — jog to the '
                f'actual pallet corner and re-teach.'),
        })
    # If either edge collapsed, skip the angle check — angle math
    # is meaningless without both directions.
    if row_len_m < _MIN_EDGE_LEN_M or col_len_m < _MIN_EDGE_LEN_M:
        return out
    fr = compute_frame(spec)
    if fr['row_col_angle_deg'] < _MIN_ROW_COL_ANGLE_DEG:
        out.append({
            'severity': 'error',
            'code':     'row_col_near_parallel',
            'involves_corners': ['c2', 'c3'],
            'message': (
                f'Points B and C describe the same direction '
                f'(row/col angle {fr["row_col_angle_deg"]:.1f}° < '
                f'{_MIN_ROW_COL_ANGLE_DEG:g}°). Re-teach C along the '
                f'OTHER edge — the column direction should run at '
                f'roughly a right angle to the row direction.'),
            'row_col_angle_deg': fr['row_col_angle_deg'],
        })
    if fr['tilt_deg'] > _MAX_TILT_DEG:
        out.append({
            'severity': 'warning',
            'code':     'pallet_tilted',
            'involves_corners': ['c1', 'c2', 'c3'],
            'message': (
                f'Pallet plane tilts {fr["tilt_deg"]:.1f}° from '
                f'horizontal (threshold {_MAX_TILT_DEG:g}°). If the '
                f'pallet actually sits on a slope this is correct; '
                f'otherwise one of the teach points was recorded at '
                f'a different Z than the others.'),
            'tilt_deg': fr['tilt_deg'],
        })
    # v2 part-datum checks (2026-07-30): the ④ point must be
    # taught, distinct from corner1, and within ~1 slot of it.
    # Migration from v1 seeds part_tcp = corner1 but flags
    # `migrated_from_v1` — that path emits an info finding
    # regardless of the distance check so the operator sees the
    # nudge.
    if spec.migrated_from_v1 and not spec.has_taught_part_datum():
        out.append({
            'severity': 'info',
            'code':     'part_datum_needs_reteach',
            'involves_corners': ['c4'],
            'message': (
                'This pallet was migrated from the v1 (3-point) '
                'model. The first-part position (④) was seeded '
                'from corner 1 as a temporary starting point — '
                're-teach ④ with a real part in the first slot so '
                'the tool contact geometry and orientation carry '
                'through to every derived slot.'),
        })
    elif not spec.has_taught_part_datum() and spec.corner1_tcp is not None:
        # No v1 migration flag AND no distinct part datum. Either
        # the operator hasn't reached the ④ teach step yet, or
        # they taught it at exactly the same pose as ① (unusual
        # but valid — the tool contacts the corner). Info only.
        out.append({
            'severity': 'info',
            'code':     'part_datum_not_taught',
            'involves_corners': ['c4'],
            'message': (
                'First-part position (④) is not distinct from '
                'corner 1. Teach ④ with a real part in the first '
                'slot to lock the tool contact geometry.'),
        })
    if spec.has_taught_part_datum():
        A = _xyz(spec.corner1_tcp)   # meters
        P = _xyz(spec.part_tcp)      # meters
        d_m = _len(_sub(P, A))       # meters
        m_row_m, m_col_m = measured_pitches(spec)   # meters
        # Typed pitches from the operator UI arrive on the schema
        # in mm (PalletConfigEditor field labels use mm). Convert
        # to meters at THIS consume boundary; the canon in this
        # module is meters everywhere below.
        typed_row_m = ((spec.pitch_row_mm or 0.0) / 1000.0) or None
        typed_col_m = ((spec.pitch_col_mm or 0.0) / 1000.0) or None
        pitches_m = [p for p in (m_row_m, m_col_m,
                                 typed_row_m, typed_col_m)
                     if p and p > 0]
        max_pitch_m = max(pitches_m) if pitches_m else 0.0
        if max_pitch_m > 0 and d_m > _PART_DATUM_MAX_SLOTS * max_pitch_m:
            out.append({
                'severity': 'warning',
                'code':     'part_datum_far_from_corner',
                'involves_corners': ['c1', 'c4'],
                'message': (
                    f'First-part position ④ is {d_m*1000.0:.1f} mm '
                    f'from corner 1 — more than '
                    f'{_PART_DATUM_MAX_SLOTS:g} × max pitch '
                    f'({max_pitch_m*1000.0:.1f} mm). Is the part '
                    f'actually in the first slot?'),
                'distance_m':      d_m,
                'max_pitch_m':     max_pitch_m,
                'threshold_slots': _PART_DATUM_MAX_SLOTS,
            })

    # 2026-08-05 OPERATOR DOCTRINE RULING (pallet_geometry canonical):
    # The old pitch typed-vs-measured check is RETIRED. Corners are
    # frame-only; typed pitch is not derived from corners, so the
    # comparison was between unrelated quantities. Its replacement
    # is the "grid fits the frame" check below — it catches the
    # actual failure mode (a pitch typo like 1500 mm) instead of
    # rejecting every legitimate configuration where the pallet
    # corners aren't at the [1,N]/[M,1] extreme slot centers.
    if spec.has_taught_frame():
        out.extend(_grid_extent_vs_frame_extent(spec))
    return out


# ── Slot indexing (fill order) — unchanged from §1 ──────────────

def _order_indices(rows: int, cols: int, layers: int,
                   order: str) -> List[Tuple[int, int, int]]:
    idx: List[Tuple[int, int, int]] = []
    for l in range(layers):
        for r in range(rows):
            if order == 'col_major':
                continue
            for c in range(cols):
                effective_c = c
                if order == 'snake' and (r % 2 == 1):
                    effective_c = (cols - 1) - c
                idx.append((r, effective_c, l))
        if order == 'col_major':
            for c in range(cols):
                for r in range(rows):
                    idx.append((r, c, l))
    return idx


# ── Slot Δ math — routes through the taught frame when present ──

def _grid_extent_vs_frame_extent(spec: PalletPlaceSpec
                                  ) -> List[Dict[str, Any]]:
    """Grid-fits-frame check (2026-08-05 operator doctrine ruling).

    The pallet frame is defined by corners 1-3. The slot grid is
    defined by the datum (corner 1 origin, part_tcp if taught) plus
    (N-1)·pitch along each frame axis. If the grid extends beyond
    the taught frame in either direction, either the pitch is a
    typo or the corners were taught in the wrong places.

    Findings:
      * ratio > _GRID_FIT_ERROR_RATIO (default 1.5) → error
      * grid extent > frame extent + _GRID_FIT_TOLERANCE_M → warning

    Returns a list of findings. Emits at most one per axis (row, col).

    Only fires when the frame is taught (has_taught_frame) AND at
    least one pitch is nonzero — otherwise there is no meaningful
    grid extent to compare against."""
    findings: List[Dict[str, Any]] = []
    A = _xyz(spec.corner1_tcp)      # meters
    B = _xyz(spec.corner2_tcp)      # meters
    C = _xyz(spec.corner3_tcp)      # meters
    row_frame_m = _len(_sub(B, A))
    col_frame_m = _len(_sub(C, A))
    pr_m = (float(spec.pitch_row_mm) or 0.0) / 1000.0
    pc_m = (float(spec.pitch_col_mm) or 0.0) / 1000.0
    cols = int(spec.cols) if spec.cols else 1
    rows = int(spec.rows) if spec.rows else 1

    def _check(axis_name: str, axis_letter: str, corners: list[str],
               pitch_m: float, N: int, frame_m: float) -> None:
        if pitch_m <= 0 or N <= 1 or frame_m <= 0:
            return
        grid_m = (N - 1) * pitch_m
        if grid_m <= frame_m + _GRID_FIT_TOLERANCE_M:
            return
        ratio = grid_m / frame_m
        severity = 'error' if ratio > _GRID_FIT_ERROR_RATIO else 'warning'
        overshoot_m = grid_m - frame_m
        findings.append({
            'severity':         severity,
            'code':             f'{axis_name}_grid_exceeds_frame',
            'involves_corners': corners,
            'message': (
                f'{axis_name.capitalize()} grid needs '
                f'{grid_m*1000.0:.0f} mm '
                f'({N} slots × {pitch_m*1000.0:.0f} mm pitch) — taught '
                f'frame along {axis_letter} is '
                f'{frame_m*1000.0:.0f} mm '
                f'(over by {overshoot_m*1000.0:.0f} mm). Check the '
                f'{axis_name} pitch value or the corner placement.'),
            'grid_m':           grid_m,
            'frame_m':          frame_m,
            'overshoot_m':      overshoot_m,
            'ratio':            ratio,
        })

    _check('row', 'row axis (corner 1 → corner 2)',
           ['c1', 'c2'], pr_m, cols, row_frame_m)
    _check('col', 'column axis (corner 1 → corner 3)',
           ['c1', 'c3'], pc_m, rows, col_frame_m)
    return findings


def _effective_pitches(spec: PalletPlaceSpec
                       ) -> Tuple[float, float, float]:
    """Return (pitch_row_m, pitch_col_m, layer_height_m) actually
    used for slot placement — METERS.

    OPERATOR DOCTRINE RULING (2026-08-05, canonical):
      Corners 1-3 define the pallet FRAME ONLY (origin at corner 1,
      row axis toward corner 2, column axis toward corner 3, plane
      from all three). Point 4 is the CENTER of slot [1,1]. Slot
      spacing comes EXCLUSIVELY from the typed pitch values in the
      palletizing parameters dialog:
        slot[i,j] = datum + (i-1)·pitch_row·row_axis
                          + (j-1)·pitch_col·col_axis
                          + layer·layer_height·plane_normal
      Corner-to-corner distance has NO required relationship to
      pitch. Pre-ruling, this function overrode typed with measured
      when the frame was taught (v2 2026-07-30 heuristic), which
      broke every configuration where the pallet corners were not
      at the [1,N] and [M,1] extreme slot centers — the operator's
      typo-of-record ("typed 150 mm, measured 341 mm at the physical
      corner") was NOT a mismatch, it was the design intent."""
    pr_m = (float(spec.pitch_row_mm) or 0.0) / 1000.0
    pc_m = (float(spec.pitch_col_mm) or 0.0) / 1000.0
    lh_m = (float(spec.layer_height_mm) / 1000.0) \
        if spec.layer_height_mm is not None else 0.0
    return (pr_m, pc_m, lh_m)


def _part_datum_offset(spec: PalletPlaceSpec
                       ) -> Tuple[float, float, float]:
    """Return the (x, y, z) METERS offset from corner1 to part_tcp
    — the v2 part-datum vector applied to every derived slot.

    Rationale: corner1 is the pallet's FIXTURE corner (tool at the
    physical corner feature, tool tip may be a few mm off the
    surface). part_tcp is where the tool ACTUALLY sits when
    presenting a part to slot [1,1] — different Z, potentially
    different XY inside the cell, and different orientation. Every
    slot's final pose = frame position + this offset, so all slots
    share the operator's taught contact geometry.

    Returns (0, 0, 0) when the part datum isn't taught (v1 migration
    with no re-teach yet, or a program that has corners without a
    part pose). Callers should still emit a validation info
    finding — see validate_frame."""
    if not (spec.has_taught_frame() and spec.part_tcp is not None):
        return (0.0, 0.0, 0.0)
    A = _xyz(spec.corner1_tcp)   # meters
    P = _xyz(spec.part_tcp)      # meters
    return (P[0] - A[0], P[1] - A[1], P[2] - A[2])


def compute_slot_offsets(spec: PalletPlaceSpec
                         ) -> List[Tuple[Tuple[int, int, int],
                                          Tuple[float, float, float]]]:
    """Return [((r, c, l), (dx_m, dy_m, dz_m)), ...] in fill
    order. Deltas are METERS in the anchor's base frame.

    Δ = c · pitch_row · row_axis + r · pitch_col · col_axis
        + l · layer_height · plane_normal + part_datum_offset

    Every scalar under the sum is meters (pitches from
    _effective_pitches, part_datum from _part_datum_offset), so
    Δ is meters. row_axis / col_axis / plane_normal come from
    compute_frame() (unit vectors, dimensionless).

    NAMING: row_axis points A→B; col_axis points A→C after
    Gram-Schmidt. pitch_row is the column-to-column spacing
    within a row; pitch_col is the row-to-row spacing within a
    column. Slot (0,0,0) has Δ = (part_datum_offset) — the
    taught part pose relative to corner1."""
    fr = compute_frame(spec)
    rax = fr['row_axis']    # unit vector
    cax = fr['col_axis']    # unit vector
    nax = fr['plane_normal']
    pr_m, pc_m, lh_m = _effective_pitches(spec)
    # v2 part-datum offset — meters. Every slot in the taught
    # frame carries part_tcp's XYZ relative to corner1 so slot
    # [0,0] lands where the operator taught the actual part.
    px_m, py_m, pz_m = _part_datum_offset(spec)
    out: List[Tuple[Tuple[int, int, int], Tuple[float, float, float]]] = []
    for (r, c, l) in _order_indices(spec.rows, spec.cols, spec.layers, spec.order):
        dx_m = c * pr_m * rax[0] + r * pc_m * cax[0] + l * lh_m * nax[0] + px_m
        dy_m = c * pr_m * rax[1] + r * pc_m * cax[1] + l * lh_m * nax[1] + py_m
        dz_m = c * pr_m * rax[2] + r * pc_m * cax[2] + l * lh_m * nax[2] + pz_m
        out.append(((r, c, l), (dx_m, dy_m, dz_m)))
    return out


def derive_slot_tcps(spec: PalletPlaceSpec,
                     anchor_tcp_m: Tuple[float, float, float,
                                          float, float, float]
                     ) -> List[Dict[str, Any]]:
    """Return per-slot absolute TCPs
    `[{index, row, col, layer, tcp_m}, ...]` in METERS + RADIANS.

    Parameter renamed 2026-08-04: `anchor_tcp_m` (was
    `anchor_tcp_mm`, which held meters — the pre-fix unit lie).
    Callers convert to mm at the render boundary (the pallet_slots
    endpoint multiplies XYZ by 1000 to expose `tcp_mm` on the
    twin-facing response).

    Orientation: v2 uses part_tcp's rx/ry/rz when taught, so every
    slot shares the operator-taught PART orientation (not the
    fixture-corner orientation). Falls back to anchor's rx/ry/rz
    when part_tcp isn't taught yet (v1 migration path).

    Position: computed from compute_slot_offsets, which already
    applies the corner-frame + part-datum offset in meters.
    anchor_tcp_m supplies the origin translation — normally
    corner1's TCP.

    No IK here; use reachability_sweep to add per-slot joint
    solutions."""
    ax, ay, az, rx, ry, rz = anchor_tcp_m
    # Orientation source: prefer part_tcp when taught (v2). Falls
    # back to the anchor's own orientation for legacy programs.
    if spec.part_tcp is not None and len(spec.part_tcp) >= 6:
        rx = float(spec.part_tcp[3])
        ry = float(spec.part_tcp[4])
        rz = float(spec.part_tcp[5])
    out: List[Dict[str, Any]] = []
    for i, ((r, c, l), (dx_m, dy_m, dz_m)) in enumerate(
            compute_slot_offsets(spec)):
        out.append({
            'index': i,
            'row':   r,
            'col':   c,
            'layer': l,
            'tcp_m': [ax + dx_m, ay + dy_m, az + dz_m, rx, ry, rz],
        })
    return out


# ── Reachability — unchanged behavior; consumes new offsets ─────

def reachability_sweep(spec: PalletPlaceSpec,
                       anchor_joints_deg: List[float],
                       *,
                       joint_limits_deg: Optional[List[float]] = None,
                       joint_limit_margin_deg: float = 2.0
                       ) -> Dict[str, Any]:
    """Sweep every slot's seeded-IK solution. Same behavior as §1 —
    the taught-frame rewrite changes only how offsets are computed;
    the seeded-IK layer lift + XY approximation are unchanged.
    Failed slots are named by (row, col, layer)."""
    try:
        from estun_driver.program_ops import seeded_ik_z_lift  # noqa
        _ik_ok = True
    except Exception:
        seeded_ik_z_lift = None            # type: ignore
        _ik_ok = False

    limits = list(joint_limits_deg) if joint_limits_deg is not None \
             else [200.0, 200.0, 166.0, 200.0, 166.0, 200.0]

    per_min: List[float] = [float('inf')] * 6
    per_max: List[float] = [float('-inf')] * 6
    unreachable: List[Dict[str, Any]] = []
    near_limit:  List[Dict[str, Any]] = []
    reachable_count = 0

    for ((r, c, l), (dx, dy, dz)) in compute_slot_offsets(spec):
        if not _ik_ok or seeded_ik_z_lift is None:
            unreachable.append({'row': r, 'col': c, 'layer': l,
                                'reason': 'ik unavailable'})
            continue
        ik = seeded_ik_z_lift(list(anchor_joints_deg), dz)
        if ik is None:
            unreachable.append({'row': r, 'col': c, 'layer': l,
                                'reason': f'seeded IK layer lift {dz:+.1f}mm failed'})
            continue
        joints, _ = ik
        for k in range(6):
            if joints[k] < per_min[k]:
                per_min[k] = joints[k]
            if joints[k] > per_max[k]:
                per_max[k] = joints[k]
            margin = limits[k] - abs(joints[k])
            if margin < joint_limit_margin_deg:
                near_limit.append({
                    'row': r, 'col': c, 'layer': l,
                    'axis': k + 1, 'margin_deg': round(margin, 2),
                })
        reachable_count += 1

    return {
        'total_slots':   spec.total_slots(),
        'reachable':     reachable_count,
        'unreachable':   unreachable,
        'per_joint_min': [None if m == float('inf') else round(m, 3) for m in per_min],
        'per_joint_max': [None if m == float('-inf') else round(m, 3) for m in per_max],
        'near_limit':    near_limit,
        'ik_available':  _ik_ok,
    }


def slot_label(row: int, col: int, layer: int, layers: int) -> str:
    """Canonical human-readable slot label used in composer step
    labels + unreachable-slot refusal messages."""
    if layers > 1:
        return f'slot r{row},c{col},l{layer}'
    return f'slot r{row},c{col}'

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

# Validation thresholds.
_MIN_ROW_COL_ANGLE_DEG = 60.0   # row·col angle must exceed this
_MAX_TILT_DEG          = 10.0   # warn beyond
_PITCH_MISMATCH_MM     = 3.0    # warn when |measured − typed| > this
_PART_DATUM_MAX_SLOTS  = 1.5    # warn when |part - corner1| > this × max_pitch
_MIN_EDGE_LEN_MM       = 1.0    # coincident-corner threshold (§465 fork-1)


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
    """Extract (x, y, z) mm from a taught_tcp 6-vector. Accepts
    list/tuple; returns (0,0,0) on malformed input so downstream
    math doesn't crash — callers must gate on has_taught_frame."""
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
    # Tilt: angle between plane_normal and +Z (or -Z — same physical
    # plane). abs() so a normal pointing at -Z on a level pallet reads
    # tilt=0.
    tilt_dot = abs(max(-1.0, min(1.0, _dot(plane_normal, (0.0, 0.0, 1.0)))))
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
    """Return (pitch_row_mm, pitch_col_mm) DERIVED from the taught
    corner positions.

    v2 (2026-07-30): corner2 is the pallet corner at [row 1, col N],
    corner3 at [row M, col 1]. Corners are ALWAYS at slot boundaries
    (the operator touched the fixture, not "somewhere along an
    edge"), so:

        pitch_row = |corner2 - corner1| / (cols - 1)
        pitch_col = |corner3 - corner1| / (rows - 1)

    The v1 teach_mode='edge' was retired in v2 — corners are
    unambiguous. teach_mode is retained on the schema but ignored
    by v2 math.

    Missing frame → (None, None). 1-row or 1-col pallet → None
    for that pitch."""
    if not spec.has_taught_frame():
        return (None, None)
    A = _xyz(spec.corner1_tcp)
    B = _xyz(spec.corner2_tcp)
    C = _xyz(spec.corner3_tcp)
    pitch_row = None
    if spec.cols and spec.cols > 1:
        pitch_row = _len(_sub(B, A)) / float(spec.cols - 1)
    pitch_col = None
    if spec.rows and spec.rows > 1:
        pitch_col = _len(_sub(C, A)) / float(spec.rows - 1)
    return (pitch_row, pitch_col)


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
    # row (c1→c2) or col (c1→c3) is under _MIN_EDGE_LEN_MM the
    # operator taught two corners at the same pose. Emitted BEFORE
    # the near-parallel angle check because that check reports
    # angle=0 on coincident inputs, and "same direction" is a
    # confusing operator message when the real problem is "same
    # point". `involves_corners` and `distance_mm` let the UI
    # (a) suppress findings mentioning the corner currently being
    # re-taught, and (b) name the exact measurement in the copy.
    A = _xyz(spec.corner1_tcp)
    B = _xyz(spec.corner2_tcp)
    C = _xyz(spec.corner3_tcp)
    row_len_mm = _len(_sub(B, A))
    col_len_mm = _len(_sub(C, A))
    if row_len_mm < _MIN_EDGE_LEN_MM:
        out.append({
            'severity':         'error',
            'code':             'corner_coincident',
            'involves_corners': ['c1', 'c2'],
            'distance_mm':      row_len_mm,
            'message': (
                f'Corners 1 and 2 appear coincident ({row_len_mm:.2f} '
                f'mm apart) — jog to the actual pallet corner and '
                f're-teach.'),
        })
    if col_len_mm < _MIN_EDGE_LEN_MM:
        out.append({
            'severity':         'error',
            'code':             'corner_coincident',
            'involves_corners': ['c1', 'c3'],
            'distance_mm':      col_len_mm,
            'message': (
                f'Corners 1 and 3 appear coincident ({col_len_mm:.2f} '
                f'mm apart) — jog to the actual pallet corner and '
                f're-teach.'),
        })
    # If either edge collapsed, skip the angle check — angle math
    # is meaningless without both directions.
    if row_len_mm < _MIN_EDGE_LEN_MM or col_len_mm < _MIN_EDGE_LEN_MM:
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
        A = _xyz(spec.corner1_tcp)
        P = _xyz(spec.part_tcp)
        d = _len(_sub(P, A))
        m_row, m_col = measured_pitches(spec)
        pitches = [p for p in (m_row, m_col,
                               spec.pitch_row_mm, spec.pitch_col_mm)
                   if p and p > 0]
        max_pitch = max(pitches) if pitches else 0.0
        if max_pitch > 0 and d > _PART_DATUM_MAX_SLOTS * max_pitch:
            out.append({
                'severity': 'warning',
                'code':     'part_datum_far_from_corner',
                'involves_corners': ['c1', 'c4'],
                'message': (
                    f'First-part position ④ is {d:.1f} mm from '
                    f'corner 1 — more than '
                    f'{_PART_DATUM_MAX_SLOTS:g} × max pitch '
                    f'({max_pitch:.1f} mm). Is the part actually '
                    f'in the first slot?'),
                'distance_mm':      d,
                'max_pitch_mm':     max_pitch,
                'threshold_slots':  _PART_DATUM_MAX_SLOTS,
            })

    if spec.teach_mode == 'far_slot':
        m_row, m_col = measured_pitches(spec)
        if m_row is not None and spec.pitch_row_mm > 0:
            diff = abs(m_row - spec.pitch_row_mm)
            if diff > _PITCH_MISMATCH_MM:
                out.append({
                    'severity': 'warning',
                    'code':     'row_pitch_mismatch',
                    'message': (
                        f'Row pitch: typed {spec.pitch_row_mm:.1f}mm '
                        f'vs measured {m_row:.1f}mm — differ by '
                        f'{diff:.1f}mm (threshold '
                        f'{_PITCH_MISMATCH_MM:g}mm). Was point B '
                        f'taught at the far column [1, N]? If so, '
                        f'update the typed value to match the '
                        f'measurement.'),
                    'typed_mm':    spec.pitch_row_mm,
                    'measured_mm': m_row,
                })
        if m_col is not None and spec.pitch_col_mm > 0:
            diff = abs(m_col - spec.pitch_col_mm)
            if diff > _PITCH_MISMATCH_MM:
                out.append({
                    'severity': 'warning',
                    'code':     'col_pitch_mismatch',
                    'message': (
                        f'Column pitch: typed {spec.pitch_col_mm:.1f}mm '
                        f'vs measured {m_col:.1f}mm — differ by '
                        f'{diff:.1f}mm (threshold '
                        f'{_PITCH_MISMATCH_MM:g}mm). Was point C '
                        f'taught at the far row [M, 1]? If so, update '
                        f'the typed value to match the measurement.'),
                    'typed_mm':    spec.pitch_col_mm,
                    'measured_mm': m_col,
                })
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

def _effective_pitches(spec: PalletPlaceSpec
                       ) -> Tuple[float, float, float]:
    """Return (pitch_row_mm, pitch_col_mm, layer_height_mm) actually
    used for slot placement.

    v2 (2026-07-30): MEASURED pitches always take precedence when
    the frame is taught — corners are unambiguous slot-boundary
    references, and the typed values only serve as the operator's
    cross-check (see validate_frame's row/col_pitch_mismatch
    warnings). Untaught frame falls back to typed values."""
    pr = float(spec.pitch_row_mm)
    pc = float(spec.pitch_col_mm)
    if spec.has_taught_frame():
        m_row, m_col = measured_pitches(spec)
        if m_row is not None:
            pr = m_row
        if m_col is not None:
            pc = m_col
    lh = float(spec.layer_height_mm) if spec.layer_height_mm is not None else 0.0
    return (pr, pc, lh)


def _part_datum_offset(spec: PalletPlaceSpec
                       ) -> Tuple[float, float, float]:
    """Return the (x, y, z) mm offset from corner1 to part_tcp — the
    v2 part-datum vector applied to every derived slot.

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
    A = _xyz(spec.corner1_tcp)
    P = _xyz(spec.part_tcp)
    return (P[0] - A[0], P[1] - A[1], P[2] - A[2])


def compute_slot_offsets(spec: PalletPlaceSpec
                         ) -> List[Tuple[Tuple[int, int, int],
                                          Tuple[float, float, float]]]:
    """Return [((r, c, l), (dx, dy, dz)), ...] in fill order.

    Δ is in the ANCHOR'S BASE FRAME:
      Δ = c · pitch_row · row_axis + r · pitch_col · col_axis
          + l · layer_height · plane_normal

    NAMING (matches operator + wizard vocabulary):
      * row_axis points from A toward B — the "along-a-row"
        direction. Walking along a row of cells means advancing
        the COLUMN index.
      * col_axis points from A toward C — the "down-a-column"
        direction. Advancing the ROW index moves along col_axis.
      * pitch_row = spacing of cells within a row (i.e. between
                    adjacent columns). Measured as |B-A|/(cols-1)
                    in far_slot mode.
      * pitch_col = spacing of cells within a column (i.e. between
                    adjacent rows). Measured as |C-A|/(rows-1)
                    in far_slot mode.

    So the row-INDEX r multiplies pitch_col along col_axis, and
    the col-INDEX c multiplies pitch_row along row_axis. This
    unpacks the natural language: "pitch_row is the column-to-
    column distance within a row" and "row_axis is the direction
    you walk along the row".

    row_axis / col_axis / plane_normal come from compute_frame(),
    which uses the taught 3-point frame when present and falls back
    to base-axis literals otherwise. Pitches come from
    _effective_pitches() (measured in far_slot mode, typed
    elsewhere). Slot (0,0,0) is always Δ = (0,0,0) — it IS the
    anchor."""
    fr = compute_frame(spec)
    rax = fr['row_axis']
    cax = fr['col_axis']
    nax = fr['plane_normal']
    pr, pc, lh = _effective_pitches(spec)
    # v2 part-datum offset: every slot in the taught frame carries
    # part_tcp's XYZ relative to corner1 so slot [0,0] lands where
    # the operator taught the actual part (not where they touched
    # the fixture corner). Zero vector when part_tcp isn't taught.
    px, py, pz = _part_datum_offset(spec)
    out: List[Tuple[Tuple[int, int, int], Tuple[float, float, float]]] = []
    for (r, c, l) in _order_indices(spec.rows, spec.cols, spec.layers, spec.order):
        dx = c * pr * rax[0] + r * pc * cax[0] + l * lh * nax[0] + px
        dy = c * pr * rax[1] + r * pc * cax[1] + l * lh * nax[1] + py
        dz = c * pr * rax[2] + r * pc * cax[2] + l * lh * nax[2] + pz
        out.append(((r, c, l), (dx, dy, dz)))
    return out


def derive_slot_tcps(spec: PalletPlaceSpec,
                     anchor_tcp_mm: Tuple[float, float, float, float, float, float]
                     ) -> List[Dict[str, Any]]:
    """Return per-slot absolute TCPs [{index, row, col, layer, tcp_mm}, ...].

    Orientation: v2 uses part_tcp's rx/ry/rz when taught, so every
    slot shares the operator-taught PART orientation (not the
    fixture-corner orientation). Falls back to anchor_tcp_mm's
    rx/ry/rz when part_tcp isn't taught yet (v1 migration path).

    Position: computed from compute_slot_offsets, which already
    applies the corner-frame + part-datum offset. anchor_tcp_mm
    supplies the origin translation — normally corner1's TCP.

    No IK here; use reachability_sweep to add per-slot joint
    solutions."""
    ax, ay, az, rx, ry, rz = anchor_tcp_mm
    # Orientation source: prefer part_tcp when taught (v2). Falls
    # back to the anchor's own orientation for legacy programs.
    if spec.part_tcp is not None and len(spec.part_tcp) >= 6:
        rx, ry, rz = float(spec.part_tcp[3]), float(spec.part_tcp[4]), float(spec.part_tcp[5])
    out: List[Dict[str, Any]] = []
    for i, ((r, c, l), (dx, dy, dz)) in enumerate(compute_slot_offsets(spec)):
        out.append({
            'index': i,
            'row':   r,
            'col':   c,
            'layer': l,
            'tcp_mm': [ax + dx, ay + dy, az + dz, rx, ry, rz],
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

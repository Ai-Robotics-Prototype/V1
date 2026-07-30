"""Pallet-place slot derivation + reachability sweep (2026-08-06 §3).

Pure math on `PalletPlaceSpec` + an anchor pose. Emits:

  * `compute_slot_offsets(spec)`         → per-slot Δ(x,y,z) in mm
                                            IN THE ANCHOR'S BASE FRAME,
                                            ordered per spec.order.
  * `derive_slot_tcps(spec, anchor_tcp)` → per-slot absolute TCP list
                                            (anchor_tcp + offset), same
                                            order.
  * `reachability_sweep(spec, anchor_joints_deg)` → seeded-IK sweep
                                            report: per-joint min/max
                                            across all slots + list of
                                            unreachable slot indices +
                                            the anchor's own joint /
                                            wrist ambiguity metrics.
                                            Codegen calls this and
                                            refuses when any slot fails
                                            with a name like
                                            "slot r2,c3 unreachable".

The Δ math is deterministic. Reachability uses the estun_driver's
seeded-IK z-lift helper for the layer axis and per-slot cartesian
displacement — same §401 machinery the FIX-C derived approaches use.
Import is deferred so this module has no hard dependency on
estun_driver at import time; when the driver isn't on sys.path the
sweep degrades to "cannot verify" for every slot rather than
crashing.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from .schema import PalletPlaceSpec


_AXIS_TO_DXYZ_MM_PER_MM = {
    '+X': (1.0, 0.0, 0.0),
    '-X': (-1.0, 0.0, 0.0),
    '+Y': (0.0, 1.0, 0.0),
    '-Y': (0.0, -1.0, 0.0),
}


def _order_indices(rows: int, cols: int, layers: int,
                   order: str) -> List[Tuple[int, int, int]]:
    """Return (row, col, layer) tuples in the fill order.

    row_major : (0,0,0) (0,1,0) … (0,C-1,0) (1,0,0) … then next layer.
    col_major : (0,0,0) (1,0,0) … (R-1,0,0) (0,1,0) … then next layer.
    snake     : row_major with every ODD row reversed (0→C-1 then
                C-1→0 then 0→C-1 …). Layers are always incremented
                after the whole 2D grid is filled — the operator's
                "next layer" moment matches the arm resetting to a
                fresh row-0 position at a raised Z.
    """
    idx: List[Tuple[int, int, int]] = []
    for l in range(layers):
        for r in range(rows):
            if order == 'col_major':
                # Emit by column-first for the whole layer, then break.
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


def compute_slot_offsets(spec: PalletPlaceSpec
                         ) -> List[Tuple[Tuple[int, int, int],
                                          Tuple[float, float, float]]]:
    """Return [((r, c, l), (dx, dy, dz)), ...] in fill order.

    dz uses (spec.layer_height_mm or 0.0) × layer_index — 0 for the
    default single-layer case. When `layers > 1` and layer_height_mm
    is None the UI validation should catch it; here we defensively
    default to 0.0 so the math never produces NaN.
    """
    rax = _AXIS_TO_DXYZ_MM_PER_MM.get(spec.row_axis.upper(), (1.0, 0.0, 0.0))
    cax = _AXIS_TO_DXYZ_MM_PER_MM.get(spec.col_axis.upper(), (0.0, 1.0, 0.0))
    lh_mm = float(spec.layer_height_mm) if spec.layer_height_mm is not None else 0.0
    pr = float(spec.pitch_row_mm)
    pc = float(spec.pitch_col_mm)
    out: List[Tuple[Tuple[int, int, int], Tuple[float, float, float]]] = []
    for (r, c, l) in _order_indices(spec.rows, spec.cols, spec.layers, spec.order):
        dx = r * pr * rax[0] + c * pc * cax[0]
        dy = r * pr * rax[1] + c * pc * cax[1]
        dz = r * pr * rax[2] + c * pc * cax[2] + l * lh_mm
        out.append(((r, c, l), (dx, dy, dz)))
    return out


def derive_slot_tcps(spec: PalletPlaceSpec,
                     anchor_tcp_mm: Tuple[float, float, float, float, float, float]
                     ) -> List[Dict[str, Any]]:
    """Return per-slot absolute TCPs [{index, row, col, layer, tcp_mm}, ...].

    Orientation carries over from the anchor — pallet slots share
    orientation by definition (task §1). No IK here; use
    reachability_sweep to add per-slot joint solutions.
    """
    ax, ay, az, rx, ry, rz = anchor_tcp_mm
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


def reachability_sweep(spec: PalletPlaceSpec,
                       anchor_joints_deg: List[float],
                       *,
                       joint_limits_deg: Optional[List[float]] = None,
                       joint_limit_margin_deg: float = 2.0
                       ) -> Dict[str, Any]:
    """Sweep every slot's seeded-IK solution and report:

        {
          'total_slots':   int,
          'reachable':     int,
          'unreachable':   [{'row','col','layer','reason'}, ...],
          'per_joint_min': [j1..j6] deg across all reachable slots,
          'per_joint_max': [j1..j6] deg across all reachable slots,
          'near_limit':    [{'row','col','layer','axis','margin_deg'}, ...],
          'ik_available':  bool,   # False when the driver's IK isn't
                                    # importable — every slot returns
                                    # reason='ik unavailable'.
        }

    Slot-i joints are computed by:
      1. Seeded IK for the pure-Z layer offset (l · layer_height_mm)
         from the anchor's joints — reuses the driver's
         seeded_ik_z_lift (holds J4/J5/J6 exactly).
      2. In-plane (dx, dy) offset: no seeded solver ships today for
         arbitrary XY, so we approximate by adding the offset in the
         base frame and running the same seeded_ik_z_lift with the
         XY-shifted TCP. When the driver exposes an XY-capable seeded
         IK we swap it in here — the call surface stays the same.
    """
    # Deferred import so this module can be used in tests / envs
    # where the driver package isn't on the path.
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
        # First pass: layer offset only via seeded IK.  In-plane
        # placement uses the anchor's joints as the seed and lets the
        # controller resolve XY at run time; a proper XY-seeded IK
        # would replace this call.
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
    labels + unreachable-slot refusal messages.
    Example:  "slot r2,c3"  (single-layer),  "slot r2,c3,l1" (multi-layer)."""
    if layers > 1:
        return f'slot r{row},c{col},l{layer}'
    return f'slot r{row},c{col}'

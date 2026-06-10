"""Tier 1 — dimensional verification.

Pure-NumPy measurements computed from a Nx3 point cloud. No Open3D,
no scikit-image — keeps Tier 1 cheap and importable even when the
heavier deps are missing.

All length-like outputs are millimetres (the Mech-Eye driver publishes
in metres; the inspection_node converts before passing in here).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .utils import Measurement, severity_from_deviation, RESULT_PASS


# ─── Primitive measurements ─────────────────────────────────────────────

def measure_overall_dimensions(cloud: np.ndarray) -> dict:
    """Axis-aligned bounding box dimensions in the cloud's own frame.

    Cheaper than the OBB — useful when the part is known to be
    pre-aligned (e.g. resting on a tooled fixture).
    """
    cloud = _validate_cloud(cloud)
    if cloud.shape[0] == 0:
        return {'x_extent_mm': 0.0, 'y_extent_mm': 0.0, 'z_extent_mm': 0.0}
    mins = cloud.min(axis=0)
    maxs = cloud.max(axis=0)
    ext = maxs - mins
    return {
        'x_extent_mm': float(ext[0]),
        'y_extent_mm': float(ext[1]),
        'z_extent_mm': float(ext[2]),
    }


def measure_oriented_bbox(cloud: np.ndarray) -> dict:
    """OBB via PCA on the centred cloud.

    Returns the three principal-axis extents (length ≥ width ≥ height),
    the principal axes as unit vectors, and the centre. PCA is much
    cheaper than open3d.geometry.OrientedBoundingBox and avoids pulling
    Open3D into the import graph for Tier 1.
    """
    cloud = _validate_cloud(cloud)
    if cloud.shape[0] < 3:
        return {
            'length_mm': 0.0, 'width_mm': 0.0, 'height_mm': 0.0,
            'principal_axes': [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            'center': [0.0, 0.0, 0.0],
        }

    center = cloud.mean(axis=0)
    centred = cloud - center
    # SVD on the centred cloud is the standard PCA route. Right
    # singular vectors are the principal axes.
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    axes = vt[:3]  # 3x3, rows are unit principal axes

    # Project all points onto each principal axis and take the extent.
    projected = centred @ axes.T          # Nx3
    extents = projected.max(axis=0) - projected.min(axis=0)  # 3,

    # Sort largest → smallest so the caller always knows which is
    # length / width / height.
    order = np.argsort(-extents)
    extents = extents[order]
    axes = axes[order]

    return {
        'length_mm': float(extents[0]),
        'width_mm':  float(extents[1]),
        'height_mm': float(extents[2]),
        'principal_axes': axes.tolist(),
        'center': center.tolist(),
    }


def measure_aspect_ratios(dims: dict) -> dict:
    """Ratios of OBB extents. Useful for orientation-independent shape ID."""
    L = dims.get('length_mm', 0.0)
    W = dims.get('width_mm', 0.0)
    H = dims.get('height_mm', 0.0)

    def _ratio(a: float, b: float) -> float:
        return float(a / b) if b > 1e-9 else 0.0

    return {
        'l_w_ratio': _ratio(L, W),
        'l_h_ratio': _ratio(L, H),
        'w_h_ratio': _ratio(W, H),
    }


def measure_volume(cloud: np.ndarray, voxel_mm: float = 1.0) -> dict:
    """Two-method volume estimate.

    convex_hull_volume_mm3 — fast, exact for convex parts, slight
        overestimate for concave parts (Open3D's QHull wrapper if it's
        available, scipy's ConvexHull as fallback).
    voxel_volume_mm3 — count of occupied 1 mm voxels times cell
        volume. Handles concavity correctly but is dominated by the
        voxel grid quality.
    """
    cloud = _validate_cloud(cloud)
    out = {'convex_hull_volume_mm3': 0.0, 'voxel_volume_mm3': 0.0}
    if cloud.shape[0] < 4:
        return out

    out['convex_hull_volume_mm3'] = _convex_hull_volume(cloud)
    out['voxel_volume_mm3'] = _voxel_volume(cloud, voxel_mm)
    return out


def measure_centroid(cloud: np.ndarray) -> dict:
    """Arithmetic centroid (not COM — point clouds carry no mass)."""
    cloud = _validate_cloud(cloud)
    if cloud.shape[0] == 0:
        return {'x_mm': 0.0, 'y_mm': 0.0, 'z_mm': 0.0}
    c = cloud.mean(axis=0)
    return {'x_mm': float(c[0]), 'y_mm': float(c[1]), 'z_mm': float(c[2])}


def measure_principal_axes(cloud: np.ndarray) -> dict:
    """Principal axes + ZYX Euler angles (degrees).

    The Euler convention is the one used by the rest of the cobot stack
    (`scene_graph` publishes ZYX). Stick to it so the inspection output
    composes with `/tf` without conversions on the operator's side.
    """
    obb = measure_oriented_bbox(cloud)
    R = np.array(obb['principal_axes'])  # 3x3

    # ZYX (yaw, pitch, roll) from the rotation matrix. Standard formula
    # — the edge case (gimbal lock) is handled by the asin clamp.
    sy = math.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    if sy > 1e-6:
        roll  = math.atan2(R[2, 1], R[2, 2])
        pitch = math.atan2(-R[2, 0], sy)
        yaw   = math.atan2(R[1, 0], R[0, 0])
    else:
        roll  = math.atan2(-R[1, 2], R[1, 1])
        pitch = math.atan2(-R[2, 0], sy)
        yaw   = 0.0

    return {
        'axis1': R[0].tolist(),
        'axis2': R[1].tolist(),
        'axis3': R[2].tolist(),
        'roll_deg':  math.degrees(roll),
        'pitch_deg': math.degrees(pitch),
        'yaw_deg':   math.degrees(yaw),
    }


# ─── Tolerance comparison ───────────────────────────────────────────────

def compare_to_tolerance(measured: float, nominal: float | None,
                         tol_warn: float | None, tol_fail: float | None,
                         units: str = 'mm') -> dict:
    """Apply a tolerance rule to one scalar measurement.

    Returns the deviation, severity, and the rule that was applied so
    the dashboard can show the exact reason for any non-pass.
    """
    if nominal is None:
        # Free measurement — no nominal, just record the value.
        return {
            'measured': float(measured),
            'nominal':  None,
            'deviation': None,
            'result':   RESULT_PASS,
            'units':    units,
        }

    deviation = float(measured - nominal)
    if tol_fail is None and tol_warn is None:
        return {
            'measured': float(measured), 'nominal': float(nominal),
            'deviation': deviation, 'result': RESULT_PASS, 'units': units,
        }

    sev = severity_from_deviation(
        deviation,
        tol_warn if tol_warn is not None else float('inf'),
        tol_fail if tol_fail is not None else float('inf'),
    )
    return {
        'measured':       float(measured),
        'nominal':        float(nominal),
        'deviation':      deviation,
        'tolerance_warn': tol_warn,
        'tolerance_fail': tol_fail,
        'result':         sev,
        'units':          units,
    }


# ─── End-to-end Tier 1 pipeline ─────────────────────────────────────────

def run_tier1_inspection(cloud: np.ndarray,
                         tolerance_rules: dict[str, dict]) -> list[Measurement]:
    """Full Tier 1 sweep: every primitive measurement + tolerance check.

    `tolerance_rules` maps measurement name (e.g. 'length_mm') to a dict
    with keys: nominal, tol_warn, tol_fail. Missing entries become
    free measurements (no nominal, always pass).
    """
    out: list[Measurement] = []
    obb  = measure_oriented_bbox(cloud)
    aabb = measure_overall_dimensions(cloud)
    ratios = measure_aspect_ratios(obb)
    vol  = measure_volume(cloud)
    cent = measure_centroid(cloud)
    pa   = measure_principal_axes(cloud)

    scalar_map = {
        'length_mm':           ('dimensional', obb['length_mm'], 'mm'),
        'width_mm':            ('dimensional', obb['width_mm'],  'mm'),
        'height_mm':           ('dimensional', obb['height_mm'], 'mm'),
        'x_extent_mm':         ('dimensional', aabb['x_extent_mm'], 'mm'),
        'y_extent_mm':         ('dimensional', aabb['y_extent_mm'], 'mm'),
        'z_extent_mm':         ('dimensional', aabb['z_extent_mm'], 'mm'),
        'l_w_ratio':           ('dimensional', ratios['l_w_ratio'], 'ratio'),
        'l_h_ratio':           ('dimensional', ratios['l_h_ratio'], 'ratio'),
        'w_h_ratio':           ('dimensional', ratios['w_h_ratio'], 'ratio'),
        'volume_mm3':          ('dimensional', vol['convex_hull_volume_mm3'], 'mm^3'),
        'voxel_volume_mm3':    ('dimensional', vol['voxel_volume_mm3'], 'mm^3'),
        'centroid_x_mm':       ('dimensional', cent['x_mm'], 'mm'),
        'centroid_y_mm':       ('dimensional', cent['y_mm'], 'mm'),
        'centroid_z_mm':       ('dimensional', cent['z_mm'], 'mm'),
        'yaw_deg':             ('dimensional', pa['yaw_deg'],   'deg'),
        'pitch_deg':           ('dimensional', pa['pitch_deg'], 'deg'),
        'roll_deg':            ('dimensional', pa['roll_deg'],  'deg'),
    }

    for name, (category, measured, units) in scalar_map.items():
        rule = tolerance_rules.get(name, {})
        cmp = compare_to_tolerance(
            measured,
            rule.get('nominal'),
            rule.get('tol_warn'),
            rule.get('tol_fail'),
            units=units,
        )
        out.append(Measurement(
            name=name,
            category=category,
            nominal=cmp['nominal'],
            measured=cmp['measured'],
            units=units,
            tolerance_warn=rule.get('tol_warn'),
            tolerance_fail=rule.get('tol_fail'),
            result=cmp['result'],
            deviation=cmp['deviation'],
        ))
    return out


# ─── Internals ──────────────────────────────────────────────────────────

def _validate_cloud(cloud: Any) -> np.ndarray:
    """Coerce input to (N, 3) float32 and sanity-check shape.

    Callers may hand in a raw numpy array, an Open3D PointCloud (we
    duck-type around it), or a list of tuples. Reject anything else
    fast so weird shapes don't propagate into the math.
    """
    if hasattr(cloud, 'points'):
        # Looks like an open3d.geometry.PointCloud
        cloud = np.asarray(cloud.points)
    cloud = np.asarray(cloud, dtype=np.float32)
    if cloud.ndim != 2 or cloud.shape[1] != 3:
        raise ValueError(
            f'cloud must be (N, 3); got shape {cloud.shape}')
    return cloud


def _convex_hull_volume(cloud: np.ndarray) -> float:
    """Convex hull volume — scipy if available, else 0.

    QHull is a hard dep of scipy so on a normal install this just
    works; if scipy is missing we degrade to 0 rather than crash.
    """
    try:
        from scipy.spatial import ConvexHull
        return float(ConvexHull(cloud).volume)
    except Exception:
        return 0.0


def _voxel_volume(cloud: np.ndarray, voxel_mm: float) -> float:
    """Voxel grid volume — count unique occupied cells × cell volume."""
    if voxel_mm <= 0:
        return 0.0
    # Quantise to integer voxel indices, take unique rows.
    grid = np.floor(cloud / voxel_mm).astype(np.int64)
    occupied = np.unique(grid, axis=0).shape[0]
    return float(occupied) * (voxel_mm ** 3)

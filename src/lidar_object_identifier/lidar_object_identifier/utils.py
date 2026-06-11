"""Shared helpers for the LiDAR identifier."""
from __future__ import annotations

import struct
from typing import Optional, Tuple

import numpy as np


def decode_pointcloud2_xyz(msg) -> np.ndarray:
    """Vectorized PointCloud2 → (N,3) float32 decode.

    Falls back to a per-point unpack if fields are interleaved oddly.
    """
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ('x', 'y', 'z')):
        return np.empty((0, 3), dtype=np.float32)
    step = msg.point_step
    if step <= 0:
        return np.empty((0, 3), dtype=np.float32)
    data = bytes(msg.data)
    n = len(data) // step
    if n == 0:
        return np.empty((0, 3), dtype=np.float32)
    ox = fields['x'].offset
    oy = fields['y'].offset
    oz = fields['z'].offset
    if oy == ox + 4 and oz == ox + 8:
        block = (np.frombuffer(data, dtype=np.uint8)
                 .reshape(n, step)[:, ox:ox + 12].copy())
        return block.view(np.float32).reshape(n, 3)
    out = np.empty((n, 3), dtype=np.float32)
    for i in range(n):
        base = i * step
        out[i, 0] = struct.unpack_from('f', data, base + ox)[0]
        out[i, 1] = struct.unpack_from('f', data, base + oy)[0]
        out[i, 2] = struct.unpack_from('f', data, base + oz)[0]
    return out


def crop_to_box(points: np.ndarray,
                xmin: float, xmax: float,
                ymin: float, ymax: float,
                zmin: float, zmax: float) -> np.ndarray:
    if points.size == 0:
        return points
    mask = ((points[:, 0] >= xmin) & (points[:, 0] <= xmax)
            & (points[:, 1] >= ymin) & (points[:, 1] <= ymax)
            & (points[:, 2] >= zmin) & (points[:, 2] <= zmax))
    return points[mask]


def points_inside_polygon(points_xy: np.ndarray,
                          polygon: np.ndarray) -> np.ndarray:
    """Ray-casting point-in-polygon, returns boolean mask of points inside.

    polygon: (M,2) array of CCW or CW vertices, last vertex != first.
    """
    if points_xy.size == 0 or polygon.shape[0] < 3:
        return np.zeros(points_xy.shape[0], dtype=bool)
    n = polygon.shape[0]
    x, y = points_xy[:, 0], points_xy[:, 1]
    inside = np.zeros(x.shape[0], dtype=bool)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i, 0], polygon[i, 1]
        xj, yj = polygon[j, 0], polygon[j, 1]
        cond = ((yi > y) != (yj > y)) & (
            x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)
        inside ^= cond
        j = i
    return inside


def quat_from_matrix(R: np.ndarray) -> Tuple[float, float, float, float]:
    """Return (x, y, z, w) quaternion from a 3x3 rotation matrix."""
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0.0:
        s = 0.5 / np.sqrt(tr + 1.0)
        w = 0.25 / s
        x = (R[2, 1] - R[1, 2]) * s
        y = (R[0, 2] - R[2, 0]) * s
        z = (R[1, 0] - R[0, 1]) * s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2])
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2])
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1])
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    return float(x), float(y), float(z), float(w)


def iso_now_z() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec='seconds') + 'Z'

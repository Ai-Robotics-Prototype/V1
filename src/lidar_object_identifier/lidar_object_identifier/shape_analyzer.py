"""Geometric feature extraction for a single cluster."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Tuple

import numpy as np

logger = logging.getLogger(__name__)

try:
    import open3d as o3d
    OPEN3D_AVAILABLE = True
except Exception:
    o3d = None
    OPEN3D_AVAILABLE = False


@dataclass
class ShapeFeatures:
    center: np.ndarray              # (3,) OBB center
    dimensions_m: np.ndarray        # (3,) sorted descending: L, W, H
    rotation: np.ndarray            # (3,3)
    volume_m3: float                # convex hull
    obb_volume_m3: float            # bounding box volume
    surface_area_m2: float
    sphericity: float
    flatness: float
    elongation: float
    compactness: float
    solidity: float                 # hull / OBB
    point_count: int
    density_per_m3: float


def _principal_axes(points: np.ndarray,
                    extent_pct_low: float = 2.0,
                    extent_pct_high: float = 98.0,
                    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (center, rotation_3x3, extents_along_axes).

    Extents are computed from PERCENTILES of the per-axis projections,
    not the raw min/max — a single outlier point (a stray ray return,
    a sensor flash, a partially-segmented neighbouring object)
    otherwise stretches the OBB across empty space. The defaults
    (2nd / 98th percentile) reject the top + bottom 2 % of points per
    axis, so the box hugs the dense bulk of the cluster instead of
    its outliers.

    Pass extent_pct_low=0, extent_pct_high=100 to recover the legacy
    raw-min/max behaviour.
    """
    center = points.mean(axis=0)
    centred = points - center
    cov = np.cov(centred.T)
    # Symmetric: eigh is more numerically stable than eig.
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)[::-1]
    eigvecs = eigvecs[:, order]
    # Ensure right-handed coordinate frame
    if np.linalg.det(eigvecs) < 0:
        eigvecs[:, 2] = -eigvecs[:, 2]
    projected = centred @ eigvecs
    if extent_pct_low <= 0.0 and extent_pct_high >= 100.0:
        mins = projected.min(axis=0)
        maxs = projected.max(axis=0)
    else:
        # np.percentile is per-column when axis=0.
        mins = np.percentile(projected, extent_pct_low,  axis=0)
        maxs = np.percentile(projected, extent_pct_high, axis=0)
    extents = maxs - mins
    # Shift center to box center along the (trimmed) principal axes
    # so the OBB sits on the dense mass, not on the outlier-skewed
    # arithmetic mean of all points.
    center = center + eigvecs @ ((mins + maxs) * 0.5)
    return center, eigvecs, extents


def _hull_metrics(points: np.ndarray) -> Tuple[float, float]:
    """Return (hull_volume, hull_surface_area). Falls back to OBB when the
    cluster is too thin / colinear for a valid 3D convex hull."""
    if OPEN3D_AVAILABLE and points.shape[0] >= 4:
        try:
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
            hull, _ = pcd.compute_convex_hull()
            return float(hull.get_volume()), float(hull.get_surface_area())
        except Exception:
            pass
    try:
        from scipy.spatial import ConvexHull
        hull = ConvexHull(points.astype(np.float64))
        return float(hull.volume), float(hull.area)
    except Exception:
        return 0.0, 0.0


def analyze(points: np.ndarray) -> ShapeFeatures:
    if points.shape[0] < 3:
        return ShapeFeatures(
            center=points.mean(axis=0) if points.size else np.zeros(3),
            dimensions_m=np.zeros(3), rotation=np.eye(3),
            volume_m3=0.0, obb_volume_m3=0.0, surface_area_m2=0.0,
            sphericity=0.0, flatness=0.0, elongation=0.0,
            compactness=0.0, solidity=0.0,
            point_count=int(points.shape[0]),
            density_per_m3=0.0,
        )

    center, R, extents = _principal_axes(points)
    # Sort descending so dim[0]=L, dim[1]=W, dim[2]=H.
    order = np.argsort(extents)[::-1]
    extents_sorted = extents[order]
    R_sorted = R[:, order]
    L, W, H = float(extents_sorted[0]), float(extents_sorted[1]), float(extents_sorted[2])
    obb_volume = max(L * W * H, 1.0e-9)

    hull_volume, hull_surface = _hull_metrics(points)
    if hull_volume <= 0.0:
        hull_volume = obb_volume * 0.5
    if hull_surface <= 0.0:
        hull_surface = 2.0 * (L * W + W * H + L * H)

    # Shape descriptors. Diameter is the largest single-axis extent (the
    # OBB's bounding diameter). Using the L2 norm of all three extents
    # would inflate the denominator and force sphericity ≪ 1 even for a
    # perfect sphere.
    diameter = max(L, 1.0e-6)
    sphericity = (6.0 * hull_volume) / (np.pi * diameter ** 3)
    sphericity = max(0.0, min(1.0, float(sphericity)))
    flatness = H / max(L, 1.0e-6)
    elongation = L / max(W, 1.0e-6)
    compactness = (hull_volume ** (2.0 / 3.0)) / max(hull_surface, 1.0e-6)
    solidity = hull_volume / obb_volume
    solidity = float(max(0.0, min(1.0, solidity)))

    density = points.shape[0] / max(hull_volume, 1.0e-6)

    return ShapeFeatures(
        center=center,
        dimensions_m=np.array([L, W, H]),
        rotation=R_sorted,
        volume_m3=float(hull_volume),
        obb_volume_m3=float(obb_volume),
        surface_area_m2=float(hull_surface),
        sphericity=float(sphericity),
        flatness=float(flatness),
        elongation=float(elongation),
        compactness=float(compactness),
        solidity=solidity,
        point_count=int(points.shape[0]),
        density_per_m3=float(density),
    )

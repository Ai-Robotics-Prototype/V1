"""Robust RANSAC ground-plane extraction.

The identifier pipeline cares more about clean above-ground points than
fast inference, so we run a proper RANSAC with normal filtering rather
than the cheaper "minimum z slab" approach. Falls back to Open3D's
plane segmentation if Open3D is available, otherwise a small in-house
RANSAC implementation.
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

try:
    import open3d as o3d
    OPEN3D_AVAILABLE = True
except Exception:
    o3d = None
    OPEN3D_AVAILABLE = False


def _np_ransac_plane(points: np.ndarray,
                     distance_threshold: float,
                     max_iterations: int,
                     normal_filter: Optional[np.ndarray],
                     normal_tolerance_cos: float,
                     ) -> Tuple[np.ndarray, np.ndarray]:
    """Returns (plane_coeffs (4,), inlier_mask)."""
    n = points.shape[0]
    best_inliers = np.zeros(n, dtype=bool)
    best_coeffs = np.array([0.0, 0.0, 1.0, 0.0])
    if n < 3:
        return best_coeffs, best_inliers
    rng = np.random.default_rng(seed=42)
    for _ in range(max_iterations):
        idx = rng.choice(n, 3, replace=False)
        p1, p2, p3 = points[idx]
        v1 = p2 - p1
        v2 = p3 - p1
        normal = np.cross(v1, v2)
        nrm = np.linalg.norm(normal)
        if nrm < 1e-9:
            continue
        normal = normal / nrm
        if normal_filter is not None:
            if abs(float(np.dot(normal, normal_filter))) < normal_tolerance_cos:
                continue
        d = -float(np.dot(normal, p1))
        dists = np.abs(points @ normal + d)
        inliers = dists <= distance_threshold
        if int(inliers.sum()) > int(best_inliers.sum()):
            best_inliers = inliers
            best_coeffs = np.array([normal[0], normal[1], normal[2], d])
    return best_coeffs, best_inliers


class GroundExtractor:
    def __init__(self,
                 distance_threshold_m: float = 0.015,
                 max_iterations: int = 1000,
                 max_tilt_deg: float = 15.0):
        self.distance_threshold = float(distance_threshold_m)
        self.max_iterations = int(max_iterations)
        self.max_tilt_deg = float(max_tilt_deg)

    def extract(self, points: np.ndarray):
        """Returns (ground_pts, above_pts, plane_coeffs (4,))."""
        if points.shape[0] < 4:
            empty_above = points.copy() if points.size else \
                np.empty((0, 3), dtype=np.float32)
            return (np.empty((0, 3), dtype=np.float32),
                    empty_above,
                    np.array([0.0, 0.0, 1.0, 0.0]))

        normal_filter = np.array([0.0, 0.0, 1.0])
        cos_tol = float(np.cos(np.deg2rad(self.max_tilt_deg)))

        if OPEN3D_AVAILABLE:
            try:
                pcd = o3d.geometry.PointCloud()
                pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
                plane_model, inlier_indices = pcd.segment_plane(
                    distance_threshold=self.distance_threshold,
                    ransac_n=3,
                    num_iterations=self.max_iterations)
                a, b, c, d = plane_model
                normal = np.array([a, b, c], dtype=float)
                normal /= max(np.linalg.norm(normal), 1e-9)
                inlier_mask = np.zeros(points.shape[0], dtype=bool)
                inlier_mask[np.asarray(inlier_indices, dtype=np.int64)] = True
                # If the plane normal isn't roughly +Z, swap to fallback path
                if abs(float(np.dot(normal, normal_filter))) < cos_tol:
                    return self._fallback(points, normal_filter, cos_tol)
                return points[inlier_mask], points[~inlier_mask], np.array([a, b, c, d])
            except Exception as exc:
                logger.warning('Open3D RANSAC failed (%s), falling back', exc)

        return self._fallback(points, normal_filter, cos_tol)

    def _fallback(self, points, normal_filter, cos_tol):
        coeffs, mask = _np_ransac_plane(
            points, self.distance_threshold, self.max_iterations,
            normal_filter=normal_filter,
            normal_tolerance_cos=cos_tol)
        return points[mask], points[~mask], coeffs

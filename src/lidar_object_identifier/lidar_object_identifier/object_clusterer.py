"""Euclidean cluster extraction.

Uses Open3D's DBSCAN when available (it's ~5x faster than scipy's
hierarchy on tens of thousands of points). Falls back to a KD-tree-based
union-find implementation otherwise.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List

import numpy as np

logger = logging.getLogger(__name__)

try:
    import open3d as o3d
    OPEN3D_AVAILABLE = True
except Exception:
    o3d = None
    OPEN3D_AVAILABLE = False


@dataclass
class Cluster:
    points: np.ndarray     # (N, 3) in base_link
    centroid: np.ndarray   # (3,)
    point_count: int


def _cluster_open3d(points: np.ndarray, tolerance: float,
                    min_pts: int) -> List[Cluster]:
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
    # DBSCAN's min_points is the local density threshold (neighbors within
    # eps a point needs to count as a core point). That's a much smaller
    # number than the overall cluster-size filter (min_pts here), which we
    # apply ourselves after the fact. Mixing the two collapses clusters in
    # sparse clouds.
    core_min = max(4, min(min_pts // 5, 20))
    labels = np.asarray(pcd.cluster_dbscan(
        eps=tolerance, min_points=core_min, print_progress=False),
        dtype=np.int64)
    out: List[Cluster] = []
    for label in np.unique(labels):
        if label < 0:
            continue
        idx = labels == label
        pts = points[idx]
        if pts.shape[0] < min_pts:
            continue
        out.append(Cluster(points=pts.copy(),
                           centroid=pts.mean(axis=0),
                           point_count=int(pts.shape[0])))
    return out


def _cluster_scipy(points: np.ndarray, tolerance: float,
                   min_pts: int) -> List[Cluster]:
    """KD-tree neighbour expansion + union-find. O(n log n)."""
    from scipy.spatial import cKDTree
    n = points.shape[0]
    if n == 0:
        return []
    tree = cKDTree(points)
    parent = np.arange(n, dtype=np.int64)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i in range(n):
        # Cap fan-out per point to keep memory bounded on cloud explosions.
        neighbours = tree.query_ball_point(points[i], tolerance)
        ri = find(i)
        for j in neighbours:
            if j == i:
                continue
            rj = find(j)
            if ri != rj:
                parent[rj] = ri
                ri = find(i)

    # Bucket points by root id
    roots = np.array([find(i) for i in range(n)], dtype=np.int64)
    out: List[Cluster] = []
    for label in np.unique(roots):
        idx = roots == label
        pts = points[idx]
        if pts.shape[0] < min_pts:
            continue
        out.append(Cluster(points=pts.copy(),
                           centroid=pts.mean(axis=0),
                           point_count=int(pts.shape[0])))
    return out


class ObjectClusterer:
    def __init__(self,
                 tolerance_m: float = 0.02,
                 min_points: int = 50,
                 max_points: int = 50000,
                 min_volume_m3: float = 1.0e-6,
                 max_volume_m3: float = 2.0,
                 max_aspect_ratio: float = 50.0,
                 min_density_per_m3: float = 100.0):
        self.tolerance = float(tolerance_m)
        self.min_points = int(min_points)
        self.max_points = int(max_points)
        self.min_volume = float(min_volume_m3)
        self.max_volume = float(max_volume_m3)
        self.max_aspect_ratio = float(max_aspect_ratio)
        self.min_density = float(min_density_per_m3)

    def cluster(self, points: np.ndarray) -> List[Cluster]:
        if points.shape[0] == 0:
            return []
        if OPEN3D_AVAILABLE:
            try:
                raw = _cluster_open3d(points, self.tolerance, self.min_points)
            except Exception as exc:
                logger.warning('Open3D DBSCAN failed (%s); using fallback', exc)
                raw = _cluster_scipy(points, self.tolerance, self.min_points)
        else:
            raw = _cluster_scipy(points, self.tolerance, self.min_points)
        return [c for c in raw if self._accept(c)]

    def _accept(self, cluster: Cluster) -> bool:
        if cluster.point_count > self.max_points:
            return False
        extents = cluster.points.ptp(axis=0)
        sorted_ext = np.sort(extents)
        # Volume sanity (treat as OBB-volume proxy: product of extents)
        volume = float(np.prod(np.maximum(extents, 1.0e-4)))
        if volume < self.min_volume or volume > self.max_volume:
            return False
        # Reject "cable / wire" shapes
        if sorted_ext[0] > 0:
            aspect = sorted_ext[-1] / max(sorted_ext[0], 1.0e-4)
            if aspect > self.max_aspect_ratio:
                return False
        density = cluster.point_count / max(volume, 1.0e-6)
        if density < self.min_density:
            return False
        return True

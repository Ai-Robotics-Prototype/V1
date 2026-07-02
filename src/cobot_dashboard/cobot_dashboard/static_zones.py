"""Build the cell's STATIC keep-out zones from its saved baseline cloud.

The baseline (saved by the Setup Wizard at
/opt/cobot/cells/<cell_id>/baseline_cloud.pcd) is the known
empty-of-people cell — benches, fixtures, walls, machines. We
cluster the dense regions of that cloud, wrap each in an OBB, merge
overlapping/adjacent boxes (one bench = one box, not twenty
fragments), inflate by a safety margin, and persist the result as
the cell's static collision map.

We REUSE the live perception primitives — no rewrite:
    lidar_object_identifier.ground_extractor.GroundExtractor
    lidar_object_identifier.object_clusterer.ObjectClusterer
    lidar_object_identifier.shape_analyzer.analyze

Defaults are tuned for the static, downsampled baseline rather than
the live 5 Hz stream:
    cluster_tolerance_m = 0.08   coarser than live 0.02 — we want
                                  benches, not screws
    cluster_min_points  = 30     looser than live 50 — voxel-down
                                  baselines have fewer points per
                                  object
    reach_radius_m      = 1.4    matches collision_monitor.reach_r
    reach_z_max_m       = 2.5    matches collision_monitor.reach_z
    base_self_radius_m  = 0.20   drop points around the robot's own
                                  footprint so we don't enclose the
                                  base column
    base_self_z_max_m   = 0.30   plus a small Z cap so the robot's
                                  base puck isn't a static obstacle
    min_volume_m3       = 0.001  drop tiny fragments (1 L)
    min_point_count     = 60     drop sparse blobs after dedup
    merge_gap_m         = 0.05   merge OBBs whose AABBs are within
                                  5 cm of each other (treat as one
                                  obstacle)
    inflate_margin_m    = 0.05   add 5 cm clearance to each side

Frame: the baseline cloud is in livox_frame, which collision_monitor
and the existing 3D viewer treat as base_link. Static boxes therefore
arrive in the SAME frame as live LiDAR-derived boxes and render
without any extra transform.
"""
from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np

# Hard-import the live perception primitives. If they aren't on the
# Python path the dashboard will fail loudly at module load time —
# which is the right behavior since static zones depend on them.
from lidar_object_identifier.ground_extractor import GroundExtractor
from lidar_object_identifier.object_clusterer import ObjectClusterer
from lidar_object_identifier.shape_analyzer import analyze


# ── Tuning defaults ──────────────────────────────────────────────────
DEFAULTS = {
    # Smaller voxel keeps more points per cluster — important because
    # the saved baseline is already voxel-downsampled (~1 cm) and the
    # cluster body counts are correspondingly lower than on raw LiDAR.
    'voxel_m':              0.02,
    'cluster_tolerance_m':  0.08,
    # Loosened for voxel-downsampled baselines: a typical bench-top
    # fixture only contributes a few dozen voxel-sampled points, so
    # demanding 30 to start a DBSCAN cluster discards real objects.
    'cluster_min_points':   15,
    'reach_radius_m':       1.4,
    'reach_z_max_m':        2.5,
    'base_self_radius_m':   0.20,
    'base_self_z_max_m':    0.30,
    # Was 0.001 (1 L); small real fixtures (e.g. an 11×7×4 cm bracket
    # → ~0.3 L) were being rejected. 0.0001 (0.1 L) still rules out
    # 3-cm-cube noise blobs but keeps useful small obstacles.
    'min_volume_m3':        0.0001,
    # Same reason as cluster_min_points — voxel-down clouds yield fewer
    # points per object. Was 60; 25 still rejects sparse noise but
    # keeps the smaller real fixtures.
    'min_point_count':      25,
    # Merge step DISABLED by default. The previous 5 cm gap chained
    # objects across the workspace; lowering to 0 didn't help because
    # OBB→AABB inflation makes rotated OBBs' axis-aligned bboxes
    # overlap even when the OBBs themselves don't. DBSCAN at
    # cluster_tolerance_m=0.08 already keeps a single physical object
    # as one cluster, so per-cluster boxes are the natural unit —
    # merging only exists to glue fragments that DBSCAN already
    # handles. Set merge_gap_m > 0 to re-enable for special cases.
    'merge_gap_m':         -1.0,
    # Was 0.05; with OBB-rotated boxes (which hug the cluster instead
    # of the inflated AABB) a smaller clearance suffices and the
    # boxes look visually tight in the 3D View.
    'inflate_margin_m':     0.02,
    # Ground filter (passed to GroundExtractor)
    'ground_dist_thresh_m': 0.015,
    'ground_max_tilt_deg':  15.0,
    # Extra cull above the fitted ground plane: RANSAC keeps a thin
    # 1.5 cm band as ground, but residual floor points sit just above
    # it and DBSCAN happily chains them into a workspace-sized sheet.
    # Drop everything within this extra band so the floor stops
    # becoming an "obstacle".
    'ground_clearance_m':   0.03,
    # ── Max-size sanity rejection (per cluster + per merged group) ──
    # Cap a single obstacle at 1.2 m on BOTH horizontal axes. Was
    # 1.8 m to absorb the rotation-induced AABB inflation; now we
    # emit the OBB directly so the dims are TIGHT (the box hugs the
    # cluster), and a real workshop fixture rarely exceeds 1.2 m
    # along both axes. The floor's OBB is still 2 m+ on its long
    # axis so it's caught by this gate.
    'max_obstacle_xy_m':    1.2,
    # Reject clusters whose XY footprint covers more than this
    # fraction of the reach disc area (π·r²). 35 % of 6.16 m² ≈ 2.2 m².
    'max_footprint_frac':   0.35,
    # Reject clusters that are very flat AND large: a wide sheet
    # under 4 cm tall is the floor / a tabletop residue, not an
    # obstacle to plan around.
    'flat_z_max_m':         0.04,
    'flat_xy_min_m':        0.5,
    # ── Contoured-shape extraction (alpha-shape visual + convex hull) ──
    # Per-cluster outlier rejection before contour fitting so a single
    # stray return doesn't blow the alpha-shape open. Statistical
    # outlier removal compares each point's mean neighbour distance to
    # the cluster's distribution.
    'outlier_nb_neighbors': 20,
    'outlier_std_ratio':    2.0,
    # Belt-and-braces percentile clip: drop the extreme ends per axis
    # before hull/alpha so a 1-in-a-thousand return still can't drag
    # the shape out. 2..98 keeps the dense body intact.
    'percentile_clip_low':  2.0,
    'percentile_clip_high': 98.0,
    # Alpha-shape candidate radii (m). We try smallest-first and pick
    # the first that yields a non-empty mesh — small alphas hug tightly
    # but fail on sparse clusters; the cascade keeps the visual tight
    # where the points support it and degrades gracefully otherwise.
    'alpha_candidates_m':   (0.04, 0.06, 0.08, 0.12, 0.18),
    # Cap visual mesh complexity so the tablet's WebGL stays smooth
    # even with a dozen zones. Quadric-decimated after alpha-shape;
    # 250 triangles per zone × 10 zones is ~2.5k tris, trivial for the
    # viewer.
    'visual_max_triangles': 250,
    # Inflate the COLLISION hull by this margin (shift each hull vertex
    # outward along the centroid→vertex ray). Replaces the old box
    # margin; smaller because the hull already hugs tighter than the
    # OBB did.
    'hull_inflate_m':       0.02,
}


# ── PCD loading ──────────────────────────────────────────────────────
def load_pcd_xyz(path: str, voxel_m: float = 0.03) -> np.ndarray:
    """Load a PCD into an (N, 3) float32 array, voxel-downsampled to
    keep clustering fast on a 100 k–500 k point baseline."""
    try:
        import open3d as o3d
    except ImportError as e:
        raise RuntimeError(f'open3d not available: {e}')
    pcd = o3d.io.read_point_cloud(path)
    if voxel_m and voxel_m > 0:
        pcd = pcd.voxel_down_sample(voxel_m)
    pts = np.asarray(pcd.points, dtype=np.float32)
    return pts


# ── Reach + self-filter ──────────────────────────────────────────────
def crop_to_reach(points: np.ndarray, reach_r: float, reach_z: float,
                  ) -> np.ndarray:
    if points.size == 0:
        return points
    r2 = points[:, 0] ** 2 + points[:, 1] ** 2
    keep = (r2 <= (reach_r * reach_r)) & (points[:, 2] <= reach_z)
    return points[keep]


def drop_robot_self(points: np.ndarray, self_r: float, self_z: float,
                    ) -> np.ndarray:
    """Remove points inside the robot's own base footprint cylinder
    so the build doesn't return a box enclosing the robot itself."""
    if points.size == 0:
        return points
    r2 = points[:, 0] ** 2 + points[:, 1] ** 2
    drop = (r2 <= (self_r * self_r)) & (points[:, 2] <= self_z)
    return points[~drop]


# ── OBB → AABB helpers + merge ───────────────────────────────────────
def obb_yaw_quat(rotation: np.ndarray, dims: np.ndarray) -> tuple[float, float, float, float]:
    """Convert an OBB rotation matrix into a yaw-only quaternion
    (rotation about world Z). The 3D viewer's ObjectBox component
    reads `yaw = 2*atan2(q.z, q.w)` so we encode the cluster's
    horizontal orientation in just the z/w components.

    Strategy: pick the rotation column whose XY-plane projection is
    longest (i.e. the most-horizontal body axis); its atan2 gives
    the yaw. Falls back to 0 when the longest body axis is vertical
    (tall thin objects — yaw is then degenerate anyway).
    """
    if rotation is None or rotation.shape != (3, 3):
        return (0.0, 0.0, 0.0, 1.0)
    # Per-column horizontal length, weighted by the column's extent so
    # ties prefer the longer side of the OBB.
    cols = rotation
    horiz = np.sqrt(cols[0, :] ** 2 + cols[1, :] ** 2)
    weighted = horiz * np.asarray(dims, dtype=np.float64)
    j = int(np.argmax(weighted))
    if horiz[j] < 1e-3:
        return (0.0, 0.0, 0.0, 1.0)
    yaw = float(np.arctan2(cols[1, j], cols[0, j]))
    # Yaw quaternion (axis = world Z): (0, 0, sin(y/2), cos(y/2)).
    return (0.0, 0.0, float(np.sin(yaw * 0.5)), float(np.cos(yaw * 0.5)))


def obb_to_aabb(center: np.ndarray, dims: np.ndarray, rotation: np.ndarray,
                ) -> tuple[np.ndarray, np.ndarray]:
    """Worst-case AABB enclosing an OBB. Returns (min, max) each (3,).

    The 8 corner points of the OBB in local frame are ±halfdims; we
    transform them into world frame and take the elementwise extent.
    """
    half = dims * 0.5
    signs = np.array([[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1],
                      [1, -1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1]],
                     dtype=np.float32)
    corners_local = signs * half  # (8, 3)
    corners = corners_local @ rotation.T + center
    return corners.min(axis=0), corners.max(axis=0)


def aabb_gap(a: tuple[np.ndarray, np.ndarray],
             b: tuple[np.ndarray, np.ndarray]) -> float:
    """Min axis-wise gap between two AABBs. Negative when they overlap."""
    a_min, a_max = a
    b_min, b_max = b
    gaps = np.maximum(np.maximum(a_min - b_max, b_min - a_max), 0.0)
    if (a_min <= b_max).all() and (b_min <= a_max).all():
        # Overlapping along all 3 axes
        return -float(np.minimum(a_max - b_min, b_max - a_min).min())
    return float(np.linalg.norm(gaps))


def union_aabb(a: tuple[np.ndarray, np.ndarray],
               b: tuple[np.ndarray, np.ndarray],
               ) -> tuple[np.ndarray, np.ndarray]:
    return np.minimum(a[0], b[0]), np.maximum(a[1], b[1])


def merge_aabbs(aabbs: list[tuple[np.ndarray, np.ndarray]],
                gap_threshold_m: float,
                ) -> list[list[int]]:
    """Union-find merge of AABBs that overlap or are within
    `gap_threshold_m` of each other. Returns groups of source indices.

    A negative `gap_threshold_m` disables merging entirely (one group
    per input) — this is the default for static-baseline zones because
    OBB→AABB inflation chains separate real objects together.
    """
    n = len(aabbs)
    if gap_threshold_m < 0:
        return [[i] for i in range(n)]
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def unite(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for i in range(n):
        for j in range(i + 1, n):
            if aabb_gap(aabbs[i], aabbs[j]) <= gap_threshold_m:
                unite(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


# ── Contoured-shape extraction (alpha-shape + convex hull) ─────────
# Two representations per cluster:
#   • visual_mesh   — concave alpha-shape, tight to the surface, for
#                     the 3D viewer only. Decimated to a poly cap.
#   • collision_hull — convex hull, the primitive MoveIt2/FCL handle
#                     natively and the collision monitor uses for
#                     point-to-mesh distance. Always exists for any
#                     kept cluster (open3d compute_convex_hull is
#                     robust to small/sparse inputs).

def _clean_cluster_points(points: np.ndarray,
                          nb_neighbors: int,
                          std_ratio: float,
                          pct_low: float,
                          pct_high: float) -> np.ndarray:
    """Strip outliers before contour fitting. Without this a stray
    return blows the alpha-shape outward and the contour stops hugging
    the dense mass — the very pathology the user called out."""
    if points.shape[0] < max(8, nb_neighbors):
        return points
    try:
        import open3d as o3d
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
        pcd_clean, _ = pcd.remove_statistical_outlier(
            nb_neighbors=int(nb_neighbors),
            std_ratio=float(std_ratio))
        cleaned = np.asarray(pcd_clean.points, dtype=np.float32)
    except Exception:
        cleaned = points

    if cleaned.shape[0] < 8:
        cleaned = points  # degenerate — fall back to raw

    # Percentile clip per axis as a belt-and-braces second pass; the
    # statistical filter is dense-cluster-tuned, the percentile clip
    # catches anything it lets through.
    if 0.0 < pct_low < pct_high < 100.0 and cleaned.shape[0] >= 32:
        lo = np.percentile(cleaned, pct_low,  axis=0)
        hi = np.percentile(cleaned, pct_high, axis=0)
        mask = np.all((cleaned >= lo) & (cleaned <= hi), axis=1)
        if int(mask.sum()) >= 8:
            cleaned = cleaned[mask]
    return cleaned


def _convex_hull_mesh(points: np.ndarray):
    """Return (vertices Nx3, triangles Mx3) of the convex hull, or
    (None, None) if open3d can't form a hull (e.g. <4 non-coplanar
    points). open3d's hull is robust enough for noisy real clusters."""
    try:
        import open3d as o3d
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
        hull, _ = pcd.compute_convex_hull()
        v = np.asarray(hull.vertices, dtype=np.float32)
        f = np.asarray(hull.triangles, dtype=np.int32)
        if v.shape[0] < 4 or f.shape[0] < 1:
            return None, None
        return v, f
    except Exception:
        return None, None


def _aabb_corner_mesh(points: np.ndarray):
    """Last-ditch hull built from the cluster's AABB corners. Used when
    alpha-shape AND convex hull both fail (e.g. a near-coplanar cluster
    where compute_convex_hull aborts). 8 vertices, 12 triangles — same
    {vertices, triangles} payload shape the viewer expects, so the zone
    renders through ContouredZone with proper wireframe edges instead
    of falling through to the legacy AABB box renderer.

    This is a *guaranteed* mesh: as long as the cluster has at least
    one point, we return a valid box-mesh. A minimum thickness keeps
    a fully-degenerate (single-point or coplanar) cluster from
    collapsing into invisible geometry."""
    if points.shape[0] < 1:
        return None, None
    mn = points.min(axis=0).astype(np.float64)
    mx = points.max(axis=0).astype(np.float64)
    # 1 cm minimum extent per axis so the mesh is always visible even
    # for degenerate (coplanar / collinear / single-point) clusters.
    eps = 0.005
    for i in range(3):
        if mx[i] - mn[i] < 2 * eps:
            mid = 0.5 * (mn[i] + mx[i])
            mn[i] = mid - eps
            mx[i] = mid + eps
    x0, y0, z0 = mn; x1, y1, z1 = mx
    v = np.array([
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ], dtype=np.float32)
    # 12 triangles, outward-facing — matches Three.js BoxGeometry winding.
    f = np.array([
        [0, 3, 2], [0, 2, 1],          # -z (bottom)
        [4, 5, 6], [4, 6, 7],          # +z (top)
        [0, 1, 5], [0, 5, 4],          # -y
        [2, 3, 7], [2, 7, 6],          # +y
        [1, 2, 6], [1, 6, 5],          # +x
        [0, 4, 7], [0, 7, 3],          # -x
    ], dtype=np.int32)
    return v, f


def _alpha_shape_mesh(points: np.ndarray,
                      alpha_candidates: tuple,
                      target_triangles: int):
    """Build a tight concave mesh via alpha-shape. Tries each alpha
    smallest-first, decimates to the poly cap, returns
    (vertices, triangles, alpha_used) or (None, None, None) when every
    alpha yielded an empty mesh — the caller then falls back to the
    convex hull as the visual form."""
    if points.shape[0] < 8:
        return None, None, None
    try:
        import open3d as o3d
    except Exception:
        return None, None, None

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points.astype(np.float64))
    best = None  # (n_tri, alpha, mesh)
    for alpha in alpha_candidates:
        try:
            mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(
                pcd, float(alpha))
        except Exception:
            continue
        # Cheap clean-up before evaluating size.
        try:
            mesh.remove_degenerate_triangles()
            mesh.remove_duplicated_triangles()
            mesh.remove_duplicated_vertices()
            mesh.remove_non_manifold_edges()
        except Exception:
            pass
        n_tri = int(np.asarray(mesh.triangles).shape[0])
        if n_tri <= 0:
            continue
        # First non-empty alpha wins — smallest alpha = tightest contour.
        best = (n_tri, float(alpha), mesh)
        break

    if best is None:
        return None, None, None

    n_tri, alpha_used, mesh = best
    if n_tri > target_triangles:
        try:
            mesh = mesh.simplify_quadric_decimation(
                target_number_of_triangles=int(target_triangles))
        except Exception:
            pass
    v = np.asarray(mesh.vertices, dtype=np.float32)
    f = np.asarray(mesh.triangles, dtype=np.int32)
    if v.shape[0] < 3 or f.shape[0] < 1:
        return None, None, None
    return v, f, alpha_used


def _inflate_hull(vertices: np.ndarray, center: np.ndarray,
                  margin_m: float) -> np.ndarray:
    """Push each hull vertex outward along the centroid→vertex ray by
    `margin_m`. Preserves convexity for convex hulls and is a clean
    stand-in for a true Minkowski sum with a ball at the safety level
    we need here."""
    if margin_m <= 0.0 or vertices.shape[0] == 0:
        return vertices
    d = vertices - center
    n = np.linalg.norm(d, axis=1, keepdims=True)
    n[n < 1e-9] = 1.0
    return (vertices + (d / n) * float(margin_m)).astype(np.float32)


def _bbox_extents(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Center, dimensions, halfdims of the cleaned point cloud's AABB
    (in the world/LiDAR frame). Used for the lightweight cull / label
    primitives even when the persisted shape is a mesh."""
    mn = points.min(axis=0)
    mx = points.max(axis=0)
    return ((mn + mx) * 0.5).astype(np.float32), \
           (mx - mn).astype(np.float32), \
           ((mx - mn) * 0.5).astype(np.float32)


def _mesh_to_payload(vertices: np.ndarray, triangles: np.ndarray
                     ) -> dict[str, list]:
    """Serialize a TriangleMesh-shaped pair for collision_zones.json."""
    return {
        'vertices':  [[float(p[0]), float(p[1]), float(p[2])]
                      for p in vertices],
        'triangles': [[int(t[0]),   int(t[1]),   int(t[2])]
                      for t in triangles],
        'n_vertices':  int(vertices.shape[0]),
        'n_triangles': int(triangles.shape[0]),
    }


def _build_zone_shapes(cluster_points: np.ndarray, p: dict) -> dict:
    """Build the visual concave mesh + the convex collision hull for a
    cleaned point set. Returns a dict with both meshes (any of which
    may be None if construction failed) plus the AABB extents the rest
    of the pipeline still relies on."""
    cleaned = _clean_cluster_points(
        cluster_points,
        nb_neighbors=int(p['outlier_nb_neighbors']),
        std_ratio=float(p['outlier_std_ratio']),
        pct_low=float(p['percentile_clip_low']),
        pct_high=float(p['percentile_clip_high']),
    )

    hull_v, hull_f = _convex_hull_mesh(cleaned)
    center, dims, _ = _bbox_extents(cleaned)
    # Last-ditch hull from AABB corners. A near-coplanar cluster (a
    # thin sheet, a sparse 3-point bundle) makes open3d's convex hull
    # return empty — without this fallback the zone gets persisted
    # with no mesh and the viewer falls through to a plain box. We
    # build the corner-mesh BEFORE inflation so the inflate step
    # operates on the same primitive regardless of which path won.
    hull_used = 'convex_hull'
    if hull_v is None:
        hull_v, hull_f = _aabb_corner_mesh(cleaned)
        hull_used = 'aabb_corners'
    if hull_v is not None and float(p.get('hull_inflate_m', 0.0)) > 0:
        hull_v = _inflate_hull(hull_v, center, float(p['hull_inflate_m']))

    vis_v, vis_f, alpha_used = _alpha_shape_mesh(
        cleaned,
        alpha_candidates=tuple(p['alpha_candidates_m']),
        target_triangles=int(p['visual_max_triangles']),
    )
    if vis_v is None and hull_v is not None:
        # Alpha failed (sparse cluster) — hull (real OR AABB-corners
        # fallback) doubles as the visual mesh so the viewer always
        # gets a contoured ContouredZone, never an unmeshed box.
        vis_v, vis_f, alpha_used = hull_v, hull_f, None

    return {
        'cleaned_points':  cleaned,
        'center':          center,
        'dims':            dims,
        'hull_v':          hull_v,
        'hull_f':          hull_f,
        'hull_source':     hull_used,
        'visual_v':        vis_v,
        'visual_f':        vis_f,
        'alpha_used':      alpha_used,
    }


# ── Main build ───────────────────────────────────────────────────────
def build_zones_from_pcd(pcd_path: str,
                         params: dict[str, float] | None = None,
                         ) -> dict[str, Any]:
    """Run the full pipeline. Returns a dict with the zones list and
    diagnostic counts so the caller can show progress."""
    p = dict(DEFAULTS)
    if params:
        for k, v in params.items():
            if v is not None:
                p[k] = v

    t0 = time.time()
    diag: dict[str, Any] = {'pcd_path': pcd_path, 'params': p}

    if not os.path.isfile(pcd_path):
        raise FileNotFoundError(f'baseline cloud not found: {pcd_path}')

    points = load_pcd_xyz(pcd_path, voxel_m=p['voxel_m'])
    diag['n_after_voxel'] = int(points.shape[0])

    points = crop_to_reach(points, p['reach_radius_m'], p['reach_z_max_m'])
    diag['n_after_reach'] = int(points.shape[0])

    points = drop_robot_self(points, p['base_self_radius_m'], p['base_self_z_max_m'])
    diag['n_after_self_filter'] = int(points.shape[0])

    if points.shape[0] < 50:
        diag['note'] = 'too few points after filtering — nothing to cluster'
        diag['zones'] = []
        diag['elapsed_s'] = time.time() - t0
        return diag

    ge = GroundExtractor(
        distance_threshold_m=p['ground_dist_thresh_m'],
        max_tilt_deg=p['ground_max_tilt_deg'],
    )
    ground, above, coeffs = ge.extract(points)
    diag['n_above_ground'] = int(above.shape[0] if above is not None else 0)
    if above is None or above.shape[0] < 50:
        diag['note'] = 'no above-ground points'
        diag['zones'] = []
        diag['elapsed_s'] = time.time() - t0
        return diag

    # Extra cull above the RANSAC band. The extractor only treats
    # points within `ground_dist_thresh_m` (1.5 cm) of the fitted
    # plane as ground; the band immediately above that often holds
    # the few centimetres of residual floor returns that DBSCAN then
    # chains into a workspace-sized sheet. Drop everything within
    # `ground_clearance_m` of the fitted plane height so the floor
    # genuinely stops contributing to clusters.
    clearance = float(p.get('ground_clearance_m', 0.0))
    if clearance > 0.0:
        # Prefer the fitted plane normal+offset (handles tilted
        # mounts); fall back to ground point z statistics if the
        # extractor didn't return coefficients.
        n_before = int(above.shape[0])
        try:
            if coeffs is not None and len(coeffs) == 4:
                a, b, c, d = (float(coeffs[0]), float(coeffs[1]),
                              float(coeffs[2]), float(coeffs[3]))
                # Plane equation a*x + b*y + c*z + d = 0; signed
                # distance is (a*x+b*y+c*z+d)/||n||. Cull points whose
                # distance above the plane is below the clearance band.
                nrm = float(np.sqrt(a * a + b * b + c * c)) or 1.0
                signed = (above[:, 0] * a + above[:, 1] * b
                          + above[:, 2] * c + d) / nrm
                # Ensure "above" means the same side as the points we
                # already kept (extractor returns above-plane points,
                # so their majority signed-distance sign tells us
                # which side is "up"); cull anything within clearance
                # of the plane on that side.
                side = 1.0 if float(np.median(signed)) >= 0 else -1.0
                keep = (signed * side) > clearance
                above = above[keep]
            elif ground is not None and ground.shape[0] > 0:
                g_top = float(np.percentile(ground[:, 2], 95))
                above = above[above[:, 2] > (g_top + clearance)]
            else:
                above = above[above[:, 2] > clearance]
        except Exception:
            # Defensive: a numeric hiccup mustn't kill the build. Fall
            # back to a simple Z cull from the ground point top.
            if ground is not None and ground.shape[0] > 0:
                g_top = float(np.percentile(ground[:, 2], 95))
                above = above[above[:, 2] > (g_top + clearance)]
        diag['n_after_ground_clearance'] = int(above.shape[0])
        diag['ground_clearance_dropped'] = n_before - int(above.shape[0])
        if above.shape[0] < 50:
            diag['note'] = 'no points left after ground clearance cull'
            diag['zones'] = []
            diag['elapsed_s'] = time.time() - t0
            return diag

    cl = ObjectClusterer(
        tolerance_m=p['cluster_tolerance_m'],
        min_points=p['cluster_min_points'],
    )
    clusters = cl.cluster(above)
    diag['n_clusters_raw'] = len(clusters)

    # Per-cluster OBB + density + sanity-size filter. Drop fragments
    # below volume / point thresholds before merging so we don't pull
    # stray noise into a real obstacle's box. Additionally reject
    # clusters whose OBB is implausibly large for an actual fixture:
    # a 2.8 m-wide "box" inside a 1.4 m reach is the floor or a
    # DBSCAN chain across noise, not an obstacle to plan around.
    max_xy = float(p.get('max_obstacle_xy_m', 0.0))
    reach_area = math.pi * float(p.get('reach_radius_m', 1.4)) ** 2
    max_footprint = float(p.get('max_footprint_frac', 0.0)) * reach_area
    flat_z = float(p.get('flat_z_max_m', 0.0))
    flat_xy_min = float(p.get('flat_xy_min_m', 0.0))
    raw: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for c in clusters:
        ci = {
            'point_count': int(c.point_count),
            'dims': None, 'reason': None,
        }
        if c.point_count < int(p['min_point_count']):
            ci['reason'] = 'min_point_count'
            rejected.append(ci); continue
        try:
            features = analyze(c.points)
        except Exception as fx:
            ci['reason'] = f'analyze_failed:{fx.__class__.__name__}'
            rejected.append(ci); continue
        dims = np.asarray(features.dimensions_m, dtype=np.float32)
        ci['dims'] = [round(float(dims[0]), 3),
                      round(float(dims[1]), 3),
                      round(float(dims[2]), 3)]
        vol = float(np.prod(dims))
        if vol < float(p['min_volume_m3']):
            ci['reason'] = 'min_volume'
            rejected.append(ci); continue
        # Sort dims so [0]=long, [1]=short, [2]=height. Cluster OBB
        # already returns dims sorted descending (shape_analyzer
        # convention), but be defensive.
        ds = sorted([float(dims[0]), float(dims[1]), float(dims[2])], reverse=True)
        # Long horizontal axis too big → almost certainly the floor.
        if max_xy > 0 and ds[0] > max_xy and ds[1] > max_xy:
            ci['reason'] = f'oversize_xy (long={ds[0]:.2f},short={ds[1]:.2f} > {max_xy})'
            rejected.append(ci); continue
        # Footprint area dominates the reach disc → not an obstacle.
        if max_footprint > 0 and (ds[0] * ds[1]) > max_footprint:
            ci['reason'] = (f'footprint {ds[0]*ds[1]:.2f}m² > '
                            f'{max_footprint:.2f}m² ({p["max_footprint_frac"]*100:.0f}% of reach disc)')
            rejected.append(ci); continue
        # Flat + huge → residual floor / tabletop sheet.
        if flat_z > 0 and ds[2] < flat_z and ds[0] > flat_xy_min:
            ci['reason'] = (f'flat_sheet (z={ds[2]:.3f} < {flat_z}, '
                            f'long={ds[0]:.2f} > {flat_xy_min})')
            rejected.append(ci); continue
        center = np.asarray(features.center, dtype=np.float32)
        rotation = np.asarray(features.rotation, dtype=np.float32)
        aabb = obb_to_aabb(center, dims, rotation)
        raw.append({
            'center':       center,
            'dims':         dims,
            'rotation':     rotation,
            'point_count':  int(c.point_count),
            'volume_m3':    vol,
            'density':      float(c.point_count / max(vol, 1e-9)),
            'aabb':         aabb,
            # Keep the raw cluster points — we re-fit the contour/hull
            # on these (possibly combined with siblings if a merge
            # group spans multiple clusters), which is the right way
            # to get a clean single mesh instead of gluing per-cluster
            # meshes geometrically.
            'points':       np.asarray(c.points, dtype=np.float32),
        })
    diag['n_clusters_kept'] = len(raw)
    diag['n_clusters_rejected'] = len(rejected)
    diag['rejected'] = rejected[:32]  # cap to keep diag readable

    # Merge overlapping / near-touching boxes into one obstacle.
    groups = merge_aabbs([r['aabb'] for r in raw], gap_threshold_m=float(p['merge_gap_m']))
    diag['n_merged_groups'] = len(groups)

    # Emit one keep-out zone per group. Each zone now carries:
    #   • collision_hull — convex hull of the (merged) cleaned points,
    #     inflated by hull_inflate_m. Tighter than the OBB box ever
    #     was and the form MoveIt2/FCL handle natively.
    #   • visual_mesh    — concave alpha-shape that hugs the surface,
    #     decimated to the poly cap for the 3D viewer.
    # The legacy center/dimensions/orientation are kept too so older
    # consumers (and the AABB pre-filter in collision_monitor) still
    # work without a schema migration; new consumers prefer the hull.
    margin = float(p['inflate_margin_m'])
    zones: list[dict[str, Any]] = []
    merged_rejected: list[dict[str, Any]] = []
    for gi, idxs in enumerate(groups):
        # Combine source points across all clusters in the group, then
        # re-fit hull + alpha-shape on the COMBINED cloud. This is the
        # right way to merge — don't union per-cluster meshes
        # geometrically (which leaves visible seams and breaks
        # convexity); always re-fit.
        combined = np.concatenate([raw[i]['points'] for i in idxs], axis=0)
        shapes = _build_zone_shapes(combined, p)
        center_arr   = shapes['center']
        bbox_dims    = shapes['dims']
        hull_v       = shapes['hull_v']
        hull_f       = shapes['hull_f']
        hull_source  = shapes.get('hull_source', 'convex_hull')
        visual_v     = shapes['visual_v']
        visual_f     = shapes['visual_f']
        alpha_used   = shapes['alpha_used']

        # OBB orientation is meaningful for a single-cluster group;
        # for merged groups we drop to identity (the hull captures
        # the real shape — the AABB is just a label primitive now).
        if len(idxs) == 1:
            r = raw[idxs[0]]
            qx, qy, qz, qw = obb_yaw_quat(r['rotation'], r['dims'])
        else:
            qx, qy, qz, qw = (0.0, 0.0, 0.0, 1.0)

        # Sanity guard on the hull/AABB dims (same intent as before:
        # never re-introduce the floor box). The contour shouldn't
        # make those guards looser — apply them to the AABB of the
        # cleaned-+-inflated hull, which is the tightest world-frame
        # envelope of what we're about to emit.
        if hull_v is not None and hull_v.shape[0] >= 4:
            envelope_min = hull_v.min(axis=0)
            envelope_max = hull_v.max(axis=0)
            env_dims = (envelope_max - envelope_min).astype(np.float64)
        else:
            env_dims = np.asarray(bbox_dims, dtype=np.float64) + (2.0 * margin)
        ds_sorted = sorted(env_dims.tolist(), reverse=True)
        rej_reason = None
        if max_xy > 0 and ds_sorted[0] > max_xy and ds_sorted[1] > max_xy:
            rej_reason = (f'hull_oversize_xy '
                          f'(long={ds_sorted[0]:.2f},short={ds_sorted[1]:.2f} > {max_xy})')
        elif max_footprint > 0 and (ds_sorted[0] * ds_sorted[1]) > max_footprint:
            rej_reason = (f'hull_footprint {ds_sorted[0]*ds_sorted[1]:.2f}m² > '
                          f'{max_footprint:.2f}m²')
        elif flat_z > 0 and ds_sorted[2] < flat_z and ds_sorted[0] > flat_xy_min:
            rej_reason = (f'hull_flat_sheet (z={ds_sorted[2]:.3f},'
                          f' long={ds_sorted[0]:.2f})')
        if rej_reason is not None:
            merged_rejected.append({
                'group_index': gi,
                'cluster_count': len(idxs),
                'dims': [round(float(env_dims[0]), 3),
                         round(float(env_dims[1]), 3),
                         round(float(env_dims[2]), 3)],
                'reason': rej_reason,
            })
            continue

        total_points = int(combined.shape[0])
        # The legacy dims field reports the (inflated) hull's AABB
        # envelope so older consumers see a tight box; if no hull was
        # produced fall back to the bbox of the cleaned cluster.
        leg_dims = env_dims
        total_vol = float(np.prod(np.maximum(leg_dims, 1e-6)))

        zone: dict[str, Any] = {
            'id':           f'static_{gi:03d}',
            'name':         f'static_obstacle_{gi + 1}',
            'source':       'baseline_static',
            'center':       {'x': float(center_arr[0]),
                             'y': float(center_arr[1]),
                             'z': float(center_arr[2])},
            'dimensions':   {'x': float(leg_dims[0]),
                             'y': float(leg_dims[1]),
                             'z': float(leg_dims[2])},
            'orientation':  {'x': qx, 'y': qy, 'z': qz, 'w': qw},
            'point_count':  total_points,
            'density':      float(total_points / max(total_vol, 1e-9)),
            'cluster_count': len(idxs),
            'margin_m':     margin,
            # Tag the *primary* shape so older / new viewers can branch.
            'shape':        ('mesh' if visual_v is not None else
                             ('obb' if len(idxs) == 1 else 'aabb')),
        }
        # Invariant: EVERY emitted zone ships at least a collision_hull
        # AND a visual_mesh. _build_zone_shapes guarantees this via the
        # AABB-corners fallback when both alpha-shape AND open3d's
        # convex hull fail. The branch below stays guarded so a future
        # refactor that returns None on a degenerate cluster still
        # produces a renderable mesh instead of silently dropping back
        # to the FE's box renderer.
        if hull_v is None or hull_f is None:
            hull_v, hull_f = _aabb_corner_mesh(combined)
            hull_source = 'aabb_corners'
        if hull_v is not None and hull_f is not None:
            zone['collision_hull'] = _mesh_to_payload(hull_v, hull_f)
            zone['collision_hull']['margin_m'] = float(p.get('hull_inflate_m', 0.0))
            zone['collision_hull']['source']   = hull_source
        if visual_v is None or visual_f is None:
            visual_v, visual_f = hull_v, hull_f
            alpha_used = None
        if visual_v is not None and visual_f is not None:
            zone['visual_mesh'] = _mesh_to_payload(visual_v, visual_f)
            zone['visual_mesh']['alpha_m'] = alpha_used
            zone['visual_mesh']['decimated_to'] = int(p['visual_max_triangles'])
            zone['visual_mesh']['source'] = (
                'alpha_shape' if alpha_used is not None else hull_source)
        # Reflect what's actually shipped on the zone-level shape tag.
        zone['shape'] = 'mesh' if zone.get('visual_mesh') else zone['shape']
        zones.append(zone)
    diag['n_merged_rejected'] = len(merged_rejected)
    diag['merged_rejected'] = merged_rejected[:16]

    # Sort largest first — UX nicety so the biggest obstacles show up
    # first in lists / debugging output.
    zones.sort(key=lambda z: z['dimensions']['x'] * z['dimensions']['y'] * z['dimensions']['z'],
               reverse=True)

    diag['zones'] = zones
    diag['n_zones'] = len(zones)
    diag['elapsed_s'] = time.time() - t0
    diag['built_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    return diag


# ── Per-cell save / load ────────────────────────────────────────────
_CELLS_DIR = '/opt/cobot/cells'


def _cell_dir(cell_id: str) -> str:
    return os.path.join(_CELLS_DIR, cell_id)


def baseline_pcd_path(cell_id: str) -> str:
    return os.path.join(_cell_dir(cell_id), 'baseline_cloud.pcd')


def zones_json_path(cell_id: str) -> str:
    return os.path.join(_cell_dir(cell_id), 'collision_zones.json')


def moveit_scene_path(cell_id: str) -> str:
    return os.path.join(_cell_dir(cell_id), 'planning_scene_collision_objects.json')


def save_zones(cell_id: str, build_result: dict[str, Any]) -> None:
    """Persist the build result + a MoveIt2 PlanningScene-shaped
    sidecar. The MoveIt2 file is forward-looking — MoveIt2 isn't
    wired yet (URDF pending) — so the file lets a future planner
    ingest the obstacle set without re-running this build."""
    cell_dir = _cell_dir(cell_id)
    os.makedirs(cell_dir, exist_ok=True)
    out = {
        'cell_id':  cell_id,
        'built_at': build_result.get('built_at'),
        'params':   build_result.get('params'),
        'n_zones':  build_result.get('n_zones', 0),
        'diag':     {k: v for k, v in build_result.items()
                     if k not in ('zones', 'params')},
        'zones':    build_result.get('zones', []),
    }
    with open(zones_json_path(cell_id), 'w') as f:
        json.dump(out, f, indent=2)

    # MoveIt2 PlanningScene-compatible export. We now emit each zone's
    # CONVEX HULL as a moveit_msgs/CollisionObject mesh (vertices +
    # triangles) — much tighter than the old BOX primitive and a form
    # MoveIt2/FCL handle natively. When no hull was produced (degenerate
    # cluster), fall back to a BOX primitive on the legacy dims so the
    # zone still ends up in the planning scene rather than vanishing.
    def _co_for(z: dict[str, Any]) -> dict[str, Any]:
        hull = z.get('collision_hull') or {}
        verts = hull.get('vertices') or []
        tris  = hull.get('triangles') or []
        if verts and tris:
            return {
                'id':         z['id'],
                'header':     {'frame_id': 'base_link'},
                'meshes': [{
                    'vertices':  verts,
                    'triangles': tris,
                }],
                # Mesh vertices are already in the world (base_link)
                # frame; pose = identity so MoveIt2 doesn't transform
                # them a second time.
                'mesh_poses': [{
                    'position':    {'x': 0.0, 'y': 0.0, 'z': 0.0},
                    'orientation': {'x': 0.0, 'y': 0.0, 'z': 0.0, 'w': 1.0},
                }],
                'operation':  'ADD',
            }
        # Legacy box fallback for zones with no hull.
        return {
            'id':         z['id'],
            'header':     {'frame_id': 'base_link'},
            'primitives': [{
                'type':       'BOX',
                'dimensions': [z['dimensions']['x'],
                               z['dimensions']['y'],
                               z['dimensions']['z']],
            }],
            'primitive_poses': [{
                'position':    z['center'],
                'orientation': z['orientation'],
            }],
            'operation':  'ADD',
        }
    scene = {
        'frame_id':         'base_link',
        'cell_id':          cell_id,
        'collision_objects': [_co_for(z) for z in build_result.get('zones', [])],
    }
    with open(moveit_scene_path(cell_id), 'w') as f:
        json.dump(scene, f, indent=2)


def load_zones(cell_id: str) -> dict[str, Any] | None:
    path = zones_json_path(cell_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def clear_zones(cell_id: str) -> bool:
    """Remove the persisted static zones for a cell. Returns True if
    anything was deleted, False if nothing existed."""
    removed = False
    for fn in (zones_json_path(cell_id), moveit_scene_path(cell_id)):
        if os.path.isfile(fn):
            try:
                os.remove(fn)
                removed = True
            except OSError:
                pass
    return removed

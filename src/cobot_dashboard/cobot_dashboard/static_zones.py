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
    'voxel_m':              0.03,
    'cluster_tolerance_m':  0.08,
    'cluster_min_points':   30,
    'reach_radius_m':       1.4,
    'reach_z_max_m':        2.5,
    'base_self_radius_m':   0.20,
    'base_self_z_max_m':    0.30,
    'min_volume_m3':        0.001,
    'min_point_count':      60,
    'merge_gap_m':          0.05,
    'inflate_margin_m':     0.05,
    # Ground filter (passed to GroundExtractor)
    'ground_dist_thresh_m': 0.015,
    'ground_max_tilt_deg':  15.0,
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
    `gap_threshold_m` of each other. Returns groups of source indices."""
    n = len(aabbs)
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
    _ground, above, _coeffs = ge.extract(points)
    diag['n_above_ground'] = int(above.shape[0] if above is not None else 0)
    if above is None or above.shape[0] < 50:
        diag['note'] = 'no above-ground points'
        diag['zones'] = []
        diag['elapsed_s'] = time.time() - t0
        return diag

    cl = ObjectClusterer(
        tolerance_m=p['cluster_tolerance_m'],
        min_points=p['cluster_min_points'],
    )
    clusters = cl.cluster(above)
    diag['n_clusters_raw'] = len(clusters)

    # Per-cluster OBB + density filter. Drop fragments below volume /
    # point thresholds before merging so we don't pull stray noise
    # into a real obstacle's box.
    raw: list[dict[str, Any]] = []
    for c in clusters:
        if c.point_count < int(p['min_point_count']):
            continue
        try:
            features = analyze(c.points)
        except Exception:
            continue
        dims = np.asarray(features.dimensions_m, dtype=np.float32)
        vol = float(np.prod(dims))
        if vol < float(p['min_volume_m3']):
            continue
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
        })
    diag['n_clusters_kept'] = len(raw)

    # Merge overlapping / near-touching boxes into one obstacle.
    groups = merge_aabbs([r['aabb'] for r in raw], gap_threshold_m=float(p['merge_gap_m']))
    diag['n_merged_groups'] = len(groups)

    # For each merged group emit a single AXIS-ALIGNED keep-out box.
    # We deliberately drop the OBB rotation in the persistent output
    # because (a) the existing collision_monitor capsule-vs-AABB check
    # operates on axis-aligned boxes, and (b) merging arbitrary
    # rotations would otherwise need a Minkowski hull. The 3D viewer
    # supports rotation in the per-object payload, so single-cluster
    # groups still get their OBB yaw if you want it — for now we keep
    # everything AABB for consistency with the live collision pipeline.
    margin = float(p['inflate_margin_m'])
    zones: list[dict[str, Any]] = []
    for gi, idxs in enumerate(groups):
        a_min = np.minimum.reduce([raw[i]['aabb'][0] for i in idxs])
        a_max = np.maximum.reduce([raw[i]['aabb'][1] for i in idxs])
        a_min = a_min - margin
        a_max = a_max + margin
        center = ((a_min + a_max) * 0.5).tolist()
        dims = (a_max - a_min).tolist()
        total_points = sum(raw[i]['point_count'] for i in idxs)
        total_vol = float(dims[0] * dims[1] * dims[2])
        zones.append({
            'id':           f'static_{gi:03d}',
            'name':         f'static_obstacle_{gi + 1}',
            'source':       'baseline_static',
            'center':       {'x': float(center[0]), 'y': float(center[1]), 'z': float(center[2])},
            'dimensions':   {'x': float(dims[0]),   'y': float(dims[1]),   'z': float(dims[2])},
            # AABB → identity quaternion. Kept on the payload so the
            # frontend's existing ObjectBox component renders it without
            # branching on whether 'orientation' is present.
            'orientation':  {'x': 0.0, 'y': 0.0, 'z': 0.0, 'w': 1.0},
            'point_count':  int(total_points),
            'density':      float(total_points / max(total_vol, 1e-9)),
            'cluster_count': len(idxs),
            'margin_m':     margin,
        })

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

    # MoveIt2 PlanningScene-compatible export. Each obstacle is a
    # single primitive BOX with an identity quaternion (AABB),
    # encoded close to a moveit_msgs/CollisionObject shape so the
    # future planning_scene loader doesn't need this dashboard's
    # internal schema.
    scene = {
        'frame_id':         'base_link',
        'cell_id':          cell_id,
        'collision_objects': [
            {
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
            for z in build_result.get('zones', [])
        ],
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

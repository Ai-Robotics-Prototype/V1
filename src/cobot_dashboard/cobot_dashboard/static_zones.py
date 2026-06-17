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
    'inflate_margin_m':     0.05,
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
    # The floor / DBSCAN-chained-noise box that originally appeared
    # was ~3 m on a side — well above any real workshop fixture
    # inside a 1.4 m reach. Cap a single obstacle at 1.8 m on BOTH
    # horizontal axes: that still rejects the 2.6-3 m floor chain
    # but allows realistic benches and machine housings.
    'max_obstacle_xy_m':    1.8,
    # Reject clusters whose XY footprint covers more than this
    # fraction of the reach disc area (π·r²). 55 % of 6.16 m² ≈ 3.4 m².
    # The floor's footprint (~8 m²) is comfortably above; a real
    # 1.5 m bench (~2.25 m²) is below.
    'max_footprint_frac':   0.55,
    # Reject clusters that are very flat AND large: a wide sheet
    # under 4 cm tall is the floor / a tabletop residue, not an
    # obstacle to plan around.
    'flat_z_max_m':         0.04,
    'flat_xy_min_m':        0.5,
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
        })
    diag['n_clusters_kept'] = len(raw)
    diag['n_clusters_rejected'] = len(rejected)
    diag['rejected'] = rejected[:32]  # cap to keep diag readable

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
    merged_rejected: list[dict[str, Any]] = []
    for gi, idxs in enumerate(groups):
        a_min = np.minimum.reduce([raw[i]['aabb'][0] for i in idxs])
        a_max = np.maximum.reduce([raw[i]['aabb'][1] for i in idxs])
        a_min = a_min - margin
        a_max = a_max + margin
        center = ((a_min + a_max) * 0.5).tolist()
        dims = (a_max - a_min).tolist()
        # Post-merge guard: an individual cluster passed the per-
        # cluster sanity checks, but the merge step can still
        # balloon a group across the workspace if neighboring
        # clusters happen to sit within `merge_gap_m`. Re-apply the
        # same XY / footprint limits so a ballooned merge gets
        # dropped instead of dominating the scene.
        ds_sorted = sorted([float(dims[0]), float(dims[1]), float(dims[2])], reverse=True)
        rej_reason = None
        if max_xy > 0 and ds_sorted[0] > max_xy and ds_sorted[1] > max_xy:
            rej_reason = (f'merged_oversize_xy '
                          f'(long={ds_sorted[0]:.2f},short={ds_sorted[1]:.2f} > {max_xy})')
        elif max_footprint > 0 and (ds_sorted[0] * ds_sorted[1]) > max_footprint:
            rej_reason = (f'merged_footprint {ds_sorted[0]*ds_sorted[1]:.2f}m² > '
                          f'{max_footprint:.2f}m²')
        elif flat_z > 0 and ds_sorted[2] < flat_z and ds_sorted[0] > flat_xy_min:
            rej_reason = (f'merged_flat_sheet (z={ds_sorted[2]:.3f},'
                          f' long={ds_sorted[0]:.2f})')
        if rej_reason is not None:
            merged_rejected.append({
                'group_index': gi,
                'cluster_count': len(idxs),
                'dims': [round(float(dims[0]), 3),
                         round(float(dims[1]), 3),
                         round(float(dims[2]), 3)],
                'reason': rej_reason,
            })
            continue
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

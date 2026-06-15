"""Synthetic scene generator for the recognition benchmark.

Renders labeled point-cloud scenes that approximate what the MotionCam-3D
Color S+ will see looking down into a bin of CAD-known parts. Each scene
carries 6DoF ground truth, so we can validate the recognition pipeline
(PPF + ICP, FoundationPose, Locator, …) end-to-end before the camera
physically arrives.

What this is for:
    - Drive RoboAi's own recognition stack against a perfect-truth baseline
    - Quantify identity vs. confused-part rates (L24 vs L28 etc.)
    - Be the harness PPF+ICP / FoundationPose / Locator all plug into

What this is NOT:
    - A replacement for real MotionCam data. The noise model approximates
      the camera but does not replicate it — specular dropouts on real
      aluminium in particular don't have a clean parametric form. Use this
      to prove the pipeline is CORRECT; use real data to prove it is ROBUST.
      DO NOT over-tune noise parameters against the synthetic distribution.

Inputs:
    - CAD models: prefers /opt/cobot/parts/models/<id>/model_cloud.ply if
      cad_model_builder has run; otherwise samples the part's STEP/STL from
      step_parser via trimesh.

Outputs (per scene under /opt/cobot/synthetic_scenes/<scene_id>/):
    scene_cloud.ply      points + normals (Open3D PLY)
    ground_truth.json    list of {instance_id, part_id, pose_6dof,
                                  is_pickable, visible_point_fraction}
    scene_meta.json      camera pose, RNG seed, config snapshot
    render_preview.png   matplotlib 3D scatter (eyeball check)
    confidence.npy       per-point synthetic confidence (mm-like)
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# Open3D imports are heavy — keep them inside the module but tolerate missing
# rendering deps in headless setups.
import open3d as o3d
import trimesh

try:
    import matplotlib
    matplotlib.use("Agg")          # never try to attach a display
    import matplotlib.pyplot as _plt
    from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
    _MPL_OK = True
except Exception:
    _MPL_OK = False


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PARTS_DIR        = Path("/opt/cobot/parts")
PARTS_MODELS_DIR = PARTS_DIR / "models"
PARTS_STEP_DIR   = PARTS_DIR / "step"
PARTS_STL_DIR    = PARTS_DIR / "stl"
SCENES_DIR       = Path("/opt/cobot/synthetic_scenes")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class SensorConfig:
    """Approximates the MotionCam-3D Color S+ datasheet.

    Honest note: these numbers are PLAUSIBLE not measured. Real specular
    behavior on aluminium and the camera's actual noise distribution will
    differ. Tune against the real cloud once the camera lands.
    """
    # Sweet-spot scanning distance from datasheet.
    camera_distance_m: float = 0.907
    # Point spacing on the table in metres (datasheet ~0.52 mm at sweet spot).
    point_spacing_m: float = 0.0006
    # Per-axis gaussian noise (metres) applied after HPR.
    depth_noise_sigma_m: float = 0.00015     # ~0.15 mm temporal noise
    # Random per-point dropout fraction (simulates specular holes).
    dropout_p: float = 0.03
    # Probability of an outlier "flying pixel" per point (at depth edges).
    outlier_p: float = 0.002
    outlier_jitter_m: float = 0.020          # how far a flier strays in Z
    # Confidence model: best near 1.0, degrades at grazing angles.
    confidence_grazing_floor: float = 0.10
    # Approximate per-square-metre table-plane sample density (points/m²).
    table_density_per_m2: float = 700_000.0


@dataclass
class BinConfig:
    """A flat rectangular bin volume parts get scattered into."""
    width_m: float = 0.20       # X extent
    depth_m: float = 0.15       # Y extent
    height_m: float = 0.05      # Z extent above the table plane
    table_extra_m: float = 0.04 # extra table-plane visible around the bin
    table_z_m: float = 0.0      # z of the table-top in world frame


@dataclass
class SceneConfig:
    part_ids: List[str] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=dict)
    bin: BinConfig = field(default_factory=BinConfig)
    sensor: SensorConfig = field(default_factory=SensorConfig)
    allow_overlap: bool = False    # parts may touch / collide (loose stacking)
    clutter_level: float = 0.0     # 0–1, scales noise + extra dropout
    pickable_face: str = "z+"      # local axis pointing up on a "pickable" pose
    pickable_tolerance_deg: float = 25.0
    seed: Optional[int] = None
    # Cap so the scene cloud stays browser-renderable / benchmark-fast.
    max_scene_points: int = 200_000


# ---------------------------------------------------------------------------
# Part model loading
# ---------------------------------------------------------------------------

@dataclass
class _PartModel:
    part_id: str
    name: str
    # Centered point cloud (N, 3) in metres + per-point unit normals (N, 3).
    points: np.ndarray
    normals: np.ndarray
    extents_m: np.ndarray
    # Surface area drives how many points to draw per instance.
    surface_area_m2: float
    source: str       # "model_cloud" | "step" | "stl"


def _load_part_model(part_id: str, target_spacing_m: float) -> _PartModel:
    """Resolve a part to a centered point cloud + normals.

    Resolution order:
        /opt/cobot/parts/models/<id>/model_cloud.ply  (cad_model_builder output)
        /opt/cobot/parts/step/<source_file>
        /opt/cobot/parts/stl/<stl_file>
    """
    meta_path = PARTS_DIR / "metadata" / f"{part_id}.json"
    if not meta_path.is_file():
        raise FileNotFoundError(f"No metadata for part {part_id}")
    meta = json.loads(meta_path.read_text())
    name = meta.get("name", part_id)

    # 1) cad_model_builder output — preferred when present.
    model_ply = PARTS_MODELS_DIR / part_id / "model_cloud.ply"
    if model_ply.is_file():
        pc = o3d.io.read_point_cloud(str(model_ply))
        if len(pc.points) > 0:
            pts = np.asarray(pc.points, dtype=np.float64)
            normals = np.asarray(pc.normals, dtype=np.float64) if pc.has_normals() else None
            return _finalize_part_model(part_id, name, pts, normals,
                                        source="model_cloud")

    # 2) STEP via trimesh.
    src_file = meta.get("source_file", "")
    step_path = PARTS_STEP_DIR / src_file if src_file else None
    mesh = None
    if step_path and step_path.is_file():
        try:
            mesh = trimesh.load(str(step_path), force="mesh")
            if isinstance(mesh, trimesh.Scene):
                mesh = mesh.dump(concatenate=True)
        except Exception:
            mesh = None

    # 3) STL fallback.
    if mesh is None or len(mesh.vertices) == 0:
        stl_file = meta.get("stl_file", "")
        stl_path = PARTS_STL_DIR / stl_file if stl_file else None
        if not (stl_path and stl_path.is_file()):
            raise FileNotFoundError(
                f"No model_cloud, STEP, or STL for part {part_id} ({name})")
        mesh = trimesh.load(str(stl_path), force="mesh")
        if isinstance(mesh, trimesh.Scene):
            mesh = mesh.dump(concatenate=True)
        source = "stl"
    else:
        source = "step"

    if mesh is None or len(mesh.vertices) == 0:
        raise ValueError(f"Empty mesh for part {part_id}")

    # CAD files are usually mm — match step_parser's rescale heuristic.
    extents_mm = mesh.bounding_box.extents
    if float(max(extents_mm)) > 10.0:
        mesh.apply_scale(0.001)

    # Sample roughly proportional to surface area, capped so we never
    # produce a wasteful 100k-point part. Target the model spacing so
    # the scene's effective resolution matches the sensor config.
    area = float(mesh.area)
    target_n = int(np.clip(area / (target_spacing_m ** 2), 800, 8000))
    om = o3d.geometry.TriangleMesh()
    om.vertices  = o3d.utility.Vector3dVector(np.asarray(mesh.vertices,
                                                        dtype=np.float64))
    om.triangles = o3d.utility.Vector3iVector(np.asarray(mesh.faces,
                                                        dtype=np.int32))
    om.compute_vertex_normals()
    sampled = om.sample_points_uniformly(number_of_points=target_n)
    sampled.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(
            radius=max(0.002, target_spacing_m * 6),
            max_nn=30))
    pts = np.asarray(sampled.points, dtype=np.float64)
    nrm = np.asarray(sampled.normals, dtype=np.float64)
    return _finalize_part_model(part_id, name, pts, nrm, source=source)


def _finalize_part_model(part_id, name, pts, normals, source) -> _PartModel:
    if normals is None or normals.shape != pts.shape:
        # Fall back to a degenerate up-normal; better than nothing for the
        # outlier-only edge case.
        normals = np.tile([0, 0, 1.0], (len(pts), 1))
    centroid = pts.mean(axis=0)
    pts = pts - centroid
    extents = pts.max(axis=0) - pts.min(axis=0)
    # Recompute "surface area" via the bounding-box diagonal as a proxy
    # when we don't have the mesh anymore — only used for sample-count.
    area = float(np.linalg.norm(extents)) ** 2 / 2.0
    return _PartModel(
        part_id=part_id, name=name,
        points=pts.astype(np.float64),
        normals=normals.astype(np.float64),
        extents_m=extents.astype(np.float64),
        surface_area_m2=area,
        source=source,
    )


# ---------------------------------------------------------------------------
# Pose helpers
# ---------------------------------------------------------------------------

def _random_rotation(rng: random.Random, *, allow_flip: bool = True) -> np.ndarray:
    """Random 3x3 rotation. Always randomises yaw; with allow_flip, also
    samples random tilt/flip so the scene contains both pickable and
    non-pickable orientations (essential for orientation discrimination)."""
    yaw   = rng.uniform(-math.pi, math.pi)
    if allow_flip:
        # Uniform random axis + angle in [0, π] gives reasonably-uniform SO(3)
        # without depending on scipy.
        axis = np.array([rng.gauss(0, 1) for _ in range(3)])
        n = np.linalg.norm(axis)
        if n < 1e-9:
            axis = np.array([0, 0, 1.0])
        axis = axis / n
        angle = rng.uniform(0, math.pi)
        return _rodrigues(axis, angle)
    return _rotation_z(yaw)


def _rotation_z(yaw: float) -> np.ndarray:
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def _rodrigues(axis: np.ndarray, angle: float) -> np.ndarray:
    ax = axis / max(np.linalg.norm(axis), 1e-12)
    K = np.array([[0, -ax[2], ax[1]],
                  [ax[2], 0, -ax[0]],
                  [-ax[1], ax[0], 0.0]])
    return np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * (K @ K)


def _quat_from_R(R: np.ndarray) -> Tuple[float, float, float, float]:
    """Return (x, y, z, w). Robust branch — picks the largest diagonal."""
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0:
        S = math.sqrt(tr + 1.0) * 2
        qw = 0.25 * S
        qx = (R[2, 1] - R[1, 2]) / S
        qy = (R[0, 2] - R[2, 0]) / S
        qz = (R[1, 0] - R[0, 1]) / S
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        S = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        qw = (R[2, 1] - R[1, 2]) / S
        qx = 0.25 * S
        qy = (R[0, 1] + R[1, 0]) / S
        qz = (R[0, 2] + R[2, 0]) / S
    elif R[1, 1] > R[2, 2]:
        S = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        qw = (R[0, 2] - R[2, 0]) / S
        qx = (R[0, 1] + R[1, 0]) / S
        qy = 0.25 * S
        qz = (R[1, 2] + R[2, 1]) / S
    else:
        S = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        qw = (R[1, 0] - R[0, 1]) / S
        qx = (R[0, 2] + R[2, 0]) / S
        qy = (R[1, 2] + R[2, 1]) / S
        qz = 0.25 * S
    return float(qx), float(qy), float(qz), float(qw)


# ---------------------------------------------------------------------------
# Scene dataclass
# ---------------------------------------------------------------------------

@dataclass
class PlacedInstance:
    instance_id: int
    part_id: str
    part_name: str
    R: np.ndarray
    t: np.ndarray
    is_pickable: bool
    placed_points: int          # before HPR
    visible_points: int         # after HPR
    extents_m: np.ndarray
    source: str

    def visible_fraction(self) -> float:
        if self.placed_points <= 0:
            return 0.0
        return float(self.visible_points) / float(self.placed_points)

    def pose_dict(self) -> Dict[str, Any]:
        qx, qy, qz, qw = _quat_from_R(self.R)
        return {
            "position":    {"x": float(self.t[0]),
                             "y": float(self.t[1]),
                             "z": float(self.t[2])},
            "orientation": {"x": qx, "y": qy, "z": qz, "w": qw},
            "matrix": self.R.tolist(),
        }


@dataclass
class SyntheticScene:
    scene_id: str
    points: np.ndarray            # (N, 3) float32 metres
    normals: np.ndarray           # (N, 3) float32
    confidence: np.ndarray        # (N,) float32 mm-like (higher = better)
    instances: List[PlacedInstance]
    camera_position: np.ndarray   # (3,) world frame
    config: SceneConfig
    saved_dir: Optional[Path] = None


# ---------------------------------------------------------------------------
# Core generator
# ---------------------------------------------------------------------------

def generate_scene(config: SceneConfig,
                   scenes_dir: Optional[Path] = None,
                   scene_id: Optional[str] = None) -> SyntheticScene:
    """Build one scene from `config`. Persists under `scenes_dir` if given."""
    rng = random.Random(config.seed if config.seed is not None else time.time_ns())
    seed_used = config.seed if config.seed is not None else rng.randrange(2**32)
    rng_np = np.random.default_rng(seed_used)

    scene_id = scene_id or f"scene_{uuid.uuid4().hex[:10]}"

    # 1. Bin + table plane (the dominant surface).
    table_pts, table_nrm, table_conf = _table_plane(config, rng_np)

    # 2. Place each part instance with a random 6DoF pose inside the bin.
    instances: List[PlacedInstance] = []
    placed_clouds: List[np.ndarray] = []
    placed_normals: List[np.ndarray] = []
    placed_inst_ids: List[int] = []

    occupied_xy_radii: List[Tuple[float, float, float]] = []
    next_iid = 1

    for part_id in config.part_ids:
        n = int(config.counts.get(part_id, 1))
        try:
            model = _load_part_model(part_id, config.sensor.point_spacing_m)
        except Exception as e:
            print(f"[scene_gen] skip {part_id}: {e}", file=sys.stderr)
            continue

        for _ in range(n):
            R = _random_rotation(rng, allow_flip=True)
            # Choose translation inside the bin. Place the part's lowest
            # rotated vertex on the table — gives a "resting on the bin"
            # look. Z position stays at table_z + epsilon so parts don't
            # sink through the floor.
            rotated = model.points @ R.T
            base_z = float(rotated[:, 2].min())
            placement_z = config.bin.table_z_m - base_z

            # Footprint radius from rotated XY extents — used for overlap
            # avoidance when allow_overlap is False.
            xy = rotated[:, :2]
            footprint = float(np.linalg.norm(xy.max(axis=0) - xy.min(axis=0)) / 2)

            placed = False
            for _attempt in range(30):
                x = rng.uniform(-config.bin.width_m / 2 + footprint,
                                 config.bin.width_m / 2 - footprint)
                y = rng.uniform(-config.bin.depth_m / 2 + footprint,
                                 config.bin.depth_m / 2 - footprint)
                if not config.allow_overlap:
                    too_close = False
                    for ox, oy, orad in occupied_xy_radii:
                        # 90% of combined radii — leaves a little touching
                        # tolerance so dense bins still pack reasonably.
                        if math.hypot(x - ox, y - oy) < (footprint + orad) * 0.9:
                            too_close = True
                            break
                    if too_close:
                        continue
                placed = True
                break
            if not placed:
                # Force-place: overlap will be culled by HPR anyway.
                pass

            t = np.array([x, y, placement_z], dtype=np.float64)
            occupied_xy_radii.append((x, y, footprint))

            # Pickability check: the local "pickable face" axis should point
            # roughly +Z after the rotation. Currently fixed to z+; the
            # config carries the choice so when the operator picks a
            # different face on the dashboard, this lines up.
            world_face = R @ _face_axis(config.pickable_face)
            tilt_deg = math.degrees(math.acos(
                max(-1.0, min(1.0, world_face[2]))))
            is_pickable = tilt_deg < config.pickable_tolerance_deg

            world_pts = rotated + t
            world_nrm = model.normals @ R.T

            inst = PlacedInstance(
                instance_id=next_iid,
                part_id=part_id,
                part_name=model.name,
                R=R, t=t,
                is_pickable=is_pickable,
                placed_points=len(world_pts),
                visible_points=0,             # filled after HPR
                extents_m=model.extents_m,
                source=model.source,
            )
            next_iid += 1
            instances.append(inst)
            placed_clouds.append(world_pts)
            placed_normals.append(world_nrm)
            placed_inst_ids.append(inst.instance_id)

    # 3. Concatenate everything and run HPR from the camera viewpoint.
    if placed_clouds:
        parts_pts  = np.concatenate(placed_clouds, axis=0)
        parts_nrm  = np.concatenate(placed_normals, axis=0)
        parts_lbl  = np.concatenate(
            [np.full(len(c), iid, dtype=np.int32)
             for c, iid in zip(placed_clouds, placed_inst_ids)])
    else:
        parts_pts = np.zeros((0, 3))
        parts_nrm = np.zeros((0, 3))
        parts_lbl = np.zeros((0,), dtype=np.int32)

    # Camera pose: directly above the bin centre at the sweet-spot distance.
    cam_z = config.bin.table_z_m + config.sensor.camera_distance_m
    camera_position = np.array([0.0, 0.0, cam_z], dtype=np.float64)

    all_pts  = np.concatenate([table_pts, parts_pts], axis=0)
    all_nrm  = np.concatenate([table_nrm, parts_nrm], axis=0)
    all_conf = np.concatenate([table_conf, np.ones(len(parts_pts))], axis=0)
    all_lbl  = np.concatenate([np.zeros(len(table_pts), dtype=np.int32),
                                parts_lbl], axis=0)

    if len(all_pts) > 0:
        all_pts, all_nrm, all_conf, all_lbl, visible_mask = _hidden_point_removal(
            all_pts, all_nrm, all_conf, all_lbl,
            camera_position=camera_position,
        )
    else:
        visible_mask = np.zeros(0, dtype=bool)

    # Per-instance visible count from labels.
    if len(all_lbl):
        for inst in instances:
            inst.visible_points = int((all_lbl == inst.instance_id).sum())

    # 4. Sensor degradation pass — applied to the visible cloud only.
    all_pts, all_nrm, all_conf = _apply_sensor_model(
        all_pts, all_nrm, all_conf, camera_position, config, rng_np)

    # 5. Random subsample if we blew past the cap.
    if len(all_pts) > config.max_scene_points:
        idx = rng_np.choice(len(all_pts), config.max_scene_points, replace=False)
        all_pts = all_pts[idx]
        all_nrm = all_nrm[idx]
        all_conf = all_conf[idx]

    scene = SyntheticScene(
        scene_id=scene_id,
        points=all_pts.astype(np.float32),
        normals=all_nrm.astype(np.float32),
        confidence=all_conf.astype(np.float32),
        instances=instances,
        camera_position=camera_position,
        config=config,
    )

    if scenes_dir is not None:
        scene.saved_dir = _persist_scene(scene, scenes_dir, seed_used)

    return scene


def generate_scene_set(config: SceneConfig, n_scenes: int,
                        scenes_dir: Optional[Path] = None,
                        set_name: Optional[str] = None) -> Path:
    """Produce a labeled dataset of `n_scenes` scenes under
    `<scenes_dir>/<set_name>/`. Returns the dataset directory."""
    if scenes_dir is None:
        scenes_dir = SCENES_DIR
    set_name = set_name or f"set_{uuid.uuid4().hex[:8]}"
    out_dir = Path(scenes_dir) / set_name
    out_dir.mkdir(parents=True, exist_ok=True)

    base_seed = config.seed if config.seed is not None else int(time.time())
    scene_ids: List[str] = []
    import copy as _copy
    for i in range(n_scenes):
        # deepcopy preserves the nested BinConfig / SensorConfig dataclasses;
        # asdict would flatten them into dicts and the generator can't index
        # those by attribute.
        c = _copy.deepcopy(config)
        c.seed = base_seed + i
        sid = f"scene_{i:04d}"
        s = generate_scene(c, scenes_dir=out_dir, scene_id=sid)
        scene_ids.append(s.scene_id)

    (out_dir / "set_meta.json").write_text(json.dumps({
        "name": set_name,
        "n_scenes": n_scenes,
        "scene_ids": scene_ids,
        "config": _config_to_json(config),
    }, indent=2))
    return out_dir


# ---------------------------------------------------------------------------
# Table plane
# ---------------------------------------------------------------------------

def _table_plane(config: SceneConfig, rng: np.random.Generator):
    w = config.bin.width_m + 2 * config.bin.table_extra_m
    d = config.bin.depth_m + 2 * config.bin.table_extra_m
    n = max(1000, int(w * d * config.sensor.table_density_per_m2 * 0.10))
    xs = rng.uniform(-w / 2, w / 2, n)
    ys = rng.uniform(-d / 2, d / 2, n)
    zs = np.full(n, config.bin.table_z_m) + rng.normal(
        0, config.sensor.depth_noise_sigma_m * 0.6, n)
    pts = np.stack([xs, ys, zs], axis=1)
    nrm = np.tile([0, 0, 1.0], (n, 1))
    # Slight confidence drop near the bin edges to mimic occluded grazing.
    edge_dist = np.minimum(
        (w / 2) - np.abs(xs),
        (d / 2) - np.abs(ys),
    )
    conf = np.clip(0.9 + edge_dist * 1.5, 0.6, 1.0)
    return pts, nrm, conf


# ---------------------------------------------------------------------------
# Hidden-point removal
# ---------------------------------------------------------------------------

def _hidden_point_removal(pts, nrm, conf, lbl, *, camera_position):
    """Open3D HPR using the camera_position viewpoint.

    Returns (pts, nrm, conf, lbl, visible_mask). visible_mask is over the
    INPUT pts so callers that care about per-input statistics can use it.
    """
    pc = o3d.geometry.PointCloud()
    pc.points = o3d.utility.Vector3dVector(pts)
    # Pick the HPR radius as a multiple of the scene diagonal — Open3D's
    # docs recommend 100× the diagonal as a safe default for top-down rigs.
    diameter = np.linalg.norm(pts.max(axis=0) - pts.min(axis=0))
    if diameter < 1e-6:
        diameter = 1.0
    radius = diameter * 100.0
    try:
        _, idx = pc.hidden_point_removal(camera_position.tolist(), radius)
    except Exception:
        # HPR can fail on near-coplanar clouds — fall back to "all visible".
        idx = list(range(len(pts)))
    visible_mask = np.zeros(len(pts), dtype=bool)
    visible_mask[idx] = True
    return pts[idx], nrm[idx], conf[idx], lbl[idx], visible_mask


# ---------------------------------------------------------------------------
# Sensor noise model
# ---------------------------------------------------------------------------

def _apply_sensor_model(pts, nrm, conf, camera_position, config: SceneConfig,
                         rng: np.random.Generator):
    """Add gaussian depth noise + dropouts + outliers + a grazing-angle
    confidence drop. Approximation only — see module docstring.
    """
    if len(pts) == 0:
        return pts, nrm, conf

    s = config.sensor
    clutter = max(0.0, min(1.0, config.clutter_level))
    sigma = s.depth_noise_sigma_m * (1.0 + 2.0 * clutter)
    dropout = s.dropout_p * (1.0 + 1.5 * clutter)
    outlier_p = s.outlier_p * (1.0 + 1.5 * clutter)

    # Vector from each point toward the camera (the "view ray").
    view = camera_position - pts
    view_norm = np.linalg.norm(view, axis=1, keepdims=True)
    view_norm = np.where(view_norm < 1e-9, 1.0, view_norm)
    view_dir = view / view_norm

    # Cosine of incidence angle (1 = head-on, 0 = grazing). Some normals
    # may be back-facing (from incomplete vertex normal estimation); take
    # the absolute value so we measure grazing regardless of orientation.
    cos_i = np.abs(np.einsum("ij,ij->i", nrm, view_dir))
    cos_i = np.clip(cos_i, 0.0, 1.0)

    # Confidence falls off with grazing. Lower-bounded by a floor so we
    # don't end up with literal zeros at perfect tangent points.
    new_conf = conf * (cos_i * (1.0 - s.confidence_grazing_floor)
                        + s.confidence_grazing_floor)

    # Depth noise along the view direction (a real depth sensor is
    # confused along the ray, not in pixel-space XY).
    noise = rng.normal(0.0, sigma, size=len(pts))[:, None] * view_dir
    pts = pts + noise

    # Outlier flying pixels — random small extra jitter along the ray.
    out_mask = rng.random(len(pts)) < outlier_p
    if out_mask.any():
        jitter = rng.normal(0.0, s.outlier_jitter_m, size=int(out_mask.sum()))
        pts[out_mask] = pts[out_mask] + jitter[:, None] * view_dir[out_mask]
        new_conf[out_mask] *= 0.4

    # Random dropouts — keep mask.
    keep = rng.random(len(pts)) > dropout
    return pts[keep], nrm[keep], new_conf[keep]


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def _persist_scene(scene: SyntheticScene, scenes_dir: Path,
                    seed_used: int) -> Path:
    out_dir = Path(scenes_dir) / scene.scene_id
    out_dir.mkdir(parents=True, exist_ok=True)

    pc = o3d.geometry.PointCloud()
    pc.points  = o3d.utility.Vector3dVector(scene.points.astype(np.float64))
    pc.normals = o3d.utility.Vector3dVector(scene.normals.astype(np.float64))
    # Encode confidence into the colour channel as a debug aid — green ramp.
    cmin, cmax = float(scene.confidence.min() if len(scene.confidence) else 0), \
                  float(scene.confidence.max() if len(scene.confidence) else 1)
    if cmax > cmin:
        cnorm = (scene.confidence - cmin) / (cmax - cmin)
    else:
        cnorm = np.ones_like(scene.confidence)
    colors = np.stack([1.0 - cnorm, cnorm, np.full_like(cnorm, 0.2)], axis=1)
    pc.colors = o3d.utility.Vector3dVector(colors)
    o3d.io.write_point_cloud(str(out_dir / "scene_cloud.ply"), pc)

    np.save(out_dir / "confidence.npy", scene.confidence)

    gt = []
    for inst in scene.instances:
        gt.append({
            "instance_id":  inst.instance_id,
            "part_id":      inst.part_id,
            "part_name":    inst.part_name,
            "pose":         inst.pose_dict(),
            "is_pickable":  bool(inst.is_pickable),
            "visible_point_fraction": round(inst.visible_fraction(), 4),
            "placed_points":  inst.placed_points,
            "visible_points": inst.visible_points,
            "extents_m":      [float(v) for v in inst.extents_m],
            "model_source":   inst.source,
        })
    (out_dir / "ground_truth.json").write_text(json.dumps({
        "scene_id":        scene.scene_id,
        "camera_position": [float(v) for v in scene.camera_position],
        "instances":       gt,
    }, indent=2))

    (out_dir / "scene_meta.json").write_text(json.dumps({
        "scene_id":        scene.scene_id,
        "seed":            seed_used,
        "n_points":        int(len(scene.points)),
        "n_instances":     len(scene.instances),
        "config":          _config_to_json(scene.config),
    }, indent=2))

    try:
        _write_preview(scene, out_dir / "render_preview.png")
    except Exception as e:
        print(f"[scene_gen] preview failed for {scene.scene_id}: {e}",
              file=sys.stderr)
    return out_dir


def _write_preview(scene: SyntheticScene, out_path: Path) -> None:
    if not _MPL_OK or len(scene.points) == 0:
        return
    # Decimate so the preview fits in memory + renders quickly.
    pts = scene.points
    if len(pts) > 20000:
        idx = np.random.choice(len(pts), 20000, replace=False)
        pts = pts[idx]
        conf = scene.confidence[idx]
    else:
        conf = scene.confidence

    fig = _plt.figure(figsize=(7, 5), dpi=110)
    ax = fig.add_subplot(111, projection="3d")
    sc = ax.scatter(pts[:, 0], pts[:, 1], pts[:, 2],
                     c=conf, cmap="viridis", s=0.5)
    cam = scene.camera_position
    ax.scatter([cam[0]], [cam[1]], [cam[2]], c="red", marker="^",
                s=60, label="camera")
    # GT axes per instance — short triad at the part centre.
    for inst in scene.instances:
        c = inst.t
        for axis_i, color in enumerate(["r", "g", "b"]):
            v = inst.R[:, axis_i] * 0.03
            ax.plot([c[0], c[0] + v[0]],
                     [c[1], c[1] + v[1]],
                     [c[2], c[2] + v[2]], color=color)
    ax.view_init(elev=40, azim=-60)
    ax.set_xlabel("X (m)"); ax.set_ylabel("Y (m)"); ax.set_zlabel("Z (m)")
    ax.set_title(f"{scene.scene_id} · {len(scene.points)} pts · "
                  f"{len(scene.instances)} parts")
    fig.colorbar(sc, ax=ax, label="confidence", shrink=0.6)
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(out_path)
    _plt.close(fig)


def _config_to_json(cfg: SceneConfig) -> Dict[str, Any]:
    d = asdict(cfg)
    return d


def _face_axis(face: str) -> np.ndarray:
    table = {
        "x+": [1, 0, 0],  "x-": [-1, 0, 0],
        "y+": [0, 1, 0],  "y-": [0, -1, 0],
        "z+": [0, 0, 1],  "z-": [0, 0, -1],
    }
    return np.array(table.get(face, table["z+"]), dtype=np.float64)


# ---------------------------------------------------------------------------
# Loader for downstream code (benchmark harness, dashboard viewer, …)
# ---------------------------------------------------------------------------

def load_scene(scene_dir: Path) -> Dict[str, Any]:
    """Load a previously-persisted scene back into memory."""
    scene_dir = Path(scene_dir)
    pc = o3d.io.read_point_cloud(str(scene_dir / "scene_cloud.ply"))
    pts = np.asarray(pc.points, dtype=np.float32)
    nrm = np.asarray(pc.normals, dtype=np.float32) if pc.has_normals() else None
    conf_path = scene_dir / "confidence.npy"
    conf = np.load(conf_path) if conf_path.is_file() else None
    gt = json.loads((scene_dir / "ground_truth.json").read_text())
    meta = json.loads((scene_dir / "scene_meta.json").read_text())
    return {
        "points": pts, "normals": nrm, "confidence": conf,
        "ground_truth": gt, "meta": meta,
        "scene_dir": scene_dir,
    }


# ---------------------------------------------------------------------------
# CLI — generate a small dataset from the command line
# ---------------------------------------------------------------------------

def _cli(argv: Optional[List[str]] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="Generate synthetic recognition scenes")
    p.add_argument("--parts", nargs="+", required=True,
                   help="Part IDs from /opt/cobot/parts/index.json")
    p.add_argument("--counts", nargs="+", type=int,
                   help="Per-part instance counts (same order as --parts)")
    p.add_argument("--n-scenes", type=int, default=1)
    p.add_argument("--out", type=str, default=str(SCENES_DIR))
    p.add_argument("--set-name", type=str, default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--allow-overlap", action="store_true")
    p.add_argument("--clutter", type=float, default=0.0)
    args = p.parse_args(argv)

    counts = {pid: (args.counts[i] if args.counts and i < len(args.counts) else 1)
              for i, pid in enumerate(args.parts)}
    cfg = SceneConfig(part_ids=args.parts, counts=counts,
                       allow_overlap=args.allow_overlap,
                       clutter_level=args.clutter, seed=args.seed)
    if args.n_scenes == 1:
        s = generate_scene(cfg, scenes_dir=Path(args.out))
        print(f"Wrote {s.saved_dir}")
    else:
        out = generate_scene_set(cfg, args.n_scenes,
                                  scenes_dir=Path(args.out),
                                  set_name=args.set_name)
        print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())

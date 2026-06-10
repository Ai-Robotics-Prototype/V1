"""Point-cloud registration / ICP utilities.

Two-stage alignment: global registration via FPFH+RANSAC for a coarse
initial transform, then point-to-plane ICP for refinement. Open3D
provides all the primitives; this module just composes them with sane
defaults and adds explicit error reporting so the inspection_node can
surface alignment quality on the dashboard.

If Open3D is not importable (CI without GPU, fresh checkout before
pip install), the public functions raise `RegistrationUnavailable` so
the caller can degrade gracefully to Tier 1 only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np


class RegistrationUnavailable(RuntimeError):
    """Raised when Open3D is missing or the install can't do registration."""


def _o3d():
    """Lazy Open3D import. Centralised so the rest of the module is bare
    NumPy and unit-testable without installing Open3D in CI.
    """
    try:
        import open3d as o3d  # type: ignore
        return o3d
    except ImportError as e:
        raise RegistrationUnavailable(
            'open3d is required for ICP registration; '
            'pip install open3d on the Jetson') from e


@dataclass
class RegistrationResult:
    """Output of the two-stage pipeline."""
    transformation: np.ndarray   # 4x4 homogeneous
    fitness: float               # 0..1, fraction of source within max corr
    rmse: float                  # inlier RMSE (m)
    correspondences: int         # inlier count
    used_global: bool            # whether global pre-alignment ran


def preprocess_cloud(cloud: Any,
                     voxel_size_m: float = 0.003,
                     normal_radius_m: float | None = None,
                     fpfh_radius_m: float | None = None):
    """Downsample, estimate normals, compute FPFH descriptors.

    Defaults are tuned for Mech-Eye NANO ULTRA scans (~0.05 mm raw
    resolution, typical part size 50-200 mm): a 3 mm voxel is plenty
    for global registration while keeping per-cloud work manageable.
    """
    o3d = _o3d()
    if normal_radius_m is None:
        normal_radius_m = voxel_size_m * 2
    if fpfh_radius_m is None:
        fpfh_radius_m = voxel_size_m * 5

    pcd = _ensure_o3d_cloud(cloud)
    down = pcd.voxel_down_sample(voxel_size=voxel_size_m)
    down.estimate_normals(
        o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius_m,
                                             max_nn=30))
    fpfh = o3d.pipelines.registration.compute_fpfh_feature(
        down,
        o3d.geometry.KDTreeSearchParamHybrid(radius=fpfh_radius_m,
                                             max_nn=100))
    return down, fpfh


def compute_fpfh_features(cloud: Any, voxel_size_m: float = 0.003):
    """Convenience: just the FPFH descriptors for the given cloud."""
    _down, fpfh = preprocess_cloud(cloud, voxel_size_m=voxel_size_m)
    return fpfh


def global_registration(source, target,
                        source_fpfh, target_fpfh,
                        voxel_size_m: float = 0.003):
    """RANSAC on FPFH correspondences → coarse initial transform.

    Used to seed ICP when the part may be anywhere in the camera's
    field. If the part is already roughly in the reference pose (a
    fixture-located scan), this stage can be skipped.
    """
    o3d = _o3d()
    distance_threshold = voxel_size_m * 1.5
    return o3d.pipelines.registration.registration_ransac_based_on_feature_matching(
        source, target, source_fpfh, target_fpfh,
        mutual_filter=True,
        max_correspondence_distance=distance_threshold,
        estimation_method=o3d.pipelines.registration.TransformationEstimationPointToPoint(False),
        ransac_n=4,
        checkers=[
            o3d.pipelines.registration.CorrespondenceCheckerBasedOnEdgeLength(0.9),
            o3d.pipelines.registration.CorrespondenceCheckerBasedOnDistance(distance_threshold),
        ],
        criteria=o3d.pipelines.registration.RANSACConvergenceCriteria(100000, 0.999),
    )


def refine_registration(source, target,
                        initial_transform: np.ndarray,
                        max_correspondence_distance_m: float = 0.002):
    """Point-to-plane ICP refinement seeded by `initial_transform`.

    Point-to-plane converges faster than point-to-point on smooth
    manufactured parts because surfaces are locally planar.
    """
    o3d = _o3d()
    src = _ensure_o3d_cloud(source)
    tgt = _ensure_o3d_cloud(target)
    if not tgt.has_normals():
        tgt.estimate_normals()
    return o3d.pipelines.registration.registration_icp(
        src, tgt, max_correspondence_distance_m, initial_transform,
        o3d.pipelines.registration.TransformationEstimationPointToPlane(),
        o3d.pipelines.registration.ICPConvergenceCriteria(
            max_iteration=50, relative_fitness=1e-6, relative_rmse=1e-6),
    )


def align_to_reference(measured: Any, reference: Any,
                       initial_transform: np.ndarray | None = None,
                       voxel_size_m: float = 0.003,
                       fine_distance_m: float = 0.002,
                       try_global: bool = True) -> RegistrationResult:
    """Two-stage alignment, returns a `RegistrationResult`.

    `initial_transform` — if supplied, skip global registration and go
    straight to ICP. The executor passes the robot's TCP pose when it
    knows roughly where the part should be.
    """
    o3d = _o3d()
    init = (initial_transform if initial_transform is not None
            else np.eye(4))
    used_global = False

    if try_global and initial_transform is None:
        src_down, src_fpfh = preprocess_cloud(measured, voxel_size_m)
        tgt_down, tgt_fpfh = preprocess_cloud(reference, voxel_size_m)
        coarse = global_registration(
            src_down, tgt_down, src_fpfh, tgt_fpfh, voxel_size_m)
        init = coarse.transformation
        used_global = True

    fine = refine_registration(measured, reference, init,
                               max_correspondence_distance_m=fine_distance_m)
    return RegistrationResult(
        transformation=np.asarray(fine.transformation, dtype=np.float64),
        fitness=float(fine.fitness),
        rmse=float(fine.inlier_rmse),
        correspondences=len(fine.correspondence_set),
        used_global=used_global,
    )


def evaluate_registration(source: Any, target: Any,
                          transform: np.ndarray,
                          max_distance_m: float = 0.002) -> dict:
    """Quality metrics without modifying the input clouds.

    Useful for "did this ICP run actually succeed?" — fitness < 0.5 is
    almost always a bad alignment.
    """
    o3d = _o3d()
    src = _ensure_o3d_cloud(source)
    tgt = _ensure_o3d_cloud(target)
    eval_ = o3d.pipelines.registration.evaluate_registration(
        src, tgt, max_distance_m, transform)
    return {
        'fitness':         float(eval_.fitness),
        'rmse':            float(eval_.inlier_rmse),
        'correspondences': len(eval_.correspondence_set),
    }


def transform_cloud(cloud: np.ndarray, transform: np.ndarray) -> np.ndarray:
    """Apply a 4x4 homogeneous transform to an (N, 3) numpy cloud."""
    R = transform[:3, :3]
    t = transform[:3, 3]
    return (cloud @ R.T) + t


def _ensure_o3d_cloud(cloud: Any):
    """Coerce numpy / list / o3d.PointCloud into o3d.PointCloud."""
    o3d = _o3d()
    if hasattr(cloud, 'points') and hasattr(cloud, 'estimate_normals'):
        return cloud
    arr = np.asarray(cloud, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != 3:
        raise ValueError(f'cloud must be (N, 3); got {arr.shape}')
    pc = o3d.geometry.PointCloud()
    pc.points = o3d.utility.Vector3dVector(arr)
    return pc

"""Tier 2 — surface-deviation analysis.

Aligns the measured cloud to a reference cloud (CAD-derived, golden
scan, or statistical envelope), computes signed per-point deviation,
classifies each point's severity against the part's tolerance rule,
clusters failing points into defect regions, and emits a colour-coded
heatmap cloud for the dashboard's 3D viewer.

Heavy use of Open3D — guarded so a missing dep produces a clean
RegistrationUnavailable instead of an import failure.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import numpy as np

from .icp_alignment import (
    RegistrationUnavailable, align_to_reference, transform_cloud, _o3d,
)
from .utils import (
    DefectRegion, RESULT_FAIL, RESULT_PASS, RESULT_WARN,
    severity_from_deviation,
)


@dataclass
class Tier2Result:
    """Everything Tier 2 produces in one bundle so the node can serialise it."""
    aligned_cloud: np.ndarray            # (N, 3) source, in reference frame
    transformation: np.ndarray           # 4x4
    deviations_mm: np.ndarray            # (N,), signed
    classifications: np.ndarray          # (N,) int8: 0=pass, 1=warn, 2=fail
    statistics: dict                     # see compute_deviation_statistics
    defects: list[DefectRegion]
    heatmap_rgb: np.ndarray              # (N, 3) uint8
    fitness: float
    rmse: float


# ─── Deviation map ──────────────────────────────────────────────────────

def compute_deviation_map(aligned_cloud: np.ndarray,
                          reference_cloud: np.ndarray) -> np.ndarray:
    """Per-source-point signed distance to nearest reference point.

    Sign convention: positive = source point sits *outside* the
    reference surface (extra material), negative = inside (missing
    material). Sign is determined by the reference's surface normal at
    the nearest point.
    """
    o3d = _o3d()
    ref_pcd = o3d.geometry.PointCloud()
    ref_pcd.points = o3d.utility.Vector3dVector(
        np.asarray(reference_cloud, dtype=np.float64))
    if not ref_pcd.has_normals():
        ref_pcd.estimate_normals()
    ref_pcd.orient_normals_consistent_tangent_plane(20)

    kd = o3d.geometry.KDTreeFlann(ref_pcd)
    ref_pts = np.asarray(ref_pcd.points)
    ref_n   = np.asarray(ref_pcd.normals)

    src = np.asarray(aligned_cloud, dtype=np.float64)
    out = np.empty(src.shape[0], dtype=np.float64)
    for i, p in enumerate(src):
        _k, idx, _d2 = kd.search_knn_vector_3d(p, 1)
        j = idx[0]
        diff = p - ref_pts[j]
        out[i] = float(np.dot(diff, ref_n[j]))
    # Convert from cloud units (metres) to mm so the rest of the
    # pipeline can speak in mm consistently.
    return out * 1000.0


def classify_deviation_severity(deviations_mm: np.ndarray,
                                tol_warn_mm: float,
                                tol_fail_mm: float) -> np.ndarray:
    """Vectorised per-point severity. 0=pass, 1=warn, 2=fail."""
    mag = np.abs(deviations_mm)
    out = np.zeros_like(deviations_mm, dtype=np.int8)
    out[mag >= tol_warn_mm] = 1
    out[mag >= tol_fail_mm] = 2
    return out


def compute_deviation_statistics(deviations_mm: np.ndarray,
                                 tol_warn_mm: float | None = None,
                                 tol_fail_mm: float | None = None) -> dict:
    """Distribution stats. RMSE, percentiles, in-tolerance fraction."""
    if deviations_mm.size == 0:
        return {'count': 0}
    d = np.asarray(deviations_mm, dtype=np.float64)
    mag = np.abs(d)

    out = {
        'count': int(d.size),
        'max':   float(mag.max()),
        'min':   float(d.min()),
        'mean':  float(d.mean()),
        'rms':   float(np.sqrt(np.mean(d * d))),
        'std':   float(d.std()),
        'p95':   float(np.percentile(mag, 95)),
        'p99':   float(np.percentile(mag, 99)),
    }
    if tol_fail_mm is not None:
        out['percent_within_tolerance'] = float(
            (mag < tol_fail_mm).sum()) / float(d.size) * 100.0
    return out


# ─── Defect clustering ──────────────────────────────────────────────────

def identify_defect_regions(deviations_mm: np.ndarray,
                            classifications: np.ndarray,
                            cloud: np.ndarray,
                            eps_m: float = 0.003,
                            min_samples: int = 20) -> list[DefectRegion]:
    """Cluster failing points into discrete defect regions via DBSCAN.

    Skips warn-only points — a defect region is a *failure* cluster.
    """
    fail_mask = classifications >= 2
    if not fail_mask.any():
        return []

    fail_pts = np.asarray(cloud)[fail_mask]
    fail_dev = np.asarray(deviations_mm)[fail_mask]

    labels = _dbscan_cluster(fail_pts, eps=eps_m, min_samples=min_samples)
    out: list[DefectRegion] = []

    for lab in sorted(set(labels)):
        if lab < 0:
            continue
        mask = labels == lab
        cluster_pts = fail_pts[mask]
        cluster_dev = fail_dev[mask]
        center = cluster_pts.mean(axis=0)
        extent = float(np.linalg.norm(
            cluster_pts.max(axis=0) - cluster_pts.min(axis=0)) * 1000.0)
        worst_idx = np.argmax(np.abs(cluster_dev))
        worst_dev = float(cluster_dev[worst_idx])

        out.append(DefectRegion(
            defect_id=uuid.uuid4().hex[:8],
            defect_type=_classify_defect(worst_dev),
            center_xyz=(float(center[0]), float(center[1]), float(center[2])),
            extent_mm=extent,
            deviation_mm=worst_dev,
            severity=RESULT_FAIL,
            confidence=min(1.0, mask.sum() / max(min_samples, 1) / 5.0),
            point_count=int(mask.sum()),
            suggested_action=_suggested_action_for(worst_dev),
        ))
    return out


def _dbscan_cluster(pts: np.ndarray, eps: float, min_samples: int) -> np.ndarray:
    """DBSCAN — sklearn if available, naive grid fallback otherwise."""
    try:
        from sklearn.cluster import DBSCAN
        return DBSCAN(eps=eps, min_samples=min_samples).fit_predict(pts)
    except ImportError:
        # Tiny fallback: bin to a coarse voxel grid and emit any bin
        # with >= min_samples as its own cluster. Not as good as DBSCAN
        # but keeps the pipeline alive on a CI box without sklearn.
        grid = np.floor(pts / eps).astype(np.int64)
        uniq, inv, counts = np.unique(grid, axis=0,
                                      return_inverse=True,
                                      return_counts=True)
        labels = -np.ones(pts.shape[0], dtype=np.int64)
        next_label = 0
        for u_idx, c in enumerate(counts):
            if c >= min_samples:
                labels[inv == u_idx] = next_label
                next_label += 1
        return labels


def _classify_defect(deviation_mm: float) -> str:
    """Coarse defect-type heuristic from sign + magnitude.

    A proper classifier would look at curvature and neighbour
    statistics; this is the cheap first pass that's usually right.
    """
    if deviation_mm > 0:
        return 'bump' if deviation_mm > 0.5 else 'protrusion'
    return 'dent' if deviation_mm < -0.5 else 'depression'


def _suggested_action_for(deviation_mm: float) -> str:
    mag = abs(deviation_mm)
    if mag > 2.0:
        return 'Reject part — out of spec by > 2 mm.'
    if mag > 0.5:
        return 'Hold for visual inspection.'
    return 'Log and continue.'


# ─── Heatmap generation ─────────────────────────────────────────────────

def generate_heatmap_rgb(deviations_mm: np.ndarray,
                         tol_warn_mm: float,
                         tol_fail_mm: float) -> np.ndarray:
    """Linear green→yellow→red colour-coding of per-point deviation.

    Out-of-spec points get full red. Below warn they're a smooth green
    gradient; between warn and fail they ramp through yellow. The
    output is uint8 so it slots straight into a PLY's `red green
    blue` properties.
    """
    mag = np.abs(np.asarray(deviations_mm, dtype=np.float64))
    rgb = np.zeros((mag.size, 3), dtype=np.uint8)

    # Below warn: green → yellow ramp by mag/tol_warn.
    below = mag < tol_warn_mm
    t = np.zeros_like(mag)
    if tol_warn_mm > 0:
        t[below] = mag[below] / tol_warn_mm
    rgb[below, 0] = (255 * t[below]).astype(np.uint8)   # R
    rgb[below, 1] = 255                                  # G

    # warn..fail: yellow → red ramp.
    mid = (~below) & (mag < tol_fail_mm)
    if tol_fail_mm > tol_warn_mm:
        u = (mag[mid] - tol_warn_mm) / (tol_fail_mm - tol_warn_mm)
        rgb[mid, 0] = 255
        rgb[mid, 1] = (255 * (1.0 - u)).astype(np.uint8)

    # >= fail: solid red.
    over = mag >= tol_fail_mm
    rgb[over, 0] = 255
    rgb[over, 1] = 0
    return rgb


# ─── End-to-end Tier 2 pipeline ─────────────────────────────────────────

def run_tier2_inspection(measured_cloud: np.ndarray,
                         reference_cloud: np.ndarray,
                         tol_warn_mm: float,
                         tol_fail_mm: float,
                         initial_transform: np.ndarray | None = None,
                         voxel_size_m: float = 0.003) -> Tier2Result:
    """Full Tier 2 pipeline.

    The caller (inspection_node) is responsible for segmenting the part
    out of the raw scene before passing the cloud in here — Tier 2
    treats whatever points it sees as "the part".

    Raises:
        RegistrationUnavailable — if Open3D isn't available.
    """
    reg = align_to_reference(
        measured_cloud, reference_cloud,
        initial_transform=initial_transform,
        voxel_size_m=voxel_size_m,
    )

    aligned = transform_cloud(np.asarray(measured_cloud, dtype=np.float64),
                              reg.transformation)
    deviations = compute_deviation_map(aligned, reference_cloud)
    classifications = classify_deviation_severity(
        deviations, tol_warn_mm, tol_fail_mm)
    stats = compute_deviation_statistics(
        deviations, tol_warn_mm, tol_fail_mm)
    defects = identify_defect_regions(deviations, classifications, aligned)
    heatmap = generate_heatmap_rgb(deviations, tol_warn_mm, tol_fail_mm)

    return Tier2Result(
        aligned_cloud=aligned,
        transformation=reg.transformation,
        deviations_mm=deviations,
        classifications=classifications,
        statistics=stats,
        defects=defects,
        heatmap_rgb=heatmap,
        fitness=reg.fitness,
        rmse=reg.rmse,
    )

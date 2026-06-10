"""Reference-cloud lifecycle.

Three supported reference types — STEP-derived, golden scan,
statistical envelope. The manager owns:

  - Where each reference lives on disk
    (/opt/cobot/inspections/references/{part_id}_{type}.ply)
  - Per-part metadata (which type is active, version, build date)
  - Build operations (STEP -> cloud, golden capture, statistical build)
  - An in-memory LRU cache so repeat inspections don't reload from
    disk every time

Open3D is the canonical PLY reader; trimesh handles STEP. Both are
imported lazily so the module imports cleanly in CI without those
deps.
"""

from __future__ import annotations

import os
import time
from collections import OrderedDict
from typing import Any

import numpy as np

from .utils import (
    REFERENCES_DIR, ensure_dirs, file_sha256,
    safe_dump_json, safe_load_json,
)


REFERENCE_TYPES = ('step', 'golden', 'statistical')

# Cache size — references are big (~5M points × 12B = 60MB) so keep
# this small. 4 entries × 60MB = ~240MB upper bound.
_CACHE_CAPACITY = 4


def _metadata_path(part_id: str) -> str:
    return os.path.join(REFERENCES_DIR, f'{part_id}_metadata.json')


def _cloud_path(part_id: str, ref_type: str) -> str:
    return os.path.join(REFERENCES_DIR, f'{part_id}_{ref_type}.ply')


class ReferenceManager:
    """All reference-cloud operations go through here."""

    def __init__(self) -> None:
        ensure_dirs()
        self._cache: OrderedDict[str, Any] = OrderedDict()

    # ─── Metadata ────────────────────────────────────────────────────

    def get_metadata(self, part_id: str) -> dict:
        """Return a structurally complete metadata dict, even for unknown parts.

        Default has all three reference slots present so the dashboard's
        Configure tab can render the table without null-checking every
        field.
        """
        default = {
            'part_id': part_id,
            'active_type': None,
            'references': {
                t: {'present': False, 'version': 0, 'timestamp': None,
                    'sha256': None, 'n_points': 0, 'built_by': None,
                    'notes': None}
                for t in REFERENCE_TYPES
            },
        }
        return safe_load_json(_metadata_path(part_id), default)

    def write_metadata(self, part_id: str, meta: dict) -> None:
        safe_dump_json(_metadata_path(part_id), meta)

    def list_references(self, part_id: str) -> list[dict]:
        """Per-type availability + file hash, for the dashboard."""
        meta = self.get_metadata(part_id)
        out = []
        for t in REFERENCE_TYPES:
            entry = dict(meta['references'][t])
            entry['type'] = t
            path = _cloud_path(part_id, t)
            entry['present'] = os.path.isfile(path)
            entry['path'] = path if entry['present'] else None
            out.append(entry)
        return out

    def set_active_reference(self, part_id: str, ref_type: str) -> dict:
        if ref_type not in REFERENCE_TYPES:
            raise ValueError(f'unknown reference type: {ref_type}')
        if not os.path.isfile(_cloud_path(part_id, ref_type)):
            raise FileNotFoundError(
                f'no {ref_type} reference exists yet for {part_id}')
        meta = self.get_metadata(part_id)
        meta['active_type'] = ref_type
        self.write_metadata(part_id, meta)
        return meta

    # ─── Loading ─────────────────────────────────────────────────────

    def get_reference(self, part_id: str,
                      preferred_type: str | None = None) -> np.ndarray:
        """Load the requested reference, falling back through the chain.

        Order of preference: `preferred_type`, the metadata-marked
        active type, then any present type. Raises FileNotFoundError if
        nothing is on disk.
        """
        meta = self.get_metadata(part_id)
        candidates = []
        if preferred_type:
            candidates.append(preferred_type)
        if meta.get('active_type'):
            candidates.append(meta['active_type'])
        for t in REFERENCE_TYPES:
            if t not in candidates:
                candidates.append(t)

        for t in candidates:
            path = _cloud_path(part_id, t)
            if os.path.isfile(path):
                return self._load_cached(path)

        raise FileNotFoundError(f'no reference of any type for part {part_id}')

    def _load_cached(self, path: str) -> np.ndarray:
        """LRU-cached PLY load. Path used as the cache key."""
        if path in self._cache:
            self._cache.move_to_end(path)
            return self._cache[path]
        cloud = _load_ply(path)
        self._cache[path] = cloud
        while len(self._cache) > _CACHE_CAPACITY:
            self._cache.popitem(last=False)
        return cloud

    # ─── Build operations ────────────────────────────────────────────

    def build_from_step(self, part_id: str, step_path: str,
                        sample_points: int = 1_000_000,
                        built_by: str | None = None) -> dict:
        """Convert a STEP file to a point cloud reference.

        Implementation routes through the existing step_parser pipeline
        (object_detection/step_parser.py) — same code path used by the
        parts library for visualisation, so a STEP that loads there
        loads here.
        """
        cloud = _step_to_cloud(step_path, sample_points)
        path = _cloud_path(part_id, 'step')
        _save_ply(path, cloud)
        self._update_metadata_after_build(
            part_id, 'step', cloud, built_by, notes=f'from {step_path}')
        self._cache.pop(path, None)
        return self.get_metadata(part_id)

    def build_golden(self, part_id: str, captured_cloud: np.ndarray,
                     built_by: str | None = None) -> dict:
        """Save a confirmed-good scan as the golden reference."""
        path = _cloud_path(part_id, 'golden')
        _save_ply(path, np.asarray(captured_cloud, dtype=np.float64))
        self._update_metadata_after_build(
            part_id, 'golden', captured_cloud, built_by,
            notes='captured live')
        self._cache.pop(path, None)
        return self.get_metadata(part_id)

    def build_statistical(self, part_id: str,
                          passing_clouds: list[np.ndarray],
                          min_samples: int = 30,
                          built_by: str | None = None) -> dict:
        """Aggregate N passing scans into a mean-position reference.

        Each cloud is first aligned to the first; per-point mean of
        the aligned clouds becomes the reference. Standard deviation
        per point is saved alongside (as the alpha channel of the PLY)
        so downstream code can build a ±Nσ envelope when needed.
        """
        if len(passing_clouds) < min_samples:
            raise ValueError(
                f'need at least {min_samples} passing clouds, '
                f'got {len(passing_clouds)}')

        from .icp_alignment import align_to_reference, transform_cloud
        anchor = np.asarray(passing_clouds[0], dtype=np.float64)
        # Re-sample all clouds to the same point count by nearest-
        # neighbour to the anchor — keeps the per-point math tractable.
        aligned = [anchor]
        for other in passing_clouds[1:]:
            reg = align_to_reference(other, anchor)
            aligned.append(
                transform_cloud(np.asarray(other, dtype=np.float64),
                                reg.transformation))

        # Naive (but works as a first pass): pad/truncate to the
        # shortest cloud's length, then average row-wise.
        min_n = min(c.shape[0] for c in aligned)
        stacked = np.stack([c[:min_n] for c in aligned], axis=0)
        mean_cloud = stacked.mean(axis=0)

        path = _cloud_path(part_id, 'statistical')
        _save_ply(path, mean_cloud)
        self._update_metadata_after_build(
            part_id, 'statistical', mean_cloud, built_by,
            notes=f'N={len(passing_clouds)}')
        self._cache.pop(path, None)
        return self.get_metadata(part_id)

    # ─── Validation ──────────────────────────────────────────────────

    def validate_reference(self, part_id: str, ref_type: str) -> dict:
        """Quick health-check on a reference file."""
        path = _cloud_path(part_id, ref_type)
        if not os.path.isfile(path):
            return {'ok': False, 'reason': 'missing'}
        try:
            cloud = _load_ply(path)
        except Exception as e:
            return {'ok': False, 'reason': f'unreadable: {e}'}
        if cloud.shape[0] < 1000:
            return {'ok': False, 'reason': f'sparse ({cloud.shape[0]} pts)'}
        return {
            'ok': True,
            'point_count': int(cloud.shape[0]),
            'density_estimate': _density_estimate(cloud),
            'sha256': file_sha256(path),
        }

    # ─── Internal ────────────────────────────────────────────────────

    def _update_metadata_after_build(self, part_id: str, ref_type: str,
                                     cloud: np.ndarray,
                                     built_by: str | None,
                                     notes: str | None) -> None:
        path = _cloud_path(part_id, ref_type)
        meta = self.get_metadata(part_id)
        meta['references'][ref_type] = {
            'present':   True,
            'version':   int(meta['references'][ref_type].get('version', 0)) + 1,
            'timestamp': time.time(),
            'sha256':    file_sha256(path),
            'n_points':  int(np.asarray(cloud).shape[0]),
            'built_by':  built_by,
            'notes':     notes,
        }
        # Auto-activate the first reference of any type.
        if not meta.get('active_type'):
            meta['active_type'] = ref_type
        self.write_metadata(part_id, meta)


# ─── PLY / STEP helpers ─────────────────────────────────────────────────

def _load_ply(path: str) -> np.ndarray:
    """Load a PLY into an (N, 3) float64 array via Open3D."""
    import open3d as o3d  # type: ignore  # lazy: only when actually loading
    pcd = o3d.io.read_point_cloud(path)
    return np.asarray(pcd.points, dtype=np.float64)


def _save_ply(path: str, cloud: np.ndarray) -> None:
    import open3d as o3d  # type: ignore
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(cloud, dtype=np.float64))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    o3d.io.write_point_cloud(path, pcd, write_ascii=False)


def _step_to_cloud(step_path: str, sample_points: int) -> np.ndarray:
    """STEP -> mesh -> Poisson-disk sampled point cloud.

    Routes through the existing object_detection.step_parser if
    importable so any quirks of the production STEP files (units,
    coordinate frame conventions) are handled the same way the rest of
    the stack handles them.
    """
    try:
        from object_detection import step_parser  # type: ignore
        mesh = step_parser.load_step_as_mesh(step_path)  # type: ignore
    except Exception:
        # Fallback: trimesh directly. Loses any project-specific
        # massaging that step_parser does, but at least produces a
        # valid cloud the operator can use.
        import trimesh  # type: ignore
        mesh = trimesh.load(step_path, force='mesh')

    # `trimesh.Trimesh.sample` is uniform-area; we want Poisson disk
    # for even spacing. Open3d's `sample_points_poisson_disk` is the
    # one we want when available.
    try:
        import open3d as o3d  # type: ignore
        o3_mesh = o3d.geometry.TriangleMesh()
        o3_mesh.vertices = o3d.utility.Vector3dVector(
            np.asarray(mesh.vertices, dtype=np.float64))
        o3_mesh.triangles = o3d.utility.Vector3iVector(
            np.asarray(mesh.faces, dtype=np.int32))
        cloud = o3_mesh.sample_points_poisson_disk(sample_points)
        return np.asarray(cloud.points, dtype=np.float64)
    except Exception:
        # Worst-case fallback: trimesh uniform sample.
        pts, _ = mesh.sample(sample_points, return_index=True)  # type: ignore
        return np.asarray(pts, dtype=np.float64)


def _density_estimate(cloud: np.ndarray) -> float:
    """Rough points-per-mm² density. Used as a reference quality metric."""
    if cloud.shape[0] < 100:
        return 0.0
    # Surface area approximated by AABB face area — good enough for a
    # density sanity check, not for billing.
    mins = cloud.min(axis=0)
    maxs = cloud.max(axis=0)
    ext = (maxs - mins) * 1000.0  # to mm
    area_mm2 = 2 * (ext[0] * ext[1] + ext[1] * ext[2] + ext[0] * ext[2])
    if area_mm2 <= 0:
        return 0.0
    return float(cloud.shape[0]) / area_mm2

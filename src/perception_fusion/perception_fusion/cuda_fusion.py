"""
GPU-accelerated point cloud operations using CuPy.
Falls back to NumPy transparently when CuPy / CUDA is unavailable.
"""

import numpy as np
from typing import List, Tuple

try:
    import cupy as cp
    from cupy.cuda import Stream
    _xp = cp
    CUPY_AVAILABLE = True
except ImportError:
    cp = None
    _xp = np
    CUPY_AVAILABLE = False


def get_backend() -> str:
    return "cupy" if CUPY_AVAILABLE else "numpy"


# ── Voxel grid downsampling ────────────────────────────────────────────────────

def voxel_downsample(pts: np.ndarray, voxel_size: float) -> np.ndarray:
    """
    pts : (N, 3+) float32 array
    Returns downsampled (M, 3+) array using voxel centroid.
    Uses CuPy on GPU when available, otherwise falls back to NumPy.
    """
    if len(pts) == 0:
        return pts

    if CUPY_AVAILABLE:
        return _voxel_downsample_gpu(pts, voxel_size)
    return _voxel_downsample_cpu(pts, voxel_size)


def _voxel_downsample_gpu(pts: np.ndarray, voxel_size: float) -> np.ndarray:
    d_pts = cp.asarray(pts, dtype=cp.float32)
    xyz   = d_pts[:, :3]

    inv_vs = cp.float32(1.0 / voxel_size)
    keys   = cp.floor(xyz * inv_vs).astype(cp.int32)

    # Pack (ix, iy, iz) into a single int64 key
    OFFSET  = cp.int32(32768)
    packed  = (
        (keys[:, 0] + OFFSET).astype(cp.int64)
        | ((keys[:, 1] + OFFSET).astype(cp.int64) << 16)
        | ((keys[:, 2] + OFFSET).astype(cp.int64) << 32)
    )

    order   = cp.argsort(packed)
    sorted_keys = packed[order]
    sorted_pts  = d_pts[order]

    # Find voxel boundaries
    boundaries = cp.concatenate([
        cp.array([True]),
        sorted_keys[1:] != sorted_keys[:-1],
        cp.array([True]),
    ])
    starts = cp.where(boundaries[:-1])[0]
    ends   = cp.where(boundaries[1:])[0]

    # Vectorised centroid per voxel via segment mean
    n_voxels = len(starts)
    out = cp.empty((n_voxels, d_pts.shape[1]), dtype=cp.float32)
    for v in range(n_voxels):
        out[v] = sorted_pts[starts[v]:ends[v]].mean(axis=0)

    return cp.asnumpy(out)


def _voxel_downsample_cpu(pts: np.ndarray, voxel_size: float) -> np.ndarray:
    inv_vs = 1.0 / voxel_size
    keys   = np.floor(pts[:, :3] * inv_vs).astype(np.int32)
    OFFSET = 32768
    packed = (
        (keys[:, 0] + OFFSET).astype(np.int64)
        | ((keys[:, 1] + OFFSET).astype(np.int64) << 16)
        | ((keys[:, 2] + OFFSET).astype(np.int64) << 32)
    )
    order  = np.argsort(packed)
    sp     = packed[order]
    spts   = pts[order]
    _, idx, cnts = np.unique(sp, return_index=True, return_counts=True)
    out = np.array([spts[i:i+c].mean(axis=0) for i, c in zip(idx, cnts)], dtype=np.float32)
    return out


# ── Range filter ──────────────────────────────────────────────────────────────

def range_filter(pts: np.ndarray, min_r: float, max_r: float) -> np.ndarray:
    if len(pts) == 0:
        return pts
    if CUPY_AVAILABLE:
        d = cp.asarray(pts, dtype=cp.float32)
        r = cp.linalg.norm(d[:, :3], axis=1)
        mask = (r >= min_r) & (r <= max_r)
        return cp.asnumpy(d[mask])
    r = np.linalg.norm(pts[:, :3], axis=1)
    return pts[(r >= min_r) & (r <= max_r)]


# ── Cloud concatenation ───────────────────────────────────────────────────────

def concat_clouds(clouds: List[np.ndarray]) -> np.ndarray:
    valid = [c for c in clouds if c is not None and len(c) > 0]
    if not valid:
        return np.zeros((0, 3), dtype=np.float32)
    if CUPY_AVAILABLE:
        gpu = [cp.asarray(c, dtype=cp.float32) for c in valid]
        merged = cp.concatenate(gpu, axis=0)
        return cp.asnumpy(merged)
    return np.concatenate(valid, axis=0).astype(np.float32)


# ── Normal estimation (PCA, GPU) ──────────────────────────────────────────────

def estimate_normals(pts: np.ndarray, k: int = 20) -> np.ndarray:
    """
    Returns (N, 4) array: [nx, ny, nz, curvature].
    Uses CuPy batched PCA when available.
    """
    n = len(pts)
    if n == 0:
        return np.zeros((0, 4), dtype=np.float32)
    if CUPY_AVAILABLE:
        return _normals_gpu(pts, k)
    return _normals_cpu(pts, k)


def _normals_gpu(pts: np.ndarray, k: int) -> np.ndarray:
    d = cp.asarray(pts[:, :3], dtype=cp.float32)  # (N,3)
    n = d.shape[0]

    # Pairwise distances: (N,N) — fine for N<10k on Orin's HBM
    D2 = (
        cp.sum(d**2, axis=1, keepdims=True)
        + cp.sum(d**2, axis=1)
        - 2.0 * d @ d.T
    )
    knn_idx = cp.argsort(D2, axis=1)[:, 1:k+1]   # (N, k)

    normals = cp.zeros((n, 4), dtype=cp.float32)

    # Batch PCA: process in chunks to avoid OOM
    CHUNK = 1024
    for start in range(0, n, CHUNK):
        end = min(start + CHUNK, n)
        nb  = knn_idx[start:end]            # (B, k)
        q   = d[start:end]                  # (B, 3)
        B   = end - start

        # Neighbourhood: (B, k, 3)
        neigh = d[nb.reshape(-1)].reshape(B, k, 3)

        # Centre
        c = neigh.mean(axis=1, keepdims=True)       # (B,1,3)
        nc = neigh - c                               # (B,k,3)

        # Covariance (B,3,3)
        cov = cp.einsum('bki,bkj->bij', nc, nc) / k

        # Smallest eigenvector via power iteration (3 iters)
        v = cp.ones((B, 3, 1), dtype=cp.float32)
        # Use inverse power on (trace*I - cov) to find smallest eigvec
        tr = cp.trace(cov, axis1=1, axis2=2).reshape(B, 1, 1)
        M  = tr * cp.eye(3, dtype=cp.float32) - cov
        for _ in range(8):
            v = M @ v
            v /= (cp.linalg.norm(v, axis=1, keepdims=True) + 1e-9)

        nv = v.squeeze(-1)                           # (B,3)
        nlen = cp.linalg.norm(nv, axis=1, keepdims=True)
        nv = nv / (nlen + 1e-9)

        # Curvature: lambda_min / trace
        curv = cp.einsum('bi,bij,bj->b', nv, cov, nv) / (tr.squeeze() + 1e-9)
        normals[start:end, :3] = nv
        normals[start:end, 3]  = curv.clip(0, 1)

    return cp.asnumpy(normals)


def _normals_cpu(pts: np.ndarray, k: int) -> np.ndarray:
    n = pts.shape[0]
    normals = np.zeros((n, 4), dtype=np.float32)
    D2 = (
        np.sum(pts[:, :3]**2, axis=1, keepdims=True)
        + np.sum(pts[:, :3]**2, axis=1)
        - 2.0 * pts[:, :3] @ pts[:, :3].T
    )
    knn_idx = np.argsort(D2, axis=1)[:, 1:k+1]
    for i in range(n):
        nb  = pts[knn_idx[i], :3]
        c   = nb.mean(axis=0)
        nc  = nb - c
        cov = (nc.T @ nc) / k
        vals, vecs = np.linalg.eigh(cov)
        normals[i, :3] = vecs[:, 0]
        normals[i, 3]  = vals[0] / (vals.sum() + 1e-9)
    return normals

"""URDF-driven forward kinematics for the run trajectory analyzer.

Parses the twin URDF (/opt/cobot/models/robot/s10-140-full.urdf — the
same file the ArmViewer3D loads over /robot/urdf) and evaluates flange
pose (XYZ + RPY) for arbitrary 6-DOF joint vectors. The point is that
the operator's screen and this analyzer agree byte-for-byte on where
the tool went, because they both read the same URDF chain (including
the deliberate J3/J5 axis sign inversions vs CAD — see the URDF's
top-of-file note; if either side drops those signs the twin diverges
from the physical arm on wrist jogs).

Vectorised over samples: fk_batch(joints_deg_Nx6) returns positions
(N,3) and orientations (N,3, roll/pitch/yaw in radians). A full
whitebowlpickplace run is ~2500 samples; this runs in <50 ms.

No external deps — plain numpy. urdf_parser_py / kdl_parser_py aren't
installed on the Jetson and this chain is simple enough (six revolute
joints, no RPY offsets, only Y / -Y / X / -X axes) that a direct
implementation is smaller and less brittle than pulling KDL in.
"""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from typing import Tuple

import numpy as np


DEFAULT_URDF = '/opt/cobot/models/robot/s10-140-full.urdf'


def _parse_chain(urdf_path: str):
    """Parse revolute joints in URDF order → list of (origin, axis).
    origin: (3,) float, xyz in meters. axis: (3,) float, unit vector."""
    tree = ET.parse(urdf_path)
    root = tree.getroot()
    joints = []
    for j in root.findall('joint'):
        if j.attrib.get('type') != 'revolute':
            continue
        o = j.find('origin')
        a = j.find('axis')
        if o is None or a is None:
            continue
        xyz = np.array([float(v) for v in o.attrib.get('xyz', '0 0 0').split()],
                       dtype=float)
        rpy = np.array([float(v) for v in o.attrib.get('rpy', '0 0 0').split()],
                       dtype=float)
        axis = np.array([float(v) for v in a.attrib.get('xyz', '0 0 1').split()],
                        dtype=float)
        n = np.linalg.norm(axis)
        if n > 0:
            axis = axis / n
        joints.append((xyz, rpy, axis))
    return joints


def _rot_rpy(rpy: np.ndarray) -> np.ndarray:
    """Fixed-axis roll-pitch-yaw → 3x3 rotation matrix."""
    r, p, y = float(rpy[0]), float(rpy[1]), float(rpy[2])
    cr, sr = np.cos(r), np.sin(r)
    cp, sp = np.cos(p), np.sin(p)
    cy, sy = np.cos(y), np.sin(y)
    Rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    Ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def _axis_angle(axis: np.ndarray, thetas: np.ndarray) -> np.ndarray:
    """Rodrigues rotation about `axis` for each of the N angles.
    Returns (N, 3, 3)."""
    axis = axis / max(np.linalg.norm(axis), 1e-12)
    kx, ky, kz = axis
    K = np.array([[0, -kz, ky], [kz, 0, -kx], [-ky, kx, 0]])
    KK = K @ K
    I = np.eye(3)
    c = np.cos(thetas)[:, None, None]
    s = np.sin(thetas)[:, None, None]
    # R = I + sin(t) K + (1 - cos(t)) K^2
    return I[None, :, :] + s * K[None, :, :] + (1 - c) * KK[None, :, :]


def _rot_to_rpy(R: np.ndarray) -> np.ndarray:
    """Extract roll-pitch-yaw (ZYX intrinsic == XYZ fixed) from (N,3,3).
    Returns (N, 3) with columns roll (X), pitch (Y), yaw (Z)."""
    sy = -R[:, 2, 0]
    sy = np.clip(sy, -1.0, 1.0)
    pitch = np.arcsin(sy)
    cy = np.cos(pitch)
    roll  = np.where(np.abs(cy) > 1e-6,
                     np.arctan2(R[:, 2, 1], R[:, 2, 2]),
                     np.arctan2(-R[:, 1, 2], R[:, 1, 1]))
    yaw   = np.where(np.abs(cy) > 1e-6,
                     np.arctan2(R[:, 1, 0], R[:, 0, 0]),
                     0.0)
    return np.stack([roll, pitch, yaw], axis=1)


class ChainFK:
    """Cached URDF chain evaluator."""

    def __init__(self, urdf_path: str = DEFAULT_URDF):
        self.urdf_path = urdf_path
        self.chain = _parse_chain(urdf_path)
        # Precompute fixed origin rotations (all zero-rpy on this URDF,
        # but keep the plumbing so a corrected URDF drops in cleanly).
        self._origin_R = [_rot_rpy(rpy) for (_, rpy, _) in self.chain]

    def fk_batch(self, joints_rad: np.ndarray
                 ) -> Tuple[np.ndarray, np.ndarray]:
        """joints_rad: (N, 6) in radians. Returns (positions (N,3),
        rpy (N,3))."""
        N = joints_rad.shape[0]
        # Running world → link6 transform per-sample.
        R = np.broadcast_to(np.eye(3), (N, 3, 3)).copy()
        p = np.zeros((N, 3))
        for i, (xyz, _rpy, axis) in enumerate(self.chain):
            R_origin = self._origin_R[i]
            # World frame update: p_i = p_{i-1} + R_{i-1} @ (xyz)
            #                     R_i = R_{i-1} @ R_origin @ R(axis, θ)
            p = p + np.einsum('nij,j->ni', R, xyz)
            R = np.einsum('nij,jk->nik', R, R_origin)
            R_j = _axis_angle(axis, joints_rad[:, i])
            R = np.einsum('nij,njk->nik', R, R_j)
        rpy = _rot_to_rpy(R)
        return p, rpy


_CACHED_CHAIN: ChainFK | None = None


def get_chain(urdf_path: str = DEFAULT_URDF) -> ChainFK:
    global _CACHED_CHAIN
    if _CACHED_CHAIN is None or _CACHED_CHAIN.urdf_path != urdf_path:
        _CACHED_CHAIN = ChainFK(urdf_path)
    return _CACHED_CHAIN


def urdf_available(urdf_path: str = DEFAULT_URDF) -> bool:
    return os.path.isfile(urdf_path)


def line_deviation(points: np.ndarray) -> Tuple[np.ndarray, float, float]:
    """Per-sample perpendicular distance from the line joining the first
    and last point (in meters). Returns (per_sample, max, rms)."""
    if points.shape[0] < 2:
        return np.zeros(points.shape[0]), 0.0, 0.0
    a = points[0]
    b = points[-1]
    ab = b - a
    ab_len = float(np.linalg.norm(ab))
    if ab_len < 1e-9:
        d = np.linalg.norm(points - a, axis=1)
        return d, float(d.max()), float(np.sqrt(np.mean(d ** 2)))
    ap = points - a
    # Projection onto ab, then perpendicular component.
    t = ap @ ab / (ab_len ** 2)
    proj = a + t[:, None] * ab
    d = np.linalg.norm(points - proj, axis=1)
    return d, float(d.max()), float(np.sqrt(np.mean(d ** 2)))


def _rpy_to_rot_batch(rpy: np.ndarray) -> np.ndarray:
    """(N, 3) rpy → (N, 3, 3) rotation matrices."""
    r, p, y = rpy[:, 0], rpy[:, 1], rpy[:, 2]
    cr, sr = np.cos(r), np.sin(r)
    cp, sp = np.cos(p), np.sin(p)
    cy, sy = np.cos(y), np.sin(y)
    R = np.zeros((rpy.shape[0], 3, 3))
    R[:, 0, 0] = cy * cp
    R[:, 0, 1] = cy * sp * sr - sy * cr
    R[:, 0, 2] = cy * sp * cr + sy * sr
    R[:, 1, 0] = sy * cp
    R[:, 1, 1] = sy * sp * sr + cy * cr
    R[:, 1, 2] = sy * sp * cr - cy * sr
    R[:, 2, 0] = -sp
    R[:, 2, 1] = cp * sr
    R[:, 2, 2] = cp * cr
    return R


def orientation_deviation(rpy: np.ndarray
                          ) -> Tuple[np.ndarray, float, float]:
    """Per-sample geodesic angle (radians) between the sample orientation
    and the SLERP interpolation from first to last. Returns
    (per_sample_deg, max_deg, rms_deg).

    SLERP is done in rotation-matrix space via the axis-angle of
    R_start^T @ R_end scaled by t, which is equivalent to quaternion
    SLERP without pulling in scipy Rotation."""
    N = rpy.shape[0]
    if N < 2:
        return np.zeros(N), 0.0, 0.0
    R_all = _rpy_to_rot_batch(rpy)
    R0 = R_all[0]
    RN = R_all[-1]
    # Relative rotation start → end.
    R_rel = R0.T @ RN
    # Axis-angle of R_rel.
    cos_a = (np.trace(R_rel) - 1.0) / 2.0
    cos_a = float(np.clip(cos_a, -1.0, 1.0))
    total_angle = float(np.arccos(cos_a))
    if total_angle < 1e-9:
        # Degenerate — endpoints coincide. Just report per-sample delta
        # from R0 (max hold error).
        R_delta = np.einsum('ij,njk->nik', R0.T, R_all)
        cos = (np.einsum('nii->n', R_delta) - 1.0) / 2.0
        cos = np.clip(cos, -1.0, 1.0)
        d = np.arccos(cos)
        d_deg = np.degrees(d)
        return d_deg, float(d_deg.max()), float(np.sqrt(np.mean(d_deg ** 2)))
    # Extract unit axis of the total rotation.
    sin_a = np.sin(total_angle)
    axis = np.array([
        R_rel[2, 1] - R_rel[1, 2],
        R_rel[0, 2] - R_rel[2, 0],
        R_rel[1, 0] - R_rel[0, 1],
    ]) / (2.0 * sin_a)
    # Per-sample expected rotation R0 @ R(axis, t * total_angle).
    ts = np.linspace(0.0, 1.0, N)
    R_interp_local = _axis_angle(axis, ts * total_angle)
    R_expected = np.einsum('ij,njk->nik', R0, R_interp_local)
    # Deviation = R_expected^T @ R_actual.
    R_dev = np.einsum('nji,njk->nik', R_expected, R_all)
    cos = (np.einsum('nii->n', R_dev) - 1.0) / 2.0
    cos = np.clip(cos, -1.0, 1.0)
    d = np.arccos(cos)
    d_deg = np.degrees(d)
    return d_deg, float(d_deg.max()), float(np.sqrt(np.mean(d_deg ** 2)))

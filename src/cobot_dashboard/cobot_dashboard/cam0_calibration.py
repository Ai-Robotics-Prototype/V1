"""cam0 → base_link extrinsic calibrator.

Touch-point correspondence method:

  * Operator places a printed AprilTag anywhere in cam0's view.
  * TCP jogs down until the cup touches the visual center of the tag.
  * At capture time we record a PAIR:
      tcp_base = the robot's live TCP position in base frame (from
                 /estun/status, i.e. from FK on the true taught
                 joints)
      cam_pt   = the AprilTag's pose translation in cam0 frame
                 (its origin IS the tag center — this is what the
                 cup is touching)
  * Operator moves the tag to another spot, jogs again, captures
    again. 4-6 spread positions give a well-conditioned solve.

Solve:

  * Umeyama rigid alignment (no scale). Compute the transform T such
    that T * cam_pt_i ≈ tcp_base_i for every pair. Report per-pair
    residuals and RMS in millimeters — the operator gates on
    RMS < 3 mm before saving.

  * Reflection guard on SVD (Kabsch / Umeyama flip): if det(V U^T) is
    negative, sign-flip the last column of V before computing R. Any
    solve that returns a proper rotation matrix without this guard
    is a coincidence — the SVD signs are not deterministic.

Persist / load:

  * cam0_extrinsic.yaml under /opt/cobot/calibration/. Structure
    matches the task's contract:  R (3x3), t (3-vec), rms_mm, date,
    points [{tcp: [x,y,z], cam: [x,y,z]}, ...].

No ROS deps in this module. dashboard_server owns the ROS side
(subscriptions, tag detection, TF broadcast). This keeps the math
+ IO unit-testable without a running node.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
import yaml


CALIBRATION_DIR   = '/opt/cobot/calibration'
CAM0_EXTRINSIC_YAML = os.path.join(CALIBRATION_DIR, 'cam0_extrinsic.yaml')

RMS_ACCEPT_MM   = 3.0    # gate: solve is acceptable when RMS residual < this
MIN_POINTS      = 4      # Umeyama needs 3, we require 4 to leave one out for
                         # visual sanity + to average measurement noise


@dataclass
class CalibrationPoint:
    """One captured (robot, camera) pair. Positions are METERS."""
    idx:      int
    tcp_base: list           # [x, y, z] — robot TCP in base_link frame
    cam_pt:   list           # [x, y, z] — tag center in cam0 frame
    captured_at: float       # unix time
    # Free-form label the UI shows. Defaults empty; the endpoint sets
    # a human timestamp string so a stack of captures is readable.
    label:    str = ''


@dataclass
class CalibrationResult:
    """The solved transform + its quality."""
    R:       list          # 3x3 nested list, row-major
    t:       list          # 3-vec, meters
    rms_mm:  float
    per_point_mm: list     # residual for each pair, in solve order
    n_points: int
    solved_at: float


@dataclass
class CalibrationSession:
    """In-memory session state — dashboard_server keeps ONE instance
    on the module and mutates it through the /api/calib endpoints.
    A save persists the SOLVE + the point list to disk; the next
    /start clears the whole thing back to defaults."""
    points:   list = field(default_factory=list)
    result:   Optional[CalibrationResult] = None
    saved_at: Optional[float] = None

    def add_point(self, tcp_base, cam_pt, label=''):
        idx = (max((p.idx for p in self.points), default=0) + 1)
        p = CalibrationPoint(
            idx=idx,
            tcp_base=[float(v) for v in tcp_base],
            cam_pt=[float(v) for v in cam_pt],
            captured_at=time.time(),
            label=label,
        )
        self.points.append(p)
        # Discard the previous solve — the point set changed.
        self.result = None
        return p

    def remove_point(self, idx: int) -> bool:
        before = len(self.points)
        self.points = [p for p in self.points if p.idx != idx]
        if len(self.points) == before:
            return False
        self.result = None
        return True

    def clear(self):
        self.points = []
        self.result = None
        self.saved_at = None

    def to_dict(self):
        return {
            'points':   [asdict(p) for p in self.points],
            'result':   (asdict(self.result) if self.result else None),
            'saved_at': self.saved_at,
        }


def umeyama_rigid(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Kabsch/Umeyama rigid alignment (no scale).
    Given two point sets sharing correspondence order, returns (R, t)
    such that (R @ src_i + t) ≈ dst_i for every i.

    src, dst: (N, 3) numpy arrays, at least 3 non-colinear points
    (task's MIN_POINTS gate enforces 4 as the caller-side minimum).

    Reflection guard: if the SVD would produce an improper rotation
    (det -1), we sign-flip the last column of V before computing R.
    This is the Kabsch fix — without it the "R" you get back is a
    reflection matrix that would mirror the world.
    """
    if src.shape != dst.shape or src.ndim != 2 or src.shape[1] != 3:
        raise ValueError('umeyama_rigid: expected (N, 3) arrays of the same shape')
    if src.shape[0] < 3:
        raise ValueError('umeyama_rigid: need at least 3 points')
    src_c = src.mean(axis=0)
    dst_c = dst.mean(axis=0)
    P = src - src_c
    Q = dst - dst_c
    H = P.T @ Q
    U, _, Vt = np.linalg.svd(H)
    # Reflection guard.
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    t = dst_c - R @ src_c
    return R, t


def solve(session: CalibrationSession) -> CalibrationResult:
    """Solve the current session. Raises ValueError if under MIN_POINTS."""
    if len(session.points) < MIN_POINTS:
        raise ValueError(f'need at least {MIN_POINTS} points, have {len(session.points)}')
    src = np.array([p.cam_pt   for p in session.points], dtype=np.float64)
    dst = np.array([p.tcp_base for p in session.points], dtype=np.float64)
    R, t = umeyama_rigid(src, dst)
    # Per-point residuals, in meters.
    predicted = (R @ src.T).T + t                # (N, 3)
    resid_m = np.linalg.norm(predicted - dst, axis=1)
    resid_mm = (resid_m * 1000.0).tolist()
    rms_mm = float(np.sqrt(np.mean((resid_m * 1000.0) ** 2)))
    result = CalibrationResult(
        R=[[float(v) for v in row] for row in R.tolist()],
        t=[float(v) for v in t.tolist()],
        rms_mm=rms_mm,
        per_point_mm=resid_mm,
        n_points=len(session.points),
        solved_at=time.time(),
    )
    session.result = result
    return result


def save(session: CalibrationSession,
         path: str = CAM0_EXTRINSIC_YAML) -> str:
    """Persist the solve + the point set. Raises if there's no solve
    yet (never save an unsolved session) or if the RMS is worse than
    the accept threshold (never persist a bad fit)."""
    if session.result is None:
        raise ValueError('no solve to save — call solve() first')
    if session.result.rms_mm >= RMS_ACCEPT_MM:
        raise ValueError(
            f'RMS {session.result.rms_mm:.2f} mm exceeds accept threshold '
            f'{RMS_ACCEPT_MM:.1f} mm — recollect points or drop the worst outlier')
    payload = {
        'R':       session.result.R,
        't':       session.result.t,
        'rms_mm':  session.result.rms_mm,
        'date':    time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(session.result.solved_at)),
        'n_points': session.result.n_points,
        'points':  [
            {'tcp': p.tcp_base, 'cam': p.cam_pt, 'idx': p.idx,
             'captured_at': p.captured_at, 'label': p.label}
            for p in session.points
        ],
        # For downstream tf_broadcaster + hover-validation flows.
        'frame_from': 'cam0_color_optical_frame',
        'frame_to':   'base_link',
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        yaml.safe_dump(payload, f, default_flow_style=False, sort_keys=False)
    os.replace(tmp, path)
    session.saved_at = time.time()
    return path


def load(path: str = CAM0_EXTRINSIC_YAML) -> Optional[dict]:
    """Read the persisted calibration or return None if absent. Used
    by TF broadcast + hover validation."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path) as f:
            return yaml.safe_load(f)
    except Exception:
        return None


def transform_cam_to_base(cam_pt, R, t):
    """Apply the persisted transform to a single point in cam0
    frame, returning its base-frame coordinates. `cam_pt` is a
    3-vec (list, tuple, or ndarray); R is 3x3; t is a 3-vec.

    Used by the hover-validation flow and, eventually, by the
    pick_at_detection step's snapshot-at-run.
    """
    R = np.asarray(R, dtype=np.float64).reshape(3, 3)
    t = np.asarray(t, dtype=np.float64).reshape(3)
    p = np.asarray(cam_pt, dtype=np.float64).reshape(3)
    return (R @ p + t).tolist()

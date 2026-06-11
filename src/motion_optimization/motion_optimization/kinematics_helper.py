"""Forward/inverse kinematics helpers (skeleton until URDF arrives).

When the Estun URDF lands at /opt/cobot/models/estun_s10_140.urdf, swap the
identity functions here for an actual chain solver (e.g., kdl_parser,
ikpy, or trac_ik). Until then we expose pass-through APIs so the rest of
the pipeline still runs in joint space.
"""
from __future__ import annotations

import os
from typing import List, Optional, Tuple

import numpy as np


URDF_PATH = '/opt/cobot/models/estun_s10_140.urdf'


def urdf_available() -> bool:
    return os.path.isfile(URDF_PATH)


def joint_count() -> int:
    return 6  # Estun S10-140 ECO


def fk_tcp(joint_positions_rad: List[float]
           ) -> Optional[Tuple[float, float, float]]:
    """Forward kinematics → TCP xyz. Returns None until URDF is loaded."""
    if not urdf_available():
        return None
    # Placeholder. With URDF available, plug in a real FK solver here.
    return (0.0, 0.0, 0.0)


def ik_tcp(target_xyz: Tuple[float, float, float],
           seed_joints_rad: Optional[List[float]] = None
           ) -> Optional[List[float]]:
    """Inverse kinematics → joint solution. Returns None until URDF is loaded."""
    if not urdf_available():
        return None
    return seed_joints_rad or [0.0] * joint_count()


def linear_interpolate_joints(start_rad: List[float],
                              goal_rad: List[float],
                              n_steps: int = 10
                              ) -> np.ndarray:
    """Joint-space linear interpolation (works regardless of URDF)."""
    s = np.asarray(start_rad, dtype=float)
    g = np.asarray(goal_rad, dtype=float)
    if s.shape != g.shape:
        raise ValueError('start/goal dimensions disagree')
    n_steps = max(2, int(n_steps))
    alphas = np.linspace(0.0, 1.0, n_steps)
    return s + alphas[:, None] * (g - s)

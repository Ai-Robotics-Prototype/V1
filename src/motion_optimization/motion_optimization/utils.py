"""Shared helpers for motion_optimization."""
from __future__ import annotations

import math
from typing import Iterable, List, Sequence

import numpy as np


DEG_TO_RAD = math.pi / 180.0
RAD_TO_DEG = 180.0 / math.pi


def waypoints_from_trajectory(trajectory) -> np.ndarray:
    """Extract joint positions from a trajectory_msgs/JointTrajectory.

    Returns an (N, J) float array in radians.
    """
    if not trajectory.points:
        return np.zeros((0, 0), dtype=float)
    return np.asarray([list(p.positions) for p in trajectory.points], dtype=float)


def trajectory_duration(trajectory) -> float:
    """Total duration of a JointTrajectory in seconds (0 if empty)."""
    if not trajectory.points:
        return 0.0
    last = trajectory.points[-1].time_from_start
    return float(last.sec) + float(last.nanosec) * 1e-9


def filter_duplicate_waypoints(
    waypoints: np.ndarray, atol: float = 1e-4
) -> np.ndarray:
    """Drop consecutive waypoints whose joint-space distance is below atol."""
    if waypoints.shape[0] <= 1:
        return waypoints
    keep = [0]
    for i in range(1, waypoints.shape[0]):
        if np.linalg.norm(waypoints[i] - waypoints[keep[-1]]) > atol:
            keep.append(i)
    return waypoints[keep]


def scaled_limits(
    base_limits: Sequence[float], scale_pct: float
) -> List[float]:
    """Scale per-joint limits by a percentage (0-100). Clamps non-negative."""
    s = max(0.0, min(100.0, float(scale_pct))) / 100.0
    return [max(1e-6, float(v) * s) for v in base_limits]


def per_segment_distances(waypoints: np.ndarray) -> np.ndarray:
    """L2 distances between successive joint configurations (degrees)."""
    if waypoints.shape[0] < 2:
        return np.zeros((0,), dtype=float)
    diffs = np.diff(waypoints, axis=0)
    return np.linalg.norm(diffs, axis=1) * RAD_TO_DEG


def detect_joint_discontinuities(
    waypoints: np.ndarray, jump_deg: float = 90.0
) -> List[int]:
    """Indices where any single joint moves more than jump_deg in one step.

    Used to flag wrist-flip-style discontinuities that smoothers should not
    silently optimize away.
    """
    if waypoints.shape[0] < 2:
        return []
    diffs_deg = np.abs(np.diff(waypoints, axis=0)) * RAD_TO_DEG
    return [i for i in range(diffs_deg.shape[0]) if (diffs_deg[i] > jump_deg).any()]


def peak_metrics(positions: np.ndarray, times: np.ndarray):
    """Return (peak_velocity_dps, peak_acceleration_dps2, peak_jerk_dps3)."""
    if positions.shape[0] < 2 or times.shape[0] < 2:
        return 0.0, 0.0, 0.0
    dt = np.diff(times)
    dt = np.where(dt <= 0, 1e-6, dt)
    vel = np.diff(positions, axis=0) / dt[:, None]
    peak_v = float(np.max(np.abs(vel)) * RAD_TO_DEG)
    if vel.shape[0] < 2:
        return peak_v, 0.0, 0.0
    acc = np.diff(vel, axis=0) / dt[1:, None]
    peak_a = float(np.max(np.abs(acc)) * RAD_TO_DEG)
    if acc.shape[0] < 2:
        return peak_v, peak_a, 0.0
    jrk = np.diff(acc, axis=0) / dt[2:, None]
    peak_j = float(np.max(np.abs(jrk)) * RAD_TO_DEG)
    return peak_v, peak_a, peak_j


def sec_nanosec(seconds: float):
    """Convert a float second value to (sec, nanosec) ints for builtin_interfaces/Duration."""
    if not math.isfinite(seconds) or seconds < 0:
        seconds = 0.0
    sec = int(seconds)
    nanosec = int(round((seconds - sec) * 1e9))
    if nanosec >= 1_000_000_000:
        sec += 1
        nanosec -= 1_000_000_000
    return sec, nanosec


def iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

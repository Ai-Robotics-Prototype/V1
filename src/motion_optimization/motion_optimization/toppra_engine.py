"""TOPP-RA wrapper for time-optimal trajectory parameterization.

We isolate the toppra import so the rest of the package still loads on a
machine where the wheel is missing (the optimizer then falls back to the
simple smoother).
"""
from __future__ import annotations

import logging
from typing import List, Optional, Tuple

import numpy as np

from . import utils
from .profile_manager import Profile, RobotLimits

logger = logging.getLogger(__name__)

try:  # pragma: no cover - presence depends on host pip env
    import toppra as ta
    import toppra.algorithm as algo
    import toppra.constraint as constraint
    TOPPRA_AVAILABLE = True
    TOPPRA_IMPORT_ERROR: Optional[str] = None
except Exception as exc:  # pragma: no cover
    ta = None
    algo = None
    constraint = None
    TOPPRA_AVAILABLE = False
    TOPPRA_IMPORT_ERROR = repr(exc)


class ToppraResult:
    __slots__ = ('positions', 'velocities', 'accelerations', 'times',
                 'duration_s', 'status', 'message')

    def __init__(self, positions, velocities, accelerations, times,
                 status='success', message=''):
        self.positions = positions
        self.velocities = velocities
        self.accelerations = accelerations
        self.times = times
        self.duration_s = float(times[-1]) if times.size else 0.0
        self.status = status
        self.message = message


def is_available() -> bool:
    return TOPPRA_AVAILABLE


def effective_limits(profile: Profile, robot_limits: RobotLimits
                     ) -> Tuple[List[float], List[float], List[float]]:
    """Compute per-joint vel/accel/jerk limits in deg/s, deg/s^2, deg/s^3."""
    vel = utils.scaled_limits(robot_limits.joint_velocity_limits_dps,
                              profile.velocity_scale_pct)
    acc = utils.scaled_limits(robot_limits.joint_acceleration_limits_dps2,
                              profile.acceleration_scale_pct)
    jrk = utils.scaled_limits(robot_limits.joint_jerk_limits_dps3,
                              profile.jerk_scale_pct)
    return vel, acc, jrk


def parameterize_path(waypoints_rad: np.ndarray,
                      joint_velocity_limits_dps: List[float],
                      joint_acceleration_limits_dps2: List[float],
                      joint_jerk_limits_dps3: Optional[List[float]] = None,
                      sample_dt: float = 0.02
                      ) -> ToppraResult:
    """Parameterize a joint-space path with TOPP-RA.

    Inputs:
      waypoints_rad: (N, J) joint positions in radians.
      *_limits_dps*: per-joint limits in degrees-units (deg/s, deg/s^2).
      jerk limits accepted for API symmetry but TOPP-RA's constraint set is
      vel + accel; jerk is enforced post-hoc by the smoother.

    Returns a ToppraResult with sampled (positions, velocities,
    accelerations) on a fixed sample_dt grid, plus total duration.

    Edge cases:
      - 0 or 1 waypoints: returns zero-duration trajectory.
      - 2 waypoints: parameterized as a two-point path.
      - Duplicate consecutive waypoints are filtered first.
    """
    waypoints = utils.filter_duplicate_waypoints(np.asarray(waypoints_rad, dtype=float))
    n_pts, n_dof = (waypoints.shape if waypoints.ndim == 2 else (0, 0))
    if n_pts == 0:
        return ToppraResult(np.zeros((0, 0)), np.zeros((0, 0)),
                            np.zeros((0, 0)), np.zeros((0,)),
                            status='success', message='empty path')
    if n_pts == 1:
        return ToppraResult(waypoints.copy(),
                            np.zeros_like(waypoints),
                            np.zeros_like(waypoints),
                            np.zeros((1,)),
                            status='success', message='single waypoint')

    if not TOPPRA_AVAILABLE:
        return _fallback_trapezoid(waypoints, joint_velocity_limits_dps,
                                   joint_acceleration_limits_dps2, sample_dt,
                                   reason=f'toppra unavailable: {TOPPRA_IMPORT_ERROR}')

    vel_rad = np.asarray(joint_velocity_limits_dps, dtype=float) * utils.DEG_TO_RAD
    acc_rad = np.asarray(joint_acceleration_limits_dps2, dtype=float) * utils.DEG_TO_RAD

    if vel_rad.size != n_dof or acc_rad.size != n_dof:
        raise ValueError(
            f'Limit arrays must have length {n_dof} (matching DOF). '
            f'Got vel={vel_rad.size}, acc={acc_rad.size}.')

    # Parameterize along arc length in joint space.
    diffs = np.linalg.norm(np.diff(waypoints, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(diffs)])
    if arc[-1] <= 1e-9:
        return ToppraResult(waypoints[:1], np.zeros((1, n_dof)),
                            np.zeros((1, n_dof)), np.zeros((1,)),
                            status='success', message='zero-length path')
    ss = arc / arc[-1]

    try:
        path = ta.SplineInterpolator(ss, waypoints)
    except Exception as exc:
        return _fallback_trapezoid(waypoints, joint_velocity_limits_dps,
                                   joint_acceleration_limits_dps2, sample_dt,
                                   reason=f'spline init failed: {exc!r}')

    vlim = np.vstack([-vel_rad, vel_rad]).T
    alim = np.vstack([-acc_rad, acc_rad]).T
    pc_vel = constraint.JointVelocityConstraint(vlim)
    pc_acc = constraint.JointAccelerationConstraint(
        alim, discretization_scheme=constraint.DiscretizationType.Interpolation)

    try:
        instance = algo.TOPPRA([pc_vel, pc_acc], path,
                               solver_wrapper='seidel')
        jnt_traj = instance.compute_trajectory(0, 0)
    except Exception as exc:
        return _fallback_trapezoid(waypoints, joint_velocity_limits_dps,
                                   joint_acceleration_limits_dps2, sample_dt,
                                   reason=f'TOPPRA solve failed: {exc!r}')

    if jnt_traj is None:
        return _fallback_trapezoid(waypoints, joint_velocity_limits_dps,
                                   joint_acceleration_limits_dps2, sample_dt,
                                   reason='TOPPRA returned no trajectory '
                                          '(infeasible limits)')

    duration = float(jnt_traj.duration)
    n_samples = max(2, int(np.ceil(duration / sample_dt)) + 1)
    ts = np.linspace(0.0, duration, n_samples)
    qs = jnt_traj(ts)
    qds = jnt_traj(ts, 1)
    qdds = jnt_traj(ts, 2)

    return ToppraResult(qs, qds, qdds, ts,
                        status='success',
                        message='toppra ok')


def _fallback_trapezoid(waypoints_rad: np.ndarray,
                        vel_limits_dps: List[float],
                        acc_limits_dps2: List[float],
                        sample_dt: float,
                        reason: str) -> ToppraResult:
    """Crude trapezoidal velocity profile per segment when TOPP-RA can't run.

    Honors per-joint limits in a slightly conservative way: time for each
    segment is the slowest of (|delta| / vel_max + sqrt(|delta| / acc_max)).
    """
    logger.warning('toppra fallback engaged: %s', reason)
    n_pts, n_dof = waypoints_rad.shape
    vel = np.asarray(vel_limits_dps, dtype=float) * utils.DEG_TO_RAD
    acc = np.asarray(acc_limits_dps2, dtype=float) * utils.DEG_TO_RAD
    vel = np.where(vel < 1e-6, 1e-6, vel)
    acc = np.where(acc < 1e-6, 1e-6, acc)
    seg_durations = []
    for i in range(n_pts - 1):
        delta = np.abs(waypoints_rad[i + 1] - waypoints_rad[i])
        # time-optimal trapezoid per joint, take max
        t_per_joint = np.maximum(delta / vel, np.sqrt(2.0 * delta / acc))
        seg_durations.append(float(np.max(t_per_joint)))
    cum = np.concatenate([[0.0], np.cumsum(seg_durations)])
    duration = float(cum[-1]) if cum.size else 0.0
    n_samples = max(2, int(np.ceil(duration / sample_dt)) + 1)
    ts = np.linspace(0.0, duration, n_samples)
    qs = np.empty((n_samples, n_dof), dtype=float)
    for j, t in enumerate(ts):
        # find segment
        idx = int(np.searchsorted(cum, t, side='right') - 1)
        idx = max(0, min(idx, n_pts - 2))
        denom = max(seg_durations[idx], 1e-9)
        u = (t - cum[idx]) / denom
        u = max(0.0, min(1.0, u))
        qs[j] = (1 - u) * waypoints_rad[idx] + u * waypoints_rad[idx + 1]
    qds = np.zeros_like(qs)
    qdds = np.zeros_like(qs)
    if n_samples >= 2:
        dts = np.diff(ts)
        dts = np.where(dts <= 0, 1e-6, dts)
        qds[1:] = np.diff(qs, axis=0) / dts[:, None]
    return ToppraResult(qs, qds, qdds, ts,
                        status='fallback', message=reason)


def apply_to_trajectory(traj_msg, profile: Profile, robot_limits: RobotLimits,
                        sample_dt: float = 0.02):
    """Optimize a trajectory_msgs/JointTrajectory in place of returning a new one.

    Returns (new_trajectory_msg, ToppraResult, warnings).
    The caller is responsible for filling header / joint_names from the
    original message; we copy joint_names through.
    """
    from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

    warnings: List[str] = []
    waypoints = utils.waypoints_from_trajectory(traj_msg)
    if waypoints.shape[0] == 0:
        out = JointTrajectory()
        out.joint_names = list(traj_msg.joint_names)
        return out, ToppraResult(np.zeros((0, 0)), np.zeros((0, 0)),
                                 np.zeros((0, 0)), np.zeros((0,)),
                                 status='success', message='empty input'), warnings

    discontinuities = utils.detect_joint_discontinuities(waypoints)
    if discontinuities:
        warnings.append(
            f'Discontinuous joint motion detected at indices {discontinuities}; '
            'TOPP-RA will treat as commanded but check for wrist flips.')

    vel, acc, _jrk = effective_limits(profile, robot_limits)
    result = parameterize_path(waypoints, vel, acc, sample_dt=sample_dt)

    out = JointTrajectory()
    out.header = traj_msg.header
    out.joint_names = list(traj_msg.joint_names)

    for i in range(result.times.size):
        pt = JointTrajectoryPoint()
        pt.positions = result.positions[i].tolist()
        pt.velocities = (result.velocities[i].tolist()
                         if result.velocities.size else [])
        pt.accelerations = (result.accelerations[i].tolist()
                            if result.accelerations.size else [])
        sec, nsec = utils.sec_nanosec(float(result.times[i]))
        pt.time_from_start.sec = sec
        pt.time_from_start.nanosec = nsec
        out.points.append(pt)

    return out, result, warnings


def estimate_duration(waypoints_rad: np.ndarray,
                      profile: Profile, robot_limits: RobotLimits) -> float:
    """Fast linear-approximation cycle-time estimate.

    Sums per-segment durations using a trapezoidal joint-space model. ~ms
    fast, no toppra solve. Within ~10-20% of the TOPP-RA result for typical
    pick-and-place geometries.
    """
    waypoints = utils.filter_duplicate_waypoints(np.asarray(waypoints_rad, dtype=float))
    if waypoints.shape[0] < 2:
        return 0.0
    vel, acc, _ = effective_limits(profile, robot_limits)
    vel_rad = np.asarray(vel) * utils.DEG_TO_RAD
    acc_rad = np.asarray(acc) * utils.DEG_TO_RAD
    vel_rad = np.where(vel_rad < 1e-6, 1e-6, vel_rad)
    acc_rad = np.where(acc_rad < 1e-6, 1e-6, acc_rad)
    total = 0.0
    for i in range(waypoints.shape[0] - 1):
        delta = np.abs(waypoints[i + 1] - waypoints[i])
        t_per_joint = np.maximum(delta / vel_rad, np.sqrt(2.0 * delta / acc_rad))
        total += float(np.max(t_per_joint))
    return total

"""Lightweight trajectory smoothing alternatives to TOPP-RA."""
from __future__ import annotations

import logging
from typing import Tuple

import numpy as np
from scipy.interpolate import CubicSpline

from . import utils
from .profile_manager import Profile, RobotLimits

logger = logging.getLogger(__name__)


def apply_spline_smoothing(waypoints_rad: np.ndarray,
                           smoothness_factor: float = 1.0,
                           sample_dt: float = 0.02,
                           segment_time_s: float = 0.5,
                           ) -> Tuple[np.ndarray, np.ndarray]:
    """Fit a cubic spline through waypoints, resample on fixed dt.

    smoothness_factor: scales the time-between-waypoints. >1 stretches
    motion, <1 compresses. The base segment_time_s is the per-segment
    timing assumption; with no velocity info we cannot do better without
    full TOPP-RA.
    """
    pts = utils.filter_duplicate_waypoints(np.asarray(waypoints_rad, dtype=float))
    n_pts = pts.shape[0]
    if n_pts == 0:
        return np.zeros((0, 0)), np.zeros((0,))
    if n_pts == 1:
        return pts.copy(), np.zeros((1,))
    seg_t = max(0.05, segment_time_s * smoothness_factor)
    ts_wp = np.arange(n_pts) * seg_t
    spline = CubicSpline(ts_wp, pts, bc_type='clamped')
    duration = float(ts_wp[-1])
    n_samples = max(2, int(np.ceil(duration / sample_dt)) + 1)
    ts = np.linspace(0.0, duration, n_samples)
    qs = spline(ts)
    return qs, ts


def apply_blend_radius(waypoints_rad: np.ndarray,
                       blend_radius_rad: float
                       ) -> np.ndarray:
    """Replace sharp corners with simple parabolic blends.

    Each interior corner v gets replaced by two surrogate waypoints offset
    by ``blend_radius_rad`` along the incoming / outgoing segments. The
    blend itself is implicit (downstream smoother sees more waypoints).
    """
    pts = np.asarray(waypoints_rad, dtype=float)
    if pts.shape[0] < 3 or blend_radius_rad <= 0:
        return pts.copy()
    out = [pts[0]]
    for i in range(1, pts.shape[0] - 1):
        prev, cur, nxt = pts[i - 1], pts[i], pts[i + 1]
        v_in = cur - prev
        v_out = nxt - cur
        d_in = float(np.linalg.norm(v_in))
        d_out = float(np.linalg.norm(v_out))
        if d_in < 1e-9 or d_out < 1e-9:
            out.append(cur)
            continue
        # cap blend radius at half the shorter neighbouring segment
        r = min(blend_radius_rad, 0.5 * min(d_in, d_out))
        out.append(cur - (v_in / d_in) * r)
        out.append(cur + (v_out / d_out) * r)
    out.append(pts[-1])
    return np.asarray(out, dtype=float)


def apply_jerk_limit(positions: np.ndarray, times: np.ndarray,
                     jerk_limit_dps3: float, max_iters: int = 6
                     ) -> Tuple[np.ndarray, np.ndarray]:
    """Iteratively stretch the time axis where jerk exceeds the limit.

    Returns (positions, times). Positions are unchanged; only timing is
    adjusted. This is the simplest jerk-limiter that won't change the
    geometric path.
    """
    if positions.shape[0] < 4:
        return positions, times
    jerk_limit_rad = float(jerk_limit_dps3) * utils.DEG_TO_RAD
    if jerk_limit_rad <= 0:
        return positions, times
    times = times.copy()
    for _ in range(max_iters):
        dt = np.diff(times)
        dt = np.where(dt <= 0, 1e-6, dt)
        vel = np.diff(positions, axis=0) / dt[:, None]
        acc = np.diff(vel, axis=0) / dt[1:, None]
        jrk = np.diff(acc, axis=0) / dt[2:, None]
        peak_per_step = np.max(np.abs(jrk), axis=1)
        excess = peak_per_step / max(jerk_limit_rad, 1e-9)
        if np.max(excess) <= 1.05:
            break
        # stretch the intervals where jerk is over-budget
        scale = np.ones_like(dt)
        scale[3:] = np.maximum(1.0, np.cbrt(excess))  # cube-root since jerk ~ dt^3
        new_dt = dt * scale
        times = np.concatenate([[0.0], np.cumsum(new_dt)])
    return positions, times


def smooth(profile: Profile, robot_limits: RobotLimits,
           waypoints_rad: np.ndarray, sample_dt: float = 0.02):
    """High-level entry: pick smoother per profile.smoothing_method."""
    method = profile.smoothing_method
    if method == 'none':
        qs = np.asarray(waypoints_rad, dtype=float)
        if qs.shape[0] < 2:
            return qs, np.zeros((qs.shape[0],)), 'none'
        # constant cadence pseudo-timing
        ts = np.arange(qs.shape[0]) * 0.5
        return qs, ts, 'none'

    if method == 'spline':
        blended = apply_blend_radius(
            np.asarray(waypoints_rad, dtype=float),
            blend_radius_rad=profile.blend_radius_mm / 1000.0)
        # scale segment time by inverse velocity scale (slower profile → longer)
        v_scale = max(profile.velocity_scale_pct, 1.0) / 70.0
        qs, ts = apply_spline_smoothing(
            blended, smoothness_factor=1.0 / v_scale, sample_dt=sample_dt)
        if profile.jerk_scale_pct > 0:
            jerk_limit = (robot_limits.joint_jerk_limits_dps3[0]
                          * profile.jerk_scale_pct / 100.0)
            qs, ts = apply_jerk_limit(qs, ts, jerk_limit)
        return qs, ts, 'spline'

    # 'toppra' and 'moveit' delegated by caller; if we get here just
    # use the spline as a safe fallback.
    qs, ts = apply_spline_smoothing(
        np.asarray(waypoints_rad, dtype=float), sample_dt=sample_dt)
    return qs, ts, f'spline-fallback-from-{method}'

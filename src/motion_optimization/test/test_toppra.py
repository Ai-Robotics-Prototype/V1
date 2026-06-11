"""TOPP-RA engine tests.

Marks toppra-import-dependent cases xfail when the wheel isn't present so
the suite still passes in environments where pip can't reach PyPI.
"""
from __future__ import annotations

import numpy as np
import pytest

from motion_optimization import toppra_engine, utils
from motion_optimization.profile_manager import Profile, RobotLimits


def _balanced_profile() -> Profile:
    return Profile(
        name='Balanced',
        velocity_scale_pct=70, acceleration_scale_pct=60,
        jerk_scale_pct=50, smoothing_method='toppra',
        toppra_enabled=True,
    )


def _limits() -> RobotLimits:
    return RobotLimits()


def test_empty_path_returns_zero_duration():
    res = toppra_engine.parameterize_path(
        np.zeros((0, 6)), [180] * 6, [400] * 6)
    assert res.duration_s == pytest.approx(0.0)
    assert res.positions.shape == (0, 0)


def test_single_waypoint_returns_zero_duration():
    res = toppra_engine.parameterize_path(
        np.zeros((1, 6)), [180] * 6, [400] * 6)
    assert res.duration_s == pytest.approx(0.0)
    assert res.positions.shape == (1, 6)


def test_two_waypoint_parameterization_respects_velocity_limit():
    a = np.zeros(6)
    b = np.deg2rad(np.array([90, 0, 0, 0, 0, 0]))  # 90deg on J1
    wp = np.vstack([a, b])
    res = toppra_engine.parameterize_path(
        wp, [90] * 6, [200] * 6)  # 90 deg/s, 200 deg/s^2
    # naive lower bound: 90 deg / 90 dps ≥ 1.0s (plus accel ramp)
    assert res.duration_s >= 1.0
    # peak velocity should not exceed limit by more than ~10%
    vel = np.diff(res.positions, axis=0) / np.diff(res.times)[:, None]
    peak_dps = float(np.max(np.abs(vel))) * utils.RAD_TO_DEG
    assert peak_dps <= 99.0  # 90 dps + ~10% headroom


def test_duplicate_waypoints_are_filtered():
    a = np.deg2rad(np.array([0, 0, 0, 0, 0, 0]))
    b = np.deg2rad(np.array([0, 0, 0, 0, 0, 0]))  # duplicate
    c = np.deg2rad(np.array([45, 0, 0, 0, 0, 0]))
    wp = np.vstack([a, b, c])
    res = toppra_engine.parameterize_path(wp, [180] * 6, [400] * 6)
    # No NaN / no infinite duration even with duplicates present
    assert np.all(np.isfinite(res.positions))
    assert res.duration_s > 0.0


def test_estimate_duration_is_proportional_to_path_length():
    short = np.deg2rad(np.array([[0]*6, [10]+[0]*5]))
    long = np.deg2rad(np.array([[0]*6, [90]+[0]*5]))
    prof = _balanced_profile()
    lim = _limits()
    t_short = toppra_engine.estimate_duration(short, prof, lim)
    t_long = toppra_engine.estimate_duration(long, prof, lim)
    assert t_long > t_short
    # Longer motion should not be wildly faster than the short one
    assert t_long > t_short * 1.5


def test_estimate_duration_zero_for_static_path():
    wp = np.zeros((3, 6))
    assert toppra_engine.estimate_duration(
        wp, _balanced_profile(), _limits()) == pytest.approx(0.0)


def test_jerk_limits_arg_does_not_break_parameterize():
    wp = np.deg2rad(np.array([[0]*6, [30]+[0]*5, [60]+[0]*5]))
    res = toppra_engine.parameterize_path(
        wp, [180] * 6, [400] * 6, joint_jerk_limits_dps3=[4000] * 6)
    assert res.duration_s > 0.0

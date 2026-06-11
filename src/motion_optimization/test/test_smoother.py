"""Trajectory smoother tests (no toppra dependency)."""
from __future__ import annotations

import numpy as np

from motion_optimization import trajectory_smoother as ts


def test_spline_smoothing_returns_monotone_time_axis():
    wp = np.deg2rad(np.array([[0]*6, [30]*6, [-15]*6, [45]*6]))
    qs, times = ts.apply_spline_smoothing(wp)
    assert qs.shape[0] >= wp.shape[0]
    assert np.all(np.diff(times) > 0)


def test_blend_radius_preserves_endpoints():
    wp = np.deg2rad(np.array([[0]*6, [30]*6, [-15]*6, [45]*6]))
    out = ts.apply_blend_radius(wp, blend_radius_rad=0.05)
    assert np.allclose(out[0], wp[0])
    assert np.allclose(out[-1], wp[-1])
    # Interior corners were softened with two surrogate waypoints each.
    assert out.shape[0] >= wp.shape[0]


def test_blend_radius_zero_is_identity():
    wp = np.deg2rad(np.array([[0]*6, [30]*6, [-15]*6, [45]*6]))
    out = ts.apply_blend_radius(wp, blend_radius_rad=0.0)
    assert np.array_equal(out, wp)


def test_apply_jerk_limit_does_not_change_geometry():
    qs = np.deg2rad(np.tile(np.linspace(0, 90, 20), (6, 1)).T)
    ts_arr = np.linspace(0, 2.0, 20)
    qs_out, ts_out = ts.apply_jerk_limit(qs, ts_arr, jerk_limit_dps3=2000.0)
    assert np.allclose(qs_out, qs)
    # Time axis may stretch but must remain monotonic.
    assert np.all(np.diff(ts_out) > 0)

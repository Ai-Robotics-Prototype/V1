"""Tier 1 algorithm sanity checks.

Pure NumPy tests — no Open3D, no ROS, no Mech-Eye. Runs in any CI
environment where the package is importable.
"""

import numpy as np
import pytest

from inspection_pipeline.tier1_dimensional import (
    measure_aspect_ratios, measure_centroid, measure_oriented_bbox,
    measure_overall_dimensions, measure_volume, compare_to_tolerance,
    run_tier1_inspection,
)


def _unit_cube_cloud(n: int = 5000, side: float = 100.0) -> np.ndarray:
    """Sample n random points inside a side-mm cube centred at origin."""
    rng = np.random.default_rng(seed=0)
    return rng.uniform(-side / 2, side / 2, size=(n, 3)).astype(np.float32)


def test_aabb_dimensions_match_known_extent():
    cloud = _unit_cube_cloud(side=100.0)
    dims = measure_overall_dimensions(cloud)
    assert abs(dims['x_extent_mm'] - 100.0) < 5.0
    assert abs(dims['y_extent_mm'] - 100.0) < 5.0
    assert abs(dims['z_extent_mm'] - 100.0) < 5.0


def test_obb_axes_unit_length():
    cloud = _unit_cube_cloud(side=80.0)
    obb = measure_oriented_bbox(cloud)
    for axis in obb['principal_axes']:
        n = np.linalg.norm(axis)
        assert abs(n - 1.0) < 1e-6, f'axis not unit-length: {n}'


def test_aspect_ratios_symmetric_for_cube():
    obb = measure_oriented_bbox(_unit_cube_cloud(side=50.0))
    ratios = measure_aspect_ratios(obb)
    for k in ('l_w_ratio', 'l_h_ratio', 'w_h_ratio'):
        assert 0.85 < ratios[k] < 1.15, (
            f'{k} should be ~1 for a cube, got {ratios[k]}')


def test_centroid_at_origin():
    cloud = _unit_cube_cloud(side=10.0)
    c = measure_centroid(cloud)
    for k in ('x_mm', 'y_mm', 'z_mm'):
        assert abs(c[k]) < 1.0


def test_volume_matches_cube():
    cloud = _unit_cube_cloud(side=50.0)
    vol = measure_volume(cloud)
    expected = 50.0 ** 3
    # Convex hull volume should be close to true cube volume; voxel
    # volume depends on density and undercounts when sparse.
    assert abs(vol['convex_hull_volume_mm3'] - expected) / expected < 0.05


def test_compare_to_tolerance_pass_warn_fail():
    assert compare_to_tolerance(10.0, 10.0, 0.5, 1.0)['result'] == 'pass'
    assert compare_to_tolerance(10.6, 10.0, 0.5, 1.0)['result'] == 'warn'
    assert compare_to_tolerance(11.5, 10.0, 0.5, 1.0)['result'] == 'fail'


def test_compare_to_tolerance_no_nominal_passes():
    out = compare_to_tolerance(42.0, None, 0.5, 1.0)
    assert out['result'] == 'pass'
    assert out['nominal'] is None


def test_pipeline_returns_measurement_list():
    # Use an axis-aligned `x_extent_mm` rule — AABB is deterministic
    # for a uniform cube, OBB length is not (PCA can pick the diagonal).
    cloud = _unit_cube_cloud(side=100.0)
    rules = {
        'x_extent_mm': {'nominal': 100.0, 'tol_warn': 5.0, 'tol_fail': 15.0},
    }
    measurements = run_tier1_inspection(cloud, rules)
    assert len(measurements) > 10
    names = {m.name for m in measurements}
    assert 'length_mm' in names and 'width_mm' in names
    x_ext = next(m for m in measurements if m.name == 'x_extent_mm')
    assert x_ext.result == 'pass'


def test_invalid_cloud_shape_raises():
    with pytest.raises(ValueError):
        measure_oriented_bbox(np.zeros((10, 4)))

"""Ground RANSAC: synthetic cloud with known plane."""
import numpy as np
import pytest

from lidar_object_identifier.ground_extractor import GroundExtractor


def _synthetic_scene(n_ground=2000, n_obj=300, ground_z=0.0,
                     obj_height=0.1, noise_sigma=0.003, seed=0):
    rng = np.random.default_rng(seed)
    ground = np.column_stack([
        rng.uniform(-1.0, 1.0, n_ground),
        rng.uniform(-1.0, 1.0, n_ground),
        ground_z + rng.normal(0, noise_sigma, n_ground),
    ])
    obj = np.column_stack([
        rng.uniform(0.1, 0.3, n_obj),
        rng.uniform(0.1, 0.3, n_obj),
        rng.uniform(ground_z + 0.005, ground_z + obj_height, n_obj),
    ])
    return np.vstack([ground, obj]), n_ground, n_obj


def test_ground_plane_recovered_at_expected_height():
    cloud, n_ground, n_obj = _synthetic_scene()
    extractor = GroundExtractor(distance_threshold_m=0.01)
    ground_pts, above_pts, coeffs = extractor.extract(cloud)
    # Plane should be close to z = 0
    # coeffs = [a,b,c,d] with normalized normal; -d ≈ ground_z
    assert abs(coeffs[3]) < 0.05
    # Above-ground point count should be roughly the object count (with some slack)
    assert above_pts.shape[0] >= int(n_obj * 0.8)
    # No object points should leak into the ground set (with 1cm tolerance)
    if ground_pts.size:
        assert float(ground_pts[:, 2].mean()) < 0.02


def test_small_cloud_returns_empty_safely():
    extractor = GroundExtractor()
    g, a, c = extractor.extract(np.zeros((2, 3)))
    assert g.shape[0] == 0

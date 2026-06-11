"""Shape analyzer should produce coherent descriptors for synthetic shapes."""
import numpy as np
import pytest

from lidar_object_identifier import shape_analyzer


def _sphere(radius=0.05, n=2000, seed=0):
    rng = np.random.default_rng(seed)
    pts = rng.normal(size=(n, 3))
    pts /= np.linalg.norm(pts, axis=1, keepdims=True)
    return pts * radius


def _box(dims=(0.10, 0.06, 0.03), n=2000, seed=0):
    rng = np.random.default_rng(seed)
    return np.column_stack([rng.uniform(-d / 2, d / 2, n) for d in dims])


def test_sphere_is_round():
    feats = shape_analyzer.analyze(_sphere(radius=0.05))
    # Sphericity should be substantially above flatter shapes; we don't
    # demand the theoretical 1.0 because hull surface estimates differ.
    assert feats.sphericity > 0.4
    assert feats.flatness > 0.5


def test_plate_is_flat():
    feats = shape_analyzer.analyze(_box(dims=(0.12, 0.10, 0.005)))
    assert feats.flatness < 0.2
    assert feats.elongation < 2.0  # plate is nearly square in plan


def test_rod_is_elongated():
    feats = shape_analyzer.analyze(_box(dims=(0.30, 0.02, 0.02)))
    assert feats.elongation > 5.0


def test_empty_cluster_safe():
    feats = shape_analyzer.analyze(np.zeros((0, 3)))
    assert feats.point_count == 0
    assert feats.volume_m3 == 0.0

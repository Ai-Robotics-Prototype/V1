"""Clustering: two well-separated boxes should produce 2 clusters."""
import numpy as np

from lidar_object_identifier.object_clusterer import ObjectClusterer


def _box(center, dims, n=600, seed=0):
    rng = np.random.default_rng(seed)
    cx, cy, cz = center
    dx, dy, dz = dims
    return np.column_stack([
        cx + rng.uniform(-dx / 2, dx / 2, n),
        cy + rng.uniform(-dy / 2, dy / 2, n),
        cz + rng.uniform(0, dz, n),
    ])


def test_two_clusters_recovered():
    a = _box((0.0, 0.0, 0.0), (0.10, 0.10, 0.10), seed=1)
    b = _box((1.0, 0.0, 0.0), (0.12, 0.12, 0.12), seed=2)
    pts = np.vstack([a, b])
    clusterer = ObjectClusterer(tolerance_m=0.03, min_points=100,
                                min_volume_m3=1e-6, max_volume_m3=1.0,
                                min_density_per_m3=10.0)
    out = clusterer.cluster(pts)
    assert len(out) == 2
    centroids = sorted([c.centroid[0] for c in out])
    assert centroids[0] < 0.5
    assert centroids[1] > 0.5


def test_clusters_below_min_points_dropped():
    sparse = _box((0.0, 0.0, 0.0), (0.05, 0.05, 0.05), n=10)
    clusterer = ObjectClusterer(tolerance_m=0.05, min_points=50)
    assert len(clusterer.cluster(sparse)) == 0


def test_cable_like_aspect_ratio_rejected():
    # Long thin line, 1000:1 aspect — should fail aspect filter
    rng = np.random.default_rng(0)
    n = 1500
    pts = np.column_stack([
        rng.uniform(0.0, 3.0, n),
        rng.uniform(-0.002, 0.002, n),
        rng.uniform(-0.002, 0.002, n),
    ])
    clusterer = ObjectClusterer(tolerance_m=0.02, min_points=200,
                                max_aspect_ratio=50.0)
    out = clusterer.cluster(pts)
    assert len(out) == 0

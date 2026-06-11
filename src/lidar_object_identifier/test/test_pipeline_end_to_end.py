"""End-to-end sanity: ground → cluster → analyze → match runs without crash.

Doesn't assert the right part is identified (no library on the test
machine), only that no stage drops a cluster that should have made it
through.
"""
import numpy as np

from lidar_object_identifier.ground_extractor import GroundExtractor
from lidar_object_identifier.object_clusterer import ObjectClusterer
from lidar_object_identifier.shape_analyzer import analyze
from lidar_object_identifier.parts_matcher import PartsMatcher
from lidar_object_identifier.persistence_tracker import PersistenceTracker


def _scene():
    rng = np.random.default_rng(42)
    ground = np.column_stack([
        rng.uniform(-1.0, 1.0, 2500),
        rng.uniform(-1.0, 1.0, 2500),
        rng.normal(0.0, 0.003, 2500),
    ])
    bracket = np.column_stack([
        rng.uniform(0.2, 0.32, 800),
        rng.uniform(-0.04, 0.04, 800),
        rng.uniform(0.005, 0.03, 800),
    ])
    return np.vstack([ground, bracket])


def test_full_pipeline_runs():
    pts = _scene()
    ground = GroundExtractor()
    clusterer = ObjectClusterer(tolerance_m=0.03, min_points=200,
                                max_volume_m3=1.0, min_density_per_m3=10.0)
    matcher = PartsMatcher()
    matcher._cache = {}  # no library; we just exercise the call path
    tracker = PersistenceTracker(confirm_streak=2)

    _g, above, _coef = ground.extract(pts)
    clusters = clusterer.cluster(above)
    assert len(clusters) >= 1
    observations = []
    for cl in clusters:
        feats = analyze(cl.points)
        match = matcher.match(feats)
        observations.append({
            'center': feats.center,
            'dimensions': feats.dimensions_m,
            'part_id': match.part_id,
            'confidence': match.overall_score,
        })
    tracks = tracker.step(observations)
    assert len(tracks) == len(observations)

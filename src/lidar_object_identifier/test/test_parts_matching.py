"""Parts matcher tests with a mock parts library."""
import numpy as np
import pytest

from lidar_object_identifier.parts_matcher import (
    PartsMatcher, PartFeatures, _to_metres_sorted)
from lidar_object_identifier.shape_analyzer import analyze


def _make_matcher():
    m = PartsMatcher(size_tolerance_pct=30.0, volume_tolerance_pct=40.0)
    # Inject fake library entries directly (skip part_library import).
    m._cache = {
        'BT225L24': PartFeatures(
            part_id='BT225L24', name='BT225L24',
            dimensions_m_sorted=_to_metres_sorted([12.0, 8.0, 2.5]),
            obb_volume_m3=(0.12 * 0.08 * 0.025),
            extents_cm_raw=[12.0, 8.0, 2.5]),
        'BT225L28': PartFeatures(
            part_id='BT225L28', name='BT225L28',
            dimensions_m_sorted=_to_metres_sorted([14.0, 8.5, 2.5]),
            obb_volume_m3=(0.14 * 0.085 * 0.025),
            extents_cm_raw=[14.0, 8.5, 2.5]),
    }
    m._library_etag = 1.0
    return m


def _cluster_like(dims_cm):
    # Build a uniform box of these dimensions for analyze().
    rng = np.random.default_rng(0)
    dx, dy, dz = [d / 100.0 for d in dims_cm]
    return np.column_stack([
        rng.uniform(-dx / 2, dx / 2, 1500),
        rng.uniform(-dy / 2, dy / 2, 1500),
        rng.uniform(0, dz, 1500),
    ])


def test_in_tolerance_match_picks_correct_part():
    m = _make_matcher()
    cluster = analyze(_cluster_like([11.5, 8.0, 2.5]))
    result = m.match(cluster)
    assert result.part_id == 'BT225L24'
    assert result.overall_score > 0.4


def test_out_of_tolerance_yields_none():
    m = _make_matcher()
    cluster = analyze(_cluster_like([50.0, 5.0, 5.0]))
    result = m.match(cluster)
    assert result.part_id is None


def test_known_parts_count_reflects_cache():
    m = _make_matcher()
    assert m.known_parts() == 2

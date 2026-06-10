"""Tier 2 surface-deviation tests.

Open3D is required for the registration path; tests are marked as
skipped if Open3D is not importable so CI without GPU still runs the
rest of the suite.
"""

import numpy as np
import pytest

from inspection_pipeline.tier2_surface import (
    classify_deviation_severity, compute_deviation_statistics,
    generate_heatmap_rgb, identify_defect_regions,
)


def test_classify_deviation_severity_buckets():
    deviations = np.array([0.0, 0.1, 0.3, 0.6, 1.0])
    out = classify_deviation_severity(deviations, tol_warn_mm=0.2,
                                       tol_fail_mm=0.5)
    # 0.0 / 0.1 < warn → pass(0); 0.3 ≥ warn → warn(1);
    # 0.6 / 1.0 ≥ fail → fail(2)
    assert out.tolist() == [0, 0, 1, 2, 2]


def test_deviation_statistics_shape():
    rng = np.random.default_rng(0)
    deviations = rng.normal(0.0, 0.1, size=1000)
    stats = compute_deviation_statistics(deviations,
                                          tol_warn_mm=0.15,
                                          tol_fail_mm=0.3)
    for k in ('count', 'max', 'mean', 'rms', 'std', 'p95', 'p99',
              'percent_within_tolerance'):
        assert k in stats


def test_heatmap_rgb_colors_extremes():
    devs = np.array([0.0, 0.2, 0.5, 0.8])
    rgb = generate_heatmap_rgb(devs, tol_warn_mm=0.2, tol_fail_mm=0.5)
    # First (0 dev): green; last (over fail): red.
    assert rgb[0, 1] == 255 and rgb[0, 0] == 0
    assert rgb[-1, 0] == 255 and rgb[-1, 1] == 0


def test_identify_defect_regions_empty_when_no_fails():
    cloud = np.zeros((10, 3))
    devs = np.zeros(10)
    classes = np.zeros(10, dtype=np.int8)
    assert identify_defect_regions(devs, classes, cloud) == []


@pytest.mark.skipif(
    not pytest.importorskip('open3d', reason='open3d not installed'),
    reason='open3d not installed',
)
def test_full_pipeline_smoke():
    """End-to-end Tier 2 — only runs if Open3D is installed."""
    from inspection_pipeline.tier2_surface import run_tier2_inspection
    rng = np.random.default_rng(0)
    cloud = rng.uniform(-0.05, 0.05, size=(2000, 3))  # 100 mm cube
    reference = cloud.copy()
    result = run_tier2_inspection(cloud, reference, tol_warn_mm=0.5,
                                   tol_fail_mm=1.0, try_global=False)
    assert result.deviations_mm.shape[0] == cloud.shape[0]
    assert 0.0 <= result.fitness <= 1.0

"""ICP alignment tests — skipped when Open3D is not available."""

import numpy as np
import pytest

open3d = pytest.importorskip('open3d', reason='open3d not installed')

from inspection_pipeline.icp_alignment import (   # noqa: E402
    align_to_reference, transform_cloud,
)


def test_align_recovers_known_translation():
    rng = np.random.default_rng(0)
    source = rng.uniform(-0.05, 0.05, size=(3000, 3))
    # Apply a known 3 mm offset along x.
    translation = np.array([0.003, 0.0, 0.0])
    target = source + translation

    result = align_to_reference(source, target, try_global=False,
                                fine_distance_m=0.01)
    # Recovered translation should match within 1 mm of truth.
    recovered = result.transformation[:3, 3]
    err = np.linalg.norm(recovered - translation)
    assert err < 0.001, f'recovered {recovered} vs truth {translation}'


def test_transform_cloud_identity_unchanged():
    cloud = np.random.default_rng(0).uniform(-1, 1, size=(100, 3))
    out = transform_cloud(cloud, np.eye(4))
    assert np.allclose(out, cloud)

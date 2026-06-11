"""Persistence tracker: spurious clusters never reach CONFIRMED."""
import numpy as np

from lidar_object_identifier.persistence_tracker import PersistenceTracker


def _obs(x, y, part_id='X', conf=0.7):
    return {
        'center': np.array([float(x), float(y), 0.05]),
        'dimensions': np.array([0.1, 0.05, 0.02]),
        'part_id': part_id,
        'confidence': conf,
    }


def test_consistent_object_promotes_to_confirmed():
    t = PersistenceTracker(confirm_streak=3, lost_after=2, drop_after=4)
    for _ in range(3):
        t.step([_obs(0.5, 0.2)])
    tracks = t.step([_obs(0.5, 0.2)])
    assert any(tr.status == 'confirmed' for tr in tracks)


def test_spurious_clusters_never_confirm():
    t = PersistenceTracker(confirm_streak=3, lost_after=1, drop_after=2)
    # A different location each frame → no persistence
    for i in range(8):
        t.step([_obs(0.5 + i * 0.5, 0.2)])
    statuses = [tr.status for tr in t._tracks.values()]
    assert 'confirmed' not in statuses


def test_lost_then_removed():
    t = PersistenceTracker(confirm_streak=2, lost_after=1, drop_after=3)
    for _ in range(2):
        t.step([_obs(0.5, 0.2)])
    # Stop seeing it
    for _ in range(4):
        t.step([])
    assert len(t._tracks) == 0


def test_identity_change_resets_streak():
    t = PersistenceTracker(confirm_streak=3, lost_after=1, drop_after=4)
    for _ in range(3):
        t.step([_obs(0.5, 0.2, part_id='A')])
    # Now identify as B at the same location
    tracks = t.step([_obs(0.5, 0.2, part_id='B')])
    assert tracks[0].part_id == 'B'
    assert tracks[0].consecutive_match == 1

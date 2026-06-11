"""Multi-frame confirmation. Filters spurious clusters by requiring a
match to persist for several cycles before promoting to CONFIRMED."""
from __future__ import annotations

import collections
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class TrackEntry:
    track_id: int
    part_id: Optional[str]
    center: np.ndarray
    dimensions: np.ndarray
    first_seen: float
    last_seen: float
    frames_observed: int = 0
    consecutive_match: int = 0
    cycles_since_lost: int = 0
    status: str = 'tentative'  # 'tentative' / 'confirmed' / 'lost'
    last_confidence: float = 0.0
    observations: List[Dict] = field(default_factory=list)


class PersistenceTracker:
    def __init__(self,
                 buffer_len: int = 10,
                 match_xy_m: float = 0.05,
                 confirm_streak: int = 5,
                 lost_after: int = 3,
                 drop_after: int = 10):
        self.buffer_len = int(buffer_len)
        self.match_xy = float(match_xy_m)
        self.confirm_streak = int(confirm_streak)
        self.lost_after = int(lost_after)
        self.drop_after = int(drop_after)
        self._next_id = 1
        self._tracks: Dict[int, TrackEntry] = {}
        self._history: collections.deque = collections.deque(maxlen=buffer_len)

    def step(self, observations: List[Dict]) -> List[TrackEntry]:
        """observations: list of dicts with keys
            'center': (3,) ndarray
            'dimensions': (3,) ndarray
            'part_id': Optional[str]
            'confidence': float
        Returns the list of TrackEntry objects active after this cycle.
        """
        now = time.time()
        used_track_ids: set = set()

        for obs in observations:
            center = np.asarray(obs.get('center'), dtype=float)
            dims_in = obs.get('dimensions')
            if dims_in is None:
                dims_in = [0, 0, 0]
            dims = np.asarray(dims_in, dtype=float)
            part_id = obs.get('part_id')
            confidence = float(obs.get('confidence') or 0.0)

            matched = self._match_existing(center, part_id, used_track_ids)
            if matched is not None:
                used_track_ids.add(matched.track_id)
                same_identity = (matched.part_id == part_id)
                matched.center = center
                matched.dimensions = dims
                matched.last_seen = now
                matched.frames_observed += 1
                matched.cycles_since_lost = 0
                matched.last_confidence = confidence
                if same_identity:
                    matched.consecutive_match += 1
                else:
                    # Identity changed mid-track. Treat as a soft reset:
                    # adopt the new identity and start the streak fresh.
                    matched.part_id = part_id
                    matched.consecutive_match = 1
                if (matched.consecutive_match >= self.confirm_streak
                        and matched.status != 'confirmed'):
                    matched.status = 'confirmed'
                obs['track_id'] = matched.track_id
                obs['status'] = matched.status
            else:
                track = TrackEntry(
                    track_id=self._next_id,
                    part_id=part_id,
                    center=center,
                    dimensions=dims,
                    first_seen=now,
                    last_seen=now,
                    frames_observed=1,
                    consecutive_match=1,
                    cycles_since_lost=0,
                    status='tentative',
                    last_confidence=confidence,
                )
                self._next_id += 1
                self._tracks[track.track_id] = track
                used_track_ids.add(track.track_id)
                obs['track_id'] = track.track_id
                obs['status'] = track.status

        # Age out missing tracks
        to_remove = []
        for tid, track in self._tracks.items():
            if tid in used_track_ids:
                continue
            track.cycles_since_lost += 1
            if track.cycles_since_lost > self.drop_after:
                to_remove.append(tid)
            elif track.cycles_since_lost > self.lost_after:
                track.status = 'lost'
        for tid in to_remove:
            del self._tracks[tid]

        self._history.append({'timestamp': now,
                              'observations': [dict(o) for o in observations]})

        return list(self._tracks.values())

    def stability_score(self, track: TrackEntry) -> float:
        """Maps frames_observed → [0, 1]. Saturates at confirm_streak * 2."""
        cap = max(self.confirm_streak * 2, 1)
        return float(min(1.0, track.frames_observed / cap))

    def _match_existing(self, center: np.ndarray, part_id: Optional[str],
                        used: set) -> Optional[TrackEntry]:
        best: Optional[TrackEntry] = None
        best_d = float('inf')
        for tid, track in self._tracks.items():
            if tid in used:
                continue
            xy_d = float(np.linalg.norm(track.center[:2] - center[:2]))
            if xy_d > self.match_xy:
                continue
            # Prefer same-identity tracks within the same gate
            penalty = 0.0 if track.part_id == part_id else self.match_xy * 0.5
            score = xy_d + penalty
            if score < best_d:
                best_d = score
                best = track
        return best

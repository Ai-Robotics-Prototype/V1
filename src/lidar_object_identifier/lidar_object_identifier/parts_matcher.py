"""Match a single cluster's shape features against the parts library.

We import object_detection.part_library lazily so this module is testable
without the rest of the workspace. Each part is summarized as a cached
`PartFeatures` row computed once at startup (and refreshed when the parts
library changes underneath us).
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

from .shape_analyzer import ShapeFeatures

logger = logging.getLogger(__name__)

CACHE_PATH = '/opt/cobot/lidar/cache/parts_features.json'


@dataclass
class PartFeatures:
    part_id: str
    name: str
    dimensions_m_sorted: List[float]  # descending L, W, H (metres)
    obb_volume_m3: float
    extents_cm_raw: List[float]


@dataclass
class MatchResult:
    part_id: Optional[str]
    part_name: str
    size_match_score: float
    volume_match_score: float
    shape_match_score: float
    overall_score: float
    alternatives: List[Tuple[str, float]] = field(default_factory=list)
    method: str = 'combined'


def _to_metres_sorted(extents_cm: List[float]) -> List[float]:
    if not extents_cm:
        return [0.0, 0.0, 0.0]
    arr = sorted([abs(float(v)) / 100.0 for v in extents_cm], reverse=True)
    while len(arr) < 3:
        arr.append(0.0)
    return arr[:3]


class PartsMatcher:
    """Loads parts library, caches geometric features, scores clusters."""

    def __init__(self,
                 size_tolerance_pct: float = 25.0,
                 volume_tolerance_pct: float = 30.0,
                 weight_size: float = 0.35,
                 weight_volume: float = 0.25,
                 weight_shape: float = 0.30,
                 weight_persistence: float = 0.10,
                 shape_feature_weights: Optional[Dict[str, Tuple[float, float]]] = None,
                 ):
        self.size_tol = max(size_tolerance_pct, 1.0) / 100.0
        self.volume_tol = max(volume_tolerance_pct, 1.0) / 100.0
        self.w_size = float(weight_size)
        self.w_vol = float(weight_volume)
        self.w_shape = float(weight_shape)
        self.w_persistence = float(weight_persistence)
        self._library_etag = 0.0
        self._cache: Dict[str, PartFeatures] = {}
        # Per-feature (weight, tolerance) used for the shape distance.
        self._shape_weights = shape_feature_weights or {
            'sphericity':  (1.0, 0.25),
            'flatness':    (1.0, 0.25),
            'elongation':  (1.2, 0.25),
            'compactness': (0.8, 0.30),
            'solidity':    (0.6, 0.20),
        }
        # Shape descriptors for each part are derived from the STEP-derived
        # dimensions. Without a STEP-based hull library we synthesize the
        # canonical descriptors from the OBB; this is good enough to
        # discriminate brackets / plates / rods even if it doesn't capture
        # fine geometric detail.
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)

    # ------------------------------------------------------------------
    # Library load + caching
    # ------------------------------------------------------------------

    def refresh_library(self, force: bool = False) -> None:
        try:
            from object_detection import part_library
        except Exception as exc:
            logger.warning('parts library import failed (%s); '
                           'matcher will operate with empty library', exc)
            self._cache = {}
            self._library_etag = 0.0
            return

        # Etag = mtime of the index file. Cheap and good enough.
        idx_path = getattr(part_library, 'LIBRARY_INDEX', None)
        try:
            etag = os.path.getmtime(idx_path) if idx_path else time.time()
        except Exception:
            etag = time.time()
        if (not force) and etag == self._library_etag and self._cache:
            return
        try:
            parts = part_library.get_all_parts() or []
        except Exception as exc:
            logger.warning('parts library read failed (%s)', exc)
            parts = []
        cache: Dict[str, PartFeatures] = {}
        for p in parts:
            pid = p.get('id')
            if not pid:
                continue
            extents = p.get('extents_cm') or [0, 0, 0]
            dims = _to_metres_sorted(extents)
            cache[pid] = PartFeatures(
                part_id=pid,
                name=p.get('name') or pid,
                dimensions_m_sorted=dims,
                obb_volume_m3=float(np.prod(dims)) if all(dims) else 0.0,
                extents_cm_raw=list(extents),
            )
        self._cache = cache
        self._library_etag = etag
        self._persist_cache()
        logger.info('Parts library cache rebuilt: %d parts', len(cache))

    def _persist_cache(self) -> None:
        try:
            tmp = CACHE_PATH + '.tmp'
            with open(tmp, 'w') as fp:
                json.dump({
                    'etag': self._library_etag,
                    'parts': [
                        {
                            'part_id': p.part_id,
                            'name': p.name,
                            'dimensions_m_sorted': p.dimensions_m_sorted,
                            'obb_volume_m3': p.obb_volume_m3,
                            'extents_cm_raw': p.extents_cm_raw,
                        }
                        for p in self._cache.values()
                    ],
                }, fp, indent=2)
            os.replace(tmp, CACHE_PATH)
        except Exception as exc:
            logger.debug('Could not persist parts cache (%s)', exc)

    def known_parts(self) -> int:
        return len(self._cache)

    # ------------------------------------------------------------------
    # Scoring helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _size_score(cluster_dims: List[float],
                    part_dims: List[float],
                    tol: float) -> float:
        if any(d <= 0 for d in part_dims):
            return 0.0
        diffs = [abs(c - p) / max(p, 1.0e-6)
                 for c, p in zip(cluster_dims, part_dims)]
        max_diff = max(diffs)
        if max_diff > tol * 2.0:
            return 0.0
        # Inside tolerance → near 1.0, decaying linearly to 0 at 2*tol.
        return float(max(0.0, 1.0 - max_diff / (tol * 2.0)))

    @staticmethod
    def _volume_score(cluster_vol: float, part_vol: float, tol: float) -> float:
        if part_vol <= 1.0e-9:
            return 0.0
        ratio = cluster_vol / part_vol
        # Geometric mean keeps ratios > 1 and < 1 symmetric.
        log_diff = abs(np.log(max(ratio, 1.0e-6)))
        # log(1+tol) is the "tolerance" in log-space.
        norm = abs(np.log(1.0 + tol)) * 2.0
        return float(max(0.0, 1.0 - log_diff / max(norm, 1.0e-6)))

    def _shape_distance(self, cluster: ShapeFeatures,
                        part: PartFeatures) -> float:
        """Synthesize the part's canonical shape descriptors from its OBB
        (no STEP geometry available here). Distance is the weighted sum of
        per-feature normalized differences, mapped to [0, 1] via 1 - dist.
        """
        L, W, H = part.dimensions_m_sorted
        if L <= 0:
            return 0.0
        # Crude "expected" descriptors for a solid box of these dimensions.
        expected = {
            'sphericity':  6.0 * (L * W * H) / (np.pi *
                                                max((L ** 2 + W ** 2 + H ** 2) ** 1.5, 1.0e-9)),
            'flatness':    H / max(L, 1.0e-6),
            'elongation':  L / max(W, 1.0e-6),
            'compactness': ((L * W * H) ** (2.0 / 3.0)) /
                           max(2.0 * (L * W + L * H + W * H), 1.0e-6),
            'solidity':    1.0,  # boxes are convex by construction
        }
        cluster_vals = {
            'sphericity':  cluster.sphericity,
            'flatness':    cluster.flatness,
            'elongation':  cluster.elongation,
            'compactness': cluster.compactness,
            'solidity':    cluster.solidity,
        }
        total_w = 0.0
        score = 0.0
        for name, (w, tol) in self._shape_weights.items():
            exp = float(expected.get(name, 0.0))
            cur = float(cluster_vals.get(name, 0.0))
            if exp <= 0 and cur <= 0:
                continue
            diff = abs(cur - exp) / max(abs(exp), 1.0e-6)
            feat = max(0.0, 1.0 - diff / max(tol * 2.0, 1.0e-6))
            score += feat * w
            total_w += w
        return float(score / total_w) if total_w > 0 else 0.0

    # ------------------------------------------------------------------
    # Public match
    # ------------------------------------------------------------------

    def match(self, cluster: ShapeFeatures,
              persistence_score: float = 0.0,
              top_k_alternatives: int = 3) -> MatchResult:
        if not self._cache:
            return MatchResult(part_id=None, part_name='unknown',
                               size_match_score=0.0,
                               volume_match_score=0.0,
                               shape_match_score=0.0,
                               overall_score=0.0,
                               method='no_library')

        cluster_dims = sorted(
            [float(cluster.dimensions_m[0]),
             float(cluster.dimensions_m[1]),
             float(cluster.dimensions_m[2])], reverse=True)
        cluster_vol = float(cluster.volume_m3)

        ranked: List[Tuple[str, str, float, float, float, float]] = []
        for pf in self._cache.values():
            size_score = self._size_score(
                cluster_dims, pf.dimensions_m_sorted, self.size_tol)
            if size_score <= 0.0:
                continue
            vol_score = self._volume_score(
                cluster_vol, pf.obb_volume_m3, self.volume_tol)
            shape_score = self._shape_distance(cluster, pf)
            overall = (self.w_size * size_score
                       + self.w_vol * vol_score
                       + self.w_shape * shape_score
                       + self.w_persistence * float(persistence_score))
            ranked.append((pf.part_id, pf.name,
                           size_score, vol_score, shape_score, overall))

        if not ranked:
            return MatchResult(part_id=None, part_name='unknown',
                               size_match_score=0.0,
                               volume_match_score=0.0,
                               shape_match_score=0.0,
                               overall_score=0.0,
                               method='no_candidate')
        ranked.sort(key=lambda row: row[5], reverse=True)
        best = ranked[0]
        alternatives = [(name, score)
                        for (pid, name, _, _, _, score) in ranked[1:top_k_alternatives + 1]]
        return MatchResult(
            part_id=best[0],
            part_name=best[1],
            size_match_score=float(best[2]),
            volume_match_score=float(best[3]),
            shape_match_score=float(best[4]),
            overall_score=float(min(1.0, max(0.0, best[5]))),
            alternatives=alternatives,
            method='combined',
        )

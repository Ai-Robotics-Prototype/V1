"""Combine match scores + persistence into a single confidence bucket."""
from __future__ import annotations

from dataclasses import dataclass


CONFIDENT = 'CONFIRMED'
TENTATIVE = 'TENTATIVE'
UNKNOWN_DETECTED = 'UNKNOWN_BUT_DETECTED'
NOISE = 'NOISE_OR_UNRECOGNIZED'


@dataclass
class ScoredResult:
    confidence: float
    bucket: str


def bucket_for(confidence: float,
               confirm: float = 0.8,
               tentative: float = 0.5,
               detected: float = 0.3) -> str:
    if confidence >= confirm:
        return CONFIDENT
    if confidence >= tentative:
        return TENTATIVE
    if confidence >= detected:
        return UNKNOWN_DETECTED
    return NOISE


def combined_confidence(overall_match: float,
                        persistence: float,
                        weight_persistence: float = 0.1) -> ScoredResult:
    """`overall_match` is already a weighted sum from parts_matcher; the
    persistence bonus is folded in here so a single track can climb from
    TENTATIVE to CONFIRMED purely by being seen many frames."""
    conf = float(overall_match) * (1.0 - weight_persistence) \
        + float(persistence) * weight_persistence
    conf = max(0.0, min(1.0, conf))
    return ScoredResult(confidence=conf, bucket=bucket_for(conf))

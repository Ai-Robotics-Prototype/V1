"""Cycle-level waypoint optimization for palletize-style programs.

Given a list of pick/place waypoints repeated across cycles, identify
shared approach/retreat positions and merge consecutive moves that share
joint deltas below a threshold. Used as a pre-processing step before
TOPP-RA.
"""
from __future__ import annotations

from typing import List

import numpy as np

from . import utils
from .profile_manager import Profile


def collapse_consecutive_duplicates(waypoints_rad: np.ndarray,
                                    atol: float = 1e-3) -> np.ndarray:
    return utils.filter_duplicate_waypoints(waypoints_rad, atol=atol)


def insert_approach_retreat(waypoints_rad: np.ndarray,
                            approach_offset_rad: float = 0.05,
                            retreat_offset_rad: float = 0.05
                            ) -> np.ndarray:
    """Insert approach / retreat shoulder waypoints around each via point.

    Approach lies along the incoming segment, retreat along the outgoing.
    Skips first/last (terminal) waypoints.
    """
    pts = np.asarray(waypoints_rad, dtype=float)
    if pts.shape[0] < 3:
        return pts.copy()
    out = [pts[0]]
    for i in range(1, pts.shape[0] - 1):
        prev, cur, nxt = pts[i - 1], pts[i], pts[i + 1]
        v_in = cur - prev
        d_in = float(np.linalg.norm(v_in))
        if d_in > 1e-6:
            out.append(cur - (v_in / d_in) * min(approach_offset_rad, 0.5 * d_in))
        out.append(cur)
        v_out = nxt - cur
        d_out = float(np.linalg.norm(v_out))
        if d_out > 1e-6:
            out.append(cur + (v_out / d_out) * min(retreat_offset_rad, 0.5 * d_out))
    out.append(pts[-1])
    return np.asarray(out, dtype=float)


def cycle_aware_compression(waypoints_rad: np.ndarray,
                            cycle_length: int) -> np.ndarray:
    """For repeated palletize cycles, drop redundant home returns when the
    cycle endpoints are within tolerance.

    cycle_length: number of waypoints per cycle (e.g., approach+pick+retreat+place).
    """
    pts = np.asarray(waypoints_rad, dtype=float)
    if cycle_length <= 0 or pts.shape[0] < 2 * cycle_length:
        return pts.copy()
    keep_mask = np.ones(pts.shape[0], dtype=bool)
    for i in range(cycle_length, pts.shape[0], cycle_length):
        if i + 1 >= pts.shape[0]:
            break
        if np.linalg.norm(pts[i] - pts[i - 1]) < 1e-3:
            keep_mask[i] = False
    return pts[keep_mask]

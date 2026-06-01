"""Match a live camera detection (binary mask + OBB extents) against
the parts library's pre-rendered CAD silhouettes.

Designed to be called from any node that has a per-detection 2D mask
(depth_segment_node is the obvious caller). Caches the parts metadata
across calls; reloads only when /opt/cobot/parts/index.json changes.
"""
import json
import os
from typing import Optional, Tuple

import numpy as np

try:
    from scipy.ndimage import binary_fill_holes
    _SCIPY_OK = True
except ImportError:
    _SCIPY_OK = False

LIBRARY_DIR    = '/opt/cobot/parts'
LIBRARY_INDEX  = os.path.join(LIBRARY_DIR, 'index.json')
MIN_MATCH_SCORE = 0.70

_parts_cache: Optional[list] = None
_cache_mtime: float = 0.0


def _load_parts() -> list:
    global _parts_cache, _cache_mtime
    if not os.path.isfile(LIBRARY_INDEX):
        return []
    mtime = os.path.getmtime(LIBRARY_INDEX)
    if _parts_cache is not None and mtime == _cache_mtime:
        return _parts_cache
    parts = []
    try:
        with open(LIBRARY_INDEX) as f:
            index = json.load(f) or {}
        for entry in index.get('parts') or []:
            part_id = entry.get('id')
            if not part_id:
                continue
            meta_path = os.path.join(LIBRARY_DIR, 'metadata', f'{part_id}.json')
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path) as f:
                    parts.append(json.load(f))
            except Exception:
                continue
    except Exception:
        pass
    _parts_cache = parts
    _cache_mtime = mtime
    return parts


# ── Descriptors (mirror step_parser's so live and reference compare) ──

def _hu_moments(mask: np.ndarray) -> np.ndarray:
    ys, xs = np.where(mask)
    n = len(xs)
    if n == 0:
        return np.zeros(7, dtype=np.float64)
    cx, cy = float(np.mean(xs)), float(np.mean(ys))

    def mu(p, q):
        return float(np.sum(((xs - cx) ** p) * ((ys - cy) ** q)) / n)

    def eta(p, q):
        gamma = (p + q) / 2.0 + 1.0
        return mu(p, q) / (n ** gamma)

    n20 = eta(2, 0); n02 = eta(0, 2); n11 = eta(1, 1)
    n30 = eta(3, 0); n03 = eta(0, 3); n21 = eta(2, 1); n12 = eta(1, 2)

    h1 = n20 + n02
    h2 = (n20 - n02) ** 2 + 4 * n11 ** 2
    h3 = (n30 - 3*n12) ** 2 + (3*n21 - n03) ** 2
    h4 = (n30 + n12) ** 2 + (n21 + n03) ** 2
    h5 = ((n30 - 3*n12) * (n30 + n12) *
          ((n30 + n12) ** 2 - 3*(n21 + n03) ** 2) +
          (3*n21 - n03) * (n21 + n03) *
          (3*(n30 + n12) ** 2 - (n21 + n03) ** 2))
    h6 = ((n20 - n02) * ((n30 + n12) ** 2 - (n21 + n03) ** 2) +
          4 * n11 * (n30 + n12) * (n21 + n03))
    h7 = ((3*n21 - n03) * (n30 + n12) *
          ((n30 + n12) ** 2 - 3*(n21 + n03) ** 2) -
          (n30 - 3*n12) * (n21 + n03) *
          (3*(n30 + n12) ** 2 - (n21 + n03) ** 2))
    return np.array([h1, h2, h3, h4, h5, h6, h7], dtype=np.float64)


def _contour_signature(mask: np.ndarray, num_samples: int = 36) -> np.ndarray:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return np.zeros(num_samples, dtype=np.float64)
    cx, cy = float(np.mean(xs)), float(np.mean(ys))
    dx, dy = xs - cx, ys - cy
    ang = np.arctan2(dy, dx)
    dist = np.hypot(dx, dy)
    sig = np.zeros(num_samples, dtype=np.float64)
    step = 2 * np.pi / num_samples
    bins = ((ang + np.pi) // step).astype(np.int32)
    bins = np.clip(bins, 0, num_samples - 1)
    np.maximum.at(sig, bins, dist)
    m = float(sig.max())
    return sig / m if m > 0 else sig


def _solidity(mask: np.ndarray) -> float:
    area = int(mask.sum())
    if not area:
        return 1.0
    if _SCIPY_OK:
        hull_area = int(binary_fill_holes(mask).sum())
        return area / max(hull_area, 1)
    return 1.0


def _hu_log_distance(a: np.ndarray, b: np.ndarray) -> float:
    """log10-magnitude distance — standard way to compare Hu moments."""
    la = np.sign(a) * np.log10(np.abs(a) + 1e-10)
    lb = np.sign(b) * np.log10(np.abs(b) + 1e-10)
    return float(np.sum(np.abs(la - lb)))


def match_detection(
    detection_mask: Optional[np.ndarray],
    detection_size_m: list,
    detection_aspect: Optional[float] = None,
) -> Tuple[Optional[dict], float, float]:
    """Score every library part against the live detection. Returns
    (best_part_metadata, score, matched_yaw_deg) or (None, 0, 0) when
    no candidate clears MIN_MATCH_SCORE.

    detection_mask: HxW binary mask of the segmented object. When None
        or empty, falls back to size-only matching.
    detection_size_m: [w, h, d] in metres from the OBB.
    detection_aspect: optional 2D aspect ratio (width / height).
    """
    parts = _load_parts()
    if not parts:
        return None, 0.0, 0.0

    have_mask = detection_mask is not None and detection_mask.any()
    det_hu       = _hu_moments(detection_mask)       if have_mask else None
    det_contour  = _contour_signature(detection_mask) if have_mask else None
    det_solidity = _solidity(detection_mask)          if have_mask else None
    if detection_aspect is None and have_mask:
        rows = np.any(detection_mask, axis=1)
        cols = np.any(detection_mask, axis=0)
        if rows.any() and cols.any():
            r0, r1 = np.where(rows)[0][[0, -1]]
            c0, c1 = np.where(cols)[0][[0, -1]]
            detection_aspect = (c1 - c0 + 1) / max(r1 - r0 + 1, 1)
        else:
            detection_aspect = 1.0
    if detection_aspect is None:
        detection_aspect = 1.0
    det_size_sorted = sorted([float(s) for s in (detection_size_m or [0, 0, 0])[:3]],
                             reverse=True)

    best_part: Optional[dict] = None
    best_score = 0.0
    best_yaw   = 0.0

    for part in parts:
        sils = part.get('silhouettes') or []
        part_ext = sorted([e / 100.0 for e in (part.get('extents_cm') or [5, 5, 5])[:3]],
                          reverse=True)
        size_err = sum(abs(a - b) for a, b in zip(det_size_sorted, part_ext))
        max_dim = max(det_size_sorted[0], part_ext[0], 0.01)
        size_score = max(0.0, 1.0 - min(1.0, size_err / max_dim))

        if not sils or not have_mask:
            # Size-only fallback for parts without silhouettes or for
            # callers that don't pass a mask.
            if size_score > best_score:
                best_score = size_score
                best_part = part
                best_yaw = 0.0
            continue

        for sil in sils:
            sil_hu      = np.array(sil.get('hu_moments') or [], dtype=np.float64)
            sil_contour = np.array(sil.get('contour_signature') or [], dtype=np.float64)
            sil_solid   = float(sil.get('solidity') or 0.5)
            sil_aspect  = float(sil.get('aspect_ratio') or 1.0)

            hu_score = max(0.0, 1.0 - _hu_log_distance(det_hu, sil_hu) / 20.0) \
                       if sil_hu.size else 0.0

            contour_score = 0.0
            if sil_contour.size == det_contour.size and sil_contour.size > 0:
                for shift in range(sil_contour.size):
                    rolled = np.roll(sil_contour, shift)
                    d = float(np.mean(np.abs(det_contour - rolled)))
                    contour_score = max(contour_score, max(0.0, 1.0 - d * 3.0))

            solidity_score = max(0.0, 1.0 - abs(det_solidity - sil_solid) * 5.0)
            aspect_score   = max(0.0, 1.0 - abs(detection_aspect - sil_aspect) * 2.0)

            total = (hu_score       * 0.25 +
                     contour_score  * 0.30 +
                     solidity_score * 0.10 +
                     aspect_score   * 0.10 +
                     size_score     * 0.25)

            if total > best_score:
                best_score = total
                best_part  = part
                best_yaw   = float(sil.get('yaw_deg') or 0.0)

    if best_part is None or best_score < MIN_MATCH_SCORE:
        return None, 0.0, 0.0
    return best_part, round(best_score, 3), best_yaw

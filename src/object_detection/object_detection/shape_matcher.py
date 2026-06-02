"""Match a live camera detection's geometric features against the
CAD-derived `geometric_features` stored on every part in the library.

The previous version compared abstract silhouette descriptors (Hu
moments, contour radial signature) and routinely false-matched any
roughly-rectangular blob in front of the camera. This version compares
the exact things STEP files give us — hole count + relative positions,
height profile, edge profile, outline, size, aspect — so a part is only
recognised when its real geometry shows up in the depth image.

Public API:
    match_geometry(det_features, det_size_m) -> (part_meta, score, reason)
"""
import json
import os
from typing import Optional, Tuple

import numpy as np

LIBRARY_DIR     = '/opt/cobot/parts'
LIBRARY_INDEX   = os.path.join(LIBRARY_DIR, 'index.json')
MIN_MATCH_SCORE = 0.50

_parts_cache: Optional[list] = None
_cache_mtime: float = 0.0


def _load_parts_with_features() -> list:
    """Return every library part that has a `geometric_features` block.
    Cached until index.json's mtime changes."""
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
                    meta = json.load(f)
            except Exception:
                continue
            if meta.get('geometric_features'):
                parts.append(meta)
    except Exception:
        pass

    _parts_cache = parts
    _cache_mtime = mtime
    return parts


def _ncc_with_rotations(cad_grid: np.ndarray, det_grid: np.ndarray) -> float:
    """Best normalised cross-correlation over 4 cardinal rotations of
    the detection grid. Rotation-invariant on the yaw axis only — which
    is what tabletop CAD-to-camera matching actually needs."""
    if det_grid.shape != (32, 32):
        from scipy.ndimage import zoom
        det_grid = zoom(det_grid,
                        (32 / det_grid.shape[0], 32 / det_grid.shape[1]),
                        order=1)
    cad_flat = cad_grid.flatten()
    a_m = float(cad_flat.mean()); a_s = float(cad_flat.std())
    if a_s < 0.01:
        return 0.0
    best = 0.0
    for rot in range(4):
        rotated = np.rot90(det_grid, rot).flatten()
        b_m = float(rotated.mean()); b_s = float(rotated.std())
        if b_s < 0.01:
            continue
        ncc = float(np.mean((cad_flat - a_m) * (rotated - b_m)) / (a_s * b_s))
        if ncc > best:
            best = ncc
    return best


def match_geometry(
    det_features: dict,
    det_size_m: list,
) -> Tuple[Optional[dict], float, str]:
    """Score every CAD part against the camera detection.

    Weighted blend of:
      - hole count (most distinctive — a 4-hole bracket can't be a slab)
      - hole-pattern: pairwise distances + radii (rotation invariant)
      - top-down height-map NCC (best of 4 rotations)
      - edge-map NCC
      - dimensional match on sorted OBB extents
      - aspect ratio

    Returns (best_part_meta, score, reason_text) or (None, 0, '') below
    MIN_MATCH_SCORE.
    """
    parts = _load_parts_with_features()
    if not parts or not det_features:
        return None, 0.0, ''

    best_part: Optional[dict] = None
    best_score = 0.0
    best_reason = ''

    det_holes_n = int(det_features.get('num_holes', 0))
    det_holes   = det_features.get('holes', []) or []
    det_hm      = det_features.get('height_map_32')
    det_em      = det_features.get('edge_map_32')
    det_aspect  = float(det_features.get('aspect_ratio', 1.0) or 1.0)
    det_sorted_xy = sorted([float(s) for s in (det_size_m or [0, 0, 0])[:2]],
                           reverse=True)

    for part in parts:
        gf = part.get('geometric_features') or {}
        if not gf:
            continue

        scores: dict = {}
        reasons: list = []

        cad_holes_n = int(gf.get('num_holes', 0))
        cad_holes   = gf.get('holes', []) or []

        # 1) HOLE COUNT — most discriminative single feature.
        if cad_holes_n == det_holes_n:
            scores['holes'] = 1.0
            reasons.append(f'holes:{cad_holes_n}={det_holes_n}')
        elif cad_holes_n > 0 and det_holes_n > 0:
            scores['holes'] = 1.0 - abs(cad_holes_n - det_holes_n) / max(cad_holes_n, det_holes_n)
            reasons.append(f'holes:{det_holes_n}/{cad_holes_n}')
        elif cad_holes_n == 0 and det_holes_n == 0:
            scores['holes'] = 0.8
            reasons.append('no_holes')
        else:
            scores['holes'] = 0.0
            reasons.append(f'holes_mismatch:{det_holes_n}vs{cad_holes_n}')

        # 2) HOLE PATTERN — rotation-invariant via sorted pairwise distances.
        if cad_holes_n > 0 and det_holes_n > 0:
            cad_centers = sorted([h['center'] for h in cad_holes])
            det_centers = sorted([h['center'] for h in det_holes])

            if len(cad_centers) >= 2 and len(det_centers) >= 2:
                cad_dists = []
                det_dists = []
                for i in range(len(cad_centers)):
                    for j in range(i + 1, len(cad_centers)):
                        cad_dists.append(float(np.hypot(
                            cad_centers[i][0] - cad_centers[j][0],
                            cad_centers[i][1] - cad_centers[j][1])))
                for i in range(len(det_centers)):
                    for j in range(i + 1, len(det_centers)):
                        det_dists.append(float(np.hypot(
                            det_centers[i][0] - det_centers[j][0],
                            det_centers[i][1] - det_centers[j][1])))
                cad_dists.sort(); det_dists.sort()
                if cad_dists and len(cad_dists) == len(det_dists):
                    ratios = [min(a, b) / max(a, b) if max(a, b) > 0.01 else 1.0
                              for a, b in zip(cad_dists, det_dists)]
                    scores['hole_pattern'] = sum(ratios) / len(ratios)
                else:
                    scores['hole_pattern'] = 0.5
            else:
                scores['hole_pattern'] = 0.7

            cad_radii = sorted([h.get('radius_norm', 0.0) for h in cad_holes])
            det_radii = sorted([h.get('radius_norm', 0.0) for h in det_holes])
            if len(cad_radii) == len(det_radii) and cad_radii:
                size_ratios = [min(a, b) / max(a, b) if max(a, b) > 0.001 else 1.0
                               for a, b in zip(cad_radii, det_radii)]
                scores['hole_size'] = sum(size_ratios) / len(size_ratios)

        # 3) HEIGHT-MAP NCC.
        cad_hm = np.asarray(gf.get('height_map_32') or [], dtype=np.float32)
        if cad_hm.size == 1024 and det_hm is not None and np.asarray(det_hm).size > 0:
            try:
                hncc = _ncc_with_rotations(cad_hm.reshape(32, 32),
                                            np.asarray(det_hm, dtype=np.float32))
                scores['height'] = max(0.0, hncc)
                reasons.append(f'height_ncc:{hncc:.2f}')
            except Exception:
                pass

        # 4) EDGE-MAP NCC.
        cad_em = np.asarray(gf.get('edge_map_32') or [], dtype=np.float32)
        if cad_em.size == 1024 and det_em is not None and np.asarray(det_em).size > 0:
            try:
                encc = _ncc_with_rotations(cad_em.reshape(32, 32),
                                            np.asarray(det_em, dtype=np.float32))
                scores['edges'] = max(0.0, encc)
            except Exception:
                pass

        # 5) SIZE — sorted XY extents. Both dims must be within 40 % or
        # we reject regardless of other scores.
        cad_w = float(gf.get('part_width_m')  or 0.05)
        cad_h = float(gf.get('part_height_m') or 0.05)
        cad_sorted_xy = sorted([cad_w, cad_h], reverse=True)
        size_ratios = [min(d, c) / max(d, c, 0.001)
                       for d, c in zip(det_sorted_xy, cad_sorted_xy)]
        if all(r > 0.6 for r in size_ratios):
            scores['size'] = sum(size_ratios) / 2.0
        else:
            scores['size'] = 0.0
            reasons.append('size_reject')

        # 6) ASPECT RATIO.
        cad_aspect = float(gf.get('aspect_ratio', 1.0) or 1.0)
        scores['aspect'] = (min(cad_aspect, det_aspect)
                            / max(cad_aspect, det_aspect, 0.01))

        # If both CAD and detection are very flat, height/edge maps are
        # useless (both are mostly zero so NCC noise dominates).
        cad_height_range = float(gf.get('height_range', 0) or 0)
        det_height_range = float(det_features.get('height_range', 0) or 0)
        flat_object = (cad_height_range < 0.005 and det_height_range < 0.005)

        # WEIGHTED TOTAL — holes carry the most weight; only the keys
        # that actually have a score contribute, and the denominator is
        # the sum of *used* weights (so a part with no holes isn't
        # punished for missing hole_pattern/hole_size).
        if flat_object:
            scores.pop('height', None)
            scores.pop('edges', None)
            weights = {
                'holes':        0.35,
                'hole_pattern': 0.15,
                'hole_size':    0.05,
                'size':         0.30,
                'aspect':       0.15,
            }
        else:
            weights = {
                'holes':        0.25,
                'hole_pattern': 0.15,
                'hole_size':    0.05,
                'height':       0.20,
                'edges':        0.10,
                'size':         0.15,
                'aspect':       0.10,
            }
        total = 0.0; used = 0.0
        for key, w in weights.items():
            if key in scores:
                total += scores[key] * w
                used  += w
        if used > 0:
            total /= used

        # HARD REJECTS — size mismatch (>60 %) or one-side-only holes.
        if scores.get('size', 0.0) < 0.3:
            total = 0.0
        if scores.get('holes', 0.0) < 0.1 and (cad_holes_n > 0 or det_holes_n > 0):
            total *= 0.3

        # HARD REJECT: CAD has holes but the camera sees none. Holes are
        # the most distinctive feature; if the part should have visible
        # holes and we see none, it's not this part — unless the part is
        # tiny enough that the holes may be sub-pixel.
        if cad_holes_n > 0 and det_holes_n == 0:
            part_area = float(gf.get('part_width_m', 0.05) or 0.05) * \
                        float(gf.get('part_height_m', 0.05) or 0.05)
            if part_area > 0.001:  # > 10 cm² — holes should be visible
                total = 0.0
                reasons.append('REJECT:holes_missing')

        if total > best_score:
            best_score  = total
            best_part   = part
            best_reason = ' '.join(reasons)

    # Dynamic threshold based on library size — a single-part library has
    # no competition to filter out weak matches, so raise the bar.
    num_parts = len(parts)
    if num_parts <= 1:
        effective_threshold = 0.70
    elif num_parts <= 3:
        effective_threshold = 0.60
    else:
        effective_threshold = MIN_MATCH_SCORE

    if best_part is None or best_score < effective_threshold:
        return None, 0.0, ''
    return best_part, round(best_score, 3), best_reason


def match_detection(detection_mask=None, detection_size_m=None,
                    detection_aspect=None):
    """Back-compat shim for callers that still pass a binary mask.

    The new geometry matcher needs the depth-derived feature dict —
    callers should switch to match_geometry. When called the old way we
    can only size-match, so we return (None, 0.0, 0.0). depth_segment_node
    has been updated to call match_geometry directly.
    """
    return None, 0.0, 0.0

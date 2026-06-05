#!/usr/bin/env python3
"""Offline validation of the orientation classifier.

Runs LEAVE-ONE-OUT cross-validation over every teach ref on disk in
/opt/cobot/parts/teach/. For each part that carries refs in both the
"pickable" and "non-pickable" buckets, we hold one ref out as the
synthetic "live detection" and score it against every OTHER ref in
that part, grouped by orientation key. The held-out ref is "correct"
iff the winning group's `is_pickable` matches the held-out ref's own
`is_pickable` label.

Five scoring signals (mirroring _match_part in production):
  NCC      0.20   shape + texture correlation, best of 4 rotations
  Hist     0.10   masked-pixel RGB histogram correlation
  Spatial  0.10   4x4 spatial colour-grid cosine similarity
  Depth    0.25   depth surface geometry: profile + 3x3 grid + holes
  Feat     0.35   Harris keypoints (Lowe ratio) + LBP histogram corr

All scoring functions are duplicated here as plain module-level
helpers so this script has zero ROS / dashboard / catkin dependency.
Old refs without kp_descs / lbp_hist get their features computed
on-the-fly from color + mask (validation only — production stores
them at teach time going forward).

Output: per-part contribution + accuracy table, overall accuracy,
and per-ref FAIL diagnostics for parts under 80%.
"""
import math
import os
import sys
from collections import defaultdict

import numpy as np

try:
    from scipy import ndimage
    from scipy.ndimage import zoom as _zoom
except ImportError as e:
    print(f'scipy required: {e}', file=sys.stderr)
    sys.exit(2)


TEACH_BASE   = '/opt/cobot/parts/teach'
META_BASE    = '/opt/cobot/parts/metadata'

# Defaults mirror DepthSegmentNode._match_part's default_weights.
DEFAULT_WEIGHTS = {
    'ncc':     0.20,
    'hist':    0.10,
    'spatial': 0.10,
    'depth':   0.25,
    'feat':    0.35,
}


# ── Scoring helpers — duplicated from depth_segment_node so this ──
#    script runs without importing ROS.

def _color_hist_corr(rgb1, rgb2, bins=32, mask1=None, mask2=None):
    """Pearson correlation between per-channel RGB histograms."""
    try:
        if rgb1 is None or rgb2 is None:
            return 0.0
        r1 = np.asarray(rgb1); r2 = np.asarray(rgb2)
        if r1.size == 0 or r2.size == 0:
            return 0.0
        if r1.ndim == 2:
            r1 = np.stack([r1, r1, r1], axis=-1)
        if r2.ndim == 2:
            r2 = np.stack([r2, r2, r2], axis=-1)

        def _flatten(img, mask):
            if (mask is not None
                    and np.asarray(mask).shape[:2] == img.shape[:2]
                    and np.asarray(mask).any()):
                return img[np.asarray(mask).astype(bool)]
            return img.reshape(-1, img.shape[-1])

        r1_use = _flatten(r1, mask1)
        r2_use = _flatten(r2, mask2)
        if r1_use.size == 0 or r2_use.size == 0:
            return 0.0
        parts = []
        for c in range(min(3, r1_use.shape[-1], r2_use.shape[-1])):
            h1, _ = np.histogram(r1_use[..., c], bins=bins, range=(0, 256))
            h2, _ = np.histogram(r2_use[..., c], bins=bins, range=(0, 256))
            h1 = h1.astype(np.float32); h2 = h2.astype(np.float32)
            s1, s2 = h1.sum(), h2.sum()
            if s1 > 0: h1 /= s1
            if s2 > 0: h2 /= s2
            parts.append((h1, h2))
        a = np.concatenate([p[0] for p in parts])
        b = np.concatenate([p[1] for p in parts])
        sa, sb = float(a.std()), float(b.std())
        if sa < 1e-9 or sb < 1e-9:
            return 0.0
        corr = float(np.mean((a - a.mean()) * (b - b.mean())) / (sa * sb))
        return max(0.0, min(1.0, corr))
    except Exception:
        return 0.0


def _spatial_color_score(det_color, det_mask, ref_color, ref_mask):
    """4x4 spatial colour-grid cosine similarity."""
    def _grid_vec(rgb, mask):
        if rgb is None:
            return None
        arr = np.asarray(rgb, dtype=np.float32)
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=-1)
        H, W = arr.shape[:2]
        if H < 4 or W < 4:
            return None
        m = (np.asarray(mask).astype(bool)
             if mask is not None and np.asarray(mask).shape[:2] == (H, W)
             else np.ones((H, W), dtype=bool))
        overall = arr[m].mean(axis=0) if m.any() else np.zeros(3, np.float32)
        vec = []
        for gy in range(4):
            y0 = int(round(gy * H / 4.0))
            y1 = int(round((gy + 1) * H / 4.0)) if gy < 3 else H
            for gx in range(4):
                x0 = int(round(gx * W / 4.0))
                x1 = int(round((gx + 1) * W / 4.0)) if gx < 3 else W
                cm = m[y0:y1, x0:x1]; cc = arr[y0:y1, x0:x1]
                v = cc[cm].mean(axis=0) if cm.any() else overall
                vec.extend([float(v[0]), float(v[1]), float(v[2])])
        v = np.asarray(vec, dtype=np.float32)
        v = np.nan_to_num(v, nan=0.0, posinf=0.0, neginf=0.0)
        n = float(np.linalg.norm(v))
        return (v / n) if n > 1e-9 else v
    try:
        v1 = _grid_vec(det_color, det_mask)
        v2 = _grid_vec(ref_color, ref_mask)
        if v1 is None or v2 is None or v1.size == 0 or v2.size == 0:
            return 0.0
        return float(max(0.0, min(1.0, float(np.dot(v1, v2)))))
    except Exception:
        return 0.0


def _depth_geometry_score(det_depth, det_mask, ref_depth, ref_mask):
    """Depth profile histogram + 3x3 spatial grid + hole signature."""
    try:
        if det_depth is None or ref_depth is None:
            return 0.5
        det_d = np.asarray(det_depth, dtype=np.float32)
        ref_d = np.asarray(ref_depth, dtype=np.float32)
        if det_d.size == 0 or ref_d.size == 0:
            return 0.5
        det_m = (np.asarray(det_mask).astype(bool) if det_mask is not None
                 else np.ones(det_d.shape, dtype=bool))
        ref_m = (np.asarray(ref_mask).astype(bool) if ref_mask is not None
                 else np.ones(ref_d.shape, dtype=bool))
        if det_m.shape != det_d.shape:
            det_m = np.ones(det_d.shape, dtype=bool)
        if ref_m.shape != ref_d.shape:
            ref_m = np.ones(ref_d.shape, dtype=bool)
        if ref_d.shape != det_d.shape:
            H, W = det_d.shape
            rh, rw = max(ref_d.shape[0], 1), max(ref_d.shape[1], 1)
            try:
                ref_d = _zoom(ref_d, (H / rh, W / rw), order=1)
                ref_m = (_zoom(ref_m.astype(np.float32),
                               (H / rh, W / rw), order=0) > 0.5)
            except Exception:
                return 0.5
            ref_d = ref_d[:H, :W]; ref_m = ref_m[:H, :W]
            if ref_d.shape != det_d.shape:
                return 0.5
        det_valid = det_m & (det_d > 0) & np.isfinite(det_d)
        ref_valid = ref_m & (ref_d > 0) & np.isfinite(ref_d)
        if det_valid.sum() < 20 or ref_valid.sum() < 20:
            return 0.5
        det_vals = det_d[det_valid]; ref_vals = ref_d[ref_valid]
        det_med = float(np.median(det_vals)); ref_med = float(np.median(ref_vals))

        # profile histogram
        edges = np.linspace(-0.015, 0.015, 17)
        h_det, _ = np.histogram(det_vals - det_med, bins=edges)
        h_ref, _ = np.histogram(ref_vals - ref_med, bins=edges)
        h_det = h_det.astype(np.float32); h_ref = h_ref.astype(np.float32)
        sd, sr = h_det.sum(), h_ref.sum()
        if sd > 0: h_det /= sd
        if sr > 0: h_ref /= sr
        sa, sb = float(h_det.std()), float(h_ref.std())
        if sa < 1e-9 or sb < 1e-9:
            hist_score = 0.5
        else:
            corr = float(np.mean(
                (h_det - h_det.mean()) * (h_ref - h_ref.mean())) / (sa * sb))
            hist_score = max(0.0, min(1.0, corr))

        # 3x3 spatial grid
        H, W = det_d.shape
        det_rel = np.zeros_like(det_d); ref_rel = np.zeros_like(ref_d)
        det_rel[det_valid] = det_d[det_valid] - det_med
        ref_rel[ref_valid] = ref_d[ref_valid] - ref_med

        def _grid_means(rel, valid):
            out = []
            for gy in range(3):
                y0 = int(round(gy * H / 3.0))
                y1 = int(round((gy + 1) * H / 3.0)) if gy < 2 else H
                for gx in range(3):
                    x0 = int(round(gx * W / 3.0))
                    x1 = int(round((gx + 1) * W / 3.0)) if gx < 2 else W
                    cv = valid[y0:y1, x0:x1]; cr = rel[y0:y1, x0:x1]
                    out.append(float(cr[cv].mean()) if int(cv.sum()) >= 3 else 0.0)
            return np.asarray(out, dtype=np.float32)

        gv_det = _grid_means(det_rel, det_valid)
        gv_ref = _grid_means(ref_rel, ref_valid)
        sa, sb = float(gv_det.std()), float(gv_ref.std())
        if sa < 1e-9 or sb < 1e-9:
            spatial_score = 0.5
        else:
            corr = float(np.mean(
                (gv_det - gv_det.mean()) * (gv_ref - gv_ref.mean())) / (sa * sb))
            spatial_score = max(0.0, min(1.0, corr))

        # hole signature
        det_hole = float(np.sum(det_valid & (det_d > (det_med + 0.008))))
        ref_hole = float(np.sum(ref_valid & (ref_d > (ref_med + 0.008))))
        fd = det_hole / float(max(int(det_m.sum()), 1))
        fr = ref_hole / float(max(int(ref_m.sum()), 1))
        denom = max(fd + fr, 1e-3)
        hole_score = 1.0 - abs(fd - fr) / denom
        if fd < 1e-4 and fr < 1e-4:
            hole_score = 1.0
        hole_score = max(0.0, min(1.0, hole_score))
        return float(hist_score * 0.40 + spatial_score * 0.40 + hole_score * 0.20)
    except Exception:
        return 0.5


def _extract_features(gray, mask, max_corners=25, patch_size=16):
    """Harris corners + patch descriptors + LBP histogram.
    Mirrors DepthSegmentNode._extract_features."""
    H, W = gray.shape[:2]
    if H < patch_size or W < patch_size:
        return [], np.zeros(64, dtype=np.float32)
    gray_f = gray.astype(np.float32)
    m_bool = np.asarray(mask).astype(bool)
    if m_bool.shape[:2] != (H, W):
        m_bool = np.ones((H, W), dtype=bool)
    m_float = m_bool.astype(np.float32)
    masked_gray = gray_f * m_float
    try:
        smoothed = ndimage.gaussian_filter(masked_gray, sigma=1.0)
        dx = ndimage.sobel(smoothed, axis=1, mode='nearest')
        dy = ndimage.sobel(smoothed, axis=0, mode='nearest')
        Ixx = ndimage.gaussian_filter(dx * dx, 2.0)
        Iyy = ndimage.gaussian_filter(dy * dy, 2.0)
        Ixy = ndimage.gaussian_filter(dx * dy, 2.0)
        R = Ixx * Iyy - Ixy * Ixy - 0.05 * (Ixx + Iyy) ** 2
        R = np.where(m_bool, R, 0.0)
        R_max = float(R.max()) if R.size else 0.0
        thresh = max(R_max * 0.01, 1e-6) if R_max > 0 else float('inf')
        R_nms = ndimage.maximum_filter(R, size=9)
        peaks_y, peaks_x = np.where((R == R_nms) & (R > thresh))
        if peaks_y.size:
            resp = R[peaks_y, peaks_x]
            order = np.argsort(-resp)
            peaks_y = peaks_y[order]; peaks_x = peaks_x[order]
    except Exception:
        peaks_y = np.array([], dtype=int); peaks_x = np.array([], dtype=int)

    descs = []
    half = patch_size // 2
    for idx in range(min(int(peaks_y.size), int(max_corners))):
        y, x = int(peaks_y[idx]), int(peaks_x[idx])
        y0 = y - half; x0 = x - half
        y1 = y0 + patch_size; x1 = x0 + patch_size
        patch = np.zeros((patch_size, patch_size), dtype=np.float32)
        sy0, sx0 = max(0, -y0), max(0, -x0)
        cy0, cx0 = max(0, y0), max(0, x0)
        cy1, cx1 = min(H, y1), min(W, x1)
        h_take = cy1 - cy0; w_take = cx1 - cx0
        if h_take > 0 and w_take > 0:
            patch[sy0:sy0 + h_take, sx0:sx0 + w_take] = gray_f[cy0:cy1, cx0:cx1]
        std = float(patch.std())
        if std < 0.5:
            continue
        normed = (patch - float(patch.mean())) / std
        descs.append(normed.astype(np.float32).ravel())

    if int(m_bool.sum()) < 20:
        return descs, np.zeros(64, dtype=np.float32)
    try:
        angles = [i * math.pi / 4.0 for i in range(8)]
        lbp_code = np.zeros((H, W), dtype=np.int32)
        for i, ang in enumerate(angles):
            dy_off = int(round(math.sin(ang)))
            dx_off = int(round(math.cos(ang)))
            neighbour = np.roll(np.roll(gray_f, -dy_off, axis=0), -dx_off, axis=1)
            lbp_code |= ((neighbour >= gray_f).astype(np.int32)) << i
        codes_in_mask = lbp_code[m_bool]
        lbp_hist, _ = np.histogram(codes_in_mask, bins=64, range=(0, 256))
        lbp_hist = lbp_hist.astype(np.float32)
        s = lbp_hist.sum()
        if s > 0:
            lbp_hist /= s
    except Exception:
        lbp_hist = np.zeros(64, dtype=np.float32)
    return descs, lbp_hist


def _match_features(det_descs, det_lbp, ref_descs, ref_lbp):
    """Lowe-ratio keypoint matches + LBP histogram correlation.
    Returns score in [0, 1]. Returns 0 when both sides lack keypoints
    AND LBP — but in practice LBP at least is always present (zero
    histogram → 0.5 neutral)."""
    try:
        if (not det_descs or not ref_descs
                or len(det_descs) == 0 or len(ref_descs) == 0):
            keypoint_score = 0.0
            n_good = 0
        else:
            A = np.asarray(det_descs, dtype=np.float32)
            B = np.asarray(ref_descs, dtype=np.float32)
            if A.ndim != 2 or B.ndim != 2 or A.shape[1] != B.shape[1]:
                keypoint_score = 0.0
                n_good = 0
            else:
                aa = np.sum(A * A, axis=1, keepdims=True)
                bb = np.sum(B * B, axis=1, keepdims=True).T
                D2 = aa + bb - 2.0 * (A @ B.T)
                D = np.sqrt(np.maximum(D2, 0.0))
                good = 0
                for i in range(D.shape[0]):
                    row = D[i]
                    if row.size < 2:
                        continue
                    idx2 = np.argpartition(row, 1)[:2]
                    d1, d2 = float(row[idx2[0]]), float(row[idx2[1]])
                    if d1 > d2:
                        d1, d2 = d2, d1
                    if d2 > 1e-6 and d1 < 0.75 * d2:
                        good += 1
                keypoint_score = good / max(int(A.shape[0]), 1)
                keypoint_score = max(0.0, min(1.0, keypoint_score))
                n_good = good

        a = np.asarray(det_lbp, dtype=np.float32)
        b = np.asarray(ref_lbp, dtype=np.float32)
        if a.size == 0 or b.size == 0 or a.size != b.size:
            lbp_score = 0.5
        elif float(a.sum()) <= 0 or float(b.sum()) <= 0:
            lbp_score = 0.5
        else:
            sa, sb = float(a.std()), float(b.std())
            if sa < 1e-9 or sb < 1e-9:
                lbp_score = 0.5
            else:
                corr = float(np.mean(
                    (a - a.mean()) * (b - b.mean())) / (sa * sb))
                lbp_score = max(0.0, min(1.0, (corr + 1.0) / 2.0))
        return float(keypoint_score * 0.60 + lbp_score * 0.40)
    except Exception:
        return 0.0


def _ncc_best_rotation(det_gray, ref_gray, det_px_per_cm, ref_px_per_cm):
    """Best-of-4-rotations physical-scale NCC."""
    if det_gray is None or ref_gray is None or ref_px_per_cm <= 0:
        return 0.0
    crop_h, crop_w = det_gray.shape[:2]
    ref_h, ref_w = ref_gray.shape[:2]
    phys_scale = ref_px_per_cm / max(det_px_per_cm, 0.1)
    target_h = int(round(crop_h * phys_scale))
    target_w = int(round(crop_w * phys_scale))
    if target_h < 20 or target_w < 20 or target_h > 300 or target_w > 300:
        return 0.0
    try:
        det_scaled = _zoom(
            det_gray.astype(np.float32),
            (target_h / crop_h, target_w / crop_w), order=1)
    except Exception:
        return 0.0
    best = 0.0
    for rot in range(4):
        dr = np.rot90(det_scaled, rot) if rot else det_scaled
        mh = min(dr.shape[0], ref_h)
        mw = min(dr.shape[1], ref_w)
        if mh < 15 or mw < 15:
            continue
        a = ref_gray[:mh, :mw].flatten()
        b = dr[:mh, :mw].flatten()
        if a.size != b.size or a.size < 100:
            continue
        a_m, a_s = float(a.mean()), float(a.std())
        b_m, b_s = float(b.mean()), float(b.std())
        if a_s < 1.0 or b_s < 1.0:
            continue
        ncc = float(np.mean((a - a_m) * (b - b_m)) / (a_s * b_s))
        ncc = max(0.0, ncc)
        if ncc > best:
            best = ncc
    return best


def _ref_features(ref):
    """Return (kp_descs, lbp_hist) for a teach ref. Backfills features
    on-the-fly from color+mask when the ref was captured before
    PART 2 (no stored kp_descs/lbp_hist on disk). Production refs
    captured going forward will have both fields and skip the
    backfill."""
    kp = ref.get('kp_descs') or []
    lbp = ref.get('lbp_hist')
    if (kp and lbp is not None
            and isinstance(lbp, np.ndarray) and lbp.size == 64
            and float(lbp.sum()) > 0):
        return kp, lbp
    # Backfill: compute from stored color+mask.
    color = ref.get('color')
    mask  = ref.get('mask')
    if color is None or mask is None:
        return kp, (lbp if isinstance(lbp, np.ndarray) else np.zeros(64, np.float32))
    gray = (np.mean(color.astype(np.float32), axis=2)
            if color.ndim == 3 else color.astype(np.float32))
    return _extract_features(gray, mask)


def score_group(det_gray, det_color, det_mask, det_depth, det_px_per_cm,
                grp_refs, weights=None,
                det_kp=None, det_lbp=None):
    """Per-group five-signal score. Returns (score, breakdown_dict,
    extras_dict) where extras carry keypoint and LBP-correlation
    counts useful for FAIL diagnostics."""
    if weights is None:
        weights = DEFAULT_WEIGHTS
    nccs, hists, spatials, depths, feats = [], [], [], [], []
    feat_kp_sum, feat_kp_n = 0, 0
    feat_lbp_corrs = []

    for ref in grp_refs:
        ref_gray = ref.get('gray')
        ref_color = ref.get('color')
        ref_mask = ref.get('mask')
        ref_depth = ref.get('depth')
        ref_px_per_cm = float(ref.get('px_per_cm') or 10.0)
        nccs.append(_ncc_best_rotation(
            det_gray, ref_gray, det_px_per_cm, ref_px_per_cm))
        if ref_color is not None and det_color is not None:
            hists.append(_color_hist_corr(
                det_color, ref_color, mask1=det_mask, mask2=ref_mask))
            spatials.append(_spatial_color_score(
                det_color, det_mask, ref_color, ref_mask))
        if det_depth is not None and ref_depth is not None:
            depths.append(_depth_geometry_score(
                det_depth, det_mask, ref_depth, ref_mask))
        # Feature matching — backfill ref features when missing.
        ref_kp, ref_lbp = _ref_features(ref)
        feats.append(_match_features(det_kp or [], det_lbp, ref_kp, ref_lbp))
        feat_kp_sum += len(ref_kp)
        feat_kp_n += 1
        # Track LBP correlation separately for the FAIL diagnostic.
        a = np.asarray(det_lbp, dtype=np.float32) if det_lbp is not None else None
        b = np.asarray(ref_lbp, dtype=np.float32)
        if a is not None and a.size and b.size and float(a.sum()) > 0 and float(b.sum()) > 0:
            sa, sb = float(a.std()), float(b.std())
            if sa > 1e-9 and sb > 1e-9:
                corr = float(np.mean(
                    (a - a.mean()) * (b - b.mean())) / (sa * sb))
                feat_lbp_corrs.append(corr)

    if not nccs:
        return 0.0, {'ncc': 0.0, 'hist': 0.0, 'spatial': 0.0,
                     'depth': 0.0, 'feat': 0.0}, {}
    avg_ncc     = float(np.mean(nccs))
    avg_hist    = float(np.mean(hists))    if hists    else 0.5
    avg_spatial = float(np.mean(spatials)) if spatials else 0.5
    avg_depth   = float(np.mean(depths))   if depths   else 0.5
    avg_feat    = float(np.mean(feats))    if feats    else 0.5
    score = (avg_ncc     * weights['ncc']
             + avg_hist    * weights['hist']
             + avg_spatial * weights['spatial']
             + avg_depth   * weights['depth']
             + avg_feat    * weights['feat'])
    breakdown = {
        'ncc': avg_ncc, 'hist': avg_hist,
        'spatial': avg_spatial, 'depth': avg_depth, 'feat': avg_feat,
    }
    extras = {
        'mean_kp_per_ref': (feat_kp_sum / feat_kp_n) if feat_kp_n else 0.0,
        'lbp_corr_mean':   (float(np.mean(feat_lbp_corrs))
                            if feat_lbp_corrs else 0.0),
    }
    return score, breakdown, extras


# ── Loading + main loop ───────────────────────────────────────────

def _load_refs_for_part(part_dir):
    """Return list of dicts (one per ref_*.npz). Skips defect refs."""
    refs = []
    try:
        files = sorted(os.listdir(part_dir))
    except OSError:
        return refs
    for fn in files:
        if not fn.endswith('.npz') or fn.startswith('defects'):
            continue
        full = os.path.join(part_dir, fn)
        try:
            z = np.load(full, allow_pickle=True)
            fileset = set(z.files)
        except Exception:
            continue
        if 'is_defect' in fileset and bool(z['is_defect']):
            continue

        color = (np.asarray(z['color'], dtype=np.uint8)
                 if 'color' in fileset else None)
        if 'gray' in fileset:
            gray = np.asarray(z['gray'], dtype=np.float32)
        elif color is not None:
            gray = (np.mean(color.astype(np.float32), axis=2)
                    if color.ndim == 3 else color.astype(np.float32))
        else:
            gray = None
        mask = (np.asarray(z['mask'], dtype=bool)
                if 'mask' in fileset else None)
        depth = (np.asarray(z['depth'], dtype=np.float32)
                 if 'depth' in fileset else None)
        orientation_str = (str(z['orientation'])
                           if 'orientation' in fileset else 'pickable')
        is_pickable = (bool(z['is_pickable'])
                       if 'is_pickable' in fileset
                       else (orientation_str == 'pickable'))
        label = (str(z['orientation_label'])
                 if 'orientation_label' in fileset else '')
        if 'kp_descs' in fileset:
            raw_kp = np.asarray(z['kp_descs'], dtype=np.float32)
            kp_list = ([raw_kp[i] for i in range(raw_kp.shape[0])]
                       if raw_kp.ndim == 2 else [])
        else:
            kp_list = []
        lbp_arr = (np.asarray(z['lbp_hist'], dtype=np.float32)
                   if 'lbp_hist' in fileset
                   else np.zeros(64, dtype=np.float32))
        refs.append({
            'fn':                fn,
            'gray':              gray,
            'color':             color,
            'mask':              mask,
            'depth':             depth,
            'px_per_cm':         (float(z['px_per_cm'])
                                  if 'px_per_cm' in fileset else 10.0),
            'is_pickable':       is_pickable,
            'orientation_label': label,
            'kp_descs':          kp_list,
            'lbp_hist':          lbp_arr,
        })
    return refs


def _part_name(part_id):
    meta_path = os.path.join(META_BASE, f'{part_id}.json')
    if not os.path.isfile(meta_path):
        return part_id
    try:
        import json as _j
        with open(meta_path) as f:
            return _j.load(f).get('name') or part_id
    except Exception:
        return part_id


def _load_part_weights(part_id):
    """Read overridden orient_weights from the part's metadata json."""
    weights = dict(DEFAULT_WEIGHTS)
    meta_path = os.path.join(META_BASE, f'{part_id}.json')
    if not os.path.isfile(meta_path):
        return weights
    try:
        import json as _j
        with open(meta_path) as f:
            meta = _j.load(f) or {}
        w = meta.get('orient_weights') or {}
        if isinstance(w, dict):
            for k in list(weights.keys()):
                v = w.get(k)
                if isinstance(v, (int, float)) and float(v) >= 0:
                    weights[k] = float(v)
            total = sum(weights.values())
            if total > 0:
                weights = {k: v / total for k, v in weights.items()}
    except Exception:
        pass
    return weights


def main():
    if not os.path.isdir(TEACH_BASE):
        print('No teach refs found at '
              + TEACH_BASE
              + ' — re-teach parts to validate.')
        return

    part_ids = sorted(
        d for d in os.listdir(TEACH_BASE)
        if os.path.isdir(os.path.join(TEACH_BASE, d))
    )
    if not part_ids:
        print('No teach refs found at '
              + TEACH_BASE
              + ' — re-teach parts to validate.')
        return

    rows = []
    overall_correct = 0
    overall_total = 0

    for pid in part_ids:
        part_dir = os.path.join(TEACH_BASE, pid)
        refs = _load_refs_for_part(part_dir)
        if len(refs) < 2:
            continue
        pickable_n = sum(1 for r in refs if r['is_pickable'])
        nonpick_n  = len(refs) - pickable_n
        if pickable_n == 0 or nonpick_n == 0:
            continue

        weights = _load_part_weights(pid)
        agg = {'ncc': 0.0, 'hist': 0.0, 'spatial': 0.0,
               'depth': 0.0, 'feat': 0.0, 'overall': 0.0, 'n': 0}
        correct = 0
        part_failures = []

        for hold_i in range(len(refs)):
            held = refs[hold_i]
            others = [r for i, r in enumerate(refs) if i != hold_i]
            # Backfill held's features if missing (mirrors what the
            # production matcher would compute on a live detection).
            det_kp, det_lbp = _ref_features(held)

            groups = defaultdict(list)
            for r in others:
                groups[(r['is_pickable'], r['orientation_label'])].append(r)

            best_score = -1.0
            best_key = None
            best_breakdown = None
            best_extras = None
            for key, grp in groups.items():
                s, brk, ext = score_group(
                    held['gray'], held['color'], held['mask'],
                    held['depth'], held['px_per_cm'], grp, weights,
                    det_kp=det_kp, det_lbp=det_lbp)
                if s > best_score:
                    best_score = s
                    best_key   = key
                    best_breakdown = brk
                    best_extras    = ext

            if best_breakdown is not None:
                for k in ('ncc', 'hist', 'spatial', 'depth', 'feat'):
                    agg[k] += best_breakdown[k]
                agg['overall'] += best_score
                agg['n'] += 1

            if best_key is not None and best_key[0] == held['is_pickable']:
                correct += 1
            else:
                feat_score = (best_breakdown.get('feat', 0.0)
                              if best_breakdown else 0.0)
                kp_count   = (best_extras.get('mean_kp_per_ref', 0.0)
                              if best_extras else 0.0)
                lbp_corr   = (best_extras.get('lbp_corr_mean', 0.0)
                              if best_extras else 0.0)
                orient_s   = 'pick' if held['is_pickable'] else 'NOpick'
                part_failures.append({
                    'ref':        held['fn'],
                    'orient':     orient_s,
                    'feat_score': feat_score,
                    'kp_count':   kp_count,
                    'lbp_corr':   lbp_corr,
                    'det_kp':     len(det_kp),
                })

        n = max(agg['n'], 1)
        rows.append({
            'name':       _part_name(pid),
            'id':         pid,
            'total':      len(refs),
            'pickable':   pickable_n,
            'nonpick':    nonpick_n,
            'correct':    correct,
            'accuracy':   correct / len(refs),
            'avg_ncc':    agg['ncc']     / n,
            'avg_hist':   agg['hist']    / n,
            'avg_spat':   agg['spatial'] / n,
            'avg_depth':  agg['depth']   / n,
            'avg_feat':   agg['feat']    / n,
            'avg_overall': agg['overall'] / n,
            'failures':   part_failures,
            'weights':    weights,
        })
        overall_correct += correct
        overall_total   += len(refs)

    if not rows:
        print('No parts with BOTH pickable and non-pickable refs found.')
        print('Re-teach at least one part with both groups to validate.')
        return

    # Table.
    name_w = max(20, max(len(r['name']) for r in rows) + 2)
    hdr = (f'{"Part":<{name_w}} {"NCC":>6} {"Hist":>6} {"Spat":>6} '
           f'{"Depth":>6} {"Feat":>6} {"Overall":>8} {"Total":>6} '
           f'{"Pick":>5} {"NoPick":>7} {"Correct":>8} {"Accuracy":>10}')
    print(hdr)
    print('-' * len(hdr))
    for r in rows:
        print(f'{r["name"]:<{name_w}} '
              f'{r["avg_ncc"]:>6.2f} {r["avg_hist"]:>6.2f} '
              f'{r["avg_spat"]:>6.2f} {r["avg_depth"]:>6.2f} '
              f'{r["avg_feat"]:>6.2f} {r["avg_overall"]:>8.2f} '
              f'{r["total"]:>6} {r["pickable"]:>5} {r["nonpick"]:>7} '
              f'{r["correct"]:>8} {r["accuracy"]*100:>9.1f}%')
    print('-' * len(hdr))
    print(f'Overall: {overall_correct}/{overall_total} '
          f'= {overall_correct/overall_total*100:.1f}%')

    # FAIL diagnostics for parts below 80%.
    below = [r for r in rows if r['accuracy'] < 0.80]
    if below:
        print()
        print('FAIL diagnostics for parts below 80% '
              '(feat_score = winning-group avg; '
              'kp_matches = mean keypoints in ref; '
              'lbp_corr = Pearson of held-ref LBP histograms):')
        for r in below:
            w = r['weights']
            print(f'\n  {r["name"]} ({r["id"]}) — {r["accuracy"]*100:.1f}% '
                  f'(weights ncc={w["ncc"]:.2f} hist={w["hist"]:.2f} '
                  f'sp={w["spatial"]:.2f} dep={w["depth"]:.2f} '
                  f'feat={w["feat"]:.2f}):')
            if not r['failures']:
                print('    (no per-ref failures recorded)')
                continue
            for f in r['failures']:
                print(f'    FAIL {f["ref"]} orient={f["orient"]}: '
                      f'feat_score={f["feat_score"]:.2f} '
                      f'kp_matches={f["kp_count"]:.1f} '
                      f'lbp_corr={f["lbp_corr"]:+.2f} '
                      f'(det_kp={f["det_kp"]})')


if __name__ == '__main__':
    main()

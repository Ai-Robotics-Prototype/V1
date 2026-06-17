"""Tablet-camera "STEP + Video Teach" scan pipeline.

The tablet has no depth, so unlike the existing cam0 teach path we
anchor real-world scale to the STEP file's exact dimensions rather
than to RealSense depth. Per-frame flow:

  1. Decode the JPEG snapshot from the tablet.
  2. Reject blurry frames (variance-of-Laplacian below threshold).
  3. Background-subtract (operator captured an empty-surface frame
     first) → largest connected component → binary mask.
  4. Measure the mask's min-area rectangle (pixel L_px, W_px).
  5. STEP-size cross-check: aspect L_px/W_px must agree with the
     CAD aspect L_cm/W_cm within a configurable tolerance (default
     35%, matching the matcher's SIZE_GATE_RATIO_FLOOR=0.65). If
     not, this frame is wrong (occluded part, two parts, bad
     segmentation) — drop it.
  6. Compute px_per_cm = L_px / L_cm — exact scale from CAD.
  7. Estimate yaw from the OBB principal axis (mod 180°). Dedup
     against previously kept frames in this orientation; reject
     if a kept frame within YAW_DEDUP_DEG already exists.
  8. Build the standard teach-ref .npz (same schema the matcher
     reads — see depth_segment_node._save_teach_ref) and drop it
     into /opt/cobot/parts/teach/<part_id>/ as ref_NNN.npz.

The matcher (depth_segment_node._match_part) reads these refs
unchanged. depth field is set to zeros (matcher's depth weight is
0.0 by default; depth_median set to 0.0 makes the source
identifiable in debug). distance_m gets a sentinel of 0.0 so
downstream code can tell tablet refs apart from cam0 refs.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import cv2
import numpy as np
from PIL import Image as PILImage
from scipy.ndimage import (
    binary_erosion, binary_fill_holes,
    binary_opening, label as _label,
)


# ── Paths ────────────────────────────────────────────────────────────
_PARTS_DIR    = '/opt/cobot/parts'
_METADATA_DIR = os.path.join(_PARTS_DIR, 'metadata')
_TEACH_DIR    = os.path.join(_PARTS_DIR, 'teach')
_SCAN_DIR     = os.path.join(_PARTS_DIR, 'scan_sessions')


# ── Tuning ───────────────────────────────────────────────────────────
# Variance-of-Laplacian threshold; below = blurry. Tablet cameras
# typically score 80-300 on a well-lit static part.
BLUR_VAR_FLOOR        = 35.0
# Background-subtraction threshold per channel (uint8).
BG_DIFF_THRESHOLD     = 22
# Mask cleanup
MASK_MIN_AREA_PX      = 500
MASK_MAX_AREA_FRAC    = 0.80  # part can't fill the whole frame
MASK_BORDER_FRAC      = 0.005 # if the largest CC touches > 0.5% of border, reject (cropped)
# STEP aspect tolerance — match the matcher's gate.
SIZE_GATE_RATIO_FLOOR = 0.65
# Dedup yaws — refs within this angular distance are duplicates.
YAW_DEDUP_DEG         = 12.0
# Cap the long side of the saved crop (matches depth_segment_node).
MAX_REF_SIZE_PX       = 128


# ── State container (per part_id session) ────────────────────────────
class ScanSession:
    """In-memory per-part scan session held by the dashboard.

    Owns the background frame + a record of yaws already captured
    so the dedup check stays cheap. Frames are written through to
    /opt/cobot/parts/teach/<part_id>/ as ref_NNN.npz exactly like
    cam0-driven teaches; the loader picks them up unchanged.
    """

    def __init__(self, part_id: str):
        self.part_id = part_id
        self.background_bgr: np.ndarray | None = None
        self.background_at: float = 0.0
        # Yaw bins (degrees, [0, 180)) of frames already accepted for
        # the active orientation. Reset when orientation changes.
        self.kept_yaws: dict[str, list[float]] = {}
        self.rejected_counts: dict[str, int] = {}
        self.kept_count: int = 0
        self.created_at = time.time()


_SESSIONS: dict[str, ScanSession] = {}


def get_session(part_id: str, create: bool = True) -> ScanSession | None:
    s = _SESSIONS.get(part_id)
    if s is None and create:
        s = ScanSession(part_id)
        _SESSIONS[part_id] = s
    return s


def reset_session(part_id: str) -> None:
    _SESSIONS.pop(part_id, None)


# ── Part metadata ────────────────────────────────────────────────────
def load_part_extents_cm(part_id: str) -> tuple[float, float, float] | None:
    """Read the STEP-derived dimensions in centimetres for this part.

    Returns the long, short, and height (depth) extents sorted
    descending — same convention the matcher uses for size-gate
    comparison.
    """
    path = os.path.join(_METADATA_DIR, f'{part_id}.json')
    if not os.path.isfile(path):
        return None
    try:
        with open(path) as f:
            meta = json.load(f)
    except Exception:
        return None
    ext = meta.get('extents_cm')
    if not isinstance(ext, list) or len(ext) < 3:
        return None
    try:
        s = sorted((float(ext[0]), float(ext[1]), float(ext[2])), reverse=True)
        return s[0], s[1], s[2]
    except Exception:
        return None


def has_step(part_id: str) -> bool:
    """A part has a STEP if its metadata.json has extents_cm — that's
    the field the STEP parser writes whether the source was a .step
    or .stl upload, and it's what the matcher's size-gate keys off."""
    return load_part_extents_cm(part_id) is not None


# ── JPEG decode ──────────────────────────────────────────────────────
def decode_jpeg_to_bgr(buf: bytes) -> np.ndarray | None:
    arr = np.frombuffer(buf, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img  # BGR or None


# ── Blur ─────────────────────────────────────────────────────────────
def laplacian_variance(bgr: np.ndarray) -> float:
    """Variance of the Laplacian — the classic Pech-Pacheco focus
    metric. Lower = blurrier. Tablet cameras at 30 cm produce
    ~80-300 on a static well-lit part."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    lap  = cv2.Laplacian(gray, cv2.CV_64F)
    return float(lap.var())


# ── Segmentation ─────────────────────────────────────────────────────
def segment_part(frame_bgr: np.ndarray, bg_bgr: np.ndarray,
                 ) -> tuple[np.ndarray | None, str]:
    """Background-subtract and return a binary mask of the largest
    component, or (None, reason)."""
    if frame_bgr.shape[:2] != bg_bgr.shape[:2]:
        bg_bgr = cv2.resize(bg_bgr, (frame_bgr.shape[1], frame_bgr.shape[0]))
    diff = cv2.absdiff(frame_bgr, bg_bgr)
    # Use the maximum-channel difference: robust to colour swings
    # while still letting bright-on-dark and dark-on-bright work.
    diff_max = diff.max(axis=2)
    raw_mask = diff_max > BG_DIFF_THRESHOLD
    # 3x3 open to drop salt noise; fill small holes; pick largest CC.
    cleaned = binary_opening(raw_mask, iterations=2)
    cleaned = binary_fill_holes(cleaned)
    labeled, n = _label(cleaned)
    if n == 0:
        return None, 'no_part_detected'
    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0
    largest = int(np.argmax(sizes))
    mask = (labeled == largest)
    area = int(mask.sum())
    frame_area = frame_bgr.shape[0] * frame_bgr.shape[1]
    if area < MASK_MIN_AREA_PX:
        return None, f'part_too_small ({area}px)'
    if area > MASK_MAX_AREA_FRAC * frame_area:
        return None, 'part_fills_frame'
    # Cropped at the edge → bad view
    h, w = mask.shape
    border = (int(mask[0, :].sum()) + int(mask[-1, :].sum())
              + int(mask[:, 0].sum()) + int(mask[:, -1].sum()))
    if border > MASK_BORDER_FRAC * (2 * (h + w)):
        return None, 'part_touches_edge'
    return mask, 'ok'


# ── OBB measurement ──────────────────────────────────────────────────
def measure_obb(mask: np.ndarray) -> tuple[float, float, float, np.ndarray]:
    """Return (long_px, short_px, yaw_deg_in_[0,180), box_pts).

    yaw is the angle of the long axis from the image x-axis.
    """
    ys, xs = np.where(mask)
    pts = np.column_stack([xs, ys]).astype(np.float32)
    rect = cv2.minAreaRect(pts)
    (cx, cy), (w, h), angle = rect
    if w >= h:
        long_px, short_px = float(w), float(h)
        # angle is the rotation of the rect; the long side aligns
        # with the angle when w >= h.
        yaw = angle
    else:
        long_px, short_px = float(h), float(w)
        yaw = angle + 90.0
    yaw = yaw % 180.0
    box = cv2.boxPoints(rect)
    return long_px, short_px, yaw, box


# ── STEP-size cross-check ────────────────────────────────────────────
def step_aspect_ok(long_px: float, short_px: float,
                   step_extents_cm: tuple[float, float, float],
                   ) -> tuple[bool, float, float]:
    """Compare measured aspect to STEP aspect.

    Returns (passes, measured_aspect, step_aspect).
    """
    if short_px <= 1e-3:
        return False, 0.0, 0.0
    measured = long_px / short_px
    step_long, step_short, _ = step_extents_cm
    if step_short <= 1e-3:
        return False, measured, 0.0
    step_aspect = step_long / step_short
    ratio = min(measured, step_aspect) / max(measured, step_aspect)
    return ratio >= SIZE_GATE_RATIO_FLOOR, measured, step_aspect


# ── Yaw dedup ────────────────────────────────────────────────────────
def yaw_already_covered(yaw: float, kept_yaws: list[float]) -> bool:
    for y in kept_yaws:
        d = abs(yaw - y)
        d = min(d, 180.0 - d)
        if d < YAW_DEDUP_DEG:
            return True
    return False


# ── Build the .npz ref ───────────────────────────────────────────────
def _next_ref_index(teach_dir: str) -> int:
    if not os.path.isdir(teach_dir):
        return 0
    return sum(1 for f in os.listdir(teach_dir)
               if f.endswith('.npz') and not f.startswith('defects'))


def _zoom_image(img: np.ndarray, scale: float) -> np.ndarray:
    h, w = img.shape[:2]
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR
    if img.ndim == 2:
        if img.dtype == bool:
            res = cv2.resize(img.astype(np.uint8), (new_w, new_h),
                             interpolation=cv2.INTER_NEAREST) > 0
        else:
            res = cv2.resize(img, (new_w, new_h), interpolation=interp)
    else:
        res = cv2.resize(img, (new_w, new_h), interpolation=interp)
    return res


def _edge_map(gray_uint8: np.ndarray) -> np.ndarray:
    smoothed = cv2.GaussianBlur(gray_uint8, (0, 0), sigmaX=1.0)
    gx = cv2.Sobel(smoothed.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(smoothed.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx * gx + gy * gy)
    m = float(mag.max())
    if m <= 0:
        return np.zeros_like(gray_uint8, dtype=np.uint8)
    return ((mag / m) > 0.15).astype(np.uint8)


def _contour_points(mask_bool: np.ndarray) -> np.ndarray | None:
    if not mask_bool.any():
        return None
    eroded = binary_erosion(mask_bool, iterations=1)
    boundary = mask_bool & ~eroded
    ys, xs = np.where(boundary)
    if len(ys) <= 10:
        return None
    h, w = mask_bool.shape
    pts = np.column_stack([xs.astype(np.float32) / max(w, 1),
                           ys.astype(np.float32) / max(h, 1)]).astype(np.float32)
    if len(pts) > 200:
        idx = np.linspace(0, len(pts) - 1, 200, dtype=int)
        pts = pts[idx]
    return pts


def _lbp_hist_zeros() -> np.ndarray:
    # Matcher tolerates zero-LBP refs (the keypoint+LBP signal weight
    # is 0.0 by default). Saving zeros keeps the schema consistent.
    return np.zeros(64, dtype=np.float32)


def save_scan_ref(part_id: str,
                  frame_bgr: np.ndarray, mask: np.ndarray,
                  long_px: float, short_px: float, yaw_deg: float,
                  px_per_cm: float, step_extents_cm: tuple[float, float, float],
                  orientation: str, orientation_number: int,
                  orientation_label: str, is_pickable: bool,
                  ) -> tuple[str, int]:
    """Write a teach .npz that matches the matcher's expected schema.

    Returns (output_path, ref_index).
    """
    teach_dir = os.path.join(_TEACH_DIR, part_id)
    os.makedirs(teach_dir, exist_ok=True)
    ref_id = _next_ref_index(teach_dir)
    out_path = os.path.join(teach_dir, f'ref_{ref_id:03d}.npz')

    # Bounding-box crop around the part with a 6 px margin.
    ys, xs = np.where(mask)
    y0, y1 = max(int(ys.min()) - 6, 0), min(int(ys.max()) + 7, mask.shape[0])
    x0, x1 = max(int(xs.min()) - 6, 0), min(int(xs.max()) + 7, mask.shape[1])
    crop_bgr  = frame_bgr[y0:y1, x0:x1]
    crop_mask = mask[y0:y1, x0:x1]

    # Downsample to ≤ MAX_REF_SIZE_PX long side, same convention as
    # depth_segment_node._save_teach_ref.
    crop_h, crop_w = crop_mask.shape[:2]
    long_side = max(crop_h, crop_w)
    scale = 1.0 if long_side <= MAX_REF_SIZE_PX else (MAX_REF_SIZE_PX / float(long_side))
    if scale < 1.0:
        ref_mask  = _zoom_image(crop_mask, scale)
        ref_bgr   = _zoom_image(crop_bgr, scale)
        # px_per_cm must follow the scale of the saved crop, since
        # the matcher rescales the runtime detection to the ref's
        # physical resolution from this number.
        px_per_cm_saved = float(px_per_cm * scale)
    else:
        ref_mask  = crop_mask.copy()
        ref_bgr   = crop_bgr.copy()
        px_per_cm_saved = float(px_per_cm)
    ref_rgb = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2RGB)

    gray_f32 = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    edges    = _edge_map(cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY))
    contour  = _contour_points(ref_mask)

    # size_m comes straight from the STEP — the whole point of the
    # tablet path. Convert cm → m and sort descending.
    sL, sW, sH = step_extents_cm
    size_m = np.array([sL / 100.0, sW / 100.0, sH / 100.0], dtype=np.float32)

    ref_h, ref_w = ref_mask.shape[:2]
    save_data: dict[str, Any] = {
        'size_m':             size_m,
        'yaw_deg':            np.float32(yaw_deg),
        'orientation':        orientation,
        'orientation_number': np.int32(orientation_number),
        'orientation_label':  orientation_label,
        'is_pickable':        np.bool_(is_pickable),
        'is_defect':          np.bool_(False),
        'defect_name':        '',
        'crop_shape':         np.array([ref_h, ref_w], dtype=np.int32),
        'num_holes':          np.int32(0),
        'distance_m':         np.float32(0.0),   # no depth on tablet path
        'px_per_cm':          np.float32(px_per_cm_saved),
        'scale_factor':       np.float32(scale),
        'color':              ref_rgb.astype(np.uint8),
        'gray':               gray_f32,
        'mask':               ref_mask.astype(bool),
        'edges':              edges.astype(np.uint8),
        'lbp_hist':           _lbp_hist_zeros(),
        # Marker so debug tools can tell tablet refs apart from cam0 ones.
        'source':             'tablet_scan',
    }
    if contour is not None:
        save_data['contour'] = contour

    np.savez_compressed(out_path, **save_data)

    # PNG preview alongside (matches depth_segment_node convention).
    try:
        PILImage.fromarray(ref_rgb).save(
            os.path.join(teach_dir, f'ref_{ref_id:03d}.png'))
    except Exception:
        pass

    return out_path, ref_id


# ── Top-level frame ingest ───────────────────────────────────────────
def ingest_frame(part_id: str, frame_jpeg: bytes, orientation: str,
                 orientation_number: int, orientation_label: str,
                 is_pickable: bool,
                 ) -> dict[str, Any]:
    """Process one tablet snapshot. Returns a JSON-safe dict the
    endpoint hands back to the wizard."""
    session = get_session(part_id, create=True)
    if session.background_bgr is None:
        return {'ok': False, 'kept': False, 'reason': 'no_background',
                'message': 'Capture an empty-surface background frame first.'}

    extents = load_part_extents_cm(part_id)
    if extents is None:
        return {'ok': False, 'kept': False, 'reason': 'no_step',
                'message': 'Part has no STEP/STL geometry — upload one first.'}

    bgr = decode_jpeg_to_bgr(frame_jpeg)
    if bgr is None or bgr.size == 0:
        return {'ok': False, 'kept': False, 'reason': 'decode_failed',
                'message': 'Could not decode the JPEG frame.'}

    blur = laplacian_variance(bgr)
    if blur < BLUR_VAR_FLOOR:
        _bump(session.rejected_counts, 'blurry')
        return _result(session, kept=False, reason='blurry',
                       blur=blur, message=f'Blurry frame (var={blur:.0f}).')

    mask, seg_reason = segment_part(bgr, session.background_bgr)
    if mask is None:
        _bump(session.rejected_counts, seg_reason)
        return _result(session, kept=False, reason=seg_reason,
                       blur=blur, message=f'Segmentation: {seg_reason}.')

    long_px, short_px, yaw_deg, _ = measure_obb(mask)
    aspect_ok, measured_aspect, step_aspect = step_aspect_ok(
        long_px, short_px, extents)
    if not aspect_ok:
        _bump(session.rejected_counts, 'step_aspect_mismatch')
        return _result(session, kept=False, reason='step_aspect_mismatch',
                       blur=blur, yaw_deg=yaw_deg,
                       measured_aspect=measured_aspect,
                       step_aspect=step_aspect,
                       message=f'Measured aspect {measured_aspect:.2f} '
                               f'disagrees with STEP {step_aspect:.2f}.')

    px_per_cm = long_px / max(extents[0], 1e-3)

    kept_yaws_for_orient = session.kept_yaws.setdefault(orientation, [])
    if yaw_already_covered(yaw_deg, kept_yaws_for_orient):
        _bump(session.rejected_counts, 'duplicate_yaw')
        return _result(session, kept=False, reason='duplicate_yaw',
                       blur=blur, yaw_deg=yaw_deg,
                       measured_aspect=measured_aspect,
                       step_aspect=step_aspect,
                       px_per_cm=px_per_cm,
                       message=f'Yaw {yaw_deg:.0f}° already covered.')

    out_path, ref_id = save_scan_ref(
        part_id, bgr, mask, long_px, short_px, yaw_deg,
        px_per_cm, extents,
        orientation, orientation_number, orientation_label, is_pickable)

    kept_yaws_for_orient.append(yaw_deg)
    session.kept_count += 1
    return _result(session, kept=True, reason='kept',
                   blur=blur, yaw_deg=yaw_deg,
                   measured_aspect=measured_aspect, step_aspect=step_aspect,
                   px_per_cm=px_per_cm, ref_id=ref_id,
                   message=f'Kept ref_{ref_id:03d} at yaw {yaw_deg:.0f}°.')


def _bump(d: dict[str, int], key: str) -> None:
    d[key] = d.get(key, 0) + 1


def _result(session: ScanSession, **kw: Any) -> dict[str, Any]:
    kw['ok']               = True
    kw['part_id']          = session.part_id
    kw['kept_total']       = session.kept_count
    kw['kept_yaws']        = {k: list(v) for k, v in session.kept_yaws.items()}
    kw['rejected_counts']  = dict(session.rejected_counts)
    kw['has_background']   = session.background_bgr is not None
    return kw


# ── Background capture ───────────────────────────────────────────────
def set_background(part_id: str, frame_jpeg: bytes) -> dict[str, Any]:
    bgr = decode_jpeg_to_bgr(frame_jpeg)
    if bgr is None or bgr.size == 0:
        return {'ok': False, 'reason': 'decode_failed'}
    session = get_session(part_id, create=True)
    session.background_bgr = bgr
    session.background_at  = time.time()
    h, w = bgr.shape[:2]
    return {'ok': True, 'width': w, 'height': h,
            'captured_at': session.background_at}


def session_status(part_id: str) -> dict[str, Any]:
    s = get_session(part_id, create=False)
    if s is None:
        return {'ok': True, 'has_session': False, 'has_background': False,
                'kept_total': 0, 'kept_yaws': {}, 'rejected_counts': {}}
    return {
        'ok':               True,
        'has_session':      True,
        'has_background':   s.background_bgr is not None,
        'background_at':    s.background_at,
        'kept_total':       s.kept_count,
        'kept_yaws':        {k: list(v) for k, v in s.kept_yaws.items()},
        'rejected_counts':  dict(s.rejected_counts),
    }

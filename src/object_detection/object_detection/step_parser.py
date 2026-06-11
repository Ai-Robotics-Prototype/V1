"""Parse STEP/STP CAD files into part geometry usable by the planner.

Returns a dict with bounding box, centroid, principal axes, volume, and
a convex-hull mesh for collision checking. Also writes a .stl alongside
the source .step so the dashboard can render a 3D preview without
re-parsing every time.

Backend: trimesh + cascadio (cascadio supplies the OpenCASCADE STEP
loader as a shared object; trimesh.load handles the rest). cascadio
ships aarch64 wheels so this works on the Jetson.
"""
import hashlib
import os

import numpy as np
import trimesh

try:
    from PIL import Image, ImageDraw
    _PIL_OK = True
except ImportError:
    _PIL_OK = False

try:
    from scipy.ndimage import binary_fill_holes
    _SCIPY_OK = True
except ImportError:
    _SCIPY_OK = False


# ── CAD geometric features used for live camera matching ──────────────

def extract_geometric_features(mesh, img_size: int = 128) -> dict:
    """Top-down geometric fingerprint of a CAD mesh.

    Produces the same descriptors the live depth_segment_node extracts
    from a per-detection depth crop, so the matcher can compare them
    directly: hole count + relative geometry, normalised top-down
    height map, edge map, outline, aspect, symmetry, scale."""
    from scipy.ndimage import (
        binary_fill_holes as _fill,
        label as _label,
        sobel as _sobel,
        zoom as _zoom,
    )

    features: dict = {}
    verts = np.asarray(mesh.vertices)
    if verts.size == 0:
        return features
    x = verts[:, 0]; y = verts[:, 1]; z = verts[:, 2]

    x_range = float(x.max() - x.min()) or 1e-3
    y_range = float(y.max() - y.min()) or 1e-3
    scale = (img_size - 10) / max(x_range, y_range)

    px = ((x - x.min()) * scale + 5).astype(int).clip(0, img_size - 1)
    py = ((y - y.min()) * scale + 5).astype(int).clip(0, img_size - 1)

    height_map = np.full((img_size, img_size), -np.inf, dtype=np.float64)
    min_height_map = np.full((img_size, img_size), np.inf, dtype=np.float64)
    # Vectorised max/min via np.maximum.at / np.minimum.at — same effect
    # as the per-vertex loop in the spec but ~100x faster on real meshes.
    np.maximum.at(height_map, (py, px), z)
    np.minimum.at(min_height_map, (py, px), z)

    valid = height_map > -np.inf
    if valid.any():
        h_min = float(height_map[valid].min())
        h_max = float(height_map[valid].max())
        if h_max > h_min:
            norm_height = (height_map - h_min) / (h_max - h_min)
            norm_height[~valid] = 0.0
        else:
            norm_height = np.zeros_like(height_map)
    else:
        h_min = 0.0; h_max = 0.0
        norm_height = np.zeros((img_size, img_size), dtype=np.float64)

    outline = valid
    filled = _fill(outline)
    hole_mask = filled & ~outline
    labeled_holes, num_holes = _label(hole_mask)

    holes = []
    for h in range(1, num_holes + 1):
        hy, hx = np.where(labeled_holes == h)
        area = int(len(hy))
        cy = float(np.mean(hy)) / img_size
        cx = float(np.mean(hx)) / img_size
        radius = float(np.sqrt(area / np.pi)) / img_size
        holes.append({
            'center':     [round(cx, 3), round(cy, 3)],
            'radius_norm': round(radius, 4),
            'area_norm':   round(area / (img_size * img_size), 4),
        })
    features['holes'] = holes
    features['num_holes'] = int(num_holes)

    target = 32
    height_32 = _zoom(norm_height, target / img_size, order=1)
    features['height_map_32'] = np.round(height_32, 4).tolist()

    edge_x = _sobel(norm_height, axis=1)
    edge_y = _sobel(norm_height, axis=0)
    edge_mag = np.sqrt(edge_x ** 2 + edge_y ** 2)
    edge_32 = _zoom(edge_mag, target / img_size, order=1)
    features['edge_map_32'] = np.round(edge_32, 4).tolist()

    outline_32 = _zoom(outline.astype(float), target / img_size, order=0) > 0.5
    features['outline_32'] = outline_32.tolist()

    if valid.any():
        heights = height_map[valid]
        features['height_mean']  = round(float(np.mean(heights)), 4)
        features['height_std']   = round(float(np.std(heights)), 4)
        features['height_range'] = round(float(h_max - h_min), 4)

    rows = np.any(outline, axis=1)
    cols = np.any(outline, axis=0)
    if rows.any() and cols.any():
        rh = int(np.where(rows)[0][-1] - np.where(rows)[0][0] + 1)
        rw = int(np.where(cols)[0][-1] - np.where(cols)[0][0] + 1)
        features['aspect_ratio'] = round(rw / max(rh, 1), 3)

        # IoU of foreground vs its flip — bounded to [0, 1]. The spec
        # used `outline == fliplr` over the whole grid which counted
        # matching empty-background pixels and produced values >> 1.
        lr = np.fliplr(outline); ud = np.flipud(outline)
        lr_sym = float(np.sum(outline & lr)) / max(int(np.sum(outline | lr)), 1)
        ud_sym = float(np.sum(outline & ud)) / max(int(np.sum(outline | ud)), 1)
        features['symmetry_lr'] = round(lr_sym, 3)
        features['symmetry_ud'] = round(ud_sym, 3)

    features['scale_m_per_px'] = round(1.0 / scale, 6)
    features['part_width_m']   = round(x_range, 4)
    features['part_height_m']  = round(y_range, 4)
    return features


# ── Shape descriptors used for camera-to-CAD matching ──────────────────

def _hu_moments(mask: np.ndarray) -> np.ndarray:
    """7 rotation/scale-invariant Hu moments from a binary mask."""
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
    """Max radial distance per angle bin, normalised. Rotation invariant
    after cyclic shift; the matcher tries all shifts when comparing."""
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
    max_d = float(sig.max()) if sig.max() > 0 else 1.0
    return sig / max_d


def _generate_silhouettes(mesh, output_dir: str, part_id: str,
                          num_angles: int = 12, img_size: int = 128):
    """Render the mesh from `num_angles` yaw rotations (top-down view)
    and return a list of shape descriptors. Saves each silhouette as
    a PNG next to the other part assets for debugging."""
    if not _PIL_OK:
        return []
    os.makedirs(output_dir, exist_ok=True)
    margin = 10
    silhouettes = []

    for i in range(num_angles):
        yaw = i * (360.0 / num_angles)
        rotated = mesh.copy()
        rot = trimesh.transformations.rotation_matrix(
            np.radians(yaw), [0, 0, 1])
        rotated.apply_transform(rot)

        verts = rotated.vertices
        if len(verts) == 0:
            continue
        x = verts[:, 0]
        y = verts[:, 1]
        x_range = float(x.max() - x.min()) or 1e-3
        y_range = float(y.max() - y.min()) or 1e-3
        scale = (img_size - 2 * margin) / max(x_range, y_range)
        px = ((x - x.min()) * scale + margin).astype(np.int32)
        py = ((y - y.min()) * scale + margin).astype(np.int32)

        img = Image.new('L', (img_size, img_size), 0)
        draw = ImageDraw.Draw(img)
        for face in rotated.faces:
            pts = [(int(px[v]), int(py[v])) for v in face]
            draw.polygon(pts, fill=255)

        mask = np.asarray(img) > 127
        rows = np.any(mask, axis=1)
        cols = np.any(mask, axis=0)
        if rows.any() and cols.any():
            r0, r1 = np.where(rows)[0][[0, -1]]
            c0, c1 = np.where(cols)[0][[0, -1]]
            aspect = (c1 - c0 + 1) / max(r1 - r0 + 1, 1)
        else:
            aspect = 1.0

        area = int(mask.sum())
        if _SCIPY_OK and area:
            hull_area = int(binary_fill_holes(mask).sum())
            solidity = area / max(hull_area, 1)
        else:
            solidity = 1.0

        hu = _hu_moments(mask)
        contour = _contour_signature(mask)

        silhouettes.append({
            'yaw_deg':            float(yaw),
            'hu_moments':         [round(float(v), 8) for v in hu],
            'aspect_ratio':       round(float(aspect), 4),
            'solidity':           round(float(solidity), 4),
            'contour_signature':  [round(float(v), 4) for v in contour],
            'area_ratio':         round(area / (img_size * img_size), 4),
        })

        try:
            img.save(os.path.join(output_dir, f'{part_id}_yaw{int(yaw):03d}.png'))
        except Exception:
            pass

    return silhouettes


# 6 viewing directions for orientation-aware template rendering.
# Each rotates the mesh so the named face points UP (+Z), so a top-down
# camera then sees that face. `label` tells the picker whether the part
# is in a usable orientation.
import math as _math

_RECOG_ORIENTATIONS = (
    {'name': 'top',    'label': 'pickable', 'rotation': (0.0,          0.0,            0.0)},
    {'name': 'bottom', 'label': 'flipped',  'rotation': (_math.pi,     0.0,            0.0)},
    {'name': 'right',  'label': 'on_side',  'rotation': (0.0,         -_math.pi / 2.0, 0.0)},
    {'name': 'left',   'label': 'on_side',  'rotation': (0.0,          _math.pi / 2.0, 0.0)},
    {'name': 'front',  'label': 'on_side',  'rotation': ( _math.pi / 2.0, 0.0,         0.0)},
    {'name': 'back',   'label': 'on_side',  'rotation': (-_math.pi / 2.0, 0.0,         0.0)},
)


def extract_face_features(mesh, img_size: int = 128,
                          margin: int = 8) -> dict:
    """Extract feature anchor positions for each of the 6 face
    orientations of a CAD mesh.

    For each orientation (top, bottom, right, left, front, back),
    rotates the mesh so that face points +Z, projects vertices top-
    down into an `img_size`×`img_size` height map, then locates:
      - holes:  regions significantly BELOW median surface height
                (recesses, counterbores, through-holes)
      - bosses: regions significantly ABOVE median surface height
                (raised pads, embossed features)

    Coordinates are normalised to [0, 1] of the rendered face bbox
    so the camera-side matcher can compare directly against live
    detection blob centroids without worrying about CAD vs sensor
    pixel scale.

    Returns a dict keyed by orient_name (top/bottom/right/left/
    front/back). Each value carries `holes`, `bosses`, and a
    `has_features` flag the matcher uses to short-circuit out for
    flat faces (no penalty in scoring when CAD has nothing to
    verify against).
    """
    from scipy.ndimage import (
        label as _label, binary_erosion)

    result = {}

    for orient in _RECOG_ORIENTATIONS:
        orient_name = orient['name']
        rot_mat = trimesh.transformations.euler_matrix(
            float(orient['rotation'][0]),
            float(orient['rotation'][1]),
            float(orient['rotation'][2]))
        oriented = mesh.copy()
        oriented.apply_transform(rot_mat)

        verts = oriented.vertices
        if len(verts) == 0:
            result[orient_name] = {
                'holes': [], 'bosses': [],
                'has_features': False}
            continue

        x = verts[:, 0]; y = verts[:, 1]; z = verts[:, 2]
        x_range = float(x.max() - x.min()) or 1e-3
        y_range = float(y.max() - y.min()) or 1e-3
        scale = (img_size - 2 * margin) / max(x_range, y_range)

        px = ((x - x.min()) * scale + margin
              ).astype(int).clip(0, img_size - 1)
        py = ((y - y.min()) * scale + margin
              ).astype(int).clip(0, img_size - 1)

        # Top-down height map: max z per pixel. Picks up only the
        # surface visible from above (matches what a top-down camera
        # would see).
        height_map = np.full(
            (img_size, img_size), -np.inf, dtype=np.float64)
        np.maximum.at(height_map, (py, px), z)
        valid = height_map > -np.inf
        if not valid.any():
            result[orient_name] = {
                'holes': [], 'bosses': [],
                'has_features': False}
            continue

        h_vals = height_map[valid]
        h_min = float(h_vals.min())
        h_max = float(h_vals.max())
        norm_h = np.zeros((img_size, img_size), dtype=np.float64)
        if h_max > h_min:
            norm_h[valid] = (height_map[valid] - h_min) / (h_max - h_min)

        # Erode 3 px so outline pixels (which sit at the part edge,
        # often at a different height than the surface interior)
        # don't masquerade as features.
        interior = binary_erosion(valid, iterations=3)
        if not interior.any():
            interior = valid

        int_vals = norm_h[interior]
        med_h = float(np.median(int_vals))
        std_h = float(int_vals.std())
        if std_h < 0.01:
            std_h = 0.01

        # ── Holes: interior pixels well below the surface ─────────
        hole_mask = interior & (norm_h < med_h - 0.5 * std_h)
        labeled_h, n_h = _label(hole_mask)
        holes = []
        for i in range(1, n_h + 1):
            ys, xs = np.where(labeled_h == i)
            area = int(len(ys))
            if area < 10:
                continue
            cx = float(np.clip(
                (np.mean(xs) - margin) / max(img_size - 2 * margin, 1),
                0.0, 1.0))
            cy = float(np.clip(
                (np.mean(ys) - margin) / max(img_size - 2 * margin, 1),
                0.0, 1.0))
            radius_norm = float(
                np.sqrt(area / np.pi) / max(img_size - 2 * margin, 1))
            holes.append({
                'center':      [round(cx, 3), round(cy, 3)],
                'radius_norm': round(radius_norm, 4),
                'area_px':     area,
            })

        # ── Bosses: interior pixels well above the surface ────────
        boss_mask = interior & (norm_h > med_h + 0.5 * std_h)
        labeled_b, n_b = _label(boss_mask)
        bosses = []
        for i in range(1, n_b + 1):
            ys, xs = np.where(labeled_b == i)
            area = int(len(ys))
            if area < 10:
                continue
            cx = float(np.clip(
                (np.mean(xs) - margin) / max(img_size - 2 * margin, 1),
                0.0, 1.0))
            cy = float(np.clip(
                (np.mean(ys) - margin) / max(img_size - 2 * margin, 1),
                0.0, 1.0))
            bosses.append({
                'center':  [round(cx, 3), round(cy, 3)],
                'area_px': area,
            })

        has_features = bool(holes or bosses)
        result[orient_name] = {
            'holes':        holes,
            'bosses':       bosses,
            'has_features': has_features,
        }

    return result


# ── New architecture: STEP as a feature dictionary, not an identifier ──
#
# These helpers take the per-face hole/boss extraction from
# `extract_face_features` above and convert it into:
#   1. A flat list of geometric features with stable IDs and a
#      distinctiveness score.
#   2. Per-orientation feature signatures (which features are visible from
#      each viewpoint) so the live matcher can BOOST orientation
#      confidence — but NOT identity.
#
# The hard rule is documented in src/object_detection/CHANGES.md: STEP
# files contribute only to orientation; identity must come from taught
# camera images + size. These helpers exist so the dashboard and
# orientation booster have a clean source of truth.

FACE_NAMES = ('top', 'bottom', 'right', 'left', 'front', 'back')

# Outward face normals for the canonical orientations. Mirrors the
# rotations used in `extract_face_features` so a hole that appears on
# the "+Z" face when the part is in its native pose maps to the 'top'
# orientation here.
FACE_NORMALS = {
    'top':    (0.0,  0.0,  1.0),
    'bottom': (0.0,  0.0, -1.0),
    'right':  (1.0,  0.0,  0.0),
    'left':  (-1.0,  0.0,  0.0),
    'front':  (0.0,  1.0,  0.0),
    'back':   (0.0, -1.0,  0.0),
}

OPPOSITE_FACE = {
    'top': 'bottom', 'bottom': 'top',
    'right': 'left', 'left': 'right',
    'front': 'back', 'back': 'front',
}


def _detect_slots_on_face(face_dict: dict) -> list:
    """Heuristic slot detection from the hole-cluster output of
    extract_face_features.

    A "slot" here is a cluster of two or more holes that are colinear
    and similar in size — typical of CAD elongated voids that
    `extract_face_features` sees as a string of connected hole pixels.
    Rather than re-running the height-map extraction (which would need
    the mesh), we approximate slots from the existing hole record.

    Returns a list of slot dicts. May be empty.
    """
    holes = list(face_dict.get('holes') or [])
    if len(holes) < 2:
        return []
    # Bucket holes by (rounded) y position, then look for runs along x
    # (and the symmetric case). This catches the common "row of holes
    # along the front edge" pattern that operators teach as one slot
    # but extract_face_features splits into N holes.
    slots = []
    sorted_x = sorted(holes, key=lambda h: h['center'][0])
    run = [sorted_x[0]]
    for h in sorted_x[1:]:
        prev = run[-1]
        # Same row if y within 0.03 of normalized coord (≈3 mm on a
        # 100 mm face) and the x gap is < 4× hole radius.
        same_y = abs(h['center'][1] - prev['center'][1]) < 0.03
        gap = h['center'][0] - prev['center'][0]
        close = gap < max(0.06, 4.0 * float(prev.get('radius_norm', 0.01)))
        if same_y and close:
            run.append(h)
        else:
            if len(run) >= 3:
                slots.append(_slot_from_run(run))
            run = [h]
    if len(run) >= 3:
        slots.append(_slot_from_run(run))
    return slots


def _slot_from_run(run: list) -> dict:
    xs = [h['center'][0] for h in run]
    ys = [h['center'][1] for h in run]
    cx = (min(xs) + max(xs)) / 2.0
    cy = (min(ys) + max(ys)) / 2.0
    length = max(xs) - min(xs) + 2 * float(run[0].get('radius_norm', 0.01))
    width = 2 * float(run[0].get('radius_norm', 0.01))
    return {
        'center':      [round(cx, 3), round(cy, 3)],
        'length_norm': round(float(length), 4),
        'width_norm':  round(float(width), 4),
        'orientation': 'horizontal',
        'hole_count':  int(len(run)),
    }


def _distinctiveness(holes: list, bosses: list, slots: list) -> float:
    """Crude per-face distinctiveness score in [0, 1].

    A face with one or more well-defined features is more discriminating
    than a flat face. The score rewards count + variety but caps at 1.0
    so a face with 20 tiny holes doesn't dominate a face with 3 large
    distinctive ones.
    """
    count = (len(holes) + len(bosses) + 2 * len(slots))
    if count == 0:
        return 0.0
    variety = (1 if holes else 0) + (1 if bosses else 0) + (1 if slots else 0)
    score = (count / 6.0) * 0.6 + (variety / 3.0) * 0.4
    return float(max(0.0, min(1.0, score)))


def extract_step_features(face_features: dict, part_id: str = '') -> dict:
    """Compose the canonical STEP feature dictionary saved per part.

    Input: the dict returned by `extract_face_features` (per-face holes
    and bosses).

    Output schema (also persisted as
    /opt/cobot/parts/features/{part_id}_features.json):

        {
          "part_id": "...",
          "features": [
            {"id": "hole_top_1", "type": "hole", "on_face": "top",
             "center": [x, y], "radius_norm": 0.06,
             "distinctiveness": 0.9},
            ...
          ],
          "faces": {
            "top":    {"features": [...], "is_flat": false,
                       "distinctiveness": 0.9,
                       "feature_summary": "3 holes"},
            ...
          }
        }
    """
    out = {'part_id': part_id, 'features': [], 'faces': {}}
    if not face_features:
        for face in FACE_NAMES:
            out['faces'][face] = {
                'features': [], 'is_flat': True,
                'distinctiveness': 0.0,
                'feature_summary': 'flat face, no features',
            }
        return out

    counters = {}
    for face_name in FACE_NAMES:
        face = face_features.get(face_name) or {}
        holes  = list(face.get('holes')  or [])
        bosses = list(face.get('bosses') or [])
        slots  = _detect_slots_on_face(face)
        face_feature_ids = []

        for kind, items in (('hole', holes), ('boss', bosses), ('slot', slots)):
            for i, item in enumerate(items):
                counters[face_name] = counters.get(face_name, 0) + 1
                fid = f'{kind}_{face_name}_{counters[face_name]}'
                rec = {
                    'id':       fid,
                    'type':     kind,
                    'on_face':  face_name,
                }
                if kind == 'slot':
                    rec.update({
                        'center':      list(item.get('center', [0.0, 0.0])),
                        'length_norm': float(item.get('length_norm', 0.0)),
                        'width_norm':  float(item.get('width_norm', 0.0)),
                        'orientation': item.get('orientation', 'horizontal'),
                    })
                else:
                    rec.update({
                        'center':      list(item.get('center', [0.0, 0.0])),
                        'radius_norm': float(item.get('radius_norm', 0.0)),
                        'area_px':     int(item.get('area_px', 0)),
                    })
                out['features'].append(rec)
                face_feature_ids.append(fid)

        dscore = _distinctiveness(holes, bosses, slots)
        summary_bits = []
        if holes:  summary_bits.append(f'{len(holes)} hole{"s" if len(holes) != 1 else ""}')
        if bosses: summary_bits.append(f'{len(bosses)} boss{"es" if len(bosses) != 1 else ""}')
        if slots:  summary_bits.append(f'{len(slots)} slot{"s" if len(slots) != 1 else ""}')
        feature_summary = ', '.join(summary_bits) or 'flat face, no features'

        out['faces'][face_name] = {
            'features':         face_feature_ids,
            'is_flat':          not bool(holes or bosses or slots),
            'distinctiveness':  round(dscore, 3),
            'feature_summary':  feature_summary,
        }

    return out


def _face_from_normal(normal) -> str:
    """Snap an arbitrary unit normal to the closest canonical face label.

    The dashboard's face-click picker yields exact axis vectors most of
    the time (the user picks a flat face), but operators sometimes click
    a chamfer or rotate the part — we still want a canonical bucket.
    """
    if not normal or len(normal) < 3:
        return 'top'
    arr = np.asarray(normal, dtype=float)
    n = float(np.linalg.norm(arr))
    if n < 1e-6:
        return 'top'
    arr = arr / n
    best_face = 'top'
    best_dot = -2.0
    for face, fn in FACE_NORMALS.items():
        d = float(np.dot(arr, fn))
        if d > best_dot:
            best_dot = d
            best_face = face
    return best_face


def compute_orientation_signatures(features_doc: dict, pick_face: str) -> dict:
    """Given the features doc and the operator-chosen pickable face,
    derive per-orientation feature signatures.

    Pickable signature: features visible on `pick_face`.
    Flipped signature: features visible on the opposite face.
    On-side signatures: features on each of the four side faces.

    Returns a dict suitable for serialisation; persists at
    /opt/cobot/parts/features/{part_id}_orientation_signatures.json.
    """
    faces = (features_doc or {}).get('faces') or {}
    if pick_face not in FACE_NAMES:
        pick_face = 'top'
    pick_entry = faces.get(pick_face, {})
    flipped_face = OPPOSITE_FACE.get(pick_face, 'bottom')
    flipped_entry = faces.get(flipped_face, {})

    pickable_sig = {
        'up_face':           pick_face,
        'visible_features':  list(pick_entry.get('features') or []),
        'feature_summary':   pick_entry.get('feature_summary') or 'flat face, no features',
        'distinctiveness':   float(pick_entry.get('distinctiveness') or 0.0),
    }
    flipped_sig = {
        'label':            'flipped',
        'up_face':           flipped_face,
        'visible_features':  list(flipped_entry.get('features') or []),
        'feature_summary':   flipped_entry.get('feature_summary') or 'flat face, no features',
        'distinctiveness':   float(flipped_entry.get('distinctiveness') or 0.0),
    }
    on_side_sigs = []
    for face in FACE_NAMES:
        if face in (pick_face, flipped_face):
            continue
        e = faces.get(face, {})
        on_side_sigs.append({
            'label':            f'on_side_{face}',
            'up_face':           face,
            'visible_features':  list(e.get('features') or []),
            'feature_summary':   e.get('feature_summary') or 'flat face, no features',
            'distinctiveness':   float(e.get('distinctiveness') or 0.0),
        })

    return {
        'part_id':       features_doc.get('part_id', ''),
        'pickable':      pickable_sig,
        'non_pickable':  [flipped_sig] + on_side_sigs,
    }


def write_features_artifacts(part_id: str, features_doc: dict,
                             orientation_signatures: dict,
                             features_dir: str = '/opt/cobot/parts/features'
                             ) -> tuple:
    """Persist features.json and orientation_signatures.json. Returns
    (features_path, signatures_path) or (None, None) on error.
    """
    os.makedirs(features_dir, exist_ok=True)
    fp = os.path.join(features_dir, f'{part_id}_features.json')
    sp = os.path.join(features_dir, f'{part_id}_orientation_signatures.json')
    try:
        import json
        with open(fp + '.tmp', 'w') as f:
            json.dump(features_doc, f, indent=2)
        os.replace(fp + '.tmp', fp)
        with open(sp + '.tmp', 'w') as f:
            json.dump(orientation_signatures, f, indent=2)
        os.replace(sp + '.tmp', sp)
    except Exception:
        return None, None
    return fp, sp


def generate_recognition_templates(mesh, output_dir: str, part_id: str,
                                   yaw_steps: int = 12, img_size: int = 128,
                                   margin: int = 8):
    """Render a CAD mesh from 6 viewing directions × `yaw_steps` yaws.

    Each template is a (mask, edges, dims) tuple stored in a single
    .npz under `output_dir`. The orientation label propagates through
    matching so the runtime can tell the operator whether the part is
    pickable, flipped (upside down), or on its side.

    Default 6 × 12 = 72 templates per part.

    Returns a summary dict with template count + per-orientation counts.
    """
    if not _PIL_OK:
        return {'num_templates': 0, 'template_file': None, 'orientations': {}}

    os.makedirs(output_dir, exist_ok=True)
    from scipy.ndimage import sobel as _sobel, binary_erosion

    all_templates = []

    for orient in _RECOG_ORIENTATIONS:
        rot_mat = trimesh.transformations.euler_matrix(
            float(orient['rotation'][0]),
            float(orient['rotation'][1]),
            float(orient['rotation'][2]))
        oriented = mesh.copy()
        oriented.apply_transform(rot_mat)

        verts = oriented.vertices
        if len(verts) == 0:
            continue
        x_range = float(verts[:, 0].max() - verts[:, 0].min()) or 1e-3
        y_range = float(verts[:, 1].max() - verts[:, 1].min()) or 1e-3
        scale = (img_size - 2 * margin) / max(x_range, y_range)

        for yi in range(yaw_steps):
            yaw_deg = yi * (360.0 / yaw_steps)
            yaw_mat = trimesh.transformations.rotation_matrix(
                np.radians(yaw_deg), [0, 0, 1])
            rotated = oriented.copy()
            rotated.apply_transform(yaw_mat)

            v = rotated.vertices
            x = v[:, 0]; y = v[:, 1]; z = v[:, 2]
            px = ((x - x.min()) * scale + margin).astype(int).clip(0, img_size - 1)
            py = ((y - y.min()) * scale + margin).astype(int).clip(0, img_size - 1)

            mask_img = Image.new('L', (img_size, img_size), 0)
            mask_draw = ImageDraw.Draw(mask_img)
            for face in rotated.faces:
                pts = [(int(px[fi]), int(py[fi])) for fi in face]
                mask_draw.polygon(pts, fill=255)
            mask = np.asarray(mask_img) > 127
            if not mask.any():
                continue

            # Top-down height map (max z per pixel), normalised to [0,1]
            height_map = np.zeros((img_size, img_size), dtype=np.float32)
            np.maximum.at(height_map, (py, px), z - z.min())
            h_max = float(height_map.max())
            if h_max > 0:
                height_map = height_map / h_max
            height_map[~mask] = 0.0

            mf = mask.astype(np.float32)
            mask_edges = (np.sqrt(_sobel(mf, axis=0) ** 2
                                  + _sobel(mf, axis=1) ** 2) > 0.1)
            h_edges = (np.sqrt(_sobel(height_map, axis=0) ** 2
                               + _sobel(height_map, axis=1) ** 2) > 0.05)
            edges = (mask_edges | h_edges).astype(np.uint8)

            rows = np.any(mask, axis=1)
            cols = np.any(mask, axis=0)
            if not (rows.any() and cols.any()):
                continue
            r0, r1 = np.where(rows)[0][[0, -1]]
            c0, c1 = np.where(cols)[0][[0, -1]]
            h_px = int(r1 - r0 + 1)
            w_px = int(c1 - c0 + 1)
            width_m = w_px / scale
            height_m = h_px / scale
            aspect = w_px / max(h_px, 1)
            fill = float(np.sum(mask)) / max(w_px * h_px, 1)

            all_templates.append({
                'orient_name':  orient['name'],
                'orient_label': orient['label'],
                'yaw_deg':      float(yaw_deg),
                'mask':         mask,
                'edges':        edges,
                'width_m':      round(float(width_m), 4),
                'height_m':     round(float(height_m), 4),
                'aspect':       round(float(aspect), 3),
                'fill':         round(float(fill), 3),
            })

    save_dict = {'num_templates': np.int32(len(all_templates))}
    for i, t in enumerate(all_templates):
        save_dict[f't{i}_orient']   = t['orient_name']
        save_dict[f't{i}_label']    = t['orient_label']
        save_dict[f't{i}_yaw']      = np.float32(t['yaw_deg'])
        save_dict[f't{i}_mask']     = t['mask']
        save_dict[f't{i}_edges']    = t['edges']
        save_dict[f't{i}_width_m']  = np.float32(t['width_m'])
        save_dict[f't{i}_height_m'] = np.float32(t['height_m'])
        save_dict[f't{i}_aspect']   = np.float32(t['aspect'])
        save_dict[f't{i}_fill']     = np.float32(t['fill'])

    save_path = os.path.join(output_dir, f'{part_id}_templates.npz')
    np.savez_compressed(save_path, **save_dict)

    orient_counts: dict = {}
    for t in all_templates:
        orient_counts[t['orient_name']] = orient_counts.get(t['orient_name'], 0) + 1

    return {
        'num_templates': len(all_templates),
        'template_file': f'{part_id}_templates.npz',
        'orientations':  orient_counts,
    }


def parse_step_file(step_path: str) -> dict:
    """Parse a STEP file and return a dict with all the planner-relevant
    geometry. Raises ValueError on parse failure."""
    if not os.path.isfile(step_path):
        raise ValueError(f"STEP file not found: {step_path}")

    try:
        mesh = trimesh.load(step_path, force='mesh')
    except Exception as e:
        raise ValueError(f"trimesh failed to load {step_path}: {e}")

    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.dump(concatenate=True)
    if mesh is None or len(mesh.vertices) == 0:
        raise ValueError(f"STEP file parsed to an empty mesh: {step_path}")

    # CAD files are usually in mm; if the bbox is huge in metric units,
    # rescale. 10 m is a generous threshold — real picked parts are
    # always smaller than that.
    extents = mesh.bounding_box.extents
    if float(max(extents)) > 10.0:
        mesh.apply_scale(0.001)

    centroid = mesh.centroid
    bounds   = mesh.bounds
    extents  = mesh.bounding_box.extents

    # Principal axes via covariance PCA. Sort by eigenvalue descending
    # so axis 0 is the longest spread, axis 2 the shortest.
    centered = mesh.vertices - centroid
    cov = np.cov(centered.T)
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)[::-1]
    principal_axes = eigvecs[:, order].T

    volume       = float(mesh.volume) if mesh.is_watertight else 0.0
    surface_area = float(mesh.area)

    # Grasp inference: longest = principal axis (gripper aligned along
    # this), middle = depth, shortest = the dimension the gripper has
    # to actually close around. is_flat if the shortest dim is much
    # smaller than the longest — drives top-down vs side approach.
    sorted_ext = sorted(extents, reverse=True)
    grasp_width = sorted_ext[2]
    grasp_depth = sorted_ext[1]
    is_flat = sorted_ext[2] < 0.3 * sorted_ext[0]

    hull = mesh.convex_hull

    # Write .stl alongside the .step for dashboard preview.
    stl_path = os.path.splitext(step_path)[0] + '.stl'
    mesh.export(stl_path)

    with open(step_path, 'rb') as f:
        file_hash = hashlib.md5(f.read()).hexdigest()[:12]

    # Render reference silhouettes from N yaw rotations so the
    # camera-side shape matcher has something to compare against.
    sil_dir = '/opt/cobot/parts/silhouettes'
    try:
        silhouettes = _generate_silhouettes(mesh, sil_dir, file_hash)
    except Exception:
        silhouettes = []

    # 6 orientations × 12 yaws = 72 templates for orientation-aware
    # recognition (pickable / flipped / on_side).
    templates_dir = '/opt/cobot/parts/templates'
    try:
        templates_info = generate_recognition_templates(
            mesh, templates_dir, file_hash)
    except Exception:
        templates_info = {'num_templates': 0, 'template_file': None,
                          'orientations': {}}

    try:
        geometric_features = extract_geometric_features(mesh)
    except Exception:
        geometric_features = {}

    # Per-face feature anchors (hole / boss positions per orientation).
    # The orientation classifier uses these to VERIFY at runtime that
    # the live crop actually shows the features the CAD model says
    # should be on that face — turns a soft texture-similarity score
    # into a hard geometric check.
    try:
        face_features = extract_face_features(mesh)
    except Exception:
        face_features = {}

    # New architecture (Foundation): write features.json +
    # orientation_signatures.json so the dashboard and (future)
    # orientation-boost code can find them. The pickable face defaults
    # to 'top'; the dashboard pick-direction selector rewrites the
    # signatures when the operator chooses a different face.
    try:
        features_doc = extract_step_features(face_features, file_hash)
        sig_doc = compute_orientation_signatures(features_doc, 'top')
        write_features_artifacts(file_hash, features_doc, sig_doc)
    except Exception:
        pass

    return {
        'id':                file_hash,
        'name':              os.path.splitext(os.path.basename(step_path))[0],
        'source_file':       os.path.basename(step_path),
        'stl_file':          os.path.basename(stl_path),
        'centroid_m':        [round(float(c), 6) for c in centroid],
        'bounds_m':          [[round(float(b), 6) for b in bounds[0]],
                              [round(float(b), 6) for b in bounds[1]]],
        'extents_m':         [round(float(e), 6) for e in extents],
        'extents_cm':        [round(float(e) * 100, 2) for e in extents],
        'volume_cm3':        round(volume * 1e6, 2),
        'surface_area_cm2':  round(surface_area * 1e4, 2),
        'principal_axes':    [[round(float(v), 6) for v in ax]
                              for ax in principal_axes],
        'grasp': {
            'width_m':           round(float(grasp_width), 4),
            'depth_m':           round(float(grasp_depth), 4),
            'is_flat':           bool(is_flat),
            'approach':          'top_down' if is_flat else 'side',
            'gripper_opening_m': round(float(grasp_width) + 0.01, 4),
        },
        'vertices':       int(len(mesh.vertices)),
        'faces':          int(len(mesh.faces)),
        'is_watertight':  bool(mesh.is_watertight),
        'hull_verts':     hull.vertices.tolist(),
        'hull_faces':     hull.faces.tolist(),
        'silhouettes':    silhouettes,
        'templates':      templates_info,
        'geometric_features': geometric_features,
        'face_features':      face_features,
    }

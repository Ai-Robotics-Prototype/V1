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

    try:
        geometric_features = extract_geometric_features(mesh)
    except Exception:
        geometric_features = {}

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
        'geometric_features': geometric_features,
    }

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
    }

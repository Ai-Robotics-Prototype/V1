#!/usr/bin/env python3
"""Split the full robot GLB into per-link GLB + decimated lite GLB files
plus a links.json describing the kinematic chain.

Geometry-to-link assignment is 1:1 by sorted centroid along the dominant
axis (Y for the Estun S10-140 — the manufacturer's STEP loads with the
arm extending along +Y in its zero pose).

Each link's mesh is translated so the *parent* joint position becomes
the mesh-local origin. That way every kinematic group in the three.js
chain just rotates around (0,0,0) — much simpler than carrying joint
offsets at runtime. The translation offset for each link is recorded
in links.json as `joint_origin`, expressed in the parent's local frame.

For the Estun S10-140: assumed joint axes are Y-Z-Z-Y-Z-Y, matching a
typical 6-axis cobot with the arm pointing along Y. These may need
adjustment when verified against the real robot — adjust JOINT_AXES
below and re-run.
"""
import json
import os
import sys
import time

import trimesh

ROBOT_DIR = '/opt/cobot/models/robot'
FULL_GLB  = os.path.join(ROBOT_DIR, 'S10-140.glb')
LINKS_DIR = os.path.join(ROBOT_DIR, 'links')

# Joint world positions along the dominant axis (Y), in metres.
# joint i is between link i-1 and link i. JOINT_Y[0] is unused (no
# joint above the base); JOINT_Y[1] = J1, JOINT_Y[2] = J2, etc.
JOINT_Y = [0.0, 0.09, 0.11, 0.83, 1.38, 1.47, 1.58]

# Joint axes in each link's LOCAL frame. Y-Z-Z-Y-Z-Y is the standard
# 6-axis cobot layout for an arm pointing along Y in zero pose.
JOINT_AXES = [
    None,          # base has no joint above it
    [0, 1, 0],     # J1 base rotation (yaw)
    [0, 0, 1],     # J2 shoulder pitch
    [0, 0, 1],     # J3 elbow pitch
    [0, 1, 0],     # J4 wrist roll
    [0, 0, 1],     # J5 wrist pitch
    [0, 1, 0],     # J6 flange roll
]

LINK_NAMES = [
    'link0_base',
    'link1_shoulder',
    'link2_upper_arm',
    'link3_forearm',
    'link4_wrist1',
    'link5_wrist2',
    'link6_flange',
]

DECIMATE_LITE_FACES = 30_000   # per link target — keep each link < ~1 MB


def fmt_mb(n: int) -> str:
    return f'{n / 1e6:.2f} MB'


def main():
    if not os.path.isfile(FULL_GLB):
        print(f'ERROR: {FULL_GLB} not found', file=sys.stderr)
        sys.exit(1)

    os.makedirs(LINKS_DIR, exist_ok=True)

    print(f'Loading full GLB: {FULL_GLB} ({fmt_mb(os.path.getsize(FULL_GLB))})')
    t0 = time.time()
    loaded = trimesh.load(FULL_GLB)
    print(f'  ... loaded in {time.time() - t0:.1f}s')

    scene = loaded if isinstance(loaded, trimesh.Scene) else trimesh.Scene([loaded])

    # Extract each per-part mesh in world frame (applies the scene
    # graph transform that was baked into the GLB).
    parts = []
    for node in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node]
        geom = scene.geometry.get(geom_name)
        if geom is None:
            continue
        wg = geom.copy()
        wg.apply_transform(transform)
        parts.append({
            'node': node,
            'mesh': wg,
            'cy':   float(wg.centroid[1]),
        })
    parts.sort(key=lambda p: p['cy'])
    print(f'Found {len(parts)} parts; mapping 1:1 to {len(LINK_NAMES)} links')

    if len(parts) != len(LINK_NAMES):
        print('WARNING: part count != link count — extras will be dropped '
              'or links will have no mesh', file=sys.stderr)

    out_links = []
    for i, link_name in enumerate(LINK_NAMES):
        part = parts[i] if i < len(parts) else None

        # joint_origin: position of THIS link's joint expressed in the
        # parent link's local frame. For the base (no parent joint),
        # it's at world origin.
        if i == 0:
            joint_origin = [0.0, 0.0, 0.0]
            mesh_shift_y = 0.0
        else:
            joint_origin = [0.0, float(JOINT_Y[i] - JOINT_Y[i - 1]), 0.0]
            # Shift the link's mesh so its parent joint sits at the
            # mesh-local origin. The link will then rotate cleanly
            # around (0,0,0) in three.js.
            mesh_shift_y = -float(JOINT_Y[i])

        full_file = lite_file = None
        if part is not None:
            mesh = part['mesh'].copy()
            if mesh_shift_y != 0.0:
                mesh.apply_translation([0.0, mesh_shift_y, 0.0])

            full_file = f'{link_name}.glb'
            lite_file = f'{link_name}_lite.glb'

            with open(os.path.join(LINKS_DIR, full_file), 'wb') as f:
                f.write(mesh.export(file_type='glb'))

            target = min(DECIMATE_LITE_FACES, len(mesh.faces))
            try:
                lite = mesh.simplify_quadric_decimation(face_count=target)
            except Exception as e:
                print(f'  {link_name}: decimation failed ({e}); reusing full')
                lite = mesh
            with open(os.path.join(LINKS_DIR, lite_file), 'wb') as f:
                f.write(lite.export(file_type='glb'))

            full_sz = os.path.getsize(os.path.join(LINKS_DIR, full_file))
            lite_sz = os.path.getsize(os.path.join(LINKS_DIR, lite_file))
            print(f'  {link_name:18s}  src={part["node"]:6s} '
                  f'faces={len(mesh.faces):>7,} -> lite {len(lite.faces):>6,}  '
                  f'full {fmt_mb(full_sz):>8s}  lite {fmt_mb(lite_sz):>8s}  '
                  f'joint_origin={joint_origin}')
        else:
            print(f'  {link_name}: no source part')

        out_links.append({
            'name':         link_name,
            'file':         full_file,
            'file_lite':    lite_file,
            'joint_index':  None if i == 0 else i - 1,   # J1 -> index 0
            'joint_origin': joint_origin,
            'joint_axis':   JOINT_AXES[i] or [0, 0, 0],
            'parent':       LINK_NAMES[i - 1] if i > 0 else None,
        })

    out = {
        'dominant_axis':  'Y',
        'joint_world_y':  [float(j) for j in JOINT_Y[1:]],
        'note':           ('Joint axes are assumed Y-Z-Z-Y-Z-Y for a typical '
                           '6-axis cobot. Verify against the real Estun and '
                           'adjust JOINT_AXES in scripts/split_robot_links.py '
                           'if needed.'),
        'links':          out_links,
    }
    links_json_path = os.path.join(LINKS_DIR, 'links.json')
    with open(links_json_path, 'w') as f:
        json.dump(out, f, indent=2)
    print(f'\nWrote {links_json_path} with {len(out_links)} links')


if __name__ == '__main__':
    main()

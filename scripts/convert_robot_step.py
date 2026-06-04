#!/usr/bin/env python3
"""Convert a robot's STEP file to GLB + STL and emit geometry analysis.

Default behavior (fast path): re-generates only the derived JSON files
(parts_inventory.json, links/z_distribution.json) from existing GLB
output. Pass --refresh-inventory to do the slow STEP re-load and
re-export the GLB/STL meshes.

  python3 scripts/convert_robot_step.py
  python3 scripts/convert_robot_step.py --refresh-inventory
  python3 scripts/convert_robot_step.py --robot-dir models/robots/other_robot

Sort axis: the STEP file is loaded as-is, so the link-stacking axis
depends on how the manufacturer exported it. The script detects the
axis with the largest centroid range and sorts the inventory by that.
The output filename remains z_distribution.json by convention.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import trimesh


def fmt_mb(n):
    return f'{n / 1e6:.1f} MB'


def reload_step(step_path):
    print(f'Loading {step_path} ({fmt_mb(os.path.getsize(step_path))}) ...')
    t0 = time.time()
    loaded = trimesh.load(step_path)
    print(f'  ... loaded in {time.time() - t0:.1f}s')
    return loaded if isinstance(loaded, trimesh.Scene) else trimesh.Scene([loaded])


def build_inventory(scene):
    inventory = []
    for node_name in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node_name]
        geom = scene.geometry.get(geom_name)
        if geom is None:
            continue
        world_geom = geom.copy()
        world_geom.apply_transform(transform)
        c  = world_geom.centroid
        bb = world_geom.bounds
        inventory.append({
            'node':     node_name,
            'geometry': geom_name,
            'vertices': int(len(world_geom.vertices)),
            'faces':    int(len(world_geom.faces)),
            'centroid': [float(c[0]), float(c[1]), float(c[2])],
            'bbox_min': [float(bb[0][0]), float(bb[0][1]), float(bb[0][2])],
            'bbox_max': [float(bb[1][0]), float(bb[1][1]), float(bb[1][2])],
        })
    return inventory


def dominant_axis(inventory):
    """Return the index (0/1/2) of the centroid axis with the largest
    range across parts. This is the axis joints are stacked along."""
    if not inventory:
        return 2
    centroids = np.array([p['centroid'] for p in inventory])
    spans = centroids.max(axis=0) - centroids.min(axis=0)
    return int(np.argmax(spans))


def write_z_distribution(inventory, out_path):
    """Per-part centroid + bbox values along each axis, plus a summary
    of which axis has the largest variance (= likely joint axis)."""
    if not inventory:
        return
    centroids = np.array([p['centroid'] for p in inventory])
    bb_min    = np.array([p['bbox_min'] for p in inventory])
    bb_max    = np.array([p['bbox_max'] for p in inventory])
    axis = dominant_axis(inventory)
    axis_name = 'XYZ'[axis]
    sorted_idx = sorted(range(len(inventory)), key=lambda i: centroids[i][axis])
    z = {
        'dominant_axis':       axis_name,
        'spans':               {'X': float(centroids[:, 0].max() - centroids[:, 0].min()),
                                'Y': float(centroids[:, 1].max() - centroids[:, 1].min()),
                                'Z': float(centroids[:, 2].max() - centroids[:, 2].min())},
        'parts': [{
            'node':       inventory[i]['node'],
            'geometry':   inventory[i]['geometry'],
            'vertices':   inventory[i]['vertices'],
            'faces':      inventory[i]['faces'],
            'center_x':   float(centroids[i][0]),
            'center_y':   float(centroids[i][1]),
            'center_z':   float(centroids[i][2]),
            'center_dom': float(centroids[i][axis]),
            'min_dom':    float(bb_min[i][axis]),
            'max_dom':    float(bb_max[i][axis]),
            'size_dom':   float(bb_max[i][axis] - bb_min[i][axis]),
        } for i in sorted_idx],
    }
    with open(out_path, 'w') as f:
        json.dump(z, f, indent=2)
    print(f'Wrote {out_path}  (dominant axis: {axis_name}, '
          f'span {z["spans"][axis_name]:.2f})')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--robot-dir', default='/opt/cobot/models/robot',
                        help='Directory containing the STEP file and where '
                             'outputs go. Default uses the /opt/cobot symlink.')
    parser.add_argument('--step-name', default='S10-140_G2.STEP')
    parser.add_argument('--glb-name',  default='S10-140.glb')
    parser.add_argument('--stl-name',  default='S10-140.stl')
    parser.add_argument('--refresh-inventory', action='store_true',
                        help='Re-load the STEP and re-export GLB/STL '
                             '(takes minutes). Without this flag the script '
                             'derives outputs from the existing inventory.')
    args = parser.parse_args()

    robot_dir = os.path.abspath(args.robot_dir)
    step_path = os.path.join(robot_dir, args.step_name)
    glb_path  = os.path.join(robot_dir, args.glb_name)
    stl_path  = os.path.join(robot_dir, args.stl_name)
    inv_path  = os.path.join(robot_dir, 'parts_inventory.json')
    links_dir = os.path.join(robot_dir, 'links')
    z_path    = os.path.join(links_dir, 'z_distribution.json')

    os.makedirs(links_dir, exist_ok=True)

    inventory = None
    if not args.refresh_inventory and os.path.isfile(inv_path):
        try:
            with open(inv_path) as f:
                inventory = json.load(f)['parts']
            print(f'Loaded existing inventory: {inv_path} '
                  f'({len(inventory)} parts)')
        except Exception as e:
            print(f'Inventory unreadable ({e}) — falling back to STEP reload')

    if inventory is None:
        if not os.path.isfile(step_path):
            print(f'ERROR: {step_path} missing and no cached inventory', file=sys.stderr)
            sys.exit(1)
        scene = reload_step(step_path)
        print(f'Scene contains {len(scene.geometry)} geometries')
        inventory = build_inventory(scene)
        # Keep z-axis sort for the on-disk inventory (matches what
        # the dashboard /robot/parts_inventory.json route returns).
        inventory.sort(key=lambda p: p['centroid'][2])
        with open(inv_path, 'w') as f:
            json.dump({'parts': inventory}, f, indent=2)
        print(f'Wrote {inv_path}')

        print(f'Exporting GLB → {glb_path} ...')
        with open(glb_path, 'wb') as f:
            f.write(scene.export(file_type='glb'))
        print(f'  GLB: {fmt_mb(os.path.getsize(glb_path))}')

        print(f'Exporting STL → {stl_path} ...')
        merged = trimesh.util.concatenate(scene.dump())
        merged.export(stl_path)
        print(f'  STL: {fmt_mb(os.path.getsize(stl_path))}')

    # ── Print inventory + write z_distribution.json ────────
    axis = dominant_axis(inventory)
    axis_name = 'XYZ'[axis]
    sorted_inv = sorted(inventory, key=lambda p: p['centroid'][axis])
    print(f'\n── Part inventory (sorted by dominant axis {axis_name}) ──')
    print(f'{"#":>3} {"vtx":>10} {"faces":>10} {"cx":>9} {"cy":>9} {"cz":>9}  '
          f'{"min_"+axis_name.lower():>9} {"max_"+axis_name.lower():>9}  node / geom')
    for i, p in enumerate(sorted_inv):
        cx, cy, cz = p['centroid']
        bmin, bmax = p['bbox_min'][axis], p['bbox_max'][axis]
        print(f'{i:3d} {p["vertices"]:10d} {p["faces"]:10d} '
              f'{cx:9.3f} {cy:9.3f} {cz:9.3f} {bmin:9.3f} {bmax:9.3f}  '
              f'{p["node"]}  ({p["geometry"]})')
    total_vtx  = sum(p['vertices'] for p in inventory)
    total_face = sum(p['faces'] for p in inventory)
    print(f'\nTotal: {total_vtx:,} vertices · {total_face:,} faces')

    write_z_distribution(inventory, z_path)


if __name__ == '__main__':
    main()

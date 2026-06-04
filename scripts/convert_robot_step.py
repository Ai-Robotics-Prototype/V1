#!/usr/bin/env python3
"""Convert the Estun S10-140 STEP file to GLB + STL for the dashboard's
3D viewer.

In addition to the conversion, this prints a per-part inventory
(name, vertex count, centroid Z) so we can identify joint-link
boundaries when we author an articulated URDF later. Run with --dry
to skip the export and just print the inventory.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import trimesh

STEP_PATH = '/opt/cobot/models/robot/S10-140_G2.STEP'
GLB_PATH  = '/opt/cobot/models/robot/S10-140.glb'
STL_PATH  = '/opt/cobot/models/robot/S10-140.stl'
INV_PATH  = '/opt/cobot/models/robot/parts_inventory.json'


def fmt_mb(n_bytes: int) -> str:
    return f'{n_bytes / 1e6:.1f} MB'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry', action='store_true',
                        help='Inventory only — skip GLB/STL export')
    args = parser.parse_args()

    if not os.path.isfile(STEP_PATH):
        print(f'ERROR: {STEP_PATH} not found', file=sys.stderr)
        sys.exit(1)

    size = os.path.getsize(STEP_PATH)
    print(f'Loading {STEP_PATH} ({fmt_mb(size)}) ...')
    t0 = time.time()
    loaded = trimesh.load(STEP_PATH)
    print(f'  ... loaded in {time.time() - t0:.1f}s')

    # Normalise: trimesh.load may return a Scene OR a single Trimesh.
    if isinstance(loaded, trimesh.Scene):
        scene = loaded
    else:
        scene = trimesh.Scene([loaded])

    print(f'Scene contains {len(scene.geometry)} geometries')

    # ── Part inventory ────────────────────────────────────
    # Use the scene graph so we get the world-frame transform per
    # node — the centroid Z below is in world coordinates, which is
    # what we need for slicing the model into link bands.
    inventory = []
    for node_name in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node_name]
        geom = scene.geometry.get(geom_name)
        if geom is None:
            continue
        # Apply the node's world transform to the local geometry so
        # the centroid we record matches what the viewer will show.
        world_geom = geom.copy()
        world_geom.apply_transform(transform)
        c = world_geom.centroid
        bb = world_geom.bounds  # 2x3
        inventory.append({
            'node':       node_name,
            'geometry':   geom_name,
            'vertices':   int(len(world_geom.vertices)),
            'faces':      int(len(world_geom.faces)),
            'centroid':   [float(c[0]), float(c[1]), float(c[2])],
            'bbox_min':   [float(bb[0][0]), float(bb[0][1]), float(bb[0][2])],
            'bbox_max':   [float(bb[1][0]), float(bb[1][1]), float(bb[1][2])],
        })

    # Sort by centroid Z (height) — joints are usually stacked
    # vertically so this clusters into link candidates.
    inventory.sort(key=lambda p: p['centroid'][2])

    print('\n── Part inventory (sorted by centroid Z) ──')
    print(f'{"#":>3} {"vtx":>8} {"face":>8} {"cx":>9} {"cy":>9} {"cz":>9}  node / geom')
    for i, p in enumerate(inventory):
        cx, cy, cz = p['centroid']
        print(f'{i:3d} {p["vertices"]:8d} {p["faces"]:8d} '
              f'{cx:9.1f} {cy:9.1f} {cz:9.1f}  {p["node"]}  ({p["geometry"]})')

    total_vtx = sum(p['vertices'] for p in inventory)
    total_face = sum(p['faces'] for p in inventory)
    print(f'\nTotal: {total_vtx:,} vertices · {total_face:,} faces')

    # Persist the inventory — useful for the URDF-builder script
    # we'll write next, and as a debugging aid in the dashboard.
    with open(INV_PATH, 'w') as f:
        json.dump({'parts': inventory}, f, indent=2)
    print(f'Wrote inventory: {INV_PATH}')

    if args.dry:
        print('Dry run — skipping GLB/STL export')
        return

    # ── GLB export (scene preserves part structure) ──────
    print(f'\nExporting GLB → {GLB_PATH} ...')
    t1 = time.time()
    glb_bytes = scene.export(file_type='glb')
    with open(GLB_PATH, 'wb') as f:
        f.write(glb_bytes)
    print(f'  GLB: {fmt_mb(os.path.getsize(GLB_PATH))} ({time.time() - t1:.1f}s)')

    # ── STL export (single merged mesh) ──────────────────
    print(f'Exporting STL → {STL_PATH} ...')
    t2 = time.time()
    merged = trimesh.util.concatenate([
        g.apply_transform(scene.graph[node][0])
        if False else  # noop — concatenate below uses the dump
        g for g in scene.geometry.values()
    ])
    # Safer: use Scene.dump which already bakes the transforms.
    merged = trimesh.util.concatenate(scene.dump())
    merged.export(STL_PATH)
    print(f'  STL: {fmt_mb(os.path.getsize(STL_PATH))} ({time.time() - t2:.1f}s)')

    print('\nDone.')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Produce a decimated lite variant of the converted robot GLB.

Concatenates the per-part scene into a single merged mesh, then runs
trimesh's quadric decimation (fast-simplification backend) down to a
target face count. Output is alongside the full GLB:

    S10-140.glb        (114 MB, full fidelity, engineering reference)
    S10-140_lite.glb   (target <10 MB, what the dashboard viewer loads)

Run after scripts/convert_robot_step.py has produced the full GLB.
"""
import argparse
import os
import sys
import time

import trimesh


def fmt_mb(n: int) -> str:
    return f'{n / 1e6:.2f} MB'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--robot-dir', default='/opt/cobot/models/robot')
    parser.add_argument('--src',  default='S10-140.glb')
    parser.add_argument('--dst',  default='S10-140_lite.glb')
    parser.add_argument('--faces', type=int, default=150_000,
                        help='Target face count for the merged mesh.')
    args = parser.parse_args()

    src_path = os.path.join(args.robot_dir, args.src)
    dst_path = os.path.join(args.robot_dir, args.dst)
    if not os.path.isfile(src_path):
        print(f'ERROR: source GLB missing: {src_path}', file=sys.stderr)
        sys.exit(1)

    print(f'Loading {src_path} ({fmt_mb(os.path.getsize(src_path))}) ...')
    t0 = time.time()
    loaded = trimesh.load(src_path)
    print(f'  ... loaded in {time.time() - t0:.1f}s')

    scene = loaded if isinstance(loaded, trimesh.Scene) else trimesh.Scene([loaded])
    merged = trimesh.util.concatenate(scene.dump())
    print(f'Merged mesh: {len(merged.vertices):,} verts · {len(merged.faces):,} faces')

    target = min(args.faces, len(merged.faces))
    print(f'Decimating to {target:,} faces ...')
    t1 = time.time()
    lite = merged.simplify_quadric_decimation(face_count=target)
    print(f'  ... done in {time.time() - t1:.1f}s — result: '
          f'{len(lite.vertices):,} verts · {len(lite.faces):,} faces')

    print(f'Exporting {dst_path} ...')
    glb_bytes = lite.export(file_type='glb')
    with open(dst_path, 'wb') as f:
        f.write(glb_bytes)
    out_size = os.path.getsize(dst_path)
    print(f'  ... {fmt_mb(out_size)}')

    src_size = os.path.getsize(src_path)
    print(f'\nSize reduction: {fmt_mb(src_size)} -> {fmt_mb(out_size)} '
          f'({out_size / src_size * 100:.1f}%)')


if __name__ == '__main__':
    main()

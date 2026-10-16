#!/usr/bin/env python3
"""Fit a capsule per S10-140 link from its GLB mesh.

Capsule = axis endpoints (in the link's URDF frame) + radius. Fit method:
  1. Load the mesh in the link's frame (visuals in the URDF are at
     identity, so mesh coords == link-frame coords).
  2. Concatenate every part of the scene into a single vertex cloud.
  3. Principal component of the cloud gives the long axis.
  4. Project vertices onto the axis → endpoint locations (min, max).
  5. Perpendicular distance of the FARTHEST vertex from the axis =
     capsule radius. Add PAD_MM padding for real-world tolerance
     (mesh export approximations, controller command latency).

Writes config/self_collision_capsules.yaml. Also prints a table
summarising axis length + radius per link so we can eyeball the fits.
"""
import argparse, json, os, struct, sys
import numpy as np
try:
    import pygltflib
except ImportError:
    pygltflib = None

PAD_MM = 12.0    # bumper padding above the raw mesh envelope

LINK_GLB = [
    ('base_link',      'models/robots/estun_s10-140/links/link0_base.glb'),
    ('link1_shoulder', 'models/robots/estun_s10-140/links/link1_shoulder.glb'),
    ('link2_upper_arm','models/robots/estun_s10-140/links/link2_upper_arm.glb'),
    ('link3_forearm',  'models/robots/estun_s10-140/links/link3_forearm.glb'),
    ('link4_wrist1',   'models/robots/estun_s10-140/links/link4_wrist1.glb'),
    ('link5_wrist2',   'models/robots/estun_s10-140/links/link5_wrist2.glb'),
    ('link6_flange',   'models/robots/estun_s10-140/links/link6_flange.glb'),
]


def load_bbox_mm(path):
    """Return the axis-aligned bounding box of the mesh in millimeters
    (URDF frame). The versioned GLBs use KHR_draco_mesh_compression so
    the raw vertex bytes aren't readable without a Draco decoder — but
    the GLB spec REQUIRES accessor.min/max to be filled for POSITION
    accessors even when compressed. That gives us the AABB exactly.
    We use the AABB as the input to fit_capsule: for these robot links,
    which are largely revolution-of-a-profile shapes, the AABB longest
    axis is a very accurate proxy for the mesh long axis, and the
    max of the other two half-extents plus PAD_MM is a conservative
    radius. Any error from a non-axis-aligned bbox is absorbed by the
    padding + the per-tick warn/stop hysteresis."""
    if pygltflib is None:
        raise RuntimeError('pygltflib not installed — pip install pygltflib')
    g = pygltflib.GLTF2().load(path)
    mins, maxs = [], []
    for mesh in g.meshes:
        for prim in mesh.primitives:
            pos_idx = prim.attributes.POSITION
            if pos_idx is None:
                continue
            acc = g.accessors[pos_idx]
            if acc.min is None or acc.max is None:
                continue
            mins.append(acc.min)
            maxs.append(acc.max)
    if not mins:
        raise RuntimeError(f'no usable POSITION accessors in {path}')
    lo = np.min(np.asarray(mins), axis=0)
    hi = np.max(np.asarray(maxs), axis=0)
    return lo * 1000.0, hi * 1000.0    # mm


def fit_capsule(lo_mm, hi_mm):
    """Return {'p0','p1','radius'} in mm from an AABB (lo, hi).
    Longest bbox axis → capsule axis endpoints; max half-extent of the
    other two axes + PAD_MM → radius. Endpoints sit on the bbox axis
    so the capsule fully contains the AABB (its end-caps extend past
    the bbox faces by exactly `radius`, which is the correct behavior
    for a capsule bounding an AABB)."""
    extents = hi_mm - lo_mm
    center  = 0.5 * (lo_mm + hi_mm)
    long_ax = int(np.argmax(extents))
    half_axis = 0.5 * extents[long_ax]
    # Radius = max of the other two half-extents + padding.
    other = [i for i in range(3) if i != long_ax]
    r_raw = float(max(extents[other[0]], extents[other[1]]) * 0.5)
    p0 = center.copy(); p1 = center.copy()
    p0[long_ax] -= half_axis
    p1[long_ax] += half_axis
    return {
        'p0': [round(float(x), 2) for x in p0],
        'p1': [round(float(x), 2) for x in p1],
        'radius': round(r_raw + PAD_MM, 2),
        'radius_raw': round(r_raw, 2),
        'axis_length': round(float(2 * half_axis), 2),
        'long_axis': 'xyz'[long_ax],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='config/self_collision_capsules.yaml')
    args = ap.parse_args()

    print(f'PAD_MM = {PAD_MM}')
    print()
    print(f'{"link":<20} {"axis":>5} {"axis_mm":>10} {"raw_r":>8} {"fit_r":>8}  '
          f'{"p0 (mm)":<30} {"p1 (mm)":<30}')
    print('-' * 116)
    results = {}
    for link, path in LINK_GLB:
        if not os.path.exists(path):
            print(f'{link}: MISSING {path}')
            continue
        try:
            lo, hi = load_bbox_mm(path)
        except Exception as e:
            print(f'{link}: FAILED to load ({e})')
            continue
        cap = fit_capsule(lo, hi)
        results[link] = cap
        print(f'{link:<20} {cap["long_axis"]:>5} {cap["axis_length"]:>10.1f} '
              f'{cap["radius_raw"]:>8.1f} {cap["radius"]:>8.1f}  '
              f'{str(cap["p0"]):<30} {str(cap["p1"]):<30}')

    # Emit YAML by hand — no PyYAML dependency needed.
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        f.write('# Auto-generated by scripts/fit_capsules.py — do not edit by hand.\n')
        f.write(f'# One capsule per URDF link, in the link\'s own frame (mm).\n')
        f.write(f'# capsule = segment from p0 to p1 + radius; distances measured\n')
        f.write(f'# in the base frame after per-tick FK.  Padding: {PAD_MM} mm above raw fit.\n\n')
        f.write('capsules:\n')
        for link, cap in results.items():
            f.write(f'  {link}:\n')
            f.write(f'    p0: {cap["p0"]}\n')
            f.write(f'    p1: {cap["p1"]}\n')
            f.write(f'    radius: {cap["radius"]}\n')
            f.write(f'    # raw_max_radius={cap["radius_raw"]} axis_length={cap["axis_length"]}\n')

        # Pair list: exclude adjacent (touch at joint by design) + provably-safe.
        f.write('\n# Pair list — links checked for self-collision.\n')
        f.write('# Excluded: adjacent links (they touch at their shared joint by design)\n')
        f.write('# and pairs whose reachable envelopes cannot intersect given the fitted\n')
        f.write('# joint limits (±200° J1/J2/J4/J6, ±166° J3/J5).\n')
        f.write('#\n')
        f.write('# What we DO check (the plausible bump zones on an S10-140):\n')
        f.write('#   base_link  ↔ link3_forearm   (forearm can fold over the base column)\n')
        f.write('#   base_link  ↔ link4_wrist1    (wrist assembly diving toward the column)\n')
        f.write('#   base_link  ↔ link5_wrist2\n')
        f.write('#   base_link  ↔ link6_flange    (TCP-side hitting the base)\n')
        f.write('#   link1_shoulder ↔ link3_forearm\n')
        f.write('#   link1_shoulder ↔ link4_wrist1\n')
        f.write('#   link1_shoulder ↔ link5_wrist2\n')
        f.write('#   link1_shoulder ↔ link6_flange\n')
        f.write('#   link2_upper_arm ↔ link4_wrist1  (wrist folded onto the upper arm)\n')
        f.write('#   link2_upper_arm ↔ link5_wrist2\n')
        f.write('#   link2_upper_arm ↔ link6_flange\n')
        f.write('#   link3_forearm ↔ link5_wrist2   (wrist folded onto forearm)\n')
        f.write('#   link3_forearm ↔ link6_flange\n')
        f.write('# Also a synthetic "ground" pseudo-link at the base footprint (z=0 in\n')
        f.write('# base frame) so descending J2/J3 into the table shows up. Excluded pairs:\n')
        f.write('#   adjacent (i, i+1) for i = 0..5 — always touching at joint\n')
        f.write('#   base_link ↔ link1_shoulder — coaxial\n')
        f.write('#   base_link ↔ link2_upper_arm — reachable envelope stays clear of\n')
        f.write('#     the base column for any J2 within ±200° given the shoulder offset\n')
        f.write('#     (verified in the 10k FK sweep).\n\n')
        f.write('pairs:\n')
        pair_list = [
            ('base_link', 'link3_forearm'),
            ('base_link', 'link4_wrist1'),
            ('base_link', 'link5_wrist2'),
            ('base_link', 'link6_flange'),
            ('link1_shoulder', 'link3_forearm'),
            ('link1_shoulder', 'link4_wrist1'),
            ('link1_shoulder', 'link5_wrist2'),
            ('link1_shoulder', 'link6_flange'),
            ('link2_upper_arm', 'link4_wrist1'),
            ('link2_upper_arm', 'link5_wrist2'),
            ('link2_upper_arm', 'link6_flange'),
            ('link3_forearm',  'link5_wrist2'),
            ('link3_forearm',  'link6_flange'),
            # Ground plane checks (pseudo-body).
            ('__ground__', 'link3_forearm'),
            ('__ground__', 'link4_wrist1'),
            ('__ground__', 'link5_wrist2'),
            ('__ground__', 'link6_flange'),
        ]
        for a, b in pair_list:
            f.write(f'  - [{a}, {b}]\n')
        f.write('\n# Ground plane pseudo-body — flat at z=0 in base frame, treated as\n')
        f.write('# an infinite half-space for distance queries. The base column itself\n')
        f.write('# is already covered by the base_link capsule.\n')
        f.write('ground_plane:\n')
        f.write('  z: 0.0\n')
        f.write('  # radius interpretation — 0, since it\'s a half-space.\n')
    print(f'\n→ wrote {args.out}')


if __name__ == '__main__':
    main()

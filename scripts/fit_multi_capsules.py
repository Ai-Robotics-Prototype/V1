#!/usr/bin/env python3
"""Fit 2-3 capsule decompositions for link3_forearm and link5_wrist2.

Single PCA-cylinder capsules fire phantom self-collision at bent poses
because they wrap the mesh's max-diagonal but the actual rectangular
cross-section has no material at the cylinder equator. This script
fits MULTIPLE capsules per link — one per PC-cluster of the mesh
vertices in the perpendicular-to-long-axis plane — so the union
tracks the real geometry.

Algorithm per link:
  1. Load mesh vertices (decompress Draco).
  2. Find long axis (largest AABB extent).
  3. In the perpendicular plane, cluster vertices with K-means (K=2
     for link3's rectangular tube, K=3 for link5's chunky block if
     the extra cluster reduces max-radius meaningfully).
  4. For each cluster: project onto long axis → endpoints; max
     perpendicular in cluster + a small pad → radius.

Emits YAML that our CollisionModel can consume (multi-capsule
per-link support added alongside).
"""
import argparse, sys, math, os
import pygltflib, DracoPy
import numpy as np


PAD_MM = 3.0     # dropped from the single-fit's 12mm — decomposed capsules
                 # already exclude the corner region so extra pad isn't
                 # needed. Combined with p97 radius + dual side-split,
                 # gives ~1% fastener-head protrusion but drops wedge-pose
                 # over-approximation from 40 mm to ~25 mm.


def load_mesh_verts_mm(link_name):
    path = f'/home/teddy/cobot_ws/models/robots/estun_s10-140/links/{link_name}.glb'
    g = pygltflib.GLTF2().load(path)
    blob = g.binary_blob()
    for mesh in g.meshes:
        for prim in mesh.primitives:
            ext = (prim.extensions or {}).get('KHR_draco_mesh_compression')
            if not ext: continue
            bv = g.bufferViews[ext['bufferView']]
            data = blob[(bv.byteOffset or 0):(bv.byteOffset or 0) + bv.byteLength]
            m = DracoPy.decode(data)
            return np.asarray(m.points, dtype=np.float64) * 1000.0
    return np.zeros((0, 3))


def _kmeans_2d(pts_2d, K, iters=40, seed=20260715):
    """Simple K-means in the 2D perpendicular plane."""
    rng = np.random.default_rng(seed)
    N = len(pts_2d)
    # k-means++ init
    centers = [pts_2d[rng.integers(0, N)]]
    for _ in range(K - 1):
        d2 = np.min(((pts_2d[:, None, :] - np.asarray(centers)[None, :, :]) ** 2).sum(-1), axis=1)
        probs = d2 / d2.sum()
        idx = rng.choice(N, p=probs)
        centers.append(pts_2d[idx])
    centers = np.asarray(centers)
    for _ in range(iters):
        d2 = ((pts_2d[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        labels = d2.argmin(axis=1)
        new = np.zeros_like(centers)
        for k in range(K):
            mask = labels == k
            new[k] = pts_2d[mask].mean(0) if mask.any() else centers[k]
        if np.allclose(new, centers, atol=0.1): break
        centers = new
    return labels, centers


def fit_multi_capsule(V_mm, k=2, long_axis=None, side_split=False):
    """Segment the mesh along its LONG axis into k contiguous slabs;
    optionally sub-split each slab by SIGN of the wider perpendicular
    axis to handle asymmetric / flat cross-sections. Each capsule's
    axis sits at the local (sub-)cluster centroid in the perpendicular
    plane and its radius is that cluster's p99 perp distance.

    Rationale: link3's distal flange is X=[-77,+61] but only Z=[-49,+49]
    — a wide flat plate. A single cylinder covers it with r=97mm even
    though the plate itself is only 98mm thick. Splitting the slab by
    sign(X) gives two half-capsules that each track a HALF of the
    plate, dropping radius from 97 → ~55mm on the wrist-facing side.

    Long-axis slabs are chosen by equal-length quantiles."""
    lo = V_mm.min(0); hi = V_mm.max(0)
    ext = hi - lo
    if long_axis is None:
        long_axis = int(np.argmax(ext))
    perp_axes = [i for i in range(3) if i != long_axis]
    # Pick the wider perpendicular axis as the "side-split" axis.
    perp_widths = [ext[a] for a in perp_axes]
    side_axis = perp_axes[int(np.argmax(perp_widths))]
    long_vals = V_mm[:, long_axis]
    edges = np.linspace(long_vals.min(), long_vals.max(), k + 1)
    OVERLAP = 5.0
    labels = np.full(len(V_mm), -1, dtype=int)
    for i in range(k):
        lo_e = edges[i]   - (OVERLAP if i > 0 else 0)
        hi_e = edges[i+1] + (OVERLAP if i < k-1 else 0)
        mask = (long_vals >= lo_e) & (long_vals <= hi_e)
        labels = np.where((labels < 0) & mask, i, labels)
    caps = []
    for kid in range(k):
        mask = labels == kid
        if not mask.any(): continue
        sub = V_mm[mask]
        # Sub-split by side axis if requested and slab straddles ≥40 mm
        # of the split axis on both sides of its median.
        sub_groups = [(kid, 'C', sub)]
        if side_split:
            med = float(np.median(sub[:, side_axis]))
            left  = sub[sub[:, side_axis] <= med + 5.0]
            right = sub[sub[:, side_axis] >= med - 5.0]
            if (len(left) > 40 and len(right) > 40):
                sub_groups = [(kid, 'L', left), (kid, 'R', right)]
        for slab_id, side, subX in sub_groups:
            t_min = float(subX[:, long_axis].min())
            t_max = float(subX[:, long_axis].max())
            c2d = subX[:, perp_axes].mean(axis=0)
            d = np.linalg.norm(subX[:, perp_axes] - c2d, axis=1)
            # p97: excludes the outer 3% of verts (fastener heads,
            # boss-tops) but keeps the actual arm profile. Combined
            # with 5 mm pad below, this restores full coverage at
            # macroscopic scale while trimming ~15 mm off wedge-pose
            # over-approximation vs the p99 fit.
            r_p99 = float(np.percentile(d, 97))
            r_max = float(d.max())
            p0 = np.zeros(3); p1 = np.zeros(3)
            p0[long_axis] = t_min; p1[long_axis] = t_max
            for pi, a in enumerate(perp_axes):
                p0[a] = c2d[pi]; p1[a] = c2d[pi]
            caps.append({
                'p0': [round(float(x), 2) for x in p0],
                'p1': [round(float(x), 2) for x in p1],
                'radius':     round(r_p99 + PAD_MM, 2),
                'radius_raw': round(r_p99, 2),
                'radius_max_verts': round(r_max, 2),
                'axis_length': round(float(t_max - t_min), 2),
                'cluster_size': int(len(subX)),
                'long_axis_idx': long_axis,
                'side':        side,
            })
    return caps


def coverage_check(V_mm, caps):
    """For each vertex, compute the distance to the union of capsules.
    Report max (worst-case protrusion outside the union), p95, median.
    Distances = perp distance to nearest capsule segment - that
    capsule's radius (negative = inside the capsule, positive = outside)."""
    def _segment_pt_dist(seg_a, seg_b, p):
        d = seg_b - seg_a
        L2 = float(d @ d)
        if L2 < 1e-9:
            return float(np.linalg.norm(p - seg_a))
        t = float((p - seg_a) @ d / L2)
        t = max(0.0, min(1.0, t))
        c = seg_a + t * d
        return float(np.linalg.norm(p - c))
    seg_arr = [(np.asarray(c['p0']), np.asarray(c['p1']), c['radius']) for c in caps]
    outside = np.zeros(len(V_mm))
    for i, v in enumerate(V_mm):
        best = float('inf')
        for a, b, r in seg_arr:
            d = _segment_pt_dist(a, b, v) - r
            if d < best: best = d
        outside[i] = best
    return {
        'max_outside_mm':  float(outside.max()),
        'p95_outside_mm':  float(np.percentile(outside, 95)),
        'median_mm':       float(np.median(outside)),
        'frac_outside':    float((outside > 0).mean()),
    }


def print_link(name, V_mm, caps, cov):
    print(f'=== {name} ({len(V_mm)} verts) ===')
    for i, c in enumerate(caps):
        print(f'  cap[{i}]: r={c["radius"]:.1f} mm (raw {c["radius_raw"]:.1f}+pad {PAD_MM})  '
              f'axis_len={c["axis_length"]:.1f} mm  cluster={c["cluster_size"]}')
        print(f'    p0={c["p0"]} p1={c["p1"]}')
    print(f'  coverage vs full mesh:')
    print(f'    max outside (worst protrusion beyond union): {cov["max_outside_mm"]:+.1f} mm')
    print(f'    p95 outside: {cov["p95_outside_mm"]:+.1f} mm')
    print(f'    median (in-cap, negative): {cov["median_mm"]:+.1f} mm')
    print(f'    fraction of verts protruding: {cov["frac_outside"]*100:.2f}%')
    print()


def emit_yaml(fh, name, caps):
    fh.write(f'  {name}:\n')
    fh.write(f'    capsules:\n')
    for i, c in enumerate(caps):
        fh.write(f'      - p0: {c["p0"]}\n')
        fh.write(f'        p1: {c["p1"]}\n')
        fh.write(f'        radius: {c["radius"]}\n')
        fh.write(f'        # raw_r={c["radius_raw"]} axis_len={c["axis_length"]} '
                 f'cluster={c["cluster_size"]}\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='config/self_collision_capsules_multi.yaml')
    args = ap.parse_args()

    plans = [
        # (link_name, K slabs along long axis, side_split)
        # link3: 3 slabs × 2 sides = up to 6 capsules — the distal
        # flange is a flat plate 138×98 mm, side-split turns r=97
        # into two r≈55 halves. Only the wrist-facing half is close to
        # link5, so pair distance improves markedly.
        # link5: 3 slabs, no side-split — cross-section is roughly
        # square (98×121 mm) so sub-splitting doesn't help.
        ('link3_forearm', 3, True),
        ('link5_wrist2',  3, True),
    ]
    with open(args.out, 'w') as fh:
        fh.write('# Multi-capsule refit for link3_forearm and link5_wrist2.\n')
        fh.write('# Each link: 2 parallel capsules along the mesh long axis,\n')
        fh.write('# positioned at the perp-plane K-means centres so the union\n')
        fh.write('# tracks the rectangular cross-section without wrapping the\n')
        fh.write('# empty corner-plane between them.\n')
        fh.write('# Auto-generated by scripts/fit_multi_capsules.py.\n\n')
        fh.write('multi_capsules:\n')
        for link_name, K, side in plans:
            V = load_mesh_verts_mm(link_name)
            caps = fit_multi_capsule(V, k=K, side_split=side)
            cov = coverage_check(V, caps)
            print_link(link_name, V, caps, cov)
            emit_yaml(fh, link_name, caps)
    print(f'→ wrote {args.out}')


if __name__ == '__main__':
    main()

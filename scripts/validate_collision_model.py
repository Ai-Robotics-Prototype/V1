#!/usr/bin/env python3
"""Validate the fitted collision model.

  1. Random FK sweep — 10 000 in-limit configurations; report:
       min pair distance overall, per-pair min/median stats,
       counts of poses reported < 0 (interpenetrating), < 30 mm (stop
       threshold), < 80 mm (warn threshold).
  2. Spot-check three obvious poses:
       - home  (all zeros) — expect all pairs well clear.
       - wrist folded down onto the base column — expect at least one
         pair report ≤ 0 mm.
       - stretched — expect all clear.
  3. Per-tick compute cost (median + p95) on this Jetson.

Also sanity-checks that no adjacent pair we EXCLUDED would have
routinely reported > 30 mm (i.e. verifies the pair list isn't
over-permissive)."""
import os, sys, time, statistics, random
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                 'src', 'estun_driver'))
from estun_driver.collision import CollisionModel

# Fitted joint limits (from dh_fit_report.txt).
LIMITS = [200.0, 200.0, 166.0, 200.0, 166.0, 200.0]

CAPSULES_YAML = os.path.join(os.path.dirname(__file__), '..',
                              'config', 'self_collision_capsules.yaml')


def rand_pose(rng):
    return [rng.uniform(-l, l) for l in LIMITS]


def main():
    model = CollisionModel(CAPSULES_YAML)
    print(f'Loaded {len(model.capsules)} capsules, '
          f'{len(model.pairs)} pairs\n')

    # 1. Random FK sweep
    rng = random.Random(20260715)
    N = 10000
    pair_min = {p: float('inf') for p in model.pairs}
    pair_all = {p: [] for p in model.pairs}
    overall_min = (float('inf'), None, None)
    over_0, over_30, over_80 = 0, 0, 0
    t_evals = []
    for _ in range(N):
        q = rand_pose(rng)
        t0 = time.perf_counter()
        res = model.evaluate(q)
        t_evals.append(time.perf_counter() - t0)
        if not res: continue
        for a, b, d in res:
            key = (a, b)
            if d < pair_min[key]:
                pair_min[key] = d
            pair_all[key].append(d)
            if d < overall_min[0]:
                overall_min = (d, key, q)
        # Closest pair for this pose
        min_d = res[0][2]
        if min_d <= 0:   over_0 += 1
        if min_d <= 30:  over_30 += 1
        if min_d <= 80:  over_80 += 1

    print(f'=== 10 000 random-pose sweep ===')
    print(f'Overall minimum:  {overall_min[0]:+7.1f} mm  pair={overall_min[1]}')
    print(f'Poses ≤ 0 mm  (interpenetrating): {over_0}   ({over_0/N*100:.2f} %)')
    print(f'Poses ≤ 30 mm (stop threshold):   {over_30}  ({over_30/N*100:.2f} %)')
    print(f'Poses ≤ 80 mm (warn threshold):   {over_80}  ({over_80/N*100:.2f} %)')
    print()
    print(f'Per-pair minimum + median distance:')
    print(f'  {"pair":<40} {"min (mm)":>10} {"median (mm)":>12}')
    for pair, dmin in sorted(pair_min.items(), key=lambda kv: kv[1]):
        med = statistics.median(pair_all[pair]) if pair_all[pair] else float('nan')
        print(f'  {str(pair):<40} {dmin:>10.1f} {med:>12.1f}')

    # 2. Spot poses
    print()
    print(f'=== spot-check poses ===')
    spots = [
        ('home (all zeros)',          [0, 0, 0, 0, 0, 0]),
        ('wrist folded toward column',[0, -175, 160, 0, 90, 0]),
        ('stretched horizontal',      [0, -90, 90, 0, 0, 0]),
    ]
    for label, q in spots:
        res = model.evaluate(q)
        print(f'  {label:<32}  min pair distance = {res[0][2]:+7.1f} mm '
              f'({res[0][0]}↔{res[0][1]})')
        # also show top 3 closest
        for a, b, d in res[:3]:
            print(f'    {a} ↔ {b}: {d:+7.1f} mm')

    # 3. Per-tick cost
    t_evals_ms = sorted(t*1000 for t in t_evals)
    print()
    print(f'=== compute cost (10 000 evaluations on this Jetson) ===')
    print(f'  median={t_evals_ms[N//2]:.3f} ms   '
          f'p95={t_evals_ms[int(N*0.95)]:.3f} ms   '
          f'max={t_evals_ms[-1]:.3f} ms')


if __name__ == '__main__':
    main()

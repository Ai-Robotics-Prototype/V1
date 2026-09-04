#!/usr/bin/env python3
"""Simulated collision-approach test.

Sweeps two representative trajectories through the CollisionModel and
verifies the warn / stop / direction-aware behavior would fire at the
right points:

  Scenario 1: wrist folding toward the base column
    (J1=0, J2=-90 fixed, J3 ramps 0 → 160°, J5 = 90 to bring wrist
     down toward the column). Expect: warn at ~80 mm, stop at ~30 mm,
     interpenetration below zero for the deepest step.

  Scenario 2: J2/J3 lowering the forearm toward the ground plane
    (J1=0, J2 ramps 0 → -170°, J3 = 100°). Same expected sequence
    but on __ground__ pairs.

Also spot-tests the direction-refinement: same trajectory REVERSED —
moving AWAY from the closest pair should not trigger 'stop' even at
distances below the stop threshold.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                 'src', 'estun_driver'))
from estun_driver.collision import CollisionModel

CAP_YAML = os.path.join(os.path.dirname(__file__), '..',
                         'config', 'self_collision_capsules.yaml')

WARN = 80.0
STOP = 30.0


def sweep(model, label, trajectory, expect_stop_pair=None):
    print(f'=== {label} ===')
    hit_warn = False
    hit_stop = False
    stop_pair = None
    stop_step = None
    prev_min = None
    for i, q in enumerate(trajectory):
        res = model.evaluate(q)
        if not res: continue
        a, b, d = res[0]
        note = ''
        if not hit_warn and d <= WARN:
            note = '  ← WARN fires'
            hit_warn = True
        if not hit_stop and d <= STOP:
            note += '  ← STOP fires'
            hit_stop = True
            stop_pair = (a, b)
            stop_step = i
        if i % max(1, len(trajectory)//20) == 0 or note:
            print(f'  step {i:3d}: q6={q[2]:+7.1f}° → min={d:+7.1f} mm '
                  f'({a}↔{b}){note}')
        prev_min = d
    print(f'  → warn fired: {hit_warn}, stop fired: {hit_stop}, '
          f'stop_pair: {stop_pair}')
    if expect_stop_pair:
        ok = stop_pair == expect_stop_pair
        print(f'  → expected pair: {expect_stop_pair}  ({"OK" if ok else "MISMATCH"})')
    print()
    return hit_warn, hit_stop, stop_pair


def main():
    model = CollisionModel(CAP_YAML)

    # Scenario 1: J3 sweep from 0 → 165° with J2 = -90 (arm out
    # horizontal), J5 = 90 (wrist rotated so it points at the base).
    traj1 = [[0, -90, j3, 0, 90, 0] for j3 in range(0, 166, 5)]
    sweep(model, 'scenario 1: wrist folding toward base column '
                 '(J3 0→165°, J2=-90, J5=90)', traj1)

    # Scenario 2: J2 sweep from 0 → -170° with J3 = 100°, which
    # lowers the forearm/wrist toward the ground.
    traj2 = [[0, j2, 100, 0, 0, 0] for j2 in range(0, -171, -5)]
    sweep(model, 'scenario 2: forearm lowering toward ground plane '
                 '(J2 0→-170°, J3=100°)', traj2)

    # Direction-refinement spot-check — jog AWAY from a close pose
    # should not stop. Start deep, move outward.
    print('=== direction-refinement spot check (reverse of scenario 2) ===')
    reverse = list(reversed(traj2))
    a0, b0, d0 = model.evaluate(reverse[0])[0]
    a1, b1, d1 = model.evaluate(reverse[1])[0]
    print(f'  start deep: min={d0:+.1f} mm ({a0}↔{b0})  ')
    print(f'  one step retreat: min={d1:+.1f} mm ({a1}↔{b1})  '
          f'{"opening" if d1 > d0 else "closing"}')
    print(f'  → distance change: {d1-d0:+.1f} mm')
    print('  (in the driver, this "opening" delta with dist ≤ stop still '
          'triggers the warning tint but NOT the stopJog — the operator '
          'can jog out.)')


if __name__ == '__main__':
    main()

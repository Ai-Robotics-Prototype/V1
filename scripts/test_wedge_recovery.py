#!/usr/bin/env python3
"""Simulate the operator wedge scenario and verify the fix.

Scenarios:
  1. Approach a real static zone until we're inside the stop threshold.
     From that pose, try:
       - a jog IN the offending direction  (must be REFUSED via projection)
       - a jog OPPOSITE the offending direction (must be ALLOWED)
       - request the escape-directions list  (must be non-empty)
  2. Craft a synthetic no-escape pose and verify:
       - escape list empty
       - fallback path would let a 3% jog through

Uses the same CollisionModel the driver uses.
"""
import os, sys, ssl, json, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                 'src', 'estun_driver'))
from estun_driver.collision import CollisionModel, parse_static_zones

CAP_YAML = os.path.join(os.path.dirname(__file__), '..',
                         'config', 'self_collision_capsules.yaml')

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def project_command(model, q_deg, joint, direction):
    """Mirror the driver's command-time gate: project one 5° step and
    return (opening, current_min, projected_min, pair)."""
    (pair, cur) = model.min_distance_at(q_deg)
    q_proj = list(q_deg)
    q_proj[joint - 1] += 5.0 * (1 if direction > 0 else -1)
    (_, proj) = model.min_distance_at(q_proj)
    return proj > cur + 0.5, cur, proj, pair


def main():
    payload = json.loads(urllib.request.urlopen(
        'https://127.0.0.1:8080/api/collision/static_zones',
        context=CTX, timeout=5).read())
    zones = parse_static_zones(payload)
    model = CollisionModel(CAP_YAML)
    model.set_env_zones(zones)
    # Use the NEW ground default; simulate the driver behavior.
    model.ground_z_mm = -300.0
    print(f'Loaded {len(zones)} env zones; ground_z_mm=-300')
    print()

    print('=== Scenario 1: wedge at env-zone contact ===')
    # Find a pose near a zone (from the previous scenario test).
    # J1 sweep in from safe to inside-stop.
    approach = None
    for j1 in range(0, -180, -2):
        q = [j1, -70, 90, 0, 0, 0]
        (pair, d) = model.min_distance_at(q)
        if d <= 28:   # 28 mm — just inside stop threshold
            approach = q; break
    if approach is None:
        print('  could not manufacture a wedge pose — abort')
        return
    (pair, cur) = model.min_distance_at(approach)
    print(f'  wedge pose q_deg = {[round(x,1) for x in approach]}')
    print(f'  offender {pair} at {cur:+.1f} mm')

    # Try closing motion — the previous direction that got us here
    # was -J1. Try J1- again.
    op, c, p, _ = project_command(model, approach, 1, -1)
    verdict = 'REFUSED (closes into stop)' if not op else 'allowed'
    print(f'  jog J1- (closing dir): projected {p:+.1f} mm → {verdict}')

    # Try opposite — J1+.
    op, c, p, _ = project_command(model, approach, 1, +1)
    verdict = 'ALLOWED (opens)' if op else 'refused'
    print(f'  jog J1+ (opening dir): projected {p:+.1f} mm → {verdict}')

    # Verify the escape list is non-empty and includes J1+.
    escapes = model.escape_directions_any(approach, pair)
    print(f'  escape directions ({len(escapes)}):')
    for e in escapes:
        sign = '+' if e['direction'] > 0 else '-'
        gain = e['projected_mm'] - e['current_mm']
        print(f'    J{e["joint"]}{sign}: '
              f'{e["current_mm"]:.0f}→{e["projected_mm"]:.0f} mm  '
              f'(+{gain:.0f} mm)')

    print()
    print('=== Scenario 2: no-escape pose (all directions close) ===')
    # Manufacture a pose where every single-axis step either keeps us
    # in the same zone or moves into another. Use the deepest-in-cluster
    # pose we can find. Attempt: J1=-40°, J2=-100°, J3=90° — arm pushed
    # deep into an obstacle cluster. See what escapes come back.
    deep_pose = [-40, -100, 90, 0, 0, 0]
    (pair, cur) = model.min_distance_at(deep_pose)
    escapes = model.escape_directions_any(deep_pose, pair)
    print(f'  deep pose q_deg = {deep_pose}  offender {pair}  cur={cur:+.0f} mm')
    print(f'  escape count: {len(escapes)}')
    if len(escapes) == 0:
        print('  → FALLBACK OVERRIDE would engage: '
              'driver allows any joint at 3% cap with LOUD warn log.')
    else:
        for e in escapes[:3]:
            sign = '+' if e['direction'] > 0 else '-'
            print(f'    J{e["joint"]}{sign}: '
                  f'{e["current_mm"]:.0f}→{e["projected_mm"]:.0f} mm')

    print()
    print('=== Scenario 3: ground-clearance re-validation at CURRENT pose ===')
    # Read live joints from /api/state and compute ground clearance
    # with the OLD default (0) vs NEW default (-300).
    st = json.loads(urllib.request.urlopen(
        'https://127.0.0.1:8080/api/state', context=CTX, timeout=5).read())
    joints_rad = st.get('joints', {}).get('positions')
    import math
    joints_deg = [math.degrees(v) for v in joints_rad]
    print(f'  live joints_deg = {[round(x,1) for x in joints_deg]}')
    for gz in (0.0, -300.0):
        model.ground_z_mm = gz
        res = model.evaluate(joints_deg)
        gr = [(a,b,d) for a,b,d in res if a=='__ground__' or b=='__ground__']
        if gr:
            _, _, d = gr[0]
            note = ' ← WEDGE default' if gz == 0.0 else ' ← current fix'
            print(f'    ground_z={gz:+.0f} mm  →  min-ground-clearance {d:+.0f} mm{note}')


if __name__ == '__main__':
    main()

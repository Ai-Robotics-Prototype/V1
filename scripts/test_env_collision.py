#!/usr/bin/env python3
"""Simulated env-collision approach test.

  1. Fetch the current-cell static zones from the dashboard API.
  2. Feed them into a CollisionModel with the fitted DH.
  3. Sweep a joint trajectory that approaches the closest env zone
     (from a known-safe home) and verify:
       - warn fires when clearance drops below 80 mm
       - stop fires at 30 mm
       - escape-direction search yields sensible candidates
  4. Report the combined (self + env) per-tick cost.

Also confirms the LIVE current pose (from the driver via /api/state)
reports NO active env warning — regression check on normal operation.
"""
import os, sys, time, json, ssl, urllib.request, statistics, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..',
                                 'src', 'estun_driver'))
from estun_driver.collision import CollisionModel, parse_static_zones

CAP_YAML = os.path.join(os.path.dirname(__file__), '..',
                         'config', 'self_collision_capsules.yaml')

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def fetch_static_zones():
    with urllib.request.urlopen(
            'https://127.0.0.1:8080/api/collision/static_zones',
            context=CTX, timeout=5) as r:
        return json.loads(r.read())


def fetch_live_state():
    with urllib.request.urlopen(
            'https://127.0.0.1:8080/api/state',
            context=CTX, timeout=5) as r:
        return json.loads(r.read())


def find_approach_trajectory(model, zone_id, n_steps=30):
    """Sweep J1 through -180 → +180 (in 12°/step) and find the pose
    that gives min clearance to the specific zone_id. Use that pose
    as the "close" endpoint; interpolate from home to there."""
    end_q = None; end_d = float('inf')
    for j1 in range(-180, 181, 12):
        q = [j1, -70, 90, 0, 0, 0]
        d = model.env_dist_for_pair(q, 'link3_forearm', zone_id)
        if d < end_d:
            end_d = d; end_q = list(q)
    if end_q is None:
        return None, float('inf')
    start_q = [0, 0, 0, 0, 0, 0]
    traj = []
    for i in range(n_steps + 1):
        f = i / n_steps
        traj.append([start_q[k] + f * (end_q[k] - start_q[k]) for k in range(6)])
    return traj, end_d


def main():
    payload = fetch_static_zones()
    zones = parse_static_zones(payload)
    print(f'Loaded {len(zones)} static zones from the dashboard.')
    if not zones:
        print('no zones — nothing to test against'); return
    model = CollisionModel(CAP_YAML)
    model.set_env_zones(zones)

    # Pick the zone that gets closest under our approach sweep
    # (usually the operator's biggest cluster).
    zone_ids = [z.zone_id for z in zones]
    best_zone, best_traj, best_d = None, None, float('inf')
    for zid in zone_ids:
        traj, ed = find_approach_trajectory(model, zid, n_steps=40)
        if ed < best_d:
            best_zone, best_traj, best_d = zid, traj, ed
    print(f'Chosen approach zone: {best_zone}  '
          f'(min link3_forearm clearance at end of sweep: {best_d:+.1f} mm)')
    print()

    warn = 80.0; stop = 30.0
    hit_warn, hit_stop = None, None
    for i, q in enumerate(best_traj):
        res = model.evaluate(q)
        env = [(a, b, d) for a, b, d in res
               if isinstance(a, str) and isinstance(b, str)
               and (a.startswith('zone#') or b.startswith('zone#'))]
        if not env: continue
        a, b, d = env[0]
        link = a if not a.startswith('zone#') else b
        note = ''
        if hit_warn is None and d <= warn:
            hit_warn = i; note = '   ← WARN'
        if hit_stop is None and d <= stop:
            hit_stop = i; note += '   ← STOP'
        if i % 5 == 0 or note:
            print(f'  step {i:3d}: J1={q[0]:+6.1f}°  min {link} vs {b.replace("zone#","")}: {d:+7.1f} mm{note}')

    print()
    if hit_warn is None:
        print('  → warn never fired; approach may not have brought clearance below 80 mm.')
    else:
        print(f'  → warn fired at step {hit_warn} ({best_traj[hit_warn][0]:+.1f}° J1)')
    if hit_stop is None:
        print('  → stop never fired.')
    else:
        # Compute escape directions at the stop pose
        q_stop = best_traj[hit_stop]
        res = model.evaluate(q_stop)
        env = [(a, b, d) for a, b, d in res
               if isinstance(a, str) and isinstance(b, str)
               and (a.startswith('zone#') or b.startswith('zone#'))]
        a, b, d = env[0]
        link = a if not a.startswith('zone#') else b
        zid = (a if a.startswith('zone#') else b).replace('zone#', '')
        escapes = model.escape_directions(q_stop, link, zid)
        print(f'  → stop fired at step {hit_stop} ({best_traj[hit_stop][0]:+.1f}° J1, dist {d:.1f} mm)')
        print(f'\n=== escape-direction trace at stop pose ===')
        print(f'  q_deg = {[round(x,1) for x in q_stop]}')
        print(f'  offender: {link} ↔ zone#{zid}  cur={d:.1f} mm')
        if escapes:
            print(f'  {len(escapes)} escape direction(s) found:')
            for e in escapes:
                sign = '+' if e['direction'] > 0 else '−'
                gain = e['projected_mm'] - e['current_mm']
                print(f'    J{e["joint"]}{sign}: {e["current_mm"]:.1f} → {e["projected_mm"]:.1f} mm  '
                      f'(+{gain:.1f} mm one step)')
        else:
            print(f'  NO single-axis escape — deep pocket. Popup shows pendant hint.')

    # Compute cost
    print()
    n = 200
    t = []
    q_test = best_traj[len(best_traj)//2]
    for _ in range(n):
        t0 = time.perf_counter()
        model.evaluate(q_test)
        t.append((time.perf_counter() - t0) * 1000)
    t.sort()
    print(f'=== combined tick cost (self + env, {len(zones)} zones, {n} runs) ===')
    print(f'  median {t[n//2]:.2f} ms   p95 {t[int(n*0.95)]:.2f} ms   max {t[-1]:.2f} ms')

    # Live regression
    print()
    print('=== live pose regression ===')
    live = fetch_live_state()['robot']
    print(f'  env_min_mm: {live.get("env_min_mm")}')
    print(f'  env_pair:   {live.get("env_pair")}')
    print(f'  → active env warning: '
          f'{"YES" if (live.get("env_min_mm") is not None and live.get("env_min_mm") <= 80) else "no"}')


if __name__ == '__main__':
    main()

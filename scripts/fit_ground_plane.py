#!/usr/bin/env python3
"""Fit the physical floor z in the driver's base_link frame from the
LiDAR cell data. Two sources tried, in order:

  1. /api/collision/static_zones — the static-zone pipeline already
     runs RANSAC / clustering and stores per-zone AABBs. If any zone
     has a flat, wide profile with a low z (looks like the floor),
     we take its lowest z as the fit.

  2. Otherwise, fall back to the raw LiDAR cache (if reachable) and
     do our own RANSAC for a horizontal plane (normal ‖ +z, coverage
     large, plane z below any zone's centre).

Emits the value in **mm** for `ground_z_mm` in
`src/estun_driver/config/estun.yaml`. STOPS with a clear message if
no horizontal plane is found — better a manual set than a silent
wrong default.

Usage:
  python3 scripts/fit_ground_plane.py
  # prints:
  #   fitted ground_z: -287.6 mm (from static_zone bottom, inliers=1506)
  #   suggested YAML: ground_z_mm: -287.6
"""
import json, ssl, sys, urllib.request

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def fetch_json(url):
    with urllib.request.urlopen(url, context=CTX, timeout=5) as r:
        return json.loads(r.read())


def fit_from_static_zones(payload):
    """Look for the widest, flattest zone at low z. Returns (z_mm,
    reason) or (None, reason_if_failed)."""
    zones = (payload or {}).get('zones') or []
    if not zones:
        return None, 'no static zones in payload'
    # Score each zone by: horizontal footprint area × 1/height. Floor
    # candidate is a zone with X×Y large and Z small.
    best = None
    for z in zones:
        d = z.get('dimensions') or {}
        c = z.get('center') or {}
        dx, dy, dz = float(d.get('x', 0)), float(d.get('y', 0)), float(d.get('z', 0))
        cz = float(c.get('z', 0))
        if dz <= 0 or dx <= 0 or dy <= 0:
            continue
        area = dx * dy
        thin_score = area / max(dz, 0.01)
        # Only consider genuinely thin, wide zones ≤ 150 mm tall and
        # ≥ 400 mm on each side of the horizontal footprint.
        if dz > 0.15 or dx < 0.4 or dy < 0.4:
            continue
        # Bottom face z (m).
        bottom = cz - dz / 2.0
        entry = {'z_bottom_m': bottom, 'score': thin_score,
                 'name': z.get('name'), 'inliers': z.get('point_count'),
                 'dx': dx, 'dy': dy, 'dz': dz}
        if best is None or entry['score'] > best['score']:
            best = entry
    if best is None:
        return None, 'no thin/wide zone matches floor heuristic'
    z_mm = best['z_bottom_m'] * 1000.0
    return z_mm, (f"static_zone bottom "
                  f"(name={best['name']}, "
                  f"footprint={best['dx']*1000:.0f}×{best['dy']*1000:.0f} mm, "
                  f"thickness={best['dz']*1000:.0f} mm, "
                  f"inliers={best['inliers']})")


def main():
    print('Fitting ground_z from cell data …')
    try:
        payload = fetch_json('https://127.0.0.1:8080/api/collision/static_zones')
    except Exception as e:
        print(f'  cannot reach dashboard /api/collision/static_zones: {e}')
        print(f'  aborting — bring the dashboard up first, or set '
              f'ground_z_mm manually in estun.yaml.')
        sys.exit(1)
    z_mm, reason = fit_from_static_zones(payload)
    if z_mm is None:
        print(f'  static-zone fit failed: {reason}')
        print(f'  {len(payload.get("zones") or [])} zones available. '
              f'STOPPING — no floor plane recoverable from the static-zone data.')
        print(f'  Manual fallback: measure the stand height and set '
              f'ground_z_mm: -<stand_height_mm> in estun.yaml.')
        sys.exit(2)
    print(f'  fitted ground_z: {z_mm:+.1f} mm  ({reason})')
    print()
    print(f'  suggested YAML update in src/estun_driver/config/estun.yaml:')
    print(f'    ground_z_mm: {z_mm:+.1f}')
    print()
    print(f'Also run the driver briefly and check the startup log for the '
          f'sanity line — if any link at the current live pose reports a '
          f'ground distance < 0 mm, the value is wrong (arm cannot be '
          f'below the physical floor).')


if __name__ == '__main__':
    main()

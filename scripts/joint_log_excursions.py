#!/usr/bin/env python3
"""Excursion summary CLI for a joint_log JSONL. Delegates to the
shared analyzer (cobot_dashboard.joint_excursions.analyze) so the CLI
output and the /api/runs/{id}/excursions endpoint always agree.

Usage
-----
    python3 scripts/joint_log_excursions.py <path/to/log.jsonl>
    python3 scripts/joint_log_excursions.py <path> --joint 4
    python3 scripts/joint_log_excursions.py <path> --threshold 5
"""

from __future__ import annotations

import argparse
import os
import sys

# Import the shared analyzer. Try the installed package first (colcon
# install), then fall back to the src tree when running from a fresh
# checkout that hasn't been built.
sys.path.insert(0, '/home/teddy/cobot_ws/src/cobot_dashboard')
try:
    from cobot_dashboard.joint_excursions import (
        analyze, load_samples_from_jsonl,
    )
except Exception as e:
    print(f'import failure: {e}', file=sys.stderr)
    sys.exit(2)


def render_table(analysis, only_joint=None):
    key = analysis.get('grouped_by')
    print(f'  grouped-by={key}  groups={analysis.get("groups")}')
    print()
    col_step = f'{key or "step":<12}'
    header = f'  {col_step} {"line":>5} {"n":>4}'
    if only_joint is None:
        for j in range(6):
            header += f' | J{j+1} start→end  min|max  swing'
    else:
        header += f' | J{only_joint+1}: start→end  min|max  swing'
    print(header)
    print(f'  {"-"*12} {"-"*5} {"-"*4} ' + '-' * max(1, len(header) - 30))

    for row in analysis['rows']:
        line = row.get('program_line')
        line_s = str(line) if line is not None else '-'
        n = row['samples']
        pieces = []
        joints = row['joints'] if only_joint is None \
                 else [j for j in row['joints'] if j['j'] == only_joint + 1]
        for j in joints:
            marker = '!!' if j['flagged'] else '  '
            pieces.append(f' {j["start"]:+7.2f}→{j["end"]:+7.2f} '
                          f'{j["min"]:+7.2f}|{j["max"]:+7.2f}'
                          f'{marker}{j["swing"]:5.2f}')
        print(f'  {str(row["step_key"]):<12} {line_s:>5} {n:>4} ' + '|'.join(pieces))

    print()
    worst = analysis.get('worst')
    thr = analysis['threshold_deg']
    if worst is None:
        print('  no data')
    elif worst['swing'] >= thr:
        print(f'  WORST EXCURSION: J{worst["joint"]} in step {worst["step_key"]}: '
              f'{worst["swing"]:.2f}° (threshold {thr:.1f}°)  ⚠ FLAGGED')
    else:
        print(f'  worst excursion: J{worst["joint"]} in step {worst["step_key"]}: '
              f'{worst["swing"]:.2f}°  (under {thr:.1f}° threshold — clean)')
    return worst is not None and worst['swing'] >= thr


def main():
    p = argparse.ArgumentParser()
    p.add_argument('path')
    p.add_argument('--threshold', type=float, default=10.0,
                   help='over-swing threshold in degrees (default 10)')
    p.add_argument('--joint', type=int, default=None,
                   help='restrict output to a single joint (1..6)')
    args = p.parse_args()
    if args.joint is not None and not (1 <= args.joint <= 6):
        print('--joint must be between 1 and 6', file=sys.stderr)
        sys.exit(2)
    only_joint = None if args.joint is None else args.joint - 1
    if not os.path.isfile(args.path):
        print(f'not found: {args.path}', file=sys.stderr)
        sys.exit(2)
    open_m, close_m, samples = load_samples_from_jsonl(args.path)
    if not samples:
        print(f'{args.path}: no samples')
        sys.exit(1)
    dur = (close_m or {}).get('duration_actual_s') or \
          (open_m or {}).get('duration_s') or '?'
    rate = (open_m or {}).get('rate_hz', '?')
    label = (open_m or {}).get('label', '?')
    print(f'{args.path}')
    print(f'  label={label}  duration={dur}s  rate={rate}Hz  '
          f'samples={len(samples)}')
    print()
    analysis = analyze(samples, threshold_deg=args.threshold)
    flagged = render_table(analysis, only_joint)
    sys.exit(2 if flagged else 0)


if __name__ == '__main__':
    main()

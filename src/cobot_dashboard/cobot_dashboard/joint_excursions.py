"""Joint-excursion analyzer.

Group samples by step_index (or program_line if step_index is
missing) and compute per-joint (start, end, min, max, over-swing)
tables. Extracted from scripts/joint_log_excursions.py so both the
CLI and the /api/runs/{id}/excursions endpoint share one code path
— the endpoint's output must agree with a parallel one-shot log's
CLI output byte-for-byte (that's the test 1 → test 2 sanity check
in the always-on recorder acceptance).

`_joint_excursion` — a joint's over-swing is the largest distance
any sample lies OUTSIDE the [min(start,end), max(start,end)] band.
Motion within the band is legitimate (it's the trajectory between
the two commanded endpoints). Motion beyond it is a re-solve or a
branch flip — the ONLY reading the operator's §354 report can be.
"""

from __future__ import annotations

import json
import os
from collections import OrderedDict
from typing import Iterable


def _joint_excursion(values, start_val, end_val):
    lo, hi = (start_val, end_val) if start_val <= end_val else (end_val, start_val)
    worst = 0.0
    for v in values:
        if v < lo:
            worst = max(worst, lo - v)
        elif v > hi:
            worst = max(worst, v - hi)
    return worst


def _group_by_step(samples):
    """Group samples by step_index (falls back to program_line if
    step_index is null throughout). Returns (OrderedDict, key_used)."""
    have_step = any(s.get('step_index') is not None for s in samples)
    key = 'step_index' if have_step else 'program_line'
    groups = OrderedDict()
    for s in samples:
        k = s.get(key)
        if k is None:
            k = '(no-line)'
        groups.setdefault(k, []).append(s)
    return groups, key


def analyze(samples: Iterable[dict], *, threshold_deg: float = 10.0) -> dict:
    """Analyze a run's samples. Returns a dict shaped for JSON return
    from an HTTP endpoint AND for the CLI's table renderer:

        {
          'threshold_deg': float,
          'grouped_by':    'step_index' | 'program_line',
          'groups':        int,
          'rows': [
            {'step_key': ..., 'program_line': ..., 'samples': N,
             'joints': [
                {'j': 1..6, 'start': float, 'end': float,
                 'min': float, 'max': float, 'swing': float,
                 'flagged': bool},
                ...
             ]},
            ...
          ],
          'worst': {'step_key': ..., 'joint': 1..6, 'swing': float} | None,
        }
    """
    samples = [s for s in samples if s and len(s.get('joints_deg') or []) == 6]
    if not samples:
        return {
            'threshold_deg': threshold_deg,
            'grouped_by':    None,
            'groups':        0,
            'rows':          [],
            'worst':         None,
        }
    groups, key = _group_by_step(samples)
    rows = []
    worst = None
    for grp_key, grp_rows in groups.items():
        n = len(grp_rows)
        start = grp_rows[0]['joints_deg']
        end   = grp_rows[-1]['joints_deg']
        line  = grp_rows[0].get('program_line')
        joints = []
        for j in range(6):
            col = [r['joints_deg'][j] for r in grp_rows]
            js_start = float(start[j])
            js_end   = float(end[j])
            js_min   = min(col)
            js_max   = max(col)
            swing    = _joint_excursion(col, js_start, js_end)
            flagged  = swing >= threshold_deg
            if worst is None or swing > worst['swing']:
                worst = {'step_key': grp_key, 'joint': j + 1, 'swing': swing}
            joints.append({
                'j':       j + 1,
                'start':   round(js_start, 3),
                'end':     round(js_end, 3),
                'min':     round(js_min, 3),
                'max':     round(js_max, 3),
                'swing':   round(swing, 3),
                'flagged': flagged,
            })
        rows.append({
            'step_key':     grp_key,
            'program_line': line,
            'samples':      n,
            'joints':       joints,
        })
    return {
        'threshold_deg': threshold_deg,
        'grouped_by':    key,
        'groups':        len(rows),
        'rows':          rows,
        'worst':         worst,
    }


def load_samples_from_jsonl(path) -> tuple[dict | None, dict | None, list[dict]]:
    """Load a joint-log JSONL (either from the one-shot logger or the
    always-on recorder). Returns (open_meta, close_meta, samples)."""
    open_meta = None
    close_meta = None
    samples = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get('meta') == 'open':
                open_meta = d
            elif d.get('meta') == 'close':
                close_meta = d
            else:
                samples.append(d)
    return open_meta, close_meta, samples


def load_samples_from_gzip_segments(segment_paths) -> list[dict]:
    """Concatenate samples across a list of .jsonl.gz segment files.
    Meta lines are dropped — the caller usually already has the run
    manifest with the timing metadata. Segments are read in the
    order they appear; the caller sorts by timestamp."""
    import gzip
    out = []
    for p in segment_paths:
        try:
            opener = gzip.open if p.endswith('.gz') else open
            with opener(p, 'rt') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if d.get('meta'):
                        continue
                    out.append(d)
        except Exception:
            continue
    return out

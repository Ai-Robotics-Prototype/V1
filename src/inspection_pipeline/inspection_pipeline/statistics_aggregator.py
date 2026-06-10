"""Rolling stats over the inspection record set.

The dashboard's Overview / Analytics views want per-part counts, pass
rates, deviation trends, and SPC indicators on every page load —
recomputing them by walking the JSON file tree would be too slow once
the system has been running for a few weeks.

So we keep a cache on disk (`/opt/cobot/inspections/stats_cache.json`)
and update it two ways:

  1. Incremental — `on_new_record()` is called by the inspection node
     after each completed inspection and bumps the counters in O(1).
  2. Periodic — `rebuild_from_index()` walks the SQLite index (which
     is small) every 5 min to recompute rates / trends / control
     limits that don't update cleanly via increment alone.

Disk format is intentionally human-readable so an operator can `cat
stats_cache.json` to diagnose surprises.
"""

from __future__ import annotations

import math
import sqlite3
import time
from typing import Any

from .utils import (
    INDEX_DB_FILE, STATS_CACHE_FILE, RESULT_FAIL, RESULT_PASS, RESULT_WARN,
    ensure_dirs, safe_dump_json, safe_load_json,
)


WINDOW_24H = 24 * 3600
WINDOW_7D  = 7 * 24 * 3600
WINDOW_30D = 30 * 24 * 3600


def _empty_per_part() -> dict:
    return {
        'total':       {'all': 0, '24h': 0, '7d': 0, '30d': 0},
        'pass_count':  {'all': 0, '24h': 0, '7d': 0, '30d': 0},
        'warn_count':  {'all': 0, '24h': 0, '7d': 0, '30d': 0},
        'fail_count':  {'all': 0, '24h': 0, '7d': 0, '30d': 0},
        'pass_rate':   {'all': None, '24h': None, '7d': None, '30d': None},
        'mean_deviation_mm': None,
        'rms_deviation_mm':  None,
        'max_deviation_mm':  None,
        'p95_deviation_mm':  None,
        'p99_deviation_mm':  None,
        'cp':              None,
        'cpk':             None,
        'trend_pass_rate': None,
        'control_limits':  None,
        'defect_types':    {},
    }


def empty_cache() -> dict:
    """Shape the dashboard can safely render even with zero records."""
    return {
        'last_updated': None,
        'global': {
            'total_inspections': 0,
            'pass_rate_all':     None,
            'pass_rate_24h':     None,
            'pass_rate_7d':      None,
            'pass_rate_30d':     None,
        },
        'per_part': {},
    }


def load_cache() -> dict:
    return safe_load_json(STATS_CACHE_FILE, empty_cache())


def save_cache(cache: dict) -> None:
    cache['last_updated'] = time.time()
    safe_dump_json(STATS_CACHE_FILE, cache)


# ─── Incremental update ─────────────────────────────────────────────────

def on_new_record(record_summary: dict) -> dict:
    """Cheap counter bump on each new inspection.

    Trends, percentiles, and control limits are *not* updated here —
    those need a window scan and are handled by `rebuild_from_index`.
    """
    cache = load_cache()
    pp = cache['per_part'].setdefault(record_summary['part_id'], _empty_per_part())
    result = record_summary.get('result', RESULT_PASS)

    pp['total']['all'] += 1
    if result == RESULT_PASS:
        pp['pass_count']['all'] += 1
    elif result == RESULT_WARN:
        pp['warn_count']['all'] += 1
    elif result == RESULT_FAIL:
        pp['fail_count']['all'] += 1

    cache['global']['total_inspections'] += 1
    save_cache(cache)
    return cache


# ─── Periodic rebuild ───────────────────────────────────────────────────

def rebuild_from_index(db_path: str = INDEX_DB_FILE) -> dict:
    """Recompute everything from the SQLite index.

    O(N) in record count but the index is light (one row per
    inspection, indexed by timestamp+part_id) so it stays fast well
    into the millions of rows.
    """
    ensure_dirs()
    cache = empty_cache()
    if not _index_exists(db_path):
        save_cache(cache)
        return cache

    now = time.time()
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            'SELECT part_id, timestamp, result, max_deviation, '
            'mean_deviation FROM inspections')
        rows = cur.fetchall()
    finally:
        conn.close()

    # Bucket by part.
    by_part: dict[str, list[tuple]] = {}
    for r in rows:
        by_part.setdefault(r[0], []).append(r)

    total = 0
    pass_total = 0
    pass_24 = total_24 = 0
    pass_7  = total_7  = 0
    pass_30 = total_30 = 0

    for part_id, part_rows in by_part.items():
        pp = _empty_per_part()
        devs_max  = []
        devs_mean = []

        for _pid, ts, result, max_d, mean_d in part_rows:
            pp['total']['all'] += 1
            total += 1
            if result == RESULT_PASS:
                pp['pass_count']['all'] += 1
                pass_total += 1
            elif result == RESULT_WARN:
                pp['warn_count']['all'] += 1
            elif result == RESULT_FAIL:
                pp['fail_count']['all'] += 1

            age = now - ts
            if age <= WINDOW_24H:
                pp['total']['24h'] += 1; total_24 += 1
                if result == RESULT_PASS:
                    pp['pass_count']['24h'] += 1; pass_24 += 1
                elif result == RESULT_WARN:
                    pp['warn_count']['24h'] += 1
                elif result == RESULT_FAIL:
                    pp['fail_count']['24h'] += 1
            if age <= WINDOW_7D:
                pp['total']['7d'] += 1; total_7 += 1
                if result == RESULT_PASS:
                    pp['pass_count']['7d'] += 1; pass_7 += 1
                elif result == RESULT_WARN:
                    pp['warn_count']['7d'] += 1
                elif result == RESULT_FAIL:
                    pp['fail_count']['7d'] += 1
            if age <= WINDOW_30D:
                pp['total']['30d'] += 1; total_30 += 1
                if result == RESULT_PASS:
                    pp['pass_count']['30d'] += 1; pass_30 += 1
                elif result == RESULT_WARN:
                    pp['warn_count']['30d'] += 1
                elif result == RESULT_FAIL:
                    pp['fail_count']['30d'] += 1

            if max_d is not None:
                devs_max.append(float(max_d))
            if mean_d is not None:
                devs_mean.append(float(mean_d))

        for k in ('all', '24h', '7d', '30d'):
            n = pp['total'][k]
            pp['pass_rate'][k] = (pp['pass_count'][k] / n) if n else None

        if devs_max:
            pp['max_deviation_mm']  = max(devs_max)
            pp['p95_deviation_mm']  = _percentile(devs_max, 95)
            pp['p99_deviation_mm']  = _percentile(devs_max, 99)
        if devs_mean:
            pp['mean_deviation_mm'] = sum(devs_mean) / len(devs_mean)
            pp['rms_deviation_mm']  = math.sqrt(
                sum(d * d for d in devs_mean) / len(devs_mean))

        # Cp/Cpk would need a per-measurement tolerance and a per-
        # measurement mean/std; left null until process-capability
        # rules are configured.
        pp['cp']  = None
        pp['cpk'] = None

        cache['per_part'][part_id] = pp

    cache['global']['total_inspections'] = total
    cache['global']['pass_rate_all'] = (pass_total / total) if total else None
    cache['global']['pass_rate_24h'] = (pass_24    / total_24) if total_24 else None
    cache['global']['pass_rate_7d']  = (pass_7     / total_7)  if total_7  else None
    cache['global']['pass_rate_30d'] = (pass_30    / total_30) if total_30 else None

    save_cache(cache)
    return cache


def get_part_stats(part_id: str) -> dict:
    cache = load_cache()
    return cache.get('per_part', {}).get(part_id, _empty_per_part())


def control_chart_series(part_id: str, db_path: str = INDEX_DB_FILE,
                         metric: str = 'max_deviation',
                         since_ts: float | None = None) -> dict:
    """Time series + UCL/LCL for SPC display.

    UCL/LCL are 3σ above and below the mean — the most common SPC
    convention. Caller can override `since_ts` to bound the window.
    """
    if not _index_exists(db_path):
        return {'series': [], 'mean': None, 'ucl': None, 'lcl': None}

    conn = sqlite3.connect(db_path)
    try:
        cur = conn.execute(
            'SELECT timestamp, ' + _safe_metric_column(metric) +
            ' FROM inspections WHERE part_id=? AND ' +
            _safe_metric_column(metric) + ' IS NOT NULL '
            + ('AND timestamp >= ? ' if since_ts else '') +
            'ORDER BY timestamp ASC',
            (part_id, since_ts) if since_ts else (part_id,)
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        return {'series': [], 'mean': None, 'ucl': None, 'lcl': None}

    values = [r[1] for r in rows]
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / len(values)
    std = math.sqrt(var) if var > 0 else 0.0
    ucl = mean + 3 * std
    lcl = mean - 3 * std

    return {
        'series': [{'t': r[0], 'v': r[1]} for r in rows],
        'mean':   mean,
        'ucl':    ucl,
        'lcl':    lcl,
        'std':    std,
        'out_of_control_count': sum(
            1 for v in values if v > ucl or v < lcl),
    }


def _safe_metric_column(metric: str) -> str:
    """Whitelist metric names — SQL is built from this string, can't trust input."""
    allowed = {'max_deviation', 'mean_deviation', 'duration_ms'}
    if metric not in allowed:
        raise ValueError(f'unknown metric: {metric}')
    return metric


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def _index_exists(db_path: str) -> bool:
    import os
    return os.path.isfile(db_path)

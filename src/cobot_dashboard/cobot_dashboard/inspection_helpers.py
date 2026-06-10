"""Inspection-tab backend helpers used by dashboard_server.py.

Split out of the main server module so the route definitions there
stay scannable. Everything in this file is a thin wrapper around the
inspection_pipeline package or the on-disk /opt/cobot/inspections
hierarchy — no ROS state lives here.

The dashboard imports `inspection_helpers()` once at startup; the
returned object is shared across all route handlers.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
import uuid
from typing import Any


# Storage layout (mirrors PART F of the spec). Kept as module-level
# constants so the helper functions are testable in isolation —
# point them at a tmpdir in unit tests by monkeypatching this module.
INSPECTIONS_ROOT = '/opt/cobot/inspections'
CONFIG_DIR       = os.path.join(INSPECTIONS_ROOT, 'config')
REFERENCES_DIR   = os.path.join(INSPECTIONS_ROOT, 'references')
RECORDS_DIR      = os.path.join(INSPECTIONS_ROOT, 'records')
STATS_CACHE_FILE = os.path.join(INSPECTIONS_ROOT, 'stats_cache.json')
INDEX_DB_FILE    = os.path.join(INSPECTIONS_ROOT, 'index.db')

TOLERANCES_FILE = os.path.join(CONFIG_DIR, 'tolerances.json')
PLANS_FILE      = os.path.join(CONFIG_DIR, 'plans.json')
TEMPLATES_FILE  = os.path.join(CONFIG_DIR, 'report_templates.json')
INSPECTORS_FILE = os.path.join(CONFIG_DIR, 'feature_inspectors.json')

RESULT_PASS, RESULT_WARN, RESULT_FAIL = 'pass', 'warn', 'fail'


def _ensure_dirs() -> None:
    for d in (INSPECTIONS_ROOT, CONFIG_DIR, REFERENCES_DIR, RECORDS_DIR):
        os.makedirs(d, exist_ok=True)


def _load_json(path: str, default: Any) -> Any:
    if not os.path.isfile(path):
        return default
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def _dump_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def _ensure_db() -> None:
    _ensure_dirs()
    conn = sqlite3.connect(INDEX_DB_FILE)
    try:
        conn.execute(
            'CREATE TABLE IF NOT EXISTS inspections ('
            'inspection_id TEXT PRIMARY KEY, '
            'part_id TEXT, plan_id TEXT, '
            'timestamp REAL, tier INTEGER, result TEXT, '
            'max_deviation REAL, mean_deviation REAL, '
            'duration_ms INTEGER, file_path TEXT)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_part_ts '
                     'ON inspections(part_id, timestamp)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_ts '
                     'ON inspections(timestamp)')
        conn.commit()
    finally:
        conn.close()


def _safe_metric(name: str) -> str:
    allowed = {'max_deviation', 'mean_deviation', 'duration_ms'}
    if name not in allowed:
        raise ValueError(f'unknown metric: {name}')
    return name


def _timeframe_to_since(timeframe: str) -> float | None:
    now = time.time()
    return {
        '24h':       now - 24 * 3600,
        '7d':        now - 7 * 24 * 3600,
        '30d':       now - 30 * 24 * 3600,
        '90d':       now - 90 * 24 * 3600,
        'all':       None,
    }.get(timeframe, now - 24 * 3600)


class InspectionHelpers:
    """Lightweight value object holding the route handlers' shared logic.

    A single instance is built by `_inspection_helpers()` in
    dashboard_server.py and stored in a module-level variable. None of
    the methods hold per-request state — they all read/write
    disk-backed state, so the instance can be safely shared across
    request handlers and threads.
    """

    def __init__(self) -> None:
        _ensure_dirs()
        _ensure_db()

    # ─── List + query ────────────────────────────────────────────────

    def list_records(self, **kw) -> dict:
        """Paginated history list. SQLite-backed for speed."""
        page = max(1, int(kw.get('page') or 1))
        per_page = max(1, min(200, int(kw.get('per_page') or 25)))
        sort = (kw.get('sort') or '-timestamp')
        direction = 'DESC' if sort.startswith('-') else 'ASC'
        col = sort.lstrip('-')
        if col not in {'timestamp', 'part_id', 'result',
                       'max_deviation', 'mean_deviation', 'tier'}:
            col = 'timestamp'

        where, params = [], []
        if kw.get('start_date') is not None:
            where.append('timestamp >= ?'); params.append(kw['start_date'])
        if kw.get('end_date') is not None:
            where.append('timestamp <= ?'); params.append(kw['end_date'])
        if kw.get('part_id'):
            where.append('part_id = ?'); params.append(kw['part_id'])
        if kw.get('result'):
            where.append('result = ?'); params.append(kw['result'])
        if kw.get('tier') is not None:
            where.append('tier = ?'); params.append(kw['tier'])
        where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''

        conn = sqlite3.connect(INDEX_DB_FILE)
        try:
            total = conn.execute(
                f'SELECT COUNT(*) FROM inspections {where_sql}',
                params).fetchone()[0]
            rows = conn.execute(
                f'SELECT inspection_id, part_id, plan_id, timestamp, '
                f'tier, result, max_deviation, mean_deviation, '
                f'duration_ms FROM inspections {where_sql} '
                f'ORDER BY {col} {direction} LIMIT ? OFFSET ?',
                (*params, per_page, (page - 1) * per_page)).fetchall()
        finally:
            conn.close()

        return {
            'total': total,
            'page':  page,
            'per_page': per_page,
            'items': [
                {
                    'inspection_id':  r[0], 'part_id': r[1],
                    'plan_id':        r[2], 'timestamp': r[3],
                    'tier':           r[4], 'result': r[5],
                    'max_deviation':  r[6], 'mean_deviation': r[7],
                    'duration_ms':    r[8],
                } for r in rows
            ],
        }

    def load_record(self, inspection_id: str) -> dict | None:
        path = self._record_dir(inspection_id)
        if not path:
            return None
        meta = _load_json(os.path.join(path, 'metadata.json'), None)
        return meta

    def record_file_path(self, inspection_id: str,
                         filename: str) -> str | None:
        d = self._record_dir(inspection_id)
        if not d:
            return None
        p = os.path.join(d, filename)
        return p if os.path.isfile(p) else None

    def ensure_report(self, inspection_id: str) -> str | None:
        """Return the PDF path, generating on demand if missing."""
        d = self._record_dir(inspection_id)
        if not d:
            return None
        path = os.path.join(d, 'report.pdf')
        if os.path.isfile(path):
            return path
        record = _load_json(os.path.join(d, 'metadata.json'), None)
        if record is None:
            return None
        try:
            from inspection_pipeline.report_generator import generate_report
            generate_report(record, path,
                            template=self.load_templates().get('default'))
            return path if os.path.isfile(path) else None
        except Exception:
            return None

    def _record_dir(self, inspection_id: str) -> str | None:
        """Locate the on-disk record directory for an inspection id.

        The id is sortable and encodes the timestamp, so we can build
        the YYYY/MM/DD path without hitting the DB. We still check
        existence on disk so a missing record returns None instead of a
        bogus path.
        """
        if not inspection_id or len(inspection_id) < 15:
            return None
        try:
            yyyy = inspection_id[:4]
            mm   = inspection_id[4:6]
            dd   = inspection_id[6:8]
        except Exception:
            return None
        path = os.path.join(RECORDS_DIR, yyyy, mm, dd, inspection_id)
        return path if os.path.isdir(path) else None

    # ─── Stats ───────────────────────────────────────────────────────

    def get_stats(self, timeframe: str, part_id: str | None) -> dict:
        # Use the cached stats from inspection_pipeline if importable;
        # otherwise compute a thin summary from the index DB.
        try:
            from inspection_pipeline.statistics_aggregator import (
                empty_cache, load_cache,
            )
            cache = load_cache()
        except Exception:
            cache = {'global': {}, 'per_part': {}}
        if part_id:
            return cache.get('per_part', {}).get(part_id, {})
        return cache

    def timeseries(self, metric: str, timeframe: str,
                   part_id: str | None, granularity: str) -> dict:
        metric = _safe_metric(metric)
        since = _timeframe_to_since(timeframe)

        bucket = {
            'hour': 3600, 'day': 86400, 'week': 7 * 86400,
        }.get(granularity, 86400)

        where, params = [], []
        if since is not None:
            where.append('timestamp >= ?'); params.append(since)
        if part_id:
            where.append('part_id = ?'); params.append(part_id)
        where.append(metric + ' IS NOT NULL')
        where_sql = 'WHERE ' + ' AND '.join(where)

        conn = sqlite3.connect(INDEX_DB_FILE)
        try:
            rows = conn.execute(
                f'SELECT timestamp, {metric} FROM inspections '
                f'{where_sql} ORDER BY timestamp ASC', params).fetchall()
        finally:
            conn.close()

        buckets: dict[int, list[float]] = {}
        for ts, val in rows:
            b = int(ts // bucket) * bucket
            buckets.setdefault(b, []).append(float(val))
        series = [{
            't':     b,
            'count': len(vs),
            'mean':  sum(vs) / len(vs),
            'max':   max(vs),
            'min':   min(vs),
        } for b, vs in sorted(buckets.items())]
        return {'series': series, 'metric': metric,
                'granularity': granularity, 'bucket_seconds': bucket}

    def distribution(self, metric: str, timeframe: str,
                     part_id: str | None, bins: int) -> dict:
        metric = _safe_metric(metric)
        since = _timeframe_to_since(timeframe)
        where, params = [], []
        if since is not None:
            where.append('timestamp >= ?'); params.append(since)
        if part_id:
            where.append('part_id = ?'); params.append(part_id)
        where.append(metric + ' IS NOT NULL')
        where_sql = 'WHERE ' + ' AND '.join(where)
        conn = sqlite3.connect(INDEX_DB_FILE)
        try:
            rows = conn.execute(
                f'SELECT {metric} FROM inspections {where_sql}',
                params).fetchall()
        finally:
            conn.close()
        values = [float(r[0]) for r in rows]
        if not values:
            return {'bins': [], 'counts': [], 'metric': metric}
        lo, hi = min(values), max(values)
        if hi == lo:
            hi = lo + 1e-6
        step = (hi - lo) / max(1, bins)
        counts = [0] * bins
        edges = [lo + i * step for i in range(bins + 1)]
        for v in values:
            i = min(bins - 1, int((v - lo) / step))
            counts[i] += 1
        return {'bins': edges, 'counts': counts, 'metric': metric}

    # ─── Storage ─────────────────────────────────────────────────────

    def storage_summary(self) -> dict:
        total = 0
        n_records = 0
        for root, _dirs, files in os.walk(RECORDS_DIR):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
            if root != RECORDS_DIR and os.path.basename(root).startswith(
                    tuple('0123456789')) and len(os.path.basename(root)) > 8:
                n_records += 1
        retention = _load_json(
            os.path.join(CONFIG_DIR, 'retention.json'),
            {'mode': '90d'})
        return {
            'bytes_used': total,
            'records':    n_records,
            'retention':  retention,
        }

    def cleanup(self, dry_run: bool,
                before_date: float | None) -> dict:
        if before_date is None:
            before_date = time.time() - 90 * 24 * 3600
        deleted, freed = 0, 0
        if not dry_run:
            for root, dirs, files in os.walk(RECORDS_DIR, topdown=False):
                # Only inspect leaf record dirs (those that have a
                # metadata.json) so we don't accidentally rm the
                # YYYY/MM/DD scaffolding.
                if 'metadata.json' in files:
                    meta = _load_json(os.path.join(root, 'metadata.json'), {})
                    if meta.get('timestamp', time.time()) < before_date:
                        for f in files:
                            try:
                                freed += os.path.getsize(os.path.join(root, f))
                            except OSError:
                                pass
                        shutil.rmtree(root, ignore_errors=True)
                        deleted += 1
        return {
            'dry_run':    dry_run,
            'deleted':    deleted,
            'freed_bytes': freed,
            'before_date': before_date,
        }

    # ─── Tolerances ──────────────────────────────────────────────────

    def load_tolerances(self) -> dict:
        return _load_json(TOLERANCES_FILE, {})

    def save_tolerance_rule(self, rule: dict) -> dict:
        all_rules = self.load_tolerances()
        part_id = rule.get('part_id')
        if not part_id:
            return {'error': 'part_id required'}
        rule_id = rule.get('rule_id') or uuid.uuid4().hex[:8]
        rule['rule_id'] = rule_id
        part_rules = all_rules.setdefault(part_id, {})
        part_rules[rule_id] = rule
        _dump_json(TOLERANCES_FILE, all_rules)
        return {'saved': rule_id, 'part_id': part_id}

    def delete_tolerance_rule(self, rule_id: str) -> dict:
        all_rules = self.load_tolerances()
        for part_id, rules in list(all_rules.items()):
            if rule_id in rules:
                del rules[rule_id]
                if not rules:
                    del all_rules[part_id]
                _dump_json(TOLERANCES_FILE, all_rules)
                return {'deleted': rule_id}
        return {'error': 'not found'}

    # ─── Plans ───────────────────────────────────────────────────────

    def load_plans(self) -> dict:
        return _load_json(PLANS_FILE, {})

    def save_plan(self, plan: dict) -> dict:
        if not plan.get('plan_id'):
            plan['plan_id'] = uuid.uuid4().hex[:8]
        plans = self.load_plans()
        plans[plan['plan_id']] = plan
        _dump_json(PLANS_FILE, plans)
        return {'saved': plan['plan_id']}

    def delete_plan(self, plan_id: str) -> dict:
        plans = self.load_plans()
        if plan_id in plans:
            del plans[plan_id]
            _dump_json(PLANS_FILE, plans)
            return {'deleted': plan_id}
        return {'error': 'not found'}

    def validate_plan(self, plan_id: str) -> dict:
        plan = self.load_plans().get(plan_id)
        if not plan:
            return {'ok': False, 'errors': ['plan not found']}
        errors = []
        for check in plan.get('checks', []):
            if not check.get('type'):
                errors.append(f'check missing type: {check}')
        return {'ok': not errors, 'errors': errors}

    # ─── References ──────────────────────────────────────────────────

    def list_references(self, part_id: str) -> list[dict]:
        try:
            from inspection_pipeline.reference_manager import ReferenceManager
            return ReferenceManager().list_references(part_id)
        except Exception as e:
            return [{'error': str(e)}]

    def build_reference_from_step(self, part_id: str,
                                  step_path: str | None,
                                  sample_points: int) -> dict:
        if not step_path or not os.path.isfile(step_path):
            return {'error': 'step_path missing or unreadable'}
        try:
            from inspection_pipeline.reference_manager import ReferenceManager
            return ReferenceManager().build_from_step(
                part_id, step_path, sample_points=sample_points)
        except Exception as e:
            return {'error': str(e)}

    def capture_golden_reference(self, part_id: str,
                                 metadata: dict) -> dict:
        # The actual capture requires the ROS pipeline + Mech-Eye.
        # Returns a structurally-valid stub the dashboard can render.
        return {
            'queued': True,
            'part_id': part_id,
            'message': 'Capture will run when /inspection/start is invoked '
                       'with reference_type=golden.',
            'metadata': metadata,
        }

    def build_statistical_reference(self, part_id: str,
                                    min_samples: int) -> dict:
        return {
            'queued': True,
            'part_id': part_id,
            'min_samples': min_samples,
            'message': 'Statistical reference build will run after enough '
                       'passing inspections accumulate.',
        }

    def set_active_reference(self, part_id: str, ref_type: str) -> dict:
        try:
            from inspection_pipeline.reference_manager import ReferenceManager
            return ReferenceManager().set_active_reference(part_id, ref_type)
        except Exception as e:
            return {'error': str(e)}

    # ─── Templates ───────────────────────────────────────────────────

    def load_templates(self) -> dict:
        return _load_json(TEMPLATES_FILE, {
            'default': {
                'name': 'default',
                'company_name': 'RoboAi',
                'pages': {'cover': True, 'summary': True,
                          'visualization': True, 'measurements': True,
                          'defects': True, 'statistics': True,
                          'traceability': True},
            },
        })

    def save_template(self, template: dict) -> dict:
        name = template.get('name')
        if not name:
            return {'error': 'name required'}
        templates = self.load_templates()
        templates[name] = template
        _dump_json(TEMPLATES_FILE, templates)
        return {'saved': name}

    # ─── Run-control (delegates to ROS node when present) ────────────

    def start_inspection(self, ros_node, body: dict) -> dict:
        """Trigger a manual inspection via the ROS service.

        Returns the structural response the UI expects whether or not
        the ROS node is up — this is the contract the Active sub-tab
        binds to.
        """
        inspection_id = _new_inspection_id()
        status = 'queued' if ros_node else 'pipeline_offline'
        if ros_node and hasattr(ros_node, 'request_inspection_start'):
            try:
                ros_node.request_inspection_start(body)
                status = 'started'
            except Exception as e:
                status = f'error: {e}'
        return {
            'inspection_id': inspection_id,
            'status':        status,
            'websocket_url': '/ws/inspection',
            'estimated_duration_ms': 5000,
        }

    def cancel_inspection(self, ros_node, inspection_id: str) -> dict:
        if ros_node and hasattr(ros_node, 'request_inspection_cancel'):
            try:
                ros_node.request_inspection_cancel(inspection_id)
                return {'cancelled': inspection_id}
            except Exception as e:
                return {'error': str(e)}
        return {'cancelled': inspection_id, 'note': 'ROS offline'}

    def re_run_inspection(self, ros_node, inspection_id: str) -> dict:
        record = self.load_record(inspection_id)
        if not record:
            return {'error': 'original record not found'}
        return self.start_inspection(ros_node, {
            'part_id':       record.get('part_id'),
            'plan_id':       record.get('plan_id'),
            'reference_type': record.get('reference_type'),
            'metadata': {'triggered_by': f're-run of {inspection_id}'},
        })

    def mark_false_positive(self, inspection_id: str,
                            reason: str,
                            defects_to_unflag: list) -> dict:
        rec = self.load_record(inspection_id)
        if rec is None:
            return {'error': 'not found'}
        rec.setdefault('false_positives', []).append({
            'ts':      time.time(),
            'reason':  reason,
            'defects': defects_to_unflag,
        })
        # Optionally downgrade the overall result if every flagged
        # defect was just dismissed.
        if defects_to_unflag and all(
                d.get('defect_id') in defects_to_unflag
                for d in rec.get('defects', [])):
            rec['overall_result'] = RESULT_PASS
        d = self._record_dir(inspection_id)
        if d:
            _dump_json(os.path.join(d, 'metadata.json'), rec)
        return {'ok': True, 'inspection_id': inspection_id}

    def add_notes(self, inspection_id: str, notes: str) -> dict:
        rec = self.load_record(inspection_id)
        if rec is None:
            return {'error': 'not found'}
        rec.setdefault('notes', []).append({'ts': time.time(),
                                            'text': notes})
        d = self._record_dir(inspection_id)
        if d:
            _dump_json(os.path.join(d, 'metadata.json'), rec)
        return {'ok': True}

    # ─── Export ──────────────────────────────────────────────────────

    def export(self, format: str, filters: dict, date_range: dict) -> dict:
        # Stub: in production this builds the file and returns a
        # presigned URL. Here it returns a job id so the UI download
        # flow can be tested end-to-end.
        return {
            'job_id': uuid.uuid4().hex[:12],
            'format': format,
            'note':   'Export build is async; poll job_id when implemented.',
        }


def _new_inspection_id() -> str:
    tm = time.gmtime()
    return (f'{tm.tm_year:04d}{tm.tm_mon:02d}{tm.tm_mday:02d}'
            f'T{tm.tm_hour:02d}{tm.tm_min:02d}{tm.tm_sec:02d}'
            f'-{uuid.uuid4().hex[:6]}')

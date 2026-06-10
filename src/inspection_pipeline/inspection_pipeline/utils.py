"""Shared helpers for the inspection pipeline.

Everything that does not depend on Open3D / SciPy / ROS is gathered here so
the algorithm modules stay importable in test environments that do not have
the full dependency stack installed yet (the Mech-Eye is not yet on the
robot, so the algorithm modules ship in a runnable-when-camera-arrives
state).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable

# Filesystem layout — see PART F of the inspection spec.
INSPECTIONS_ROOT = '/opt/cobot/inspections'
CONFIG_DIR       = os.path.join(INSPECTIONS_ROOT, 'config')
REFERENCES_DIR   = os.path.join(INSPECTIONS_ROOT, 'references')
RECORDS_DIR      = os.path.join(INSPECTIONS_ROOT, 'records')
STATS_CACHE_FILE = os.path.join(INSPECTIONS_ROOT, 'stats_cache.json')
AUDIT_LOG_FILE   = os.path.join(INSPECTIONS_ROOT, 'audit_log.json')
INDEX_DB_FILE    = os.path.join(INSPECTIONS_ROOT, 'index.db')

DEFAULT_TOLERANCES_FILE = os.path.join(CONFIG_DIR, 'tolerances.json')
DEFAULT_PLANS_FILE      = os.path.join(CONFIG_DIR, 'plans.json')
DEFAULT_TEMPLATES_FILE  = os.path.join(CONFIG_DIR, 'report_templates.json')
DEFAULT_INSPECTORS_FILE = os.path.join(CONFIG_DIR, 'feature_inspectors.json')

# Result vocabulary — kept as plain strings so JSON serialisation is
# trivial and so the dashboard can render the same vocabulary the
# pipeline emits.
RESULT_PASS = 'pass'
RESULT_WARN = 'warn'
RESULT_FAIL = 'fail'
RESULT_ERROR = 'error'  # something blew up before we could compute a result


def ensure_dirs() -> None:
    """Create the on-disk hierarchy if it does not already exist.

    Idempotent — safe to call at startup every boot.
    """
    for d in (INSPECTIONS_ROOT, CONFIG_DIR, REFERENCES_DIR, RECORDS_DIR):
        os.makedirs(d, exist_ok=True)


def record_dir_for(timestamp_id: str, t: float | None = None) -> str:
    """Return the YYYY/MM/DD/{id} directory for a given inspection.

    `t` is the unix timestamp (seconds); if omitted the current time is
    used. Caller is responsible for `os.makedirs(..., exist_ok=True)`.
    """
    t = t if t is not None else time.time()
    tm = time.gmtime(t)
    return os.path.join(
        RECORDS_DIR,
        f'{tm.tm_year:04d}',
        f'{tm.tm_mon:02d}',
        f'{tm.tm_mday:02d}',
        timestamp_id,
    )


def new_inspection_id() -> str:
    """Sortable, unique inspection id: `YYYYMMDDTHHMMSS-<6hex>`.

    The 6-hex suffix is enough collision resistance for human-scale
    inspection rates (one robot does < 1 inspection / second).
    """
    tm = time.gmtime()
    return (f'{tm.tm_year:04d}{tm.tm_mon:02d}{tm.tm_mday:02d}'
            f'T{tm.tm_hour:02d}{tm.tm_min:02d}{tm.tm_sec:02d}'
            f'-{uuid.uuid4().hex[:6]}')


def file_sha256(path: str) -> str | None:
    """SHA-256 of a file, or None if the file is missing.

    Used for reference traceability (PDF report cites the hash so an
    auditor can prove which reference was used).
    """
    if not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def safe_load_json(path: str, default: Any) -> Any:
    """Read JSON if present, return `default` otherwise.

    Corruption (truncated file, invalid JSON) is logged-and-skipped — the
    caller gets `default` so the pipeline keeps moving instead of
    crashing on disk damage.
    """
    if not os.path.isfile(path):
        return default
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def safe_dump_json(path: str, data: Any) -> None:
    """Atomic JSON write: write to <path>.tmp then rename.

    Prevents the readers from seeing a half-written file if the writer
    crashes mid-write.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2, sort_keys=False)
    os.replace(tmp, path)


def severity_from_deviation(deviation_mm: float,
                            tol_warn_mm: float,
                            tol_fail_mm: float) -> str:
    """Classify a single signed deviation against a warn/fail threshold.

    Operates on the magnitude — sign is preserved upstream but the
    severity bands are symmetric.
    """
    d = abs(deviation_mm)
    if d >= tol_fail_mm:
        return RESULT_FAIL
    if d >= tol_warn_mm:
        return RESULT_WARN
    return RESULT_PASS


def worst_severity(items: Iterable[str]) -> str:
    """Roll up many per-measurement severities into one overall result.

    fail beats warn beats pass. Empty input is treated as pass — an
    inspection with no measurements never fails.
    """
    have_warn = False
    for s in items:
        if s == RESULT_FAIL:
            return RESULT_FAIL
        if s == RESULT_WARN:
            have_warn = True
    return RESULT_WARN if have_warn else RESULT_PASS


@dataclass
class Measurement:
    """One scalar measurement against one tolerance.

    Stored verbatim in the inspection record's measurements.json and
    rendered into the PDF report's measurements table.
    """
    name: str
    category: str                  # 'dimensional' / 'surface' / 'feature'
    nominal: float | None          # expected value (may be None for free
                                   # measurements like "max deviation")
    measured: float                # observed value
    units: str                     # 'mm' / 'deg' / 'mm^3' / ...
    tolerance_warn: float | None   # +/- warn threshold (None = info only)
    tolerance_fail: float | None   # +/- fail threshold
    result: str                    # 'pass' / 'warn' / 'fail'
    deviation: float | None = None # measured - nominal (signed)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DefectRegion:
    """One localized surface defect found during a tier-2 inspection."""
    defect_id: str
    defect_type: str                                # 'dent', 'bump', ...
    center_xyz: tuple[float, float, float]
    extent_mm: float
    deviation_mm: float                             # signed worst-point dev
    severity: str                                   # pass/warn/fail
    confidence: float                               # 0..1
    point_count: int
    suggested_action: str | None = None
    screenshot_region: tuple[float, float, float, float] | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class InspectionRecord:
    """A complete inspection result, persisted to disk and indexed.

    Mirrors the schema the dashboard list endpoint serves and the PDF
    report consumes. Keep the field names stable — changing them is a
    DB migration.
    """
    inspection_id: str
    part_id: str
    plan_id: str
    timestamp: float
    duration_ms: int
    tier: int
    reference_type: str
    reference_hash: str | None
    overall_result: str
    measurements: list[dict] = field(default_factory=list)
    defects: list[dict] = field(default_factory=list)
    statistics: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)
    files: dict = field(default_factory=dict)        # relative paths

    def to_dict(self) -> dict:
        return asdict(self)

    def summary(self) -> dict:
        """Slim dict for the history list / SQLite index."""
        stats = self.statistics or {}
        return {
            'inspection_id':  self.inspection_id,
            'part_id':        self.part_id,
            'plan_id':        self.plan_id,
            'timestamp':      self.timestamp,
            'tier':           self.tier,
            'result':         self.overall_result,
            'max_deviation':  stats.get('max'),
            'mean_deviation': stats.get('mean'),
            'duration_ms':    self.duration_ms,
        }

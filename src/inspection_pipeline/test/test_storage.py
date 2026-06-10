"""Storage / index database round-trip tests.

Uses tmp_path to avoid touching the production /opt/cobot/inspections
tree during CI.
"""

import os
import sqlite3
import time

import pytest

from inspection_pipeline import statistics_aggregator as sa
from inspection_pipeline import utils


@pytest.fixture
def tmp_inspection_root(tmp_path, monkeypatch):
    """Redirect every storage path into a tmp_path for isolated testing."""
    root = tmp_path / 'inspections'
    monkeypatch.setattr(utils, 'INSPECTIONS_ROOT', str(root))
    monkeypatch.setattr(utils, 'CONFIG_DIR',       str(root / 'config'))
    monkeypatch.setattr(utils, 'REFERENCES_DIR',   str(root / 'references'))
    monkeypatch.setattr(utils, 'RECORDS_DIR',      str(root / 'records'))
    monkeypatch.setattr(utils, 'STATS_CACHE_FILE', str(root / 'stats.json'))
    monkeypatch.setattr(utils, 'INDEX_DB_FILE',    str(root / 'index.db'))
    monkeypatch.setattr(sa,    'INDEX_DB_FILE',    str(root / 'index.db'))
    monkeypatch.setattr(sa,    'STATS_CACHE_FILE', str(root / 'stats.json'))
    utils.ensure_dirs()
    return root


def test_ensure_dirs_creates_layout(tmp_inspection_root):
    for d in ('config', 'references', 'records'):
        assert (tmp_inspection_root / d).is_dir()


def test_safe_dump_load_roundtrip(tmp_inspection_root):
    path = tmp_inspection_root / 'rules.json'
    utils.safe_dump_json(str(path), {'a': 1, 'b': [2, 3]})
    assert utils.safe_load_json(str(path), None) == {'a': 1, 'b': [2, 3]}


def test_safe_load_returns_default_on_corruption(tmp_inspection_root):
    path = tmp_inspection_root / 'bad.json'
    path.write_text('{ not json')
    assert utils.safe_load_json(str(path), {'fallback': True}) == {'fallback': True}


def test_severity_thresholds():
    assert utils.severity_from_deviation(0.05, 0.1, 0.3) == 'pass'
    assert utils.severity_from_deviation(0.2,  0.1, 0.3) == 'warn'
    assert utils.severity_from_deviation(0.4,  0.1, 0.3) == 'fail'


def test_worst_severity():
    assert utils.worst_severity(['pass', 'warn', 'pass']) == 'warn'
    assert utils.worst_severity(['pass', 'fail', 'warn']) == 'fail'
    assert utils.worst_severity([]) == 'pass'


def test_new_inspection_id_unique():
    a = utils.new_inspection_id()
    b = utils.new_inspection_id()
    assert a != b
    assert len(a) > 15


def test_statistics_rebuild_empty(tmp_inspection_root):
    cache = sa.rebuild_from_index()
    assert cache['global']['total_inspections'] == 0


def test_statistics_rebuild_with_records(tmp_inspection_root):
    # Seed the index with three synthetic records.
    conn = sqlite3.connect(utils.INDEX_DB_FILE)
    conn.execute(
        'CREATE TABLE inspections ('
        'inspection_id TEXT PRIMARY KEY, '
        'part_id TEXT, plan_id TEXT, '
        'timestamp REAL, tier INTEGER, result TEXT, '
        'max_deviation REAL, mean_deviation REAL, '
        'duration_ms INTEGER, file_path TEXT)')
    now = time.time()
    conn.executemany(
        'INSERT INTO inspections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            ('a', 'p1', 'd', now,     1, 'pass', 0.1, 0.05, 100, '/x'),
            ('b', 'p1', 'd', now-10,  1, 'fail', 0.6, 0.3,  120, '/y'),
            ('c', 'p2', 'd', now-100, 2, 'pass', 0.1, 0.05, 200, '/z'),
        ])
    conn.commit()
    conn.close()

    cache = sa.rebuild_from_index()
    assert cache['global']['total_inspections'] == 3
    p1 = cache['per_part']['p1']
    assert p1['total']['all'] == 2
    assert p1['pass_count']['all'] == 1
    assert p1['fail_count']['all'] == 1
    assert p1['pass_rate']['all'] == 0.5

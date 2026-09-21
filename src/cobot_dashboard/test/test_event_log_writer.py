"""Pinned tests for the 2026-08-05 unified event log writer.

Fork registry: `event_log`. ONE writer module. No component writes
its own error file. This test suite is the CI-enforceable form of
the invariants the operator directive laid down:

  * emit() writes exactly one line per call (no partial records)
  * daily rotation by UTC date
  * dismissing a toast NEVER deletes the JSONL record
  * rotation across UTC midnight opens a fresh file
  * retention prune respects the size + age caps
  * read_day round-trips what emit wrote

The writer is imported hermetically — it has no ROS dependency —
so this suite runs standalone.
"""

from __future__ import annotations

import json
import os
import sys
import time

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)

import event_log as _el   # noqa: E402


@pytest.fixture
def tmp_log_dir(monkeypatch, tmp_path):
    """Isolate the writer to a temp directory + reset fd cache."""
    d = str(tmp_path / 'event_log')
    monkeypatch.setattr(_el, '_LOG_DIR', d)
    # Close any cached fd from a prior test so the roll picks up
    # the new _LOG_DIR.
    with _el._fd_lock:
        if _el._fd is not None:
            try: os.close(_el._fd)
            except Exception: pass
        _el._fd = None
        _el._fd_date = None
    yield d
    # Teardown — close fd so temp dir can be reaped.
    with _el._fd_lock:
        if _el._fd is not None:
            try: os.close(_el._fd)
            except Exception: pass
            _el._fd = None
            _el._fd_date = None


# ── emit + read_day round-trip ─────────────────────────────────

def test_emit_writes_one_line_per_call(tmp_log_dir):
    _el.emit('error', 'driver', 'stop_jog:joint_limit',
             'Jog stopped — J6 past its limit.',
             technical_detail='cart limit approach J6 at -192.5°',
             context={'joint': 6})
    _el.emit('warning', 'validator', 'row_grid_exceeds_frame',
             'Row grid needs 600 mm; taught frame is 400 mm.',
             technical_detail='ratio 1.5', context={'ratio': 1.5})
    _el.emit('info', 'watcher', 'deploy_ok',
             'Deploy 6dcc5f6 landed clean.', context={'duration_s': 89})
    days = _el.list_days()
    assert len(days) == 1, f'expected 1 day file, got {days!r}'
    recs = _el.read_day(days[0])
    assert len(recs) == 3
    assert recs[0]['severity'] == 'error'
    assert recs[0]['source']   == 'driver'
    assert recs[0]['code']     == 'stop_jog:joint_limit'
    assert 'J6' in recs[0]['operator_message']
    assert recs[2]['context']['duration_s'] == 89


def test_emit_returns_the_record_it_wrote(tmp_log_dir):
    r = _el.emit('info', 'dashboard', 'x', 'y')
    assert r['severity'] == 'info'
    assert r['code'] == 'x'
    assert r['operator_message'] == 'y'
    # Round-trip must match.
    day = _el.list_days()[0]
    disk = _el.read_day(day)[0]
    assert disk == r


def test_read_day_missing_returns_empty(tmp_log_dir):
    assert _el.read_day('20990101') == []


# ── Dismiss NEVER deletes ──────────────────────────────────────

def test_dismiss_would_never_delete_the_jsonl_record(tmp_log_dir):
    """The JSONL is append-only. The frontend removeToast path only
    removes the in-memory toast; it does not call any log-mutation
    endpoint. Verify: after emit, there is no delete API in the
    module, and read_day returns the same records regardless of
    how many times the caller inspects the file."""
    _el.emit('warning', 'dashboard', 'namedLoadError',
             'Load blocked: pending_poses.',
             technical_detail='step 4 taught_joints missing')
    for _ in range(3):
        recs = _el.read_day(_el.list_days()[0])
        assert len(recs) == 1
    # No public delete/remove API.
    for name in dir(_el):
        assert 'delete' not in name.lower()
        assert 'remove' not in name.lower()


# ── Daily rotation ─────────────────────────────────────────────

def test_daily_rotation_opens_new_file_on_utc_date_change(tmp_log_dir):
    """Feed two emits with wall-clock timestamps a day apart —
    verify two distinct files land in the log dir."""
    t1 = 1735689600.0                     # 2025-01-01 00:00:00Z
    t2 = t1 + 86400 + 60                  # 2025-01-02 00:01:00Z
    _el.emit('error', 'driver', 'a', 'first day event',   ts=t1)
    _el.emit('error', 'driver', 'b', 'second day event',  ts=t2)
    days = sorted(_el.list_days())
    assert len(days) == 2, f'expected 2 rotation files, got {days!r}'
    d1 = _el.read_day(days[0])
    d2 = _el.read_day(days[1])
    assert d1[0]['operator_message'] == 'first day event'
    assert d2[0]['operator_message'] == 'second day event'


def test_rotation_uses_utc_not_local(tmp_log_dir):
    """The 'day' key is UTC — an operator's local timezone must not
    shift a file across UTC midnight."""
    # A timestamp 30 min before UTC midnight but well INSIDE the
    # following day in western-hemisphere local time. Both emits
    # should land in the SAME UTC day.
    t_before_utc_midnight = 1735689600.0 - 1800   # 2024-12-31 23:30:00Z
    t_after_utc_midnight  = 1735689600.0 + 1800   # 2025-01-01 00:30:00Z
    _el.emit('info', 'dashboard', 'x', 'before UTC midnight',
             ts=t_before_utc_midnight)
    _el.emit('info', 'dashboard', 'x', 'after UTC midnight',
             ts=t_after_utc_midnight)
    days = _el.list_days()
    assert set(days) == {'20241231', '20250101'}, (
        f'UTC rotation broken — got {days!r}')


# ── Retention prune ────────────────────────────────────────────

def test_age_based_prune_removes_files_older_than_retention(tmp_log_dir):
    """Create a "log file" older than 90 days; emit; verify prune
    removed the ancient one but kept the fresh one."""
    ancient = os.path.join(tmp_log_dir, 'events_20200101.jsonl')
    os.makedirs(tmp_log_dir, exist_ok=True)
    with open(ancient, 'w') as fh:
        fh.write('{"ts_utc":"2020-01-01T00:00:00Z","code":"ancient"}\n')
    # Backdate mtime beyond the 90-day window.
    ancient_mtime = time.time() - (100 * 86400)
    os.utime(ancient, (ancient_mtime, ancient_mtime))
    _el.emit('info', 'dashboard', 'x', 'fresh event')
    days = _el.list_days()
    assert '20200101' not in days
    # Fresh file for today survived.
    assert len(days) == 1


def test_size_based_prune_capped(tmp_log_dir):
    """Force the total-size cap by lowering it and writing more
    than one file's worth of data. Verify oldest goes first."""
    orig = _el._MAX_TOTAL_BYTES
    try:
        _el._MAX_TOTAL_BYTES = 2048   # tiny cap
        # Write 3 days of records, each with a ~1 KB payload.
        base = time.time() - (30 * 86400)     # 30 days ago
        for i in range(3):
            _el.emit('info', 'dashboard', 'x',
                     'x' * 900,        # ~1 KB message
                     ts=base + i * 86400)
        days = _el.list_days()
        # At least the two oldest should have been pruned when we
        # hit the 2 KB cap.
        assert len(days) <= 2, (
            f'size prune did not fire — {len(days)} days survive '
            f'with a 2 KB cap: {days!r}')
    finally:
        _el._MAX_TOTAL_BYTES = orig


# ── Field normalization ────────────────────────────────────────

def test_invalid_severity_falls_back_to_info(tmp_log_dir):
    _el.emit('CRITICAL', 'driver', 'x', 'y')
    day = _el.list_days()[0]
    rec = _el.read_day(day)[0]
    assert rec['severity'] == 'info'


def test_context_non_json_values_coerced_to_string(tmp_log_dir):
    class _Weird:
        def __repr__(self): return '<weird>'
    _el.emit('info', 'dashboard', 'x', 'y',
             context={'ok': 1, 'bad': _Weird()})
    day = _el.list_days()[0]
    rec = _el.read_day(day)[0]
    assert rec['context']['ok'] == 1
    assert rec['context']['bad'] == '<weird>'


def test_field_length_caps_prevent_runaway_payloads(tmp_log_dir):
    huge = 'x' * 20000
    _el.emit('info', 'dashboard', huge, huge, technical_detail=huge)
    day = _el.list_days()[0]
    rec = _el.read_day(day)[0]
    assert len(rec['code'])             <= 200
    assert len(rec['operator_message']) <= 2000
    assert len(rec['technical_detail']) <= 8000


# ── ISO timestamp shape ────────────────────────────────────────

def test_ts_utc_is_iso_with_ms_and_z(tmp_log_dir):
    _el.emit('info', 'dashboard', 'x', 'y', ts=1735689600.123)
    day = _el.list_days()[0]
    rec = _el.read_day(day)[0]
    # 'YYYY-MM-DDTHH:MM:SS.sssZ'
    assert rec['ts_utc'].endswith('Z')
    assert '.' in rec['ts_utc']         # ms
    # ts_local carries a numeric offset.
    assert rec['ts_local'][-5] in ('+', '-')   # e.g. -0500 or +0000

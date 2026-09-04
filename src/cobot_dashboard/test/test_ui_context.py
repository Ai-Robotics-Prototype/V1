"""Pinned tests for the 2026-08-05 per-device UI context store.

Fork registry: page_context_persistence. The store must:
  * Round-trip get/set on a valid device_id
  * Reject invalid device_id (traversal, empty, malformed)
  * Prune oldest entries beyond _MAX_DEVICES
  * Degrade gracefully on OSError (ENOSPC etc.) — never crash
    the caller, return None or the pre-write dict
  * Reject non-whitelisted patch fields silently
"""

from __future__ import annotations

import os
import sys
import time

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)

import ui_context   # noqa: E402


@pytest.fixture
def tmp_dir(monkeypatch, tmp_path):
    d = str(tmp_path / 'ui_context')
    monkeypatch.setattr(ui_context, '_UI_DIR', d)
    yield d


def test_round_trip_get_set(tmp_dir):
    r = ui_context.set('dev-abc', {'open_program_id': 'prog1',
                                    'active_tab': 'program'})
    assert r is not None
    assert r['open_program_id'] == 'prog1'
    assert r['active_tab']      == 'program'
    got = ui_context.get('dev-abc')
    assert got['open_program_id'] == 'prog1'
    assert got['active_tab']      == 'program'
    assert 'updated_ts' in got


def test_get_missing_returns_none(tmp_dir):
    assert ui_context.get('never-existed') is None


def test_invalid_device_id_rejected(tmp_dir):
    for bad in ('', '..', '../etc/passwd', 'a/b', 'a\x00b', 'xy',
                'a' * 200, 'has space'):
        assert ui_context.set(bad, {'open_program_id': 'x'}) is None
        assert ui_context.get(bad) is None


def test_non_whitelisted_fields_dropped(tmp_dir):
    r = ui_context.set('dev-1', {
        'open_program_id': 'p',
        'active_tab':      'program',
        'device_label':    'Shop Tablet',
        'secret_admin':    True,
        '__proto__':       'nope',
    })
    assert 'secret_admin' not in r
    assert '__proto__' not in r
    assert r['open_program_id'] == 'p'
    assert r['device_label']    == 'Shop Tablet'


def test_device_label_round_trip(tmp_dir):
    """2026-08-05 (identity root-cause fix): device_label is a
    whitelisted, first-class field alongside open_program_id/
    active_tab. Banners and event-log entries read from here."""
    r = ui_context.set('dev-label', {'device_label': 'Office PC'})
    assert r['device_label'] == 'Office PC'
    r2 = ui_context.set('dev-label', {'device_label': 'Shop Tablet'})
    assert r2['device_label'] == 'Shop Tablet'
    # None clears.
    r3 = ui_context.set('dev-label', {'device_label': None})
    assert 'device_label' not in r3


def test_null_field_clears(tmp_dir):
    ui_context.set('dev-2', {'open_program_id': 'p1'})
    r = ui_context.set('dev-2', {'open_program_id': None})
    assert 'open_program_id' not in r


def test_merge_semantics(tmp_dir):
    """set() merges into existing; missing fields preserved."""
    ui_context.set('dev-3', {'open_program_id': 'p', 'active_tab': 'program'})
    r = ui_context.set('dev-3', {'active_tab': 'monitor'})
    assert r['open_program_id'] == 'p'
    assert r['active_tab']      == 'monitor'


def test_prune_caps_at_max_devices(tmp_dir, monkeypatch):
    monkeypatch.setattr(ui_context, '_MAX_DEVICES', 3)
    for i in range(5):
        ui_context.set(f'dev-{i}', {'open_program_id': f'p{i}'})
        time.sleep(0.02)   # ensure distinct mtimes
    # Only 3 most-recent survive.
    surviving = sorted(os.listdir(tmp_dir))
    assert len(surviving) == 3
    # Oldest (dev-0, dev-1) pruned; dev-2..dev-4 remain.
    remaining = {name[:-len('.json')] for name in surviving}
    assert remaining == {'dev-2', 'dev-3', 'dev-4'}


def test_clear_removes_file(tmp_dir):
    ui_context.set('dev-c', {'open_program_id': 'x'})
    assert ui_context.get('dev-c') is not None
    ui_context.clear('dev-c')
    assert ui_context.get('dev-c') is None
    ui_context.clear('dev-c')   # idempotent


def test_list_all_returns_newest_first(tmp_dir):
    ui_context.set('dev-old', {'open_program_id': 'p-old'})
    time.sleep(0.02)
    ui_context.set('dev-new', {'open_program_id': 'p-new'})
    lst = ui_context.list_all()
    assert lst[0]['_device_id'] == 'dev-new'
    assert lst[1]['_device_id'] == 'dev-old'

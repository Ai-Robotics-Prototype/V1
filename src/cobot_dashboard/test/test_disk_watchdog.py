"""Pinned tests for disk_watchdog — 2026-08-05.

Fork registry: `disk_watchdog`. The module must:
  * Correctly classify free-space levels ok/warn/critical/dead
    against the published thresholds
  * Refuse non-critical writers at CRITICAL, refuse ALL writers
    at DEAD, permit at OK/WARN
  * Prune oldest-first when a directory total exceeds the cap
  * Never crash on filesystem errors (statvfs, listdir, remove)
  * status() returns the shape /api/disk_status promises to the
    footer widget
"""

from __future__ import annotations

import os
import sys
import time

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)

import disk_watchdog as dw   # noqa: E402


# ── level() classification ──────────────────────────────────────────

def test_level_ok(monkeypatch):
    monkeypatch.setattr(dw, 'free_bytes', lambda: dw.WARN_BYTES * 2)
    assert dw.level() == 'ok'


def test_level_warn(monkeypatch):
    monkeypatch.setattr(dw, 'free_bytes', lambda: dw.WARN_BYTES - 1)
    assert dw.level() == 'warn'


def test_level_critical(monkeypatch):
    monkeypatch.setattr(dw, 'free_bytes', lambda: dw.CRITICAL_BYTES - 1)
    assert dw.level() == 'critical'


def test_level_dead(monkeypatch):
    monkeypatch.setattr(dw, 'free_bytes', lambda: dw.DEAD_BYTES - 1)
    assert dw.level() == 'dead'


# ── should_write() gate ─────────────────────────────────────────────

def test_should_write_ok_admits_all(monkeypatch):
    monkeypatch.setattr(dw, 'level', lambda: 'ok')
    assert dw.should_write('critical')     is True
    assert dw.should_write('non-critical') is True


def test_should_write_warn_admits_all(monkeypatch):
    monkeypatch.setattr(dw, 'level', lambda: 'warn')
    assert dw.should_write('critical')     is True
    assert dw.should_write('non-critical') is True


def test_should_write_critical_drops_noncritical(monkeypatch):
    monkeypatch.setattr(dw, 'level', lambda: 'critical')
    assert dw.should_write('critical')     is True
    assert dw.should_write('non-critical') is False


def test_should_write_dead_drops_all(monkeypatch):
    monkeypatch.setattr(dw, 'level', lambda: 'dead')
    assert dw.should_write('critical')     is False
    assert dw.should_write('non-critical') is False


# ── prune ──────────────────────────────────────────────────────────

def test_prune_oldest_first(tmp_path):
    d = tmp_path / 'logs'
    d.mkdir()
    files = []
    for i in range(5):
        fp = d / f'log-{i}.txt'
        fp.write_bytes(b'x' * 100)   # 100 B each → 500 B total
        # Stagger mtimes so oldest is unambiguous.
        os.utime(fp, (time.time() - (5 - i) * 10,
                      time.time() - (5 - i) * 10))
        files.append(fp)
    # Cap at 250 B — should keep the ~3 newest (some slack).
    freed = dw._prune_dir(str(d), 250)
    assert freed >= 200
    remaining = sorted(os.listdir(d))
    # The very newest files must survive.
    assert 'log-4.txt' in remaining
    assert 'log-3.txt' in remaining
    # The very oldest must be gone.
    assert 'log-0.txt' not in remaining


def test_prune_missing_dir_is_silent(tmp_path):
    """Non-existent path must not crash."""
    freed = dw._prune_dir(str(tmp_path / 'nope'), 1000)
    assert freed == 0


def test_prune_under_cap_is_noop(tmp_path):
    d = tmp_path / 'logs'
    d.mkdir()
    (d / 'a.txt').write_bytes(b'x' * 50)
    (d / 'b.txt').write_bytes(b'x' * 50)
    before = set(os.listdir(d))
    freed = dw._prune_dir(str(d), 10_000)
    after = set(os.listdir(d))
    assert freed == 0
    assert before == after


# ── enforce_all + status ────────────────────────────────────────────

def test_enforce_all_returns_shape(tmp_path, monkeypatch):
    """enforce_all() surveys every capped dir and returns a
    per-path result dict for logging."""
    fake = {
        str(tmp_path / 'a'): 1_000,
        str(tmp_path / 'b'): 500,
    }
    monkeypatch.setattr(dw, 'DIR_CAPS', fake)
    for p in fake:
        os.makedirs(p, exist_ok=True)
    out = dw.enforce_all()
    for p in fake:
        assert p in out
        assert 'before' in out[p]
        assert 'after'  in out[p]
        assert 'freed_bytes' in out[p]
        assert 'cap' in out[p]


def test_status_shape(monkeypatch):
    monkeypatch.setattr(dw, 'free_bytes', lambda: 10 * 1024 ** 3)
    s = dw.status()
    assert set(s.keys()) >= {'free_bytes', 'free_human', 'level',
                             'thresholds', 'dirs', 'ts'}
    assert s['level'] == 'ok'
    assert isinstance(s['dirs'], list)
    for d in s['dirs']:
        assert set(d.keys()) >= {'path', 'size_bytes', 'size_human',
                                 'cap_bytes', 'cap_human'}


def test_free_bytes_survives_missing_root(monkeypatch):
    """statvfs on a missing path must fall back to a huge value
    (fail-open) so the watchdog can't block writes on its own
    error."""
    monkeypatch.setattr(dw, 'COBOT_ROOT', '/definitely/not/a/path')
    monkeypatch.setattr(os.path, 'isdir', lambda p: False)
    b = dw.free_bytes()
    assert b > 0   # non-zero fallback


def test_human_formatter():
    assert dw._human(0) == '0 B'
    assert dw._human(500) == '500 B'
    assert dw._human(2048).endswith('KB')
    assert dw._human(5 * 1024 ** 2).endswith('MB')
    assert dw._human(3 * 1024 ** 3).endswith('GB')

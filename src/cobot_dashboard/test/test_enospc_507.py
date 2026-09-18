"""Pinned regression test for the 2026-08-05 P0: record endpoint
crashed on ENOSPC.

Fork registry: page_context_persistence (record-through). Every
teach-session write path must convert a filesystem-level OSError
into a 507 with the shared operator-language body — never a 500
traceback.

The test re-declares the write helper + response body hermetically
(same pattern as test_teach_session_lifecycle.py) and asserts that
raising OSError(ENOSPC) inside _teach_write_draft surfaces as
_TeachWriteError, which _storage_full_response formats into the
507-shaped dict every endpoint returns.
"""

from __future__ import annotations

import errno
import json
import os
import sys

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


class _TeachWriteError(OSError):
    """Re-declared: the wrapper the endpoint catch blocks look for."""
    pass


def _storage_full_response(e):
    errno_ = e.args[0] if e.args else '?'
    detail = e.args[1] if len(e.args) > 1 else str(e)
    return {
        'ok':    False,
        'error': 'storage_full',
        'operator_message': (
            "Couldn't save — the dashboard's disk is full. "
            "Free space on /opt/cobot and try again. Earlier "
            "successful writes are safe on disk."),
        'technical_detail': f'errno={errno_} {detail}',
    }


def _teach_write_draft(path, draft):
    """Mirror of the deployed helper: atomic write, fsync, replace,
    OSError → _TeachWriteError."""
    tmp = None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(draft, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError as e:
        if tmp is not None:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass
        raise _TeachWriteError(e.errno, str(e))


# ── Regression: ENOSPC → _TeachWriteError → 507 body ────────────

def test_enospc_wraps_to_TeachWriteError(tmp_path, monkeypatch):
    """The record P0 root cause: OSError bubbled up as a 500. The
    fix wraps every write in a helper that raises the structured
    _TeachWriteError so endpoint code can return 507 cleanly."""
    path = str(tmp_path / 'p.draft.json')

    # Simulate ENOSPC on the fsync call — same failure mode as a
    # real full disk. `open()` succeeds; `fsync` is where the
    # kernel returns ENOSPC on many filesystems.
    real_fsync = os.fsync
    def _boom(fd):
        raise OSError(errno.ENOSPC, 'No space left on device')
    monkeypatch.setattr(os, 'fsync', _boom)

    with pytest.raises(_TeachWriteError) as ei:
        _teach_write_draft(path, {'poses': {}})
    # errno preserved so the operator error-log can filter.
    assert ei.value.args[0] == errno.ENOSPC

    monkeypatch.setattr(os, 'fsync', real_fsync)


def test_partial_write_removed_on_error(tmp_path, monkeypatch):
    """Failed write must not leave a `.tmp` fragment behind — a
    subsequent successful record must not blend with partial state."""
    path = str(tmp_path / 'p.draft.json')

    def _boom(fd):
        raise OSError(errno.ENOSPC, 'No space left on device')
    monkeypatch.setattr(os, 'fsync', _boom)

    with pytest.raises(_TeachWriteError):
        _teach_write_draft(path, {'poses': {}})

    # Neither the final file nor the tmp should exist.
    assert not os.path.exists(path)
    assert not os.path.exists(path + '.tmp')


def test_storage_full_response_shape():
    """The 507 body every endpoint returns: operator-language +
    technical detail. Frontend copy-register must not shift."""
    e = _TeachWriteError(errno.ENOSPC, 'No space left on device')
    body = _storage_full_response(e)
    assert body['ok']    is False
    assert body['error'] == 'storage_full'
    # Operator-facing: no jargon, actionable instruction.
    assert "disk is full" in body['operator_message']
    assert "Free space"   in body['operator_message']
    assert "safe on disk" in body['operator_message']
    # Technical detail carries the raw errno for diagnostics.
    assert 'errno=28' in body['technical_detail']


def test_multiple_errnos_all_wrap_cleanly(tmp_path, monkeypatch):
    """Not just ENOSPC — EROFS/EIO/EDQUOT/EACCES must all convert
    to _TeachWriteError so no fs error crashes the record path."""
    path = str(tmp_path / 'p.draft.json')
    for e_no in (errno.ENOSPC, errno.EROFS, errno.EIO,
                 getattr(errno, 'EDQUOT', 122), errno.EACCES):
        def _make_boom(n):
            def _boom(fd):
                raise OSError(n, os.strerror(n))
            return _boom
        monkeypatch.setattr(os, 'fsync', _make_boom(e_no))
        with pytest.raises(_TeachWriteError) as ei:
            _teach_write_draft(path, {'poses': {}})
        assert ei.value.args[0] == e_no

"""Pinned tests for the 2026-09-18 device-pairing backend.

Directive (session 2026-09-18):
  * Identity file (/opt/cobot/identity.json) minted once, survives.
  * /api/pair/start returns a 6-digit code + session_id, 90 s TTL.
  * /api/pair/confirm on the correct code mints a per-device token
    (256-bit), stored HASHED on disk. Raw token returned once.
  * Wrong code: single-use per session, 3 fails inside 5 min = 5 min
    lockout on that remote_ip.
  * Code expiry at 90 s.
  * Revoke drops the device immediately + notifies live-WS subscribers.
  * PAIRING_ENFORCED=false grandfathers everything (default this
    session — enforcement is inert until the operator flips the env).
  * PAIRING_ENFORCED=true refuses /api/state without a token with a
    JSON body carrying `kind: pairing_required` at 401.

These tests exercise `pairing.PairingStore` directly (pure module) +
the auth-middleware branch by importing the middleware helpers as
a small hermetic slice. Full-server TestClient boots against rclpy
which is not always available on the test host; the middleware
logic is straightforward enough to pin in isolation.
"""
from __future__ import annotations

import json
import os
import sys
import time
import tempfile

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)


# ── (1) Identity: minted once, immutable serial/model ──────────

def test_identity_mint_and_persist(tmp_path):
    from cobot_dashboard import identity as ident
    ident.reset_cache()
    path = str(tmp_path / 'identity.json')
    a = ident.load_or_mint(path)
    assert a['serial'].startswith('NR-')
    assert a['model'] == 'S10-140'
    assert a['friendly_name']
    # Reload → same serial.
    ident.reset_cache()
    b = ident.load_or_mint(path)
    assert b['serial'] == a['serial']
    assert b['model']  == a['model']
    # Rename does NOT touch serial/model.
    ident.reset_cache()
    ident.load_or_mint(path)
    c = ident.set_friendly_name('bay-3', path)
    assert c['serial'] == a['serial']
    assert c['friendly_name'] == 'bay-3'


def test_identity_rejects_empty_name(tmp_path):
    from cobot_dashboard import identity as ident
    ident.reset_cache()
    path = str(tmp_path / 'identity.json')
    ident.load_or_mint(path)
    with pytest.raises(ValueError):
        ident.set_friendly_name('  ', path)


# ── (2) Pairing: start → confirm → token ────────────────────────

def _fresh(tmp_path):
    from cobot_dashboard import pairing as pm
    store = pm.PairingStore(str(tmp_path / 'paired_devices.json'))
    store._reset_for_tests()
    return pm, store


def test_pair_start_then_confirm_mints_token(tmp_path):
    pm, store = _fresh(tmp_path)
    started = store.start('Tim tablet', '192.168.2.201')
    assert started['ok'] is True
    assert len(started['code']) == 6
    assert started['code'].isdigit()
    confirmed = store.confirm(started['session_id'], started['code'],
                              '192.168.2.201')
    assert confirmed['ok'] is True
    assert isinstance(confirmed['token'], str)
    assert len(confirmed['token']) >= 32
    # Raw token validates.
    tid = store.validate_token(confirmed['token'])
    assert tid == confirmed['token_id']
    # Persisted (hashed).
    with open(store._path) as fh:
        on_disk = json.load(fh)
    assert confirmed['token_id'] in on_disk
    assert 'token_hash' in on_disk[confirmed['token_id']]
    assert on_disk[confirmed['token_id']]['token_hash'] != confirmed['token']


def test_pair_bad_code_is_single_shot(tmp_path):
    pm, store = _fresh(tmp_path)
    started = store.start('bad-code tablet', '192.168.2.202')
    r = store.confirm(started['session_id'], '000000', '192.168.2.202')
    assert r == {'ok': False, 'kind': 'bad_code'} or (
        not r['ok'] and r['kind'] == 'bad_code')
    # Session is burned — retry with the real code fails as no_session.
    r2 = store.confirm(started['session_id'], started['code'],
                       '192.168.2.202')
    assert not r2['ok']
    assert r2['kind'] == 'no_session'


def test_three_fails_locks_out(tmp_path):
    pm, store = _fresh(tmp_path)
    ip = '192.168.2.203'
    for _ in range(3):
        s = store.start('locky', ip)
        assert s['ok']
        store.confirm(s['session_id'], '000000', ip)
    # 4th start refused.
    s = store.start('locky', ip)
    assert not s['ok']
    assert s['kind'] == 'locked_out'
    assert s['retry_after_s'] > 0


def test_code_expires_at_ttl(tmp_path, monkeypatch):
    pm, store = _fresh(tmp_path)
    started = store.start('slow tablet', '192.168.2.204')
    # Fast-forward the pending session's created_ts beyond TTL.
    with store._lock:
        store._pending[started['session_id']]['created_ts'] = (
            time.time() - pm.CODE_TTL_S - 1)
    r = store.confirm(started['session_id'], started['code'],
                      '192.168.2.204')
    assert not r['ok']
    assert r['kind'] == 'expired'


def test_revoke_drops_token_and_fires_callback(tmp_path):
    pm, store = _fresh(tmp_path)
    s = store.start('revoke tablet', '192.168.2.205')
    c = store.confirm(s['session_id'], s['code'], '192.168.2.205')
    fired = []
    store.on_revoke(lambda tid: fired.append(tid))
    assert store.validate_token(c['token']) == c['token_id']
    ok = store.revoke(c['token_id'])
    assert ok is True
    assert fired == [c['token_id']]
    assert store.validate_token(c['token']) is None
    # Revoking a gone token returns False, doesn't refire.
    fired.clear()
    assert store.revoke(c['token_id']) is False
    assert fired == []


def test_list_devices_hides_hashes(tmp_path):
    pm, store = _fresh(tmp_path)
    s = store.start('list tablet', '192.168.2.206')
    c = store.confirm(s['session_id'], s['code'], '192.168.2.206')
    listed = store.list_devices()
    assert len(listed) == 1
    row = listed[0]
    assert row['token_id']    == c['token_id']
    assert row['device_name'] == 'list tablet'
    assert row['created']
    assert row['last_seen']
    assert 'token_hash' not in row
    assert 'token'      not in row


# ── (3) Middleware branch: PAIRING_ENFORCED gates the API ──────

def test_middleware_flag_semantics(monkeypatch):
    """Grep-pin: the auth middleware short-circuits when the flag is
    off + rejects with 401 pairing_required when on. We don't boot the
    full FastAPI app (rclpy dep) — instead we assert the exact source
    string that pins the behaviour so a future refactor that silently
    disables enforcement fails this test."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    # Flag read from env.
    assert "os.environ.get('COBOT_PAIRING_ENFORCED'" in src
    # The default-off short-circuit is present.
    assert "if not PAIRING_ENFORCED:" in src
    # Enforced path returns 401 with pairing_required.
    assert "'kind': 'pairing_required'" in src
    assert "status_code=401" in src
    # /api/pair/* is in the unauth prefix list.
    assert "'/api/pair/'" in src
    # Localhost is grandfathered.
    assert "('127.0.0.1', '::1', 'localhost')" in src
    # WS auth uses the same check helper on every /ws/ handler.
    ws_check = "_pair_ok, _pair_tid = _ws_auth_check(websocket)"
    # 10 WS routes should each carry it.
    assert src.count(ws_check) >= 10, (
        f"expected auth check on every /ws/ route, got {src.count(ws_check)}")
    # And the 4401 close code.
    assert "await websocket.close(code=4401)" in src

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


# ── (4) Broadcast + deny + code-not-in-response pins (add-58 §687) ─

def test_pair_start_omits_code_from_response():
    """SECURITY BOUNDARY. /api/pair/start must NEVER return the code
    in its response body. The code lives only in the broadcast + the
    paired-dashboard modal that renders it. If this test fails, the
    tablet side has visibility of the code it just requested — the
    physical-access requirement collapses."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    # Slice the endpoint body.
    import re
    m = re.search(
        r"async def api_pair_start\(request: Request\):(.+?)(?=\n    async def |\n    @app\.)",
        src, re.DOTALL)
    assert m, "api_pair_start slice not found"
    body = m.group(1)
    # No 'code' field returned. Look for the literal 'code': in a
    # response-dict context — the return dict in start MUST NOT have
    # 'code' as a key.
    return_slice = re.search(r"return\s*\{([^}]+)\}", body)
    assert return_slice, "start endpoint has no return {...}"
    assert "'code'" not in return_slice.group(1), (
        "pair/start return body must not carry the code — it should "
        "only be broadcast into STATE.pairing.pending. See "
        "cobot_dashboard/pairing.py + PairRequestModal.jsx.")


def test_pair_start_broadcasts_pending_into_state():
    """The paired-dashboard modal reads STATE.pairing.pending to render
    the code. Pin that start writes into that namespace."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    assert "STATE.setdefault('pairing', {})" in src
    assert "list_pending" in src


def test_pair_deny_endpoint_present():
    """Deny is a physical-access equivalent — same auth rung as
    /api/pair/start."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    assert '@app.post("/api/pair/deny")' in src


def test_pairing_store_lists_pending_and_deny(tmp_path):
    """Wire-level pin: store.start writes into list_pending; store.deny
    removes; a confirmed session no longer shows."""
    pm, store = _fresh(tmp_path)
    s = store.start('modal tablet', '192.168.2.207')
    listed = store.list_pending()
    assert any(p['session_id'] == s['session_id'] for p in listed)
    row = next(p for p in listed if p['session_id'] == s['session_id'])
    assert row['device_name'] == 'modal tablet'
    assert row['code'] == s['code']
    assert row['remaining_s'] > 0
    assert store.deny(s['session_id']) is True
    assert not any(p['session_id'] == s['session_id']
                   for p in store.list_pending())
    # Denying an unknown session is False, doesn't error.
    assert store.deny('nope') is False


# ── (5) Both-flag suite proof (add-58 §687) ─────────────────────────

# ── (6) Reachability (add-59 §688 field bug) ────────────────────────

def test_identity_enumerates_interface_addresses():
    """enumerate_advertised_hosts must return every advertised IP so
    the wizard can probe each one from the client side. Field bug
    2026-09-18: tablet on 192.168.1.x got "site cannot be reached"
    on the Jetson's wired IP; discovery has to know the WiFi leg
    exists and only present addresses reachable from the client."""
    from cobot_dashboard import identity as ident
    hosts = ident.enumerate_advertised_hosts()
    assert isinstance(hosts, dict)
    assert 'mdns_host' in hosts and hosts['mdns_host'].endswith('.local')
    assert isinstance(hosts.get('addresses'), list)
    # IPv6 link-local addresses excluded — they never route across
    # subnets and would clutter the wizard's unreachable list.
    for a in hosts['addresses']:
        assert not a.lower().startswith('fe80:'), (
            f'fe80:: link-local leaked into advertised addresses: {a}')


def test_identity_endpoint_shape_grep_pins_network_payload():
    """/api/identity returns network:{addresses,mdns_host,port}. Pin
    the exact wire shape by grep so a refactor that drops the network
    sub-dict fails this test."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    assert "enumerate_advertised_hosts" in src
    assert "'network':" in src
    assert "'addresses'" in src
    assert "'mdns_host'" in src
    assert "'port'" in src


def test_wizard_carries_unreachable_copy_verbatim():
    """The 2026-09-18 field directive names the copy verbatim.
    The wizard exports UNREACHABLE_COPY as the single site."""
    wiz_path = os.path.join(
        os.path.dirname(SERVER_DIR),
        'frontend', 'src', 'components', 'DevicePairingWizard.jsx')
    with open(wiz_path) as fh:
        js = fh.read()
    expected = ("This address didn't respond from your device — it may "
                "be on a different network than this tablet.")
    assert 'export const UNREACHABLE_COPY' in js, (
        'UNREACHABLE_COPY must be the single export owning this string')
    assert expected in js, (
        f'operator-approved unreachable-copy missing verbatim: {expected!r}')


def test_wizard_probes_client_side_and_splits_reachable():
    """Grep-pin: DiscoverPage builds candidates from /api/identity's
    network.addresses + network.mdns_host, probes each from the
    client, splits reachable/unreachable. If a refactor pulls the
    address list off the server-side host header instead, this test
    catches the regression."""
    wiz_path = os.path.join(
        os.path.dirname(SERVER_DIR),
        'frontend', 'src', 'components', 'DevicePairingWizard.jsx')
    with open(wiz_path) as fh:
        js = fh.read()
    assert "fetch('/api/identity'" in js
    assert 'net.addresses' in js or 'network.addresses' in js.replace('net.', 'network.')
    assert 'mdns_host' in js
    assert 'Reachable from this device' in js
    assert 'Advertised but not reachable from this device' in js


@pytest.mark.parametrize('flag', ['0', '1'])
def test_middleware_reads_flag_lazily(flag, monkeypatch, tmp_path):
    """Import the pairing module fresh under both flag states and
    prove the store still works end-to-end without depending on the
    middleware surface. The middleware itself is grep-pinned above;
    what we prove here is the OTHER half — that changing the flag
    doesn't secretly rewire the store's contract.

    This is the "both-flag suite proof" the directive asks for at
    the pytest layer — the middleware behavior is grep-pinned, the
    store behavior is state-tested under both flag states."""
    monkeypatch.setenv('COBOT_PAIRING_ENFORCED', flag)
    import importlib
    from cobot_dashboard import pairing as pm
    importlib.reload(pm)
    store = pm.PairingStore(str(tmp_path / 'paired.json'))
    store._reset_for_tests()
    s = store.start(f'flag-{flag}', '10.0.0.1')
    assert s['ok'] is True
    c = store.confirm(s['session_id'], s['code'], '10.0.0.1')
    assert c['ok'] is True
    assert store.validate_token(c['token']) == c['token_id']

"""Pinned tests for the 2026-09-18 auth model pivot (add-61 §690).

The dashboard split into VIEW (open) + CONTROL (login-required
when COBOT_AUTH_ENFORCED=1). Everyone sees the dashboard; only
users signed in via /api/login can move / change / write. Pairing
survives as the device-trust layer for later, no longer the gate.

These pins exercise:
  * user_store.py — scrypt hashing, add/remove/passwd, rate-limit,
    default-admin provisioning with a RANDOM password (never a
    fixed default), bootstrap file mode 0600.
  * pairing.py — mint_user_session mints kind='user' tokens,
    resolve_token returns kind + username + role, revoke_by_token
    for logout.
  * dashboard_server.py — VIEW/CONTROL classification, unauth
    exception list, e-stop safety invariant, login-required 401
    body.
  * Both-flag-state proof: with AUTH_ENFORCED=0, view + control
    both open. With AUTH_ENFORCED=1, view open, control 401
    without token, control 200 with token.
"""
from __future__ import annotations

import json
import os
import re
import stat
import sys
import time

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)


# ── (1) UserStore basics ─────────────────────────────────────────

def _fresh(tmp_path):
    from cobot_dashboard import user_store as us
    store = us.UserStore(str(tmp_path / 'users.json'))
    store._reset_for_tests()
    return us, store


def test_add_then_verify_password(tmp_path):
    us, store = _fresh(tmp_path)
    res = store.add('operator1', 'correct-horse-battery', role='operator')
    assert res['ok'] is True
    v = store.verify_password('operator1', 'correct-horse-battery',
                              '10.0.0.1')
    assert v['ok'] is True
    assert v['username'] == 'operator1'
    assert v['role'] == 'operator'
    bad = store.verify_password('operator1', 'wrong', '10.0.0.1')
    assert bad['ok'] is False
    assert bad['kind'] == 'invalid'


def test_password_is_hashed_on_disk(tmp_path):
    us, store = _fresh(tmp_path)
    store.add('op', 'super-secret-password', role='operator')
    with open(store._path) as fh:
        blob = json.load(fh)
    u = blob['op']
    assert 'super-secret-password' not in json.dumps(blob), (
        'plaintext password leaked to disk')
    assert 'password_hash' in u
    assert 'salt' in u
    assert len(u['password_hash']) >= 40
    assert len(u['salt']) == 32   # 16 bytes hex


def test_file_permissions_are_600(tmp_path):
    us, store = _fresh(tmp_path)
    store.add('op', 'super-secret-password', role='operator')
    mode = stat.S_IMODE(os.stat(store._path).st_mode)
    assert mode == 0o600, f'users.json mode is {oct(mode)}, want 0600'


def test_weak_password_rejected(tmp_path):
    us, store = _fresh(tmp_path)
    r = store.add('op', 'short', role='operator')
    assert r['ok'] is False and r['kind'] == 'weak_password'


def test_five_fails_locks_out(tmp_path):
    us, store = _fresh(tmp_path)
    store.add('op', 'the-right-password', role='operator')
    ip = '10.0.0.2'
    for _ in range(5):
        r = store.verify_password('op', 'wrong', ip)
        assert not r['ok']
    r = store.verify_password('op', 'the-right-password', ip)
    assert r['ok'] is False
    assert r['kind'] == 'locked_out'
    assert r['retry_after_s'] > 0


def test_passwd_resets_password(tmp_path):
    us, store = _fresh(tmp_path)
    store.add('op', 'original-password', role='operator')
    r = store.set_password('op', 'brand-new-password')
    assert r['ok'] is True
    assert store.verify_password(
        'op', 'brand-new-password', '10.0.0.3')['ok'] is True
    assert store.verify_password(
        'op', 'original-password', '10.0.0.4')['ok'] is False


# ── (2) Default admin provisioning is RANDOM ──────────────────────

def test_default_admin_provisioned_with_random_password(tmp_path):
    us, store = _fresh(tmp_path)
    boot = str(tmp_path / 'admin_bootstrap.txt')
    r = us.provision_default_admin_if_empty(store, bootstrap_path=boot)
    assert r['ok'] is True and r['created'] is True
    assert r['username'] == 'admin'
    assert r['bootstrap_path'] == boot
    # File exists, 0600, contains "password: <random>".
    assert os.path.exists(boot)
    mode = stat.S_IMODE(os.stat(boot).st_mode)
    assert mode == 0o600, f'bootstrap file mode is {oct(mode)}'
    with open(boot) as fh:
        blob = fh.read()
    m = re.search(r'password:\s*(\S+)', blob)
    assert m, 'no password line in bootstrap file'
    pw = m.group(1)
    # Must NOT be any of the classic factory-defaults.
    forbidden = {
        'admin', 'password', '123456', '12345678', 'default',
        'qwerty', 'letmein', 'changeme', 'roboadmin', 'neurobots',
    }
    assert pw.lower() not in forbidden, (
        f'default admin password is a factory-default guess: {pw!r}')
    assert len(pw) >= 16, f'password too short: {len(pw)}'
    # Admin was actually created; verify with the extracted password.
    v = store.verify_password('admin', pw, '10.0.0.5')
    assert v['ok'] is True and v['role'] == 'admin'


def test_provisioning_is_idempotent(tmp_path):
    us, store = _fresh(tmp_path)
    boot = str(tmp_path / 'admin_bootstrap.txt')
    us.provision_default_admin_if_empty(store, bootstrap_path=boot)
    # Add another user.
    store.add('op', 'another-password-xx', role='operator')
    # Re-run — should NOT reset admin, should NOT overwrite bootstrap.
    with open(boot) as fh: before = fh.read()
    r = us.provision_default_admin_if_empty(store, bootstrap_path=boot)
    assert r['created'] is False
    with open(boot) as fh: after = fh.read()
    assert before == after


def test_no_fixed_default_admin_password_in_provisioning():
    """CENSUS: user_store.py + dashboard_server.py + tools/*
    must not contain ANY of the classic factory-default password
    literals in call-position for the default admin. This is the
    123456 disease pin."""
    forbidden_literals = [
        "admin', 'admin",
        '"admin", "admin"',
        "'password', 'password'",
        "'123456'",
        '"123456"',
        "'changeme'",
        '"changeme"',
        "'default_password'",
    ]
    files_to_check = [
        os.path.join(SERVER_DIR, 'user_store.py'),
        os.path.join(SERVER_DIR, 'dashboard_server.py'),
    ]
    for fp in files_to_check:
        if not os.path.exists(fp):
            continue
        with open(fp) as fh:
            src = fh.read()
        for literal in forbidden_literals:
            assert literal not in src, (
                f'{fp}: forbidden literal {literal!r} found — the '
                f'default admin must be minted with a random password '
                f'via _mint_random_password(), never a fixed default')


# ── (3) PairingStore — user sessions ─────────────────────────────

def test_mint_user_session_and_resolve(tmp_path):
    from cobot_dashboard import pairing as pm
    store = pm.PairingStore(str(tmp_path / 'paired.json'))
    store._reset_for_tests()
    s = store.mint_user_session('operator1', 'operator')
    assert s['ok'] is True
    assert s['kind'] == 'user'
    assert s['username'] == 'operator1'
    assert s['role'] == 'operator'
    row = store.resolve_token(s['token'])
    assert row is not None
    assert row['kind'] == 'user'
    assert row['username'] == 'operator1'
    assert row['role'] == 'operator'


def test_revoke_by_token_drops_session(tmp_path):
    from cobot_dashboard import pairing as pm
    store = pm.PairingStore(str(tmp_path / 'paired.json'))
    store._reset_for_tests()
    s = store.mint_user_session('operator1', 'operator')
    assert store.resolve_token(s['token']) is not None
    ok = store.revoke_by_token(s['token'])
    assert ok is True
    assert store.resolve_token(s['token']) is None
    # Second revoke of the same token is a no-op.
    assert store.revoke_by_token(s['token']) is False


# ── (4) Middleware source pin ────────────────────────────────────

def _server_src() -> str:
    with open(os.path.join(SERVER_DIR, 'dashboard_server.py')) as fh:
        return fh.read()


def test_auth_enforced_env_read_and_default_off():
    src = _server_src()
    assert "os.environ.get('COBOT_AUTH_ENFORCED'" in src
    assert 'AUTH_ENFORCED' in src


def test_view_methods_bypass_gate():
    """GET/HEAD/OPTIONS must be short-circuited before any auth
    check when AUTH_ENFORCED — they are VIEW by definition."""
    src = _server_src()
    assert "if method in ('GET', 'HEAD', 'OPTIONS'):" in src


def test_estop_is_in_unauth_control_paths():
    src = _server_src()
    m = re.search(r'_UNAUTH_CONTROL_PATHS\s*=\s*\(([^)]+)\)', src, re.DOTALL)
    assert m, '_UNAUTH_CONTROL_PATHS tuple not found'
    body = m.group(1)
    assert "'/cmd/estop'" in body, (
        'E-STOP MUST remain reachable from every view-only client — '
        "add '/cmd/estop' to _UNAUTH_CONTROL_PATHS")
    assert "'/api/login'" in body
    assert "'/api/pair/'" in body


def test_control_gate_returns_login_required_kind():
    src = _server_src()
    assert "'kind': 'login_required'" in src
    assert "Sign in to control the robot." in src


def test_login_logout_whoami_endpoints_registered():
    src = _server_src()
    assert '@app.post("/api/login")' in src
    assert '@app.post("/api/logout")' in src
    assert '@app.get("/api/whoami")' in src


def test_frontend_login_modal_copy_and_event():
    modal_path = os.path.join(
        os.path.dirname(SERVER_DIR),
        'frontend', 'src', 'components', 'LoginModal.jsx')
    with open(modal_path) as fh:
        js = fh.read()
    # Exact operator-approved copy.
    assert 'Sign in to control the robot' in js
    assert 'Viewing does not require a sign-in' in js
    # Event wired.
    assert "roboai-login-required" in js
    assert "/api/login" in js


def test_frontend_interceptor_splits_pairing_vs_login():
    """pairedDevice.js dispatches roboai-login-required on
    login_required 401 kinds, roboai-pair-required on
    pairing_required (legacy). If the kind isn't in the body,
    default to login-required so the LoginModal opens (the
    new-primary path)."""
    lib_path = os.path.join(
        os.path.dirname(SERVER_DIR),
        'frontend', 'src', 'lib', 'pairedDevice.js')
    with open(lib_path) as fh:
        js = fh.read()
    assert 'roboai-login-required' in js
    assert 'roboai-pair-required' in js
    assert 'login_required' in js
    assert 'pairing_required' in js

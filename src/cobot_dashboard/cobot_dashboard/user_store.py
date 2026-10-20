"""User store — username/password credentials for the login model.

Fork-registry `device_pairing_auth` sibling: the LOGIN half of the
auth model pivot (add-61 §690, 2026-09-18). Passwords are hashed
with scrypt (stdlib, no external dep required). Roles are `admin`
or `operator`. First-boot provisioning mints a default admin with
a RANDOM per-robot password — never a fixed default. The random
password is written mode 0600 to /opt/cobot/admin_bootstrap.txt for
the installer to retrieve; the file is meant to be `cat`ted once,
then `shred`-deleted.

Threat model:
* Password hashing: scrypt with per-user random salt + n=2^14,
  r=8, p=1 (Colin Percival's recommended baseline for interactive
  auth). Hash width is ~64 bytes; salt 16 bytes; both hex.
* Rate limit: 5 fails inside 5 min from the SAME remote_ip → 5 min
  lockout on that IP for /api/login.
* No password reset flow in-band. Operators reset via
  `sudo python3 tools/cobot-user-cli.py passwd <user>` from
  localhost. Recovery is administrative, not UX-driven.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time


USERS_PATH = os.environ.get('COBOT_USERS_PATH', '/opt/cobot/users.json')

BOOTSTRAP_PATH = os.environ.get(
    'COBOT_ADMIN_BOOTSTRAP_PATH', '/opt/cobot/admin_bootstrap.txt')

VALID_ROLES = ('admin', 'operator')

# Scrypt parameters. n=2^14 is the Percival baseline for interactive
# login (well under 100ms on modern hardware, well over any offline
# attacker's per-guess budget). Not tunable at runtime — a change
# here means re-hashing all users, which is a migration event.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024

LOCKOUT_WINDOW_S   = 300
LOCKOUT_MAX_FAILS  = 5
LOCKOUT_DURATION_S = 300


def _now() -> float:
    return time.time()


def _mint_salt() -> str:
    return secrets.token_hex(16)


def _hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    return hashlib.scrypt(
        password.encode('utf-8'), salt=salt,
        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
        maxmem=_SCRYPT_MAXMEM).hex()


def _mint_random_password(length: int = 24) -> str:
    """Mint a URL-safe password suitable for the default admin. 24
    URL-safe chars = 144 bits of entropy — well above brute-force
    range for scrypt-hashed offline attack, and readable enough for
    an installer to `cat` and paste into the wizard once."""
    return secrets.token_urlsafe(length)[:length]


class UserStore:
    """In-memory + on-disk user store."""

    def __init__(self, path: str = USERS_PATH):
        self._path = path
        self._lock = threading.RLock()
        self._users: dict = self._read()
        self._failures: dict = {}
        self._lockout_until: dict = {}

    def _read(self) -> dict:
        if not os.path.exists(self._path):
            return {}
        try:
            with open(self._path) as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        return {}

    def _write(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
        except Exception:
            pass
        tmp = self._path + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(self._users, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._path)
        try:
            os.chmod(self._path, 0o600)
        except Exception:
            pass

    # ── users ---------------------------------------------------------

    def is_empty(self) -> bool:
        with self._lock:
            return len(self._users) == 0

    def add(self, username: str, password: str,
            role: str = 'operator') -> dict:
        username = (username or '').strip().lower()
        if not username or not username.isidentifier() or len(username) > 32:
            return {'ok': False, 'kind': 'bad_username'}
        if not password or len(password) < 8:
            return {'ok': False, 'kind': 'weak_password'}
        role = (role or 'operator').strip().lower()
        if role not in VALID_ROLES:
            return {'ok': False, 'kind': 'bad_role'}
        with self._lock:
            if username in self._users:
                return {'ok': False, 'kind': 'exists'}
            salt = _mint_salt()
            self._users[username] = {
                'password_hash': _hash_password(password, salt),
                'salt':          salt,
                'role':          role,
                'created':       time.strftime(
                    '%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'last_login':    '',
            }
            self._write()
        return {'ok': True, 'username': username, 'role': role}

    def remove(self, username: str) -> bool:
        username = (username or '').strip().lower()
        with self._lock:
            existed = self._users.pop(username, None) is not None
            if existed:
                self._write()
        return existed

    def set_password(self, username: str, password: str) -> dict:
        username = (username or '').strip().lower()
        if not password or len(password) < 8:
            return {'ok': False, 'kind': 'weak_password'}
        with self._lock:
            u = self._users.get(username)
            if u is None:
                return {'ok': False, 'kind': 'no_such_user'}
            salt = _mint_salt()
            u['password_hash'] = _hash_password(password, salt)
            u['salt']          = salt
            self._write()
        return {'ok': True, 'username': username}

    def list_users(self) -> list:
        with self._lock:
            return [
                {
                    'username':   u,
                    'role':       meta.get('role', 'operator'),
                    'created':    meta.get('created', ''),
                    'last_login': meta.get('last_login', ''),
                }
                for u, meta in sorted(self._users.items())
            ]

    # ── auth ----------------------------------------------------------

    def _is_locked(self, remote_ip: str):
        with self._lock:
            until = self._lockout_until.get(remote_ip, 0.0)
            if until > _now():
                return True, until - _now()
            return False, 0.0

    def _record_failure(self, remote_ip: str) -> None:
        with self._lock:
            now = _now()
            hits = [t for t in self._failures.get(remote_ip, [])
                    if now - t < LOCKOUT_WINDOW_S]
            hits.append(now)
            self._failures[remote_ip] = hits
            if len(hits) >= LOCKOUT_MAX_FAILS:
                self._lockout_until[remote_ip] = now + LOCKOUT_DURATION_S
                self._failures[remote_ip] = []

    def _clear_failures(self, remote_ip: str) -> None:
        with self._lock:
            self._failures.pop(remote_ip, None)
            self._lockout_until.pop(remote_ip, None)

    def verify_password(self, username: str, password: str,
                        remote_ip: str) -> dict:
        """Verify a login attempt.

        Returns:
          {ok:True, username, role} on success
          {ok:False, kind:'locked_out', retry_after_s} on lockout
          {ok:False, kind:'invalid'} on bad credentials
        """
        username = (username or '').strip().lower()
        locked, remaining = self._is_locked(remote_ip)
        if locked:
            return {'ok': False, 'kind': 'locked_out',
                    'retry_after_s': int(remaining)}
        with self._lock:
            u = self._users.get(username)
        if u is None:
            # Do a dummy scrypt to keep the timing curve flat — a
            # subtle mitigation against username enumeration via
            # response time.
            _hash_password(password or '_', _mint_salt())
            self._record_failure(remote_ip)
            return {'ok': False, 'kind': 'invalid'}
        expected = u['password_hash']
        got      = _hash_password(password, u['salt'])
        if not hmac.compare_digest(got, expected):
            self._record_failure(remote_ip)
            return {'ok': False, 'kind': 'invalid'}
        # Success — bump last_login + clear the failure counter.
        with self._lock:
            u['last_login'] = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            self._write()
        self._clear_failures(remote_ip)
        return {'ok': True, 'username': username,
                'role': u.get('role', 'operator')}

    # ── test hook -----------------------------------------------------

    def _reset_for_tests(self) -> None:
        with self._lock:
            self._users.clear()
            self._failures.clear()
            self._lockout_until.clear()
            if os.path.exists(self._path):
                try:
                    os.remove(self._path)
                except Exception:
                    pass


_default_store = None
_default_lock  = threading.Lock()


def get_store() -> UserStore:
    global _default_store
    with _default_lock:
        if _default_store is None:
            _default_store = UserStore()
        return _default_store


def reset_default_store_for_tests(path: str | None = None) -> UserStore:
    global _default_store
    with _default_lock:
        _default_store = UserStore(path or USERS_PATH)
        return _default_store


# ── First-boot provisioning ─────────────────────────────────────────

def provision_default_admin_if_empty(
        store: UserStore | None = None,
        bootstrap_path: str = BOOTSTRAP_PATH) -> dict:
    """Mint a random-password admin ONLY if the user store is empty.

    Called at dashboard lifespan startup. Idempotent: once ANY user
    exists (default admin OR operator-added user), this function is
    a no-op.

    Writes the plaintext password to `bootstrap_path` with mode 0600
    for the installer to `cat` once. Never returns the password;
    the caller reads the file or the journal.

    Returns:
      {'ok': True, 'created': True|False, 'username': 'admin'|None,
       'bootstrap_path': path|None}
    """
    store = store or get_store()
    if not store.is_empty():
        return {'ok': True, 'created': False,
                'username': None, 'bootstrap_path': None}
    password = _mint_random_password()
    res = store.add('admin', password, role='admin')
    if not res.get('ok'):
        return {'ok': False, 'created': False,
                'kind': res.get('kind', 'unknown'),
                'bootstrap_path': None}
    try:
        os.makedirs(os.path.dirname(bootstrap_path), exist_ok=True)
    except Exception:
        pass
    try:
        # Write with mode 0600 from the start — DO NOT touch first
        # then chmod. secrets shouldn't ever appear world-readable
        # even for a race window.
        fd = os.open(bootstrap_path,
                     os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, (
                'NeuRobots dashboard — default admin bootstrap\n'
                '\n'
                f'username: admin\n'
                f'password: {password}\n'
                '\n'
                'This file is written once, on first boot when the\n'
                'user store is empty. Read it, use the credentials\n'
                'to sign in via the dashboard, then delete this file:\n'
                '\n'
                f'  sudo shred -u {bootstrap_path}\n'
            ).encode('utf-8'))
        finally:
            os.close(fd)
    except Exception:
        # Hard-fail: emit the password to the journal so the
        # operator has SOMETHING to work with. The file is
        # preferred; journal is the backstop.
        print(f'[user_store] BOOTSTRAP FALLBACK (file write failed): '
              f'admin password = {password}', flush=True)
        return {'ok': True, 'created': True,
                'username': 'admin', 'bootstrap_path': None}
    # Non-secret journal breadcrumb so the operator knows to check
    # the file. NEVER log the password itself.
    print(f'[user_store] default admin provisioned; password at '
          f'{bootstrap_path} (mode 0600)', flush=True)
    return {'ok': True, 'created': True,
            'username': 'admin', 'bootstrap_path': bootstrap_path}

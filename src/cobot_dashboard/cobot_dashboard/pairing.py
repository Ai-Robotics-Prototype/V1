"""Device pairing service — pure module (no FastAPI dependency).

Security boundary. A new tablet running the app calls /api/pair/start
which returns a session_id and shows a 6-digit code on the robot's
already-paired dashboard. The tablet operator types the code into
the tablet, which calls /api/pair/confirm — correct code mints a
per-device token; wrong code counts toward a lockout.

State:
  * Pending sessions (in-memory): session_id → {code, device_name,
    created_ts, remote_ip}, 90s TTL, single successful confirm.
  * Failure counter per remote_ip: 3 fails inside a 5-min window =
    5-min lockout on /pair/start AND /pair/confirm from that ip.
  * Paired devices (on disk, /opt/cobot/paired_devices.json):
    token_id → {token_hash, device_name, created, last_seen}. Only
    the hash is stored; the raw token is returned once on confirm
    and never persisted.

Threading:
  * All public helpers are safe under one internal lock. The
    dashboard broadcast loop + HTTP handlers all live in a single
    asyncio event loop, but the file-store I/O + lockout counters
    are read from a background WS-drop worker too, hence the lock.

Revocation:
  * `revoke(token_id)` returns the set of active token_ids that
    were removed. Callers subscribe via `on_revoke(callback)` to
    receive live-drop signals (used to close open WS sessions).

Deliberately NOT here:
  * FastAPI Request / Response types. The dashboard_server layer
    calls into this module for logic and translates to HTTP status.
  * mDNS advertisement. Owned by a follow-on identity_avahi module.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Callable, Dict, List, Optional, Set, Tuple


PAIRED_DEVICES_PATH = os.environ.get(
    'COBOT_PAIRED_DEVICES_PATH', '/opt/cobot/paired_devices.json')

CODE_TTL_S              = 90
LOCKOUT_WINDOW_S        = 300
LOCKOUT_MAX_FAILS       = 3
LOCKOUT_DURATION_S      = 300
TOKEN_BYTES             = 32           # 256-bit
CODE_DIGITS             = 6


def _now() -> float:
    return time.time()


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _mint_code() -> str:
    n = secrets.randbelow(10 ** CODE_DIGITS)
    return f'{n:0{CODE_DIGITS}d}'


def _mint_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def _mint_session_id() -> str:
    return secrets.token_urlsafe(16)


def _mint_token_id() -> str:
    return secrets.token_urlsafe(9)


class PairingStore:
    """In-memory session store + on-disk device store + lockout."""

    def __init__(self, path: str = PAIRED_DEVICES_PATH):
        self._path = path
        self._lock = threading.RLock()
        self._pending: Dict[str, dict] = {}
        self._failures: Dict[str, List[float]] = {}
        self._lockout_until: Dict[str, float] = {}
        self._revoke_callbacks: List[Callable[[str], None]] = []
        self._devices: Dict[str, dict] = self._read()

    # ----- persistence ------------------------------------------------

    def _read(self) -> Dict[str, dict]:
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
            json.dump(self._devices, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._path)

    # ----- lockout ----------------------------------------------------

    def _is_locked(self, remote_ip: str) -> Tuple[bool, float]:
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

    # ----- session lifecycle -----------------------------------------

    def start(self, device_name: str, remote_ip: str) -> dict:
        """Begin a pairing session. Returns dict for HTTP layer.

        Returns:
          {ok:True, session_id, code, expires_in_s}                        on ok
          {ok:False, kind:'locked_out', retry_after_s}                     on lockout
          {ok:False, kind:'bad_device_name'}                               on empty name
        """
        device_name = (device_name or '').strip()
        if not device_name or len(device_name) > 64:
            return {'ok': False, 'kind': 'bad_device_name'}
        locked, remaining = self._is_locked(remote_ip)
        if locked:
            return {'ok': False, 'kind': 'locked_out',
                    'retry_after_s': int(remaining)}
        with self._lock:
            self._sweep_expired_pending_locked()
            session_id = _mint_session_id()
            code       = _mint_code()
            self._pending[session_id] = {
                'code':        code,
                'device_name': device_name,
                'remote_ip':   remote_ip,
                'created_ts':  _now(),
                'attempts':    0,
            }
        return {
            'ok':           True,
            'session_id':   session_id,
            'code':         code,
            'expires_in_s': CODE_TTL_S,
            'device_name':  device_name,
        }

    def confirm(self, session_id: str, code: str,
                remote_ip: str) -> dict:
        """Confirm a pairing session against its code.

        Returns:
          {ok:True, token, token_id, device_name}                          on match
          {ok:False, kind:'no_session'|'expired'|'bad_code'|'locked_out'}  otherwise
        """
        code = (code or '').strip()
        locked, remaining = self._is_locked(remote_ip)
        if locked:
            return {'ok': False, 'kind': 'locked_out',
                    'retry_after_s': int(remaining)}
        with self._lock:
            sess = self._pending.get(session_id)
            if sess is None:
                self._record_failure(remote_ip)
                return {'ok': False, 'kind': 'no_session'}
            age = _now() - sess['created_ts']
            if age > CODE_TTL_S:
                self._pending.pop(session_id, None)
                self._record_failure(remote_ip)
                return {'ok': False, 'kind': 'expired'}
            # Sweep siblings AFTER the lookup — the target session's
            # own expiry is handled by the age check above.
            self._sweep_expired_pending_locked()
            sess['attempts'] += 1
            if not hmac.compare_digest(code, sess['code']):
                self._pending.pop(session_id, None)
                self._record_failure(remote_ip)
                return {'ok': False, 'kind': 'bad_code'}
            self._pending.pop(session_id, None)
            self._clear_failures(remote_ip)
            token       = _mint_token()
            token_id    = _mint_token_id()
            device_name = sess['device_name']
            now_iso     = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                        time.gmtime())
            self._devices[token_id] = {
                'token_hash':  _hash_token(token),
                'device_name': device_name,
                'created':     now_iso,
                'last_seen':   now_iso,
            }
            self._write()
        return {
            'ok':          True,
            'token':       token,
            'token_id':    token_id,
            'device_name': device_name,
        }

    def _sweep_expired_pending_locked(self) -> None:
        now = _now()
        dead = [sid for sid, s in self._pending.items()
                if now - s['created_ts'] > CODE_TTL_S]
        for sid in dead:
            self._pending.pop(sid, None)

    def list_pending(self) -> List[dict]:
        """Snapshot pending pairing sessions for the paired-dashboard
        modal to render. Called from the broadcast loop; NEVER returned
        over an unauthenticated endpoint under enforced mode — the code
        must ONLY be visible on the paired robot display."""
        with self._lock:
            self._sweep_expired_pending_locked()
            now = _now()
            return [
                {
                    'session_id':   sid,
                    'device_name':  s['device_name'],
                    'code':         s['code'],
                    'remote_ip':    s['remote_ip'],
                    'remaining_s':  max(
                        0, int(CODE_TTL_S - (now - s['created_ts']))),
                }
                for sid, s in sorted(
                    self._pending.items(),
                    key=lambda kv: kv[1]['created_ts'])
            ]

    def deny(self, session_id: str) -> bool:
        """Cancel a pending session from the robot-side dashboard.
        Returns True if it existed and got dropped."""
        with self._lock:
            existed = self._pending.pop(session_id, None) is not None
        return existed

    # ----- token validation + revocation -----------------------------

    def validate_token(self, raw_token: str) -> Optional[str]:
        """Return token_id if valid, else None. Updates last_seen."""
        if not raw_token:
            return None
        h = _hash_token(raw_token)
        with self._lock:
            for tid, meta in self._devices.items():
                if hmac.compare_digest(h, meta.get('token_hash', '')):
                    meta['last_seen'] = time.strftime(
                        '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                    return tid
        return None

    def list_devices(self) -> List[dict]:
        """List devices for the mgmt UI (no hashes leaked)."""
        with self._lock:
            return [
                {
                    'token_id':    tid,
                    'device_name': meta.get('device_name', ''),
                    'created':     meta.get('created', ''),
                    'last_seen':   meta.get('last_seen', ''),
                }
                for tid, meta in sorted(self._devices.items())
            ]

    def revoke(self, token_id: str) -> bool:
        """Drop a device. Fires on_revoke callbacks with token_id."""
        with self._lock:
            existed = self._devices.pop(token_id, None) is not None
            if existed:
                self._write()
                callbacks = list(self._revoke_callbacks)
            else:
                callbacks = []
        for cb in callbacks:
            try:
                cb(token_id)
            except Exception:
                pass
        return existed

    def on_revoke(self, cb: Callable[[str], None]) -> None:
        with self._lock:
            self._revoke_callbacks.append(cb)

    # ----- test hooks -------------------------------------------------

    def _reset_for_tests(self) -> None:
        with self._lock:
            self._pending.clear()
            self._failures.clear()
            self._lockout_until.clear()
            self._devices.clear()
            self._revoke_callbacks.clear()
            if os.path.exists(self._path):
                try:
                    os.remove(self._path)
                except Exception:
                    pass


_default_store: Optional[PairingStore] = None
_default_lock = threading.Lock()


def get_store() -> PairingStore:
    """Module-level singleton for the dashboard-server callers."""
    global _default_store
    with _default_lock:
        if _default_store is None:
            _default_store = PairingStore()
        return _default_store


def reset_default_store_for_tests(path: Optional[str] = None) -> PairingStore:
    global _default_store
    with _default_lock:
        _default_store = PairingStore(path or PAIRED_DEVICES_PATH)
        return _default_store

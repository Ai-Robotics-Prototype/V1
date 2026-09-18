"""Robot provisioning identity.

/opt/cobot/identity.json is generated ONCE at first boot and survives
updates. It answers "which physical robot is this" for pairing +
advertisement + support telemetry. The file is authoritative — the
serial is minted here on first run and never rewritten. If the file
is missing (fresh install, disk swap) a new identity is minted.

Never confused with the CLIENT device UUID (`roboai-device-id`,
localStorage) — that lives in the browser and identifies a tablet,
not the robot.
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import threading
from typing import Dict


IDENTITY_PATH = os.environ.get('COBOT_IDENTITY_PATH',
                               '/opt/cobot/identity.json')
DEFAULT_MODEL = 'S10-140'

_lock = threading.Lock()
_cached: Dict[str, str] | None = None


def _mint_serial() -> str:
    return 'NR-' + secrets.token_hex(3).upper()


def _default_friendly_name() -> str:
    host = socket.gethostname().split('.')[0].strip() or 'cobot'
    return host


def _atomic_write(path: str, payload: dict) -> None:
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _validate(loaded: dict) -> bool:
    if not isinstance(loaded, dict):
        return False
    for k in ('serial', 'model', 'friendly_name'):
        v = loaded.get(k)
        if not isinstance(v, str) or not v.strip():
            return False
    return True


def load_or_mint(path: str = IDENTITY_PATH) -> Dict[str, str]:
    """Return the identity dict. Mints + persists on first run.

    Fields: serial (NR-XXXXXX), model (S10-140), friendly_name (host).
    """
    global _cached
    with _lock:
        if _cached is not None:
            return dict(_cached)
        if os.path.exists(path):
            try:
                with open(path) as fh:
                    loaded = json.load(fh)
                if _validate(loaded):
                    _cached = {
                        'serial':        loaded['serial'],
                        'model':         loaded['model'],
                        'friendly_name': loaded['friendly_name'],
                    }
                    return dict(_cached)
            except Exception:
                pass
        minted = {
            'serial':        _mint_serial(),
            'model':         DEFAULT_MODEL,
            'friendly_name': _default_friendly_name(),
        }
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            _atomic_write(path, minted)
        except Exception:
            pass
        _cached = minted
        return dict(_cached)


def set_friendly_name(name: str, path: str = IDENTITY_PATH) -> Dict[str, str]:
    """Rewrite friendly_name only. Serial + model are immutable."""
    global _cached
    name = (name or '').strip()
    if not name:
        raise ValueError('friendly_name empty')
    with _lock:
        current = _cached or load_or_mint(path)
        updated = {
            'serial':        current['serial'],
            'model':         current['model'],
            'friendly_name': name,
        }
        _atomic_write(path, updated)
        _cached = updated
        return dict(updated)


def reset_cache() -> None:
    """Test hook — drop the module cache so a fresh path re-loads."""
    global _cached
    with _lock:
        _cached = None

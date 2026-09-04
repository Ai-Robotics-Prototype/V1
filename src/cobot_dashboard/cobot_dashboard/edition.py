"""Edition module — SINGLE source of truth for basic vs full.

Basic ships on the operator tablet. Full is for our own PC development
and later production tiers. Same codebase, same branch, edition flag.

Load-bearing invariants:
  1. E-STOP, safety interlocks, refusal gates, delete integrity, and
     codegen behaviour are edition-INDEPENDENT — identical in both.
     `SAFETY_INVARIANT_KEYS` are hard-rejected by `_validate_map` at
     import time so no future edit can accidentally hide a safety
     surface behind an edition gate.
  2. Frontend has a byte-mirror at `frontend/src/lib/edition.js`. The
     regression suite `test_edition_matrix.py` compares the two so
     they can never silently drift.
  3. Per-device edition overrides live in `/opt/cobot/dashboard_editions
     .json` (`{'default': 'basic', 'devices': {<client_id>: 'full'}}`).
     If missing, everything is basic.
  4. Unknown feature keys default ENABLED (basic-safe) — new features
     land as basic first; explicitly listing them under `FEATURE_MAP`
     with `EDITION_FULL` is what makes them full-only.

The GitHub structure implied by this module is:
  * ONE repo, ONE branch flow. Releases are TAGS `vX.Y-basic` +
    `vX.Y-full` cut from the SAME commit. Never an edition branch.
"""
from __future__ import annotations

import json
import os
import threading


EDITION_BASIC = 'basic'
EDITION_FULL  = 'full'
EDITIONS      = (EDITION_BASIC, EDITION_FULL)

# The feature-map loader hard-rejects any of these appearing as feature
# keys. Safety, delete integrity, refusal gates, and codegen behave
# identically in both editions — they cannot be gated.
SAFETY_INVARIANT_KEYS = frozenset({
    'estop',
    'safety_interlocks',
    'delete_integrity',
    'codegen',
    'refusal_gates',
})

# feature_key -> minimum edition. Unknown keys are treated as basic.
#
# 2026-09-04 OPERATOR SPLIT — Basic hides exactly THREE surfaces:
#   * cameras_lidar     (SensorsLayout — CameraPanel/LidarPanel/MotionCam)
#   * part_recognition  (AdaptivePicking — parts library + teach)
#   * safety_page       (SafetyPage — safety configuration surface)
#
# The safety PAGE is edition-gated. E-STOP, safety interlocks,
# refusal gates, delete integrity, and codegen behaviour remain
# edition-INDEPENDENT — those keys sit in SAFETY_INVARIANT_KEYS and
# the loader hard-rejects them as FEATURE_MAP entries. The E-STOP
# button in TopBar renders unconditionally in both editions
# (regardless of this map).
FEATURE_MAP: dict = {
    'monitor':            EDITION_BASIC,
    'run_controls':       EDITION_BASIC,
    'program_library':    EDITION_BASIC,
    'wizard':             EDITION_BASIC,
    'demonstration':      EDITION_BASIC,
    'speed_control':      EDITION_BASIC,
    'corner_smoothing':   EDITION_BASIC,
    'deep_editor':        EDITION_BASIC,
    '3d_view':            EDITION_BASIC,
    'io_panel':           EDITION_BASIC,
    'event_log':          EDITION_BASIC,
    'per_step_overrides': EDITION_BASIC,
    # Full-only surfaces. Each has its own backend refusal wired on
    # the endpoints ONLY consumed by that surface — endpoints that
    # visible tabs also consume (Monitor's /api/parts list,
    # /api/lidar_objects/identified, GET /api/cells/active for the
    # StatusBar footer + Monitor zone display) stay open.
    'cameras_lidar':      EDITION_FULL,
    'part_recognition':   EDITION_FULL,
    'safety_page':        EDITION_FULL,
    # 2026-09-04 Configure additions:
    #   * `configure` flipped basic → full so the Configure tab is
    #     hidden entirely on basic devices (per operator item 10:
    #     "hide the Configure tab itself on basic rather than
    #     showing a blank page").
    #   * `cell_commissioning` is the new gate for the Setup Wizard
    #     cell-management endpoints (POST/PUT/DELETE on /api/cells/*,
    #     activate/deactivate, baseline/collision_zones builds).
    #     Cell STATE reads stay open so Monitor + StatusBar keep
    #     working on basic.
    'configure':          EDITION_FULL,
    'cell_commissioning': EDITION_FULL,
}


def _validate_map():
    forbidden = SAFETY_INVARIANT_KEYS & set(FEATURE_MAP.keys())
    if forbidden:
        raise ValueError(
            f'safety-invariant keys must never appear in FEATURE_MAP: '
            f'{sorted(forbidden)} — this class of surface is edition-'
            f'independent by policy')
    for k, v in FEATURE_MAP.items():
        if v not in EDITIONS:
            raise ValueError(
                f'FEATURE_MAP[{k!r}]={v!r} is not a valid edition '
                f'(expected one of {EDITIONS!r})')


_validate_map()


def is_feature_enabled(feature_key: str, edition: str) -> bool:
    """True when a device on `edition` may use `feature_key`.

    Contract:
      * Unknown edition → False (fail closed).
      * Unknown feature_key → True (unknown = basic-safe).
      * `EDITION_BASIC` features are enabled everywhere.
      * `EDITION_FULL` features enabled only when edition == full.
    """
    if edition not in EDITIONS:
        return False
    min_ed = FEATURE_MAP.get(feature_key)
    if min_ed is None:
        return True
    if min_ed == EDITION_BASIC:
        return True
    return edition == EDITION_FULL


# ── Per-device edition persistence ─────────────────────────────
# Small JSON keyed by `X-Client-Id`. Passphrase check on unlock is
# separation, not security — the user directive explicitly says so.
_EDITION_STORE_PATH = os.environ.get(
    'COBOT_EDITION_STORE',
    '/opt/cobot/dashboard_editions.json',
)
_UNLOCK_PASSPHRASE  = os.environ.get(
    'COBOT_EDITION_UNLOCK_PASS',
    'full-please',
)
_editions_lock = threading.Lock()


def _default_store() -> dict:
    return {'default': EDITION_BASIC, 'devices': {}}


def _load_store() -> dict:
    try:
        with open(_EDITION_STORE_PATH) as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return _default_store()
        default = data.get('default')
        if default not in EDITIONS:
            data['default'] = EDITION_BASIC
        if not isinstance(data.get('devices'), dict):
            data['devices'] = {}
        return data
    except (OSError, ValueError):
        return _default_store()


def _save_store(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_EDITION_STORE_PATH), exist_ok=True)
    except OSError:
        pass
    tmp = _EDITION_STORE_PATH + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, _EDITION_STORE_PATH)


def resolve_edition(client_id: str | None) -> str:
    """Prefer per-device override; else server default."""
    with _editions_lock:
        data = _load_store()
    default = data.get('default') if data.get('default') in EDITIONS \
        else EDITION_BASIC
    if client_id:
        devices = data.get('devices') or {}
        if client_id in devices and devices[client_id] in EDITIONS:
            return devices[client_id]
    return default


def unlock_device(client_id: str, passphrase: str) -> bool:
    """Unlock this device to FULL edition. Returns True on success.

    The passphrase check is separation-of-concerns, not a real gate —
    an installer-controlled env var keeps operator tablets on basic
    without cluttering the UI.
    """
    if not client_id:
        return False
    if str(passphrase or '') != _UNLOCK_PASSPHRASE:
        return False
    with _editions_lock:
        data = _load_store()
        devices = data.setdefault('devices', {})
        devices[client_id] = EDITION_FULL
        _save_store(data)
    return True


def lock_device(client_id: str) -> None:
    """Reset this device to server default (usually basic)."""
    if not client_id:
        return
    with _editions_lock:
        data = _load_store()
        devices = data.setdefault('devices', {})
        if client_id in devices:
            del devices[client_id]
            _save_store(data)


def refusal_payload(feature_key: str) -> dict:
    """Named refusal for backend endpoints that a basic device hit.
    UI-hiding alone is not a gate; this payload is the gate."""
    return {
        'ok': False,
        'error': 'available in the full edition',
        'reason_code': 'feature_full_only',
        'feature_key': feature_key,
        'edition_required': EDITION_FULL,
    }

"""Per-device UI context store — 2026-08-05 refresh persistence.

Fork registry: `page_context_persistence`. The Jetson is the source
of truth for "which program is open on this device"; UIs are views.
No page state in browser localStorage.

Store shape: one JSON file per device_id at
/opt/cobot/ui_context/<device_id>.json. Fields kept small (< 200 B
each) so 200 devices is <40 kB total.

Fields:
  open_program_id   — the program the operator has open in the
                       Program tab. Refresh restores it.
  active_tab        — 'monitor' | 'program' | 'programs' | ...
  device_label      — human name for this device ("Shop Tablet",
                       "Office PC"). Shown in every teach-lock
                       banner + event-log entry. Rename in
                       Configure. (2026-08-05 identity root-cause
                       fix.)
  updated_ts        — ISO-8601 UTC, refreshed on every set.

Retention: LRU prune on set — hard cap at _MAX_DEVICES entries.
Individual files are tiny; the cap is a defense against a runaway
create-a-new-device-per-visit bug rather than a size concern.
"""

from __future__ import annotations

import json
import os
import re
import time


_UI_DIR = '/opt/cobot/ui_context'
_MAX_DEVICES = 200

# device_id shape must match the frontend's _getTeachDeviceId():
# either a crypto.randomUUID() (36 chars with dashes) OR a legacy
# `dev-<ms>-<rand>` fallback. Cap to a sane range.
_DEVICE_ID_RE = re.compile(r'^[A-Za-z0-9_.-]{4,64}$')


def _path(device_id: str) -> str | None:
    """Return the on-disk path for a device_id, or None if the id
    fails validation. Rejects traversal + invalid chars."""
    if not device_id or not _DEVICE_ID_RE.match(device_id):
        return None
    return os.path.join(_UI_DIR, device_id + '.json')


def get(device_id: str) -> dict | None:
    """Return the stored context dict for a device, or None on
    missing / unreadable file. Callers treat None as 'no context
    remembered — fall back to default UI state'."""
    p = _path(device_id)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p) as fh:
            return json.load(fh)
    except Exception:
        return None


def _prune_if_needed() -> None:
    """Enforce the _MAX_DEVICES cap — oldest mtime pruned first.
    Cheap: only stats + rms when threshold crossed. Silently
    swallows filesystem errors."""
    try:
        try:
            names = os.listdir(_UI_DIR)
        except FileNotFoundError:
            return
        entries: list[tuple[str, float]] = []
        for name in names:
            if not name.endswith('.json'):
                continue
            fp = os.path.join(_UI_DIR, name)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            entries.append((fp, st.st_mtime))
        if len(entries) <= _MAX_DEVICES:
            return
        entries.sort(key=lambda e: e[1])   # oldest first
        for fp, _ in entries[:len(entries) - _MAX_DEVICES]:
            try:
                os.remove(fp)
            except OSError:
                pass
    except Exception:
        pass


def set(device_id: str, patch: dict) -> dict | None:
    """Merge `patch` into the device's context and persist. Returns
    the merged dict, or None on validation failure. Silently
    tolerates ENOSPC / EROFS — a persistence miss here degrades to
    "refresh forgets THIS write" but doesn't crash the endpoint;
    the record-through invariant remains only for pose/edit data,
    not UI pointers.

    Accepts a whitelist of fields — `open_program_id` and
    `active_tab`. Anything else in `patch` is dropped to keep the
    surface tight and audit-friendly."""
    if not isinstance(patch, dict):
        return None
    p = _path(device_id)
    if not p:
        return None
    try:
        os.makedirs(_UI_DIR, exist_ok=True)
    except OSError:
        return None
    cur = get(device_id) or {}
    for k in ('open_program_id', 'active_tab', 'device_label'):
        if k in patch:
            v = patch[k]
            if v is None:
                cur.pop(k, None)
            elif isinstance(v, str) and 0 < len(v) < 256:
                cur[k] = v
    cur['updated_ts'] = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                       time.gmtime())
    try:
        tmp = p + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(cur, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
    except OSError:
        # Degrade gracefully — UI context is helpful, not critical.
        # The alternative (raise/crash) would prevent the operator
        # from even OPENING a program when the disk is full.
        return cur
    _prune_if_needed()
    return cur


def clear(device_id: str) -> None:
    """Delete a device's context — used by an explicit sign-out or
    a test cleanup. Safe on missing file."""
    p = _path(device_id)
    if not p:
        return
    try:
        os.remove(p)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def list_all() -> list[dict]:
    """Return every stored context (mtime-ordered, newest first) —
    used by /api/health for a per-device pointer sweep. Silently
    skips unreadable files."""
    try:
        names = os.listdir(_UI_DIR)
    except FileNotFoundError:
        return []
    out = []
    for name in names:
        if not name.endswith('.json'):
            continue
        fp = os.path.join(_UI_DIR, name)
        try:
            st = os.stat(fp)
            with open(fp) as fh:
                d = json.load(fh)
        except Exception:
            continue
        d['_device_id'] = name[:-len('.json')]
        d['_mtime']     = st.st_mtime
        out.append(d)
    out.sort(key=lambda d: d['_mtime'], reverse=True)
    return out

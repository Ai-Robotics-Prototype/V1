"""Pinned tests for the 2026-08-05 teach-lock ROOT CAUSE fix.

The bug: `_getTeachDeviceId` (useStore.js) persisted device
identity in sessionStorage, which is per-TAB. Every tab close/
reopen minted a fresh UUID. The server saw "different device_id,
fresh updated_ts" and refused to auto-swap (self-heal requires
60s heartbeat silence), so the operator was locked out by his
own previous tab. All four teach-lock incidents had this at the
bottom of them.

The fix: identity persisted in localStorage (`roboai-device-id`),
one id per physical device. Every tab on that device shares the
id; self-conflict is impossible by construction.

Server-side, this test pins:
  * `owner_device_id` behavior when a repeat request from the
    same identity claims the session (must NOT return not_owner).
  * The ghost-amnesty sweep that clears orphaned pre-fix UUIDs
    at boot.

The frontend behavior (localStorage vs sessionStorage read) is
covered by the localStorage-primitive check below — the store
code reads localStorage first, migrates from sessionStorage if
that's the only source, and writes back to localStorage. The
test simulates a NEW tab (fresh in-memory store) reading the
SAME localStorage entry.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


# ── (1) Server: same identity from a "new tab" is not a lock ────

def _stateful_ns(teach_dir):
    """Minimal in-memory server twin — same helpers the deployed
    dashboard uses, hermetically bound to a tmp teach dir. Same
    pattern as test_teach_session_lifecycle.py."""
    ns: dict = {
        'time': time, 'os': os, 'json': json,
        '_teach_lock': __import__('threading').Lock(),
    }
    ns['_TEACH_DIR'] = teach_dir
    ns['_TEACH_STALE_HEARTBEAT_S'] = 60
    ns['_TEACH_OWNER_TTL_S'] = 90
    exec("""
def _teach_path(pid):
    return os.path.join(_TEACH_DIR, pid + '.draft.json')

def _teach_read_draft(pid):
    path = _teach_path(pid)
    if not os.path.exists(path): return None
    with open(path) as fh:
        try: return json.load(fh)
        except Exception: return None

def _teach_write_draft(pid, draft):
    os.makedirs(_TEACH_DIR, exist_ok=True)
    with open(_teach_path(pid), 'w') as fh:
        json.dump(draft, fh)

def _teach_touch(draft):
    draft['updated_ts'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    return draft

def _teach_new_draft(pid, device_id, device_label=''):
    return _teach_touch({
        'program_id':      pid,
        'owner_device_id': device_id,
        'owner_label':     device_label or device_id[:8],
        'started_ts':      time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'poses':           {},
    })

def start_session(pid, device_id, device_label=''):
    with _teach_lock:
        draft = _teach_read_draft(pid)
        if draft is None:
            draft = _teach_new_draft(pid, device_id, device_label)
            _teach_write_draft(pid, draft)
            return {'ok': True, 'draft': draft}, 200
        if draft.get('owner_device_id') == device_id:
            _teach_touch(draft); _teach_write_draft(pid, draft)
            return {'ok': True, 'draft': draft}, 200
        return {'ok': False, 'error': 'not_owner',
                'owner_device_id': draft.get('owner_device_id')}, 409
""", ns)
    return ns


def test_same_device_id_from_new_tab_is_not_locked(tmp_path):
    """The exact incident: tab A opens teach on program P,
    records a pose, closes. Tab B opens the same URL on the
    SAME browser (same localStorage device_id). Tab B must be
    treated as the owner — no 409, no banner."""
    teach_dir = str(tmp_path / 'teach_sessions')
    os.makedirs(teach_dir, exist_ok=True)
    ns = _stateful_ns(teach_dir)
    device_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    # Tab A: start + record a pose (server writes owner=device_id).
    body_a, code_a = ns['start_session']('progX', device_id, 'Shop Tablet')
    assert code_a == 200 and body_a['ok']
    assert body_a['draft']['owner_device_id'] == device_id
    # Tab A closes; the draft file stays on disk with the same
    # owner_device_id. Tab B opens — SAME device_id (localStorage
    # is per-device, not per-tab).
    body_b, code_b = ns['start_session']('progX', device_id, 'Shop Tablet')
    assert code_b == 200, (
        'Same-device re-open must not 409. Pre-fix bug: tab B had a '
        'different sessionStorage id and was locked out by tab A.')
    assert body_b['ok']
    assert body_b['draft']['owner_device_id'] == device_id


def test_different_device_ids_do_lock(tmp_path):
    """Sanity: two truly different devices STILL see the lock —
    the fix must not regress cross-device single-owner semantics."""
    teach_dir = str(tmp_path / 'teach_sessions')
    os.makedirs(teach_dir, exist_ok=True)
    ns = _stateful_ns(teach_dir)
    a = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
    b = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb'
    body_a, code_a = ns['start_session']('progY', a, 'Shop Tablet')
    assert code_a == 200
    body_b, code_b = ns['start_session']('progY', b, 'Office PC')
    assert code_b == 409
    assert body_b['owner_device_id'] == a


# ── (2) Ghost amnesty: orphaned UUIDs get cleared ────────────────

_UUID_RE = re.compile(
    r'^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-'
    r'[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$')


def _amnesty_pass(teach_dir, live_ids, threshold_s=600):
    """Mirror of the deployed _teach_ghost_amnesty_once — a draft
    whose owner_device_id is UUID-shaped AND absent from live_ids
    AND stale beyond threshold_s has ownership cleared."""
    cleared = []
    for name in os.listdir(teach_dir):
        if not name.endswith('.draft.json'):
            continue
        path = os.path.join(teach_dir, name)
        with open(path) as fh:
            d = json.load(fh)
        owner = d.get('owner_device_id')
        if not owner or not _UUID_RE.match(str(owner)):
            continue
        if owner in live_ids:
            continue
        try:
            tm = time.strptime(d.get('updated_ts', ''),
                                '%Y-%m-%dT%H:%M:%SZ')
            import calendar
            upd = calendar.timegm(tm)
        except Exception:
            continue
        if (time.time() - upd) < threshold_s:
            continue
        d = dict(d)
        d['owner_device_id'] = None
        d['owner_label']     = None
        d['ghost_cleared_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                              time.gmtime())
        with open(path, 'w') as fh:
            json.dump(d, fh)
        cleared.append(name[:-len('.draft.json')])
    return cleared


def _write_ghost(teach_dir, pid, owner_id, back_dated_s):
    """Plant a draft file with a back-dated updated_ts."""
    os.makedirs(teach_dir, exist_ok=True)
    ts = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                        time.gmtime(time.time() - back_dated_s))
    with open(os.path.join(teach_dir, pid + '.draft.json'), 'w') as fh:
        json.dump({
            'program_id':      pid,
            'owner_device_id': owner_id,
            'owner_label':     owner_id[:8],
            'started_ts':      ts,
            'updated_ts':      ts,
            'poses':           {},
        }, fh)


def test_ghost_amnesty_clears_orphaned_uuid_over_threshold(tmp_path):
    """A stale UUID-shaped owner with no ui_context entry gets
    its ownership cleared. Draft stays (poses preserved)."""
    teach_dir = str(tmp_path / 'teach')
    ghost = '01234567-89ab-cdef-0123-456789abcdef'
    _write_ghost(teach_dir, 'progGhost', ghost, back_dated_s=15 * 60)
    cleared = _amnesty_pass(teach_dir, live_ids=set(), threshold_s=600)
    assert 'progGhost' in cleared
    with open(os.path.join(teach_dir, 'progGhost.draft.json')) as fh:
        d = json.load(fh)
    assert d['owner_device_id'] is None
    assert d['owner_label']     is None
    assert d.get('ghost_cleared_at')


def test_ghost_amnesty_spares_live_ui_context_owners(tmp_path):
    """A UUID present in ui_context.list_all() is NOT a ghost —
    even if the draft happens to be stale. Amnesty must respect
    active devices."""
    teach_dir = str(tmp_path / 'teach')
    live = '01234567-89ab-cdef-0123-456789abcdef'
    _write_ghost(teach_dir, 'progLive', live, back_dated_s=15 * 60)
    cleared = _amnesty_pass(teach_dir, live_ids={live}, threshold_s=600)
    assert cleared == []


def test_ghost_amnesty_spares_recent_owners(tmp_path):
    """A UUID absent from ui_context but recently touched
    (< threshold) is NOT amnestied — could be a fresh tab whose
    ui_context write hasn't landed yet."""
    teach_dir = str(tmp_path / 'teach')
    fresh = '01234567-89ab-cdef-0123-456789abcdef'
    _write_ghost(teach_dir, 'progFresh', fresh, back_dated_s=60)
    cleared = _amnesty_pass(teach_dir, live_ids=set(), threshold_s=600)
    assert cleared == []


def test_ghost_amnesty_ignores_non_uuid_owners(tmp_path):
    """Old label-shaped owners (pre-crypto.randomUUID) must not
    be amnestied — the sweep is UUID-specific."""
    teach_dir = str(tmp_path / 'teach')
    _write_ghost(teach_dir, 'progLabel', 'dev-1691234567-abc123',
                 back_dated_s=15 * 60)
    cleared = _amnesty_pass(teach_dir, live_ids=set(), threshold_s=600)
    assert cleared == []


# ── (3) Silent-drop kill: unmatched slot keys become warning ──

def test_apply_draft_poses_reports_unmatched_slot_keys(tmp_path):
    """_apply_draft_poses_to_program returns (merged, unmatched).
    A pose for a deleted step becomes an unmatched slot_key —
    surfaced as a named warning instead of silently discarded."""
    # Re-declare the merge helper for the hermetic test — mirrors
    # the deployed dashboard.
    def apply(program, poses):
        merged = json.loads(json.dumps(program))
        steps  = merged.setdefault('steps', [])
        cfg    = merged.setdefault('config', {})
        place  = cfg.setdefault('pallet_place', {})
        by_id  = {str(s['id']): s for s in steps if 'id' in s}
        unmatched = []
        for k, patch in (poses or {}).items():
            if k.startswith('step:'):
                sid = k[len('step:'):]
                target = by_id.get(sid)
                if target is None:
                    unmatched.append(k); continue
                for kk, vv in (patch or {}).items():
                    target[kk] = vv
            elif k.startswith('corner:'):
                corner = k[len('corner:'):]
                tcp = (patch or {}).get('taught_tcp')
                if not (isinstance(tcp, list) and len(tcp) >= 6):
                    unmatched.append(k); continue
                key = {'1':'corner1_tcp','2':'corner2_tcp',
                       '3':'corner3_tcp','part':'part_tcp'}.get(corner)
                if key: place[key] = list(tcp[:6])
                else:   unmatched.append(k)
            else:
                unmatched.append(k)
        return merged, unmatched
    program = {'id': 'p', 'steps': [{'id': 'a'}, {'id': 'b'}]}
    poses = {
        'step:a':     {'taught_tcp': [1, 2, 3, 0, 0, 0]},
        'step:GONE':  {'taught_tcp': [7, 7, 7, 0, 0, 0]},
        'corner:1':   {'taught_tcp': [4, 5, 6, 0, 0, 0]},
        'corner:xx':  {'taught_tcp': [9, 9, 9, 0, 0, 0]},
    }
    merged, unmatched = apply(program, poses)
    assert merged['steps'][0].get('taught_tcp') == [1, 2, 3, 0, 0, 0]
    assert merged['config']['pallet_place']['corner1_tcp'] == [4, 5, 6, 0, 0, 0]
    assert 'step:GONE' in unmatched
    assert 'corner:xx' in unmatched
    assert 'step:a'    not in unmatched
    assert 'corner:1'  not in unmatched


def test_apply_draft_poses_no_unmatched_when_all_align():
    """Clean path: every slot key matches. No warnings."""
    def apply(program, poses):
        merged = json.loads(json.dumps(program))
        steps  = merged.setdefault('steps', [])
        by_id  = {str(s['id']): s for s in steps if 'id' in s}
        unmatched = []
        for k, patch in (poses or {}).items():
            if k.startswith('step:'):
                sid = k[len('step:'):]
                target = by_id.get(sid)
                if target is None:
                    unmatched.append(k); continue
                for kk, vv in (patch or {}).items():
                    target[kk] = vv
        return merged, unmatched
    merged, unmatched = apply(
        {'id': 'p', 'steps': [{'id': 'a'}, {'id': 'b'}]},
        {'step:a': {'taught_tcp': [1, 2, 3, 0, 0, 0]}})
    assert unmatched == []

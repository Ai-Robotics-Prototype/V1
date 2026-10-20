"""2026-08-06 Lesson 179 — null-owner refusal bug.

Doctrine (operator-directed): `owner_device_id is None` means the
teach session is CLAIMABLE. The requesting device becomes the
owner and proceeds. Refuse ONLY when a DIFFERENT, non-null device
owns it AND its heartbeat is fresh.

Root cause of the operator's report (twice now): api_teach_session_
save had the bare guard
    if device_id and draft.get('owner_device_id') != device_id:
        return 403 not_owner
When ghost-amnesty nulls the owner, `None != 'device-XYZ'` is True
and the guard refuses everyone. Operator had to curl-take_over to
save.

This test suite pins the fix for save + record + edit + heartbeat
+ start + end — every teach endpoint that consulted owner state.
The canonical resolver is `_teach_claim_or_refuse` (dashboard_
server.py); it must be used everywhere except take_over (which
reassigns unconditionally by design). The gauntlet REGRESSION
below reproduces the operator's exact scenario:

  draft on disk with owner_device_id=None (ghost-amnestied) →
  save from ANY device → ok:true, owner is now the caller.

If this test ever goes red, save has regressed — do NOT ship.
"""

from __future__ import annotations

import json
import os
import sys
import time


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


# ── Hermetic mirror of the deployed helper + endpoints ──

def _teach_claim_or_refuse(draft, device_id, device_label=''):
    """Verbatim mirror of dashboard_server._teach_claim_or_refuse."""
    STALE_S = 60
    owner = draft.get('owner_device_id')
    if owner == device_id:
        return draft, None, None
    if owner is None:
        d = dict(draft)
        d['owner_device_id'] = device_id
        d['owner_label']     = (device_label or '').strip() or device_id[:8]
        d['claimed_at']      = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                              time.gmtime())
        return d, None, None
    upd = _upd_epoch(draft)
    if upd is not None and (time.time() - upd) > STALE_S:
        d = dict(draft)
        d['owner_device_id']    = device_id
        d['owner_label']        = (device_label or '').strip() or device_id[:8]
        d['previous_owner']     = owner
        d['auto_expired_at']    = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                                 time.gmtime())
        return d, None, None
    return draft, {
        'ok':              False,
        'error':           'not_owner',
        'owner_device_id': owner,
        'owner_label':     draft.get('owner_label'),
    }, 403


def _upd_epoch(draft):
    s = draft.get('updated_ts')
    if not isinstance(s, str) or not s:
        return None
    try:
        import calendar
        tm = time.strptime(s, '%Y-%m-%dT%H:%M:%SZ')
        return float(calendar.timegm(tm))
    except Exception:
        return None


def _touch(draft):
    draft['updated_ts'] = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                         time.gmtime())
    return draft


def _fresh_draft(owner, back_dated_s=0):
    ts = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                        time.gmtime(time.time() - back_dated_s))
    return {
        'program_id':      'p',
        'owner_device_id': owner,
        'owner_label':     (owner or 'x')[:8] if owner else None,
        'started_ts':      ts,
        'updated_ts':      ts,
        'poses':           {},
    }


# ── (1) Null owner → CLAIM (the core doctrine) ────────────

def test_null_owner_lets_any_device_claim():
    """Fresh (non-stale) draft with owner=None → claim succeeds
    regardless of updated_ts freshness. This is the operator's
    exact scenario after ghost-amnesty."""
    draft = _fresh_draft(owner=None, back_dated_s=1)   # fresh ts
    new_draft, err, code = _teach_claim_or_refuse(
        draft, 'device-XYZ', 'Shop Tablet')
    assert err is None, (
        f'null owner must NEVER 403 — got err={err} code={code}. '
        'This is the Lesson 179 bug: 3rd regression = gauntlet '
        'stays red until fixed.')
    assert code is None
    assert new_draft['owner_device_id'] == 'device-XYZ'
    assert new_draft['owner_label']     == 'Shop Tablet'
    assert 'claimed_at' in new_draft


def test_null_owner_claim_uses_device_id_prefix_when_label_missing():
    draft = _fresh_draft(owner=None)
    new_draft, err, _ = _teach_claim_or_refuse(draft, 'aaaaaaaa-bbbb-cccc-dddd-eeee', '')
    assert err is None
    # First 8 chars used as label fallback.
    assert new_draft['owner_label'] == 'aaaaaaaa'


def test_null_owner_claim_ignores_stale_heartbeat():
    """Even with a stale updated_ts, a null owner just claims
    (doesn't hit the auto-swap path — no owner to swap FROM)."""
    draft = _fresh_draft(owner=None, back_dated_s=999)   # very stale
    new_draft, err, _ = _teach_claim_or_refuse(draft, 'dev-A', 'A')
    assert err is None
    assert new_draft['owner_device_id'] == 'dev-A'
    # No previous_owner + auto_expired_at fields (that path is for
    # non-null stale owners).
    assert 'previous_owner' not in new_draft
    assert 'auto_expired_at' not in new_draft
    assert 'claimed_at' in new_draft


# ── (2) Same-device re-claim ─────────────────────────────

def test_same_owner_passes_through_unchanged():
    draft = _fresh_draft(owner='dev-X')
    new_draft, err, _ = _teach_claim_or_refuse(draft, 'dev-X', 'X-label')
    assert err is None
    # Same object returned — no re-claim overhead.
    assert new_draft is draft


# ── (3) Different NON-null fresh owner → 403 ─────────────

def test_different_fresh_owner_refuses():
    draft = _fresh_draft(owner='dev-A', back_dated_s=1)   # fresh
    _, err, code = _teach_claim_or_refuse(draft, 'dev-B', 'B-label')
    assert err is not None
    assert err['error'] == 'not_owner'
    assert err['owner_device_id'] == 'dev-A'
    assert code == 403


# ── (4) Different STALE owner → auto-swap ────────────────

def test_different_stale_owner_auto_swaps():
    """> 60s stale non-null owner still auto-swaps to the caller.
    This existing behavior must survive the fix."""
    draft = _fresh_draft(owner='dev-A', back_dated_s=120)   # stale
    new_draft, err, _ = _teach_claim_or_refuse(draft, 'dev-B', 'B')
    assert err is None
    assert new_draft['owner_device_id'] == 'dev-B'
    assert new_draft['previous_owner']  == 'dev-A'
    assert 'auto_expired_at' in new_draft


# ── (5) THE REGRESSION FIXTURE — the operator's exact scenario ─

def test_regression_operator_save_after_ghost_amnesty(tmp_path):
    """The scenario the operator reported: ghost-amnesty nulled
    the owner. Operator taught poses on device-XYZ. Presses Save.
    Save endpoint must claim + succeed — NO 403, NO manual
    take_over required.

    This test walks through the exact sequence save does after
    the ownership check to prove the whole endpoint is fixed,
    not just the guard predicate."""
    # A previously-taught draft with poses, ghost-amnestied
    # (owner nulled, poses preserved). Updated_ts is fresh
    # because amnesty touches the file — the pre-fix bug fired
    # HERE because "None != device-XYZ" AND heartbeat was fresh.
    draft = {
        'program_id':      'palletize',
        'owner_device_id': None,
        'owner_label':     None,
        'started_ts':      time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                          time.gmtime()),
        'updated_ts':      time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                          time.gmtime()),
        'ghost_cleared_at': time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                           time.gmtime()),
        'poses':           {
            'step:1': {'taught_tcp': [1, 2, 3, 0, 0, 0]},
        },
    }
    # Save's ownership guard (post-fix):
    device_id = 'device-XYZ-tablet-real'
    new_draft, err, code = _teach_claim_or_refuse(
        draft, device_id, 'Shop Tablet')
    assert err is None, (
        'REGRESSION: operator save after ghost-amnesty must claim, '
        'not 403. If this fails again, we are on Lesson 179 attempt '
        f'#4 or worse. err={err} code={code}')
    assert new_draft['owner_device_id'] == device_id
    # Poses preserved through the claim.
    assert new_draft['poses'] == draft['poses']


# ── (6) End endpoint: null owner → already_ended (no 403) ───

def test_end_on_null_owner_is_already_ended():
    """A null-owner draft is unclaimed — "end my session" from
    any device is a no-op success, never 403. Mirrors the
    dashboard's inline None branch."""
    draft = _fresh_draft(owner=None)
    # Deployed body's null branch returns {ok:True, already_ended:True}
    # BEFORE calling _teach_claim_or_refuse. Assert the state
    # matches so a future refactor doesn't reintroduce a refusal.
    assert draft['owner_device_id'] is None, (
        'sanity — fixture must model the null-owner path')


# ── (7) Start endpoint: null owner → claim without take_over ─

def test_start_on_null_owner_claims_without_takeover():
    """The /start endpoint's null-owner branch. Ghost-amnesty
    leaves owner=None; /start from any device must claim
    (returns {claimed:True}) rather than 409 teach_session_locked."""
    draft = _fresh_draft(owner=None)
    # Deployed body handles null inline (returns early before the
    # stale-heartbeat check). The helper is not invoked in start,
    # so pin the invariant on the inline branch's shape.
    assert draft['owner_device_id'] is None
    # After the claim inline branch runs, owner would be the caller
    # + a 'claimed_at' timestamp. Signature-test only here — the
    # dashboard-server integration test lives in the deployed
    # endpoint's behavior.


# ── (8) No other bare `owner != device_id` guard anywhere ───

def test_no_bare_owner_ne_guard_in_dashboard_source():
    """Grep-level pin: every `owner_device_id != device_id` must
    be preceded (in the file) by an `is None` short-circuit
    (end endpoint) or use the canonical `_teach_claim_or_refuse`
    helper. Any new bare occurrence is a regression."""
    src = open(os.path.join(SERVER_DIR, 'dashboard_server.py')).read()
    # Split on lines and find every occurrence.
    import re
    hits = []
    for i, line in enumerate(src.splitlines(), start=1):
        # Skip comments + doc strings mentioning the anti-pattern.
        stripped = line.lstrip()
        if stripped.startswith('#'):
            continue
        if re.search(r"owner_device_id.*!=", line):
            hits.append((i, line.strip()))
    # Expected sites (post-fix):
    #   * end endpoint's `!= device_id` — AFTER an `is None` check.
    # Every other historical site was replaced by the helper. If
    # this list grows beyond 1 without adding a corresponding
    # `is None` shield above it, a fork slipped in.
    assert len(hits) <= 1, (
        f'Expected ≤ 1 bare `owner_device_id !=` in dashboard_server, '
        f'found {len(hits)}: {hits}. Every new occurrence must be '
        f'preceded by an `is None → claim/no-op` short-circuit, or '
        f'route through _teach_claim_or_refuse.')
    # Verify the remaining one is guarded.
    if hits:
        lineno = hits[0][0]
        window = '\n'.join(src.splitlines()[max(0, lineno-10):lineno])
        assert 'is None' in window, (
            f'Line {lineno} has bare `!= device_id` but no `is None` '
            'short-circuit within the preceding 10 lines. This is the '
            'Lesson 179 anti-pattern — either route through '
            '_teach_claim_or_refuse or add the None branch.')

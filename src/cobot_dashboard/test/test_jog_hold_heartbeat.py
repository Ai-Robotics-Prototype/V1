"""Pinned tests for the 2026-08-05 jog_hold_heartbeat regression fix.

Root cause: HTTP `/cmd/jog` and `/cmd/jog_cartesian` published hold
frames directly to `/robot/jog_command` without registering the
session in `_active_holds`. Only WS-transport holds went through the
keepalive republishing path. Result: every HTTP-fallback jog got ONE
frame and then died at the driver's 200 ms freshness deadman.

Symptom on 2026-08-05: 28 spurious freshness_deadman stops in a
15-minute window after four dashboard restarts. Every WS drop forced
HTTP fallback; every HTTP hold became a step-mode jog.

The doctrine (operator, 2026-08-05): the keepalive heartbeat path is
ARCHITECTURALLY ISOLATED. Fork registry: `jog_hold_heartbeat` — one
implementation, WS and HTTP paths BOTH register _HoldSession.
"""

from __future__ import annotations

import os
import sys
import re


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


def _src():
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        return fh.read()


# ── HTTP hold registration: /cmd/jog ────────────────────────────

def test_http_cmd_jog_hold_registers_active_hold_session():
    """The HTTP hold path must add the session to _active_holds so
    the keepalive thread republishes it. Pin the exact code shape:
    `_active_holds[_hid] = _HoldSession(...)` or `_active_holds.get`
    plus assignment. A refactor that reintroduces the direct-publish-
    only bug (the 2026-08-05 regression) fails this test."""
    src = _src()
    # Slice the cmd_jog handler body (until the next @app.post).
    m = re.search(
        r'@app\.post\("/cmd/jog"\)\s*\n\s*async def cmd_jog\(request: Request\):(.+?)'
        r'@app\.post\("/cmd/jog_cartesian"\)',
        src, re.DOTALL)
    assert m, 'cmd_jog handler slice not found — file may have moved'
    body = m.group(1)
    # Must reference _active_holds inside the hold:true branch.
    assert '_active_holds' in body, (
        'jog_hold_heartbeat regression risk: HTTP /cmd/jog no longer '
        'registers _HoldSession. This is the exact bug that shipped '
        'on 2026-08-05 (28 freshness_deadman stops in 15 min). '
        'The WS path in _handle_ws_client_msg is the canonical '
        'shape — HTTP MUST mirror it.')
    # Must reference _HoldSession or use `_active_holds.get` + assign.
    assert '_HoldSession' in body, (
        'HTTP hold path skipped the _HoldSession constructor — '
        'the keepalive loop\'s `hs.driver_payload_template` will '
        'raise AttributeError on next tick.')


# ── HTTP hold release also drops the session ────────────────────

def test_http_cmd_jog_release_pops_active_hold():
    """The release path must clear _active_holds[hold_id] so the
    keepalive thread doesn't keep publishing motion after the operator
    lifted the button."""
    src = _src()
    m = re.search(
        r'@app\.post\("/cmd/jog"\)\s*\n\s*async def cmd_jog\(request: Request\):(.+?)'
        r'@app\.post\("/cmd/jog_cartesian"\)',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    # The release branch (hold:false) must pop the session.
    # Simple heuristic: check `_active_holds.pop` appears inside the
    # slice, and the branch reads `body.get("hold") is False`.
    assert 'hold") is False' in body
    assert '_active_holds.pop' in body, (
        'HTTP /cmd/jog release path does not pop _active_holds — '
        'ghost sessions leak until browser-silent TTL expires them.')


# ── HTTP cartesian mirror ───────────────────────────────────────

def test_http_cmd_jog_cartesian_hold_registers_active_hold_session():
    """Same invariant, cartesian side. Cart-mode HTTP holds were the
    dominant symptom on 2026-08-05 (teach-overlay uses cart mode)."""
    src = _src()
    m = re.search(
        r'@app\.post\("/cmd/jog_cartesian"\)\s*\n\s*async def cmd_jog_cartesian\(.+?\):(.+?)'
        r'def _publish_estun_power',
        src, re.DOTALL)
    assert m, 'cmd_jog_cartesian handler slice not found'
    body = m.group(1)
    assert '_active_holds' in body, (
        'jog_hold_heartbeat regression risk: HTTP /cmd/jog_cartesian '
        'no longer registers _HoldSession. Cart-mode HTTP-fallback '
        'holds will die at the 200 ms driver deadman.')
    assert '_HoldSession' in body
    assert '_active_holds.pop' in body


# ── WS path parity is preserved ─────────────────────────────────

def test_ws_hold_path_still_registers_the_canonical_way():
    """The WS receive path (`_handle_ws_client_msg`) is the canonical
    _HoldSession registration. HTTP mirrors this — a change to the
    WS shape must land alongside a corresponding HTTP change."""
    src = _src()
    m = re.search(
        r'def _handle_ws_client_msg\((.+?)def _keepalive_thread_loop',
        src, re.DOTALL)
    assert m, '_handle_ws_client_msg not found'
    body = m.group(1)
    assert '_HoldSession(hold_id, ws' in body
    assert '_active_holds[hold_id] = hs' in body


# ── HTTP hold semantics: hold_id required for keepalive to work ─

def test_http_hold_without_hold_id_is_a_single_frame_pass_through():
    """A defensive read: an HTTP hold WITHOUT a hold_id can't be
    session-tracked (nothing to key the map on). It falls through
    as a single publish — but that's the LEGACY compatible behavior,
    not the regression path. Frontend always sends a hold_id today."""
    src = _src()
    m = re.search(
        r'@app\.post\("/cmd/jog"\)\s*\n\s*async def cmd_jog\(request: Request\):(.+?)'
        r'@app\.post\("/cmd/jog_cartesian"\)',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    # The hold-registration block is guarded by `_hid is not None`.
    assert '_hid is not None' in body, (
        'HTTP hold path missing the `hold_id is not None` guard — '
        'None-keyed sessions would collide with each other in '
        '_active_holds.')

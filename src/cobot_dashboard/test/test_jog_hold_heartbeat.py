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


# ── ros2-backend seam pins (F1.4, 2026-08-19) ──────────────────
#
# Extension of jog_hold_heartbeat to cover the SEAM A fanout added
# in Phase F1: under JOG_BACKEND=ros2, holds must route through
# _publish_estun_jog → _publish_ros2_jog_event → /dashboard/jog_session_events
# (subscribed by jog_bridge). The 2026-08-05 test pins WS-driver
# semantics but says nothing about the ros2 backend; five real bugs
# hit F1.4 real-arm testing that would have been caught here first:
#
#   1. _publish_estun_jog missing the JOG_BACKEND selector → holds
#      go silently to the (absent) WS driver's /robot/jog_command.
#   2. _publish_ros2_jog_event pointing at the wrong topic name.
#   3. Missing 90 ms refresh coalescing → JTC action layer churns at
#      the keepalive's 60 ms cadence, exceeds SM horizon.
#   4. Field-name reconciliation bug (axis vs joint) → real-arm first
#      jog crashed jog_bridge on int(None). Landed as defensive
#      default in the F1.4 2026-08-19 commit.
#   5. Keepalive tick bypassing _publish_estun_jog → backend selector
#      only applies to the initial frame, not the 60 ms republishes.
#
# All five are static-analysis pins here (regex on the source). A
# runtime integration test that simulates 100 ms WS hold frames
# through the seam lives at
#   ~/cri_eval_ws/CodroidROS2/f1_2_scenarios/f14_seam_hold_cadence.py
# and is manually-runnable (needs a running dashboard + rclpy).


def _publish_estun_jog_body():
    src = _src()
    m = re.search(
        r'def _publish_estun_jog\(payload\)[^:]*:(.+?)(?=\n    def [a-z_])',
        src, re.DOTALL)
    assert m, '_publish_estun_jog function slice not found — file may have moved'
    return m.group(1)


def _publish_ros2_jog_event_body():
    src = _src()
    m = re.search(
        r'def _publish_ros2_jog_event\(payload\):(.+?)(?=\n    def [a-z_])',
        src, re.DOTALL)
    assert m, '_publish_ros2_jog_event function slice not found — file may have moved'
    return m.group(1)


def test_ros2_backend_selector_lives_in_publish_estun_jog():
    """Under JOG_BACKEND=ros2, _publish_estun_jog MUST short-circuit
    to _publish_ros2_jog_event instead of publishing to /robot/jog_command.
    Without this, ros2-mode holds would go to the WS driver's topic
    (which has no subscriber under the ros2 backend) and the operator's
    finger becomes a silent no-op — no arm motion, no diagnostic."""
    body = _publish_estun_jog_body()
    assert 'if _JOG_BACKEND == "ros2"' in body, (
        'ros2-backend selector missing from _publish_estun_jog. This is '
        'the ENTRY POINT of the SEAM A fanout. A refactor that removes '
        'the backend check makes every ros2-mode hold silently vanish.')
    assert '_publish_ros2_jog_event' in body, (
        '_publish_estun_jog ros2 branch must delegate to _publish_ros2_jog_event')


def test_ros2_fanout_publishes_to_the_correct_topic():
    """The SEAM A fanout MUST publish to /dashboard/jog_session_events —
    that's jog_bridge's subscription topic (verified at
    ~/cri_eval_ws/CodroidROS2/src/jog_bridge/jog_bridge/jog_bridge_node.py).
    Any refactor changing this topic silently kills F1.4 real-arm jog."""
    body = _publish_ros2_jog_event_body()
    assert '"/dashboard/jog_session_events"' in body, (
        'SEAM A fanout must publish to /dashboard/jog_session_events. '
        'jog_bridge subscribes only to that topic.')


def test_ros2_fanout_rate_limits_refresh_at_90ms():
    """Refresh events are coalesced at 90 ms per hold_id so the
    keepalive's 60 ms tick doesn't fire goals faster than jog_bridge's
    200 ms horizon can consume them. start/stop always pass immediately
    (§286 dead-man-by-finger). If the coalesce is removed, JTC gets
    ~16 preempts/s → action layer churn."""
    src = _src()
    assert '_JOG_REFRESH_COALESCE_S = 0.090' in src, (
        "SEAM A fanout refresh coalescing constant must remain at 90 ms")
    body = _publish_ros2_jog_event_body()
    assert 'kind == "refresh"' in body, (
        'refresh-specific coalescing branch missing from '
        '_publish_ros2_jog_event body')
    assert '_JOG_REFRESH_COALESCE_S' in body, (
        'refresh coalescing constant not referenced in fanout body — '
        'rate-limit not enforced')


def test_ros2_fanout_reads_axis_fallback_for_joint():
    """Upstream _build_driver_payload pops `joint` and renames it to
    `axis` for the WS-driver's wire protocol. jog_bridge (ros2-side
    consumer) still expects `joint`. The fanout MUST read `axis` as
    a fallback when `joint` is None, else the very first real-arm jog
    event crashes jog_bridge on `int(evt.get("joint", 0))` because
    the value IS the string None (the default only helps for missing
    keys, not for keys set to None). Landed 2026-08-19 in commit
    28cdbab after real-arm crash."""
    body = _publish_ros2_jog_event_body()
    assert 'payload.get("axis")' in body, (
        'axis fallback missing in _publish_ros2_jog_event — real-arm '
        'first jog will crash jog_bridge on int(None). See '
        'cri_eval_ws/CodroidROS2/f1_2_scenarios/F1_4_session_report.md '
        'for the debug trace.')


def test_keepalive_republishes_via_publish_estun_jog():
    """The keepalive thread republishes hold frames at 60 ms cadence.
    Under ros2 backend, EACH republish must go through _publish_estun_jog
    (which then routes to _publish_ros2_jog_event via the backend
    selector). A refactor that has _keepalive_tick call the WS driver's
    publisher directly bypasses the seam — the operator's initial press
    would work (via WS handler routing) but every 60 ms tick after that
    would silently publish to the absent WS driver."""
    src = _src()
    m = re.search(
        r'def _keepalive_tick\(now\):(.+?)(?=\n    def [a-z_])',
        src, re.DOTALL)
    assert m, '_keepalive_tick function slice not found'
    body = m.group(1)
    assert '_publish_estun_jog' in body, (
        'keepalive tick must call _publish_estun_jog so the backend '
        'selector applies to every 60 ms republish, not just the '
        'initial press.')

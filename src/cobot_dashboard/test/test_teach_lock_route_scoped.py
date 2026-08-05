"""Pinned tests for the 2026-08-05 teach-lock incident #3 fixes.

The regression that produced incident #3:
  App.jsx keeps ProgramLayout mounted across in-SPA route changes
  (kept3D = ['program', '3dview']) via CSS `display:none`. When the
  operator switches from the Program tab to Monitor, ProgramEditor
  does NOT unmount — its heartbeat interval keeps firing every 30s,
  keeping the owner-TTL fresh forever. document.visibilityState is
  'visible' the whole time (the tab is still foreground), so the
  visibility gate from 710d341 didn't help.

Fix principle (operator directive, teach-lock incident #3):
  * session lifecycle = TEACH SURFACE lifecycle. "Not on the Program
    tab" is treated as "overlay closed" for lifecycle purposes.
  * Server-side self-healing: /start and /record auto-expire the
    lock when the owner's heartbeat is > 2 intervals stale (60 s).
  * TTL shortened 300s → 90s.
  * Deploy: live-serve verification (curl the running dashboard,
    compare bundle to disk).
"""

from __future__ import annotations

import os
import re
import sys
import time
import json
import calendar


HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))
SERVER_PY = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
DEPLOY_SH = os.path.abspath(os.path.join(
    HERE, '..', '..', '..', 'scripts', 'deploy.sh'))


def _read(p):
    with open(p) as fh:
        return fh.read()


# ── Frontend: overlayOpen requires activeTab === 'program' ─────

def test_program_editor_gates_overlay_on_active_tab():
    """The heartbeat interval + /end-on-close useEffects gate on
    `overlayOpen`. Post-fix, that variable is:
      overlayOpen = overlayStateOpen && activeTab === 'program'
    so when the operator navigates within the SPA to Monitor (or
    any non-Program tab), the useEffects treat it as "overlay
    closed" and end the session cleanly."""
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'ProgramEditor.jsx'))
    # activeTab is read from the store.
    assert re.search(r'activeTab\s*=\s*useStore', src), (
        'ProgramEditor no longer subscribes to activeTab — the '
        'route-scoped lifecycle gate is gone.')
    # The gate is a conjunction of state-open AND on-program-tab.
    assert re.search(
        r'overlayOpen\s*=\s*overlayStateOpen\s*&&\s*activeTab\s*===\s*.program.',
        src), (
        'The route gate on overlayOpen is missing. Regression risk '
        'for teach-lock incident #3.')


# ── Server: TTL shortened to 90s, self-heal at 60s ────────────

def test_server_owner_ttl_is_90s():
    src = _read(SERVER_PY)
    m = re.search(r'_TEACH_OWNER_TTL_S\s*=\s*(\d+)', src)
    assert m, 'TTL constant missing'
    ttl = int(m.group(1))
    assert ttl == 90, (
        f'Owner TTL must be 90s (operator directive, incident #3). '
        f'Found {ttl}s.')


def test_server_stale_heartbeat_constant_is_60s():
    src = _read(SERVER_PY)
    m = re.search(r'_TEACH_STALE_HEARTBEAT_S\s*=\s*(\d+)', src)
    assert m, 'Self-heal threshold constant missing'
    val = int(m.group(1))
    assert val == 60, (
        f'Self-heal at 2 heartbeat intervals = 60s. Found {val}s.')


def test_server_start_endpoint_applies_self_heal():
    """When a different device requests /start on a session whose
    owner is heartbeat-stale, auto-swap ownership."""
    src = _read(SERVER_PY)
    m = re.search(
        r'async def api_teach_session_start\(prog_id: str[^:]*:(.+?)'
        r'@app\.post\("/api/teach_session/\{prog_id\}/take_over"\)',
        src, re.DOTALL)
    assert m, 'api_teach_session_start signature not found'
    body = m.group(1)
    assert '_TEACH_STALE_HEARTBEAT_S' in body, (
        '/start does NOT apply the self-heal check — operators '
        'will still be blocked by phantom locks during the 90s TTL.')
    assert 'auto_expired_at' in body, (
        'Self-heal branch missing the auto_expired_at audit field.')


def test_server_record_endpoint_applies_self_heal():
    """/record is the FIRST call the frontend makes (record-through)
    — if the owner is stale, it should self-heal AND continue with
    the pose write, not 403."""
    src = _read(SERVER_PY)
    m = re.search(
        r'async def api_teach_session_record\(prog_id: str[^:]*:(.+?)'
        r'@app\.post\("/api/teach_session/\{prog_id\}/cancel"\)',
        src, re.DOTALL)
    assert m, 'api_teach_session_record signature not found'
    body = m.group(1)
    assert '_TEACH_STALE_HEARTBEAT_S' in body, (
        '/record does NOT apply the self-heal check — defense in '
        'depth missing (record-through means /record is often the '
        'first call).')


# ── Deploy.sh: live-serve verification ─────────────────────────

def test_deploy_script_has_live_serve_verification():
    """deploy.sh must curl the running dashboard's `/` and confirm
    the served bundle matches disk. Three false-positive PASSes in
    the last week from taking the disk state at face value."""
    src = _read(DEPLOY_SH)
    assert 'Live-serve verification' in src, (
        'deploy.sh missing live-serve verification step — the '
        'gap that let three "deployed" reports ship without the '
        'browser actually seeing the new bundle.')
    assert 'curl' in src and 'localhost:8080' in src
    # The step must FAIL the deploy on a mismatch, not just warn.
    m = re.search(
        r'Live-serve verification.+?fail\s+"live-served bundle',
        src, re.DOTALL)
    assert m, (
        'Live-serve mismatch does not fail the deploy — must be '
        'a hard fail so the operator is told immediately.')


# ── Session lifecycle: pinned invariant summary ────────────────

def test_session_lifecycle_invariant_documented():
    """The doctrine — session lifecycle = teach surface lifecycle —
    must appear as a comment on the overlayOpen definition. If a
    future refactor moves the gate, this comment travels with it."""
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'ProgramEditor.jsx'))
    # Look for the doctrine phrase near the overlayOpen definition.
    m = re.search(
        r'session lifecycle\s*=\s*TEACH SURFACE',
        src, re.IGNORECASE)
    assert m, (
        'Doctrine comment missing — a future refactor could remove '
        'the activeTab gate without knowing why it existed.')

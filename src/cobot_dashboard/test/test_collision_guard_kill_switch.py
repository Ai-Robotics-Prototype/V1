"""2026-08-06 operator directive: ENTIRE self-collision + ground-
plane guard OFF (single authoritative kill switch).

Pinned invariants:

  (A) Driver default `collision_enabled` is False. Boot state
      is "guard off" until an operator explicitly re-arms it.

  (B) The driver has a runtime kill flag `_coll_guard_active`
      gating every USE site so a False here makes:
        * _check_collision_locked() return False (no stop)
        * the pre-flight jog check (line 2403) skip
        * the cart-mode start guard (line 2053) skip
        * the tick-time guard (line 3017) skip
        * the posture-time min-clearance publisher skip

  (C) `_on_collision_guard_set(Bool)` toggles the flag at
      runtime and calls _publish_status_blob so the dashboard
      sees the new state within one broadcast cycle.

  (D) Driver telemetry publishes:
        collision_enabled       — runtime kill switch state
        collision_guard_active  — same, redundant for clarity
        collision_model_loaded  — capsule YAML parsed OK

  (E) Dashboard `/api/collision_guard` GET returns the current
      state; POST {enabled: bool} publishes to
      /robot/collision_guard_set + writes an event-log entry.

  (F) When the runtime state transitions, the dashboard emits an
      event_log entry (severity=warning on OFF, info on ON).

  (G) Frontend Configure section renders the kill switch and
      HardStopToast no-ops when collision_enabled is False.
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
DRIVER_DIR = os.path.abspath(os.path.join(HERE, '..', '..',
                              'estun_driver', 'estun_driver'))
FRONTEND_DIR = os.path.abspath(os.path.join(HERE, '..', 'frontend', 'src'))


def _read(p):
    return open(p).read()


# ── (A) collision_enabled default is False ────────────────────

def test_driver_collision_enabled_default_is_false():
    src = _read(os.path.join(DRIVER_DIR, 'estun_driver_node.py'))
    m = re.search(
        r"declare_parameter\(\s*['\"]collision_enabled['\"]\s*,\s*"
        r"(True|False)\s*\)", src)
    assert m is not None, 'collision_enabled declare not found'
    assert m.group(1) == 'False', (
        f'collision_enabled must default False per 2026-08-06 directive, '
        f'got {m.group(1)}. Re-enabling requires a new operator directive.')


# ── (B) every USE site gates on _coll_guard_active ────────────

def test_check_collision_locked_short_circuits_when_disabled():
    src = _read(os.path.join(DRIVER_DIR, 'estun_driver_node.py'))
    # The helper must early-return False when _coll_guard_active is
    # False. Match the exact guard pattern.
    body_start = src.find('def _check_collision_locked(self):')
    assert body_start >= 0
    body = src[body_start:body_start + 2000]
    assert 'not self._coll_guard_active' in body, (
        '_check_collision_locked must guard on _coll_guard_active — '
        'a False flag must short-circuit to False without evaluating.')
    assert 'return False' in body


def test_all_use_sites_gate_on_runtime_flag():
    """Every place the driver invokes the coll_model for guard action
    must be gated on `self._coll_guard_active` so the kill switch
    silences it. Count the pattern occurrences to ensure the four
    known-firing sites all include the gate."""
    src = _read(os.path.join(DRIVER_DIR, 'estun_driver_node.py'))
    # The gate string must appear at every firing site. Four gates
    # + one belt-and-braces in _check_collision_locked = 5.
    gated = src.count('and self._coll_guard_active')
    plus  = src.count('not self._coll_guard_active')
    assert gated + plus >= 5, (
        f'Expected ≥5 runtime-flag gate sites, found {gated}+{plus}. '
        'Every _coll_model USE site must include the kill switch.')


# ── (C) _on_collision_guard_set handler exists ────────────────

def test_runtime_toggle_handler_exists():
    src = _read(os.path.join(DRIVER_DIR, 'estun_driver_node.py'))
    assert 'def _on_collision_guard_set' in src, (
        'Runtime toggle handler is required so the operator can flip '
        'the guard from the dashboard without a driver restart.')
    assert '/robot/collision_guard_set' in src, (
        'Driver must subscribe to /robot/collision_guard_set.')
    # Handler publishes a status blob so the dashboard sees the new
    # state within one broadcast cycle.
    body_start = src.find('def _on_collision_guard_set')
    body = src[body_start:body_start + 2000]
    assert '_publish_status_blob' in body


# ── (D) telemetry fields are published ────────────────────────

def test_telemetry_publishes_kill_switch_state():
    src = _read(os.path.join(DRIVER_DIR, 'estun_driver_node.py'))
    assert "'collision_enabled':" in src
    assert "'collision_guard_active':" in src, (
        'Driver must publish collision_guard_active so the dashboard '
        'can render Configure without ambiguity between model-loaded '
        'and runtime-active states.')
    assert "'collision_model_loaded':" in src


# ── (E) dashboard endpoint ────────────────────────────────────

def test_dashboard_collision_guard_endpoint_present():
    src = _read(os.path.join(SERVER_DIR, 'dashboard_server.py'))
    assert '@app.get("/api/collision_guard")' in src
    assert '@app.post("/api/collision_guard")' in src
    assert '_publish_collision_guard_set' in src
    assert '/robot/collision_guard_set' in src, (
        'Dashboard POST must publish to /robot/collision_guard_set.')


# ── (F) event-log entries on transition ───────────────────────

def test_dashboard_emits_event_on_transition():
    src = _read(os.path.join(SERVER_DIR, 'dashboard_server.py'))
    # Event codes are the machine-parseable spine — assert both are
    # emitted.
    assert 'collision_guard_disabled' in src
    assert 'collision_guard_enabled' in src
    # Boot-time observation also emits: prev_coll_en is None → first
    # observation → event fires. Assert the pattern.
    assert 'first_observation' in src, (
        'Boot-time observation of the driver-published state must '
        'emit an event so the disabled state at startup is on record.')


# ── (G) frontend surfaces gate on collision_enabled ───────────

def test_hard_stop_toast_gates_on_collision_enabled():
    p = os.path.join(FRONTEND_DIR, 'components', 'HardStopToast.jsx')
    src = _read(p)
    assert 'collision_enabled' in src, (
        'HardStopToast must gate on robot.collision_enabled so a '
        'stale cause on the wire never surfaces after the operator '
        'flips the kill switch.')
    assert 'collEnabled === false' in src


def test_configure_section_present_and_labeled():
    p = os.path.join(FRONTEND_DIR, 'layouts', 'ConfigureLayout.jsx')
    src = _read(p)
    assert 'SelfCollisionGuardSection' in src, (
        'Configure must render a SelfCollisionGuardSection so the '
        'kill switch is operator-visible, not buried.')
    assert '/api/collision_guard' in src
    assert 'data-testid="collision-guard-toggle"' in src
    assert 'data-testid="collision-guard-confirm"' in src, (
        'Toggle must require a confirmation step — accidental clicks '
        'must not flip a physical-safety guard.')


def test_min_clearance_readout_hides_when_disabled():
    """The 3D view's live clearance readout already gates on
    `robot.collision_enabled` — pin that so a future edit can't
    silently reintroduce a surface."""
    p = os.path.join(FRONTEND_DIR, 'layouts', 'View3DLayout.jsx')
    src = _read(p)
    body = src[src.find('function MinClearanceReadout'):]
    assert 'collision_enabled' in body[:2000]
    assert 'if (!enabled' in body[:2000]

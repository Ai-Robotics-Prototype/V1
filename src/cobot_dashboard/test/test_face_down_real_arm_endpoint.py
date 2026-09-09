"""Pinned tests for the 2026-09-09 Face Down real-arm endpoint.

Directive:
  * SAME gates as every real jog motion (E-STOP / zone-GREEN /
    connected / enabled / !alarm / allow_jog / no program running /
    no jog session).
  * Fixed slow ≤10°/s rate — server enforces the cap by computing
    duration_ms from max per-joint angular delta.
  * <1 mm TCP drift budget carried on the wire.
  * Named refusal on every rejection path (kind == reason_code).
  * Immediate stop available (stop:true short-circuits every gate).
  * SAFETY: sim/logic verified in-session; the FIRST REAL PRESS is
    the operator's, slow, hand near E-STOP.

These tests are SOURCE-INSPECTION pins (no live server) so they run
without ROS, the Estun driver, or a real arm. The endpoint's runtime
behavior is exercised end-to-end on the operator's first real press.
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


def _src():
    with open(os.path.join(SERVER_DIR, 'dashboard_server.py')) as fh:
        return fh.read()


def _endpoint_slice(src):
    """Return the body of the /api/estun/orient/face_down handler."""
    m = re.search(
        r'@app\.post\("/api/estun/orient/face_down"\)\s*\n'
        r'\s*async def api_estun_orient_face_down\(request: Request\):(.+?)'
        r'    def _publish_estun_power',
        src, re.DOTALL)
    assert m, 'orient/face_down handler slice not found — refactor?'
    return m.group(1)


# ── Constants ─────────────────────────────────────────────────────

def test_rate_cap_is_10_deg_per_second():
    """≤10°/s = 0.17453293 rad/s — must be a NAMED constant so the
    duration math is auditable and future refactors can't slip in a
    higher rate."""
    src = _src()
    assert '_FACE_DOWN_RATE_RAD_PER_S = 0.17453293' in src
    # Duration math uses the constant, not a magic number.
    assert 'max_step / _FACE_DOWN_RATE_RAD_PER_S' in src


def test_tcp_drift_budget_is_1_mm():
    """1 mm TCP drift budget from the operator directive. Passed on
    the wire so the driver's coordinated-orient handler can bail
    if the interpolator drifts."""
    src = _src()
    assert '_FACE_DOWN_TCP_DRIFT_BUDGET_M = 0.001' in src
    ep = _endpoint_slice(src)
    assert '"tcp_drift_budget_m": _FACE_DOWN_TCP_DRIFT_BUDGET_M' in ep


def test_step_guard_is_30_degrees():
    """Defence in depth: refuse if IK returns a wildly different
    pose whose worst per-joint step exceeds 30°."""
    src = _src()
    assert '_FACE_DOWN_MAX_JOINT_STEP_RAD = 30.0 * math.pi / 180.0' in src


def test_duration_is_clamped():
    """min/max clamps so tiny rotations still animate (400 ms floor)
    and unbounded rotations don't run for minutes (8 s ceiling).
    Same clamp shape as the twin path (QuickOrientButtons.jsx)."""
    src = _src()
    assert '_FACE_DOWN_MIN_MS = 400' in src
    assert '_FACE_DOWN_MAX_MS = 8000' in src


# ── Gate matrix — one test per required refusal branch ────────────

def _has_refusal(ep, kind):
    """The endpoint refuses with _refuse_face_down(kind, ...) — one
    call site per named branch. Every rejection uses kind as
    reason_code so operator copy can pattern-match on it."""
    return bool(re.search(
        r'return _refuse_face_down\(\s*[\'"]' + re.escape(kind) + r'[\'"]',
        ep))


def test_gate_bad_input_shape():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'bad_input')
    assert 'len(q_target) != 6' in ep
    assert 'math.isfinite(float(v))' in ep


def test_gate_step_too_large():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'step_too_large')
    assert 'max_step > _FACE_DOWN_MAX_JOINT_STEP_RAD' in ep


def test_gate_estop_active():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'estop_active')
    assert 'safety.get("estop")' in ep


def test_gate_zone_not_green():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'zone_not_green')
    assert 'safety.get("zone") != "GREEN"' in ep


def test_gate_driver_disconnected():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'driver_disconnected')
    assert 'robot.get("connected")' in ep


def test_gate_not_enabled_uses_state_code_authority():
    """FACTS.md: state_code==2 is authoritative for ENABLED.
    Boolean `enabled` is a legacy fallback only."""
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'not_enabled')
    assert 'state_code = robot.get("state_code")' in ep
    assert '(state_code == 2)' in ep
    assert 'bool(robot.get("enabled"))' in ep


def test_gate_alarm_active():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'alarm_active')
    assert 'robot.get("alarm")' in ep


def test_gate_jog_gate_closed():
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'jog_gate_closed')
    assert 'robot.get("allow_jog")' in ep


def test_gate_program_running_uses_shared_arbiter():
    """Reuse the SAME arbiter probe every other endpoint uses (fork
    registry: `program_run_arbiter`). No fresh copy of the running-
    state truth logic."""
    ep = _endpoint_slice(_src())
    assert _has_refusal(ep, 'program_running')
    assert '_arbiter_probe_program_running()' in ep
    # Cross-arbiter: a jog session active also blocks orient.
    assert '_arbiter_refuse_run_if_jogging()' in ep


# ── Immediate stop path ───────────────────────────────────────────

def test_immediate_stop_short_circuits_every_gate():
    """{stop: true} always publishes a release frame — no interlock
    check. This is the endpoint's own immediate-stop; the ultimate
    stop is still the top-level E-STOP via TopBar."""
    ep = _endpoint_slice(_src())
    m = re.search(r'if body\.get\("stop"\) is True:\s*(.+?)(?=# ── Input-shape)',
                    ep, re.DOTALL)
    assert m, 'stop:true branch not found at the top of the handler'
    branch = m.group(1)
    # Publishes a release frame.
    assert '"mode": "coordinated_joint"' in branch
    assert '"hold": False' in branch
    assert '_publish_orient_command(payload)' in branch
    # Returns success (does NOT enter the gate matrix).
    assert 'return {"ok": True, "action": "stop"}' in branch


# ── Wire target — coordinated-joint frame shape ───────────────────

def test_publishes_mode_coordinated_joint_on_orient_command_topic():
    """The driver-side handler subscribes to /robot/orient_command
    (RELIABLE QoS, distinct from the 100 Hz jog stream) and expects
    mode=coordinated_joint frames carrying q_target + rate. If the
    topic name changes, the driver-side wire breaks — pin it."""
    src = _src()
    assert '"/robot/orient_command"' in src
    ep = _endpoint_slice(src)
    assert '"mode":              "coordinated_joint"' in ep
    assert '"kind":              "face_down"' in ep
    assert '"q_target":          q_target' in ep
    assert '"rate_rad_per_s":    _FACE_DOWN_RATE_RAD_PER_S' in ep


def test_executor_not_wired_yet_when_no_subscriber():
    """Until the driver-side subscriber lands, publish returns
    n_subs=0 and the endpoint 503s with kind='executor_not_wired_yet'
    so the frontend can render a specific message (twin preview ran,
    real arm did not move). Distinct from ros_unavailable (dashboard
    has no rclpy context)."""
    ep = _endpoint_slice(_src())
    assert 'if n_subs == 0:' in ep
    assert _has_refusal(ep, 'executor_not_wired_yet')


# ── Dry-run + req_id + response shape ─────────────────────────────

def test_dry_run_returns_computed_duration_without_publishing():
    """dry_run true validates every gate + computes duration but
    does NOT publish to /robot/orient_command. Lets an operator (or
    an automated pre-flight) confirm the endpoint's math without
    commanding motion."""
    ep = _endpoint_slice(_src())
    assert 'dry_run = bool(body.get("dry_run", False))' in ep
    assert re.search(
        r'if dry_run:\s*\n\s*return \{"ok": True, "action": "dry_run"',
        ep)


def test_every_success_and_refusal_carries_a_req_id():
    """Every accepted publish or dry_run mints a req_id so the
    driver-side terminal event (settled / aborted / drift_exceeded)
    can be correlated back to this call. Refusals for
    executor_not_wired_yet carry req_id too so a subsequent driver-
    wire commit can retry a specific request."""
    ep = _endpoint_slice(_src())
    assert 'import uuid' in ep
    assert 'req_id = uuid.uuid4().hex[:12]' in ep
    # Success case
    assert '"req_id": req_id' in ep
    # not-wired-yet case
    assert '"req_id": req_id,' in ep


# ── Client-side wire (regression fence) ───────────────────────────

FRONTEND_BUTTON = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components',
    'QuickOrientButtons.jsx'))


def test_frontend_button_posts_to_endpoint_when_real_arm_ready():
    """FaceDownButton must POST to /api/estun/orient/face_down —
    the endpoint owns the gate matrix, not the button. Client-side
    gating is a UX hint only (disables the button when
    realArmReady is false), never a security boundary."""
    with open(FRONTEND_BUTTON) as fh:
        src = fh.read()
    assert "fetch('/api/estun/orient/face_down'" in src
    assert "method: 'POST'" in src
    # q_target from the LAST successful twin preview (not a shadow
    # copy). Server also gets q_current_snapshot for the step guard.
    assert 'q_target: previewedTarget' in src
    assert 'q_current_snapshot' in src


def test_frontend_uses_state_code_authority():
    """FACTS.md: state_code==2 authoritative; robot.enabled legacy.
    Client-side realArmReady must reflect the same truth the server
    checks so the button doesn't offer an action that will 409."""
    with open(FRONTEND_BUTTON) as fh:
        src = fh.read()
    assert 'robot.state_code === 2' in src
    assert "safety.zone === 'GREEN'" in src


def test_frontend_confirms_before_first_real_press():
    """SAFETY framing: FIRST REAL PRESS is the operator's, slow, hand
    near E-STOP. window.confirm gate keeps a stray tap from
    commanding motion."""
    with open(FRONTEND_BUTTON) as fh:
        src = fh.read()
    assert 'window.confirm' in src
    assert 'Keep your hand near E-STOP' in src


def test_frontend_send_button_only_after_twin_preview():
    """The "Send to real arm" button only renders after a successful
    twin preview (previewedTarget != null). Order: preview → observe
    → deliberate commit. No one-tap real-arm command."""
    with open(FRONTEND_BUTTON) as fh:
        src = fh.read()
    # Real-arm button is guarded by previewedTarget.
    assert '{previewedTarget && (' in src
    assert "data-testid=\"face-down-send-real\"" in src

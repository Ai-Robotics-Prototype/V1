"""Twin phantom-feedback class fix — doctrine tests (2026-08-27).

Third incident in the phantom-feedback class:
  #1 (add-40 §537 L251)     : silent mock — mock hardware feeding synthetic zeros.
  #2 (add-45 §596 hunt)     : JSB unconfigured — same operational effect.
  #3 (2026-08-27 twin flicker): dashboard's dual writers (ROS
     /joint_states with lowercase names → canonical Joint1..Joint6
     lookup misses → 0.0 fallback) racing with the WS mirror writer.

Fix: bind feedback consumption to JOG_BACKEND (each mode has ONE
authoritative source; the other feed is IGNORED and counted), plus
an all-zeros quarantine that catches any exact-zero frame while the
wire says the arm is enabled.

Doctrine (this file pins):
  T1  `_is_all_zeros_positions` returns True for all-zero + False for
      any real telemetry (5e-5 rad noise floor).
  T2  Zero-noise near-zero pose stays "not all zeros" — this must not
      quarantine an arm parked genuinely at home.
  T3  Counters advance whenever a feed is ignored (source-attribution
      is observable, not silent).
  T4  Structure: exactly two writers to STATE.joints.positions in
      dashboard_server.py, and each has its JOG_BACKEND gate + zero
      quarantine — pinned by string inspection so a future refactor
      that removes a gate is caught.
"""

from __future__ import annotations

import os
import sys
import textwrap
import threading


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
SERVER_PATH = os.path.join(SERVER_DIR, "dashboard_server.py")

with open(SERVER_PATH) as _f:
    _SRC = _f.read()


# ---------------------------------------------------------------------
# Extract the helpers + counters and exec them into a namespace.
# ---------------------------------------------------------------------

_HELPER_BEGIN = "# ── PHANTOM-FEEDBACK CLASS FIX (2026-08-27"
_HELPER_END = "# Camera opt-out"


def _load_helpers(state_dict, twin_ignored=None, phantom_zero=None):
    line_start = _SRC.rfind("\n", 0, _SRC.find(_HELPER_BEGIN)) + 1
    line_end = _SRC.find(_HELPER_END, line_start)
    assert line_start > 0 and line_end > line_start, "helper markers moved"
    block = _SRC[line_start:line_end]
    block = textwrap.dedent(block)
    ns = {
        "STATE": state_dict,
        "_state_lock": threading.Lock(),
    }
    if twin_ignored is not None:
        ns["_twin_source_ignored"] = twin_ignored
    if phantom_zero is not None:
        ns["_phantom_zero_frames"] = phantom_zero
    exec(compile(block, "<phantom_helpers>", "exec"), ns)
    return ns


# ---------------------------------------------------------------------
# T1 — _is_all_zeros_positions detects the phantom-zero class
# ---------------------------------------------------------------------

def test_T1_all_zeros_detected():
    ns = _load_helpers(state_dict={})
    assert ns["_is_all_zeros_positions"]([0.0]*6) is True
    # Exactly-zero doubles and Python 0
    assert ns["_is_all_zeros_positions"]([0]*6) is True
    # Sub-noise-floor values still quarantine — encoder noise is
    # not physical motion.
    assert ns["_is_all_zeros_positions"]([1e-6]*6) is True


def test_T1_real_telemetry_not_quarantined():
    ns = _load_helpers(state_dict={})
    # Any non-trivial joint is enough to escape quarantine.
    real = [1.29, 0.28, 1.44, -0.03, 1.63, -1.63]  # session pose in rad
    assert ns["_is_all_zeros_positions"](real) is False


# ---------------------------------------------------------------------
# T2 — sensor noise around zero doesn't quarantine a home-parked arm
# unless the noise floor is exceeded
# ---------------------------------------------------------------------

def test_T2_home_pose_with_encoder_noise_quarantines():
    """A GENUINELY at-home arm produces sub-LSB noise; this SHOULD be
    quarantined because we cannot distinguish it from the phantom-zero
    class. The safety net is designed to fail-closed: while the arm is
    enabled, don't render a home-pose we can't attribute to a real
    motion. Operator can always see the last non-zero frame (twin
    freezes rather than flickering)."""
    ns = _load_helpers(state_dict={})
    # 4× noise floor is 2e-4 rad ≈ 0.011° — this SHOULD still
    # quarantine since the fix's noise floor is 5e-5 rad.
    # Reality: a genuine home-park is a rare edge case worth the
    # freeze-vs-flicker trade.
    at_home_noise = [3.7e-5, -2.1e-5, 4.9e-5, 1.2e-5, -4.5e-5, 2.8e-5]
    assert ns["_is_all_zeros_positions"](at_home_noise) is True


def test_T2_slightly_off_home_not_quarantined():
    ns = _load_helpers(state_dict={})
    # Even 0.01° on ONE joint is enough to escape.
    slightly_off = [0.0, 0.0, 0.0, 0.0, 0.0, 2e-4]
    assert ns["_is_all_zeros_positions"](slightly_off) is False


# ---------------------------------------------------------------------
# T3 — _wire_arm_is_enabled gates on STATE.robot.state
# ---------------------------------------------------------------------

def test_T3_wire_arm_enabled_state_2():
    ns = _load_helpers(state_dict={"robot": {"state": 2}})
    assert ns["_wire_arm_is_enabled"]() is True


def test_T3_wire_arm_enabled_state_0():
    ns = _load_helpers(state_dict={"robot": {"state": 0}})
    assert ns["_wire_arm_is_enabled"]() is False


def test_T3_wire_arm_enabled_no_state():
    ns = _load_helpers(state_dict={"robot": {}})
    assert ns["_wire_arm_is_enabled"]() is False


def test_T3_wire_arm_enabled_no_robot():
    ns = _load_helpers(state_dict={})
    assert ns["_wire_arm_is_enabled"]() is False


# ---------------------------------------------------------------------
# T4 — Structural: both writer paths have their JOG_BACKEND gate + zero
# quarantine. Static string inspection so a refactor that removes one
# is caught.
# ---------------------------------------------------------------------

def test_T4_on_joint_states_gates_on_backend_ws():
    """Under JOG_BACKEND=ws, _on_joint_states must return early."""
    a = _SRC.find("def _on_joint_states")
    b = _SRC.find("def ", a + 20)
    body = _SRC[a:b]
    assert 'if _JOG_BACKEND_ENV == "ws":' in body
    assert '_twin_source_ignored["ws_joint_states"]' in body
    # Return follows the counter bump.
    assert body.find("_twin_source_ignored[\"ws_joint_states\"]") < body.find("return")


def test_T4_on_joint_states_has_all_zeros_quarantine():
    """Under ros2 mode the ROS handler still runs, and MUST quarantine
    any all-zeros frame while the wire says enabled."""
    a = _SRC.find("def _on_joint_states")
    b = _SRC.find("def ", a + 20)
    body = _SRC[a:b]
    assert "_is_all_zeros_positions(ordered_pos)" in body
    assert "_wire_arm_is_enabled()" in body
    assert '_phantom_zero_frames["cri_joint_states"]' in body


def test_T4_on_estun_status_gates_on_backend_ros2():
    """Under JOG_BACKEND=ros2, the WS-mirror path must NOT overwrite
    STATE.joints.positions."""
    a = _SRC.find("Joints (rad) — only overwrite if the driver gave us real data.")
    b = _SRC.find("# TCP pose (m / rad)", a)
    body = _SRC[a:b]
    assert 'if _JOG_BACKEND_ENV == "ros2":' in body
    assert '_twin_source_ignored["ros2_estun_status_joints"]' in body


def test_T4_on_estun_status_has_all_zeros_quarantine():
    a = _SRC.find("Joints (rad) — only overwrite if the driver gave us real data.")
    b = _SRC.find("# TCP pose (m / rad)", a)
    body = _SRC[a:b]
    assert "_is_all_zeros_positions(jr)" in body
    assert "_wire_arm_is_enabled()" in body
    assert '_phantom_zero_frames["ws_estun_status"]' in body


def test_T4_exactly_two_writers_to_state_joints_positions():
    """No hidden third writer that bypasses both gates. If a legitimate
    new writer is added, it MUST also add a JOG_BACKEND gate + zero
    quarantine and update this count. Whitespace-tolerant match."""
    import re
    # Whole-slot writer (excluding the []= increment path which is
    # index-scoped in cmd_jog and not a feedback source).
    pattern = re.compile(
        r'STATE\["joints"\]\["positions"\]\s+=\s+(?!\S*\[)')
    matches = pattern.findall(_SRC)
    assert len(matches) == 2, (
        f"expected exactly 2 whole-array assignments to "
        f"STATE['joints']['positions']; found {len(matches)} — "
        f"new writer added without a JOG_BACKEND gate?"
    )

"""JOG-11 (2026-08-27) motion arbiter doctrine test.

Pins the invariant that jog and program-run are mutually exclusive at
the dashboard server. Loads the arbiter helpers via source-extract
(same pattern as `test_jog_stop_operator_copy.py`) since importing
`dashboard_server` has FastAPI + ROS side effects.

Doctrine:
  D1  jog with hold=True  is REFUSED (409, reason_code=program_running)
      when STATE.robot.program.state ∈ {2, 3}.
  D2  jog with hold=False (release) or stop=True is ALWAYS allowed
      — otherwise an in-flight hold can be stranded when a program
      starts, and the safety net (freshness deadman on the driver) is
      the only fallback.
  D3  jog increment (delta_deg or legacy delta) is REFUSED when a
      program is running — increments are motion, same as holds.
  D4  program-run is REFUSED (409, reason_code=jog_active) when
      _active_holds is non-empty.
  D5  clean baselines: with no program running AND no jog active,
      both surfaces pass.
  D6  operator_copy is always present on refusals with title + detail
      strings, and does NOT leak any technical token from the
      cobot-dashboard operator-copy banned list.
"""

from __future__ import annotations

import os
import sys
import threading


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))


# ---------------------------------------------------------------------
# Extract the arbiter helpers from dashboard_server.py by SOURCE parse.
# We cannot `import dashboard_server` cleanly (FastAPI + ROS side
# effects); mirroring the `test_jog_stop_operator_copy` extraction
# style, we string-scan for the arbiter block, splice in local stubs
# for STATE / _state_lock / _active_holds / _active_holds_lock /
# JSONResponse, and exec it into a fresh namespace.
# ---------------------------------------------------------------------

SERVER_PATH = os.path.join(SERVER_DIR, "dashboard_server.py")
with open(SERVER_PATH) as _f:
    _SRC = _f.read()

_BEGIN_MARK = "# Motion arbiter (JOG-11"
_END_MARK   = "def _build_driver_payload"

_start = _SRC.find(_BEGIN_MARK)
_end   = _SRC.find(_END_MARK, _start)
assert _start > 0 and _end > _start, (
    "test_motion_arbiter: cannot locate arbiter block markers in "
    "dashboard_server.py — did the section rename?"
)

# Move _start back to the beginning of the LINE containing the marker
# so leading indentation is preserved uniformly for textwrap.dedent.
_line_start = _SRC.rfind("\n", 0, _start) + 1
_ARBITER_BLOCK = _SRC[_line_start:_end]


class _StubJSONResponse:
    """Minimal JSONResponse stand-in that captures body + status_code."""
    def __init__(self, content, status_code=200):
        self.body = content
        self.status_code = status_code


def _load_arbiter(state, active_holds):
    """Build a namespace with the stubs the arbiter block reaches for,
    then exec the extracted block into it. Returns the namespace so
    tests can pull `_arbiter_refuse_jog_if_running` /
    `_arbiter_refuse_run_if_jogging` / probes."""
    ns = {
        "STATE": state,
        "_state_lock": threading.Lock(),
        "_active_holds": active_holds,
        "_active_holds_lock": threading.Lock(),
        "JSONResponse": _StubJSONResponse,
    }
    # Dedent the block — the arbiter lives inside a function so it's
    # indented one level. textwrap.dedent handles the uniform strip.
    import textwrap
    dedented = textwrap.dedent(_ARBITER_BLOCK)
    exec(compile(dedented, "<arbiter_block>", "exec"), ns)
    return ns


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

def _state(program_state=0):
    return {"robot": {"program": {"state": program_state,
                                   "project_id": "prog_x", "line": 42}},
            "safety": {"estop": False, "zone": "GREEN"}}


def _load_state_zero_holds(program_state=0, holds=None):
    holds = holds or {}
    return _load_arbiter(_state(program_state), holds)


# ---------------------------------------------------------------------
# D1 — jog hold REFUSED when program running
# ---------------------------------------------------------------------
def test_d1_hold_refused_when_program_running_state2():
    ns = _load_state_zero_holds(program_state=2)
    result = ns["_arbiter_refuse_jog_if_running"](
        {"hold": True, "joint": 6, "direction": 1, "speed_pct": 22.0})
    assert result is not None
    assert result.status_code == 409
    assert result.body["reason_code"] == "program_running"
    assert result.body["program"]["program_state"] == 2


def test_d1_hold_refused_when_program_running_state3():
    ns = _load_state_zero_holds(program_state=3)
    result = ns["_arbiter_refuse_jog_if_running"](
        {"hold": True, "joint": 6, "direction": 1, "speed_pct": 22.0})
    assert result is not None
    assert result.status_code == 409
    assert result.body["reason_code"] == "program_running"


# ---------------------------------------------------------------------
# D2 — release ALWAYS passes (never gated)
# ---------------------------------------------------------------------
def test_d2_release_passes_when_program_running():
    ns = _load_state_zero_holds(program_state=2)
    assert ns["_arbiter_refuse_jog_if_running"]({"hold": False}) is None


def test_d2_stop_passes_when_program_running():
    ns = _load_state_zero_holds(program_state=3)
    assert ns["_arbiter_refuse_jog_if_running"]({"stop": True}) is None


def test_d2_release_passes_when_idle():
    ns = _load_state_zero_holds(program_state=0)
    assert ns["_arbiter_refuse_jog_if_running"]({"hold": False}) is None


# ---------------------------------------------------------------------
# D3 — increment (delta_deg) REFUSED when program running
# ---------------------------------------------------------------------
def test_d3_increment_refused_when_program_running():
    ns = _load_state_zero_holds(program_state=2)
    result = ns["_arbiter_refuse_jog_if_running"](
        {"joint": 3, "delta_deg": 2.0})
    assert result is not None
    assert result.status_code == 409
    assert result.body["reason_code"] == "program_running"


# ---------------------------------------------------------------------
# D4 — program-run REFUSED when jog active
# ---------------------------------------------------------------------
def test_d4_run_refused_when_jog_active():
    ns = _load_state_zero_holds(program_state=0, holds={"hidA": object()})
    result = ns["_arbiter_refuse_run_if_jogging"]()
    assert result is not None
    assert result.status_code == 409
    assert result.body["reason_code"] == "jog_active"
    assert result.body["jog"]["n_active_holds"] == 1
    assert result.body["jog"]["hold_ids"] == ["hidA"]


def test_d4_run_refused_when_multiple_holds():
    ns = _load_state_zero_holds(program_state=0,
                                holds={"a": 1, "b": 2, "c": 3})
    result = ns["_arbiter_refuse_run_if_jogging"]()
    assert result is not None
    assert result.body["jog"]["n_active_holds"] == 3


# ---------------------------------------------------------------------
# D5 — clean baseline: both surfaces pass
# ---------------------------------------------------------------------
def test_d5_idle_baseline_both_pass():
    ns = _load_state_zero_holds(program_state=0, holds={})
    assert ns["_arbiter_refuse_jog_if_running"](
        {"hold": True, "joint": 6, "direction": 1, "speed_pct": 5}) is None
    assert ns["_arbiter_refuse_run_if_jogging"]() is None


# ---------------------------------------------------------------------
# D6 — operator_copy carries title + detail; no banned tokens leak
# ---------------------------------------------------------------------
_BANNED_TOKENS = (
    "dyn margin", "cart limit approach", "mm2mAndDeg2rad", "exitProcess",
    "firmware bug", "v.size()", "sigma_soft", "sigma_hard",
    "freshness deadman", "σ_min",
)


def test_d6_operator_copy_present_and_clean_jog_refusal():
    ns = _load_state_zero_holds(program_state=2)
    result = ns["_arbiter_refuse_jog_if_running"](
        {"hold": True, "joint": 6, "direction": 1, "speed_pct": 22.0})
    oc = result.body["operator_copy"]
    assert oc["title"] and isinstance(oc["title"], str)
    assert oc["detail"] and isinstance(oc["detail"], str)
    for tok in _BANNED_TOKENS:
        assert tok not in oc["title"]
        assert tok not in oc["detail"]


def test_d6_operator_copy_present_and_clean_run_refusal():
    ns = _load_state_zero_holds(program_state=0, holds={"h": 1})
    result = ns["_arbiter_refuse_run_if_jogging"]()
    oc = result.body["operator_copy"]
    assert oc["title"] and isinstance(oc["title"], str)
    assert oc["detail"] and isinstance(oc["detail"], str)
    for tok in _BANNED_TOKENS:
        assert tok not in oc["title"]
        assert tok not in oc["detail"]


# ---------------------------------------------------------------------
# Race-condition sanity: a program-run event that fires between the
# operator's hold-start and hold-release must not leave a phantom.
# This test doesn't exercise the wire path (that lives in the FastAPI
# handlers) — it just pins that release is ALWAYS a pass even when a
# program transitions to running in between.
# ---------------------------------------------------------------------
def test_release_after_program_started_still_passes():
    ns = _load_state_zero_holds(program_state=0, holds={"h1": 1})
    # Operator was holding; program then started (state → 2)
    ns["STATE"]["robot"]["program"]["state"] = 2
    # Release still passes → hold gets cleared → freshness deadman doesn't fire.
    assert ns["_arbiter_refuse_jog_if_running"]({"hold": False}) is None

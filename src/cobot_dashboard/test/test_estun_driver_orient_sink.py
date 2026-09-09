"""Pinned tests for the estun_driver coordinated_joint sink +
[MOTION-SINK] instrumentation (2026-09-09 §NN retirement of JTC wire).

The Face Down real-arm publish now lands on /robot/jog_command with
mode='coordinated_joint'. estun_driver_node._on_jog_command must:
  1. Recognise the mode.
  2. Return a NAMED refusal ('coordinated_orient_not_implemented_on_ws')
     via /estun/rejected so the dashboard mirrors it upstream to the
     frontend (no silent success).
  3. Log the receipt with a [MOTION-SINK] tag so an operator can grep
     the driver journal to verify the frame arrived, log-only.

The estun_driver._send() sink logs every Robot/* and project/* frame
with a [MOTION-SINK] prefix so a future coordinated-orient
implementation can be verified end-to-end without commanding motion.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.abspath(os.path.join(
    HERE, '..', '..', 'estun_driver',
    'estun_driver', 'estun_driver_node.py'))


def _src():
    with open(DRIVER) as fh:
        return fh.read()


def test_on_jog_command_dispatches_coordinated_joint_mode():
    """The driver's _on_jog_command must have a branch for
    mode='coordinated_joint' BEFORE the generic 'mode not implemented'
    catch-all."""
    src = _src()
    coord_idx = src.find("mode_s == 'coordinated_joint'")
    catchall_idx = src.find("mode {mode_s!r} not implemented")
    assert coord_idx != -1, (
        "coordinated_joint branch missing from _on_jog_command")
    assert catchall_idx != -1
    assert coord_idx < catchall_idx, (
        "coordinated_joint branch MUST precede the generic "
        "'mode not implemented' catch-all")


def test_coordinated_joint_dispatches_to_orient_handler():
    """Prior refusal-only branch is RETIRED. Coordinated orient now
    dispatches to _on_coordinated_joint which drives the save+run
    Lua motion path (option b: proven codegen/run wire)."""
    src = _src()
    m = re.search(
        r"if mode_s == 'coordinated_joint':(.+?)if mode_s != 'joint':",
        src, re.DOTALL)
    assert m, 'coordinated_joint branch body not found'
    branch = m.group(1)
    assert 'self._on_coordinated_joint(d)' in branch, (
        "coordinated_joint branch must delegate to "
        "_on_coordinated_joint (real motion path)")
    # Retired: refusal-only kind.
    assert 'coordinated_orient_not_implemented_on_ws' not in branch, (
        "obsolete refusal kind — orient is now implemented; class-of-"
        "bug closed by the save+run wire")


def test_orient_handler_emits_setspeedj_movj_lua():
    """_on_coordinated_joint synthesizes Lua of shape:
        setSpeedJ(<rate_dps>)
        movJ(orient_target)
    per lua_contract.md §Motion-setup (setSpeedJ modal preferred over
    inline v=). Rate ≤ _ORIENT_MAX_RATE_DEG_PER_S (10 deg/s per the
    Face Down operator directive)."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m, '_on_coordinated_joint not found'
    body = m.group(1)
    # Rate constant matches directive.
    assert '_ORIENT_MAX_RATE_DEG_PER_S = 10.0' in src
    # Rate cap enforcement.
    assert 'min(self._ORIENT_MAX_RATE_DEG_PER_S' in body
    # Lua emission shape.
    assert 'setSpeedJ(' in body
    assert 'movJ(' in body
    # Reserved point name — pins so the movJ reference matches the
    # varspoint registration key.
    assert '_ORIENT_POINT_NAME' in body
    # varspoint via the shared _make_jp_point helper (same helper
    # regular programs use).
    assert '_make_jp_point' in body


def test_orient_handler_reuses_save_project_pipeline():
    """Motion path rides the proven program_ops.save_project 4-POST
    sequence (source → varspoint → project.json → projectlist, with
    syntax + semantic gates). NOT a bespoke HTTP call — the same
    hardened pipeline regular taught programs traverse."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    assert 'save_project' in body
    # After save success, project/run over the SAME ws verb regular
    # programs use.
    assert "self._ws_verb('project/run'," in body
    # Reserved project + task IDs so repeat presses overwrite (no
    # accumulating orient debris on the controller).
    assert '_ORIENT_PROJECT_ID' in body
    assert '_ORIENT_TASK_ID' in body


def test_orient_handler_latches_orient_active_for_stop_routing():
    """After project/run success, `_orient_active = True` so the
    NEXT release/stop on /robot/jog_command routes to project/stop
    (halts mid-orient) instead of Robot/stopJog. Cleared by the
    release path so subsequent jog releases don't emit spurious
    project/stop frames."""
    src = _src()
    # Latch site inside the handler.
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    assert 'self._orient_active = True' in body
    # Node init defaults orient_active + req_id to False/None.
    assert 'self._orient_active = False' in src
    assert 'self._orient_req_id = None' in src


def test_release_path_fires_project_stop_when_orient_active():
    """The release/stop branch of _on_jog_command checks
    _orient_active BEFORE falling through to Robot/stopJog. When
    True: fires project/stop (same wire regular program stop uses),
    clears _orient_active, returns immediately. This IS the
    'motion stoppable immediately' contract."""
    src = _src()
    # Slice: from '# ── Release / stop path' to the next '# ──'.
    m = re.search(
        r"# ── Release / stop path takes ABSOLUTE priority(.+?)# ── Staleness",
        src, re.DOTALL)
    assert m, 'release/stop branch not found'
    branch = m.group(1)
    assert "getattr(self, '_orient_active', False)" in branch
    assert "self._ws_verb('project/stop')" in branch
    assert 'self._orient_active = False' in branch
    # [MOTION-SINK] evidence for the stop.
    assert '[MOTION-SINK] coordinated_joint stop' in branch


def test_orient_handler_refuses_bad_q_target():
    """Named refusal for bad q_target (missing / wrong shape / not
    a 6-element list of numbers). Guards against a rogue publisher
    on /robot/jog_command sending a coordinated_joint frame without
    a target — the driver refuses BEFORE the write path."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    assert "'reason_code': 'bad_q_target'" in body


def test_orient_handler_refuses_allow_move_gate_closed():
    """coordinated_joint uses the save+run write path, so allow_move
    (not just allow_jog) must be open. Refuses with named kind
    'allow_move_closed' when the gate is closed."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    assert 'self._writes_allowed_for_move()' in body
    assert "'reason_code': 'allow_move_closed'" in body


def test_orient_handler_dry_run_skips_save_and_run():
    """dry_run:true short-circuits before save_project + project/run
    so pinned tests (this file) + operator pre-flight can validate
    the emitted Lua shape without commanding motion. Emits a
    /estun/program_status event with the synthesized Lua so a bench
    consumer can regex the shape."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    assert "dry_run = bool(d.get('dry_run'))" in body
    assert 'if dry_run:' in body
    # dry_run path does NOT call save_project or project/run.
    # Slice to the `if dry_run:` block and confirm.
    dry_slice_m = re.search(
        r'if dry_run:(.+?)# ── Save:', body, re.DOTALL)
    assert dry_slice_m, 'dry_run block boundary not found'
    dry_slice = dry_slice_m.group(1)
    assert 'save_project' not in dry_slice
    assert "self._ws_verb('project/run'" not in dry_slice


def test_orient_handler_emits_motion_sink_logs():
    """Every phase (recv, dry_run, published) emits a [MOTION-SINK]
    log line so an operator can grep the driver journal for
    end-to-end evidence — operator directive item 4 (instrument,
    don't assume)."""
    src = _src()
    m = re.search(
        r'def _on_coordinated_joint\(self, d\):(.+?)def _start_or_refresh_continuous',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    # Three distinct log occurrences at receipt, dry_run, and publish.
    assert body.count('[MOTION-SINK]') >= 3, (
        f'[MOTION-SINK] appears {body.count("[MOTION-SINK]")}× in the '
        f'handler; expected ≥3 (recv, dry_run, published)')


def test_send_wraps_motion_verbs_with_motion_sink_log():
    """_send() is the ONE WS motion sink. Every Robot/* or project/*
    frame reaching this function logs a [MOTION-SINK] tx line with
    ty + id + compact db. Non-motion verbs (IOManager/*, publish/*,
    ping) are skipped to keep log signal:noise low."""
    src = _src()
    # Slice from _send definition to the next def.
    m = re.search(r'def _send\(self, obj\):(.+?)def _send_raw',
                    src, re.DOTALL)
    assert m, '_send definition not found'
    body = m.group(1)
    # Log wraps motion verbs. Regex tolerates whitespace variation.
    assert "startswith('Robot/')" in body
    assert "startswith('project/')" in body
    assert '[MOTION-SINK] tx' in body


def test_no_silent_return_on_send():
    """_send must return True/False on completion — never raise
    silently or drop a motion frame without a log. Regression fence."""
    src = _src()
    m = re.search(r'def _send\(self, obj\):(.+?)def _send_raw',
                    src, re.DOTALL)
    assert m
    body = m.group(1)
    # Two return paths: return False if no ws; return True after send.
    assert 'return False' in body
    assert 'return True' in body

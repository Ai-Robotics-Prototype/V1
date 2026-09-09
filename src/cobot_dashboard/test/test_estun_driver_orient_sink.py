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
    mode='coordinated_joint'. Prior code fell through to
    `mode {!r} not implemented (joint or cartesian only)` — a
    generic refusal that didn't name the intended sink."""
    src = _src()
    # New branch appears BEFORE the generic 'mode not implemented'
    # catch-all (else the catch-all fires first).
    coord_idx = src.find("mode_s == 'coordinated_joint'")
    catchall_idx = src.find("mode {mode_s!r} not implemented")
    assert coord_idx != -1, (
        "coordinated_joint branch missing from _on_jog_command")
    assert catchall_idx != -1
    assert coord_idx < catchall_idx, (
        "coordinated_joint branch MUST precede the generic "
        "'mode not implemented' catch-all")


def test_coordinated_joint_returns_named_refusal():
    """The branch must call self._reject(family, ...) with a named
    reason_code the dashboard can pattern-match on. Silent handling
    is a class-of-bug this atomic session is closing."""
    src = _src()
    m = re.search(
        r"if mode_s == 'coordinated_joint':(.+?)if mode_s != 'joint':",
        src, re.DOTALL)
    assert m, 'coordinated_joint branch body not found'
    branch = m.group(1)
    # Uses the standard driver refusal channel.
    assert 'self._reject(' in branch
    # Names the reason_code — key the dashboard mirror uses.
    assert "'coordinated_orient_not_implemented_on_ws'" in branch
    # Preserves the req_id so the dashboard's response can echo it
    # (the response body includes req_id + `next` pointer).
    assert "req_id" in branch


def test_coordinated_joint_emits_motion_sink_log_on_receive():
    """The branch logs a [MOTION-SINK] line on every receipt so an
    operator can grep the driver journal to prove the frame arrived
    at the sink — item 4 of the operator directive (instrument, don't
    assume). This is a diagnostic log, not a production metric —
    keep until the Face Down real-arm end-to-end verification lands."""
    src = _src()
    m = re.search(
        r"if mode_s == 'coordinated_joint':(.+?)if mode_s != 'joint':",
        src, re.DOTALL)
    assert m
    branch = m.group(1)
    assert '[MOTION-SINK]' in branch, (
        "coordinated_joint branch missing [MOTION-SINK] log — the "
        "operator directive item 4 requires the sink to emit a log "
        "line on every press so path-broken-upstream can be ruled out")


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

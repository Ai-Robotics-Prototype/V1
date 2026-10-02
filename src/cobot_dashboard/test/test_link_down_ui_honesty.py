"""Link-down UI honesty (2026-08-04, post-D14 hardening).

Three verifications in the post-incident audit surfaced gaps
that this test file pins:

  (1) LINK-DOWN button gating — the Run button must be
      disabled when robot.connected === false, so the operator
      can't waste a Confirm-modal cycle only to hit a server-
      side transport_down refusal.

  (2) STALE run-state honesty — the deriveRunState helper's
      new 'stale_link_down' kind is exercised in
      frontend/src/lib/runState.test.js. This file pins the
      structural claim that MonitorDashboard.jsx consumes the
      new kind (the button gate uses it).

  (3) resumeProgram ladder verb — /api/estun/program/resume
      must exist on the server AND the frontend must call it
      instead of the destructive /api/estun/program/run path
      (which restarts the program from step 1).
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
MONITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'MonitorDashboard.jsx'))
USESTORE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'store', 'useStore.js'))
RUNSTATE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'runState.js'))


def _read(path: str) -> str:
    with open(path) as fh:
        return fh.read()


# ── (1) Run button disable on link-down ─────────────────────────

def test_run_button_disabled_when_link_down():
    """MonitorDashboard.jsx must include robot.connected === false
    (or a linkDown variable derived from it) in the runDisabled
    expression. Without this the operator can click Run during a
    controller-WS outage, land in the Confirm modal, click
    Confirm, and only THEN discover the push is refused. The
    fix is to disable up front, matching IncrementalJogPanel's
    existing behavior."""
    src = _read(MONITOR)
    # Look for a linkDown-ish variable close to runDisabled OR a
    # direct !robot.connected check in the disabled expression.
    m = re.search(r'const runDisabled\s*=', src)
    assert m, ('runDisabled binding is missing from '
               'MonitorDashboard.jsx — the Run button has no '
               'gate at all')
    # Extract a healthy window around the binding to look at
    # the OR clauses.
    window = src[m.start(): m.start() + 800]
    assert ('linkDown' in window
            or 'robot.connected === false' in window
            or 'robot?.connected === false' in window
            or "!robot.connected" in window
            or "!robot?.connected" in window), (
        'runDisabled does not include a link-down check — '
        'operators can click Run while the controller WS is '
        'down and get a wasted transport_down refusal in the '
        'modal')


def test_link_down_gate_uses_stale_link_down_kind():
    """The runDisabled expression must also include the
    stale_link_down kind — otherwise a link-down mid-run could
    still show the Run button as clickable (stale_link_down
    isn't 'running' or 'stopping' formally)."""
    src = _read(MONITOR)
    m = re.search(r'const runDisabled\s*=', src)
    window = src[m.start(): m.start() + 800]
    assert "'stale_link_down'" in window or \
           '"stale_link_down"' in window, (
        "runDisabled does not gate on runState.kind === "
        "'stale_link_down' — a controller-WS drop mid-run could "
        "leave the Run button clickable while the pill says "
        "'RUNNING? · LINK DOWN'")


# ── (2) deriveRunState carries stale_link_down ──────────────────

def test_derive_run_state_declares_stale_link_down():
    """The deriveRunState helper must have a 'stale_link_down'
    branch that fires when robot.connected === false and
    program.state ∈ {2, 3}. Full behavior is exercised in
    runState.test.js; this test is the structural pin that
    the branch exists at all."""
    src = _read(RUNSTATE)
    assert "'stale_link_down'" in src or '"stale_link_down"' in src, (
        'runState.js does not declare a stale_link_down kind — '
        'the RUNNING pill honesty fix is not present')
    assert 'connected === false' in src, (
        'runState.js does not check robot.connected — the stale '
        'gate has no trigger')
    assert 'LINK DOWN' in src, (
        'stale_link_down label does not include "LINK DOWN" — '
        'operators cannot read the pill correctly')


# ── (3) resumeProgram ladder verb ───────────────────────────────

def test_resume_endpoint_exists_on_dashboard():
    """/api/estun/program/resume must exist as a POST endpoint
    mirroring /api/estun/program/pause. Without it, the
    frontend's resumeProgram has to fall back to the destructive
    /api/estun/program/run path."""
    src = _read(SERVER)
    assert re.search(
        r'@app\.post\(\s*["\']/api/estun/program/resume["\']\s*\)',
        src), (
        '/api/estun/program/resume endpoint not declared — '
        'resumeProgram cannot call the ladder verb')
    # And the handler publishes op:resume to /estun/program (not
    # a run publish).
    m = re.search(
        r'/api/estun/program/resume["\']\s*\)\s*\n\s*async def '
        r'api_estun_program_resume',
        src)
    assert m, ('resume endpoint decl exists but the handler '
               'is not named api_estun_program_resume — the '
               'shape has drifted')
    # Body must call _estun_publish_op("resume")
    handler_start = m.end()
    handler_body = src[handler_start: handler_start + 1500]
    assert '_estun_publish_op("resume")' in handler_body \
        or "_estun_publish_op('resume')" in handler_body, (
        'resume handler does not publish op:resume to the '
        'driver — the ladder verb never reaches the wire')


def test_resume_program_frontend_uses_ladder_verb():
    """resumeProgram in useStore.js must POST to
    /api/estun/program/resume, NOT to /api/estun/program/run
    (the latter re-runs from step 1, not resumes)."""
    src = _read(USESTORE)
    # Extract resumeProgram body.
    m = re.search(r'async resumeProgram\(\)\s*\{', src)
    assert m, 'resumeProgram function not found in useStore.js'
    body_start = m.end()
    # Bound to next top-level function decl at indent 2.
    end_m = re.search(r'\n  async [A-Za-z_]|\n  [a-zA-Z_]+\(',
                      src[body_start:])
    body = src[body_start: body_start + end_m.start()] if end_m \
        else src[body_start: body_start + 2000]

    assert '/api/estun/program/resume' in body, (
        'resumeProgram does not POST to /api/estun/program/'
        'resume — it is still calling the destructive re-run '
        'path')
    # The old destructive call site must be gone — check for an
    # ACTUAL fetch() to the /run endpoint, not a bare mention in a
    # comment (the fix's own comment cites the old path).
    body_no_comments = re.sub(r'//[^\n]*', '', body)
    body_no_block = re.sub(r'/\*.*?\*/', '', body_no_comments,
                           flags=re.DOTALL)
    assert not re.search(
        r"fetch\(\s*['\"]/api/estun/program/run['\"]",
        body_no_block), (
        'resumeProgram still contains a fetch() to '
        '/api/estun/program/run — that path re-runs from step 1 '
        'and is not a resume')


def test_resume_program_surfaces_errors():
    """resumeProgram must addToast on non-ok / network error.
    The pre-fix code silently swallowed the error and dispatched
    to the sim, so a failed resume looked identical to success."""
    src = _read(USESTORE)
    m = re.search(r'async resumeProgram\(\)\s*\{', src)
    body_start = m.end()
    end_m = re.search(r'\n  async [A-Za-z_]|\n  [a-zA-Z_]+\(',
                      src[body_start:])
    body = src[body_start: body_start + end_m.start()] if end_m \
        else src[body_start: body_start + 2000]

    assert 'addToast' in body, (
        'resumeProgram does not call addToast on failure — '
        'the operator has no error surface if resume fails')
    # Explicit "Resume failed" phrasing so operator sees WHICH
    # action failed (not just "Fetch failed"). Template literals
    # use backticks, so accept either quote type OR a backtick
    # before the phrase.
    assert re.search(r"[`'\"]Resume failed", body), (
        'resumeProgram does not use "Resume failed" phrasing '
        'in the error toast — operator has to guess which '
        'action errored')


# ── Non-regression of the D14 shape ─────────────────────────────

def test_d14_still_wires_pending_pose_gate_before_codegen():
    """Belt-and-suspenders: the D14 pending-pose gate ordering
    must survive this commit's changes. If a merge accidentally
    reorders check_program_pending_poses AFTER the codegen
    call, this test catches it before deploy."""
    src = _read(SERVER)
    m = re.search(
        r'async def api_estun_program_run\(request: Request\):',
        src)
    assert m
    body_start = m.end()
    end_m = re.search(
        r'\n    @app\.|\n    async def api_[a-z]',
        src[body_start:])
    body = src[body_start: body_start + end_m.start()] if end_m \
        else src[body_start:]

    pos_gate = body.find('check_program_pending_poses(')
    pos_codegen = body.find('codegen_lua_from_program(')
    assert pos_gate != -1 and pos_codegen != -1
    assert pos_gate < pos_codegen, (
        f'D14 gate ordering regressed — pending-pose check now '
        f'runs at {pos_gate}, codegen at {pos_codegen}. Merge '
        f'reordered the safety gate; revert.')

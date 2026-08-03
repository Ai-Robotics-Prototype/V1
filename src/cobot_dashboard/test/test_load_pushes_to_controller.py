"""Load-must-push pinned regression (2026-08-03).

Operator hit a hard divergence: Monitor showed 'white bowl pick &
place' (dashboard state) while the controller had 'hole part
palletize' resident. Root cause: the Program Library's load
handler set frontend state and published an executor 'load'
message the executor IGNORED — it did NOT push the program to
the controller. Run would then execute whatever was LAST RUN,
not what the operator loaded.

Fix, pinned by these tests:
  * dashboard_server.py: `/api/estun/program/run` accepts a
    `push_only: true` flag that stops the run pipeline right
    before the `to_auto`/`run` publish. Codegen + save +
    byte-verify + STATE.robot.program mirror + sidecar refresh
    all run — so the resident becomes current, but the arm
    doesn't move.
  * MonitorDashboard.jsx: onSelectProgram calls
    /api/estun/program/run with push_only=true. On failure the
    UI surfaces a warning toast instead of silently accepting
    the divergence.
  * MonitorDashboard.jsx: residentDivergence banner renders when
    robot.program.resident_program_id disagrees with
    currentProgram.id — so an operator who edited without
    pushing sees the caveat before hitting Run.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
MONITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'MonitorDashboard.jsx'))


def _read(path: str) -> str:
    with open(path) as fh:
        return fh.read()


def test_run_endpoint_supports_push_only_short_circuit():
    """The run endpoint MUST honor `push_only:true` and stop before
    publishing the `run` verb. Without this the load path has no
    way to update the resident without moving the arm."""
    src = _read(SERVER)
    # The push_only body-key check exists.
    assert 'push_only' in src, (
        'dashboard_server.py has no push_only branch — load handler '
        'has no way to push without running')
    # The push_only branch returns BEFORE the run publish. Regex:
    # `if bool(body.get("push_only")):` should appear BEFORE the
    # `_estun_publish_op("to_auto")` call in file order.
    push_pos = src.find('body.get("push_only")')
    run_pub_pos = src.find('_estun_publish_op("to_auto")')
    assert push_pos != -1 and run_pub_pos != -1, (
        'Missing push_only check OR to_auto publish — endpoint '
        'shape has drifted')
    assert push_pos < run_pub_pos, (
        f'push_only branch (at {push_pos}) must appear BEFORE the '
        f'to_auto publish (at {run_pub_pos}) — otherwise a load '
        f'still moves the arm')
    # And the branch returns "kind":"pushed" outcome — the wire
    # contract the frontend reads.
    assert '"kind": "pushed"' in src, (
        'push_only branch does not return kind:"pushed" — the '
        'frontend cannot distinguish push-only success from a run')


def test_load_handler_pushes_via_estun_program_run():
    """MonitorDashboard.jsx onSelectProgram must POST to
    /api/estun/program/run with push_only:true. The old code
    posted to /api/program/run with action:'load' — an executor
    verb the executor ignored, so nothing reached the controller."""
    src = _read(MONITOR)
    # The push call is present with push_only=true.
    assert re.search(
        r"fetch\(\s*['\"]/api/estun/program/run['\"]",
        src), (
        'onSelectProgram no longer posts to /api/estun/program/run — '
        'the load-must-push contract is broken')
    assert 'push_only' in src, (
        'onSelectProgram does not send push_only — the load will '
        'either fail or (worse) actually move the arm')
    # The pre-fix stale post to /api/program/run with action:'load'
    # must be gone.
    assert not re.search(
        r"action:\s*['\"]load['\"]", src), (
        'Legacy action:"load" post to /api/program/run still '
        'present — that path is ignored by the executor')


def test_monitor_renders_resident_divergence_banner():
    """When robot.program.resident_program_id != currentProgram.id
    the Monitor MUST show a divergence banner. Without it the
    operator sees ONE name (dashboard's) and has no way to know
    the controller has a different program resident."""
    src = _read(MONITOR)
    assert 'residentDivergence' in src, (
        'Monitor has no residentDivergence derivation — divergence '
        'is invisible to the operator')
    assert 'data-testid="resident-divergence"' in src, (
        'Divergence banner has no data-testid — QA cannot pin its '
        'render. Reinstate the anchor.')
    # The banner MUST mention both the resident and the loaded ids
    # so the operator can act on the disagreement.
    assert 'Controller resident' in src, (
        'Divergence banner does not name the controller-resident id')


def test_no_stale_action_load_in_frontend():
    """One more sweep: no OTHER place in the frontend still sends
    the legacy action:'load' to /api/program/run. That fork was
    the whole bug — it must be dead everywhere."""
    frontend = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src'))
    hits = []
    for root, _dirs, files in os.walk(frontend):
        for name in files:
            if not (name.endswith('.jsx') or name.endswith('.js')):
                continue
            path = os.path.join(root, name)
            if '/node_modules/' in path or '/dist/' in path:
                continue
            with open(path) as fh:
                text = fh.read()
            if re.search(r"action:\s*['\"]load['\"]", text):
                hits.append(path)
    assert not hits, (
        f'Legacy action:"load" post still exists in {hits} — that '
        f'path is a no-op wrt the controller and re-introducing it '
        f'would restore the load/resident divergence')

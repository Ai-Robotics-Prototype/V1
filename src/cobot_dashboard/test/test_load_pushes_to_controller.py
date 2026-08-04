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


# ── Rollback invariant (2026-08-04) ───────────────────────────────
# The pre-rollback fix set currentProgram BEFORE the push, so any
# refusal (transport down, empty_program, lint, byte-verify)
# manufactured the exact divergence the resident-mismatch banner
# was designed to warn about. These tests pin the new invariant:
# "the UI's current program follows push success, never precedes it."


def test_load_verb_returns_410_on_program_run():
    """The retired /api/program/run action:'load' returns 410 Gone
    with a pointer at the replacement. Preserves the no-fork rule:
    program-selection state may only be written by
    /api/estun/program/run (per push_only:true for a load)."""
    src = _read(SERVER)
    # 410 status is explicit in the route handler
    assert '410' in src or 'status_code=410' in src, (
        'action:load handler does not return HTTP 410 Gone — '
        'that verb must be retired, not silently accepted')
    assert "'load_verb_retired'" in src or '"load_verb_retired"' in src, (
        'load-verb-retired outcome.kind missing — the frontend '
        'cannot distinguish this from other 4xx responses')
    # The old accepting-any-action code path must be gone
    assert not re.search(
        r"action not in \('run', 'pause', 'resume', 'stop', 'home', 'load'\)",
        src), (
        "The 'load' action is still in the accepted set for "
        "/api/program/run — retirement was not landed cleanly")


def test_monitor_onSelectProgram_pushes_before_setCurrentProgram():
    """Rollback invariant: in MonitorDashboard.jsx, the load-flow
    call to setCurrentProgram must come AFTER the push helper's
    successful response, not before. If setCurrentProgram runs
    first, ANY push failure (transport down, empty program, lint,
    byte-verify) creates the exact divergence the banner is
    designed to warn about — reintroducing the 2026-08-04 report
    where the operator saw the fix as 'not working'.

    The push itself lives in a shared helper
    (pushProgramToController) so the load path and the banner
    Push button use one code path. This test asserts (a) the
    helper is invoked inside onSelectProgram, and (b) the
    setCurrentProgram call sits AFTER that invocation."""
    src = _read(MONITOR)
    assert 'onSelectProgram' in src, (
        'onSelectProgram is missing — Program Library click cannot '
        'run the load path')
    m = re.search(
        r"const onSelectProgram\s*=\s*async \(prog\)\s*=>\s*\{",
        src)
    assert m, "onSelectProgram signature drifted — cannot pin push order"
    # Bound the search to the onSelectProgram body only. The next
    # top-level `const on…` / `const push…` arrow decl at indent 2
    # ends the function (there is no earlier closing brace at the
    # same indent).
    body = src[m.end():]
    end_m = re.search(
        r"\n  const (?:on[A-Z]|pushProgramToController)",
        body)
    body = body[: end_m.start()] if end_m else body[:6000]

    pos_push_call = body.find('pushProgramToController(')
    pos_set       = body.find('setCurrentProgram(')
    assert pos_push_call != -1, (
        'onSelectProgram does not invoke pushProgramToController — '
        'load path is not using the shared push helper')
    assert pos_set != -1, (
        'onSelectProgram does not call setCurrentProgram at all — '
        'the load path cannot commit local state')
    assert pos_push_call < pos_set, (
        f'setCurrentProgram (at {pos_set}) fires BEFORE the push '
        f'helper (at {pos_push_call}) — pre-rollback ordering has '
        f'returned. The UI would manufacture a resident-mismatch '
        f'on every push refusal.')
    # Additional invariant: the setCurrentProgram call must sit
    # AFTER a check on the push result (result.ok / !result.ok
    # early return). Otherwise the ordering is right but the
    # gating is missing — currentProgram would still update after
    # a failed push.
    pos_ok_check = body.find('result.ok')
    if pos_ok_check == -1:
        pos_ok_check = body.find('.ok)')
    assert pos_ok_check != -1 and pos_ok_check < pos_set, (
        'setCurrentProgram is not gated on the push result — the '
        'ordering is right but a failed push still commits local '
        'state, reintroducing the divergence bug')


def test_monitor_uses_named_load_error_map():
    """Rollback fix requires named errors (transport_down,
    empty_program, lint_failed, byte_verify_*, codegen) surfaced
    as error-severity toasts, not a generic warning. The
    namedLoadError helper is the shared map — every load-path
    failure toast has to route through it so a new refusal kind
    added on the server doesn't downgrade to 'push failed HTTP …'
    silently."""
    src = _read(MONITOR)
    assert 'namedLoadError' in src, (
        "MonitorDashboard.jsx does not import the namedLoadError "
        "helper — load-path errors will fall back to generic text")
    assert "from '../lib/loadOutcome'" in src, (
        'namedLoadError import path drifted from /lib/loadOutcome')


def test_monitor_banner_has_push_to_controller_action():
    """When the mismatch banner DOES render (genuine divergence
    only, post-rollback fix), the operator needs a one-tap way
    to converge without navigating. The button must be inside
    the divergence banner render and call the same push_only
    endpoint the load path uses."""
    src = _read(MONITOR)
    assert 'data-testid="banner-push-to-controller"' in src, (
        'divergence banner has no push-to-controller action — the '
        'operator has no one-tap way to converge')
    # Same handler shape as the load path (push_only:true against
    # /api/estun/program/run). Assert the handler function exists
    # and is wired to the button — the actual endpoint call lives
    # in pushProgramToController, which the load path also uses.
    assert 'onBannerPushToController' in src, (
        'banner Push button handler onBannerPushToController is '
        'missing — the button would be unwired')
    assert 'pushProgramToController' in src, (
        'The shared push helper is missing — the load path and '
        'the banner button should share one code path')


def test_dashboard_maps_ws_reject_to_transport_down_outcome():
    """The dashboard's save-reject relay must upgrade the driver's
    'ws not connected' reject (or reason_code='transport_down') to
    outcome.kind='transport_down'. That's what lets the frontend
    render the operator message 'Controller link down — program
    NOT loaded' instead of a generic 'save rejected'. This is the
    server half of the transport_down named-error contract."""
    src = _read(SERVER)
    assert '"transport_down"' in src, (
        'transport_down outcome.kind never appears in the server '
        '— the driver reject relay cannot signal it to the UI')
    # Both trigger paths (reason_code AND legacy reason substring)
    # exist so a driver that predates reason_code still upgrades.
    assert 'reason_code' in src, (
        'reason_code plumbing missing — the driver code cannot '
        'be surfaced upstream')
    assert '"ws not connected"' in src or "'ws not connected'" in src, (
        'reason-string fallback for pre-reason_code driver builds '
        'is missing')


def test_driver_ws_gate_carries_reason_code():
    """The driver's WS gate at estun_driver_node._on_program_command
    must attach reason_code='transport_down' to the reject frame.
    The gate itself (safety-correct: refuse program ops when we
    cannot see controller state) is unchanged; this is only the
    machine-readable tag the dashboard maps."""
    driver = os.path.abspath(os.path.join(
        HERE, '..', '..', 'estun_driver', 'estun_driver',
        'estun_driver_node.py'))
    with open(driver) as fh:
        src = fh.read()
    # Search near 'ws not connected' — extra dict on the same reject
    # should carry the reason_code.
    ws_reject_idx = src.find("'ws not connected'")
    assert ws_reject_idx != -1, (
        "driver ws-not-connected reject reason string is gone — "
        "the gate reason plumbing has drifted")
    window = src[ws_reject_idx: ws_reject_idx + 400]
    assert 'transport_down' in window, (
        'reason_code=transport_down not attached to the ws-not-'
        'connected reject — the dashboard cannot map the driver '
        'refusal to the named operator message')


def test_named_load_error_map_has_all_documented_kinds():
    """The frontend's namedLoadError helper must have a mapping for
    every outcome.kind the server can emit on the load path. If a
    new server outcome ships without a corresponding named entry
    the UI silently downgrades to 'push refused HTTP …' — which
    is exactly the bug that made the operator read the divergence
    banner as 'the fix isn't working' on 2026-08-04."""
    helper = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'lib', 'loadOutcome.js'))
    with open(helper) as fh:
        src = fh.read()
    for kind in ('transport_down', 'save_rejected', 'save_failed',
                 'empty_program', 'lint_failed',
                 'byte_verify_mismatch', 'byte_verify_get_failed',
                 'id_not_controller_safe',
                 'lint_infrastructure_error', 'codegen',
                 # Firmware bug #3 quarantine (2026-08-04):
                 'pending_poses', 'arity_assertion_failed'):
        assert kind in src, (
            f'namedLoadError has no entry for outcome.kind={kind!r} '
            '— the UI would fall back to a generic message')
    # Every named entry must clearly signal that the operator's
    # requested action did not take effect. Post the 2026-08-04
    # operator-copy rewrite, the register is lowercase and
    # varies per outcome (some say "not loaded", some "can't
    # run", "Nothing to run", etc). The invariant is that the
    # helper NEVER just says "OK" on a refusal path.
    for phrase in ('not loaded', "can't run", 'Nothing to run',
                   "can't be generated", "can't handle",
                   "couldn't"):
        # At least one of these operator-friendly refusal
        # phrases must appear — a rewrite that dropped all of
        # them would leave the UI with no negative signal.
        if phrase in src:
            return
    raise AssertionError(
        'None of the expected operator-facing refusal phrases '
        'appears in loadOutcome.js — namedLoadError may be '
        'silently returning success-ish copy on failure paths.')

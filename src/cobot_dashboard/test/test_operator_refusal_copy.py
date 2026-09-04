"""Pinned tests for the 2026-08-05 operator_refusal_copy fork rule.

Directive: every operator-facing refusal surface renders ONLY
through the shared copy module (lib/loadOutcome.js). No component
may concatenate `outcome.reason || body.error || HTTP status` into
a user-visible string.

Three canonical call sites pinned here:
  * RunProgramModal.jsx     — error phase renders {title, detail,
                              technicalDetail} + Details toggle
  * MonitorDashboard.jsx    — Restart-refused via namedLoadError
  * MonitorDashboard.jsx    — Speed-change-refused via namedSpeedRefusal

Any new render site that dumps raw wire text will trip the fork
registry lint (`operator_refusal_copy` patterns) — this test set
is the belt to the lint's braces.
"""

from __future__ import annotations

import os
import re
import subprocess


HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))


def _read(path):
    with open(path) as fh:
        return fh.read()


# ── loadOutcome exports the two refusal helpers ────────────────

def test_load_outcome_exports_named_load_error_and_named_speed_refusal():
    src = _read(os.path.join(FRONTEND_SRC, 'lib', 'loadOutcome.js'))
    assert 'export function namedLoadError' in src, (
        'namedLoadError missing — the shared copy module is broken.')
    assert 'export function namedSpeedRefusal' in src, (
        'namedSpeedRefusal missing — speed-change refusals have '
        'nowhere to route.')


def test_named_speed_refusal_carries_operator_language():
    """The speed-refusal helper must return operator-language copy
    that doesn't leak the raw wire reason into title or detail."""
    src = _read(os.path.join(FRONTEND_SRC, 'lib', 'loadOutcome.js'))
    # Extract the namedSpeedRefusal body — bounded by the closing
    # brace at column 0 (end of file for the last export).
    m = re.search(r'export function namedSpeedRefusal[^{]*\{(.+)$',
                  src, re.DOTALL)
    assert m
    body = m.group(1)
    # Title contains operator-language stem.
    assert 'Speed change refused' in body or 'high-speed' in body.lower()
    # Fallback branch surfaces the raw reason ONLY in
    # technicalDetail, not in the title.
    assert 'technicalDetail: rawReason' in body


# ── RunProgramModal error phase uses structured render ─────────

def test_run_modal_imports_named_load_error():
    src = _read(os.path.join(FRONTEND_SRC, 'components',
                             'RunProgramModal.jsx'))
    assert "from '../lib/loadOutcome'" in src, (
        'RunProgramModal does not import from the shared copy '
        'module — regression risk for operator_refusal_copy.')
    assert 'namedLoadError' in src


def test_run_modal_error_render_has_no_raw_reason_concat():
    """The error-phase render must NOT contain the raw wire-reason
    concatenation pattern (outcome?.reason || body?.error || HTTP)
    inline. It should read errorCopy fields from the shared module."""
    src = _read(os.path.join(FRONTEND_SRC, 'components',
                             'RunProgramModal.jsx'))
    # Sentinel: the pre-fix concatenation.
    assert re.search(
        r'body\?\.outcome\?\.reason\s*$',
        src, re.MULTILINE) is None, (
        'Raw refusal-reason concat lingers in RunProgramModal — '
        'the shared copy module is being bypassed.')
    # Structured render is present.
    assert 'errorCopy' in src
    assert 'errorCopy?.title' in src or 'errorCopy.title' in src
    assert 'errorCopy?.detail' in src or 'errorCopy.detail' in src
    assert 'technicalDetail' in src
    # Details toggle exists.
    assert 'showTechnical' in src
    assert 'data-testid="run-refused-details-toggle"' in src


def test_run_modal_confirm_run_calls_named_load_error():
    """The confirmRun path routes the body through namedLoadError
    on refusal — pin the exact call shape."""
    src = _read(os.path.join(FRONTEND_SRC, 'components',
                             'RunProgramModal.jsx'))
    m = re.search(r'async function confirmRun\(\)\s*\{(.+?)\n  \}',
                  src, re.DOTALL)
    assert m, 'confirmRun body not found — file structure drifted'
    body = m.group(1)
    assert 'namedLoadError(' in body, (
        'confirmRun does not call namedLoadError — refusal copy '
        'will fall back to raw wire text.')
    # The exact anti-pattern must be gone from the body.
    assert 'body?.outcome?.reason' not in body


# ── MonitorDashboard restart + speed refusal ───────────────────

def test_monitor_dashboard_imports_both_refusal_helpers():
    src = _read(os.path.join(FRONTEND_SRC, 'pages',
                             'MonitorDashboard.jsx'))
    assert 'namedLoadError' in src, (
        'MonitorDashboard missing namedLoadError import — the '
        'Restart-refused toast will fall back to raw wire text.')
    assert 'namedSpeedRefusal' in src, (
        'MonitorDashboard missing namedSpeedRefusal import — the '
        'Speed-change-refused toast will fall back to raw wire text.')


def test_monitor_dashboard_restart_refused_uses_named_load_error():
    src = _read(os.path.join(FRONTEND_SRC, 'pages',
                             'MonitorDashboard.jsx'))
    # Slice a ~800-char window around the "Restarted" success toast
    # and require namedLoadError to appear in that window with no
    # raw wire-reason concat in it.
    m = re.search(r'Restarted\s+"', src)
    assert m, 'Restart-branch anchor "Restarted \\"" not found'
    window = src[m.start():m.start() + 800]
    assert 'namedLoadError(' in window, (
        'Restart-refused branch does not call namedLoadError '
        'within 800 chars of the success toast — routing missing.')
    assert 'outcome?.reason' not in window, (
        'Raw wire-reason concat lingers in Restart-refused branch.')


def test_monitor_dashboard_speed_change_refused_uses_named_speed_refusal():
    src = _read(os.path.join(FRONTEND_SRC, 'pages',
                             'MonitorDashboard.jsx'))
    # The Speed-change-refused branch (inside the speed handler)
    # must invoke namedSpeedRefusal.
    m = re.search(
        r'if \(!res\.ok \|\| !body\?\.ok\) \{(.+?)return\n',
        src, re.DOTALL)
    assert m, 'speed-refused branch shape drifted'
    branch = m.group(1)
    assert 'namedSpeedRefusal(' in branch, (
        'Speed-change-refused branch does not call '
        'namedSpeedRefusal.')
    assert '${body?.reason ||' not in branch, (
        'Raw wire-reason concat lingers in Speed-refused branch.')


# ── Fork sentinel: no other frontend file uses the anti-pattern ─

def test_no_other_file_uses_the_raw_refusal_concat():
    """The exact anti-pattern the 2026-08-05 sweep found —
    `outcome?.reason || body?.error` inside a user-visible string —
    must not appear in any operator-facing render surface except
    the shared copy module itself. `loadOutcome.js` legitimately
    reads these fields inside `_wireReason`."""
    grandfathered = {
        'lib/loadOutcome.js',
    }
    hits = []
    for root, _, files in os.walk(FRONTEND_SRC):
        for fn in files:
            if not fn.endswith(('.js', '.jsx')):
                continue
            if fn.endswith('.test.js') or fn.endswith('.test.jsx'):
                continue
            rel = os.path.relpath(os.path.join(root, fn), FRONTEND_SRC).replace(os.sep, '/')
            if rel in grandfathered:
                continue
            src = _read(os.path.join(root, fn))
            # The exact anti-pattern: raw `outcome?.reason || body`
            # or `body?.reason || body?.error` chain in a render
            # context.
            for pat in (
                r'outcome\??\.reason\s*\|\|\s*body\??\.error',
                r'body\??\.reason\s*\|\|\s*body\??\.error',
            ):
                for m in re.finditer(pat, src):
                    lineno = src[:m.start()].count('\n') + 1
                    hits.append(f'{rel}:{lineno}: {m.group(0)}')
    assert not hits, (
        'New fork of the raw refusal-reason concat pattern — '
        'route through the shared copy module instead. Sites:\n  '
        + '\n  '.join(hits))


# ── modeOutcome mapper + mode-switch call sites (2026-08-31) ───

def test_mode_outcome_exports_named_mode_error():
    src = _read(os.path.join(FRONTEND_SRC, 'lib', 'modeOutcome.js'))
    assert 'export function namedModeError' in src, (
        'namedModeError missing — the shared mode-refusal copy '
        'module is broken.')
    assert 'export const MODE_OUTCOME_KINDS' in src, (
        'MODE_OUTCOME_KINDS export missing — coverage sweeps cannot '
        'iterate the named branches.')
    assert 'export const MODE_FAILED_REASON_CODES' in src, (
        'MODE_FAILED_REASON_CODES export missing — mode_switch_'
        "failed's inner dispatch cannot be exhaustively covered.")


def test_named_mode_error_covers_every_documented_outcome_kind():
    """Every outcome.kind the server's /api/estun/mode handler can
    emit must have an operator-language branch in namedModeError.
    A new kind shipping without a corresponding entry would
    silently downgrade the operator's toast to 'Mode switch was
    refused' — the exact class the ladder was built to name."""
    src = _read(os.path.join(FRONTEND_SRC, 'lib', 'modeOutcome.js'))
    # Every documented kind must appear as a branch (as a quoted
    # literal in the file — either in MODE_OUTCOME_KINDS list or
    # in an `if (kind === '...')` guard).
    for kind in ('invalid_target', 'arbiter_refused',
                 'mode_selector_manual',
                 'recovery_state_power_cycle_required',
                 'errors_latched_uncleared', 'driver_ack_timeout',
                 'mode_switch_failed'):
        assert f"'{kind}'" in src, (
            f'namedModeError has no branch for outcome.kind='
            f'{kind!r} — the UI would fall back to a generic '
            f'"mode switch refused" message.')
    # Every mode_switch_failed reason_code the driver / server can
    # attach must also have a named branch. mode_readback_timeout
    # was the specific case that triggered the 2026-08-31 rewrite.
    for rc in ('allow_mode_gate_closed', 'transport_down',
               'controller_not_ready', 'arm_enabled_interlock',
               'verb_publish_failed', 'mode_readback_timeout',
               'publish_failed'):
        assert f"'{rc}'" in src, (
            f'namedModeError has no reason_code branch for '
            f'{rc!r} — inner dispatch of mode_switch_failed is '
            f'incomplete.')


def test_named_mode_error_selector_manual_names_physical_selector():
    """Rung 0 (2026-08-31): DI16 modeSwitch == 0 → the ONLY remedy
    is turning the hardware selector on the cabinet. Copy must
    name the physical action (not a wire retry, not a power-
    cycle instruction). Regression sentinel for the reframe."""
    src = _read(os.path.join(FRONTEND_SRC, 'lib', 'modeOutcome.js'))
    m = re.search(
        r"kind === 'mode_selector_manual'\)\s*\{(.+?)\}\s*\n\n",
        src, re.DOTALL)
    assert m, 'mode_selector_manual branch not found'
    branch = m.group(1)
    # Title names the physical action.
    assert 'selector' in branch.lower() or 'manual' in branch.lower(), (
        'Rung 0 title does not name the physical selector — '
        'the operator would look for a wire fix.')
    assert 'auto' in branch.lower(), (
        'Rung 0 title does not name the direction the operator '
        'must turn the selector to (AUTO).')
    # Must NOT prescribe a power-cycle (that was the retired Rung 1
    # bogus remedy).
    assert 'power-cycle' not in branch.lower(), (
        'Rung 0 branch is prescribing power-cycle — that was the '
        'retired addendum-40 §566 remedy. DI16 is a hardware '
        'selector; no cabinet cycle will change its state.')


def test_named_mode_error_retired_recovery_state_branch_is_marked_legacy():
    """The recovery_state_power_cycle_required branch is retired
    (add-53 §655-660) but kept as a mapped kind for backward-
    compat with older backends. Copy MUST explicitly say the
    backend version is out-of-date — an operator seeing this
    outcome should know their server needs updating, not that
    they need to cycle the cabinet."""
    src = _read(os.path.join(FRONTEND_SRC, 'lib', 'modeOutcome.js'))
    m = re.search(
        r"kind === 'recovery_state_power_cycle_required'\)\s*\{(.+?)\}\s*\n\n",
        src, re.DOTALL)
    assert m, 'recovery_state_power_cycle_required branch missing'
    branch = m.group(1)
    assert 'out-of-date' in branch.lower() or 'legacy' in branch.lower(), (
        'Retired recovery_state branch copy does not name the '
        'legacy status — operator would think a power-cycle is '
        'still the fix.')
    # Must reference the reframe addendum so anyone auditing the
    # code can find the wire evidence.
    assert 'addendum-53' in branch.lower() or 'add-53' in branch.lower(), (
        'Retired branch does not cite the ledger reframe — the '
        'why is not documented in place.')


def test_run_program_modal_uses_named_mode_error():
    """RunProgramModal's mode-switch pre-flight refusal must route
    through namedModeError. Prior code (pre-2026-08-31) built the
    errorCopy inline with a hardcoded title 'Can't start —
    controller is not in Auto and the switch was refused', which
    was wrong for Rung 1 (physical cycle) and Rung 2 (latched
    errors)."""
    src = _read(os.path.join(FRONTEND_SRC, 'components',
                             'RunProgramModal.jsx'))
    assert "from '../lib/modeOutcome'" in src, (
        'RunProgramModal does not import from the mode-refusal '
        'copy module.')
    assert 'namedModeError(' in src, (
        "RunProgramModal does not invoke namedModeError — mode "
        "refusals will fall back to the pre-ladder generic copy.")
    # The pre-fix hardcoded title must be gone.
    assert 'controller is not in Auto and the switch was refused' \
        not in src, (
        "RunProgramModal still hardcodes the pre-ladder title "
        "'Can't start — controller is not in Auto...' — mode-"
        'refusal copy has not been unified.')
    # The pre-fix flattening pattern must be gone.
    assert 'mbody?.outcome?.reason' not in src, (
        'Raw mbody?.outcome?.reason flattening still present in '
        'RunProgramModal — the ladder outcome is being smashed.')


def test_mode_control_uses_named_mode_error():
    """ModeControl.runSwitch's refusal path must route through
    namedModeError. This is the pill dialog operators use to
    switch mode directly (before any program run) — the surface
    that has been on the acceptance list for three sessions."""
    src = _read(os.path.join(FRONTEND_SRC, 'components',
                             'ModeControl.jsx'))
    assert "from '../lib/modeOutcome'" in src
    assert 'namedModeError(' in src, (
        'ModeControl.runSwitch does not invoke namedModeError — '
        'mode-pill refusals will fall back to raw flattened text.')
    # Pre-fix flattening pattern gone.
    assert 'body?.outcome?.reason' not in src, (
        'Raw body?.outcome?.reason flattening still present in '
        'ModeControl.')


def test_every_estun_mode_call_site_imports_named_mode_error():
    """Fork sentinel: any frontend file that POSTs to
    /api/estun/mode MUST import namedModeError. A new call site
    that flattens the response silently would reintroduce the
    exact bug (mode_readback_timeout as the generic bottom on
    every rung) the 2026-08-31 rewrite closed."""
    hits = []
    for root, _, files in os.walk(FRONTEND_SRC):
        for fn in files:
            if not fn.endswith(('.js', '.jsx')):
                continue
            if fn.endswith('.test.js') or fn.endswith('.test.jsx'):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, FRONTEND_SRC).replace(os.sep, '/')
            src = _read(path)
            if not re.search(
                r"fetch\(\s*['\"]/api/estun/mode['\"]", src):
                continue
            if 'namedModeError' not in src:
                hits.append(rel)
    assert not hits, (
        'Files POST to /api/estun/mode but do NOT route the '
        'refusal through namedModeError: ' + ', '.join(hits))


# ── Fork registry entry + lint clean ───────────────────────────

def test_fork_registry_has_operator_refusal_copy_entry():
    reg = _read(os.path.abspath(os.path.join(
        HERE, '..', '..', '..', 'tools', 'fork_registry.yaml')))
    assert 'id: operator_refusal_copy' in reg
    # Points at the canonical module.
    assert 'lib/loadOutcome.js' in reg


def test_fork_lint_is_clean():
    tool = os.path.abspath(os.path.join(
        HERE, '..', '..', '..', 'tools', 'fork_lint.py'))
    r = subprocess.run(['python3', tool], capture_output=True, text=True)
    assert r.returncode == 0, (
        f'fork_lint failed:\n{r.stdout}\n{r.stderr}')

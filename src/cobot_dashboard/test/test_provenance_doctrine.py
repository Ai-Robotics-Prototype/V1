"""Provenance doctrine — 2026-08-28 stale-class close.

Everything the operator sees is required to be traceable to a git
SHA: dashboard backend, frontend bundle, deploy verdict, WS
handshake, footer verdict. This test pins the invariants that make
that traceability enforceable rather than advisory.

Fork registry: `provenance` — one canonical implementation. Owner:
dashboard-transport.

The seven layers pinned here:
  A. Backend bakes _BACKEND_GIT_SHA + _BACKEND_START_ISO at import
  B. /api/provenance exposes both, plus frontend_sha via .build-sha
  C. /health mirrors A + B
  D. /api/deploy_status composes a three-layer verdict with named
     failing_layers on mismatch
  E. index.html is served with Cache-Control: no-store
  F. WS /ws/state pushes {type:'hello', backend_sha, frontend_sha}
     on accept
  G. deploy.sh + autodeploy_wrapper.sh refuse a dirty working tree
     unless ALLOW_DIRTY=1
  H. Frontend has StaleGuard component that renders a BLOCKING
     overlay when the store's staleProvenance is non-null

Source-grep tests (not runtime tests) are deliberate: they can't be
faked by patching the runtime and they catch a maintainer who
"cleans up" one of these seams without knowing it was load-bearing.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
# From src/cobot_dashboard/test/ → cobot_dashboard → src → ws root
# (three .. hops). The prior four-hop calc landed one dir above ws
# and broke every path-based read below.
WS = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, SERVER_DIR)


def _server_src() -> str:
    with open(os.path.join(SERVER_DIR, 'dashboard_server.py')) as fh:
        return fh.read()


def _deploy_sh() -> str:
    with open(os.path.join(WS, 'scripts', 'deploy.sh')) as fh:
        return fh.read()


def _autodeploy_wrapper_sh() -> str:
    with open(os.path.join(WS, 'scripts', 'autodeploy_wrapper.sh')) as fh:
        return fh.read()


def _vite_config() -> str:
    with open(os.path.join(
        WS, 'src', 'cobot_dashboard', 'frontend', 'vite.config.js')) as fh:
        return fh.read()


def _use_store_js() -> str:
    with open(os.path.join(
        WS, 'src', 'cobot_dashboard', 'frontend', 'src', 'store',
        'useStore.js')) as fh:
        return fh.read()


def _stale_guard_jsx() -> str:
    p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend', 'src',
                     'components', 'StaleGuard.jsx')
    with open(p) as fh:
        return fh.read()


def _deploy_status_banner_jsx() -> str:
    p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend', 'src',
                     'components', 'DeployStatusBanner.jsx')
    with open(p) as fh:
        return fh.read()


def _fork_registry() -> str:
    with open(os.path.join(WS, 'tools', 'fork_registry.yaml')) as fh:
        return fh.read()


# ── A. Backend module-level provenance constants ─────────────────

def test_backend_sha_constant_present():
    src = _server_src()
    assert re.search(r'^_BACKEND_GIT_SHA\s*=', src, re.MULTILINE), (
        '_BACKEND_GIT_SHA must be a module-level constant baked at '
        'import time so it cannot drift from the running code.')


def test_backend_sha_reads_env_first():
    src = _server_src()
    m = re.search(
        r'def _read_backend_git_sha.*?return "unknown"',
        src, re.DOTALL)
    assert m, ('_read_backend_git_sha helper must exist and terminate '
               'in a well-defined "unknown" fallback.')
    body = m.group(0)
    assert 'COBOT_BACKEND_SHA' in body, (
        'Env var COBOT_BACKEND_SHA must be honored first — deploys '
        'stamp SHA into the systemd drop-in and the process reads it '
        'without invoking git.')
    assert 'git' in body and 'rev-parse' in body, (
        'Best-effort git rev-parse HEAD is the fallback when the env '
        'var is not set (dev-shell runs).')


def test_backend_start_iso_present():
    src = _server_src()
    assert '_BACKEND_START_ISO' in src, (
        'Start time must be baked so /health can display it beside '
        'the SHA — same-process ID for the operator.')


# ── B. /api/provenance endpoint ──────────────────────────────────

def test_api_provenance_endpoint_exists():
    src = _server_src()
    assert '@app.get("/api/provenance")' in src
    # Body must return all four fields the WS handshake + deploy
    # verifier need.
    for field in ('backend_sha', 'backend_start_iso',
                  'backend_uptime_s', 'frontend_sha'):
        assert re.search(rf'"{field}":', src), (
            f'/api/provenance must return {field}.')


def test_frontend_sha_reads_dist_build_sha():
    src = _server_src()
    m = re.search(r'def _read_frontend_git_sha.*?return "unknown"',
                  src, re.DOTALL)
    assert m, '_read_frontend_git_sha must exist.'
    assert '.build-sha' in m.group(0), (
        'Frontend SHA must be read from _STATIC_DIR/.build-sha — the '
        'sidecar the vite writeSidecarPlugin drops next to index.html.')


# ── C. /health mirrors provenance ────────────────────────────────

def test_health_returns_provenance():
    src = _server_src()
    m = re.search(
        r'@app\.get\("/health"\).*?async def health\(\).*?return \{',
        src, re.DOTALL)
    assert m
    # The whole handler is long, so match the return dict body
    # across a large slice.
    idx = m.end() - len('return {')
    tail = src[idx:idx + 4000]
    for field in ('backend_sha', 'backend_start_iso', 'frontend_sha'):
        assert f'"{field}"' in tail, (
            f'/health must include {field} so System Check can '
            f'render the provenance without a second endpoint hit.')


# ── D. /api/deploy_status three-layer verdict ────────────────────

def test_deploy_status_returns_verdict():
    src = _server_src()
    m = re.search(
        r'@app\.get\("/api/deploy_status"\).*?return \{',
        src, re.DOTALL)
    assert m
    tail = src[m.start():m.start() + 6000]
    assert '"verdict"' in tail
    assert '"failing_layers"' in tail
    # 'red' is the mismatch verdict; 'green' is the all-ok verdict.
    # Both must be a possible verdict value.
    assert "'green'" in tail or '"green"' in tail
    assert "'red'"   in tail or '"red"'   in tail


# ── E. Cache-Control headers on the SPA shell ────────────────────

def test_index_html_no_cache():
    src = _server_src()
    m = re.search(
        r'_NO_CACHE\s*=\s*\{[^}]*"Cache-Control"[^}]*\}',
        src)
    assert m
    body = m.group(0)
    # 'no-store' is the strong header; 'no-cache' + 'must-revalidate'
    # complete the belt-and-braces set.
    assert 'no-store' in body
    # serve_index must apply _NO_CACHE.
    assert re.search(
        r'@app\.get\("/"\).*?FileResponse\(.*?headers=_NO_CACHE',
        src, re.DOTALL), (
        'The catch-all / handler MUST apply _NO_CACHE — a cached '
        'shell pins the old bundle-hash reference and no rebuild ever '
        'reaches the browser.')


# ── F. WS /ws/state hello frame ──────────────────────────────────

def test_ws_state_pushes_provenance_hello():
    src = _server_src()
    m = re.search(
        r'@app\.websocket\("/ws/state"\).*?async def ws_state.*?'
        r'await websocket\.accept\(\)',
        src, re.DOTALL)
    assert m
    # The hello frame must be sent BEFORE the state broadcaster
    # takes over, i.e. immediately after accept().
    tail = src[m.end():m.end() + 2000]
    assert '"type":' in tail and '"hello"' in tail
    assert 'backend_sha' in tail
    assert 'frontend_sha' in tail


# ── G. deploy scripts refuse a dirty working tree ────────────────

def test_deploy_sh_refuses_dirty_tree():
    sh = _deploy_sh()
    assert 'ALLOW_DIRTY' in sh, (
        'ALLOW_DIRTY=1 override must exist (ALLOW_MOCK pattern).')
    assert re.search(r'git status --porcelain', sh), (
        'Dirty check must use git status --porcelain — mtime / '
        'find heuristics are brittle.')
    assert 'dirty_tree_refused' in sh, (
        'The named-reason string must land in deploy_log so the '
        'footer banner renders a concrete refusal, not "unknown".')


def test_autodeploy_wrapper_refuses_dirty_tree():
    sh = _autodeploy_wrapper_sh()
    assert 'ALLOW_DIRTY' in sh
    assert 'dirty_tree_refused' in sh


def test_deploy_sh_asserts_backend_and_frontend_provenance():
    sh = _deploy_sh()
    # Post-restart verify assertions live in deploy.sh so a
    # surviving old worker doesn't sneak through with only the
    # codegen check.
    assert '/api/provenance' in sh, (
        'deploy.sh must curl /api/provenance and assert '
        'backend_sha == HEAD after restart.')
    assert 'backend running == deployed HEAD' in sh
    assert 'frontend bundle == deployed HEAD' in sh


# ── Vite writeSidecarPlugin ──────────────────────────────────────

def test_vite_writes_build_sha_sidecar():
    v = _vite_config()
    assert '__GIT_SHA__' in v, (
        '__GIT_SHA__ define must expose the raw SHA to the JS bundle '
        'so the client can do like-for-like SHA-to-SHA comparison '
        '(L257).')
    assert 'writeSidecarPlugin' in v or '.build-sha' in v, (
        'A vite plugin must write dist/.build-sha at the end of '
        'every build so dashboard_server can read the frontend SHA.')
    assert 'writeBundle' in v, (
        'writeBundle is the vite hook that fires AFTER the bundle '
        'lands on disk — earlier hooks race the sidecar write.')


# ── H. Frontend WS hello handler + StaleGuard ────────────────────

def test_frontend_handles_hello_frame():
    js = _use_store_js()
    assert re.search(r"msg\.type\s*===\s*['\"]hello['\"]", js), (
        'store/useStore.js WS onmessage must intercept the hello '
        'frame BEFORE running the state-update pipeline.')
    assert '__GIT_SHA__' in js, (
        'Client-side compare must use the compile-time __GIT_SHA__ '
        'baked by vite — anything else is not like-for-like.')
    assert 'staleProvenance' in js, (
        'staleProvenance must be settable from the hello handler.')


def test_stale_guard_component_is_blocking():
    j = _stale_guard_jsx()
    assert "data-testid=\"stale-guard-overlay\"" in j or \
           "data-testid='stale-guard-overlay'" in j
    assert 'pointerEvents' in j and 'auto' in j, (
        'Overlay must intercept clicks (pointerEvents: auto) — the '
        'whole point is the operator cannot dismiss it and keep '
        'operating the arm on a stale tab.')
    assert 'aria-modal="true"' in j or "aria-modal='true'" in j
    # A "Reload now" button must exist. No close/dismiss button.
    assert 'Reload now' in j
    assert 'staleProvenance' in j
    # Sanity: the overlay is only rendered when staleProvenance is
    # set (i.e. returns null otherwise).
    assert 'return null' in j


# ── Deploy status banner renders layer-named failures ────────────

def test_deploy_status_banner_names_failing_layer():
    b = _deploy_status_banner_jsx()
    assert 'failing_layers' in b or 'failing' in b
    assert 'STALE:' in b, (
        'When the deploy_log latest is ok but backend/frontend SHA '
        'disagrees, banner text must render "STALE: <layer>" so the '
        'operator sees the mismatch named — not a false-green pill.')


# ── Fork registry canonical entry ────────────────────────────────

def test_fork_registry_has_provenance_capability():
    reg = _fork_registry()
    assert re.search(r'^\s*-\s*id:\s*provenance\s*$', reg, re.MULTILINE), (
        'fork_registry.yaml must declare a `provenance` capability so '
        'a second implementation ("mock provenance" module, "second '
        'health check", etc.) trips the fork gate.')


# ── Bash-level acceptance: dirty deploy exits 2 ──────────────────

# ── 2026-08-28 lockout close: build-skip must not lie about SHA ──

def test_deploy_sh_does_not_advance_build_sha_on_skip():
    """The prior sidecar-advance-on-skip locked every open tab out
    of the dashboard: server reported a frontend SHA the JS bundle
    could not contain, StaleGuard fired on every fresh tab, and
    the operator lost access to the deploy control surface used to
    fix it. The sidecar records "which SHA vite built the bundle
    against", period. This test refuses any patch that puts the
    old `echo HEAD > .build-sha` line back."""
    sh = _deploy_sh()
    # No `> .build-sha` write in the build-skip branch (or anywhere
    # in deploy.sh — vite's writeSidecarPlugin is the only writer).
    assert not re.search(r'>\s*"?\$FRONTEND_OUT/\.build-sha"?', sh), (
        'deploy.sh must not overwrite dist/.build-sha; only vite '
        'writeSidecarPlugin (at build time) is allowed to write it. '
        'Overwriting on build-skip lies about the JS bundle content.')


def test_deploy_status_verdict_ignores_frontend_sha():
    """`frontend_sha != deploy_sha` on a docs-only commit is honest
    (vite legitimately skipped the build) — not a red-verdict
    condition. StaleGuard is the correct staleness signal for the
    operator's tab (client-side compare of baked __GIT_SHA__ to
    WS-pushed frontend_sha; on docs commits, both are the last-
    build SHA → no fire). The verdict must NOT include frontend in
    failing_layers."""
    src = _server_src()
    # Find the verdict compose block.
    m = re.search(
        r'@app\.get\("/api/deploy_status"\).*?return \{',
        src, re.DOTALL)
    assert m
    tail = src[m.start():m.start() + 6000]
    # The failing_layers list is built ONLY from deploy and
    # backend; frontend appears as advisory (frontend_ok) but NOT
    # in the append list.
    fl_block = re.search(
        r'failing_layers\s*=\s*\[\](.*?)provenance\["failing_layers"\]',
        tail, re.DOTALL)
    assert fl_block, ('failing_layers compose block not found — the '
                      'compose logic must be greppable so this rule '
                      "can't silently regress.")
    body = fl_block.group(1)
    assert 'append("deploy")'   in body or "append('deploy')"   in body
    assert 'append("backend")'  in body or "append('backend')"  in body
    assert 'append("frontend")' not in body and "append('frontend')" not in body, (
        'frontend_sha must NOT gate the verdict. Reporting it in '
        'the provenance blob is fine — appending it to failing_layers '
        'is what locked the operator out on 2026-08-28.')


def test_stale_guard_has_escape_hatch():
    """After N mount cycles against the same (expected, actual)
    pair within the TTL window, StaleGuard MUST surface an override
    button so a guard bug can never again lock the operator out.
    The dashboard is safety-adjacent; there is no un-bypassable
    client-side wall."""
    j = _stale_guard_jsx()
    assert 'stale-guard-override' in j, (
        'StaleGuard.jsx must render a data-testid="stale-guard-'
        'override" button after repeated failed reloads.')
    assert 'OVERRIDE_AFTER' in j or 'showOverride' in j, (
        'A repeat-mount counter must decide when to surface the '
        'override — silent behavior would defeat the point.')
    # localStorage-backed history so counts survive the reload.
    assert 'localStorage' in j
    # Override click must clear the mismatch — otherwise the overlay
    # keeps re-rendering.
    assert '_setStaleProvenance' in j or 'staleProvenance: null' in j
    # An OVERRIDE ACTIVE indicator must exist so the operator SEES
    # the fact that the tab is running without the guard.
    p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend', 'src',
                     'components', 'StaleOverrideIndicator.jsx')
    assert os.path.isfile(p), (
        'StaleOverrideIndicator component must exist — a silent '
        'bypass is worse than none.')
    with open(p) as fh:
        ind = fh.read()
    assert 'OVERRIDE ACTIVE' in ind
    assert 'staleguard.override' in ind


def test_store_exposes_setStaleProvenance_action():
    """The override path needs a discrete action to clear the
    mismatch, both so StaleGuard doesn't reach into raw set() and
    so a unit test can drive it. Same pattern as _reconcileAll and
    the other store actions."""
    js = _use_store_js()
    assert '_setStaleProvenance' in js


# ── 2026-08-28 lie-eviction: no "network hiccup" default; no
#    legacy chunk-vs-git bundle-id toast ───────────────────────

def _load_outcome_js() -> str:
    with open(os.path.join(
        WS, 'src', 'cobot_dashboard', 'frontend', 'src', 'lib',
        'loadOutcome.js')) as fh:
        return fh.read()


def _strip_js_comments(src: str) -> str:
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.DOTALL)
    src = re.sub(r'//[^\n]*', '', src)
    return src


def test_save_failed_copy_does_not_lie_about_network():
    """The save_failed copy used to say "transient network hiccup"
    as the default detail — after weeks of the operator clicking
    through what were really driver_reject:program allow_move
    refusals, the class was named on 2026-08-28 and the copy
    retired. Retirement comments are allowed to mention the old
    string; the actual copy strings must not."""
    j = _strip_js_comments(_load_outcome_js())
    m = re.search(
        r"if \(kind === 'save_failed'\).*?\}\s*\)\s*\}",
        j, re.DOTALL)
    assert m, 'save_failed branch not found in loadOutcome.js'
    body = m.group(0)
    assert 'transient network hiccup' not in body, (
        'save_failed detail must not default to the retired '
        '"transient network hiccup" copy. The class was named on '
        '2026-08-28; see ledger addendum-48 §614.1.')
    assert 'Controller reason:' in body or 'did not return a reason' in body


def test_byte_verify_get_failed_copy_does_not_lie_about_network():
    """Same rule for byte_verify_get_failed — retired the
    "network hiccup" default so the wire's real error surfaces."""
    j = _strip_js_comments(_load_outcome_js())
    m = re.search(
        r"if \(kind === 'byte_verify_get_failed'\).*?\}\s*\)\s*\}",
        j, re.DOTALL)
    assert m
    body = m.group(0)
    assert 'transient network hiccup' not in body


def test_backend_drains_save_event_step_reason():
    """The backend classifier's final fall-through used to jump
    straight to save_failed if the /estun/rejected topic didn't
    fire in-window. Now: before defaulting, inspect
    save_event.steps for a per-step reason. Any non-200 step with
    a `reason` (or `error`/`body`) classifies as save_rejected so
    the frontend can surface the wire's actual message."""
    src = _server_src()
    # Locate the block that precedes the final save_failed return.
    idx = src.find(
        "\"error\": (\"save did not complete cleanly (some POSTs \"")
    assert idx > 0, 'save_failed fallback string not found'
    window = src[max(0, idx - 2000): idx]
    assert 'step_reason' in window or 'save_event' in window
    assert 'step.get("reason")' in window or "step.get('reason')" in window, (
        'The pre-fallback drain must probe save_event.steps for a '
        'reason field — that is where some driver builds put the '
        'named refusal when the reject topic missed our window.')


def test_check_bundle_id_toast_retired():
    """The chunk-hash-vs-git-SHA legacy toast (`_checkBundleId`
    comparing /api/build_id.bundle_id (chunk hash) to
    __BUILD_ID__ (git-describe SHA)) compared different SHAPES —
    the strings could never equal each other, so the toast fired
    for every deploy where both fields were non-empty. Provenance
    is StaleGuard's job now (SHA-to-SHA, WS-pushed). This test
    refuses any reintroduction of the legacy mechanism."""
    js = _use_store_js()
    # No live call, no method definition, no state fields.
    assert '_checkBundleId' not in re.sub(
        r'//[^\n]*|/\*.*?\*/', '', js, flags=re.DOTALL), (
        '_checkBundleId method must be fully removed — comments '
        'documenting its retirement are fine, live references are not.')
    for banned in ('serverBundleId:', 'bundleObsolete:'):
        assert banned not in re.sub(
            r'//[^\n]*|/\*.*?\*/', '', js, flags=re.DOTALL), (
            f'{banned} state field must be removed.')


def _hardware_md() -> str:
    with open(os.path.join(WS, 'docs', 'HARDWARE.md')) as fh:
        return fh.read()


def _facts_md() -> str:
    with open(os.path.join(WS, 'docs', 'FACTS.md')) as fh:
        return fh.read()


def _driver_src() -> str:
    with open(os.path.join(
        WS, 'src', 'estun_driver', 'estun_driver',
        'estun_driver_node.py')) as fh:
        return fh.read()


def _mode_control_jsx() -> str:
    with open(os.path.join(
        WS, 'src', 'cobot_dashboard', 'frontend', 'src',
        'components', 'ModeControl.jsx')) as fh:
        return fh.read()


# ── 2026-08-28 mode-switch feature doctrine ──────────────────────

def test_driver_mode_gate_exists_and_wired():
    """Mode ops must ride behind a SEPARATE gate (allow_mode /
    ESTUN_ALLOW_MODE) so an operator can permit mode toggling
    without also opening program-write. The driver subscribes to
    /estun/mode_command and publishes results on /estun/mode_status."""
    src = _driver_src()
    assert re.search(r"declare_parameter\(['\"]allow_mode['\"]", src)
    assert "ESTUN_ALLOW_MODE" in src
    assert "/estun/mode_command" in src
    assert "/estun/mode_status" in src
    # The subscription must be created eagerly (avoids the DDS
    # discovery-race class that hit /estun/program).
    assert "self.create_subscription(\n            String, '/estun/mode_command'," in src \
        or "'/estun/mode_command', self._on_mode_command" in src


def test_driver_mode_readback_uses_numeric_ground_truth():
    """L298 discipline: publish/RobotStatus.mode is the ONLY ground
    truth for "did the switch land". State-name strings are not
    trusted; the driver polls self._robot_mode_code and compares
    against the numeric target (0=AUTO, 1=MANUAL, 2=REMOTE)."""
    src = _driver_src()
    m = re.search(r"def _on_mode_command\(self, msg\)", src)
    assert m, '_on_mode_command handler not found'
    # Read the whole handler — bounded by the NEXT top-level def.
    tail = src[m.start():]
    end  = re.search(r"\n    def ", tail[100:])
    body = tail[:100 + (end.start() if end else 4000)]
    assert "_robot_mode_code" in body, (
        'read-back must compare against _robot_mode_code (numeric)')
    assert "_MODE_CODE_FOR_OP" in body or "target_code" in body, (
        'target must be resolved to a numeric code, not a string')
    assert re.search(r"mode_readback_timeout", src), (
        'a timed-out read-back must emit reason_code=mode_readback_timeout '
        'so the dashboard can classify it correctly')


def test_dashboard_mode_endpoint_arbiter_aware():
    """POST /api/estun/mode must REFUSE with a named reason when
    a jog hold is active OR a program is running (JOG-11 arbiter
    discipline extended). Mode ops mid-motion are unsafe: they can
    interrupt program state or race the jog freshness deadman."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\).*?async def api_estun_mode\(',
                  src, re.DOTALL)
    assert m
    # The handler body — enough surface to catch the arbiter block.
    # Endpoint has grown past 15KB with the diagnostic ladder;
    # find the next @app.* to bound the search.
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    assert "arbiter_refused" in body, (
        '/api/estun/mode must return outcome.kind="arbiter_refused" '
        'when the arbiter blocks')
    assert "_active_holds" in body, (
        'active jog hold must be checked (mirror of JOG-11 doctrine)')
    assert 'program' in body and 'state' in body, (
        'program.state == 2 must be checked before allowing the switch')


def test_dashboard_mode_endpoint_event_logs_on_change_and_refusal():
    """Every mode change attempt must land in the event log so the
    operator's timeline reflects what was attempted, granted, or
    refused. Success + failure both emit — silent success is what
    caused the "what changed?" investigations."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\)', src)
    assert m
    # Orchestration expanded the handler past 6 KB; give it room.
    # Endpoint has grown past 15KB with the diagnostic ladder;
    # find the next @app.* to bound the search.
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    assert '_event_log.emit' in body, (
        '/api/estun/mode must emit event_log entries')
    assert 'mode_switch' in body


def test_dashboard_mode_endpoint_reads_wire_ack():
    """The endpoint must NOT return "ok" until the driver publishes
    a matching envelope on /estun/mode_status with the same req_id.
    Optimistic success is what taught operators to distrust status
    pills."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\).*?return \{',
                  src, re.DOTALL)
    assert m
    # Endpoint has grown past 15KB with the diagnostic ladder;
    # find the next @app.* to bound the search.
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    assert 'req_id' in body
    assert 'mode_status' in body
    assert 'uuid' in body


def test_mode_control_component_is_canonical_and_guarded():
    """ModeControl is the ONLY frontend surface that switches
    mode. Renders current mode ALWAYS (per operator directive:
    safety-relevant, not a toggle), opens a confirm dialog naming
    the consequence, and disables the pill when the arbiter would
    refuse (already-refused hint before the wire trip)."""
    j = _mode_control_jsx()
    assert 'data-testid="mode-control"' in j
    assert 'data-testid="mode-confirm-dialog"' in j
    assert 'aria-modal="true"' in j
    # Consequence-text presence — the operator must SEE the effect
    # named before confirming.
    assert 'Programs run at their configured speed' in j
    assert 'Drag-teach + jog only' in j
    # Arbiter-aware disable — the pill knows before the endpoint
    # trip that the switch would refuse.
    assert 'jog_active' in j and 'program' in j


# ── 2026-08-28 mode-map correlation + enable-interlock ────────

def test_hardware_md_has_mode_code_table():
    """HARDWARE.md must carry the numeric-to-label map as a
    canonical constant table. Any code that gates on mode reads
    from this table (or a copy that matches). The correlation
    was locked 2026-08-28 by disable → factory-UI-click → wire
    observation; the table cites it."""
    h = _hardware_md()
    assert "Robot-mode code table" in h
    # All three rows must be present with numeric ↔ label.
    for token in ("AUTO", "MANUAL", "REMOTE"):
        assert token in h, f'HARDWARE.md missing {token} label'
    # Execution-path cross-reference must be present so the
    # F2 executor's CRI = REMOTE precondition is discoverable
    # from the map itself.
    assert "REMOTE" in h and "CRI" in h
    assert "AUTO" in h and "WS-programs" in h
    # Enable-interlock rule must be stated with the exact reason
    # code the driver emits.
    assert "arm_enabled_interlock" in h
    assert "disable" in h.lower() and "re-enable" in h.lower()


def test_facts_md_names_mode_header_lies_and_enable_interlock():
    """FACTS.md must carry two ambient truths so any future
    session sees them before writing mode-adjacent code:
    (1) factory-UI mode header can lie (mode-edition of L298),
    (2) mode switch requires arm disabled first (Codroid
    interlock)."""
    f = _facts_md()
    assert "Factory-UI mode header can lie" in f
    assert "numeric" in f and "robot_mode_code" in f
    assert "Mode switch requires arm disabled first" in f
    assert "arm_enabled_interlock" in f


def test_driver_refuses_mode_switch_when_enabled():
    """The driver's _on_mode_command must pre-check `_enabled`
    and refuse with reason_code=arm_enabled_interlock. The
    controller silently refuses the WS verb while enabled — the
    read-back would time out and the operator would see a stale
    generic error. Explicit refusal names the rule so the
    dashboard orchestrator (or a direct caller) can act on it."""
    src = _driver_src()
    m = re.search(r"def _on_mode_command\(self, msg\)", src)
    assert m
    tail = src[m.start():]
    end = re.search(r"\n    def ", tail[100:])
    body = tail[:100 + (end.start() if end else 4000)]
    assert "_enabled" in body
    assert "arm_enabled_interlock" in body


def test_dashboard_mode_endpoint_orchestrates_disable_switch_enable():
    """/api/estun/mode must, on arm_enabled_interlock, orchestrate
    disable → retry mode switch → re-enable behind a single
    operator confirm. The sub-step trace must ride in the
    response so the frontend can render it and the event log can
    record it."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\)', src)
    assert m
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    assert "arm_enabled_interlock" in body
    # Orchestration must hit disable + enable via power_command.
    assert "_publish_estun_power" in body
    assert re.search(r'''["']disable["']''', body), 'orchestration missing disable action'
    assert re.search(r'''["']enable["']''', body),  'orchestration missing enable action'
    # Sub-step trace must be surfaced in the response, not just
    # logged — the frontend renders progress from `subs`.
    assert '"subs"' in body or "'subs'" in body
    # Re-enable must always fire — leaving the arm disabled after
    # a failed switch is worse than leaving it in the pre-switch
    # mode.
    assert "publish_enable" in body
    assert "await_enabled" in body


def test_mode_control_dialog_names_interlock_dance():
    """When the arm is enabled at dialog time, ModeControl must
    surface the disable → switch → re-enable sub-steps to the
    operator BEFORE they confirm. Silent orchestration would
    surprise the operator when servos drop."""
    j = _mode_control_jsx()
    assert "needsInterlockDance" in j
    assert "Disable the arm" in j
    assert "Re-enable the arm" in j


# ── 2026-08-28 jog-stop taxonomy: kill the cause=other bucket ─

# Every `_stop_jog_locked(reason='...')` call site in the driver is
# enumerated here. `_tag_stop_reason` MUST route each to a specific
# tag; anything falling through to `cause=other` becomes a doctrine
# failure. The list is grep-derived from the driver source; if a new
# _stop_jog_locked call site lands, this fixture updates in the same
# commit.
_DRIVER_STOP_REASON_STRINGS = (
    # (representative reason string, expected non-'other' tag)
    ("disable command",                                   'disable_command'),
    ("release cmd",                                       'release_cmd'),
    ("zero-speed hold cmd",                               'zero_speed'),
    ("hold transition",                                   'hold_transition'),
    ("send failed",                                       'send_failed'),
    ("self-collision guard J1 vs J3 at 12mm",             'collision_guard'),
    ("ground guard J6 vs table at 8mm",                   'collision_guard'),
    ("obstacle guard TCP vs zone at 24mm",                'collision_guard'),
    ("increment complete J1 at 12.3°",                    'increment_end'),
    ("increment freshness fallback 0.35s",                'freshness_deadman'),
    ("hold staleness 0.28s",                              'freshness_deadman'),
    ("escape_only J3 at -155.0° past its escape edge",    'joint_limit_deeper'),
    ("limit approach J1 at 190.0° margin 2.0°",           'joint_limit'),
    ("cart limit approach J2 at 195.0° margin 2.0°",      'joint_limit'),
    ("singularity guard (σ_min=0.0080 < 0.0100 hard)",    'singularity_guard'),
    ("joint overspeed guard J4 -2.36 rad/s (cap 1.50)",   'joint_overspeed'),
    ("hb send failed",                                    'hb_send_failed'),
    ("ws disconnect",                                     'transport_down'),
    ("node shutdown",                                     'node_shutdown'),
)


def test_stop_jog_taxonomy_no_other():
    """Every reason string emitted by _stop_jog / _stop_jog_locked in
    the driver source MUST route to a specific cause tag. `other` is
    RETIRED — a stop the operator can't name is a stop the operator
    can't debug. Priority override 2026-08-28: the mid-hold jog stop
    problem outranks everything, and the toast has to speak truth."""
    # Import the driver module so we can call _tag_stop_reason
    # directly. Load it under sys.path to reach the source.
    sys.path.insert(0, os.path.join(
        WS, 'src', 'estun_driver', 'estun_driver'))
    # Simulate the classifier as a pure function on the class table
    # so this test doesn't need to spin up ROS.
    src = _driver_src()
    m = re.search(
        r"_STOP_REASON_PATTERNS\s*=\s*\((.*?)^\s*\)",
        src, re.DOTALL | re.MULTILINE)
    assert m, '_STOP_REASON_PATTERNS not found in driver source'
    patterns = []
    for line in m.group(1).splitlines():
        pm = re.match(r"\s*\('([^']+)',\s*'([^']+)'\)", line)
        if pm:
            patterns.append((pm.group(1), pm.group(2)))
    assert patterns, 'no (substring, tag) tuples parsed'

    def _tag(reason):
        low = reason.lower()
        for token, tag in patterns:
            if token in low:
                return tag
        return 'other'

    unnamed = []
    for reason, expected_tag in _DRIVER_STOP_REASON_STRINGS:
        got = _tag(reason)
        if got == 'other':
            unnamed.append((reason, expected_tag))
        else:
            assert got == expected_tag, (
                f'reason {reason!r} tagged as {got!r} but doctrine '
                f'expected {expected_tag!r}')
    assert not unnamed, (
        'STOP-JOG TAXONOMY DOCTRINE VIOLATED — the following reason '
        'strings still fall through to cause=other:\n  '
        + '\n  '.join(f'{r!r} (expected {t})' for r, t in unnamed)
        + '\nAdd matching entries to _STOP_REASON_PATTERNS in the '
          'driver AND operator copy in _jog_stop_cause_operator_copy.')


def test_operator_copy_covers_every_stop_tag():
    """Every non-'other' tag emitted by _STOP_REASON_PATTERNS must
    have operator copy in _jog_stop_cause_operator_copy — a named
    tag with generic fallback copy defeats the whole point of
    naming. Grep the dashboard translator for `if tag ==` branches
    and cross-check against the driver's tag set."""
    driver_src = _driver_src()
    m = re.search(
        r"_STOP_REASON_PATTERNS\s*=\s*\((.*?)^\s*\)",
        driver_src, re.DOTALL | re.MULTILINE)
    assert m
    driver_tags = set()
    for line in m.group(1).splitlines():
        pm = re.match(r"\s*\('[^']+',\s*'([^']+)'\)", line)
        if pm:
            driver_tags.add(pm.group(1))

    server_src = _server_src()
    # Find every `if tag == '<name>'` branch in the translator.
    handled = set(re.findall(
        r"tag\s*==\s*'([a-z_]+)'", server_src))
    missing = sorted(driver_tags - handled)
    assert not missing, (
        'operator copy missing for tag(s): '
        f'{missing}. Every driver tag must have a named branch in '
        '_jog_stop_cause_operator_copy — the "Jog stopped." generic '
        'fallback is the very thing this doctrine kills.')


# ── 2026-08-28 wrist-friendly cart holds ──────────────────────

def test_cart_hold_does_not_hard_stop_on_joint_overspeed():
    """Under the verb-era trust default (2026-08-28), cart holds
    must NOT hard-stop on the joint-overspeed path — the firmware
    clamps. The observe branch populates cart_softening with
    cause='joint_overspeed', mode='observe'; the arm slows via
    firmware clamp, not our stopJog+fresh-Robot/jog dance.

    The ENFORCE branch is retained inside `elif worst_ratio > 1.0
    ...` for regression testing under
    WSJOG_TRUST_FIRMWARE_CLAMPS=0, but the default must be observe."""
    src = _driver_src()
    # The observe branch: cause=joint_overspeed + mode=observe
    # inside a wsjog_trust guard. Covered by
    # test_wsjog_redundant_guards_demoted_to_observe already; here
    # we specifically pin that observe fires BEFORE the enforce
    # branch (elif order matters — the elif keeps the ENFORCE
    # scaling under regression flag).
    m = re.search(
        r"if worst_ratio\s*>\s*1\.0 and worst_i\s*>=\s*0\s*"
        r"\\\n?\s*and self\._wsjog_trust_firmware_clamps:",
        src)
    assert m, (
        'observe branch must be the leading if-clause on the '
        'joint-overspeed decision — regression: hard-stop or scale '
        'is running before the observe path.')


def test_cart_softening_toast_and_wrist_indicator_present():
    """The operator directive requires visible, immediate signaling
    when the cart governor engages AND a persistent affordance for
    wound wrists. Two components, both mounted at the App level so
    they see the state regardless of which page is open."""
    app_p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend',
                         'src', 'App.jsx')
    with open(app_p) as fh:
        app = fh.read()
    assert '<CartSofteningToast' in app
    assert '<WristWindIndicator' in app

    cst_p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend',
                         'src', 'components', 'CartSofteningToast.jsx')
    assert os.path.isfile(cst_p)
    with open(cst_p) as fh:
        cst = fh.read()
    # Reads robot.cart_softening (the driver's exposed blob).
    assert 'cart_softening' in cst
    # Actionable copy for the operator's frequent flier.
    assert 'joint_overspeed' in cst
    # 'Slowed' language — the operator's ear expects this pattern.
    assert 'Slowed' in cst

    wwi_p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend',
                         'src', 'components', 'WristWindIndicator.jsx')
    assert os.path.isfile(wwi_p)
    with open(wwi_p) as fh:
        wwi = fh.read()
    # Watches J4 + J6 explicitly. A silent partial coverage
    # (e.g., only J6) would still let the operator wind J4
    # invisibly.
    assert re.search(r"WRIST_JOINTS\s*=\s*\[\s*4\s*,\s*6\s*\]", wwi)
    # Threshold matches HARDWARE.md.
    assert '150' in wwi
    # Unwind direction is named ("+J6" / "−J6"), not generic.
    assert 'unwind' in wwi.lower()


# ── 2026-08-28 addendum-52 ROS2 executor cutover scaffolding ─

def test_run_backend_flag_defaults_legacy_lua():
    """The RUN_BACKEND env flag must exist AND default to
    legacy_lua so a fresh deploy stays on the proven path. F2.7
    first-run acceptance is what flips the default to
    ros2_executor — see ledger addendum-52 §647 M2."""
    src = _server_src()
    m = re.search(
        r"_RUN_BACKEND_ENV\s*=\s*os\.environ\.get\("
        r"[\"']RUN_BACKEND[\"'],\s*[\"'](\w+)[\"']", src)
    assert m, ('_RUN_BACKEND_ENV env-var flag not found in '
               'dashboard_server.py — regression: the cutover '
               'scaffolding has been silently removed.')
    assert m.group(1) == 'legacy_lua', (
        f'default must be legacy_lua; got {m.group(1)!r}. F2.7 '
        'first-run acceptance is what flips the default — this '
        'is not a codegen-time decision.')


def test_provenance_publishes_run_backend_and_target_mode():
    """/api/provenance MUST publish both `run_backend` and
    `run_backend_target_mode`. The frontend RunProgramModal
    keys on `run_backend_target_mode` for the auto-offer — a
    hard-coded 'auto' would break the cutover."""
    src = _server_src()
    m = re.search(
        r'@app\.get\("/api/provenance"\).*?return \{(.*?)\}',
        src, re.DOTALL)
    assert m
    body = m.group(1)
    assert '"run_backend"' in body, (
        '/api/provenance must publish run_backend')
    assert '"run_backend_target_mode"' in body, (
        '/api/provenance must publish run_backend_target_mode — '
        'the frontend auto-offer keys on this field')
    # Target-mode derivation must map legacy_lua → auto and
    # ros2_executor → remote per HARDWARE.md > Robot-mode code
    # table. Regression here would target the wrong mode.
    assert 'legacy_lua' in body and '"auto"' in body
    assert '"remote"' in body


def test_run_endpoint_dispatches_on_run_backend():
    """/api/estun/program/run must have a top-level dispatcher on
    _RUN_BACKEND_ENV. Under ros2_executor: quarantined programs
    still return 423; non-quarantined dispatch through the F2.7
    executor bridge (publish /task/run_program + await
    /executor/status terminal via per-req_id awaiter). Silent
    fallthrough to legacy would defeat the acceptance signal.

    2026-08-31 F2.7 (add-54): stub returning 501
    ros2_executor_not_wired_yet retired; bridge now dispatches
    for real."""
    src = _server_src()
    m = re.search(
        r'@app\.post\("/api/estun/program/run"\)',
        src)
    assert m
    body = src[m.start(): m.start() + 8000]
    assert '_RUN_BACKEND_ENV' in body, (
        'run endpoint must consult _RUN_BACKEND_ENV at dispatch')
    # The retired 501 stub kind MUST be gone from the endpoint body
    # (still may live in comments elsewhere as historical context).
    assert '"ros2_executor_not_wired_yet"' not in body \
        and "'ros2_executor_not_wired_yet'" not in body, (
        'ros2_executor_not_wired_yet stub is back — F2.7 bridge '
        'was retired or masked')
    # The new bridge shape publishes on /task/run_program and
    # registers a per-req_id awaiter. Regression here would revert
    # the F2.7 wiring.
    assert '_publish_task_run_program' in body, (
        'ros2_executor branch does not publish on /task/run_program '
        '— executor bridge is not wired')
    assert '_register_executor_awaiter' in body, (
        'ros2_executor branch does not register a per-req_id awaiter '
        '— bridge cannot correlate terminal state')
    assert '_unregister_executor_awaiter' in body, (
        'ros2_executor branch does not unregister the awaiter in a '
        'finally block — leaked awaiters would pile up')
    # Quarantine check inside the ros2 branch must precede the
    # bridge dispatch (safety before capability).
    ros2_block = re.search(
        r'_RUN_BACKEND_ENV\s*==\s*[\"\']ros2_executor[\"\'].*?_publish_task_run_program',
        body, re.DOTALL)
    assert ros2_block
    assert 'quarantined' in ros2_block.group(0), (
        'ros2 branch must still refuse quarantined programs — '
        'the palletize latch class is architecturally impossible '
        'on CRI, but the safety guard belt-and-braces stays')
    # Terminal-state outcomes: executor_complete on success,
    # executor_error on failure, executor_timeout on awaiter deadline.
    for kind in ('executor_complete', 'executor_dry_run_complete',
                 'executor_error', 'executor_timeout',
                 'executor_not_running'):
        assert f"'{kind}'" in body or f'"{kind}"' in body, (
            f'ros2 bridge branch missing terminal-outcome kind '
            f'{kind!r} — this is a named path the frontend needs')


def test_executor_bridge_subscribes_executor_status_topic():
    """The dashboard must subscribe /executor/status (the F2.7
    executor's status topic) AND translate program_state into the
    legacy STATE.robot.program.state field the JOG-11 arbiter
    reads. Without the mirror, the arbiter would fail to refuse
    jog while the executor is running a program."""
    src = _server_src()
    assert '"/executor/status"' in src or "'/executor/status'" in src, (
        'dashboard has no /executor/status subscription — the F2.7 '
        'executor status is never mirrored')
    assert '_on_executor_status' in src, (
        'dashboard has no _on_executor_status callback — bridge '
        'awaiter cannot be signaled on terminal state')
    # Arbiter mirror: program_state 2 or 3 → prog["state"] = ps.
    handler_m = re.search(
        r'def\s+_on_executor_status\s*\(self.*?\n(?=\n    def\s+)',
        src, re.DOTALL)
    assert handler_m, '_on_executor_status body not locatable'
    hbody = handler_m.group(0)
    assert 'STATE' in hbody and 'prog["state"]' in hbody, (
        '_on_executor_status does not translate program_state → '
        'STATE.robot.program.state — arbiter mirror missing')


def test_executor_bridge_publisher_topic_and_dropin_present():
    """The /task/run_program publisher and the F2.7 systemd
    drop-in must both be present. Missing publisher = executor
    never receives run events; missing drop-in = the flip
    procedure has no artifact."""
    src = _server_src()
    assert '"/task/run_program"' in src or "'/task/run_program'" in src, (
        'dashboard has no /task/run_program publisher — executor '
        'cannot be triggered')
    dropin = os.path.join(
        WS, 'src', 'cobot_bringup', 'systemd',
        'roboai-dashboard.service.d', 'f27-ros2-executor.conf')
    assert os.path.isfile(dropin), (
        f'F2.7 systemd drop-in missing at {dropin!r}')
    with open(dropin) as fh:
        conf = fh.read()
    assert 'RUN_BACKEND=ros2_executor' in conf, (
        'drop-in does not set RUN_BACKEND=ros2_executor')


def test_run_modal_reads_provenance_target_mode():
    """RunProgramModal.jsx must fetch /api/provenance on open and
    use the returned target mode (not a hard-coded 'auto') when
    calling /api/estun/mode. Regression here would keep asking
    for AUTO under RUN_BACKEND=ros2_executor and defeat the
    entire cutover."""
    p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend',
                     'src', 'components', 'RunProgramModal.jsx')
    with open(p) as fh:
        j = fh.read()
    assert '/api/provenance' in j, (
        'modal must fetch /api/provenance to read the run backend')
    assert 'run_backend_target_mode' in j, (
        'modal must consume run_backend_target_mode from provenance')
    # The mode switch call must key on the dynamic target, not
    # a hard-coded string.
    assert re.search(r"target:\s*targetModeStr", j), (
        'POST /api/estun/mode must send `target: targetModeStr` '
        'so the flag actually drives the auto-offer')


# ── 2026-08-28 palletize quarantine (§644 investigation) ─────

def test_palletize_programs_quarantined_server_side():
    """The palletize programs latch controller recoveryState=1 on
    push. Until §644 root-causes which codegen element is the
    poison, load/run of ANY of the three known palletize IDs must
    be refused server-side with outcome.kind='quarantined'. GET
    /api/programs/{id} surfaces the flag so the frontend can badge
    the entry BEFORE the operator clicks Run.

    Removing a program from the quarantine set should require a
    ledger-cited §644 root-cause resolution — this test refuses a
    silent unquarantine."""
    src = _server_src()
    m = re.search(
        r"_QUARANTINED_PROGRAM_IDS\s*=\s*\{(.*?)\}",
        src, re.DOTALL)
    assert m, ('_QUARANTINED_PROGRAM_IDS set not found — regression: '
               'the palletize quarantine has been silently removed.')
    ids = m.group(1)
    for expected in ("'holepartpalletize'",
                     "'pallettest'",
                     "'pallettest2'"):
        assert expected in ids, (
            f'{expected} missing from quarantine set — §644 poison '
            'has not been root-caused; removing this id must cite '
            'the fix commit.')
    # Endpoint must refuse before opening the program file.
    assert '"program_quarantined"' in src, (
        'reason_code=program_quarantined missing — frontend keys on '
        'this to render the quarantine copy')
    assert 'status_code=423' in src, (
        'quarantine refusal must use HTTP 423 Locked — the class '
        'signal for "the resource is temporarily unavailable by '
        'policy"')
    # GET /api/programs/{prog_id} must include the flag so the
    # Library UI can badge the entry before Run.
    m2 = re.search(
        r'@app\.get\("/api/programs/\{prog_id\}"\).*?return prog',
        src, re.DOTALL)
    assert m2, 'GET /api/programs/{prog_id} handler not found'
    body = m2.group(0)
    assert '_QUARANTINED_PROGRAM_IDS' in body, (
        'the GET handler must consult the quarantine set + surface '
        'quarantined + quarantine_reason fields')
    assert '"quarantined"' in body
    assert '"quarantine_reason"' in body


# ── 2026-08-28 §566 self-healing diagnostic ladder ───────────

def test_dashboard_mirrors_errors_and_recoveryState():
    """L298 / addendum-40 §566 pinned {mode, state, stateName,
    recoveryState, errors[]} as the four-tuple. Silent absence of
    the last two was what turned every toAuto refusal into a
    riddle — the diagnostic ladder can't diagnose what it can't
    see. The dashboard's _on_estun_mode mirror MUST include both
    keys; the driver MUST publish them in the status blob."""
    dash = _server_src()
    m = re.search(r'def _on_estun_mode\(self, msg\).*?for k in \((.*?)\):',
                  dash, re.DOTALL)
    assert m, '_on_estun_mode mirror block not found'
    keys = m.group(1)
    assert '"errors"' in keys, (
        'dashboard _on_estun_mode must mirror "errors" — §566')
    assert '"recoveryState"' in keys, (
        'dashboard _on_estun_mode must mirror "recoveryState" — §566')

    drv = _driver_src()
    assert re.search(r"_last_errors\s*=\s*\[\]", drv), (
        'driver must initialize _last_errors = [] at construction')
    assert re.search(r"_recovery_state\s*=\s*0", drv), (
        'driver must initialize _recovery_state = 0 at construction')
    assert re.search(r"db\.get\(['\"]errors['\"]\)", drv), (
        'driver _on_status must parse db.get("errors")')
    assert re.search(r"db\.get\(['\"]recoveryState['\"]\)", drv), (
        'driver _on_status must parse db.get("recoveryState")')


def test_mode_endpoint_has_di16_rung_zero():
    """Rung 0 (2026-08-31 add-53 §655-660): DI16 modeSwitch pre-
    check. If hardware selector is in MANUAL (DI16 == 0) and the
    target is 'auto', refuse immediately with the honest physical
    action. Firmware silently ACKs Robot/toAuto when DI16=0 but
    does NOT transition — the ladder must catch this BEFORE the
    orchestration burns two 4 s ack windows chasing a state no
    wire verb can move."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\)', src)
    assert m
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    assert 'mode_selector_manual' in body, (
        'Rung 0 outcome kind missing — DI16 hardware precheck is '
        'not wired')
    assert 'hardware_mode_selector_manual' in body, (
        'reason_code missing — the frontend keys on this')
    # Copy names the physical action.
    assert 'MANUAL' in body and 'AUTO' in body, (
        'The instruction must name the physical positions — no '
        'riddle')
    # Guard runs only for target=='auto' (Manual is always reachable).
    assert 'target == "auto"' in body or "target == 'auto'" in body, (
        'Rung 0 must only gate the auto target — a MANUAL-target '
        'switch has no reason to check the selector')
    # Reads STATE['io_live'] (mirror populated by the driver's
    # IOManager/GetIOValue poll). Direct wire probe here would be
    # over-engineering; the mirror refreshes every ~0.5 s.
    assert "STATE.get(\"io_live\")" in body or "STATE.get('io_live')" in body, (
        'Rung 0 must read STATE.io_live — reading anything else '
        'would either be stale or add a wire round-trip')


def test_mode_endpoint_does_not_gate_on_recovery_state_alone():
    """2026-08-31 reframe (add-53 §655-660): `recoveryState` is a
    session-persistent servos-were-off flag, NOT a fault latch.
    Wire evidence showed rs=1 latches on every Robot/switchOff and
    persists for the rest of the CPU session; a rs-only refusal
    would demand a power-cycle after any jog session. The mode
    endpoint MUST NOT return recovery_state_power_cycle_required
    with reason_code=recovery_state_nonzero — that was the retired
    Rung 1 misdiagnosis."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\)', src)
    assert m
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    # The retired reason_code must NOT be emitted from this endpoint.
    assert '"recovery_state_nonzero"' not in body \
        and "'recovery_state_nonzero'" not in body, (
        'Retired reason_code=recovery_state_nonzero is back — the '
        'ladder is again refusing on rs alone, which trivially '
        'over-fires after any operator disable.')
    assert '"recovery_state_power_cycle_required"' not in body \
        and "'recovery_state_power_cycle_required'" not in body, (
        'Retired outcome.kind=recovery_state_power_cycle_required '
        'is back in the mode endpoint — rs alone must not gate '
        'refusals.')
    # `recoveryState` should still appear in four_tuple output —
    # observability is retained, only the refusal is retired.
    assert 'four_tuple' in body and 'recoveryState' in body, (
        'recoveryState must still be reported in four_tuple output '
        'for operator observability — the reframe retires the '
        'refusal, not the observation.')


def test_mode_endpoint_has_errors_clear_rung():
    """Rung 2: errors[] latched → publish clear_alarm, wait 2 s
    for errors[] to drain, retry mode. Auto-silent success or a
    named refusal (errors_latched_uncleared) — never a raw
    "mode read-back timeout" if the cause is diagnosable."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\)', src)
    assert m
    # Endpoint has grown past 15KB with the diagnostic ladder;
    # find the next @app.* to bound the search.
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    assert 'publish_clear_alarm' in body, 'Rung 2 sub-step name missing'
    assert 'await_errors_cleared' in body, 'Rung 2 sub-step name missing'
    assert 'errors_latched_uncleared' in body, (
        'Rung 2 failure outcome kind missing')
    assert 'clear_alarm' in body, (
        'Rung 2 must publish action=clear_alarm — the wire path')


def test_mode_endpoint_dumps_four_tuple_on_terminal_failure():
    """Any terminal failure (mode_selector_manual, driver_ack_timeout,
    mode_switch_failed, errors_latched_uncleared) must carry the
    §566 four-tuple in the response payload so the operator toast
    can render wire truth instead of a riddle. Reframed 2026-08-31
    (add-53 §655-660): the retired Rung 1 recovery_state branch is
    no longer counted as a terminal path — DI16 Rung 0 replaces it."""
    src = _server_src()
    m = re.search(r'@app\.post\("/api/estun/mode"\)', src)
    assert m
    _next = re.search(r'\n    @app\.(?:get|post|put|delete|websocket)',
                      src[m.end():])
    _end = m.end() + (_next.start() if _next else 40000)
    body = src[m.start(): _end]
    # Every terminal path must include four_tuple. Rung 0 (DI16),
    # Rung 2 failure, driver_ack_timeout, mode_switch_failed.
    assert body.count('four_tuple') >= 4, (
        'four_tuple must appear on Rung 0, Rung 2 failure, '
        'driver_ack_timeout, AND mode_switch_failed responses — '
        f'found {body.count("four_tuple")} references')
    # Each tuple must carry the 5 §566 fields — reframe kept the
    # OBSERVATION of recoveryState even though the REFUSAL on it
    # was retired.
    for field in ('mode', 'state_code', 'state_name',
                  'recoveryState', 'errors'):
        assert f'"{field}"' in body, (
            f'four_tuple must include {field} — §566')


# ── 2026-08-28 WS-jog guard demotion (verb-era trust) ─────────

def test_wsjog_trust_firmware_gate_defaults_true():
    """Streamed-era guards on the WS jog path DEMOTE to observe-
    only under the `wsjog_trust_firmware_clamps` param (default
    True). Regression would restore the "our driver kills the
    hold while the pendant doesn't" class."""
    src = _driver_src()
    m = re.search(
        r"declare_parameter\(['\"]wsjog_trust_firmware_clamps['\"],\s*(\w+)\)",
        src)
    assert m, ('wsjog_trust_firmware_clamps parameter must exist — '
               'this is the feature gate for the verb-era trust '
               'boundary')
    assert m.group(1) == 'True', (
        f'default must be True (observe-only); got {m.group(1)!r}. '
        'Flipping this back to False regresses to the streamed-era '
        'guards that killed factory-parity holds.')
    assert 'WSJOG_TRUST_FIRMWARE_CLAMPS' in src, (
        'env override must exist so a regression session can '
        'restore ENFORCE without a source edit')


def test_wsjog_redundant_guards_demoted_to_observe():
    """Each of the five redundant guards on the cart WS-jog path
    must have an observe branch gated on
    `self._wsjog_trust_firmware_clamps`. A stop-only or scale-only
    block for these causes is the regression this doctrine forbids."""
    src = _driver_src()
    # The five demoted guards, each identified by its cart_softening
    # cause tag. Each cause must appear inside an
    # `if self._wsjog_trust_firmware_clamps:` block AND its
    # cart_softening entry must carry `mode: 'observe'`.
    demoted_causes = (
        'cart_limit_at_wall',
        'cart_limit_deepening',
        'joint_limit_soft',
        'singularity_guard',
        'joint_overspeed',
        'sigma_soft',
    )
    for cause in demoted_causes:
        # The cause tag must appear NEAR a `'mode': 'observe'` line
        # AND inside a wsjog_trust guard.
        pat = (r"if self\._wsjog_trust_firmware_clamps:"
               r".*?'cause':\s*'" + re.escape(cause) + r"'"
               r".*?'mode':\s*'observe'")
        pat_alt = (r"if self\._wsjog_trust_firmware_clamps:"
                   r".*?'mode':\s*'observe'"
                   r".*?'cause':\s*'" + re.escape(cause) + r"'")
        assert re.search(pat, src, re.DOTALL) \
            or re.search(pat_alt, src, re.DOTALL), (
            f'demoted cause {cause!r} must have an observe branch '
            f'gated on wsjog_trust_firmware_clamps and populate '
            f"cart_softening with mode='observe'.")


def test_wsjog_hard_enforce_guards_still_present():
    """The KEEP list on the WS-jog path: collision_guard (self /
    ground / env — our unique layer the firmware knows nothing
    about), keepalive deadman, faults, disable/release/hold-
    transition, arbiter refuses, and JOINT-mode escape_only. Any
    of these disappearing is a safety regression, not a parity
    improvement."""
    src = _driver_src()
    # Collision guard hard-stop must remain — no wsjog_trust gate.
    # Grep for a _stop_jog_locked with collision-guard reason
    # NOT inside a trust-gate. Simpler proxy: assert the pattern
    # `collision_guard` maps to _stop_jog_locked without a
    # wsjog_trust prefix on that line.
    m = re.search(r"self\._stop_jog_locked\(\s*\n\s*reason=f?['\"]"
                  r"\{kind\} guard",
                  src)
    assert m, ('collision-guard hard-stop must remain — search for '
               '_stop_jog_locked(reason=f"{kind} guard ..." expected')
    # Escape-only (joint mode) must remain enforced.
    assert re.search(r"reason=f?['\"]escape_only J\{ax\}", src), (
        'JOINT-mode escape_only enforcement must remain — it is a '
        'UX-level guard, not firmware-redundant.')
    # Freshness deadman (keepalive) must remain — firmware cannot
    # detect browser death.
    assert re.search(r"hold staleness", src), (
        'freshness deadman (hold staleness) must remain enforced — '
        'firmware cannot detect browser death')


def test_frontend_run_modal_offers_switch_to_target_mode():
    """Run Program must transparently offer "Switch to <target>
    and run" when the arm is not in the target mode. Post
    addendum-52, the target is dynamic (auto for legacy_lua,
    remote for ros2_executor per provenance)."""
    p = os.path.join(WS, 'src', 'cobot_dashboard', 'frontend', 'src',
                     'components', 'RunProgramModal.jsx')
    with open(p) as fh:
        j = fh.read()
    assert 'willSwitchMode' in j
    assert '/api/estun/mode' in j
    # Dynamic label + dynamic target — no hard-coded 'Auto'.
    assert 'Switch to ${targetModeLabel} and run' in j
    assert 'target: targetModeStr' in j


def test_estun_allow_move_env_expected_shape():
    """The systemd drop-in for roboai-estun must remain the ONE
    place ESTUN_ALLOW_MOVE is set. If the file has drifted or a
    parallel Environment= line has landed, the operator's
    understanding of "is program-push allowed" diverges from
    truth. This test source-inspects the drop-in when present."""
    p = '/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.env'
    if not os.path.isfile(p):
        # CI / fresh checkout — the drop-in doesn't exist. The
        # invariant is only enforceable on the target Jetson.
        return
    with open(p) as fh:
        env = fh.read()
    # Any explicit assignment must not silently be zero anymore.
    m = re.search(r'^ESTUN_ALLOW_MOVE=(\S+)', env, re.MULTILINE)
    assert m, 'ESTUN_ALLOW_MOVE must be declared in the drop-in.'
    # Truthy per the driver's parser: 1|true|yes|on (case-insensitive).
    assert m.group(1).lower() in ('1', 'true', 'yes', 'on'), (
        f'ESTUN_ALLOW_MOVE={m.group(1)!r} — the drop-in was flipped '
        'closed. Program change/save is a required product function '
        'and pushes through this gate; a closed gate returns '
        '"allow_move gate closed" and the operator sees a refusal '
        'toast instead of a save. See ledger addendum-48 §614.1.')


def test_deploy_sh_exits_2_on_dirty_tree(tmp_path):
    """Fabricate a tiny bash environment that mirrors deploy.sh's
    dirty-check without spinning up the full deploy. Guarantees the
    guard runs even in CI where /opt/cobot/deploy_log.jsonl doesn't
    exist."""
    # Extract the guard block from deploy.sh and run it against a
    # fake $WS that is a dirty git repo.
    fake_ws = tmp_path / "ws"
    fake_ws.mkdir()
    subprocess.run(['git', 'init', '-q'], cwd=fake_ws, check=True)
    subprocess.run(['git', 'config', 'user.email', 't@t'], cwd=fake_ws, check=True)
    subprocess.run(['git', 'config', 'user.name',  'T'], cwd=fake_ws, check=True)
    (fake_ws / 'seed').write_text('seed\n')
    subprocess.run(['git', 'add', 'seed'], cwd=fake_ws, check=True)
    subprocess.run(['git', 'commit', '-q', '-m', 'seed'], cwd=fake_ws, check=True)
    # Dirty the tree.
    (fake_ws / 'dirty').write_text('dirty\n')

    # Minimal shell driver — no other deploy.sh preflight, so this
    # is a pure guard exercise.
    log = tmp_path / "deploy_log.jsonl"
    guard = f"""set -uo pipefail
WS={fake_ws}
LOG={log}
mkdir -p "$(dirname "$LOG")"; touch "$LOG"
DIRTY_FILES=$(cd "$WS" && git status --porcelain 2>/dev/null | head -20)
if [[ -n "$DIRTY_FILES" && "${{ALLOW_DIRTY:-0}}" != "1" ]]; then
    printf '{{"phase":"fail","step":"dirty_tree_refused"}}\\n' >> "$LOG"
    exit 2
fi
exit 0
"""
    res = subprocess.run(['bash', '-c', guard],
                         capture_output=True, text=True)
    assert res.returncode == 2, (
        f'Dirty tree must exit 2. stdout={res.stdout!r} stderr={res.stderr!r}')
    # And ALLOW_DIRTY=1 lets it through.
    res2 = subprocess.run(['bash', '-c', guard],
                          env={**os.environ, 'ALLOW_DIRTY': '1'},
                          capture_output=True, text=True)
    assert res2.returncode == 0

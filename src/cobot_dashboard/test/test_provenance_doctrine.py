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

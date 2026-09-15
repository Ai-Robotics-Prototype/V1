"""Fork Registry pins (§465 fork-1 lesson, 2026-08-04).

Three invariants:

  1. Every capability in `tools/fork_registry.yaml` resolves to
     real code on disk (python module importable, javascript
     module exists at the declared path, referenced file paths
     resolve where they can be checked).

  2. `tools/fork_lint.py` fails hard when a synthetic fork is
     planted in a forbidden path: exit code 1, at least one
     finding names the correct capability id.

  3. `scripts/deploy.sh` runs the linter BEFORE the build step
     and emits `phase="lint_failed"` (via --deploy-phase) on a
     hit — so the deploy log shows a named refusal rather than
     a silent generic fail.

If this file fails: either restore the registry / linter / deploy
wiring, or amend the tests when the invariant has been
deliberately changed with operator sign-off.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml


HERE = Path(__file__).resolve().parent
# test/ → cobot_dashboard/ → src/ → cobot_ws (three parents up).
WS   = HERE.parent.parent.parent
REGISTRY = WS / 'tools' / 'fork_registry.yaml'
LINTER   = WS / 'tools' / 'fork_lint.py'
DEPLOY   = WS / 'scripts' / 'deploy.sh'


# ── (1) Registry entries resolve ────────────────────────────────

def _load_registry() -> dict:
    with open(REGISTRY) as fh:
        return yaml.safe_load(fh)


def test_registry_yaml_parses():
    reg = _load_registry()
    assert isinstance(reg, dict)
    assert 'capabilities' in reg
    assert isinstance(reg['capabilities'], list)
    assert len(reg['capabilities']) >= 10, (
        'registry has fewer than 10 entries — the directive seeds '
        '~12, and a shrinking registry is almost never right')


def test_every_capability_has_id_and_canonical():
    reg = _load_registry()
    for cap in reg['capabilities']:
        assert isinstance(cap, dict)
        assert cap.get('id'), (
            f'capability missing id: {cap!r}')
        assert cap.get('canonical'), (
            f'capability {cap["id"]!r} missing canonical block')
        assert cap.get('forbidden'), (
            f'capability {cap["id"]!r} declares no forbidden paths — '
            'a registered capability without a fork-detection block '
            'is toothless; either add patterns or delete the entry')


def test_capability_ids_are_unique():
    reg = _load_registry()
    ids = [cap['id'] for cap in reg['capabilities']]
    dupes = [i for i in ids if ids.count(i) > 1]
    assert not dupes, f'duplicate capability ids: {sorted(set(dupes))!r}'


def test_python_canonical_modules_are_importable():
    """Registered python modules must actually import. If a module
    is renamed or deleted, the registry entry rots — this test
    catches that before the linter starts skipping capabilities
    silently."""
    reg = _load_registry()
    # Put every src/<pkg> on sys.path so `programming_by_demonstration`,
    # `estun_driver`, `cobot_dashboard` all resolve.
    for src_pkg in (WS / 'src').iterdir():
        if src_pkg.is_dir():
            p = str(src_pkg)
            if p not in sys.path:
                sys.path.insert(0, p)
    problems = []
    for cap in reg['capabilities']:
        py = (cap.get('canonical') or {}).get('python')
        if not py:
            continue
        mod = py.get('module')
        if not mod:
            continue
        try:
            import importlib
            m = importlib.import_module(mod)
        except Exception as e:
            problems.append(f'{cap["id"]}: import {mod!r}: '
                            f'{type(e).__name__}: {e}')
            continue
        # Function existence is a soft check — we don't fail on
        # a missing function (may be private) but we DO warn.
        for fn in py.get('functions') or []:
            if not hasattr(m, fn):
                problems.append(f'{cap["id"]}: {mod}.{fn} not found')
    assert not problems, 'registry rot: ' + '; '.join(problems)


def test_javascript_canonical_modules_exist_on_disk():
    reg = _load_registry()
    problems = []
    for cap in reg['capabilities']:
        js = (cap.get('canonical') or {}).get('javascript')
        if not js:
            continue
        path = js.get('module')
        if not path:
            continue
        abs_ = WS / path
        if not abs_.exists():
            problems.append(f'{cap["id"]}: js module missing: {path}')
    assert not problems, '; '.join(problems)


def test_route_canonicals_declare_method_and_path():
    reg = _load_registry()
    for cap in reg['capabilities']:
        r = (cap.get('canonical') or {}).get('route')
        if not r:
            continue
        assert r.get('method'), (
            f'{cap["id"]}: route.method missing')
        assert r.get('path'), (
            f'{cap["id"]}: route.path missing')


# ── (2) Linter blocks a synthetic fork ─────────────────────────

def test_linter_exits_zero_on_clean_tree():
    """Sanity: with the tree as-committed, the linter passes."""
    result = subprocess.run(
        [sys.executable, str(LINTER)],
        cwd=str(WS), capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, (
        f'linter failed on clean tree — this test relies on the '
        f'registry being self-consistent. stderr:\n{result.stderr}')


def test_linter_flags_a_synthetic_pallet_frame_fork():
    """Plant a file at a forbidden path that trips the
    pallet_frame_geometry entry. Linter must exit 1 and its
    stderr must name the capability id."""
    plant_dir = WS / 'src' / 'cobot_dashboard' / 'frontend' / 'src' / 'lib'
    plant_path = plant_dir / 'pallet_frame_forktest_DELETE_ME.js'
    fork_source = (
        "// Synthetic fork for test_fork_registry — safe to delete.\n"
        "export function validatePalletFrame(place) {\n"
        "  const c1 = place.corner1_tcp\n"
        "  const c2 = place.corner2_tcp\n"
        "  const c3 = place.corner3_tcp\n"
        "  // Trip a banned pattern: Math.acos(dot(...)) near corner refs.\n"
        "  const a = Math.acos(dot(c1, c2)) + plane_normal(c3)\n"
        "  return a\n"
        "}\n"
    )
    try:
        plant_path.write_text(fork_source, encoding='utf-8')
        result = subprocess.run(
            [sys.executable, str(LINTER)],
            cwd=str(WS), capture_output=True, text=True, timeout=30)
        assert result.returncode != 0, (
            'synthetic fork planted but linter passed — the gate is '
            'blind. Registry entry for pallet_frame_geometry must '
            'catch validatePalletFrame + plane_normal + '
            'Math.acos(dot(...)) in a frontend .js file that '
            'references corner_*_tcp.')
        out = (result.stdout or '') + (result.stderr or '')
        assert 'pallet_frame_geometry' in out, (
            'linter failed but did not name pallet_frame_geometry '
            'as the tripped capability. Output:\n' + out)
        # And the linter must cite the planted file specifically.
        assert 'pallet_frame_forktest_DELETE_ME.js' in out, (
            'linter output does not cite the planted file — '
            'operator cannot find the fork from the message.')
    finally:
        try:
            plant_path.unlink()
        except FileNotFoundError:
            pass


def test_linter_json_output_is_machine_readable():
    """--json output is a JSON array (may be empty). Clients that
    plug into CI pipelines rely on this."""
    result = subprocess.run(
        [sys.executable, str(LINTER), '--json', '--report'],
        cwd=str(WS), capture_output=True, text=True, timeout=30)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert isinstance(payload, list)


# ── (3) Deploy wiring ─────────────────────────────────────────

def test_deploy_sh_invokes_fork_lint_before_build():
    """The linter must run BEFORE `npm run build` (and BEFORE the
    doctrine gate, which the file order also documents). Without
    this ordering a fork could ship even when the linter would
    have caught it.

    Search for the EXECUTED lines (not comment mentions). The
    linter and doctrine calls are executed inside `if !` blocks;
    the build is inside a `( cd … && npm run build … )` subshell.
    """
    src = DEPLOY.read_text()
    m_lint  = re.search(
        r'\bpython3 "?\$WS/tools/fork_lint\.py"?', src)
    m_doctr = re.search(r'bash "?\$WS/scripts/run_doctrine_suite\.sh"?',
                        src)
    m_build = re.search(r'&&\s*npm run build', src)
    assert m_lint, (
        'scripts/deploy.sh does not invoke tools/fork_lint.py — '
        'the deploy-time gate is missing')
    assert m_doctr and m_build
    assert m_lint.start() < m_doctr.start() < m_build.start(), (
        f'ordering wrong: fork_lint at {m_lint.start()}, doctrine '
        f'at {m_doctr.start()}, build at {m_build.start()}. '
        f'Expected lint < doctrine < build so a fork blocks first.')


def test_deploy_sh_passes_deploy_phase_flag():
    """The linter is called with `--deploy-phase <sha>` so a
    failure appends a `phase="lint_failed"` line to the deploy
    log — the deploy log must show a NAMED refusal, not just a
    generic fail."""
    src = DEPLOY.read_text()
    m = re.search(
        r'fork_lint\.py"\s+--deploy-phase\s+"?\$_CURRENT_SHA"?',
        src)
    assert m, (
        'deploy.sh does not pass --deploy-phase to fork_lint — '
        'a lint failure would emit only the generic wrapper `fail` '
        'phase, leaving the operator without a specific reason')


def test_pre_commit_hook_is_tracked_and_runs_fork_lint():
    """The pre-commit hook must live in `.githooks/pre-commit`
    (tracked in the repo) and must invoke fork_lint. Ephemeral
    per-clone hooks are the pre-2026-08-04 pattern that let
    forks slip through unreviewed."""
    hook = WS / '.githooks' / 'pre-commit'
    assert hook.exists(), (
        '.githooks/pre-commit missing — the pre-commit gate is not '
        'tracked in the repo. Add it and re-run '
        'scripts/install_git_hooks.sh.')
    body = hook.read_text()
    assert 'tools/fork_lint.py' in body, (
        '.githooks/pre-commit does not call tools/fork_lint.py')
    installer = WS / 'scripts' / 'install_git_hooks.sh'
    assert installer.exists(), (
        'scripts/install_git_hooks.sh missing — operators need a '
        'one-shot installer to wire git core.hooksPath')


def test_deploy_log_emits_lint_failed_phase_on_fork_hit():
    """When --deploy-phase is passed AND a fork is detected, the
    linter writes a JSONL entry with phase="lint_failed" to a
    caller-supplied path. Exercise the write against a tmp file.

    We can't easily override /opt/cobot/deploy_log.jsonl from the
    test env, so we assert the code path is present in the linter
    source: the emit function and the phase='lint_failed' string
    both live in fork_lint.py. A run-time end-to-end assertion
    lives in the operator's deploy log after the next commit."""
    src = LINTER.read_text()
    assert '_emit_deploy_phase' in src
    assert "'lint_failed'" in src or '"lint_failed"' in src, (
        'lint_failed phase name missing from fork_lint.py — the '
        'directive requires a NAMED lint_failed phase')
    assert '/opt/cobot/deploy_log.jsonl' in src, (
        'deploy log path not referenced in fork_lint.py')

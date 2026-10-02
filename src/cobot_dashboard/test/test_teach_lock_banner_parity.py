"""Pinned tests for the 2026-08-05 teach_lock_banner fork-1 kill.

Directive: every surface that renders the "teaching in progress on
another device" state MUST expose the Take Over button. Pre-fix, the
fullscreen TeachOverlay only surfaced the lock as a `disabledReason`
tooltip on the Record button — no visible banner, no button. The
editor tab HAD a banner + button, but the fullscreen overlay obscured
it, so an operator on the tablet could not discover Take Over.

Fork registry: teach_lock_banner. This test is the CI gate that
catches a regression before it lands.
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


# ── Shared component exists with the required API ──────────────

def test_teach_lock_banner_component_exists():
    p = os.path.join(FRONTEND_SRC, 'components', 'TeachLockBanner.jsx')
    assert os.path.exists(p), 'TeachLockBanner.jsx missing — fork risk'


def test_teach_lock_banner_exports_default_component():
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'TeachLockBanner.jsx'))
    assert 'export default function TeachLockBanner' in src


def test_teach_lock_banner_renders_take_over_button():
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'TeachLockBanner.jsx'))
    # Button carries the take-over test-id + wires takeOverTeachSession.
    assert 'data-testid="teach-lock-take-over"' in src
    assert 'takeOverTeachSession' in src


def test_teach_lock_banner_shows_last_active_age():
    """Copy per the operator's register: '(last active Xm ago)'.
    The ageLabel helper is inline; verify it exists and both the
    `updated_ts` read and the `last active` label ship."""
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'TeachLockBanner.jsx'))
    assert 'updated_ts' in src
    assert 'last active' in src


def test_teach_lock_banner_confirms_before_take_over():
    """No accidental steal — a confirm dialog gates the API call."""
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'TeachLockBanner.jsx'))
    assert 'window.confirm' in src


# ── ProgramEditor renders TeachLockBanner at BOTH lock sites ────

def test_program_editor_imports_shared_component():
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'ProgramEditor.jsx'))
    assert "from './TeachLockBanner'" in src, (
        'ProgramEditor does not import the shared TeachLockBanner — '
        'the fork-1 defect (missing Take Over on the overlay) will '
        'return.')


def test_program_editor_renders_banner_in_editor_tab_and_overlay():
    """Both the editor tab (inline variant) AND the fullscreen teach
    overlay (overlay variant, via the `lockBanner` slot) must
    reference TeachLockBanner. Pre-fix, only the editor did — the
    overlay hid the button under a tooltip attribute."""
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'ProgramEditor.jsx'))
    # Component is used at least twice (editor + at least one overlay).
    hits = re.findall(r'<TeachLockBanner\b', src)
    assert len(hits) >= 2, (
        f'Expected TeachLockBanner rendered at >=2 sites (editor '
        f'tab + TeachOverlay slot), got {len(hits)}. Fork risk.')


def test_teach_overlay_accepts_lock_banner_slot():
    """The overlay must accept a `lockBanner` slot and render it
    above the instruction band, above the arrow pad."""
    src = _read(os.path.join(FRONTEND_SRC, 'components', 'ProgramEditor.jsx'))
    # Function signature accepts lockBanner.
    assert re.search(r'function TeachOverlay\(\s*\{[^}]*lockBanner', src, re.DOTALL), (
        'TeachOverlay signature does not accept lockBanner — the '
        'in-overlay Take Over button will not render.')
    # And the JSX renders it.
    assert re.search(r'\{\s*lockBanner\s*\}', src), (
        'TeachOverlay body does not render {lockBanner} — the slot '
        'is declared but never displayed.')


# ── The fork sentinel: no OTHER file renders the copy verbatim ──

def test_no_other_file_renders_teaching_in_progress_verbatim():
    """The literal 'Teaching in progress on' copy is the canonical
    fork sentinel. It lives ONLY in TeachLockBanner.jsx and in the
    grandfathered tooltip-string sites in ProgramEditor.jsx (both
    entered as known_debt in fork_registry.yaml). Any NEW file with
    this literal is a fork."""
    grandfathered = {
        'components/TeachLockBanner.jsx',
        'components/ProgramEditor.jsx',   # tooltip-string sites (known_debt)
        'store/useStore.js',              # comment reference only
    }
    hits = []
    for root, _, files in os.walk(FRONTEND_SRC):
        for fn in files:
            if not fn.endswith(('.js', '.jsx')): continue
            if fn.endswith('.test.js') or fn.endswith('.test.jsx'): continue
            rel = os.path.relpath(os.path.join(root, fn), FRONTEND_SRC)
            if rel.replace(os.sep, '/') in grandfathered:
                continue
            try:
                s = _read(os.path.join(root, fn))
            except Exception:
                continue
            for i, line in enumerate(s.splitlines(), start=1):
                if 'Teaching in progress on' in line:
                    hits.append(f'{rel}:{i}: {line.strip()[:120]}')
    assert not hits, (
        'New fork of the teach-lock copy — every site must render '
        'via TeachLockBanner. Sites:\n  ' + '\n  '.join(hits))


# ── Fork registry pins the invariant ───────────────────────────

def test_fork_registry_has_teach_lock_banner_entry():
    reg = _read(os.path.abspath(os.path.join(
        HERE, '..', '..', '..', 'tools', 'fork_registry.yaml')))
    assert 'id: teach_lock_banner' in reg
    # Canonical path present.
    assert 'TeachLockBanner.jsx' in reg


# ── Fork lint clean on the tree ────────────────────────────────

def test_fork_lint_is_clean():
    """Whole-tree lint gate. Also catches accidental new callers
    beyond the frontend (e.g. if someone drops a Python doc string
    that mentions the copy — the pattern is scoped to .jsx/.js so
    that shouldn't fire, but this check catches any regression)."""
    tool = os.path.abspath(os.path.join(
        HERE, '..', '..', '..', 'tools', 'fork_lint.py'))
    r = subprocess.run(['python3', tool], capture_output=True, text=True)
    assert r.returncode == 0, (
        f'fork_lint failed:\n{r.stdout}\n{r.stderr}')

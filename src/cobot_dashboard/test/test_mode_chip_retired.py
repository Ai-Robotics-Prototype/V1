"""Mode chip + dialog retirement pinned regression (2026-09-08).

Directive:
  1. Delete the MODE • MANUAL chip next to DISABLE/READY and its
     confirm dialog, BOTH editions.
  2. Prior pause was named (audit at 6760f30 stopped on item 3
     of the 3D View directive and reported the dialog was
     load-bearing); operator now clarifies: delete anyway.
  3. Backend endpoint POST /api/estun/mode stays live for
     driver-internal / CRI use. The frontend surface is retired.

Fork registry:
  * mode_switch capability's javascript canonical is dropped.
  * The forbidden-glob path_exempt list is empty — no frontend
    file may fetch /api/estun/mode until an operator directive
    re-authorizes a UI caller.
"""

from __future__ import annotations

import os


HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_ROOT = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))
VIEW3D = os.path.join(FRONTEND_ROOT, 'layouts', 'View3DLayout.jsx')
REGISTRY = os.path.abspath(os.path.join(
    HERE, '..', '..', '..', 'tools', 'fork_registry.yaml'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_mode_control_files_deleted():
    """components/ModeControl.jsx + lib/modeOutcome.js are both
    removed from disk. namedModeError was only used by
    ModeControl, so its module goes with it."""
    assert not os.path.exists(os.path.join(
        FRONTEND_ROOT, 'components', 'ModeControl.jsx'))
    assert not os.path.exists(os.path.join(
        FRONTEND_ROOT, 'lib', 'modeOutcome.js'))


def test_view3d_no_longer_imports_or_renders_mode_control():
    src = _read(VIEW3D)
    # Strip line comments AND JSX block comments — retirement notes
    # in both forms reference the name.
    import re as _re
    code = _re.sub(r'\{/\*.*?\*/\}', '', src, flags=_re.DOTALL)
    code = _re.sub(r'/\*.*?\*/',    '', code, flags=_re.DOTALL)
    code = '\n'.join(
        line for line in code.splitlines()
        if not line.lstrip().startswith('//'))
    assert 'import ModeControl' not in code, \
        'View3DLayout must not import ModeControl'
    assert '<ModeControl' not in code, \
        'View3DLayout must not render <ModeControl />'


def test_no_frontend_file_fetches_api_estun_mode():
    """Directive item 1: chip AND dialog gone from every render
    surface. The endpoint must not be reachable from any frontend
    fetch call site."""
    hits = []
    for base, _dirs, files in os.walk(FRONTEND_ROOT):
        for fn in files:
            if not fn.endswith(('.js', '.jsx')):
                continue
            if 'test' in fn.lower():
                continue
            p = os.path.join(base, fn)
            with open(p) as fh:
                src = fh.read()
            # Ignore comments — strip line + block styles.
            import re as _re
            src_nc = _re.sub(r'/\*.*?\*/', '', src, flags=_re.DOTALL)
            src_nc = _re.sub(r'\{/\*.*?\*/\}', '', src_nc, flags=_re.DOTALL)
            src_nc = '\n'.join(
                line for line in src_nc.splitlines()
                if not line.lstrip().startswith('//'))
            if '/api/estun/mode' in src_nc:
                hits.append(p)
    assert not hits, (
        f'No frontend file may fetch /api/estun/mode after the '
        f'mode chip retirement (2026-09-08). Hits: {hits}')


def test_fork_registry_removes_frontend_canonical_and_exempts():
    """The mode_switch capability's javascript canonical is
    dropped; path_exempt is empty. A reappearance of ModeControl
    .jsx or any other UI caller must be a new capability record,
    not a silent restore."""
    reg = _read(REGISTRY)
    # Locate the mode_switch block.
    i = reg.find('  - id: mode_switch')
    assert i != -1
    # Slice a big-enough window.
    j = reg.find('  - id:', i + 4) if reg.find('  - id:', i + 4) != -1 else len(reg)
    block = reg[i:j]
    # Frontend canonical seam removed.
    assert 'ModeControl.jsx' not in block or \
           block.find('# 2026-09-08') != -1, \
        'mode_switch registry block must record the 2026-09-08 retirement'
    # path_exempt must not carry ModeControl.jsx or RunProgramModal.jsx.
    assert "'**/ModeControl.jsx'" not in block
    assert "'**/RunProgramModal.jsx'" not in block


def test_disable_and_ready_badge_unaffected():
    """ArmEnableControl + JogReadyBadge still render in the same
    RealArmChrome header slot — the retirement is scoped to
    ModeControl only."""
    src = _read(VIEW3D)
    assert 'import ArmEnableControl' in src
    assert 'import JogReadyBadge' in src
    # Both still rendered.
    assert '<ArmEnableControl' in src
    assert '<JogReadyBadge' in src

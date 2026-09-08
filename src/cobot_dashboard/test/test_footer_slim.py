"""Footer slim + wordmark edition + banners regression (2026-09-08).

Directive:
  1. StatusBar shrinks to a single "Disk <free>" element with
     WARN/CRITICAL coloring. Every other block is retired.
  2. Edition chip/unlock relocates to the NeuRobots wordmark click
     (Brand.jsx). Must work on basic (no Configure tab).
  3. Bad-state banners (SystemBanners.jsx) render only when
     wsStatus != 'connected' OR self-collision guard is OFF.
     Healthy = nothing shown.
  4. Engineer info moves to /health.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
SB = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'StatusBar.jsx'))
BRAND = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'Brand.jsx'))
BANNERS = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'SystemBanners.jsx'))
APP = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'App.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_comments(src):
    s = re.sub(r'/\*.*?\*/',   '', src, flags=re.DOTALL)
    s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.DOTALL)
    return '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))


def test_statusbar_reduced_to_disk_only():
    """The StatusBar carries exactly one operator-visible element:
    the disk indicator. All other blocks (Connection dot, ROS2
    Humble, IP, State, Zone, Cell, WS rate, Edition) are gone."""
    code = _strip_comments(_read(SB))
    # Load-bearing element still there.
    assert 'data-testid="disk-status-block"' in code
    # Retired blocks — verify by searching for their old text.
    for gone in (
        'ROS2 Humble',
        'Robot Generic TCP',
        'IP&nbsp;192.168.1.246',
        'edition-block',       # edition chip retired from StatusBar
        'runState.color',      # State pill retired
        'Zone&nbsp;',          # Zone chip retired
        'WS&nbsp;25Hz',        # WS rate retired
        'environment guard off',   # cell note retired
        'safety.human_proximity',
    ):
        assert gone not in code, \
            f'StatusBar must not carry {gone!r} any more'


def test_statusbar_has_no_stale_state_reads():
    """No leftover useStore reads for retired blocks. Disk polls
    /api/disk_status only."""
    code = _strip_comments(_read(SB))
    # Disk poll is the only wire call left.
    api_calls = re.findall(r"/api/[a-z0-9_/{}]+", code)
    assert api_calls == ['/api/disk_status'], \
        f'expected only /api/disk_status, got {api_calls}'
    # Store reads consumers of retired blocks are gone.
    for gone_state in (
        'useStore((s) => s.wsStatus)',
        'useStore((s) => s.wsLatency)',
        'useStore((s) => s.task)',
        'useStore((s) => s.safety)',
        'useStore((s) => s.robot)',
        'useStore((s) => s.edition)',
        'useStore((s) => s.unlockEdition)',
        'useStore((s) => s.lockEdition)',
        'deriveRunState',
    ):
        assert gone_state not in code, \
            f'StatusBar must not still read {gone_state!r}'


def test_brand_wordmark_hosts_edition_click():
    """The NeuRobots wordmark carries the edition affordance. On
    basic devices (no Configure tab) this is the only unlock path;
    on full devices the same click relocks."""
    code = _strip_comments(_read(BRAND))
    assert "useStore((s) => s.edition)" in code
    assert "useStore((s) => s.unlockEdition)" in code
    assert "useStore((s) => s.lockEdition)" in code
    # Prompt / confirm affordances preserved from the retired
    # StatusBar block.
    assert 'window.prompt(' in code
    assert 'window.confirm(' in code
    # Test hook for headless smoke checks.
    assert 'data-testid="brand-edition-hotspot"' in code


def test_system_banners_only_render_when_bad():
    """Banners are non-dismissible and only render when the
    underlying state is bad. `return null` is the healthy state."""
    code = _strip_comments(_read(BANNERS))
    # Guard state trigger — strict === false (not null/unknown).
    assert 'const guardOff = collision === false' in code
    # WS trigger.
    assert "wsStatus === 'disconnected'" in code
    assert "wsStatus === 'connecting'" in code
    # Nothing when both healthy.
    assert 'if (!wsBad && !guardOff) return null' in code
    # Test hooks so headless verifications can assert render/no-render.
    assert 'data-testid="banner-ws-status"' in code
    assert 'data-testid="banner-guard-off"' in code


def test_app_mounts_system_banners():
    src = _read(APP)
    assert "import SystemBanners from './components/SystemBanners'" in src
    assert '<SystemBanners' in src


def test_no_orphan_statusbar_code():
    """Verify clean removal per item 4. The StatusBar file is <=
    ~110 lines (just the disk block + polling) and does not import
    any of the retired dependencies (runState, useStore-based
    edition/ws/task/safety, etc.)."""
    src = _read(SB)
    lines = src.splitlines()
    assert len(lines) <= 120, \
        f'StatusBar should be <=~110 lines after slim, got {len(lines)}'
    # Import list — only useState + useEffect from react.
    imports = [l for l in lines if l.startswith('import ')]
    for retired in (
        'useStore',
        'deriveRunState',
        'runState',
    ):
        for imp in imports:
            assert retired not in imp, \
                f'StatusBar must not import {retired!r} any more'

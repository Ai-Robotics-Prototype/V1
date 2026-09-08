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
    /api/disk_status only. The full-only guard footer needs
    `edition` + `robot.collision_enabled` reads — those are
    permitted."""
    code = _strip_comments(_read(SB))
    # Disk poll is the only wire call left.
    api_calls = re.findall(r"/api/[a-z0-9_/{}]+", code)
    assert api_calls == ['/api/disk_status'], \
        f'expected only /api/disk_status, got {api_calls}'
    # Retired retired-block reads. `edition` + `robot?.collision_enabled`
    # stay because the full-only guard footer text needs them.
    for gone_state in (
        'useStore((s) => s.wsStatus)',
        'useStore((s) => s.wsLatency)',
        'useStore((s) => s.task)',
        'useStore((s) => s.safety)',
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


def test_system_banners_file_retired():
    """2026-09-08 (later same day) banner-removal directive: the
    SystemBanners.jsx file is DELETED, the App.jsx mount is gone,
    and the guard-off top banner no longer overlaps the tab bar."""
    assert not os.path.exists(BANNERS), \
        'SystemBanners.jsx must be removed'
    app_src = _read(APP)
    # Strip comments — the retirement note references the name.
    code = _strip_comments(app_src)
    assert 'SystemBanners' not in code, \
        'App.jsx must not import or mount SystemBanners'


def test_footer_guard_text_is_full_only():
    """Guard-state visibility moves into StatusBar as compact text
    next to disk, gated on isFeatureEnabled('guard_visibility',
    edition). BASIC shows nothing about the guard anywhere; FULL
    shows the red-dot 'Guards OFF' element when
    robot.collision_enabled === false and nothing when it's on."""
    code = _read(SB)
    # Feature gate wired.
    assert "isFeatureEnabled('guard_visibility', edition)" in code
    # Strict === false: null/undefined must NOT alert.
    assert 'collision === false' in code
    # Text hook + copy pinned.
    assert 'data-testid="footer-guards-off"' in code
    assert 'Guards OFF' in code
    # Guard visibility feature key exists in the frontend mirror.
    from_lib = _read(os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'lib', 'edition.js')))
    assert 'guard_visibility:   EDITION_FULL' in from_lib


def test_guard_enforcement_is_edition_independent():
    """Item 3: enforcement stays edition-independent. The
    guard_visibility feature key gates ONLY operator-visible state;
    the collision_guard endpoint stays reachable both editions.
    Assert: within the middleware pattern list block, no entry
    routes /api/collision_guard to a feature refusal."""
    server_src = _read(os.path.abspath(os.path.join(
        HERE, '..', 'cobot_dashboard', 'dashboard_server.py')))
    # Slice the pattern-list block and check no collision_guard
    # entry lives there.
    i = server_src.find('_EDITION_FULL_ONLY_PATTERNS = [')
    assert i != -1, 'pattern list not found'
    j = server_src.find(']', i)
    block = server_src[i:j]
    assert '/api/collision_guard' not in block, \
        ('/api/collision_guard must NOT be gated — safety '
         'enforcement is edition-independent')


def test_no_orphan_statusbar_code():
    """Verify clean removal per item 4. StatusBar file stays small
    (disk + full-only guard text), and does not import retired
    dependencies (runState). useStore + isFeatureEnabled are
    permitted for the guard footer."""
    src = _read(SB)
    lines = src.splitlines()
    assert len(lines) <= 160, \
        f'StatusBar should be <=~150 lines after slim, got {len(lines)}'
    imports = [l for l in lines if l.startswith('import ')]
    for retired in (
        'deriveRunState',
        'runState',
    ):
        for imp in imports:
            assert retired not in imp, \
                f'StatusBar must not import {retired!r} any more'

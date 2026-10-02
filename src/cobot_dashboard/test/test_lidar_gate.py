"""LiDAR removal on BASIC edition pinned regression (2026-09-08).

Directive:
  1. Monitor's Objects Detected stat + IdentifiedObjectsCard both
     hide on basic; full renders both. Row auto-reflows.
  2. Every other basic-visible surface swept for LiDAR — audit
     documented in the commit report.
  3. Backend /api/lidar_objects/* + /api/lidar_workspace_mask*
     refuse for basic devices via the edition middleware. LiDAR
     services keep running for full devices + any program logic
     that consumes them.
  4. Feature key `lidar` in FEATURE_MAP as full-only. No
     safety-invariant collision (safety keys stay rejected).
"""

from __future__ import annotations

import os
import re
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_ROOT = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))
MONITOR = os.path.join(FRONTEND_ROOT, 'pages', 'MonitorDashboard.jsx')
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))
LIB = os.path.join(FRONTEND_ROOT, 'lib', 'edition.js')

sys.path.insert(0, os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard')))
import edition as _edition_mod  # noqa: E402


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_comments(src):
    s = re.sub(r'/\*.*?\*/',     '', src, flags=re.DOTALL)
    s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.DOTALL)
    return '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))


def test_lidar_feature_key_full_only_in_both_modules():
    """FEATURE_MAP.lidar = EDITION_FULL in both backend Python
    module + frontend JS mirror. Basic devices fail closed on
    is_feature_enabled('lidar')."""
    assert _edition_mod.FEATURE_MAP.get('lidar') == 'full'
    assert not _edition_mod.is_feature_enabled('lidar', 'basic')
    assert _edition_mod.is_feature_enabled('lidar', 'full')
    # Frontend mirror.
    js = _read(LIB)
    assert 'lidar:              EDITION_FULL' in js
    # Safety-invariant collision fence still holds.
    assert 'lidar' not in _edition_mod.SAFETY_INVARIANT_KEYS


def test_monitor_hides_lidar_stat_and_card_on_basic():
    """<StatCard label="Objects Detected"> AND <IdentifiedObjects
    Card /> both wrapped in `{lidarVisible && ...}` — basic
    renders neither, full renders both. The wrapping expression
    reads isFeatureEnabled('lidar', edition)."""
    code = _strip_comments(_read(MONITOR))
    # Import + hook wired.
    assert "import { isFeatureEnabled } from '../lib/edition'" in code
    assert "isFeatureEnabled('lidar', edition)" in code
    # Objects Detected stat card gated.
    idx = code.find('label="Objects Detected"')
    assert idx != -1, 'Objects Detected StatCard must still exist'
    # Look backwards ~200 chars for the `{lidarVisible && (` wrapper.
    window = code[max(0, idx - 300):idx]
    assert 'lidarVisible && (' in window, \
        'Objects Detected StatCard must be gated by lidarVisible'
    # IdentifiedObjectsCard gated.
    idx2 = code.find('<IdentifiedObjectsCard')
    assert idx2 != -1
    window2 = code[max(0, idx2 - 300):idx2]
    assert 'lidarVisible' in window2, \
        'IdentifiedObjectsCard must be gated by lidarVisible'


def test_backend_middleware_gates_lidar_objects_and_workspace_mask():
    """The edition middleware's URL-regex list carries entries for
    /api/lidar_objects/* (all methods) and /api/lidar_workspace_
    mask* (all methods), both keyed 'lidar'. Full devices reach
    both endpoints unchanged; basic gets a 403 named refusal."""
    src = _read(SERVER)
    assert "'^/api/lidar_objects($|/)'" in src
    assert "'^/api/lidar_workspace_mask($|/)'" in src
    assert "'lidar'" in src
    # Sanity: guard_visibility patterns retired (they were never
    # added — no visibility gate needs backend method-awareness).
    # No stray `_require_full_edition(request, 'lidar')` per-endpoint
    # calls; middleware is the ONE audit site.
    assert "_require_full_edition(request, 'lidar')" not in src


def test_backend_endpoints_still_serve_full_devices():
    """The middleware only refuses when is_feature_enabled returns
    false. A full device (edition resolves to 'full') passes the
    method + edition check, so the endpoint handlers run
    unchanged. This test asserts the underlying handler
    definitions still exist on the backend."""
    src = _read(SERVER)
    for endpoint in (
        '@app.get("/api/lidar_objects/identified")',
        '@app.get("/api/lidar_workspace_mask")',
    ):
        assert endpoint in src, \
            f'lidar handler {endpoint} must still be defined on the backend'

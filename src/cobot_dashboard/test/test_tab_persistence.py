"""Tab-persistence bug fix pinned regression (2026-09-08).

Directive:
  1. Refreshing the dashboard must stay on the current tab. Prior
     bug: reload always landed on Program.
  2. Persist per-device (same class as edition + client id +
     ui_context). Zustand persist to `localStorage.roboai-ui`
     satisfies this — it's per-device (per browser origin), same
     class as CLIENT_ID's uuid-per-tab.
  3. Stale hidden-in-current-edition persisted tab snaps to
     Monitor via the App.jsx edition-guard useEffect.

Root cause pinned by this test:
  * `restoreOpenProgramOnMount` in useStore.js used to run on App
    mount, read `active_tab` from the server's ui_context, and
    call setActiveTab(activeTab) — overwriting the freshly-
    rehydrated zustand-persisted value. Because server-side
    `active_tab` is only WRITTEN via rememberOpenProgram (which
    fires on program-open events, not tab switches), the server
    value was stale — usually 'program', which is why refresh
    landed there.
  * Fix: skip the server-side active_tab restore. Zustand persist
    owns activeTab across refreshes. The edition-guard fallback
    already handles stale hidden-tab values.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'store', 'useStore.js'))
APP = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'App.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_active_tab_still_in_zustand_persist_partialize():
    """Zustand persist must carry activeTab across page refreshes.
    partialize() picks the slots that get written to localStorage —
    activeTab must appear there."""
    src = _read(STORE)
    # Locate partialize block and check activeTab lives inside.
    m = re.search(r'partialize:\s*\(state\)\s*=>\s*\(\{([^}]*)\}\)',
                  src, re.DOTALL)
    assert m, 'partialize function not found in useStore.js'
    keys = m.group(1)
    assert 'activeTab: state.activeTab' in keys, \
        'activeTab must be in zustand persist partialize'


def test_restore_open_program_does_not_overwrite_active_tab():
    """restoreOpenProgramOnMount reads ui_context.active_tab from
    the server (for legacy compat) but MUST NOT call setActiveTab
    with it — zustand persist owns the value across refreshes.
    The old `if (activeTab) { setActiveTab(activeTab) }` block is
    what caused the "reload lands on Program" bug."""
    src = _read(STORE)
    # The function still exists.
    assert 'async restoreOpenProgramOnMount()' in src
    # But it must not call setActiveTab with the server-side value.
    # We accept the read (`activeTab = b?.context?.active_tab`)
    # staying for possible future consumers; we forbid the write.
    # The current code retains the read into
    # `_server_active_tab_unused` behind an eslint-disable so the
    # value is captured but never applied.
    body = src[src.find('async restoreOpenProgramOnMount()'):
               src.find('async restoreOpenProgramOnMount()') + 3000]
    assert 'setActiveTab(activeTab)' not in body, \
        ('restoreOpenProgramOnMount must not overwrite activeTab '
         'with the server-side ui_context value — that clobbers '
         'the freshly-rehydrated zustand persist slot on refresh')


def test_edition_guard_snap_gated_on_edition_hydration():
    """App.jsx edition-guard useEffect must gate on
    editionHydrated. Before hydration, `edition` is at its 'basic'
    default; a Full device with a persisted full-only tab would
    get bounced to Monitor for one paint. Gate the snap so the
    guard only fires after /api/edition has answered."""
    src = _read(APP)
    assert 'editionHydrated' in src, \
        'edition-guard useEffect must read editionHydrated'
    # useEffect body starts with the gate.
    m = re.search(
        r'useEffect\(\s*\(\)\s*=>\s*\{\s*'
        r'if\s*\(!editionHydrated\)\s*return',
        src)
    assert m, \
        ('edition-guard useEffect must early-return on !editionHydrated '
         'before considering _tabAllowed')


def test_layout_fallback_also_gated_on_hydration():
    """The layout fallback (`other = _tabAllowed ? ... :
    <MonitorDashboard />`) must not force Monitor before edition
    hydrates — same rationale as the snap-back useEffect."""
    src = _read(APP)
    assert '_tabPassesGate' in src
    assert 'const _tabPassesGate = _tabAllowed || !editionHydrated' in src

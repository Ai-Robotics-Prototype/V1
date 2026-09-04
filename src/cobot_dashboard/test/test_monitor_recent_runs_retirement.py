"""Monitor Recent-runs retirement + recorder budget refit
regression (2026-09-04).

Directive:
  1. Monitor screen no longer renders the Recent runs section
     (RecentRunsCard). The Monitor is for running the CURRENT
     program, not browsing history.
  2. Recorder keeps writing on every run; budget changes:
       * Hard size cap: 2 GB → 300 MB (default env value)
       * Age cap:       14 d → 7 d
       * Effective cap = min(hard, 20 % of currently-free disk)
         enforced at every retention pass so a shrinking disk
         shrinks the recorder's budget in lockstep.
  3. Recordings stay reachable OFF the Monitor via ConfigureLayout
     ("Motion recordings" section wrapping the same RecentRunsCard
     — one component, two homes retired to one).
  4. Recorder stats line (samples · MB · Hz · cap) inside the card
     is retired along with the rest of the Monitor status widgets.
  5. Pause condition: no non-UI consumer of /api/runs endpoints
     depends on the Monitor rendering — the recorder writes
     manifests + segments regardless of who reads them. useStore's
     post-run codegen-stale toast still fetches /api/runs; that
     survives the UI move.
"""

from __future__ import annotations

import os


HERE = os.path.dirname(os.path.abspath(__file__))
MONITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'MonitorDashboard.jsx'))
CONFIGURE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'ConfigureLayout.jsx'))
CARD = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'RecentRunsCard.jsx'))
RECORDER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'joint_recorder.py'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_monitor_no_longer_imports_or_renders_recent_runs():
    src = _read(MONITOR)
    assert 'import RecentRunsCard' not in src, \
        'Monitor must not import RecentRunsCard'
    assert '<RecentRunsCard' not in src, \
        'Monitor must not render <RecentRunsCard />'


def test_configure_hosts_recent_runs():
    """New home is Configure (per operator directive: 'if an
    existing page can host a simple Motion recordings list …
    move it there')."""
    src = _read(CONFIGURE)
    assert "import RecentRunsCard from '../components/RecentRunsCard'" in src
    assert '<RecentRunsCard' in src


def test_recorder_stats_line_retired_from_card():
    """The `recorder: N samples · MB · Hz · cap G/d` monospace line
    that used to sit above the runs list is gone. The `recorder`
    state variable is retired too — no consumer."""
    src = _read(CARD)
    # Card header retitled per new home ("Motion recordings" vs
    # "Recent runs").
    assert 'Motion recordings' in src
    # Retired stats-line renderer.
    assert 'recorder.samples_total' not in src
    assert 'recorder.disk_bytes' not in src
    assert 'recorder.retention_bytes' not in src
    # State + setter both removed.
    assert 'const [recorder, setRec]' not in src
    assert 'setRec(' not in src


def test_recorder_budget_default_is_300mb_7days():
    src = _read(RECORDER)
    # Hard defaults expressed as 300 MB and 7 days.
    assert "str(300 * 1024 * 1024)" in src
    assert "str(7 * 86400)" in src
    # No stale 2 GB / 14 d defaults left in the module.
    assert "'2000000000'" not in src
    assert "14 * 86400" not in src


def test_recorder_20_percent_free_space_guard():
    """`_effective_size_cap` enforces min(RETENTION_BYTES,
    RETENTION_FREE_FRACTION * free_bytes). Called from
    enforce_retention BEFORE the size-prune loop so a shrinking
    disk shrinks the recorder's effective budget."""
    src = _read(RECORDER)
    assert 'RETENTION_FREE_FRACTION' in src
    assert "'0.20'" in src, \
        'default free-space fraction must be 20 %'
    assert 'def _effective_size_cap() -> int:' in src
    # Free-space read must go through the fork-registry-canonical
    # owner (disk_watchdog). Direct os.statvfs in the recorder is
    # blocked by fork_lint.
    assert 'from cobot_dashboard import disk_watchdog as _dw' in src
    assert '_dw.free_bytes()' in src
    assert 'os.statvfs(' not in src, \
        ('recorder must not call os.statvfs directly — route through '
         'disk_watchdog.free_bytes() (fork registry: disk_watchdog)')
    # enforce_retention uses the effective cap, not the raw
    # RETENTION_BYTES.
    er_i = src.find('def enforce_retention')
    er_body = src[er_i:er_i + 2500]
    assert 'size_cap = _effective_size_cap()' in er_body
    assert 'while total > size_cap' in er_body


def test_pause_condition_none_triggered():
    """The only non-UI consumer of /api/runs on the frontend is
    useStore's post-run codegen-stale toast. It fetches the same
    endpoint; moving the UI doesn't change the endpoint or the
    manifest write path. This asserts the toast fetch still exists
    (i.e. we didn't inadvertently retire the store logic that
    piggybacks on the same manifest)."""
    store = os.path.abspath(os.path.join(
        HERE, '..', 'frontend', 'src', 'store', 'useStore.js'))
    src = _read(store)
    assert "fetch('/api/runs')" in src

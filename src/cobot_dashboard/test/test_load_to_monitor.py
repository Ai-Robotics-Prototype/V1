"""Load-to-Monitor pinned regression (2026-09-04).

Directive:
  1. Program Library's detail modal exposes a primary "Load to
     Monitor →" button alongside Edit / Duplicate / Delete / Close.
     Never a bare "Run" label — this button must not run motion.
  2. Both the Library button and MonitorDashboard's Change Program →
     select flow call the SAME loader (lib/loadProgramFlow). One
     loader, not a second parallel implementation.
  3. The loader hits ONLY /api/programs/{id} (GET) and
     /api/estun/program/run with push_only:true. It never sends
     `run` verbs or motion commands.
  4. Refused push still commits the program locally (184ada3 rule):
     setCurrentProgram fires either way; the named refusal toast
     explains what the controller doesn't have.
  5. Both editions get the button by construction (no edition gate on
     the Library detail modal).
  6. After a successful load, navigation goes to the Monitor tab.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'lib', 'loadProgramFlow.js'))
LIBRARY = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'ProgramLibrary.jsx'))
MONITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'MonitorDashboard.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_shared_loader_module_exists():
    """The shared lib exports loadProgramFlow with the load contract."""
    src = _read(LIB)
    assert 'export async function loadProgramFlow' in src
    assert 'push_only:  true' in src, \
        'loader must use push_only, never a bare `run` publish'


def test_shared_loader_never_sends_run_or_motion_verbs():
    """Grep the lib for anything that would issue a real motion —
    only /api/programs GET and /api/estun/program/run push_only POST
    are permitted."""
    src = _read(LIB)
    # The only /api/ endpoints the loader may touch:
    api_calls = re.findall(r"/api/[a-z0-9_/{}?=]+", src)
    for path in api_calls:
        assert path in ('/api/programs/', '/api/estun/program/run'), \
            f'unexpected endpoint in loader: {path!r}'
    # The only body-key related to run is push_only:true.
    assert 'push_only:  true' in src
    # Strip comments before checking for forbidden verbs — comments
    # legitimately reference to_auto / run to explain WHY push_only
    # short-circuits before them, but the CODE must not touch them.
    code = re.sub(r'//.*', '', src)
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.DOTALL)
    for verb in ('to_auto', 'run_program',
                 'execute', 'movJ', 'movL', 'setDO'):
        assert verb not in code, \
            f'loader must not contain motion verb {verb!r}'


def test_library_detail_modal_has_load_to_monitor_button():
    src = _read(LIBRARY)
    # Primary action label is operator-facing prose, not a bare "Run".
    assert 'Load to Monitor →' in src or 'Load to Monitor' in src
    # Never "Run" on a button that doesn't run.
    # (We do allow the word Run in comments explaining what NOT to
    # do; scope the assertion to <button ... Run <)
    button_run = re.findall(r'<button[^>]*>\s*Run\s*<', src)
    assert not button_run, ('Library detail modal must not carry a '
                            '"Run" button — Run lives only on Monitor')


def test_library_wires_load_to_monitor_through_shared_loader():
    src = _read(LIBRARY)
    assert "from '../lib/loadProgramFlow'" in src
    assert 'loadProgramFlow({' in src
    # After load, navigate to Monitor.
    assert "setTab('monitor')" in src


def test_monitor_uses_the_same_shared_loader():
    """MonitorDashboard's onSelectProgram must route through the SAME
    lib/loadProgramFlow — otherwise we have a second parallel loader
    that can drift. This test also implicitly asserts the earlier
    inline pushProgramToController is retired."""
    src = _read(MONITOR)
    assert "from '../lib/loadProgramFlow'" in src
    assert 'loadProgramFlow({' in src
    # Old inline helper name must be gone.
    assert 'const pushProgramToController = async' not in src, \
        ('inline pushProgramToController helper retired — one loader '
         'lives in lib/loadProgramFlow')


def test_load_to_monitor_not_edition_gated():
    """The Load-to-Monitor affordance must render in BOTH editions.
    Program Library itself is program_library (basic); the detail
    modal + button are inside that surface with no additional
    edition wrapper."""
    src = _read(LIBRARY)
    # No isFeatureEnabled/FeatureGate/edition check wrapping the
    # load button or the ProgramDetailsModal.
    assert 'isFeatureEnabled' not in src, \
        ('ProgramLibrary must NOT gate on edition — the whole page '
         'is basic-tier and the Load button ships in both editions')


def test_loader_commits_current_program_regardless_of_push_outcome():
    """184ada3 rule: refused controller push does NOT erase the
    loaded program from the editor. setCurrentProgram fires before
    the return in every branch — including the network-failure and
    push-refused branches."""
    src = _read(LIB)
    # setCurrentProgram appears in at least 2 branches — the normal
    # path AND the network-failure catch block.
    n = src.count('setCurrentProgram({')
    assert n >= 2, (f'expected setCurrentProgram in both the normal '
                    f'and network-failure branches, found {n}')

"""'No program loaded' placeholder retirement (2026-09-08).

Directive:
  1. Dashed placeholder card + Open Program Library / Create New
     Program buttons GONE from Monitor.
  2. Empty state is a plain inline "No program loaded" string in
     the Current Program header slot. `programName = currentProgram
     ?.name || 'No program loaded'` at MonitorDashboard.jsx:864
     already carries this fallback; the placeholder card was
     duplicative visual noise.
  3. Run's named refusal on missing program stays intact — no
     wire changes.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
MONITOR = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'pages', 'MonitorDashboard.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_line_comments(src):
    """Drop line comments but keep JSX block comments — the retirement
    note references the retired strings inside a {/* ... */} block
    that we DO want to keep filtered out for these assertions."""
    s = re.sub(r'\{/\*.*?\*/\}', '', src, flags=re.DOTALL)
    return '\n'.join(
        line for line in s.splitlines()
        if not line.lstrip().startswith('//'))


def test_dashed_placeholder_card_removed():
    """The dashed border container + two nav buttons must be gone.
    The retirement JSX comment references the retired strings by
    name; those references live in the block comment which
    _strip_line_comments filters out."""
    code = _strip_line_comments(_read(MONITOR))
    # Container style + button labels no longer land in the render
    # tree.
    for retired in (
        "border: '2px dashed #d1d5db'",
        'Open Program Library',
        'Create New Program',
    ):
        assert retired not in code, \
            f'"{retired}" must be retired from Monitor render tree'


def test_inline_empty_state_still_wired_in_header_slot():
    """`programName = currentProgram?.name || 'No program loaded'`
    is the inline fallback for the Current Program header slot.
    Pin this so a future edit that swaps out programName without
    supplying an equivalent fallback trips CI."""
    code = _stripped = _strip_line_comments(_read(MONITOR))
    assert "const programName    = currentProgram?.name || 'No program loaded'" in code
    # And the header slot renders it.
    assert '{programName}' in code


def test_run_refusal_name_still_used():
    """The 'no program loaded' named refusal wiring stays — Run
    gates against a missing program via `program_not_loaded` /
    `no_program_home` reason strings. This test asserts the
    detail line still resolves against the load-bearing token so
    a future refactor of the placeholder doesn't drag the run
    gate with it."""
    src = _read(MONITOR)
    # The named refusal detail lives in the runResult handler at
    # MonitorDashboard.jsx:1452 (pre-retirement line) and reads
    # 'No program loaded — no program home.'
    assert 'No program loaded — no program home.' in src

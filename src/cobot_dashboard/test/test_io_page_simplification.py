"""I/O page simplification regression (2026-09-04 operator directive).

Directive:
  1. Removed from the default view: NAMEPLATE bar, status-chip strip
     (VERIFIED / allow_io / bridge / "live · IOManager poll active" /
     assigned+free legend), "N/M assigned · Saved" counter,
     "silkscreen-verified" suffix, and per-card (i) info buttons.
  1a. Wire-verb / Lua command reference section removed entirely.
  2. Kept front-and-center: plate cards + DO toggles. Safety I/O
     header stays; its "safety-PLC domain · not actuated from this UI"
     note shrinks to a tooltip on the header text.
  3. Folded into a single collapsed "Advanced" disclosure:
     Expert force inputs + Clear all N forces sub-button + Reset
     assignments. Nothing else. allow_io / bridgeUp STATE still
     consumed by row-level toggle-disable logic — only the chips
     were removed.
  4. Header text simplified to "I/O".
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
IOP = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'IOPortMap.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_nameplate_bar_retired():
    src = _read(IOP)
    # No `Nameplate` block label anywhere.
    assert '            Nameplate\n' not in src, \
        'NAMEPLATE dark bar must be retired from the I/O page'
    # No JSX branch that would render nameplate.model/serial.
    assert '{nameplate.model}' not in src
    assert '{nameplate.serial}' not in src


def test_status_chip_strip_retired():
    src = _read(IOP)
    # Strip BOTH line comments (`// …`) and JSX block comments
    # (`{/* … */}`) so my own explanatory comments about the retired
    # chip strip don't false-match. Also strip C-style /* … */.
    def _strip_comments(s):
        s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)
        s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.DOTALL)
        s = '\n'.join(
            line for line in s.splitlines()
            if not line.lstrip().startswith('//'))
        return s
    code = _strip_comments(src)
    # The VERIFIED / allow_io / bridge chip strip lived inside the
    # Legend component; that whole function is retired.
    assert 'function Legend(' not in code
    assert 'VERIFIED\n' not in code
    assert 'allow_io: {allowIo' not in code
    assert 'bridge: {bridgeUp' not in code
    assert 'IOManager poll active' not in code
    # Assigned/free dot legend + N/M counter retired.
    assert '{assignedCount}/{totalCount} assigned' not in code


def test_silkscreen_verified_suffix_retired():
    src = _read(IOP)
    assert 'silkscreen-verified' not in src
    # Header text simplified.
    assert '          I/O\n' in src, \
        'header must read plain "I/O"'


def test_per_card_info_circles_retired():
    """Four (i) info circles across PairRowsBlock / SectionsBlock /
    PlateBlock (two variants) are gone. Match the specific 14×14
    circle pattern that was used for the info buttons."""
    src = _read(IOP)
    # The circle-pattern JSX with cursor: 'help' rendering the "i"
    # glyph should no longer close with `}}>i</span>`. The one
    # remaining `>i</span>` occurrence is on the wiring-mode chip's
    # inline hint (line ~875, `<span ...>i</span>` inside a bigger
    # chip), which the directive did not target.
    circle_infos = re.findall(
        r"width: 14, height: 14, borderRadius: '50%',\s+background: '#fff', color: C\.textMuted,\s+border: `1px solid \$\{C\.border\}`,\s+fontSize: 9, fontWeight: 700, cursor: 'help',",
        src)
    assert not circle_infos, \
        (f'expected zero per-card (i) info circles, found '
         f'{len(circle_infos)}')


def test_verb_reference_section_retired():
    """Item 1a: the entire wire-verb / Lua command reference details
    block is gone. Its summary line + iteration over `verbs`
    entries must both be absent."""
    src = _read(IOP)
    assert 'Verb reference · ' not in src
    assert 'Object.entries(verbs)' not in src
    # data.verbs is not destructured any more — no consumer.
    assert 'const verbs' not in src


def test_advanced_disclosure_folds_the_two_named_controls():
    src = _read(IOP)
    assert 'function AdvancedControls(' in src
    # Collapsed by default (bare <details> with no `open` attr).
    adv = src[src.find('function AdvancedControls'):
              src.find('function AdvancedControls') + 2500]
    assert '<details' in adv
    assert 'open=' not in adv, \
        'Advanced disclosure must be collapsed by default'
    assert 'Advanced' in adv
    # Both named controls present inside AdvancedControls.
    assert 'Expert: force inputs' in adv
    assert 'Reset assignments' in adv
    # Sub-affordance (Clear all N forces) stays with Expert.
    assert 'Clear all {forcedCount} force' in adv


def test_advanced_disclosure_wired_in_render():
    src = _read(IOP)
    assert '<AdvancedControls' in src
    # And <Legend ...> is no longer called.
    assert '<Legend' not in src


def test_allow_io_and_bridge_state_still_consumed_by_toggle_logic():
    """Item 3: allow_io / bridgeUp CHIPS retired but the STATE is
    still consumed by row-level toggle-disable logic. Preserving
    the disable behaviour is load-bearing (a toggle that fires
    while the bridge is down publishes to nothing)."""
    src = _read(IOP)
    assert 'const toggleDisabled = !allowIo || !bridgeUp' in src
    # Provider still exposes both to the row-level useIOLive hook.
    # Match with whitespace flexibility — the value object spans
    # multiple lines.
    assert re.search(r'live,\s*allowIo,\s*bridgeUp,\s*expertMode', src)


def test_safety_header_note_became_a_tooltip():
    """Item 2: Safety I/O header stays; its 'safety-PLC domain ·
    not actuated from this UI' note shrinks to a tooltip on the
    header text, not its own visible inline strip."""
    src = _read(IOP)
    # The inline italic strip is gone.
    assert "fontStyle: 'italic' }}>\n          safety-PLC domain" not in src
    # The copy survives as a title on the header span.
    assert 'title="safety-PLC domain · not actuated from this UI"' in src


def test_do_toggle_endpoint_still_wired():
    """Load-bearing: the DO toggle path still calls /api/io/set
    or the equivalent write endpoint via useIOLive.writePort. The
    Advanced disclosure change must not have disturbed the write
    path itself."""
    src = _read(IOP)
    assert 'writePort' in src
    # /api/io/set (or /api/io/force for expert-mode DIs) is the wire.
    assert '/api/io/set' in src or '/api/io/force' in src

"""3D View banner→badge pinned regression (2026-09-04).

Directive:
  1. Remove the full-width green READY status bar. Replace with a
     small READY / NOT READY badge (green/red dot + word) placed
     directly next to the ENABLE/DISABLE button. State info must
     remain visible at a glance.
  2. Remove the small duplicate "Disable" pill that lived at the
     right end of the banner — <ArmEnableControl /> owns the one
     canonical enable/disable control.
  3. MODE • MANUAL chip removal STOPPED and reported before
     deleting — dialog is load-bearing (mode switch + interlock).
     This test does NOT assert ModeControl removal; it will be
     added or dropped once the operator confirms.
  4. Layout: banner-height reclaimed for the 3D viewport.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
JOG = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JogControls.jsx'))
BADGE = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'components', 'JogReadyBadge.jsx'))
CHROME = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src', 'layouts', 'View3DLayout.jsx'))


def _read(path):
    with open(path) as fh:
        return fh.read()


def test_ready_badge_component_exists():
    src = _read(BADGE)
    assert 'export default function JogReadyBadge' in src
    # Green / red / yellow dot + word — compact chip.
    assert "'READY'" in src
    assert 'NOT READY' in src
    assert "data-testid=\"jog-ready-badge\"" in src


def test_badge_rendered_next_to_arm_enable_control():
    """Badge must be adjacent to <ArmEnableControl /> in the
    RealArmChrome header — the operator's pre-jog cue lives at the
    same visual site as the enable button. Strip line comments
    first so a `// <ArmEnableControl />` doc mention doesn't get
    picked up in place of the JSX element."""
    src = _read(CHROME)
    assert 'import JogReadyBadge' in src
    code = '\n'.join(
        line for line in src.splitlines()
        if not line.lstrip().startswith('//'))
    jsx_idx = code.find('<ArmEnableControl />')
    assert jsx_idx != -1, 'JSX element <ArmEnableControl /> not found'
    header_slice = code[jsx_idx:jsx_idx + 500]
    assert '<JogReadyBadge' in header_slice, \
        'badge must be adjacent to <ArmEnableControl /> in the header'


def test_banner_and_actions_removed_from_jogcontrols():
    """The full-width State banner render block is gone. `bannerBg`
    (its background-color helper) and `bannerActions` (its inline
    action pills — Enable / Disable / Clear Alarm / ↗ Recovery
    guide) must have zero references."""
    src = _read(JOG)
    # bannerBg helper retired.
    assert 'const bannerBg = ' not in src
    # bannerActions computation retired.
    assert 'bannerActions' not in src
    # Old comment header for the banner render block is gone.
    assert 'State banner — always visible' not in src
    # The right-side "subtle Disable" pill class is retired.
    assert "appearance: 'subtle'" not in src


def test_jog_gate_state_still_computed_for_button_greying():
    """bannerLevel / bannerText computation stays — jogGateOk gates
    pad buttons; bannerText is the tooltip when a pad is greyed
    ('why can't I jog right now'). Badge upstream mirrors the
    same precedence."""
    src = _read(JOG)
    assert "const jogGateOk = bannerLevel === 'ready'" in src
    assert 'let bannerLevel' in src
    assert 'let bannerText' in src
    # tooltip still references bannerText on the disabled buttons.
    assert 'tooltip: !jogGateOk' in src


def test_badge_precedence_matches_banner_precedence():
    """Badge's computeReadyState precedence must byte-align with
    JogControls' bannerLevel table — same conditions in the same
    order — so the badge and the pad-tooltip cannot disagree on
    'is jog gated open right now'."""
    badge = _read(BADGE)
    # The precedence order asserted by presence — E-STOP first,
    # then driver, then joint-limit, then alarm, then enabling, then
    # disabled, then running, then jog gate closed.
    order = [
        ('E-STOP',          badge.find("'NOT READY: E-STOP'")),
        ('DRIVER',          badge.find("'NOT READY: DRIVER DISCONNECTED'")),
        ('JOINTS',          badge.find('JOINTS PAST LIMIT')),
        ('ALARM',           badge.find("'NOT READY: ALARM'")),
        ('ENABLING',        badge.find("'ENABLING…'")),
        ('DISABLED',        badge.find("'NOT READY: DISABLED'")),
        ('RUNNING',         badge.find("'NOT READY: PROGRAM RUNNING'")),
        ('JOG_CLOSED',      badge.find("'NOT READY: JOG GATE CLOSED'")),
        ('READY',           badge.find("'READY'")),
    ]
    for name, pos in order:
        assert pos != -1, f'badge missing precedence entry: {name}'
    positions = [pos for _, pos in order]
    assert positions == sorted(positions), \
        f'badge precedence out of order (order fail): {order}'


def test_alarm_modal_reopen_chip_retired_from_jogcontrols():
    """The banner's ↗ Recovery guide reopen chip is retired. Modal
    owns its own minimize/restore lifecycle; JogControls no longer
    touches alarmModalMinimized. The store slice stays for the
    modal itself (AlarmRecoveryModal.jsx)."""
    src = _read(JOG)
    assert 'alarmModalMinimized' not in src
    assert 'setAlarmModalMinimized' not in src
    # AlarmRecoveryModal is the surviving owner — do not touch it here.


def test_disable_pill_retired_from_ready_state():
    """When ready, no small right-side Disable pill anywhere in
    JogControls. The one canonical enable/disable control is
    <ArmEnableControl />."""
    src = _read(JOG)
    # kind:'disable' as a bannerActions entry is gone.
    assert "{ kind: 'disable'" not in src
    # No bare 'Disable' label rendered inside JogControls
    # (ArmEnableControl's label is a store-derived string; not
    # matched by this literal).
    matches = re.findall(r"label:\s*'Disable'", src)
    assert matches == [], \
        f"stray Disable pill labels in JogControls: {matches}"

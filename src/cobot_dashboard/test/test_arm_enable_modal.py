"""ArmEnableControl app-theme confirm modal (2026-09-17).

Directive: the previous flow used window.confirm() on Enable —
off-theme, breaks the app-wide native-popup ban. Replaced with a
centered app-theme modal mirroring OrientFlangeDownControl:
title + plain-language body + primary/Cancel buttons, backdrop no
click-through, Escape cancels. Both Enable AND Disable prompt now
(green vs red primary). Fetch (sendPowerCommand) fires ONLY on
Confirm — endpoint gating unchanged.

App-wide census: every remaining window.confirm() / .alert() /
bare confirm(/alert( call is listed as a board item — this pin
suite locks in the enable/disable retirement and pins the census
threshold so a regression in ArmEnableControl surfaces at deploy
time.
"""

from __future__ import annotations

import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
FRONT_SRC = os.path.abspath(os.path.join(
    HERE, '..', 'frontend', 'src'))
ARM_ENABLE = os.path.join(FRONT_SRC, 'components', 'ArmEnableControl.jsx')
ORIENT     = os.path.join(FRONT_SRC, 'components', 'QuickOrientButtons.jsx')


def _read(path):
    with open(path) as fh:
        return fh.read()


def _strip_comments(src):
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.DOTALL)
    src = re.sub(r'\{/\*.*?\*/\}', '', src, flags=re.DOTALL)
    return '\n'.join(
        line for line in src.splitlines()
        if not line.lstrip().startswith('//'))


def test_no_native_confirm_in_enable_flow():
    """ArmEnableControl must NOT call window.confirm() / window.alert()
    or bare confirm(/alert(. The 2026-09-17 operator order bans
    native popups app-wide and replaces the Enable flow with the
    app-theme modal.
    """
    src = _strip_comments(_read(ARM_ENABLE))
    for banned in ('window.confirm(', 'window.alert(',
                   'window.prompt('):
        assert banned not in src, (
            f'{banned} must be retired from ArmEnableControl per '
            f'2026-09-17 native-popup ban')
    # Bare `confirm(` / `alert(` too (destructured or global).
    assert not re.search(r'(?<![\w.])confirm\(', src), (
        'bare confirm(...) call must be retired from '
        'ArmEnableControl')
    assert not re.search(r'(?<![\w.])alert\(', src), (
        'bare alert(...) call must be retired from ArmEnableControl')


def test_app_wide_native_popup_census():
    """Frontend-wide native-popup census. Each remaining
    window.confirm / window.alert / confirm( / alert( is a board
    item to migrate to the app modal. This pin ENFORCES the ceiling
    so any NEW native popup breaks CI; the current callers are
    grandfathered explicitly in the ALLOWLIST below.

    When a caller migrates to the modal, remove it from the list.
    When a new native popup lands anywhere, this test breaks first.
    """
    allowlist = {
        # (relpath under frontend/src, callsite excerpt)
        # 2026-09-17 census — board items, not fixed this session.
        # ArmEnableControl explicitly excluded (retired above).
        ('pages/ProgramLibrary.jsx',      'confirm(msg)'),
        ('pages/ProgramLibrary.jsx',      'confirm(\'Delete this folder?'),
        ('components/TeachLockBanner.jsx', 'window.confirm('),
        ('layouts/ConfigureLayout.jsx',   'confirm(\'Delete this cell?'),
        ('layouts/ConfigureLayout.jsx',   'confirm(`Restart '),
        ('layouts/ConfigureLayout.jsx',   'alert(`Restart failed (rc'),
        ('layouts/ConfigureLayout.jsx',   'alert(`Restart failed:'),
        ('layouts/QualityInspectionLayout.jsx', "alert('Failed to start inspection"),
        ('layouts/QualityInspectionLayout.jsx', "confirm('Run cleanup"),
        ('layouts/QualityInspectionLayout.jsx', 'alert(`Deleted '),
        ('layouts/QualityInspectionLayout.jsx', "alert('Re-run queued.')"),
        ('pages/MonitorDashboard.jsx',    'window.confirm(lines.join'),
        ('pages/MonitorDashboard.jsx',    'window.confirm(prompt.join'),
        ('pages/AdaptivePicking.jsx',     "confirm('Delete this part?')"),
        ('pages/AdaptivePicking.jsx',     'confirm('),   # 2nd site, multiline
        ('components/WorkspaceMaskSection.jsx', "confirm('Disable workspace mask"),
        ('components/CellDetailPanel.jsx', 'confirm(`Delete cell '),
        ('components/CellDetailPanel.jsx', "confirm('Clear the static"),
        ('components/PartsLibrary.jsx',   "confirm('Delete this part?')"),
        ('components/Brand.jsx',          "window.confirm('Return this device"),
        ('components/Brand.jsx',          'window.alert(`Unlock refused'),
        ('components/IOPortMap.jsx',      'window.confirm('),  # 3 sites, multiline
        ('components/IOPortMap.jsx',      "confirm('Reset every assignable"),
        # window.prompt sites (also natives; board items).
        ('layouts/QualityInspectionLayout.jsx', "prompt('Path to STEP file:'"),
        ('components/ProgramEditor.jsx',  'window.prompt('),
        ('components/Brand.jsx',          "window.prompt('Unlock Full edition"),
        # Inline documentation strings inside ProgramEditor that
        # happen to match `confirm (` — these are STRING LITERALS in
        # UI labels ("confirm (input to verify)"), not code calls.
        # Allowlist them so the greedy regex doesn't false-positive.
        ('components/ProgramEditor.jsx',  'confirm (input to verify)'),
        # Same shape at pages/AdaptivePicking.jsx: a "prompt (Enter to
        # save)…" tooltip label — string literal, not a call.
        ('pages/AdaptivePicking.jsx',     'prompt (Enter to save)'),
    }

    hits = []
    for root, _dirs, files in os.walk(FRONT_SRC):
        for fname in files:
            if not fname.endswith(('.jsx', '.js')):
                continue
            path = os.path.join(root, fname)
            rel = os.path.relpath(path, FRONT_SRC)
            src = _strip_comments(_read(path))
            for m in re.finditer(
                    r'(?:window\.)?(?:confirm|alert|prompt)\s*\(',
                    src):
                # Snip the call site for the allowlist comparison
                # (first 40 chars including the paren).
                snippet = src[m.start():m.start() + 60].split('\n')[0]
                hits.append((rel, snippet))

    unexpected = []
    for rel, snippet in hits:
        matched = False
        for al_rel, al_prefix in allowlist:
            if rel == al_rel and al_prefix in snippet:
                matched = True
                break
        if not matched:
            unexpected.append((rel, snippet))

    # ArmEnableControl MUST NOT appear anywhere in the hit list.
    for rel, snippet in hits:
        assert 'ArmEnableControl.jsx' not in rel, (
            f'ArmEnableControl.jsx must not use native popups (found '
            f'{snippet!r}) — retired 2026-09-17 in favour of the '
            f'app-theme modal')

    if unexpected:
        listing = '\n'.join(f'  {rel}: {snip}' for rel, snip in unexpected)
        raise AssertionError(
            'New native popup(s) detected in the frontend — migrate to '
            'the app-theme modal (or add to the census allowlist if '
            f'grandfathered):\n{listing}')


def test_enable_modal_copy_and_structure():
    """Enable modal renders the exact operator-approved copy:
      title = "Enable robot?"
      body  = "The arm will power its motors and be ready to move."
      cta   = "Enable" (green — matches the ENABLE button chip)
    Disable modal mirrors:
      title = "Disable robot?"
      body  = "Motor power will be turned off."
      cta   = "Disable" (red — matches the DISABLE button chip)
    """
    src = _read(ARM_ENABLE)

    # Titles.
    assert "title: 'Enable robot?'" in src, (
        "Enable modal title must be 'Enable robot?'")
    assert "title: 'Disable robot?'" in src, (
        "Disable modal title must be 'Disable robot?'")
    # Bodies.
    assert 'The arm will power its motors and be ready to move.' in src, (
        'Enable modal body must be the operator-approved plain-'
        'language copy')
    assert 'Motor power will be turned off.' in src, (
        'Disable modal body must be the operator-approved plain-'
        'language copy')
    # CTA labels.
    assert "cta: 'Enable'" in src
    assert "cta: 'Disable'" in src
    # Primary CTA colors match the terminal chip colors.
    assert 'ENABLED_GREEN' in src, (
        'Enable modal primary must reference ENABLED_GREEN')
    assert 'DISABLED_RED' in src, (
        'Disable modal primary must reference DISABLED_RED')

    # Testids for both dialog states.
    assert 'data-testid="arm-enable-modal"' in src
    assert 'data-testid="arm-enable-backdrop"' in src
    assert 'data-testid="arm-enable-confirm"' in src
    assert 'data-testid="arm-enable-cancel"' in src
    # Modal declares role="dialog" + aria-modal.
    assert 'role="dialog"' in src
    assert 'aria-modal="true"' in src


def test_enable_modal_fetch_gated_by_confirm():
    """sendPowerCommand fires only on Confirm. Cancel closes the
    modal without calling anything. This is the load-bearing
    invariant that keeps endpoint behavior unchanged vs the
    retired native-confirm path.
    """
    src = _strip_comments(_read(ARM_ENABLE))

    # sendPowerCommand invoked only inside onConfirm.
    on_confirm_idx = src.find('const onConfirm')
    assert on_confirm_idx != -1, 'onConfirm handler not found'
    # Find the closing brace of onConfirm (naive: first `}` after
    # the second-level `{`).
    body_start = src.find('{', on_confirm_idx)
    # Grab a reasonable window and assert sendPowerCommand appears.
    on_confirm_body = src[body_start:body_start + 400]
    assert 'sendPowerCommand?.(' in on_confirm_body, (
        'onConfirm must invoke sendPowerCommand?.(action) — this is '
        'the ONLY authorized send site')

    # onCancel must NOT call sendPowerCommand. onCancel is a
    # 1-liner arrow assignment; bound the window tightly to the
    # single-statement body.
    on_cancel_idx = src.find('const onCancel')
    assert on_cancel_idx != -1
    on_cancel_body = src[on_cancel_idx:on_cancel_idx + 80]
    assert 'sendPowerCommand' not in on_cancel_body, (
        'onCancel must not call sendPowerCommand — Cancel closes '
        'the modal without firing any request')

    # onTogglePower (button click) must NOT call sendPowerCommand
    # directly — it only sets pendingAction and opens the modal.
    on_toggle_idx = src.find('const onTogglePower')
    assert on_toggle_idx != -1
    # Body ends at the next `const `.
    next_const = src.find('\n  const ', on_toggle_idx + 20)
    on_toggle_body = src[on_toggle_idx:next_const if next_const != -1 else on_toggle_idx + 400]
    assert 'sendPowerCommand' not in on_toggle_body, (
        'onTogglePower (button click) must NOT invoke sendPowerCommand '
        'directly — it opens the confirm modal; only Confirm fires '
        'the actual command (fetch gate)')


def test_enable_modal_backdrop_no_click_through():
    """Backdrop is pointerEvents:'auto' and does NOT register any
    onClick handler that closes the modal. Dismissal via Cancel +
    Escape only (mirrors the Orient modal contract — enforces the
    "no click-through" operator order for both flows).
    """
    src = _read(ARM_ENABLE)
    bd_idx = src.find('data-testid="arm-enable-backdrop"')
    assert bd_idx != -1
    # Grab the backdrop <div> — approximate: until the next
    # data-testid or role="dialog".
    bd_end = src.find('data-testid="arm-enable-modal"', bd_idx)
    bd_block = src[bd_idx:bd_end]
    assert "pointerEvents: 'auto'" in bd_block, (
        'backdrop must be pointerEvents:auto so clicks do NOT fall '
        'through to the LEFT-column controls behind it')
    # No onClick on the backdrop element itself (only onClick's the
    # buttons carry are in the modal body, past bd_end).
    assert 'onClick=' not in bd_block, (
        'backdrop must not carry onClick — no click-through dismissal '
        '(Cancel + Escape only)')


def test_enable_modal_escape_key_cancels():
    """Escape key must dismiss the modal without invoking
    sendPowerCommand — mirrors the Orient modal keyboard contract.
    """
    src = _strip_comments(_read(ARM_ENABLE))
    # useEffect body listens for 'Escape' keydown and clears
    # pendingAction (which unmounts the modal).
    assert re.search(
        r"e\.key\s*===\s*'Escape'", src), (
        "Enable modal must listen for e.key === 'Escape' in its "
        'useEffect keydown handler')
    # And clear pendingAction (no fetch).
    esc_idx = src.find("e.key === 'Escape'")
    esc_body = src[esc_idx:esc_idx + 200]
    assert 'setPendingAction(null)' in esc_body, (
        'Escape handler must setPendingAction(null) — no fetch '
        'fires on cancel')

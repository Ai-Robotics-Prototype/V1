"""Pinned test for the 2026-08-05 legacy-shape home-share self-heal
in check_program_pending_poses.

Motivating incident: an operator taught ALL points on the tablet
for `holepartpalletize` (a program composed BEFORE the home-
unification composer fix). Save then failed with pending_poses on
step 8 (Return to home) because that step's data lacked
`derived_from: 'home'`. The operator's teaching was NOT lost — 6
poses sat correctly in the draft — but the pending-poses check
had no way to resolve step 8 without an explicit re-teach.

Fix: `check_program_pending_poses` mirrors the frontend's
`isTeachable` sibling-scan. Any move_home AFTER the first
move_home inherits the first's taught pose. Legacy programs
composed before the composer fix self-heal at validate time.
The operator's `overridden === True` flag disables the auto-
share (per parity with the frontend).
"""

from __future__ import annotations

import sys

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.program_ops import check_program_pending_poses


_HOME_JOINTS = [-63.3, -5.55, 91.32, -3.18, 92.15, -106.01]
_PICK_JOINTS = [-29.6, 32.84, 123.26, 65.78, 92.37, -72.28]


def _legacy_hole_part_palletize_shape():
    """The verbatim on-disk shape of holepartpalletize.json prior to
    the home-unification composer fix — TWO move_home steps, neither
    linked. Step 8 has NO derived_from."""
    return {
        'name': 'hole part Palletize',
        'steps': [
            {'id': 1, 'action': 'move_home', 'position_role': 'home',
             'taught': False, 'taught_joints': None, 'label': 'Move to home'},
            {'id': 2, 'action': 'move_linear', 'derived_from': 'pick',
             'label': 'Approach above pick'},
            {'id': 3, 'action': 'move_linear', 'position_role': 'pick',
             'taught': False, 'taught_joints': None, 'label': 'Pick'},
            {'id': 4, 'action': 'set_io',   'label': 'Engage vacuum'},
            {'id': 5, 'action': 'wait',     'label': 'Wait'},
            {'id': 6, 'action': 'move_linear', 'derived_from': 'pick',
             'label': 'Retreat above pick'},
            {'id': 7, 'action': 'move_to_pallet', 'position_role': 'place',
             'taught': False, 'taught_joints': None, 'label': 'Place'},
            {'id': 8, 'action': 'move_home',
             'taught': False, 'taught_joints': None,
             'label': 'Return to home'},
        ],
        'config': {},
    }


# ── The reported case verbatim ────────────────────────────────

def test_legacy_program_second_home_resolves_when_first_is_taught():
    """holepartpalletize scenario: operator teaches step 1 (home) +
    step 3 (pick). Step 8 has NO derived_from on disk. Post-fix,
    check_program_pending_poses infers home-share via the sibling
    scan and resolves step 8."""
    prog = _legacy_hole_part_palletize_shape()
    # Simulate the merge that happened at save: first-home taught,
    # pick taught. Step 8 unchanged (no draft entry for it).
    prog['steps'][0]['taught_joints'] = _HOME_JOINTS
    prog['steps'][0]['taught'] = True
    prog['steps'][2]['taught_joints'] = _PICK_JOINTS
    prog['steps'][2]['taught'] = True
    # Fill pallet frame so step 7 (move_to_pallet) doesn't dominate
    # the findings — the check treats move_to_pallet as pallet-driven
    # (see _NON_MOTION_ACTIONS_FOR_TAUGHT_CHECK). Actually, look:
    findings = check_program_pending_poses(prog)
    codes_by_step = {(f['step_idx'], f['step_id'], f['action']) for f in findings}
    # Step 8 (id=8, idx=7) — was the ONE finding the operator hit.
    assert (7, 8, 'move_home') not in codes_by_step, (
        f'Step 8 (Return to home) still pending after first-home '
        f'was taught. The sibling-scan rule is not firing. '
        f'Findings: {findings!r}')


def test_second_home_still_pending_when_first_home_untaught():
    """Contrapositive: if the FIRST move_home is not taught, the
    sibling scan can't resolve the second either. Both flag."""
    prog = _legacy_hole_part_palletize_shape()
    # Nothing taught.
    findings = check_program_pending_poses(prog)
    home_findings = [f for f in findings if f['action'] == 'move_home']
    # First home flagged for sure.
    assert any(f['step_id'] == 1 for f in home_findings)
    # Second home flagged too — its anchor (first home) is unresolved.
    assert any(f['step_id'] == 8 for f in home_findings)


def test_overridden_second_home_needs_its_own_teach():
    """When step.overridden === True, the sibling-scan short-circuits
    — the operator has declared an independent home. Only the step's
    own taught_joints resolve it."""
    prog = _legacy_hole_part_palletize_shape()
    prog['steps'][0]['taught_joints'] = _HOME_JOINTS
    prog['steps'][0]['taught'] = True
    prog['steps'][7]['overridden'] = True   # step 8 override
    findings = check_program_pending_poses(prog)
    assert any(f['step_id'] == 8 for f in findings), (
        'Overridden second home should require its OWN taught pose. '
        'The sibling-scan should NOT resolve when overridden=true.')
    # And when the operator DOES teach the overridden step, it resolves.
    prog['steps'][7]['taught_joints'] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    prog['steps'][7]['taught'] = True
    findings2 = check_program_pending_poses(prog)
    assert not any(f['step_id'] == 8 for f in findings2)


def test_only_the_first_move_home_is_the_anchor():
    """If a program has THREE move_home steps, only the first is the
    anchor — the second AND third both share its pose. Symmetric
    with the frontend rule."""
    prog = _legacy_hole_part_palletize_shape()
    # Insert a THIRD move_home between step 5 and step 6.
    prog['steps'].insert(5, {'id': 55, 'action': 'move_home',
                              'taught': False, 'label': 'Mid home'})
    prog['steps'][0]['taught_joints'] = _HOME_JOINTS
    prog['steps'][0]['taught'] = True
    findings = check_program_pending_poses(prog)
    home_findings = [f for f in findings if f['action'] == 'move_home']
    assert home_findings == [], (
        f'All later move_home steps must share the first home\'s '
        f'anchor. Got home findings: {home_findings!r}')


def test_non_home_derived_steps_unaffected():
    """The auto-share rule fires ONLY on move_home. A move_linear
    with position_role='place' still requires its own resolution."""
    prog = _legacy_hole_part_palletize_shape()
    prog['steps'][0]['taught_joints'] = _HOME_JOINTS
    prog['steps'][0]['taught'] = True
    # Deliberately leave step 3 (pick) untaught — step 2 + 6
    # derive_from='pick' so they should ALSO flag.
    findings = check_program_pending_poses(prog)
    step_ids = {f['step_id'] for f in findings}
    # Step 8 resolves (home share). Steps 2, 3, 6, 7 remain unresolved
    # (pick is untaught → pick-derived steps unresolved; pallet frame
    # not present → place unresolved).
    assert 8 not in step_ids
    assert 3 in step_ids   # pick anchor untaught

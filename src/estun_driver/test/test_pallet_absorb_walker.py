"""Pinned regressions for the pallet.plan_absorb backward walker
(2026-10-20 field codegen bug).

Motivating incidents: the wizard's `buildPalletizeSteps` emits a
`waypoint` step (2026-10-15 "waypoint offer" commit) between the
pick retreat and `move_to_pallet`, and a `verify_input` step
(dd4798a `verify_input` whitelist + ProgramWizard.jsx:3753/3766)
between the engage `wait` and the retreat. Before this fix, the
backward walker in `pallet.plan_absorb` had NO case for either
action and `break`ed out of the scan at the first encounter —
`absorbed_approach_step` / `absorbed_retreat_step` stayed `None`,
and codegen refused the entire `move_to_pallet` with
`-- REFUSED 'move_to_pallet': no absorbed approach step …` on
EVERY wizard-authored palletize program — even though
`config.pallet_place` was fully populated.

Fix:
  * `waypoint` → transit (walker advances WITHOUT absorbing — the
    waypoint fires once per cycle at its own emission site).
  * `verify_input` → absorb (same engage-sequence category as
    `wait`/`set_io`/gripper helpers — fires once per pick cycle,
    the pallet expansion emits its own vacuum ON/OFF so the
    confirm belongs to the absorbed engage block).

These pins reproduce the exact step shape the wizard emits today
and lock the walker's behaviour against future regressions.
"""

from __future__ import annotations

import sys

sys.path.insert(0, '/home/teddy/cobot_ws/src/estun_driver')

from estun_driver.pallet import plan_absorb


_PICK_JOINTS   = [59.82, 70.53, 123.15, 103.36, 89.51, 91.77]
_HOME_JOINTS   = [25.02, 39.88, 91.15,  40.48, 89.77, 56.95]
_WAYPT_JOINTS  = [41.85, 30.65, 114.63, 54.82, 89.63, 73.80]


def _wizard_palletize_steps():
    """Verbatim shape of the wizard's buildPalletizeSteps emission
    for a vacuum tool with per_pick verification + an operator-
    taught pick_to_place waypoint. Mirrors
    /opt/cobot/programs/palletize{2,3}.json post-f875351 (home
    taught on steps[0]).
    """
    return [
        {'step': 1,  'action': 'move_home', 'label': 'Move to home position',
         'taught': True, 'taught_joints': _HOME_JOINTS,
         'position_role': 'home'},
        {'step': 2,  'action': 'set_io',    'io_id': 'DO3', 'value': 0,
         'io_role': 'vacuum', 'label': 'Vacuum off (ready)'},
        {'step': 3,  'action': 'move_linear', 'derived_from': 'pick',
         'offset_z_mm': 100, 'label': 'Approach above pick'},
        {'step': 4,  'action': 'move_linear', 'position_role': 'pick',
         'taught': True, 'taught_joints': _PICK_JOINTS,
         'label': 'Pick position — contact'},
        {'step': 5,  'action': 'set_io',    'io_id': 'DO3', 'value': 1,
         'io_role': 'vacuum', 'label': 'Engage vacuum'},
        {'step': 6,  'action': 'wait',      'duration_s': 0.5,
         'label': 'Wait for vacuum seal'},
        {'step': 7,  'action': 'verify_input', 'input': 'IN04',
         'on_fail': 'stop', 'label': 'Confirm part grabbed'},
        {'step': 8,  'action': 'move_linear', 'derived_from': 'pick',
         'offset_z_mm': 200, 'label': 'Retreat above pick'},
        {'step': 9,  'action': 'waypoint', 'taught': True,
         'taught_joints': _WAYPT_JOINTS,
         'waypoint_junction': 'pick_to_place',
         'label': 'Waypoint 1 (pick_to_place)'},
        {'step': 10, 'action': 'move_to_pallet', 'mode': 'palletize',
         'label': 'Place at pallet slot [computed at runtime]'},
        {'step': 11, 'action': 'loop', 'goto': 3, 'count': 1,
         'pallet_loop': True},
        {'step': 12, 'action': 'move_home', 'label': 'Return to home'},
    ]


def test_wizard_palletize_absorb_finds_approach_retreat_pick():
    """The field case: wizard-emitted palletize with a pick_to_place
    waypoint between retreat and move_to_pallet + a verify_input in
    the engage block. Pre-fix: absorbed_approach_step / retreat_step
    stayed None (walker broke at the waypoint). Post-fix: all three
    anchor steps resolve."""
    steps = _wizard_palletize_steps()
    plan = plan_absorb(steps, cfg={})

    assert plan.absorbed_retreat_step is not None, (
        "absorbed_retreat_step is None — the walker couldn't walk "
        "past the pick_to_place waypoint (step 9) to find the retreat "
        "(step 8). Codegen will refuse the entire move_to_pallet.")
    assert plan.absorbed_retreat_step.get('label') == 'Retreat above pick', (
        f"absorbed_retreat_step is wrong step: "
        f"{plan.absorbed_retreat_step.get('label')!r}")
    assert plan.absorbed_retreat_step.get('offset_z_mm') == 200

    assert plan.absorbed_approach_step is not None, (
        "absorbed_approach_step is None — the walker couldn't walk "
        "past the verify_input (step 7) + the engage set_io/wait "
        "(steps 5/6) to reach the pick_contact and then the approach.")
    assert plan.absorbed_approach_step.get('label') == 'Approach above pick', (
        f"absorbed_approach_step is wrong step: "
        f"{plan.absorbed_approach_step.get('label')!r}")
    assert plan.absorbed_approach_step.get('offset_z_mm') == 100

    assert plan.absorbed_pick_step is not None, (
        "absorbed_pick_step is None — the walker never reached the "
        "pick_contact.")
    assert plan.absorbed_pick_step.get('position_role') == 'pick'


def test_waypoint_is_not_absorbed_only_transited():
    """The waypoint is a per-cycle authored via-point; absorbing it
    would silently drop the operator's intended routing. The walker
    must step PAST it without adding its id to absorb_step_ids."""
    steps = _wizard_palletize_steps()
    plan = plan_absorb(steps, cfg={})
    waypoint = next(s for s in steps if s.get('action') == 'waypoint')
    assert id(waypoint) not in plan.absorb_step_ids, (
        "waypoint step was absorbed — this would drop the per-cycle "
        "via-point emission. Walker must transit without absorbing.")


def test_verify_input_is_absorbed_into_engage_sequence():
    """verify_input is the "Confirm part grabbed" check that fires
    once per pick cycle after the engage set_io + seal wait. It
    belongs to the absorbed engage block (same category as
    wait/set_io/gripper). The pallet expansion emits its own
    vacuum ON/OFF + confirmation so this step must be absorbed."""
    steps = _wizard_palletize_steps()
    plan = plan_absorb(steps, cfg={})
    verify = next(s for s in steps if s.get('action') == 'verify_input')
    assert id(verify) in plan.absorb_step_ids, (
        "verify_input step was NOT absorbed — the walker would break "
        "at it before reaching the pick_contact + approach. All "
        "wizard-authored palletize programs with per_pick "
        "verification would then refuse 'move_to_pallet'.")


def test_pre_fix_baseline_without_waypoint_and_verify_still_works():
    """Baseline guard: a palletize program without the waypoint AND
    without the verify_input still absorbs cleanly. Protects against
    a regression that would narrow the walker instead of broadening
    it."""
    steps = _wizard_palletize_steps()
    # Strip the two "modern" steps so this is the pre-waypoint-offer
    # pre-verify-input shape.
    steps = [s for s in steps
             if s.get('action') not in ('waypoint', 'verify_input')]
    plan = plan_absorb(steps, cfg={})
    assert plan.absorbed_approach_step is not None
    assert plan.absorbed_retreat_step  is not None
    assert plan.absorbed_pick_step     is not None

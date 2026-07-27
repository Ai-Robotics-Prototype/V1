"""Pinned tests for the PBD Accept-time answer-application contract.

These are the tests that make the whitebowl-symptom class unregressable:
answer stored in intent → composed step list reflects the answer. The
server-side Accept endpoint (dashboard_server.api_pbd_correct) calls
the same compose_program_draft path these tests hit, so a composer
regression here IS an Accept-time regression on the operator's screen.

Test scenarios come straight from the operator's report:
  1. effector=vacuum on a gripper-shaped intent → composed steps carry
     Engage/Disengage vacuum + blow-off triplet + zero open_gripper /
     close_gripper.
  2. source=fixed_position → composed steps carry NO detect step
     (locks the §382 fix at the compose layer).

Ambiguity path bindings intentionally mirror the client's
applyClarifications in ProgramFromDemonstration.jsx: the operator's
answer flips a single field on `op` (effector / source) and the
composer's step-list branching does the rest. If either side drifts,
one of these tests fails.
"""

from programming_by_demonstration.schema import (
    IntentOperation, PartReference, PoseSlot, StructuredIntent,
)
from programming_by_demonstration.program_composer import compose_program_draft


def _gripper_intent():
    """The pre-answer shape of a whitebowl-style demo: a pick_and_place
    op with the default 'finger' effector, camera_library source, an
    unmatched part. Fresh operators land here whenever the AI can't
    decide the effector or the source from the video alone."""
    return StructuredIntent(
        task_summary='Pick the white bowl and place it on the black table.',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference(
                    part_id=None, name='white bowl',
                    confidence=0.2, source='unmatched',
                ),
                sequence_index=1,
                pick=PoseSlot(location_hint='from the stool on the right'),
                place=PoseSlot(location_hint='onto the table in front'),
                effector='finger',
                source='camera_library',
            ),
        ],
    )


def _apply_effector(intent, value):
    """Same field write the client's applyClarifications does for
    path=='effector'. Mutates in place; returns the intent."""
    for op in intent.operations:
        op.effector = value
    return intent


def _apply_source(intent, value):
    for op in intent.operations:
        op.source = value
    return intent


# ── Effector binding — the exact whitebowl scenario ──────────────

def test_accept_effector_vacuum_replaces_gripper_steps():
    intent = _gripper_intent()
    # Pre-answer sanity: composed steps carry gripper actions.
    baseline = compose_program_draft(intent, demo_id='demo_test_accept_a1'
                                     ).to_program_payload()['steps']
    baseline_actions = [s['action'] for s in baseline]
    assert 'close_gripper' in baseline_actions
    assert 'open_gripper'  in baseline_actions

    # Operator answers effector=vacuum. Same field write as
    # applyClarifications in ProgramFromDemonstration.jsx line ~1318.
    _apply_effector(intent, 'vacuum')

    # Server-side recompose (what api_pbd_correct now runs before
    # persisting — see dashboard_server.py ~line 6636).
    steps = compose_program_draft(intent, demo_id='demo_test_accept_a2'
                                  ).to_program_payload()['steps']
    actions = [s['action'] for s in steps]
    labels  = [(s.get('label') or '').lower() for s in steps]

    # Gripper actions must be gone. This is the assertion the operator
    # cared about: no more 'open_gripper' / 'close_gripper' anywhere.
    assert 'open_gripper'  not in actions, actions
    assert 'close_gripper' not in actions, actions

    # Engage + disengage vacuum steps must be present. The composer
    # emits them as set_io steps with labels containing the words —
    # matches the corrected-step listing we ship to operators.
    assert any('engage vacuum' in lab for lab in labels), labels
    assert any('disengage vacuum' in lab for lab in labels), labels

    # Blow-off triplet: set_io / wait / set_io around 'blow off'.
    blow_off_idx = [i for i, lab in enumerate(labels) if 'blow off' in lab]
    assert len(blow_off_idx) >= 2, (
        f'expected blow-off on + off (+ wait) triplet; got: {labels}')


def test_accept_effector_finger_preserves_gripper_steps():
    """Reverse guard — if the operator answers finger, gripper steps
    remain and vacuum steps DO NOT appear (no accidental duplication)."""
    intent = _gripper_intent()
    _apply_effector(intent, 'finger')
    steps = compose_program_draft(intent, demo_id='demo_test_accept_a3'
                                  ).to_program_payload()['steps']
    actions = [s['action'] for s in steps]
    labels  = [(s.get('label') or '').lower() for s in steps]
    assert 'open_gripper'  in actions
    assert 'close_gripper' in actions
    assert not any('engage vacuum' in lab for lab in labels), labels
    assert not any('disengage vacuum' in lab for lab in labels), labels


# ── Source binding — locks §382 fix at the compose layer ─────────

def test_accept_source_fixed_removes_detect_step():
    intent = _gripper_intent()
    # camera_library baseline emits a detect step; recompose after
    # source=fixed_position must not.
    baseline = compose_program_draft(intent, demo_id='demo_test_accept_b1'
                                     ).to_program_payload()['steps']
    assert any(s['action'] == 'detect' for s in baseline), \
        'camera_library baseline should include a detect step'

    _apply_source(intent, 'fixed_position')
    steps = compose_program_draft(intent, demo_id='demo_test_accept_b2'
                                  ).to_program_payload()['steps']
    actions = [s['action'] for s in steps]
    assert 'detect' not in actions, actions


def test_accept_source_camera_keeps_detect_step():
    """Reverse guard — flipping back to camera_library restores detect."""
    intent = _gripper_intent()
    _apply_source(intent, 'camera_library')
    steps = compose_program_draft(intent, demo_id='demo_test_accept_b3'
                                  ).to_program_payload()['steps']
    assert any(s['action'] == 'detect' for s in steps), \
        [s['action'] for s in steps]


# ── Combined: both answers at once (whitebowl actual scenario) ────

def test_accept_vacuum_plus_fixed_matches_whitebowl_answers():
    """The exact combination the operator answered on demo
    demo_20260727T161927_e475ef. Verifies both bindings hold together
    and the composed step list matches the human-readable output we
    reported to the operator (engage/disengage vacuum + blow-off, no
    detect, no gripper)."""
    intent = _gripper_intent()
    _apply_effector(intent, 'vacuum')
    _apply_source(intent, 'fixed_position')
    steps = compose_program_draft(intent, demo_id='demo_test_accept_c1'
                                  ).to_program_payload()['steps']
    actions = [s['action'] for s in steps]
    labels  = [(s.get('label') or '').lower() for s in steps]

    # Nothing gripper-shaped.
    assert 'open_gripper'  not in actions
    assert 'close_gripper' not in actions
    assert 'detect'        not in actions

    # Vacuum path present.
    assert any('engage vacuum'    in lab for lab in labels)
    assert any('disengage vacuum' in lab for lab in labels)

    # Pair skeleton is intact.
    assert actions.count('move_linear') >= 4     # approach/contact × 2 × 2
    assert actions[0]  == 'move_home'
    assert actions[-1] == 'move_home'

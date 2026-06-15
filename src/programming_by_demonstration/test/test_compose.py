"""Smoke tests — verify the composer and schema round-trip without
needing any external deps. These run under colcon test."""

from programming_by_demonstration.schema import (
    IntentOperation,
    PartReference,
    PoseSlot,
    StructuredIntent,
    AVAILABLE_OPERATIONS,
    POSE_AWAITING_PERCEPTION,
)
from programming_by_demonstration.program_composer import compose_program_draft


def _intent_pick_and_place():
    return StructuredIntent(
        task_summary='Pick BT225L24 brackets and place in left tray',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference(
                    part_id='bt225l24', name='BT225L24 bracket',
                    confidence=0.85, source='matched_to_library'),
                sequence_index=1,
                pick=PoseSlot(location_hint='from the bin on the right'),
                place=PoseSlot(location_hint='onto the left tray'),
            ),
        ],
        ambiguities=['Place tray boundary not visually anchored'],
        confidence_overall=0.78,
        backend_id='api:claude-opus-4-7',
        transited_externally=True,
    )


def test_compose_pick_and_place_loads_like_wizard():
    intent = _intent_pick_and_place()
    draft = compose_program_draft(intent, demo_id='demo_test_001')
    payload = draft.to_program_payload()
    # Steps numbered 1..N, contain the expected action labels.
    actions = [s['action'] for s in payload['steps']]
    assert actions[0] == 'move_home'
    assert 'approach' in actions
    assert 'close_gripper' in actions
    assert 'open_gripper' in actions
    assert actions[-1] == 'move_home'
    # All move-style steps carry placeholder pose markers.
    for s in payload['steps']:
        if s['action'] in ('move_home', 'move_joint', 'approach'):
            assert s.get('pose') is None
            assert s.get('pose_status') == POSE_AWAITING_PERCEPTION
    # Draft is tagged so the library can filter.
    assert 'draft' in payload['tags']
    assert 'pbd' in payload['tags']
    assert payload['config']['pbd_metadata']['demo_id'] == 'demo_test_001'


def test_available_operations_match_wizard_set():
    # Sanity: the schema's AVAILABLE_OPERATIONS is exactly the set
    # the wizard currently offers (palletize/depalletize are sister
    # modes — schema lists both).
    assert 'pick_and_place' in AVAILABLE_OPERATIONS
    assert 'sort' in AVAILABLE_OPERATIONS
    assert 'machine_tend' in AVAILABLE_OPERATIONS
    assert 'palletize' in AVAILABLE_OPERATIONS
    assert 'depalletize' in AVAILABLE_OPERATIONS
    # Removed operations from the earlier sweep must NOT reappear.
    assert 'inspect' not in AVAILABLE_OPERATIONS
    assert 'inspect_verify' not in AVAILABLE_OPERATIONS
    assert 'scan_identify' not in AVAILABLE_OPERATIONS


def test_intent_json_round_trip():
    intent = _intent_pick_and_place()
    again = StructuredIntent.from_dict(intent.to_dict())
    assert again.task_summary == intent.task_summary
    assert again.operations[0].operation_type == 'pick_and_place'
    assert again.operations[0].target_part.part_id == 'bt225l24'
    # Poses always coerce to placeholder on parse — no metric data ever sneaks through.
    assert again.operations[0].pick.pose is None
    assert again.operations[0].pick.pose_status == POSE_AWAITING_PERCEPTION


def test_empty_intent_produces_loadable_draft():
    intent = StructuredIntent(ambiguities=['nothing recognisable'])
    draft = compose_program_draft(intent, demo_id='demo_empty_001')
    payload = draft.to_program_payload()
    assert payload['steps'], 'empty intent must still produce a loadable artifact'
    assert payload['tags'] == ['pick_and_place', 'draft', 'pbd']

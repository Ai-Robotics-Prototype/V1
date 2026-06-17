"""Smoke tests — verify the composer and schema round-trip without
needing any external deps. These run under colcon test."""

from programming_by_demonstration.schema import (
    IntentOperation,
    PartReference,
    PoseSlot,
    Scene,
    SceneLocation,
    SceneObject,
    StructuredIntent,
    AVAILABLE_OPERATIONS,
    POSE_AWAITING_PERCEPTION,
    SOURCE_BOTH,
    SOURCE_VIDEO,
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


def test_scene_round_trip_through_intent():
    """Scene survives to_dict/from_dict and keeps grounded matched_part_id
    plus the fused-source marker on both objects and locations."""
    scene = Scene(
        objects=[
            SceneObject(
                label='white bracket',
                matched_part_id='bt225l24',
                matched_part_name='BT225L24 bracket',
                match_confidence=0.86,
                source=SOURCE_BOTH,
                approx_location='in the right bin',
                count_seen='multiple',
            ),
            SceneObject(
                label='unfamiliar widget',
                matched_part_id=None,
                source=SOURCE_VIDEO,
                approx_location='back of the table',
            ),
        ],
        locations=[
            SceneLocation(label='right bin', role='pick_source',
                          approx_position='right side', source=SOURCE_VIDEO),
            SceneLocation(label='left tray', role='place_target',
                          approx_position='left side, front', source=SOURCE_BOTH),
        ],
        spatial_summary='A bin on the right and an empty tray on the left.',
    )
    intent = StructuredIntent(
        task_summary='Pick brackets from the right bin, place on the left tray',
        scene=scene,
        operations=[],
        ambiguities=[],
        confidence_overall=0.81,
        backend_id='api:claude-opus-4-7',
        transited_externally=True,
    )
    again = StructuredIntent.from_dict(intent.to_dict())
    assert again.scene.spatial_summary == scene.spatial_summary
    assert len(again.scene.objects) == 2
    assert again.scene.objects[0].matched_part_id == 'bt225l24'
    assert again.scene.objects[0].source == 'both'
    assert again.scene.objects[1].matched_part_id is None
    assert again.scene.objects[1].source == 'video'
    assert again.scene.locations[0].role == 'pick_source'
    assert again.scene.locations[1].source == 'both'


def test_default_intent_has_empty_scene_not_none():
    """from_dict({}) must produce a usable empty Scene — UI mounts before
    the AI replies and would crash on intent.scene.objects otherwise."""
    intent = StructuredIntent.from_dict({})
    assert intent.scene is not None
    assert intent.scene.objects == []
    assert intent.scene.locations == []
    assert intent.scene.spatial_summary == ''

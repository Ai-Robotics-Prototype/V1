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
    steps = payload['steps']
    actions = [s['action'] for s in steps]
    # Structural expectations under the two-taught-poses-per-pair model:
    #   move_home (framing), grip open, detect, approach (derived) →
    #   pick contact (taught) → grip close → retreat (derived) →
    #   approach place (derived) → place contact (taught) →
    #   grip release → retreat (derived), move_home.
    assert actions[0]  == 'move_home'
    assert actions[-1] == 'move_home'
    assert 'close_gripper' in actions
    assert 'open_gripper'  in actions
    # No standalone 'approach' action any more — all approach/retreat
    # moves are move_linear steps carrying derived_from + offset_z_mm.
    assert 'approach' not in actions
    # Placeholder poses on taught + derived move steps alike; derived
    # steps additionally carry derived_from and no position_role.
    for s in steps:
        if s['action'] in ('move_home', 'move_joint', 'move_linear'):
            assert s.get('pose') is None or s.get('derived_from')
    assert 'draft' in payload['tags']
    assert 'pbd' in payload['tags']
    assert payload['config']['pbd_metadata']['demo_id'] == 'demo_test_001'


def test_compose_pick_place_emits_two_taught_contacts_per_pair():
    """Exactly one taught 'pick' anchor and one taught 'place' anchor.
    Every approach/retreat step is derived_from one of those roles
    with offset_z_mm > 0. No taught data on derived steps."""
    intent = _intent_pick_and_place()
    steps = compose_program_draft(intent, demo_id='demo_p001').to_program_payload()['steps']
    taught_pick  = [s for s in steps if s.get('position_role') == 'pick']
    taught_place = [s for s in steps if s.get('position_role') == 'place']
    assert len(taught_pick)  == 1, taught_pick
    assert len(taught_place) == 1, taught_place
    # Derived pick/place steps: derived_from ∈ {pick, place}, positive Z
    # offset (approach/retreat height). No taught data.
    derived = [s for s in steps
               if s.get('derived_from') in ('pick', 'place')]
    for d in derived:
        assert d.get('offset_z_mm', 0) > 0, d
        assert not d.get('taught_joints')
        assert not d.get('taught_tcp')
        assert not d.get('position_role')
    # And: at least one approach + one retreat on each side.
    dpick  = [d for d in derived if d.get('derived_from') == 'pick']
    dplace = [d for d in derived if d.get('derived_from') == 'place']
    assert len(dpick)  >= 2, dpick
    assert len(dplace) >= 2, dplace


def test_compose_pick_place_taught_step_is_move_linear_move_linear():
    """The taught pick/place steps use action='move_linear' + the
    position_role tag — matches the executor's motion taxonomy without
    introducing a new pick_position / place_position action."""
    intent = _intent_pick_and_place()
    steps = compose_program_draft(intent, demo_id='demo_p002').to_program_payload()['steps']
    for s in steps:
        if s.get('position_role') in ('pick', 'place'):
            assert s['action'] == 'move_linear', s
            assert 'contact' in (s.get('label') or '').lower()


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


# ── Program-name shape constraints ─────────────────────────────────
#
# The library-list name is the "<Part> <Operation>" short form (max
# ~30 chars). Full descriptive detail lives in the description field,
# not the name. These tests pin that behaviour so a future prompt or
# composer change can't silently regress it.

def test_program_name_uses_short_part_op_pattern():
    """Library-matched part + pick_and_place → '<Part> Pick & Place'."""
    intent = _intent_pick_and_place()
    draft = compose_program_draft(intent, demo_id='demo_name_001')
    assert draft.name == 'BT225L24 bracket Pick & Place'
    assert len(draft.name) <= 30


def test_program_name_trims_overlong_part_to_fit_char_budget():
    """A long library part name is trimmed on word boundaries so the
    operation half survives whole. Char budget is the hard rule."""
    intent = StructuredIntent(
        operations=[IntentOperation(
            operation_type='palletize', sequence_index=1,
            target_part=PartReference(
                part_id='extra', name='Extra Long Multipart Assembly Name',
                confidence=1.0, source='matched_to_library'),
        )],
    )
    draft = compose_program_draft(intent, demo_id='demo_name_002')
    assert draft.name.endswith('Palletize'), draft.name
    assert len(draft.name) <= 30


def test_program_name_falls_back_to_scene_when_op_target_unknown():
    """Unknown target_part → fall back to a scene object's label."""
    intent = StructuredIntent(
        operations=[IntentOperation(
            operation_type='pick_and_place', sequence_index=1,
            target_part=PartReference(part_id='unknown', name='',
                                      confidence=0.0, source=''),
        )],
        scene=Scene(objects=[
            SceneObject(label='black bracket', matched_part_id='xyz'),
        ]),
    )
    draft = compose_program_draft(intent, demo_id='demo_name_003')
    assert draft.name == 'black bracket Pick & Place'


def test_program_name_caller_override_is_capped():
    """Caller-supplied program_name wins but still gets word-capped +
    char-capped so an over-long upstream string can't leak through."""
    intent = _intent_pick_and_place()
    draft = compose_program_draft(
        intent, demo_id='demo_name_004',
        program_name='This is a very verbose upstream name for a demo',
    )
    # Word cap = 4.
    assert len(draft.name.split()) <= 4
    assert len(draft.name) <= 30


def test_program_name_empty_intent_falls_back_to_demo_id():
    """Nothing to work with → 'demo <id>', not empty or None."""
    intent = StructuredIntent()
    draft = compose_program_draft(intent, demo_id='demo_name_005')
    assert draft.name.startswith('demo ')


def test_machine_tend_taught_contacts_per_role():
    """Machine-tend has three taught roles (pick, machine_load, unload).
    Each must appear exactly once as position_role and have at least one
    derived approach + retreat step attached."""
    intent = StructuredIntent(
        operations=[IntentOperation(
            operation_type='machine_tend', sequence_index=1,
            target_part=PartReference(part_id='bt225l24', name='BT225L24 bracket',
                                      confidence=0.85, source='matched_to_library'),
            pick=PoseSlot(location_hint='from bin'),
            place=PoseSlot(location_hint='into vice'),
        )],
    )
    steps = compose_program_draft(intent, demo_id='demo_mt').to_program_payload()['steps']
    role_counts = {}
    for s in steps:
        r = s.get('position_role')
        if r and not s.get('derived_from'):
            role_counts[r] = role_counts.get(r, 0) + 1
    # 'home' role appears twice (start + return); pick/machine_load/unload once each.
    assert role_counts.get('pick') == 1
    assert role_counts.get('machine_load') == 1
    assert role_counts.get('unload') == 1
    # Each role has at least one derived approach and retreat.
    for role in ('pick', 'machine_load', 'unload'):
        dsteps = [s for s in steps
                  if s.get('derived_from') == role and s.get('offset_z_mm', 0) > 0]
        assert len(dsteps) >= 2, (role, dsteps)


def test_detect_step_gated_on_operation_source():
    """`op.source` is the part-locating discriminator that mirrors the
    wizard's answers.source. Composer emits `detect` only when the
    operator wants vision each cycle; 'fixed_position' means the pick
    pose is bound to the taught contact and the detect step must be
    absent from the draft."""
    def _intent(src):
        return StructuredIntent(operations=[IntentOperation(
            operation_type='pick_and_place', sequence_index=1,
            target_part=PartReference(part_id='bt225l24', name='BT225L24 bracket',
                                      confidence=0.85, source='matched_to_library'),
            source=src,
        )])
    # Default (unset source) → NO detect step — the safer default now
    # that a taught contact pose is treated as authoritative.
    from programming_by_demonstration.schema import StructuredIntent as SI
    intent_default = SI(operations=[IntentOperation(
        operation_type='pick_and_place', sequence_index=1,
        target_part=PartReference(part_id='bt225l24', name='BT225L24 bracket',
                                  confidence=0.85, source='matched_to_library'),
    )])   # source unset → dataclass default kicks in
    d_default = compose_program_draft(intent_default, demo_id='dsrc1')
    assert not any(s['action'] == 'detect' for s in d_default.to_program_payload()['steps'])
    # Vision each cycle → detect present.
    d_vision = compose_program_draft(_intent('camera_library'), demo_id='dsrc2')
    assert any(s['action'] == 'detect' for s in d_vision.to_program_payload()['steps'])
    # Fixed position → NO detect step.
    d_fixed = compose_program_draft(_intent('fixed_position'), demo_id='dsrc3')
    assert not any(s['action'] == 'detect' for s in d_fixed.to_program_payload()['steps'])


def test_intent_source_round_trip_defaults_fixed_position():
    """Intents without a `source` field parse back as fixed_position —
    the safer default: a taught contact pose is deterministic and
    operators only add vision when the part actually moves. Fresh
    drafts therefore emit no detect step until the operator picks
    vision via the location clarification."""
    raw = {
        'operations': [{
            'operation_type': 'pick_and_place',
            'target_part': {'part_id': 'p1', 'name': 'P1'},
            'sequence_index': 1,
        }],
    }
    parsed = StructuredIntent.from_dict(raw)
    assert parsed.operations[0].source == 'fixed_position'
    # Explicit camera_library round-trips (the vision-each-cycle path).
    raw2 = dict(raw)
    raw2['operations'] = [{**raw['operations'][0], 'source': 'camera_library'}]
    parsed2 = StructuredIntent.from_dict(raw2)
    assert parsed2.operations[0].source == 'camera_library'


def test_vacuum_effector_emits_engage_disengage_and_blow_off():
    """Vacuum operation → the pick body swaps grip_close for
    `set_io Engage vacuum` + a seal-wait, and the place body swaps
    grip_release for `set_io Disengage vacuum` followed by the
    blow-off pulse (DO on → wait → off). Both Engage and Disengage
    must bind to the SAME `io_id` so re-mapping the port in the I/O
    page updates the pair together (symmetry invariant)."""
    intent = StructuredIntent(operations=[IntentOperation(
        operation_type='pick_and_place', sequence_index=1,
        target_part=PartReference(part_id='delrin', name='Delrin piece',
                                  confidence=0.9, source='matched_to_library'),
        pick=PoseSlot(location_hint='right bin'),
        place=PoseSlot(location_hint='left tray'),
        effector='vacuum',
    )])
    steps = compose_program_draft(intent, demo_id='demo_vac').to_program_payload()['steps']
    labels = [s.get('label') for s in steps]
    assert 'Engage vacuum'    in labels, labels
    assert 'Disengage vacuum' in labels, labels
    # No parallel-gripper verbs.
    assert 'Grip part'    not in labels
    assert 'Release part' not in labels
    # Blow-off triplet present (set_io on → wait → set_io off).
    blow_idxs = [i for i, s in enumerate(steps) if 'Blow off' in (s.get('label') or '')]
    assert blow_idxs, f'blow-off sequence missing: {labels}'
    # Symmetric port binding: Engage and Disengage vacuum share io_id.
    engage_io = next(s['io_id'] for s in steps if s.get('label') == 'Engage vacuum')
    disen_io  = next(s['io_id'] for s in steps if s.get('label') == 'Disengage vacuum')
    assert engage_io == disen_io, (engage_io, disen_io)
    # Both carry the io_role tag so downstream tools can regroup them
    # symbolically without parsing labels.
    for lbl in ('Engage vacuum', 'Disengage vacuum'):
        s = next(x for x in steps if x.get('label') == lbl)
        assert s.get('io_role') == 'vacuum', (lbl, s)


def test_finger_effector_is_the_default():
    """Legacy intents without an `effector` field parse back as
    'finger' → composer keeps emitting open_gripper/close_gripper
    with the classic Open/Grip/Release labels. Preserves the
    pre-effector shape byte-for-byte."""
    intent = _intent_pick_and_place()   # no effector set
    steps = compose_program_draft(intent, demo_id='demo_fingerdef').to_program_payload()['steps']
    actions = [s.get('action') for s in steps]
    assert 'close_gripper' in actions
    assert 'open_gripper'  in actions
    # No vacuum I/O leaks in.
    assert not any('vacuum' in (s.get('label') or '').lower() for s in steps)


def test_derived_steps_never_carry_taught_data():
    """New shape invariant: any step with derived_from is pose-free
    (no taught_joints/tcp, no position_role). The old "carry taught data
    on derived steps as legacy fallback" pattern is gone from the
    composer — the resolver + role_map covers all cases."""
    intent = _intent_pick_and_place()
    steps = compose_program_draft(intent, demo_id='demo_deriv').to_program_payload()['steps']
    for s in steps:
        if not s.get('derived_from'):
            continue
        assert not s.get('taught'), s
        assert not s.get('taught_joints'), s
        assert not s.get('taught_tcp'), s
        assert not s.get('position_role'), s

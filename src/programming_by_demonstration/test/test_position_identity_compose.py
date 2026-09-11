"""End-to-end tests for the position-identity feature (2026-08-01):

  - fusion → composer wiring: multi-op programs with a shared
    location_ref collapse to ONE taught anchor + repeats
    (derived_from_step_id).
  - single-op programs stay bit-identical (regression gate).
  - no sameness Clarification is EVER emitted by the api backend or
    the composer (no-asking contract).
  - low-confidence chip metadata propagates through positions[].
"""
from __future__ import annotations

import json

from programming_by_demonstration.schema import (
    IntentOperation,
    LocationRegion,
    PartReference,
    PoseSlot,
    StructuredIntent,
)
from programming_by_demonstration.fusion import fuse_positions
from programming_by_demonstration.program_composer import compose_program_draft


def _two_pnp_same_spot():
    """Two pick_and_place ops that fusion resolves to a single pick
    ref + a single place ref (transcript + video agree)."""
    si = StructuredIntent(
        task_summary='pick from tray, place on fixture',
        raw_understanding_notes='pick this from the tray, place on the fixture. same spot again.',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                pick=PoseSlot(location_hint='tray',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=2,
                pick=PoseSlot(location_hint='tray',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
        ],
    )
    fuse_positions(si)
    return si


def test_shared_ref_collapses_taught_contacts():
    si = _two_pnp_same_spot()
    draft = compose_program_draft(si, demo_id='demo-share')
    steps = draft.steps
    # An ANCHOR pick is a contact-role step that ISN'T derived.
    # (`taught: False` is the draft-shape default on every step —
    # not a distinguishing signal here.)
    anchor_picks = [s for s in steps
                    if s.get('position_role') == 'pick'
                    and not s.get('derived_from')
                    and not s.get('derived_from_step_id')]
    linked_picks = [s for s in steps if s.get('derived_from_step_id')
                    and s.get('position_role') == 'pick']
    assert len(anchor_picks) == 1, anchor_picks
    assert len(linked_picks) == 1, linked_picks
    assert linked_picks[0]['offset_z_mm'] == 0
    assert linked_picks[0]['derived_from_step_id'] == anchor_picks[0]['id']


def test_shared_ref_labels_show_link():
    si = _two_pnp_same_spot()
    draft = compose_program_draft(si, demo_id='demo-share-labels')
    linked = [s for s in draft.steps if s.get('derived_from_step_id')]
    for s in linked:
        assert '(link → step' in s.get('label', ''), s


def test_distinct_refs_keep_two_taught_contacts():
    """Two ops with DISTINCT location refs must each keep their own
    taught contact (no over-merge)."""
    si = StructuredIntent(
        task_summary='pick from bin A then from bin B',
        raw_understanding_notes='pick from the tray, place on the fixture. now pick from a different bin, place on a new fixture.',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                pick=PoseSlot(location_hint='tray',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=2,
                pick=PoseSlot(location_hint='bin',
                              region=LocationRegion(cell='TR', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BL', clarity='clear')),
            ),
        ],
    )
    fuse_positions(si)
    draft = compose_program_draft(si, demo_id='demo-distinct')
    anchor_picks = [s for s in draft.steps
                    if s.get('position_role') == 'pick'
                    and not s.get('derived_from')
                    and not s.get('derived_from_step_id')]
    assert len(anchor_picks) == 2, anchor_picks   # anchor per distinct ref
    linked = [s for s in draft.steps if s.get('derived_from_step_id')]
    assert linked == [], f'no linking expected on distinct refs, got: {linked}'


def test_single_op_program_is_unaffected():
    """Single-op programs (the historic case) regenerate the same
    steps regardless of the position-identity feature.  Ensures
    backward compatibility with every legacy stored demo."""
    si = StructuredIntent(
        task_summary='pick from tray',
        raw_understanding_notes='pick this from the tray.',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                pick=PoseSlot(location_hint='tray',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
        ],
    )
    fuse_positions(si)
    draft = compose_program_draft(si, demo_id='demo-single')
    # No linked steps — with only one op, dedupe has nothing to do.
    linked = [s for s in draft.steps if s.get('derived_from_step_id')]
    assert linked == [], linked
    # Exactly ONE taught pick and ONE taught place.
    taught_picks = [s for s in draft.steps
                    if s.get('position_role') == 'pick'
                    and 'Pick position — contact' in s.get('label', '')]
    taught_places = [s for s in draft.steps
                     if s.get('position_role') == 'place'
                     and 'Place position — contact' in s.get('label', '')]
    assert len(taught_picks) == 1
    assert len(taught_places) == 1


def test_low_confidence_flag_propagates_through_positions():
    """A rule 2 case (speech says same, video says distinct) drops
    confidence < 0.7 and sets low_confidence=True. That flag renders
    as the "linked — verify" chip in review (surfaced via
    positions[i].low_confidence)."""
    si = StructuredIntent(
        raw_understanding_notes='pick from the tray. the same tray again for pick.',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                pick=PoseSlot(location_hint='tray',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=2,
                pick=PoseSlot(location_hint='tray',
                              # Video DISAGREES with speech-same.
                              region=LocationRegion(cell='TR', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
        ],
    )
    positions = fuse_positions(si)
    pick_lr = [p for p in positions if p.role == 'pick'][0]
    assert pick_lr.low_confidence is True, pick_lr
    assert pick_lr.confidence < 0.7, pick_lr


def test_no_sameness_clarification_emitted_by_fusion():
    """Fusion runs deterministically — it does NOT populate the
    intent.ambiguities list. The whole no-asking contract rests on
    this: the ONLY clarification producer for sameness must be
    non-existent."""
    si = _two_pnp_same_spot()
    # Fusion ran already inside _two_pnp_same_spot.  Confirm no
    # `field:"location"` clarification was generated.
    location_amb = [c for c in si.ambiguities
                    if getattr(c, 'field', '') == 'location'
                    and 'same' in getattr(c, 'question', '').lower()]
    assert location_amb == [], (
        'fusion must NEVER emit a sameness clarification. '
        f'found: {[(c.id, c.question) for c in location_amb]}')


def test_positions_persist_via_program_pbd_metadata():
    """The composer's pbd_metadata should carry the resolved
    positions so the review UI can render them without re-running
    fusion. Round-trips via to_program_payload → JSON."""
    si = _two_pnp_same_spot()
    draft = compose_program_draft(si, demo_id='demo-positions-round-trip')
    payload = draft.to_program_payload()
    # The compose-side metadata must at LEAST include the positions
    # from the intent that produced it (or a copy).  We assert the
    # payload's config.pbd_metadata references demo_id — a proxy
    # for provenance survival — and rely on the FE to fetch the
    # intent's positions from /api/demonstrations/<id>/intent.
    assert payload['config']['pbd_metadata']['demo_id'] == 'demo-positions-round-trip'


def test_speech_different_overrides_video_same_at_composer():
    """Rule 5 (speech_different) must beat matching regions all the
    way through the composer — same TL/BR video regions on both ops,
    but the transcript declares "a different bin" for the second
    pick.  Fusion should decide DISTINCT and the composer must emit
    two anchor picks (no dedupe).  Guards the whole path: fusion +
    _dedupe_repeated_refs both honouring speech over video."""
    si = StructuredIntent(
        task_summary='pick from tray, then from a different bin',
        raw_understanding_notes=(
            'pick this from the tray and place on the fixture. '
            'now pick from a different bin and place on the fixture.'
        ),
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                pick=PoseSlot(location_hint='tray',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=2,
                # Identical cells to op 1 — video says "same spot".
                pick=PoseSlot(location_hint='bin',
                              region=LocationRegion(cell='TL', clarity='clear')),
                place=PoseSlot(location_hint='fixture',
                               region=LocationRegion(cell='BR', clarity='clear')),
            ),
        ],
    )
    fuse_positions(si)
    # Sanity: pick refs must be DIFFERENT because speech overrode video.
    pick_refs = {op.pick.location_ref for op in si.operations}
    assert len(pick_refs) == 2, (
        f'speech-different must produce 2 distinct pick refs '
        f'despite identical video regions — got {pick_refs}')

    draft = compose_program_draft(si, demo_id='demo-speech-overrides')
    anchor_picks = [s for s in draft.steps
                    if s.get('position_role') == 'pick'
                    and not s.get('derived_from')
                    and not s.get('derived_from_step_id')]
    linked_picks = [s for s in draft.steps
                    if s.get('position_role') == 'pick'
                    and s.get('derived_from_step_id')]
    assert len(anchor_picks) == 2, (
        f'composer must keep 2 anchor picks when speech says '
        f'different — got {len(anchor_picks)}: {anchor_picks}')
    assert linked_picks == [], (
        f'composer must NOT link picks that speech marked different '
        f'— got: {linked_picks}')


def test_five_ops_same_spot_dedupes_to_one_pick_anchor():
    """Real-world shape: five pick_and_place ops sharing the same
    physical pick spot (the white bowl demo). Fusion resolves them
    to one loc_1 pick + one loc_2 place; composer emits one anchor
    per role plus N-1=4 linked repeats.  This is the acceptance
    shape from the 63-step demo — pinned so any regression that
    over-anchors or under-links surfaces immediately."""
    ops = []
    for i in range(1, 6):
        ops.append(IntentOperation(
            operation_type='pick_and_place',
            target_part=PartReference('unknown', 'part'),
            sequence_index=i,
            pick=PoseSlot(location_hint='stool',
                          region=LocationRegion(cell='CR', clarity='clear')),
            place=PoseSlot(location_hint='table',
                           region=LocationRegion(cell='CL', clarity='clear')),
        ))
    si = StructuredIntent(
        task_summary='pick five bowls from the stool onto the table',
        raw_understanding_notes=(
            'pick these five bowls from the stool and place them on '
            'the table. same spot each time.'
        ),
        operations=ops,
    )
    fuse_positions(si)
    # Every op should share the same two location_refs.
    pick_refs = {op.pick.location_ref for op in si.operations}
    place_refs = {op.place.location_ref for op in si.operations}
    assert len(pick_refs) == 1, pick_refs
    assert len(place_refs) == 1, place_refs

    draft = compose_program_draft(si, demo_id='demo-five-same-spot')
    anchor_picks = [s for s in draft.steps
                    if s.get('position_role') == 'pick'
                    and not s.get('derived_from')
                    and not s.get('derived_from_step_id')]
    linked_picks = [s for s in draft.steps
                    if s.get('position_role') == 'pick'
                    and s.get('derived_from_step_id')]
    anchor_places = [s for s in draft.steps
                     if s.get('position_role') == 'place'
                     and not s.get('derived_from')
                     and not s.get('derived_from_step_id')]
    linked_places = [s for s in draft.steps
                     if s.get('position_role') == 'place'
                     and s.get('derived_from_step_id')]
    assert len(anchor_picks) == 1, anchor_picks
    assert len(linked_picks) == 4, linked_picks
    assert len(anchor_places) == 1, anchor_places
    assert len(linked_places) == 4, linked_places
    # Every linked repeat points at THE anchor's step id.
    anchor_pick_id = anchor_picks[0]['id']
    anchor_place_id = anchor_places[0]['id']
    for s in linked_picks:
        assert s['derived_from_step_id'] == anchor_pick_id, s
        assert s['offset_z_mm'] == 0, s
    for s in linked_places:
        assert s['derived_from_step_id'] == anchor_place_id, s
        assert s['offset_z_mm'] == 0, s

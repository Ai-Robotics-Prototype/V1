"""Pinned tests for the position-identity fusion module (2026-08-01 §1c).

One test per ordered rule + the label-extraction + the composer
integration + the no-sameness-clarification invariant + the re-fuse
idempotency contract.

Fixtures are synthetic and minimal so a fusion change surfaces as
one focused test failure rather than a cascade.
"""
from __future__ import annotations

import copy

from programming_by_demonstration.schema import (
    IntentOperation,
    LocationRegion,
    PartReference,
    PoseSlot,
    StructuredIntent,
)
from programming_by_demonstration.fusion import (
    RULE_FIRST_OF_SLOT,
    RULE_LEGACY_NO_EVIDENCE,
    RULE_SPEECH_DIFFERENT,
    RULE_SPEECH_SAME_VIDEO_AGREES,
    RULE_SPEECH_SAME_VIDEO_AMBIGUOUS,
    RULE_SPEECH_SILENT_VIDEO_DISTINCT,
    RULE_SPEECH_SILENT_VIDEO_SAME,
    _fuse_pair,
    _extract_label,
    _speech_signal,
    _video_signal,
    fuse_positions,
    refuse_intent,
)


def _two_pnp(transcript='', pick_regions=None, place_regions=None,
             hints=('bin', 'tray')):
    """Two pick_and_place ops sharing target_part but with tunable
    region + transcript so tests can dial in each rule."""
    pick_regions = pick_regions or [None, None]
    place_regions = place_regions or [None, None]
    return StructuredIntent(
        task_summary=hints[0] + ' to ' + hints[1],
        raw_understanding_notes=transcript,
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                pick=PoseSlot(location_hint=hints[0], region=pick_regions[0]),
                place=PoseSlot(location_hint=hints[1], region=place_regions[0]),
            ),
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=2,
                pick=PoseSlot(location_hint=hints[0], region=pick_regions[1]),
                place=PoseSlot(location_hint=hints[1], region=place_regions[1]),
            ),
        ],
    )


# ── Rule 1: speech-same + video-agrees → SAME (high conf) ─────

def test_rule_1_speech_same_video_agrees():
    si = _two_pnp(
        transcript='pick from the tray, place on the fixture. same spot as before for pick and place.',
        pick_regions=[LocationRegion(cell='TL', clarity='clear')] * 2,
        place_regions=[LocationRegion(cell='BR', clarity='clear')] * 2)
    positions = fuse_positions(si)
    assert len(positions) == 2, [p.to_dict() for p in positions]
    for p in positions:
        assert p.fusion_rule == RULE_SPEECH_SAME_VIDEO_AGREES, p
        assert p.confidence >= 0.9
        assert p.low_confidence is False
        assert len(p.members) == 2


# ── Rule 2: speech-same + video-ambiguous → SAME (speech is intent) ──

def test_rule_2_speech_same_video_ambiguous():
    si = _two_pnp(
        transcript='pick from the tray, place on the fixture. the same tray again for pick.',
        pick_regions=[LocationRegion(cell='TL', clarity='borderline'),
                      LocationRegion(cell='TR', clarity='borderline')],
        place_regions=[None, None])
    positions = fuse_positions(si)
    # pick refs should collapse to one (speech wins); place should
    # be silent+ambiguous → distinct (rule 4 fallback).
    pick_refs = {op.pick.location_ref for op in si.operations}
    assert len(pick_refs) == 1, [op.pick.location_ref for op in si.operations]
    # Find the pick ref's rule.
    pick_lr = [p for p in positions if p.role == 'pick'][0]
    assert pick_lr.fusion_rule == RULE_SPEECH_SAME_VIDEO_AMBIGUOUS


# ── Rule 3: speech-silent + video-clearly-same → SAME ──────────

def test_rule_3_speech_silent_video_same():
    si = _two_pnp(
        transcript='pick and place.',    # no sameness cues at all
        pick_regions=[LocationRegion(cell='TL', clarity='clear')] * 2,
        place_regions=[LocationRegion(cell='BR', clarity='clear')] * 2)
    positions = fuse_positions(si)
    assert len(positions) == 2
    for p in positions:
        assert p.fusion_rule == RULE_SPEECH_SILENT_VIDEO_SAME, p


# ── Rule 4: speech-silent + video-distinct → DISTINCT ─────────

def test_rule_4_speech_silent_video_distinct():
    si = _two_pnp(
        transcript='pick and place.',
        pick_regions=[LocationRegion(cell='TL', clarity='clear'),
                      LocationRegion(cell='TR', clarity='clear')],
        place_regions=[LocationRegion(cell='BL', clarity='clear'),
                       LocationRegion(cell='BR', clarity='clear')])
    positions = fuse_positions(si)
    assert len(positions) == 4, positions
    for p in positions:
        # First-of-slot events use RULE_FIRST_OF_SLOT; the second
        # pick/place use silent+video-distinct.
        assert p.fusion_rule in (RULE_FIRST_OF_SLOT,
                                 RULE_SPEECH_SILENT_VIDEO_DISTINCT)


# ── Rule 5: speech-different beats video-same ─────────────────

def test_rule_5_speech_different_beats_video_same():
    si = _two_pnp(
        transcript='pick from the tray, place on the fixture. now pick from a different tray for this one.',
        pick_regions=[LocationRegion(cell='TL', clarity='clear')] * 2,
        place_regions=[LocationRegion(cell='BR', clarity='clear')] * 2)
    positions = fuse_positions(si)
    pick_refs = {op.pick.location_ref for op in si.operations}
    assert len(pick_refs) == 2, ('speech-different must beat video-same for pick',
                                 [op.pick.location_ref for op in si.operations])
    # The second pick's fusion_rule should record RULE_SPEECH_DIFFERENT.
    second_pick_ref = si.operations[1].pick.location_ref
    second_pick_lr = [p for p in positions if p.ref == second_pick_ref][0]
    assert second_pick_lr.fusion_rule == RULE_SPEECH_DIFFERENT
    # Place should still collapse (video same, no different-cue for place).
    place_refs = {op.place.location_ref for op in si.operations}
    assert len(place_refs) == 1


# ── Extra: generic "another" MUST NOT trigger DIFFERENT ───────

def test_speech_generic_another_does_not_fire():
    """`another bowl` = another OBJECT, not another LOCATION.  The
    fusion rule mustn't treat it as speech-different — otherwise the
    three-bowl-same-spot demo over-splits."""
    si = _two_pnp(
        transcript='pick this bowl from the tray, place on the fixture. back to the tray for another bowl.',
        pick_regions=[LocationRegion(cell='TL', clarity='clear')] * 2,
        place_regions=[LocationRegion(cell='BR', clarity='clear')] * 2)
    positions = fuse_positions(si)
    # 'back to the tray' is a SAME cue for pick. Second pick collapses.
    assert len({op.pick.location_ref for op in si.operations}) == 1
    assert len({op.place.location_ref for op in si.operations}) == 1
    assert len(positions) == 2


# ── Rule 6 (baseline): first event of a role gets FIRST_OF_SLOT ─

def test_first_event_of_slot_gets_baseline_rule():
    si = _two_pnp()
    positions = fuse_positions(si)
    first_pick = [p for p in positions if p.role == 'pick'][0]
    first_place = [p for p in positions if p.role == 'place'][0]
    assert first_pick.fusion_rule == RULE_FIRST_OF_SLOT
    assert first_place.fusion_rule == RULE_FIRST_OF_SLOT
    assert first_pick.confidence == 1.0
    assert first_place.confidence == 1.0


# ── Silent + ambiguous → distinct + low_confidence ─────────────

def test_silent_ambiguous_marks_low_confidence():
    si = _two_pnp(
        transcript='pick and place.',
        pick_regions=[None, None],   # no video evidence either
        place_regions=[None, None])
    positions = fuse_positions(si)
    # No evidence → default DISTINCT with low_confidence=True on the
    # second event's LocationRef (rule LEGACY_NO_EVIDENCE).
    assert len(positions) == 4
    second_pick = [p for p in positions
                   if p.role == 'pick'
                   and p.fusion_rule == RULE_LEGACY_NO_EVIDENCE]
    assert second_pick, positions
    assert second_pick[0].low_confidence is True


# ── Fusion mutates in place; idempotent on repeat ─────────────

def test_fusion_is_idempotent():
    """Running fuse_positions twice produces the same positions list."""
    def _make():
        return _two_pnp(
            transcript='pick from the tray. same spot again for pick.',
            pick_regions=[LocationRegion(cell='TL', clarity='clear')] * 2,
            place_regions=[LocationRegion(cell='BR', clarity='clear')] * 2)
    si_a = _make(); positions_a = fuse_positions(si_a)
    # A fresh intent (fuse_positions mutates location_ref in place).
    si_b = _make(); positions_b = fuse_positions(si_b)
    assert [p.to_dict() for p in positions_a] == [p.to_dict() for p in positions_b]


def test_refuse_intent_roundtrips_legacy_shape():
    """A legacy stored-intent dict (no positions field, no location_ref)
    round-trips through refuse_intent() with populated positions."""
    d = {
        'task_summary': 'test',
        'raw_understanding_notes': 'pick from the tray. same tray again.',
        'operations': [
            {'operation_type': 'pick_and_place',
             'target_part': {'part_id': 'unknown', 'name': 'x'},
             'sequence_index': 1,
             'pick':  {'location_hint': 'tray',
                       'region': {'cell': 'TL', 'clarity': 'clear'}},
             'place': {'location_hint': 'fixture',
                       'region': {'cell': 'BR', 'clarity': 'clear'}}},
            {'operation_type': 'pick_and_place',
             'target_part': {'part_id': 'unknown', 'name': 'x'},
             'sequence_index': 2,
             'pick':  {'location_hint': 'tray',
                       'region': {'cell': 'TL', 'clarity': 'clear'}},
             'place': {'location_hint': 'fixture',
                       'region': {'cell': 'BR', 'clarity': 'clear'}}},
        ],
    }
    out = refuse_intent(d)
    assert 'positions' in out
    assert len(out['positions']) == 2       # both picks + both places collapsed
    assert out['operations'][0]['pick']['location_ref'] \
        == out['operations'][1]['pick']['location_ref']


# ── Label extraction (§2) ─────────────────────────────────────

def test_label_extraction_uses_noun_and_qualifier():
    """`_extract_label` produces 'Left tray pick' from 'pick from the
    left tray'."""
    label = _extract_label(
        'pick the part from the left tray, place on the right fixture.',
        slot_role='pick', op_index=0, fallback_index=1)
    assert label == 'Left tray pick', label


def test_label_extraction_fallback_when_no_noun():
    label = _extract_label(
        'do the thing.', slot_role='pick', op_index=0, fallback_index=1)
    assert label == 'Pick position 1', label


def test_label_extraction_stacks_and_fixtures():
    p = _extract_label(
        'stack on the fixture', slot_role='place', op_index=0, fallback_index=1)
    assert p == 'Fixture place', p


# ── _fuse_pair unit checks (the decision table) ──────────────

def test_fuse_pair_rule1():
    r, rule, c = _fuse_pair('same', 'same')
    assert r == 'same' and rule == RULE_SPEECH_SAME_VIDEO_AGREES and c >= 0.9


def test_fuse_pair_rule2_speech_wins_over_ambiguous_video():
    r, rule, c = _fuse_pair('same', 'ambiguous')
    assert r == 'same' and rule == RULE_SPEECH_SAME_VIDEO_AMBIGUOUS


def test_fuse_pair_rule3():
    r, rule, c = _fuse_pair('silent', 'same')
    assert r == 'same' and rule == RULE_SPEECH_SILENT_VIDEO_SAME


def test_fuse_pair_rule4():
    r, rule, c = _fuse_pair('silent', 'distinct')
    assert r == 'distinct' and rule == RULE_SPEECH_SILENT_VIDEO_DISTINCT


def test_fuse_pair_rule5_speech_diff_beats_video():
    for vid in ('same', 'distinct', 'ambiguous'):
        r, rule, c = _fuse_pair('different', vid)
        assert r == 'distinct' and rule == RULE_SPEECH_DIFFERENT, (vid, r, rule)


def test_fuse_pair_speech_wins_over_distinct_video():
    """Rule 2 subtlety: speech says SAME but video says DISTINCT.
    Speech wins (operator intent), confidence drops as a warning."""
    r, rule, c = _fuse_pair('same', 'distinct')
    assert r == 'same'
    assert rule == RULE_SPEECH_SAME_VIDEO_AMBIGUOUS
    assert c < 0.7   # low-confidence chip fires

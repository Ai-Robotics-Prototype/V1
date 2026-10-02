"""Position-identity fusion — deterministic, ordered rules that
resolve which pick/place slots across operations refer to the SAME
physical spot.  Runs after the understanding backend parses raw
intent JSON and before the composer emits a program draft.

The task's contract (2026-08-01 §1c):

  1. speech-explicit-same  + video-agrees      → SAME (high confidence)
  2. speech-explicit-same  + video-ambiguous   → SAME (speech is intent)
  3. speech-silent         + video-clearly-same→ SAME
  4. speech-silent         + video-distinct    → DISTINCT
  5. speech-explicit-diff  + any video         → DISTINCT (speech beats video)

The system DECIDES.  It never asks a sameness clarification.  A
low-confidence result (rule 3 with a borderline region) renders as
a passive "linked — verify" chip in review — never blocking.

Output shape: mutates `operations[*].pick.location_ref` and
`operations[*].place.location_ref` in place, and returns the
canonical `positions` list (schema.LocationRef instances) that
StructuredIntent stores.

Pure Python.  No ML calls.  No I/O.  Deterministic on repeat runs.
The api_backend / local_backend supply the per-event region
descriptors (LocationRegion, cell + clarity) via the operation JSON;
the transcript is passed in verbatim for the speech channel.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

from .schema import (
    IntentOperation,
    LocationRef,
    LocationRegion,
    PoseSlot,
    StructuredIntent,
)


# ── Speech vocabulary (channel A) ────────────────────────────────
# Each set is a list of NORMALIZED phrases (whitespace collapsed,
# lowercase). The fusion classifier scans a window around each
# pick/place event; a hit sets that event's speech signal.
#
# 'SAME' phrases assert identity to the PRIOR mention of the same slot
# role (pick/place).  'DIFFERENT' phrases assert non-identity.
# Everything else is 'silent' (no explicit assertion).
SAMENESS_SAME = (
    'same spot', 'same place', 'same location', 'same position',
    'same one', 'same thing', 'same as before',
    'back to', 'back at', 'back into',
    'the same', 'as before',
    ' again',    # leading space avoids matching mid-word "against" etc.
    'this again', 'that same', 'right there',
    "where it was", "where you picked", "where you placed",
    'onto the same', 'from the same',
    'from that', 'onto that',
)


# LOCATION_NOUNS = LABEL_NOUNS ∪ generic location terms. Used to
# generate phrase families like "different tray", "new fixture",
# "other bin". Kept in sync with LABEL_NOUNS below.
_LOCATION_NOUNS = ('spot', 'place', 'location', 'position',
                   'tray', 'bin', 'fixture', 'chuck', 'pallet', 'stool',
                   'chair', 'table', 'bench', 'cart', 'conveyor', 'shelf',
                   'rack', 'slot', 'holder', 'jaw', 'jig', 'vise',
                   'dropoff', 'feeder', 'hopper', 'box', 'crate', 'palette',
                   'side', 'corner', 'end', 'zone')


def _generate_different_phrases():
    """Cartesian expansion of DIFFERENT modifiers × location nouns.
    Deliberately EXCLUDES object-only qualifiers like 'another' or
    'a new' — these are about parts, not spots. See
    test_speech_generic_another_does_not_fire for the invariant."""
    modifiers = ('different', 'new', 'other', 'next')
    out: List[str] = []
    for mod in modifiers:
        for noun in _LOCATION_NOUNS:
            out.append(f'{mod} {noun}')
    # Literal phrases that don't fit the modifier×noun template.
    out.extend([
        'not the same',
        'moved to',
        'somewhere else',
        'the other one',
        'over there',   # spatial deixis
    ])
    return tuple(out)


SAMENESS_DIFFERENT = _generate_different_phrases()

# Label vocabulary — noun phrases that the label extractor prefers
# when it finds one near a pick/place event. Matched
# case-insensitively; the extractor casefolds the whole nearby text
# window. When two nouns co-occur ("stack on the fixture"), the FIRST
# hit wins (walk left-to-right around the event).
LABEL_NOUNS = (
    'tray', 'bin', 'stack', 'fixture', 'chuck', 'pallet',
    'stool', 'chair', 'table', 'bench', 'cart',
    'conveyor', 'shelf', 'rack', 'slot', 'holder',
    'jaw', 'jig', 'vise', 'gripper', 'dropoff', 'drop-off',
    'feeder', 'hopper', 'bowl', 'box', 'crate', 'palette',
)
LABEL_QUALIFIERS = ('left', 'right', 'front', 'back', 'top', 'upper',
                    'lower', 'first', 'second', 'third', 'main', 'far',
                    'near')

# Fusion-rule keys (recorded on LocationRef.fusion_rule for training +
# audit). Sorted so the rule name in the intent JSON is stable across
# refactors.
RULE_SPEECH_SAME_VIDEO_AGREES = 'speech_same+video_agrees'
RULE_SPEECH_SAME_VIDEO_AMBIGUOUS = 'speech_same+video_ambiguous'
RULE_SPEECH_SILENT_VIDEO_SAME = 'speech_silent+video_same'
RULE_SPEECH_SILENT_VIDEO_DISTINCT = 'speech_silent+video_distinct'
RULE_SPEECH_DIFFERENT = 'speech_different'
RULE_FIRST_OF_SLOT = 'first_event_of_slot'      # baseline: no prior to compare
RULE_LEGACY_NO_EVIDENCE = 'legacy_no_evidence'  # empty transcript + no region


# ── Speech-signal classifier ─────────────────────────────────────

def _speech_signal(transcript: str,
                   slot_role: str,
                   op_index: int,
                   ) -> str:
    """Return 'same' | 'different' | 'silent' for one pick/place event.

    We approximate the event's location in the transcript by splitting
    on sentence boundaries and using op_index as an ordering key —
    sentence i (roughly) covers operation i. This is coarse but
    consistent, and the model can also embed sameness cues in the
    scene block / notes so the whole transcript is checked as a
    fallback.

    Priority: DIFFERENT beats SAME beats silent — if both sets of
    phrases occur in the window, the operator's explicit "different"
    wins per rule 5.
    """
    if not transcript:
        return 'silent'
    text = ' '.join(transcript.lower().split())
    # 1) Whole-transcript scan for DIFFERENT — rule 5 is unconditional.
    for kw in SAMENESS_DIFFERENT:
        if kw in text:
            # Only counts if it's near a pick/place mention for the
            # same slot; otherwise it's about a different concept.
            if _mentions_slot_near(text, kw, slot_role):
                return 'different'
    # 2) Then SAME.
    for kw in SAMENESS_SAME:
        if kw in text:
            if _mentions_slot_near(text, kw, slot_role):
                return 'same'
    return 'silent'


_SLOT_VERBS = {
    'pick':  ('pick', 'grab', 'take', 'lift', 'grasp'),
    'place': ('place', 'set', 'drop', 'put', 'stack'),
}


def _mentions_slot_near(text: str, keyword: str, slot_role: str,
                        window: int = 60) -> bool:
    """Proximity check: the keyword occurs within `window` characters
    of a slot verb, AND the NEAREST slot verb is for `slot_role`.

    Prevents cross-slot bleed — e.g. "pick from a different tray"
    fires only for pick, not for place, even when both verbs sit
    inside the same window. This matters for the fusion rule
    because place shouldn't inherit a pick-specific sameness cue.
    """
    for m in re.finditer(re.escape(keyword), text):
        kw_mid = (m.start() + m.end()) / 2
        # Find nearest slot verb by role within the window.
        best: Dict[str, Optional[float]] = {'pick': None, 'place': None}
        lo = max(0, m.start() - window)
        hi = min(len(text), m.end() + window)
        chunk = text[lo:hi]
        for role, verbs in _SLOT_VERBS.items():
            for v in verbs:
                for vm in re.finditer(r'\b' + re.escape(v) + r'\b', chunk):
                    v_pos = lo + (vm.start() + vm.end()) / 2
                    dist = abs(v_pos - kw_mid)
                    if best[role] is None or dist < best[role]:
                        best[role] = dist
        this_d  = best[slot_role]
        other   = 'place' if slot_role == 'pick' else 'pick'
        other_d = best[other]
        if this_d is None:
            continue
        # A cue fires for this role when the same-role verb is close
        # enough that the opposite-role verb doesn't clearly dominate.
        # 15-char margin lets a "pick and place" conjunction hit both
        # roles while a "pick from a different tray for this one"
        # remains a pick-only cue.
        _MARGIN = 15.0
        if other_d is not None and this_d - other_d > _MARGIN:
            continue
        return True
    return False


# ── Video-signal classifier ──────────────────────────────────────

def _video_signal(a: Optional[LocationRegion],
                  b: Optional[LocationRegion]) -> str:
    """Return 'same' | 'distinct' | 'ambiguous'.

    'same'      — both regions present, same cell, both clear.
    'distinct'  — both regions present, different cells, both clear.
    'ambiguous' — any region missing, unknown clarity, or borderline
                  clarity on either side.
    """
    if a is None or b is None:
        return 'ambiguous'
    if not a.cell or not b.cell:
        return 'ambiguous'
    if a.clarity != 'clear' or b.clarity != 'clear':
        return 'ambiguous' if a.cell == b.cell else 'ambiguous'
    if a.cell == b.cell:
        return 'same'
    return 'distinct'


# ── Fusion rule (the ordered decision table) ─────────────────────

def _fuse_pair(speech: str, video: str) -> Tuple[str, str, float]:
    """Return (relation, rule_id, confidence) for a single event vs.
    its predecessor of the same slot role.

    relation: 'same' | 'distinct'
    rule_id:  one of the RULE_* module constants
    confidence: 0..1
    """
    # Rule 5: explicit DIFFERENT beats everything.
    if speech == 'different':
        return ('distinct', RULE_SPEECH_DIFFERENT, 0.95)
    # Rules 1 + 2: explicit SAME (video agrees or ambiguous).
    if speech == 'same':
        if video == 'same':
            return ('same', RULE_SPEECH_SAME_VIDEO_AGREES, 0.95)
        if video == 'distinct':
            # Speech overrides. Video-distinct is corroboration, not
            # veto — but the disagreement itself IS a warning worth
            # recording. Confidence drops accordingly.
            return ('same', RULE_SPEECH_SAME_VIDEO_AMBIGUOUS, 0.60)
        return ('same', RULE_SPEECH_SAME_VIDEO_AMBIGUOUS, 0.80)
    # Rules 3 + 4: speech silent — video decides.
    if video == 'same':
        return ('same', RULE_SPEECH_SILENT_VIDEO_SAME, 0.75)
    if video == 'distinct':
        return ('distinct', RULE_SPEECH_SILENT_VIDEO_DISTINCT, 0.85)
    # Silent + ambiguous video — no evidence to link. Default to
    # DISTINCT (never over-merge) but flag low confidence so the
    # review chip surfaces the uncertainty.
    return ('distinct', RULE_LEGACY_NO_EVIDENCE, 0.40)


# ── Label extraction (§2) ────────────────────────────────────────

def _extract_label(transcript: str, slot_role: str, op_index: int,
                   fallback_index: int) -> str:
    """Pull a human name from the transcript context around this
    pick/place event. Returns 'Tray pick', 'Stack place', 'Fixture A'
    style names; falls back to '<Role> position N'.

    Heuristic: find the FIRST mention of a LABEL_NOUNS token near a
    pick/place verb; optionally prefix with a qualifier like 'left'
    or 'first' if it appears immediately before the noun.
    """
    if not transcript:
        return f'{slot_role.capitalize()} position {fallback_index}'
    text = transcript.lower()
    slot_verbs = {
        'pick':  ('pick', 'grab', 'take', 'lift', 'grasp'),
        'place': ('place', 'set', 'drop', 'put', 'stack'),
    }.get(slot_role, ())
    # Iterate through the transcript. For each slot verb occurrence,
    # look FORWARD ~40 chars for a noun, taking a qualifier if it
    # sits within one word before the noun.
    for verb in slot_verbs:
        for m in re.finditer(r'\b' + re.escape(verb), text):
            window = text[m.end():m.end() + 60]
            for noun in LABEL_NOUNS:
                nm = re.search(r'\b' + re.escape(noun) + r'\b', window)
                if not nm:
                    continue
                # Peek at the word just before the noun for a qualifier.
                pre = window[:nm.start()].strip().split()
                qual = ''
                if pre and pre[-1] in LABEL_QUALIFIERS:
                    qual = pre[-1] + ' '
                # Compose "<qual><noun> <role>" — e.g. "left tray pick".
                base = (qual + noun).strip()
                return f'{base.capitalize()} {slot_role}'
    return f'{slot_role.capitalize()} position {fallback_index}'


# ── Main entry point ─────────────────────────────────────────────

def fuse_positions(intent: StructuredIntent) -> List[LocationRef]:
    """Run the ordered fusion rule over an intent's operations and
    return the resolved positions list. MUTATES the operations'
    pick.location_ref and place.location_ref in place.

    Idempotent: running fuse_positions() a second time on the same
    intent produces the same positions list (assuming the transcript,
    operations, and regions are unchanged).
    """
    positions: List[LocationRef] = []
    # last-seen event per slot role — used to compare each new event
    # against its predecessor.
    last_event_per_role: Dict[str, Dict[str, Any]] = {}
    # counters for fallback labels ("Pick position 1", "Place position 2")
    role_fallback_count: Dict[str, int] = {'pick': 0, 'place': 0}
    # per-role LocationRef list so refs are stable across a single fuse
    ref_counter = 0
    # transcript source: raw_understanding_notes usually holds the
    # Whisper output; task_summary + scene.spatial_summary contribute
    # phrasing evidence too. Concatenate the three so keyword search
    # runs over everything the backend saw.
    transcript = ' '.join([
        intent.raw_understanding_notes or '',
        intent.task_summary or '',
        intent.scene.spatial_summary if intent.scene else '',
    ]).strip()

    for op_idx, op in enumerate(intent.operations):
        for slot_name in ('pick', 'place'):
            slot: PoseSlot = getattr(op, slot_name)
            speech = _speech_signal(transcript, slot_name, op_idx)
            prev = last_event_per_role.get(slot_name)
            if prev is None:
                # First event of this role in the program — baseline
                # rule. No predecessor to compare against, so this is
                # a new location by definition.
                ref_counter += 1
                role_fallback_count[slot_name] += 1
                label = _extract_label(transcript, slot_name, op_idx,
                                       role_fallback_count[slot_name])
                lr = LocationRef(
                    ref=f'loc_{ref_counter}',
                    label=label,
                    role=slot_name,
                    fusion_rule=RULE_FIRST_OF_SLOT,
                    confidence=1.0,
                    low_confidence=False,
                    members=[{'op_index': op_idx, 'slot': slot_name}],
                )
                positions.append(lr)
                slot.location_ref = lr.ref
                last_event_per_role[slot_name] = {
                    'ref': lr.ref,
                    'region': slot.region,
                    'positions_idx': len(positions) - 1,
                }
                continue
            # There IS a prior event of this role. Fuse.
            video = _video_signal(prev['region'], slot.region)
            relation, rule_id, conf = _fuse_pair(speech, video)
            if relation == 'same':
                # Reuse the prior ref. Append this event to its
                # members list; update stored region only if the
                # new one is clearer (upgrading from unknown/borderline
                # → clear).
                prior_ref = prev['ref']
                slot.location_ref = prior_ref
                prior_lr = positions[prev['positions_idx']]
                prior_lr.members.append({'op_index': op_idx, 'slot': slot_name})
                # Confidence blends toward the lower of the two
                # so a rule-3-with-borderline doesn't over-inflate.
                prior_lr.confidence = min(prior_lr.confidence, conf)
                if conf < 0.7:
                    prior_lr.low_confidence = True
                # Refine label if a stronger transcript cue appears
                # later than the first event and the prior label is
                # a numbered fallback (starts with "<Role> position").
                if prior_lr.label.startswith(('Pick position',
                                              'Place position')):
                    role_num = 1  # arbitrary — used only if extract fails
                    new_label = _extract_label(
                        transcript, slot_name, op_idx, role_num)
                    if not new_label.startswith(('Pick position',
                                                 'Place position')):
                        prior_lr.label = new_label
                # Update rule string only if this event's rule is
                # weaker; keeps the strongest evidence in the audit.
                # ordering: agrees > speech-same > silent+video-same
                _RULE_STRENGTH = {
                    RULE_SPEECH_SAME_VIDEO_AGREES: 3,
                    RULE_SPEECH_SILENT_VIDEO_SAME: 2,
                    RULE_SPEECH_SAME_VIDEO_AMBIGUOUS: 1,
                    RULE_FIRST_OF_SLOT: 0,
                }
                if (_RULE_STRENGTH.get(rule_id, 0)
                        > _RULE_STRENGTH.get(prior_lr.fusion_rule, 0)):
                    prior_lr.fusion_rule = rule_id
                # Only update stored region if new one is stricter
                # ('clear' beats 'borderline' beats 'unknown').
                _CLARITY_RANK = {'clear': 2, 'borderline': 1,
                                 'unknown': 0, '': 0}
                new_r = slot.region
                old_r = prev['region']
                if new_r is not None and (old_r is None or
                        _CLARITY_RANK.get(new_r.clarity, 0) >
                        _CLARITY_RANK.get(old_r.clarity if old_r else '', 0)):
                    last_event_per_role[slot_name]['region'] = new_r
            else:
                # DISTINCT — this event is its own LocationRef.
                ref_counter += 1
                role_fallback_count[slot_name] += 1
                label = _extract_label(
                    transcript, slot_name, op_idx,
                    role_fallback_count[slot_name])
                lr = LocationRef(
                    ref=f'loc_{ref_counter}',
                    label=label,
                    role=slot_name,
                    fusion_rule=rule_id,
                    confidence=conf,
                    low_confidence=(conf < 0.7),
                    members=[{'op_index': op_idx, 'slot': slot_name}],
                )
                positions.append(lr)
                slot.location_ref = lr.ref
                last_event_per_role[slot_name] = {
                    'ref': lr.ref,
                    'region': slot.region,
                    'positions_idx': len(positions) - 1,
                }
    intent.positions = positions
    return positions


def refuse_intent(intent_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Re-run fusion on a stored intent dict (e.g. a legacy
    /opt/cobot/demonstrations/*/structured_intent.json). Returns the
    updated intent dict with positions[] populated and each pick/
    place slot's location_ref filled. Used by the re-compose script
    to migrate the on-disk demonstrations without touching the model."""
    intent = StructuredIntent.from_dict(intent_dict)
    fuse_positions(intent)
    return intent.to_dict()

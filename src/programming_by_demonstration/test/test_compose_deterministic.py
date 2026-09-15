"""Composer determinism pins (§determinism directive, 2026-08-04).

Two invariants:

  1. **Idempotence (property):** for every recorded demonstration
     intent in `/opt/cobot/demonstrations/*/structured_intent.json`,
     `compose_program_draft(intent, demo_id)` produces
     byte-identical output on two consecutive calls. No wall-clock,
     no random ids, no unsorted dict iteration.

  2. **No detect emissions (structural):** no composed program
     from ANY fixture may contain a `detect` step. The composer's
     positive-list assertion (`check_program_emissions`) blocks
     detect at emit time; this test proves the corpus round-trips
     without it AND catches a regression that shifts the assertion
     to a soft-warn.

Historical goldens (the checked-in per-demo `program_draft.json`
that pre-dates this commit) are NOT byte-compared here: today's
composer refactor moved labels through `label_vocabulary`, which
is intentionally a same-strings change but a pinned diff. A
follow-up commit that regenerates the corpus goldens should turn
this test into a full byte-identity gate against those goldens.

Corpus scope: `/opt/cobot/demonstrations/`. The bench workspace
holds every recorded demo; a fresh clone without those fixtures
skips this test cleanly (SKIPPED, not FAILED).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


_DEMOS_DIR = Path('/opt/cobot/demonstrations')


def _load_intent(demo_dir: Path):
    from programming_by_demonstration.schema import StructuredIntent
    path = demo_dir / 'structured_intent.json'
    with open(path) as fh:
        return StructuredIntent.from_dict(json.load(fh))


def _iter_demos():
    """Yield (demo_id, demo_dir) for every demo that carries a
    structured_intent.json. Sorted so the parametrize order is
    deterministic across runs (Python's os.listdir isn't)."""
    if not _DEMOS_DIR.exists():
        return
    for name in sorted(os.listdir(_DEMOS_DIR)):
        d = _DEMOS_DIR / name
        if not d.is_dir():
            continue
        if not (d / 'structured_intent.json').is_file():
            continue
        yield name, d


_DEMO_IDS = [name for name, _ in _iter_demos()]


if not _DEMO_IDS:
    pytest.skip(f'No demonstration fixtures found under {_DEMOS_DIR!s}',
                allow_module_level=True)


# ── (1) Property: compose(intent) is idempotent ─────────────────

@pytest.mark.parametrize('demo_id', _DEMO_IDS)
def test_compose_is_byte_identical_on_two_calls(demo_id):
    """The composer emits byte-identical bytes for repeated calls
    on the same intent. Any random/timestamp/id-of-object slip
    would break this — it's the property that "same intent →
    same program" hinges on."""
    from programming_by_demonstration import program_composer as pc
    demo_dir = _DEMOS_DIR / demo_id
    intent   = _load_intent(demo_dir)
    d1 = pc.compose_program_draft(intent, demo_id)
    d2 = pc.compose_program_draft(intent, demo_id)
    # Serialise both to a canonical JSON string. Steps + config +
    # description + routines all round-trip through json.dumps
    # with sort_keys for a stable byte comparison.
    def _canon(draft):
        return json.dumps({
            'steps':       draft.steps,
            'config':      draft.config,
            'description': draft.description,
            'routines':    [r.to_dict() if hasattr(r, 'to_dict') else r
                            for r in (draft.routines or [])],
            'pbd_metadata': draft.pbd_metadata,
        }, sort_keys=True, default=str)
    b1, b2 = _canon(d1), _canon(d2)
    assert b1 == b2, (
        f'{demo_id}: compose(intent) is NOT byte-identical on '
        f'two consecutive calls. First bytes differ at:\n'
        f'  b1: {b1[:200]!r}\n'
        f'  b2: {b2[:200]!r}')


# ── (2) Structural: NO detect steps ─────────────────────────────

@pytest.mark.parametrize('demo_id', _DEMO_IDS)
def test_no_detect_in_composed_output(demo_id):
    """The composer's positive-list assertion (label_vocabulary.
    check_program_emissions) blocks `detect` at emit time. This
    test proves it for every fixture — a regression that adds
    detect back to COMPOSER_EMITTABLE_ACTIONS shows up here as
    well as via the assertion path."""
    from programming_by_demonstration import program_composer as pc
    demo_dir = _DEMOS_DIR / demo_id
    intent   = _load_intent(demo_dir)
    draft    = pc.compose_program_draft(intent, demo_id)
    detects  = [s for s in draft.steps if s.get('action') == 'detect']
    assert detects == [], (
        f'{demo_id}: composer emitted {len(detects)} detect '
        f'step(s). The vision arc is not wired end-to-end yet; '
        f'detect must be impossible by construction. If vision '
        f'is being enabled, add `detect` to '
        f'COMPOSER_EMITTABLE_ACTIONS + LABEL_FOR_ROLE in the '
        f'same commit that lands the runtime.')


# ── (3) Structural: labels all match vocabulary ─────────────────

@pytest.mark.parametrize('demo_id', _DEMO_IDS)
def test_labels_all_originate_from_vocabulary(demo_id):
    """Every emitted step's label must start with a template from
    label_vocabulary.LABEL_FOR_ROLE. The composer runs
    check_program_emissions at the end of compose_program_draft,
    so this test's failure mode is EITHER a composer bug that
    slipped past the assertion OR a vocabulary entry the
    composer emits but hasn't declared."""
    from programming_by_demonstration import program_composer as pc
    from programming_by_demonstration.label_vocabulary import (
        LABEL_FOR_ROLE, check_program_emissions)
    demo_dir = _DEMOS_DIR / demo_id
    intent   = _load_intent(demo_dir)
    draft    = pc.compose_program_draft(intent, demo_id)
    # If compose_program_draft's assertion passed we know the check
    # succeeded, but re-run here so the failure mode names THIS
    # test in the traceback rather than the composer.
    check_program_emissions({'steps': draft.steps})


# ── (4) Structural: emittable action set is enforced ──────────

@pytest.mark.parametrize('demo_id', _DEMO_IDS)
def test_actions_in_positive_list(demo_id):
    from programming_by_demonstration import program_composer as pc
    from programming_by_demonstration.label_vocabulary import (
        COMPOSER_EMITTABLE_ACTIONS)
    demo_dir = _DEMOS_DIR / demo_id
    intent   = _load_intent(demo_dir)
    draft    = pc.compose_program_draft(intent, demo_id)
    for i, step in enumerate(draft.steps):
        action = step.get('action')
        assert action in COMPOSER_EMITTABLE_ACTIONS, (
            f'{demo_id} step {i}: action {action!r} is not in '
            f'COMPOSER_EMITTABLE_ACTIONS. Every new action needs a '
            f'label_vocabulary entry AND a runtime code path.')


# ── (5) Structural: composer strips vision intent fields ──────

def test_composer_ignores_pick_pattern_vision_each():
    """A synthetic intent with pick_pattern='vision_each' composes
    to the SAME output as one with pick_pattern='individual_taught'.
    Proves the composer is tolerant of the vision fields in the
    schema but does not emit vision steps from them."""
    from programming_by_demonstration import program_composer as pc
    from programming_by_demonstration.schema import (
        StructuredIntent, PICK_PATTERN_INDIVIDUAL_TAUGHT,
        PICK_PATTERN_VISION_EACH)
    def _build(pick_pattern):
        return StructuredIntent.from_dict({
            'operations': [{
                'operation_type': 'pick_and_place',
                'target_part': {'part_id': 'p1', 'name': 'bowl'},
                'pick':  {'location_hint': 'in bin'},
                'place': {'location_hint': 'on tray'},
                'count': 2,
                'pick_pattern': pick_pattern,
                'source': 'fixed_position',
            }],
            'task_summary': 'test',
        })
    d_taught = pc.compose_program_draft(
        _build(PICK_PATTERN_INDIVIDUAL_TAUGHT), 'test-taught')
    d_vision = pc.compose_program_draft(
        _build(PICK_PATTERN_VISION_EACH), 'test-vision')
    # Steps identical modulo the intent-metadata that carries the
    # pattern value (iter_pattern field on step). Normalise it out
    # before comparing.
    def _strip_pattern(steps):
        return [{k: v for k, v in s.items() if k != 'iter_pattern'}
                for s in steps]
    assert _strip_pattern(d_taught.steps) == _strip_pattern(d_vision.steps), (
        'composer emitted DIFFERENT steps for vision_each vs '
        'individual_taught. The composer must treat both '
        'patterns identically until the vision arc lands.')
    # And neither carries a detect step.
    for name, d in (('taught', d_taught), ('vision', d_vision)):
        assert not any(s.get('action') == 'detect' for s in d.steps), name


def test_composer_ignores_camera_library_source():
    """Same guarantee for op.source='camera_library'."""
    from programming_by_demonstration import program_composer as pc
    from programming_by_demonstration.schema import StructuredIntent
    def _build(source):
        return StructuredIntent.from_dict({
            'operations': [{
                'operation_type': 'pick_and_place',
                'target_part': {'part_id': 'p1', 'name': 'bowl'},
                'pick':  {'location_hint': 'in bin'},
                'place': {'location_hint': 'on tray'},
                'source': source,
            }],
            'task_summary': 'test',
        })
    d_fixed = pc.compose_program_draft(
        _build('fixed_position'), 'test-fixed')
    d_cam   = pc.compose_program_draft(
        _build('camera_library'), 'test-cam')
    assert d_fixed.steps == d_cam.steps, (
        'composer emitted DIFFERENT steps for camera_library vs '
        'fixed_position. Vision runtime is not wired; both must '
        'compose to the same fixed-pose program.')
    for name, d in (('fixed', d_fixed), ('camera', d_cam)):
        assert not any(s.get('action') == 'detect' for s in d.steps), name

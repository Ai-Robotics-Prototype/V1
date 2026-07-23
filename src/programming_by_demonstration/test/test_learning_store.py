"""Learning-store behavior for clarification answers.

Pins the two-signal shape (answered + chose_suggested) so a future
refactor can't collapse them back to the old value-comparison-only
representation that caused the review-UI answered-state bug."""

import json
import os
import tempfile

from programming_by_demonstration.learning_store import LearningStore


def _fresh_store():
    """A LearningStore rooted at a per-test tempdir so tests never
    step on each other or on /opt/cobot."""
    d = tempfile.mkdtemp(prefix='pbd_test_store_')
    return LearningStore(root=d), d


def _read_answers(store_root, demo_id):
    with open(os.path.join(store_root, demo_id, 'clarifications_answered.json')) as f:
        return json.load(f)


def test_save_clarifications_new_shape_records_both_signals():
    """{id: {value, answered, chose_suggested}} → both booleans persist
    on each row plus the value; used_default alias mirrors
    chose_suggested for older readers."""
    store, root = _fresh_store()
    demo = 'demo_clar_new'
    clarifications = [
        {'id': 'q1', 'field': 'part', 'question': 'Which part?',
         'type': 'part_select', 'suggested': 'p1'},
        {'id': 'q2', 'field': 'count', 'question': 'How many?',
         'type': 'number', 'suggested': 4},
    ]
    answers = {
        # Operator explicitly clicked the suggested option — this is
        # the case that used to render "SUGGESTED" instead of
        # "ANSWERED" and lose the interaction signal.
        'q1': {'value': 'p1', 'answered': True, 'chose_suggested': True},
        # Operator overrode the suggestion.
        'q2': {'value': 6,    'answered': True, 'chose_suggested': False},
    }
    store.save_clarifications(demo, clarifications, answers)
    payload = _read_answers(root, demo)
    rows = {r['id']: r for r in payload['answers']}
    assert rows['q1']['answered'] is True
    assert rows['q1']['chose_suggested'] is True
    assert rows['q1']['answer'] == 'p1'
    assert rows['q1']['used_default'] is True   # back-compat alias
    assert rows['q2']['answered'] is True
    assert rows['q2']['chose_suggested'] is False
    assert rows['q2']['answer'] == 6
    assert rows['q2']['used_default'] is False


def test_save_clarifications_implicit_accept_of_default():
    """No interaction, answer left equal to suggested (the 'Accept all
    suggested defaults' path). answered:false + chose_suggested:true —
    a distinct training signal from an explicit-click on the same
    value."""
    store, root = _fresh_store()
    demo = 'demo_clar_implicit'
    clarifications = [
        {'id': 'q1', 'suggested': 'blue', 'type': 'choice'},
    ]
    answers = {
        'q1': {'value': 'blue', 'answered': False, 'chose_suggested': True},
    }
    store.save_clarifications(demo, clarifications, answers)
    row = _read_answers(root, demo)['answers'][0]
    assert row['answered'] is False
    assert row['chose_suggested'] is True
    assert row['used_default'] is True


def test_save_clarifications_legacy_flat_shape_still_works():
    """{id: value} flat map (old callers) — answered is unknown (None),
    chose_suggested falls back to value comparison. Older tools that
    still POST the flat map keep working; the answered signal is just
    conservatively absent for that path."""
    store, root = _fresh_store()
    demo = 'demo_clar_legacy'
    clarifications = [
        {'id': 'q1', 'suggested': 'p1'},
        {'id': 'q2', 'suggested': 4},
    ]
    answers = {'q1': 'p1', 'q2': 6}
    store.save_clarifications(demo, clarifications, answers)
    rows = {r['id']: r for r in _read_answers(root, demo)['answers']}
    assert rows['q1']['answered'] is None
    assert rows['q1']['chose_suggested'] is True
    assert rows['q1']['used_default'] is True
    assert rows['q2']['answered'] is None
    assert rows['q2']['chose_suggested'] is False

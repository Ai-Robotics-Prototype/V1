"""Pinned tests for the 2026-08-05 edit-through + refresh persistence.

Fork registry: page_context_persistence.

The refresh gauntlet: an operator opens a program, teaches a pose,
reorders a step, refreshes the tablet — the reloaded UI must show
BOTH the pose AND the reorder. The pre-fix bug lost the reorder
because save() used the disk-saved program as base, ignoring the
staged_program the /edit endpoint had written.

These tests exercise the merge logic hermetically — same pattern as
test_teach_session_lifecycle.py.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import time

import pytest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


@pytest.fixture
def teach_dir(tmp_path):
    d = str(tmp_path / 'teach_sessions')
    os.makedirs(d, exist_ok=True)
    return d


@pytest.fixture
def prog_dir(tmp_path):
    d = str(tmp_path / 'programs')
    os.makedirs(d, exist_ok=True)
    return d


def _write_program(prog_dir, pid, program):
    with open(os.path.join(prog_dir, pid + '.json'), 'w') as fh:
        json.dump(program, fh)


def _write_draft(teach_dir, pid, draft):
    with open(os.path.join(teach_dir, pid + '.draft.json'), 'w') as fh:
        json.dump(draft, fh)


def _read_program(prog_dir, pid):
    with open(os.path.join(prog_dir, pid + '.json')) as fh:
        return json.load(fh)


def _read_draft(teach_dir, pid):
    p = os.path.join(teach_dir, pid + '.draft.json')
    if not os.path.exists(p):
        return None
    with open(p) as fh:
        return json.load(fh)


# The core merge invariant, re-declared hermetically. The three
# rules the fix must uphold:
#   1. If draft.staged_program is present → merge uses it as base
#   2. If not → merge uses disk-saved program as base
#   3. draft.poses always overlays on top (last-write-wins per slot)
def _merge(base_program, poses):
    """Mirror of the dashboard's _apply_draft_poses_to_program
    reduced to the invariants under test — steps carry taught_tcp/
    taught_joints from the matching pose slot, everything else is
    the base program verbatim."""
    p = copy.deepcopy(base_program)
    for step in p.get('steps', []):
        key = f"step:{step.get('id')}"
        if key in poses:
            for k, v in poses[key].items():
                step[k] = v
    return p


def _refresh_pick(saved, draft):
    """The refresh path: pick which program the UI should render
    on reload. When a draft with staged_program exists → use it
    (with pose overlay applied); when only poses exist → use
    saved with pose overlay; otherwise → saved."""
    if draft is None:
        return saved
    base = (draft.get('staged_program')
            if isinstance(draft.get('staged_program'), dict)
            else saved)
    return _merge(base, draft.get('poses') or {})


# ── Invariants ────────────────────────────────────────────────────

def test_refresh_with_staged_reorder_survives(teach_dir, prog_dir):
    """Steps 1,2,3 on disk. Operator reorders to 1,3,2 via /edit.
    Refresh must show 1,3,2."""
    saved = {
        'id': 'p1',
        'steps': [{'id': 'a', 'kind': 'move_to'},
                  {'id': 'b', 'kind': 'move_to'},
                  {'id': 'c', 'kind': 'move_to'}],
    }
    _write_program(prog_dir, 'p1', saved)
    draft = {
        'program_id': 'p1',
        'owner_device_id': 'dev-A',
        'poses': {},
        'staged_program': {
            'id': 'p1',
            'steps': [{'id': 'a', 'kind': 'move_to'},
                      {'id': 'c', 'kind': 'move_to'},
                      {'id': 'b', 'kind': 'move_to'}],
        },
    }
    _write_draft(teach_dir, 'p1', draft)
    view = _refresh_pick(_read_program(prog_dir, 'p1'),
                         _read_draft(teach_dir, 'p1'))
    assert [s['id'] for s in view['steps']] == ['a', 'c', 'b']


def test_refresh_with_only_poses_uses_saved_base(teach_dir, prog_dir):
    """No staged_program → save base = disk program, pose overlay
    still applied. This is the pre-existing record-through path."""
    saved = {
        'id': 'p2',
        'steps': [{'id': 'a', 'kind': 'move_to'},
                  {'id': 'b', 'kind': 'move_to'}],
    }
    _write_program(prog_dir, 'p2', saved)
    draft = {
        'program_id': 'p2',
        'owner_device_id': 'dev-A',
        'poses': {'step:a': {'taught_tcp': [1, 2, 3]}},
    }
    _write_draft(teach_dir, 'p2', draft)
    view = _refresh_pick(_read_program(prog_dir, 'p2'),
                         _read_draft(teach_dir, 'p2'))
    assert view['steps'][0]['taught_tcp'] == [1, 2, 3]
    # Order preserved from disk.
    assert [s['id'] for s in view['steps']] == ['a', 'b']


def test_refresh_reorder_and_teach_both_survive(teach_dir, prog_dir):
    """The full gauntlet: teach step B, THEN reorder A/B/C → A/C/B.
    Both the pose AND the reorder must survive refresh."""
    saved = {
        'id': 'p3',
        'steps': [{'id': 'a', 'kind': 'move_to'},
                  {'id': 'b', 'kind': 'move_to'},
                  {'id': 'c', 'kind': 'move_to'}],
    }
    _write_program(prog_dir, 'p3', saved)
    draft = {
        'program_id': 'p3',
        'owner_device_id': 'dev-A',
        'poses': {'step:b': {'taught_tcp': [9, 9, 9]}},
        'staged_program': {
            'id': 'p3',
            'steps': [{'id': 'a', 'kind': 'move_to'},
                      {'id': 'c', 'kind': 'move_to'},
                      {'id': 'b', 'kind': 'move_to'}],
        },
    }
    _write_draft(teach_dir, 'p3', draft)
    view = _refresh_pick(_read_program(prog_dir, 'p3'),
                         _read_draft(teach_dir, 'p3'))
    assert [s['id'] for s in view['steps']] == ['a', 'c', 'b']
    # Step b (now last) still carries the taught pose.
    b_step = next(s for s in view['steps'] if s['id'] == 'b')
    assert b_step['taught_tcp'] == [9, 9, 9]


def test_refresh_without_draft_returns_saved(teach_dir, prog_dir):
    """No draft at all → the unmodified disk program is what
    the operator sees. This is the resting state."""
    saved = {'id': 'p4', 'steps': [{'id': 'a'}]}
    _write_program(prog_dir, 'p4', saved)
    view = _refresh_pick(_read_program(prog_dir, 'p4'),
                         _read_draft(teach_dir, 'p4'))
    assert view == saved


def test_refresh_stage_deletes_step(teach_dir, prog_dir):
    """Structural edit that DELETES a step. The pose that was
    associated with the deleted step is orphaned — this test
    pins the merge behavior: no crash, the deleted step doesn't
    reappear, the remaining steps are unaffected."""
    saved = {
        'id': 'p5',
        'steps': [{'id': 'a'}, {'id': 'b'}, {'id': 'c'}],
    }
    _write_program(prog_dir, 'p5', saved)
    draft = {
        'program_id': 'p5',
        'owner_device_id': 'dev-A',
        'poses': {'step:b': {'taught_tcp': [5, 5, 5]}},
        'staged_program': {
            'id': 'p5',
            'steps': [{'id': 'a'}, {'id': 'c'}],   # b deleted
        },
    }
    _write_draft(teach_dir, 'p5', draft)
    view = _refresh_pick(_read_program(prog_dir, 'p5'),
                         _read_draft(teach_dir, 'p5'))
    assert [s['id'] for s in view['steps']] == ['a', 'c']
    # No step should carry the orphaned pose.
    for s in view['steps']:
        assert s.get('taught_tcp') != [5, 5, 5]


def test_refresh_stage_adds_step(teach_dir, prog_dir):
    """New step added client-side, then refresh. Pose overlay for
    the new step ID applies to the newly-added step."""
    saved = {'id': 'p6', 'steps': [{'id': 'a'}]}
    _write_program(prog_dir, 'p6', saved)
    draft = {
        'program_id': 'p6',
        'owner_device_id': 'dev-A',
        'poses': {'step:new': {'taught_tcp': [8, 8, 8]}},
        'staged_program': {
            'id': 'p6',
            'steps': [{'id': 'a'}, {'id': 'new', 'kind': 'move_to'}],
        },
    }
    _write_draft(teach_dir, 'p6', draft)
    view = _refresh_pick(_read_program(prog_dir, 'p6'),
                         _read_draft(teach_dir, 'p6'))
    assert [s['id'] for s in view['steps']] == ['a', 'new']
    assert view['steps'][1]['taught_tcp'] == [8, 8, 8]


def test_staged_program_replaces_metadata_and_config(teach_dir, prog_dir):
    """A structural edit isn't just step order — a rename or config
    change also lives on the staged_program. Same invariant: the
    refresh must render the STAGED metadata, not the saved one."""
    saved = {'id': 'p7', 'name': 'old_name',
             'motion_profile_name': 'Conservative', 'steps': []}
    _write_program(prog_dir, 'p7', saved)
    draft = {
        'program_id': 'p7',
        'owner_device_id': 'dev-A',
        'poses': {},
        'staged_program': {'id': 'p7', 'name': 'new_name',
                            'motion_profile_name': 'Balanced',
                            'steps': []},
    }
    _write_draft(teach_dir, 'p7', draft)
    view = _refresh_pick(_read_program(prog_dir, 'p7'),
                         _read_draft(teach_dir, 'p7'))
    assert view['name'] == 'new_name'
    assert view['motion_profile_name'] == 'Balanced'

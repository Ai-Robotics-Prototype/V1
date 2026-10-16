"""Pinned tests for repeated-routine detection (2026-08-02).

Two layers under test:
  A. detect_routines()  — pure detector over intent.operations.
  B. compose_program_draft() — routines[] populated on ProgramDraft;
     each grouped step carries routine_id + routine_iteration.

Plus the byte-diff invariant: a routine-grouped program emits
byte-identical Lua to its flat equivalent — codegen is unaware of
routines[], which is the whole point (representation-only grouping,
loop emission deferred).
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

# Reach codegen for the byte-diff test.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent
                       / 'estun_driver'))

from estun_driver.program_ops import codegen_lua_from_program  # noqa: E402

from programming_by_demonstration.schema import (
    IntentOperation,
    LocationRegion,
    PartReference,
    PoseSlot,
    StructuredIntent,
)
from programming_by_demonstration.fusion import fuse_positions
from programming_by_demonstration.program_composer import compose_program_draft
from programming_by_demonstration.routine_detector import (
    _op_signature,
    detect_routines,
)


def _pnp_op(seq: int, pick_ref: str, place_ref: str,
            effector: str = 'finger',
            count: int = 1) -> IntentOperation:
    return IntentOperation(
        operation_type='pick_and_place',
        target_part=PartReference('unknown', 'part'),
        sequence_index=seq,
        count=count,
        pick=PoseSlot(location_hint='tray', location_ref=pick_ref,
                      region=LocationRegion(cell='TL', clarity='clear')),
        place=PoseSlot(location_hint='fixture', location_ref=place_ref,
                       region=LocationRegion(cell='BR', clarity='clear')),
        effector=effector,
    )


# ── detect_routines() unit checks ──────────────────────────────

def test_two_identical_ops_collapse_into_one_routine():
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2'),
        _pnp_op(2, 'loc_1', 'loc_2'),
    ])
    routines = detect_routines(intent)
    assert len(routines) == 1
    assert routines[0].iterations == 2
    assert routines[0].operation_indices == [0, 1]
    assert routines[0].name == 'Pick & place ×2'


def test_three_identical_ops_group_together():
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2'),
        _pnp_op(2, 'loc_1', 'loc_2'),
        _pnp_op(3, 'loc_1', 'loc_2'),
    ])
    routines = detect_routines(intent)
    assert len(routines) == 1
    assert routines[0].iterations == 3
    assert routines[0].name == 'Pick & place ×3'


def test_ops_with_different_location_refs_do_not_group():
    """Two same-op-type ops MUST NOT group when their location_refs
    differ — the whole point of position identity."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2'),
        _pnp_op(2, 'loc_3', 'loc_4'),   # different picks + places
    ])
    routines = detect_routines(intent)
    assert routines == []


def test_intervening_op_breaks_grouping():
    """Consecutive-only rule: ops separated by any other op do NOT
    group (conservative first pass, task §1)."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2'),
        _pnp_op(2, 'loc_3', 'loc_4'),
        _pnp_op(3, 'loc_1', 'loc_2'),   # matches op 0 but interrupted
    ])
    routines = detect_routines(intent)
    assert routines == []


def test_effector_difference_breaks_grouping():
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2', effector='finger'),
        _pnp_op(2, 'loc_1', 'loc_2', effector='vacuum'),
    ])
    routines = detect_routines(intent)
    assert routines == []


def test_untagged_refs_never_group():
    """Empty location_ref = fusion hasn't run. Refuse to group —
    otherwise a legacy demo with two visually-similar ops could be
    incorrectly collapsed."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, '', ''),
        _pnp_op(2, '', ''),
    ])
    routines = detect_routines(intent)
    assert routines == []


def test_two_runs_of_two_produce_two_routines():
    """Consecutive runs of 2+ produce SEPARATE routines when the
    signatures differ between the runs."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2'),
        _pnp_op(2, 'loc_1', 'loc_2'),
        _pnp_op(3, 'loc_3', 'loc_4'),
        _pnp_op(4, 'loc_3', 'loc_4'),
    ])
    routines = detect_routines(intent)
    assert len(routines) == 2
    assert routines[0].iterations == 2
    assert routines[1].iterations == 2
    assert routines[0].operation_indices == [0, 1]
    assert routines[1].operation_indices == [2, 3]


def test_singleton_run_is_not_a_routine():
    """Length-1 run = a routine of one, which is just an op. Skip."""
    intent = StructuredIntent(operations=[_pnp_op(1, 'loc_1', 'loc_2')])
    routines = detect_routines(intent)
    assert routines == []


def test_op_signature_stable_across_equal_ops():
    a = _pnp_op(1, 'loc_1', 'loc_2')
    b = _pnp_op(2, 'loc_1', 'loc_2')
    assert _op_signature(a) == _op_signature(b)
    assert _op_signature(a) is not None


# ── compose_program_draft() integration ────────────────────────

def _two_pnp_same_refs_intent():
    si = StructuredIntent(
        task_summary='pick tray, place fixture',
        raw_understanding_notes='pick from the tray, place on the fixture. same spot again for pick and place.',
        operations=[
            _pnp_op(1, '', ''),   # location refs get resolved by fusion
            _pnp_op(2, '', ''),
        ],
    )
    fuse_positions(si)
    return si


def test_grouped_draft_populates_routines_list():
    si = _two_pnp_same_refs_intent()
    draft = compose_program_draft(si, demo_id='grouped')
    assert len(draft.routines) == 1
    r = draft.routines[0]
    assert r.iterations == 2
    assert 'Pick & place' in r.name


def test_grouped_steps_carry_routine_metadata():
    si = _two_pnp_same_refs_intent()
    draft = compose_program_draft(si, demo_id='grouped-meta')
    routined = [s for s in draft.steps if 'routine_id' in s]
    assert routined, draft.steps
    ids = {s['routine_id'] for s in routined}
    assert len(ids) == 1
    iters = {s['routine_iteration'] for s in routined}
    assert iters == {0, 1}


def test_flat_draft_has_empty_routines():
    """A single-op program → no routines[]. Regression gate for
    every legacy demo composed through the new pipeline."""
    si = StructuredIntent(operations=[_pnp_op(1, 'loc_1', 'loc_2')])
    draft = compose_program_draft(si, demo_id='flat')
    assert draft.routines == []
    for s in draft.steps:
        assert 'routine_id'        not in s, s
        assert 'routine_iteration' not in s, s


# ── Byte-diff invariant: routines[] never changes emitted Lua ──

def test_routine_grouped_lua_bytediff():
    """Compose a 2-op grouped program AND a flat 2-op program with
    identical taught structure; run both through codegen. Emitted
    Lua must be byte-identical modulo the trailer timestamp and
    src_sha (these are wall-clock-dependent lines the trailer test
    already strips)."""
    # (a) Grouped: build via the composer with two matching ops.
    si = _two_pnp_same_refs_intent()
    grouped_draft = compose_program_draft(si, demo_id='byte-diff-grouped')
    grouped_steps = grouped_draft.steps

    # (b) Flat equivalent: same steps but with routine_id and
    #     routine_iteration stripped, to prove codegen ignores those
    #     fields (they're representation-only).
    flat_steps = []
    for s in grouped_steps:
        s2 = {k: v for k, v in s.items()
              if k not in ('routine_id', 'routine_iteration')}
        flat_steps.append(s2)

    def _lua(steps):
        program = {
            'id':     'byte-diff-test',
            'name':   'byte-diff-test',
            'config': {'speed_pct': 50},
            'steps':  steps,
        }
        lua, _, _ = codegen_lua_from_program(
            program, operator_speed_limit_pct=100)
        # Strip trailer + src_sha lines that carry wall-clock timestamps.
        keep = []
        for ln in lua.splitlines():
            if ln.startswith('--Lua version'):
                continue
            if ln.startswith('-- codegen:'):
                continue
            keep.append(ln)
        return '\n'.join(keep)

    grouped_lua = _lua(grouped_steps)
    flat_lua    = _lua(flat_steps)
    assert grouped_lua == flat_lua, (
        f'routine_id / routine_iteration must be representation-only. '
        f'grouped-vs-flat diff length: {len(grouped_lua)} vs {len(flat_lua)}')


# ── Teach-flow counter ────────────────────────────────────────

def test_teach_once_within_a_routine():
    """A routine of 2 iterations that share location_refs teaches the
    positions ONCE — the second iteration's contacts get rewritten
    to derived_from_step_id repeats by the composer's dedupe pass."""
    si = _two_pnp_same_refs_intent()
    draft = compose_program_draft(si, demo_id='teach-once')
    anchors = [s for s in draft.steps
               if s.get('position_role') in ('pick', 'place')
               and not s.get('derived_from')
               and not s.get('derived_from_step_id')]
    linked = [s for s in draft.steps if s.get('derived_from_step_id')]
    # Two anchors (one pick + one place); two linked repeats
    # (iteration 1 for pick and for place).
    assert len(anchors) == 2, [s.get('label') for s in anchors]
    assert len(linked)  == 2, [s.get('label') for s in linked]


# ── §430 extension: single-op count>=2 → routine ─────────────────

def test_single_op_count_five_becomes_routine_of_five():
    """The 63-step white bowl demo shape: one pick_and_place op with
    count=5 that the composer expands into 5 iterations. This ALSO
    counts as a routine now (§430) so the review/editor can fold
    to "×5"."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2', count=5),
    ])
    routines = detect_routines(intent)
    assert len(routines) == 1
    r = routines[0]
    assert r.iterations == 5, r
    assert r.operation_indices == [0], r
    assert r.single_iteration_signature.get('kind') == 'single_op_multi_iter'
    assert '×5' in r.name


def test_single_op_count_one_is_not_a_routine():
    """count=1 = a single execution → not a routine. Guard for the
    legacy demo shape (1 op, 1 iter)."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2', count=1),
    ])
    assert detect_routines(intent) == []


def test_single_op_multi_iter_step_metadata():
    """Every emitted step from a single-op count>=2 op carries
    routine_id + routine_iteration matching its iter_index."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2', count=3),
    ])
    fuse_positions(intent)  # ensure refs are set as in real path
    draft = compose_program_draft(intent, demo_id='single-op-5')
    assert len(draft.routines) == 1
    r = draft.routines[0]
    # Iteration ranges: each iteration should be a contiguous span
    # of steps.  count=3 iterations → 3 ranges.
    assert len(r.step_indices_per_iter) == 3, r.step_indices_per_iter
    # Every step in the ranges carries routine_id + a routine_iteration
    # matching its iter_index (0..2).
    for iter_i, (a, b) in enumerate(r.step_indices_per_iter):
        for s in draft.steps[a:b]:
            assert s.get('routine_id') == r.id, s
            assert s.get('routine_iteration') == iter_i, s
    # Steps outside a routine (home wrappers) stay flat.
    outside = [s for s in draft.steps if 'routine_id' not in s]
    # Home wrappers are outside the op span (composer prepends home
    # then appends return home). Both should be routine-free.
    assert outside, 'expected home wrappers to sit outside the routine'
    for s in outside:
        assert 'routine_iteration' not in s


def test_single_op_routine_byte_diff_lua_matches_flat():
    """Codegen invariant, §430 case: a single-op count>=2 routine
    emits Lua byte-identical to the same steps with routine_id +
    routine_iteration stripped. Proves the loop-emission is still
    deferred and that single-op grouping is representation-only."""
    intent = StructuredIntent(operations=[
        _pnp_op(1, 'loc_1', 'loc_2', count=4),
    ])
    fuse_positions(intent)
    grouped_draft = compose_program_draft(intent, demo_id='single-op-bytediff')
    grouped_steps = grouped_draft.steps
    flat_steps = [
        {k: v for k, v in s.items()
         if k not in ('routine_id', 'routine_iteration')}
        for s in grouped_steps
    ]

    def _lua(steps):
        program = {
            'id':     'byte-diff-single-op',
            'name':   'byte-diff-single-op',
            'config': {'speed_pct': 50},
            'steps':  steps,
        }
        lua, _, _ = codegen_lua_from_program(
            program, operator_speed_limit_pct=100)
        return '\n'.join(
            ln for ln in lua.splitlines()
            if not ln.startswith('--Lua version')
            and not ln.startswith('-- codegen:'))

    assert _lua(grouped_steps) == _lua(flat_steps), (
        'single-op routine metadata must not change emitted Lua')

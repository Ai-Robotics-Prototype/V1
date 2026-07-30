"""Repeated-routine detection over an intent's operation list.

Consumed by the composer AFTER it emits its flat step list; produces:
  * a list of Routine descriptors (representation-only), and
  * a per-step {routine_id, routine_iteration} decoration written
    onto the emitted step dicts.

Codegen is INTENTIONALLY untouched: emission stays unrolled and a
grouped program produces byte-identical Lua to its flat-authored
equivalent (pinned by test_routine_grouped_lua_bytediff). Loop-
emission is deferred; this is the model layer only.

Conservative scope for the first pass (2026-08-02 §1):
  * Consecutive-only. Two ops separated by any other op do NOT group.
  * Identical structure: op_type + pick.location_ref + place.location_ref
    + count + patterns + effector + source + pallet + iteration
    offsets. Any difference → distinct routines.
  * Non-refined refs (empty location_ref) → NOT grouped. Explicit
    identity is required to avoid over-merging legacy demos where
    fusion didn't run.
  * Runs of length 1 are not routines. Minimum length = 2.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .schema import IntentOperation, Routine, StructuredIntent


def _op_signature(op: IntentOperation) -> Optional[Tuple[Any, ...]]:
    """Return a hashable stable identity tuple for `op`, or None if
    the op can't participate in routine detection (missing location
    refs, unusable op_type). Two ops with equal signatures are
    routine-equivalent.

    Location refs are the load-bearing bit: without a resolved
    location_ref, two same-shape ops might STILL be different physical
    positions (fusion hasn't run yet). Refuse to group in that case.
    """
    op_type = (op.operation_type or '').strip().lower()
    if not op_type:
        return None
    pick_ref  = (op.pick.location_ref  if op.pick  else '') or ''
    place_ref = (op.place.location_ref if op.place else '') or ''
    if not pick_ref and not place_ref:
        # Untagged locations — refuse to group. See the module
        # docstring for the rationale.
        return None
    pallet_key: Tuple[Any, ...] = ()
    if op.pallet is not None:
        pallet_key = (op.pallet.rows, op.pallet.cols, op.pallet.layers,
                      op.pallet.fill_order,
                      op.pallet.spacing_x_mm, op.pallet.spacing_y_mm,
                      op.pallet.layer_height_mm)
    return (
        op_type,
        pick_ref,
        place_ref,
        int(op.count or 1),
        op.pick_pattern,
        op.pick_pitch_dx_mm,
        op.pick_pitch_dy_mm,
        op.place_pattern,
        op.place_stack_dz_mm,
        op.place_pitch_dx_mm,
        op.place_pitch_dy_mm,
        op.effector,
        op.source,
        pallet_key,
    )


def _routine_name(op: IntentOperation, iterations: int) -> str:
    """Human-readable routine title from the op + count.

    Examples:
      pick_and_place, 3 iterations → 'Pick & place ×3'
      sort           , 2           → 'Sort ×2'
      palletize      , 4           → 'Palletize ×4'
    """
    op_type_pretty = {
        'pick_and_place': 'Pick & place',
        'sort':           'Sort',
        'machine_tend':   'Machine tend',
        'palletize':      'Palletize',
        'depalletize':    'Depalletize',
    }.get(op.operation_type, (op.operation_type or 'routine').replace('_', ' ').title())
    return f'{op_type_pretty} ×{iterations}'


def detect_routines(intent: StructuredIntent) -> List[Routine]:
    """Walk intent.operations (in sequence_index order) and return
    the consecutive-run routines. Runs of length 1 (i.e. any op with
    a unique signature among its neighbours) are NOT wrapped —
    they'd be routines-of-one and their emission is unchanged.
    """
    ops = sorted(
        list(intent.operations or []),
        key=lambda o: o.sequence_index if o.sequence_index else 0,
    )
    routines: List[Routine] = []
    i = 0
    while i < len(ops):
        sig = _op_signature(ops[i])
        if sig is None:
            i += 1
            continue
        j = i + 1
        while j < len(ops) and _op_signature(ops[j]) == sig:
            j += 1
        run_len = j - i
        if run_len >= 2:
            routines.append(Routine(
                id=f'routine_{len(routines) + 1}',
                name=_routine_name(ops[i], run_len),
                iterations=run_len,
                operation_indices=list(range(i, j)),
                step_indices_per_iter=[],   # filled in by decorate_steps
                per_iteration_deltas=[],
                single_iteration_signature={
                    'op_type':      sig[0],
                    'pick_ref':     sig[1],
                    'place_ref':    sig[2],
                    'count':        sig[3],
                    'effector':     sig[11],
                    'source':       sig[12],
                },
            ))
        i = j
    return routines


def decorate_steps(steps: List[Dict[str, Any]],
                   routines: List[Routine],
                   op_step_ranges: List[Tuple[int, int]]) -> None:
    """Write routine_id + routine_iteration onto each emitted step
    that participates in a routine, and fill each routine's
    `step_indices_per_iter` with [start, end) ranges for each iteration.

    `op_step_ranges[k]` = (start, end) — the [start, end) range of
    `steps` that operation k contributed. Provided by the composer
    since only it knows how many steps each op emitted.

    Mutates both `steps` and `routines` in place. No-op when the
    routines list is empty (the flat-program case).
    """
    for r in routines:
        r.step_indices_per_iter = []
        for iter_idx, op_idx in enumerate(r.operation_indices):
            if 0 <= op_idx < len(op_step_ranges):
                start, end = op_step_ranges[op_idx]
                r.step_indices_per_iter.append([start, end])
                for s_idx in range(start, end):
                    if 0 <= s_idx < len(steps):
                        steps[s_idx]['routine_id']        = r.id
                        steps[s_idx]['routine_iteration'] = iter_idx

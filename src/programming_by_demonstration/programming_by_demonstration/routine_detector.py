"""Repeated-routine detection over an intent's operation list.

Consumed by the composer AFTER it emits its flat step list; produces:
  * a list of Routine descriptors (representation-only), and
  * a per-step {routine_id, routine_iteration} decoration written
    onto the emitted step dicts.

Codegen is INTENTIONALLY untouched: emission stays unrolled and a
grouped program produces byte-identical Lua to its flat-authored
equivalent (pinned by test_routine_grouped_lua_bytediff). Loop-
emission is deferred; this is the model layer only.

Scope (2026-08-02 §1, extended §430 2026-07-30):
  * Consecutive-only for MULTI-OP runs. Two ops separated by any
    other op do NOT group.
  * Identical structure: op_type + pick.location_ref + place.location_ref
    + count + patterns + effector + source + pallet + iteration
    offsets. Any difference → distinct routines.
  * Non-refined refs (empty location_ref) → NOT grouped. Explicit
    identity is required to avoid over-merging legacy demos where
    fusion didn't run.
  * Multi-op minimum length = 2 (a single unique op is not a routine
    of one — its emission is unchanged).
  * SINGLE-OP with count >= 2 ALSO forms a routine, iterations=count.
    This is the shape the 2026-07-30 63-step white bowl demo has:
    one op with count=5 that the composer expands into 5 iterations.
    Grouping this shape gives the review + editor the same folded
    "×5" render as a multi-op routine.
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
    routines under two rules:

      * MULTI-OP: >=2 consecutive ops with matching signatures →
        one routine with iterations=len(run).
      * SINGLE-OP with count >= 2: a single op that the composer
        expands into count iterations → one routine with
        iterations=count.  This covers the common demonstrated
        "pick these N bowls" case (one op, N iterations).

    Non-participating ops (untagged refs, or single ops with
    count<2) emit no routine metadata; their steps stay flat.
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
        run_len   = j - i
        single_op_count = int(ops[i].count or 1) if run_len == 1 else 0
        # Two paths group into a routine:
        #   * multi-op run of length >= 2, or
        #   * single op with count >= 2 (iterations come from
        #     the composer's per-iter expansion of that one op).
        if run_len >= 2 or single_op_count >= 2:
            iterations = run_len if run_len >= 2 else single_op_count
            routines.append(Routine(
                id=f'routine_{len(routines) + 1}',
                name=_routine_name(ops[i], iterations),
                iterations=iterations,
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
                    # Kind marker so the FE can decide whether an
                    # edit propagates via routine_iteration (multi-
                    # op) or via iter_index within a single op.
                    'kind': 'multi_op' if run_len >= 2 else 'single_op_multi_iter',
                },
            ))
        i = j
    return routines


def decorate_steps(steps: List[Dict[str, Any]],
                   routines: List[Routine],
                   op_step_ranges: List[Tuple[int, int]],
                   op_iter_ranges: Optional[Dict[int, List[List[int]]]] = None,
                   ) -> None:
    """Write routine_id + routine_iteration onto each emitted step
    that participates in a routine, and fill each routine's
    `step_indices_per_iter` with [start, end) ranges for each iteration.

    Two grouping shapes:
      * MULTI-OP: each iteration = one source op → one op_step_ranges
        slice. iteration index = position within operation_indices.
      * SINGLE-OP with count>=2: the ONE op's step slice is
        further partitioned by `op_iter_ranges[op_idx]` — the
        composer supplies exact [start, end) ranges for each
        iteration since it built them.  When op_iter_ranges is
        missing (unexpected), the routine's step_indices_per_iter
        stays empty and no step is decorated (safe fail-open).

    Mutates both `steps` and `routines` in place. No-op when the
    routines list is empty (the flat-program case).
    """
    op_iter_ranges = op_iter_ranges or {}
    for r in routines:
        r.step_indices_per_iter = []
        kind = (r.single_iteration_signature or {}).get('kind', 'multi_op')
        if kind == 'single_op_multi_iter':
            if not r.operation_indices:
                continue
            op_idx = r.operation_indices[0]
            iters = op_iter_ranges.get(op_idx)
            if not iters:
                # Composer didn't supply per-iter ranges — fall back
                # to a single "iteration" spanning the whole op. This
                # keeps step decoration coherent even if a future
                # op_type expands multi-iter without wiring iter
                # ranges, at the cost of no fold in the UI.
                if 0 <= op_idx < len(op_step_ranges):
                    a, b = op_step_ranges[op_idx]
                    r.step_indices_per_iter = [[a, b]]
                    for s_idx in range(a, b):
                        if 0 <= s_idx < len(steps):
                            steps[s_idx]['routine_id']        = r.id
                            steps[s_idx]['routine_iteration'] = 0
                continue
            for iter_i, rng in enumerate(iters):
                a, b = int(rng[0]), int(rng[1])
                r.step_indices_per_iter.append([a, b])
                for s_idx in range(a, b):
                    if 0 <= s_idx < len(steps):
                        steps[s_idx]['routine_id']        = r.id
                        steps[s_idx]['routine_iteration'] = iter_i
        else:
            # Multi-op routine — each iteration = one source op.
            for iter_idx, op_idx in enumerate(r.operation_indices):
                if 0 <= op_idx < len(op_step_ranges):
                    start, end = op_step_ranges[op_idx]
                    r.step_indices_per_iter.append([start, end])
                    for s_idx in range(start, end):
                        if 0 <= s_idx < len(steps):
                            steps[s_idx]['routine_id']        = r.id
                            steps[s_idx]['routine_iteration'] = iter_idx

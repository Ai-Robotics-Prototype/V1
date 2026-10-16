"""Canonical label vocabulary + positive-list of emittable actions
for the PBD composer (§determinism directive, 2026-08-04).

Before this module, every step factory in `program_composer.py`
inlined its own label string (line 237 `'Move to home position'`,
line 308 `'Open gripper'`, line 566 `f'{base} — {i+1} of {n}{tag}'`,
etc.). Adding or renaming a label meant grepping across factories;
auditability required reading the whole composer.

This module is the SINGLE SOURCE OF TRUTH for:

  (1) `COMPOSER_EMITTABLE_ACTIONS` — the exact set of `action`
      strings the composer is allowed to produce. `detect` is
      DELIBERATELY absent (no camera-detection code path exists;
      the directive says "impossible by construction, not filtered
      at runtime"). A composer edit that emits an action outside
      this set fails the post-emit assertion in `_check_emit_shape`.

  (2) `LABEL_FOR_ROLE` — a role → label-template registry. Roles
      identify the SEMANTIC step (`home`, `approach_above_pick`,
      `pick_contact`, `engage_vacuum`, `wait_machine_finish`, …).
      Every composer emission goes through `label_for(role, …)`
      which returns the canonical string. Templates can accept
      operator-spoken parameters (part name, iteration index) but
      NEVER free-form LLM text.

  (3) `label_for(role, part_name=None, iter_index=None,
      iter_count=None, extra=None)` — the one function callers
      use. `part_name` fills a `{part}` placeholder if the
      template has one; iteration indices fill `{i}` / `{n}`.
      `extra` is an operator-provided qualifier (e.g. a
      slot-index tag for pallet moves) that lands in a fixed
      slot at the end of the label.

The composer's registry entry in `tools/fork_registry.yaml`
forbids any hardcoded label string outside this module. A
regression that reintroduces an inline label fails the deploy-
time fork_lint gate.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


# ── Positive list of emittable actions ────────────────────────
#
# `detect` INTENTIONALLY absent: no camera detection code path
# exists in the runtime yet, and the directive is explicit —
# the composer must be UNABLE to emit `detect`, not merely
# gated at runtime. When the vision arc lands, this set is the
# ONE place to enable it.
#
# `open_gripper` covers both "open" and "release" semantics
# (both use the same wire verb; label distinguishes them).
COMPOSER_EMITTABLE_ACTIONS = frozenset({
    'move_home',
    'move_linear',
    'move_to_pallet',
    'open_gripper',
    'close_gripper',
    'set_io',
    'wait',
})


# ── Canonical labels keyed by semantic role ───────────────────
#
# Every role name maps to a template. `{part}` fills from the
# operation's target_part.name; `{i}`, `{n}` from iteration
# metadata. Roles WITHOUT a template placeholder produce a
# fixed string regardless of parameters (e.g., 'engage_vacuum'
# is always "Engage vacuum" — no iteration suffix).
#
# Iteration decoration ("— i of n (part)") lives in
# `_apply_iteration_suffix` below, applied uniformly. That
# keeps the templates atomic: the ROLE names the shape, the
# suffix names the iteration.
LABEL_FOR_ROLE: Dict[str, str] = {
    # ── Home ─────────────────────────────────────────────────
    'move_to_home':           'Move to home position',
    'return_to_home':         'Return to home',

    # ── Pick side (any iteration) ────────────────────────────
    'approach_above_pick':    'Approach above pick',
    'pick_contact':           'Pick position — contact',
    'retreat_above_pick':     'Retreat above pick',

    # ── Place side (any iteration) ───────────────────────────
    'approach_above_place':   'Approach above place',
    'place_contact':          'Place position — contact',
    'retreat_above_place':    'Retreat above place',
    'place_position':         'Place position',   # for offset-derived label bases

    # ── Machine-tend (fixture) ────────────────────────────────
    'approach_machine_load':  'Approach machine load',
    'machine_load_contact':   'Machine load — contact',
    'retreat_machine_load':   'Retreat from machine load',
    'approach_finished_part': 'Approach finished part',
    'retreat_finished_part':  'Retreat with finished part',
    'approach_unload':        'Approach unload',
    'unload_contact':         'Unload position — contact',
    'retreat_unload':         'Retreat from unload',
    'start_machine_cycle':    'Start machine cycle',
    'wait_machine_finish':    'Wait for machine to finish',
    'clear_cycle_start':      'Clear cycle start',

    # ── Pallet expansion (executor-computed) ─────────────────
    'pallet_place':           'Place at pallet slot [computed at runtime]',
    'pallet_pick':            'Pick from pallet slot [computed at runtime]',

    # ── Gripper (finger effector) ────────────────────────────
    'open_gripper':           'Open gripper',
    'grip_part':              'Grip part',
    'release_part':           'Release part',

    # ── Vacuum / magnet effectors ────────────────────────────
    # Strings match the composer's historical emissions exactly so
    # legacy fixtures / golden programs round-trip without churn.
    'engage_vacuum':          'Engage vacuum',
    'disengage_vacuum':       'Disengage vacuum',
    'wait_vacuum_seal':       'Wait for vacuum seal',
    'wait_vacuum_release':    'Wait for vacuum release',
    'engage_magnet':          'Engage magnet',
    'disengage_magnet':       'Disengage magnet',
    'ready_vacuum':           'Vacuum off (ready)',
    'ready_magnet':           'Magnet off (ready)',
    'blow_off_start':         'Blow off',
    'blow_off_stop':          'Blow off stop',
    'wait_blow_off':          'Wait for blow off',

    # ── Empty-draft fallback ─────────────────────────────────
    # When no operation resolves to steps (all-ambiguous intent),
    # the composer emits one wait step so the draft round-trips
    # through the program-list without a zero-step edge case.
    'empty_draft_placeholder': 'Empty draft — review ambiguities',
}


def _apply_iteration_suffix(base: str,
                            iter_index: Optional[int],
                            iter_count: Optional[int],
                            part_name: Optional[str]) -> str:
    """Uniform iteration suffix. `— {i+1} of {n}` when count > 1;
    `(<part>)` tag when a part name is supplied. Both suffixes
    are optional; nothing prints when the counts are None."""
    part_tag = f' ({part_name})' if part_name else ''
    if iter_count is None or iter_count <= 1 \
       or iter_index is None or iter_index < 0:
        return f'{base}{part_tag}' if part_tag else base
    return f'{base} — {iter_index + 1} of {iter_count}{part_tag}'


def label_for(role: str,
              *,
              part_name: Optional[str] = None,
              iter_index: Optional[int] = None,
              iter_count: Optional[int] = None,
              extra: Optional[str] = None) -> str:
    """Return the canonical label for a semantic step role.

    role       - one of the keys in LABEL_FOR_ROLE. Unknown roles
                 raise KeyError so a typo fails loudly at compose
                 time, not silently at runtime.
    part_name  - operator-spoken part name; filled into the
                 iteration suffix's `(<part>)` tag when present.
    iter_index / iter_count - iteration metadata for multi-cycle
                 programs; when count > 1 the label carries
                 `— i+1 of n`.
    extra      - a fixed-form qualifier for offset-derived steps
                 (e.g. "derived: +50mm Z"); appended in parens.
    """
    try:
        base = LABEL_FOR_ROLE[role]
    except KeyError as e:
        raise KeyError(
            f'label_for: unknown role {role!r}. Every composer '
            f'label goes through label_vocabulary.LABEL_FOR_ROLE '
            f'— add a template entry there rather than inlining.'
        ) from e
    out = _apply_iteration_suffix(base, iter_index, iter_count, part_name)
    if extra:
        out = f'{out} ({extra})'
    return out


def assert_action_emittable(action: str) -> None:
    """Post-emit assertion helper. Raises when the composer tries
    to produce an action outside COMPOSER_EMITTABLE_ACTIONS.
    Enforces the "detect impossible by construction" invariant."""
    if action not in COMPOSER_EMITTABLE_ACTIONS:
        raise AssertionError(
            f'label_vocabulary: action {action!r} is not in '
            f'COMPOSER_EMITTABLE_ACTIONS. The composer cannot '
            f'emit this action; add it to the positive list only '
            f'when the runtime code path exists. '
            f'(Directive: no camera-detection step until the '
            f'vision arc lands — detect must be impossible by '
            f'construction, not filtered at runtime.)')


def check_program_emissions(program: Dict[str, Any]) -> None:
    """Sweep every step in a composed program and assert both:
      (a) `action` ∈ COMPOSER_EMITTABLE_ACTIONS
      (b) `label` matches a known LABEL_FOR_ROLE template (base
          substring match after stripping iteration suffix + part
          tag + extra qualifier).

    Called by the composer after every compose_program_draft.
    """
    known_bases = set(LABEL_FOR_ROLE.values())
    for i, step in enumerate(program.get('steps') or []):
        action = step.get('action')
        assert_action_emittable(action)
        # Pallet-slot steps carry a `pallet_slot` dict identifying
        # row/col/layer and use pallet_geometry.slot_label() for
        # their human-readable label. The slot label varies per
        # slot and is canonical from a DIFFERENT single source
        # (pallet_geometry, itself registered in the fork
        # registry). Skip the vocabulary prefix check on those —
        # the slot identity is proven by the `pallet_slot` field,
        # not the label string.
        if step.get('pallet_slot') is not None:
            continue
        label = step.get('label') or ''
        # Every known base must appear as a prefix somewhere in the
        # emitted label. This lets iteration suffixes / part tags /
        # extra qualifiers ride the base without special-casing
        # each format in the assertion.
        if not any(label.startswith(base) for base in known_bases):
            raise AssertionError(
                f'label_vocabulary: step {i} action={action!r} '
                f'label={label!r} does not begin with any label '
                f'template in LABEL_FOR_ROLE. Route the label '
                f'through label_for(role, …) instead of inlining.'
            )

"""Convert a StructuredIntent into a ProgramDraft.

The composer is a faithful Python mirror of the wizard's buildSteps
templates (ProgramWizard.jsx) for the four supported operations
(pick_and_place, sort, machine_tend, palletize/depalletize). Each
step matches the SAME action/label/field shape the wizard produces so
a generated draft loads in the Program Library, opens in the Program
tab, and renders through the same step list components.

Critical invariant: NO METRIC POSES. Every move step that the wizard
would have taught coordinates for is annotated with:

    pose: null,
    pose_status: "awaiting_perception",
    location_hint: "<short text from intent>"

The frontend renders these as "awaiting perception" markers instead
of taught coordinates. The MotionCam recognition stack fills them in
later when the robot is present.
"""

from __future__ import annotations

import json as _json
from typing import Any, Dict, List, Optional, Tuple

from .schema import (
    AVAILABLE_OPERATIONS,
    IntentOperation,
    PalletSpec,
    POSE_AWAITING_PERCEPTION,
    PICK_PATTERN_INDIVIDUAL_TAUGHT,
    PICK_PATTERN_REPEAT_OFFSET,
    # PICK_PATTERN_VISION_EACH kept in schema but NOT imported here:
    # the composer refuses to emit detect steps (§determinism
    # directive, 2026-08-04). Vision-each intents compose as if
    # they were individual_taught — the intent shape survives, the
    # composer output stays runnable-without-vision.
    PLACE_PATTERN_FIXED,
    PLACE_PATTERN_STACK,
    PLACE_PATTERN_REPEAT_OFFSET,
    PLACE_PATTERN_PALLET,
    ProgramDraft,
    StructuredIntent,
)
from .label_vocabulary import (
    COMPOSER_EMITTABLE_ACTIONS,
    LABEL_FOR_ROLE,
    check_program_emissions,
    label_for,
)


# Composer-side defaults — applied only when the spoken intent didn't
# specify spacing / layer height. Match the wizard's defaults
# (buildPalletConfig in ProgramWizard.jsx) so a PBD-generated program
# and a wizard-built program with the same grid look identical to the
# executor and the PalletConfigEditor.
_DEFAULT_SPACING_MM = 150.0
_DEFAULT_LAYER_H_MM = 100.0
_DEFAULT_PALLET_APPROACH_MM = 100
_DEFAULT_PALLET_RETRACT_MM  = 200


# Silent defaults matching ProgramWizard.jsx — Balanced motion, 60% speed.
SILENT_SPEED_PCT = 60
SILENT_MOTION_PROFILE = 'Balanced'
DEFAULT_APPROACH_HEIGHT = 100
DEFAULT_GRIPPER_WIDTH   = 85
DEFAULT_GRIP_FORCE      = 50


# Program-name shape: keep it short and identifiable so the library
# view + program tabs stay scannable. Details belong in the description
# field, not the name.
_PROGRAM_NAME_MAX_WORDS = 4
_PROGRAM_NAME_MAX_CHARS = 30

# Human-readable operation tags for the "<Part> <Operation>" name
# format. Anything not in this map falls back to the raw op string
# with underscores replaced.
_OP_DISPLAY = {
    'pick_and_place': 'Pick & Place',
    'sort':           'Sort',
    'machine_tend':   'Machine Tend',
    'palletize':      'Palletize',
    'depalletize':    'Depalletize',
}


def _op_display_name(op_type: str) -> str:
    if op_type in _OP_DISPLAY:
        return _OP_DISPLAY[op_type]
    # Fallback: "some_new_op" → "Some New Op".
    return ' '.join(w.capitalize() for w in str(op_type or '').split('_') if w) or 'Task'


def _trim_to_budget(text: str, budget: int) -> str:
    """Trim `text` to at most `budget` chars, preferring a word
    boundary. Falls back to a hard slice if the first word alone
    exceeds the budget."""
    text = (text or '').strip()
    if len(text) <= budget:
        return text
    cut = text[:max(1, budget)].rstrip()
    # If the raw slice landed mid-word AND there's a prior space, drop
    # back to the last complete word.
    if ' ' in cut and not text[budget:budget + 1].isspace():
        cut = cut.rsplit(' ', 1)[0].rstrip()
    return cut


def _short_program_name(intent: StructuredIntent,
                        primary_op_type: str) -> Optional[str]:
    """Build a compact "<Part> <Operation>" program name from the
    intent — the library-list-friendly short form. Returns None when
    the intent doesn't carry enough signal (caller falls back to a
    demo-id name).

    Part chosen in priority order:
      1. First operation's target_part.name (library-matched name).
      2. First scene object's matched-library name.
      3. First scene object's raw label.
    Then paired with the operation's display name (e.g. "Pick & Place").

    The OPERATION half is kept intact — it carries the "what does this
    program do" signal. The PART half is trimmed to whatever fits the
    remaining char budget, respecting word boundaries where possible.
    That way "Extra Long Assembly" + "Palletize" becomes
    "Extra Long Palletize" rather than "Extra Long Assembly" (part
    without op) — the op tag is more useful than an extra part word."""
    part = ''
    ops = list(intent.operations or [])
    if ops:
        tp = ops[0].target_part
        if tp and tp.name and tp.name.strip() and tp.part_id != 'unknown':
            part = tp.name.strip()
    if not part:
        # Prefer scene objects with a library match; fall back to any
        # labeled scene object.
        matched = None
        raw = None
        for obj in (intent.scene.objects or []):
            if obj.matched_part_id and obj.label and not matched:
                matched = obj.label.strip()
            if obj.label and not raw:
                raw = obj.label.strip()
        part = matched or raw or ''
    if not part:
        return None
    op = _op_display_name(primary_op_type)
    # Reserve `len(op) + 1` chars for the op segment (plus the space).
    # If that leaves no room for even one char of part text (very long
    # op display), fall back to op-only.
    part_budget = _PROGRAM_NAME_MAX_CHARS - len(op) - 1
    if part_budget < 1:
        return _trim_to_budget(op, _PROGRAM_NAME_MAX_CHARS) or None
    part = _trim_to_budget(part, part_budget)
    name = f'{part} {op}'.strip() if part else op.strip()
    return name or None


# ── Step factories ─────────────────────────────────────────────────

def _dedupe_repeated_refs(steps: List[Dict[str, Any]]) -> None:
    """Post-pass: convert cross-op repeats of the same location_ref
    from taught contacts into derived_from_step_id references.

    The FIRST taught step for a given ref stays as the anchor. Every
    subsequent taught step carrying the same `location_ref` is
    rewritten to a derived-move shape: taught=False, no pose,
    derived_from_step_id=<first_anchor_id>, offset_z_mm=0. The codegen
    resolver in program_ops.py recognises `derived_from_step_id` and
    emits movJ to the anchor's already-registered varspoint (its
    FIX A path — identity offset → reuse anchor jp; no IK).

    In-place. Idempotent on repeat runs: a step that's already been
    converted to derived_from_step_id shape is skipped.
    """
    # Assign stable step ids so derived_from_step_id can point to them.
    # `id` was already used by _resolve_anchor_step for its explicit-
    # link path — reuse the same field.
    for i, s in enumerate(steps):
        if 'id' not in s:
            s['id'] = i + 1
    ref_to_anchor_id: Dict[str, int] = {}
    for s in steps:
        ref = s.get('location_ref')
        if not ref:
            continue
        # An ANCHOR for a ref is a contact step (position_role in
        # {'pick','place'}) that is NOT itself derived. `taught` is
        # False on every draft-shape step (poses come later from
        # perception) — that's not a signal we can use here.
        if s.get('position_role') not in ('pick', 'place'):
            continue
        if s.get('derived_from') or s.get('derived_from_step_id'):
            continue
        # Earliest step wins as the anchor for this ref.
        ref_to_anchor_id.setdefault(ref, s['id'])
    for s in steps:
        ref = s.get('location_ref')
        if not ref:
            continue
        anchor_id = ref_to_anchor_id.get(ref)
        if anchor_id is None or s['id'] == anchor_id:
            continue
        # Only rewrite contact-shaped steps (position_role pick/place)
        # that aren't already derived. Approach/retreat steps have
        # `derived_from` and don't need re-linking.
        if s.get('position_role') not in ('pick', 'place'):
            continue
        if s.get('derived_from') or s.get('derived_from_step_id'):
            continue
        # Convert this step into a derived repeat. Strip taught +
        # pose fields; add derived_from_step_id + offset_z_mm=0. The
        # label suffix notes the link so operators reading the review
        # see it. Iteration metadata (iter_index / iter_count /
        # iter_pattern) is preserved so the wizard grouping renderer
        # still knows this belongs to a multi-count operation.
        s['taught'] = False
        s['taught_joints'] = None
        s['taught_tcp'] = None
        s['pose'] = None
        s['pose_status'] = POSE_AWAITING_PERCEPTION
        s['derived_from_step_id'] = anchor_id
        s['offset_z_mm'] = 0
        old_label = s.get('label', '')
        if '(link →' not in old_label:
            s['label'] = f'{old_label} (link → step {anchor_id})' \
                if old_label else f'Repeat position (link → step {anchor_id})'


def _placeholder(role: str, hint: str) -> Dict[str, Any]:
    """Fields that mark a step's pose as awaiting perception."""
    return {
        'taught':        False,
        'taught_joints': None,
        'taught_tcp':    None,
        'pose':          None,
        'pose_status':   POSE_AWAITING_PERCEPTION,
        'position_role': role,
        'location_hint': hint or '',
    }


def _move_home(label: Optional[str] = None) -> Dict[str, Any]:
    """Home step. Default label is the canonical
    LABEL_FOR_ROLE['move_to_home']; pass label_for('return_to_home')
    when the step is at the END of a cycle to reach the
    "Return to home" variant. All labels flow through the
    vocabulary module (§determinism directive, 2026-08-04)."""
    return {
        'action': 'move_home',
        'label':  label or label_for('move_to_home'),
        **_placeholder('home', ''),
    }


# ── Pick/place: two-taught-poses-per-pair model ─────────────────────
#
# Only the CONTACT poses (pick + place) are taught. Everything else —
# approach, retreat, descend, lift — is DERIVED from those contact
# poses via {derived_from: <role>, offset_z_mm: <height>}, with the
# codegen resolver in estun_driver.program_ops applying the Z offset in
# the base frame. Derived steps carry no taught data of their own.
#
# The old model had a single taught step (labeled "Move above pick
# position") that combined "approach location" and "contact anchor"
# into one, with the descend step at offset_z_mm=0 producing a movJ
# back to the same taught pose. That model works but the taught-step
# label misleads operators and the descend-at-offset-0 is a no-op.

def _above(role: str, label: str, appH: int, spd: int) -> Dict[str, Any]:
    """Derived approach/retreat: base_z(taught) + appH, no taught data.
    Rendered read-only in the editor as `derived: above <role> (+Nmm Z)`
    and resolved by program_ops.codegen_lua_from_program at build time
    (movJCoorRel Δz relative in base frame). Same shape used for
    approach-before-pick, retreat-after-pick, approach-before-place,
    and retreat-after-place — the sequence-level meaning comes from
    the surrounding steps, not the shape."""
    return {
        'action':       'move_linear',
        'label':        label,
        'offset_z_mm':  int(appH),
        'speed_pct':    int(spd),
        'derived_from': role,
    }


def _contact(role: str, label: str, hint: str, spd: int) -> Dict[str, Any]:
    """Taught contact step — position_role marks it as the anchor for
    derived approach/retreat steps that share the same role. Applies
    to pick/place, but also to secondary roles like machine_load and
    unload for the machine-tending template."""
    return {
        'action':    'move_linear',
        'label':     label,
        'speed_pct': int(spd),
        **_placeholder(role, hint),
    }


def _pick_contact(hint: str, spd: int) -> Dict[str, Any]:
    return _contact('pick', 'Pick position — contact', hint, spd)


def _place_contact(hint: str, spd: int) -> Dict[str, Any]:
    return _contact('place', 'Place position — contact', hint, spd)


# _detect() factory RETIRED (§determinism directive, 2026-08-04). The
# composer is UNABLE to emit `detect` steps until the vision arc
# lands. `label_vocabulary.COMPOSER_EMITTABLE_ACTIONS` is the
# positive-list; `check_program_emissions` raises AssertionError at
# the end of every compose call if a detect step slips in. Vision-
# intent fields (operation.source == 'camera_library',
# pick_pattern == 'vision_each') still parse in the schema but the
# composer treats them as no-ops — the intent survives, the runnable
# artifact stays vision-free.


def _grip_open(spd: int) -> Dict[str, Any]:
    return {
        'action': 'open_gripper',
        'label':  label_for('open_gripper'),
        'width_mm':       DEFAULT_GRIPPER_WIDTH,
        'speed_pct':      int(spd),
        'io_open':        'DO1',
        'io_open_confirm': 'DI1',
    }


def _grip_close() -> Dict[str, Any]:
    return {
        'action': 'close_gripper',
        'label':  label_for('grip_part'),
        'force_pct':       DEFAULT_GRIP_FORCE,
        'io_close':        'DO0',
        'io_close_confirm': 'DI0',
    }


def _grip_release() -> Dict[str, Any]:
    return {
        'action': 'open_gripper',
        'label':  label_for('release_part'),
        'width_mm':  DEFAULT_GRIPPER_WIDTH,
        'io_open':   'DO1',
    }


# ── IO-map lookup for effector ports ──────────────────────────────
#
# The operator-editable io_map (dashboard I/O page → /opt/cobot/io_map
# .json) is the single source of truth for "which physical DO does
# 'Vacuum' refer to?". The composer reads it once per compose call so
# BOTH the Engage and Disengage vacuum steps land on the SAME port —
# re-mapping the port in the I/O page and recomposing updates both
# steps together. No two independent hardcoded references.

_IO_MAP_PATH = '/opt/cobot/io_map.json'
_VACUUM_DEFAULT_PORT   = 2   # DO2, matches the pre-effector wizard hardcode
_BLOWOFF_DEFAULT_PORT  = 3   # DO3, matches the pre-effector wizard hardcode
_MAGNET_DEFAULT_PORT   = 3


def _io_map_port_for(*keywords: str, kind: str = 'DO',
                     default_port: Optional[int] = None) -> Optional[int]:
    """Read /opt/cobot/io_map.json and return the port number whose
    assignment (case-insensitive) contains any of the given keywords.
    `kind` restricts the search to DO/DI/AI/AO channels. Falls back to
    `default_port` when the file is missing, malformed, or has no
    matching assignment.

    Reading at compose time (not at module import) lets an operator
    re-label the port on the I/O page and see the change reflected on
    the next Regenerate draft, no service restart required."""
    try:
        with open(_IO_MAP_PATH) as f:
            m = _json.load(f)
    except Exception:
        return default_port
    ports = (m.get('ports') or {}) if isinstance(m, dict) else {}
    kw = tuple(k.lower() for k in keywords)
    # Iterate the flattened terminal list to keep the "which port"
    # semantics stable regardless of block ordering.
    def _iter_signals():
        for block in (m.get('plate') or []):
            for t in (block.get('terminals') or []):
                if t and t.get('role') == 'signal': yield t
            for row in (block.get('pair_rows') or []):
                for c in row:
                    if isinstance(c, dict) and c.get('role') == 'signal': yield c
            for sec in (block.get('sections') or []):
                for row in (sec.get('rows') or []):
                    for c in row:
                        if isinstance(c, dict) and c.get('role') == 'signal': yield c
        flg = m.get('flange') or {}
        for t in (flg.get('terminals') or []):
            if t and t.get('role') == 'signal': yield t
    for t in _iter_signals():
        if (t.get('kind') or '').upper() != kind: continue
        name = t.get('name') or ''
        assign = ((ports.get(name) or {}).get('assignment') or '').lower().strip()
        # Skip the sentinel "Unassigned" so we don't match "vacuum"
        # against the placeholder label the io_map emits on unassigned
        # ports.
        if not assign or assign == 'unassigned': continue
        if any(k in assign for k in kw):
            p = t.get('port')
            if isinstance(p, int): return p
    return default_port


# ── Effector-aware step emitters ──────────────────────────────────
#
# Each per-pair pick/place body needs three moments where the
# effector actually acts:
#   * READY at the start of the program (make sure it's OFF / open)
#   * ENGAGE after arriving at the pick contact (grab the part)
#   * DISENGAGE after arriving at the place contact (release), with
#     the blow-off pulse for vacuum
# Every emitter below returns a LIST of steps so vacuum's multi-step
# pattern (set_io + wait + set_io) fits naturally alongside the
# finger single-step pattern. `_effector_of(op)` normalises legacy
# intents (missing field) back to 'finger'.

def _effector_of(op: IntentOperation) -> str:
    e = str(getattr(op, 'effector', '') or 'finger').lower()
    if e not in ('finger', 'vacuum', 'magnetic'):
        return 'finger'
    return e


def _effector_ready(op: IntentOperation, spd: int) -> List[Dict[str, Any]]:
    e = _effector_of(op)
    if e == 'vacuum':
        port = _io_map_port_for('vacuum', kind='DO',
                                default_port=_VACUUM_DEFAULT_PORT)
        return [{
            'action': 'set_io',
            'label':  'Vacuum off (ready)',
            'io_id':  f'DO{port}', 'value': 0,
            'io_role': 'vacuum',
        }]
    if e == 'magnetic':
        port = _io_map_port_for('magnet', 'gripper', kind='DO',
                                default_port=_MAGNET_DEFAULT_PORT)
        return [{
            'action': 'set_io',
            'label':  'Magnet off (ready)',
            'io_id':  f'DO{port}', 'value': 0,
            'io_role': 'magnet',
        }]
    return [_grip_open(spd)]


def _effector_engage(op: IntentOperation) -> List[Dict[str, Any]]:
    """Grip the part after the arm has reached the pick contact."""
    e = _effector_of(op)
    if e == 'vacuum':
        port = _io_map_port_for('vacuum', kind='DO',
                                default_port=_VACUUM_DEFAULT_PORT)
        return [
            {'action': 'set_io',
             'label':  'Engage vacuum',
             'io_id':  f'DO{port}', 'value': 1,
             'io_role': 'vacuum'},
            {'action': 'wait',
             'label':  'Wait for vacuum seal',
             'duration_s': 0.5},
        ]
    if e == 'magnetic':
        port = _io_map_port_for('magnet', 'gripper', kind='DO',
                                default_port=_MAGNET_DEFAULT_PORT)
        return [
            {'action': 'set_io',
             'label':  'Engage magnet',
             'io_id':  f'DO{port}', 'value': 1,
             'io_role': 'magnet'},
        ]
    return [_grip_close()]


def _effector_disengage(op: IntentOperation) -> List[Dict[str, Any]]:
    """Release the part after arriving at the place contact. Vacuum
    additionally fires the blow-off pulse (DO on → dwell → off) when
    a "Blow off" port is configured in the io_map (falls back to DO3
    for legacy wizard compatibility)."""
    e = _effector_of(op)
    if e == 'vacuum':
        vac_port = _io_map_port_for('vacuum', kind='DO',
                                    default_port=_VACUUM_DEFAULT_PORT)
        blow_port = _io_map_port_for('blow', kind='DO',
                                     default_port=_BLOWOFF_DEFAULT_PORT)
        out: List[Dict[str, Any]] = [
            {'action': 'set_io',
             'label':  'Disengage vacuum',
             'io_id':  f'DO{vac_port}', 'value': 0,
             'io_role': 'vacuum'},
        ]
        if blow_port is not None and blow_port != vac_port:
            out += [
                {'action': 'set_io',
                 'label':  'Blow off',
                 'io_id':  f'DO{blow_port}', 'value': 1,
                 'io_role': 'blow_off'},
                {'action': 'wait',
                 'label':  'Wait for blow off',
                 'duration_s': 0.3},
                {'action': 'set_io',
                 'label':  'Blow off stop',
                 'io_id':  f'DO{blow_port}', 'value': 0,
                 'io_role': 'blow_off'},
            ]
        return out
    if e == 'magnetic':
        port = _io_map_port_for('magnet', 'gripper', kind='DO',
                                default_port=_MAGNET_DEFAULT_PORT)
        return [
            {'action': 'set_io',
             'label':  'Disengage magnet',
             'io_id':  f'DO{port}', 'value': 0,
             'io_role': 'magnet'},
        ]
    return [_grip_release()]


# ── Per-operation builders ─────────────────────────────────────────
#
# Sequence per pick/place pair (approved 2026-07-23):
#   approach (derived, +appH)  → pick (taught, contact)
#     → grip_close → retreat (derived, +appH)
#     → approach-place (derived, +appH) → place (taught, contact)
#     → grip_release → retreat-place (derived, +appH)

def _build_pick_and_place(op: IntentOperation, appH: int,
                          spd: int, slow: int, medium: int) -> Tuple[List[Dict[str, Any]], List[List[int]]]:
    """Emit N pick/place iterations. count=1 → bit-identical to the
    pre-unroll shape (load-bearing back-compat guarantee). count>1 →
    the pair body is emitted N times, with iteration >0 poses derived
    per pick_pattern / place_pattern.

    Returns (steps, iter_ranges) where iter_ranges[i] = [start, end)
    within the returned steps slice for iteration i. iter_ranges is
    used by routine_detector.decorate_steps for the single-op
    multi-iteration routine case; it's empty when n<=1 since the
    routine detector doesn't group unit-count ops (§430).

    Role names stay 'pick' / 'place' across all iterations — the codegen
    nearest-anchor resolver (program_ops._resolve_anchor_step) picks the
    nearest anchor with taught data by index distance, so a flat
    multi-iteration sequence disambiguates naturally: each derived
    approach/retreat finds its OWN iteration's taught contact, not
    another iteration's."""
    n = max(1, int(getattr(op, 'count', 1) or 1))
    # 2026-08-06 §4 slot-to-cycle binding: when place_pattern is
    # 'pallet_place', the iteration count is FORCED to the spec's
    # rows*cols*layers so every slot gets its own unrolled iteration.
    # Compose-time expansion (not per-cycle regeneration) — matches the
    # multiplicity decision from the 2026-08-02 routine-detection work
    # and lets the codegen byte-diff invariant keep holding. Cycle N of
    # the run loop places at slot N by construction.
    if (getattr(op, 'place_pattern', PLACE_PATTERN_FIXED) == PLACE_PATTERN_PALLET
            and getattr(op, 'pallet_place', None) is not None):
        n = max(n, op.pallet_place.total_slots())
    s: List[Dict[str, Any]] = []
    s.extend(_effector_ready(op, spd))
    iter_ranges: List[List[int]] = []
    for i in range(n):
        _iter_start = len(s)
        _extend_one_pair(s, op, i, n, appH, spd, slow, medium)
        iter_ranges.append([_iter_start, len(s)])
    # Single-iteration ops don't need range tracking — the routine
    # detector treats count=1 as flat and decorate_steps writes
    # nothing.
    if n <= 1:
        iter_ranges = []
    return s, iter_ranges


def _iter_label(base: str, i: int, n: int, part_name: str) -> str:
    """`Pick 2 of 3 (bowl)` / `Pick position — contact` (n=1)."""
    if n <= 1:
        return base
    p = (part_name or '').strip()
    tag = f' ({p})' if p else ''
    # Human indexes from 1; suffix says which iteration + total.
    return f'{base} — {i + 1} of {n}{tag}'


def _extend_one_pair(steps: List[Dict[str, Any]],
                     op: IntentOperation,
                     i: int, n: int,
                     appH: int, spd: int, slow: int, medium: int) -> None:
    """One iteration's pick/place body. `i` is the 0-based iteration
    index, `n` the total count. For iteration 0 in a n=1 program the
    labels stay at the pre-unroll wording so the golden test's Lua
    output is unchanged."""
    part_name = op.target_part.name or ''
    pick_pattern  = getattr(op, 'pick_pattern',  PICK_PATTERN_INDIVIDUAL_TAUGHT)
    place_pattern = getattr(op, 'place_pattern', PLACE_PATTERN_FIXED)

    # Detect emission RETIRED — the composer does not emit `detect`
    # steps regardless of pick_pattern or op.source. The vision arc
    # is not wired end-to-end yet; a detect step in the output would
    # break the moment the runtime tries to execute it. Vision-
    # relevant intent fields still round-trip through the schema so
    # a future re-enable is one label_vocabulary entry away.

    # ── pick side ───────────────────────────────────────────────
    steps.append(_above('pick',
                        _iter_label('Approach above pick', i, n, part_name),
                        appH, spd))
    pick_step = _pick_contact(op.pick.location_hint, slow)
    pick_step['label'] = _iter_label('Pick position — contact', i, n, part_name)
    if n > 1:
        # Mark iteration index for the FE grouping renderer + learning
        # store. The wizard reads pattern/iter_index off of the step
        # (not off of the source intent) because programs can outlive
        # the intent they were composed from.
        pick_step['iter_index'] = i
        pick_step['iter_count'] = n
        pick_step['iter_pattern'] = pick_pattern
    if i > 0 and pick_pattern == PICK_PATTERN_REPEAT_OFFSET \
            and (op.pick_pitch_dx_mm or op.pick_pitch_dy_mm):
        # Encode the iteration offset on the STEP. Codegen for the
        # cartesian (dx/dy) form is not wired end-to-end yet (Z-only
        # `offset_z_mm` is supported today via _resolve_derived); the
        # composer emits the intent faithfully with `iter_offset_mm`
        # so the review layer can display it and a follow-up codegen
        # change can consume it without another schema round-trip.
        pick_step['taught'] = False
        pick_step['pose'] = None
        pick_step['pose_status'] = POSE_AWAITING_PERCEPTION
        pick_step['position_role'] = 'pick'   # keep resolver-friendly
        pick_step['derived_from'] = 'pick'
        pick_step['iter_offset_mm'] = {
            'dx': float(op.pick_pitch_dx_mm or 0.0) * i,
            'dy': float(op.pick_pitch_dy_mm or 0.0) * i,
            'dz': 0.0,
        }
        pick_step['label'] = (
            f'{_iter_label("Pick position", i, n, part_name)} '
            f'(derived: +{pick_step["iter_offset_mm"]["dx"]:g}mm X, '
            f'+{pick_step["iter_offset_mm"]["dy"]:g}mm Y)')
    steps.append(pick_step)
    steps.extend(_effector_engage(op))
    steps.append(_above('pick',
                        _iter_label('Retreat above pick', i, n, part_name),
                        appH, medium))

    # ── place side ──────────────────────────────────────────────
    steps.append(_above('place',
                        _iter_label('Approach above place', i, n, part_name),
                        appH, spd))
    if i > 0 and place_pattern == PLACE_PATTERN_STACK \
            and (op.place_stack_dz_mm or 0) > 0:
        # Stack: iteration i places at (place anchor + i·dz Z). The
        # existing offset_z_mm derived-step form handles this end-to-end
        # in codegen today — no new cartesian-offset support needed.
        # derived_from='place' + nearest-anchor resolver finds iter 0's
        # taught place; the +i·dz stacks each bowl on top of the
        # previous by construction.
        dz = float(op.place_stack_dz_mm or 0.0) * i
        stack_step = _above('place', '', appH, slow)
        stack_step['offset_z_mm'] = int(round(dz))
        stack_step['label'] = (
            f'{_iter_label("Place position", i, n, part_name)} '
            f'(stack: +{int(round(dz))}mm Z on iter 1)')
        stack_step['iter_index'] = i
        stack_step['iter_count'] = n
        stack_step['iter_pattern'] = place_pattern
        # Keep as derived move_linear — codegen already treats
        # derived_from='place' + offset_z_mm as a legal descend/lift.
        steps.append(stack_step)
    else:
        place_step = _place_contact(op.place.location_hint, slow)
        place_step['label'] = _iter_label(
            'Place position — contact', i, n, part_name)
        if n > 1:
            place_step['iter_index'] = i
            place_step['iter_count'] = n
            place_step['iter_pattern'] = place_pattern
        if i > 0 and place_pattern == PLACE_PATTERN_REPEAT_OFFSET \
                and (op.place_pitch_dx_mm or op.place_pitch_dy_mm):
            place_step['taught'] = False
            place_step['pose'] = None
            place_step['pose_status'] = POSE_AWAITING_PERCEPTION
            place_step['position_role'] = 'place'
            place_step['derived_from'] = 'place'
            place_step['iter_offset_mm'] = {
                'dx': float(op.place_pitch_dx_mm or 0.0) * i,
                'dy': float(op.place_pitch_dy_mm or 0.0) * i,
                'dz': 0.0,
            }
            place_step['label'] = (
                f'{_iter_label("Place position", i, n, part_name)} '
                f'(derived: +{place_step["iter_offset_mm"]["dx"]:g}mm X, '
                f'+{place_step["iter_offset_mm"]["dy"]:g}mm Y)')
        elif place_pattern == PLACE_PATTERN_PALLET \
                and getattr(op, 'pallet_place', None) is not None:
            # 2026-08-06 §1 pallet_place — iteration i's slot pose is
            # (anchor + slot_offsets[i]). Iteration 0 is the taught
            # anchor (position_role='place'); iterations 1..N-1 are
            # derived move_linear steps carrying iter_offset_mm the
            # codegen resolves via the same nearest-anchor route the
            # STACK / REPEAT_OFFSET patterns use.
            from .pallet_geometry import compute_slot_offsets, slot_label
            slots = compute_slot_offsets(op.pallet_place)
            (r, c, l), (dx, dy, dz) = slots[i] if i < len(slots) else slots[-1]
            place_step['iter_index'] = i
            place_step['iter_count'] = n
            place_step['iter_pattern'] = PLACE_PATTERN_PALLET
            # Attach a per-step pallet_slot identity — the review UI
            # collapses these into one "Place on pallet — N slots"
            # header using this field; the 3D twin's ghost markers
            # key off it too.
            place_step['pallet_slot'] = {
                'index': i, 'row': r, 'col': c, 'layer': l,
                'label': slot_label(r, c, l, op.pallet_place.layers),
            }
            if i == 0:
                # Anchor: keep as a taught contact (no derived_from).
                place_step['label'] = (
                    f'Pallet corner — teach at first slot '
                    f'({slot_label(r, c, l, op.pallet_place.layers)}, '
                    f'part compressed)')
            else:
                place_step['taught'] = False
                place_step['pose'] = None
                place_step['pose_status'] = POSE_AWAITING_PERCEPTION
                place_step['position_role'] = 'place'
                place_step['derived_from'] = 'place'
                place_step['iter_offset_mm'] = {
                    'dx': float(dx), 'dy': float(dy), 'dz': float(dz),
                }
                place_step['label'] = (
                    f'{slot_label(r, c, l, op.pallet_place.layers)} '
                    f'(derived: +{dx:g}mm X, +{dy:g}mm Y, +{dz:g}mm Z '
                    f'from pallet corner)')
        steps.append(place_step)

    steps.extend(_effector_disengage(op))
    steps.append(_above('place',
                        _iter_label('Retreat above place', i, n, part_name),
                        appH, medium))


def _build_sort(op: IntentOperation, appH: int,
                spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    """Sort = pick + place-by-type. Same body as pick_and_place; the
    place-contact step gets a `sort_bin_hint` from the intent's place
    location for the operator to verify later."""
    s, _iter_ranges = _build_pick_and_place(op, appH, spd, slow, medium)
    for step in s:
        if step.get('position_role') == 'place':
            step['sort_bin_hint'] = op.place.location_hint
    return s


def _build_machine_tend(op: IntentOperation, appH: int,
                        spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    s: List[Dict[str, Any]] = []
    s.extend(_effector_ready(op, spd))
    # Detect emission RETIRED — see _build_pick_and_place.
    s.append(_above('pick', 'Approach above pick', appH, spd))
    s.append(_pick_contact(op.pick.location_hint, slow))
    s.extend(_effector_engage(op))
    s.append(_above('pick', 'Retreat above pick',  appH, medium))
    # Machine-load contact — the taught anchor for the machine-load
    # role. Approach/retreat steps around it derive from this pose
    # + appH, matching the pick/place two-taught-poses model.
    s.append(_above('machine_load', 'Approach machine load', appH, spd))
    s.append(_contact('machine_load', 'Machine load — contact',
                      op.place.location_hint or 'machine load fixture',
                      min(spd, 20)))
    s.extend(_effector_disengage(op))
    s.append(_above('machine_load', 'Retreat from machine load', appH, slow))
    s.append({'action': 'set_io', 'label': label_for('start_machine_cycle'),
              'io_id': 'DO4', 'value': 1})
    s.append({'action': 'wait', 'label': label_for('wait_machine_finish'),
              'duration_s': 30})
    s.append({'action': 'set_io', 'label': label_for('clear_cycle_start'),
              'io_id': 'DO4', 'value': 0})
    # Re-approach the same machine_load anchor to pick up the
    # finished part — reuses the SAME taught contact pose.
    s.append(_above('machine_load', 'Approach finished part', appH, slow))
    s.extend(_effector_engage(op))
    s.append(_above('machine_load', 'Retreat with finished part', appH, medium))
    # Unload contact — separate taught role.
    s.append(_above('unload', 'Approach unload', appH, spd))
    s.append(_contact('unload', 'Unload position — contact',
                      'unload location', slow))
    s.extend(_effector_disengage(op))
    s.append(_above('unload', 'Retreat from unload', appH, medium))
    return s


def _build_palletize(op: IntentOperation, mode: str,
                     appH: int, spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    """Palletize / depalletize use move_to_pallet which the executor
    expands at runtime — pallet geometry is in config.pallet, not in
    individual steps. The taught end of the pair (pick for palletize,
    place for depalletize) still follows the two-taught-poses model:
    approach (derived) → contact (taught) → retreat (derived). The
    pallet end is executor-computed and untouched here."""
    s: List[Dict[str, Any]] = []
    s.append(_move_home())
    # Retract clearance for pallet moves is larger than the standard
    # appH — reuses the existing 200 mm literal from the pre-change
    # composer so pallet programs keep the same clearance envelope.
    palletH = 200
    # 2026-08-06 (finalize palletize subroutine, operator directive):
    # vacuum + blow-off ports read from the io_map once and stamped
    # onto move_to_pallet so codegen doesn't fork port meanings.
    # Absent io_map entries fall back to composer defaults.
    _eff_type   = _effector_of(op)
    _vac_port   = _io_map_port_for('vacuum', kind='DO',
                                   default_port=_VACUUM_DEFAULT_PORT)
    _blow_port  = _io_map_port_for('blow', kind='DO',
                                   default_port=None)
    _pallet_io_block: Dict[str, Any] = {
        'gripper_type':       _eff_type,
        'vacuum_port_do':     _vac_port,
        'blow_off_port_do':   _blow_port,   # None → no pulse
        'blow_off_pulse_ms':  300,
        'safety_margin_mm':   50,
        'seal_wait_ms':       500,
        # Legacy fingers-only fields retained so old codegens (and
        # depalletize's non-vacuum path) still find `io_open` /
        # `io_close`. New codegen prefers vacuum_port_do.
        'io_open':            'DO1',
        'io_close':           'DO0',
    }
    if mode == 'palletize':
        # Under the 2026-08-06 finalize spec, the palletize cycle
        # is a single self-contained loop emitted INSIDE the codegen
        # expansion. The composer now stakes ONLY the taught pick
        # pose (position_role='pick') so the operator can teach it;
        # the surrounding motion (approach descent, vacuum ON, seal
        # wait, transit lift, retreat) is emitted per cycle by the
        # codegen with dynamic transit heights. This eliminates the
        # pre-fix "1 vacuum-ON + N releases" I/O pairing bug and
        # lets transit_Z rise per layer.
        s.append(_pick_contact(op.pick.location_hint, slow))
        s.append({
            'action': 'move_to_pallet',
            'mode':   'palletize',
            'label':  label_for('pallet_place'),
            'pallet_phase': 'place',
            'speed_pct': slow,
            **_pallet_io_block,
            **_placeholder('place', op.place.location_hint),
        })
    else:
        s.append({
            'action': 'move_to_pallet',
            'mode':   'depalletize',
            'label':  label_for('pallet_pick'),
            'pallet_phase': 'pick',
            'speed_pct': slow,
            **_pallet_io_block,
            **_placeholder('pick', op.pick.location_hint),
        })
        s.append(_above('place', 'Approach above place', palletH, spd))
        s.append(_place_contact(op.place.location_hint, slow))
        s.extend(_effector_disengage(op))
        s.append(_above('place', 'Retreat above place', palletH, medium))
    s.append(_move_home(label=label_for('return_to_home')))
    return s


# ── Pallet config builder ──────────────────────────────────────────

def _build_pallet_config(spec: Optional[PalletSpec], mode: str) -> Dict[str, Any]:
    """Materialise the program.config.pallet block from the (possibly
    None) intent PalletSpec. Mirrors the shape produced by the wizard's
    buildPalletConfig so the same PalletConfigEditor renders both.

    None spec → (1,1,1) single slot. This is the load-bearing default:
    the executor uses rows*cols*layers as its cycle budget, so dropping
    the spec must never silently inflate to a multi-cell grid.
    """
    s = spec or PalletSpec()
    return {
        'rows':                int(s.rows or 1),
        'cols':                int(s.cols or 1),
        'layers':              int(s.layers or 1),
        'spacing_x_mm':        float(s.spacing_x_mm if s.spacing_x_mm is not None
                                     else _DEFAULT_SPACING_MM),
        'spacing_y_mm':        float(s.spacing_y_mm if s.spacing_y_mm is not None
                                     else _DEFAULT_SPACING_MM),
        'layer_height_mm':     float(s.layer_height_mm if s.layer_height_mm is not None
                                     else _DEFAULT_LAYER_H_MM),
        'fill_order':          s.fill_order or 'row_lr',
        # corner_tcp is taught by the operator after the draft loads.
        # Stub a zero corner so the executor's _compute_pallet_position
        # can index without KeyError when the program is dry-run pre-
        # teach (slot positions will read as the corner origin until
        # the operator records the corner).
        'corner_tcp':          {'x': 0, 'y': 0, 'z': 0, 'rx': 0, 'ry': 0, 'rz': 0},
        'approach_height_mm':  _DEFAULT_PALLET_APPROACH_MM,
        'retract_height_mm':   _DEFAULT_PALLET_RETRACT_MM,
    }


# ── Composer ────────────────────────────────────────────────────────

def compose_program_draft(intent: StructuredIntent,
                          demo_id: str,
                          program_name: Optional[str] = None) -> ProgramDraft:
    """Build a ProgramDraft from a StructuredIntent. The composer is
    deterministic — given the same intent it produces the same draft.

    If the intent has zero usable operations, we still emit a minimal
    program (just a move_home) so the artifact LOADS in the library
    and the human can see what the AI flagged in ambiguities. Better
    than dropping the demonstration on the floor."""
    appH   = DEFAULT_APPROACH_HEIGHT
    spd    = SILENT_SPEED_PCT
    slow   = min(spd, 30)
    medium = min(spd, 40)

    sorted_ops = sorted(
        list(intent.operations or []),
        key=lambda o: o.sequence_index if o.sequence_index else 0,
    )

    primary_op_type = (sorted_ops[0].operation_type if sorted_ops else 'pick_and_place')
    if primary_op_type not in AVAILABLE_OPERATIONS:
        primary_op_type = 'pick_and_place'

    # Name resolution order:
    #   1. Caller-supplied `program_name` (external override — respected
    #      verbatim but capped by the free-form guard below).
    #   2. `_short_program_name(intent, primary_op_type)` — deterministic
    #      "<Part> <Operation>" from the library-matched part + op type.
    #      Already char-trimmed to _PROGRAM_NAME_MAX_CHARS internally so
    #      the "<Part> <Op>" pattern survives whole (the free-form
    #      word-cap does NOT apply on this path).
    #   3. task_summary (legacy fallback) — trimmed by the guard.
    #   4. `demo <id>` when the intent carries no signal at all.
    # The full descriptive task_summary is still preserved elsewhere
    # (metadata index, description field) — this constraint is about
    # the LIBRARY-LIST NAME being scannable, not throwing away detail.
    if program_name and str(program_name).strip():
        # Free-form guard on external input — cap words + chars.
        candidate = str(program_name).strip()
        words = candidate.split()
        if len(words) > _PROGRAM_NAME_MAX_WORDS:
            candidate = ' '.join(words[:_PROGRAM_NAME_MAX_WORDS])
        name = _trim_to_budget(candidate, _PROGRAM_NAME_MAX_CHARS) or candidate
    else:
        short = _short_program_name(intent, primary_op_type)
        if short:
            name = short
        else:
            candidate = (intent.task_summary if intent.task_summary
                         else f'demo {demo_id}').strip() or f'demo {demo_id}'
            words = candidate.split()
            if len(words) > _PROGRAM_NAME_MAX_WORDS:
                candidate = ' '.join(words[:_PROGRAM_NAME_MAX_WORDS])
            name = _trim_to_budget(candidate, _PROGRAM_NAME_MAX_CHARS) or f'demo {demo_id}'

    steps: List[Dict[str, Any]] = []
    steps.append(_move_home())

    # Captured during the loop below so it can be written into
    # config.pallet after step composition. None for non-pallet
    # programs.
    pallet_op_mode: Optional[str] = None
    pallet_spec: Optional[PalletSpec] = None

    # Stamp each op's location refs on the steps it produces so the
    # cross-op dedupe pass below can identify same-position taught
    # contacts.  Marker is a per-op (op_index, slot) tuple that gets
    # baked into the step dict as `location_ref` when the operation's
    # slot has one (fusion.fuse_positions populates these).
    def _tag_ops_steps(ops_steps: List[Dict[str, Any]],
                       op: IntentOperation,
                       op_index: int) -> List[Dict[str, Any]]:
        """Stamp location_ref onto the pick/place-role steps built
        for one op.  Approach/retreat derived steps inherit their
        anchor's ref through the resolver — no need to tag them
        here."""
        for s in ops_steps:
            role = s.get('position_role')
            if role == 'pick' and op.pick.location_ref:
                s['location_ref'] = op.pick.location_ref
            elif role == 'place' and op.place.location_ref:
                s['location_ref'] = op.place.location_ref
        return ops_steps

    # 2026-08-02 §1 — per-op step ranges for the routine detector.
    # Recorded as `steps` grows so decorate_steps knows exactly
    # which slice of the flat step list belongs to each source op.
    op_step_ranges: List[tuple] = []
    # 2026-07-30 §430 — for single-op multi-iter routines, we also
    # need per-iteration ranges INSIDE the op's slice so
    # decorate_steps can stamp routine_iteration per iteration.
    # Only pick_and_place expansion produces multi-iter shape today
    # (sort/machine_tend inherit the same builder; palletize is a
    # single-op single-slice shape by design). Keyed by op_index.
    op_iter_ranges: Dict[int, List[List[int]]] = {}

    for op_index, op in enumerate(sorted_ops):
        _start = len(steps)
        if op.operation_type == 'pick_and_place':
            _pnp_steps, _pnp_iters = _build_pick_and_place(op, appH, spd, slow, medium)
            steps.extend(_tag_ops_steps(_pnp_steps, op, op_index))
            if _pnp_iters:
                # Shift the iter_ranges (which are relative to the
                # op-local slice) into absolute step-list coordinates.
                op_iter_ranges[op_index] = [
                    [_start + a, _start + b] for (a, b) in _pnp_iters
                ]
        elif op.operation_type == 'sort':
            steps.extend(_tag_ops_steps(
                _build_sort(op, appH, spd, slow, medium), op, op_index))
        elif op.operation_type == 'machine_tend':
            steps.extend(_tag_ops_steps(
                _build_machine_tend(op, appH, spd, slow, medium),
                op, op_index))
        elif op.operation_type == 'palletize':
            steps = _build_palletize(op, 'palletize', appH, spd, slow, medium)
            primary_op_type = 'palletize'
            pallet_op_mode = 'palletize'
            pallet_spec = op.pallet
            op_step_ranges = [(0, len(steps))]
            break        # pallet programs are single-op by design
        elif op.operation_type == 'depalletize':
            steps = _build_palletize(op, 'depalletize', appH, spd, slow, medium)
            primary_op_type = 'palletize'
            pallet_op_mode = 'depalletize'
            pallet_spec = op.pallet
            op_step_ranges = [(0, len(steps))]
            break
        op_step_ranges.append((_start, len(steps)))

    if not sorted_ops:
        # Nothing to do — still emit a loadable artifact.
        steps.append({'action': 'wait', 'label': 'Empty draft — review ambiguities',
                      'duration_s': 0})

    if primary_op_type != 'palletize':
        steps.append(_move_home(label='Return to home'))

    # 2026-08-01 §4: one location_ref = one program position. When
    # two operations share a resolved location (fusion said SAME),
    # the SECOND op's taught contact for that ref becomes a
    # derived_from_step_id repeat with offset_z_mm=0 — codegen's
    # FIX A (identity offset → movJ reuse) then emits movJ back to
    # the first anchor point. Teach-once propagates.
    #
    # Emissions from ops WITHOUT a resolved location_ref (legacy
    # intents where fusion never ran) are left untouched — they
    # keep the per-op position_role='pick'|'place' shape and the
    # existing per-op resolver.
    _dedupe_repeated_refs(steps)

    # 2026-08-05 OPERATOR DIRECTIVE (home unification): multiple
    # move_home steps in a single program share ONE taught pose.
    # Every move_home AFTER the first inherits from the first via
    # `derived_from: 'home'`, so the backend's pending-pose check
    # (check_program_pending_poses rule c — resolves against
    # role_map['home']) treats them as satisfied when the FIRST
    # home is taught. The operator therefore teaches home ONCE.
    #
    # The frontend's isTeachable rule already hides the Teach button
    # on later move_home steps (programTruth.js); this fix aligns
    # the DATA model so backend + frontend + record path agree
    # instead of just the surface.
    #
    # Override path preserved: `step.overridden === True` lets an
    # operator break the share and teach an independent second
    # home. Backend rule (b) will still resolve that case via the
    # step's own taught_joints.
    _first_home_idx = None
    for _i, _s in enumerate(steps):
        if _s and str(_s.get('action') or '').lower() == 'move_home':
            if _first_home_idx is None:
                _first_home_idx = _i
                continue
            # Every subsequent move_home links to the first. Match
            # the composer's invariant for derived steps: no pose
            # data of their own (position_role, taught_joints,
            # taught_tcp, taught, pose all cleared) — the resolver
            # + role_map covers all reads. This is what
            # test_derived_steps_never_carry_taught_data pins.
            _s['derived_from'] = 'home'
            for _k in ('position_role', 'taught_joints', 'taught_tcp',
                       'pose', 'pose_status'):
                _s.pop(_k, None)
            _s['taught'] = False   # kept explicit for legacy readers

    # 2026-08-02 §1 — routine detection over the operation list.
    # Consecutive ops with identical signatures collapse into a
    # single Routine (representation only; steps stay unrolled).
    # Codegen ignores routines[] entirely; the pinned test
    # test_routine_grouped_lua_bytediff proves emitted Lua matches.
    from .routine_detector import decorate_steps, detect_routines
    routines = detect_routines(intent)
    decorate_steps(steps, routines, op_step_ranges,
                   op_iter_ranges=op_iter_ranges)

    numbered = [{**s, 'step': i + 1} for i, s in enumerate(steps)]

    # Positive-list assertion (§determinism directive, 2026-08-04).
    # Every emitted step MUST use an action in
    # COMPOSER_EMITTABLE_ACTIONS and a label whose base string
    # appears in LABEL_FOR_ROLE. Any regression that introduces a
    # `detect` step, an inline literal label, or a new action
    # without a vocabulary entry fails HERE — not silently on the
    # wire.
    check_program_emissions({'steps': numbered})

    # Description reflects the ACTUAL state of the draft. The
    # "poses pending perception" caveat is included only while the
    # poses truly are placeholders (which is always true at compose
    # time — real joint values arrive when the operator teaches them
    # in the wizard's review step, and dashboard_server strips this
    # sentence on read once _has_taught_poses returns True). Provenance
    # itself lives in the top-level `source` field on the saved
    # program (see /api/pbd/{demo_id}/correct), not in the description.
    desc_lines = [
        'PBD draft — poses pending perception.',
    ]
    if intent.task_summary:
        desc_lines.append(intent.task_summary)
    if intent.ambiguities:
        desc_lines.append(f'{len(intent.ambiguities)} ambiguity/ambiguities flagged for review.')

    parts_seen = sorted({op.target_part.part_id for op in sorted_ops
                         if op.target_part and op.target_part.part_id and op.target_part.part_id != 'unknown'})
    ops_seen = sorted({op.operation_type for op in sorted_ops})

    pbd_metadata = {
        'source':         'programming_by_demonstration',
        'demo_id':        demo_id,
        'primary_operation': primary_op_type,
        'part_ids':       parts_seen,
        'operations':     ops_seen,
        'task_summary':   intent.task_summary,
        # Serialise each Clarification to a plain dict — pbd_metadata
        # is JSON-dumped by learning_store.save_draft, which can't
        # handle dataclass instances directly.
        'ambiguities':    [c.to_dict() if hasattr(c, 'to_dict') else c
                           for c in (intent.ambiguities or [])],
        'confidence':     float(intent.confidence_overall or 0.0),
        'backend_id':     intent.backend_id,
        'transited_externally': bool(intent.transited_externally),
        'pose_status':    POSE_AWAITING_PERCEPTION,
    }

    config = {
        'draft':                True,
        'speed':                SILENT_SPEED_PCT,
        'speed_pct':            SILENT_SPEED_PCT,
        'motion_profile_name':  SILENT_MOTION_PROFILE,
        'operation':            primary_op_type,
        'approach_height':      DEFAULT_APPROACH_HEIGHT,
        'gripper': {
            'type':     'finger',
            'width_mm': DEFAULT_GRIPPER_WIDTH,
            'force_pct': DEFAULT_GRIP_FORCE,
        },
        'pbd_metadata': pbd_metadata,
    }

    # Pallet programs: bake the spoken grid into config.pallet so the
    # executor's move_to_pallet expansion (which reads
    # config.pallet.{rows,cols,layers,...}) uses the operator's pattern
    # — not a hard-coded default. Also surfaces in the
    # PalletConfigEditor (which pre-fills from config.pallet).
    if pallet_op_mode is not None:
        config['pallet']      = _build_pallet_config(pallet_spec, pallet_op_mode)
        config['pallet_mode'] = pallet_op_mode

    return ProgramDraft(
        name=name,
        description='  '.join(desc_lines),
        steps=numbered,
        config=config,
        tags=[primary_op_type],
        pbd_metadata=pbd_metadata,
        routines=routines,
    )

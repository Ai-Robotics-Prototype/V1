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

from typing import Any, Dict, List, Optional

from .schema import (
    AVAILABLE_OPERATIONS,
    IntentOperation,
    PalletSpec,
    POSE_AWAITING_PERCEPTION,
    ProgramDraft,
    StructuredIntent,
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


def _move_home(label: str = 'Move to home position') -> Dict[str, Any]:
    return {
        'action': 'move_home',
        'label':  label,
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


def _detect(part_name: str) -> Dict[str, Any]:
    return {
        'action': 'detect',
        'label':  f'Find {part_name or "library part"}',
        'mode':   'library',
    }


def _grip_open(spd: int) -> Dict[str, Any]:
    return {
        'action': 'open_gripper',
        'label':  'Open gripper',
        'width_mm':       DEFAULT_GRIPPER_WIDTH,
        'speed_pct':      int(spd),
        'io_open':        'DO1',
        'io_open_confirm': 'DI1',
    }


def _grip_close() -> Dict[str, Any]:
    return {
        'action': 'close_gripper',
        'label':  'Grip part',
        'force_pct':       DEFAULT_GRIP_FORCE,
        'io_close':        'DO0',
        'io_close_confirm': 'DI0',
    }


def _grip_release() -> Dict[str, Any]:
    return {
        'action': 'open_gripper',
        'label':  'Release part',
        'width_mm':  DEFAULT_GRIPPER_WIDTH,
        'io_open':   'DO1',
    }


# ── Per-operation builders ─────────────────────────────────────────
#
# Sequence per pick/place pair (approved 2026-07-23):
#   approach (derived, +appH)  → pick (taught, contact)
#     → grip_close → retreat (derived, +appH)
#     → approach-place (derived, +appH) → place (taught, contact)
#     → grip_release → retreat-place (derived, +appH)

def _build_pick_and_place(op: IntentOperation, appH: int,
                          spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    s: List[Dict[str, Any]] = []
    s.append(_grip_open(spd))
    # Detect step is gated on how the part is located each cycle. When
    # the operator confirms a fixed taught position (op.source ==
    # 'fixed_position'), the pick pose comes straight from the taught
    # contact step below — vision-driven `detect` would be busy work
    # that just adds latency and a false failure mode when the part
    # isn't at exactly the recognised orientation. Default source is
    # 'camera_library' so intents that don't set this field keep the
    # detect step (matches the composer's pre-change behaviour).
    if op.source == 'camera_library':
        s.append(_detect(op.target_part.name))
    s.append(_above('pick',  'Approach above pick',  appH, spd))
    s.append(_pick_contact(op.pick.location_hint, slow))
    s.append(_grip_close())
    s.append(_above('pick',  'Retreat above pick',   appH, medium))
    s.append(_above('place', 'Approach above place', appH, spd))
    s.append(_place_contact(op.place.location_hint, slow))
    s.append(_grip_release())
    s.append(_above('place', 'Retreat above place',  appH, medium))
    return s


def _build_sort(op: IntentOperation, appH: int,
                spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    """Sort = pick + place-by-type. Same body as pick_and_place; the
    place-contact step gets a `sort_bin_hint` from the intent's place
    location for the operator to verify later."""
    s = _build_pick_and_place(op, appH, spd, slow, medium)
    for step in s:
        if step.get('position_role') == 'place':
            step['sort_bin_hint'] = op.place.location_hint
    return s


def _build_machine_tend(op: IntentOperation, appH: int,
                        spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    s: List[Dict[str, Any]] = []
    s.append(_grip_open(spd))
    # See _build_pick_and_place — detect gated on op.source.
    if op.source == 'camera_library':
        s.append(_detect(op.target_part.name))
    s.append(_above('pick', 'Approach above pick', appH, spd))
    s.append(_pick_contact(op.pick.location_hint, slow))
    s.append(_grip_close())
    s.append(_above('pick', 'Retreat above pick',  appH, medium))
    # Machine-load contact — the taught anchor for the machine-load
    # role. Approach/retreat steps around it derive from this pose
    # + appH, matching the pick/place two-taught-poses model.
    s.append(_above('machine_load', 'Approach machine load', appH, spd))
    s.append(_contact('machine_load', 'Machine load — contact',
                      op.place.location_hint or 'machine load fixture',
                      min(spd, 20)))
    s.append(_grip_release())
    s.append(_above('machine_load', 'Retreat from machine load', appH, slow))
    s.append({'action': 'set_io', 'label': 'Start machine cycle',
              'io_id': 'DO4', 'value': 1})
    s.append({'action': 'wait', 'label': 'Wait for machine to finish',
              'duration_s': 30})
    s.append({'action': 'set_io', 'label': 'Clear cycle start',
              'io_id': 'DO4', 'value': 0})
    # Re-approach the same machine_load anchor to pick up the
    # finished part — reuses the SAME taught contact pose.
    s.append(_above('machine_load', 'Approach finished part', appH, slow))
    s.append({'action': 'close_gripper', 'label': 'Grip finished part',
              'force_pct': DEFAULT_GRIP_FORCE, 'io_close': 'DO0'})
    s.append(_above('machine_load', 'Retreat with finished part', appH, medium))
    # Unload contact — separate taught role.
    s.append(_above('unload', 'Approach unload', appH, spd))
    s.append(_contact('unload', 'Unload position — contact',
                      'unload location', slow))
    s.append(_grip_release())
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
    if mode == 'palletize':
        # See _build_pick_and_place — detect gated on op.source.
        if op.source == 'camera_library':
            s.append(_detect(op.target_part.name))
        s.append(_above('pick', 'Approach above pick', appH, spd))
        s.append(_pick_contact(op.pick.location_hint, slow))
        s.append(_grip_close())
        s.append(_above('pick', 'Retreat above pick', palletH, medium))
        s.append({
            'action': 'move_to_pallet',
            'mode':   'palletize',
            'label':  'Place at pallet slot [computed at runtime]',
            'pallet_phase': 'place',
            'gripper_type': 'finger',
            'io_open': 'DO1', 'io_close': 'DO0',
            'speed_pct': slow,
            **_placeholder('place', op.place.location_hint),
        })
    else:
        s.append({
            'action': 'move_to_pallet',
            'mode':   'depalletize',
            'label':  'Pick from pallet slot [computed at runtime]',
            'pallet_phase': 'pick',
            'gripper_type': 'finger',
            'io_open': 'DO1', 'io_close': 'DO0',
            'speed_pct': slow,
            **_placeholder('pick', op.pick.location_hint),
        })
        s.append(_above('place', 'Approach above place', palletH, spd))
        s.append(_place_contact(op.place.location_hint, slow))
        s.append(_grip_release())
        s.append(_above('place', 'Retreat above place', palletH, medium))
    s.append(_move_home(label='Return to home'))
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

    for op in sorted_ops:
        if op.operation_type == 'pick_and_place':
            steps.extend(_build_pick_and_place(op, appH, spd, slow, medium))
        elif op.operation_type == 'sort':
            steps.extend(_build_sort(op, appH, spd, slow, medium))
        elif op.operation_type == 'machine_tend':
            steps.extend(_build_machine_tend(op, appH, spd, slow, medium))
        elif op.operation_type == 'palletize':
            steps = _build_palletize(op, 'palletize', appH, spd, slow, medium)
            primary_op_type = 'palletize'
            pallet_op_mode = 'palletize'
            pallet_spec = op.pallet
            break        # pallet programs are single-op by design
        elif op.operation_type == 'depalletize':
            steps = _build_palletize(op, 'depalletize', appH, spd, slow, medium)
            primary_op_type = 'palletize'
            pallet_op_mode = 'depalletize'
            pallet_spec = op.pallet
            break

    if not sorted_ops:
        # Nothing to do — still emit a loadable artifact.
        steps.append({'action': 'wait', 'label': 'Empty draft — review ambiguities',
                      'duration_s': 0})

    if primary_op_type != 'palletize':
        steps.append(_move_home(label='Return to home'))

    numbered = [{**s, 'step': i + 1} for i, s in enumerate(steps)]

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
    )

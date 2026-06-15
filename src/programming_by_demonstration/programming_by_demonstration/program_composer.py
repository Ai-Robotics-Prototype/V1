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
    POSE_AWAITING_PERCEPTION,
    ProgramDraft,
    StructuredIntent,
)


# Silent defaults matching ProgramWizard.jsx — Balanced motion, 60% speed.
SILENT_SPEED_PCT = 60
SILENT_MOTION_PROFILE = 'Balanced'
DEFAULT_APPROACH_HEIGHT = 100
DEFAULT_GRIPPER_WIDTH   = 85
DEFAULT_GRIP_FORCE      = 50


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


def _approach(hint: str, appH: int, spd: int) -> Dict[str, Any]:
    return {
        'action': 'approach',
        'label':  'Move above pick position',
        'target':       'auto',
        'offset_z_mm':  int(appH),
        'speed_pct':    int(spd),
        **_placeholder('pick', hint),
    }


def _descend(role: str, label: str, spd: int,
             derived_from: str) -> Dict[str, Any]:
    return {
        'action': 'move_linear',
        'label':  label,
        'offset_z_mm':  0,
        'speed_pct':    int(spd),
        'derived_from': derived_from,
        **_placeholder(role, ''),
    }


def _lift(role: str, label: str, offset_mm: int, spd: int,
          derived_from: str) -> Dict[str, Any]:
    return {
        'action': 'move_linear',
        'label':  label,
        'offset_z_mm':  int(offset_mm),
        'speed_pct':    int(spd),
        'derived_from': derived_from,
        **_placeholder(role, ''),
    }


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


def _place_above(hint: str, spd: int) -> Dict[str, Any]:
    return {
        'action': 'move_joint',
        'label':  'Move above place position',
        'speed_pct': int(spd),
        **_placeholder('place', hint),
    }


# ── Per-operation builders ─────────────────────────────────────────

def _build_pick_and_place(op: IntentOperation, appH: int,
                          spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    s: List[Dict[str, Any]] = []
    s.append(_grip_open(spd))
    s.append(_detect(op.target_part.name))
    s.append(_approach(op.pick.location_hint, appH, spd))
    s.append(_descend('pick', 'Descend to part', slow, 'pick'))
    s.append(_grip_close())
    s.append(_lift('pick', 'Lift part', appH, medium, 'pick'))
    s.append(_place_above(op.place.location_hint, spd))
    s.append(_descend('place', 'Descend to place', slow, 'place'))
    s.append(_grip_release())
    s.append(_lift('place', 'Lift from place', appH, medium, 'place'))
    return s


def _build_sort(op: IntentOperation, appH: int,
                spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    """Sort = pick + place-by-type. We emit the same pick body as
    pick_and_place; the place leg gets a `sort_bin_hint` from the
    intent's place location for the operator to verify later."""
    s = _build_pick_and_place(op, appH, spd, slow, medium)
    for step in s:
        if step.get('position_role') == 'place':
            step['sort_bin_hint'] = op.place.location_hint
    return s


def _build_machine_tend(op: IntentOperation, appH: int,
                        spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    s: List[Dict[str, Any]] = []
    s.append(_grip_open(spd))
    s.append(_detect(op.target_part.name))
    s.append(_approach(op.pick.location_hint, appH, spd))
    s.append(_descend('pick', 'Descend to part', slow, 'pick'))
    s.append(_grip_close())
    s.append(_lift('pick', 'Lift part', appH, medium, 'pick'))
    s.append({
        'action': 'move_joint',
        'label':  'Move to machine load position',
        'speed_pct': int(spd),
        **_placeholder('machine_load', op.place.location_hint or 'machine load fixture'),
    })
    s.append(_descend('machine_load', 'Descend to load position', min(spd, 20), 'machine_load'))
    s.append(_grip_release())
    s.append(_lift('machine_load', 'Retreat from machine', appH, slow, 'machine_load'))
    s.append({'action': 'set_io', 'label': 'Start machine cycle',
              'io_id': 'DO4', 'value': 1})
    s.append({'action': 'wait', 'label': 'Wait for machine to finish',
              'duration_s': 30})
    s.append({'action': 'set_io', 'label': 'Clear cycle start',
              'io_id': 'DO4', 'value': 0})
    s.append(_lift('machine_load', 'Approach finished part', appH, slow, 'machine_load'))
    s.append(_descend('machine_load', 'Descend to finished part', min(spd, 20), 'machine_load'))
    s.append({'action': 'close_gripper', 'label': 'Grip finished part',
              'force_pct': DEFAULT_GRIP_FORCE, 'io_close': 'DO0'})
    s.append(_lift('machine_load', 'Lift finished part', appH, medium, 'machine_load'))
    s.append({
        'action': 'move_joint',
        'label':  'Move to unload position',
        'speed_pct': int(spd),
        **_placeholder('unload', 'unload location'),
    })
    s.append(_descend('unload', 'Descend to unload', slow, 'unload'))
    s.append(_grip_release())
    return s


def _build_palletize(op: IntentOperation, mode: str,
                     appH: int, spd: int, slow: int, medium: int) -> List[Dict[str, Any]]:
    """Palletize / depalletize use move_to_pallet which the executor
    expands at runtime — pallet geometry is in config.pallet, not in
    individual steps. The wizard does the same."""
    s: List[Dict[str, Any]] = []
    s.append(_move_home())
    if mode == 'palletize':
        s.append(_detect(op.target_part.name))
        s.append(_approach(op.pick.location_hint, appH, spd))
        s.append(_descend('pick', 'Descend to pick', slow, 'pick'))
        s.append(_grip_close())
        s.append(_lift('pick', 'Lift from pick', 200, medium, 'pick'))
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
        s.append({
            'action': 'move_linear',
            'label':  'Move above place',
            'speed_pct': spd, 'offset_z_mm': 200,
            **_placeholder('place', op.place.location_hint),
        })
        s.append(_descend('place', 'Descend to place', slow, 'place'))
        s.append(_grip_release())
        s.append(_lift('place', 'Lift from place', 200, medium, 'place'))
    s.append(_move_home(label='Return to home'))
    return s


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

    name = (program_name
            or (intent.task_summary[:60] if intent.task_summary else f'demo {demo_id}')
            ).strip() or f'demo {demo_id}'

    sorted_ops = sorted(
        list(intent.operations or []),
        key=lambda o: o.sequence_index if o.sequence_index else 0,
    )

    primary_op_type = (sorted_ops[0].operation_type if sorted_ops else 'pick_and_place')
    if primary_op_type not in AVAILABLE_OPERATIONS:
        primary_op_type = 'pick_and_place'

    steps: List[Dict[str, Any]] = []
    steps.append(_move_home())

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
            break        # pallet programs are single-op by design
        elif op.operation_type == 'depalletize':
            steps = _build_palletize(op, 'depalletize', appH, spd, slow, medium)
            primary_op_type = 'palletize'
            break

    if not sorted_ops:
        # Nothing to do — still emit a loadable artifact.
        steps.append({'action': 'wait', 'label': 'Empty draft — review ambiguities',
                      'duration_s': 0})

    if primary_op_type != 'palletize':
        steps.append(_move_home(label='Return to home'))

    numbered = [{**s, 'step': i + 1} for i, s in enumerate(steps)]

    # Description summarises the source + caveat in one line so the
    # Program Library row makes the draft-ness obvious without the
    # operator opening the program.
    desc_lines = [
        'Generated from demonstration — poses pending perception.',
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
        'ambiguities':    list(intent.ambiguities),
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

    return ProgramDraft(
        name=name,
        description='  '.join(desc_lines),
        steps=numbered,
        config=config,
        tags=[primary_op_type],
        pbd_metadata=pbd_metadata,
    )

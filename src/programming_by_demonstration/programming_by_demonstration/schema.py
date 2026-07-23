"""StructuredIntent + ProgramDraft schemas for Programming by Demonstration.

These dataclasses are the contract between the understanding backend
(API/local), the program composer, and everything downstream. They are
plain JSON-serialisable Python dicts under the hood — no rclpy
dependency — so the dashboard can import them without dragging ROS in.

Two principles drive the shape:

  1. Operations and parts MUST be grounded to the real RoboAi catalog.
     `operation_type` must be one of AVAILABLE_OPERATIONS; `target_part`
     must carry a real `part_id` from the library or be flagged
     `unknown_part_not_in_library`. Inventing either is forbidden.

  2. Poses are ALWAYS placeholders in this build. Every pick/place pose
     carries `pose: null` + `pose_status: "awaiting_perception"` plus a
     human-readable `location_hint` so the later perception stack can
     ground the intent. Generated programs LOAD and DISPLAY but do not
     RUN — the operator sees "awaiting perception" markers instead of
     taught coordinates.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from dataclasses import field as dc_field
from typing import Any, Dict, List, Optional


# ── Real wizard operations (must match ProgramWizard.jsx PAGES[0]). ──
# Inspect & Verify / Pick & Inspect / Scan & Identify were removed in
# an earlier sweep; the four remaining operations below are the ground
# truth — the understanding backend is constrained to these.
AVAILABLE_OPERATIONS = (
    'pick_and_place',
    'sort',
    'machine_tend',
    'palletize',
    'depalletize',
)


# Sentinel for every placeholder pose in this build. Anything reading
# a draft program checks for this to render "awaiting perception"
# instead of taught coordinates.
POSE_AWAITING_PERCEPTION = 'awaiting_perception'


# ── StructuredIntent ────────────────────────────────────────────────

@dataclass
class PartReference:
    """The grounded part the AI matched to the library."""
    part_id: str                       # real id from the parts library, or 'unknown'
    name: str                          # display name
    confidence: float = 0.0            # 0..1
    # 'matched_to_library' | 'unknown_part_not_in_library' | 'inferred'
    source: str = 'matched_to_library'

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PoseSlot:
    """Pick / place / approach pose. Always a placeholder in this build."""
    location_hint: str = ''
    pose: Optional[List[float]] = None
    pose_status: str = POSE_AWAITING_PERCEPTION

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PalletSpec:
    """Grid geometry for a palletize / depalletize op, extracted from
    the user's spoken pallet pattern ("3 by 4", "2 rows of 5"…).

    Lives on IntentOperation so the composer can write it straight into
    `config.pallet` for the executor. None on either dimension means
    "operator did not state a grid" — composer falls back to (1,1,1)
    so a single placement is generated rather than a guessed multi-cell
    pattern."""
    rows: int = 1
    cols: int = 1
    layers: int = 1
    fill_order: str = 'row_lr'         # row_lr | row_rl | col | snake
    spacing_x_mm: Optional[float] = None   # None → composer applies default
    spacing_y_mm: Optional[float] = None
    layer_height_mm: Optional[float] = None
    # True when geometry was inferred from a total count without a
    # stated grid (e.g. "place 6 of them"). Surfaces in ambiguities so
    # the reviewer can confirm the assumption.
    assumed: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> 'PalletSpec':
        if not d or not isinstance(d, dict):
            return cls()
        # Allow the model to emit only rows/cols and skip everything
        # else. Coerce safely; reject zero/negative dims back to 1 so
        # the executor's rows*cols*layers can't underflow to 0.
        def _pos_int(v, default=1):
            try:
                n = int(v)
                return n if n > 0 else default
            except (TypeError, ValueError):
                return default
        def _opt_float(v):
            if v is None or v == '':
                return None
            try:
                f = float(v)
                return f if f > 0 else None
            except (TypeError, ValueError):
                return None
        fill = str(d.get('fill_order') or 'row_lr').strip().lower()
        if fill not in ('row_lr', 'row_rl', 'col', 'snake'):
            fill = 'row_lr'
        return cls(
            rows=_pos_int(d.get('rows'), 1),
            cols=_pos_int(d.get('cols'), 1),
            layers=_pos_int(d.get('layers'), 1),
            fill_order=fill,
            spacing_x_mm=_opt_float(d.get('spacing_x_mm')),
            spacing_y_mm=_opt_float(d.get('spacing_y_mm')),
            layer_height_mm=_opt_float(d.get('layer_height_mm')),
            assumed=bool(d.get('assumed') or False),
        )


@dataclass
class IntentOperation:
    """One step of the demonstrated task."""
    operation_type: str                # must be in AVAILABLE_OPERATIONS
    target_part: PartReference
    sequence_index: int
    count_hint: Any = 'all'            # 'all' | int
    pick: PoseSlot = dc_field(default_factory=PoseSlot)
    place: PoseSlot = dc_field(default_factory=PoseSlot)
    # Only meaningful for palletize / depalletize ops. None on other
    # ops so backward-compat consumers can keep ignoring it.
    pallet: Optional[PalletSpec] = None
    notes: str = ''
    # How the robot LOCATES the part each cycle. Mirrors the wizard's
    # `answers.source` discriminator so the composer can gate the
    # `detect` step without inventing a new taxonomy:
    #   'camera_library'  — vision recognises the part every cycle
    #                       (composer emits a `detect` step).
    #   'fixed_position'  — part is always in the same taught spot
    #                       (composer emits NO detect; the pick pose
    #                       is bound directly to the taught contact).
    # Default 'camera_library' matches the composer's pre-change
    # behaviour so intents that don't set this field keep producing
    # vision-driven drafts.
    source: str = 'camera_library'

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['target_part'] = self.target_part.to_dict()
        d['pick']        = self.pick.to_dict()
        d['place']       = self.place.to_dict()
        d['pallet']      = self.pallet.to_dict() if self.pallet else None
        return d


# ── Scene extraction ────────────────────────────────────────────────
# v1 captures only the CORE scene: what objects are present, what named
# locations are referenced, and a free-text spatial summary. Metric
# poses stay out by design — those land later when the MotionCam
# recognition stack resolves them on the real workspace.
#
# Every field carries a `source` tag — "video" | "narration" | "both"
# — so the human reviewer (and the future local model) can see where
# each piece of understanding came from. "both" means video + voice
# agreed, which is the highest-confidence signal.

SOURCE_VIDEO     = 'video'
SOURCE_NARRATION = 'narration'
SOURCE_BOTH      = 'both'


@dataclass
class SceneObject:
    """One object recognised in the demonstration."""
    label: str = ''
    matched_part_id: Optional[str] = None       # real library id or None
    matched_part_name: Optional[str] = None
    match_confidence: float = 0.0
    source: str = SOURCE_BOTH                   # video|narration|both
    approx_location: str = ''                   # verbal, NOT metric
    count_seen: Any = 1                         # int OR "multiple"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SceneLocation:
    """A named place referenced in the demonstration (pick/place/fixture)."""
    label: str = ''
    role: str = 'other'                         # place_target|pick_source|fixture|other
    approx_position: str = ''                   # verbal
    source: str = SOURCE_BOTH

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Scene:
    """Combined video+narration scene understanding."""
    objects: List[SceneObject] = dc_field(default_factory=list)
    locations: List[SceneLocation] = dc_field(default_factory=list)
    spatial_summary: str = ''

    def to_dict(self) -> Dict[str, Any]:
        return {
            'objects':         [o.to_dict() for o in self.objects],
            'locations':       [l.to_dict() for l in self.locations],
            'spatial_summary': self.spatial_summary,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> 'Scene':
        if not d:
            return cls()
        objs: List[SceneObject] = []
        for raw in (d.get('objects') or []):
            objs.append(SceneObject(
                label=str(raw.get('label') or ''),
                matched_part_id=(str(raw['matched_part_id'])
                                 if raw.get('matched_part_id') else None),
                matched_part_name=(str(raw['matched_part_name'])
                                   if raw.get('matched_part_name') else None),
                match_confidence=float(raw.get('match_confidence') or 0.0),
                source=str(raw.get('source') or SOURCE_BOTH),
                approx_location=str(raw.get('approx_location') or ''),
                count_seen=raw.get('count_seen', 1),
            ))
        locs: List[SceneLocation] = []
        for raw in (d.get('locations') or []):
            locs.append(SceneLocation(
                label=str(raw.get('label') or ''),
                role=str(raw.get('role') or 'other'),
                approx_position=str(raw.get('approx_position') or ''),
                source=str(raw.get('source') or SOURCE_BOTH),
            ))
        return cls(
            objects=objs,
            locations=locs,
            spatial_summary=str(d.get('spatial_summary') or ''),
        )


# ── Clarifications ──────────────────────────────────────────────────
# A Clarification is a STRUCTURED ambiguity: a question the AI wants
# the operator to answer before the draft program is final. Each one
# carries enough metadata for the frontend to render the right input
# (multiple choice / number / text / part picker) and enough
# `affects`/`field` context for the apply step to write the answer
# back into the correct slot in the draft.
#
# The schema is intentionally permissive: any item the model emits as
# a plain string (the legacy ambiguities shape) is wrapped into a
# text-typed Clarification by from_dict so old demos still load and
# render — they just can't be answered interactively.

_CLARIFICATION_FIELDS = (
    'part', 'count', 'pallet_grid', 'location',
    'speed', 'gripper', 'order', 'other',
)
_CLARIFICATION_TYPES = ('choice', 'number', 'text', 'part_select')


@dataclass
class Clarification:
    """One structured question the AI wants the operator to answer."""
    id: str = ''
    field: str = 'other'                     # one of _CLARIFICATION_FIELDS
    question: str = ''
    type: str = 'text'                       # one of _CLARIFICATION_TYPES
    options: List[Any] = dc_field(default_factory=list)
    suggested: Any = None
    affects: Dict[str, Any] = dc_field(default_factory=dict)
    # Plain-string legacy items get wrapped with answerable=False so
    # the FE renders them as a read-only chip rather than a broken
    # input. Newly-emitted Clarifications are answerable by default.
    answerable: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_any(cls, raw: Any, fallback_id: str = '') -> 'Clarification':
        """Build a Clarification from either a structured dict (new
        shape) or a plain string (legacy ambiguity)."""
        if isinstance(raw, str):
            return cls(
                id=fallback_id or 'legacy',
                field='other',
                question=raw,
                type='text',
                options=[],
                suggested=None,
                affects={},
                answerable=False,
            )
        if not isinstance(raw, dict):
            return cls(id=fallback_id or 'invalid',
                       field='other', question=str(raw or ''),
                       type='text', answerable=False)
        ftype = str(raw.get('type') or 'text').strip().lower()
        if ftype not in _CLARIFICATION_TYPES:
            ftype = 'text'
        ffield = str(raw.get('field') or 'other').strip().lower()
        if ffield not in _CLARIFICATION_FIELDS:
            ffield = 'other'
        opts = raw.get('options')
        opts = list(opts) if isinstance(opts, list) else []
        aff  = raw.get('affects')
        aff  = dict(aff) if isinstance(aff, dict) else {}
        return cls(
            id=str(raw.get('id') or fallback_id or ''),
            field=ffield,
            question=str(raw.get('question') or ''),
            type=ftype,
            options=opts,
            suggested=raw.get('suggested'),
            affects=aff,
            answerable=bool(raw.get('answerable', True)),
        )


@dataclass
class StructuredIntent:
    """Grounded interpretation of one demonstration."""
    task_summary: str = ''
    scene: Scene = dc_field(default_factory=Scene)
    operations: List[IntentOperation] = dc_field(default_factory=list)
    # The on-disk field name stays `ambiguities` (older demos on
    # /opt/cobot/demonstrations use this) but the type is now
    # Clarification. Legacy plain strings get wrapped on load.
    ambiguities: List[Clarification] = dc_field(default_factory=list)
    confidence_overall: float = 0.0
    raw_understanding_notes: str = ''
    # Provenance — populated by the orchestration layer, not the backend.
    backend_id: str = ''               # 'api:claude-opus-4-7' / 'local:stub'
    transited_externally: bool = False

    def __post_init__(self) -> None:
        # Normalize `ambiguities` so any construction path — from_dict,
        # api_backend._parse_intent_json (which builds the list from
        # raw model JSON + appended plain strings), local_backend,
        # _error_result, tests, future callers — produces a list of
        # real Clarification instances. Without this, to_dict() blows
        # up with AttributeError: 'dict' object has no attribute
        # 'to_dict' the moment any non-Clarification slips in. This
        # is the load-bearing invariant for the whole intent-output
        # path.
        norm: List[Clarification] = []
        for idx, item in enumerate(self.ambiguities or []):
            if isinstance(item, Clarification):
                norm.append(item)
                continue
            c = Clarification.from_any(item, fallback_id=f'q{idx + 1}')
            if not c.id:
                c.id = f'q{idx + 1}'
            norm.append(c)
        self.ambiguities = norm

    def to_dict(self) -> Dict[str, Any]:
        return {
            'task_summary':            self.task_summary,
            'scene':                   self.scene.to_dict(),
            'operations':              [op.to_dict() for op in self.operations],
            'ambiguities':             [c.to_dict() for c in self.ambiguities],
            'confidence_overall':      float(self.confidence_overall),
            'raw_understanding_notes': self.raw_understanding_notes,
            'backend_id':              self.backend_id,
            'transited_externally':    bool(self.transited_externally),
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    # ── Constructors ────────────────────────────────────────────────

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> 'StructuredIntent':
        ops = []
        for raw in (d.get('operations') or []):
            tp = raw.get('target_part') or {}
            op_type = str(raw.get('operation_type') or 'pick_and_place')
            # PalletSpec is only attached to pallet ops; older intents
            # without the field still load (pallet=None) and the
            # composer falls back to a single-slot default.
            pallet_spec: Optional[PalletSpec] = None
            if op_type in ('palletize', 'depalletize'):
                pallet_spec = PalletSpec.from_dict(raw.get('pallet'))
            ops.append(IntentOperation(
                operation_type=op_type,
                target_part=PartReference(
                    part_id=str(tp.get('part_id') or 'unknown'),
                    name=str(tp.get('name') or ''),
                    confidence=float(tp.get('confidence') or 0.0),
                    source=str(tp.get('source') or 'matched_to_library'),
                ),
                sequence_index=int(raw.get('sequence_index') or 0),
                count_hint=raw.get('count_hint') if raw.get('count_hint') is not None else 'all',
                pick=PoseSlot(
                    location_hint=str((raw.get('pick') or {}).get('location_hint') or ''),
                    pose=None,
                    pose_status=POSE_AWAITING_PERCEPTION,
                ),
                place=PoseSlot(
                    location_hint=str((raw.get('place') or {}).get('location_hint') or ''),
                    pose=None,
                    pose_status=POSE_AWAITING_PERCEPTION,
                ),
                pallet=pallet_spec,
                notes=str(raw.get('notes') or ''),
                source=(str(raw.get('source') or 'camera_library').lower()
                        if str(raw.get('source') or '').lower() in
                           ('camera_library', 'fixed_position') else 'camera_library'),
            ))
        clarifications: List[Clarification] = []
        for idx, raw in enumerate(d.get('ambiguities') or []):
            fallback = f'q{idx + 1}'
            c = Clarification.from_any(raw, fallback_id=fallback)
            # Ensure every clarification has an id so the FE can use it
            # as a React key and the learning store can associate the
            # operator's answer back to the exact question.
            if not c.id:
                c.id = fallback
            clarifications.append(c)
        return cls(
            task_summary=str(d.get('task_summary') or ''),
            scene=Scene.from_dict(d.get('scene') or {}),
            operations=ops,
            ambiguities=clarifications,
            confidence_overall=float(d.get('confidence_overall') or 0.0),
            raw_understanding_notes=str(d.get('raw_understanding_notes') or ''),
            backend_id=str(d.get('backend_id') or ''),
            transited_externally=bool(d.get('transited_externally') or False),
        )


# ── ProgramDraft ────────────────────────────────────────────────────
# Mirrors the existing program library shape so a draft loads in the
# Program Library and opens in the Program tab unchanged. The single
# meaningful difference is config.pbd_metadata + config.draft = True,
# which the UI uses to render "awaiting perception" badges and tag
# the program as demonstration-generated.

@dataclass
class ProgramDraft:
    name: str
    description: str
    steps: List[Dict[str, Any]]
    config: Dict[str, Any]
    tags: List[str]
    pbd_metadata: Dict[str, Any]       # source demo_id, intent ref, etc.

    def to_program_payload(self) -> Dict[str, Any]:
        """Shape consumed by POST /api/programs (matches the wizard payload)."""
        cfg = dict(self.config)
        cfg['draft']        = True
        cfg['pbd_metadata'] = dict(self.pbd_metadata)
        return {
            'name':        self.name,
            'description': self.description,
            'steps':       list(self.steps),
            'tags':        list(self.tags) + ['draft', 'pbd'],
            'config':      cfg,
            'motion_profile_name':             cfg.get('motion_profile_name', 'Balanced'),
            'motion_profile_override_enabled': False,
            'motion_optimization_enabled':     True,
        }

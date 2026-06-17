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
from dataclasses import asdict, dataclass, field
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
class IntentOperation:
    """One step of the demonstrated task."""
    operation_type: str                # must be in AVAILABLE_OPERATIONS
    target_part: PartReference
    sequence_index: int
    count_hint: Any = 'all'            # 'all' | int
    pick: PoseSlot = field(default_factory=PoseSlot)
    place: PoseSlot = field(default_factory=PoseSlot)
    notes: str = ''

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['target_part'] = self.target_part.to_dict()
        d['pick']        = self.pick.to_dict()
        d['place']       = self.place.to_dict()
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
    objects: List[SceneObject] = field(default_factory=list)
    locations: List[SceneLocation] = field(default_factory=list)
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


@dataclass
class StructuredIntent:
    """Grounded interpretation of one demonstration."""
    task_summary: str = ''
    scene: Scene = field(default_factory=Scene)
    operations: List[IntentOperation] = field(default_factory=list)
    ambiguities: List[str] = field(default_factory=list)
    confidence_overall: float = 0.0
    raw_understanding_notes: str = ''
    # Provenance — populated by the orchestration layer, not the backend.
    backend_id: str = ''               # 'api:claude-opus-4-7' / 'local:stub'
    transited_externally: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            'task_summary':            self.task_summary,
            'scene':                   self.scene.to_dict(),
            'operations':              [op.to_dict() for op in self.operations],
            'ambiguities':             list(self.ambiguities),
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
            ops.append(IntentOperation(
                operation_type=str(raw.get('operation_type') or 'pick_and_place'),
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
                notes=str(raw.get('notes') or ''),
            ))
        return cls(
            task_summary=str(d.get('task_summary') or ''),
            scene=Scene.from_dict(d.get('scene') or {}),
            operations=ops,
            ambiguities=list(d.get('ambiguities') or []),
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

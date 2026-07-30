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
class LocationRegion:
    """Normalized image location for one pick/place event — the video
    channel's evidence used by the position-identity fusion rule.

    Model-friendly and categorical: a 3×3 grid over the workspace
    view. Same cell across two events = evidence of the same physical
    spot; `clarity` records the model's confidence in the cell
    assignment. None on a slot means the backend did not report a
    region (older stored demos, or the backend chose not to).
    """
    grid:      str           = '3x3'     # grid resolution the backend
                                         # reported against; only '3x3'
                                         # is validated by fusion.py.
    cell:      str           = ''        # 'TL'|'TC'|'TR'|'CL'|'C'|'CR'|
                                         # 'BL'|'BC'|'BR' — empty = unknown
    clarity:   str           = 'unknown' # 'clear' | 'borderline' | 'unknown'
    frame_ref: Optional[str] = None      # optional pointer to a frame
                                         # timestamp for audit

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PoseSlot:
    """Pick / place / approach pose. Always a placeholder in this build.

    2026-08-01 §1 adds:
      * `location_ref` — string key into StructuredIntent.positions.
        Identical strings across operations = same physical spot per
        the fusion rule. Empty on legacy demos (they parse back with
        no ref; fusion can be re-run to populate).
      * `region` — LocationRegion the backend reported for this event.
        Feeds fusion's video channel.
    """
    location_hint: str = ''
    pose: Optional[List[float]] = None
    pose_status: str = POSE_AWAITING_PERCEPTION
    location_ref: str = ''
    region: Optional[LocationRegion] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        # Ensure region round-trips as a dict rather than a nested
        # dataclass on downstream deserializers.
        d['region'] = self.region.to_dict() if self.region else None
        return d


_VALID_CELLS = frozenset(('TL', 'TC', 'TR',
                          'CL', 'C',  'CR',
                          'BL', 'BC', 'BR'))
_VALID_CLARITY = frozenset(('clear', 'borderline', 'unknown'))


def _locationregion_from_dict(d: Optional[Dict[str, Any]]) -> Optional[LocationRegion]:
    """Tolerant deserializer for LocationRegion. Returns None when the
    input is missing or empty; coerces bad values back to 'unknown'."""
    if not isinstance(d, dict):
        return None
    cell    = str(d.get('cell') or '').strip().upper()
    if cell not in _VALID_CELLS:
        cell = ''
    clarity = str(d.get('clarity') or 'unknown').strip().lower()
    if clarity not in _VALID_CLARITY:
        clarity = 'unknown'
    frame_ref = d.get('frame_ref')
    if not cell and clarity == 'unknown' and not frame_ref:
        return None
    return LocationRegion(
        grid=str(d.get('grid') or '3x3'),
        cell=cell,
        clarity=clarity,
        frame_ref=str(frame_ref) if frame_ref else None,
    )


def _poseslot_from_dict(d: Optional[Dict[str, Any]]) -> PoseSlot:
    """Deserialize a PoseSlot from an intent-JSON fragment. Handles
    the 2026-08-01 additions (`location_ref`, `region`) and preserves
    the legacy shape (`location_hint`, `pose`, `pose_status`)."""
    if not isinstance(d, dict):
        return PoseSlot(pose_status=POSE_AWAITING_PERCEPTION)
    return PoseSlot(
        location_hint=str(d.get('location_hint') or ''),
        pose=None,      # every pose in this build is a placeholder
        pose_status=POSE_AWAITING_PERCEPTION,
        location_ref=str(d.get('location_ref') or ''),
        region=_locationregion_from_dict(d.get('region')),
    )


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


# Repetition patterns (Task 1 §2, 2026-07-28). The composer consults these
# to unroll operations whose `count` > 1. Kept string-typed so a legacy
# intent that never mentions repetition still parses; unknown values coerce
# to the safe default ('individual_taught') at from_dict time.
PICK_PATTERN_INDIVIDUAL_TAUGHT = 'individual_taught'   # N own taught anchors
PICK_PATTERN_REPEAT_OFFSET     = 'repeat_offset'       # 1 taught + N-1 derived (i·pitch)
PICK_PATTERN_VISION_EACH       = 'vision_each'         # detect step per iter
PLACE_PATTERN_FIXED            = 'fixed'               # all iters place at same taught pose
PLACE_PATTERN_STACK            = 'stack'               # +i·dz on top of iter 0
PLACE_PATTERN_REPEAT_OFFSET    = 'repeat_offset'       # 1 taught + N-1 derived (i·pitch)
# 2026-08-06 §1 addition — pallet_place: teach ONE anchor at the first
# slot (row=0, col=0, layer=0), derive every other slot from the anchor
# via operator-entered pitch × row_axis / pitch × col_axis / layer_height.
# The whole pallet is ONE taught position + N-1 derived contacts —
# radically fewer teach operations than repeat_offset. Distinct from the
# existing `palletize` op_type (which delegates slot expansion to the
# executor at runtime); pallet_place is a PLACE PATTERN on a normal
# pick_and_place op, so the pick side stays identical to today.
PLACE_PATTERN_PALLET           = 'pallet_place'

_PICK_PATTERNS  = (PICK_PATTERN_INDIVIDUAL_TAUGHT,
                   PICK_PATTERN_REPEAT_OFFSET,
                   PICK_PATTERN_VISION_EACH)
_PLACE_PATTERNS = (PLACE_PATTERN_FIXED,
                   PLACE_PATTERN_STACK,
                   PLACE_PATTERN_REPEAT_OFFSET,
                   PLACE_PATTERN_PALLET)


# Base-frame axis literals for pallet row/col growth directions.
_PALLET_AXES = ('+X', '-X', '+Y', '-Y')
_PALLET_ORDERS = ('row_major', 'col_major', 'snake')
_PALLET_TEACH_MODES = ('far_slot', 'edge')


@dataclass
class PalletPlaceSpec:
    """Geometry of a `pallet_place` pattern.

    History:
      2026-08-06 §1 — assume-base-axes (one taught corner + literal
                      +X/-Y grid growth). Broke on any rotated pallet.
      2026-07-30 v1 — 3-point taught frame (A/B/C). Rotation OK; but
                      A conflated "the corner of the pallet" with
                      "the pose the tool contacts the first part",
                      forcing the operator to choose one or the other
                      when the two are actually different geometric
                      quantities.
      2026-07-30 v2 — 4-point split. Three CORNERS on the pallet
                      define the frame (rotation, tilt, pitch); a
                      separate PART pose captures the tool contact
                      + orientation for slot [1,1]. Every slot's
                      position derives its (x,y,z) from the frame
                      and its OFFSET from corner1, and its
                      orientation from part_tcp. Corners can be
                      touched with the tool at the pallet's fixture
                      corner (no part needed) while the part pose
                      only needs to be taught ONCE, with a real
                      part in slot [1,1].

    Model (v2):
        corner1_tcp — pallet corner at slot [row=0, col=0]  (①)
        corner2_tcp — pallet corner at slot [row=0, col=N-1] (②)
        corner3_tcp — pallet corner at slot [row=M-1, col=0] (③)
        part_tcp    — actual part pose at slot [0, 0]         (④)

    Frame derivations:
        row_axis     = normalize(corner2 - corner1)
        col_axis     = normalize((corner3 - corner1) - proj on row)
        plane_normal = row_axis × col_axis
        pitch_row_mm = |corner2 - corner1| / (cols - 1)   (measured)
        pitch_col_mm = |corner3 - corner1| / (rows - 1)   (measured)

    Slot [r, c, l] world position =
        corner1 + c · pitch_row · row_axis
                + r · pitch_col · col_axis
                + l · layer_height · plane_normal
                + (part_tcp[xyz] − corner1[xyz])       ← the part-datum
                                                        offset from ①

    Orientation of every slot = part_tcp's orientation (rx, ry, rz).

    Backward compatibility:
      * If corner1/corner2/corner3/part_tcp are all None but v1's
        corner_a_tcp / point_b_tcp / point_c_tcp are present, the
        v1 fields migrate: corner1 ← corner_a (and part_tcp ←
        corner_a as a first guess so slots don't jump), corner2 ←
        point_b, corner3 ← point_c. A migration finding tells the
        operator to re-teach ④ so the part-datum offset can be
        measured properly. Without a re-teach, slot poses remain
        exactly what v1 produced (part_tcp == corner1 → zero
        offset).
      * If the frame is completely untaught, math falls back to
        base-axis literals in row_axis / col_axis so pre-frame
        programs keep rendering.

    The v1 fields (corner_a_tcp / point_b_tcp / point_c_tcp) are
    kept on the dataclass for the migration path but new writers
    (wizard v2, editor) emit the corner1/2/3/part_tcp fields."""
    rows:               int   = 1
    cols:               int   = 1
    pitch_row_mm:       float = 0.0
    pitch_col_mm:       float = 0.0
    row_axis:           str   = '+X'    # legacy fallback — see docstring
    col_axis:           str   = '+Y'
    layers:             int   = 1
    layer_height_mm:    Optional[float] = None    # ignored when layers == 1
    order:              str   = 'snake'           # one of _PALLET_ORDERS

    # 3-point taught frame (v1). Retained for migration into v2 —
    # from_dict maps these into corner1/2/3 + part_tcp when the v2
    # fields are absent. New code should NOT read these directly.
    corner_a_tcp:       Optional[List[float]] = None
    point_b_tcp:        Optional[List[float]] = None
    point_c_tcp:        Optional[List[float]] = None
    teach_mode:         str   = 'far_slot'         # one of _PALLET_TEACH_MODES

    # 4-point taught frame (v2, 2026-07-30). Three pallet corners +
    # the actual part pose at slot [1,1]. Each is a 6-vector
    # [x_mm, y_mm, z_mm, rx_rad, ry_rad, rz_rad] in the robot base.
    corner1_tcp:        Optional[List[float]] = None
    corner2_tcp:        Optional[List[float]] = None
    corner3_tcp:        Optional[List[float]] = None
    part_tcp:           Optional[List[float]] = None
    # When True, corner1/part_tcp were seeded from v1's corner_a
    # via from_dict's migration. UI surfaces this so the operator
    # sees "re-teach ④" as an info nudge rather than silently
    # accepting a probably-wrong part datum.
    migrated_from_v1:   bool  = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> 'PalletPlaceSpec':
        if not isinstance(d, dict):
            return cls()
        def _pos_int(v, default=1):
            try:
                n = int(v)
                return n if n > 0 else default
            except (TypeError, ValueError):
                return default
        def _f(v):
            try:
                return float(v) if v is not None and v != '' else 0.0
            except (TypeError, ValueError):
                return 0.0
        def _opt_f(v):
            try:
                return float(v) if v is not None and v != '' else None
            except (TypeError, ValueError):
                return None
        def _opt_tcp(v):
            """Accept a 6-vector list/tuple or None. Malformed → None
            so the math falls back to base-axis literals rather than
            crashing on bad input from an out-of-date wizard."""
            if v is None: return None
            if not isinstance(v, (list, tuple)): return None
            if len(v) < 6: return None
            try:
                return [float(x) for x in v[:6]]
            except (TypeError, ValueError):
                return None
        row_axis = str(d.get('row_axis') or '+X').upper()
        if row_axis not in _PALLET_AXES:
            row_axis = '+X'
        col_axis = str(d.get('col_axis') or '+Y').upper()
        if col_axis not in _PALLET_AXES:
            col_axis = '+Y'
        order = str(d.get('order') or 'snake').lower()
        if order not in _PALLET_ORDERS:
            order = 'snake'
        teach_mode = str(d.get('teach_mode') or 'far_slot').lower()
        if teach_mode not in _PALLET_TEACH_MODES:
            teach_mode = 'far_slot'

        # v1 fields (read as-is).
        corner_a = _opt_tcp(d.get('corner_a_tcp'))
        point_b  = _opt_tcp(d.get('point_b_tcp'))
        point_c  = _opt_tcp(d.get('point_c_tcp'))
        # v2 fields — direct read.
        c1 = _opt_tcp(d.get('corner1_tcp'))
        c2 = _opt_tcp(d.get('corner2_tcp'))
        c3 = _opt_tcp(d.get('corner3_tcp'))
        pt = _opt_tcp(d.get('part_tcp'))
        migrated = False
        # v1 → v2 migration: seed corner1/2/3 + part_tcp from the
        # v1 fields when v2 is absent. corner1 AND part_tcp both
        # get corner_a — v1 conflated the two, so seeding both
        # keeps the derived slots byte-identical to the v1 output
        # (zero part-datum offset). Downstream validation raises
        # an info finding telling the operator to re-teach ④.
        if c1 is None and corner_a is not None:
            c1 = list(corner_a); migrated = True
        if c2 is None and point_b is not None:
            c2 = list(point_b);  migrated = True
        if c3 is None and point_c is not None:
            c3 = list(point_c);  migrated = True
        if pt is None and corner_a is not None:
            pt = list(corner_a); migrated = True

        return cls(
            rows=_pos_int(d.get('rows'), 1),
            cols=_pos_int(d.get('cols'), 1),
            pitch_row_mm=_f(d.get('pitch_row_mm')),
            pitch_col_mm=_f(d.get('pitch_col_mm')),
            row_axis=row_axis,
            col_axis=col_axis,
            layers=_pos_int(d.get('layers'), 1),
            layer_height_mm=_opt_f(d.get('layer_height_mm')),
            order=order,
            corner_a_tcp=corner_a,
            point_b_tcp=point_b,
            point_c_tcp=point_c,
            teach_mode=teach_mode,
            corner1_tcp=c1,
            corner2_tcp=c2,
            corner3_tcp=c3,
            part_tcp=pt,
            migrated_from_v1=migrated,
        )

    def total_slots(self) -> int:
        return int(self.rows) * int(self.cols) * int(self.layers)

    def has_taught_frame(self) -> bool:
        """True iff all three CORNER points are taught. Enough to
        compute the frame math (axes / pitches / normal). Whether
        part_tcp is also taught controls the orientation source
        and the part-datum offset — see has_taught_part_datum."""
        return (self.corner1_tcp is not None
                and self.corner2_tcp is not None
                and self.corner3_tcp is not None)

    def has_taught_part_datum(self) -> bool:
        """True iff part_tcp is taught AND distinct from corner1_tcp
        (so the migration seed doesn't count). When True the slot
        derivation carries a non-zero part-datum offset."""
        if self.part_tcp is None or self.corner1_tcp is None:
            return False
        # Any of x/y/z differs by more than 0.5 mm → truly distinct.
        for i in range(3):
            if abs(self.part_tcp[i] - self.corner1_tcp[i]) > 0.5:
                return True
        return False


@dataclass
class IntentOperation:
    """One step of the demonstrated task."""
    operation_type: str                # must be in AVAILABLE_OPERATIONS
    target_part: PartReference
    sequence_index: int
    # Legacy — the composer used to ignore this. Kept for wire-compat with
    # stored intents; NEW clarifications write `count` (below). from_dict
    # accepts either; to_dict emits both so downstream consumers can pick
    # whichever they already speak.
    count_hint: Any = 'all'            # 'all' | int
    # Canonical iteration count (Task 1 §2). Composer unrolls this many
    # pick/place iterations; default 1 keeps every legacy intent's draft
    # bit-identical.
    count: int = 1
    # How iterations 2..N of pick relate to iteration 1's taught anchor.
    #   individual_taught  — each iteration is its own taught contact (safe
    #                        default; operator teaches N times).
    #   repeat_offset      — iteration i's contact = anchor + (i · pitch);
    #                        pitch supplied by pick_pitch_dx_mm / dy_mm.
    #                        `derived_from='pick_iter0'` on iters 2..N.
    #   vision_each        — a `detect` step runs per iteration and the
    #                        pick pose comes from perception each cycle.
    pick_pattern:      str   = PICK_PATTERN_INDIVIDUAL_TAUGHT
    pick_pitch_dx_mm:  Optional[float] = None
    pick_pitch_dy_mm:  Optional[float] = None
    # Place iteration policy.
    #   fixed          — every iter drops at the same taught place pose
    #                    (overwrites — rarely what the operator wants).
    #   stack          — iter i places at (place anchor + i · dz Z);
    #                    dz = place_stack_dz_mm. Default when the transcript
    #                    mentions stacking / "on top of the previous".
    #   repeat_offset  — iter i places at (place anchor + i · pitch);
    #                    dx/dy in place_pitch_*.
    place_pattern:     str   = PLACE_PATTERN_FIXED
    place_stack_dz_mm: Optional[float] = None
    place_pitch_dx_mm: Optional[float] = None
    place_pitch_dy_mm: Optional[float] = None
    pick: PoseSlot = dc_field(default_factory=PoseSlot)
    place: PoseSlot = dc_field(default_factory=PoseSlot)
    # Only meaningful for palletize / depalletize ops. None on other
    # ops so backward-compat consumers can keep ignoring it.
    pallet: Optional[PalletSpec] = None
    # 2026-08-06 §1 — pallet_place pattern spec. Only meaningful when
    # `place_pattern == 'pallet_place'`. None on other ops keeps the
    # dict shape byte-identical to legacy intents.
    pallet_place: Optional[PalletPlaceSpec] = None
    notes: str = ''
    # How the robot LOCATES the part each cycle. Mirrors the wizard's
    # `answers.source` discriminator so the composer can gate the
    # `detect` step without inventing a new taxonomy:
    #   'fixed_position'  — part is always in the same taught spot
    #                       (composer emits NO detect; the pick pose
    #                       is bound directly to the taught contact).
    #                       DEFAULT — a taught contact is
    #                       deterministic and operators only add
    #                       vision when the part actually moves.
    #   'camera_library'  — vision recognises the part every cycle
    #                       (composer emits a `detect` step tied to
    #                       target_part.part_id).
    # A schema round-trip on an older intent with no `source` field
    # will now default to 'fixed_position' — fresh review of a legacy
    # demo therefore shows no detect step until the operator picks
    # vision via the location clarification. The applyClarifications
    # step-restructuring on the frontend keeps flipping bidirectional.
    source: str = 'fixed_position'
    # End-effector type. Drives which gripper-actuation steps the
    # composer emits per pick/place pair:
    #   'finger'   — parallel-jaw gripper. `open_gripper` / `close_gripper`
    #                / `open_gripper` actions with the app's existing
    #                Open/Grip/Release labels. Default.
    #   'vacuum'   — suction cup. `set_io Engage vacuum` /
    #                `set_io Disengage vacuum` (both bound to the same
    #                io_map "Vacuum" port), plus the blow-off pulse
    #                (set_io Blow off → wait → set_io Blow off stop)
    #                after Disengage when a blow-off port is
    #                configured.
    #   'magnetic' — single-signal magnet on a custom DO. Same
    #                two-step shape as vacuum but no blow-off pulse.
    # Legacy intents parse back with 'finger' — that's what the
    # composer emitted before the effector split, so drafts stored
    # under the old shape stay bit-for-bit identical.
    effector: str = 'finger'

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['target_part']  = self.target_part.to_dict()
        d['pick']         = self.pick.to_dict()
        d['place']        = self.place.to_dict()
        d['pallet']       = self.pallet.to_dict() if self.pallet else None
        d['pallet_place'] = self.pallet_place.to_dict() if self.pallet_place else None
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
class LocationRef:
    """One resolved position — the SAME across all events that fusion
    marked as the same physical spot. Every pick/place slot on an
    operation carries a `location_ref` STRING that points into
    StructuredIntent.positions; identical strings = same place.

    Fusion is DECIDED, not asked. The `fusion_rule` field records
    which of the ordered rules (§1c) fired to produce this ref, and
    `confidence` is the numeric score. `low_confidence=True` renders
    as a passive 'linked — verify' chip in review; NOT a blocking
    clarification question.

    The `members` list is the audit trail — every (op_index, slot)
    that folded into this ref. The learning store records split /
    merge corrections against the ref, so a training loop can see
    exactly where fusion was wrong.
    """
    ref:            str                     = ''
    label:          str                     = ''    # 'Tray pick', 'Fixture A'…
    role:           str                     = ''    # 'pick' | 'place' | 'mixed'
    fusion_rule:    str                     = ''    # 'speech_same+video_agrees' …
    confidence:     float                   = 0.0   # 0..1
    low_confidence: bool                    = False
    members:        List[Dict[str, Any]]    = dc_field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> 'LocationRef':
        if not isinstance(d, dict):
            return cls()
        members = d.get('members') or []
        members = [m for m in members if isinstance(m, dict)]
        return cls(
            ref=str(d.get('ref') or ''),
            label=str(d.get('label') or ''),
            role=str(d.get('role') or ''),
            fusion_rule=str(d.get('fusion_rule') or ''),
            confidence=float(d.get('confidence') or 0.0),
            low_confidence=bool(d.get('low_confidence') or False),
            members=[dict(m) for m in members],
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
    # 2026-08-01 §1 — resolved position identities across operations.
    # Populated by fusion.fuse_positions after the backend returns.
    # Legacy stored demos default to [] and re-fuse on demand.
    positions: List[LocationRef] = dc_field(default_factory=list)
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
            'positions':               [p.to_dict() for p in self.positions],
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
            # 2026-08-06 §1 — pallet_place spec sits on any op whose
            # place_pattern == 'pallet_place'. Legacy intents don't
            # carry the field and load with pallet_place=None (composer
            # takes the safe non-pallet branches).
            pallet_place_spec: Optional[PalletPlaceSpec] = None
            if raw.get('pallet_place') is not None:
                pallet_place_spec = PalletPlaceSpec.from_dict(raw.get('pallet_place'))
            # Count reconciliation (Task 1 §2). Accept either the legacy
            # `count_hint` ('all' | int) or the canonical `count` (int).
            # 'all' → 1 iteration in the composer (the operator hasn't
            # confirmed a repetition yet — the q-count ambiguity is what
            # upgrades it). Any positive int wins.
            raw_count = raw.get('count')
            if raw_count is None:
                raw_count = raw.get('count_hint')
            try:
                if raw_count is None or (isinstance(raw_count, str)
                                         and raw_count.strip().lower() == 'all'):
                    count = 1
                else:
                    count = max(1, int(raw_count))
            except (TypeError, ValueError):
                count = 1
            # Pattern coercion — unknown strings snap to the safe default.
            pp_raw = str(raw.get('pick_pattern') or '').strip().lower()
            pick_pattern = pp_raw if pp_raw in _PICK_PATTERNS \
                else PICK_PATTERN_INDIVIDUAL_TAUGHT
            ppl_raw = str(raw.get('place_pattern') or '').strip().lower()
            place_pattern = ppl_raw if ppl_raw in _PLACE_PATTERNS \
                else PLACE_PATTERN_FIXED
            def _f(v):
                if v is None or v == '':
                    return None
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
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
                count=count,
                pick_pattern=pick_pattern,
                pick_pitch_dx_mm=_f(raw.get('pick_pitch_dx_mm')),
                pick_pitch_dy_mm=_f(raw.get('pick_pitch_dy_mm')),
                place_pattern=place_pattern,
                place_stack_dz_mm=_f(raw.get('place_stack_dz_mm')),
                place_pitch_dx_mm=_f(raw.get('place_pitch_dx_mm')),
                place_pitch_dy_mm=_f(raw.get('place_pitch_dy_mm')),
                pick=_poseslot_from_dict(raw.get('pick')),
                place=_poseslot_from_dict(raw.get('place')),
                pallet=pallet_spec,
                pallet_place=pallet_place_spec,
                notes=str(raw.get('notes') or ''),
                source=(str(raw.get('source') or 'fixed_position').lower()
                        if str(raw.get('source') or '').lower() in
                           ('camera_library', 'fixed_position') else 'fixed_position'),
                effector=(str(raw.get('effector') or 'finger').lower()
                          if str(raw.get('effector') or '').lower() in
                             ('finger', 'vacuum', 'magnetic') else 'finger'),
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
        positions = [LocationRef.from_dict(p)
                     for p in (d.get('positions') or [])
                     if isinstance(p, dict)]
        return cls(
            task_summary=str(d.get('task_summary') or ''),
            scene=Scene.from_dict(d.get('scene') or {}),
            operations=ops,
            ambiguities=clarifications,
            positions=positions,
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
class Routine:
    """A REPRESENTATION-LEVEL grouping of a repeated operation
    sub-sequence (2026-08-02 task §2). The program is still emitted
    UNROLLED — codegen never sees routines[] and produces byte-
    identical Lua to a flat-authored equivalent (pinned by
    test_routine_grouped_lua_bytediff). Routines are what the
    editor + review UI collapse to render "×3" instead of three
    copies.

    Fields:
      id                       — 'routine_1' style, stable within a program.
      name                     — auto-generated, e.g. "Pick & place ×3".
      iterations               — number of copies of the sub-sequence.
      operation_indices        — indices into intent.operations that fold
                                 into this routine (in order).
      step_indices_per_iter    — list of [start, end) index ranges into
                                 ProgramDraft.steps for each iteration —
                                 the review UI uses these to fold/expand.
      per_iteration_deltas     — reserved for §415 offset-pattern work.
                                 Empty list today; a per-iteration override
                                 would land here as {"iter": int, "delta": {...}}.
      single_iteration_signature — the shared op-signature tuple that
                                   identified the routine.
    """
    id: str = ''
    name: str = ''
    iterations: int = 1
    operation_indices: List[int]     = dc_field(default_factory=list)
    step_indices_per_iter: List[List[int]] = dc_field(default_factory=list)
    per_iteration_deltas: List[Dict[str, Any]] = dc_field(default_factory=list)
    single_iteration_signature: Dict[str, Any] = dc_field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ProgramDraft:
    name: str
    description: str
    steps: List[Dict[str, Any]]
    config: Dict[str, Any]
    tags: List[str]
    pbd_metadata: Dict[str, Any]       # source demo_id, intent ref, etc.
    # 2026-08-02 §2 addition — REPRESENTATION-only routines list.
    # Codegen ignores this field; the editor/review UI uses it to
    # render collapsed repeats. Defaults to [] so every legacy caller
    # constructing a ProgramDraft continues to work.
    routines: List[Routine] = dc_field(default_factory=list)

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
            'routines':    [r.to_dict() for r in self.routines],
        }

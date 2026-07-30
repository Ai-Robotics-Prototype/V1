"""Anthropic Claude understanding backend.

This file is the ONLY place that talks to the external API. Every
piece of provider-specific code (auth header, request shape,
zero-data-retention beta) lives here so the rest of the system stays
provider-agnostic. Replacing the API entirely with the on-Jetson
local backend is a one-config-value swap (backend: api -> local).

The understanding pipeline is:

    frames + transcript + parts/op grounding + retrieved examples
        ─────────────► single multimodal request
                       │
                       ▼
                StructuredIntent JSON
        ◄────────────  parsed and validated against schema.py
"""

from __future__ import annotations

import base64
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from ..schema import (
    AVAILABLE_OPERATIONS,
    IntentOperation,
    LocationRegion,
    PartReference,
    PoseSlot,
    Scene,
    SceneLocation,
    SceneObject,
    SOURCE_BOTH,
    SOURCE_NARRATION,
    SOURCE_VIDEO,
    StructuredIntent,
    POSE_AWAITING_PERCEPTION,
    _locationregion_from_dict,
)
from ..fusion import fuse_positions
from ..understanding_backend import BackendResult, UnderstandingBackend
from ..utils import read_b64_jpeg


# ── Module-level configuration ─────────────────────────────────────

# Keep the SDK import lazy so colcon build / dashboard startup work
# even on machines without `anthropic` installed.
def _anthropic_client(api_key: str, base_url: Optional[str] = None):
    try:
        import anthropic  # type: ignore
    except Exception as e:
        raise BackendApiUnavailable(
            'anthropic SDK not installed. Run:\n'
            '    pip3 install --user anthropic\n'
            f'(import error: {e})'
        ) from e
    kwargs: Dict[str, Any] = {'api_key': api_key}
    if base_url:
        kwargs['base_url'] = base_url
    return anthropic.Anthropic(**kwargs)


class BackendApiUnavailable(RuntimeError):
    """Raised when the SDK isn't installed or the request fails."""


# ── Prompting ───────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are RoboAi's understanding model. The user uploaded a short video
WITH voice narration showing AND describing a robot task they want
programmed. Your job is to FUSE the two channels into ONE coherent
StructuredIntent JSON that RoboAi's deterministic composer consumes.

HOW TO FUSE VIDEO + NARRATION:

  • Video SHOWS what physically happens — which objects are present,
    where they sit on the workspace, how the action unfolds in time
    (first frame = initial state, last frame = final state, interior
    frames = the action).
  • Narration EXPLAINS intent and naming — what to call things, which
    object is "the bracket", what should be picked vs placed.
  • Combine them: if video shows three white parts in a bin and the
    narration says "pick the brackets", bind the visible objects to
    the named one. If narration mentions an object the video doesn't
    clearly show, note it. If video shows an object the narration
    ignores, still record it.
  • On every scene element set `source` to "video" | "narration" |
    "both". "both" means the two channels agreed (highest signal).
  • When channels CONFLICT, prefer what the video shows and flag the
    conflict in `ambiguities`.

CRITICAL RULES — violating any of these makes the output unusable:

  1) operation_type MUST be one of EXACTLY this set (no other value):
{ops_list}

  2) target_part AND scene.objects[].matched_part_id MUST be grounded
     to a real part from the provided parts library by part_id. If you
     cannot match it confidently, emit part_id "unknown" / matched_part_id
     null and add to ambiguities. NEVER invent part_ids.

  3) DO NOT produce numeric poses. Every pose value MUST be:
        "pose": null, "pose_status": "awaiting_perception",
        "location_hint": "<short human-readable spatial cue>"
     RoboAi's perception stack resolves metric poses later. Capture
     intent + verbal layout, not coordinates.

  4) The `scene` block summarises WHAT IS IN THE WORKSPACE.
     `scene.objects[]` = each physical object you identified, with
     `approx_location` as a verbal cue ("right side of the table",
     "in the bin", "on the left tray"). `scene.locations[]` = named
     places referenced (pick zone, place zone, fixture). Neither
     contains numeric coordinates.

     `scene.spatial_summary` VOCABULARY — must match the rest of the
     RoboAi UI so operators reading the review screen see the same
     terminology as in the program editor and the parts library:
       • Refer to parts by their `matched_part_name` VERBATIM (the
         library name — e.g. "BT225L24 bracket"), not by generic
         descriptors like "the small white part". If a part is
         unmatched, use its `label` verbatim.
       • Location vocabulary is fixed: "pick location", "place
         location", "approach", "retreat", "home". Do NOT invent
         synonyms like "drop-off zone", "target area", "staging
         spot" — those don't appear anywhere else in the app.
       • Distances / heights are millimetres ("mm"), matching the
         program editor's Z-offset and descend fields. Do NOT use
         inches, cm, "a bit", "high", "low".
       • Keep it to 1-2 short sentences. State where the part is at
         the start, where it ends up, and any obvious in-between
         location — nothing more.

  5) `operations[]` references scene objects/locations by their LABELS
     so the reviewer can see "Operation 1 picks the white bracket
     from 'right bin', places at 'left tray'". Sequence is captured by
     `sequence_index` (1, 2, …) and the frame timestamps you're given.

     Every operation carries `source` — how the robot LOCATES the part
     each cycle:
       "camera_library"  — vision recognises the part every cycle
                           (composer emits a `detect` step tied to
                           target_part.part_id). Default.
       "fixed_position"  — part is always in the same taught spot
                           (composer emits NO detect; the pick pose
                           is bound to a fixed taught contact).
     Choose `fixed_position` ONLY when the demo unambiguously shows a
     dedicated fixture / feeder / conveyor stop that puts the part at
     the same spot every cycle. When you're unsure, keep the default
     `camera_library` and emit a `field:"location"` clarification
     with `affects.path = "source"` so the operator can flip it — see
     the fixed-vs-vision clarification example below.

     Every operation ALSO carries `effector` — the end-effector type
     that drives which gripper-actuation steps the composer emits:
       "finger"   — parallel-jaw gripper (open/grip/release actions).
                    Default.
       "vacuum"   — suction cup. Composer emits
                    `set_io Engage vacuum` / `set_io Disengage vacuum`
                    with the blow-off pulse after Disengage.
       "magnetic" — electromagnet on a single DO.
     Read the demo. Suction cup / vacuum cup / vacuum gripper in
     narration or visible in video → `effector: "vacuum"`. Parallel
     jaw / two-finger / claw → `effector: "finger"`. When the demo is
     ambiguous, emit a `field:"gripper"` clarification with
     `affects.path = "effector"` and options ["vacuum", "finger"] so
     the operator can confirm — see the effector example below.

     Every `pick` and `place` slot ALSO carries a `region` descriptor
     — approximate normalized image location the fusion rule uses to
     decide whether two events share a physical spot:
        {{
          "grid":    "3x3",              // always this value
          "cell":    "TL"|"TC"|"TR"|
                     "CL"|"C" |"CR"|
                     "BL"|"BC"|"BR",     // where the hand terminates
          "clarity": "clear"|"borderline"  // confidence in the cell
        }}
     Assign the cell by dividing the workspace frame into a 3x3 grid
     (top row = TL/TC/TR from the operator's viewpoint) and asking
     "which cell does the hand end in?". "clear" = well inside a
     single cell; "borderline" = near a cell boundary or the frame
     is uncertain. When two events share the same cell + both are
     "clear", the fusion rule reads that as evidence of sameness.
     Do NOT emit numeric coordinates. Do NOT report region as null —
     always give a best-effort cell + a clarity, and let clarity
     signal doubt.

  6) Surface uncertainty in `ambiguities` as STRUCTURED CLARIFICATIONS,
     not free-form prose. Each item is an OBJECT the dashboard renders
     as an interactive question the operator answers inline. Schema:
        {{
          "id":         "<short kebab id, unique per intent>",
          "field":      "part" | "count" | "pallet_grid" | "location"
                       | "speed" | "gripper" | "order" | "other",
          "question":   "<short, single-sentence question>",
          "type":       "choice" | "number" | "text" | "part_select",
          "options":    [...]      // required for type=choice; for
                                   // part_select put the top
                                   // matching parts library entries
          "suggested":  <your best-guess default the operator can
                        accept verbatim — same shape as the answer
                        you'd want stored>,
          "affects":    {{ "scope": "config" | "operation" | "step",
                          "operation_index": <int, when scope!="config">,
                          "path": "config.pallet" | "target_part"
                                  | "count_hint" | "place.location_hint"
                                  | ... }}
        }}
     RULES:
       a) Do NOT silently guess on MATERIAL ambiguities (which part,
          how many, what grid). Emit a clarification with a sensible
          `suggested` default so the operator can accept-as-is or
          override. Low-stakes assumptions (e.g. you defaulted speed
          to 60) can still be one-line `type:"text"`, `answerable:false`
          notes — but always with a clear `question` so the reviewer
          knows what you assumed.
       b) For pallet_grid, `suggested` should be the same shape the
          composer reads (e.g. {{"rows":1,"cols":1,"layers":1}}). For
          part_select, `suggested` is a part_id; `options` is a list
          of {{"part_id":"...","name":"..."}}. For count, `suggested`
          is an int. For choice, `suggested` is one of `options`.
       c) DO NOT emit any clarification asking whether two locations
          are the same. Position identity is resolved DETERMINISTICALLY
          by a downstream fusion rule (2026-08-01 §1c) using your
          per-event `region` descriptor + the transcript's sameness
          language. Your job is to REPORT the evidence, not to ask.
          If you feel a merge is uncertain, set `region.clarity` to
          "borderline" — the fusion rule renders that as a passive
          "linked — verify" chip, not a blocking question.
     Conflicts between video and narration go in this same list with
     `field:"other"` and a question asking the operator which to
     trust — EXCEPT sameness/difference of two locations, which
     belongs in `region` per rule (c) above and is NOT asked.

     Examples:
       Vague pallet phrasing:
         {{"id":"q-pallet", "field":"pallet_grid",
           "question":"How should the parts be arranged on the pallet?",
           "type":"choice",
           "options":["1 by 1 (single slot)", "a row of 4", "2 by 3 grid"],
           "suggested":{{"rows":1,"cols":1,"layers":1}},
           "affects":{{"scope":"config","path":"config.pallet"}}}}
       Part not confidently matched:
         {{"id":"q-part-1", "field":"part",
           "question":"Which library part did you mean?",
           "type":"part_select",
           "options":[{{"part_id":"bt225l24","name":"BT225L24 bracket"}},
                      {{"part_id":"bt225l13","name":"BT225L13 bracket"}}],
           "suggested":"bt225l24",
           "affects":{{"scope":"operation","operation_index":0,"path":"target_part"}}}}
       Count unclear:
         {{"id":"q-count", "field":"count",
           "question":"How many pieces should the robot place?",
           "type":"number", "suggested":1,
           "affects":{{"scope":"operation","operation_index":0,"path":"count"}}}}
       How pick positions are laid out — when count > 1, the composer
       needs to know whether each pick pose is (a) its own taught
       contact, (b) derived from a first taught anchor + regular
       linear spacing, or (c) resolved by vision each cycle. Default
       suggestion is `individual_taught` (operator teaches each). Use
       `repeat_offset` when the narration/video shows a straight row
       or column with visible spacing; use `vision_each` when the
       narration explicitly says vision picks each cycle:
         {{"id":"q-pick-pattern", "field":"other",
           "question":"How should pick positions be set for the 3 bowls?",
           "type":"choice",
           "options":["individual_taught","repeat_offset","vision_each"],
           "suggested":"individual_taught",
           "affects":{{"scope":"operation","operation_index":0,"path":"pick_pattern"}}}}
       Place stacks on top of each other — dz per iteration:
         {{"id":"q-place-dz", "field":"other",
           "question":"Bowls stack at the place location — height per bowl (mm)?",
           "type":"number", "suggested":50,
           "affects":{{"scope":"operation","operation_index":0,"path":"place_stack_dz_mm"}}}}
       When emitting `q-place-dz`, ALSO set `place_pattern:"stack"` on
       the operation so the composer's stack path fires; if the demo
       says "stack" or "on top of the previous" and count > 1, do this
       automatically (do NOT wait for the operator to answer).
       Place location vague:
         {{"id":"q-place", "field":"location",
           "question":"Describe the place target in a few words.",
           "type":"text", "suggested":"left tray",
           "affects":{{"scope":"operation","operation_index":0,"path":"place.location_hint"}}}}
       Fixed spot vs vision each cycle (drives the `detect` step):
         {{"id":"q-part-source", "field":"location",
           "question":"How should the robot locate the part each cycle?",
           "type":"choice",
           "options":["fixed_position","camera_library"],
           "suggested":"fixed_position",
           "affects":{{"scope":"operation","operation_index":0,"path":"source"}}}}
       End-effector type (drives Engage/Disengage vacuum vs
       Open/Grip/Release step naming):
         {{"id":"q-effector", "field":"gripper",
           "question":"Confirm end effector is a suction cup.",
           "type":"choice",
           "options":["vacuum","finger"],
           "suggested":"vacuum",
           "affects":{{"scope":"operation","operation_index":0,"path":"effector"}}}}
       Options MUST be the canonical values `vacuum` / `finger` /
       `magnetic` so applyClarifications can restructure the draft
       steps deterministically; any other option strings stay as
       free-text and the composer keeps its default effector.
       Note: fixed_position is the default suggestion because a taught
       contact pose is deterministic and needs no runtime perception —
       operators pick vision only when the part actually moves between
       cycles (feeder shuffle, camera-driven bin picking, etc.). Fresh
       drafts without an answered clarification carry source
       "fixed_position" and therefore emit NO detect step.
       Free-text variant of the same clarification (whichever phrasing
       reads best to the operator) — `options` MUST still be the two
       canonical values "fixed_position" and "camera_library" so the
       dashboard can restructure the draft's steps; anything else and
       the answer stays as a plain text field.

  7) For palletize / depalletize operations, EXTRACT the pallet grid
     from the narration and emit it as `operations[i].pallet`:
        {{"rows": int, "cols": int, "layers": int,
         "fill_order": "row_lr"|"row_rl"|"col"|"snake",
         "spacing_x_mm": <optional>, "spacing_y_mm": <optional>,
         "assumed": false}}
     Mappings (apply LITERALLY — do not "round up" a stated grid):
       • "1 by 1" / "one by one" / "single slot"     → rows=1, cols=1
       • "3 by 4" / "three by four"                  → rows=3, cols=4
       • "2 rows of 5" / "two rows of five"          → rows=2, cols=5
       • "a row of 6" / "single row of six"          → rows=1, cols=6
       • "a column of 4" / "stack of 4 in a column"  → rows=4, cols=1
       • "2 layers" / "stack 3 high"                 → layers=2 / layers=3
       • "snake" / "back and forth"                  → fill_order="snake"
     If the operator gives a TOTAL count but no grid ("place 6 of
     them"), set rows=1 cols=<count> layers=1 and assumed=true, and
     add a line to `ambiguities` ("Assumed a single row of N — no grid
     was stated").
     If NO pattern is stated AT ALL, emit rows=1 cols=1 layers=1
     (a single placement). NEVER guess a multi-cell grid.
     Leave `pallet` null on non-pallet operations.

  8) `task_summary` — one short sentence describing what the robot
     does end to end, using the same VOCABULARY as rule 4's
     spatial_summary (library part names verbatim, "pick location" /
     "place location", millimetres, no synonyms). This value is used
     as the LIBRARY-LIST NAME after truncation, so lead with the part
     and operation (e.g. "BT225L24 bracket pick and place from the
     right bin to the left tray"). Long free-form detail belongs in
     `raw_understanding_notes` or the operator-editable description,
     not here.

  9) Output ONLY a JSON object matching the schema below. No prose, no
     markdown fences, no commentary.

Schema:
{schema_example}
"""


SCHEMA_EXAMPLE = """\
{
  "task_summary": "Pick BT225L24 brackets from the bin and place them on the left tray",
  "scene": {
    "objects": [
      {
        "label": "white bracket",
        "matched_part_id": "bt225l24",
        "matched_part_name": "BT225L24 bracket",
        "match_confidence": 0.86,
        "source": "both",
        "approx_location": "in the bin on the right side of the table",
        "count_seen": "multiple"
      }
    ],
    "locations": [
      { "label": "right bin",  "role": "pick_source",   "approx_position": "right side of the table",            "source": "video" },
      { "label": "left tray",  "role": "place_target",  "approx_position": "left side of the table, front edge", "source": "both"  }
    ],
    "spatial_summary": "BT225L24 brackets sit at the pick location on the right side of the work surface; the place location is an empty tray on the left. The robot approaches from home, picks each BT225L24 bracket, and places it at the left tray."
  },
  "operations": [
    {
      "operation_type": "pick_and_place",
      "target_part": {
        "part_id": "bt225l24",
        "name": "BT225L24 bracket",
        "confidence": 0.86,
        "source": "matched_to_library"
      },
      "sequence_index": 1,
      "count_hint": "all",
      "count": 1,
      "pick_pattern":  "individual_taught",
      "place_pattern": "fixed",
      "source":   "fixed_position",
      "effector": "finger",
      "pick":  { "location_hint": "from the right bin",  "pose": null, "pose_status": "awaiting_perception",
                 "region": {"grid":"3x3","cell":"CR","clarity":"clear"} },
      "place": { "location_hint": "onto the left tray",  "pose": null, "pose_status": "awaiting_perception",
                 "region": {"grid":"3x3","cell":"CL","clarity":"clear"} },
      "notes": "Video shows three brackets at t=0s, tray empty at t=0s, brackets in tray at t=8s."
    }
  ],
  "ambiguities": [
    {
      "id": "q-place-tray",
      "field": "location",
      "question": "Which tray is the place target? Only one tray was clearly visible in the video.",
      "type": "choice",
      "options": ["left tray (the one visible)", "right tray (mentioned but not visible)"],
      "suggested": "left tray (the one visible)",
      "affects": { "scope": "operation", "operation_index": 0, "path": "place.location_hint" }
    }
  ],
  "confidence_overall": 0.78,
  "raw_understanding_notes": "Initial state and final state agree across video frames and narration."
}

Palletize example — operator says "place these in a 3 by 4 pallet
pattern on the right side of the table, snake order":
{
  "operations": [
    {
      "operation_type": "palletize",
      "target_part": { "part_id": "bt225l24", "name": "BT225L24 bracket",
                       "confidence": 0.9, "source": "matched_to_library" },
      "sequence_index": 1,
      "count_hint": "all",
      "pick":  { "location_hint": "from the left bin",         "pose": null, "pose_status": "awaiting_perception" },
      "place": { "location_hint": "into the pallet on the right", "pose": null, "pose_status": "awaiting_perception" },
      "pallet": { "rows": 3, "cols": 4, "layers": 1, "fill_order": "snake", "assumed": false },
      "notes": "Spoken grid: 3 by 4."
    }
  ]
}

Multi-pick with stack — operator says "three white bowls in a row on
the table, pick each and stack them on top of the destination bowl on
the stool":
{
  "operations": [
    {
      "operation_type": "pick_and_place",
      "target_part": { "part_id": "unknown", "name": "white bowl",
                       "confidence": 0.2, "source": "unmatched" },
      "sequence_index": 1,
      "count_hint": 3,
      "count": 3,
      "pick_pattern":  "individual_taught",
      "place_pattern": "stack",
      "place_stack_dz_mm": 50,
      "source":   "fixed_position",
      "effector": "vacuum",
      "pick":  { "location_hint": "from the row of bowls on the table",   "pose": null, "pose_status": "awaiting_perception" },
      "place": { "location_hint": "stacked on the destination bowl on the stool", "pose": null, "pose_status": "awaiting_perception" },
      "notes": "Narration: three bowls, pick each, stack on destination bowl. dz assumed 50mm — clarify."
    }
  ],
  "ambiguities": [
    {"id":"q-count", "field":"count",
     "question":"How many bowls should the robot stack?",
     "type":"number", "suggested":3,
     "affects":{ "scope":"operation","operation_index":0,"path":"count" }},
    {"id":"q-pick-pattern", "field":"other",
     "question":"How should pick positions be set for the 3 bowls?",
     "type":"choice",
     "options":["individual_taught","repeat_offset","vision_each"],
     "suggested":"individual_taught",
     "affects":{ "scope":"operation","operation_index":0,"path":"pick_pattern" }},
    {"id":"q-place-dz", "field":"other",
     "question":"Bowls stack at the place location — height per bowl (mm)?",
     "type":"number", "suggested":50,
     "affects":{ "scope":"operation","operation_index":0,"path":"place_stack_dz_mm" }}
  ]
}

Palletize example — operator says "place it in a 1 by 1 pattern" (one
slot only — emit rows=1 cols=1, NOT a default 4x4):
{
  "operations": [
    {
      "operation_type": "palletize",
      "target_part": { "part_id": "bt225l24", "name": "BT225L24 bracket",
                       "confidence": 0.9, "source": "matched_to_library" },
      "sequence_index": 1,
      "count_hint": 1,
      "pick":  { "location_hint": "from the bin",      "pose": null, "pose_status": "awaiting_perception" },
      "place": { "location_hint": "single pallet slot", "pose": null, "pose_status": "awaiting_perception" },
      "pallet": { "rows": 1, "cols": 1, "layers": 1, "fill_order": "row_lr", "assumed": false },
      "notes": "Operator stated 1 by 1 — single placement."
    }
  ]
}
"""


def _system_prompt(operations: List[str]) -> str:
    return SYSTEM_PROMPT.format(
        ops_list='\n'.join(f'      - {o}' for o in operations),
        schema_example=SCHEMA_EXAMPLE,
    )


def _user_content(transcript: str,
                  parts_library: List[Dict[str, Any]],
                  context: Dict[str, Any],
                  retrieved_examples: List[Dict[str, Any]],
                  frames: List[Any]) -> List[Dict[str, Any]]:
    """Build the message content list.

    `frames` is the ordered list returned by utils.extract_frames —
    `(path, timestamp_s)` tuples. A bare list of paths is still
    accepted for back-compat (no timestamps surfaced in that case).

    Order matters: grounding + retrieval text FIRST so the model reads
    the constraints, then frames in chronological order each preceded
    by a tiny `frame @ t=Ns` label so the model can refer to specific
    moments in the action.
    """
    blocks: List[Dict[str, Any]] = []

    grounding = {
        'transcript':           transcript,
        'context':              context or {},
        'parts_library':        parts_library or [],
        'available_operations': list(AVAILABLE_OPERATIONS),
    }
    blocks.append({'type': 'text',
                   'text': 'GROUNDING (use these exactly):\n' +
                           json.dumps(grounding, indent=2)})

    if retrieved_examples:
        blocks.append({'type': 'text',
                       'text': 'PAST EXAMPLES (similar prior demonstrations '
                               'with their corrected programs — mimic these '
                               'patterns when similar):\n' +
                               json.dumps(retrieved_examples, indent=2)})

    # Normalise: accept either [(path, ts), ...] or [path, ...].
    norm_frames: List[Tuple[str, Optional[float]]] = []
    for item in (frames or []):
        if isinstance(item, (tuple, list)) and len(item) >= 2:
            norm_frames.append((str(item[0]), float(item[1])))
        else:
            norm_frames.append((str(item), None))

    if norm_frames:
        blocks.append({
            'type': 'text',
            'text': (
                f'VIDEO FRAMES ({len(norm_frames)} sampled, ordered '
                'chronologically). The first frame is the initial scene '
                'state, the last frame is the final state after the '
                'demonstrated action. Use the timestamps to reason about '
                'sequence.'
            ),
        })
        for path, ts in norm_frames:
            try:
                media_type, b64 = read_b64_jpeg(path)
            except Exception:
                continue
            label = (f'frame @ t={ts:.2f}s' if ts is not None
                     else f'frame {os.path.basename(path)}')
            blocks.append({'type': 'text', 'text': label})
            blocks.append({
                'type': 'image',
                'source': {
                    'type':       'base64',
                    'media_type': media_type,
                    'data':       b64,
                },
            })

    blocks.append({
        'type': 'text',
        'text': ('FUSE the video and narration into ONE StructuredIntent. '
                 'Output the JSON now.'),
    })
    return blocks


# ── Backend ─────────────────────────────────────────────────────────

class AnthropicClaudeBackend(UnderstandingBackend):
    """Strong external multimodal model. Used "now" until the local
    distilled model lands. Reads its API key from ANTHROPIC_API_KEY by
    default — never hardcoded."""

    transits_externally = True

    def __init__(self,
                 model: str = 'claude-opus-4-7',
                 api_key: Optional[str] = None,
                 base_url: Optional[str] = None,
                 max_tokens: int = 4096,
                 request_timeout_s: float = 120.0,
                 zero_data_retention: Optional[bool] = None):
        self.model = model
        self.api_key  = api_key or os.environ.get('ANTHROPIC_API_KEY') or ''
        self.base_url = base_url or os.environ.get('ANTHROPIC_BASE_URL') or None
        self.max_tokens = int(max_tokens)
        self.timeout_s = float(request_timeout_s)
        # ZDR is an opt-in Anthropic feature that requires per-account
        # enrollment. Sending the `anthropic-beta: zero-data-retention`
        # header on accounts that aren't enrolled used to be a no-op but
        # the API now strict-validates beta values and rejects with HTTP
        # 400 if you ask for one you don't have. Default is therefore
        # OFF; the dashboard can flip it on via ROBOAI_PBD_ZERO_DATA_RETENTION=1
        # for accounts that actually have ZDR turned on with Anthropic.
        if zero_data_retention is None:
            zero_data_retention = (os.environ.get('ROBOAI_PBD_ZERO_DATA_RETENTION', '') == '1')
        self.zero_data_retention = bool(zero_data_retention)
        self.backend_id = f'api:{model}'

    # ── Contract ────────────────────────────────────────────────────

    def understand(self,
                   frames:                List[str],
                   transcript:            str,
                   context:               Dict[str, Any],
                   parts_library:         List[Dict[str, Any]],
                   available_operations:  List[str],
                   retrieved_examples:    List[Dict[str, Any]]) -> BackendResult:
        if not self.api_key:
            return self._error_result(
                'ANTHROPIC_API_KEY not set — configure the key (env var or '
                'systemd EnvironmentFile) or switch backend to "local".'
            )

        ops = list(available_operations) or list(AVAILABLE_OPERATIONS)
        sys = _system_prompt(ops)
        user_blocks = _user_content(
            transcript, parts_library, context, retrieved_examples, frames,
        )

        try:
            client = _anthropic_client(self.api_key, self.base_url)
        except BackendApiUnavailable as e:
            return self._error_result(str(e))

        # Anthropic's API strict-validates `anthropic-beta` header values
        # and rejects requests asking for ZDR unless the account is
        # actually enrolled for it (HTTP 400 "Unexpected value(s) for the
        # anthropic-beta header"). Default is OFF; flip ON only after
        # verifying ZDR enrollment on the workspace this key belongs to
        # via the Anthropic Console — then either pass zero_data_retention=True
        # to the constructor, or set env ROBOAI_PBD_ZERO_DATA_RETENTION=1.
        extra_headers: Dict[str, str] = {}
        if self.zero_data_retention:
            extra_headers['anthropic-beta'] = 'zero-data-retention'

        try:
            resp = client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                system=sys,
                messages=[{'role': 'user', 'content': user_blocks}],
                timeout=self.timeout_s,
                extra_headers=extra_headers,
            )
        except Exception as e:
            return self._error_result(f'Anthropic API request failed: {e}')

        text_chunks: List[str] = []
        for block in (getattr(resp, 'content', None) or []):
            t = getattr(block, 'text', None)
            if t:
                text_chunks.append(t)
        raw_text = '\n'.join(text_chunks).strip()
        intent = _parse_intent_json(raw_text, parts_library, ops)
        intent.backend_id = self.backend_id
        intent.transited_externally = True
        return BackendResult(
            intent=intent,
            backend_id=self.backend_id,
            transited_externally=True,
            raw_response_text=raw_text,
            used_examples=list(retrieved_examples or []),
            error=None,
        )

    # ── Helpers ─────────────────────────────────────────────────────

    def _error_result(self, msg: str) -> BackendResult:
        intent = StructuredIntent(
            task_summary='',
            operations=[],
            ambiguities=[msg],
            confidence_overall=0.0,
            raw_understanding_notes='backend error: ' + msg,
            backend_id=self.backend_id,
            transited_externally=False,    # nothing left this machine
        )
        return BackendResult(
            intent=intent,
            backend_id=self.backend_id,
            transited_externally=False,
            raw_response_text='',
            used_examples=[],
            error=msg,
        )


# ── Response parsing ────────────────────────────────────────────────

_FENCE_RE = re.compile(r'^\s*```(?:json)?\s*|\s*```\s*$', re.MULTILINE)


def _parse_intent_json(text: str,
                       parts_library: List[Dict[str, Any]],
                       available_operations: List[str]) -> StructuredIntent:
    """Tolerantly extract the JSON object from the model's reply and
    validate-coerce it into a StructuredIntent. Bad operation types
    flip to ambiguity, bad part_ids flip to unknown, poses always
    coerce to placeholder so a hallucinated coordinate can't leak
    downstream."""
    raw = _FENCE_RE.sub('', text or '').strip()
    # If the model still wrote prose, try to slice out the first {...}.
    if not raw.startswith('{'):
        m = re.search(r'\{[\s\S]*\}', raw)
        if m:
            raw = m.group(0)
    try:
        data = json.loads(raw) if raw else {}
    except Exception:
        return StructuredIntent(
            task_summary='',
            ambiguities=[f'Backend produced non-JSON output (first 200 chars): {text[:200]!r}'],
            raw_understanding_notes=text[:2000],
        )

    valid_ops = set(available_operations)
    parts_index = {(p.get('part_id') or '').lower(): p for p in parts_library or []}
    valid_sources = {SOURCE_VIDEO, SOURCE_NARRATION, SOURCE_BOTH}

    ambiguities: List[str] = list(data.get('ambiguities') or [])

    # ── scene ───────────────────────────────────────────────────────
    scene_raw = data.get('scene') or {}
    scene_objects: List[SceneObject] = []
    for obj in (scene_raw.get('objects') or []):
        mp = obj.get('matched_part_id')
        mp_id: Optional[str] = None
        mp_name: Optional[str] = None
        if mp:
            mp_str = str(mp).lower()
            if mp_str in parts_index:
                mp_id   = parts_index[mp_str].get('part_id') or mp_str
                mp_name = (str(obj.get('matched_part_name'))
                           if obj.get('matched_part_name')
                           else parts_index[mp_str].get('name') or '')
            else:
                ambiguities.append(
                    f'Scene object {str(obj.get("label") or "?")!r} '
                    f'referenced matched_part_id {mp_str!r} which is not '
                    f'in the parts library — left unmatched.'
                )
        src = str(obj.get('source') or SOURCE_BOTH).lower()
        if src not in valid_sources:
            src = SOURCE_BOTH
        scene_objects.append(SceneObject(
            label=str(obj.get('label') or ''),
            matched_part_id=mp_id,
            matched_part_name=mp_name,
            match_confidence=float(obj.get('match_confidence') or 0.0),
            source=src,
            approx_location=str(obj.get('approx_location') or ''),
            count_seen=obj.get('count_seen', 1),
        ))

    scene_locations: List[SceneLocation] = []
    for loc in (scene_raw.get('locations') or []):
        src = str(loc.get('source') or SOURCE_BOTH).lower()
        if src not in valid_sources:
            src = SOURCE_BOTH
        scene_locations.append(SceneLocation(
            label=str(loc.get('label') or ''),
            role=str(loc.get('role') or 'other'),
            approx_position=str(loc.get('approx_position') or ''),
            source=src,
        ))

    scene = Scene(
        objects=scene_objects,
        locations=scene_locations,
        spatial_summary=str(scene_raw.get('spatial_summary') or ''),
    )

    # ── operations ──────────────────────────────────────────────────
    ops_out: List[IntentOperation] = []
    for idx, op in enumerate(data.get('operations') or []):
        op_type = str((op or {}).get('operation_type') or '').lower()
        if op_type not in valid_ops:
            ambiguities.append(
                f'Backend proposed unsupported operation {op_type!r}; '
                f'dropped from draft. (Available: {sorted(valid_ops)})'
            )
            continue
        tp = (op.get('target_part') or {})
        pid = str(tp.get('part_id') or 'unknown').lower()
        if pid != 'unknown' and pid not in parts_index:
            ambiguities.append(
                f'Backend referenced part_id {pid!r} that is not in the library — flagged unknown'
            )
            pid_eff = 'unknown'
            source = 'unknown_part_not_in_library'
        else:
            pid_eff = pid
            source = str(tp.get('source') or 'matched_to_library')
        # Count / pattern (Task 1 §2, 2026-07-28). Reconcile the legacy
        # `count_hint` ('all' | int) with the new canonical `count` (int).
        # Any positive int wins; 'all' or missing → 1. The from_dict path
        # in schema.py does the same coercion — this parser mirrors it
        # exactly because compose_program_draft is called on the in-memory
        # StructuredIntent this function returns (NOT on a JSON round-
        # trip), so a field the parser drops is a field the composer
        # never sees.
        raw_count = op.get('count')
        if raw_count is None:
            raw_count = op.get('count_hint')
        try:
            if raw_count is None or (isinstance(raw_count, str)
                                     and raw_count.strip().lower() == 'all'):
                count_i = 1
            else:
                count_i = max(1, int(raw_count))
        except (TypeError, ValueError):
            count_i = 1
        _PICK_PATTERNS_LOCAL  = {'individual_taught', 'repeat_offset', 'vision_each'}
        _PLACE_PATTERNS_LOCAL = {'fixed', 'stack', 'repeat_offset'}
        pp_raw = str(op.get('pick_pattern') or '').strip().lower()
        pick_pattern_i = pp_raw if pp_raw in _PICK_PATTERNS_LOCAL else 'individual_taught'
        ppl_raw = str(op.get('place_pattern') or '').strip().lower()
        place_pattern_i = ppl_raw if ppl_raw in _PLACE_PATTERNS_LOCAL else 'fixed'
        def _f_or_none(v):
            if v is None or v == '':
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        # Effector / source / pallet also flow through here (they always
        # did, but the parser dropped them — legacy composed drafts came
        # out with defaults instead of the model's choice). Fixed at the
        # same time as count/pattern so we don't ship a still-partial
        # parser.
        _EFFECTORS_LOCAL = {'finger', 'vacuum', 'magnetic'}
        _SOURCES_LOCAL   = {'fixed_position', 'camera_library'}
        eff_raw = str(op.get('effector') or '').strip().lower()
        effector_i = eff_raw if eff_raw in _EFFECTORS_LOCAL else 'finger'
        src_raw = str(op.get('source') or '').strip().lower()
        source_i = src_raw if src_raw in _SOURCES_LOCAL else 'fixed_position'
        pallet_i = None
        if op_type in ('palletize', 'depalletize') and op.get('pallet'):
            from ..schema import PalletSpec as _PalletSpec
            pallet_i = _PalletSpec.from_dict(op.get('pallet'))
        ops_out.append(IntentOperation(
            operation_type=op_type,
            target_part=PartReference(
                part_id=pid_eff,
                name=str(tp.get('name') or (parts_index.get(pid_eff, {}).get('name') or '')),
                confidence=float(tp.get('confidence') or 0.0),
                source=source,
            ),
            sequence_index=int(op.get('sequence_index') or (idx + 1)),
            count_hint=op.get('count_hint') if op.get('count_hint') is not None else 'all',
            count=count_i,
            pick_pattern=pick_pattern_i,
            pick_pitch_dx_mm=_f_or_none(op.get('pick_pitch_dx_mm')),
            pick_pitch_dy_mm=_f_or_none(op.get('pick_pitch_dy_mm')),
            place_pattern=place_pattern_i,
            place_stack_dz_mm=_f_or_none(op.get('place_stack_dz_mm')),
            place_pitch_dx_mm=_f_or_none(op.get('place_pitch_dx_mm')),
            place_pitch_dy_mm=_f_or_none(op.get('place_pitch_dy_mm')),
            pick=PoseSlot(
                location_hint=str((op.get('pick') or {}).get('location_hint') or ''),
                pose=None,
                pose_status=POSE_AWAITING_PERCEPTION,
                region=_locationregion_from_dict((op.get('pick') or {}).get('region')),
            ),
            place=PoseSlot(
                location_hint=str((op.get('place') or {}).get('location_hint') or ''),
                pose=None,
                pose_status=POSE_AWAITING_PERCEPTION,
                region=_locationregion_from_dict((op.get('place') or {}).get('region')),
            ),
            pallet=pallet_i,
            notes=str(op.get('notes') or ''),
            source=source_i,
            effector=effector_i,
        ))

    intent = StructuredIntent(
        task_summary=str(data.get('task_summary') or ''),
        scene=scene,
        operations=ops_out,
        ambiguities=ambiguities,
        confidence_overall=float(data.get('confidence_overall') or 0.0),
        raw_understanding_notes=str(data.get('raw_understanding_notes') or ''),
    )
    # 2026-08-01 §1c: run fusion AFTER the raw parse so the intent
    # returned to the pipeline already has positions[] populated and
    # each pick/place's location_ref filled. Fusion is deterministic
    # and runs pure Python — no model call. A re-invocation on the
    # stored intent (see fusion.refuse_intent) produces the same
    # result, so re-composing an older demo picks up the new rules
    # without a network round-trip.
    fuse_positions(intent)
    return intent

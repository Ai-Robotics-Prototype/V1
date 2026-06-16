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
from typing import Any, Dict, List, Optional

from ..schema import (
    AVAILABLE_OPERATIONS,
    IntentOperation,
    PartReference,
    PoseSlot,
    StructuredIntent,
    POSE_AWAITING_PERCEPTION,
)
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
with voice narration showing/describing a robot task they want
programmed. Your job is to produce a STRICT JSON StructuredIntent that
RoboAi will use as input to a deterministic program composer.

CRITICAL RULES — violating any of these makes the output unusable:

  1) operation_type MUST be one of EXACTLY this set (no other value):
{ops_list}

  2) target_part MUST be grounded to a real part from the provided
     parts library by part_id. If you cannot match it confidently,
     emit:
        "part_id": "unknown",
        "source":  "unknown_part_not_in_library",
        "confidence": 0.0,
     and add an entry to ambiguities explaining what part appeared.
     NEVER invent part_ids.

  3) DO NOT produce numeric poses. Every pose value MUST be:
        "pose": null,
        "pose_status": "awaiting_perception",
        "location_hint": "<short human-readable spatial cue>"
     RoboAi's perception stack resolves the metric pose later. Your
     job is to capture the human INTENT, not coordinates.

  4) Surface things you are unsure about in `ambiguities` — these are
     the questions a human reviewer will resolve next.

  5) Output ONLY a JSON object matching the schema below. No prose,
     no markdown fences, no commentary.

Schema:
{schema_example}
"""


SCHEMA_EXAMPLE = """\
{
  "task_summary": "Pick BT225L24 brackets from the bin and place them on the left tray",
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
      "pick":  { "location_hint": "from the bin on the right",  "pose": null, "pose_status": "awaiting_perception" },
      "place": { "location_hint": "onto the left tray",          "pose": null, "pose_status": "awaiting_perception" },
      "notes": ""
    }
  ],
  "ambiguities": [
    "Operator mentioned 'the other tray' but only one tray was clearly visible"
  ],
  "confidence_overall": 0.74,
  "raw_understanding_notes": "Brief one-liner about what was visually anchored"
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
                  frame_paths: List[str]) -> List[Dict[str, Any]]:
    """Build the message content list. Anthropic wants {type: image} and
    {type: text} blocks; order matters — keep the grounding text
    before the frames so the model reads constraints first."""
    blocks: List[Dict[str, Any]] = []

    grounding = {
        'transcript':          transcript,
        'context':             context or {},
        'parts_library':       parts_library or [],
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

    if frame_paths:
        blocks.append({'type': 'text', 'text': f'Video frames ({len(frame_paths)} sampled):'})
        for p in frame_paths:
            try:
                media_type, b64 = read_b64_jpeg(p)
            except Exception:
                continue
            blocks.append({
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': media_type,
                    'data': b64,
                },
            })

    blocks.append({'type': 'text',
                   'text': 'Produce the StructuredIntent JSON now.'})
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

    ops_out: List[IntentOperation] = []
    ambiguities = list(data.get('ambiguities') or [])
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
            pick=PoseSlot(
                location_hint=str((op.get('pick') or {}).get('location_hint') or ''),
                pose=None,
                pose_status=POSE_AWAITING_PERCEPTION,
            ),
            place=PoseSlot(
                location_hint=str((op.get('place') or {}).get('location_hint') or ''),
                pose=None,
                pose_status=POSE_AWAITING_PERCEPTION,
            ),
            notes=str(op.get('notes') or ''),
        ))

    return StructuredIntent(
        task_summary=str(data.get('task_summary') or ''),
        operations=ops_out,
        ambiguities=ambiguities,
        confidence_overall=float(data.get('confidence_overall') or 0.0),
        raw_understanding_notes=str(data.get('raw_understanding_notes') or ''),
    )

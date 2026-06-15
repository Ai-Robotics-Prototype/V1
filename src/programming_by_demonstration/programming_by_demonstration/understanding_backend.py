"""Abstract contract for any model that turns a demonstration into a
StructuredIntent. Every backend (Claude, future on-Jetson, fakes for
tests) implements the same `understand()` signature so the rest of the
system is backend-blind. Swapping a backend is one config value:

    pbd_node:
      ros__parameters:
        backend: api          # or 'local'

Two implementations ship today:
  - backends.api_backend.AnthropicClaudeBackend  — strong external model
  - backends.local_backend.LocalBackendStub      — explicit "not yet trained"

The api_backend is the ONLY place that talks to the external provider.
Keeping the surface narrow here lets us delete that file in a single
diff once the local model lands."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .schema import StructuredIntent


@dataclass
class BackendResult:
    """What every backend returns. Wraps the intent plus enough provenance
    that the learning store can record where it came from."""
    intent:               StructuredIntent
    backend_id:           str                = ''   # 'api:claude-opus-4-7' / 'local:stub'
    transited_externally: bool               = False
    raw_response_text:    str                = ''   # optional, for audit
    used_examples:        List[Dict[str, Any]] = field(default_factory=list)
    error:                Optional[str]      = None


class UnderstandingBackend(ABC):
    """The contract. Implementations must be stateless w.r.t. user data —
    no caching of frames, no persisting prompts. Anything the system
    needs to remember goes through the LearningStore, not the backend."""

    backend_id: str = 'unset'
    transits_externally: bool = False

    @abstractmethod
    def understand(self,
                   frames:                List[str],
                   transcript:            str,
                   context:               Dict[str, Any],
                   parts_library:         List[Dict[str, Any]],
                   available_operations:  List[str],
                   retrieved_examples:    List[Dict[str, Any]]) -> BackendResult:
        """Args:
            frames:               file paths to extracted JPEG frames
            transcript:           Whisper transcript (string, may be empty)
            context:              workspace info (fixtures, zones, units)
            parts_library:        list of {part_id, name, extents_cm, ...}
            available_operations: subset of schema.AVAILABLE_OPERATIONS
            retrieved_examples:   few-shot examples produced by retrieval_augment

        The returned intent MUST satisfy the grounding rules:
          - every operation_type in available_operations or marked ambiguous
          - every target_part has either a real part_id from parts_library
            or part_id='unknown' with source='unknown_part_not_in_library'
          - every pose is null + pose_status='awaiting_perception'
        """


# ── Factory ─────────────────────────────────────────────────────────

def build_backend(name: str, params: Dict[str, Any]) -> UnderstandingBackend:
    """Resolve a backend by name. Keeps callers from importing concrete
    backends directly — the only place a switch on backend type lives
    is here. Adding a third backend means a third elif and nothing else.

    `name` defaults to "api" when blank so the dashboard's pass-through
    of a missing config field still produces a working backend."""
    n = (name or 'api').strip().lower()
    if n in ('api', 'anthropic', 'claude'):
        from .backends.api_backend import AnthropicClaudeBackend
        return AnthropicClaudeBackend(**(params or {}))
    if n in ('local', 'stub', 'jetson'):
        from .backends.local_backend import LocalBackendStub
        return LocalBackendStub(**(params or {}))
    raise ValueError(f'unknown backend: {name!r}')

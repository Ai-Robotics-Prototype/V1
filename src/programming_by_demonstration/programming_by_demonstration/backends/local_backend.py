"""On-Jetson local understanding backend — stub.

This is the future home of RoboAi's own distilled multimodal model,
trained on the proprietary corpus the LearningStore accumulates. The
interface is identical to the API backend so flipping the config from
"api" to "local" is the only change needed once the model lands.

Today the stub returns a clearly-labelled "not yet trained" intent so
callers (and the dashboard) see a well-formed response instead of
crashing.
"""

from __future__ import annotations

from typing import Any, Dict, List

from ..schema import StructuredIntent
from ..understanding_backend import BackendResult, UnderstandingBackend


class LocalBackendStub(UnderstandingBackend):
    """Always returns an empty intent with an ambiguity describing the
    stub's status. Once a real on-Jetson model is dropped in, this
    class is replaced wholesale — the rest of the pipeline doesn't
    change because it only consumes BackendResult."""

    transits_externally = False     # local backend never leaves the machine

    def __init__(self, **_ignored):
        self.backend_id = 'local:stub'

    def understand(self,
                   frames:               List[str],
                   transcript:           str,
                   context:              Dict[str, Any],
                   parts_library:        List[Dict[str, Any]],
                   available_operations: List[str],
                   retrieved_examples:   List[Dict[str, Any]]) -> BackendResult:
        msg = (
            'Local on-Jetson understanding model is not yet trained. '
            'Flip pbd_node.backend back to "api" until the local model '
            'replaces this stub. The learning store is meanwhile '
            'accumulating training data for that model.'
        )
        return BackendResult(
            intent=StructuredIntent(
                task_summary='',
                operations=[],
                ambiguities=[msg],
                confidence_overall=0.0,
                raw_understanding_notes=msg,
                backend_id=self.backend_id,
                transited_externally=False,
            ),
            backend_id=self.backend_id,
            transited_externally=False,
            raw_response_text='',
            used_examples=list(retrieved_examples or []),
            error=None,
        )

"""Programming by Demonstration — public surface."""

from .schema import (
    AVAILABLE_OPERATIONS,
    POSE_AWAITING_PERCEPTION,
    StructuredIntent,
    ProgramDraft,
)
from .learning_store import LearningStore
from .program_composer import compose_program_draft
from .understanding_backend import UnderstandingBackend, BackendResult

__all__ = [
    'AVAILABLE_OPERATIONS',
    'POSE_AWAITING_PERCEPTION',
    'StructuredIntent',
    'ProgramDraft',
    'LearningStore',
    'compose_program_draft',
    'UnderstandingBackend',
    'BackendResult',
]

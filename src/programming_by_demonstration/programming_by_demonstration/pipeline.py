"""High-level orchestration shared by the ROS node and the dashboard
HTTP endpoints. Keeps the steps in ONE place so both call sites stay
consistent:

    upload + transcribe → retrieval → understand → compose → store

All side effects go through the LearningStore. The pipeline does NOT
talk to the program library directly — that's the dashboard's job
(POST /api/programs uses the existing wizard endpoint), so the
acceptance step can save the human-corrected program through the
same path the wizard does.
"""

from __future__ import annotations

import json
import os
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .backends.retrieval_augment import retrieve_examples
from .learning_store import LearningStore
from .program_composer import compose_program_draft
from .schema import (
    AVAILABLE_OPERATIONS,
    ProgramDraft,
    StructuredIntent,
)
from .understanding_backend import (
    BackendResult,
    UnderstandingBackend,
    build_backend,
)
from .utils import (
    extract_audio_wav,
    extract_frames,
    mint_demo_id,
    now_iso,
    parts_library_summary,
    FFmpegMissing,
)
from .voice_transcriber import (
    TranscriberUnavailable,
    VoiceTranscriber,
)


@dataclass
class PipelineConfig:
    demonstrations_dir: str = '/opt/cobot/demonstrations'
    programs_dir:       str = '/opt/cobot/programs'

    backend:                  str   = 'api'
    backend_params:           Dict[str, Any] = field(default_factory=dict)

    whisper_model:            str   = 'base.en'
    whisper_device:           str   = 'auto'
    whisper_compute:          str   = 'int8'

    frame_sample_fps:         float = 1.0
    frame_max_count:          int   = 20
    frame_resize_long_edge_px: int  = 768
    frame_jpeg_quality:       int   = 82

    retrieval_enabled:        bool  = True
    retrieval_k:              int   = 3
    retrieval_min_score:      float = 0.10


@dataclass
class PipelineResult:
    ok: bool
    demo_id: str
    intent: Optional[StructuredIntent] = None
    draft:  Optional[ProgramDraft]     = None
    transcript_text: str = ''
    used_examples: List[Dict[str, Any]] = field(default_factory=list)
    backend_id: str = ''
    transited_externally: bool = False
    error: Optional[str] = None
    stages_done: List[str] = field(default_factory=list)


class Pipeline:
    def __init__(self,
                 cfg: PipelineConfig,
                 store: Optional[LearningStore] = None,
                 transcriber: Optional[VoiceTranscriber] = None,
                 backend: Optional[UnderstandingBackend] = None,
                 parts_provider: Optional[Callable[[], List[Dict[str, Any]]]] = None,
                 logger: Optional[Callable[[str], None]] = None):
        self.cfg   = cfg
        self.store = store or LearningStore(cfg.demonstrations_dir)
        self._logger = logger or (lambda _msg: None)
        self._transcriber = transcriber
        self._backend = backend
        # parts_provider lets the dashboard hand us its existing
        # part_library reader without pbd having to import it.
        self._parts_provider = parts_provider or (lambda: [])

    # ── Setters / lazy builders ───────────────────────────────────

    def _ensure_transcriber(self) -> VoiceTranscriber:
        if self._transcriber is None:
            self._transcriber = VoiceTranscriber(
                model_name=self.cfg.whisper_model,
                device=self.cfg.whisper_device,
                compute_type=self.cfg.whisper_compute,
            )
        return self._transcriber

    def _ensure_backend(self) -> UnderstandingBackend:
        if self._backend is None:
            self._backend = build_backend(self.cfg.backend, self.cfg.backend_params or {})
        return self._backend

    # ── Top-level entry point ──────────────────────────────────────

    def run_from_upload(self, video_path: str,
                        demo_id: Optional[str] = None,
                        backend_override: Optional[str] = None) -> PipelineResult:
        demo_id = demo_id or mint_demo_id()
        self.store.ensure_demo_dir(demo_id)
        self._log(f'[{demo_id}] start; video={video_path}')

        # 1. Save the original upload into the learning store. Even if
        #    later stages fail the upload is preserved so re-runs and
        #    training-data export still have something to work with.
        try:
            saved = self.store.save_upload(demo_id, video_path,
                                           original_filename=os.path.basename(video_path))
            self._log(f'[{demo_id}] saved upload at {saved}')
        except Exception as e:
            return self._fail(demo_id, f'save_upload failed: {e}', stage='upload')

        result = PipelineResult(ok=False, demo_id=demo_id)
        result.stages_done.append('upload')

        # 2. Extract audio + transcribe locally (Whisper).
        try:
            wav = os.path.join(self.store.dir_for(demo_id), 'audio.wav')
            extract_audio_wav(saved, wav)
            transcript = self._ensure_transcriber().transcribe(wav)
        except FFmpegMissing as e:
            return self._fail(demo_id, str(e), stage='transcribe')
        except TranscriberUnavailable as e:
            return self._fail(demo_id, str(e), stage='transcribe')
        except Exception as e:
            return self._fail(demo_id, f'transcription failed: {e}', stage='transcribe')
        self.store.save_transcript(demo_id, transcript)
        result.transcript_text = transcript.get('text') or ''
        result.stages_done.append('transcribe')
        self._log(f'[{demo_id}] transcript ({len(result.transcript_text)} chars)')

        # 3. Extract frames at low fps + JPEG-encode for the backend.
        frames_dir = os.path.join(self.store.dir_for(demo_id), 'frames')
        try:
            frame_paths = extract_frames(
                saved, frames_dir,
                fps=self.cfg.frame_sample_fps,
                max_count=self.cfg.frame_max_count,
                long_edge_px=self.cfg.frame_resize_long_edge_px,
                jpeg_quality=self.cfg.frame_jpeg_quality,
            )
        except FFmpegMissing as e:
            return self._fail(demo_id, str(e), stage='frames')
        except Exception as e:
            return self._fail(demo_id, f'frame extraction failed: {e}', stage='frames')
        result.stages_done.append('frames')
        self._log(f'[{demo_id}] extracted {len(frame_paths)} frames')

        # 4. Few-shot retrieval (only from human-corrected past demos).
        parts_library = self._parts_provider() or []
        retrieved: List[Dict[str, Any]] = []
        if self.cfg.retrieval_enabled:
            try:
                corpus = list(self.store.iter_corrected_entries())
                retrieved = retrieve_examples(
                    transcript=result.transcript_text,
                    part_ids=[p.get('part_id') or p.get('id') or '' for p in parts_library],
                    operations=list(AVAILABLE_OPERATIONS),
                    corpus=corpus,
                    k=self.cfg.retrieval_k,
                    min_score=self.cfg.retrieval_min_score,
                )
            except Exception as e:
                # Retrieval is advisory — don't fail the whole pipeline.
                self._log(f'[{demo_id}] retrieval failed (non-fatal): {e}')
                retrieved = []
        result.used_examples = list(retrieved)
        result.stages_done.append('retrieval')

        # 5. Understanding backend (API or local stub).
        backend = (
            build_backend(backend_override, self.cfg.backend_params)
            if backend_override else
            self._ensure_backend()
        )
        try:
            br: BackendResult = backend.understand(
                frames=frame_paths,
                transcript=result.transcript_text,
                context={'units': 'mm/deg', 'workspace': 'tabletop'},
                parts_library=parts_library_summary(parts_library),
                available_operations=list(AVAILABLE_OPERATIONS),
                retrieved_examples=retrieved,
            )
        except Exception as e:
            return self._fail(
                demo_id,
                f'backend.understand crashed: {e}\n{traceback.format_exc(limit=2)}',
                stage='understand',
            )
        intent = br.intent
        result.backend_id = br.backend_id
        result.transited_externally = br.transited_externally
        self.store.save_intent(demo_id, intent.to_dict())
        self.store.save_backend_used(
            demo_id, br.backend_id, br.transited_externally,
            extra={'error': br.error or '', 'used_examples_count': len(retrieved)},
        )
        if br.error:
            # The backend already produced an intent (with the error in
            # ambiguities) — don't crash, but flag so the dashboard can
            # show a warning. Composition still runs so an empty draft
            # is saved.
            self._log(f'[{demo_id}] backend reported error: {br.error}')
        result.intent = intent
        result.stages_done.append('understand')

        # 6. Compose a draft program from the intent.
        draft = compose_program_draft(intent, demo_id)
        self.store.save_draft(demo_id, draft.to_program_payload())
        result.draft = draft
        result.stages_done.append('compose')

        # 7. Index metadata (drives /api/pbd/dataset/stats + retrieval).
        meta = {
            'demo_id':       demo_id,
            'created_at':    now_iso(),
            'task_summary':  intent.task_summary,
            'transcript':    result.transcript_text,
            'backend': {
                'backend_id':            br.backend_id,
                'transited_externally':  br.transited_externally,
            },
            'part_ids':      [op.target_part.part_id for op in intent.operations
                              if op.target_part and op.target_part.part_id
                              and op.target_part.part_id != 'unknown'],
            'operations':    [op.operation_type for op in intent.operations],
            'ambiguities':   list(intent.ambiguities),
            'confidence':    float(intent.confidence_overall or 0.0),
            'correction_made': False,
            'retrieval': {
                'used_examples': [
                    {'demo_id': e.get('demo_id'), 'score': e.get('_score')}
                    for e in retrieved
                ],
            },
        }
        self.store.save_metadata(demo_id, meta)
        result.stages_done.append('index')

        result.ok = True
        result.error = br.error          # surface the backend's own error if any
        return result

    # ── Acceptance: human corrected the draft → write back ─────────

    def accept_correction(self, demo_id: str,
                          corrected_program: Dict[str, Any],
                          program_id: Optional[str] = None) -> Dict[str, Any]:
        """Called when the operator clicks Accept. The dashboard saves
        the program through the existing /api/programs endpoint and
        hands us the slug; we record it as the highest-value training
        signal."""
        self.store.save_correction(demo_id, corrected_program, program_id=program_id)
        return {'ok': True, 'demo_id': demo_id, 'program_id': program_id}

    # ── Internals ──────────────────────────────────────────────────

    def _fail(self, demo_id: str, msg: str, stage: str) -> PipelineResult:
        self._log(f'[{demo_id}] FAIL ({stage}): {msg}')
        # Always write a metadata stub so the dashboard can list the
        # demonstration even when generation failed.
        try:
            self.store.save_metadata(demo_id, {
                'demo_id':         demo_id,
                'created_at':      now_iso(),
                'task_summary':    '',
                'transcript':      '',
                'backend':         {'backend_id': self.cfg.backend, 'transited_externally': False},
                'part_ids':        [],
                'operations':      [],
                'ambiguities':     [f'pipeline failed at {stage}: {msg}'],
                'confidence':      0.0,
                'correction_made': False,
                'failure':         {'stage': stage, 'message': msg},
            })
        except Exception:
            pass
        return PipelineResult(ok=False, demo_id=demo_id, error=msg,
                              stages_done=[stage])

    def _log(self, msg: str) -> None:
        try:
            self._logger(msg)
        except Exception:
            pass


# ── Convenience: read params dict directly from rclpy ─────────────

def pipeline_config_from_params(get: Callable[[str], Any]) -> PipelineConfig:
    """Pull values out of a parameter accessor (rclpy's get_parameter().value)
    with safe defaults — used by pbd_node so the node and the dashboard
    construct the same config."""
    return PipelineConfig(
        demonstrations_dir=str(get('demonstrations_dir') or '/opt/cobot/demonstrations'),
        programs_dir=str(get('programs_dir') or '/opt/cobot/programs'),
        backend=str(get('backend') or 'api'),
        backend_params={
            'model':               str(get('api_model') or 'claude-opus-4-7'),
            'max_tokens':          int(get('api_max_tokens') or 4096),
            'request_timeout_s':   float(get('api_request_timeout_s') or 120.0),
            # Defaults to False — see api_backend.AnthropicClaudeBackend.__init__
            # for why (Anthropic rejects the ZDR beta unless enrolled).
            'zero_data_retention': bool(get('api_zero_data_retention') if get('api_zero_data_retention') is not None else False),
        },
        whisper_model=str(get('whisper_model') or 'base.en'),
        whisper_device=str(get('whisper_device') or 'auto'),
        whisper_compute=str(get('whisper_compute') or 'int8'),
        frame_sample_fps=float(get('frame_sample_fps') or 1.0),
        frame_max_count=int(get('frame_max_count') or 20),
        frame_resize_long_edge_px=int(get('frame_resize_long_edge_px') or 768),
        frame_jpeg_quality=int(get('frame_jpeg_quality') or 82),
        retrieval_enabled=bool(get('retrieval_enabled') if get('retrieval_enabled') is not None else True),
        retrieval_k=int(get('retrieval_k') or 3),
        retrieval_min_score=float(get('retrieval_min_score') or 0.10),
    )

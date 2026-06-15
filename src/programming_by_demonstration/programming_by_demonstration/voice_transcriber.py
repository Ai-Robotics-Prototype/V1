"""Local audio -> transcript using faster-whisper (CTranslate2).

Lazy-imports so the package builds and the dashboard endpoints come up
even before faster_whisper is installed. Calling transcribe() without
the dep raises TranscriberUnavailable with a clear install hint.

Install on Jetson AGX Orin:
    pip3 install --user faster-whisper

The first call downloads the model (Hugging Face cache). For
production Orin builds we recommend `tiny.en` or `base.en`; `small.en`
is fine but takes ~3-5x as long.
"""

from __future__ import annotations

import os
from typing import Optional


class TranscriberUnavailable(RuntimeError):
    pass


_DEFAULT_MODEL_DIR = '/opt/cobot/models/whisper'


class VoiceTranscriber:
    def __init__(self,
                 model_name: str = 'base.en',
                 device: str = 'auto',
                 compute_type: str = 'int8',
                 download_root: Optional[str] = None):
        self.model_name   = model_name
        self.device       = device
        self.compute_type = compute_type
        self.download_root = download_root or _DEFAULT_MODEL_DIR
        self._model = None
        self._import_err: Optional[str] = None

    # ── Lazy load ───────────────────────────────────────────────────

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as e:
            self._import_err = str(e)
            raise TranscriberUnavailable(
                'faster-whisper not installed. Run:\n'
                '    pip3 install --user faster-whisper\n'
                f'(import error: {e})'
            ) from e
        # Pick a safe device. 'auto' tries cuda, falls back to cpu.
        device = self.device
        if device == 'auto':
            try:
                import ctranslate2  # type: ignore
                device = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
            except Exception:
                device = 'cpu'
        try:
            os.makedirs(self.download_root, exist_ok=True)
        except OSError:
            pass
        self._model = WhisperModel(
            self.model_name,
            device=device,
            compute_type=self.compute_type,
            download_root=self.download_root,
        )
        return self._model

    # ── Public API ──────────────────────────────────────────────────

    def transcribe(self, audio_path: str) -> dict:
        """Return {'text': full_text, 'segments': [...], 'language': '...'}.
        Caller is responsible for handing in a 16 kHz mono WAV (see
        utils.extract_audio_wav). faster-whisper will resample as
        needed but pre-converted audio is faster and matches the
        Whisper-canonical pipeline."""
        if not os.path.isfile(audio_path):
            return {'text': '', 'segments': [], 'language': '',
                    'error': f'audio not found: {audio_path}'}

        model = self._load()
        segments, info = model.transcribe(audio_path, beam_size=5)
        seg_list = []
        full_text_parts = []
        for s in segments:
            piece = {
                'start': float(getattr(s, 'start', 0.0) or 0.0),
                'end':   float(getattr(s, 'end',   0.0) or 0.0),
                'text':  str(getattr(s, 'text',  '') or '').strip(),
            }
            seg_list.append(piece)
            if piece['text']:
                full_text_parts.append(piece['text'])
        return {
            'text':     ' '.join(full_text_parts).strip(),
            'segments': seg_list,
            'language': str(getattr(info, 'language', '') or ''),
        }


def is_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False

"""Misc helpers: frame extraction, path/id minting, optional-dep gates."""

from __future__ import annotations

import base64
import datetime as dt
import os
import re
import shutil
import subprocess
import uuid
from typing import List, Optional, Tuple


# ── Paths / ids ────────────────────────────────────────────────────

DEFAULT_DEMOS_DIR = '/opt/cobot/demonstrations'
DEFAULT_PROGRAMS_DIR = '/opt/cobot/programs'


def mint_demo_id() -> str:
    """Time-ordered + random suffix so directory listings sort sanely."""
    ts = dt.datetime.utcnow().strftime('%Y%m%dT%H%M%S')
    return f'demo_{ts}_{uuid.uuid4().hex[:6]}'


def safe_demo_id(s: str) -> Optional[str]:
    """Strict allowlist — demos are referenced by URL, no path traversal."""
    if not s or '..' in s or '/' in s or '\\' in s:
        return None
    return s if re.fullmatch(r'[A-Za-z0-9_\-]{1,128}', s) else None


def demo_dir(root: str, demo_id: str) -> str:
    return os.path.join(root, demo_id)


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


# ── ffmpeg gate ─────────────────────────────────────────────────────

class FFmpegMissing(RuntimeError):
    """Raised when ffmpeg/ffprobe can't be located on PATH."""


def require_ffmpeg() -> str:
    exe = shutil.which('ffmpeg')
    if not exe:
        raise FFmpegMissing(
            "ffmpeg not found on PATH. Install via:\n"
            "    sudo apt-get install -y ffmpeg")
    return exe


# ── Frame + audio extraction ────────────────────────────────────────

def extract_audio_wav(video_path: str, out_path: str) -> str:
    """Strip the audio track into a 16 kHz mono WAV — exactly what Whisper
    consumes natively without an internal ffmpeg call."""
    ffmpeg = require_ffmpeg()
    subprocess.run(
        [ffmpeg, '-y', '-i', video_path,
         '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out_path],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return out_path


def extract_frames(video_path: str, out_dir: str,
                   fps: float = 1.0,
                   max_count: int = 20,
                   long_edge_px: int = 768,
                   jpeg_quality: int = 82) -> List[str]:
    """Sample frames at `fps` fps, resize longest edge to `long_edge_px`,
    write JPEGs into out_dir. Returns sorted file paths.

    `max_count` caps how many frames we keep so a 10-minute clip doesn't
    blow up the API request — we keep the first `max_count` after
    sampling. The first frame and a frame from the end of the clip are
    almost always the most informative, but for v1 a simple cap is
    plenty."""
    ffmpeg = require_ffmpeg()
    ensure_dir(out_dir)
    # Wipe any previous extraction so re-runs don't mix old frames.
    for fn in os.listdir(out_dir):
        if fn.startswith('frame_') and fn.endswith('.jpg'):
            try:
                os.remove(os.path.join(out_dir, fn))
            except OSError:
                pass
    # `scale='if(gt(iw,ih),768,-2)':'if(gt(iw,ih),-2,768)'` keeps aspect
    # ratio while clamping the LONG edge — -2 keeps the other edge even.
    le = int(long_edge_px)
    vf = (
        f"fps={fps},"
        f"scale='if(gt(iw,ih),{le},-2)':'if(gt(iw,ih),-2,{le})'"
    )
    pattern = os.path.join(out_dir, 'frame_%04d.jpg')
    subprocess.run(
        [ffmpeg, '-y', '-i', video_path, '-vf', vf,
         '-q:v', str(max(2, min(31, 31 - int(jpeg_quality * 31 / 100)))),
         pattern],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    frames = sorted(
        os.path.join(out_dir, fn)
        for fn in os.listdir(out_dir)
        if fn.startswith('frame_') and fn.endswith('.jpg')
    )
    if max_count > 0 and len(frames) > max_count:
        # Even sampling so a long clip's late context isn't lost.
        step = len(frames) / float(max_count)
        kept_idx = {int(i * step) for i in range(max_count)}
        keep = [p for i, p in enumerate(frames) if i in kept_idx]
        for p in frames:
            if p not in keep:
                try:
                    os.remove(p)
                except OSError:
                    pass
        frames = keep
    return frames


def read_b64_jpeg(path: str) -> Tuple[str, str]:
    """Return (media_type, base64) for a JPEG on disk."""
    with open(path, 'rb') as f:
        return 'image/jpeg', base64.standard_b64encode(f.read()).decode('ascii')


# ── Misc small helpers ──────────────────────────────────────────────

def now_iso() -> str:
    return dt.datetime.utcnow().isoformat(timespec='seconds') + 'Z'


def slugify(s: str, fallback: str = 'demonstration') -> str:
    s = re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')
    return s or fallback


def parts_library_summary(parts: list) -> list:
    """Strip the heavy fields from the parts library so prompts and
    retrieval inputs stay small."""
    out = []
    for p in parts or []:
        out.append({
            'part_id': p.get('id') or '',
            'name':    p.get('name') or '',
            'extents_cm': p.get('extents_cm') or None,
        })
    return out

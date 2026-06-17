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


def probe_duration_s(video_path: str) -> float:
    """Return the clip duration in seconds, or 0.0 if ffprobe fails."""
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        return 0.0
    try:
        out = subprocess.check_output(
            [ffprobe, '-v', 'error',
             '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1',
             video_path],
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).decode('ascii', errors='ignore').strip()
        return float(out or 0.0)
    except Exception:
        return 0.0


def extract_frames(video_path: str, out_dir: str,
                   fps: float = 1.0,
                   max_count: int = 20,
                   long_edge_px: int = 768,
                   jpeg_quality: int = 82) -> List[Tuple[str, float]]:
    """Sample the clip at `fps` fps and return an ORDERED list of
    `(jpeg_path, timestamp_seconds)` pairs.

    Key-moment guarantees so the backend sees the full arc:
      • The first sampled frame (≈ t=0) — initial scene state.
      • The last sampled frame (≈ t=duration) — final state after the
        demonstrated action.
      • Interior frames spread uniformly between them.

    The backend uses timestamps to reason about sequence; passing them
    through the prompt lets the model say "frame at 4.0s shows..."
    instead of guessing order from raw image order.

    `max_count` caps payload size for long clips. We sample at `fps`
    first (ffmpeg-cheap), then thin uniformly to `max_count` while
    pinning the first and last frames.
    """
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
    frame_files = sorted(
        os.path.join(out_dir, fn)
        for fn in os.listdir(out_dir)
        if fn.startswith('frame_') and fn.endswith('.jpg')
    )
    if not frame_files:
        return []

    # Reconstruct each kept frame's timestamp from its sampling index
    # (ffmpeg's `fps=` filter is deterministic — frame 1 = 0s,
    # frame 2 = 1/fps, …).
    period_s = 1.0 / float(fps) if fps > 0 else 1.0
    timed = [(p, i * period_s) for i, p in enumerate(frame_files)]

    # If we already fit, keep all. Otherwise thin uniformly, pinning
    # both endpoints so the first/last frames always survive.
    if max_count <= 0 or len(timed) <= max_count:
        return timed

    n = len(timed)
    if max_count == 1:
        idxs = [0]
    elif max_count == 2:
        idxs = [0, n - 1]
    else:
        # max_count points evenly across [0, n-1] inclusive — guarantees
        # 0 and n-1 are in the set.
        step = (n - 1) / float(max_count - 1)
        idxs = sorted({int(round(i * step)) for i in range(max_count)})

    keep = [timed[i] for i in idxs]
    keep_paths = {p for p, _ in keep}
    for p, _ in timed:
        if p not in keep_paths:
            try:
                os.remove(p)
            except OSError:
                pass
    return keep


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

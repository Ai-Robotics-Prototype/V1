"""Always-on joint-state flight recorder.

Snapshot the dashboard's live STATE.joints + program-line join at
25 Hz to gzip'd JSONL segments under /opt/cobot/joint_history/. A
paired run-manifest sidecar records each program-execution window
so /api/runs can list historical runs and /api/runs/{id}/joints can
assemble the samples across segments after the fact — no
pre-arming required to investigate any past run.

Disk hygiene (the load-bearing property, per the 100%-disk incident
that motivated this file's paranoia):

  * Hard cap: 2 GB or 14 days, whichever comes first. Enforced in
    the WRITER before every segment open — never a background cron,
    never a "we'll add it later". If the writer can't guarantee the
    cap holds after its next append, it drops the oldest segment
    first. The recorder can lose old segments (that's the trade
    every rolling log takes); it CANNOT fill the disk.
  * The oldest-first prune runs whenever a segment closes or the
    directory-size check fails at start-up, not just when segments
    rotate — a long run producing many samples per segment gets
    checked mid-flight too (every 30 s in the writer loop).
  * Recorder failures (write refused, disk full despite the cap,
    gzip errors) are caught + logged + suppressed. The recorder
    stays alive; the state pipeline is never touched. Same rule
    as debug dumps.

Sample shape (one JSON per line inside each segment):
    {
      "t":              float  — wall-clock time (seconds since epoch)
      "joints_deg":     [float]*6  — degrees
      "program_id":     str | null
      "program_state":  int (0=idle, 2=running, 3=paused)
      "program_line":   int | null (controller ProjectState line)
      "is_step":        bool  — step-by-step vs continuous run
    }

Manifest shape (one file per run under manifests/):
    {
      "run_id":       "<program_id>_YYYYMMDDTHHMMSS_shortuuid"
      "program_id":   str
      "program_name": str
      "t_start":      float — wall-clock start
      "t_end":        float | null — null while the run is live
      "duration_s":   float | null
      "state_transitions": [{"t": float, "state": int}, ...]
      "segments":     ["<segment filename>", ...]
    }
"""

from __future__ import annotations

import gzip
import json
import math
import os
import threading
import time
import uuid
from typing import Callable

# ── configuration (tuneable via env; sensible defaults matching the task) ─
JOINT_RECORDER_DIR   = os.environ.get(
    'JOINT_RECORDER_DIR', '/opt/cobot/joint_history')
JOINT_RECORDER_HZ    = float(os.environ.get('JOINT_RECORDER_HZ', '25'))
SEGMENT_DURATION_S   = float(os.environ.get(
    'JOINT_RECORDER_SEGMENT_S', '600'))   # 10 min
SEGMENT_MAX_BYTES    = int(float(os.environ.get(
    'JOINT_RECORDER_SEGMENT_MAX_BYTES', '20000000')))  # 20 MB safety cap
RETENTION_BYTES      = int(float(os.environ.get(
    'JOINT_RECORDER_RETENTION_BYTES', str(300 * 1024 * 1024))))  # 300 MB
RETENTION_MAX_AGE_S  = float(os.environ.get(
    'JOINT_RECORDER_RETENTION_AGE_S', str(7 * 86400)))  # 7 days
# Recorder checks retention every N seconds even if no rotation is due
# so a long-running segment can't drift past the cap silently.
RETENTION_CHECK_PERIOD_S = 30.0
# 2026-09-04 operator directive: the size cap must NEVER exceed
# `RETENTION_FREE_FRACTION` of currently-free disk. Enforced at every
# retention pass, so a shrinking disk shrinks the effective cap in
# lockstep. RETENTION_BYTES is the hard MAX; the effective cap is
# `min(RETENTION_BYTES, free_bytes * RETENTION_FREE_FRACTION)`.
RETENTION_FREE_FRACTION = float(os.environ.get(
    'JOINT_RECORDER_FREE_FRACTION', '0.20'))

_MANIFEST_SUBDIR = 'manifests'
_SEGMENT_SUBDIR  = 'segments'


def _ensure_dirs():
    os.makedirs(os.path.join(JOINT_RECORDER_DIR, _SEGMENT_SUBDIR), exist_ok=True)
    os.makedirs(os.path.join(JOINT_RECORDER_DIR, _MANIFEST_SUBDIR), exist_ok=True)


def _segment_dir():
    return os.path.join(JOINT_RECORDER_DIR, _SEGMENT_SUBDIR)


def _manifest_dir():
    return os.path.join(JOINT_RECORDER_DIR, _MANIFEST_SUBDIR)


def _now_stamp():
    return time.strftime('%Y%m%dT%H%M%S', time.gmtime())


def _list_segments_sorted():
    """All segment files, oldest-first by mtime (fallback: name)."""
    d = _segment_dir()
    if not os.path.isdir(d):
        return []
    entries = []
    for fn in os.listdir(d):
        if not fn.endswith('.jsonl.gz'):
            continue
        p = os.path.join(d, fn)
        try:
            st = os.stat(p)
            entries.append((st.st_mtime, st.st_size, fn, p))
        except FileNotFoundError:
            continue
    entries.sort()  # ascending mtime — oldest first
    return entries


def _list_manifests_sorted():
    d = _manifest_dir()
    if not os.path.isdir(d):
        return []
    out = []
    for fn in os.listdir(d):
        if not fn.endswith('.json'):
            continue
        p = os.path.join(d, fn)
        try:
            with open(p) as f:
                m = json.load(f)
            out.append(m)
        except Exception:
            continue
    out.sort(key=lambda m: m.get('t_start') or 0.0, reverse=True)
    return out


def _load_manifest(run_id):
    p = os.path.join(_manifest_dir(), f'{run_id}.json')
    if not os.path.isfile(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def _save_manifest(m):
    p = os.path.join(_manifest_dir(), f'{m["run_id"]}.json')
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(m, f)
    os.replace(tmp, p)


def _effective_size_cap() -> int:
    """Return the effective size cap for this pass. Always the MIN of
    the hard `RETENTION_BYTES` and `RETENTION_FREE_FRACTION` of the
    partition's currently-free bytes. A shrinking disk shrinks the
    recorder's effective budget in lockstep — the recorder cannot
    monopolise more than the configured fraction of remaining free
    space regardless of its hard cap.

    Free-space read goes through disk_watchdog.free_bytes() which is
    the fork-registry-canonical owner of statvfs on this codebase
    (registry entry: disk_watchdog). Best-effort — a read failure
    inside disk_watchdog already falls back to a huge sentinel, so
    the recorder degrades gracefully to the hard cap."""
    try:
        # Deferred import: joint_recorder is imported at server-boot
        # from dashboard_server; disk_watchdog imports resolve at the
        # same module-graph layer.
        from cobot_dashboard import disk_watchdog as _dw
        free_b = _dw.free_bytes()
        fractional = int(free_b * RETENTION_FREE_FRACTION)
        return max(0, min(RETENTION_BYTES, fractional))
    except Exception as e:
        print(f'[joint_recorder] free-space read failed ({e}); '
              f'using hard cap {RETENTION_BYTES}', flush=True)
        return RETENTION_BYTES


def enforce_retention():
    """Drop the oldest segments until we're under BOTH caps. Called
    before each segment rotation AND on a 30 s cadence during long
    segments. Safe to call from the recorder loop; catches every
    filesystem exception."""
    try:
        entries = _list_segments_sorted()
        # Age cap: drop anything older than RETENTION_MAX_AGE_S.
        cutoff = time.time() - RETENTION_MAX_AGE_S
        for mtime, size, fn, path in list(entries):
            if mtime < cutoff:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                except Exception as e:
                    print(f'[joint_recorder] age-prune failed on {fn}: {e}',
                          flush=True)
        # Size cap: recompute after age prune; drop oldest until under.
        # Effective cap floors the hard RETENTION_BYTES at
        # RETENTION_FREE_FRACTION of currently-free disk — see
        # `_effective_size_cap`.
        size_cap = _effective_size_cap()
        entries = _list_segments_sorted()
        total = sum(sz for (_, sz, _, _) in entries)
        i = 0
        while total > size_cap and i < len(entries):
            _, sz, fn, path = entries[i]
            try:
                os.remove(path)
                total -= sz
            except FileNotFoundError:
                total -= sz
            except Exception as e:
                print(f'[joint_recorder] size-prune failed on {fn}: {e}',
                      flush=True)
            i += 1
    except Exception as e:
        # Never let retention break the recorder.
        print(f'[joint_recorder] retention pass failed: {e}', flush=True)


class JointRecorder:
    """Owns the current segment file, the sampling task, and the run
    manifest state machine. One instance per process; instantiated
    from dashboard_server at startup and left running for the life
    of the service."""

    def __init__(self, sample_provider: Callable[[], dict]):
        """`sample_provider` is a callable that returns a snapshot
        dict (or None). Called at each tick — the dashboard passes a
        closure that reads STATE under its lock so we never touch
        the state pipeline directly. Provider dict shape mirrors the
        sample-line schema (see module docstring); a None return
        skips the tick (arm hasn't published joints yet, etc.)."""
        self._sample_provider = sample_provider
        # Native-thread stop signal (not asyncio.Event). Recorder ticks
        # on a dedicated thread so the dashboard's asyncio broadcast
        # loop can't starve it — the same rationale (and pattern) the
        # hold-keepalive thread uses.
        self._stop = threading.Event()
        self._thread = None
        self._seg_file = None
        self._seg_path = None
        self._seg_bytes = 0
        self._seg_started_at = 0.0
        self._samples_this_seg = 0
        # Run manifest tracking. state=2 (running) or 3 (paused) → in-
        # run; state=0 (idle) → between runs.
        self._current_run = None       # manifest dict when live
        self._last_program_state = 0
        # Pending metadata — merged into the NEXT run's manifest when the
        # controller reports state=2/3. Set by the run endpoint before
        # publishing the run op so the manifest records which codegen
        # produced the pushed Lua (see /api/estun/program/run).
        self._pending_meta = None
        self._pending_meta_lock = threading.Lock()
        # Statistics — surface via /api/runs top-level for the "runtime
        # cost" report the task asks for.
        self._samples_total = 0

    def start(self):
        try:
            _ensure_dirs()
        except Exception as e:
            print(f'[joint_recorder] cannot create dirs: {e}', flush=True)
            return
        try:
            enforce_retention()
        except Exception as e:
            print(f'[joint_recorder] retention at boot failed: {e}', flush=True)
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name='joint-recorder', daemon=True)
        self._thread.start()
        print(f'[joint_recorder] started — dir={JOINT_RECORDER_DIR} '
              f'hz={JOINT_RECORDER_HZ} segment_s={SEGMENT_DURATION_S} '
              f'cap={RETENTION_BYTES / 1e9:.1f} GB / {RETENTION_MAX_AGE_S / 86400:.0f} d',
              flush=True)

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            try:
                self._thread.join(timeout=2.0)
            except Exception:
                pass
        self._close_segment()
        self._finalize_run()

    def _open_segment(self):
        try:
            _ensure_dirs()
            enforce_retention()
            self._seg_started_at = time.time()
            fname = f'segment_{_now_stamp()}_{uuid.uuid4().hex[:8]}.jsonl.gz'
            self._seg_path = os.path.join(_segment_dir(), fname)
            self._seg_file = gzip.open(self._seg_path, 'wt')
            self._seg_bytes = 0
            self._samples_this_seg = 0
            # Segment-open meta line — makes a bare segment file
            # standalone-analyzable via joint_log_excursions.py.
            self._seg_file.write(json.dumps({
                'meta':          'open',
                'ts':            self._seg_started_at,
                'rate_hz':       JOINT_RECORDER_HZ,
                'source':        'recorder',
                'segment_name':  fname,
            }) + '\n')
            # If a run is currently live, thread this segment onto its
            # manifest so /api/runs/{id}/joints can find it.
            if self._current_run is not None:
                segs = self._current_run.setdefault('segments', [])
                segs.append(fname)
                _save_manifest(self._current_run)
        except Exception as e:
            print(f'[joint_recorder] segment open failed: {e}', flush=True)
            self._seg_file = None
            self._seg_path = None

    def _close_segment(self):
        if self._seg_file is None:
            return
        try:
            self._seg_file.write(json.dumps({
                'meta':      'close',
                'ts':        time.time(),
                'samples':   self._samples_this_seg,
            }) + '\n')
            self._seg_file.close()
        except Exception as e:
            print(f'[joint_recorder] segment close failed: {e}', flush=True)
        finally:
            self._seg_file = None
            self._seg_path = None
            self._seg_bytes = 0
            self._samples_this_seg = 0

    def _rotate_if_needed(self):
        """Rotate when segment is older than SEGMENT_DURATION_S OR
        when its uncompressed byte count exceeds SEGMENT_MAX_BYTES.
        Both branches enforce retention before opening a fresh file
        so the total on-disk footprint stays capped."""
        if self._seg_file is None:
            self._open_segment()
            return
        age = time.time() - self._seg_started_at
        if age >= SEGMENT_DURATION_S or self._seg_bytes >= SEGMENT_MAX_BYTES:
            self._close_segment()
            self._open_segment()

    def _on_program_state_change(self, new_state, program_id, program_name):
        """Handle idle↔running transitions. Start a new run manifest
        on 0→(2|3); close the current one on (2|3)→0. Paused (3)
        counts as in-run — the arm's still logically in this run."""
        was_in_run = self._last_program_state in (2, 3)
        is_in_run  = new_state in (2, 3)
        if is_in_run and not was_in_run:
            self._start_run(program_id, program_name)
        elif was_in_run and not is_in_run:
            self._finalize_run()
        # Record every transition on the manifest for cycle-time
        # accounting (pause counts, mid-run stops, etc.).
        if self._current_run is not None:
            self._current_run.setdefault('state_transitions', []).append({
                't':     time.time(),
                'state': int(new_state),
            })
            _save_manifest(self._current_run)
        self._last_program_state = new_state

    def _start_run(self, program_id, program_name):
        try:
            _ensure_dirs()
        except Exception:
            return
        t = time.time()
        rid = f'{(program_id or "unknown")}_{_now_stamp()}_{uuid.uuid4().hex[:6]}'
        # Windows-safe: replace any character that would foul the
        # filesystem. Keep letters/digits/dashes/underscore.
        rid_safe = ''.join(c if c.isalnum() or c in '-_' else '_'
                           for c in rid)
        m = {
            'run_id':       rid_safe,
            'program_id':   program_id,
            'program_name': program_name,
            't_start':      t,
            't_end':        None,
            'duration_s':   None,
            'state_transitions': [],
            'segments':     [self._seg_path.split('/')[-1]]
                            if self._seg_path else [],
        }
        # Drain any pending metadata attached by the run endpoint (codegen
        # version, pushed Lua sha, freshness check result). Cleared on
        # drain so a subsequent operator-initiated run without a
        # /api/estun/program/run press (e.g. controller resumes a paused
        # run) doesn't inherit stale attribution.
        with self._pending_meta_lock:
            pm = self._pending_meta
            self._pending_meta = None
        if pm:
            for k, v in pm.items():
                if k not in m:
                    m[k] = v
        self._current_run = m
        _save_manifest(m)
        print(f'[joint_recorder] run start: {rid_safe} (prog={program_id})'
              + (f' codegen={pm.get("codegen_version",{}).get("git_sha","?")}'
                 if pm else ''),
              flush=True)

    def attach_pending_metadata(self, meta: dict) -> None:
        """Merge into the NEXT run's manifest. Call from the run endpoint
        BEFORE publishing the run op so metadata is in place by the time
        the controller's state transition triggers _start_run."""
        if not isinstance(meta, dict):
            return
        with self._pending_meta_lock:
            self._pending_meta = dict(meta)

    def _finalize_run(self):
        m = self._current_run
        if m is None:
            return
        m['t_end']      = time.time()
        m['duration_s'] = round(m['t_end'] - m['t_start'], 3)
        _save_manifest(m)
        print(f'[joint_recorder] run end: {m["run_id"]} '
              f'duration={m["duration_s"]}s '
              f'segments={len(m.get("segments") or [])}',
              flush=True)
        self._current_run = None

    def _run(self):
        period = 1.0 / JOINT_RECORDER_HZ
        last_retention_check = time.time()
        while not self._stop.is_set():
            try:
                snap = None
                try:
                    snap = self._sample_provider()
                except Exception as e:
                    print(f'[joint_recorder] provider raised: {e}', flush=True)
                # Handle program-state transitions BEFORE writing so the
                # sample lands in the correct run's segment listing.
                if snap is not None:
                    st = int(snap.get('program_state') or 0)
                    if st != self._last_program_state:
                        self._on_program_state_change(
                            st,
                            snap.get('program_id'),
                            snap.get('program_name') or snap.get('program_id'),
                        )
                self._rotate_if_needed()
                if snap is not None and self._seg_file is not None:
                    try:
                        line = json.dumps({
                            't':             round(snap['t'], 3),
                            'joints_deg':    snap['joints_deg'],
                            'program_id':    snap.get('program_id'),
                            'program_state': snap.get('program_state'),
                            'program_line':  snap.get('program_line'),
                            'is_step':       bool(snap.get('is_step', False)),
                        }) + '\n'
                        self._seg_file.write(line)
                        self._seg_bytes += len(line)
                        self._samples_this_seg += 1
                        self._samples_total += 1
                        # gzip.GzipFile buffers ~8 KB before emitting a
                        # compressed chunk. At 25 Hz × ~100 B/sample that
                        # would take ~15 s to flush the first byte — long
                        # enough that a crash between sample 1 and the
                        # first flush loses the whole run. Flush every N
                        # samples to bound loss to <1 s of data while
                        # keeping most of the gzip compression win.
                        if (self._samples_this_seg % 25) == 0:
                            try:
                                self._seg_file.flush()
                            except Exception:
                                pass
                    except Exception as e:
                        print(f'[joint_recorder] write failed: {e}', flush=True)
                        # Close + reopen the segment on write failure so a
                        # transient disk hiccup doesn't wedge the recorder.
                        self._close_segment()
                # Periodic retention check for long-lived segments.
                now = time.time()
                if now - last_retention_check > RETENTION_CHECK_PERIOD_S:
                    enforce_retention()
                    last_retention_check = now
            except Exception as e:
                # Belt-and-braces: every recorder tick is isolated.
                print(f'[joint_recorder] tick error: {e}', flush=True)
            # Sleep on the threading.Event so stop() can wake us
            # immediately rather than waiting for the next tick.
            if self._stop.wait(timeout=period):
                break

    # ── introspection for /api/runs and /health ──────────────────
    def stats(self):
        return {
            'dir':                 JOINT_RECORDER_DIR,
            'rate_hz':             JOINT_RECORDER_HZ,
            'segment_seconds':     SEGMENT_DURATION_S,
            'retention_bytes':     RETENTION_BYTES,
            'retention_age_s':     RETENTION_MAX_AGE_S,
            'samples_total':       self._samples_total,
            'current_segment':     (self._seg_path.split('/')[-1]
                                    if self._seg_path else None),
            'current_run':         (self._current_run['run_id']
                                    if self._current_run else None),
            'disk_bytes':          sum(sz for _, sz, _, _ in _list_segments_sorted()),
        }

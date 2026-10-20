"""Unified event log — one append-only JSONL store for every
error/warning/info event the platform surfaces (2026-08-05).

Fork registry: `event_log`. This module is the SINGLE writer.
No component writes its own error file — everyone routes through
`emit(...)`. The daily file at
/opt/cobot/event_log/events_YYYYMMDD.jsonl is atomically appended
via `os.write` on a durable file descriptor; a reader can safely
tail the same file without race hazards.

Retention: 90 days on disk, capped by _MAX_TOTAL_BYTES, oldest-
first prune. Prune runs opportunistically on every append (cheap
because we only stat/rm at threshold).

Event shape (canonical):
  {
    "ts_utc":            ISO-8601 UTC 'YYYY-MM-DDTHH:MM:SS.sssZ',
    "ts_local":          ISO-8601 local (for operator readability),
    "severity":          "error" | "warning" | "info",
    "source":            "dashboard" | "driver" | "pbd" | "validator"
                       | "watcher" | "operator",
    "code":              str — machine-readable outcome kind or
                                finding code or stop cause tag,
    "operator_message":  str — the title the human saw,
    "technical_detail":  str — verbatim reason string,
    "context":           dict — {program_id, step_id, device_id,
                                 session, sha, ...arbitrary},
  }

Design choices, per directive:
  * ONE writer module (fork-registry entry). No per-component logs.
  * Append-only. Dismissing a toast NEVER deletes the record.
  * Atomic per-line writes via os.write on the fd (no read-modify-
    write; no partial-line races on multi-threaded flushes).
  * Daily rotation by UTC date (so the operator's timezone can't
    shift a file across midnight and split a day).
  * Retention prune on every emit — cheap: only reads directory
    listing + statvfs; disk work only when threshold crossed.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone


_LOG_DIR = '/opt/cobot/event_log'

# Retention:
#   90 days OR total size > _MAX_TOTAL_BYTES, oldest-first prune.
_RETENTION_DAYS      = 90
_MAX_TOTAL_BYTES     = 500 * 1024 * 1024   # 500 MB — plenty of headroom

# fd cache: keep the current day's file open across appends. A day
# roll closes the old fd and opens the new. Concurrent writers on
# the same fd are serialized by _write_lock; os.write on POSIX with
# O_APPEND is atomic up to PIPE_BUF (4KB on Linux) — our records
# are well under that.
_fd_lock  = threading.Lock()
_fd       = None                     # int or None
_fd_date  = None                     # 'YYYYMMDD' or None
_write_lock = threading.Lock()

# Running-build sha for the `context.sha` field. Populated once at
# import time from /opt/cobot/deploy_log.jsonl (best-effort — an
# unset sha means the module runs pre-deploy, which is a valid state
# on a fresh install). Callers can override per-emit via
# `context={'sha': ...}`.
_RUNNING_SHA: str | None = None


def _load_running_sha() -> str | None:
    """Best-effort read of the latest deploy sha. Silently returns
    None on any read/parse error — this field is diagnostic, not
    load-bearing."""
    try:
        with open('/opt/cobot/deploy_log.jsonl') as fh:
            last_ok = None
            for ln in fh:
                try:
                    d = json.loads(ln)
                except Exception:
                    continue
                if d.get('phase') == 'ok' and d.get('sha'):
                    last_ok = d['sha']
            return last_ok
    except Exception:
        return None


def _iso_utc(ts: float) -> str:
    """Millisecond-precision ISO-8601 in UTC with the 'Z' suffix."""
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def _iso_local(ts: float) -> str:
    """Same instant, local TZ, with numeric offset."""
    dt = datetime.fromtimestamp(ts).astimezone()
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + \
           f'{dt.microsecond // 1000:03d}' + dt.strftime('%z')


def _utc_date_str(ts: float) -> str:
    """UTC YYYYMMDD for daily rotation."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y%m%d')


def _path_for_date(date_str: str) -> str:
    return os.path.join(_LOG_DIR, f'events_{date_str}.jsonl')


def _ensure_fd_for_date(date_str: str) -> int:
    """Open (or reuse) the fd for the given UTC date. Caller must
    hold `_fd_lock`. Rolls the fd when the date changes."""
    global _fd, _fd_date
    if _fd is not None and _fd_date == date_str:
        return _fd
    # Roll: close old, open new.
    if _fd is not None:
        try:
            os.close(_fd)
        except Exception:
            pass
        _fd = None
    os.makedirs(_LOG_DIR, exist_ok=True)
    path = _path_for_date(date_str)
    # O_APPEND | O_CREAT | O_WRONLY — POSIX-guarantees that each
    # write moves the file position to end-of-file first, so
    # concurrent writers on separate fds are also atomic per-line
    # under PIPE_BUF.
    _fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    _fd_date = date_str
    return _fd


def _prune_if_needed() -> None:
    """Retention sweep — 90 days OR size cap, whichever comes
    first. Silently swallows filesystem errors (this is a
    housekeeping op, not part of the emit contract)."""
    try:
        entries = []
        try:
            names = os.listdir(_LOG_DIR)
        except FileNotFoundError:
            return
        for name in names:
            if not (name.startswith('events_') and name.endswith('.jsonl')):
                continue
            path = os.path.join(_LOG_DIR, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            entries.append((path, st.st_mtime, st.st_size, name))
        if not entries:
            return
        entries.sort(key=lambda x: x[1])   # oldest first
        # Age-based prune.
        cutoff = time.time() - (_RETENTION_DAYS * 86400)
        for path, mtime, _size, _name in list(entries):
            if mtime < cutoff:
                try:
                    os.remove(path)
                    entries.remove((path, mtime, _size, _name))
                except OSError:
                    pass
        # Size-based prune (after age-based).
        total = sum(e[2] for e in entries)
        while total > _MAX_TOTAL_BYTES and len(entries) > 1:
            path, _mtime, size, _name = entries.pop(0)
            try:
                os.remove(path)
                total -= size
            except OSError:
                break
    except Exception:
        pass


_VALID_SEVERITIES = {'error', 'warning', 'info'}
_VALID_SOURCES    = {'dashboard', 'driver', 'pbd', 'validator',
                     'watcher', 'operator'}


def emit(
    severity: str,
    source: str,
    code: str,
    operator_message: str,
    technical_detail: str = '',
    context: dict | None = None,
    ts: float | None = None,
) -> dict:
    """Append one event to the daily JSONL. Returns the emitted
    record (with normalized fields) — callers can log it too.

    Never raises to the caller. Best-effort write; any filesystem
    failure returns an empty dict so the caller can degrade
    gracefully. The event was ALREADY reported to the operator via
    the toast/reject path — the JSONL is the persistent forensic
    record, not the user-facing signal."""
    ts = ts if ts is not None else time.time()
    severity = severity if severity in _VALID_SEVERITIES else 'info'
    source   = source if source in _VALID_SOURCES else 'dashboard'
    code     = str(code or '')[:200]           # cap length
    operator_message = str(operator_message or '')[:2000]
    technical_detail = str(technical_detail or '')[:8000]
    if context is None or not isinstance(context, dict):
        context = {}
    else:
        # Copy + serialize each value defensively — a caller might
        # pass a non-JSON-safe object (e.g. numpy scalar). str()
        # everything that fails default JSON.
        safe: dict = {}
        for k, v in context.items():
            try:
                json.dumps(v)
                safe[k] = v
            except Exception:
                safe[k] = str(v)
        context = safe
    if _RUNNING_SHA and 'sha' not in context:
        context['sha'] = _RUNNING_SHA
    record = {
        'ts_utc':            _iso_utc(ts),
        'ts_local':          _iso_local(ts),
        'severity':          severity,
        'source':            source,
        'code':              code,
        'operator_message':  operator_message,
        'technical_detail':  technical_detail,
        'context':           context,
    }
    date_str = _utc_date_str(ts)
    line = json.dumps(record, ensure_ascii=False) + '\n'
    payload = line.encode('utf-8')
    try:
        with _fd_lock:
            fd = _ensure_fd_for_date(date_str)
            with _write_lock:
                os.write(fd, payload)
    except Exception:
        return {}
    # Prune opportunistically. Cheap: no-op unless a threshold
    # crossed. Fires outside the write lock so it doesn't stall
    # producers.
    try:
        _prune_if_needed()
    except Exception:
        pass
    return record


def read_day(date_str: str, limit: int | None = None) -> list[dict]:
    """Return the day's records, oldest first. `date_str` is
    'YYYYMMDD' (UTC). `limit` caps the result count (returns the
    LATEST N; useful for the interface page's live-tail view).
    Returns [] on any error — this is a diagnostic read path."""
    path = _path_for_date(date_str)
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
    except FileNotFoundError:
        return []
    except Exception:
        return []
    out: list[dict] = []
    for ln in data.decode('utf-8', errors='replace').splitlines():
        if not ln.strip():
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            continue
    if limit is not None and len(out) > limit:
        out = out[-limit:]
    return out


def list_days() -> list[str]:
    """List available dates ('YYYYMMDD') sorted newest first."""
    try:
        names = os.listdir(_LOG_DIR)
    except FileNotFoundError:
        return []
    days: list[str] = []
    for name in names:
        if name.startswith('events_') and name.endswith('.jsonl'):
            days.append(name[len('events_'):-len('.jsonl')])
    days.sort(reverse=True)
    return days


def path_for_date(date_str: str) -> str:
    """Public wrapper for _path_for_date — used by the HTTP
    download endpoints."""
    return _path_for_date(date_str)


def log_dir() -> str:
    """Public accessor for the log directory root."""
    return _LOG_DIR


# Module-load side effects: capture the running-build sha once.
_RUNNING_SHA = _load_running_sha()

"""Disk watchdog + enforced retention — 2026-08-05.

Fork registry: `disk_watchdog`. ONE source of truth for
"how much space is free on /opt/cobot", how the dashboard responds
to low-space conditions, and where the retention caps are set for
each domain writer.

The 2026-08-05 P0 (record-endpoint crash on ENOSPC) motivated
this module: three separate log domains (driver ws logs, joint
history, event log) grew unbounded until the record path
crashed. Each is now capped at a well-known number and pruned
oldest-first when the cap is exceeded.

Directory caps:
  /opt/cobot/logs           →  300 MB (driver ws logs)
  /opt/cobot/joint_history  →  2 GB   (already enforced in
                                        joint_recorder.py; this
                                        module mirrors the number)
  /opt/cobot/event_log      →  500 MB (already enforced in
                                        event_log.py; mirrored)

Retention hazard (2026-08-28): `os.remove` on Linux unlinks the
directory entry but a writer with the file open keeps writing to
the now-invisible inode — disk fills without a visible file. The
prune loop always keeps the newest file to protect the LIVE
writer. Cap of 300 MB accommodates ~5 rotated 60 MB files.

Watchdog thresholds — free space on the / partition:
  WARN     — < 2 GB free → footer widget goes amber; operator
             sees "Disk low" hint
  CRITICAL — < 500 MB free → non-critical writers (event_log)
             stop; critical writers (teach draft, program save)
             still attempt and return 507 on failure
  DEAD     — < 50 MB free  → even critical writers refuse
             pre-emptively so a mid-write ENOSPC doesn't leave
             partial state
"""

from __future__ import annotations

import glob
import os
import time
from typing import Callable


# Root of everything the dashboard writes. The watchdog checks
# free space on THIS partition — most installs have /opt on the
# root fs, but the check via statvfs handles a separate mount too.
COBOT_ROOT = '/opt/cobot'

# Directory-level caps (bytes). Prune runs on every enforce_all()
# call, cheap when nothing to do.
DIR_CAPS = {
    '/opt/cobot/logs':          300 * 1024 ** 2, # 300 MB (2026-08-28: was 2 GB)
    '/opt/cobot/joint_history': 2 * 1024 ** 3,   # 2 GB — mirror of joint_recorder
    '/opt/cobot/event_log':     500 * 1024 ** 2, # 500 MB — mirror of event_log
}

# Watchdog thresholds — free space on the partition COBOT_ROOT
# lives on.
WARN_BYTES     = 2 * 1024 ** 3   # 2 GB
CRITICAL_BYTES = 500 * 1024 ** 2 # 500 MB
DEAD_BYTES     = 50  * 1024 ** 2 # 50 MB


def free_bytes() -> int:
    """Return free bytes on the partition hosting COBOT_ROOT.
    Falls back to a huge number on error so the check degrades
    to 'not critical' rather than blocking every write."""
    try:
        st = os.statvfs(COBOT_ROOT if os.path.isdir(COBOT_ROOT) else '/')
        return st.f_bavail * st.f_frsize
    except OSError:
        return 1 << 62


def level() -> str:
    """Return the current watchdog level: 'ok' | 'warn' |
    'critical' | 'dead'. Called by the footer widget +
    non-critical writers."""
    b = free_bytes()
    if b < DEAD_BYTES:     return 'dead'
    if b < CRITICAL_BYTES: return 'critical'
    if b < WARN_BYTES:     return 'warn'
    return 'ok'


def should_write(writer_kind: str = 'critical') -> bool:
    """Guard for writers. `writer_kind`:
      * 'critical'     — teach draft, program save, ui_context.
                         Only refused pre-emptively when DEAD.
      * 'non-critical' — event log, deploy_log tail, etc.
                         Refused at CRITICAL AND above.
    """
    lvl = level()
    if lvl == 'dead':
        return False
    if lvl == 'critical' and writer_kind != 'critical':
        return False
    return True


def _dir_bytes(path: str) -> int:
    """Sum of file sizes in `path` (non-recursive)."""
    total = 0
    try:
        for name in os.listdir(path):
            fp = os.path.join(path, name)
            try:
                total += os.stat(fp).st_size
            except OSError:
                continue
    except FileNotFoundError:
        return 0
    return total


def _prune_dir(path: str, cap_bytes: int,
               pattern: str = '*') -> int:
    """Prune oldest files in `path` (matching `pattern`) until
    the directory total is under `cap_bytes`. Returns bytes freed.
    Silent on any filesystem error."""
    try:
        entries = []
        for fp in glob.glob(os.path.join(path, pattern)):
            try:
                st = os.stat(fp)
            except OSError:
                continue
            if not os.path.isfile(fp):
                continue
            entries.append((st.st_mtime, st.st_size, fp))
        if not entries:
            return 0
        entries.sort(key=lambda e: e[0])   # oldest first
        total = sum(e[1] for e in entries)
        freed = 0
        i = 0
        # Never remove the newest file — a writer likely has it
        # open, and `os.remove` on an open inode fills the disk
        # silently (2026-08-28). Cap the loop at len-1.
        limit = max(0, len(entries) - 1)
        while total > cap_bytes and i < limit:
            _, size, fp = entries[i]
            try:
                os.remove(fp)
                total -= size
                freed += size
            except OSError:
                pass
            i += 1
        return freed
    except Exception:
        return 0


def enforce_all() -> dict:
    """Run oldest-first prune on every capped directory.
    Returns a dict of {path: {before, after, freed_bytes}} so
    callers can log the result. Cheap when nothing to prune."""
    out = {}
    for path, cap in DIR_CAPS.items():
        before = _dir_bytes(path)
        freed  = _prune_dir(path, cap)
        after  = _dir_bytes(path)
        out[path] = {'cap': cap, 'before': before,
                     'after': after, 'freed_bytes': freed}
    return out


def status() -> dict:
    """Snapshot for /api/disk_status and the footer widget."""
    b = free_bytes()
    return {
        'free_bytes':      b,
        'free_human':      _human(b),
        'level':           level(),
        'thresholds': {
            'warn_bytes':     WARN_BYTES,
            'critical_bytes': CRITICAL_BYTES,
            'dead_bytes':     DEAD_BYTES,
        },
        'dirs': [
            {'path': path,
             'size_bytes': _dir_bytes(path),
             'size_human': _human(_dir_bytes(path)),
             'cap_bytes':  cap,
             'cap_human':  _human(cap)}
            for path, cap in DIR_CAPS.items()
        ],
        'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


def _human(n: int) -> str:
    if n < 1024:                return f'{n} B'
    if n < 1024 ** 2:           return f'{n / 1024:.1f} KB'
    if n < 1024 ** 3:           return f'{n / 1024 ** 2:.1f} MB'
    return f'{n / 1024 ** 3:.2f} GB'


def start_watchdog_thread(period_s: float = 60.0,
                          on_status: Callable[[dict], None] = None
                          ) -> None:
    """Spawn a daemon thread that runs `enforce_all()` every
    `period_s` seconds. Idempotent — call once at dashboard boot."""
    import threading
    def _loop():
        while True:
            try:
                enforce_all()
            except Exception:
                pass
            if on_status is not None:
                try: on_status(status())
                except Exception: pass
            time.sleep(period_s)
    t = threading.Thread(target=_loop, name='disk-watchdog', daemon=True)
    t.start()

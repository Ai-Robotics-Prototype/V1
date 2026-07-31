#!/usr/bin/env python3
"""observe_drag_button — bench observation for the flange drag button.

Purpose: identify WHICH observable signal (if any) flips when the
operator presses the physical flange button. This is the "BENCH STEP
FIRST" the drag-mode task rests on — before we can build a Drag chip,
we need to know what signal the chip watches.

Usage (at the bench):

    # Terminal A — driver already running with ws_log_raw=True (default).
    # Confirm the log tail is fresh:
    sudo systemctl status roboai-estun

    # Terminal B — arm the observer.
    python3 scripts/observe_drag_button.py

    # Follow the on-screen prompts:
    #   1. Move controller to MANUAL mode (physical key).
    #   2. Enable the arm.
    #   3. Press ENTER when idle (BASELINE mark).
    #   4. Press the flange button and HOLD it (PRESSED mark).
    #   5. Release. Press ENTER when released (RELEASED mark).
    #
    # The script slices the driver's raw WS log around each mark,
    # diffs the frame content, and reports:
    #   * any DI port whose `value` changed (flange button candidate)
    #   * any new key that appeared in RobotStatus.db while pressed
    #   * any GetDragMode reply that returned a NON-zero value

Design notes:
  * Read-only. Never sends WS frames or ROS topics.
  * Uses the driver's existing raw log (/opt/cobot/logs/estun_ws_*.jsonl)
    — no code changes, no restart required.
  * If the flange button isn't wired to any observable path, the
    report says so explicitly. That's a valid outcome: "we can't
    detect this signal — either wire it through a DI port at the
    controller, or defer the chip until a controller firmware read
    of GetDragMode returns non-zero during press."
"""

from __future__ import annotations

import glob
import json
import os
import sys
import time
from collections import defaultdict


LOG_DIR = '/opt/cobot/logs'


def find_latest_log() -> str | None:
    paths = sorted(glob.glob(os.path.join(LOG_DIR, 'estun_ws_*.jsonl')))
    return paths[-1] if paths else None


def prompt_mark(label: str) -> float:
    input(f'\n[{label}] ready — press ENTER to mark.')
    ts = time.time()
    print(f'  mark @ {ts:.3f}')
    return ts


def load_frames_between(path: str, t_start: float, t_end: float) -> list[dict]:
    """Return every log entry whose ts is inside [t_start, t_end]."""
    out = []
    with open(path, 'r') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = entry.get('ts')
            if not isinstance(ts, (int, float)):
                continue
            if t_start <= ts <= t_end:
                out.append(entry)
    return out


def io_snapshot(frames: list[dict]) -> dict[tuple[str, int], object]:
    """Latest {value} per (DI/DO/AI/AO, port) inside the window.

    We only care about the LAST value seen for each port in a window —
    the driver polls at fixed cadence, so the last read is what the
    controller was showing when the operator hit their mark.
    """
    latest: dict[tuple[str, int], object] = {}
    for e in frames:
        payload = e.get('payload') or {}
        if payload.get('ty') != 'IOManager/GetIOValue':
            continue
        db = payload.get('db')
        if not isinstance(db, list):
            continue
        for row in db:
            if not isinstance(row, dict):
                continue
            typ = row.get('type')
            port = row.get('port')
            val = row.get('value')
            if typ in ('DI', 'DO', 'AI', 'AO') and isinstance(port, int):
                latest[(typ, port)] = val
    return latest


def robot_status_keys(frames: list[dict]) -> set[str]:
    """Union of every key ever seen in publish/RobotStatus.db within
    the window — spot-check for new fields (`dragMode`, `dragging`,
    an unknown enum) that appear only while the button is held."""
    keys: set[str] = set()
    for e in frames:
        payload = e.get('payload') or {}
        if payload.get('ty') != 'publish/RobotStatus':
            continue
        db = payload.get('db')
        if isinstance(db, dict):
            keys.update(db.keys())
    return keys


def robot_status_field_values(frames: list[dict]) -> dict[str, set]:
    """Distinct scalar values seen per RobotStatus field. If a field's
    value changes only during the press, its diff will show up."""
    seen: dict[str, set] = defaultdict(set)
    for e in frames:
        payload = e.get('payload') or {}
        if payload.get('ty') != 'publish/RobotStatus':
            continue
        db = payload.get('db')
        if not isinstance(db, dict):
            continue
        for k, v in db.items():
            try:
                # Hashable only. Skip nested dicts/lists — anything
                # non-hashable is a candidate to inspect manually.
                seen[k].add(v)
            except TypeError:
                seen[k].add(f'<non-hashable {type(v).__name__}>')
    return seen


def dragmode_replies(frames: list[dict]) -> list[object]:
    """Any Robot/GetDragMode reply value inside the window."""
    vals: list[object] = []
    for e in frames:
        payload = e.get('payload') or {}
        if payload.get('ty') != 'Robot/GetDragMode':
            continue
        vals.append(payload.get('db'))
    return vals


def diff_report(baseline: list[dict], pressed: list[dict],
                released: list[dict]) -> None:
    print('\n' + '=' * 60)
    print('BENCH OBSERVATION REPORT')
    print('=' * 60)

    # ── DI diff ────────────────────────────────────────────────
    base_io = io_snapshot(baseline)
    press_io = io_snapshot(pressed)
    rel_io = io_snapshot(released)
    di_changes = []
    all_di_ports = sorted({p for (t, p) in {**base_io, **press_io}.keys()
                           if t == 'DI'})
    for port in all_di_ports:
        b = base_io.get(('DI', port))
        p = press_io.get(('DI', port))
        r = rel_io.get(('DI', port))
        if b != p:
            di_changes.append((port, b, p, r))
    if di_changes:
        print('\n[DI candidates — value changed between baseline and pressed]')
        for port, b, p, r in di_changes:
            match_release = ' ✓ returned to baseline on release' \
                if r == b else ' ⚠ did NOT return to baseline'
            print(f'  DI{port}: baseline={b!r} → pressed={p!r} → released={r!r}{match_release}')
        print('\n  → The DI port whose value returns to baseline on release')
        print('    is the most likely flange-button DI. Wire the chip to that port.')
    else:
        print('\n[DI candidates] none — no DI port changed value during the press.')
        print('  The flange button is either NOT wired to a DI port,')
        print('  or the IO poll cadence missed the transition.')
        print('  Confirm at the controller: which DI port is the flange button?')

    # ── RobotStatus new keys ───────────────────────────────────
    base_keys = robot_status_keys(baseline)
    press_keys = robot_status_keys(pressed)
    new_keys = press_keys - base_keys
    if new_keys:
        print('\n[RobotStatus.db — new keys during press]')
        for k in sorted(new_keys):
            print(f'  + {k}')
    else:
        print('\n[RobotStatus.db] no new keys appeared during press.')

    # ── RobotStatus value drift ───────────────────────────────
    base_vals = robot_status_field_values(baseline)
    press_vals = robot_status_field_values(pressed)
    drifts = []
    for k in base_keys & press_keys:
        if base_vals[k] != press_vals[k]:
            drifts.append((k, base_vals[k], press_vals[k]))
    if drifts:
        print('\n[RobotStatus.db — value drift during press]')
        for k, b, p in drifts:
            print(f'  {k}: baseline values={b} → pressed values={p}')
        print('\n  → A field that only shows a new value while pressed')
        print('    is the drag-state indicator. Prefer it over DI when both fire.')
    else:
        print('\n[RobotStatus.db] no known field changed value during press.')

    # ── GetDragMode replies ────────────────────────────────────
    press_drag = dragmode_replies(pressed)
    if press_drag:
        print('\n[Robot/GetDragMode replies during press]')
        for v in press_drag:
            print(f'  → {v!r}')
        if any(v not in (0, None) for v in press_drag):
            print('\n  → GetDragMode answered non-zero while pressed.')
            print('    That is the authoritative signal — poll it and publish drag_active.')
    else:
        print('\n[Robot/GetDragMode] not polled during the press window.')
        print('  Consider adding a poll during the next observation.')

    # ── Verdict ────────────────────────────────────────────────
    print('\n' + '-' * 60)
    if di_changes and any(r == b for _, b, _, r in di_changes):
        print('VERDICT: use the DI port(s) listed above.')
        print('         Publish drag_active on /estun/state; UI copy honest.')
    elif drifts:
        print('VERDICT: use the RobotStatus field(s) listed above.')
    elif press_drag and any(v not in (0, None) for v in press_drag):
        print('VERDICT: GetDragMode is the signal.')
    else:
        print('VERDICT: no observable signal detected in this window.')
        print('         Options: (1) wire the button to a DI port at the')
        print('         controller, (2) rerun the observation while polling')
        print('         GetDragMode explicitly, (3) defer the chip until a')
        print('         torque-sensor-equipped arm captures a working press.')
    print('=' * 60)


def main() -> int:
    log_path = find_latest_log()
    if not log_path:
        print(f'ERROR: no estun_ws_*.jsonl under {LOG_DIR}', file=sys.stderr)
        print('       Is roboai-estun running with ws_log_raw=True?', file=sys.stderr)
        return 2
    print(f'Using log: {log_path}')
    print('Confirm the controller is in MANUAL mode and the arm is enabled.')

    t_baseline = prompt_mark('BASELINE — do NOT press yet')
    # Give the poll a tick to update after baseline mark.
    time.sleep(0.3)
    t_press = prompt_mark('PRESSED — press and HOLD the flange button, then ENTER')
    time.sleep(0.3)
    t_release = prompt_mark('RELEASED — release the button, then ENTER')

    # Widen the baseline window so we sample multiple poll cycles.
    baseline_start = t_baseline - 2.0
    baseline_frames = load_frames_between(log_path, baseline_start, t_baseline)
    press_frames    = load_frames_between(log_path, t_baseline, t_press)
    release_frames  = load_frames_between(log_path, t_press, t_release + 1.0)
    print(f'\nFrames sampled — baseline: {len(baseline_frames)}, '
          f'pressed: {len(press_frames)}, released: {len(release_frames)}')

    diff_report(baseline_frames, press_frames, release_frames)
    return 0


if __name__ == '__main__':
    sys.exit(main())

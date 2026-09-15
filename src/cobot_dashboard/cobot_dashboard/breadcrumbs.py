"""Program-execution breadcrumb collector.

Records the joint waypoints the arm actually achieved during a
program run so Return Home can retrace the proven path rather than
improvise a direct move through unproven space (2026-07-24 report:
mid-program Return Home tried to cut a diagonal that would have
struck an obstacle the program path avoided).

Schema
------
Each breadcrumb entry:
    {
      "step_index":       int,          # 0-based; index into program.steps
      "step_role":        str | None,   # position_role from the step (pick, place, home, ...)
      "step_action":      str,          # move_home / move_linear / set_io / ...
      "joints_deg":       [f, f, f, f, f, f],
      "ts":               "2026-07-24T13:45:12.345Z",
      "paused_mid_step":  bool,         # true only when the run was paused
                                        # mid-step and this is the LAST entry
    }

Each trail:
    {
      "program_id":      "delrinpiecepickplace",
      "program_name":    "Delrin piece Pick & Place",
      "run_started_at":  "2026-07-24T13:44:59.000Z",
      "run_finished_at": "2026-07-24T13:45:20.000Z",
      "finalized":       true,
      "finish_reason":   "stopped" | "completed" | "paused" | "abandoned",
      "waypoints":       [breadcrumb, breadcrumb, ...],
      "step_roles":      {...},          # index → role, cached from program.json
    }

Retention
---------
* In-memory: the most recent trail per program_id (LRU of `MEM_CAP`).
* Disk: on finalise, `/opt/cobot/runs/<iso>_<program_id>_breadcrumbs.json`.
  Kept forever until the operator prunes; small (~10 KB per program).

Thinning
--------
`thin_waypoints(waypoints)` returns a new list where breadcrumbs
whose max joint delta versus the previous kept breadcrumb is under
`THIN_MAX_DELTA_DEG` are dropped — EXCEPT waypoints whose
`step_role` is a contact role (`pick`/`place`/`machine_load`/`unload`),
which are never skipped so a Z-descent step boundary is always
preserved. Applied at READ time (in the preview + retrace builder)
so the raw recording stays lossless.

Freshness
---------
`is_stale(trail, current_joints_deg, tol_deg)` returns True when the
arm's current joints differ from the trail's last waypoint by more
than `tol_deg` per joint — indicates the arm has moved outside the
trail (jogged, controller reboot, another motion command). A stale
trail must NOT be retraced blind.
"""

from __future__ import annotations

import json
import math
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


RUNS_DIR = '/opt/cobot/runs'
PROGRAMS_DIR = '/opt/cobot/programs'

# LRU cap for in-memory finalised trails, keyed by program_id.
MEM_CAP = 8

# Waypoint thinning: skip breadcrumbs whose max joint delta from the
# previous kept breadcrumb is below this, unless the step is a
# contact role.
THIN_MAX_DELTA_DEG = 2.0

# Contact / Z-descent step roles that must never be thinned out —
# these are the taught pick/place/machine-load/unload contacts the
# program approached with a Z descent. Losing one would take the
# retrace through unproven space.
CONTACT_ROLES = frozenset(('pick', 'place', 'machine_load', 'unload'))

# Staleness threshold — arm must be within this many degrees on
# every joint of the last breadcrumb for the trail to be considered
# fresh. Above this: assume the arm moved outside the recorded path.
DEFAULT_STALE_TOL_DEG = 1.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') \
         + f'{datetime.now(timezone.utc).microsecond // 1000:03d}Z'


def _rad2deg(v: float) -> float:
    return v * 180.0 / math.pi


def _rad_list_to_deg(positions_rad) -> List[float]:
    return [round(_rad2deg(float(v)), 3) for v in list(positions_rad)[:6]]


def _max_joint_delta_deg(a: List[float], b: List[float]) -> float:
    if not a or not b:
        return math.inf
    return max(abs(float(a[i]) - float(b[i])) for i in range(min(6, len(a), len(b))))


def thin_waypoints(waypoints: List[Dict[str, Any]],
                   max_delta_deg: float = THIN_MAX_DELTA_DEG,
                   contact_roles=CONTACT_ROLES) -> List[Dict[str, Any]]:
    """Return a thinned copy of `waypoints`. See module docstring."""
    if len(waypoints) <= 2:
        return list(waypoints)
    kept: List[Dict[str, Any]] = [waypoints[0]]
    for wp in waypoints[1:-1]:
        role = wp.get('step_role')
        delta = _max_joint_delta_deg(
            kept[-1].get('joints_deg') or [],
            wp.get('joints_deg') or [])
        if role in contact_roles or delta >= max_delta_deg:
            kept.append(wp)
    kept.append(waypoints[-1])
    return kept


def is_stale(trail: Optional[Dict[str, Any]],
             current_joints_deg: Optional[List[float]],
             tol_deg: float = DEFAULT_STALE_TOL_DEG) -> bool:
    """A trail is stale when the arm is nowhere near where the trail
    ended. See module docstring."""
    if not trail or not trail.get('waypoints'):
        return True
    if not current_joints_deg or len(current_joints_deg) < 6:
        # Can't verify → treat as stale so we don't retrace on a
        # sample we can't cross-check.
        return True
    last = trail['waypoints'][-1].get('joints_deg') or []
    return _max_joint_delta_deg(last, current_joints_deg) > tol_deg


def effector_state_at_end(trail: Optional[Dict[str, Any]],
                          program_steps: Optional[List[Dict[str, Any]]]) -> Dict[str, bool]:
    """Walk the program's step list up to the last completed step
    (from the trail) and return the effector's on/off state at the
    moment the program was interrupted. Two flags today:
      vacuum_engaged  — vacuum DO commanded ON with no subsequent OFF
      blow_off_active — blow-off DO currently ON
    The Return Home confirm dialog uses these to warn the operator
    (a carried part must not be dropped mid-retrace)."""
    out = {'vacuum_engaged': False, 'blow_off_active': False}
    if not trail or not program_steps:
        return out
    last_wp = trail.get('waypoints') or []
    if not last_wp:
        return out
    # Steps up to and including the last completed step_index.
    last_idx = int(last_wp[-1].get('step_index') or 0)
    for step in program_steps[: last_idx + 1]:
        role = str(step.get('io_role') or '').lower()
        val = step.get('value')
        if role == 'vacuum':
            out['vacuum_engaged'] = (val == 1)
        elif role == 'blow_off':
            out['blow_off_active'] = (val == 1)
    return out


class BreadcrumbCollector:
    """Owns the in-memory trail state. All public methods are
    thread-safe — the ROS handlers may call from arbitrary threads,
    and the FastAPI endpoint reads from asyncio."""

    def __init__(self, runs_dir: str = RUNS_DIR, programs_dir: str = PROGRAMS_DIR):
        self._lock = threading.Lock()
        self._runs_dir = runs_dir
        self._programs_dir = programs_dir
        # Latest sampled joints, in DEGREES. We hold these ready so
        # every ProjectState transition can be tagged with the joints
        # the arm was at right when the transition fired.
        self._latest_joints_deg: Optional[List[float]] = None
        # Active trail — mutable while the program runs; moved to
        # `_finalized` on stop/complete.
        self._active: Optional[Dict[str, Any]] = None
        # Cached step-role lookup for the active program (loaded once
        # at run-open, so we don't disk-read on every status event).
        self._active_steps: Optional[List[Dict[str, Any]]] = None
        # ProjectState transition tracking.
        self._prev_state: int = 0
        self._prev_line: Optional[int] = None
        # LRU of finalised trails keyed by program_id (most recent
        # wins). Deque-ish behaviour by insertion order.
        self._finalized: Dict[str, Dict[str, Any]] = {}
        # Task-side pause flag. Snapshotted on status events but
        # updated by on_task_state whenever available so mid-step
        # pauses tag the last breadcrumb correctly.
        self._task_paused: bool = False

    # ── Public: called by the ROS handlers ────────────────────────

    def on_joint_states(self, positions_rad) -> None:
        """/joint_states subscriber calls this on every frame."""
        deg = _rad_list_to_deg(positions_rad)
        with self._lock:
            self._latest_joints_deg = deg

    def on_task_state(self, task_state: Dict[str, Any]) -> None:
        """/task/state subscriber calls this so we know when the run
        transitions into paused. ProjectState alone doesn't clearly
        distinguish paused from stopping on every firmware."""
        with self._lock:
            self._task_paused = bool(task_state.get('paused')
                                     or task_state.get('state') == 'paused')

    def on_program_status(self, status: Dict[str, Any]) -> None:
        """Called from `_on_estun_program_status` for event=status.
        `status` carries `state`, `line`, `task`, `is_step`, plus a
        `program_id` when the driver knows it (the run publisher
        includes it in its op envelope). We look up the current
        program_id from the driver's mirror instead when absent."""
        state = int(status.get('state') or 0)
        line  = status.get('line')
        line  = int(line) if isinstance(line, (int, float)) else None
        prog_id   = status.get('program') or status.get('program_id') or None
        prog_name = status.get('program_name') or prog_id
        with self._lock:
            prev_state, prev_line = self._prev_state, self._prev_line
            self._prev_state, self._prev_line = state, line

            # State 0→2: program started. Open a fresh trail.
            if prev_state != 2 and state == 2:
                self._open_trail(prog_id, prog_name)

            # State 2→2 with line advance: the step at prev_line just
            # completed. Snapshot at prev_line.
            elif state == 2 and prev_state == 2 and self._active is not None \
                    and line is not None and prev_line is not None \
                    and line != prev_line:
                self._append_breadcrumb(prev_line, paused_mid_step=False)

            # State →3 (stopping) or →0 (idle) from an active state:
            # snapshot the LAST line the program was on (which may
            # not have completed if we're stopping mid-move), then
            # finalise if idle.
            elif (prev_state in (2, 3)) and state in (0, 3) and self._active is not None:
                if line is not None:
                    # Mid-step if we're stopping (state=3) or if the
                    # task explicitly reports paused.
                    mid = (state == 3) or self._task_paused
                    self._append_breadcrumb(line, paused_mid_step=mid)
                if state == 0:
                    self._finalize('stopped')

    # ── Public: readers for the preview + retrace endpoints ──────

    def latest_trail(self, program_id: Optional[str] = None
                     ) -> Optional[Dict[str, Any]]:
        """Return the most recent finalised trail, optionally filtered
        by program_id. Prefers the ACTIVE trail if one exists (a
        paused-mid-program run should retrace WHAT WAS ACHIEVED,
        which lives on the active trail)."""
        with self._lock:
            if self._active is not None:
                if not program_id or self._active.get('program_id') == program_id:
                    return json.loads(json.dumps(self._active))
            if program_id:
                t = self._finalized.get(program_id)
                return json.loads(json.dumps(t)) if t else None
            # No filter — return the LAST finalised by insertion order.
            if not self._finalized:
                return None
            k = list(self._finalized.keys())[-1]
            return json.loads(json.dumps(self._finalized[k]))

    def latest_joints_deg(self) -> Optional[List[float]]:
        with self._lock:
            return list(self._latest_joints_deg) if self._latest_joints_deg else None

    def active_program_steps(self) -> Optional[List[Dict[str, Any]]]:
        with self._lock:
            return json.loads(json.dumps(self._active_steps)) if self._active_steps else None

    # ── Internal: state transitions ──────────────────────────────

    def _open_trail(self, program_id: Optional[str],
                    program_name: Optional[str]) -> None:
        # Called under self._lock.
        # Any previously-active trail that never saw a state=0 gets
        # abandoned rather than finalised — either the driver missed
        # a status event or the run overlapped another. Move it aside
        # so a subsequent recovery still has it.
        if self._active is not None:
            self._active['finalized']    = True
            self._active['finish_reason'] = 'abandoned'
            self._active['run_finished_at'] = _now_iso()
            self._finalized[self._active['program_id']] = self._active
            self._active = None
            self._active_steps = None
        if not program_id:
            return
        steps = self._load_program_steps(program_id)
        self._active = {
            'program_id':      program_id,
            'program_name':    program_name or program_id,
            'run_started_at':  _now_iso(),
            'run_finished_at': None,
            'finalized':       False,
            'finish_reason':   None,
            'waypoints':       [],
            'step_roles':      {i: (s.get('position_role') or None)
                                 for i, s in enumerate(steps or [])},
        }
        self._active_steps = steps

    def _append_breadcrumb(self, step_index: int,
                           paused_mid_step: bool = False) -> None:
        # Called under self._lock.
        if self._active is None:
            return
        joints = self._latest_joints_deg or []
        step = None
        if self._active_steps and 0 <= step_index < len(self._active_steps):
            step = self._active_steps[step_index]
        role = (step or {}).get('position_role')
        action = (step or {}).get('action', 'unknown')
        bc = {
            'step_index':      int(step_index),
            'step_role':       role,
            'step_action':     action,
            'joints_deg':      list(joints),
            'ts':              _now_iso(),
            'paused_mid_step': bool(paused_mid_step),
        }
        # De-dupe: if the previous breadcrumb is at the same step
        # AND same joints (tolerance 0.05°/joint), skip. Prevents
        # spam when the driver publishes multiple status events per
        # line transition.
        wps = self._active['waypoints']
        if wps and wps[-1].get('step_index') == step_index \
                and _max_joint_delta_deg(wps[-1].get('joints_deg') or [], joints) < 0.05:
            wps[-1]['paused_mid_step'] = paused_mid_step or wps[-1].get('paused_mid_step', False)
            return
        wps.append(bc)

    def _finalize(self, reason: str) -> None:
        # Called under self._lock.
        if self._active is None:
            return
        self._active['finalized']       = True
        self._active['finish_reason']   = reason
        self._active['run_finished_at'] = _now_iso()
        # Persist to disk (best-effort — failure to write must never
        # blow up the ROS handler).
        try:
            os.makedirs(self._runs_dir, exist_ok=True)
            fname = self._active['run_started_at'].replace(':', '').replace('-', '') \
                    + '_' + self._active['program_id'] + '_breadcrumbs.json'
            with open(os.path.join(self._runs_dir, fname), 'w') as f:
                json.dump(self._active, f, indent=2)
        except Exception:
            pass
        prog_id = self._active['program_id']
        self._finalized[prog_id] = self._active
        # LRU eviction.
        while len(self._finalized) > MEM_CAP:
            oldest = next(iter(self._finalized))
            del self._finalized[oldest]
        self._active = None
        self._active_steps = None

    def _load_program_steps(self, program_id: str) -> List[Dict[str, Any]]:
        path = os.path.join(self._programs_dir, f'{program_id}.json')
        try:
            with open(path) as f:
                prog = json.load(f)
            steps = prog.get('steps') or []
            return list(steps) if isinstance(steps, list) else []
        except Exception:
            return []

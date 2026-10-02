// Unified run-state derivation.
//
// Before this module, the Monitor status pill and the StatusBar footer
// both read from `task.*` (executor state via /task/state), while the
// green Estun banner read from `robot.program.*` (publish/ProjectState
// mirror). When a program ran through the wire-proven Estun pipeline
// the executor stays idle, so the pill said IDLE while the banner
// said RUNNING. This helper is the ONE source of truth every widget
// now consumes.
//
// Precedence (highest wins):
//   1. safety.estop            → 'estop'      "E-STOP"
//   2. robot.active_alarm      → 'alarm'      "ALARM {code}: {text}"
//   3. robot.enabled === false → 'disabled'   "DISABLED"  (motor power off;
//                                              programs can't run at all)
//   4. robot.program.state=3   → 'paused' or 'stopping' — disambiguated
//                                by programIntent (see below)
//   5. robot.program.state=2   → 'running'    "RUNNING · {task} · line {line}"
//                                              or "SINGLE-STEP · line {line}"
//   6. task.paused             → 'paused'     "PAUSED"    (executor sim path)
//   7. task.running            → 'running'    "RUNNING"   (executor sim path)
//   8. else                    → 'idle'       "IDLE"
//
// Rules 4-5 are the Estun ProjectState feed (the driver's authoritative
// mirror of what's actually happening on the wire). Rules 6-7 are the
// executor's own state — kept as a fallback so the sim and any
// non-Estun run paths still light up the pill correctly.
//
// programIntent (2026-09-02): on the CC10-A controller, both project/
// pause and project/stop land at ProjectState.state=3 — the difference
// is that stop transitions 3→0 within a second while pause holds at 3
// indefinitely. Since the frame we're reading may be the first 3 after
// EITHER verb, we disambiguate off the client-tracked intent set by
// pauseProgram/cancelProgram BEFORE the wire verb fires. Absent
// intent, we default to 'stopping' — that preserves backwards
// compatibility with the pre-pause behavior for any state=3 the
// operator didn't ask for (e.g., driver-side auto-stop).

export function deriveRunState({ robot, task, safety, programIntent } = {}) {
  robot  = robot  || {}
  task   = task   || {}
  safety = safety || {}

  if (safety.estop) {
    return { kind: 'estop', label: 'E-STOP', color: '#DC2626', bg: '#FEF2F2',
             border: '#DC2626', pulse: false }
  }
  if (robot.active_alarm && typeof robot.active_alarm === 'object') {
    const a = robot.active_alarm
    return { kind: 'alarm',
             label: `ALARM ${a.code ?? ''}`,
             detail: a.text || '',
             color: '#B45309', bg: '#FEF3C7', border: '#B45309', pulse: true }
  }
  if (robot.connected && robot.enabled === false) {
    return { kind: 'disabled', label: 'DISABLED', color: '#6b7280',
             bg: '#F3F4F6', border: '#9CA3AF', pulse: false,
             detail: robot.state_name || '' }
  }

  const prog = robot.program || {}
  const line = prog.line
  const taskName = prog.task

  // Stale-link honesty (2026-08-04). If the driver's WS to the
  // controller has dropped (robot.connected === false) but the
  // last-known program.state was 2 or 3, we CANNOT know if the
  // arm is still running / stopping — the /estun/mode feed that
  // updated program.state is dark. Prior to this branch the pill
  // stayed green "RUNNING" indefinitely: the freshness gate was
  // wired to dashboard→browser WS silence, and the dashboard→
  // browser stream stays fresh even when the underlying
  // controller state is stale. Ambering out here IS the honesty
  // fix: the last-known state is preserved in the detail line
  // so the operator sees where the controller was when the link
  // dropped, but the label + amber color make the loss of truth
  // explicit. Do not treat this as a wedge (the STOP button
  // still works) — a genuine wedge fires the STOPPING branch
  // when connectivity returns.
  if (robot.connected === false && (prog.state === 2 || prog.state === 3)) {
    const last = prog.state === 3 ? 'STOPPING' : 'RUNNING'
    const lineTag = line != null ? `line ${line}` : ''
    return { kind: 'stale_link_down',
             label: `${last}? · LINK DOWN`,
             color: '#B45309', bg: '#FEF3C7', border: '#B45309',
             pulse: false,
             detail: `last known: ${last.toLowerCase()}`
                   + (lineTag ? ` · ${lineTag}` : '')
                   + '. Controller feed dark — actual state unknown.' }
  }

  if (prog.state === 3) {
    if (programIntent === 'pause') {
      return { kind: 'paused', label: 'PAUSED', color: '#CA8A04',
               bg: '#FFFBEB', border: '#CA8A04', pulse: false,
               detail: line != null ? `line ${line}` : '' }
    }
    return { kind: 'stopping', label: 'STOPPING', color: '#B45309',
             bg: '#FEF3C7', border: '#B45309', pulse: true,
             detail: line != null ? `line ${line}` : '' }
  }
  if (prog.state === 2) {
    const isStep = !!prog.is_step
    const detail = [
      isStep ? 'single-step' : null,
      taskName ? `task ${taskName}` : null,
      line != null ? `line ${line}` : null,
    ].filter(Boolean).join(' · ')
    return { kind: 'running', label: isStep ? 'SINGLE-STEP' : 'RUNNING',
             color: '#16A34A', bg: '#F0FDF4', border: '#16A34A',
             pulse: !isStep, detail }
  }

  // Executor / sim fallback.
  if (task.paused) {
    return { kind: 'paused', label: 'PAUSED', color: '#CA8A04', bg: '#FFFBEB',
             border: '#CA8A04', pulse: false }
  }
  if (task.running) {
    return { kind: 'running', label: 'RUNNING', color: '#16A34A',
             bg: '#F0FDF4', border: '#16A34A', pulse: true,
             detail: task.step_label ? `step ${task.step_label}` : '' }
  }
  return { kind: 'idle', label: 'IDLE', color: '#6b7280', bg: '#F3F4F6',
           border: '#D1D5DB', pulse: false }
}

// ── Stuck-STOPPING recovery (Part D, 2026-07-22) ─────────────────
//
// A project/stop should transition the Estun controller through
// state 2 → 3 → 0 in well under a second. If it sits at 3 for
// STUCK_STOPPING_MS or longer, either the driver's stop ack was
// dropped or the interpreter stalled mid-motion. These pure
// helpers let the Monitor UI decide when to surface the recovery
// banner and which buttons stay enabled — no React, easily unit-
// tested in isolation.

export const STUCK_STOPPING_MS = 3000

// State-stream freshness threshold. When the client hasn't received
// a WS frame carrying robot.program.state in this long, treat the
// stream as stale and DO NOT blame the controller for a wedge —
// there's no live evidence the controller is still in state 3;
// what we're actually seeing is a subscription stall (driver
// reconnected, WS backpressure, controller offline, etc.). Value is
// deliberately shorter than the wedge threshold so a stale stream
// hides the wedge banner instead of racing it.
export const STATE_STREAM_STALE_MS = 2500

// Returns true when we haven't seen a program.state frame in at
// least STATE_STREAM_STALE_MS. `lastProgramStateTs` is a Date.now()
// captured client-side when a WS frame with msg.robot.program.state
// arrives; `nowTs` is Date.now(). Both are on the SAME machine, so
// this is safe under any clock skew against the server. A 0
// timestamp means we've never received a state frame this session
// — treated as stale so a freshly-loaded page with no data yet
// doesn't immediately assert a controller wedge.
export function isStateStreamStale(lastProgramStateTs, nowTs = Date.now(),
                                   staleMs = STATE_STREAM_STALE_MS) {
  if (!lastProgramStateTs) return true
  return (nowTs - lastProgramStateTs) >= staleMs
}

// The STOP button MUST stay enabled in every active state so a
// wedged program can always be interrupted. Deliberately exempt
// from the gate-open / estop-clear checks that grey out the OTHER
// motion verbs — STOP works precisely when things are running or
// wedged, so its enable-state cannot depend on the same conditions
// that got the arm into trouble.
export function isStopButtonEnabled(runStateKind) {
  return runStateKind === 'running'
      || runStateKind === 'paused'
      || runStateKind === 'stopping'
      || runStateKind === 'alarm'
}

// Returns true if the run state is 'stopping' AND the operator has
// been waiting at least STUCK_STOPPING_MS since the transition.
// `stoppingSinceTs` is a wall-clock ms epoch OR null. `nowTs` is
// injectable so tests can advance a fake clock; falls back to
// Date.now().
export function isStuckStopping(runStateKind, stoppingSinceTs,
                                nowTs = Date.now()) {
  if (runStateKind !== 'stopping') return false
  if (stoppingSinceTs == null) return false
  return (nowTs - stoppingSinceTs) >= STUCK_STOPPING_MS
}

// A "run-family" verb (Home, Restart) is normally disabled while
// active — but when isStuckStopping is true, it re-enables (with a
// confirm prompt supplied by the caller) so the operator has a
// path out of the wedge.
export function homeButtonEnabled({ runStateKind, stoppingSinceTs, safety, robot,
                                    nowTs = Date.now() }) {
  const stuck = isStuckStopping(runStateKind, stoppingSinceTs, nowTs)
  // Never allowed under an estop — pressing home while estopped
  // would waste the operator's confirm click on a guaranteed refusal.
  if (safety && safety.estop) return false
  // Normal path: enabled in idle/disabled; disabled while active.
  if (runStateKind === 'running' || runStateKind === 'paused'
      || runStateKind === 'alarm') {
    return false
  }
  if (runStateKind === 'stopping') return stuck
  return !!(robot && robot.connected)
}

export function restartButtonEnabled({ runStateKind, stoppingSinceTs, safety,
                                       nowTs = Date.now() }) {
  const stuck = isStuckStopping(runStateKind, stoppingSinceTs, nowTs)
  if (safety && safety.estop) return false
  // Restart is meaningful in idle (re-run) and in stuck-STOPPING
  // (recovery). Not offered mid-run (use Stop first) or mid-alarm
  // (fix the alarm first).
  if (runStateKind === 'running' || runStateKind === 'paused'
      || runStateKind === 'alarm') {
    return false
  }
  if (runStateKind === 'stopping') return stuck
  return true
}

// Line-map (D9 · 2026-08-03) — the codegen-emitted step map is the
// single source of truth. `/api/programs/{id}/line_map` returns a
// sidecar authored by `program_ops.codegen_lua_from_program`; each
// entry is `{step_idx, step_id, action, lua_line_start, lua_line_end}`.
// The prior heuristic that reproduced the walker in JS was retired
// after the 2026-07-30 audit — codegen emits multi-line preludes
// (setSpeedJ, ADAPTED comments) that broke the "one Lua line per
// step" assumption. The sidecar is authored by the same code that
// emitted the lines, so the map can't drift from the wire.
//
// stepIndexForLine consumes a fetched line_map (pass as second arg)
// and does an inclusive-range lookup. Returns -1 when there's no
// map or the line falls outside every step's range — the caller
// then either falls through to task.program_step (executor sim
// path) or renders no highlight (honesty rule).

export function stepIndexForLine(_program, line, lineMap) {
  if (line == null || line <= 0) return -1
  if (!Array.isArray(lineMap) || lineMap.length === 0) return -1
  for (let i = 0; i < lineMap.length; i++) {
    const e = lineMap[i]
    if (!e) continue
    const s = e.lua_line_start
    const t = e.lua_line_end
    if (!Number.isInteger(s) || !Number.isInteger(t)) continue
    if (line >= s && line <= t) {
      return Number.isInteger(e.step_idx) ? e.step_idx : i
    }
  }
  return -1
}

// Honesty guard — the wire's `robot.program.codegen_sha` (mirrored
// by the dashboard on every save_project) MUST equal the line_map
// sidecar's `codegen_sha`. Mismatch means the resident Lua doesn't
// match this map (stale resident, foreign program, mid-deploy race)
// and the caller MUST NOT highlight. Returns:
//   {ok: true}                         — map matches resident
//   {ok: false, reason: 'no_resident'} — nothing running to compare
//   {ok: false, reason: 'no_map'}      — sidecar not fetched yet
//   {ok: false, reason: 'sha_mismatch',
//    resident, map}                    — protocol wire disagrees
//   {ok: false, reason: 'wrong_program',
//    resident_program_id, map_program_id}
export function lineMapHonesty({ residentSha, residentProgramId,
                                 lineMapSha, lineMapProgramId }) {
  if (!residentSha) return { ok: false, reason: 'no_resident' }
  if (!lineMapSha)  return { ok: false, reason: 'no_map' }
  if (lineMapProgramId && residentProgramId
      && lineMapProgramId !== residentProgramId) {
    return { ok: false, reason: 'wrong_program',
             resident_program_id: residentProgramId,
             map_program_id: lineMapProgramId }
  }
  if (residentSha !== lineMapSha) {
    return { ok: false, reason: 'sha_mismatch',
             resident: residentSha, map: lineMapSha }
  }
  return { ok: true }
}

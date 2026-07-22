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
//   4. robot.program.state=3   → 'stopping'   "STOPPING"  (project/stop in flight)
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

export function deriveRunState({ robot, task, safety } = {}) {
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
  if (prog.state === 3) {
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

// Reproduce the codegen's line-emission decision for each step so the
// step-preview panel can find WHICH step corresponds to a given
// ProjectState.line value. Matches program_ops.codegen_lua_from_program
// in the driver — every step (valid or skipped) consumes one file line;
// executable-line index equals step index + 1 in the emitted Lua.
//
// Returns an array parallel to steps, where each entry is:
//   { emittedLine: 1-based int, kind: 'movJ' | 'skipped' }
// A skipped step still gets a line number (the codegen emits a comment
// on it) but the interpreter's ProjectState.line never lands there —
// so the step-preview panel treats 'skipped' entries as un-highlightable.
export function computeLineMap(program) {
  const steps = (program && Array.isArray(program.steps)) ? program.steps : []
  const points = (program && program.points) || {}
  const out = []
  let line = 1
  for (const step of steps) {
    if (!step) { out.push({ emittedLine: line++, kind: 'skipped' }); continue }
    const pn = step.point_name
    const hasPointRef = pn && points[pn]
      && Array.isArray(points[pn].joints) && points[pn].joints.length === 6
    const hasTaught = Array.isArray(step.taught_joints) && step.taught_joints.length === 6
    if (hasPointRef || hasTaught) {
      out.push({ emittedLine: line, kind: 'movJ' })
    } else {
      out.push({ emittedLine: line, kind: 'skipped' })
    }
    line += 1
  }
  return out
}

// stepIndexForLine(program, line) — inverse of computeLineMap. Given the
// ProjectState.line the driver reports, find the step index (0-based)
// whose emittedLine matches. Returns -1 when no match (line points at
// a footer/blank/comment line the driver shouldn't normally report).
export function stepIndexForLine(program, line) {
  if (line == null || line <= 0) return -1
  const map = computeLineMap(program)
  for (let i = 0; i < map.length; i++) {
    if (map[i].emittedLine === line) return i
  }
  return -1
}

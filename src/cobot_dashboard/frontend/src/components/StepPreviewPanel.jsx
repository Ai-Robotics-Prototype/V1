import { useStore } from '../store/useStore'
import { deriveRunState, stepIndexForLine } from '../lib/runState'

// Non-motion step actions — these don't take a pose. Keep in sync with
// the backend's _NON_MOTION_ACTIONS in dashboard_server.py.
const NON_MOTION_ACTIONS = new Set([
  'set_io', 'wait', 'wait_input', 'loop', 'gripper', 'gripper_close',
  'gripper_open', 'pause', 'comment', 'end', 'vacuum_on', 'vacuum_off',
])

// Compact per-step target/status classifier for the step-preview panel.
// Reads the truth on disk — never re-derives it — so the panel matches
// what the executor + codegen see. Order of precedence matches the
// backend's _has_taught_poses so display and gate agree.
//
// Returns { text, kind } where kind is one of:
//   'taught'    — bright: step has an authored pose
//   'derived'   — bright-muted: pose resolves at runtime from an anchor
//   'nonmotion' — subtle: action doesn't need a pose (SET_IO / WAIT / LOOP …)
//   'blocked'   — amber: SET_IO / WAIT whose I/O verb isn't captured yet
//   'untaught'  — amber: motion step missing a pose source
function classifyStep(step, program) {
  const points = (program && program.points) || {}
  const action = String(step?.action || '').toLowerCase()

  // Taught inline / via point ref (has authored pose).
  const pn = step?.point_name
  if (pn && points[pn]
      && Array.isArray(points[pn].joints) && points[pn].joints.length === 6) {
    return { kind: 'taught', text: `→ ${pn}` }
  }
  const hasTj = Array.isArray(step?.taught_joints) && step.taught_joints.length === 6
  if (hasTj) {
    const role = step?.position_role
    return { kind: 'taught', text: role ? `→ ${role} (taught)` : '→ (taught)' }
  }
  // Derived-from-anchor motion — resolves at runtime.
  if (step?.derived_from) {
    return { kind: 'derived', text: `↳ from ${step.derived_from}` }
  }
  // Non-motion actions: no pose required. Flag SET_IO / WAIT as
  // blocked on I/O verbs so the operator sees them distinctly from
  // taught / untaught motion.
  if (NON_MOTION_ACTIONS.has(action)) {
    if (action === 'set_io' || action === 'vacuum_on' || action === 'vacuum_off') {
      const port = step?.io_id ? ` ${step.io_id}` : ''
      return { kind: 'blocked', text: `I/O${port} · pending capture` }
    }
    if (action === 'wait') {
      return { kind: 'blocked', text: `wait ${step?.duration_s ?? '?'}s · no delay verb` }
    }
    if (action === 'wait_input') {
      const port = step?.io_id ? ` ${step.io_id}` : ''
      // wait_input emits a getDI(port) read via program_ops codegen —
      // wire-verified verb, so this step is no longer blocked. Show
      // as neutral non-motion.
      return { kind: 'nonmotion', text: `read${port} (getDI)` }
    }
    if (action === 'loop') {
      const g = step?.goto != null ? ` → step ${step.goto}` : ''
      return { kind: 'nonmotion', text: `loop${g}` }
    }
    if (action.startsWith('gripper')) {
      return { kind: 'blocked', text: 'gripper · pending capture' }
    }
    return { kind: 'nonmotion', text: action }
  }
  return { kind: 'untaught', text: 'not taught' }
}

const KIND_STYLE = {
  taught:    { color: '#6b7280', weight: 500 },
  derived:   { color: '#0369A1', weight: 500 },   // sky-blue: authored but deferred
  nonmotion: { color: '#9CA3AF', weight: 400 },
  blocked:   { color: '#B45309', weight: 500 },   // amber: needs a captured verb
  untaught:  { color: '#B45309', weight: 600 },
}

// Live step-preview panel — shows the currently-loaded program's steps
// with the executing step highlighted from publish/ProjectState
// scripts.{task}.line.
//
// Line→step mapping (see lib/runState.computeLineMap):
//   program_ops.codegen_lua_from_program emits ONE Lua line per step.
//   A step with a valid taught pose (either step.taught_joints[6] or
//   step.point_name resolving in program.points{}) emits movJ; a
//   step without valid poses emits a "-- skipped …" comment. The
//   interpreter's ProjectState.line reports the FILE-LINE number
//   for the currently-executing line; comment lines are never
//   reported (the interpreter skips them). So the mapping is:
//     step_index = ProjectState.line - 1                (well-formed programs)
//     step_index = index of the step whose emittedLine == line
//                                                        (with skipped steps
//                                                         interleaved)
//   computeLineMap handles both cases.
//
// Behavior:
//   - Header shows "Step {current+1} / {total}" when collapsed,
//     "Steps ({total})" when expanded.
//   - Completed steps: green check.
//   - Current step: highlighted + pulsing dot.
//   - Upcoming steps: dimmed.
//   - On state=0 (idle) all steps un-highlight.

export default function StepPreviewPanel() {
  const cp = useStore((s) => s.currentProgram)
  const robot = useStore((s) => s.robot) || {}
  const task = useStore((s) => s.task)
  const safety = useStore((s) => s.safety)
  const open = useStore((s) => s.stepPanelOpen)
  const setOpen = useStore((s) => s.setStepPanelOpen)

  const runState = deriveRunState({ robot, task, safety })
  const steps = Array.isArray(cp?.steps) ? cp.steps : []
  const total = steps.length

  // Which step is currently executing? Only meaningful in running /
  // stopping / paused states — everything else clears the highlight.
  let currentIdx = -1
  const isActive = runState.kind === 'running' || runState.kind === 'stopping'
                   || runState.kind === 'paused'
  if (isActive) {
    const line = robot?.program?.line
    if (Number.isInteger(line) && line > 0) {
      currentIdx = stepIndexForLine(cp, line)
    }
    // Fall back to sim executor's program_step when the Estun feed
    // isn't populated (sim path) — task.program_step is 0-indexed.
    if (currentIdx < 0 && Number.isInteger(task?.program_step)) {
      currentIdx = task.program_step
    }
  }

  if (total === 0) return null   // nothing to show; hide the panel

  const wrap = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
    marginTop: 12, overflow: 'hidden',
  }
  const header = {
    padding: '8px 12px', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', cursor: 'pointer',
    background: '#f8fafc', borderBottom: open ? '1px solid #e5e7eb' : 'none',
    fontSize: 12, fontWeight: 700, color: '#374151',
    letterSpacing: '0.05em', textTransform: 'uppercase',
    userSelect: 'none',
  }
  const list = { maxHeight: 260, overflow: 'auto' }

  return (
    <div style={wrap}>
      <div style={header} onClick={() => setOpen(!open)}>
        <span>
          {open
            ? `Steps (${total})`
            : (isActive && currentIdx >= 0)
              ? `Step ${currentIdx + 1} / ${total}`
              : `Steps · ${total}`}
        </span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          {open ? '▼ collapse' : '▶ expand'}
        </span>
      </div>
      {open && (
        <div style={list}>
          {steps.map((s, i) => {
            const isDone = isActive && currentIdx >= 0 && i < currentIdx
            const isCurrent = isActive && i === currentIdx
            const isUpcoming = !isActive || (currentIdx < 0) || i > currentIdx
            const bg = isCurrent ? '#EFF6FF'
                     : isDone    ? '#F0FDF4'
                     : '#fff'
            const border = isCurrent ? '2px solid #2563EB' : '1px solid #f3f4f6'
            const label = s.label || s.action || `Step ${i + 1}`
            const type = (s.type || s.action || '').toString().toUpperCase().slice(0, 12)
            const status = classifyStep(s, cp)
            const statusStyle = KIND_STYLE[status.kind] || KIND_STYLE.untaught
            return (
              <div key={s.id ?? i}
                   style={{
                     display: 'grid',
                     gridTemplateColumns: '28px 40px 1fr auto',
                     alignItems: 'center', gap: 8,
                     padding: '6px 12px',
                     background: bg,
                     borderLeft: border,
                     borderBottom: '1px solid #f3f4f6',
                     opacity: isUpcoming ? 0.7 : 1,
                     fontSize: 13,
                   }}>
                <span style={{
                  fontSize: 14, textAlign: 'center',
                  color: isDone ? '#16A34A' : isCurrent ? '#2563EB' : '#9ca3af',
                  fontWeight: 700,
                }}>
                  {isDone ? '✓' : isCurrent ? '●' : (i + 1)}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: '#6b7280', fontFamily: 'monospace',
                }}>{type}</span>
                <span style={{
                  fontWeight: isCurrent ? 700 : 500,
                  color: isCurrent ? '#1E40AF' : '#374151',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {label}
                  {isCurrent && (
                    <span style={{
                      marginLeft: 8, display: 'inline-block',
                      width: 8, height: 8, borderRadius: '50%',
                      background: '#2563EB',
                      animation: 'pulse-dot 1.5s ease-in-out infinite',
                      verticalAlign: 'middle',
                    }} />
                  )}
                </span>
                <span style={{
                  fontSize: 11, fontFamily: 'monospace',
                  color: statusStyle.color, fontWeight: statusStyle.weight,
                }}>
                  {status.text}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

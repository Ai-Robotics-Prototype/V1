import { useStore } from '../store/useStore'
import { deriveRunState, computeLineMap, stepIndexForLine } from '../lib/runState'

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

  const lineMap = computeLineMap(cp || {})

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
            const wouldSkip = (lineMap[i] || {}).kind === 'skipped'
            const bg = isCurrent ? '#EFF6FF'
                     : isDone    ? '#F0FDF4'
                     : '#fff'
            const border = isCurrent ? '2px solid #2563EB' : '1px solid #f3f4f6'
            const label = s.label || s.action || `Step ${i + 1}`
            const type = (s.type || s.action || '').toString().toUpperCase().slice(0, 12)
            const target = s.point_name
              || (Array.isArray(s.taught_joints) && s.taught_joints.length === 6 ? '(taught inline)' : null)
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
                  fontSize: 11, color: '#6b7280', fontFamily: 'monospace',
                }}>
                  {target
                    ? `→ ${target}`
                    : wouldSkip ? <span style={{ color: '#B45309' }}>not taught</span> : ''}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

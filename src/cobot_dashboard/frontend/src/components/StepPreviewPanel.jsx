import { useStore } from '../store/useStore'
import { deriveRunState, stepIndexForLine } from '../lib/runState'

// Live step-preview panel — shows the currently-loaded program's steps
// with the executing step highlighted from publish/ProjectState
// scripts.{task}.line.
//
// Display is titles-only: step number, type tag, label. No per-step
// classifier annotation — the old right-hand column (I/O DO2 · pending
// capture, wait 0.5s · no delay verb, → pick (taught), etc.) has been
// removed. Codegen now emits real verbs for every non-motion action
// (setDO/setAO for set_io, wait() for wait, getDI for wait_input,
// goto/label for loop), so the "pending" annotations were both noisy
// and stale. Live state — executing highlight, green checkmark for
// completed — stays.
//
// Line→step mapping (see lib/runState.computeLineMap):
//   program_ops.codegen_lua_from_program emits ONE Lua line per step.
//   The interpreter's ProjectState.line reports the FILE-LINE number
//   for the currently-executing line; skipped comment lines are never
//   reported (the interpreter skips them). computeLineMap handles the
//   mapping.

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
            return (
              <div key={s.id ?? i}
                   style={{
                     display: 'grid',
                     gridTemplateColumns: '28px 96px 1fr',
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

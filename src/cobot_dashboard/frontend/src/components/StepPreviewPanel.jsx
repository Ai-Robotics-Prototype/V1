import { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { deriveRunState, stepIndexForLine, lineMapHonesty }
  from '../lib/runState'
import { useLineMap } from '../lib/useLineMap'

// Live step-preview panel — shows the currently-loaded program's
// steps with the executing step highlighted from publish/ProjectState
// scripts.{task}.line, JOINED against the D9 line_map sidecar for
// that program (2026-08-03). No more regex heuristics — the map is
// authored by the codegen that wrote the resident Lua lines.
//
// Honesty guard: the resident program's codegen_sha (mirrored into
// STATE.robot.program.codegen_sha by the dashboard on save_project)
// MUST equal the line_map sidecar's codegen_sha before we highlight.
// Mismatch = stale resident, foreign program, or mid-deploy race →
// render no highlight + a small "line map unavailable" note (never
// highlight the wrong step — truth-audit rule stands).

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

  // D9 line_map fetch (2026-08-03). Cache-key components:
  //   * program id (obvious)
  //   * cp.rev — bumps on every /api/programs PUT
  //   * pushed_lua_sha12 — bumps on every /api/estun/program/run,
  //     because save_project re-writes the sidecar with the
  //     currently-running codegen sha. Including it in the key
  //     forces a refetch as soon as the push mints a new sha,
  //     even when the operator didn't edit the program.
  const pushedLuaSha12 = useStore((s) => s.robot?.program?.pushed_lua_sha12)
  const {
    lineMap, codegenSha: mapCodegenSha,
    programId: mapProgramId,
    loading: mapLoading, error: mapError,
  } = useLineMap(cp?.id, `${cp?.rev ?? ''}#${pushedLuaSha12 ?? ''}`)

  // Honesty guard against the resident program's codegen sha.
  const residentSha = robot?.program?.codegen_sha
  const residentProgramId = robot?.program?.resident_program_id
                            ?? robot?.program?.project_id
  const honesty = lineMapHonesty({
    residentSha,
    residentProgramId,
    lineMapSha: mapCodegenSha,
    lineMapProgramId: mapProgramId,
  })

  // Which step is currently executing? Only meaningful in running /
  // stopping / paused states — everything else clears the highlight.
  let currentIdx = -1
  const isActive = runState.kind === 'running' || runState.kind === 'stopping'
                   || runState.kind === 'paused'
  if (isActive) {
    const line = robot?.program?.line
    if (Number.isInteger(line) && line > 0 && honesty.ok) {
      currentIdx = stepIndexForLine(cp, line, lineMap)
    }
    // Fall through to executor sim path only when the line_map path
    // is BLANK (no resident, no map yet), not on a stamp mismatch —
    // a mismatch means we KNOW the map is wrong for the wire.
    if (currentIdx < 0
        && (honesty.ok || honesty.reason === 'no_resident'
            || honesty.reason === 'no_map')
        && Number.isInteger(task?.program_step)) {
      currentIdx = task.program_step
    }
  }

  // Auto-scroll the current step row into view as it advances.
  const currentRowRef = useRef(null)
  useEffect(() => {
    if (open && currentIdx >= 0 && currentRowRef.current) {
      try { currentRowRef.current.scrollIntoView({
        block: 'nearest', behavior: 'smooth' }) } catch {}
    }
  }, [currentIdx, open])

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
          {isActive && !honesty.ok
             && honesty.reason === 'sha_mismatch' && (
            <div data-testid="line-map-unavailable"
                 style={{
                   padding: '6px 12px', fontSize: 11,
                   color: '#92400E', background: '#FEF3C7',
                   borderBottom: '1px solid #FCD34D',
                 }}>
              Line map unavailable — resident codegen sha
              {' '}(<code>{residentSha}</code>) doesn't match the
              saved program's map (<code>{mapCodegenSha}</code>).
              Highlight suppressed until they agree (re-run to push
              a fresh Lua).
            </div>
          )}
          {isActive && !honesty.ok
             && honesty.reason === 'wrong_program' && (
            <div data-testid="line-map-unavailable"
                 style={{
                   padding: '6px 12px', fontSize: 11,
                   color: '#92400E', background: '#FEF3C7',
                   borderBottom: '1px solid #FCD34D',
                 }}>
              Line map unavailable — resident program on the
              controller is <code>{honesty.resident_program_id}</code>,
              but this panel is showing <code>{honesty.map_program_id}</code>.
              Highlight suppressed.
            </div>
          )}
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
                   ref={isCurrent ? currentRowRef : null}
                   data-testid={isCurrent ? 'step-current' : undefined}
                   data-step-idx={i}
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

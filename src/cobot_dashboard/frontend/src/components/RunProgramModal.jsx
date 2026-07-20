import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

// Confirm modal for the Monitor "Run Program" button. Reads the same
// currentProgram + robot.allow_move + robot.operator_speed_limit that
// the ladder pipeline gates on — so the modal shows the OPERATOR
// EXACTLY what will happen (which program, how many steps, what speed
// after the cap, whether the gate is even open).
//
// Behavior:
//   - Opens when store.runModalOpen === true (set by MonitorDashboard's
//     Run button handler).
//   - Confirm → POST /api/estun/program/run — the ladder-proven pipeline
//     kicks off (codegen → HTTP save → run) end-to-end. The response
//     surfaces:
//       ok=true  → run published, modal closes and Monitor's live line
//                  indicator takes over.
//       ok=false → gate closed or save failed. Modal stays open,
//                  showing the driver's OWN rejection reason (from
//                  STATE.robot.rejected's newest entry). Never a
//                  generic "something went wrong".
//   - Cancel or backdrop click → close, no wire traffic.
//
// The modal does NOT pre-check the gate. Per the operator's requirement
// (Lesson 97 follow-up), pressing Run with the gate closed must still
// attempt and surface the DRIVER'S rejection — proves the pipeline is
// wired end-to-end even when nothing moves.

export default function RunProgramModal() {
  const open           = useStore((s) => s.runModalOpen)
  const close          = useStore((s) => s.closeRunModal)
  const currentProgram = useStore((s) => s.currentProgram)
  const robot          = useStore((s) => s.robot) || {}
  const runSpeedPct    = useStore((s) => s.runSpeedPct)

  const [phase, setPhase]   = useState('confirm')  // 'confirm' | 'running' | 'error' | 'ok'
  const [result, setResult] = useState(null)
  const [errorText, setErrorText] = useState('')

  // Reset local state each time the modal is opened.
  useEffect(() => {
    if (open) {
      setPhase('confirm')
      setResult(null)
      setErrorText('')
    }
  }, [open])

  if (!open) return null

  const stepCount = Array.isArray(currentProgram?.steps) ? currentProgram.steps.length : 0
  const taughtCount = Array.isArray(currentProgram?.steps)
    ? currentProgram.steps.filter((s) => Array.isArray(s?.taught_joints)
                                          && s.taught_joints.length === 6).length
    : 0
  // The Monitor speed input feeds runSpeedPct in the store; this
  // modal reads from THAT (not program.config.speed_pct) so what
  // the operator saw next to Run is exactly what confirm ships.
  const requestedPct = Number(
    runSpeedPct ?? currentProgram?.config?.speed_pct ?? currentProgram?.speed_pct ?? 10
  )
  const operatorCapFrac = Number(robot?.operator_speed_limit ?? 0.25)
  const operatorCapPct  = Math.max(1, Math.min(100, Math.round(operatorCapFrac * 100)))
  const effectivePct    = Math.max(1, Math.min(operatorCapPct, requestedPct))
  const isCapped        = requestedPct > operatorCapPct

  const allowMove   = !!robot.allow_move
  const monitorOnly = !!robot.monitor_only
  const connected   = !!robot.connected

  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const panel = {
    background: '#fff', borderRadius: 12,
    padding: 24, minWidth: 480, maxWidth: 560,
    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
  }
  const titleStyle = { fontSize: 20, fontWeight: 700, marginBottom: 12, color: '#111827' }
  const rowStyle = { padding: '8px 0', borderBottom: '1px solid #f3f4f6',
                     display: 'flex', justifyContent: 'space-between', fontSize: 14 }
  const btnRow = { marginTop: 20, display: 'flex', gap: 12, justifyContent: 'flex-end' }
  const btnPrimary = (color, disabled) => ({
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    background: disabled ? '#9CA3AF' : color, color: '#fff',
    border: 'none', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const btnGhost = {
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
  }

  const gateOK = allowMove && !monitorOnly && connected

  async function confirmRun() {
    if (!currentProgram?.id) {
      setPhase('error'); setErrorText('No program loaded.'); return
    }
    setPhase('running'); setResult(null); setErrorText('')
    try {
      const res = await fetch('/api/estun/program/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          program_id: currentProgram.id,
          // Send the operator's Monitor-entered speed. Backend clamps
          // 1..100 then compares to operator_speed_limit for the hard
          // cap. We already display the cap outcome in the modal so
          // Confirm is a no-surprise action.
          run_speed_pct: requestedPct,
        }),
      })
      const body = await res.json()
      setResult(body)
      if (body?.ok) {
        // Run has been published; the driver's ProjectState will drive
        // the Monitor's live line indicator from here. Close the modal
        // after a brief pause so the operator sees the confirmation.
        setPhase('ok')
        setTimeout(close, 900)
      } else {
        setPhase('error')
        // Surface the driver's own reason when the gate rejected.
        const reason = body?.outcome?.reason
          || body?.error
          || `HTTP ${res.status}`
        setErrorText(reason)
      }
    } catch (e) {
      setPhase('error')
      setErrorText(String(e))
    }
  }

  return (
    <div style={backdrop} onClick={phase === 'running' ? null : close}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>
          {phase === 'ok' ? '✓ Run started' :
           phase === 'error' ? '⚠ Run refused' :
           phase === 'running' ? 'Starting…' :
           'Run this program on the REAL ARM?'}
        </div>

        {phase === 'confirm' && (
          <>
            <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 12 }}>
              This will overwrite the controller's stored copy of the
              program (fresh codegen every press — no stale points),
              then run it autonomously.
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Program</span>
              <span style={{ fontWeight: 600 }}>
                {currentProgram?.name || currentProgram?.id || '(none)'}
              </span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Steps</span>
              <span>
                {taughtCount} taught / {stepCount} total
              </span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Requested speed</span>
              <span>{requestedPct}%{isCapped ? ' (from Monitor input)' : ''}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Operator cap</span>
              <span>{operatorCapPct}%</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280', fontWeight: 600 }}>
                Effective speed
              </span>
              <span style={{ fontWeight: 700, color: isCapped ? '#B45309' : '#059669' }}>
                {isCapped
                  ? `${effectivePct}% (capped from ${requestedPct}%)`
                  : `${effectivePct}%`}
                {' — runs on REAL ARM'}
              </span>
            </div>
            {!gateOK && (
              <div style={{
                marginTop: 12, padding: 10, background: '#FEF3C7',
                border: '1px solid #F59E0B', borderRadius: 6,
                color: '#92400E', fontSize: 13,
              }}>
                <b>Move gate closed.</b>{' '}
                {monitorOnly ? 'Driver is in MONITOR-ONLY mode. ' : ''}
                {!allowMove ? 'allow_move is FALSE. ' : ''}
                {!connected ? 'Driver not connected to controller. ' : ''}
                Pressing Confirm below WILL still send the request — the
                driver will refuse it, and the refusal reason appears here.
              </div>
            )}
            <div style={btnRow}>
              <button style={btnGhost} onClick={close}>Cancel</button>
              <button
                style={btnPrimary('#16A34A', taughtCount === 0)}
                onClick={confirmRun}
                disabled={taughtCount === 0}>
                Confirm — Run at {effectivePct}%
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <div style={{ fontSize: 14, color: '#374151', padding: '20px 0' }}>
            Publishing save + run to the driver…
          </div>
        )}

        {phase === 'ok' && result && (
          <>
            <div style={{ fontSize: 14, color: '#065F46', marginBottom: 12 }}>
              Run published. Watch the live line indicator on the Monitor
              for step-by-step progress.
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>program_id</span>
              <span style={{ fontFamily: 'monospace' }}>{result.program_id}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>source_hash</span>
              <span style={{ fontFamily: 'monospace' }}>{result.source_hash}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>effective_pct</span>
              <span>{result.effective_pct}%
                {result?.speed_note && (
                  <span style={{ color: '#B45309', marginLeft: 6 }}>
                    ({result.speed_note})
                  </span>
                )}
              </span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>points</span>
              <span>{(result.points || []).join(', ') || '(none)'}</span>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <div style={{
              padding: 12, background: '#FEE2E2',
              border: '1px solid #DC2626', borderRadius: 6,
              color: '#7F1D1D', fontSize: 14, marginBottom: 12,
              fontFamily: 'monospace',
            }}>
              {errorText || 'Run refused (no details).'}
            </div>
            {result?.outcome?.payload_head && (
              <div style={{ fontSize: 12, color: '#6b7280',
                            fontFamily: 'monospace', marginBottom: 12 }}>
                driver payload: {result.outcome.payload_head}
              </div>
            )}
            <div style={btnRow}>
              <button style={btnGhost} onClick={close}>Close</button>
              <button style={btnPrimary('#16A34A', false)} onClick={confirmRun}>
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

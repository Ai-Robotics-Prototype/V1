import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { runnableStepCount } from '../lib/programTruth'
import { namedLoadError } from '../lib/loadOutcome'

// Confirm modal for the Monitor "Run Program" button.
//
// Confirm-view surface is intentionally minimal (operator directive):
// program name, steps taught/total, requested speed, effective speed,
// Cancel / Confirm — nothing else. No payload row, no payload
// warning, no executor/backend info note, no gate/staleness banners.
// Pinned by RunProgramModal.pinned.test.js so a future modal rebuild
// can't resurrect the removed strings.
//
// Confirm → POST /api/estun/program/run; ok=true closes the modal and
// hands off to Monitor's live line indicator; ok=false stays open
// with the driver's rejection routed through namedLoadError.

export default function RunProgramModal() {
  const open           = useStore((s) => s.runModalOpen)
  const close          = useStore((s) => s.closeRunModal)
  const currentProgram = useStore((s) => s.currentProgram)
  const robot          = useStore((s) => s.robot) || {}
  const runSpeedPct    = useStore((s) => s.runSpeedPct)

  const [phase, setPhase]   = useState('confirm')  // 'confirm' | 'running' | 'error' | 'ok'
  const [result, setResult] = useState(null)
  // 2026-08-05 (operator_refusal_copy fork registry): the refusal
  // renders as a structured {title, detail, technicalDetail} triple
  // sourced from namedLoadError, matching the ToastContainer copy
  // register. The pre-fix `errorText` string dumped raw wire text
  // into a monospace box — operator saw "codegen:", HTTP codes,
  // driver reject strings without operator language.
  const [errorCopy, setErrorCopy] = useState(null)
  const [showTechnical, setShowTechnical] = useState(false)

  // Reset local state each time the modal is opened.
  useEffect(() => {
    if (open) {
      setPhase('confirm')
      setResult(null)
      setErrorCopy(null)
      setShowTechnical(false)
    }
  }, [open])

  if (!open) return null

  const stepCount = Array.isArray(currentProgram?.steps) ? currentProgram.steps.length : 0
  // Shared programTruth.runnableStepCount — the SAME resolver Editor's
  // untaughtCount and Monitor's runnableStepCount use.  Mirrors
  // dashboard_server._has_taught_poses, including derived_from
  // implicit teaching and non-motion actions (2026-07-30 audit
  // #P1-2 — see docs/ui_truth_audit.md for the fork history).
  const taughtCount = runnableStepCount(currentProgram)
  // Controller-id round-trip safety: only [a-z0-9] ids can be
  // resolved by the controller's URL parser (underscore/dash get
  // treated as path separators and break project/run lookup).
  const idSafe = /^[a-z0-9]+$/.test(currentProgram?.id || '')
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

  async function confirmRun() {
    if (!currentProgram?.id) {
      setPhase('error')
      setErrorCopy({
        code: 'no_program',
        title: 'No program loaded — pick one from Program Library first.',
        detail: '',
        technicalDetail: '',
      })
      return
    }
    setPhase('running'); setResult(null); setErrorCopy(null); setShowTechnical(false)
    try {
      // 2026-09-02 (per operator directive): the pre-flight mode
      // switch has been REMOVED. Bare project/run is accepted by the
      // controller in Manual (wire-proven). The Run modal now only
      // POSTs to /api/estun/program/run; the run endpoint pushes the
      // program and publishes project/run with no mode transition.
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
        // 2026-08-05 (operator_refusal_copy): route through the
        // shared copy module — {title, detail, technicalDetail}.
        // Raw wire text (codegen tags, HTTP codes, driver reject
        // strings) is DEMOTED to technicalDetail, hidden behind
        // the Details toggle. Fork registry: operator_refusal_copy.
        setErrorCopy(namedLoadError(body || {}, res.status))
      }
    } catch (e) {
      setPhase('error')
      setErrorCopy({
        code:            'network',
        title:           "Couldn't reach the dashboard — network hiccup.",
        detail:          'Try again in a moment.',
        technicalDetail: String(e && e.message || e),
      })
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
          <div data-testid="run-confirm-body">
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
              <span>{requestedPct}%</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280', fontWeight: 600 }}>
                Effective speed
              </span>
              <span style={{ fontWeight: 700, color: isCapped ? '#B45309' : '#059669' }}>
                {isCapped
                  ? `${effectivePct}% (capped from ${requestedPct}%)`
                  : `${effectivePct}%`}
              </span>
            </div>
            <div style={btnRow}>
              <button style={btnGhost} onClick={close}>Cancel</button>
              <button
                style={btnPrimary('#16A34A', taughtCount === 0 || !idSafe)}
                onClick={confirmRun}
                disabled={taughtCount === 0 || !idSafe}>
                {`Confirm — Run at ${effectivePct}%`}
              </button>
            </div>
          </div>
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
            {/* 2026-08-05 (operator_refusal_copy fork registry): the
                refusal renders as an operator-language title +
                detail. Raw wire text lives in `technicalDetail`
                behind a Details toggle — same register as the
                ToastContainer (267108a). Pre-fix, this box dumped
                `outcome.reason` verbatim, so operators saw phrases
                like "codegen:", "HTTP 5xx", and driver reject
                fragments with no explanation. */}
            <div data-testid="run-refused-copy" style={{
              padding: 12, background: '#FEE2E2',
              border: '1px solid #DC2626', borderRadius: 6,
              color: '#7F1D1D', fontSize: 14, marginBottom: 12,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {errorCopy?.title || 'Run refused.'}
              </div>
              {errorCopy?.detail && (
                <div style={{ fontWeight: 400, marginBottom: 4 }}>
                  {errorCopy.detail}
                </div>
              )}
              {errorCopy?.technicalDetail && (
                <>
                  <button
                    data-testid="run-refused-details-toggle"
                    onClick={(e) => { e.stopPropagation()
                                      setShowTechnical((v) => !v) }}
                    style={{
                      background: 'none', border: 'none',
                      color: '#7F1D1D', fontSize: 11,
                      textDecoration: 'underline', padding: 0,
                      marginTop: 6, cursor: 'pointer',
                    }}>
                    {showTechnical ? 'Hide details' : 'Details'}
                  </button>
                  {showTechnical && (
                    <pre
                      data-testid="run-refused-technical"
                      style={{
                        marginTop: 6, padding: 8,
                        background: '#FFFFFF',
                        border: '1px solid #FCA5A5',
                        borderRadius: 4,
                        fontSize: 11, fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap',
                        color: '#7F1D1D',
                      }}>{errorCopy.technicalDetail}</pre>
                  )}
                </>
              )}
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

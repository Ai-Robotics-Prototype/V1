import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

// Program-execution error modal. Reads STATE.robot.program.error, which
// the driver populates ONLY on transitions (see program_ops.ErrorDedup
// — the ~3 Hz publish/Error reflood collapses to one event per unique
// (code, unix_ts) tuple, then clears when the driver sees an empty
// frame or the operator sends System/ClearError).
//
// Behavior:
//   - Opens when robot.program.error becomes non-null (first appearance
//     of a new (code, ts) tuple).
//   - Shows the code + text + unix_ts (helpful for correlating with
//     controller logs).
//   - "Clear error" button POSTs /api/estun/program/clear_error which
//     dispatches System/ClearError on the wire. The controller stops
//     reflooding once cleared and STATE.robot.program.error goes null.
//   - "Dismiss" hides the modal locally without clearing the underlying
//     controller state (useful if the operator wants to keep the error
//     visible in the banner for a while).

export default function ProgramErrorModal() {
  const err              = useStore((s) => s.robot?.program?.error) || null
  const clearProgramError = useStore((s) => s.clearProgramError)

  // Local dismiss latch — separate from the underlying error tuple so
  // dismissing this instance doesn't hide a fresh error with a different
  // ts. We store the (code, ts) key that was dismissed; a new tuple
  // re-opens the modal automatically.
  const [dismissedKey, setDismissedKey] = useState(null)

  const key = err ? `${err[1]}|${err[2]}` : null

  useEffect(() => {
    // Reset dismiss latch when the underlying error clears.
    if (key === null) setDismissedKey(null)
  }, [key])

  if (!err || dismissedKey === key) return null

  const severity = err[0]
  const code     = err[1]
  const ts       = err[2]
  const text     = err[3] || 'Program error'

  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const panel = {
    background: '#fff', borderRadius: 12,
    padding: 24, minWidth: 480, maxWidth: 560,
    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
    border: '2px solid #DC2626',
  }
  const btnRow = { marginTop: 20, display: 'flex', gap: 12, justifyContent: 'flex-end' }
  const btnPrimary = (color) => ({
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    background: color, color: '#fff',
    border: 'none', borderRadius: 8, cursor: 'pointer',
  })
  const btnGhost = {
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
  }

  return (
    <div style={backdrop}>
      <div style={panel}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#7F1D1D', marginBottom: 12 }}>
          ⚠ Program error {code}
        </div>
        <div style={{
          padding: 12, background: '#FEE2E2',
          borderRadius: 6, color: '#7F1D1D', fontSize: 14,
          fontFamily: 'monospace', marginBottom: 12,
        }}>
          {text}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          severity: {severity} &middot; unix_ts: {ts?.toFixed?.(3) ?? ts}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          The controller is refolding this error at ~3 Hz until it's
          cleared. Deduped at the driver — this modal opens once per
          fault event, not per reflow frame.
        </div>
        <div style={btnRow}>
          <button style={btnGhost} onClick={() => setDismissedKey(key)}>
            Dismiss (keep on controller)
          </button>
          <button style={btnPrimary('#DC2626')} onClick={() => clearProgramError()}>
            Clear error
          </button>
        </div>
      </div>
    </div>
  )
}

// RecordConfirmModal — the single, shared confirm-before-record
// surface used by every teach flow. One component, one copy, so a
// change here lands uniformly across the program editor's teach
// overlay, the wizard's teach step, and any future surface that
// records a taught pose.
//
// Design (2026-10-09 operator directive): the modal shows just
// "Record position?" and a Record / Cancel pair. Operators no
// longer have to read a joint/TCP coordinate dump before saving
// a pose — the clutter is behind a "Show details ▾" expander that
// is collapsed by default. When expanded, the detail panel streams
// live joints (from the WS /ws stream) + tcp (polled from /api/state
// at 500 ms) so an operator who wants to sanity-check numbers can;
// everyone else sees only the confirm prompt.
//
// IMPORTANT — RECORDED DATA UNCHANGED: this modal is a confirm-
// before-record UI only. The capture path lives in the parent
// surface's `onConfirm` callback (e.g. the editor's `doRecord()`
// → teachOverlayRecord chain), which re-reads /api/state at click
// time. The modal never writes to the step; it only decides
// whether `onConfirm` is called.
//
// Shared vocabulary: this is the canonical operator-facing confirm
// used by every teach entry point. If a new surface needs to
// capture a pose, it imports from here — no competing prompt copy.
//
// data-testids (stable surface for the pinned test):
//   * record-confirm-modal         — the dialog root
//   * record-confirm-record-button — the primary action
//   * record-confirm-cancel-button — dismiss without capture
//   * record-confirm-details-toggle— the expander button
//   * record-confirm-details-panel — the collapsible readout
//     (only renders when expanded)

import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

function radiansToJointDegrees(positions) {
  if (!Array.isArray(positions)) return [0, 0, 0, 0, 0, 0]
  return positions.slice(0, 6)
    .map((rad) => Number((rad * 180 / Math.PI).toFixed(2)))
}

export default function RecordConfirmModal({ onConfirm, onCancel }) {
  const [showDetails, setShowDetails] = useState(false)
  const jointsRad = useStore((s) => s.joints?.positions) || [0, 0, 0, 0, 0, 0]
  const jointsDeg = radiansToJointDegrees(jointsRad)
  const [tcp, setTcp] = useState(null)
  // Live TCP poller — only runs while the details expander is open
  // so an operator who never opens the panel pays no network cost.
  // The LIVE JOINT stream is already in the store (ws); nothing to
  // start here for joints.
  useEffect(() => {
    if (!showDetails) return
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/state')
        if (!res.ok) return
        const d = await res.json()
        if (alive && Array.isArray(d?.tcp_pose)) setTcp(d.tcp_pose)
      } catch { /* nop */ }
    }
    poll()
    const id = setInterval(poll, 500)
    return () => { alive = false; clearInterval(id) }
  }, [showDetails])
  const jointsLine = jointsDeg.slice(0, 6)
    .map((v, i) => `J${i + 1}:${Number(v).toFixed(2)}`).join('  ')
  const tcpKeys = ['x', 'y', 'z', 'rx', 'ry', 'rz']
  const tcpLine = Array.isArray(tcp)
    ? tcp.slice(0, 6).map((v, i) => `${tcpKeys[i]}:${Number(v).toFixed(3)}`).join('  ')
    : null
  return (
    <div
      data-testid="record-confirm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-confirm-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: '#111827',
          borderRadius: 12, width: '100%', maxWidth: 420,
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '20px 24px 8px 24px' }}>
          <div
            id="record-confirm-title"
            style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}
          >
            Record position?
          </div>
        </div>
        <div style={{
          padding: '14px 24px 0 24px',
        }}>
          <button
            type="button"
            data-testid="record-confirm-details-toggle"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((v) => !v)}
            style={{
              background: 'transparent', color: '#6B7280',
              border: 'none', padding: 0, cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
            }}
          >
            {showDetails ? 'Hide details ▴' : 'Show details ▾'}
          </button>
          {showDetails && (
            <div
              data-testid="record-confirm-details-panel"
              style={{
                marginTop: 8,
                fontFamily: 'monospace', fontSize: 12, color: '#374151',
                background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6,
                padding: '10px 12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
              }}
            >
              joints: {jointsLine}
              {'\n'}
              tcp:    {tcpLine || '(awaiting live tcp…)'}
            </div>
          )}
        </div>
        <div style={{
          padding: '18px 24px 20px 24px',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button
            type="button"
            data-testid="record-confirm-cancel-button"
            onClick={onCancel}
            style={{
              minHeight: 44, padding: '0 16px',
              background: 'transparent', color: '#6B7280',
              border: '1px solid #E5E7EB', borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="record-confirm-record-button"
            onClick={onConfirm}
            style={{
              minHeight: 44, padding: '0 22px',
              background: '#16A34A', color: '#fff',
              border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Record
          </button>
        </div>
      </div>
    </div>
  )
}

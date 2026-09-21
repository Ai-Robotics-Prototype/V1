import { useState } from 'react'
import { useStore } from '../store/useStore'

// Points panel — lists the taught-point table for the currently-loaded
// program with teach / rename / re-teach / delete affordances plus an
// "+ Insert step" button next to each point that appends a movJ step
// referencing it.
//
// Design notes:
//   - Reads currentProgram.points (backend GET populates this via the
//     _refreshCurrentProgram flow in useStore).
//   - The Teach button is the only entry that requires a LIVE pose from
//     the driver. The backend refuses (HTTP 503) if the driver has
//     never published joints_deg — the store surfaces that as a toast.
//   - Teach never touches the move gate. Rename/delete/insert-step are
//     pure JSON operations on the program file. Run is the ONLY thing
//     that goes through the gate.
//   - Deleting a point that's in use returns 409 with the referencing
//     step indices; the store's toast makes that failure operator-
//     obvious ("Can't delete p1: step(s) #1, #2 still use it. Re-
//     target or delete those steps first.").

export default function PointsPanel({ compact = false }) {
  const cp = useStore((s) => s.currentProgram)
  const robot = useStore((s) => s.robot) || {}
  const teachCurrentPose = useStore((s) => s.teachCurrentPose)
  const retachPoint      = useStore((s) => s.retachPoint)
  const renamePoint      = useStore((s) => s.renamePoint)
  const relabelPoint     = useStore((s) => s.relabelPoint)
  const deletePoint      = useStore((s) => s.deletePoint)
  const addMoveStepForPoint = useStore((s) => s.addMoveStepForPoint)

  const [teaching, setTeaching] = useState(false)
  const [renameFor, setRenameFor] = useState(null)
  const [renameTo, setRenameTo] = useState('')
  const [labelFor, setLabelFor] = useState(null)
  const [labelTo, setLabelTo] = useState('')

  const points = cp?.points || {}
  const names  = Object.keys(points).sort()
  const hasProgram = !!cp?.id

  const wrap = {
    padding: compact ? 8 : 12, background: '#fff',
    border: '1px solid #e5e7eb', borderRadius: 8,
    display: 'flex', flexDirection: 'column', gap: 6,
    minHeight: 0, overflow: 'hidden',
  }
  const header = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    fontSize: 12, color: '#6b7280', fontWeight: 700,
    letterSpacing: '0.05em', textTransform: 'uppercase',
    marginBottom: 4,
  }
  const btnTeach = {
    padding: '8px 14px', fontSize: 13, fontWeight: 700,
    background: hasProgram ? '#2563EB' : '#9CA3AF', color: '#fff',
    border: 'none', borderRadius: 6,
    cursor: hasProgram ? 'pointer' : 'not-allowed',
  }
  const rowStyle = {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center', gap: 8,
    padding: '6px 8px',
    borderBottom: '1px solid #f3f4f6',
    fontSize: 13,
  }
  const chipStyle = (fg, bg) => ({
    display: 'inline-block', padding: '2px 8px',
    background: bg, color: fg, borderRadius: 999,
    fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
  })
  const smallBtn = (bg, disabled) => ({
    padding: '4px 8px', fontSize: 11, fontWeight: 600,
    background: bg, color: '#fff', border: 'none', borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  })
  const ghostBtn = {
    padding: '4px 8px', fontSize: 11,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
  }

  async function onTeach() {
    if (teaching) return
    setTeaching(true)
    try { await teachCurrentPose({}) }
    finally { setTeaching(false) }
  }

  async function commitRename() {
    if (!renameFor) return
    const to = renameTo.trim()
    if (to && to !== renameFor) await renamePoint(renameFor, to)
    setRenameFor(null); setRenameTo('')
  }
  async function commitLabel() {
    if (!labelFor) return
    await relabelPoint(labelFor, labelTo.trim() || null)
    setLabelFor(null); setLabelTo('')
  }

  return (
    <div style={wrap}>
      <div style={header}>
        <span>Points ({names.length})</span>
        <button style={btnTeach} onClick={onTeach} disabled={!hasProgram || teaching}
                title={hasProgram
                  ? 'Snapshot current arm pose as a new point'
                  : 'Load or save a program first'}>
          {teaching ? '…' : '📌 Teach current pose'}
        </button>
      </div>
      {names.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic',
                      padding: '10px 0', textAlign: 'center' }}>
          No taught points yet. Jog the arm to a target and press <b>Teach current pose</b>.
        </div>
      ) : (
        <div style={{ overflow: 'auto', maxHeight: compact ? 160 : 260 }}>
          {names.map((name) => {
            const p = points[name]
            const j = Array.isArray(p.joints) ? p.joints : []
            const inRename = renameFor === name
            const inRelabel = labelFor === name
            return (
              <div key={name} style={rowStyle}>
                <span style={chipStyle('#065F46', '#ECFDF5')}>{name}</span>
                <div style={{ minWidth: 0 }}>
                  {inRename ? (
                    <input value={renameTo}
                      onChange={(e) => setRenameTo(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => e.key === 'Enter' && commitRename()}
                      autoFocus
                      style={{ width: '100%', padding: '2px 6px',
                               fontSize: 12, border: '1px solid #d1d5db',
                               borderRadius: 4 }} />
                  ) : inRelabel ? (
                    <input value={labelTo}
                      onChange={(e) => setLabelTo(e.target.value)}
                      onBlur={commitLabel}
                      onKeyDown={(e) => e.key === 'Enter' && commitLabel()}
                      placeholder="Label…"
                      autoFocus
                      style={{ width: '100%', padding: '2px 6px',
                               fontSize: 12, border: '1px solid #d1d5db',
                               borderRadius: 4 }} />
                  ) : (
                    <>
                      <div style={{ fontWeight: 600, color: '#111827',
                                    whiteSpace: 'nowrap', overflow: 'hidden',
                                    textOverflow: 'ellipsis' }}>
                        {p.label || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(no label)</span>}
                      </div>
                      <div style={{ fontFamily: 'monospace', fontSize: 10.5,
                                    color: '#6b7280', whiteSpace: 'nowrap',
                                    overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        [{j.map((v) => v.toFixed(1)).join(', ')}]°
                      </div>
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button style={smallBtn('#059669')}
                    title="Append a movJ step referencing this point"
                    onClick={() => addMoveStepForPoint(name)}>
                    + step
                  </button>
                  <button style={ghostBtn}
                    title="Re-teach: overwrite with the current pose"
                    onClick={() => retachPoint(name)}>
                    ↻
                  </button>
                  <button style={ghostBtn}
                    title="Rename"
                    onClick={() => { setRenameFor(name); setRenameTo(name) }}>
                    ✎ name
                  </button>
                  <button style={ghostBtn}
                    title="Edit label"
                    onClick={() => { setLabelFor(name); setLabelTo(p.label || '') }}>
                    ✎ label
                  </button>
                  <button style={smallBtn('#DC2626')}
                    title="Delete (blocked if any step references this point)"
                    onClick={() => deletePoint(name)}>
                    ✕
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {robot?.joints_deg && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280',
                      fontFamily: 'monospace', textAlign: 'center' }}>
          live: [{robot.joints_deg.map((v) => v.toFixed(2)).join(', ')}]°
        </div>
      )}
    </div>
  )
}

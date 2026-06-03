import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'

function StatusBadge({ status }) {
  const colors = {
    idle:    { bg: '#f3f4f6', border: '#d1d5db', text: '#6b7280', label: 'IDLE' },
    running: { bg: '#f0fdf4', border: '#16A34A', text: '#16A34A', label: 'RUNNING' },
    paused:  { bg: '#fffbeb', border: '#CA8A04', text: '#CA8A04', label: 'PAUSED' },
    estop:   { bg: '#fef2f2', border: '#DC2626', text: '#DC2626', label: 'E-STOP' },
    homing:  { bg: '#eff6ff', border: '#2563EB', text: '#2563EB', label: 'HOMING' },
  }
  const c = colors[status] || colors.idle
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      padding: '12px 24px', borderRadius: 12,
      background: c.bg, border: '2px solid ' + c.border,
    }}>
      <div style={{
        width: 14, height: 14, borderRadius: '50%',
        background: c.text,
        animation: status === 'running' ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
      }} />
      <span style={{ fontSize: 20, fontWeight: 800, color: c.text, letterSpacing: '0.05em' }}>
        {c.label}
      </span>
    </div>
  )
}

function StatCard({ label, value, unit, color }) {
  return (
    <div style={{
      padding: '16px 20px', background: '#fff',
      borderRadius: 10, border: '1px solid #e5e7eb',
      flex: 1, minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color || '#111', fontVariantNumeric: 'tabular-nums' }}>
        {value}{unit && <span style={{ fontSize: 14, fontWeight: 500, color: '#9ca3af', marginLeft: 4 }}>{unit}</span>}
      </div>
    </div>
  )
}

export default function MonitorDashboard() {
  const currentProgram = useStore((s) => s.currentProgram)
  const task           = useStore((s) => s.task)
  const safety         = useStore((s) => s.safety)
  const detectionsFromStore = useStore((s) => s.detections)
  const setTab         = useStore((s) => s.setTab)

  const runProgram     = useStore((s) => s.runProgram)
  const pauseProgram   = useStore((s) => s.pauseProgram)
  const resumeProgram  = useStore((s) => s.resumeProgram)
  const cancelProgram  = useStore((s) => s.cancelProgram)

  // Cycle bookkeeping lives in local state — the backend doesn't track
  // cycle count in STATE yet, so we maintain a counter on the client
  // by watching for running → !running transitions.
  const [cycleCount, setCycleCount] = useState(0)
  const [cycleStart, setCycleStart] = useState(null)
  const [lastCycleTime, setLastCycleTime] = useState(null)

  useEffect(() => {
    if (task?.running && !task?.paused && cycleStart === null) {
      setCycleStart(Date.now())
    }
    if (!task?.running && cycleStart !== null) {
      const dt = (Date.now() - cycleStart) / 1000
      setLastCycleTime(dt.toFixed(1))
      setCycleCount((c) => c + 1)
      setCycleStart(null)
    }
  }, [task?.running, task?.paused, cycleStart])

  // Derive the badge from real task + safety state.
  const status = safety?.estop ? 'estop'
               : task?.paused  ? 'paused'
               : task?.running ? 'running'
               :                  'idle'

  const programName    = currentProgram?.name || 'No program loaded'
  const steps          = currentProgram?.steps || []
  const currentStepIdx = task?.running || task?.paused ? (task?.program_step ?? 0) : -1
  const currentStepLabel = currentStepIdx >= 0 && steps[currentStepIdx]
    ? steps[currentStepIdx].label
    : 'Waiting'

  const detections = Array.isArray(detectionsFromStore) ? detectionsFromStore : []
  const detectionCount = detections.length
  const speedPct = Math.round((safety?.speed_scale ?? 1) * 100)

  const runDisabled    = safety?.estop || (task?.running && !task?.paused)
  const pauseDisabled  = !task?.running || task?.paused || safety?.estop
  const stopDisabled   = !task?.running && !task?.paused

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'auto',
      background: '#f8fafc', padding: 24,
    }}>
      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.5; transform: scale(1.3); }
        }
      `}</style>

      {/* Top row: Status + Program info | Live camera */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 360 }}>
          <StatusBadge status={status} />
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Current Program
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginTop: 4 }}>
              {programName}
            </div>
            {currentStepIdx >= 0 && steps.length > 0 && (
              <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
                Step {currentStepIdx + 1} of {steps.length}: {currentStepLabel}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
            {status === 'paused' ? (
              <>
                <button onClick={resumeProgram} disabled={safety?.estop}
                  style={primaryBtn('#16A34A', safety?.estop)}>
                  ▶ Resume
                </button>
                <button onClick={cancelProgram} style={primaryBtn('#DC2626')}>
                  ✕ Stop
                </button>
              </>
            ) : status === 'running' ? (
              <>
                <button onClick={pauseProgram} disabled={pauseDisabled}
                  style={primaryBtn('#CA8A04', pauseDisabled)}>
                  ⏸ Pause
                </button>
                <button onClick={cancelProgram} disabled={stopDisabled}
                  style={primaryBtn('#DC2626', stopDisabled)}>
                  ✕ Stop
                </button>
              </>
            ) : (
              <button onClick={runProgram} disabled={runDisabled || steps.length === 0}
                style={primaryBtn('#16A34A', runDisabled || steps.length === 0)}>
                ▶ Run Program
              </button>
            )}
            <button onClick={() => setTab('program')} style={{
              padding: '14px 24px', fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            }}>
              Edit Program
            </button>
          </div>
        </div>

        <div style={{
          width: 400, height: 280, borderRadius: 12, overflow: 'hidden',
          background: '#111', border: '1px solid #e5e7eb', flexShrink: 0,
          position: 'relative',
        }}>
          <img src="/stream/annotated" alt="Live camera"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            onError={(e) => { e.target.src = '/stream/cam0' }}
          />
          <div style={{
            position: 'absolute', top: 8, left: 8,
            background: 'rgba(0,0,0,0.6)', color: '#fff',
            padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600,
          }}>LIVE</div>
          {detectionCount > 0 && (
            <div style={{
              position: 'absolute', bottom: 8, left: 8,
              background: 'rgba(37,99,235,0.8)', color: '#fff',
              padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            }}>{detectionCount} object{detectionCount !== 1 ? 's' : ''} detected</div>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Speed" value={speedPct} unit="%" color="#2563EB" />
        <StatCard label="Cycle Count" value={cycleCount} color="#16A34A" />
        <StatCard label="Last Cycle Time" value={lastCycleTime ?? '—'} unit={lastCycleTime ? 's' : ''} color="#374151" />
        <StatCard label="Objects Detected" value={detectionCount} color="#9333EA" />
      </div>

      {/* Program steps progress */}
      {steps.length > 0 ? (
        <div style={{
          background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
          padding: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111', marginBottom: 14 }}>
            Program Steps
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {steps.map((step, i) => (
              <div key={step.id ?? i} style={{
                flex: 1, height: 8, borderRadius: 4,
                background: i < currentStepIdx ? '#16A34A'
                  : i === currentStepIdx ? '#2563EB'
                  : '#e5e7eb',
                transition: 'background 300ms',
              }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {steps.map((step, i) => (
              <div key={step.id ?? i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', borderRadius: 6,
                background: i === currentStepIdx ? '#eff6ff'
                  : i < currentStepIdx ? '#f0fdf4'
                  : '#fafafa',
                border: i === currentStepIdx ? '1px solid #93c5fd'
                  : i < currentStepIdx ? '1px solid #bbf7d0'
                  : '1px solid #e5e7eb',
              }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700,
                  background: i < currentStepIdx ? '#16A34A' : i === currentStepIdx ? '#2563EB' : '#e5e7eb',
                  color: i <= currentStepIdx ? '#fff' : '#6b7280',
                }}>
                  {i < currentStepIdx ? '✓' : i + 1}
                </div>
                <div style={{
                  fontSize: 12, fontWeight: i === currentStepIdx ? 700 : 400,
                  color: i === currentStepIdx ? '#2563EB' : '#374151',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {step.label || step.action}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{
          background: '#fff', borderRadius: 12, border: '2px dashed #d1d5db',
          padding: 40, textAlign: 'center',
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
            No program loaded
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
            Load a program from the library or create a new one with the wizard
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={() => setTab('programs')} style={{
              padding: '12px 24px', fontSize: 14, fontWeight: 600,
              background: '#2563EB', color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer',
            }}>
              Open Program Library
            </button>
            <button onClick={() => setTab('program')} style={{
              padding: '12px 24px', fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
            }}>
              Create New Program
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function primaryBtn(bg, disabled) {
  return {
    padding: '14px 28px', fontSize: 16, fontWeight: 700,
    background: bg, color: '#fff', border: 'none',
    borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
}

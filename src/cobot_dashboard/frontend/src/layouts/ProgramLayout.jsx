import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import ProgramEditor from '../components/ProgramEditor'
import ArmViewer3D from '../components/ArmViewer3D'

// Vertical resize divider on the right edge of a left-fixed panel.
function VerticalDivider({ onMouseDown, dragging }) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 5, cursor: 'col-resize', flexShrink: 0,
        background: dragging ? '#2563EB40' : 'transparent',
        position: 'relative', zIndex: 10,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#2563EB40' }}
      onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = 'transparent' }}>
      <div style={{
        position: 'absolute', top: '50%', left: 1, transform: 'translateY(-50%)',
        width: 3, height: 30, borderRadius: 2, background: '#d1d5db',
      }} />
    </div>
  )
}

function HorizontalDivider({ onMouseDown, dragging }) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        height: 5, cursor: 'row-resize', flexShrink: 0,
        background: dragging ? '#2563EB40' : 'transparent',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#2563EB40' }}
      onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = 'transparent' }}>
      <div style={{ width: 30, height: 3, borderRadius: 2, background: '#d1d5db' }} />
    </div>
  )
}

// Run / Pause / Stop / Home — preserved from the previous layout so
// the Program tab can still drive program execution.
function RunStrip() {
  const task          = useStore((s) => s.task)
  const safety        = useStore((s) => s.safety)
  const runProgram    = useStore((s) => s.runProgram)
  const pauseProgram  = useStore((s) => s.pauseProgram)
  const resumeProgram = useStore((s) => s.resumeProgram)
  const homeRobot     = useStore((s) => s.homeRobot)
  const cancelProgram = useStore((s) => s.cancelProgram)
  const { estop }     = safety
  const { running, paused, state, program_step, program_total } = task

  const btn = (bg, color, disabled) => ({
    flex: 1, padding: '6px 0', fontSize: 11, fontWeight: 600,
    background: bg, color, border: 'none', borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button onClick={paused ? resumeProgram : runProgram}
        disabled={estop || (running && !paused)}
        style={btn('#16A34A', '#fff', estop || (running && !paused))}>
        {paused ? '▶ Resume' : '▶ Run'}
      </button>
      <button onClick={pauseProgram} disabled={!running || paused || estop}
        style={btn('#fef3c7', '#92400e', !running || paused || estop)}>
        ⏸ Pause
      </button>
      <button onClick={cancelProgram} disabled={!running && !paused}
        style={btn('#fee2e2', '#b91c1c', !running && !paused)}>
        ✕ Stop
      </button>
      <button onClick={homeRobot} disabled={estop}
        style={btn('#f3f4f6', '#374151', estop)}>
        ⌂ Home
      </button>
      <span style={{ fontSize: 10, color: '#6b7280', minWidth: 110, textAlign: 'right' }}>
        {state} · {program_step + 1}/{program_total}
      </span>
    </div>
  )
}

function JogPanel() {
  const jog          = useStore((s) => s.jog)
  const jogCartesian = useStore((s) => s.jogCartesian)
  const triggerEstop = useStore((s) => s.triggerEstop)

  const [jogMode, setJogMode] = useState('joint') // 'joint' | 'cartesian'
  const [step, setStep]       = useState(1.0)
  const [speed, setSpeed]     = useState(20)

  // Joint mode: backend wants delta in radians on a joint index 0-5.
  // Cartesian mode: publishes a ROS message via /cmd/jog_cartesian.
  const sendJog = useCallback((axis, direction) => {
    if (jogMode === 'joint') {
      const deltaRad = direction * step * Math.PI / 180
      jog(axis - 1, deltaRad)
    } else {
      jogCartesian(axis, direction, step, speed)
    }
  }, [jogMode, step, speed, jog, jogCartesian])

  const JogButton = ({ label, axis, dir, accent }) => (
    <button
      onMouseDown={() => sendJog(axis, dir)}
      style={{
        padding: '8px 0', fontSize: 11, fontWeight: 700,
        background: '#fff', color: accent,
        border: '1px solid #d1d5db', borderRadius: 4,
        cursor: 'pointer', flex: 1, minWidth: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f9ff'; e.currentTarget.style.borderColor = '#2563EB' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff';     e.currentTarget.style.borderColor = '#d1d5db' }}>
      {label}
    </button>
  )

  const toggleStyle = (on) => ({
    padding: '3px 10px', fontSize: 10, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? 'none'    : '1px solid #d1d5db',
  })

  return (
    <div style={{ padding: 10, background: '#fff', height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <RunStrip />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>Jog Control</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setJogMode('joint')}     style={toggleStyle(jogMode === 'joint')}>Joint</button>
        <button onClick={() => setJogMode('cartesian')} style={toggleStyle(jogMode === 'cartesian')}>Cartesian</button>
      </div>

      {jogMode === 'joint' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: 4, alignItems: 'center' }}>
          {[1, 2, 3, 4, 5, 6].map((j) => (
            <div key={j} style={{ display: 'contents' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textAlign: 'right', paddingRight: 6 }}>J{j}</span>
              <JogButton label={'− J' + j} axis={j} dir={-1} accent="#DC2626" />
              <JogButton label={'+ J' + j} axis={j} dir={1}  accent="#16A34A" />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: 4, alignItems: 'center' }}>
          {['x', 'y', 'z', 'rx', 'ry', 'rz'].map((axis) => (
            <div key={axis} style={{ display: 'contents' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textAlign: 'right', paddingRight: 6 }}>{axis.toUpperCase()}</span>
              <JogButton label={'− ' + axis.toUpperCase()} axis={axis} dir={-1} accent="#DC2626" />
              <JogButton label={'+ ' + axis.toUpperCase()} axis={axis} dir={1}  accent="#16A34A" />
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <span style={{ fontSize: 10, color: '#6b7280', marginRight: 4 }}>Step:</span>
          {[0.1, 0.5, 1.0, 5.0, 10.0].map((s) => (
            <button key={s} onClick={() => setStep(s)}
              style={{
                padding: '2px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                background: step === s ? '#2563EB' : '#f3f4f6',
                color:      step === s ? '#fff'    : '#6b7280',
                border:     step === s ? 'none'    : '1px solid #d1d5db',
              }}>
              {s}{jogMode === 'joint' ? '°' : 'mm'}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: '#6b7280' }}>
          Speed: {speed}%
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ width: '100%', marginTop: 2 }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={triggerEstop} style={{
          flex: 1, padding: '8px', fontSize: 11, fontWeight: 700,
          background: '#DC2626', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer',
        }}>STOP</button>
        <button style={{
          flex: 2, padding: '8px', fontSize: 10, fontWeight: 600,
          background: '#16A34A', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer',
        }} title="Save current pose as a teach point (not yet wired)">
          Teach Current Position
        </button>
      </div>
    </div>
  )
}

export default function ProgramLayout() {
  const [leftWidth, setLeftWidth] = useState(560)
  const [jogHeight, setJogHeight] = useState(260)
  const drag = useRef({ active: null, startPos: 0, startVal: 0 })
  const [activeDrag, setActiveDrag] = useState(null) // mirrors drag.current.active for re-renders

  const startVerticalDrag = useCallback((e) => {
    drag.current = { active: 'v', startPos: e.clientX, startVal: leftWidth }
    setActiveDrag('v')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [leftWidth])

  const startHorizontalDrag = useCallback((e) => {
    drag.current = { active: 'h', startPos: e.clientY, startVal: jogHeight }
    setActiveDrag('h')
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [jogHeight])

  useEffect(() => {
    const onMove = (e) => {
      const d = drag.current
      if (d.active === 'v') {
        const delta = e.clientX - d.startPos
        setLeftWidth(Math.max(280, Math.min(1000, d.startVal + delta)))
      } else if (d.active === 'h') {
        const delta = d.startPos - e.clientY
        setJogHeight(Math.max(160, Math.min(480, d.startVal + delta)))
      }
    }
    const onUp = () => {
      if (drag.current.active) {
        drag.current = { active: null, startPos: 0, startVal: 0 }
        setActiveDrag(null)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top row: program editor (left, resizable) | 3D viewer (right, fills) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ width: leftWidth, flexShrink: 0, display: 'flex', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ProgramEditor />
          </div>
        </div>
        <VerticalDivider onMouseDown={startVerticalDrag} dragging={activeDrag === 'v'} />
        <div style={{ flex: 1, overflow: 'hidden', background: '#0a0a12' }}>
          <ArmViewer3D />
        </div>
      </div>

      <HorizontalDivider onMouseDown={startHorizontalDrag} dragging={activeDrag === 'h'} />

      {/* Bottom: jog panel (resizable height, includes Run/Pause/Stop/Home strip) */}
      <div style={{ height: jogHeight, flexShrink: 0, overflow: 'hidden', borderTop: '1px solid #e5e7eb' }}>
        <JogPanel />
      </div>
    </div>
  )
}

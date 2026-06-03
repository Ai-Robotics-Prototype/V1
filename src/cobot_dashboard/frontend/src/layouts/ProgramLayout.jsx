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

// One arrow button — SVG up-arrow rotated to taste, accent-tinted on
// hover so the user can see which axis the button drives at a glance.
function ArrowPadBtn({ onMouseDown, rotation, label, color, size = 44 }) {
  return (
    <button
      onMouseDown={onMouseDown}
      style={{
        width: size, height: size, padding: 0,
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 6,
        cursor: 'pointer', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 2,
        transition: 'background 100ms, border-color 100ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = color + '15'; e.currentTarget.style.borderColor = color }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff';        e.currentTarget.style.borderColor = '#d1d5db' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: 9, fontWeight: 600, color: '#374151' }}>{label}</span>
    </button>
  )
}

// Centred label tile that sits in the middle of a 3×3 arrow grid.
function PadCenter({ label, height = 44, width = 44 }) {
  return (
    <div style={{
      width, height,
      background: '#f3f4f6', borderRadius: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 9, fontWeight: 700, color: '#9ca3af',
    }}>
      {label}
    </div>
  )
}

function JogPanel() {
  const jog          = useStore((s) => s.jog)
  const jogCartesian = useStore((s) => s.jogCartesian)
  const triggerEstop = useStore((s) => s.triggerEstop)
  const homeRobot    = useStore((s) => s.homeRobot)

  const [jogMode, setJogMode] = useState('cartesian') // 'cartesian' | 'joint'
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

  const toggleStyle = (on) => ({
    padding: '4px 12px', fontSize: 10, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? 'none'    : '1px solid #d1d5db',
  })

  const padLabel = (text) => (
    <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textAlign: 'center', marginBottom: 4 }}>{text}</div>
  )

  return (
    <div style={{ padding: 12, background: '#fff', height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <RunStrip />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Jog</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setJogMode('cartesian')} style={toggleStyle(jogMode === 'cartesian')}>XYZ</button>
        <button onClick={() => setJogMode('joint')}     style={toggleStyle(jogMode === 'joint')}>Joint</button>
      </div>

      {jogMode === 'cartesian' ? (
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
          {/* XY pad — D-pad for the horizontal plane. Y is "forward/back"
              from the operator's perspective, X is "left/right". */}
          <div>
            {padLabel('Position')}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 44px)',
              gridTemplateRows: 'repeat(3, 44px)',
              gridTemplateAreas: '". up ." "left center right" ". down ."',
              gap: 3,
            }}>
              <div style={{ gridArea: 'up' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('y',  1)} rotation={0}   label="Y+" color="#16A34A" />
              </div>
              <div style={{ gridArea: 'left' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('x', -1)} rotation={-90} label="X−" color="#DC2626" />
              </div>
              <div style={{ gridArea: 'center' }}>
                <PadCenter label="XY" />
              </div>
              <div style={{ gridArea: 'right' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('x',  1)} rotation={90}  label="X+" color="#DC2626" />
              </div>
              <div style={{ gridArea: 'down' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('y', -1)} rotation={180} label="Y−" color="#16A34A" />
              </div>
            </div>
          </div>

          {/* Z column — up / down for height. */}
          <div>
            {padLabel('Height')}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: 44 }}>
              <ArrowPadBtn onMouseDown={() => sendJog('z',  1)} rotation={0}   label="Z+" color="#3B82F6" />
              <PadCenter label="Z" height={22} />
              <ArrowPadBtn onMouseDown={() => sendJog('z', -1)} rotation={180} label="Z−" color="#3B82F6" />
            </div>
          </div>

          {/* Rotation pad — Rx tilts forward/back, Rz spins around Z. */}
          <div>
            {padLabel('Rotation')}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 44px)',
              gridTemplateRows: 'repeat(3, 44px)',
              gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
              gap: 3,
            }}>
              <div style={{ gridArea: 'rxp' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" />
              </div>
              <div style={{ gridArea: 'rzn' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" />
              </div>
              <div style={{ gridArea: 'center' }}>
                <PadCenter label="Rot" />
              </div>
              <div style={{ gridArea: 'rzp' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" />
              </div>
              <div style={{ gridArea: 'rxn' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rx', -1)} rotation={180} label="Rx−" color="#9333EA" />
              </div>
            </div>
          </div>
        </div>
      ) : (
        // Joint mode — one column per joint with up (positive) / down (negative).
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {[1, 2, 3, 4, 5, 6].map((j) => (
            <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: 44 }}>
              <ArrowPadBtn onMouseDown={() => sendJog(j,  1)} rotation={0}   label="+" color="#16A34A" size={44} />
              <PadCenter label={'J' + j} height={24} />
              <ArrowPadBtn onMouseDown={() => sendJog(j, -1)} rotation={180} label="−" color="#DC2626" size={44} />
            </div>
          ))}
        </div>
      )}

      {/* Step size + speed */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#6b7280' }}>Step:</span>
          {[0.1, 0.5, 1, 5, 10].map((s) => (
            <button key={s} onClick={() => setStep(s)} style={{
              padding: '3px 7px', fontSize: 9, fontWeight: 600, borderRadius: 3, cursor: 'pointer',
              background: step === s ? '#2563EB' : '#f3f4f6',
              color:      step === s ? '#fff'    : '#6b7280',
              border:     step === s ? 'none'    : '1px solid #e5e7eb',
            }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 160, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: '#6b7280', whiteSpace: 'nowrap' }}>Speed: {speed}%</span>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ flex: 1, height: 4 }} />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={homeRobot} style={{
          flex: 1, padding: '8px', fontSize: 11, fontWeight: 600,
          background: '#f3f4f6', color: '#374151',
          border: '1px solid #d1d5db', borderRadius: 5, cursor: 'pointer',
        }}>Home</button>
        <button onClick={triggerEstop} style={{
          flex: 1, padding: '8px', fontSize: 11, fontWeight: 700,
          background: '#DC2626', color: '#fff',
          border: 'none', borderRadius: 5, cursor: 'pointer',
        }}>STOP</button>
        <button title="Save current pose as a teach point (not yet wired)" style={{
          flex: 1, padding: '8px', fontSize: 11, fontWeight: 600,
          background: '#16A34A', color: '#fff',
          border: 'none', borderRadius: 5, cursor: 'pointer',
        }}>Teach Position</button>
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
        <div style={{ flex: 1, overflow: 'hidden', background: '#FFFFFF' }}>
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

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

// Run / Pause / Stop / Home — bigger, touch-friendly buttons.
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
    flex: 1, padding: '14px 0', fontSize: 14, fontWeight: 700,
    background: bg, color, border: 'none', borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
    minHeight: 48,
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
      <span style={{ fontSize: 12, color: '#6b7280', minWidth: 140, textAlign: 'right' }}>
        {state} · {program_step + 1}/{program_total}
      </span>
    </div>
  )
}

// One arrow button. Size, svg, label all parameterised so the same
// component drives both normal-jog and maximised-jog layouts.
function ArrowPadBtn({ onMouseDown, rotation, label, color, size = 80, svgSize = 36, labelSize = 12 }) {
  return (
    <button
      onMouseDown={onMouseDown}
      style={{
        width: size, height: size, padding: 0,
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
        cursor: 'pointer', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4,
        transition: 'background 100ms, border-color 100ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = color + '15'; e.currentTarget.style.borderColor = color }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff';        e.currentTarget.style.borderColor = '#d1d5db' }}>
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: labelSize, fontWeight: 700, color: '#374151' }}>{label}</span>
    </button>
  )
}

function PadCenter({ label, width = 80, height = 80, labelSize = 12 }) {
  return (
    <div style={{
      width, height,
      background: '#f3f4f6', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: labelSize, fontWeight: 700, color: '#9ca3af',
    }}>
      {label}
    </div>
  )
}

function JogPanel({ maximized, onToggleMaximize }) {
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

  // Size knobs flip between normal and maximised modes.
  const padBtn      = maximized ? 110 : 80
  const zBtnWidth   = maximized ? 90  : 70
  const zBtnHeight  = maximized ? 110 : 80
  const jointBtn    = maximized ? 90  : 64
  const svgPx       = maximized ? 48  : 36
  const lblPx       = maximized ? 15  : 12

  const toggleStyle = (on) => ({
    padding: '8px 18px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
    minHeight: 40,
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? 'none'    : '1px solid #d1d5db',
  })

  const padLabel = (text) => (
    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textAlign: 'center', marginBottom: 6 }}>{text}</div>
  )

  return (
    <div style={{ padding: 14, background: '#fff', height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <RunStrip />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>Jog</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setJogMode('cartesian')} style={toggleStyle(jogMode === 'cartesian')}>XYZ</button>
        <button onClick={() => setJogMode('joint')}     style={toggleStyle(jogMode === 'joint')}>Joint</button>
        <button onClick={onToggleMaximize}
          title={maximized ? 'Restore split layout' : 'Maximize jog panel'}
          style={{
            padding: '8px 14px', fontSize: 12, fontWeight: 600,
            background: '#f3f4f6', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6,
            cursor: 'pointer', minHeight: 40,
          }}>
          {maximized ? 'Minimize' : 'Maximize'}
        </button>
      </div>

      {jogMode === 'cartesian' ? (
        <div style={{ display: 'flex', gap: 28, justifyContent: 'center', flexWrap: 'wrap' }}>
          {/* XY pad — D-pad for the horizontal plane. */}
          <div>
            {padLabel('Position')}
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(3, ${padBtn}px)`,
              gridTemplateRows:    `repeat(3, ${padBtn}px)`,
              gridTemplateAreas: '". up ." "left center right" ". down ."',
              gap: 4,
            }}>
              <div style={{ gridArea: 'up' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'left' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'center' }}>
                <PadCenter label="XY" width={padBtn} height={padBtn} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'right' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'down' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
            </div>
          </div>

          {/* Z column. */}
          <div>
            {padLabel('Height')}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: zBtnWidth }}>
              <ArrowPadBtn onMouseDown={() => sendJog('z',  1)} rotation={0}   label="Z+" color="#3B82F6"
                size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
              {/* PadCenter uses width override so its width matches the Z buttons. */}
              <div style={{ width: zBtnWidth, height: Math.max(28, padBtn - 50) }}>
                <PadCenter label="Z" width={zBtnWidth} height={Math.max(28, padBtn - 50)} labelSize={lblPx} />
              </div>
              <ArrowPadBtn onMouseDown={() => sendJog('z', -1)} rotation={180} label="Z−" color="#3B82F6"
                size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
            </div>
          </div>

          {/* Rotation pad. */}
          <div>
            {padLabel('Rotation')}
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(3, ${padBtn}px)`,
              gridTemplateRows:    `repeat(3, ${padBtn}px)`,
              gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
              gap: 4,
            }}>
              <div style={{ gridArea: 'rxp' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'rzn' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'center' }}>
                <PadCenter label="Rot" width={padBtn} height={padBtn} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'rzp' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
              <div style={{ gridArea: 'rxn' }}>
                <ArrowPadBtn onMouseDown={() => sendJog('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        // Joint mode — one column per joint with up (positive) / down (negative).
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          {[1, 2, 3, 4, 5, 6].map((j) => (
            <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: jointBtn }}>
              <ArrowPadBtn onMouseDown={() => sendJog(j,  1)} rotation={0}   label="+" color="#16A34A"
                size={jointBtn} svgSize={svgPx} labelSize={lblPx + 2} />
              <PadCenter label={'J' + j} width={jointBtn} height={Math.max(32, jointBtn / 2)} labelSize={13} />
              <ArrowPadBtn onMouseDown={() => sendJog(j, -1)} rotation={180} label="−" color="#DC2626"
                size={jointBtn} svgSize={svgPx} labelSize={lblPx + 2} />
            </div>
          ))}
        </div>
      )}

      {/* Step size + speed */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Step:</span>
          {[0.1, 0.5, 1, 5, 10].map((s) => (
            <button key={s} onClick={() => setStep(s)} style={{
              padding: '8px 14px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
              minHeight: 36,
              background: step === s ? '#2563EB' : '#f3f4f6',
              color:      step === s ? '#fff'    : '#6b7280',
              border:     step === s ? 'none'    : '1px solid #e5e7eb',
            }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 220, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>Speed: {speed}%</span>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ flex: 1, height: 6 }} />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={homeRobot} style={{
          flex: 1, padding: '16px', fontSize: 15, fontWeight: 700,
          background: '#f3f4f6', color: '#374151',
          border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
          minHeight: 52,
        }}>Home</button>
        <button onClick={triggerEstop} style={{
          flex: 1, padding: '16px', fontSize: 15, fontWeight: 700,
          background: '#DC2626', color: '#fff',
          border: 'none', borderRadius: 8, cursor: 'pointer',
          minHeight: 52,
        }}>STOP</button>
        <button title="Save current pose as a teach point (not yet wired)" style={{
          flex: 1, padding: '16px', fontSize: 15, fontWeight: 700,
          background: '#16A34A', color: '#fff',
          border: 'none', borderRadius: 8, cursor: 'pointer',
          minHeight: 52,
        }}>Teach Position</button>
      </div>
    </div>
  )
}

export default function ProgramLayout() {
  const [leftWidth, setLeftWidth]       = useState(560)
  const [jogHeight, setJogHeight]       = useState(500)
  const [jogMaximized, setJogMaximized] = useState(false)
  const drag = useRef({ active: null, startPos: 0, startVal: 0 })
  const [activeDrag, setActiveDrag] = useState(null)

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
        setJogHeight(Math.max(360, Math.min(800, d.startVal + delta)))
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

  // Maximised mode: jog panel takes the whole Program tab. Editor + 3D
  // viewer + horizontal divider all hidden.
  if (jogMaximized) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <JogPanel maximized onToggleMaximize={() => setJogMaximized(false)} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
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

      <div style={{ height: jogHeight, flexShrink: 0, overflow: 'hidden', borderTop: '1px solid #e5e7eb' }}>
        <JogPanel maximized={false} onToggleMaximize={() => setJogMaximized(true)} />
      </div>
    </div>
  )
}

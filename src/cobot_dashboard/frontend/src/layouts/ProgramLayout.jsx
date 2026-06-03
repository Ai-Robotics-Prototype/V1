import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import ProgramEditor from '../components/ProgramEditor'
import ArmViewer3D from '../components/ArmViewer3D'

// Pinned: red tint when the panel is at its min/max limit so the
// operator gets visual feedback instead of silent unresponsiveness.
function VerticalDivider({ onMouseDown, dragging, atLimit }) {
  const tint = dragging ? '#2563EB40' : atLimit ? '#DC262640' : 'transparent'
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 5, cursor: 'col-resize', flexShrink: 0,
        background: tint, position: 'relative', zIndex: 10,
        transition: 'background 150ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = atLimit ? '#DC262640' : '#2563EB40' }}
      onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = atLimit ? '#DC262640' : 'transparent' }}>
      <div style={{
        position: 'absolute', top: '50%', left: 1, transform: 'translateY(-50%)',
        width: 3, height: 30, borderRadius: 2, background: atLimit ? '#DC2626' : '#d1d5db',
      }} />
    </div>
  )
}

function HorizontalDivider({ onMouseDown, dragging, atLimit }) {
  const tint = dragging ? '#2563EB40' : atLimit ? '#DC262640' : 'transparent'
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        height: 5, cursor: 'row-resize', flexShrink: 0,
        background: tint, transition: 'background 150ms',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = atLimit ? '#DC262640' : '#2563EB40' }}
      onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = atLimit ? '#DC262640' : 'transparent' }}>
      <div style={{ width: 30, height: 3, borderRadius: 2, background: atLimit ? '#DC2626' : '#d1d5db' }} />
    </div>
  )
}

// A button that fires its action on press and keeps re-firing every
// 150 ms until the user releases (mouse-up, mouse-leave, touch-end).
// Used for every directional arrow so the operator can hold to jog.
function HoldButton({ onPress, color, width, height, children }) {
  const timer = useRef(null)
  const start = useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    onPress()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(onPress, 150)
  }, [onPress])
  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }, [])
  useEffect(() => () => stop(), [stop])

  return (
    <button
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#d1d5db'; stop() }}
      onMouseEnter={(e) => { e.currentTarget.style.background = color + '15'; e.currentTarget.style.borderColor = color }}
      onTouchStart={start}
      onTouchEnd={stop}
      onTouchCancel={stop}
      style={{
        width, height, padding: 0,
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
        cursor: 'pointer', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4,
        transition: 'background 100ms, border-color 100ms',
        userSelect: 'none', touchAction: 'none',
      }}>
      {children}
    </button>
  )
}

function ArrowPad({ onPress, rotation, label, color, size, svgSize, labelSize }) {
  return (
    <HoldButton onPress={onPress} color={color} width={size} height={size}>
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: labelSize, fontWeight: 700, color: '#374151' }}>{label}</span>
    </HoldButton>
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
  const runProgram   = useStore((s) => s.runProgram)
  const pauseProgram = useStore((s) => s.pauseProgram)
  const resumeProgram= useStore((s) => s.resumeProgram)
  const cancelProgram= useStore((s) => s.cancelProgram)
  const task         = useStore((s) => s.task)
  const safety       = useStore((s) => s.safety)

  const [jogMode, setJogMode] = useState('cartesian')
  const [step, setStep]       = useState(1.0)
  const [speed, setSpeed]     = useState(20)

  const stepRef  = useRef(step)
  const speedRef = useRef(speed)
  const modeRef  = useRef(jogMode)
  useEffect(() => { stepRef.current = step },   [step])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { modeRef.current = jogMode }, [jogMode])

  // Stable callback for the HoldButton repeating interval — reads
  // step/speed/mode from refs so a setInterval set up at press time
  // doesn't capture stale values.
  const sendJog = useCallback((axis, direction) => {
    if (modeRef.current === 'joint') {
      const deltaRad = direction * stepRef.current * Math.PI / 180
      jog(axis - 1, deltaRad)
    } else {
      jogCartesian(axis, direction, stepRef.current, speedRef.current)
    }
  }, [jog, jogCartesian])

  // Sizing knobs flip between normal and maximised modes.
  const padBtn     = maximized ? 110 : 80
  const zBtnWidth  = maximized ? 90  : 70
  const zBtnHeight = maximized ? 110 : 80
  const jointBtnW  = maximized ? 80  : 64
  const jointBtnH  = maximized ? 80  : 56
  const svgPx      = maximized ? 48  : 36
  const lblPx      = maximized ? 15  : 12

  const { estop } = safety
  const { running, paused, state, program_step, program_total } = task

  // === Layout helpers ===
  const modeBtnStyle = (on) => ({
    padding: '14px 20px', fontSize: 15, fontWeight: 700,
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? '2px solid #2563EB' : '2px solid #d1d5db',
    borderRadius: 8, cursor: 'pointer', width: '100%',
    transition: 'all 100ms',
  })

  const runBtnBase = (bg, color, disabled, weight = 700) => ({
    width: '100%', padding: '14px', fontSize: 14, fontWeight: weight,
    background: bg, color,
    border: bg.startsWith('#f') ? '1px solid #d1d5db' : 'none',
    borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  })

  const padLabel = (text) => (
    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textAlign: 'center', marginBottom: 6 }}>{text}</div>
  )

  return (
    <div style={{
      padding: 14, background: '#fff',
      height: '100%', overflowY: 'auto',
      display: 'flex', alignItems: 'stretch', gap: 16,
    }}>
      {/* LEFT — mode, step, speed, maximize */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        width: 160, flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>Jog</div>

        <button onClick={() => setJogMode('cartesian')} style={modeBtnStyle(jogMode === 'cartesian')}>XYZ</button>
        <button onClick={() => setJogMode('joint')}     style={modeBtnStyle(jogMode === 'joint')}>Joint</button>

        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Step Size</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s} onClick={() => setStep(s)} style={{
                padding: '8px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
                minHeight: 36,
                background: step === s ? '#2563EB' : '#f3f4f6',
                color:      step === s ? '#fff'    : '#6b7280',
                border:     step === s ? 'none'    : '1px solid #e5e7eb',
              }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Speed: {speed}%</div>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ width: '100%', height: 6 }} />
        </div>

        <div style={{ flex: 1 }} />

        <button onClick={onToggleMaximize}
          title={maximized ? 'Restore split layout' : 'Maximize jog panel'}
          style={{
            padding: '10px', fontSize: 12, fontWeight: 600,
            background: '#f3f4f6', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
          }}>
          {maximized ? 'Minimize' : 'Maximize'}
        </button>
      </div>

      {/* CENTER — jog arrow pads */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minWidth: 0 }}>
        {jogMode === 'cartesian' ? (
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'center' }}>
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
                  <ArrowPad onPress={() => sendJog('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'left' }}>
                  <ArrowPad onPress={() => sendJog('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'center' }}>
                  <PadCenter label="XY" width={padBtn} height={padBtn} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'right' }}>
                  <ArrowPad onPress={() => sendJog('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'down' }}>
                  <ArrowPad onPress={() => sendJog('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
              </div>
            </div>

            <div>
              {padLabel('Height')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: zBtnWidth }}>
                <ArrowPad onPress={() => sendJog('z',  1)} rotation={0}   label="Z+" color="#3B82F6"
                  size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
                <PadCenter label="Z" width={zBtnWidth} height={Math.max(28, padBtn - 50)} labelSize={lblPx} />
                <ArrowPad onPress={() => sendJog('z', -1)} rotation={180} label="Z−" color="#3B82F6"
                  size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
              </div>
            </div>

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
                  <ArrowPad onPress={() => sendJog('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'rzn' }}>
                  <ArrowPad onPress={() => sendJog('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'center' }}>
                  <PadCenter label="Rot" width={padBtn} height={padBtn} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'rzp' }}>
                  <ArrowPad onPress={() => sendJog('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'rxn' }}>
                  <ArrowPad onPress={() => sendJog('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            {[1, 2, 3, 4, 5, 6].map((j) => (
              <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <ArrowPad onPress={() => sendJog(j,  1)} rotation={0}   label="+" color="#16A34A"
                  size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
                <PadCenter label={'J' + j} width={jointBtnW} height={28} labelSize={13} />
                <ArrowPad onPress={() => sendJog(j, -1)} rotation={180} label="−" color="#DC2626"
                  size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT — Run/Pause/Stop/Home + Teach */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        width: 150, flexShrink: 0,
      }}>
        <button onClick={paused ? resumeProgram : runProgram}
          disabled={estop || (running && !paused)}
          style={runBtnBase('#16A34A', '#fff', estop || (running && !paused))}>
          {paused ? '▶ Resume' : '▶ Run'}
        </button>
        <button onClick={pauseProgram}
          disabled={!running || paused || estop}
          style={runBtnBase('#fef3c7', '#92400e', !running || paused || estop, 600)}>
          ⏸ Pause
        </button>
        <button onClick={cancelProgram}
          disabled={!running && !paused}
          style={{ ...runBtnBase('#DC2626', '#fff', !running && !paused), fontSize: 15 }}>
          STOP
        </button>
        <button onClick={homeRobot} disabled={estop}
          style={runBtnBase('#f3f4f6', '#374151', estop, 600)}>
          ⌂ Home
        </button>

        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', padding: '4px 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb' }}>
          {state} · {program_step + 1}/{program_total}
        </div>

        <div style={{ flex: 1 }} />

        <button onClick={triggerEstop}
          title="Emergency stop"
          style={{
            width: '100%', padding: '10px', fontSize: 11, fontWeight: 700,
            background: '#fff', color: '#DC2626',
            border: '2px solid #DC2626', borderRadius: 8, cursor: 'pointer',
          }}>
          E-STOP
        </button>
        <button
          title="Save current pose as a teach point (not yet wired)"
          style={{
            width: '100%', padding: '14px', fontSize: 13, fontWeight: 700,
            background: '#2563EB', color: '#fff',
            border: 'none', borderRadius: 8, cursor: 'pointer',
          }}>
          Teach Position
        </button>
      </div>
    </div>
  )
}

// Hard floors / fractional ceilings for the resizable panels. The
// floors are derived from "what does each panel need to keep its
// controls visible" — they keep buttons from being clipped no matter
// how the operator drags the dividers.
const PROGRAM_MIN_WIDTH = 380   // editor: step-row buttons (Edit / Teach / Del) fit
const VIEWER_MIN_WIDTH  = 250   // 3D arm: enough to see the robot model
const PROGRAM_MAX_FRAC  = 0.75  // editor can take up to 75% of the row
const JOG_MIN_HEIGHT    = 320   // jog: arrow pads + step/speed + action col fit
const JOG_MAX_FRAC      = 0.6   // jog can take up to 60% of available height

function useWindowSize() {
  const [size, setSize] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth  : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

export default function ProgramLayout() {
  const { w: winW, h: winH } = useWindowSize()
  // Available width inside the Program tab: full viewport minus the
  // left sidebar (64) and a tiny gutter for the divider. The 3D viewer
  // always reserves VIEWER_MIN_WIDTH from the right edge, so the
  // editor's hard max is whichever is tighter: 75 % or "leave room".
  const availW = Math.max(640, winW - 64)
  const leftMax = Math.max(PROGRAM_MIN_WIDTH,
    Math.min(Math.floor(availW * PROGRAM_MAX_FRAC), availW - VIEWER_MIN_WIDTH - 8))
  const jogMax  = Math.max(JOG_MIN_HEIGHT, Math.floor((winH - 96) * JOG_MAX_FRAC))

  const [leftWidth, setLeftWidth]       = useState(() => Math.min(560, leftMax))
  const [jogHeight, setJogHeight]       = useState(() => Math.min(500, jogMax))
  const [jogMaximized, setJogMaximized] = useState(false)
  const drag = useRef({ active: null, startPos: 0, startVal: 0 })
  const [activeDrag, setActiveDrag] = useState(null)

  // Re-clamp when the viewport shrinks so a previously-valid width
  // doesn't end up over the new max (e.g. user shrinks the window
  // after dragging the editor to 800 px).
  useEffect(() => {
    setLeftWidth((w) => Math.max(PROGRAM_MIN_WIDTH, Math.min(w, leftMax)))
    setJogHeight((h) => Math.max(JOG_MIN_HEIGHT, Math.min(h, jogMax)))
  }, [leftMax, jogMax])

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
        setLeftWidth(Math.max(PROGRAM_MIN_WIDTH, Math.min(leftMax, d.startVal + delta)))
      } else if (d.active === 'h') {
        const delta = d.startPos - e.clientY
        setJogHeight(Math.max(JOG_MIN_HEIGHT, Math.min(jogMax, d.startVal + delta)))
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
  }, [leftMax, jogMax])

  const leftAtLimit = leftWidth <= PROGRAM_MIN_WIDTH + 0.5 || leftWidth >= leftMax - 0.5
  const jogAtLimit  = jogHeight <= JOG_MIN_HEIGHT   + 0.5 || jogHeight >= jogMax  - 0.5

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
        <VerticalDivider onMouseDown={startVerticalDrag} dragging={activeDrag === 'v'} atLimit={leftAtLimit} />
        <div style={{ flex: 1, overflow: 'hidden', background: '#FFFFFF', minWidth: VIEWER_MIN_WIDTH }}>
          <ArmViewer3D />
        </div>
      </div>

      <HorizontalDivider onMouseDown={startHorizontalDrag} dragging={activeDrag === 'h'} atLimit={jogAtLimit} />

      {/* Jog panel: overflow auto so a too-small height shows a
          scrollbar instead of clipping the action buttons. */}
      <div style={{ height: jogHeight, flexShrink: 0, overflow: 'auto', borderTop: '1px solid #e5e7eb' }}>
        <JogPanel maximized={false} onToggleMaximize={() => setJogMaximized(true)} />
      </div>
    </div>
  )
}

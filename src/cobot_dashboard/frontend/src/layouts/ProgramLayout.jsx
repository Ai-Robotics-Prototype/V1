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

// Small overlay button on each of the three program-tab panels. Lets
// the operator give one panel the entire workspace (and back again).
//
// Icon-only 32×32 chip at the top-right. The wrapping <PanelChrome>
// gives it the position:relative + overflow:hidden + padding-top
// clearance it needs so no other panel button can ever sit underneath
// it (step Edit/Teach/Del buttons, jog arrow pads, viewer controls).
function PanelExpandBtn({ expanded, onClick, title }) {
  return (
    <button
      onClick={onClick}
      title={title || (expanded ? 'Restore split layout' : 'Expand panel')}
      aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
      style={{
        position: 'absolute', top: 8, right: 8, zIndex: 10,
        width: 32, height: 32, padding: 0,
        background: expanded ? '#2563EB' : 'rgba(255,255,255,0.92)',
        color:      expanded ? '#fff'    : '#374151',
        border:     expanded ? 'none'    : '1px solid #d1d5db',
        borderRadius: 6, cursor: 'pointer',
        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
        fontSize: 16, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      {expanded ? '✕' : '⛶'}
    </button>
  )
}

// Wraps a panel's contents so the expand button is clipped to that
// panel only and the content sits below it (min 44px top inset).
// All three program-tab panels share this chrome so the corner button
// behaves identically across steps, 3D viewer, and jog.
function PanelChrome({ expanded, onToggle, title, background, children }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      width: '100%', height: '100%',
      background: background || 'transparent',
    }}>
      <PanelExpandBtn expanded={expanded} onClick={onToggle} title={title} />
      <div style={{
        width: '100%', height: '100%',
        paddingTop: 44, boxSizing: 'border-box',
      }}>
        {children}
      </div>
    </div>
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

// The teach pendant. Maximize/restore is driven entirely by the
// surrounding PanelChrome corner button — JogPanel no longer renders
// its own toggle.
function JogPanel({ maximized }) {
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

  // Sizing knobs flip between normal and maximised modes. Every value
  // below is sized to the spec'd jog button sheet — the panel fills
  // the available area instead of clustering buttons in a corner.
  //
  // Arrow / d-pad buttons:
  const padBtn     = maximized ? 140 : 96
  const zBtnWidth  = maximized ? 140 : 96
  const zBtnHeight = maximized ? 140 : 96
  const jointBtnW  = maximized ? 140 : 96
  const jointBtnH  = maximized ? 140 : 96
  const svgPx      = maximized ? 60  : 42
  const lblPx      = maximized ? 16  : 13
  // Gaps inside each d-pad and between the three d-pad groups.
  const padInner   = maximized ? 14  : 10
  const padGroup   = maximized ? 40  : 28
  const jointColGap = maximized ? 24 : 16
  // Joint label that sits between +/- buttons of each joint column.
  const jointLblFont = maximized ? 16 : 13
  const jointLblMb   = maximized ? 10 : 6
  // Action buttons on the right (Run / Pause / Stop / Home / Teach).
  const actionMinH = maximized ? 68  : 52
  const actionFont = maximized ? 17  : 14
  const actionMinW = maximized ? 100 : 80
  const actionGap  = maximized ? 14  : 10
  // Mode toggle buttons (XYZ / Joint).
  const modeMinH   = maximized ? 56  : 44
  const modeFont   = maximized ? 16  : 13
  const modePadX   = maximized ? 24  : 18
  // Step-size chips (small selection grid).
  const stepBtnH   = maximized ? 56  : 36
  const stepBtnFont = maximized ? 15 : 12
  const sectionLabelFont = maximized ? 13 : 11
  const speedFont  = maximized ? 15 : 13
  const containerPad = maximized ? 20 : 12

  const { estop } = safety
  const { running, paused, state, program_step, program_total } = task

  // === Layout helpers ===
  const modeBtnStyle = (on) => ({
    padding: `0 ${modePadX}px`,
    minHeight: modeMinH,
    fontSize: modeFont, fontWeight: 700,
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? '2px solid #2563EB' : '2px solid #d1d5db',
    borderRadius: 8, cursor: 'pointer', width: '100%',
    transition: 'all 100ms',
  })

  const runBtnBase = (bg, color, disabled, weight = 700) => ({
    width: '100%',
    minWidth: actionMinW,
    padding: maximized ? '16px' : '12px',
    minHeight: actionMinH,
    fontSize: actionFont, fontWeight: weight,
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
      padding: containerPad, background: '#fff',
      width: '100%', height: '100%', overflowY: 'auto',
      display: 'flex', flexDirection: 'row',
      alignItems: 'center', justifyContent: 'space-evenly',
      gap: maximized ? 28 : 16,
      boxSizing: 'border-box',
    }}>
      {/* LEFT — mode, step, speed */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        width: maximized ? 220 : 180, flexShrink: 0,
        alignSelf: 'stretch', justifyContent: 'center',
      }}>
        <div style={{ fontSize: maximized ? 16 : 14, fontWeight: 700, color: '#111' }}>Jog</div>

        <button onClick={() => setJogMode('cartesian')} style={modeBtnStyle(jogMode === 'cartesian')}>XYZ</button>
        <button onClick={() => setJogMode('joint')}     style={modeBtnStyle(jogMode === 'joint')}>Joint</button>

        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: sectionLabelFont, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Step Size</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s} onClick={() => setStep(s)} style={{
                padding: maximized ? '12px 16px' : '8px 12px',
                fontSize: stepBtnFont, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
                minHeight: stepBtnH,
                background: step === s ? '#2563EB' : '#f3f4f6',
                color:      step === s ? '#fff'    : '#6b7280',
                border:     step === s ? 'none'    : '1px solid #e5e7eb',
              }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: speedFont, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Speed: {speed}%</div>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ width: '100%', height: maximized ? 10 : 6 }} />
        </div>

        <div style={{ flex: 1 }} />
      </div>

      {/* CENTER — jog arrow pads */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minWidth: 0, alignSelf: 'stretch' }}>
        {jogMode === 'cartesian' ? (
          <div style={{ display: 'flex', gap: padGroup, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <div>
              {padLabel('Position')}
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                gridTemplateAreas: '". up ." "left center right" ". down ."',
                gap: padInner,
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: padInner, width: zBtnWidth }}>
                <ArrowPad onPress={() => sendJog('z',  1)} rotation={0}   label="Z+" color="#3B82F6"
                  size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
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
                gap: padInner,
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
          <div style={{ display: 'flex', gap: jointColGap, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
            {[1, 2, 3, 4, 5, 6].map((j) => (
              <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: padInner }}>
                <div style={{ fontSize: jointLblFont, fontWeight: 700, color: '#374151', marginBottom: jointLblMb }}>
                  {'J' + j}
                </div>
                <ArrowPad onPress={() => sendJog(j,  1)} rotation={0}   label="+" color="#16A34A"
                  size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
                <ArrowPad onPress={() => sendJog(j, -1)} rotation={180} label="−" color="#DC2626"
                  size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT — Run/Pause/Stop/Home + Teach */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: actionGap,
        width: maximized ? 180 : 150, flexShrink: 0,
        alignSelf: 'stretch', justifyContent: 'center',
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
          style={runBtnBase('#DC2626', '#fff', !running && !paused)}>
          STOP
        </button>
        <button onClick={homeRobot} disabled={estop}
          style={runBtnBase('#f3f4f6', '#374151', estop, 600)}>
          ⌂ Home
        </button>

        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', padding: '4px 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb' }}>
          {state} · {program_step + 1}/{program_total}
        </div>

        <button onClick={triggerEstop}
          title="Emergency stop"
          style={{
            width: '100%',
            minWidth: actionMinW,
            padding: maximized ? '14px' : '10px',
            minHeight: actionMinH,
            fontSize: actionFont, fontWeight: 700,
            background: '#fff', color: '#DC2626',
            border: '2px solid #DC2626', borderRadius: 8, cursor: 'pointer',
          }}>
          E-STOP
        </button>
        <button
          title="Save current pose as a teach point (not yet wired)"
          style={{
            width: '100%',
            minWidth: actionMinW,
            padding: maximized ? '16px' : '12px',
            minHeight: actionMinH,
            fontSize: actionFont, fontWeight: 700,
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
const JOG_MIN_HEIGHT    = 420   // jog: 96×96 d-pad + label + chrome 44 + padding fit
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

  // Layout state lives in the store (and is persisted) so tab swaps
  // and page reloads keep the dividers where the operator put them.
  const programLayout    = useStore((s) => s.programLayout)
  const setProgramLayout = useStore((s) => s.setProgramLayout)
  const leftWidth        = programLayout.leftWidth
  const jogHeight        = programLayout.jogHeight
  // expandedPanel: 'steps' | '3d' | 'jog' | null. Old persisted state
  // may still carry jogMaximized:true from before this slice existed —
  // honour it as the migration path so a tab swap doesn't surprise.
  const expandedPanel    = programLayout.expandedPanel
    ?? (programLayout.jogMaximized ? 'jog' : null)
  const setLeftWidth     = useCallback((w) => setProgramLayout({ leftWidth: typeof w === 'function' ? w(programLayout.leftWidth) : w }), [setProgramLayout, programLayout.leftWidth])
  const setJogHeight     = useCallback((h) => setProgramLayout({ jogHeight: typeof h === 'function' ? h(programLayout.jogHeight) : h }), [setProgramLayout, programLayout.jogHeight])
  const setExpandedPanel = useCallback((p) => setProgramLayout({
    expandedPanel: p,
    jogMaximized: p === 'jog',  // mirror so legacy reads stay consistent
  }), [setProgramLayout])

  const drag = useRef({ active: null, startPos: 0, startVal: 0 })
  const [activeDrag, setActiveDrag] = useState(null)

  // Re-clamp when the viewport shrinks so a previously-valid width
  // doesn't end up over the new max (e.g. user shrinks the window
  // after dragging the editor to 800 px).
  useEffect(() => {
    const clampedW = Math.max(PROGRAM_MIN_WIDTH, Math.min(leftWidth, leftMax))
    const clampedH = Math.max(JOG_MIN_HEIGHT,    Math.min(jogHeight, jogMax))
    if (clampedW !== leftWidth || clampedH !== jogHeight) {
      setProgramLayout({ leftWidth: clampedW, jogHeight: clampedH })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Single-panel maximised views. Each one is the full Program tab with
  // a top-right Collapse button. PanelChrome supplies the 44px top
  // inset so the corner button never overlays inner controls (step
  // buttons, jog arrows, viewer overlays).
  if (expandedPanel === 'steps') {
    return (
      <PanelChrome expanded onToggle={() => setExpandedPanel(null)} title="Restore split layout">
        <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
          <ProgramEditor />
        </div>
      </PanelChrome>
    )
  }
  if (expandedPanel === '3d') {
    return (
      <PanelChrome expanded onToggle={() => setExpandedPanel(null)} title="Restore split layout" background="#FFFFFF">
        <ArmViewer3D />
      </PanelChrome>
    )
  }
  if (expandedPanel === 'jog') {
    return (
      <PanelChrome expanded onToggle={() => setExpandedPanel(null)} title="Restore split layout">
        <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
          <JogPanel maximized />
        </div>
      </PanelChrome>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div style={{ width: leftWidth, flexShrink: 0, display: 'flex', overflow: 'hidden' }}>
          <PanelChrome
            onToggle={() => setExpandedPanel('steps')}
            title="Expand the program steps panel"
          >
            <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
              <ProgramEditor />
            </div>
          </PanelChrome>
        </div>
        <VerticalDivider onMouseDown={startVerticalDrag} dragging={activeDrag === 'v'} atLimit={leftAtLimit} />
        <div style={{ flex: 1, overflow: 'hidden', background: '#FFFFFF', minWidth: VIEWER_MIN_WIDTH }}>
          <PanelChrome
            onToggle={() => setExpandedPanel('3d')}
            title="Expand the 3D viewer"
            background="#FFFFFF"
          >
            <ArmViewer3D />
          </PanelChrome>
        </div>
      </div>

      <HorizontalDivider onMouseDown={startHorizontalDrag} dragging={activeDrag === 'h'} atLimit={jogAtLimit} />

      {/* Jog panel — wrapped in the same PanelChrome so the corner
          button matches the other two panels. PanelChrome's inner
          scroll keeps the action buttons accessible even at small
          heights. */}
      <div style={{ height: jogHeight, flexShrink: 0, borderTop: '1px solid #e5e7eb' }}>
        <PanelChrome
          onToggle={() => setExpandedPanel('jog')}
          title="Expand the teach pendant"
        >
          <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
            <JogPanel maximized={false} />
          </div>
        </PanelChrome>
      </div>
    </div>
  )
}

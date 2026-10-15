import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { HoldButton } from './JogControls'
import ArmEnableControl from './ArmEnableControl'
import NumericField from './NumericField'
import DistanceSlider from './DistanceSlider'
import { formatInLabel, mmToIn, inToMm } from '../lib/distanceUnits'
import PalletFrameDiagram from './PalletFrameDiagram'
import { getToolHookup, toolHookupKey } from '../lib/toolsApi'
import ToolFromCellStep from './ToolFromCellStep'
import { QuestionCard } from './WizardStepCard'
import WizardStepErrorBoundary from './WizardStepErrorBoundary'
import { useIOPortmap, portmapToOptions } from '../lib/ioPortmap'
import { useSynapsePortmap, displayNameForRaw } from '../lib/synapsePortmap'
import { useIoHardwareProfile } from '../lib/ioHardwareProfile'
import { getCell, findCellEoat } from '../lib/cellStore'
import { resolveCapacity, resolveVerification, resolveConfirmSignals,
         offersMultiPick, emitsVerificationStep,
         VERIFICATION_PER_PART } from '../lib/eoatVerification'
import { waypointJunctionsForOperation, readWaypointsForJunction,
         waypointStepsForJunction, offerInstrFor }
  from '../lib/waypointJunctions'
import { resolveMachineFixtures, clampFixtureSteps, unclampFixtureSteps,
         missingClampSignalFixtures, missingClampSignalRefusal }
  from '../lib/machineFixtures'

// 2026-10-15 operator directive: multi-pick + verification questions
// are gated on the SELECTED tool's capacity + verification. The PAGES
// list's skip predicate only receives answers (cellRegistry is kept in
// component state and not threaded through), so this module ref lets
// skip() reach the current cell snapshot without touching the engine
// signature. The ProgramWizard component below sets this ref on mount
// and clears it on unmount — single-wizard-instance invariant.
let _wizardCellRegistryRef = null
function _wizardSelectedEoat(answers) {
  if (!_wizardCellRegistryRef) return null
  const id = answers && answers.cell_eoat_id
  if (!id) return null
  return findCellEoat(_wizardCellRegistryRef, id) || null
}
import { effectorReady, effectorEngage, effectorDisengage,
         effectorOf,
         clampWorkpiece, unclampWorkpiece,
         startMachineCycle, waitMachineCycle } from '../lib/effectorVocab'
import { typeLabel } from '../lib/cellEntryDisplay'
import { kbSafeFlexShellStyle, kbSafeScrollChildStyle,
         kbSafeOverlayStyle } from '../lib/keyboardInset'

/*
 * Conversational Program Wizard
 *
 * Each "page" asks ONE question. The answer determines the next page.
 * The program steps are built incrementally as the operator answers.
 * At any point the operator can go back and change a previous answer.
 */

// ────────────────────────────────────────────────────────
// Question definitions
// ────────────────────────────────────────────────────────

// QuestionCard (canonical wizard-step container) moved to
// ./WizardStepCard.jsx so steps imported from their own files
// (ToolFromCellStep + any future per-file step) render inside the
// SAME chrome as inline PAGES entries. Import, don't fork.

function ChoiceButton({ label, description, selected, onClick, icon }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', padding: '16px 18px', textAlign: 'left', cursor: 'pointer',
      background: selected ? '#eff6ff' : '#fff',
      border: selected ? '2px solid #2563EB' : '2px solid #e5e7eb',
      borderRadius: 10, marginBottom: 8,
      transition: 'all 100ms',
    }}
      onMouseEnter={e => { if (!selected) { e.currentTarget.style.borderColor = '#93c5fd'; e.currentTarget.style.background = '#f8fafc' }}}
      onMouseLeave={e => { if (!selected) { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff' }}}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {icon && <span style={{ fontSize: 24 }}>{icon}</span>}
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: selected ? '#2563EB' : '#111' }}>{label}</div>
          {description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{description}</div>}
        </div>
      </div>
    </button>
  )
}

function SliderQuestion({ label, value, onChange, min, max, step, unit, description }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#2563EB' }}>{value}{unit}</span>
      </div>
      {description && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{description}</div>}
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', height: 8 }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

function NextButton({ onClick, disabled, label }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: '100%', padding: '14px', fontSize: 16, fontWeight: 700, marginTop: 16,
      background: disabled ? '#d1d5db' : '#2563EB', color: '#fff',
      border: 'none', borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
    }}>
      {label || 'Next'}
    </button>
  )
}

// 2026-10-15 pick/place count input — large +/- stepper flanking a
// numeric read-out, clamp 1..10, tablet-friendly (56px tall buttons).
// Shared between the "How many pick positions?" and "How many place
// positions?" steps so the two surfaces stay import-identical.
function PickPlaceCountInput({ value, onChange, testId }) {
  const MIN = 1
  const MAX = 10
  const v = Number.isFinite(value) ? Math.max(MIN, Math.min(MAX, Math.round(value))) : 1
  const setClamped = (n) => onChange(Math.max(MIN, Math.min(MAX, Math.round(n))))
  const btn = (disabled) => ({
    minHeight: 56, minWidth: 72,
    padding: '0 20px', fontSize: 22, fontWeight: 800,
    background: disabled ? '#f3f4f6' : '#eff6ff',
    color: disabled ? '#9ca3af' : '#2563EB',
    border: `1px solid ${disabled ? '#e5e7eb' : '#bfdbfe'}`,
    borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  return (
    <div data-testid={testId} data-value={v}
         style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', marginBottom: 8 }}>
      <button type="button" aria-label="decrease"
              onClick={() => setClamped(v - 1)} disabled={v <= MIN}
              style={btn(v <= MIN)}>−</button>
      <input
        type="number" inputMode="numeric" min={MIN} max={MAX} value={v}
        onChange={(e) => setClamped(parseInt(e.target.value, 10) || MIN)}
        style={{
          width: 96, textAlign: 'center',
          fontSize: 28, fontWeight: 800, color: '#111',
          padding: '12px 10px',
          border: '2px solid #e5e7eb', borderRadius: 10,
          fontVariantNumeric: 'tabular-nums',
        }} />
      <button type="button" aria-label="increase"
              onClick={() => setClamped(v + 1)} disabled={v >= MAX}
              style={btn(v >= MAX)}>+</button>
    </div>
  )
}

// ────────────────────────────────────────────────────────
// Wizard pages
// ────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────
// TeachWithJog — inline jog pendant for each wizard teach page.
// Wires straight into the store's existing jog actions so the same
// safety guards + radian conversion the Program tab uses apply here.
// ────────────────────────────────────────────────────────

function radiansToJointDegrees(positions) {
  if (!Array.isArray(positions)) return [0, 0, 0, 0, 0, 0]
  return positions.slice(0, 6).map((rad) => Number((rad * 180 / Math.PI).toFixed(2)))
}

function JogArrow({ onPress, color, label, rotation, size = 64 }) {
  const timer = useRef(null)
  const start = useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    onPress()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(onPress, 150)
  }, [onPress])
  const stop = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null }
  }, [])
  useEffect(() => () => stop(), [stop])

  // Inner content scales with the button size so big touch buttons in the
  // fullscreen teach pendant don't render with a tiny arrow + label in the
  // middle. Floors stay at the previous fixed values so the smaller jog
  // panels (TeachWithJog at size 64) render identically to before.
  const svgPx = Math.max(24, Math.floor(size * 0.28))
  const lblPx = Math.max(10, Math.floor(size * 0.10))

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
        width: size, height: size, padding: 0,
        background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
        cursor: 'pointer', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 2,
        userSelect: 'none', touchAction: 'none',
      }}>
      <svg width={svgPx} height={svgPx} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: lblPx, fontWeight: 700, color: '#374151' }}>{label}</span>
    </button>
  )
}

function PadCenterTile({ label, width = 64, height = 64 }) {
  return (
    <div style={{
      width, height,
      background: '#f3f4f6', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 11, fontWeight: 700, color: '#9ca3af',
    }}>{label}</div>
  )
}

// Wizard-sized wrapper for the shared HoldButton — same pattern as
// ProgramEditor.OverlayJogArrow. Migrated from the old onPress
// setInterval(150ms) pulsing that fired discrete /cmd/jog HTTP POSTs
// (never `s.jog` — that store action doesn't exist, so joint-mode
// jog was a silent TypeError). Now uses the same WS transport +
// hold_id/seq/keepalive the main pendant does.
//
// 2026-10-08 Bug-2 unify: accepts jogStyle + onTap from the caller so
// the wizard teach surface rides the SAME HoldButton STEP/CONTINUOUS
// contract as the main pendant + TeachDrawer. Prior form hard-coded
// jogStyle="CONTINUOUS", making the wizard step-chip row visually
// dead. Default stays CONTINUOUS so legacy TeachWithJog callers keep
// their pre-unify behavior.
function WizardJogArrow({
  jogStyle, onTap, onPressStart, onPressTick, onPressEnd,
  color, label, rotation, size = 64, svgSize,
  disabled,
}) {
  const sp = svgSize || Math.max(24, Math.floor(size * 0.28))
  const lp = Math.max(10, Math.floor(size * 0.10))
  return (
    <HoldButton
      jogStyle={jogStyle || 'CONTINUOUS'}
      onTap={onTap}
      onPressStart={onPressStart}
      onPressTick={onPressTick}
      onPressEnd={onPressEnd}
      color={color}
      width={size} height={size}
      disabled={disabled}>
      <svg width={sp} height={sp} viewBox="0 0 24 24"
           style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: lp, fontWeight: 700, color: '#374151' }}>{label}</span>
    </HoldButton>
  )
}

function TeachWithJog({ title, description, instructions, pointName, answers, setAnswer, onNext, onSkip }) {
  const jogHold          = useStore((s) => s.jogHold)
  const jogHoldCartesian = useStore((s) => s.jogHoldCartesian)
  const jogRelease       = useStore((s) => s.jogRelease)
  const homeRobot    = useStore((s) => s.homeRobot)
  const triggerEstop = useStore((s) => s.triggerEstop)

  // answers may be undefined on the very first render if a stale
  // teach page mounts before the parent wizard hydrates — guard both
  // reads so initial useState never throws.
  const initialTaught = !!(answers && answers[pointName])
  const [taught, setTaught]     = useState(initialTaught)
  const [position, setPosition] = useState((answers && answers[pointName]) || null)

  const [jogMode, setJogMode] = useState('cartesian')
  const [step, setStep]       = useState(1.0)
  const [speed, setSpeed]     = useState(20)

  const [liveJoints, setLiveJoints] = useState([0, -90, 0, -90, 0, 0])
  const [liveTcp,    setLiveTcp]    = useState([0, 0, 0, 0, 0, 0])

  // Keep refs current so the JogArrow's repeating interval reads
  // the latest step/speed/mode instead of the values captured at
  // press time.
  const stepRef = useRef(step), speedRef = useRef(speed), modeRef = useRef(jogMode)
  useEffect(() => { stepRef.current = step },   [step])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { modeRef.current = jogMode }, [jogMode])

  // Poll live robot state.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/state')
        if (!alive || !res.ok) return
        const d = await res.json()
        setLiveJoints(radiansToJointDegrees(d?.joints?.positions))
        if (Array.isArray(d?.tcp_pose)) setLiveTcp(d.tcp_pose)
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 300)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  // Shared WS jog transport — same store actions the main
  // JogControls pendant and the fullscreen TeachOverlay use. The
  // old broken pattern posted discrete HTTP /cmd/jog pulses through
  // `s.jog` (undefined — silent TypeError on joint jog) or
  // `s.jogCartesian` (worked but every 150 ms pulse looked like a
  // fresh session to the driver → 300 ms freshness deadman fired
  // between pulses → jog chatter). jogHold + jogRelease carry
  // hold_id/seq/abort meta from HoldButton so the driver sees ONE
  // continuous session and the server-side keepalive covers stalls.
  const holdStart = useCallback((axis, direction, meta) => {
    if (modeRef.current === 'joint') {
      return jogHold(axis, direction, speedRef.current, meta)
    }
    return jogHoldCartesian(axis, direction, speedRef.current, meta)
  }, [jogHold, jogHoldCartesian])
  const holdEnd = useCallback((meta) => jogRelease(modeRef.current, meta),
    [jogRelease])
  const wire = useCallback((axis, direction) => ({
    onPressStart: (meta) => holdStart(axis, direction, meta),
    onPressTick:  (meta) => holdStart(axis, direction, meta),
    onPressEnd:   (meta) => holdEnd(meta),
  }), [holdStart, holdEnd])

  async function recordPosition() {
    try {
      const res = await fetch('/api/state')
      if (!res.ok) return
      const d = await res.json()
      const joints = radiansToJointDegrees(d?.joints?.positions)
      const tcp    = Array.isArray(d?.tcp_pose) ? d.tcp_pose : null
      const pos = {
        joints,
        tcp,
        name:      pointName,
        taught_at: new Date().toISOString(),
      }
      setPosition(pos)
      // Wizard's per-answer setter: (key, value). Not the (prev =>
      // next) functional setter the previous draft assumed.
      setAnswer(pointName, pos)
      setTaught(true)
    } catch {}
  }

  const padBtn = 64

  // Tablet-first layout (2026-07-22 fix). The old layout was a flat
  // document-flow div — the Record button sat at the BOTTOM of a
  // ~1200 px stack of instructions + live readout + three jog grids +
  // speed slider, which on any tablet viewport put Record below the
  // fold. The operator would have had to scroll while hold-jogging,
  // impossible on touch. Now the component fills its parent (the
  // wizard modal's flex-1 content area) as a flex column:
  //   * scrollable middle (instructions, live readout, jog pads)
  //   * flex-shrink:0 STICKY FOOTER — Record + STOP + Cancel/Next
  //     stay reserved, safe-area padded, ≥44px touch targets.
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0,
      background: '#fff',
    }}>
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: 24,
        maxWidth: 760, width: '100%', margin: '0 auto',
        boxSizing: 'border-box',
      }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 16 }}>{description}</div>

      <div style={{
        padding: 16, background: '#eff6ff', borderRadius: 10,
        border: '1px solid #bfdbfe', marginBottom: 20,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#2563EB', marginBottom: 8 }}>
          How to teach this position:
        </div>
        {instructions.map((inst, i) => (
          <div key={i} style={{
            display: 'flex', gap: 10, marginBottom: 6,
            fontSize: 13, color: '#374151',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: '#2563EB', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
            }}>{i + 1}</div>
            <div style={{ paddingTop: 2 }}>{inst}</div>
          </div>
        ))}
      </div>

      {/* 2026-10-13 operator directive: live Joints/TCP numeric readout
          retired from every teach surface — operators don't need the
          numbers while teaching. liveJoints + liveTcp state kept and
          polled only as the Record Position fallback path (used when
          /api/state is unavailable at capture time). */}

      <div style={{
        padding: 16, background: '#fff', borderRadius: 10,
        border: '1px solid #e5e7eb', marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setJogMode('cartesian')} style={modeBtn(jogMode === 'cartesian')}>XYZ</button>
          <button onClick={() => setJogMode('joint')}     style={modeBtn(jogMode === 'joint')}>Joint</button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#6b7280' }}>Step:</span>
          {[0.1, 0.5, 1, 5, 10].map((s) => (
            <button key={s} onClick={() => setStep(s)} style={{
              padding: '4px 8px', fontSize: 10, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
              background: step === s ? '#2563EB' : '#f3f4f6',
              color:      step === s ? '#fff'    : '#6b7280',
              border:     step === s ? 'none'    : '1px solid #e5e7eb',
            }}>{s}</button>
          ))}
        </div>

        {jogMode === 'cartesian' ? (
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={padLabelStyle}>Position</div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                gridTemplateAreas: '". up ." "left center right" ". down ."',
                gap: 4,
              }}>
                <div style={{ gridArea: 'up' }}>    <WizardJogArrow {...wire('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} /></div>
                <div style={{ gridArea: 'left' }}>  <WizardJogArrow {...wire('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} /></div>
                <div style={{ gridArea: 'center' }}><PadCenterTile label="XY" /></div>
                <div style={{ gridArea: 'right' }}> <WizardJogArrow {...wire('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} /></div>
                <div style={{ gridArea: 'down' }}>  <WizardJogArrow {...wire('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} /></div>
              </div>
            </div>

            <div>
              <div style={padLabelStyle}>Height</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: padBtn }}>
                <WizardJogArrow {...wire('z',  1)} rotation={0}   label="Z+" color="#3B82F6" size={padBtn} />
                <PadCenterTile label="Z" height={24} />
                <WizardJogArrow {...wire('z', -1)} rotation={180} label="Z−" color="#3B82F6" size={padBtn} />
              </div>
            </div>

            <div>
              <div style={padLabelStyle}>Rotation</div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
                gap: 4,
              }}>
                <div style={{ gridArea: 'rxp' }}>   <WizardJogArrow {...wire('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} /></div>
                <div style={{ gridArea: 'rzn' }}>   <WizardJogArrow {...wire('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} /></div>
                <div style={{ gridArea: 'center' }}><PadCenterTile label="Rot" /></div>
                <div style={{ gridArea: 'rzp' }}>   <WizardJogArrow {...wire('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} /></div>
                <div style={{ gridArea: 'rxn' }}>   <WizardJogArrow {...wire('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} /></div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {[1, 2, 3, 4, 5, 6].map((j) => (
              <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <WizardJogArrow {...wire(j,  1)} rotation={0}   label={'+J' + j} color="#16A34A" size={56} />
                <PadCenterTile label={'J' + j} width={56} height={24} />
                <WizardJogArrow {...wire(j, -1)} rotation={180} label={'−J' + j} color="#DC2626" size={56} />
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <span style={{ fontSize: 12, color: '#6b7280', minWidth: 90 }}>Speed: {speed}%</span>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ flex: 1 }} />
          <button onClick={homeRobot} style={smallBtn('#f3f4f6', '#374151', '#d1d5db')}>Home</button>
          <button onClick={triggerEstop} style={{ ...smallBtn('#DC2626', '#fff'), border: 'none', fontWeight: 700 }}>STOP</button>
        </div>
      </div>

      {taught && position && (
        <div style={{
          padding: 14, background: '#f0fdf4', borderRadius: 10,
          border: '1px solid #bbf7d0', marginBottom: 16,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#16A34A', marginBottom: 4 }}>
            ✓ Position recorded
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>
            Joints: [{position.joints.map((j) => j.toFixed(1)).join(', ')}]°
          </div>
        </div>
      )}
      </div>

      {/* STICKY FOOTER — tablet-first: Record + STOP + Skip/Next share
          one row that stays reserved outside the scrollable content.
          padding-bottom includes env(safe-area-inset-bottom) so the
          row clears the iOS home indicator / Android nav bar. Every
          button ≥56px tall (well over 44px minimum). */}
      <div style={{
        flexShrink: 0,
        borderTop: '1px solid #e5e7eb', background: '#fff',
        padding: '10px 16px',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <button onClick={triggerEstop} style={{
          minHeight: 56, minWidth: 96,
          padding: '0 16px',
          fontSize: 15, fontWeight: 800,
          background: '#DC2626', color: '#fff',
          border: 'none', borderRadius: 10, cursor: 'pointer',
          flexShrink: 0,
          boxShadow: '0 0 0 2px rgba(220,38,38,0.15)',
        }}>⏹ STOP</button>
        {/* 2026-10-13 operator directive: shared Enable control on the
            teach surface so the operator can power the arm without
            leaving the teach window. Imported identity — same store
            action, confirm modal, and live state as the main pendant
            (fork registry: arm_enable_control). */}
        <ArmEnableControl />
        <button onClick={recordPosition} style={{
          flex: 1, minHeight: 56, padding: '0 16px',
          fontSize: 16, fontWeight: 800,
          background: taught ? '#16A34A' : '#2563EB', color: '#fff',
          border: 'none', borderRadius: 10, cursor: 'pointer',
        }}>
          {taught ? 'Re-record Position' : 'Record This Position'}
        </button>
        {taught && (
          <button onClick={onNext} style={{
            minHeight: 56, padding: '0 22px',
            fontSize: 15, fontWeight: 700,
            background: '#16A34A', color: '#fff',
            border: 'none', borderRadius: 10, cursor: 'pointer',
            flexShrink: 0,
          }}>Next →</button>
        )}
        {onSkip && !taught && (
          <button onClick={onSkip} style={{
            minHeight: 56, padding: '0 16px',
            fontSize: 14, fontWeight: 600,
            background: '#fff', color: '#6b7280',
            border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            flexShrink: 0,
          }}>Skip →</button>
        )}
      </div>
    </div>
  )
}

const modeBtn = (on) => ({
  padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
  background: on ? '#2563EB' : '#f3f4f6',
  color:      on ? '#fff'    : '#374151',
  border:     on ? 'none'    : '1px solid #d1d5db',
})

const smallBtn = (bg, color, border) => ({
  padding: '8px 16px', fontSize: 12, fontWeight: 600,
  background: bg, color,
  border: border ? `1px solid ${border}` : 'none',
  borderRadius: 6, cursor: 'pointer',
})

const padLabelStyle = {
  fontSize: 11, fontWeight: 600, color: '#6b7280',
  textAlign: 'center', marginBottom: 4,
}

const inputBox = {
  width: '100%', padding: '10px 12px', fontSize: 16, fontWeight: 600,
  border: '2px solid #e5e7eb', borderRadius: 8, outline: 'none',
  boxSizing: 'border-box',
}

// Style + math tokens retained from the retired custom-gripper block

// 2026-10-15 operator directive: the record-confirmation names THIS
// position in plain language ("Successfully taught Pick position"). The
// teach-step labels are ALL-CAPS pedagogical headings; convert to a
// first-letter-cap sentence form for the confirmation copy. No coord
// dump anywhere — just the name.
function teachLabelToName(label) {
  if (!label || typeof label !== 'string') return 'position'
  // Lowercase everything then capitalize the first letter. Preserves
  // punctuation ("HOME (return)" → "Home (return)") and leading digits
  // / enclosed-digit glyphs ("① PALLET CORNER — origin" → "① pallet
  // corner — origin" where the first alpha char is left as-is).
  const lower = label.toLowerCase()
  const firstAlpha = lower.search(/[a-z]/)
  if (firstAlpha < 0) return lower
  return lower.slice(0, firstAlpha) + lower.charAt(firstAlpha).toUpperCase() + lower.slice(firstAlpha + 1)
}

// 2026-10-15 operator directive: waypoint-offer prompts between main
// teach positions. The data model (junction map + storage reader +
// codegen emitter) lives in lib/waypointJunctions.js so every surface
// that offers waypoint teaching consumes the SAME source — a fix
// landed in the shared module applies everywhere. ProgramWizard imports
// waypointJunctionsForOperation, readWaypointsForJunction,
// waypointStepsForJunction + offerInstrFor from that lib. No inline
// fork of the junction map allowed; D_shared_waypoint_offer.test.js
// greps for the retired function names and fails on any re-add.


// Derive the ordered list of positions for the current operation.
function teachPositionsForAnswers(answers) {
  const op   = answers.operation
  const mode = answers.pallet_mode
  const positions = [
    { key: 'taught_home', label: 'HOME POSITION',
      instr: 'Jog the robot to its safe home position — a neutral pose away from the work area that the robot returns to between cycles.' },
  ]
  // Teach flow speaks the contact-pose model — the operator teaches
  // where the gripper physically TOUCHES the part / target, not an
  // approach hover. Approach and retreat poses are derived at build
  // time from the taught contact + program-config approach_height.
  if (op === 'palletize' && mode === 'palletize') {
    positions.push({
      key: 'taught_pick', label: 'PICK POSITION',
      instr: 'Jog the robot to the pick CONTACT — the pose where the gripper/vacuum touches the part. The approach hover above is computed automatically from your approach-height setting.',
    })
    // 4-point pallet frame (2026-08-05 operator doctrine ruling,
    // canonical): three CORNERS define the pallet FRAME ONLY
    // (origin at corner 1, row axis toward corner 2, column axis
    // toward corner 3, plane from all three). Point 4 is the
    // CENTER of slot [1,1] — the first-part datum. Slot spacing
    // comes exclusively from the typed row/column pitch in the
    // parameters dialog: slot[i,j] = datum + (i-1)·pitch_row·rowax
    // + (j-1)·pitch_col·colax. Corner-to-corner distance has NO
    // required relationship to pitch — teach at the pallet's
    // physical corners regardless of grid dimensions.
    positions.push({
      key: 'taught_pallet_corner1', label: '① PALLET CORNER — origin',
      role: 'pallet_c1',
      instr: "Touch the pallet's physical corner at slot [1,1] — this anchors the pallet frame origin. Geometry only; no part needs to be in the slot.",
    })
    positions.push({
      key: 'taught_pallet_corner2', label: '② PALLET CORNER — along the first row',
      role: 'pallet_c2',
      instr: "Touch the pallet's physical corner at the far end of the first row. This locks the ROW DIRECTION only — slot pitch comes from the parameters dialog.",
    })
    positions.push({
      key: 'taught_pallet_corner3', label: '③ PALLET CORNER — along the first column',
      role: 'pallet_c3',
      instr: "Touch the pallet's physical corner at the far end of the first column. This locks the COLUMN DIRECTION only — slot pitch comes from the parameters dialog.",
    })
    positions.push({
      key: 'taught_pallet_part', label: '④ FIRST PART CENTER — slot [1,1] datum',
      role: 'pallet_part',
      instr: 'Place a real part in slot [1,1] and touch the CENTER of that first place position — this datum plus your typed row/column pitch determines every other slot.',
    })
  } else if (op === 'palletize' && mode === 'depalletize') {
    positions.push({
      key: 'taught_pallet_corner1', label: '① PALLET CORNER — origin (top layer)',
      role: 'pallet_c1',
      instr: "Touch the pallet's physical corner at slot [1,1] on the top layer — anchors the pallet frame origin.",
    })
    positions.push({
      key: 'taught_pallet_corner2', label: '② PALLET CORNER — along the first row',
      role: 'pallet_c2',
      instr: "Touch the pallet's physical corner at the far end of the first row on the top layer — locks ROW DIRECTION only; pitch is typed.",
    })
    positions.push({
      key: 'taught_pallet_corner3', label: '③ PALLET CORNER — along the first column',
      role: 'pallet_c3',
      instr: "Touch the pallet's physical corner at the far end of the first column on the top layer — locks COLUMN DIRECTION only; pitch is typed.",
    })
    positions.push({
      key: 'taught_pallet_part', label: '④ FIRST PART CENTER — slot [1,1,top] datum',
      role: 'pallet_part',
      instr: 'Place a real part at slot [1,1,top] and touch the CENTER of it — this datum plus the typed pitch determines every pick pose.',
    })
    positions.push({
      key: 'taught_place', label: 'PLACE POSITION',
      instr: 'Jog the robot to the place CONTACT — the pose where the part is released against the target surface. The retreat above is computed automatically.',
    })
  } else if (op === 'machine_tend') {
    positions.push({
      key: 'taught_pick', label: 'PICK / LOAD POSITION',
      instr: 'Jog the robot to the pick CONTACT — where the gripper/vacuum touches the part. Approach and retreat are computed from your approach-height setting.',
    })
    // 2026-10-15 operator field report: the generated machine_tend
    // program references position_role 'machine_safe' (the safe-outside-
    // machine waypoint — the pose the robot retreats to between fixture
    // entries + the pose the cycle-start handshake fires from) but the
    // wizard teach sequence NEVER offered to teach it. Operators were
    // left with step 10 "Move to safe-outside-machine waypoint" flagged
    // red/Teach after wizard save, having to go back into the editor
    // to teach it manually. Added here so the wizard teach flow is
    // self-contained: every generated position_role has a teach step.
    positions.push({
      key: 'taught_machine_safe', label: 'SAFE-OUTSIDE-MACHINE WAYPOINT',
      instr: 'Jog the robot to a safe pose OUTSIDE the machine door — the pose the robot retreats to between loading the part and reaching back in for the finished one, and the pose from which the machine cycle is started. This is where the robot waits for the machine to signal "cycle complete".',
    })
    // 2026-10-15: per-fixture load positions. For 0 or 1 selected
    // fixture, keep the legacy taught_machine_load key (byte-identical
    // to the pre-directive teach + codegen path — old programs load
    // unchanged). For 2+ fixtures emit taught_machine_load_1..N,
    // naming each fixture in the label so the operator knows which
    // vice they are teaching for.
    const _selectedFixtures = resolveMachineFixtures(
      _wizardCellRegistryRef, answers)
    if (_selectedFixtures.length >= 2) {
      _selectedFixtures.forEach((fx, idx) => {
        const i = idx + 1
        const name = fx.name || `Vice ${i}`
        positions.push({
          key:   `taught_machine_load_${i}`,
          label: `MACHINE LOAD ${i} — ${name}`,
          instr: `Jog the robot to the load contact for ${name} — the pose where the part is seated in this vice. Approach and retreat are computed automatically.`,
        })
      })
    } else {
      positions.push({
        key: 'taught_machine_load', label: 'MACHINE LOAD POSITION',
        instr: 'Jog the robot to the machine-load CONTACT — where the part is seated in the fixture. Approach and retreat are computed automatically.',
      })
    }
    positions.push({
      key: 'taught_unload', label: 'UNLOAD POSITION',
      instr: 'Jog the robot to the unload CONTACT — where the finished part is released. Approach and retreat are computed automatically.',
    })
  } else if (op === 'sort') {
    positions.push({
      key: 'taught_pick', label: 'PICK POSITION',
      instr: 'Jog the robot to the pick CONTACT — where the gripper/vacuum touches the part. Approach and retreat are computed automatically.',
    })
    positions.push({
      key: 'taught_sort_1', label: 'SORT PLACE 1',
      instr: 'Jog the robot to the CONTACT for the first sort destination — where type 1 parts are released.',
    })
    positions.push({
      key: 'taught_sort_2', label: 'SORT PLACE 2',
      instr: 'Jog the robot to the CONTACT for the second sort destination — where type 2 parts are released.',
    })
  } else {
    // Default: pick_and_place and anything else with a pick + place
    // flow. 2026-10-15 operator directive: the retired place_method
    // (Fixed/Relative) step is replaced with explicit pick_count /
    // place_count. For 1 / 1 we keep the historical taught_pick +
    // taught_place keys (buildSteps emits byte-identical output; old
    // programs load unchanged). For any count ≥ 2 we switch to
    // indexed taught_pick_i / taught_place_j keys and the per-position
    // teach entries so each position gets its own jog / record step.
    const nPicks  = Math.max(1, Math.min(10, Number(answers.pick_count)  || 1))
    const nPlaces = Math.max(1, Math.min(10, Number(answers.place_count) || 1))
    if (nPicks === 1 && nPlaces === 1) {
      positions.push({
        key: 'taught_pick', label: 'PICK POSITION',
        instr: 'Jog the robot to the pick CONTACT — the pose where the gripper/vacuum touches the part. The approach hover above is computed automatically from your approach-height setting.',
      })
      positions.push({
        key: 'taught_place', label: 'PLACE POSITION',
        instr: 'Jog the robot to the place CONTACT — the pose where the part is released against the target surface. The retreat above is computed automatically.',
      })
    } else {
      for (let i = 1; i <= nPicks; i++) {
        positions.push({
          key:   `taught_pick_${i}`,
          label: `PICK ${i} POSITION`,
          instr: `Jog the robot to the pick ${i} CONTACT — the pose where the gripper/vacuum touches the part. The approach hover above is computed automatically from your approach-height setting.`,
        })
      }
      for (let j = 1; j <= nPlaces; j++) {
        positions.push({
          key:   `taught_place_${j}`,
          label: `PLACE ${j} POSITION`,
          instr: `Jog the robot to the place ${j} CONTACT — the pose where the part is released against the target surface. The retreat above is computed automatically.`,
        })
      }
    }
  }
  // Every operation's generated program ends with a move_home ("Return
  // to home" — buildSteps / buildPalletizeSteps both emit it). Append a
  // teach step keyed to the same 'taught_home' so the return appears in
  // the sequence and the reuse mechanism fires in forward navigation:
  // teaching Home at step 1 populates the key, and reaching the return
  // step shows the Reuse/Re-teach choice screen with the recorded TCP.
  // Same key = single shared value; Re-teach here overwrites both
  // references, by design (Re-teach updates "any other step in this
  // session that references the same key" — task spec).
  positions.push({
    key: 'taught_home',
    label: 'HOME (return)',
    instr: 'The robot returns to this position after completing each cycle. Reuse the home you taught earlier, or teach a different return position — re-teaching here updates the start-home as well, since both reference the same logical home.',
  })

  // 2026-10-15: interleave waypoint-offer junctions AFTER each
  // referenced main teach step. Default `kind: 'teach'` on every
  // existing entry; junction entries carry `kind: 'waypoint_junction'`
  // + the junction tuple. The junction's afterKey points at the LAST
  // occurrence of that key in the sequence BEFORE the HOME (return)
  // tail-step, so the pallet flow's `pick_to_place` junction with
  // afterKey=`taught_pick` lands right after the pick teach and
  // BEFORE the pallet-corner teach steps (correct — the pallet
  // corners define the FRAME, not a motion endpoint).
  const junctions = waypointJunctionsForOperation(answers)
  const teachEntries = positions.map((p) => ({ ...p, kind: 'teach' }))
  const result = []
  teachEntries.forEach((entry, idx) => {
    result.push(entry)
    // Only emit the junction AFTER the FIRST occurrence of its
    // afterKey (so for 'taught_home' the junction lands after the
    // START home teach, not after the HOME (return) tail — the tail
    // is the end-return step itself, no junction needed after it).
    const earlierSameKey = teachEntries.slice(0, idx).some((e) => e.key === entry.key)
    if (earlierSameKey) return
    const j = junctions.find((x) => x.afterKey === entry.key)
    if (!j) return
    result.push({
      kind: 'waypoint_junction',
      junctionId: j.id,
      fromLabel: j.fromLabel,
      toLabel:   j.toLabel,
      label: `WAYPOINT? — between ${j.fromLabel} and ${j.toLabel}`,
      instr: offerInstrFor(j),
    })
  })
  return result
}



function ProgressDots({ count, currentIdx, statuses }) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '12px 0' }}>
      {Array.from({ length: count }).map((_, i) => {
        const s = statuses[i] || 'pending'
        // 'reused' renders as a hollow blue dot to set it apart from
        // 'recorded' (solid blue) — same logical value but a different
        // user action got it there.
        const isReused = s === 'reused'
        const fill = s === 'recorded' ? '#2563EB'
                   : isReused         ? '#fff'
                   : s === 'skipped'  ? '#d1d5db'
                   : i === currentIdx ? '#bfdbfe' : '#e5e7eb'
        const border = isReused ? '2px solid #2563EB' : 'none'
        const ring = i === currentIdx ? '2px solid #2563EB' : 'none'
        return (
          <div key={i} title={`Step ${i + 1}: ${s}`}
            style={{
              width: 14, height: 14, borderRadius: '50%',
              background: fill, border, outline: ring, outlineOffset: 2,
              boxSizing: 'border-box',
            }} />
        )
      })}
    </div>
  )
}

function TeachSequence({ answers, setAnswer, onComplete, onBackToName, reusedSteps, setReusedSteps }) {
  const jogHold          = useStore((s) => s.jogHold)
  const jogHoldCartesian = useStore((s) => s.jogHoldCartesian)
  const jogRelease       = useStore((s) => s.jogRelease)
  // 2026-10-08 Bug-2 unify: pull the STEP-mode dispatchers + shared
  // jogStyle slice from the SAME store the main pendant and
  // TeachDrawer use. No fork — one implementation, three mount
  // points. Pre-fix the wizard rendered a Step chip row that was
  // visually decorative because WizardJogArrow was hard-coded to
  // CONTINUOUS and the wire function never supplied onTap.
  const jogIncrement       = useStore((s) => s.jogIncrement)
  const jogPulseCartesian  = useStore((s) => s.jogPulseCartesian)
  const jogStyleShared     = useStore((s) => s.jogStyle) || 'CONTINUOUS'
  const setJogStyleShared  = useStore((s) => s.setJogStyle)
  const homeRobot    = useStore((s) => s.homeRobot)
  const triggerEstop = useStore((s) => s.triggerEstop)

  const positions = teachPositionsForAnswers(answers)
  const [posIdx, setPosIdx]   = useState(0)
  const [flash, setFlash]     = useState(false)
  const [jogMode, setJogMode] = useState('cartesian')
  const [step, setStep]       = useState(1.0)
  // Error banner shown when a Record Position attempt can't get a usable
  // pose from the robot (fetch throws, endpoint returns non-2xx, or the
  // response has no live TCP because no arm is connected). Presence of
  // this string also triggers the inline manual-entry form so the wizard
  // is never dead-ended.
  const [recordErr, setRecordErr] = useState(null)
  const [manualOpen, setManualOpen] = useState(false)
  // TCP entry is in mm / degrees to match how operators think about
  // positions on the shop floor; convert to m / radians on save.
  const [manualTcp, setManualTcp] = useState({ x: '', y: '', z: '', rx: '', ry: '', rz: '' })
  const [speed, setSpeed]     = useState(20)
  const [liveJoints, setLiveJoints] = useState([0, -90, 0, -90, 0, 0])
  const [liveTcp,    setLiveTcp]    = useState([0, 0, 0, 0, 0, 0])

  // forceTeach[posIdx] = true means the operator clicked "Re-teach" on the
  // reuse-choice screen for this step, so we should render the jog
  // pendant even though the underlying key is already recorded. Keyed by
  // step index, not key, so two steps that share a key (back-nav, future
  // duplicate entries) can have independent decisions.
  const [forceTeach, setForceTeach] = useState({})

  // 2026-10-15 waypoint-offer flow: teachingWaypoint[posIdx] = true
  // when the operator picked "Add waypoint" / "Add another" on a
  // waypoint_junction step and the jog UI should be rendered. On
  // record, the waypoint pose is pushed into answers.waypoints[
  // junctionId] and the UI flips back to the "add another? / continue"
  // screen without advancing (so the operator can chain more via-
  // points at the same junction). The "No, continue" / "Continue"
  // buttons advance to the next sequence step.
  const [teachingWaypoint, setTeachingWaypoint] = useState({})

  const clearReusedAt = (idx) => {
    if (!setReusedSteps) return
    setReusedSteps((prev) => {
      if (!prev || !prev[idx]) return prev
      const next = { ...prev }
      delete next[idx]
      return next
    })
  }

  const stepRef  = useRef(step)
  const speedRef = useRef(speed)
  const modeRef  = useRef(jogMode)
  useEffect(() => { stepRef.current = step },     [step])
  useEffect(() => { speedRef.current = speed },   [speed])
  useEffect(() => { modeRef.current = jogMode },  [jogMode])

  // Live state for the small joint / TCP readout in the panel header.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/state')
        if (!alive || !res.ok) return
        const d = await res.json()
        setLiveJoints(radiansToJointDegrees(d?.joints?.positions))
        if (Array.isArray(d?.tcp_pose)) setLiveTcp(d.tcp_pose)
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 300)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  // 2026-10-08 Bug-1 scope-leak fix (operator field report 2026-10-07):
  // the prior global-home seed (fetched /api/robot/home on mount and
  // populated answers.taught_home with source='global') caused a NEW
  // program to show "This position is already taught — Reuse/Re-teach"
  // on the HOME POSITION step before the operator had taught anything.
  // Reuse was triggered by cell/global data instead of only by prior
  // saves of THIS program — the trigger was too loose. The reuse
  // feature still fires intra-session (teaching HOME POSITION at step
  // 1 populates taught_home and the HOME (return) step reuses it) and
  // for existing programs re-opened for edit (saved taught_home flows
  // in through answers). It no longer fires spontaneously on a fresh
  // program.

  // Migrated 2026-07-22 from the discrete HTTP-pulse `s.jog` /
  // `s.jogCartesian` pattern (see TeachWithJog above for the full
  // rationale). Same HoldButton-driven WS transport TeachOverlay uses.
  const holdStart = useCallback((axis, direction, meta) => {
    if (modeRef.current === 'joint') {
      return jogHold(axis, direction, speedRef.current, meta)
    }
    return jogHoldCartesian(axis, direction, speedRef.current, meta)
  }, [jogHold, jogHoldCartesian])
  const holdEnd = useCallback((meta) => jogRelease(modeRef.current, meta),
    [jogRelease])
  // 2026-10-08 Bug-2 unify: STEP-mode tap — one increment per press.
  // Byte-for-byte the same dispatch main JogControls.tap() + the
  // TeachDrawer tap() use. Joint uses the driver's time-boxed
  // delta_deg path; Cartesian passes stepRef.current (mm) so the
  // driver derives duration from the labelled distance (2026-10-06
  // cart-step correctness fix).
  const tap = useCallback((axis, direction) => {
    if (modeRef.current === 'joint') {
      const deltaDeg = direction * stepRef.current
      jogIncrement(axis, deltaDeg)
    } else {
      jogPulseCartesian(axis, direction, speedRef.current, stepRef.current)
    }
  }, [jogIncrement, jogPulseCartesian])
  const wire = useCallback((axis, direction) => ({
    jogStyle:     jogStyleShared,
    onTap:        () => tap(axis, direction),
    onPressStart: (meta) => holdStart(axis, direction, meta),
    onPressTick:  (meta) => holdStart(axis, direction, meta),
    onPressEnd:   (meta) => holdEnd(meta),
  }), [holdStart, holdEnd, tap, jogStyleShared])

  // Compute per-position status (recorded / reused / skipped / pending)
  // for the progress dots and Review page card. A step marked 'reused'
  // for this session beats the underlying answer's 'recorded' state so
  // the operator can see at a glance which steps they revisited. For
  // waypoint-junction entries (no `key`), status is 'recorded' when
  // the operator has taught at least one via-point for this junction,
  // else 'pending' — "No, continue" dismissals don't flip to skipped
  // (an empty junction is the default outcome, not a skip).
  const statusOf = (i) => {
    const p = positions[i]
    if (p.kind === 'waypoint_junction') {
      const wps = readWaypointsForJunction(answers, p.junctionId)
      return wps.length > 0 ? 'recorded' : 'pending'
    }
    if (reusedSteps?.[i]) return 'reused'
    const v = answers[p.key]
    if (!v) return 'pending'
    if (v.skipped) return 'skipped'
    if (v.tcp || v.joints) return 'recorded'
    return 'pending'
  }
  const statuses = positions.map((_, i) => statusOf(i))

  const current = positions[posIdx]
  const isWaypointJunction = !!(current && current.kind === 'waypoint_junction')
  const currentJunctionId = isWaypointJunction ? current.junctionId : null
  const currentJunctionWps = isWaypointJunction
    ? readWaypointsForJunction(answers, currentJunctionId)
    : []
  const isTeachingWaypoint = isWaypointJunction && !!teachingWaypoint[posIdx]

  // 2026-10-15 operator directive: the reuse prompt fires ONLY on the
  // end/return step (the HOME-return at the tail of the sequence, which
  // reuses the same key as an earlier step — always 'taught_home'). On
  // every other step — including edit-mode re-opens where answers carry
  // saved poses — recording and navigation are plain: no "already taught"
  // choice screen. Scope: posIdx === last AND an earlier position shares
  // this key (the end-return is defined as that key-duplicate). Waypoint
  // junctions never have `.key`, so they can't trigger showChoiceScreen.
  const existingForCurrent = (current && !isWaypointJunction) ? answers[current.key] : null
  const alreadyRecordedHere = !!(existingForCurrent &&
    !existingForCurrent.skipped &&
    (Array.isArray(existingForCurrent.tcp) || Array.isArray(existingForCurrent.joints)))
  const isEndReturnStep = !!(current && !isWaypointJunction
    && posIdx === positions.length - 1
    && positions.slice(0, posIdx).some((p) => p.key === current.key))
  const showChoiceScreen = alreadyRecordedHere && !forceTeach[posIdx] && isEndReturnStep

  // Waypoint-junction UI mode: the offer / add-another prompt is a
  // full-screen scaffold (same shell shape as showChoiceScreen). When
  // the operator picks "Add waypoint" / "Add another", teachingWaypoint
  // flips on and the usual jog UI renders — same jog pads, same Record
  // button, same manual-entry fallback. No fork: Record branches on
  // isWaypointJunction inside recordPosition / saveManualPose.
  const showWaypointOffer = isWaypointJunction && !isTeachingWaypoint

  // When teaching a waypoint, override the header title + instr so the
  // operator sees "WAYPOINT #N — between X and Y" (and the ordinal
  // reflects the pose they're about to add) rather than the junction's
  // offer-shaped label. Same single `current` object drives the shell
  // elsewhere — this is a display-only override.
  const nextWaypointOrdinal = currentJunctionWps.length + 1
  const headerLabel = (isWaypointJunction && isTeachingWaypoint && current)
    ? `WAYPOINT #${nextWaypointOrdinal} — between ${current.fromLabel} and ${current.toLabel}`
    : (current ? current.label : '')
  const headerInstr = (isWaypointJunction && isTeachingWaypoint && current)
    ? `Jog the robot to the via-point and press Record. The arm will pass THROUGH this pose on the way between ${current.fromLabel} and ${current.toLabel}. Manual routing: you teach the via-point; the arm does not auto-detect obstacles.`
    : (current ? current.instr : '')
  // Success-banner copy: for junction steps, name the waypoint by its
  // endpoints ("Successfully taught waypoint between Home and Pick"); for
  // plain teach steps, defer to teachLabelToName (unchanged from the
  // 2026-10-15 record-confirmation ship).
  const successName = (isWaypointJunction && current)
    ? `waypoint between ${current.fromLabel} and ${current.toLabel}`
    : teachLabelToName(current ? current.label : '')

  const advanceOrComplete = useCallback(() => {
    if (posIdx >= positions.length - 1) {
      onComplete()
    } else {
      setPosIdx(posIdx + 1)
    }
  }, [posIdx, positions.length, onComplete])

  // Record Position never dead-ends. Fallback chain:
  //   1. /api/state has a real TCP (live arm) → record live tcp+joints.
  //   2. /api/state responds but tcp is missing/zeros (no arm) → record
  //      joints from the payload and mark source='simulated'; tcp stays
  //      null so downstream code can tell it's joint-only.
  //   3. Fetch throws or returns non-2xx → use the last-polled liveJoints
  //      from the header readout (already populated by the poll loop).
  // Any of these paths writes into wizard state and advances. A "source"
  // note surfaces briefly so the operator knows a fallback was used.
  const [lastSource, setLastSource] = useState(null)

  // Append a taught waypoint pose to answers.waypoints[junctionId].
  // Flashes success then flips teachingWaypoint OFF for this step so
  // the "add another? / continue" screen re-renders — the operator
  // chains more via-points at this junction, or hits Continue to
  // advance. Shared between recordPosition and saveManualPose below.
  function appendWaypointPose({ tcp, joints, source }) {
    const existing = (answers.waypoints && Array.isArray(answers.waypoints[currentJunctionId]))
      ? answers.waypoints[currentJunctionId]
      : []
    const next = [...existing, {
      tcp, joints,
      taught_at: new Date().toISOString(),
      skipped: false,
      source,
    }]
    const nextMap = { ...(answers.waypoints || {}), [currentJunctionId]: next }
    setAnswer('waypoints', nextMap)
    setLastSource(source)
    setFlash(true)
    setTimeout(() => {
      setFlash(false)
      setTeachingWaypoint((p) => ({ ...p, [posIdx]: false }))
    }, 900)
  }

  async function recordPosition() {
    setRecordErr(null)
    let joints = null
    let tcp = null
    let source = 'live'
    try {
      const res = await fetch('/api/state')
      if (res.ok) {
        const d = await res.json()
        joints = radiansToJointDegrees(d?.joints?.positions)
        const tcpArr = Array.isArray(d?.tcp_pose) ? d.tcp_pose : null
        const tcpAllZeros = tcpArr && tcpArr.length >= 3 &&
          tcpArr.slice(0, 3).every((v) => Math.abs(Number(v) || 0) < 1e-6)
        const armConnected = !!(d?.robot?.connected)
        if (tcpArr && !tcpAllZeros && armConnected) {
          tcp = tcpArr
          source = 'live'
        } else {
          // Endpoint responded but there's no live TCP — use the joint
          // pose we did get (realistic sim defaults or last-known), tcp
          // stays null.
          tcp = null
          source = 'simulated'
        }
      } else {
        joints = liveJoints
        tcp = null
        source = 'simulated'
      }
    } catch {
      joints = liveJoints
      tcp = null
      source = 'simulated'
    }
    if (isWaypointJunction) {
      appendWaypointPose({ tcp, joints, source })
      return
    }
    setAnswer(current.key, {
      tcp, joints,
      taught_at: new Date().toISOString(),
      skipped: false,
      source,
    })
    setLastSource(source)
    clearReusedAt(posIdx)
    setFlash(true)
    setTimeout(() => { setFlash(false); advanceOrComplete() }, 900)
  }

  // Pre-fill the manual-entry form with the current live TCP so the
  // operator can tweak instead of typing 6 fields from scratch. TCP is
  // stored in meters / radians on the state; the form is mm / degrees.
  function openManualEntry() {
    const R2D = 180 / Math.PI
    const t = Array.isArray(liveTcp) ? liveTcp : [0, 0, 0, 0, 0, 0]
    setManualTcp({
      // 2026-10-13 inches directive: operator types x/y/z in INCHES
      // and we convert to meters (storage units) on save. R2D stays
      // the same — rotation unit (deg) is unaffected.
      x:  (((Number(t[0]) || 0) * 1000) / 25.4).toFixed(2),
      y:  (((Number(t[1]) || 0) * 1000) / 25.4).toFixed(2),
      z:  (((Number(t[2]) || 0) * 1000) / 25.4).toFixed(2),
      rx: ((Number(t[3]) || 0) * R2D).toFixed(1),
      ry: ((Number(t[4]) || 0) * R2D).toFixed(1),
      rz: ((Number(t[5]) || 0) * R2D).toFixed(1),
    })
    setRecordErr(null)
    setManualOpen(true)
  }

  function saveManualPose() {
    const parse = (s) => {
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    const x = parse(manualTcp.x), y = parse(manualTcp.y), z = parse(manualTcp.z)
    const rx = parse(manualTcp.rx), ry = parse(manualTcp.ry), rz = parse(manualTcp.rz)
    if ([x, y, z, rx, ry, rz].some((v) => v === null)) {
      setRecordErr('All six fields are required. Use numeric values (″ for x/y/z, degrees for rx/ry/rz).')
      return
    }
    const D2R = Math.PI / 180
    // Store TCP in the same units /api/state uses: meters + radians.
    // Operator-entered x/y/z are in INCHES → inches × 25.4 / 1000 = meters.
    const inToMeters = (inches) => (inches * 25.4) / 1000
    const tcp = [inToMeters(x), inToMeters(y), inToMeters(z), rx * D2R, ry * D2R, rz * D2R]
    const joints = (Array.isArray(liveJoints) ? liveJoints.slice(0, 6) : [0, 0, 0, 0, 0, 0])
    if (isWaypointJunction) {
      appendWaypointPose({ tcp, joints, source: 'manual' })
      setManualOpen(false)
      setRecordErr(null)
      return
    }
    setAnswer(current.key, {
      tcp,
      joints,
      taught_at: new Date().toISOString(),
      skipped: false,
      source: 'manual',
    })
    setLastSource('manual')
    clearReusedAt(posIdx)
    setManualOpen(false)
    setRecordErr(null)
    setFlash(true)
    setTimeout(() => { setFlash(false); advanceOrComplete() }, 900)
  }

  // When the operator moves to a new step, drop any stale error banner or
  // half-filled manual-entry form from the previous step.
  useEffect(() => {
    setRecordErr(null)
    setManualOpen(false)
    setLastSource(null)
    setManualTcp({ x: '', y: '', z: '', rx: '', ry: '', rz: '' })
  }, [posIdx])

  function skipCurrent() {
    // Waypoint-junction steps are optional by construction — "Skip →"
    // on a junction is the same as "No, continue": just advance.
    if (isWaypointJunction) {
      advanceOrComplete()
      return
    }
    // Don't clobber an earlier-taught value that shares this key. The
    // pallet + pick_and_place flows re-use `taught_home` for the return-
    // home step at the tail of the sequence; if the operator taught
    // home at step 1 and hits Skip on the return-home step, we must
    // NOT overwrite the taught pose with {skipped:true} — otherwise
    // the review page's Positions Taught list flips `taught_home` to
    // "required — skipped" and the operator sees a false "home
    // untaught" verdict after they clearly taught it. Same guard
    // skipAllRemaining() already uses.
    const existing = answers[current.key]
    const alreadyRecorded = !!(existing && !existing.skipped
      && (Array.isArray(existing.tcp) || Array.isArray(existing.joints)))
    if (!alreadyRecorded) {
      setAnswer(current.key, {
        tcp: null, joints: null,
        taught_at: new Date().toISOString(),
        skipped: true,
      })
    }
    clearReusedAt(posIdx)
    advanceOrComplete()
  }

  function skipAllRemaining() {
    const stamp = new Date().toISOString()
    positions.slice(posIdx).forEach((p) => {
      // Waypoint-junction steps are optional; "Skip All" leaves their
      // storage untouched (no waypoints is already the empty default).
      if (p.kind === 'waypoint_junction') return
      const existing = answers[p.key]
      // Don't clobber an already-recorded position.
      if (existing && !existing.skipped && (existing.tcp || existing.joints)) return
      setAnswer(p.key, { tcp: null, joints: null, taught_at: stamp, skipped: true })
    })
    onComplete()
  }

  // Reuse the existing taught value as-is. Don't touch the answer; just
  // mark this step as 'reused' for the progress dot + Review summary and
  // advance. No jog/record needed.
  function reuseCurrent() {
    if (setReusedSteps) {
      setReusedSteps((prev) => ({ ...(prev || {}), [posIdx]: true }))
    }
    advanceOrComplete()
  }

  // Operator wants to teach this position fresh. Pivot the body to the
  // jog pendant by setting forceTeach for this step; clear any prior
  // reused flag (it would be overwritten by recordPosition anyway, but
  // also keeps the progress dot honest while they're jogging).
  function reteachCurrent() {
    setForceTeach((p) => ({ ...p, [posIdx]: true }))
    clearReusedAt(posIdx)
  }

  function goBack() {
    if (posIdx === 0) onBackToName()
    else setPosIdx(posIdx - 1)
  }

  // Jog-pad button size is computed from the live size of the jog-pad
  // container so the buttons fill the available area without overflowing.
  // The fullscreen overlay flexes header / title / control / dots / footer
  // as fixed bands and gives the jog-pad container `flex: 1` for the rest;
  // ResizeObserver below measures that container and picks the largest
  // square button size that lets the full layout fit at once. No scroll.
  const jogPadRef = useRef(null)
  const [padBtn, setPadBtn] = useState(120)
  const padGap = 12

  useEffect(() => {
    if (showChoiceScreen) return  // pad not rendered in choice mode
    if (showWaypointOffer) return // pad not rendered in waypoint-offer mode
    const el = jogPadRef.current
    if (!el) return
    const recalc = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      const containerPad = 32 // matches padding: 16 top + 16 bottom/sides
      const blockGap = 28     // gap between position/height/rotation blocks
      const availW = Math.max(0, w - containerPad)
      const availH = Math.max(0, h - containerPad)
      let size
      if (jogMode === 'cartesian') {
        // Cartesian: 7 button-widths across (position 3 + height 1 +
        // rotation 3), with 4 intra-block gaps + 2 block gaps.
        const byW = (availW - 4 * padGap - 2 * blockGap) / 7
        // 3 button-heights tall (position / rotation blocks dominate),
        // with 2 inter-row gaps.
        const byH = (availH - 2 * padGap) / 3
        size = Math.min(byW, byH)
      } else {
        // Joint: 6 column blocks; each column is 2 stacked buttons plus a
        // small label above. 5 inter-column gaps.
        const colGap = 20
        const labelBand = 28
        const byW = (availW - 5 * colGap) / 6
        const byH = (availH - labelBand - padGap) / 2
        size = Math.min(byW, byH)
      }
      // 60px floor keeps buttons tappable at small viewports; 220px cap
      // keeps them from looking comically big on ultra-wide displays.
      size = Math.max(60, Math.min(size, 220))
      setPadBtn(Math.floor(size))
    }
    recalc()
    const ro = new ResizeObserver(recalc)
    ro.observe(el)
    return () => ro.disconnect()
  }, [jogMode, showChoiceScreen, showWaypointOffer])

  const modeBtn = (on) => ({
    padding: '12px 20px', minHeight: 48, fontSize: 14, fontWeight: 700,
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? '2px solid #2563EB' : '2px solid #d1d5db',
    borderRadius: 8, cursor: 'pointer',
  })

  return (
    // True fullscreen container — no centered modal, no backdrop margins,
    // no rounded corners. The overlay IS the screen. Vertical flex column
    // with overflow: hidden so the layout exactly fills the viewport and
    // nothing scrolls. The jog pad area absorbs all remaining vertical
    // space. `inset: 0` sizes to the ACTUAL visible viewport (not the
    // large-viewport 100vh, which on mobile Safari includes the address
    // bar and pushes the footer bottom off-screen). Removed the redundant
    // `width: 100vw, height: 100vh` for that reason.
    <div style={{
      position: 'fixed', inset: 0,
      margin: 0, padding: 0, borderRadius: 0,
      zIndex: 2000,
      background: '#fff',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* HEADER (~56px) */}
      <div style={{
        flex: '0 0 auto', height: 56, minHeight: 56,
        padding: '0 24px',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex', alignItems: 'center', gap: 12,
        boxSizing: 'border-box',
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: '#6b7280',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          Teaching Positions
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
          Step {posIdx + 1} of {positions.length}
        </div>
        <button onClick={skipAllRemaining}
          title="Skip all remaining positions and go to Review"
          style={{
            padding: '8px 14px', fontSize: 12, fontWeight: 600,
            background: 'transparent', color: '#DC2626',
            border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer',
          }}>
          × Skip All
        </button>
      </div>

      {/* TITLE + INSTRUCTION + READOUT (~80px) — flex:0 0 auto so it never
          steals space from the jog pad. Instruction is clamped to 2 lines
          via -webkit-line-clamp to keep the band height bounded. */}
      <div style={{
        flex: '0 0 auto',
        padding: '10px 24px',
        borderBottom: '1px solid #f3f4f6',
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'nowrap', minWidth: 0 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: '#2563EB', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 800, flexShrink: 0,
          }}>{posIdx + 1}</div>
          <div style={{
            fontSize: 19, fontWeight: 800, color: '#111', lineHeight: 1.2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>
            {headerLabel}
          </div>
          <div style={{ flex: 1 }} />
          {/* 2026-10-13 operator directive: live Joints/TCP numeric
              readout retired from every teach surface. liveJoints +
              liveTcp state remain populated by the 300ms poll as the
              Record Position fallback (recordPosition reads /api/state
              fresh; on non-ok / exception it falls back to the
              last-polled liveJoints). Capture path untouched. */}
        </div>
        <div style={{
          fontSize: 13, color: '#6b7280', lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {headerInstr}
        </div>
        {current.role && (current.role === 'pallet_c1'
                          || current.role === 'pallet_c2'
                          || current.role === 'pallet_c3'
                          || current.role === 'pallet_part') && (
          <PalletFrameDiagram
            role={current.role}
            rows={answers.pallet_rows || 4}
            cols={answers.pallet_cols || 4}
            fillOrder={answers.pallet_fill_order || 'row_lr'}
          />
        )}
      </div>

      {recordErr && (
        <div style={{
          flex: '0 0 auto',
          margin: '10px 24px 0',
          padding: '10px 14px',
          background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 8, color: '#991b1b',
          fontSize: 13, lineHeight: 1.4,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1 }}>{recordErr}</div>
          <button onClick={openManualEntry} style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 700,
            background: '#fff', color: '#991b1b',
            border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer',
          }}>Enter manually</button>
          <button onClick={() => setRecordErr(null)} title="Dismiss" style={{
            padding: '6px 10px', fontSize: 12, fontWeight: 700,
            background: 'transparent', color: '#991b1b',
            border: 'none', cursor: 'pointer',
          }}>×</button>
        </div>
      )}

      {lastSource && lastSource !== 'live' && !recordErr && (
        <div style={{
          flex: '0 0 auto',
          margin: '10px 24px 0',
          padding: '8px 12px',
          background: '#fffbeb', border: '1px solid #fde68a',
          borderRadius: 8, color: '#92400e',
          fontSize: 12, lineHeight: 1.4,
        }}>
          {lastSource === 'simulated'
            ? 'Recorded from simulated pose — no arm is connected. Use "Enter manually" to override.'
            : 'Recorded from manually-entered pose.'}
        </div>
      )}

      {manualOpen && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', zIndex: 2100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }}>
          <div style={{
            background: '#fff', borderRadius: 12,
            padding: 24, maxWidth: 520, width: '100%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#111', marginBottom: 6 }}>
              Enter TCP pose manually
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Position in inches, rotation in degrees. Saved as the taught pose for {headerLabel}.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
              {['x', 'y', 'z'].map((k) => (
                <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#374151', fontWeight: 600 }}>
                  {k.toUpperCase()} (″)
                  <input type="number" value={manualTcp[k]}
                    onChange={(e) => setManualTcp({ ...manualTcp, [k]: e.target.value })}
                    style={{ padding: '10px 12px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'monospace' }} />
                </label>
              ))}
              {['rx', 'ry', 'rz'].map((k) => (
                <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#374151', fontWeight: 600 }}>
                  {k.toUpperCase()} (°)
                  <input type="number" value={manualTcp[k]}
                    onChange={(e) => setManualTcp({ ...manualTcp, [k]: e.target.value })}
                    style={{ padding: '10px 12px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'monospace' }} />
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setManualOpen(false); setRecordErr(null) }} style={{
                padding: '10px 18px', fontSize: 14, fontWeight: 700,
                background: '#fff', color: '#374151',
                border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={saveManualPose} style={{
                padding: '10px 22px', fontSize: 14, fontWeight: 800,
                background: '#2563EB', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer',
              }}>Save Position</button>
            </div>
          </div>
        </div>
      )}

      {showChoiceScreen ? (
        /* CHOICE SCREEN — fills the middle (flex:1), centered. Same shell
           as the teach mode (header above, footer below) so the operator
           gets consistent navigation. No scroll. */
        <div style={{
          flex: '1 1 auto', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: 32, overflow: 'hidden',
          background: '#fafafa',
        }}>
          <div style={{ maxWidth: 720, width: '100%' }}>
            <div style={{
              padding: 22, marginBottom: 22,
              background: '#f0fdf4', border: '1px solid #bbf7d0',
              borderRadius: 12,
            }}>
              {/* 2026-10-15 operator directive: no coord/TCP/joint dump
                  on the reuse screen (fires only on the end-return step).
                  Plain "already taught" headline + Reuse/Re-teach choice. */}
              <div style={{ fontSize: 16, fontWeight: 700, color: '#16A34A', marginBottom: 6 }}>
                ✓ The home position is already taught
              </div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                {(() => {
                  const at = existingForCurrent?.taught_at
                  let when = null
                  if (at) {
                    try { when = new Date(at).toLocaleString() } catch { when = at }
                  }
                  return when
                    ? `Taught earlier in this setup on ${when}.`
                    : 'Taught earlier in this setup.'
                })()}
              </div>
            </div>
            <div style={{ fontSize: 16, color: '#374151', marginBottom: 18, textAlign: 'center' }}>
              Do you want to reuse it or teach it again?
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              <button onClick={reuseCurrent} style={{
                flex: 1, minHeight: 64,
                padding: '16px 22px', fontSize: 17, fontWeight: 800,
                background: '#2563EB', color: '#fff',
                border: 'none', borderRadius: 12, cursor: 'pointer',
              }}>
                ✓ Reuse This Position
              </button>
              <button onClick={reteachCurrent} style={{
                flex: 1, minHeight: 64,
                padding: '16px 22px', fontSize: 17, fontWeight: 700,
                background: '#fff', color: '#374151',
                border: '1px solid #d1d5db', borderRadius: 12, cursor: 'pointer',
              }}>
                ↻ Re-teach
              </button>
            </div>
          </div>
        </div>
      ) : showWaypointOffer ? (
        /* 2026-10-15 WAYPOINT-OFFER SCREEN — same shell shape as the
           reuse screen above (header/footer around, middle flex fills,
           no scroll). Default button is "No, continue" (first-focused +
           primary styled) so a straight pick-place flow is one tap per
           junction. Multiple waypoints chain: after Record, the UI
           re-enters this screen in "add another?" form.                   */
        <div
          data-testid="waypoint-junction-offer"
          data-junction-id={currentJunctionId}
          data-waypoints-count={currentJunctionWps.length}
          style={{
            flex: '1 1 auto', minHeight: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: 32, overflow: 'hidden',
            background: '#fafafa',
          }}>
          <div style={{ maxWidth: 720, width: '100%' }}>
            <div style={{
              padding: 22, marginBottom: 18,
              background: '#f0fdfa', border: '1px solid #99f6e4',
              borderRadius: 12,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#0d9488', marginBottom: 8 }}>
                {currentJunctionWps.length === 0
                  ? `Add a waypoint between ${current.fromLabel} and ${current.toLabel}?`
                  : `${currentJunctionWps.length} waypoint${currentJunctionWps.length === 1 ? '' : 's'} taught between ${current.fromLabel} and ${current.toLabel} — add another?`}
              </div>
              <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
                A waypoint is a point the robot passes through — use it to
                steer the path around a fixture or obstacle between {current.fromLabel} and {current.toLabel}.
                Manual routing: you teach the via-point; the arm does not
                auto-detect obstacles.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              {/* Default (primary) = "No, continue" / "Continue" — a
                  straight path doesn't need waypoints and the operator
                  should not be forced to click through a secondary CTA.
                  The 2026-10-15 directive is explicit about this. */}
              <button
                data-testid="waypoint-junction-continue"
                onClick={advanceOrComplete}
                autoFocus
                style={{
                  flex: 1, minHeight: 64,
                  padding: '16px 22px', fontSize: 17, fontWeight: 800,
                  background: '#2563EB', color: '#fff',
                  border: 'none', borderRadius: 12, cursor: 'pointer',
                }}>
                {currentJunctionWps.length === 0 ? 'No, continue →' : 'Continue →'}
              </button>
              <button
                data-testid="waypoint-junction-add"
                onClick={() => setTeachingWaypoint((p) => ({ ...p, [posIdx]: true }))}
                style={{
                  flex: 1, minHeight: 64,
                  padding: '16px 22px', fontSize: 17, fontWeight: 700,
                  background: '#fff', color: '#0d9488',
                  border: '1px solid #99f6e4', borderRadius: 12, cursor: 'pointer',
                }}>
                {currentJunctionWps.length === 0 ? '+ Add waypoint' : '+ Add another waypoint'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* CONTROL BAR (~56px) — single row, no wrap. The speed slider
              flexes to absorb leftover width. All touch targets ≥ 44px. */}
          <div style={{
            flex: '0 0 auto', minHeight: 56,
            padding: '8px 16px',
            borderBottom: '1px solid #f3f4f6',
            display: 'flex', alignItems: 'center', gap: 8,
            boxSizing: 'border-box',
          }}>
            <button onClick={() => setJogMode('cartesian')} style={modeBtn(jogMode === 'cartesian')}>XYZ</button>
            <button onClick={() => setJogMode('joint')}     style={modeBtn(jogMode === 'joint')}>Joint</button>
            {/* 2026-10-08 Bug-2 unify: Step/Continuous toggle rides the
                SHARED setJogStyle setter — flipping here propagates to
                the main pendant and the TeachDrawer and vice-versa. */}
            <div
              data-testid="wizard-teach-jog-style-toggle"
              data-jog-style={jogStyleShared}
              style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 8 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Mode:</span>
              {['STEP', 'CONTINUOUS'].map((style) => (
                <button
                  key={style}
                  data-testid="wizard-teach-jog-style-button"
                  data-jog-style={style}
                  data-active={String(jogStyleShared === style)}
                  onClick={() => setJogStyleShared(style)}
                  style={{
                    padding: '10px 12px', minHeight: 44,
                    fontSize: 13, fontWeight: 600, borderRadius: 6,
                    cursor: 'pointer',
                    background: jogStyleShared === style ? '#2563EB' : '#fff',
                    color:      jogStyleShared === style ? '#fff'    : '#374151',
                    border:     jogStyleShared === style ? 'none'    : '1px solid #d1d5db',
                  }}>
                  {style === 'STEP' ? 'Step' : 'Continuous'}
                </button>
              ))}
            </div>
            <span style={{
              fontSize: 12, color: '#6b7280', marginLeft: 8,
              opacity: jogStyleShared === 'STEP' ? 1 : 0.4,
            }}>Step:</span>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s}
                onClick={() => { if (jogStyleShared === 'STEP') setStep(s) }}
                disabled={jogStyleShared !== 'STEP'}
                style={{
                  padding: '10px 12px', fontSize: 13, fontWeight: 600, borderRadius: 6,
                  cursor: jogStyleShared === 'STEP' ? 'pointer' : 'not-allowed',
                  minHeight: 44, minWidth: 48,
                  opacity: jogStyleShared === 'STEP' ? 1 : 0.4,
                  background: step === s ? '#2563EB' : '#f3f4f6',
                  color:      step === s ? '#fff'    : '#374151',
                  border:     step === s ? 'none'    : '1px solid #e5e7eb',
                }}>{jogMode === 'joint' ? `${s}°` : formatInLabel(s, { digits: s < 1 ? 3 : 2 })}</button>
            ))}
            <div style={{ flex: 1, minWidth: 120, display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
              <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>Speed {speed}%</span>
              <input type="range" min={1} max={100} value={speed}
                onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
                style={{ flex: 1, minWidth: 0 }} />
            </div>
            <button onClick={homeRobot} style={{
              padding: '10px 16px', fontSize: 13, fontWeight: 600,
              background: '#f3f4f6', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
              minHeight: 44,
            }}>Home</button>
            {/* STOP moved into the sticky footer bar so it stays visible
                on tablet-portrait even when this toolbar wraps or the
                jog area consumes all vertical space. See the FOOTER
                block below. */}
          </div>

          {/* JOG PAD — flex:1, scales to fit. Buttons sized via the
              ResizeObserver effect above so the full layout always fits
              the viewport without scrolling. */}
          <div ref={jogPadRef} style={{
            flex: '1 1 auto', minHeight: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, overflow: 'hidden',
            background: '#fafafa',
          }}>
            {jogMode === 'cartesian' ? (
              <div style={{ display: 'flex', gap: 28, alignItems: 'center', justifyContent: 'center' }}>
                <div>
                  <div style={padLabelStyle}>Position</div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                    gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                    gridTemplateAreas: '". up ." "left center right" ". down ."',
                    gap: padGap,
                  }}>
                    <div style={{ gridArea: 'up' }}>    <WizardJogArrow {...wire('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} /></div>
                    <div style={{ gridArea: 'left' }}>  <WizardJogArrow {...wire('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} /></div>
                    <div style={{ gridArea: 'center' }}><PadCenterTile label="XY" width={padBtn} height={padBtn} /></div>
                    <div style={{ gridArea: 'right' }}> <WizardJogArrow {...wire('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} /></div>
                    <div style={{ gridArea: 'down' }}>  <WizardJogArrow {...wire('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} /></div>
                  </div>
                </div>
                <div>
                  <div style={padLabelStyle}>Height</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: padGap, width: padBtn }}>
                    <WizardJogArrow {...wire('z',  1)} rotation={0}   label="Z+" color="#3B82F6" size={padBtn} />
                    <WizardJogArrow {...wire('z', -1)} rotation={180} label="Z−" color="#3B82F6" size={padBtn} />
                  </div>
                </div>
                <div>
                  <div style={padLabelStyle}>Rotation</div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                    gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                    gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
                    gap: padGap,
                  }}>
                    <div style={{ gridArea: 'rxp' }}>   <WizardJogArrow {...wire('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} /></div>
                    <div style={{ gridArea: 'rzn' }}>   <WizardJogArrow {...wire('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} /></div>
                    <div style={{ gridArea: 'center' }}><PadCenterTile label="Rot" width={padBtn} height={padBtn} /></div>
                    <div style={{ gridArea: 'rzp' }}>   <WizardJogArrow {...wire('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} /></div>
                    <div style={{ gridArea: 'rxn' }}>   <WizardJogArrow {...wire('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} /></div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 20, justifyContent: 'center' }}>
                {[1, 2, 3, 4, 5, 6].map((j) => (
                  <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: padGap }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>{'J' + j}</div>
                    <WizardJogArrow {...wire(j,  1)} rotation={0}   label={'+J' + j} color="#16A34A" size={padBtn} />
                    <WizardJogArrow {...wire(j, -1)} rotation={180} label={'−J' + j} color="#DC2626" size={padBtn} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* PROGRESS DOTS (~28px) — slim band above the footer so the operator
          sees where they are without stealing space from the jog pad. */}
      <div style={{
        flex: '0 0 auto', padding: '4px 0',
        borderTop: '1px solid #f3f4f6', background: '#fff',
      }}>
        <ProgressDots count={positions.length} currentIdx={posIdx} statuses={statuses} />
      </div>

      {/* 2026-10-15 operator directive: plain success banner after record,
          naming THIS position. No TCP / joint / coord dump — just the
          name. Visible for the ~900 ms flash window, then advanceOrComplete
          moves to the next step. Shared between live-capture (recordPosition)
          and manual-entry (saveManualPose) paths via the single `flash`
          state. */}
      {flash && current && (
        <div
          data-testid="teach-success-banner"
          data-position-name={successName}
          style={{
            flex: '0 0 auto',
            margin: '0 16px 8px',
            padding: '12px 16px',
            background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 10, color: '#15803d',
            fontSize: 15, fontWeight: 700,
            textAlign: 'center',
          }}>
          ✓ Successfully taught {successName}
        </div>
      )}

      {/* STICKY FOOTER — tablet-first: STOP + Back + Record + Skip share
          one row that stays reserved outside the scrollable content.
          padding-bottom includes env(safe-area-inset-bottom) so the row
          clears the iOS home indicator / Android nav bar. `Enter
          manually` moved down a tier — it's less critical than STOP and
          the sticky row on 800 px portrait doesn't have space for a
          fifth button. */}
      <div style={{
        flex: '0 0 auto', minHeight: 88,
        padding: '14px 16px',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 14px)',
        borderTop: '1px solid #e5e7eb',
        display: 'flex', gap: 10, alignItems: 'center',
        boxSizing: 'border-box',
        flexWrap: 'wrap',
      }}>
        <button onClick={triggerEstop} style={{
          padding: '0 18px', minHeight: 56, minWidth: 96,
          fontSize: 15, fontWeight: 800,
          background: '#DC2626', color: '#fff',
          border: 'none', borderRadius: 10, cursor: 'pointer',
          flexShrink: 0,
          boxShadow: '0 0 0 2px rgba(220,38,38,0.15)',
        }}>⏹ STOP</button>
        {/* 2026-10-13 operator directive: shared Enable control on the
            fullscreen teach pendant too — same import-identity component
            as the main-pendant surface; state syncs via the shared store. */}
        <ArmEnableControl />
        <button onClick={goBack} style={{
          padding: '0 18px', minHeight: 56, fontSize: 14, fontWeight: 700,
          background: '#fff', color: '#374151',
          border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
          flexShrink: 0,
        }}>← Back</button>
        {!showChoiceScreen && !showWaypointOffer && (
          <>
            <button onClick={recordPosition} style={{
              flex: 1, padding: '0 20px', minHeight: 60, fontSize: 16, fontWeight: 800,
              background: flash ? '#16A34A' : '#2563EB', color: '#fff',
              border: 'none', borderRadius: 10, cursor: 'pointer',
              minWidth: 200,
              transition: 'background 200ms',
            }}>
              {flash
                ? '✓ Recorded'
                : (isWaypointJunction ? 'Record Waypoint' : 'Record Position')}
            </button>
            <button onClick={openManualEntry} title="Type in x/y/z + orientation instead of capturing live" style={{
              padding: '0 14px', minHeight: 56, fontSize: 13, fontWeight: 700,
              background: '#fff', color: '#2563EB',
              border: '1px solid #93c5fd', borderRadius: 10, cursor: 'pointer',
              flexShrink: 0,
            }}>Enter…</button>
            <button onClick={skipCurrent} style={{
              padding: '0 18px', minHeight: 56, fontSize: 14, fontWeight: 700,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
              flexShrink: 0,
            }}>
              {isWaypointJunction ? 'Done — Continue →' : 'Skip →'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// 2026-09-08: CellPickerPage RETIRED. Cell auto-assign lives in
// ProgramWizard mount below — one commissioned cell auto-selects,
// zero or many leaves cell_id null (silent).


// ── Page bodies that use hooks — extracted as proper Components so
// ── React tracks their hook stacks separately from the parent
// ── ProgramWizard fiber. Prior inline lambda form
//    render: ({...}) => { const [x] = useState(...); ... }
// tripped react-hooks/rules-of-hooks because the render-prop function
// has a lowercase name from ESLint's perspective; capitalising the
// component name is what tells the linter this IS a component and
// makes the hooks legal. The PAGES entries below simply spread these
// component references into the `render` field.
// Detection-engine capability list (2026-08-03 architecture directive).
// The Isaac ROS TensorRT YOLOv8 pipeline ships with COCO weights on
// day one, so parts whose canonical name matches a COCO class detect
// immediately. Everything else needs the Phase 2 fine-tune pipeline
// (CAD → synthetic renders → TensorRT engine) — training takes ~1
// hour in the cloud, gated on the RunPod account. The wizard surfaces
// the training requirement per-part so the operator sees the story
// before they hit Run and get an empty detection.
// WhichPartBody + COCO_NATIVE_NAMES + partIsCocoNative deleted
// 2026-10-05 along with the `which_part` PAGES entry (operator
// directive: vision/detect is not in scope). The parts-library
// endpoint still exists for the editor's palette-level detect step;
// nothing else in the wizard consumed these helpers.

// 2026-10-15 machine fixtures step. Reads cell.fixtures (the shared
// External Fixture store).
//
// Operator directive (addendum): the earlier Yes/No "Does the machine
// hold the part with a clamp or vice?" gate was unnecessary — machine
// tending uses a vice (or several), air-controlled, always. Replaced
// with a direct count question: "How many vices hold the part in the
// machine?" Count = 0 covers the self-clamping / no-vice case (chuck,
// magnetic bed, etc.) without a separate yes/no screen. For count ≥ 1
// the operator picks WHICH External Fixture each vice slot binds to.
//
// Clamp sequencing (release-first, confirm-after, cycle-after-all-
// clamped, unclamp-after-grip) + multi-vice load-all-before-cycle
// is UNCHANGED from the prior ship — this body only touches the
// question / selection UI. The persisted shape stays:
//     answers.machine_vice_count  : number (0..6, default 1)
//     answers.machine_fixture_ids : string[] (empty when count=0;
//                                             length === count when ≥1;
//                                             order = per-vice slot
//                                             assignment)
// resolveMachineFixtures(cellRegistry, answers) continues to read
// machine_fixture_ids and drive buildSteps' per-vice emission.
function MachineFixturesBody({ answers, setAnswer, goNext }) {
  // Hook into the module-level cell registry mirror set by the
  // ProgramWizard shell on mount. Keeps the engine signature
  // unchanged (skip() + render({answers,...})) while giving this body
  // access to the cell snapshot — same seam the multi-pick question
  // uses to look up the selected EOAT.
  const cell = _wizardCellRegistryRef || null
  const fixtures = (cell && Array.isArray(cell.fixtures)) ? cell.fixtures : []
  const vicesFirst = [
    ...fixtures.filter((f) => f && f.type === 'vice'),
    ...fixtures.filter((f) => f && f.type !== 'vice'),
  ]

  // Count: 0..6. Default 1 (machine tending almost always uses one
  // vice; 0 is the self-clamping escape hatch). Clamp defensively on
  // every read so a hand-edited saved program with a wild number
  // can't bust the UI.
  const MIN = 0
  const MAX = 6
  const DEFAULT = 1
  const rawCount = Number.isFinite(Number(answers.machine_vice_count))
    ? Number(answers.machine_vice_count)
    : DEFAULT
  const count = Math.max(MIN, Math.min(MAX, Math.round(rawCount)))

  const idsRaw = Array.isArray(answers.machine_fixture_ids)
    ? answers.machine_fixture_ids
    : []
  // Size the selection to the current count. Preserve prior picks for
  // the slots that still exist; fill the rest with empty strings.
  const slotIds = []
  for (let i = 0; i < count; i++) slotIds.push(idsRaw[i] || '')

  function setCount(nextRaw) {
    const n = Math.max(MIN, Math.min(MAX, Math.round(Number(nextRaw) || 0)))
    setAnswer('machine_vice_count', n)
    if (n === 0) {
      setAnswer('machine_fixture_ids', [])
      return
    }
    // Resize the id array to match the new count. Keep prior picks for
    // retained slots; blank the rest.
    const next = []
    for (let i = 0; i < n; i++) next.push(idsRaw[i] || '')
    setAnswer('machine_fixture_ids', next)
  }

  function setSlot(idx, fxId) {
    const next = [...slotIds]
    next[idx] = fxId
    setAnswer('machine_fixture_ids', next)
  }

  const noFixturesInCell = fixtures.length === 0
  const allSlotsFilled = count === 0 || slotIds.every((id) => !!id)
  const canAdvance = allSlotsFilled && (count === 0 || !noFixturesInCell)

  const stepperBtn = (dis) => ({
    minHeight: 56, minWidth: 72,
    padding: '0 20px', fontSize: 22, fontWeight: 800,
    background: dis ? '#f3f4f6' : '#eff6ff',
    color: dis ? '#9ca3af' : '#2563EB',
    border: `1px solid ${dis ? '#e5e7eb' : '#bfdbfe'}`,
    borderRadius: 10, cursor: dis ? 'not-allowed' : 'pointer',
  })

  return (
    <QuestionCard
      question="How many vices hold the part in the machine?"
      description="Vices are air-controlled; the program will clamp each one after loading, wait for the machine cycle to finish, then unclamp before removing the finished part. 0 = the machine holds the part by itself (self-clamping chuck, magnetic bed, etc.)."
    >
      <div data-testid="machine-vice-count"
           data-value={String(count)}
           style={{
             display: 'flex', alignItems: 'center', gap: 12,
             justifyContent: 'center', marginBottom: 12,
           }}>
        <button type="button" aria-label="decrease"
                data-testid="machine-vice-count-dec"
                disabled={count <= MIN}
                onClick={() => setCount(count - 1)}
                style={stepperBtn(count <= MIN)}>−</button>
        <input
          type="number" inputMode="numeric" min={MIN} max={MAX} value={count}
          data-testid="machine-vice-count-input"
          onChange={(e) => setCount(parseInt(e.target.value, 10))}
          style={{
            width: 96, textAlign: 'center',
            fontSize: 28, fontWeight: 800, color: '#111',
            padding: '12px 10px',
            border: '2px solid #e5e7eb', borderRadius: 10,
            fontVariantNumeric: 'tabular-nums',
          }} />
        <button type="button" aria-label="increase"
                data-testid="machine-vice-count-inc"
                disabled={count >= MAX}
                onClick={() => setCount(count + 1)}
                style={stepperBtn(count >= MAX)}>+</button>
      </div>

      {count === 0 && (
        <div data-testid="machine-vice-selfclamp"
             style={{
               padding: 12,
               background: '#F0FDF4', border: '1px solid #BBF7D0',
               borderRadius: 8, color: '#15803D', fontSize: 13,
               lineHeight: 1.5,
             }}>
          No vices — the machine holds the part itself. The program
          will not emit any clamp I/O.
        </div>
      )}

      {count >= 1 && noFixturesInCell && (
        <div data-testid="machine-fixtures-empty"
             style={{
               padding: 12,
               background: '#FFFBEB', border: '1px solid #FCD34D',
               borderRadius: 8, color: '#92400E', fontSize: 13,
             }}>
          No fixtures in this cell yet — set one up in the External
          Fixture wizard first, then come back here.
        </div>
      )}

      {count >= 1 && !noFixturesInCell && (
        <div data-testid="machine-fixtures-picker"
             style={{ marginTop: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
            Which vice is each one?
          </div>
          {slotIds.map((id, idx) => {
            const fx = vicesFirst.find((f) => f.id === id) || null
            const hasClamp = !!(fx && (fx.valve || fx.out))
            return (
              <div key={idx}
                   data-testid="machine-vice-slot"
                   data-slot-index={String(idx)}
                   data-fixture-id={id}
                   style={{
                     display: 'flex', alignItems: 'center', gap: 12,
                     padding: 12, marginBottom: 6,
                     background: '#fff', border: '1px solid #e5e7eb',
                     borderRadius: 8,
                   }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#111', minWidth: 72 }}>
                  Vice {idx + 1}
                </div>
                <select value={id}
                        onChange={(e) => setSlot(idx, e.target.value)}
                        style={{
                          flex: 1, padding: '10px 12px', fontSize: 14,
                          border: '1px solid #d1d5db', borderRadius: 6,
                        }}>
                  <option value="">— pick a fixture —</option>
                  {vicesFirst.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name || `Vice (${f.id.slice(0, 6)})`}
                      {f.type === 'vice' ? '' : ` · ${f.type || 'fixture'}`}
                    </option>
                  ))}
                </select>
                {id && (
                  <div style={{ fontSize: 11, color: hasClamp ? '#15803D' : '#92400E' }}>
                    {hasClamp
                      ? 'clamp signal assigned'
                      : 'no clamp signal — finish its setup'}
                  </div>
                )}
              </div>
            )
          })}
          {count > 1 && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#2563EB' }}>
              {count} vices will be loaded before the machine starts.
              Each gets its own load position in the teach step.
            </div>
          )}
        </div>
      )}

      <NextButton
        onClick={() => goNext({
          machine_vice_count:   count,
          machine_fixture_ids:  count === 0 ? [] : slotIds,
          // Legacy flag — kept for backward-read of saved programs.
          machine_uses_fixture: count > 0,
        })}
        disabled={!canAdvance}
        label="Next" />
    </QuestionCard>
  )
}

function MachineIOBody({ answers, setAnswer, goNext }) {
  const portmap = useIOPortmap()
  const synapsePortmap = useSynapsePortmap()
  const profile = useIoHardwareProfile()
  const doOptions = portmapToOptions(portmap, 'output')
  const diOptions = portmapToOptions(portmap, 'input')
  // 2026-10-01 Synapse Addressing Doctrine (default): dropdown rows
  // render the Synapse name primarily — "Valve 03 (DO3) — Vacuum On".
  // 2026-10-06 I/O hardware profile: in OEM mode the operator wires
  // directly to the controller, so the Synapse breadcrumb is dropped
  // — "DO3 — Vacuum On". The displayNameForRaw call stays live on
  // the Synapse branch (doctrine pin).
  const isOem = profile === 'oem'
  const synDisplay = (o) => {
    if (isOem) {
      const suffix = o.label
        ? ` — ${o.label}${o.flange ? ' (flange)' : ''}`
        : (o.flange ? ' (flange)' : '')
      return `${o.id}${suffix}`
    }
    if (!synapsePortmap) return o.display
    const syn = displayNameForRaw(synapsePortmap, o.id)
    const base = `${syn} (${o.id})`
    const suffix = o.label
      ? ` — ${o.label}${o.flange ? ' (flange)' : ''}`
      : (o.flange ? ' (flange)' : '')
    return `${base}${suffix}`
  }
  return (
    <QuestionCard
      question="Which I/O signals control the machine?"
      description="Select the digital outputs and inputs that communicate with the machine."
    >
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
          Cycle Start Signal (output to machine)
        </div>
        <select value={answers.io_cycle_start || 'DO4'}
          onChange={e => setAnswer('io_cycle_start', e.target.value)}
          style={{ width: '100%', padding: 10, fontSize: 14, borderRadius: 6, border: '1px solid #d1d5db' }}>
          {doOptions.map(o => <option key={o.id} value={o.id}>{synDisplay(o)}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
          Cycle Complete Signal (input from machine)
        </div>
        <select value={answers.io_cycle_done || 'DI3'}
          onChange={e => setAnswer('io_cycle_done', e.target.value)}
          style={{ width: '100%', padding: 10, fontSize: 14, borderRadius: 6, border: '1px solid #d1d5db' }}>
          {diOptions.map(o => <option key={o.id} value={o.id}>{synDisplay(o)}</option>)}
        </select>
      </div>
      <SliderQuestion label="Cycle timeout" value={answers.cycle_timeout || 30}
        onChange={v => setAnswer('cycle_timeout', v)} min={5} max={300} step={5} unit="s"
        description="Maximum time to wait for the machine to finish before flagging an error" />
      <NextButton onClick={goNext} label="Next" />
    </QuestionCard>
  )
}

// Merged tool-and-payload step (2026-10-08). Hosts the shared
// ToolFromCellStep selector (embedded, no auto-advance) above a
// mass + optional CoG input and this step's own Next/Skip row.
// The operator sees cards for the saved cell EOATs AND captures
// payload mass under one canonical card — resolving the pre-merge
// confusion where the mass step's "What tool or payload…" question
// implied cards but didn't render them.
//
// 2026-10-14 crash-hardening (operator field report): the step
// must render safely for ALL answers shapes — fresh program (no
// payload keys), skipped mass ('skip'), numeric mass, NaN after a
// bad input, and legacy cog_mm shapes that aren't a plain object.
// Every read goes through a helper that returns a safe default
// instead of trusting the shape. See cog = _safeCog(...) below.
function _safeNumber(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function _safeCog(v) {
  // Accept only plain objects; everything else (array, number,
  // string, null, undefined) renders as the empty-cog state.
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v
}
function ToolAndPayloadStep({ answers, setAnswer, goNext }) {
  const safeAnswers = answers || {}
  const kg       = safeAnswers.payload_kg
  const kgNum    = _safeNumber(kg)
  const massOk   = kg === 'skip' || (kgNum !== null && kgNum > 0)
  const toolPicked = !!safeAnswers.cell_eoat_id
  const canProceed = toolPicked && massOk
  const [showCog, setShowCog] = useState(false)
  const cog = _safeCog(safeAnswers.payload_cog_mm)
  return (
    <QuestionCard
      question="What tool & payload will this program use?"
      description="Pick the end-of-arm tool, then enter the payload mass so the controller can size collision-detection thresholds correctly. Mass can be skipped and set later in the program editor; the tool is required."
    >
      <ToolFromCellStep
        answers={answers}
        setAnswer={setAnswer}
        goNext={goNext}
        autoAdvance={false}
        embedded
      />
      <div style={{
        marginTop: 18,
        padding: '14px 0 2px',
        borderTop: '1px solid #e5e7eb',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
          Payload mass
        </div>
        <label
          data-testid="tool-and-payload-mass"
          style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>
          Mass (kg)
          <input
            type="number" step="0.1" min="0" max="30"
            placeholder="e.g. 1.2"
            value={kgNum !== null && kgNum > 0 ? kgNum : ''}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') { setAnswer('payload_kg', null); return }
              const n = Number(raw)
              setAnswer('payload_kg', Number.isFinite(n) ? n : null)
            }}
            style={{
              display: 'block', marginTop: 6,
              padding: '8px 12px', fontSize: 16, fontWeight: 500,
              border: '1px solid #d1d5db', borderRadius: 8,
              background: '#fff', color: '#111827', width: 140,
            }} />
        </label>
        <button
          onClick={() => setShowCog((v) => !v)}
          style={{
            background: 'none', border: 'none', padding: 0,
            fontSize: 13, color: '#2563EB', cursor: 'pointer',
            fontWeight: 500, textAlign: 'left', maxWidth: 300,
          }}>
          {showCog ? '▾ Hide CoG offset' : '▸ Add CoG offset (advanced)'}
        </button>
        {showCog && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            fontSize: 13, color: '#374151',
          }}>
            <span>CoG (″ from flange)</span>
            {['x', 'y', 'z'].map((k) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{k}</span>
                <input
                  type="number" step="0.1"
                  placeholder="0"
                  value={_safeNumber(cog[k]) !== null ? mmToIn(cog[k], 2) : ''}
                  onChange={(e) => {
                    const v = e.target.value
                    const next = { ...cog }
                    if (v === '') delete next[k]
                    else {
                      const n = Number(v)
                      if (Number.isFinite(n)) next[k] = inToMm(n)
                    }
                    setAnswer('payload_cog_mm', Object.keys(next).length ? next : null)
                  }}
                  style={{
                    padding: '4px 8px', fontSize: 13,
                    border: '1px solid #d1d5db', borderRadius: 5,
                    width: 72, textAlign: 'right',
                  }} />
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{
        padding: 12, background: '#EFF6FF', borderRadius: 8,
        border: '1px solid #bfdbfe', fontSize: 12, color: '#1E3A8A',
        marginTop: 14, lineHeight: 1.55,
      }}>
        <b>Why we ask.</b> Without a payload value the collision
        monitor uses default (heavier) thresholds — false positives
        go up and true collisions register later. Programs without
        a set payload will show a warning until it's filled in.
      </div>
      <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          data-testid="tool-and-payload-skip-mass"
          onClick={() => { setAnswer('payload_kg', 'skip'); goNext({ payload_kg: 'skip' }) }}
          disabled={!toolPicked}
          title={toolPicked ? undefined : 'Pick a tool first'}
          style={{
            padding: '10px 18px', fontSize: 14, fontWeight: 500,
            background: 'transparent',
            color: toolPicked ? '#6b7280' : '#9ca3af',
            border: '1px solid #d1d5db', borderRadius: 8,
            cursor: toolPicked ? 'pointer' : 'not-allowed',
          }}>
          Not sure yet — skip
        </button>
        <div style={{ flex: 1 }} />
        <NextButton
          onClick={goNext}
          label="Next"
          disabled={!canProceed} />
      </div>
    </QuestionCard>
  )
}

const PAGES = [
  // 2026-09-08 wizard simplification (operator directive):
  //   * `cell` page RETIRED. Auto-assigned in ProgramWizard mount
  //     when exactly one commissioned cell exists; silent null
  //     otherwise. Cell-less programs load / push / run
  //     correctly (the footer's "No cell — environment guard off"
  //     path has been the default when no cell is active for a
  //     week now).
  //   * `sort` operation RETIRED from the operation page (codegen
  //     paths on the backend stay live so existing sort programs
  //     on disk still load; only the wizard chooser goes).
  //   * `pick_method` page RETIRED. Source defaults to
  //     'fixed_position' for pick_and_place + machine_tend; the
  //     palletize flow still sets its own source via pallet_mode.
  //     `which_part` skip predicate (`source !== 'camera_library'`)
  //     handles the source=undefined case as True → page skipped
  //     with no orphan.

  // 1: What operation?
  {
    id: 'operation',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What do you want the robot to do?"
        description="Choose the type of operation. The wizard will guide you through the setup."
      >
        {[
          // 2026-10-13 operator directive: operation cards are
          // NAME-only — the per-card subtitle + letter badges
          // (P/M/G) are retired. The step heading + helper above
          // ("Choose the type of operation…") carries the intent.
          { value: 'pick_and_place', label: 'Pick and Place' },
          { value: 'machine_tend', label: 'Machine Tending' },
          { value: 'palletize', label: 'Palletize' },
        ].map(op => (
          <ChoiceButton key={op.value} label={op.label}
            selected={answers.operation === op.value}
            onClick={() => {
              // Default `source` alongside `operation` per the
              // 2026-09-08 directive: pick_and_place + machine_tend
              // = fixed-position taught pick (skips the retired
              // which_part page); palletize sets its own source
              // in the pallet_mode click handler. Passing both
              // keys through the goNext override so skip predicates
              // on downstream pages see the fresh values (per the
              // desync class fix).
              const override = { operation: op.value }
              if (op.value !== 'palletize') {
                override.source = 'fixed_position'
              }
              setAnswer('operation', op.value)
              if (override.source) setAnswer('source', override.source)
              goNext(override)
            }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 0p: Palletize / Depalletize selector. Inserted immediately after the
  // operation page so the wizard branches before sharing the rest of the
  // setup. Also seeds answers.source so the gripper / detection path
  // skips correctly later on.
  {
    id: 'pallet_mode',
    skip: (answers) => answers.operation !== 'palletize',
    render: ({ answers, setAnswer, goNext }) => {
      const choose = (mode) => {
        const source = mode === 'palletize' ? 'camera_library' : 'fixed_grid'
        setAnswer('pallet_mode', mode)
        setAnswer('source', source)
        goNext({ pallet_mode: mode, source })
      }
      const cardStyle = (selected) => ({
        flex: 1, minHeight: 140, padding: '20px 22px', cursor: 'pointer',
        background: selected ? '#eff6ff' : '#fff',
        border: selected ? '2px solid #2563EB' : '2px solid #e5e7eb',
        borderRadius: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
        textAlign: 'left', transition: 'all 100ms',
      })
      return (
        <QuestionCard
          question="Palletize or Depalletize?"
          description="Both modes share the same pallet layout setup. Pick which direction your robot is going."
        >
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <button onClick={() => choose('palletize')} style={cardStyle(answers.pallet_mode === 'palletize')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14" stroke={answers.pallet_mode === 'palletize' ? '#2563EB' : '#374151'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
                <div style={{ fontSize: 18, fontWeight: 700, color: answers.pallet_mode === 'palletize' ? '#2563EB' : '#111' }}>
                  PALLETIZE
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
                Pick parts and stack them onto a pallet
              </div>
            </button>
            <button onClick={() => choose('depalletize')} style={cardStyle(answers.pallet_mode === 'depalletize')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20V8m0 0l-5 5m5-5l5 5M5 4h14" stroke={answers.pallet_mode === 'depalletize' ? '#CA8A04' : '#374151'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
                <div style={{ fontSize: 18, fontWeight: 700, color: answers.pallet_mode === 'depalletize' ? '#CA8A04' : '#111' }}>
                  DEPALLETIZE
                </div>
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
                Pick parts off a pallet and place them elsewhere
              </div>
            </button>
          </div>
        </QuestionCard>
      )
    },
  },

  // pick_method page RETIRED 2026-09-08. Source now defaults to
  // 'fixed_position' from the operation page's click handler
  // (pick_and_place + machine_tend). Palletize continues to set
  // source in the pallet_mode click handler. Re-adding a
  // camera-detection option is an editor-level change; do not
  // reintroduce a wizard page for it without a fresh directive.

  // which_part page RETIRED 2026-10-05 (operator directive: vision /
  // detect is not in scope). The page only existed to pick the
  // target_part the detect step would scan for; with the wizard no
  // longer emitting a detect step, the page has no purpose and is
  // removed from the flow. The parts-library endpoint + the editor's
  // detect-step palette entry stay intact so legacy programs load
  // and detect can be re-wired when vision is in scope.

  // 2026-10-08: standalone `gripper_type` page RETIRED (operator
  // field report 2026-10-08). The tool-selection cards and the mass
  // question are now merged into a single `tool_and_payload` step
  // (defined below alongside the retired `payload` entry) so the
  // operator sees ONE "tool/payload" step — cards + mass under one
  // canonical card — instead of two confusingly-named steps. The
  // single-mount of ToolFromCellStep still holds: the merged step
  // hosts the ONE embedded render.

  // ──────────────────────────────────────────────────────────────────
  // PALLET PAGES — shared layout + per-mode teach + approach pages.
  // All gated on operation === 'palletize' plus the chosen pallet_mode.
  // ──────────────────────────────────────────────────────────────────

  // P1: Shared pallet layout (rows / cols / layers / spacing / order)
  {
    id: 'pallet_layout',
    skip: (answers) => answers.operation !== 'palletize',
    render: ({ answers, setAnswer, goNext }) => {
      const rows   = answers.pallet_rows   ?? 4
      const cols   = answers.pallet_cols   ?? 4
      const layers = answers.pallet_layers ?? 1
      const sx     = answers.pallet_spacing_x_mm ?? 150
      const sy     = answers.pallet_spacing_y_mm ?? 150
      const lz     = answers.pallet_layer_height_mm ?? 100
      const order  = answers.pallet_fill_order || 'row_lr'
      const total  = rows * cols * layers
      const isDepal = answers.pallet_mode === 'depalletize'

      const setInt = (key, v, lo, hi) => {
        const n = parseInt(v, 10)
        if (Number.isNaN(n)) return
        setAnswer(key, Math.max(lo, Math.min(hi, n)))
      }

      // Visualise the first-layer fill order so the operator can see
      // exactly which slot the robot will hit first / next / last.
      const sequence = []
      for (let i = 0; i < rows * cols; i++) {
        let r, c
        if (order === 'row_lr') {
          c = i % cols
          r = Math.floor(i / cols)
        } else if (order === 'row_rl') {
          c = (cols - 1) - (i % cols)
          r = Math.floor(i / cols)
        } else if (order === 'col') {
          r = i % rows
          c = Math.floor(i / rows)
        } else { // snake
          r = Math.floor(i / cols)
          const within = i % cols
          c = (r % 2 === 0) ? within : (cols - 1 - within)
        }
        sequence.push({ r, c, idx: i })
      }
      const orderForCell = (r, c) => sequence.findIndex((s) => s.r === r && s.c === c)

      const orderOptions = [
        { value: 'row_lr', label: 'Row by row L→R', icon: '→' },
        { value: 'row_rl', label: 'Row by row R→L', icon: '←' },
        { value: 'col',    label: 'Column by column', icon: '↓' },
        { value: 'snake',  label: 'Snake (alternating)', icon: '↔' },
      ]

      return (
        <QuestionCard
          question="How is your pallet arranged?"
          description={isDepal
            ? "Set the grid layout of the pallet the robot will pick FROM. Parts will be picked top layer first."
            : "Set the grid layout of the pallet the robot will place parts ON."}
        >
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 90 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Rows</div>
              <NumericField integer min={1} max={20} value={rows}
                onCommit={(v) => setAnswer('pallet_rows', v)}
                aria-label="Pallet rows" style={inputBox} />
            </label>
            <label style={{ flex: 1, minWidth: 90 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Columns</div>
              <NumericField integer min={1} max={20} value={cols}
                onCommit={(v) => setAnswer('pallet_cols', v)}
                aria-label="Pallet columns" style={inputBox} />
            </label>
            <label style={{ flex: 1, minWidth: 90 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Layers</div>
              <NumericField integer min={1} max={10} value={layers}
                onCommit={(v) => setAnswer('pallet_layers', v)}
                aria-label="Pallet layers" style={inputBox} />
            </label>
          </div>

          <DistanceSlider label="Spacing X (centre-to-centre)" mmValue={sx}
            onCommitMm={(v) => setAnswer('pallet_spacing_x_mm', v)}
            minMm={10} maxMm={500} stepMm={5}
            description="Distance between columns" />
          <DistanceSlider label="Spacing Y (centre-to-centre)" mmValue={sy}
            onCommitMm={(v) => setAnswer('pallet_spacing_y_mm', v)}
            minMm={10} maxMm={500} stepMm={5}
            description="Distance between rows" />
          <DistanceSlider label="Layer height Z" mmValue={lz}
            onCommitMm={(v) => setAnswer('pallet_layer_height_mm', v)}
            minMm={10} maxMm={300} stepMm={5}
            description="Vertical offset added per layer" />

          <div style={{
            padding: 14, background: '#eff6ff', border: '1px solid #bfdbfe',
            borderRadius: 10, marginBottom: 16, textAlign: 'center',
          }}>
            <div style={{ fontSize: 13, color: '#374151' }}>Total capacity</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#2563EB', fontVariantNumeric: 'tabular-nums' }}>
              {rows} × {cols} × {layers} = {total} parts
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
              Layer preview (first layer)
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(20px, 32px))`,
              gridAutoRows: 'minmax(20px, 32px)',
              gap: 4,
              justifyContent: 'center',
              padding: 12,
              background: '#f8fafc',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
            }}>
              {Array.from({ length: rows }).map((_, r) =>
                Array.from({ length: cols }).map((__, c) => {
                  const ord = orderForCell(r, c)
                  const isFirst = ord === 0
                  return (
                    <div key={`${r}-${c}`} title={`Slot ${ord + 1} — row ${r + 1}, col ${c + 1}`}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: isFirst ? '#2563EB' : '#dbeafe',
                        color: isFirst ? '#fff' : '#1e3a8a',
                        borderRadius: 4,
                        fontSize: 10, fontWeight: 700,
                      }}>
                      {ord + 1}
                    </div>
                  )
                })
              )}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, textAlign: 'center' }}>
              Blue square is slot 1 — the first {isDepal ? 'pick' : 'place'} position.
            </div>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
            Fill order
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            {orderOptions.map((o) => (
              <button key={o.value} onClick={() => setAnswer('pallet_fill_order', o.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                  background: order === o.value ? '#eff6ff' : '#fff',
                  border: order === o.value ? '2px solid #2563EB' : '2px solid #e5e7eb',
                  borderRadius: 8,
                  fontSize: 13, fontWeight: 600,
                  color: order === o.value ? '#2563EB' : '#111',
                }}>
                <span style={{
                  width: 26, height: 26, borderRadius: 6, background: '#f3f4f6',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, color: '#374151',
                }}>{o.icon}</span>
                {o.label}
              </button>
            ))}
          </div>

          {isDepal && (
            <div style={{
              padding: 12, background: '#fffbeb', border: '1px solid #fde68a',
              borderRadius: 8, fontSize: 12, color: '#92400e', marginBottom: 8,
            }}>
              Parts will be picked top layer first — layer {layers} down to layer 1.
            </div>
          )}

          <NextButton onClick={goNext} label="Next" />
        </QuestionCard>
      )
    },
  },

  // PA3: Palletize — place approach + retract heights.
  {
    id: 'palletize_approach',
    skip: (answers) => !(answers.operation === 'palletize' && answers.pallet_mode === 'palletize'),
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Place approach settings"
        description="How the robot positions above each pallet slot before placing and how high it retracts between moves."
      >
        <DistanceSlider label="Approach height" mmValue={answers.pallet_approach_height_mm || 100}
          onCommitMm={(v) => setAnswer('pallet_approach_height_mm', v)}
          minMm={20} maxMm={300} stepMm={5}
          description="Z offset above each slot before descent" />
        <DistanceSlider label="Retract height" mmValue={answers.pallet_retract_height_mm || 200}
          onCommitMm={(v) => setAnswer('pallet_retract_height_mm', v)}
          minMm={50} maxMm={500} stepMm={10}
          description="Z height the robot moves to between pick / place moves" />
        <div style={{
          padding: 12, background: '#f0f9ff', borderRadius: 8,
          border: '1px solid #bfdbfe', fontSize: 12, color: '#2563EB', marginBottom: 16,
        }}>
          Higher retract = safer but slower.
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // DA3: Depalletize — pick approach + retract heights.
  {
    id: 'depalletize_approach',
    skip: (answers) => !(answers.operation === 'palletize' && answers.pallet_mode === 'depalletize'),
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Pick approach settings"
        description="How the robot positions above each pallet slot before picking and how high it retracts between moves."
      >
        <DistanceSlider label="Approach height" mmValue={answers.pallet_approach_height_mm || 100}
          onCommitMm={(v) => setAnswer('pallet_approach_height_mm', v)}
          minMm={20} maxMm={300} stepMm={5}
          description="Z offset above each slot before descent" />
        <DistanceSlider label="Retract height" mmValue={answers.pallet_retract_height_mm || 200}
          onCommitMm={(v) => setAnswer('pallet_retract_height_mm', v)}
          minMm={50} maxMm={500} stepMm={10}
          description="Z height the robot moves to between pick / place moves" />
        <div style={{
          padding: 12, background: '#f0f9ff', borderRadius: 8,
          border: '1px solid #bfdbfe', fontSize: 12, color: '#2563EB', marginBottom: 16,
        }}>
          Higher retract = safer but slower.
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // Speed and Motion Profile pages were removed from the wizard. The
  // program config still carries `speed_pct` and `motion_profile_name`
  // (the executor still reads them), but they are defaulted silently at
  // save time. Operators tune both from the Program tab's motion profile
  // card after the program exists.

  // 6: Approach height
  //    Skipped for pallet modes — they teach their own approach/retract
  //    heights on the dedicated PA3 / DA3 pages.
  {
    id: 'approach',
    skip: (answers) => answers.operation === 'palletize',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How high above the part should the robot approach?"
        description="The robot moves to this height above the part before descending to pick it up. Higher is safer but slower."
      >
        <DistanceSlider label="Approach height" mmValue={answers.approach_height || 100}
          onCommitMm={v => setAnswer('approach_height', v)}
          minMm={20} maxMm={300} stepMm={10}
          description="Distance above the part surface before the final descent"
          recommendedCopy="Recommended: 4–6″ for most operations. Use 2–3″ for tight spaces." />
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // Tool + payload (merged, 2026-10-08 operator field report).
  //
  // The old split — a standalone `gripper_type` step for the tool-
  // selection cards + a separate `payload` step for mass — surfaced
  // as a UX bug: the payload step's question "What tool or payload
  // does this program use?" led operators to expect the cell-EOAT
  // cards here too. The cards were on the earlier step; the payload
  // step was a different / older question that never got wired to
  // the cell. Fix: merge the two under one canonical card. The
  // operator-visible "tool/payload" step renders the saved cell
  // EOATs as cards (via the SAME ToolFromCellStep selector, now
  // embedded) with the mass + optional CoG + Next below.
  //
  // Payload mass is still non-blocking (Skip is available); the
  // editor's payload card is where it's typically tuned after
  // creation. The tool-selection, by contrast, is required to
  // advance — a program must bind to an EOAT.
  //
  // ToolFromCellStep stays mounted EXACTLY once in the PAGES list
  // (D_cell single-mount pin); the embedded=true flag suppresses
  // its auto-advance and its outer <QuestionCard>, letting this
  // step host both concerns under one card.
  {
    id: 'tool_and_payload',
    render: ToolAndPayloadStep,
  },

  // 7: How many pick positions? (pick_and_place only)
  //
  // 2026-10-15 operator directive: the retired "Where should the
  // robot place the part? / Fixed Position / Relative Offset" step
  // (previously at this slot) is gone. "Relative offset" was
  // redundant with Palletize's grid flow and — on an audit grep —
  // was never read by codegen anywhere (place_method was write-only
  // in answers; buildSteps / buildPalletizeSteps always honored the
  // taught place pose). Replaced here with explicit per-position
  // counts: the operator declares N pick positions and M place
  // positions, and the teach sequence + buildSteps emit one
  // approach / contact / engage / retreat triple per taught pose.
  //
  // Skipped for machine_tend (its own load / unload teach) and
  // palletize (the pallet pages own the place flow — grid stays
  // in Palletize per the directive). For sort, the two taught sort
  // places have their own PLACE_1 / PLACE_2 keys from an earlier
  // ship; sort also skips this count step so those stay untouched.
  //
  // Default 1 / 1 reproduces today's single-pick → single-place
  // output byte-for-byte (teach keys stay taught_pick / taught_place,
  // position_roles stay 'pick' / 'place'). Only when a count ≥ 2 does
  // the teach sequence switch to indexed taught_pick_i / taught_place_j
  // keys and the paired-loop codegen.
  //
  // 6b: Multi-pick (how many parts grabbed before placing)
  //
  // 2026-10-15 operator directive: this question appears ONLY when
  // the selected tool's capacity > 1 (resolveCapacity from
  // lib/eoatVerification). For a capacity-1 tool the question stays
  // hidden — complexity ONLY appears when the tool makes it relevant.
  // Default answer "One at a time" (multi_pick_count === 1) runs the
  // simple pick → place → repeat flow byte-identical to today.
  //
  // Codegen (buildSteps multi-pair / single-pair) reads
  // answers.multi_pick_count and emits that many engage-with-
  // verification iterations before transitioning to the place leg.
  // Capped by resolveCapacity on save — a hand-edit of a saved
  // program that pushes multi_pick_count above capacity is clamped
  // by the gate at buildSteps time (not silently honored).
  {
    id: 'multi_pick_count',
    skip: (answers) => {
      if (answers.operation === 'machine_tend') return true
      if (answers.operation === 'palletize')    return true
      if (answers.operation === 'sort')         return true
      const eoat = _wizardSelectedEoat(answers)
      // No tool picked yet → nothing to gate on → skip.
      if (!eoat) return true
      // Honor the EOAT's permanent-truth capacity. Capacity 1 means
      // the tool can only hold one part at a time; the multi-pick
      // question is never asked, operator never sees it.
      return !offersMultiPick(eoat)
    },
    render: ({ answers, setAnswer, goNext }) => {
      const eoat = _wizardSelectedEoat(answers)
      const cap = resolveCapacity(eoat)
      const current = Math.max(1, Math.min(cap, Number(answers.multi_pick_count) || 1))
      const grabSeveral = current > 1
      return (
        <QuestionCard
          question="Pick one part at a time, or grab several before placing?"
          description={`This tool can hold up to ${cap} parts at once. Grabbing several means the robot picks multiple parts, then places them.`}
        >
          <ChoiceButton
            label="One at a time"
            description="Pick one part, place it, repeat."
            selected={!grabSeveral}
            onClick={() => { setAnswer('multi_pick_count', 1); goNext({ multi_pick_count: 1 }) }}
          />
          <ChoiceButton
            label="Grab several"
            description="Pick multiple parts first, then place them."
            selected={grabSeveral}
            onClick={() => setAnswer('multi_pick_count', Math.max(2, current))}
          />
          {grabSeveral && (
            <div style={{
              marginTop: 12, padding: 12,
              background: '#F9FAFB', border: '1px solid #E5E7EB',
              borderRadius: 8,
            }}>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 8 }}>
                How many parts before placing? <span style={{ color: '#6b7280' }}>(max {cap})</span>
              </div>
              <PickPlaceCountInput
                testId="multi-pick-count-input"
                value={Math.max(2, Math.min(cap, current))}
                onChange={(n) => setAnswer('multi_pick_count',
                  Math.max(2, Math.min(cap, n)))}
              />
              <NextButton
                onClick={() => goNext({
                  multi_pick_count: Math.max(2, Math.min(cap, current)),
                })}
                label="Next" />
            </div>
          )}
        </QuestionCard>
      )
    },
  },

  {
    id: 'pick_count',
    skip: (answers) => answers.operation === 'machine_tend'
                     || answers.operation === 'palletize'
                     || answers.operation === 'sort',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How many pick positions?"
        description="The robot will pick a part from each position in turn. For a grid of parts, use the Palletize operation instead."
      >
        <PickPlaceCountInput
          testId="pick-count-input"
          value={answers.pick_count ?? 1}
          onChange={(n) => setAnswer('pick_count', n)}
        />
        <NextButton
          onClick={() => goNext({ pick_count: answers.pick_count ?? 1 })}
          label="Next" />
      </QuestionCard>
    ),
  },

  // 7b: How many place positions? (pick_and_place only — same skip)
  {
    id: 'place_count',
    skip: (answers) => answers.operation === 'machine_tend'
                     || answers.operation === 'palletize'
                     || answers.operation === 'sort',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How many place positions?"
        description="For equal pick + place counts the robot pairs them: pick 1 → place 1, pick 2 → place 2, and so on. Unequal counts use the smaller of the two; extras are listed as unused on the Review page."
      >
        <PickPlaceCountInput
          testId="place-count-input"
          value={answers.place_count ?? 1}
          onChange={(n) => setAnswer('place_count', n)}
        />
        <NextButton
          onClick={() => goNext({ place_count: answers.place_count ?? 1 })}
          label="Next" />
      </QuestionCard>
    ),
  },

  // 8b: Machine fixtures / vices (machine_tend only)
  //
  // 2026-10-15 operator field report: a machine-tending program placed
  // the part in the fixture and released the gripper but NEVER emitted
  // any clamp IO — the machine would have cycled on an unheld part.
  // The wizard also never asked which fixture(s) the machine uses.
  //
  // This step reads cell.fixtures (the shared External Fixture store
  // the fixture wizard writes — NO fork) and offers a plain Yes/No
  // + multi-select. answers.machine_fixture_ids: string[] records the
  // operator's selection. For zero fixtures the codegen stays
  // byte-identical to the pre-directive legacy path (clampWorkpiece
  // returns [] when no portmap role is set).
  //
  // Order rationale: the fixtures step lands AFTER tool_and_payload
  // (so the operator picked their EOAT) and BEFORE machine_io (which
  // asks about cycle-start / cycle-complete signals). The teach
  // sequence derives per-fixture load positions from the selection,
  // so this answer must be known by the time the teach pages compile.
  {
    id: 'machine_fixtures',
    skip: (answers) => answers.operation !== 'machine_tend',
    render: MachineFixturesBody,
  },

  // 9: Machine I/O (only for machine_tend)
  {
    id: 'machine_io',
    skip: (answers) => answers.operation !== 'machine_tend',
    render: MachineIOBody,
  },

  // 10: Should it repeat?
  //     For pallet modes the count is locked to rows × cols × layers —
  //     the program loops through the full pallet then stops.
  {
    id: 'repeat',
    render: ({ answers, setAnswer, goNext }) => {
      const isPallet = answers.operation === 'palletize'
      if (isPallet) {
        const rows   = answers.pallet_rows   ?? 4
        const cols   = answers.pallet_cols   ?? 4
        const layers = answers.pallet_layers ?? 1
        const total  = rows * cols * layers
        // buildPalletizeSteps emits the loop with count = rows×cols×layers
        // directly so answers.repeat is not consulted for pallet
        // programs — no need to setAnswer here.
        return (
          <QuestionCard
            question="Cycle count"
            description="A pallet program runs once through every slot, then stops."
          >
            <div style={{
              padding: 16, background: '#eff6ff', border: '1px solid #bfdbfe',
              borderRadius: 10, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 6 }}>
                This program will run
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#2563EB', fontVariantNumeric: 'tabular-nums' }}>
                {total} cycles
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                {rows} rows × {cols} cols × {layers} layers
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>
              Cycle count is fixed for pallet programs and cannot be changed here.
            </div>
            <NextButton onClick={goNext} label="Next" />
          </QuestionCard>
        )
      }
      return (
        <QuestionCard
          question="Should the program repeat?"
          description="After completing all steps, should the robot start again?"
        >
          {[
            { value: 'once', label: 'Run Once', desc: 'Complete the operation one time and stop.' },
            { value: 'continuous', label: 'Run Continuously', desc: 'Repeat the cycle until stopped by the operator.' },
            { value: 'count', label: 'Run a Set Number of Times', desc: 'Repeat a specific number of cycles.' },
          ].map(r => (
            <ChoiceButton key={r.value} label={r.label} description={r.desc}
              selected={answers.repeat === r.value}
              onClick={() => { setAnswer('repeat', r.value); if (r.value !== 'count') goNext({ repeat: r.value }) }}
            />
          ))}
          {answers.repeat === 'count' && (
            <div style={{ marginTop: 12 }}>
              {/* 2026-09-08 wizard simplification: SliderQuestion
                  replaced with a plain numeric input per operator
                  directive. Direct typing, min=1, no artificial
                  max — codegen accepts any positive integer (the
                  Lua `for i=1,N do … end` loop caps at controller
                  int range). Validate integer at commit; letting
                  operator type freely as they go. */}
              <label style={{
                display: 'block', fontSize: 13, fontWeight: 600,
                color: '#111', marginBottom: 6,
              }}>
                Number of cycles
              </label>
              <input
                data-testid="wizard-cycles-input"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={answers.repeat_count ?? 10}
                onChange={(e) => {
                  const raw = e.target.value
                  if (raw === '') { setAnswer('repeat_count', ''); return }
                  const n = parseInt(raw, 10)
                  if (Number.isFinite(n) && n >= 1) {
                    setAnswer('repeat_count', n)
                  }
                }}
                style={{
                  width: 140, padding: '8px 12px',
                  fontSize: 16, fontFamily: 'var(--font-mono, monospace)',
                  border: '1px solid #d1d5db', borderRadius: 6,
                  background: '#fff', color: '#111',
                }}
              />
              <NextButton
                onClick={() => {
                  // Belt-and-braces integer validation at commit
                  // time. Empty / non-integer / <1 clamps to 1.
                  const n = parseInt(answers.repeat_count, 10)
                  if (!Number.isFinite(n) || n < 1) {
                    setAnswer('repeat_count', 1)
                    goNext({ repeat_count: 1 })
                  } else {
                    goNext({ repeat_count: n })
                  }
                }}
                label="Next" />
            </div>
          )}
        </QuestionCard>
      )
    },
  },

  // 11: Name the program
  {
    id: 'name',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Give your program a name"
        description="Choose a descriptive name so you can find it later in the program library."
      >
        <input value={answers.program_name || ''}
          onChange={e => setAnswer('program_name', e.target.value)}
          placeholder="e.g. Pick bolts from bin A"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && answers.program_name?.trim()) goNext() }}
          style={{
            width: '100%', padding: '14px 16px', fontSize: 18, fontWeight: 600,
            border: '2px solid #2563EB', borderRadius: 10, outline: 'none',
            marginBottom: 16,
          }}
        />
        <NextButton onClick={goNext} disabled={!answers.program_name?.trim()} label="Review Program" />
      </QuestionCard>
    ),
  },

  // 12: Teach intro — explains the upcoming teach walk-through.
  //     Pallet flows already taught their points (PA*/DA*) so skip the
  //     generic intro.
  {
    id: 'teach_intro',
    skip: (answers) => answers.operation === 'palletize',
    render: ({ answers, goNext }) => {
      const points = [
        '1. Home position — where the robot rests between cycles',
        '2. Pick position — where the robot grabs parts',
        '3. Place position — where the robot puts parts',
      ]
      if (answers.operation === 'machine_tend') {
        points.push('4. Machine load position')
        points.push('5. Unload position')
      }
      return (
        <QuestionCard
          question="Now let's teach the robot positions"
          description="Use the jog controls to move the robot to each spot, then press Record."
        >
          <div style={{
            padding: 16, background: '#eff6ff', borderRadius: 10,
            border: '1px solid #bfdbfe', marginBottom: 20,
            fontSize: 14, color: '#374151', lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 700, color: '#2563EB', marginBottom: 8 }}>You will teach:</div>
            {points.map((p, i) => <div key={i}>{p}</div>)}
          </div>
          <NextButton onClick={goNext} label="Start Teaching" />
        </QuestionCard>
      )
    },
  },

  // 13: Teach home
  //
  // Every TeachWithJog below carries key={pointName}. Without it, React
  // matches the component by position-in-tree and reuses the SAME
  // instance across teach pages — meaning useState(initialTaught) reads
  // answers[pointName] only on the first mount and the `taught` /
  // `position` state from the previous teach page leaks into the next.
  // The key forces a fresh mount per teach point.
  //
  // Pallet flows skip — the robot uses the driver's hard-coded home.
  // 13: Teach sequence — the dedicated fullscreen flow that replaces
  //     the old per-position teach pages (teach_home / teach_pick /
  //     teach_place / teach_machine_load / teach_unload / teach_inspect
  //     plus the PA1/PA2/DA1/DA2 pallet teach pages). One position at a
  //     time, big jog pendant, progress dots; advances to Review when
  //     finished or when Skip All is pressed.
  {
    id: 'teach_sequence',
    render: ({ answers, setAnswer, goNext, goBack, reusedSteps, setReusedSteps }) => (
      <TeachSequence
        answers={answers}
        setAnswer={setAnswer}
        onComplete={goNext}
        onBackToName={goBack}
        reusedSteps={reusedSteps}
        setReusedSteps={setReusedSteps}
      />
    ),
  },

  // 19: Review and save (final)
  {
    id: 'review',
    render: ({ answers, steps, saving, onSave, reusedSteps }) => {
      const isPallet  = answers.operation === 'palletize'
      const isDepal   = isPallet && answers.pallet_mode === 'depalletize'
      const rows      = answers.pallet_rows   ?? 4
      const cols      = answers.pallet_cols   ?? 4
      const layers    = answers.pallet_layers ?? 1
      const total     = rows * cols * layers
      const orderLabel = {
        row_lr: 'Row by row L→R',
        row_rl: 'Row by row R→L',
        col:    'Column by column',
        snake:  'Snake (alternating)',
      }[answers.pallet_fill_order || 'row_lr']
      return (
      <QuestionCard
        question="Review your program"
        description={`"${answers.program_name}" — ${steps.length} steps`}
      >
        <div style={{
          background: '#f8fafc', borderRadius: 10, border: '1px solid #e5e7eb',
          padding: 14, marginBottom: 16, maxHeight: 350, overflowY: 'auto',
        }}>
          {steps.map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px',
              borderBottom: i < steps.length - 1 ? '1px solid #e5e7eb' : 'none',
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%',
                background: '#e5e7eb', color: '#374151',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>{i + 1}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{s.label}</div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>{s.action}</div>
              </div>
            </div>
          ))}
        </div>

        {isPallet && (
          <div style={{
            padding: 14, background: isDepal ? '#fffbeb' : '#eff6ff',
            border: isDepal ? '1px solid #fde68a' : '1px solid #bfdbfe',
            borderRadius: 10, marginBottom: 16, fontSize: 13,
          }}>
            <div style={{
              fontWeight: 800, color: isDepal ? '#92400e' : '#1e3a8a',
              marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
              letterSpacing: '0.05em',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d={isDepal
                  ? "M12 20V8m0 0l-5 5m5-5l5 5"
                  : "M12 4v12m0 0l-5-5m5 5l5-5"}
                  stroke={isDepal ? '#CA8A04' : '#2563EB'} strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
              {isDepal ? 'DEPALLETIZE' : 'PALLETIZE'}
            </div>
            <div style={{ color: '#374151', fontWeight: 600, marginBottom: 4 }}>
              {rows} rows × {cols} cols × {layers} layers = {total} parts
            </div>
            <div style={{ color: '#6b7280' }}>
              Spacing: {formatInLabel(answers.pallet_spacing_x_mm ?? 150)} × {formatInLabel(answers.pallet_spacing_y_mm ?? 150)}
            </div>
            <div style={{ color: '#6b7280' }}>
              Layer height: {formatInLabel(answers.pallet_layer_height_mm ?? 100)}
            </div>
            <div style={{ color: '#6b7280' }}>
              {isDepal ? 'Pick' : 'Fill'} order: {isDepal ? `Top layer first, ${orderLabel}` : orderLabel}
            </div>
            <div style={{ color: '#6b7280', marginTop: 6 }}>
              {/* v2 frame: 3 corners + first-part datum. The old
                  single-key `taught_pallet_corner` check dates to v1
                  and always resolves to false against v2 answers,
                  which made this row read "Not taught" on the
                  review page even after the operator taught all
                  four points. Read the v2 keys. */}
              {(() => {
                // 2026-09-15 widened validator: prefer wizard-marker
                // key; fall back to config.pallet.corner*_tcp so a
                // program taught via the editor overlay reads as
                // "taught" (both stores are truth — geometry is the
                // authority codegen uses).
                const _cfg  = buildPalletConfig(answers) ? { pallet: buildPalletConfig(answers) } : {}
                const c1   = readTaughtWithConfig(answers, _cfg, 'taught_pallet_corner1')
                const c2   = readTaughtWithConfig(answers, _cfg, 'taught_pallet_corner2')
                const c3   = readTaughtWithConfig(answers, _cfg, 'taught_pallet_corner3')
                const part = readTaughtWithConfig(answers, _cfg, 'taught_pallet_part')
                const allFour = c1 && c2 && c3 && part
                return isDepal ? (
                  <>
                    Pallet frame (①②③ + ④ part): {allFour ? '✓ Taught' : '— Not fully taught'}
                    <br />
                    Place position: {readTaught(answers, 'taught_place') ? '✓ Taught' : '— Not taught'}
                  </>
                ) : (
                  <>
                    Pick position: {readTaught(answers, 'taught_pick') ? '✓ Taught' : '— Not taught'}
                    <br />
                    Pallet frame (①②③ + ④ part): {allFour ? '✓ Taught' : '— Not fully taught'}
                  </>
                )
              })()}
            </div>
          </div>
        )}

        {(() => {
          // POSITIONS TAUGHT card — driven by the same teachPositionsForAnswers
          // helper the TeachSequence uses, so the list always matches what
          // the operator just walked through.
          const positions = teachPositionsForAnswers(answers)
          // Track which key carries the "primary" (first-taught) value so
          // a duplicate later occurrence of the same key labels as
          // 'reused (same as ...)'. With the current position list none
          // of the operations have duplicate keys, but the wiring is
          // ready for it.
          const seenKeyAt = {}
          const statuses  = positions.map((p, i) => {
            const reusedHere = reusedSteps && reusedSteps[i]
            const v = answers[p.key]
            const recorded = !!v && !v.skipped && (
              (Array.isArray(v.tcp) && v.tcp.length) ||
              (Array.isArray(v.joints) && v.joints.length)
            )
            // Record the first index that taught this key so duplicates
            // can label themselves "same as <label>".
            if (recorded && seenKeyAt[p.key] === undefined) seenKeyAt[p.key] = i
            if (reusedHere && recorded) return 'reused'
            if (!v) return 'pending'
            if (v.skipped) return 'skipped'
            if (recorded) return 'recorded'
            return 'pending'
          })
          const requiredKeys  = new Set(['taught_home', 'taught_pick'])
          const recordedCount = statuses.filter((s) => s === 'recorded' || s === 'reused').length
          const anyTaught     = recordedCount > 0
          return (
            <div style={{
              padding: 14, background: '#f8fafc', borderRadius: 10,
              border: '1px solid #e5e7eb', marginBottom: 16, fontSize: 13,
            }}>
              <div style={{
                fontWeight: 700, color: '#374151', marginBottom: 8,
                textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11,
              }}>
                Positions Taught
              </div>
              {positions.map((p, i) => {
                const s = statuses[i]
                const required = requiredKeys.has(p.key)
                const isReused = s === 'reused'
                const isWarn   = required && s !== 'recorded' && s !== 'reused'
                const color  = s === 'recorded' ? '#16A34A'
                             : isReused         ? '#2563EB'
                             : isWarn           ? '#CA8A04'
                                                : '#9ca3af'
                const symbol = s === 'recorded' ? '✓'
                             : isReused         ? '↻'
                             : isWarn           ? '!'
                                                : '—'
                // Build the trailing label. For reused entries point at
                // the earlier step that taught this key (when one exists)
                // so the operator knows where the value came from.
                // 2026-09-15: append the source pose's timestamp / origin
                // per operator directive ("reused from <date>") — for
                // globally-seeded home, name the origin ("saved home
                // position") rather than a bare date.
                let trailing
                if (isReused) {
                  const firstIdx = seenKeyAt[p.key]
                  const primary  = (firstIdx !== undefined && firstIdx !== i)
                    ? positions[firstIdx]?.label
                    : null
                  const v = answers[p.key]
                  let origin = null
                  if (v?.source === 'global') {
                    origin = 'saved home position'
                  } else if (v?.taught_at) {
                    try { origin = new Date(v.taught_at).toLocaleDateString() }
                    catch { origin = v.taught_at }
                  }
                  if (primary) {
                    trailing = origin
                      ? `reused (same as ${primary.toLowerCase()}, from ${origin})`
                      : `reused (same as ${primary.toLowerCase()})`
                  } else {
                    trailing = origin ? `reused from ${origin}` : 'reused'
                  }
                } else {
                  trailing = s === 'recorded' ? 'recorded'
                           : isWarn         ? 'required — skipped'
                           : s === 'skipped' ? 'skipped'
                                              : 'not taught'
                }
                return (
                  <div key={i + ':' + p.key} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '4px 0', fontSize: 13,
                  }}>
                    <span style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: color + '22', color, fontWeight: 800,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, flexShrink: 0,
                    }}>{symbol}</span>
                    <span style={{ color: '#374151' }}>{p.label}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, color, fontWeight: 600, textTransform: 'lowercase' }}>
                      {trailing}
                    </span>
                  </div>
                )
              })}
              {!anyTaught && (
                <div style={{
                  marginTop: 10, padding: 10, fontSize: 12,
                  background: '#fffbeb', border: '1px solid #fde68a',
                  borderRadius: 6, color: '#92400e',
                }}>
                  No positions were taught. You can teach them later from the
                  Program tab using Teach All.
                </div>
              )}
            </div>
          )
        })()}

        <div style={{
          padding: 14, background: '#f8fafc', borderRadius: 10,
          border: '1px solid #e5e7eb', marginBottom: 16, fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, color: '#374151', marginBottom: 8 }}>Settings</div>
          <div style={{ color: '#6b7280' }}
               data-testid="program-wizard-summary-gripper">
            Gripper: {typeLabel({ type: answers.gripper_type }) || '—'}
          </div>
          {/* Speed and motion profile are defaulted at save time (see save handler).
              They are tuned from the Program tab's motion profile card after creation. */}
          {isPallet ? (
            <>
              <div style={{ color: '#6b7280' }}>Approach height: {formatInLabel(answers.pallet_approach_height_mm ?? 100)}</div>
              <div style={{ color: '#6b7280' }}>Retract height: {formatInLabel(answers.pallet_retract_height_mm ?? 200)}</div>
              <div style={{ color: '#6b7280' }}>Cycles: {total} (locked — full pallet)</div>
            </>
          ) : (
            <>
              <div style={{ color: '#6b7280' }}>Approach height: {formatInLabel(answers.approach_height)}</div>
              <div style={{ color: '#6b7280' }}>Repeat: {answers.repeat === 'continuous' ? 'Continuously' : answers.repeat === 'count' ? answers.repeat_count + ' times' : 'Once'}</div>
            </>
          )}
        </div>

        <button onClick={onSave} disabled={saving} style={{
          width: '100%', padding: 16, fontSize: 17, fontWeight: 700,
          background: saving ? '#9ca3af' : '#16A34A', color: '#fff',
          border: 'none', borderRadius: 10, cursor: saving ? 'wait' : 'pointer',
        }}>
          {saving ? 'Saving...' : 'Save Program'}
        </button>
      </QuestionCard>
      )
    },
  },
]

// ────────────────────────────────────────────────────────
// Build steps from answers
// ────────────────────────────────────────────────────────

// Convert TCP recorded by /api/state (meters / radians) into the
// {x,y,z,rx,ry,rz} object the saved program config uses.
function tcpToObj(tcp) {
  if (!Array.isArray(tcp) || tcp.length < 3) return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }
  return {
    x:  Number(tcp[0]) || 0,
    y:  Number(tcp[1]) || 0,
    z:  Number(tcp[2]) || 0,
    rx: Number(tcp[3]) || 0,
    ry: Number(tcp[4]) || 0,
    rz: Number(tcp[5]) || 0,
  }
}

// Read a taught_* payload from answers, treating skipped / empty as
// null so downstream applyTaught calls don't half-apply a position.
function readTaught(answers, key) {
  const v = answers && answers[key]
  if (!v) return null
  if (v.skipped) return null
  if (!Array.isArray(v.tcp) && !Array.isArray(v.joints)) return null
  return v
}

// 2026-10-15 operator directive: compose the pick-side verification
// steps a tool with 'per_pick' or 'per_part' verification requires.
// Reads the shared allocator's confirm_signals from the cell EOAT
// (never pulls DO/DI from the wizard answer map — the operator does
// not type signal ids). Returns [] for 'none' verification OR when no
// confirm signals are wired, so pre-directive tools and tools without
// sensors emit byte-identical to today.
//
// Semantics:
//   per_pick → ONE verify_input (the first confirm signal); fired
//              after effectorEngage, blocks until the input confirms;
//              on timeout the executor stops with reason "part not
//              confirmed" (reason stays on the step for the Monitor
//              + Run modal to surface in plain language).
//   per_part → N verify_input emits (one per part held, capped by
//              resolveCapacity + multi_pick_count). Fired at the end
//              of each pick's engage in the multi-pick flow — the
//              generated program checks each sensor independently.
//              Only valid when capacity > 1; the EOAT record resolver
//              refuses per_part on capacity ≤ 1 (safety-rails).
function verificationStepsForEoat(cellEoat, { partsOnPick = 1,
                                               partIndex = 1 } = {}) {
  if (!cellEoat) return []
  if (!emitsVerificationStep(cellEoat)) return []
  const signals = resolveConfirmSignals(cellEoat)
  if (!signals.length) return []
  const mode = resolveVerification(cellEoat)
  if (mode === VERIFICATION_PER_PART) {
    // Return ONE verify_input for THIS part (partIndex). The caller
    // loops per-pick, so the per-pick emission already fans out N
    // steps across N picks when partsOnPick > 1.
    const sigIdx = Math.max(0, Math.min(signals.length - 1, partIndex - 1))
    return [{
      action: 'verify_input',
      label: `Confirm part ${partIndex} grabbed`,
      input: signals[sigIdx],
      on_fail: 'stop',
      reason: 'part not confirmed',
      verification: 'per_part',
      part_index: partIndex,
    }]
  }
  // per_pick: one wait on the first confirm signal, regardless of how
  // many parts the pick leg will grab. Operator order: "one sensor
  // for the whole pick" exactly.
  return [{
    action: 'verify_input',
    label: 'Confirm part grabbed',
    input: signals[0],
    on_fail: 'stop',
    reason: 'part not confirmed',
    verification: 'per_pick',
  }]
}

// 2026-10-15 waypoint codegen — waypointStepsForJunction + its reader
// readWaypointsForJunction moved to lib/waypointJunctions.js. The
// shared module backs every wizard that offers waypoint teaching;
// ProgramWizard imports them at the top of this file. A pin suite
// (D_shared_waypoint_offer.test.js) greps this file to assert no inline
// fork is reintroduced.

// 2026-09-15 field-triage fix: for pallet corner / part keys, ALSO
// consult the geometry store (config.pallet.corner*_tcp + part_tcp).
// The editor's palletTeachRecord writes only the geometry keys, so a
// program taught via the editor overlay had config.pallet.corner*_tcp
// populated but config.taught_pallet_corner* empty. The wizard Review
// card was then reading the empty wizard-marker key and claiming the
// pallet was "not fully taught" even though geometry authority (used
// by codegen) held the operator's pose. Widen the reader here — the
// mirror-write fix in ProgramEditor.jsx now stamps both stores going
// forward, but this fallback repairs any program that was taught
// under the old code.
const PALLET_TAUGHT_KEY_TO_GEOMETRY_FIELD = {
  taught_pallet_corner1: 'corner1_tcp',
  taught_pallet_corner2: 'corner2_tcp',
  taught_pallet_corner3: 'corner3_tcp',
  taught_pallet_part:    'part_tcp',
}
function readTaughtWithConfig(answers, config, key) {
  const direct = readTaught(answers, key)
  if (direct) return direct
  const geom = PALLET_TAUGHT_KEY_TO_GEOMETRY_FIELD[key]
  if (!geom) return null
  const tcp = config?.pallet?.[geom] || config?.pallet_place?.[geom]
  if (!Array.isArray(tcp) || tcp.length < 6) return null
  return {
    tcp:       [...tcp],
    joints:    null,
    taught_at: null,
    source:    'editor_overlay',
    skipped:   false,
  }
}

// Build the typed pallet config block saved into program.config.pallet.
// The wizard never bakes per-slot coordinates into steps — the executor
// computes them at runtime from this block. See the EXECUTOR CHANGES
// section of the task spec.
function buildPalletConfig(answers) {
  // v2 (2026-07-30): four taught points — three corners for the
  // frame + a first-part pose for orientation and Z. See
  // programming_by_demonstration.pallet_geometry docstring for the
  // slot derivation math. New writes emit the corner1/2/3/part
  // fields; the schema's from_dict handles v1-only saved programs
  // via a migration path so legacy loads still work.
  const corner1 = readTaught(answers, 'taught_pallet_corner1')
  const corner2 = readTaught(answers, 'taught_pallet_corner2')
  const corner3 = readTaught(answers, 'taught_pallet_corner3')
  const part    = readTaught(answers, 'taught_pallet_part')
  return {
    rows:            answers.pallet_rows   ?? 4,
    cols:            answers.pallet_cols   ?? 4,
    layers:          answers.pallet_layers ?? 1,
    spacing_x_mm:    answers.pallet_spacing_x_mm   ?? 150,
    spacing_y_mm:    answers.pallet_spacing_y_mm   ?? 150,
    layer_height_mm: answers.pallet_layer_height_mm ?? 100,
    fill_order:      answers.pallet_fill_order || 'row_lr',
    // Legacy corner_tcp mirror (backwards-compat with old readers
    // that consume the pallet block outside pallet_place — the 3D
    // twin's pre-2026-07-30 preview path still reads this). Seed
    // from corner1's TCP so the display doesn't jump.
    corner_tcp:      tcpToObj(corner1?.tcp),
    approach_height_mm: answers.pallet_approach_height_mm ?? 100,
    retract_height_mm:  answers.pallet_retract_height_mm  ?? 200,
    // v2 taught frame: three corners + first-part pose.
    corner1_tcp: Array.isArray(corner1?.tcp) ? [...corner1.tcp] : null,
    corner2_tcp: Array.isArray(corner2?.tcp) ? [...corner2.tcp] : null,
    corner3_tcp: Array.isArray(corner3?.tcp) ? [...corner3.tcp] : null,
    part_tcp:    Array.isArray(part?.tcp)    ? [...part.tcp]    : null,
    teach_mode:  'far_slot',            // retained for schema; v2 ignores
    pitch_row_mm: answers.pallet_spacing_x_mm   ?? 150,
    pitch_col_mm: answers.pallet_spacing_y_mm   ?? 150,
  }
}

// Emit the wizard-side step list for a pallet program. Per-cycle motion
// uses move_to_pallet which the executor expands into the actual slot
// XYZ at runtime; pick / place taught TCPs (and their lift/approach
// offsets) are baked into normal move_linear steps with absolute TCPs
// since they're fixed once the operator records them.
function buildPalletizeSteps(answers, cellEoat = null, synapsePortmap = null) {
  const spd = answers.speed || 40
  const slow = Math.min(spd, 30)
  const medium = Math.min(spd, 40)
  const gripW = answers.gripper_width || 85
  const gripF = answers.grip_force || 50
  const mode  = answers.pallet_mode === 'depalletize' ? 'depalletize' : 'palletize'
  const rows   = answers.pallet_rows   ?? 4
  const cols   = answers.pallet_cols   ?? 4
  const layers = answers.pallet_layers ?? 1
  const cycles = rows * cols * layers
  const appH   = answers.pallet_approach_height_mm ?? 100
  const retH   = answers.pallet_retract_height_mm  ?? 200

  const gripType = answers.gripper_type || 'finger'
  // Custom-gripper IO: the operator picks the activate signal on the
  // Custom Gripper page. We emit it onto the generated steps so the
  // existing executor 'magnetic' branch (single DO toggle) fires the
  // correct port without any executor changes — the saved program
  // config still carries gripper_type === 'custom' for display.
  const customActivate = answers.gripper_activate_signal || 'DO3'
  const customConfirm  = answers.gripper_confirm_signal  || ''
  // gripper_type sent on per-step payloads. Executor only knows
  // finger / vacuum / magnetic — 'custom' is mapped to 'magnetic'
  // (single-signal IO) so its branch handles the gripper actuation.
  const stepGripType = gripType === 'custom' ? 'magnetic' : gripType

  // effector-vocabulary shared with the PBD composer + editor palette.
  // The old label-taking gripOpen/gripClose closures were the bug —
  // they used the CALLER's label verbatim (e.g. 'Grip part') even
  // when the effector was vacuum. See lib/effectorVocab for the
  // single source of truth (2026-07-30 audit instance #4).
  //
  // 2026-10-05 capability-driven blow-off: withBlowOff is derived
  // from the picked cell EOAT's actuators[] inside _cellVocabOpts
  // (true iff the record carries a {type:'blow_off', valve:...}
  // actuator). The wizard NO LONGER asks "will there be blow-off?"
  // — the tool declares its own capability in EOAT Setup; the
  // program contributes the capability's action at the correct
  // sequence anchor. No question, no branch state.
  const _vocabOpts = {
    spd, gripW, gripF, customActivate, customConfirm,
    ..._cellVocabOpts(cellEoat, synapsePortmap),
  }
  const engageSteps = (labelOverride) =>
    effectorEngage({ effector: gripType }, { ..._vocabOpts, labelOverride })
  const disengageSteps = (labelOverride) =>
    effectorDisengage({ effector: gripType }, { ..._vocabOpts, labelOverride })
  const readySteps = () =>
    effectorReady({ effector: gripType }, _vocabOpts)

  const steps = []
  steps.push({ action: 'move_home', label: 'Move to home position' })
  // 2026-10-15: waypoints between HOME and the first pick-side motion.
  // Injected BEFORE readySteps() + loopStart so they run ONCE at program
  // start (not every pallet cycle). Empty when no waypoints taught, so
  // existing pallet programs emit byte-identical to the pre-feature shape.
  steps.push(...waypointStepsForJunction(answers, 'home_to_pick', spd))
  // Effector-ready state at program start (vacuum off / gripper open /
  // magnet off). Same shared vocabulary module the PBD composer uses.
  steps.push(...readySteps())

  // Loop start index — step number (1-indexed for the executor's
  // goto-1 convention) of the first inside-loop step we're about to
  // push. move_home is step 1, so loop body starts at step 2.
  const loopStart = steps.length + 1

  if (mode === 'palletize') {
    // 2026-10-05 operator directive: vision/detect is not in scope.
    // The wizard no longer emits any `action:'detect'` step. The pick
    // sequence goes straight to the taught approach + contact; the
    // detect primitive stays available in the step palette for
    // editor-level insertion when the vision stack lands.

    const pickPoint = readTaught(answers, 'taught_pick') || {}
    const pickTcp   = Array.isArray(pickPoint.tcp) ? pickPoint.tcp : null
    const pickJoints = Array.isArray(pickPoint.joints) ? pickPoint.joints : null

    // Two-taught-poses model on the pick side: approach and lift
    // derive from a single taught 'pick' CONTACT step; the operator's
    // taught_pick landed at that contact, not above it. Derived
    // approach/retreat steps carry no taught data — the codegen
    // resolver applies the base-frame Z offset at build time.
    steps.push({
      action: 'move_linear', label: 'Approach above pick',
      speed_pct: spd, offset_z_mm: appH,
      derived_from: 'pick',
    })
    steps.push({
      action: 'move_linear', label: 'Pick position — contact',
      taught: !!pickJoints, taught_joints: pickJoints, joints: pickJoints,
      taught_tcp: pickTcp, position: pickTcp ? pickTcp.slice(0, 3) : null,
      speed_pct: slow, position_role: 'pick',
    })
    // Effector-aware engage (vacuum → "Engage vacuum" + wait for seal;
    // finger → "Grip part"; magnet → "Engage magnet"). Never emits
    // gripper-vocabulary when effector is vacuum (2026-07-30 fix).
    steps.push(...engageSteps())
    // 2026-10-15 pallet-pick verification. Same emission shape as the
    // generic buildSteps pick side — pass-through [] when the tool has
    // verification='none' (byte-identical for pre-directive tools).
    steps.push(...verificationStepsForEoat(cellEoat, { partsOnPick: 1, partIndex: 1 }))
    steps.push({
      action: 'move_linear', label: 'Retreat above pick',
      speed_pct: medium, offset_z_mm: retH,
      derived_from: 'pick',
    })
    // 2026-10-15: waypoints between PICK side and the pallet-place macro.
    // Inside the loop body (operator-taught via-points steer the arm around
    // a fixture on EVERY cycle; that's the intended semantics).
    steps.push(...waypointStepsForJunction(answers, 'pick_to_place', spd))
    // Compound pallet motion — executor computes slot, traverses,
    // descends to slot, opens gripper, lifts to retract, advances
    // cycle. Carries the gripper IO so the executor knows what to
    // fire mid-motion.
    steps.push({
      action: 'move_to_pallet', mode: 'palletize',
      label: 'Place at pallet slot [computed at runtime]',
      pallet_phase: 'place',
      gripper_type: stepGripType,
      io_open: 'DO1', io_close: 'DO0', io_vacuum: 'DO2',
      io_magnet: gripType === 'custom' ? customActivate : 'DO3',
      width_mm: gripW, force_pct: gripF,
      speed_pct: slow,
    })
  } else {
    // DEPALLETIZE — pick FROM the pallet.
    steps.push({
      action: 'move_to_pallet', mode: 'depalletize',
      label: 'Pick from pallet slot [computed at runtime]',
      pallet_phase: 'pick',
      gripper_type: stepGripType,
      io_open: 'DO1', io_close: 'DO0', io_vacuum: 'DO2',
      io_magnet: gripType === 'custom' ? customActivate : 'DO3',
      width_mm: gripW, force_pct: gripF,
      speed_pct: slow,
    })
    // 2026-10-15: waypoints between the pallet-pick macro and the place
    // side (inside the loop body — per-cycle routing around a fixture).
    steps.push(...waypointStepsForJunction(answers, 'pick_to_place', spd))

    const placePoint = readTaught(answers, 'taught_place') || {}
    const placeTcp   = Array.isArray(placePoint.tcp) ? placePoint.tcp : null
    const placeJoints = Array.isArray(placePoint.joints) ? placePoint.joints : null

    // Two-taught-poses model on the place side: approach and lift
    // derive from a single taught 'place' CONTACT step.
    steps.push({
      action: 'move_linear', label: 'Approach above place',
      speed_pct: spd, offset_z_mm: retH,
      derived_from: 'place',
    })
    steps.push({
      action: 'move_linear', label: 'Place position — contact',
      taught: !!placeTcp, taught_tcp: placeTcp, position: placeTcp ? placeTcp.slice(0, 3) : null,
      taught_joints: placeJoints, joints: placeJoints,
      speed_pct: slow, position_role: 'place',
    })
    // Effector-aware disengage. Vacuum emits Disengage vacuum + the
    // blow-off triplet in one call — no more parallel wizard-side
    // hardcoded 'Blow off' emissions to drift from the composer.
    steps.push(...disengageSteps())
    steps.push({
      action: 'move_linear', label: 'Retreat above place',
      speed_pct: medium, offset_z_mm: retH,
      derived_from: 'place',
    })
  }

  // Palletize marker. count is fixed at 1 — pallet.py::expand inlines
  // every slot per iteration; count>1 would multiply the emission
  // (Sep 15 field bug: rows*cols*layers count → capacity² placements).
  steps.push({
    action: 'loop',
    label: `Palletize marker — inline ${cycles} slots (${rows} × ${cols} × ${layers})`,
    goto: loopStart, count: 1,
    pallet_loop: true,
  })

  // 2026-10-15: waypoints between the pallet-place / place side and HOME.
  // Injected AFTER the loop marker so they run ONCE at program end
  // (post-pallet-exhaustion), not every cycle.
  steps.push(...waypointStepsForJunction(answers, 'place_to_home', spd))
  steps.push({ action: 'move_home', label: 'Return to home' })
  return steps.map((s, i) => ({ ...s, step: i + 1 }))
}

// Cell-sourced vocab options — resolves the picked EOAT entry's
// Synapse valve/input assignments into the overrides that effector
// Vocab.effectorReady/Engage/Disengage consult. When no cell entry
// is bound (cold-boot flow / cell-less programs), returns an empty
// options object so emitters fall back to their hardcoded defaults
// (preserving every existing test's exact emission).
//
// 2026-10-05 field-bug fix: without this bridge, a wizard-authored
// vacuum program emitted DO2 regardless of the operator's assigned
// Synapse valve (field screenshot: cell says V03, step showed
// Valve 02=ON). Now the picked entry's `valve` flows through to the
// vacuum/magnet emitters and the row renderer (which already routes
// via displayNameForRaw) renders "Valve 03" against a Valve-03 cell.
function _cellVocabOpts(cellEoat, synapsePortmap) {
  // 2026-10-05 capability-driven blow-off: even without a cell
  // binding, the wizard emits NO blow-off unless the picked EOAT
  // declares a blow_off actuator. Explicit withBlowOff:false
  // overrides effectorDisengage's historical default (true) so a
  // cell-less wizard run can't ship a program that fires an
  // uncommanded blow-off step.
  if (!cellEoat) return { withBlowOff: false }
  const opts = { portmap: synapsePortmap || null }
  if (cellEoat.valve) {
    // Single-valve EOATs (vacuum, magnet, custom-tool-with-one-valve,
    // finger-with-one-double-acting-valve) all have one Synapse valve
    // assignment on the entry. The emitter picks the right field by
    // effector kind — the extras are inert for mismatched effectors.
    opts.vacuumValve = cellEoat.valve
    opts.magnetValve = cellEoat.valve
    // 2026-10-08 operator field report: finger EOATs also need their
    // Synapse valve threaded through — pre-fix emission hardcoded
    // io_close='DO0' / io_open='DO1' regardless of the cell. For a
    // standard finger EOAT the single valve controls both clamp and
    // release (double-acting); the emitter re-uses the same valve id
    // for both the close and open steps.
    opts.fingerValve = cellEoat.valve
  }
  // Finger sensor inputs: cell.eoats[].inputs[] carries the sensor
  // Synapse ids in setup order. Convention — index 0 is the "part
  // gripped / close confirm" sensor, index 1 is the "fully open /
  // open confirm" sensor. Absent sensors fall through to the
  // defaults inside effectorVocab (DI0 / DI1).
  const inputs = Array.isArray(cellEoat.inputs) ? cellEoat.inputs : []
  if (inputs[0]) opts.fingerCloseConfirmInput = inputs[0]
  if (inputs[1]) opts.fingerOpenConfirmInput  = inputs[1]
  // 2026-10-05 capability-driven blow-off: a tool emits a blow-off
  // step at the CLEAR anchor (after release, before retreat-place)
  // ONLY when its cell record carries a distinct blow_off actuator.
  // The multi-actuator custom-EOAT flow (actuatorsFromCapabilities)
  // produces { type: 'blow_off', valve: '<spare>' } for the "blows
  // air" capability; _standardCellEntry for finger/vacuum does NOT
  // carry one. The wizard no longer asks "will there be blow-off?"
  // — tool capability is the ONLY source.
  const blowActuator = (cellEoat.actuators || [])
    .find((a) => a && String(a.type || '').toLowerCase() === 'blow_off'
                 && a.valve)
  if (blowActuator) {
    opts.withBlowOff = true
    opts.blowOffValve = blowActuator.valve
  } else {
    opts.withBlowOff = false
  }
  opts.cellBinding = { eoat_id: cellEoat.id }
  return opts
}

function buildSteps(answers, portmap = null,
                    cellEoat = null, synapsePortmap = null,
                    cellRegistry = null) {
  // Pallet programs follow a totally different shape — their steps
  // come from buildPalletizeSteps so the editor and executor see the
  // move_to_pallet flow rather than the generic pick/place body.
  if (answers.operation === 'palletize') {
    return buildPalletizeSteps(answers, cellEoat, synapsePortmap)
  }

  const steps = []
  const spd = answers.speed || 40
  const slow = Math.min(spd, 30)
  const medium = Math.min(spd, 40)
  const appH = answers.approach_height || 100
  const gripW = answers.gripper_width || 85
  const gripF = answers.grip_force || 50
  const op = answers.operation

  steps.push({ action: 'move_home', label: 'Move to home position' })

  // 2026-10-15: waypoints between HOME and the pick side. Injected
  // AFTER the start-home move so the arm leaves home, flies through
  // every operator-taught via-point, then does the pick approach.
  // Empty when no waypoints taught — existing programs byte-identical.
  steps.push(...waypointStepsForJunction(answers, 'home_to_pick', spd))

  // ── Standard pick / sort / machine_tend flow. Palletize takes the
  //    buildPalletizeSteps path above.

  // Custom gripper IO: operator-selected activate / confirm signals
  // from the Custom Gripper page. Default to DO3 / no-confirm to match
  // the prior 'magnetic' behaviour for programs that didn't assign IO.
  const customActivate = answers.gripper_activate_signal || 'DO3'
  const customConfirm  = answers.gripper_confirm_signal  || ''

  // All effector-linked emissions (ready, engage, disengage) route
  // through lib/effectorVocab. Same source the PBD composer uses on
  // the backend and the Add Step palette uses in the editor — one
  // vocabulary, all authoring surfaces (audit instance #4).
  //
  // 2026-10-05 capability-driven blow-off: withBlowOff flows from
  // the cell EOAT's actuators[] (see _cellVocabOpts). The wizard
  // does not ask the operator — the tool declares its capability
  // in EOAT Setup; the program contributes the capability at the
  // correct sequence anchor.
  const _vocabOpts = {
    spd, gripW, gripF, customActivate, customConfirm,
    ..._cellVocabOpts(cellEoat, synapsePortmap),
  }
  const cfgEffector = { effector: answers.gripper_type }

  steps.push(...effectorReady(cfgEffector, _vocabOpts))

  // 2026-10-05 operator directive: wizard emits ZERO detect steps.
  // The detect primitive remains in the editor's step palette +
  // ACTION_TYPES so legacy programs load and the capability can
  // be re-wired when vision is in scope — just no new emits from
  // the wizard's authoring paths.

  // Two-taught-poses-per-pair model (matches program_composer.py):
  //   approach (derived, +appH) → pick contact (TAUGHT) → engage →
  //   retreat (derived, +appH) → approach-place (derived, +appH) →
  //   place contact (TAUGHT) → disengage → retreat (derived, +appH).
  // Only the contact steps carry position_role + taught data; every
  // approach/retreat step is derived_from that role.
  //
  // 2026-10-15 operator directive: pick_and_place now carries explicit
  // pick_count + place_count (replaces the retired Fixed/Relative place
  // method). For nPicks==1 && nPlaces==1 the sequence is byte-identical
  // to the pre-directive emit (position_role 'pick' / 'place', taught
  // keys taught_pick / taught_place). For any count ≥ 2 the loop emits
  // one approach / contact / engage / retreat / waypoints / approach-
  // place / contact / disengage / retreat block per paired index — K =
  // min(nPicks, nPlaces) pairs. Extras get flagged on the Review page
  // (buildSteps doesn't emit the unused taught poses; they stay in
  // answers for future round-trip but never fire motion).
  const nPicks  = Math.max(1, Math.min(10, Number(answers.pick_count)  || 1))
  const nPlaces = Math.max(1, Math.min(10, Number(answers.place_count) || 1))
  const isMultiPair = (op === 'pick_and_place') && (nPicks !== 1 || nPlaces !== 1)
  const K = Math.min(nPicks, nPlaces)

  if (isMultiPair) {
    // Paired loop. Each pair owns its own engage + disengage + waypoints
    // (the operator-taught via-points steer around fixtures BETWEEN
    // every pair, same semantics as the per-cycle intent). The trailing
    // single-pair disengage + retreat BELOW is suppressed for multi-pair
    // via `isMultiPair` so each pair's own disengage + retreat is the
    // only emission.
    for (let i = 1; i <= K; i++) {
      steps.push({ action: 'move_linear', label: `Approach above pick ${i}`, offset_z_mm: appH, speed_pct: spd, derived_from: `pick_${i}` })
      steps.push({ action: 'move_linear', label: `Pick ${i} — contact`, speed_pct: slow, position_role: `pick_${i}` })
      steps.push(...effectorEngage(cfgEffector, _vocabOpts))
      // 2026-10-15: emit verification wait-input after engage when the
      // tool has verification. per_part fires one check per part (indexed
      // by i); per_pick fires once. Empty for 'none' tools (byte-identical).
      steps.push(...verificationStepsForEoat(cellEoat,
        { partsOnPick: K, partIndex: i }))
      steps.push({ action: 'move_linear', label: `Retreat above pick ${i}`, offset_z_mm: appH, speed_pct: medium, derived_from: `pick_${i}` })
      steps.push(...waypointStepsForJunction(answers, 'pick_to_place', spd))
      steps.push({ action: 'move_linear', label: `Approach above place ${i}`, offset_z_mm: appH, speed_pct: spd, derived_from: `place_${i}` })
      steps.push({ action: 'move_linear', label: `Place ${i} — contact`, speed_pct: slow, position_role: `place_${i}` })
      steps.push(...effectorDisengage(cfgEffector, _vocabOpts))
      steps.push({ action: 'move_linear', label: `Retreat above place ${i}`, offset_z_mm: appH, speed_pct: medium, derived_from: `place_${i}` })
    }
  } else {
    steps.push({ action: 'move_linear', label: 'Approach above pick', offset_z_mm: appH, speed_pct: spd, derived_from: 'pick' })
    steps.push({ action: 'move_linear', label: 'Pick position — contact', speed_pct: slow, position_role: 'pick' })

    steps.push(...effectorEngage(cfgEffector, _vocabOpts))
    // 2026-10-15 single-pair pick verification. Pass-through [] when the
    // tool has verification='none' → 1/1 byte-identical to today.
    steps.push(...verificationStepsForEoat(cellEoat, { partsOnPick: 1, partIndex: 1 }))

    // Retreat back above the pick contact.
    steps.push({ action: 'move_linear', label: 'Retreat above pick', offset_z_mm: appH, speed_pct: medium, derived_from: 'pick' })

    // 2026-10-15: waypoints between PICK and the next main position.
    // For machine_tend the junction id is 'pick_to_machine_load'; for
    // pick_and_place / sort it's 'pick_to_place' (sort folds its two
    // place poses onto one codegen segment — see
    // waypointJunctionsForOperation for the sort rationale). Chosen per
    // op so the semantics match the operator's wizard flow.
    if (op === 'machine_tend') {
      steps.push(...waypointStepsForJunction(answers, 'pick_to_machine_load', spd))
    } else {
      steps.push(...waypointStepsForJunction(answers, 'pick_to_place', spd))
    }
  }

  if (!isMultiPair && op === 'machine_tend') {
    // ── Machine-tending template (2026-07-30 vocabulary work + 2026-10-15
    //    multi-fixture rewrite). ──
    //
    // Required taught poses:
    //   * machine_safe   — safe-outside-machine waypoint (door
    //                      clearance pose). MUST be reached before/
    //                      after any fixture motion so the robot
    //                      doesn't collide with the machine door.
    //   * machine_load   — fixture pose (part-in-fixture contact)
    //                      for the single-fixture case; indexed
    //                      machine_load_i for N-fixture jobs (one
    //                      taught load position per vice).
    //   * unload         — final drop-off contact.
    //
    // 2026-10-15 operator field report: the wizard never asked which
    // vice(s) the machine uses, and the clamp emitter searched the
    // system IO portmap for a role-labeled row (returning [] silently
    // when none was labeled) — so machine-tending programs placed
    // the part and released the gripper WITHOUT ever firing a clamp.
    // The machine would have cycled on an unheld part.
    //
    // Fix: resolve the operator-selected fixtures from the shared
    // External Fixture store (cellRegistry.fixtures, bind-by-id via
    // answers.machine_fixture_ids). For each selected fixture emit:
    //   approach → place-in-fixture → release gripper → CLAMP (set_io
    //   on fixture.valve || fixture.out) → CONFIRM (verify_input on
    //   fixture.in_done, if assigned) → retreat → safe.
    // All N fixtures load+clamp+confirm BEFORE the cycle-start
    // handshake fires — the machine only starts once every vice is
    // confirmed clamped (or, if a vice has no confirm sensor, after
    // its clamp signal lands).
    //
    // After cycle-complete, loop per fixture to UNCLAMP + grab the
    // finished part + retreat → safe, then approach the unload
    // position once and release every retrieved part there in the
    // operator's declared order.
    //
    // Zero selected fixtures → fall back to the pre-2026-10-15 clamp
    // vocab (effectorVocab.clampWorkpiece/unclampWorkpiece) which
    // searches the system portmap by role string. This preserves
    // byte-identity for programs saved before the directive AND for
    // programs the operator deliberately marks "No fixture" (machine
    // holds the part by itself — chuck, magnetic bed, …).
    const fixtures = resolveMachineFixtures(cellRegistry, answers)
    const hasFixtures = fixtures.length > 0
    const multiFixtures = fixtures.length >= 2

    // Move to safe waypoint OUTSIDE the machine door.
    steps.push({ action: 'move_linear', label: 'Move to safe-outside-machine waypoint',
                 speed_pct: spd, position_role: 'machine_safe' })

    if (hasFixtures) {
      // ── Multi-fixture load phase ──
      // Load ALL N vices before the machine runs. Each vice gets a
      // dedicated approach + place + release + clamp + confirm +
      // retreat cycle so the robot can clear each one before loading
      // the next and the machine only starts once every vice holds
      // its workpiece.
      fixtures.forEach((fx, idx) => {
        const i = idx + 1
        const loadRole = multiFixtures ? `machine_load_${i}` : 'machine_load'
        const fxName = fx.name || `Vice ${i}`
        steps.push({ action: 'move_linear',
                     label: multiFixtures
                       ? `Approach ${fxName}`
                       : 'Approach machine fixture',
                     offset_z_mm: appH, speed_pct: spd,
                     derived_from: loadRole })
        steps.push({ action: 'move_linear',
                     label: multiFixtures
                       ? `Place in ${fxName} — contact`
                       : 'Place in fixture — contact',
                     speed_pct: Math.min(spd, 20),
                     position_role: loadRole })
        // Release the gripper FIRST (before the vice clamps) so the
        // robot does not pull against a closing vice jaw. Safety
        // sequencing: gripper releases → robot clear of clamp zone →
        // then set the clamp. (The pre-2026-10-15 flow clamped first,
        // then released — which worked only because the clamp was a
        // single sustained-DO that physically couldn't close on the
        // robot. Multi-vice programs with air cylinders can close
        // fast enough to catch the gripper, so release-first is
        // mandatory for the new flow.)
        steps.push(...effectorDisengage(cfgEffector, {
          ..._vocabOpts, withBlowOff: false,
          labelOverride: multiFixtures
            ? `Release part into ${fxName}`
            : 'Release part into fixture',
        }))
        // Fire the clamp IO + optional confirm. clampFixtureSteps
        // emits plain operator-facing labels — "Clamp the vice (X)" /
        // "Confirm vice clamped (X)" — and tags each step with
        // fixture_id so hand-edits can round-trip to the originating
        // fixture record.
        steps.push(...clampFixtureSteps(fx))
        // Retreat from the fixture, then back to safe so the robot
        // is clear of the machine before the next fixture is loaded
        // (or before cycle-start fires).
        steps.push({ action: 'move_linear',
                     label: multiFixtures
                       ? `Retreat from ${fxName}`
                       : 'Retreat from fixture',
                     offset_z_mm: appH, speed_pct: slow,
                     derived_from: loadRole })
        steps.push({ action: 'move_linear',
                     label: 'Return to safe-outside-machine',
                     speed_pct: medium, derived_from: 'machine_safe' })
      })
    } else {
      // Legacy no-fixture path: pre-2026-10-15 shape, byte-identical.
      steps.push({ action: 'move_linear', label: 'Approach machine fixture',
                   offset_z_mm: appH, speed_pct: spd, derived_from: 'machine_load' })
      steps.push({ action: 'move_linear', label: 'Place in fixture — contact',
                   speed_pct: Math.min(spd, 20), position_role: 'machine_load' })
      // Clamp FIRST (pre-directive ordering kept for the legacy path
      // so old saved programs still match byte-for-byte).
      steps.push(...clampWorkpiece(portmap))
      steps.push(...effectorDisengage(cfgEffector, {
        ..._vocabOpts, withBlowOff: false,
        labelOverride: 'Release part into fixture',
      }))
      steps.push({ action: 'move_linear', label: 'Retreat from fixture',
                   offset_z_mm: appH, speed_pct: slow, derived_from: 'machine_load' })
      steps.push({ action: 'move_linear', label: 'Return to safe-outside-machine',
                   speed_pct: medium, derived_from: 'machine_safe' })
    }
    // Start the machine cycle — PULSED DO. Vocab handles the
    // set 1 → wait pulse_ms → set 0 triplet.
    //
    // 2026-10-15 operator field report: the wizard's "Which I/O signals
    // control the machine?" page writes answers.io_cycle_start +
    // answers.io_cycle_done directly to the program's answers blob,
    // NOT to the shared system IO portmap. The vocab emitter used to
    // search ONLY the portmap for a role-labeled Cycle Start / Cycle
    // Done row — so an operator who picked "DO4" + "DI3" in the
    // wizard but had no portmap row labeled "Cycle start" / "Cycle
    // done" silently got NO handshake in the generated program (the
    // robot loaded the fixture, retreated, reached back in for the
    // finished part without ever telling the machine to run). The
    // emitter now accepts override_do / override_di → we pass the
    // wizard's answers through verbatim. Safety-critical — the
    // machine must be told to run AFTER the robot has retreated to
    // safe and the robot must wait for 'cycle done' BEFORE
    // re-approaching the fixture.
    //
    // Timeout key fix: the wizard writes answers.cycle_timeout (not
    // cycle_timeout_s — the slider's "s" is the unit label, not a
    // key suffix). Read it first, fall back to the historical
    // cycle_timeout_s key for any program that saved under that
    // shape, else default 60s.
    const _cycleTimeoutS = Number(answers.cycle_timeout)
      || Number(answers.cycle_timeout_s)
      || 60
    steps.push(...startMachineCycle(portmap, {
      pulse_ms: answers.machine_pulse_ms || 500,
      override_do: answers.io_cycle_start,
    }))
    // Wait for machine cycle done — blocking verify_input on the
    // Cycle done DI with a configurable outer timeout. Emitter stamps
    // reason:'machine did not signal complete' so the executor
    // surfaces the plain operator-facing stop reason on timeout.
    steps.push(...waitMachineCycle(portmap, {
      timeout_ms: _cycleTimeoutS * 1000,
      override_di: answers.io_cycle_done,
    }))
    // ── Unload side ────────────────────────────────────────────
    // For N fixtures: loop per vice — approach, grip finished part,
    // unclamp, retreat, back to safe — then approach the unload
    // position once and release the LAST retrieved part there. The
    // operator teaches a single unload drop zone; multi-fixture jobs
    // that need per-fixture unload zones can be split in the editor.
    //
    // For the legacy no-fixture path: single approach / grip /
    // unclamp / retreat / safe → approach unload → place.
    if (hasFixtures) {
      fixtures.forEach((fx, idx) => {
        const i = idx + 1
        const loadRole = multiFixtures ? `machine_load_${i}` : 'machine_load'
        const fxName = fx.name || `Vice ${i}`
        steps.push({ action: 'move_linear',
                     label: multiFixtures
                       ? `Approach ${fxName} (finished part)`
                       : 'Approach fixture (finished part)',
                     offset_z_mm: appH, speed_pct: slow,
                     derived_from: loadRole })
        steps.push({ action: 'move_linear',
                     label: multiFixtures
                       ? `${fxName} — contact (finished part)`
                       : 'Fixture — contact (finished part)',
                     speed_pct: Math.min(spd, 20),
                     position_role: loadRole })
        steps.push(...effectorEngage(cfgEffector, {
          ..._vocabOpts, labelOverride: (effectorOf(cfgEffector) === 'finger'
            ? `Grip finished part (${fxName})`
            : `Pick finished part (${fxName})`),
        }))
        // Release the vice ONLY after the gripper has engaged the
        // finished part. Safety sequencing: unclamp while the robot
        // holds the part so the part can't fall if the vice spring-
        // returns.
        steps.push(...unclampFixtureSteps(fx))
        steps.push({ action: 'move_linear',
                     label: multiFixtures
                       ? `Retreat from ${fxName} with finished part`
                       : 'Retreat with finished part',
                     offset_z_mm: appH, speed_pct: medium,
                     derived_from: loadRole })
        steps.push({ action: 'move_linear',
                     label: 'Return to safe-outside-machine',
                     speed_pct: medium, derived_from: 'machine_safe' })
      })
    } else {
      // Legacy single-fixture / no-fixture unload. clampWorkpiece's
      // unclamp mirror runs the role-labeled DI/DO lookup; preserves
      // byte-identity for the pre-directive flow.
      steps.push({ action: 'move_linear', label: 'Approach fixture (finished part)',
                   offset_z_mm: appH, speed_pct: slow, derived_from: 'machine_load' })
      steps.push({ action: 'move_linear', label: 'Fixture — contact (finished part)',
                   speed_pct: Math.min(spd, 20), position_role: 'machine_load' })
      steps.push(...effectorEngage(cfgEffector, {
        ..._vocabOpts, labelOverride: (effectorOf(cfgEffector) === 'finger'
          ? 'Grip finished part' : 'Pick finished part'),
      }))
      steps.push(...unclampWorkpiece(portmap))
      steps.push({ action: 'move_linear', label: 'Retreat with finished part',
                   offset_z_mm: appH, speed_pct: medium, derived_from: 'machine_load' })
      steps.push({ action: 'move_linear', label: 'Return to safe-outside-machine',
                   speed_pct: medium, derived_from: 'machine_safe' })
    }
    // 2026-10-15: waypoints between the (completed) MACHINE LOAD cycle
    // and the UNLOAD side — operator-taught via-points steer the arm
    // from the machine-safe pose to approach-unload.
    steps.push(...waypointStepsForJunction(answers, 'machine_load_to_unload', spd))
    // Unload contact — separate taught role.
    steps.push({ action: 'move_linear', label: 'Approach unload',
                 offset_z_mm: appH, speed_pct: spd, derived_from: 'unload' })
    steps.push({ action: 'move_linear', label: 'Unload position — contact',
                 speed_pct: slow, position_role: 'unload' })
  } else if (!isMultiPair) {
    // Default place flow (pick_and_place / sort). Multi-pair pick_and_place
    // already emitted its per-pair approach-place + contact + disengage +
    // retreat inside the loop above; this branch is single-pair only.
    steps.push({ action: 'move_linear', label: 'Approach above place', offset_z_mm: appH, speed_pct: spd, derived_from: 'place' })
    steps.push({ action: 'move_linear', label: 'Place position — contact', speed_pct: slow, position_role: 'place' })
  }

  // Trailing disengage + final retreat belong to the single-pair /
  // machine_tend path. Multi-pair's per-pair disengage + retreat are
  // already inside the loop, so suppress the duplicate here.
  if (!isMultiPair) {
    steps.push(...effectorDisengage(cfgEffector, _vocabOpts))

    // Retreat back above the final release contact (place or unload).
    const retreatRole = (op === 'machine_tend') ? 'unload' : 'place'
    const retreatLabel = (op === 'machine_tend') ? 'Retreat from unload' : 'Retreat above place'
    steps.push({ action: 'move_linear', label: retreatLabel, offset_z_mm: appH, speed_pct: medium, derived_from: retreatRole })
  }
  // 2026-10-15: waypoints between the final place / unload and HOME.
  // Junction id depends on op — unload_to_home for machine_tend, else
  // place_to_home for pick_and_place / sort. Injected AFTER the final
  // retreat so the arm leaves the release pose, flies through every
  // taught via-point, then returns home. Multi-pair takes the
  // place_to_home junction too (the last pair's retreat left the arm
  // at retreat-above-place_K, same seam shape as single-pair).
  if (op === 'machine_tend') {
    steps.push(...waypointStepsForJunction(answers, 'unload_to_home', spd))
  } else {
    steps.push(...waypointStepsForJunction(answers, 'place_to_home', spd))
  }
  steps.push({ action: 'move_home', label: 'Return to home' })

  if (answers.repeat === 'continuous') {
    steps.push({ action: 'loop', label: 'Repeat continuously', goto: 1, count: 0 })
  } else if (answers.repeat === 'count') {
    steps.push({ action: 'loop', label: 'Repeat ' + (answers.repeat_count || 10) + ' times', goto: 1, count: answers.repeat_count || 10 })
  }

  // Inject taught data from the wizard's teach pages so the editor's
  // green T badges appear immediately for the positions the operator
  // recorded. Under the two-taught-poses-per-pair model, the taught
  // step is the CONTACT step marked with position_role — approach and
  // retreat are derived and never carry taught data. Matching by
  // position_role rather than action label keeps this stable across
  // label rewording.
  function applyTaught(s, point) {
    if (!point) return s
    return {
      ...s,
      taught: true,
      taught_joints: point.joints,
      taught_tcp:    point.tcp || null,
      taught_at:     point.taught_at || new Date().toISOString(),
      joints:        point.joints,
      ...(point.tcp ? { position: point.tcp.slice(0, 3) } : {}),
    }
  }

  const cfg = answers
  const numbered = steps.map((s, i) => ({ ...s, step: i + 1 }))

  // Taught points come from the dedicated TeachSequence at the end of
  // the wizard. readTaught() returns null for skipped / empty entries
  // so the corresponding step keeps its untaught state (the editor
  // shows the red "!" badge).
  const homeP   = readTaught(cfg, 'taught_home')
  const pickP   = readTaught(cfg, 'taught_pick')
  const placeP  = readTaught(cfg, 'taught_place')
  const loadP   = readTaught(cfg, 'taught_machine_load')
  const unloadP = readTaught(cfg, 'taught_unload')
  // 2026-10-15: safe-outside-machine waypoint joins the taught-pose
  // set. The teach sequence now offers it; applyToRole targets the
  // position_role 'machine_safe' step the machine_tend template
  // emits (currently the first step after the pick retreat, re-used
  // on every return-to-safe between fixture entries + after cycle
  // completion).
  const machineSafeP = readTaught(cfg, 'taught_machine_safe')

  const applyToRole = (role, point) => {
    if (!point) return
    const i = numbered.findIndex((s) => s.position_role === role
                                     && !s.derived_from)
    if (i >= 0) numbered[i] = applyTaught(numbered[i], point)
  }

  // Home has two occurrences (start + return); apply to both.
  if (homeP) {
    const homeIdxs = numbered.map((s, i) => s.action === 'move_home' ? i : -1).filter((i) => i >= 0)
    homeIdxs.forEach((i) => { numbered[i] = applyTaught(numbered[i], homeP) })
  }
  applyToRole('pick',         pickP)
  applyToRole('place',        placeP)
  applyToRole('machine_load', loadP)
  applyToRole('unload',       unloadP)
  applyToRole('machine_safe', machineSafeP)

  // 2026-10-15 multi-fixture machine-tending: indexed load positions
  // for 2+ selected vices. Each taught_machine_load_i lands on its
  // matching position_role 'machine_load_i' step the per-fixture
  // loop emitted above.
  if (op === 'machine_tend') {
    const _mFixtures = resolveMachineFixtures(cellRegistry, answers)
    if (_mFixtures.length >= 2) {
      _mFixtures.forEach((_fx, idx) => {
        const i = idx + 1
        const p = readTaught(cfg, `taught_machine_load_${i}`)
        applyToRole(`machine_load_${i}`, p)
      })
    }
  }

  // 2026-10-15 multi-pair pick_and_place: resolve indexed taught_pick_i /
  // taught_place_i keys against the position_role: 'pick_i' / 'place_i'
  // steps the paired loop emitted. Looping to max(nPicks, nPlaces) so
  // every taught pose that CAN land does — the loop body only ran K
  // pairs (K = min), so taught poses with index > K have no matching
  // step and quietly fall through (they are the "unused" surfacing the
  // Review page will warn about in a follow-up ship; the taught data
  // is preserved in answers for a round-trip).
  if (isMultiPair) {
    const maxN = Math.max(nPicks, nPlaces)
    for (let i = 1; i <= maxN; i++) {
      const pickI  = readTaught(cfg, `taught_pick_${i}`)
      const placeI = readTaught(cfg, `taught_place_${i}`)
      applyToRole(`pick_${i}`,  pickI)
      applyToRole(`place_${i}`, placeI)
    }
  }

  return numbered
}

// ────────────────────────────────────────────────────────
// Main wizard component
// ────────────────────────────────────────────────────────

export default function ProgramWizard({ onClose, onSaved }) {
  // Portmap for machine-tending emitters — clamp / cycle start / cycle
  // done / clamp confirmed. buildSteps receives it below so those
  // steps land in the wizard's output only when the operator has
  // actually assigned the roles on the I/O page.
  const wizardPortmap = useIOPortmap()
  const wizardSynapsePortmap = useSynapsePortmap()
  // Cell registry (end-of-arm tools + fixtures). Loaded once on
  // mount so buildSteps can resolve the picked cell_eoat_id to the
  // operator's actual Synapse valve assignment — the fix for the
  // 2026-10-05 "Valve 02 for Valve 03 tool" field bug (effectorVocab
  // was hardcoding default DO2 regardless of the cell binding).
  const [cellRegistry, setCellRegistry] = useState(null)
  useEffect(() => {
    let alive = true
    getCell().then((c) => { if (alive) setCellRegistry(c) })
             .catch(() => {})
    return () => { alive = false }
  }, [])
  // 2026-10-15: mirror the cell snapshot into the module ref so the
  // PAGES-list skip predicates (which only receive answers) can read
  // the selected EOAT without threading an extra arg through the
  // engine. Cleared on unmount so a stale snapshot from a prior
  // wizard launch cannot leak into a fresh one.
  useEffect(() => {
    _wizardCellRegistryRef = cellRegistry
    return () => { _wizardCellRegistryRef = null }
  }, [cellRegistry])
  const [pageIdx, setPageIdx] = useState(0)
  const [answers, setAnswers] = useState({
    // Silently-defaulted: the wizard no longer asks about speed or motion
    // profile. The Program tab's motion profile card is where operators
    // adjust both after creation. Keep these keys populated so any
    // intermediate buildSteps helper that reads `answers.speed` keeps
    // emitting Medium-speed moves.
    speed: 60,
    motion_profile_name: 'Balanced',
    approach_height: 100,
    gripper_width: 85,
    grip_force: 50,
    vacuum_threshold: 70,
    repeat: 'once',
    repeat_count: 10,
    program_name: '',
  })
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState([0])
  // reusedSteps tracks which TeachSequence step indices the operator
  // confirmed via the Reuse button (vs. teaching fresh). Lifted here so
  // the Review page can show the distinction after the teach sequence
  // completes — TeachSequence's internal state would be lost on unmount.
  const [reusedSteps, setReusedSteps] = useState({})

  // 2026-09-08 wizard simplification: auto-assign cell_id when
  // exactly one commissioned cell exists. Silent null otherwise
  // (no page, no toast — cell-less programs load / push / run
  // exactly as today per the footer "No cell — environment guard
  // off" doctrine that's been the running default all week).
  useEffect(() => {
    let alive = true
    fetch('/api/cells').then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!alive || !j) return
        const commissioned = (j.cells || []).filter(
          (c) => c && c.commissioning_complete)
        if (commissioned.length === 1) {
          setAnswers((prev) => prev.cell_id
            ? prev
            : { ...prev, cell_id: commissioned[0].cell_id })
        }
        // 0 or >1: leave cell_id undefined; buildSteps sends null.
      })
      .catch(() => { /* silent — cell_id stays null */ })
    return () => { alive = false }
  }, [])

  const setAnswer = (key, value) => setAnswers(prev => ({ ...prev, [key]: value }))

  const goNext = (overrides) => {
    // Advance-with-value: React's setAnswer is asynchronous, so if the
    // caller just set an answer whose value drives the next page's skip
    // predicate, `answers` here is still stale. Callers pass that new
    // value via `overrides` so skip() sees the fresh selection.
    const merged = overrides ? { ...answers, ...overrides } : answers
    let next = pageIdx + 1
    while (next < PAGES.length && PAGES[next].skip?.(merged)) next++
    if (next < PAGES.length) {
      setPageIdx(next)
      setHistory(prev => [...prev, next])
    }
  }

  const goBack = () => {
    if (history.length > 1) {
      const newHistory = history.slice(0, -1)
      setHistory(newHistory)
      setPageIdx(newHistory[newHistory.length - 1])
    }
  }

  const builtCellEoat = findCellEoat(cellRegistry, answers.cell_eoat_id)
  const builtSteps = buildSteps(
    answers, wizardPortmap, builtCellEoat, wizardSynapsePortmap,
    cellRegistry)

  const handleSave = async () => {
    // 2026-10-15 machine-fixture refusal: if the operator picked
    // fixture(s) in the Machine Fixtures step but any selected fixture
    // lacks a clamp signal (no fixture.valve + no fixture.out), save
    // is refused with a plain-copy toast. Prevents shipping a program
    // that would set the part down and silently never clamp it.
    if (answers.operation === 'machine_tend'
        && Array.isArray(answers.machine_fixture_ids)
        && answers.machine_fixture_ids.length) {
      const _mFixtures = resolveMachineFixtures(cellRegistry, answers)
      const _refusal = missingClampSignalRefusal(_mFixtures)
      if (_refusal) {
        try { useStore.getState().addToast?.(_refusal, 'error') } catch { /* ignore */ }
        setSaving(false)
        return
      }
    }
    setSaving(true)
    try {
      // Pallet programs need the typed pallet + pick/place TCP block at
      // the top of program.config so the executor (and the Monitor
      // widget) can find them without rummaging through wizard-internal
      // answer keys. The full answers object is still kept for round-
      // tripping into the wizard later.
      let config = { ...answers }
      // Speed and motion profile are no longer asked in the wizard. We
      // force the silent Medium / Balanced defaults onto the saved
      // program. The Program tab's motion profile card is where these
      // get tuned after creation.
      const SILENT_SPEED_PCT = 60
      const SILENT_MOTION_PROFILE = 'Balanced'
      config.speed = SILENT_SPEED_PCT
      config.speed_pct = SILENT_SPEED_PCT
      config.motion_profile_name = SILENT_MOTION_PROFILE
      // Payload normalization: the wizard stores `payload_kg='skip'`
      // when the operator chose "Not sure yet". Persist that as an
      // explicit null so codegen + editor + run modal all agree the
      // program has no payload set. Empty tool_name / no-CoG entries
      // stay out of config so we don't ship junk keys.
      if (config.payload_kg === 'skip' || config.payload_kg === undefined) {
        config.payload_kg = null
      }
      if (!config.tool_name || String(config.tool_name).trim() === '') {
        delete config.tool_name
      }
      // 2026-09-08 Custom EOAT item 4: promote wizard-collected
      // custom_tool_id to config.tool_id so codegen emits the
      // toolOffset header + tool=__tool suffix on every mov*.
      if (answers.custom_tool_id) {
        config.tool_id = answers.custom_tool_id
      }
      // Wizard-internal state that shouldn't ship on config.
      delete config.custom_tool_substep
      delete config.custom_tool_id

      // 2026-09-10 hookup restructure: hookup guidance now lives in
      // the standalone EOAT Setup wizard (per-tool, not per-
      // program). Snapshot the tool's confirmation record onto
      // program.config so downstream codegen consumers (effectorVocab
      // `withBlowOff`, `hookup_no_sensor` invariant) stay unchanged.
      // Failure to read → leave config untouched (blow-off default
      // remains opt-out true, matching prior silent-default behavior).
      try {
        const gt = answers.gripper_type || 'finger'
        const key = toolHookupKey(gt, answers.custom_tool_id || config.tool_id || null)
        const rec = await getToolHookup(key)
        if (rec) {
          if (rec.no_sensor && typeof rec.no_sensor === 'object') {
            config.hookup_no_sensor = { ...rec.no_sensor }
          }
          if (rec.optional && typeof rec.optional === 'object') {
            for (const k of Object.keys(rec.optional)) {
              config[k] = rec.optional[k]
            }
          }
          if (rec.confirmed_at) {
            config.hookup_confirmed_at = rec.confirmed_at
          }
        }
      } catch { /* thread line already advertises status; do not block save */ }
      if (config.payload_cog_mm && typeof config.payload_cog_mm === 'object'
          && Object.keys(config.payload_cog_mm).length === 0) {
        delete config.payload_cog_mm
      }
      if (answers.operation === 'palletize') {
        const pallet = buildPalletConfig(answers)
        config.pallet      = pallet
        // 2026-07-30: pallet_place spec (the shape PalletPlaceSpec
        // consumes on the backend) is also stashed under
        // config.pallet_place so /api/programs/{id}/pallet_slots
        // reads the 3-point taught frame + measured pitches without
        // reconstructing from step metadata.
        config.pallet_place = {
          rows:            pallet.rows,
          cols:            pallet.cols,
          layers:          pallet.layers,
          pitch_row_mm:    pallet.pitch_row_mm,
          pitch_col_mm:    pallet.pitch_col_mm,
          layer_height_mm: pallet.layer_height_mm,
          order:           (pallet.fill_order === 'col')     ? 'col_major'
                         : (pallet.fill_order === 'snake')   ? 'snake'
                         : 'row_major',
          row_axis:        '+X',
          col_axis:        '+Y',
          // v2 (2026-07-30): four taught points. Backend
          // PalletPlaceSpec.from_dict migrates v1 saves (only
          // corner_a/b/c present) into these fields transparently.
          corner1_tcp:     pallet.corner1_tcp,
          corner2_tcp:     pallet.corner2_tcp,
          corner3_tcp:     pallet.corner3_tcp,
          part_tcp:        pallet.part_tcp,
          teach_mode:      pallet.teach_mode,
        }
        config.pallet_mode = answers.pallet_mode === 'depalletize' ? 'depalletize' : 'palletize'
        config.source      = config.pallet_mode === 'palletize' ? 'camera_library' : 'fixed_grid'
        config.speed_pct   = SILENT_SPEED_PCT
        if (answers.pallet_mode === 'depalletize') {
          const placeP = readTaught(answers, 'taught_place')
          config.place_tcp = tcpToObj(placeP?.tcp)
        } else {
          const pickP = readTaught(answers, 'taught_pick')
          config.pick_tcp = tcpToObj(pickP?.tcp)
        }
      }
      // Always emit a typed gripper block — the 3D viewer reads this
      // to decide whether to load a custom gripper GLB.
      const gripper = {
        type:             answers.gripper_type || 'finger',
        width_mm:         answers.gripper_width || 85,
        force_pct:        answers.grip_force || 50,
        vacuum_threshold: answers.vacuum_threshold || 70,
      }
      if ((answers.gripper_type || 'finger') === 'custom') {
        gripper.gripper_type    = 'custom'
        gripper.gripper_name    = (answers.gripper_name || answers.gripper_upload_name || '').trim()
        gripper.gripper_model_id = answers.gripper_model_id || null
        gripper.gripper_glb_url = answers.gripper_glb_url || null
        gripper.gripper_stl_url = answers.gripper_stl_url || null
        gripper.activate_signal = answers.gripper_activate_signal || null
        gripper.confirm_signal  = answers.gripper_confirm_signal  || null
        if (answers.gripper_dimensions) gripper.dimensions = answers.gripper_dimensions
      } else {
        gripper.gripper_type = gripper.type
      }
      config.gripper = gripper
      const res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: answers.program_name,
          description: answers.operation ? answers.operation.replace(/_/g, ' ') : '',
          steps: builtSteps,
          tags: [answers.operation],
          config,
          cell_id: answers.cell_id || null,
          motion_profile_name: SILENT_MOTION_PROFILE,
          motion_profile_override_enabled: false,
          motion_optimization_enabled: true,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        // Refresh the shared programs list so ProgramLibrary +
        // anywhere else reading programsList sees the new program
        // without waiting for its next mount-fetch.
        try { useStore.getState().refreshPrograms?.() } catch {}
        onSaved?.(data.program)
        onClose()
      }
    } catch {}
    setSaving(false)
  }

  // Safety guard: clamp pageIdx to a valid index. If goNext / history ever
  // resolves to an out-of-range or skipped page, fall through to the next
  // renderable page instead of letting `PAGES[pageIdx]` be undefined and
  // crashing React. Belt-and-braces: goNext already bounds-checks, but a
  // future regression in skip-rule chaining shouldn't be able to crash the
  // wizard.
  let safeIdx = pageIdx
  if (safeIdx < 0 || safeIdx >= PAGES.length || !PAGES[safeIdx]) {
    safeIdx = 0
  } else if (PAGES[safeIdx].skip?.(answers)) {
    let probe = safeIdx + 1
    while (probe < PAGES.length && PAGES[probe].skip?.(answers)) probe++
    safeIdx = probe < PAGES.length ? probe : PAGES.length - 1
  }
  // Self-heal: if the render-time remap moved us past pageIdx (because a
  // handler set state that made pageIdx's page transiently skip-hidden
  // — the pageIdx/safeIdx desync class that caused the "click once,
  // select; click twice, advance" bug), sync setPageIdx to what's
  // actually on screen. Otherwise the NEXT click's goNext walks forward
  // from the STALE stored pageIdx, lands back on the rendered page, and
  // the operator sees "no advance" until a second click. Every handler
  // now passes goNext overrides to avoid this in the first place; the
  // effect is defense-in-depth so a future handler that forgets can't
  // silently reintroduce the class.
  useEffect(() => {
    if (safeIdx !== pageIdx) {
      // eslint-disable-next-line no-console
      console.warn('[ProgramWizard] pageIdx/safeIdx drift:',
        { pageIdx, safeIdx, page: PAGES[safeIdx]?.id })
      setPageIdx(safeIdx)
      setHistory((prev) => {
        // Replace the tail of history with safeIdx so Back doesn't
        // re-enter the skip-hidden page.
        if (prev[prev.length - 1] === safeIdx) return prev
        return [...prev.slice(0, -1), safeIdx]
      })
    }
  }, [safeIdx, pageIdx])
  const page = PAGES[safeIdx]
  const progressPct = ((history.length - 1) / (PAGES.length - 1)) * 100

  // Each page render uses hooks (useState / useEffect / etc.) inside its
  // inline `render` function. If we invoke it as a plain function call
  // (`{page.render(props)}`) the hooks land on the parent ProgramWizard
  // fiber — meaning the parent's hook count changes whenever pageIdx
  // points to a page whose render uses different hooks, and React throws
  // "Rendered more hooks than during the previous render" at that
  // transition.
  //
  // Treating page.render as a component type (JSX element) gives each
  // page its own fiber and hook stack. key={safeIdx} on the surrounding
  // WizardStepErrorBoundary forces a fresh mount per page so even
  // repeat visits start with a clean stack AND a cleared boundary.
  const PageBody = page && typeof page.render === 'function' ? page.render : null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      ...kbSafeOverlayStyle(),
    }}>
      <div className="kb-safe-modal-shell" style={{
        width: '95%', maxWidth: 800,
        background: '#fff', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
        // Audit #8E (2026-10-14 iPad tuning): the shell is a flex
        // COLUMN with three children (header + progress + scroll).
        // kbSafeModalContentStyle(95)'s paddingBottom lived HERE
        // pre-fix, and when the keyboard opened the padding grew to
        // ~324 px INSIDE the box-sizing: border-box height, stealing
        // from every flex sibling — the scroll child collapsed to a
        // 60-120 px strip on landscape and the operator saw "the
        // field is barely visible". The split helpers put maxHeight
        // + boxSizing here (where they belong on the sizing
        // container) and move paddingBottom down to the scroll
        // child (where it belongs — breathing room for the last
        // field in the scrollable list).
        ...kbSafeFlexShellStyle(95),
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {history.length > 1 && (
            <button onClick={goBack} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, color: '#6b7280', padding: '2px 6px',
            }}>{'<'}</button>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              New Program Wizard
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 18, color: '#9ca3af', padding: '2px 8px',
          }}>X</button>
        </div>

        {/* Progress bar */}
        <div style={{ height: 3, background: '#e5e7eb' }}>
          <div style={{
            height: '100%', background: '#2563EB',
            width: progressPct + '%',
            transition: 'width 300ms',
          }} />
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          // Audit #8E (2026-10-14): paddingBottom moved here from
          // the shell. On the shell it stole flex-sibling space when
          // --kb-inset grew. On the scroll child it just gives the
          // last field in the scrollable list breathing room above
          // the keyboard — same semantic as kbSafeModalContentStyle
          // on a simple-form modal (LoginModal etc.).
          ...kbSafeScrollChildStyle(24),
        }}>
          {PageBody ? (
            <WizardStepErrorBoundary
              key={safeIdx}
              stepId={page?.id}
              onBack={history.length > 1 ? goBack : null}
            >
              <PageBody
                answers={answers}
                setAnswer={setAnswer}
                goNext={goNext}
                goBack={goBack}
                steps={builtSteps}
                saving={saving}
                onSave={handleSave}
                reusedSteps={reusedSteps}
                setReusedSteps={setReusedSteps}
              />
            </WizardStepErrorBoundary>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                This step could not be loaded.
              </div>
              <button onClick={goBack} style={{
                padding: '10px 18px', fontSize: 13, fontWeight: 600,
                background: '#2563EB', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer',
              }}>Back</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

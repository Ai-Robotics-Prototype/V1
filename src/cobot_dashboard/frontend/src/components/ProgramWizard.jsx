import { useState, useEffect, useRef, useCallback } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { HoldButton } from './JogControls'

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

function QuestionCard({ question, description, children }) {
  return (
    <div style={{ padding: 32, maxWidth: 600, margin: '0 auto' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111', marginBottom: 8, lineHeight: 1.3 }}>
        {question}
      </div>
      {description && (
        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 28, lineHeight: 1.5 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  )
}

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
function WizardJogArrow({
  onPressStart, onPressTick, onPressEnd,
  color, label, rotation, size = 64, svgSize,
  disabled,
}) {
  const sp = svgSize || Math.max(24, Math.floor(size * 0.28))
  const lp = Math.max(10, Math.floor(size * 0.10))
  return (
    <HoldButton
      jogStyle="CONTINUOUS"
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

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '0 auto' }}>
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

      <div style={{
        padding: 12, background: '#f8fafc', borderRadius: 8,
        border: '1px solid #e5e7eb', marginBottom: 16,
        fontFamily: 'monospace', fontSize: 12,
      }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <span style={{ color: '#6b7280' }}>Joints: </span>
            <span style={{ color: '#111', fontWeight: 700 }}>
              [{liveJoints.map((j) => j.toFixed(1)).join(', ')}]°
            </span>
          </div>
          <div>
            <span style={{ color: '#6b7280' }}>TCP: </span>
            <span style={{ color: '#111', fontWeight: 700 }}>
              [{liveTcp.slice(0, 3).map((t) => Number(t).toFixed(3)).join(', ')}]
            </span>
          </div>
        </div>
      </div>

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

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={recordPosition} style={{
          flex: 2, padding: '16px', fontSize: 16, fontWeight: 700,
          background: taught ? '#16A34A' : '#2563EB', color: '#fff',
          border: 'none', borderRadius: 10, cursor: 'pointer',
        }}>
          {taught ? 'Re-record Position' : 'Record This Position'}
        </button>
        {taught && (
          <button onClick={onNext} style={{
            flex: 1, padding: '16px', fontSize: 16, fontWeight: 700,
            background: '#16A34A', color: '#fff',
            border: 'none', borderRadius: 10, cursor: 'pointer',
          }}>Next</button>
        )}
      </div>
      {onSkip && !taught && (
        <button onClick={onSkip} style={{
          width: '100%', marginTop: 8, padding: '10px', fontSize: 13,
          background: 'transparent', color: '#6b7280',
          border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
        }}>
          Skip — use auto-detection instead
        </button>
      )}
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

// ────────────────────────────────────────────────────────
// Custom-gripper page support
// ────────────────────────────────────────────────────────

// STL viewer reused for the Custom Gripper preview. Same lighting /
// material / OrbitControls / grid setup as the parts library viewer
// so the operator sees the gripper rendered identically to a part.
function GripperStlModel({ stlUrl }) {
  const [mesh, setMesh] = useState(null)
  useEffect(() => {
    if (!stlUrl) { setMesh(null); return }
    let cancelled = false
    const loader = new STLLoader()
    loader.load(
      stlUrl,
      (geometry) => {
        if (cancelled) return
        geometry.computeBoundingBox()
        geometry.center()
        const box = geometry.boundingBox
        const size = Math.max(
          box.max.x - box.min.x,
          box.max.y - box.min.y,
          box.max.z - box.min.z,
        ) || 1
        const scale = 0.2 / size
        geometry.scale(scale, scale, scale)
        const m = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: '#A8B0C0', metalness: 0.5, roughness: 0.35 }),
        )
        m.castShadow = true
        setMesh(m)
      },
      undefined,
      () => { if (!cancelled) setMesh(null) },
    )
    return () => { cancelled = true }
  }, [stlUrl])
  if (!mesh) return null
  return <primitive object={mesh} />
}

function GripperPreviewCanvas({ stlUrl, name, dims, onRemove }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ height: 300, background: '#fafafa', position: 'relative' }}>
        <Canvas camera={{ position: [0.25, 0.18, 0.25], fov: 45 }} shadows>
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 5, 5]} intensity={0.9} castShadow />
          <directionalLight position={[-5, 3, -5]} intensity={0.3} />
          <gridHelper args={[0.4, 16, '#d1d5db', '#e5e7eb']} position={[0, -0.1, 0]} />
          {/* Shadow catcher beneath the model. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
            <planeGeometry args={[0.6, 0.6]} />
            <shadowMaterial transparent opacity={0.18} />
          </mesh>
          <GripperStlModel stlUrl={stlUrl} />
          <OrbitControls enablePan={false} target={[0, 0, 0]} />
        </Canvas>
        {onRemove && (
          <button onClick={onRemove}
            style={{
              position: 'absolute', top: 8, right: 8,
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              background: 'rgba(255,255,255,0.92)', color: '#DC2626',
              border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer',
            }}>
            Remove
          </button>
        )}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{name || 'Custom Gripper'}</div>
        {dims && (
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {Number(dims.w_cm || 0).toFixed(1)} × {Number(dims.d_cm || 0).toFixed(1)} × {Number(dims.h_cm || 0).toFixed(1)} cm
          </div>
        )}
      </div>
    </div>
  )
}

// Small DO / DI selector that mirrors the editor's IOPortSelector
// look so the operator gets the same dropdown they see when wiring
// gripper IO on a step. Pulls labels from /api/io/config.
function IOPortDropdown({ label, direction, value, onChange, ioLabels }) {
  const ports = Array.from({ length: 16 }, (_, i) => {
    const id  = (direction === 'output' ? 'DO' : 'DI') + i
    const pin = (direction === 'output' ? 'Y' : 'X') + Math.floor(i / 8) + '.' + (i % 8)
    return { id, pin, label: (ioLabels && ioLabels[id]) || id }
  })
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}
        style={{
          width: '100%', padding: '10px 12px', fontSize: 14,
          border: '1px solid #d1d5db', borderRadius: 6, background: '#fff',
        }}>
        <option value="">Not assigned</option>
        {ports.map((p) => (
          <option key={p.id} value={p.id}>{p.pin} — {p.label}</option>
        ))}
      </select>
    </div>
  )
}

function CustomGripperPanel({ answers, setAnswer, goNext }) {
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const [dragOver,  setDragOver]  = useState(false)
  const [ioLabels,  setIoLabels]  = useState({})
  const fileInputRef = useRef(null)

  useEffect(() => {
    let alive = true
    fetch('/api/io/config')
      .then((r) => r.json())
      .then((d) => { if (alive && d) setIoLabels(d.labels || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const uploadedModelId  = answers.gripper_model_id  || null
  const uploadedStlUrl   = answers.gripper_stl_url   || null
  const uploadedGlbUrl   = answers.gripper_glb_url   || null
  const uploadedName     = answers.gripper_upload_name || ''
  const uploadedDims     = answers.gripper_dimensions || null
  const gripperName      = answers.gripper_name || uploadedName
  const activateSignal   = answers.gripper_activate_signal || ''
  const confirmSignal    = answers.gripper_confirm_signal  || ''

  const uploadFile = async (file) => {
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!(lower.endsWith('.step') || lower.endsWith('.stp'))) {
      setUploadErr('Only .step / .stp files accepted')
      return
    }
    setUploadErr('')
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/gripper/upload', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok || data.error) {
        setUploadErr(data.error || 'Upload failed')
      } else {
        setAnswer('gripper_model_id',   data.id)
        setAnswer('gripper_glb_url',    data.glb_url || null)
        setAnswer('gripper_stl_url',    data.stl_url || null)
        setAnswer('gripper_upload_name', data.name || '')
        setAnswer('gripper_dimensions', data.dimensions || null)
        if (!answers.gripper_name && data.name) {
          setAnswer('gripper_name', data.name)
        }
      }
    } catch (e) {
      setUploadErr('Upload error: ' + (e?.message || 'unknown'))
    }
    setUploading(false)
  }

  const removeModel = () => {
    const id = answers.gripper_model_id
    if (id) {
      fetch('/api/gripper/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {})
    }
    setAnswer('gripper_model_id',   null)
    setAnswer('gripper_glb_url',    null)
    setAnswer('gripper_stl_url',    null)
    setAnswer('gripper_upload_name', '')
    setAnswer('gripper_dimensions', null)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer?.files?.[0]
    if (f) uploadFile(f)
  }

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111', marginBottom: 8, lineHeight: 1.3 }}>
        Custom Gripper
      </div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.5 }}>
        Optional: upload a STEP file for a 3D preview. Name your gripper and assign any digital I/O it uses.
      </div>

      {/* Section 1 — STEP file */}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>STEP File (optional)</div>
      {uploading ? (
        <div style={{
          padding: 28, border: '2px dashed #bfdbfe', borderRadius: 10, background: '#eff6ff',
          textAlign: 'center', marginBottom: 20,
        }}>
          <div style={{
            width: 28, height: 28, margin: '0 auto 10px',
            border: '3px solid #bfdbfe', borderTopColor: '#2563EB',
            borderRadius: '50%', animation: 'spin 1s linear infinite',
          }} />
          <div style={{ fontSize: 13, color: '#2563EB', fontWeight: 600 }}>Processing STEP file…</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : uploadedModelId && uploadedStlUrl ? (
        <div style={{ marginBottom: 20 }}>
          <GripperPreviewCanvas
            stlUrl={uploadedStlUrl}
            name={uploadedName || gripperName}
            dims={uploadedDims}
            onRemove={removeModel}
          />
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={{
            padding: 28, marginBottom: 20,
            border: '2px dashed ' + (dragOver ? '#2563EB' : '#d1d5db'),
            background: dragOver ? '#eff6ff' : '#f8fafc',
            borderRadius: 10, textAlign: 'center',
            transition: 'all 100ms',
          }}>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
            Upload a STEP file to preview your gripper in 3D (optional)
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".step,.stp"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = '' }}
          />
          <button onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '10px 18px', fontSize: 13, fontWeight: 700,
              background: '#2563EB', color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer',
            }}>
            Upload Gripper STEP File
          </button>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
            Or drag and drop a .step / .stp file here.
          </div>
        </div>
      )}
      {uploadErr && (
        <div style={{
          padding: 10, marginBottom: 16, fontSize: 12,
          background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 6, color: '#DC2626',
        }}>{uploadErr}</div>
      )}

      {/* Section 2 — Name */}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Gripper name</div>
      <input
        value={gripperName}
        onChange={(e) => setAnswer('gripper_name', e.target.value)}
        placeholder="e.g. Custom Magnetic Gripper"
        style={{ ...inputBox, fontSize: 15, marginBottom: 20 }}
      />

      {/* Section 3 — I/O */}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4 }}>
        I/O signals (optional — assign if your gripper uses digital I/O)
      </div>
      <IOPortDropdown
        label="Activate signal"
        direction="output"
        value={activateSignal}
        onChange={(v) => setAnswer('gripper_activate_signal', v)}
        ioLabels={ioLabels}
      />
      <IOPortDropdown
        label="Confirm signal"
        direction="input"
        value={confirmSignal}
        onChange={(v) => setAnswer('gripper_confirm_signal', v)}
        ioLabels={ioLabels}
      />

      <NextButton onClick={goNext} disabled={!gripperName.trim()} label="Next" />
    </div>
  )
}

// ────────────────────────────────────────────────────────
// TeachSequence — the dedicated end-of-wizard teach flow
//
// One position at a time. Derives the list from `answers` (operation
// + pallet_mode, etc.), walks the operator through them
// with a full-bleed jog pendant (140×140 buttons, same sizing as the
// Program tab's maximised pendant), and writes the recorded
// {tcp, joints, taught_at, skipped} payload into answers under
// taught_home / taught_pick / taught_place / etc. so program
// generation and the Review page can read them.
// ────────────────────────────────────────────────────────

// Derive the ordered list of positions for the current operation.
function teachPositionsForAnswers(answers) {
  const op   = answers.operation
  const mode = answers.pallet_mode
  const positions = [
    { key: 'taught_home', label: 'HOME POSITION',
      instr: 'Jog the robot to its safe home position — a neutral pose away from the work area that the robot returns to between cycles.' },
  ]
  if (op === 'palletize' && mode === 'palletize') {
    positions.push({
      key: 'taught_pick', label: 'PICK POSITION',
      instr: 'Jog the robot to where it should pick parts from, positioned directly above the pick point at the correct approach angle.',
    })
    positions.push({
      key: 'taught_pallet_corner', label: 'PALLET CORNER [row 1, col 1, layer 1]',
      instr: 'Jog the robot to the centre of the FIRST pallet slot — bottom layer, nearest corner [row 1, col 1, layer 1]. All other grid positions will be calculated automatically.',
    })
  } else if (op === 'palletize' && mode === 'depalletize') {
    positions.push({
      key: 'taught_pallet_corner', label: 'PALLET CORNER [row 1, col 1, top layer]',
      instr: 'Jog the robot to the centre of the FIRST part to pick — top layer, nearest corner [row 1, col 1]. All other grid positions will be calculated automatically.',
    })
    positions.push({
      key: 'taught_place', label: 'PLACE POSITION',
      instr: 'Jog the robot to where it should place parts, above the target location at the correct approach angle.',
    })
  } else if (op === 'machine_tend') {
    positions.push({
      key: 'taught_pick', label: 'PICK / LOAD POSITION',
      instr: 'Jog the robot to where it should pick parts from, positioned directly above the pick point at the correct approach angle.',
    })
    positions.push({
      key: 'taught_machine_load', label: 'MACHINE LOAD POSITION',
      instr: 'Jog the robot to the machine load point — where it places a part into the machine fixture.',
    })
    positions.push({
      key: 'taught_unload', label: 'UNLOAD POSITION',
      instr: 'Jog the robot to where it picks the finished part out of the machine.',
    })
  } else if (op === 'sort') {
    positions.push({
      key: 'taught_pick', label: 'PICK POSITION',
      instr: 'Jog the robot to where it should pick parts from, positioned directly above the pick point at the correct approach angle.',
    })
    positions.push({
      key: 'taught_sort_1', label: 'SORT PLACE 1',
      instr: 'Jog the robot to the first sort destination — where type 1 parts are placed.',
    })
    positions.push({
      key: 'taught_sort_2', label: 'SORT PLACE 2',
      instr: 'Jog the robot to the second sort destination — where type 2 parts are placed.',
    })
  } else {
    // Default: pick_and_place and anything else with a pick + place flow.
    positions.push({
      key: 'taught_pick', label: 'PICK POSITION',
      instr: 'Jog the robot to where it should pick parts from, positioned directly above the pick point at the correct approach angle.',
    })
    positions.push({
      key: 'taught_place', label: 'PLACE POSITION',
      instr: 'Jog the robot to where it should place parts, above the target location at the correct approach angle.',
    })
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
  return positions
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
  const wire = useCallback((axis, direction) => ({
    onPressStart: (meta) => holdStart(axis, direction, meta),
    onPressTick:  (meta) => holdStart(axis, direction, meta),
    onPressEnd:   (meta) => holdEnd(meta),
  }), [holdStart, holdEnd])

  // Compute per-position status (recorded / reused / skipped / pending)
  // for the progress dots and Review page card. A step marked 'reused'
  // for this session beats the underlying answer's 'recorded' state so
  // the operator can see at a glance which steps they revisited.
  const statusOf = (i) => {
    if (reusedSteps?.[i]) return 'reused'
    const v = answers[positions[i].key]
    if (!v) return 'pending'
    if (v.skipped) return 'skipped'
    if (v.tcp || v.joints) return 'recorded'
    return 'pending'
  }
  const statuses = positions.map((_, i) => statusOf(i))

  const current = positions[posIdx]

  // The reuse prompt fires when the current step's key already holds a
  // recorded (non-skipped, has tcp/joints) value from earlier in this
  // session — either a prior step that shares the key, a back-nav return,
  // or a re-entry into the teach sequence.
  const existingForCurrent = current ? answers[current.key] : null
  const alreadyRecordedHere = !!(existingForCurrent &&
    !existingForCurrent.skipped &&
    (Array.isArray(existingForCurrent.tcp) || Array.isArray(existingForCurrent.joints)))
  const showChoiceScreen = alreadyRecordedHere && !forceTeach[posIdx]

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
      x:  ((Number(t[0]) || 0) * 1000).toFixed(1),
      y:  ((Number(t[1]) || 0) * 1000).toFixed(1),
      z:  ((Number(t[2]) || 0) * 1000).toFixed(1),
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
      setRecordErr('All six fields are required. Use numeric values (mm for x/y/z, degrees for rx/ry/rz).')
      return
    }
    const D2R = Math.PI / 180
    // Store TCP in the same units /api/state uses: meters + radians.
    const tcp = [x / 1000, y / 1000, z / 1000, rx * D2R, ry * D2R, rz * D2R]
    setAnswer(current.key, {
      tcp,
      joints: (Array.isArray(liveJoints) ? liveJoints.slice(0, 6) : [0, 0, 0, 0, 0, 0]),
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
    setAnswer(current.key, {
      tcp: null, joints: null,
      taught_at: new Date().toISOString(),
      skipped: true,
    })
    clearReusedAt(posIdx)
    advanceOrComplete()
  }

  function skipAllRemaining() {
    const stamp = new Date().toISOString()
    positions.slice(posIdx).forEach((p) => {
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
  }, [jogMode, showChoiceScreen])

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
    // with overflow: hidden so the layout exactly fills 100vh and nothing
    // scrolls. The jog pad area absorbs all remaining vertical space.
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      width: '100vw', height: '100vh',
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
            {current.label}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap', flexShrink: 0 }}>
            Joints [{liveJoints.map((j) => j.toFixed(1)).join(', ')}]°
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap', flexShrink: 0 }}>
            TCP [{liveTcp.slice(0, 3).map((t) => Number(t).toFixed(3)).join(', ')}]
          </div>
        </div>
        <div style={{
          fontSize: 13, color: '#6b7280', lineHeight: 1.4,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {current.instr}
        </div>
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
              Position in mm, rotation in degrees. Saved as the taught pose for {current.label}.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
              {['x', 'y', 'z'].map((k) => (
                <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#374151', fontWeight: 600 }}>
                  {k.toUpperCase()} (mm)
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
              <div style={{ fontSize: 16, fontWeight: 700, color: '#16A34A', marginBottom: 10 }}>
                ✓ This position is already taught
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#111', marginBottom: 6 }}>
                {Array.isArray(existingForCurrent.tcp) && existingForCurrent.tcp.length >= 3 ? (
                  <>
                    <div>
                      TCP: x:{Number(existingForCurrent.tcp[0]).toFixed(3)}
                      {'  '}y:{Number(existingForCurrent.tcp[1]).toFixed(3)}
                      {'  '}z:{Number(existingForCurrent.tcp[2]).toFixed(3)}
                    </div>
                    {existingForCurrent.tcp.length >= 6 && (
                      <div>
                        {'     '}rx:{Number(existingForCurrent.tcp[3]).toFixed(3)}
                        {'  '}ry:{Number(existingForCurrent.tcp[4]).toFixed(3)}
                        {'  '}rz:{Number(existingForCurrent.tcp[5]).toFixed(3)}
                      </div>
                    )}
                  </>
                ) : Array.isArray(existingForCurrent.joints) && existingForCurrent.joints.length ? (
                  <div>
                    Joints: [{existingForCurrent.joints.map((j) => Number(j).toFixed(1)).join(', ')}]°
                  </div>
                ) : null}
              </div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                Taught earlier in this setup.
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
            <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>Step:</span>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s} onClick={() => setStep(s)} style={{
                padding: '10px 12px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                minHeight: 44, minWidth: 48,
                background: step === s ? '#2563EB' : '#f3f4f6',
                color:      step === s ? '#fff'    : '#374151',
                border:     step === s ? 'none'    : '1px solid #e5e7eb',
              }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
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
            <button onClick={triggerEstop} style={{
              padding: '10px 16px', fontSize: 13, fontWeight: 700,
              background: '#DC2626', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              minHeight: 44,
            }}>STOP</button>
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

      {/* FOOTER (~88px) — Back / Record / Skip in teach mode; only Back in
          choice mode (the Reuse/Re-teach buttons live in the body). */}
      <div style={{
        flex: '0 0 auto', minHeight: 88,
        padding: '14px 24px',
        borderTop: '1px solid #e5e7eb',
        display: 'flex', gap: 12, alignItems: 'center',
        boxSizing: 'border-box',
      }}>
        <button onClick={goBack} style={{
          padding: '14px 22px', minHeight: 56, fontSize: 14, fontWeight: 700,
          background: '#fff', color: '#374151',
          border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
        }}>← Back</button>
        {!showChoiceScreen && (
          <>
            <div style={{ flex: 1 }} />
            <button onClick={openManualEntry} title="Type in x/y/z + orientation instead of capturing live" style={{
              padding: '14px 20px', minHeight: 56, fontSize: 13, fontWeight: 700,
              background: '#fff', color: '#2563EB',
              border: '1px solid #93c5fd', borderRadius: 10, cursor: 'pointer',
            }}>Enter manually</button>
            <button onClick={recordPosition} style={{
              padding: '14px 32px', minHeight: 60, fontSize: 16, fontWeight: 800,
              background: flash ? '#16A34A' : '#2563EB', color: '#fff',
              border: 'none', borderRadius: 10, cursor: 'pointer',
              minWidth: 220,
              transition: 'background 200ms',
            }}>
              {flash ? '✓ Recorded' : 'Record Position'}
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={skipCurrent} style={{
              padding: '14px 22px', minHeight: 56, fontSize: 14, fontWeight: 700,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            }}>Skip →</button>
          </>
        )}
      </div>
    </div>
  )
}

function CellPickerPage({ answers, setAnswer, goNext }) {
  const [cells, setCells]   = useState([])
  const [active, setActive] = useState(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    fetch('/api/cells').then(r => r.json()).then((j) => {
      if (!alive) return
      setCells((j.cells || []).filter(c => c.commissioning_complete))
      setActive(j.active_cell_id || null)
      setLoaded(true)
      // Pre-select the active cell on first mount if the user hasn't
      // already chosen one in this session.
      if (j.active_cell_id && !answers.cell_id) {
        setAnswer('cell_id', j.active_cell_id)
      }
    }).catch(() => { setLoaded(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const haveCells = cells.length > 0
  return (
    <QuestionCard
      question="Which workspace is this program for?"
      description="Programs are scoped to a commissioned cell. The active cell is pre-selected."
    >
      {!loaded && <div style={{ color: '#6b7280', fontSize: 13 }}>Loading cells…</div>}
      {loaded && !haveCells && (
        <div style={{
          padding: 14, background: '#fffbeb', border: '1px solid #fde68a',
          borderRadius: 10, color: '#92400e', fontSize: 13, lineHeight: 1.5,
          marginBottom: 12,
        }}>
          No cells commissioned yet. You can still continue without one, but linking the program to a cell unlocks per-cell baselines and bounds later.
          {' '}Go to <strong>Configure → Setup Wizard</strong> to commission one.
        </div>
      )}
      {loaded && haveCells && (
        <div style={{ marginBottom: 12 }}>
          {cells.map(c => (
            <ChoiceButton key={c.cell_id}
              label={c.name + (c.cell_id === active ? '   (Active)' : '')}
              description={
                (c.baseline_captured ? `Baseline ${(c.baseline_point_count || 0).toLocaleString()} pts · ` : 'No baseline · ')
                + (c.commissioning_complete ? 'Commissioned' : 'Incomplete')
              }
              selected={answers.cell_id === c.cell_id}
              onClick={() => { setAnswer('cell_id', c.cell_id); goNext() }}
            />
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <NextButton
          onClick={goNext}
          label={haveCells ? 'Use selected' : 'Continue without a cell'}
        />
      </div>
    </QuestionCard>
  )
}

// ── Page bodies that use hooks — extracted as proper Components so
// ── React tracks their hook stacks separately from the parent
// ── ProgramWizard fiber. Prior inline lambda form
//    render: ({...}) => { const [x] = useState(...); ... }
// tripped react-hooks/rules-of-hooks because the render-prop function
// has a lowercase name from ESLint's perspective; capitalising the
// component name is what tells the linter this IS a component and
// makes the hooks legal. The PAGES entries below simply spread these
// component references into the `render` field.
function WhichPartBody({ answers, setAnswer, goNext }) {
  const [parts, setParts] = useState([])
  useEffect(() => {
    fetch('/api/parts').then(r => r.json()).then(d => setParts(d.parts || [])).catch(() => {})
  }, [])
  return (
    <QuestionCard
      question="Which part should the robot look for?"
      description="Select a part from the library. The robot will only pick this type."
    >
      {parts.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#6b7280', border: '2px dashed #d1d5db', borderRadius: 8 }}>
          No parts in the library. Upload STEP files in Part Recognition first.
        </div>
      ) : parts.map(p => (
        <ChoiceButton key={p.id} label={p.name}
          description={`${p.extents_cm?.[0]} x ${p.extents_cm?.[1]} x ${p.extents_cm?.[2]} cm`}
          selected={answers.target_part === p.id}
          onClick={() => { setAnswer('target_part', p.id); setAnswer('target_part_name', p.name); goNext() }}
        />
      ))}
    </QuestionCard>
  )
}

function MachineIOBody({ answers, setAnswer, goNext }) {
  const [ioLabels, setIoLabels] = useState({})
  useEffect(() => {
    fetch('/api/io/config').then(r => r.json()).then(d => setIoLabels(d.labels || {})).catch(() => {})
  }, [])
  const doOptions = Array.from({ length: 16 }, (_, i) => ({
    id: 'DO' + i, label: ioLabels['DO' + i] || 'DO' + i,
    pin: 'Y' + Math.floor(i/8) + '.' + (i%8),
  }))
  const diOptions = Array.from({ length: 16 }, (_, i) => ({
    id: 'DI' + i, label: ioLabels['DI' + i] || 'DI' + i,
    pin: 'X' + Math.floor(i/8) + '.' + (i%8),
  }))
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
          {doOptions.map(o => <option key={o.id} value={o.id}>{o.pin} - {o.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
          Cycle Complete Signal (input from machine)
        </div>
        <select value={answers.io_cycle_done || 'DI3'}
          onChange={e => setAnswer('io_cycle_done', e.target.value)}
          style={{ width: '100%', padding: 10, fontSize: 14, borderRadius: 6, border: '1px solid #d1d5db' }}>
          {diOptions.map(o => <option key={o.id} value={o.id}>{o.pin} - {o.label}</option>)}
        </select>
      </div>
      <SliderQuestion label="Cycle timeout" value={answers.cycle_timeout || 30}
        onChange={v => setAnswer('cycle_timeout', v)} min={5} max={300} step={5} unit="s"
        description="Maximum time to wait for the machine to finish before flagging an error" />
      <NextButton onClick={goNext} label="Next" />
    </QuestionCard>
  )
}

const PAGES = [
  // 0: Which workspace is this program for?
  {
    id: 'cell',
    render: CellPickerPage,
  },

  // 1: What operation?
  {
    id: 'operation',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What do you want the robot to do?"
        description="Choose the type of operation. The wizard will guide you through the setup."
      >
        {[
          { value: 'pick_and_place', label: 'Pick and Place', desc: 'Pick an object and move it to another location', icon: 'P' },
          { value: 'sort', label: 'Sort Parts', desc: 'Identify parts and place them in different locations by type', icon: 'S' },
          { value: 'machine_tend', label: 'Machine Tending', desc: 'Load parts into a machine, wait, then unload', icon: 'M' },
          { value: 'palletize', label: 'Palletize', desc: 'Stack parts onto a pallet or pick them off a pallet', icon: 'G' },
        ].map(op => (
          <ChoiceButton key={op.value} label={op.label} description={op.desc} icon={op.icon}
            selected={answers.operation === op.value}
            onClick={() => { setAnswer('operation', op.value); goNext() }}
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
        setAnswer('pallet_mode', mode)
        setAnswer('source', mode === 'palletize' ? 'camera_library' : 'fixed_grid')
        goNext()
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

  // 1: How does the robot find objects?
  //    Skipped entirely for pallet modes — palletize forces camera_library,
  //    depalletize forces fixed_grid (selection happens on the
  //    pallet_mode page above).
  //    Stores answers.source (the value downstream consumers read).
  //    'camera_library' — vision detects the part using taught
  //                       references from the Part Recognition library;
  //                       requires the which_part page to pick which.
  //    'fixed_position' — part is always in the same taught spot.
  {
    id: 'pick_method',
    skip: (answers) => answers.operation === 'palletize',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How should the robot find the parts?"
        description="Choose how the robot identifies what to pick up."
      >
        {[
          { value: 'camera_library', label: 'Camera Detection', desc: 'Camera detects parts using taught references from the Part Recognition library' },
          { value: 'fixed_position', label: 'Fixed Position', desc: 'The part is always in the same spot (e.g. from a feeder or conveyor).' },
        ].map(m => (
          <ChoiceButton key={m.value} label={m.label} description={m.desc}
            selected={answers.source === m.value}
            onClick={() => { setAnswer('source', m.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 2: Which part? (only if Camera Detection selected on page 1)
  {
    id: 'which_part',
    skip: (answers) => answers.source !== 'camera_library',
    render: WhichPartBody,
  },

  // 3: What gripper type?
  {
    id: 'gripper_type',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What type of gripper will you use?"
        description="Choose the end-of-arm tool for this operation."
      >
        {[
          { value: 'finger', label: 'Finger Gripper', desc: 'Two parallel jaw fingers. Best for rigid parts with flat gripping surfaces.' },
          { value: 'vacuum', label: 'Vacuum Suction', desc: 'Vacuum cup picks from the top. Best for flat, smooth, sealed surfaces.' },
          { value: 'custom', label: 'Custom Gripper', desc: 'Upload a STEP file, name the gripper, and assign optional I/O. For magnetic, electroadhesive, or any other end-effector.' },
        ].map(g => (
          <ChoiceButton key={g.value} label={g.label} description={g.desc}
            selected={answers.gripper_type === g.value}
            onClick={() => { setAnswer('gripper_type', g.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 4: Gripper settings
  //    Vacuum → threshold slider.
  //    Custom → STEP upload + name + I/O assignment.
  //    Finger → nothing operator-tunable, page is skipped entirely.
  {
    id: 'gripper_settings',
    skip: (answers) => !(answers.gripper_type === 'vacuum' || answers.gripper_type === 'custom'),
    render: ({ answers, setAnswer, goNext }) => {
      if (answers.gripper_type === 'custom') {
        return (
          <CustomGripperPanel answers={answers} setAnswer={setAnswer} goNext={goNext} />
        )
      }
      return (
        <QuestionCard
          question="Set the vacuum settings"
          description="These settings control how the gripper picks up parts."
        >
          <SliderQuestion label="Vacuum threshold" value={answers.vacuum_threshold || 70}
            onChange={v => setAnswer('vacuum_threshold', v)} min={30} max={95} step={5} unit="%"
            description="Minimum vacuum level needed to confirm a successful pick" />
          <NextButton onClick={goNext} label="Next" />
        </QuestionCard>
      )
    },
  },

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
              <input type="number" min={1} max={20} value={rows}
                onChange={(e) => setInt('pallet_rows', e.target.value, 1, 20)}
                style={inputBox} />
            </label>
            <label style={{ flex: 1, minWidth: 90 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Columns</div>
              <input type="number" min={1} max={20} value={cols}
                onChange={(e) => setInt('pallet_cols', e.target.value, 1, 20)}
                style={inputBox} />
            </label>
            <label style={{ flex: 1, minWidth: 90 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Layers</div>
              <input type="number" min={1} max={10} value={layers}
                onChange={(e) => setInt('pallet_layers', e.target.value, 1, 10)}
                style={inputBox} />
            </label>
          </div>

          <SliderQuestion label="Spacing X (centre-to-centre)" value={sx}
            onChange={(v) => setAnswer('pallet_spacing_x_mm', v)}
            min={10} max={500} step={5} unit="mm"
            description="Distance between columns" />
          <SliderQuestion label="Spacing Y (centre-to-centre)" value={sy}
            onChange={(v) => setAnswer('pallet_spacing_y_mm', v)}
            min={10} max={500} step={5} unit="mm"
            description="Distance between rows" />
          <SliderQuestion label="Layer height Z" value={lz}
            onChange={(v) => setAnswer('pallet_layer_height_mm', v)}
            min={10} max={300} step={5} unit="mm"
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
        <SliderQuestion label="Approach height" value={answers.pallet_approach_height_mm || 100}
          onChange={(v) => setAnswer('pallet_approach_height_mm', v)}
          min={20} max={300} step={5} unit="mm"
          description="Z offset above each slot before descent" />
        <SliderQuestion label="Retract height" value={answers.pallet_retract_height_mm || 200}
          onChange={(v) => setAnswer('pallet_retract_height_mm', v)}
          min={50} max={500} step={10} unit="mm"
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
        <SliderQuestion label="Approach height" value={answers.pallet_approach_height_mm || 100}
          onChange={(v) => setAnswer('pallet_approach_height_mm', v)}
          min={20} max={300} step={5} unit="mm"
          description="Z offset above each slot before descent" />
        <SliderQuestion label="Retract height" value={answers.pallet_retract_height_mm || 200}
          onChange={(v) => setAnswer('pallet_retract_height_mm', v)}
          min={50} max={500} step={10} unit="mm"
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
        <SliderQuestion label="Approach height" value={answers.approach_height || 100}
          onChange={v => setAnswer('approach_height', v)} min={20} max={300} step={10} unit="mm"
          description="Distance above the part surface before the final descent" />
        <div style={{
          padding: 12, background: '#f0f9ff', borderRadius: 8,
          border: '1px solid #bfdbfe', fontSize: 12, color: '#2563EB', marginBottom: 16,
        }}>
          Recommended: 100-150mm for most operations. Use 50-80mm for tight spaces.
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 7: Where to place? (for pick_and_place)
  //    Skipped for machine_tend (own load/unload teach) and palletize
  //    (the pallet pages own the place flow).
  {
    id: 'place_method',
    skip: (answers) => answers.operation === 'machine_tend' || answers.operation === 'palletize',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Where should the robot place the part?"
        description="Choose how the place location is determined."
      >
        {[
          { value: 'fixed', label: 'Fixed Position', desc: 'Always place at the same taught position.' },
          { value: 'relative', label: 'Relative Offset', desc: 'Place at a fixed offset from the pick position.' },
          ...(answers.operation === 'palletize' ? [
            { value: 'pallet', label: 'Pallet Grid', desc: 'Arrange parts in rows and columns on a pallet.' },
          ] : []),
          ...(answers.operation === 'sort' ? [
            { value: 'by_type', label: 'Sort by Part Type', desc: 'Different location for each part type.' },
          ] : []),
        ].map(p => (
          <ChoiceButton key={p.value} label={p.label} description={p.desc}
            selected={answers.place_method === p.value}
            onClick={() => { setAnswer('place_method', p.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
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
              onClick={() => { setAnswer('repeat', r.value); if (r.value !== 'count') goNext() }}
            />
          ))}
          {answers.repeat === 'count' && (
            <div style={{ marginTop: 12 }}>
              <SliderQuestion label="Number of cycles" value={answers.repeat_count || 10}
                onChange={v => setAnswer('repeat_count', v)} min={2} max={500} step={1} unit="" />
              <NextButton onClick={goNext} label="Next" />
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
              Spacing: {answers.pallet_spacing_x_mm ?? 150}mm × {answers.pallet_spacing_y_mm ?? 150}mm
            </div>
            <div style={{ color: '#6b7280' }}>
              Layer height: {answers.pallet_layer_height_mm ?? 100}mm
            </div>
            <div style={{ color: '#6b7280' }}>
              {isDepal ? 'Pick' : 'Fill'} order: {isDepal ? `Top layer first, ${orderLabel}` : orderLabel}
            </div>
            <div style={{ color: '#6b7280', marginTop: 6 }}>
              {isDepal ? (
                <>
                  Corner [1,1,top]: {readTaught(answers, 'taught_pallet_corner') ? '✓ Taught' : '— Not taught'}
                  <br />
                  Place position: {readTaught(answers, 'taught_place') ? '✓ Taught' : '— Not taught'}
                </>
              ) : (
                <>
                  Pick position: {readTaught(answers, 'taught_pick') ? '✓ Taught' : '— Not taught'}
                  <br />
                  Corner [1,1,1]: {readTaught(answers, 'taught_pallet_corner') ? '✓ Taught' : '— Not taught'}
                </>
              )}
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
                let trailing
                if (isReused) {
                  const firstIdx = seenKeyAt[p.key]
                  const primary  = (firstIdx !== undefined && firstIdx !== i)
                    ? positions[firstIdx]?.label
                    : null
                  trailing = primary
                    ? `reused (same as ${primary.toLowerCase()})`
                    : 'reused'
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
          <div style={{ color: '#6b7280' }}>Gripper: {answers.gripper_type}</div>
          {/* Speed and motion profile are defaulted at save time (see save handler).
              They are tuned from the Program tab's motion profile card after creation. */}
          {isPallet ? (
            <>
              <div style={{ color: '#6b7280' }}>Approach height: {answers.pallet_approach_height_mm ?? 100}mm</div>
              <div style={{ color: '#6b7280' }}>Retract height: {answers.pallet_retract_height_mm ?? 200}mm</div>
              <div style={{ color: '#6b7280' }}>Cycles: {total} (locked — full pallet)</div>
            </>
          ) : (
            <>
              <div style={{ color: '#6b7280' }}>Approach height: {answers.approach_height}mm</div>
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

// Build the typed pallet config block saved into program.config.pallet.
// The wizard never bakes per-slot coordinates into steps — the executor
// computes them at runtime from this block. See the EXECUTOR CHANGES
// section of the task spec.
function buildPalletConfig(answers) {
  const cornerPoint = readTaught(answers, 'taught_pallet_corner')
  return {
    rows:            answers.pallet_rows   ?? 4,
    cols:            answers.pallet_cols   ?? 4,
    layers:          answers.pallet_layers ?? 1,
    spacing_x_mm:    answers.pallet_spacing_x_mm   ?? 150,
    spacing_y_mm:    answers.pallet_spacing_y_mm   ?? 150,
    layer_height_mm: answers.pallet_layer_height_mm ?? 100,
    fill_order:      answers.pallet_fill_order || 'row_lr',
    corner_tcp:      tcpToObj(cornerPoint?.tcp),
    approach_height_mm: answers.pallet_approach_height_mm ?? 100,
    retract_height_mm:  answers.pallet_retract_height_mm  ?? 200,
  }
}

// Emit the wizard-side step list for a pallet program. Per-cycle motion
// uses move_to_pallet which the executor expands into the actual slot
// XYZ at runtime; pick / place taught TCPs (and their lift/approach
// offsets) are baked into normal move_linear steps with absolute TCPs
// since they're fixed once the operator records them.
function buildPalletizeSteps(answers) {
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
  const gripOpen  = (label = 'Open gripper') => gripType === 'finger'
    ? { action: 'open_gripper', label, width_mm: gripW, speed_pct: spd, io_open: 'DO1', io_open_confirm: 'DI1' }
    : gripType === 'vacuum'
      ? { action: 'set_io', label, io_id: 'DO2', value: 0 }
      : { action: 'set_io', label, io_id: customActivate, value: 0 }
  const gripClose = (label = 'Close gripper') => gripType === 'finger'
    ? { action: 'close_gripper', label, force_pct: gripF, io_close: 'DO0', io_close_confirm: 'DI0' }
    : gripType === 'vacuum'
      ? { action: 'set_io', label, io_id: 'DO2', value: 1 }
      : { action: 'set_io', label, io_id: customActivate, value: 1, ...(customConfirm ? { io_close_confirm: customConfirm } : {}) }

  const steps = []
  steps.push({ action: 'move_home', label: 'Move to home position' })

  // Loop start index — step number (1-indexed for the executor's
  // goto-1 convention) of the first inside-loop step we're about to
  // push. move_home is step 1, so loop body starts at step 2.
  const loopStart = steps.length + 1

  if (mode === 'palletize') {
    // Camera-driven pick: detect first using the parts library.
    if ((answers.source || 'camera_library') === 'camera_library') {
      steps.push({ action: 'detect', label: 'Find ' + (answers.target_part_name || 'library part'), mode: 'library' })
    }

    const pickPoint = readTaught(answers, 'taught_pick') || {}
    const pickTcp   = Array.isArray(pickPoint.tcp) ? pickPoint.tcp : null
    const pickJoints = Array.isArray(pickPoint.joints) ? pickPoint.joints : null

    // Approach above pick — emit as movj on taught joints (matches
    // the wizard's existing 'approach' semantics in buildSteps). The
    // executor goes to the taught pose; the operator already taught
    // it at the pick. The compound descend / lift TCPs below carry
    // the approach / retract offsets.
    // Source step for taught_pick; descend / lift derive from it via
    // derived_from + offset so re-teaching the pick in the editor
    // propagates to both children automatically.
    steps.push({
      action: 'approach', label: 'Approach above pick',
      taught: !!pickJoints, taught_joints: pickJoints, joints: pickJoints,
      taught_tcp: pickTcp, position: pickTcp ? pickTcp.slice(0, 3) : null,
      speed_pct: spd, offset_z_mm: appH,
      position_role: 'pick',
    })
    // Descend to pick TCP. Keep the literal taught data as a fallback
    // for the legacy executor path but tag derived_from so the new
    // resolver uses the source step's current pose (handles re-teach).
    if (pickTcp) {
      steps.push({
        action: 'move_linear', label: 'Descend to pick',
        taught_tcp: pickTcp, position: pickTcp.slice(0, 3),
        taught_joints: pickJoints, joints: pickJoints,
        speed_pct: slow, offset_z_mm: 0,
        derived_from: 'pick',
      })
    }
    steps.push(gripClose('Grip part'))
    if (gripType === 'vacuum') steps.push({ action: 'wait', label: 'Wait for vacuum seal', duration_s: 0.5 })
    // Lift from pick — derived from taught_pick + retract offset.
    steps.push({
      action: 'move_linear', label: 'Lift from pick',
      taught_tcp: pickTcp, position: pickTcp ? pickTcp.slice(0, 3) : null,
      taught_joints: pickJoints, joints: pickJoints,
      speed_pct: medium, offset_z_mm: retH,
      derived_from: 'pick',
    })
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

    const placePoint = readTaught(answers, 'taught_place') || {}
    const placeTcp   = Array.isArray(placePoint.tcp) ? placePoint.tcp : null
    const placeJoints = Array.isArray(placePoint.joints) ? placePoint.joints : null

    // Source step for taught_place; the first "Move above place" carries
    // the taught data and tags itself as the 'place' role so the descend
    // and lift below can derive from it via derived_from + offset.
    steps.push({
      action: 'move_linear', label: 'Move above place',
      taught: !!placeTcp, taught_tcp: placeTcp, position: placeTcp ? placeTcp.slice(0, 3) : null,
      taught_joints: placeJoints, joints: placeJoints,
      speed_pct: spd, offset_z_mm: retH,
      position_role: 'place',
    })
    // Derived: descend to place at z+0 from taught_place.
    if (placeTcp) {
      steps.push({
        action: 'move_linear', label: 'Descend to place',
        taught_tcp: placeTcp, position: placeTcp.slice(0, 3),
        taught_joints: placeJoints, joints: placeJoints,
        speed_pct: slow, offset_z_mm: 0,
        derived_from: 'place',
      })
    }
    steps.push(gripOpen('Release part'))
    if (gripType === 'vacuum') {
      steps.push({ action: 'set_io', label: 'Blow off', io_id: 'DO3', value: 1 })
      steps.push({ action: 'wait',   label: 'Wait for blow off', duration_s: 0.3 })
      steps.push({ action: 'set_io', label: 'Blow off stop', io_id: 'DO3', value: 0 })
    }
    // Derived: lift from place at z+retract offset.
    steps.push({
      action: 'move_linear', label: 'Lift from place',
      taught_tcp: placeTcp, position: placeTcp ? placeTcp.slice(0, 3) : null,
      taught_joints: placeJoints, joints: placeJoints,
      speed_pct: medium, offset_z_mm: retH,
      derived_from: 'place',
    })
  }

  // Loop back to the first inside-loop step. count = total slots.
  steps.push({
    action: 'loop',
    label: `Pallet loop — ${cycles} cycles (${rows} × ${cols} × ${layers})`,
    goto: loopStart, count: cycles,
    pallet_loop: true,
  })

  steps.push({ action: 'move_home', label: 'Return to home' })
  return steps.map((s, i) => ({ ...s, step: i + 1 }))
}

function buildSteps(answers) {
  // Pallet programs follow a totally different shape — their steps
  // come from buildPalletizeSteps so the editor and executor see the
  // move_to_pallet flow rather than the generic pick/place body.
  if (answers.operation === 'palletize') return buildPalletizeSteps(answers)

  const steps = []
  const spd = answers.speed || 40
  const slow = Math.min(spd, 30)
  const medium = Math.min(spd, 40)
  const appH = answers.approach_height || 100
  const gripW = answers.gripper_width || 85
  const gripF = answers.grip_force || 50
  const op = answers.operation

  steps.push({ action: 'move_home', label: 'Move to home position' })

  // ── Standard pick / sort / machine_tend flow. Palletize takes the
  //    buildPalletizeSteps path above.

  // Custom gripper IO: operator-selected activate / confirm signals
  // from the Custom Gripper page. Default to DO3 / no-confirm to match
  // the prior 'magnetic' behaviour for programs that didn't assign IO.
  const customActivate = answers.gripper_activate_signal || 'DO3'

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'open_gripper', label: 'Open gripper', width_mm: gripW, speed_pct: spd, io_open: 'DO1', io_open_confirm: 'DI1' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum off', io_id: 'DO2', value: 0 })
  } else if (answers.gripper_type === 'custom') {
    steps.push({ action: 'set_io', label: 'Gripper off', io_id: customActivate, value: 0 })
  }

  if (answers.source === 'camera_library') {
    steps.push({ action: 'detect', label: 'Find ' + (answers.target_part_name || 'library part'), mode: 'library' })
  }

  // Source step for the pick — carries taught_pick (applied by applyTaught
  // below) so the descend/lift derived moves can resolve to its taught_tcp
  // plus their offsets at runtime.
  steps.push({ action: 'approach', label: 'Move above pick position', target: answers.source === 'fixed_position' ? 'fixed' : 'auto', offset_z_mm: appH, speed_pct: spd, position_role: 'pick' })
  // Derived from the taught pick — z+0 (descend onto the part). The
  // editor treats `derived_from` steps as non-teachable; the executor
  // resolves the actual TCP at runtime from the source step + offset.
  steps.push({ action: 'move_linear', label: 'Descend to part', offset_z_mm: 0, speed_pct: slow, derived_from: 'pick' })

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'close_gripper', label: 'Grip part', force_pct: gripF, io_close: 'DO0', io_close_confirm: 'DI0' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum on', io_id: 'DO2', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for vacuum seal', duration_s: 0.5 })
  } else {
    // Custom gripper — single-signal toggle on the operator's activate port.
    steps.push({ action: 'set_io', label: 'Gripper on', io_id: customActivate, value: 1 })
  }

  // Lift = pick + appH (return above the part after gripping).
  steps.push({ action: 'move_linear', label: 'Lift part', offset_z_mm: appH, speed_pct: medium, derived_from: 'pick' })

  if (op === 'machine_tend') {
    // Source step for the machine_load taught point; descend / retreat /
    // approach-finished-part / descend-to-finished-part / lift-finished
    // all derive from this single taught position with z-offsets.
    steps.push({ action: 'move_joint', label: 'Move to machine load position', speed_pct: spd, position_role: 'machine_load' })
    steps.push({ action: 'move_linear', label: 'Descend to load position', offset_z_mm: 0, speed_pct: Math.min(spd, 20), derived_from: 'machine_load' })
    if (answers.gripper_type === 'finger') {
      steps.push({ action: 'open_gripper', label: 'Release part into machine', width_mm: gripW, io_open: 'DO1' })
    } else {
      steps.push({ action: 'set_io', label: 'Release part into machine', io_id: 'DO2', value: 0 })
    }
    steps.push({ action: 'move_linear', label: 'Retreat from machine', offset_z_mm: appH, speed_pct: slow, derived_from: 'machine_load' })
    steps.push({ action: 'set_io', label: 'Start machine cycle', io_id: answers.io_cycle_start || 'DO4', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for machine to finish', duration_s: answers.cycle_timeout || 30 })
    steps.push({ action: 'set_io', label: 'Clear cycle start', io_id: answers.io_cycle_start || 'DO4', value: 0 })
    // The robot picks the finished part out of the same fixture it loaded
    // into, so these all derive from machine_load too.
    steps.push({ action: 'move_linear', label: 'Approach finished part', offset_z_mm: appH, speed_pct: slow, derived_from: 'machine_load' })
    steps.push({ action: 'move_linear', label: 'Descend to finished part', offset_z_mm: 0, speed_pct: Math.min(spd, 20), derived_from: 'machine_load' })
    if (answers.gripper_type === 'finger') {
      steps.push({ action: 'close_gripper', label: 'Grip finished part', force_pct: gripF, io_close: 'DO0' })
    } else {
      steps.push({ action: 'set_io', label: 'Pick finished part', io_id: 'DO2', value: 1 })
    }
    steps.push({ action: 'move_linear', label: 'Lift finished part', offset_z_mm: appH, speed_pct: medium, derived_from: 'machine_load' })
    // Source step for the unload taught point; the descend-to-unload
    // derives from it.
    steps.push({ action: 'move_joint', label: 'Move to unload position', speed_pct: spd, position_role: 'unload' })
    steps.push({ action: 'move_linear', label: 'Descend to unload', offset_z_mm: 0, speed_pct: slow, derived_from: 'unload' })
  } else {
    // Default place flow (pick_and_place / sort). The move_joint is the
    // taught place position; the descend derives from it.
    steps.push({ action: 'move_joint', label: 'Move above place position', speed_pct: spd, position_role: 'place' })
    steps.push({ action: 'move_linear', label: 'Descend to place', offset_z_mm: 0, speed_pct: slow, derived_from: 'place' })
  }

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'open_gripper', label: 'Release part', width_mm: gripW, io_open: 'DO1' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum off — release part', io_id: 'DO2', value: 0 })
    steps.push({ action: 'set_io', label: 'Blow off', io_id: 'DO3', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for blow off', duration_s: 0.3 })
    steps.push({ action: 'set_io', label: 'Blow off stop', io_id: 'DO3', value: 0 })
  } else {
    // Custom gripper — release on the operator's activate port.
    steps.push({ action: 'set_io', label: 'Gripper off — release part', io_id: customActivate, value: 0 })
  }

  steps.push({ action: 'move_linear', label: 'Lift from place', offset_z_mm: appH, speed_pct: medium, derived_from: 'place' })
  steps.push({ action: 'move_home', label: 'Return to home' })

  if (answers.repeat === 'continuous') {
    steps.push({ action: 'loop', label: 'Repeat continuously', goto: 1, count: 0 })
  } else if (answers.repeat === 'count') {
    steps.push({ action: 'loop', label: 'Repeat ' + (answers.repeat_count || 10) + ' times', goto: 1, count: answers.repeat_count || 10 })
  }

  // Inject taught data from the wizard's teach pages so the editor's
  // green T badges appear immediately for the positions the operator
  // recorded. Mapping rules:
  //   home_point         → first + last move_home (start / return-home)
  //   pick_point         → the 'approach' step (descend uses the same)
  //   place_point        → first move_joint or move_linear labelled
  //                        "Move above place position"
  //   machine_load_point → "Move to machine load position"
  //   unload_point       → "Move to unload position"
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

  // First and last move_home both share taught_home.
  if (homeP) {
    const homeIdxs = numbered.map((s, i) => s.action === 'move_home' ? i : -1).filter((i) => i >= 0)
    homeIdxs.forEach((i) => { numbered[i] = applyTaught(numbered[i], homeP) })
  }
  if (pickP) {
    const i = numbered.findIndex((s) => s.action === 'approach')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], pickP)
  }
  if (placeP) {
    const i = numbered.findIndex((s) =>
      (s.action === 'move_joint' || s.action === 'move_linear') &&
      typeof s.label === 'string' && s.label.toLowerCase().includes('place')
    )
    if (i >= 0) numbered[i] = applyTaught(numbered[i], placeP)
  }
  if (loadP) {
    const i = numbered.findIndex((s) => s.action === 'move_joint' && s.label === 'Move to machine load position')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], loadP)
  }
  if (unloadP) {
    const i = numbered.findIndex((s) => s.action === 'move_joint' && s.label === 'Move to unload position')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], unloadP)
  }

  return numbered
}

// ────────────────────────────────────────────────────────
// Main wizard component
// ────────────────────────────────────────────────────────

export default function ProgramWizard({ onClose, onSaved }) {
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

  const setAnswer = (key, value) => setAnswers(prev => ({ ...prev, [key]: value }))

  const goNext = () => {
    let next = pageIdx + 1
    while (next < PAGES.length && PAGES[next].skip?.(answers)) next++
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

  const builtSteps = buildSteps(answers)

  const handleSave = async () => {
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
      if (answers.operation === 'palletize') {
        const pallet = buildPalletConfig(answers)
        config.pallet      = pallet
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
  // page its own fiber and hook stack. key={safeIdx} forces a fresh
  // mount per page so even repeat visits start with a clean stack.
  const PageBody = page && typeof page.render === 'function' ? page.render : null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '95%', maxWidth: 800, maxHeight: '95vh',
        background: '#fff', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
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
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {PageBody ? (
            <PageBody
              key={safeIdx}
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

import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'

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
      <svg width="24" height="24" viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#374151' }}>{label}</span>
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

function TeachWithJog({ title, description, instructions, pointName, answers, setAnswer, onNext, onSkip }) {
  const jog          = useStore((s) => s.jog)
  const jogCartesian = useStore((s) => s.jogCartesian)
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

  // Use the same store actions the Program-tab jog panel uses —
  // joint mode posts /cmd/jog (rad delta), cartesian mode posts
  // /cmd/jog_cartesian. Safety gates already live in the backend.
  const sendJog = useCallback((axis, direction) => {
    if (modeRef.current === 'joint') {
      const deltaRad = direction * stepRef.current * Math.PI / 180
      jog(axis - 1, deltaRad)
    } else {
      jogCartesian(axis, direction, stepRef.current, speedRef.current)
    }
  }, [jog, jogCartesian])

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
                <div style={{ gridArea: 'up' }}>    <JogArrow onPress={() => sendJog('y',  1)} rotation={0}   label="Y+" color="#16A34A" /></div>
                <div style={{ gridArea: 'left' }}>  <JogArrow onPress={() => sendJog('x', -1)} rotation={-90} label="X−" color="#DC2626" /></div>
                <div style={{ gridArea: 'center' }}><PadCenterTile label="XY" /></div>
                <div style={{ gridArea: 'right' }}> <JogArrow onPress={() => sendJog('x',  1)} rotation={90}  label="X+" color="#DC2626" /></div>
                <div style={{ gridArea: 'down' }}>  <JogArrow onPress={() => sendJog('y', -1)} rotation={180} label="Y−" color="#16A34A" /></div>
              </div>
            </div>

            <div>
              <div style={padLabelStyle}>Height</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: padBtn }}>
                <JogArrow onPress={() => sendJog('z',  1)} rotation={0}   label="Z+" color="#3B82F6" />
                <PadCenterTile label="Z" height={24} />
                <JogArrow onPress={() => sendJog('z', -1)} rotation={180} label="Z−" color="#3B82F6" />
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
                <div style={{ gridArea: 'rxp' }}>   <JogArrow onPress={() => sendJog('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" /></div>
                <div style={{ gridArea: 'rzn' }}>   <JogArrow onPress={() => sendJog('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" /></div>
                <div style={{ gridArea: 'center' }}><PadCenterTile label="Rot" /></div>
                <div style={{ gridArea: 'rzp' }}>   <JogArrow onPress={() => sendJog('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" /></div>
                <div style={{ gridArea: 'rxn' }}>   <JogArrow onPress={() => sendJog('rx', -1)} rotation={180} label="Rx−" color="#9333EA" /></div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {[1, 2, 3, 4, 5, 6].map((j) => (
              <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <JogArrow onPress={() => sendJog(j,  1)} rotation={0}   label={'+J' + j} color="#16A34A" size={56} />
                <PadCenterTile label={'J' + j} width={56} height={24} />
                <JogArrow onPress={() => sendJog(j, -1)} rotation={180} label={'−J' + j} color="#DC2626" size={56} />
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

const PAGES = [
  // 0: What operation?
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
          { value: 'palletize', label: 'Palletize', desc: 'Arrange parts in a grid pattern on a pallet', icon: 'G' },
          { value: 'inspect', label: 'Pick and Inspect', desc: 'Pick a part, inspect it with the camera, then sort pass/fail', icon: 'I' },
          { value: 'scan_identify', label: 'Scan & Identify', desc: 'Robot scans the workspace, moves above each detected object, identifies it from the parts library', icon: 'Q' },
        ].map(op => (
          <ChoiceButton key={op.value} label={op.label} description={op.desc} icon={op.icon}
            selected={answers.operation === op.value}
            onClick={() => { setAnswer('operation', op.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 0a: Scan-only — scan height. Gated on operation === 'scan_identify'.
  {
    id: 'scan_height',
    skip: (answers) => answers.operation !== 'scan_identify',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How close should the robot scan each part?"
        description="The robot moves above each detected object at this height for a close-up identification. Lower = more detail but smaller field of view."
      >
        <SliderQuestion
          label="Scan height"
          value={answers.scan_height || 150}
          onChange={(v) => setAnswer('scan_height', v)}
          min={80} max={300} step={10} unit="mm"
          description="Distance above the part surface during close-up scan"
        />
        <div style={{
          padding: 12, background: '#f0f9ff', borderRadius: 8,
          border: '1px solid #bfdbfe', fontSize: 12, color: '#2563EB', marginBottom: 16,
        }}>
          Recommended: 120–150 mm for small parts (under 10 cm). 200–250 mm for larger parts.
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 0b: Scan-only — what to do after scanning.
  {
    id: 'scan_after',
    skip: (answers) => answers.operation !== 'scan_identify',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What should happen after scanning?"
        description="After identifying all parts, what should the robot do?"
      >
        {[
          { value: 'report_only',    label: 'Report Only',       desc: 'Just identify and report what was found. Robot returns home.' },
          { value: 'pick_known',     label: 'Pick Known Parts',  desc: 'After scanning, pick identified parts and place them in their designated locations.' },
          { value: 'sort_by_type',   label: 'Sort by Type',      desc: 'After scanning, sort parts into different bins based on their type.' },
          { value: 'remove_defects', label: 'Remove Defects',    desc: 'After scanning, pick up defective parts and place them in a reject bin.' },
        ].map((o) => (
          <ChoiceButton
            key={o.value}
            label={o.label}
            description={o.desc}
            selected={answers.scan_after === o.value}
            onClick={() => { setAnswer('scan_after', o.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 0c: Scan-only — wide scan position source.
  {
    id: 'scan_wide_position',
    skip: (answers) => answers.operation !== 'scan_identify',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Where should the robot look from to see the full workspace?"
        description="The robot first moves to a high position to see all parts, then moves closer to each one."
      >
        {[
          { value: 'home',  label: 'Use Home Position',      desc: 'The home position already has a good view of the workspace.' },
          { value: 'teach', label: 'Teach a Scan Position',  desc: 'Jog the robot to a position where the camera can see the entire workspace.' },
        ].map((o) => (
          <ChoiceButton
            key={o.value}
            label={o.label}
            description={o.desc}
            selected={answers.scan_wide_source === o.value}
            onClick={() => { setAnswer('scan_wide_source', o.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 1: How does the robot find objects?
  {
    id: 'pick_method',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How should the robot find the parts?"
        description="Choose how the robot identifies what to pick up."
      >
        {[
          { value: 'camera_auto', label: 'Use Camera', desc: 'The camera detects objects automatically. Best when parts move around.' },
          { value: 'library_part', label: 'Look for Specific Part', desc: 'The camera looks for a specific part from the parts library. Only picks the right type.' },
          { value: 'fixed', label: 'Always Same Position', desc: 'The part is always in the same spot (e.g. from a feeder or conveyor).' },
        ].map(m => (
          <ChoiceButton key={m.value} label={m.label} description={m.desc}
            selected={answers.pick_method === m.value}
            onClick={() => { setAnswer('pick_method', m.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 2: Which part? (only if library_part selected)
  {
    id: 'which_part',
    skip: (answers) => answers.pick_method !== 'library_part',
    render: ({ answers, setAnswer, goNext }) => {
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
    },
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
          { value: 'magnetic', label: 'Magnetic', desc: 'Electromagnetic gripper. For ferrous metal parts only.' },
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
  {
    id: 'gripper_settings',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question={answers.gripper_type === 'finger' ? 'Set the gripper opening width' : answers.gripper_type === 'vacuum' ? 'Set the vacuum settings' : 'Configure the gripper'}
        description="These settings control how the gripper picks up parts."
      >
        {answers.gripper_type === 'finger' && (
          <>
            <SliderQuestion label="Opening width" value={answers.gripper_width || 85}
              onChange={v => setAnswer('gripper_width', v)} min={10} max={150} step={5} unit="mm"
              description="How wide the gripper opens before picking" />
            <SliderQuestion label="Grip force" value={answers.grip_force || 50}
              onChange={v => setAnswer('grip_force', v)} min={10} max={100} step={5} unit="%"
              description="How hard the gripper squeezes. Higher = more secure, but may damage soft parts" />
          </>
        )}
        {answers.gripper_type === 'vacuum' && (
          <SliderQuestion label="Vacuum threshold" value={answers.vacuum_threshold || 70}
            onChange={v => setAnswer('vacuum_threshold', v)} min={30} max={95} step={5} unit="%"
            description="Minimum vacuum level needed to confirm a successful pick" />
        )}
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 5: How fast?
  {
    id: 'speed',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How fast should the robot move?"
        description="Lower speed is safer, especially during initial testing. You can increase it later."
      >
        {[
          { value: 15, label: 'Slow', desc: 'Safe for first test runs. Good for heavy or fragile parts.' },
          { value: 40, label: 'Medium', desc: 'Normal production speed. Good balance of speed and safety.' },
          { value: 75, label: 'Fast', desc: 'Maximum production throughput. Use only after testing is complete.' },
        ].map(s => (
          <ChoiceButton key={s.value} label={s.label} description={s.desc}
            selected={answers.speed === s.value}
            onClick={() => { setAnswer('speed', s.value); goNext() }}
          />
        ))}
        <div style={{ marginTop: 16 }}>
          <SliderQuestion label="Custom speed" value={answers.speed || 40}
            onChange={v => setAnswer('speed', v)} min={5} max={100} step={5} unit="%"
            description="Or set an exact speed percentage" />
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 6: Approach height
  {
    id: 'approach',
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
  {
    id: 'place_method',
    skip: (answers) => answers.operation === 'machine_tend',
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

  // 8: Pallet configuration (only for palletize)
  {
    id: 'pallet_config',
    skip: (answers) => answers.place_method !== 'pallet',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Set up the pallet grid"
        description="How many rows and columns of parts on the pallet?"
      >
        <SliderQuestion label="Rows" value={answers.pallet_rows || 3}
          onChange={v => setAnswer('pallet_rows', v)} min={1} max={10} step={1} unit="" />
        <SliderQuestion label="Columns" value={answers.pallet_cols || 4}
          onChange={v => setAnswer('pallet_cols', v)} min={1} max={10} step={1} unit="" />
        <div style={{ fontSize: 14, color: '#374151', padding: '8px 0', fontWeight: 600 }}>
          Total positions: {(answers.pallet_rows || 3) * (answers.pallet_cols || 4)}
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 9: Machine I/O (only for machine_tend)
  {
    id: 'machine_io',
    skip: (answers) => answers.operation !== 'machine_tend',
    render: ({ answers, setAnswer, goNext }) => {
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
    },
  },

  // 10: Should it repeat?
  {
    id: 'repeat',
    render: ({ answers, setAnswer, goNext }) => (
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
    ),
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
  {
    id: 'teach_intro',
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
      if (answers.operation === 'inspect') {
        points.push('4. Inspection pose')
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
  {
    id: 'teach_home',
    render: ({ answers, setAnswer, goNext }) => (
      <TeachWithJog
        key="home_point"
        title="Teach the HOME position"
        description="This is where the robot rests between cycles. Jog to adjust if needed, or just record the current pose."
        instructions={[
          'The home position should be clear of all obstacles',
          'The robot should have good visibility of the workspace',
          'This position runs at the start and end of every cycle',
          'Press "Record This Position" to confirm',
        ]}
        pointName="home_point"
        answers={answers} setAnswer={setAnswer}
        onNext={goNext}
      />
    ),
  },

  // 14: Teach pick
  {
    id: 'teach_pick',
    render: ({ answers, setAnswer, goNext }) => (
      <TeachWithJog
        key="pick_point"
        title="Teach the PICK position"
        description="Move the robot to where it should pick up parts."
        instructions={[
          'Use the XY arrows to move the robot over the part',
          'Use Z− to lower the robot close to the part surface',
          'Use Rotation to align the gripper with the part',
          'Make sure the gripper can close around the part',
          'Press "Record This Position" when ready',
        ]}
        pointName="pick_point"
        answers={answers} setAnswer={setAnswer}
        onNext={goNext}
        // Camera-driven picks can skip a fixed teach point; runtime
        // detection supplies the pose. Fixed-position picks must teach.
        onSkip={answers.pick_method === 'fixed' ? null : goNext}
      />
    ),
  },

  // 15: Teach place
  {
    id: 'teach_place',
    skip: (answers) => answers.operation === 'machine_tend',
    render: ({ answers, setAnswer, goNext }) => (
      <TeachWithJog
        key="place_point"
        title="Teach the PLACE position"
        description="Move the robot to where parts should be placed."
        instructions={[
          'Use the XY arrows to move to the place location',
          'Use Z− to lower to the correct height',
          'The robot will open the gripper here to release the part',
          'Press "Record This Position" when ready',
        ]}
        pointName="place_point"
        answers={answers} setAnswer={setAnswer}
        onNext={goNext}
      />
    ),
  },

  // 16: Teach machine load
  {
    id: 'teach_machine_load',
    skip: (answers) => answers.operation !== 'machine_tend',
    render: ({ answers, setAnswer, goNext }) => (
      <TeachWithJog
        key="machine_load_point"
        title="Teach the MACHINE LOAD position"
        description="Move the robot to where it loads parts into the machine."
        instructions={[
          'Move the robot to the machine opening',
          'Position the gripper so the part aligns with the fixture',
          'Use small step sizes (0.1 mm) for precision near the machine',
          'Make sure there is clearance — the robot must not collide with the machine',
          'Press "Record This Position" when ready',
        ]}
        pointName="machine_load_point"
        answers={answers} setAnswer={setAnswer}
        onNext={goNext}
      />
    ),
  },

  // 17: Teach unload
  {
    id: 'teach_unload',
    skip: (answers) => answers.operation !== 'machine_tend',
    render: ({ answers, setAnswer, goNext }) => (
      <TeachWithJog
        key="unload_point"
        title="Teach the UNLOAD position"
        description="Move the robot to where finished parts should be placed after the machine cycle."
        instructions={[
          'Move the robot to the unload / output area',
          'Lower to the correct drop-off height',
          'Press "Record This Position" when ready',
        ]}
        pointName="unload_point"
        answers={answers} setAnswer={setAnswer}
        onNext={goNext}
      />
    ),
  },

  // 18: Teach inspection pose
  {
    id: 'teach_inspect',
    skip: (answers) => answers.operation !== 'inspect',
    render: ({ answers, setAnswer, goNext }) => (
      <TeachWithJog
        key="inspect_point"
        title="Teach the INSPECTION pose"
        description="Move the robot to where it holds the part in front of the camera for inspection."
        instructions={[
          'Position the part in clear view of the camera',
          'Make sure the camera can see all features of the part',
          'The part should be well-lit and at the right distance',
          'Press "Record This Position" when ready',
        ]}
        pointName="inspect_point"
        answers={answers} setAnswer={setAnswer}
        onNext={goNext}
      />
    ),
  },

  // 19: Review and save (final)
  {
    id: 'review',
    render: ({ answers, steps, saving, onSave }) => (
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

        <div style={{
          padding: 14, background: '#f8fafc', borderRadius: 10,
          border: '1px solid #e5e7eb', marginBottom: 16, fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, color: '#374151', marginBottom: 8 }}>Settings</div>
          <div style={{ color: '#6b7280' }}>Gripper: {answers.gripper_type}</div>
          <div style={{ color: '#6b7280' }}>Speed: {answers.speed}%</div>
          <div style={{ color: '#6b7280' }}>Approach height: {answers.approach_height}mm</div>
          <div style={{ color: '#6b7280' }}>Repeat: {answers.repeat === 'continuous' ? 'Continuously' : answers.repeat === 'count' ? answers.repeat_count + ' times' : 'Once'}</div>
        </div>

        <button onClick={onSave} disabled={saving} style={{
          width: '100%', padding: 16, fontSize: 17, fontWeight: 700,
          background: saving ? '#9ca3af' : '#16A34A', color: '#fff',
          border: 'none', borderRadius: 10, cursor: saving ? 'wait' : 'pointer',
        }}>
          {saving ? 'Saving...' : 'Save Program'}
        </button>
      </QuestionCard>
    ),
  },
]

// ────────────────────────────────────────────────────────
// Build steps from answers
// ────────────────────────────────────────────────────────

function buildSteps(answers) {
  const steps = []
  const spd = answers.speed || 40
  const slow = Math.min(spd, 30)
  const medium = Math.min(spd, 40)
  const appH = answers.approach_height || 100
  const gripW = answers.gripper_width || 85
  const gripF = answers.grip_force || 50
  const op = answers.operation

  steps.push({ action: 'move_home', label: 'Move to home position' })

  // Scan & Identify takes a different path — the rest of the picking
  // flow doesn't apply when the goal is to inventory the workspace.
  // We still fall through to the post-processing block at the bottom
  // so step numbering + taught-point application (home_point in
  // particular) work the same way for scan programs.
  const isScan = op === 'scan_identify'
  if (isScan) {
    if (answers.scan_wide_source === 'teach') {
      steps.push({ action: 'move_joint', label: 'Move to wide scan position', speed_pct: spd })
    }
    steps.push({
      action: 'scan_workspace',
      label:  'Scan workspace — detect all objects',
      scan_height_mm: answers.scan_height || 150,
      scan_speed_pct: Math.min(spd, 30),
      mode:   'wide',
    })
    steps.push({
      action: 'scan_identify_each',
      label:  'Move above each object and identify',
      scan_height_mm: answers.scan_height || 150,
      scan_speed_pct: Math.min(spd, 20),
      settle_time_ms: 500,
      capture_frames: 5,
      match_threshold_pct: 70,
    })
    const after = answers.scan_after || 'report_only'
    if (after === 'pick_known') {
      steps.push({ action: 'move_joint',   label: 'Move above first identified part', speed_pct: spd })
      steps.push({ action: 'move_linear',  label: 'Descend to pick',                  speed_pct: slow })
      if (answers.gripper_type === 'finger') {
        steps.push({ action: 'close_gripper', label: 'Grip part', force_pct: gripF, io_close: 'DO0', io_close_confirm: 'DI0' })
      }
      steps.push({ action: 'move_linear',  label: 'Lift part', offset_z_mm: appH, speed_pct: medium })
      steps.push({ action: 'move_joint',   label: 'Move to place position', speed_pct: spd })
      steps.push({ action: 'move_linear',  label: 'Descend to place', speed_pct: slow })
      if (answers.gripper_type === 'finger') {
        steps.push({ action: 'open_gripper', label: 'Release part', width_mm: gripW, io_open: 'DO1' })
      }
      steps.push({ action: 'move_linear',  label: 'Lift from place', offset_z_mm: appH, speed_pct: medium })
    } else if (after === 'sort_by_type') {
      steps.push({ action: 'sort_scanned',   label: 'Sort identified parts by type' })
    } else if (after === 'remove_defects') {
      steps.push({ action: 'remove_defects', label: 'Pick up defective parts and place in reject bin' })
    }
    steps.push({ action: 'move_home', label: 'Return to home' })
    if (answers.repeat === 'continuous') {
      steps.push({ action: 'loop', label: 'Repeat continuously', goto: 1, count: 0 })
    } else if (answers.repeat === 'count') {
      steps.push({ action: 'loop', label: 'Repeat ' + (answers.repeat_count || 10) + ' times', goto: 1, count: answers.repeat_count || 10 })
    }
  } else {
  // ── Standard pick / sort / machine_tend / palletize / inspect flow.
  //    Skipped for scan_identify, which built its own steps above.

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'open_gripper', label: 'Open gripper', width_mm: gripW, speed_pct: spd, io_open: 'DO1', io_open_confirm: 'DI1' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum off', io_id: 'DO2', value: 0 })
  }

  if (answers.pick_method === 'camera_auto') {
    steps.push({ action: 'detect', label: 'Detect objects with camera', mode: 'all' })
  } else if (answers.pick_method === 'library_part') {
    steps.push({ action: 'detect', label: 'Find ' + (answers.target_part_name || 'library part'), mode: 'library' })
  }

  steps.push({ action: 'approach', label: 'Move above pick position', target: answers.pick_method === 'fixed' ? 'fixed' : 'auto', offset_z_mm: appH, speed_pct: spd })
  steps.push({ action: 'move_linear', label: 'Descend to part', offset_z_mm: 0, speed_pct: slow })

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'close_gripper', label: 'Grip part', force_pct: gripF, io_close: 'DO0', io_close_confirm: 'DI0' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum on', io_id: 'DO2', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for vacuum seal', duration_s: 0.5 })
  } else {
    steps.push({ action: 'set_io', label: 'Magnet on', io_id: 'DO3', value: 1 })
  }

  steps.push({ action: 'move_linear', label: 'Lift part', offset_z_mm: appH, speed_pct: medium })

  if (op === 'machine_tend') {
    steps.push({ action: 'move_joint', label: 'Move to machine load position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to load position', offset_z_mm: 0, speed_pct: Math.min(spd, 20) })
    if (answers.gripper_type === 'finger') {
      steps.push({ action: 'open_gripper', label: 'Release part into machine', width_mm: gripW, io_open: 'DO1' })
    } else {
      steps.push({ action: 'set_io', label: 'Release part into machine', io_id: 'DO2', value: 0 })
    }
    steps.push({ action: 'move_linear', label: 'Retreat from machine', offset_z_mm: appH, speed_pct: slow })
    steps.push({ action: 'set_io', label: 'Start machine cycle', io_id: answers.io_cycle_start || 'DO4', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for machine to finish', duration_s: answers.cycle_timeout || 30 })
    steps.push({ action: 'set_io', label: 'Clear cycle start', io_id: answers.io_cycle_start || 'DO4', value: 0 })
    steps.push({ action: 'move_linear', label: 'Approach finished part', offset_z_mm: appH, speed_pct: slow })
    steps.push({ action: 'move_linear', label: 'Descend to finished part', offset_z_mm: 0, speed_pct: Math.min(spd, 20) })
    if (answers.gripper_type === 'finger') {
      steps.push({ action: 'close_gripper', label: 'Grip finished part', force_pct: gripF, io_close: 'DO0' })
    } else {
      steps.push({ action: 'set_io', label: 'Pick finished part', io_id: 'DO2', value: 1 })
    }
    steps.push({ action: 'move_linear', label: 'Lift finished part', offset_z_mm: appH, speed_pct: medium })
    steps.push({ action: 'move_joint', label: 'Move to unload position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to unload', offset_z_mm: 0, speed_pct: slow })
  } else if (op === 'inspect') {
    steps.push({ action: 'move_joint', label: 'Move to inspection pose', speed_pct: spd })
    steps.push({ action: 'detect', label: 'Inspect part with camera', mode: 'library' })
    steps.push({ action: 'move_joint', label: 'Move above place position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to place', offset_z_mm: 0, speed_pct: slow })
  } else {
    steps.push({ action: 'move_joint', label: 'Move above place position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to place', offset_z_mm: 0, speed_pct: slow })
  }

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'open_gripper', label: 'Release part', width_mm: gripW, io_open: 'DO1' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum off — release part', io_id: 'DO2', value: 0 })
    steps.push({ action: 'set_io', label: 'Blow off', io_id: 'DO3', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for blow off', duration_s: 0.3 })
    steps.push({ action: 'set_io', label: 'Blow off stop', io_id: 'DO3', value: 0 })
  } else {
    steps.push({ action: 'set_io', label: 'Magnet off — release part', io_id: 'DO3', value: 0 })
  }

  steps.push({ action: 'move_linear', label: 'Lift from place', offset_z_mm: appH, speed_pct: medium })
  steps.push({ action: 'move_home', label: 'Return to home' })

  if (answers.repeat === 'continuous') {
    steps.push({ action: 'loop', label: 'Repeat continuously', goto: 1, count: 0 })
  } else if (answers.repeat === 'count') {
    steps.push({ action: 'loop', label: 'Repeat ' + (answers.repeat_count || 10) + ' times', goto: 1, count: answers.repeat_count || 10 })
  }
  }  // end of !isScan picking flow

  // Inject taught data from the wizard's teach pages so the editor's
  // green T badges appear immediately for the positions the operator
  // recorded. Mapping rules:
  //   home_point         → first + last move_home (start / return-home)
  //   pick_point         → the 'approach' step (descend uses the same)
  //   place_point        → first move_joint or move_linear labelled
  //                        "Move above place position"
  //   machine_load_point → "Move to machine load position"
  //   unload_point       → "Move to unload position"
  //   inspect_point      → "Move to inspection pose"
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

  // First and last move_home both share home_point.
  if (cfg.home_point) {
    const homeIdxs = numbered.map((s, i) => s.action === 'move_home' ? i : -1).filter((i) => i >= 0)
    homeIdxs.forEach((i) => { numbered[i] = applyTaught(numbered[i], cfg.home_point) })
  }
  if (cfg.pick_point) {
    const i = numbered.findIndex((s) => s.action === 'approach')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], cfg.pick_point)
  }
  if (cfg.place_point) {
    const i = numbered.findIndex((s) =>
      (s.action === 'move_joint' || s.action === 'move_linear') &&
      typeof s.label === 'string' && s.label.toLowerCase().includes('place')
    )
    if (i >= 0) numbered[i] = applyTaught(numbered[i], cfg.place_point)
  }
  if (cfg.machine_load_point) {
    const i = numbered.findIndex((s) => s.action === 'move_joint' && s.label === 'Move to machine load position')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], cfg.machine_load_point)
  }
  if (cfg.unload_point) {
    const i = numbered.findIndex((s) => s.action === 'move_joint' && s.label === 'Move to unload position')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], cfg.unload_point)
  }
  if (cfg.inspect_point) {
    const i = numbered.findIndex((s) => s.action === 'move_joint' && s.label === 'Move to inspection pose')
    if (i >= 0) numbered[i] = applyTaught(numbered[i], cfg.inspect_point)
  }

  return numbered
}

// ────────────────────────────────────────────────────────
// Main wizard component
// ────────────────────────────────────────────────────────

export default function ProgramWizard({ onClose, onSaved }) {
  const [pageIdx, setPageIdx] = useState(0)
  const [answers, setAnswers] = useState({
    speed: 40,
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
      const res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: answers.program_name,
          description: PAGES[0] && answers.operation ? answers.operation.replace(/_/g, ' ') : '',
          steps: builtSteps,
          tags: [answers.operation],
          config: answers,
        }),
      })
      const data = await res.json()
      if (data.ok) { onSaved?.(data.program); onClose() }
    } catch {}
    setSaving(false)
  }

  const page = PAGES[pageIdx]
  const progressPct = ((history.length - 1) / (PAGES.length - 1)) * 100

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
          {page.render({
            answers,
            setAnswer,
            goNext,
            steps: builtSteps,
            saving,
            onSave: handleSave,
          })}
        </div>
      </div>
    </div>
  )
}

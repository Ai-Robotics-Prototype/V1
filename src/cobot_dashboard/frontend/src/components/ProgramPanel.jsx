import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'

const TYPE_META = {
  move:    { label: 'Move',    color: 'var(--accent)',       bg: 'var(--accent-dim)'  },
  gripper: { label: 'Gripper', color: '#7C3AED',             bg: 'rgba(124,58,237,.1)' },
  home:    { label: 'Home',    color: 'var(--text-muted)',   bg: 'var(--bg-surface)'  },
  wait:    { label: 'Wait',    color: 'var(--yellow)',       bg: 'var(--yellow-dim)'  },
}

// ── Drag-drop step list ───────────────────────────────────────────────────────
function StepList({ steps, onRemove, onReorder, activeStep }) {
  const dragIdx = useRef(null)

  function onDragStart(e, i) { dragIdx.current = i; e.dataTransfer.effectAllowed = 'move' }
  function onDragOver(e, i) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === i) return
    const ids = steps.map((s) => s.id)
    const [removed] = ids.splice(dragIdx.current, 1)
    ids.splice(i, 0, removed)
    dragIdx.current = i
    onReorder(ids)
  }
  function onDrop(e) { e.preventDefault(); dragIdx.current = null }

  if (!steps.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
        No steps — add one below
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {steps.map((step, i) => {
        const meta   = TYPE_META[step.type] || TYPE_META.move
        const done   = step.status === 'done'
        const active = i === activeStep

        return (
          <div
            key={step.id}
            draggable
            onDragStart={(e) => onDragStart(e, i)}
            onDragOver={(e) => onDragOver(e, i)}
            onDrop={onDrop}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '6px 10px',
              borderBottom: '1px solid var(--border)',
              borderLeft: `3px solid ${active ? 'var(--accent)' : done ? 'var(--green)' : 'transparent'}`,
              background: active ? 'var(--accent-dim)' : 'transparent',
              transition: 'background .2s',
            }}
          >
            {/* Drag handle */}
            <span style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: 12, userSelect: 'none' }}>⠿</span>

            {/* Status circle */}
            <div style={{
              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
              border: `2px solid ${done ? 'var(--green)' : active ? 'var(--accent)' : 'var(--border)'}`,
              background: done ? 'var(--green)' : active ? 'var(--accent-dim)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700,
              color: done ? '#fff' : active ? 'var(--accent)' : 'var(--text-muted)',
            }}>
              {done ? '✓' : i + 1}
            </div>

            {/* Step body */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {step.label}
              </div>
              {step.detail && (
                <div style={{ fontSize: 9, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                  {step.detail}
                </div>
              )}
            </div>

            {/* Type chip */}
            <span style={{
              fontSize: 8, padding: '1px 5px', borderRadius: 8,
              background: meta.bg, color: meta.color,
              textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700,
              flexShrink: 0,
            }}>
              {meta.label}
            </span>

            {/* Delete button */}
            {!active && (
              <button
                onClick={() => onRemove(step.id)}
                style={{
                  width: 18, height: 18, borderRadius: 4, border: 'none',
                  background: 'transparent', color: 'var(--text-muted)',
                  cursor: 'pointer', fontSize: 12, padding: 0, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Inline Add Form ───────────────────────────────────────────────────────────
function AddForm({ onAdd, onCancel }) {
  const joints  = useStore((s) => s.joints)
  const [type,  setType]  = useState('move')
  const [label, setLabel] = useState('')

  // Type-specific fields
  const [target,      setTarget]     = useState('')
  const [speed,       setSpeed]      = useState(50)
  const [gripAction,  setGripAction] = useState('open')
  const [gripWidth,   setGripWidth]  = useState(42)
  const [waitSecs,    setWaitSecs]   = useState(1)

  const inp = {
    width: '100%', background: 'var(--bg-surface)',
    border: '1px solid var(--border)', color: 'var(--text-primary)',
    borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, outline: 'none',
  }

  function buildDetail() {
    if (type === 'move')    return target ? `target: ${target}, speed: ${speed}%` : `speed: ${speed}%`
    if (type === 'gripper') return `${gripAction}, ${gripWidth}mm`
    if (type === 'home')    return `speed: ${speed}%`
    if (type === 'wait')    return `${waitSecs}s`
    return ''
  }

  function buildLabel() {
    if (label) return label
    if (type === 'move')    return target ? `Move to ${target}` : 'Move'
    if (type === 'gripper') return `Gripper ${gripAction}`
    if (type === 'home')    return 'Go home'
    if (type === 'wait')    return `Wait ${waitSecs}s`
    return type
  }

  function submit() {
    onAdd({ type, label: buildLabel(), detail: buildDetail() })
  }

  return (
    <div style={{ padding: '8px 10px', borderTop: '2px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
        Add Step
      </div>

      {/* Type selector pills */}
      <div style={{ display: 'flex', gap: 4 }}>
        {Object.entries(TYPE_META).map(([t, m]) => (
          <button
            key={t}
            onClick={() => setType(t)}
            style={{
              flex: 1, padding: '3px 0', fontSize: 10, fontWeight: 600,
              border: `1px solid ${type === t ? m.color : 'var(--border)'}`,
              background: type === t ? m.bg : 'transparent',
              color: type === t ? m.color : 'var(--text-muted)',
              borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Move fields */}
      {type === 'move' && (
        <>
          <input placeholder="Target (object class or leave blank)" value={target} onChange={(e) => setTarget(e.target.value)} style={inp} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 36 }}>Speed</span>
            <input type="range" min={10} max={100} step={10} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', width: 28, textAlign: 'right' }}>{speed}%</span>
          </div>
          <button
            type="button"
            onClick={() => {
              const pos = joints?.positions || []
              const deg = pos.map((r) => (r * 180 / Math.PI).toFixed(1) + '°').join(', ')
              setTarget(`[${deg}]`)
              if (!label) setLabel('Move to position')
            }}
            style={{
              fontSize: 10, padding: '3px 0',
              background: 'var(--bg-hover)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}
          >
            Use current position
          </button>
        </>
      )}

      {/* Gripper fields */}
      {type === 'gripper' && (
        <>
          <div style={{ display: 'flex', gap: 4 }}>
            {['open', 'close'].map((a) => (
              <button
                key={a}
                onClick={() => setGripAction(a)}
                style={{
                  flex: 1, padding: '4px 0', fontSize: 10, fontWeight: 600,
                  border: `1px solid ${gripAction === a ? 'var(--accent)' : 'var(--border)'}`,
                  background: gripAction === a ? 'var(--accent-dim)' : 'transparent',
                  color: gripAction === a ? 'var(--accent)' : 'var(--text-muted)',
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                }}
              >
                {a === 'open' ? 'Open' : 'Close'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 36 }}>Width</span>
            <input type="range" min={0} max={85} step={5} value={gripWidth} onChange={(e) => setGripWidth(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', width: 32, textAlign: 'right' }}>{gripWidth}mm</span>
          </div>
        </>
      )}

      {/* Home fields */}
      {type === 'home' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 36 }}>Speed</span>
          <input type="range" min={10} max={100} step={10} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', width: 28, textAlign: 'right' }}>{speed}%</span>
        </div>
      )}

      {/* Wait fields */}
      {type === 'wait' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 36 }}>Delay</span>
          <input type="number" min={0.1} max={60} step={0.5} value={waitSecs} onChange={(e) => setWaitSecs(Number(e.target.value))} style={{ ...inp, width: 60, flex: 'none' }} />
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>s</span>
        </div>
      )}

      {/* Custom label */}
      <input placeholder="Label (auto-generated if blank)" value={label} onChange={(e) => setLabel(e.target.value)} style={inp} />

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 5 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1, padding: '5px 0', fontSize: 10,
            background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={submit}
          style={{
            flex: 2, padding: '5px 0', fontSize: 10, fontWeight: 600,
            background: 'var(--accent-dim)', color: 'var(--accent)',
            border: '1px solid var(--accent-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}
        >
          Add Step →
        </button>
      </div>
    </div>
  )
}

// ── Voice Bar ─────────────────────────────────────────────────────────────────
function VoiceBar() {
  const sendVoice = useStore((s) => s.sendVoice)
  const [text,     setText]    = useState('')
  const [lastResp, setLastResp] = useState('')
  const [listening, setListening] = useState(false)
  const recognRef = useRef(null)

  function startListen() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) return
    const r = new SpeechRecognition()
    r.continuous = false
    r.onresult = (e) => { setText(e.results[0][0].transcript); setListening(false) }
    r.onend    = () => setListening(false)
    r.start()
    setListening(true)
    recognRef.current = r
  }

  async function submit() {
    if (!text.trim()) return
    const res = await sendVoice(text.trim())
    if (res?.response) setLastResp(res.response)
    setText('')
  }

  return (
    <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 5 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Ask RoboAi…"
          style={{
            flex: 1, background: 'var(--bg-surface)',
            border: '1px solid var(--border)', color: 'var(--text-primary)',
            borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 11, outline: 'none',
          }}
        />
        <button
          onClick={startListen}
          style={{
            width: 30, height: 28, borderRadius: 'var(--radius-sm)',
            border: `1px solid ${listening ? 'var(--red)' : 'var(--border)'}`,
            background: listening ? 'var(--red-dim)' : 'var(--bg-surface)',
            color: listening ? 'var(--red)' : 'var(--text-muted)',
            cursor: 'pointer', fontSize: 13,
            animation: listening ? 'safeBlink .8s ease infinite' : 'none',
          }}
        >
          🎤
        </button>
        <button
          onClick={submit}
          style={{
            height: 28, padding: '0 10px', fontSize: 10, fontWeight: 600,
            background: 'var(--accent-dim)', color: 'var(--accent)',
            border: '1px solid var(--accent-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}
        >
          →
        </button>
      </div>
      {lastResp && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>{lastResp}</div>
      )}
    </div>
  )
}

// ── ProgramPanel ──────────────────────────────────────────────────────────────
export default function ProgramPanel() {
  const program       = useStore((s) => s.program)
  const task          = useStore((s) => s.task)
  const safety        = useStore((s) => s.safety)
  const sendCommand   = useStore((s) => s.sendCommand)
  const addToast      = useStore((s) => s.addToast)

  const [progName,      setProgName]      = useState('Program 1')
  const [savedPrograms, setSavedPrograms] = useState([])
  const [showLoadMenu,  setShowLoadMenu]  = useState(false)
  const [showAddForm,   setShowAddForm]   = useState(false)

  const steps = program?.steps || []
  const estop = safety?.estop ?? true
  const progStep  = task?.program_step  ?? 0
  const progTotal = task?.program_total ?? steps.length
  const progPct   = progTotal > 0 ? Math.round(progStep / progTotal * 100) : 0

  useEffect(() => { if (program?.name) setProgName(program.name) }, [program?.name])

  async function addStep(step) {
    await sendCommand('program/add', step)
    setShowAddForm(false)
  }

  async function removeStep(id) { await sendCommand('program/remove', { id }) }

  async function reorderSteps(ids) { await sendCommand('program/reorder', { ids }) }

  async function saveProgram() {
    const currentSteps = useStore.getState().program?.steps || []
    const res = await fetch('/cmd/program/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: progName, steps: currentSteps }),
    })
    const d = await res.json()
    if (d.ok) addToast(`Saved "${progName}"`, 'success')
  }

  async function loadProgramList() {
    try {
      const res = await fetch('/api/programs')
      setSavedPrograms(await res.json())
    } catch (_) {}
  }

  async function loadProgram(name) {
    const res = await fetch(`/cmd/program/load/${name}`, { method: 'POST' })
    const d   = await res.json()
    if (d.ok) { setProgName(name); setShowLoadMenu(false); addToast(`Loaded "${name}"`, 'info') }
  }

  return (
    <div style={{
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%',
    }}>
      {/* Header */}
      <div style={{
        padding: '7px 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          Program
        </span>
        <span style={{
          fontSize: 9, padding: '1px 5px', borderRadius: 8,
          background: 'var(--bg-surface)', color: 'var(--text-muted)',
        }}>
          {steps.length}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => sendCommand('run_program', { name: progName })}
          disabled={estop || steps.length === 0 || task?.running}
          style={{
            fontSize: 10, fontWeight: 700, padding: '3px 10px',
            background: (!estop && steps.length > 0 && !task?.running) ? 'var(--green-dim)' : 'var(--bg-surface)',
            color:      (!estop && steps.length > 0 && !task?.running) ? 'var(--green)'     : 'var(--text-muted)',
            border: `1px solid ${(!estop && steps.length > 0 && !task?.running) ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: (estop || steps.length === 0 || task?.running) ? 0.4 : 1,
          }}
        >
          ▶ Run
        </button>
      </div>

      {/* Save/Load row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <input
          value={progName}
          onChange={(e) => setProgName(e.target.value)}
          style={{
            flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 'var(--radius-sm)', padding: '3px 7px', fontSize: 11, outline: 'none',
          }}
        />
        <button
          onClick={saveProgram}
          style={{
            fontSize: 10, padding: '3px 8px',
            background: 'var(--accent-dim)', color: 'var(--accent)',
            border: '1px solid var(--accent-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}
        >
          Save
        </button>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => { loadProgramList(); setShowLoadMenu((v) => !v) }}
            style={{
              fontSize: 10, padding: '3px 8px',
              background: 'var(--bg-surface)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}
          >
            Load ▾
          </button>
          {showLoadMenu && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, zIndex: 200,
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', minWidth: 160, marginTop: 2,
              boxShadow: 'var(--shadow-md)',
            }}>
              {savedPrograms.length === 0 ? (
                <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--text-muted)' }}>No saved programs</div>
              ) : savedPrograms.map((p) => (
                <div
                  key={p.name}
                  onClick={() => loadProgram(p.name)}
                  style={{
                    padding: '6px 10px', fontSize: 11, cursor: 'pointer',
                    color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'     }}
                >
                  {p.name}
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 5 }}>
                    {p.step_count} steps
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--bg-surface)', flexShrink: 0 }}>
        <div style={{
          height: '100%', background: 'var(--accent)',
          width: `${progPct}%`, transition: 'width .4s',
        }} />
      </div>

      {/* Steps list */}
      <StepList
        steps={steps}
        onRemove={removeStep}
        onReorder={reorderSteps}
        activeStep={task?.running ? (task.program_step ?? 0) : -1}
      />

      {/* Add step */}
      {showAddForm ? (
        <AddForm onAdd={addStep} onCancel={() => setShowAddForm(false)} />
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          style={{
            margin: '6px 10px', padding: '6px 0', fontSize: 11,
            border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)',
            background: 'transparent', color: 'var(--text-muted)',
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          + Add step
        </button>
      )}

      {/* Voice bar */}
      <VoiceBar />
    </div>
  )
}

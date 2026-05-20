import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'

const STEP_TYPES = [
  { value: 'move',          label: 'Move' },
  { value: 'pick',          label: 'Pick' },
  { value: 'place',         label: 'Place' },
  { value: 'grip_open',     label: 'Gripper Open' },
  { value: 'grip_close',    label: 'Gripper Close' },
  { value: 'wait',          label: 'Wait' },
  { value: 'home',          label: 'Home' },
  { value: 'loop',          label: 'Loop' },
]

const TYPE_COLORS = {
  move: 'var(--accent)', pick: 'var(--green)', place: '#A855F7',
  grip_open: 'var(--green)', grip_close: 'var(--accent)',
  wait: 'var(--yellow)', home: 'var(--text-muted)', loop: '#EC4899',
}

// ── Add Step Form ─────────────────────────────────────────────────────────────
function AddStepForm({ onAdd }) {
  const [type,   setType]   = useState('move')
  const [label,  setLabel]  = useState('')
  const [detail, setDetail] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    onAdd({ type, label: label || STEP_TYPES.find(t => t.value === type)?.label || type, detail })
    setLabel(''); setDetail('')
  }

  const inputStyle = {
    width: '100%', background: 'var(--bg-surface)',
    border: '1px solid var(--border)', color: 'var(--text-primary)',
    borderRadius: 'var(--radius-sm)', padding: '4px 8px',
    fontSize: 11, outline: 'none',
  }

  return (
    <form onSubmit={handleSubmit} style={{
      padding: '8px 12px', borderTop: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '.08em', marginBottom: 2 }}>
        Add Step
      </div>
      <select
        value={type} onChange={(e) => setType(e.target.value)}
        style={{ ...inputStyle, cursor: 'pointer' }}>
        {STEP_TYPES.map(t => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      <input
        placeholder="Label (optional)"
        value={label} onChange={(e) => setLabel(e.target.value)}
        style={inputStyle}
      />
      <input
        placeholder="Detail / parameters"
        value={detail} onChange={(e) => setDetail(e.target.value)}
        style={inputStyle}
      />
      {/* Use current position (move steps) */}
      {type === 'move' && (
        <button
          type="button"
          onClick={() => {
            const pos = useStore.getState().joints?.positions || []
            const deg = pos.map(r => (r * 180 / Math.PI).toFixed(1) + '°').join(', ')
            setDetail(`J: [${deg}]`)
            if (!label) setLabel('Move to position')
          }}
          style={{
            fontSize: 11, padding: '3px 10px',
            background: 'var(--bg-hover)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            cursor: 'pointer', width: '100%',
          }}>
          Use current position
        </button>
      )}
      <button type="submit" style={{
        padding: '5px 0', fontSize: 11, fontWeight: 600,
        background: 'var(--accent-dim)', color: 'var(--accent)',
        border: '1px solid var(--accent-border)',
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
      }}>
        + Add
      </button>
    </form>
  )
}

// ── Step row ──────────────────────────────────────────────────────────────────
function StepRow({ step, index, onRemove }) {
  const color = TYPE_COLORS[step.type] || 'var(--text-muted)'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px',
      borderBottom: '1px solid var(--border)',
      background: step.status === 'running' ? 'rgba(59,130,246,.08)' : 'transparent',
      transition: 'background .2s',
    }}>
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)', width: 16, flexShrink: 0,
      }}>
        {String(index + 1).padStart(2, '0')}
      </span>
      <span style={{
        fontSize: 9, padding: '1px 5px', borderRadius: 8,
        background: color + '20', color, border: `1px solid ${color}40`,
        textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700,
        flexShrink: 0,
      }}>
        {step.type}
      </span>
      <span style={{
        flex: 1, fontSize: 11, color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {step.label}
      </span>
      {step.detail && (
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 80,
        }}>
          {step.detail}
        </span>
      )}
      <button
        onClick={() => onRemove(step.id)}
        style={{
          width: 18, height: 18, borderRadius: 4, border: 'none',
          background: 'transparent', color: 'var(--text-muted)',
          cursor: 'pointer', fontSize: 12, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        ×
      </button>
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

  const [progName,       setProgName]       = useState('Program 1')
  const [savedPrograms,  setSavedPrograms]  = useState([])
  const [showLoadMenu,   setShowLoadMenu]   = useState(false)

  const steps = program?.steps || []
  const estop = safety?.estop ?? true

  // Sync name from store
  useEffect(() => {
    if (program?.name) setProgName(program.name)
  }, [program?.name])

  async function addStep(step) {
    await sendCommand('program/add', step)
  }

  async function removeStep(id) {
    await sendCommand('program/remove', { id })
  }

  async function saveProgram(name) {
    const currentSteps = useStore.getState().program?.steps || []
    const res = await fetch('/cmd/program/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, steps: currentSteps }),
    })
    const data = await res.json()
    if (data.ok) addToast(`Program "${name}" saved`, 'success')
  }

  async function loadProgramList() {
    try {
      const res  = await fetch('/api/programs')
      const data = await res.json()
      setSavedPrograms(Array.isArray(data) ? data : [])
    } catch (_) {}
  }

  async function loadProgram(name) {
    const res  = await fetch(`/cmd/program/load/${name}`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      setProgName(name)
      setShowLoadMenu(false)
      addToast(`Loaded "${name}"`, 'info')
    }
  }

  async function runProgram() {
    await sendCommand('run_program', { name: progName })
  }

  const progStep   = task?.program_step  ?? 0
  const progTotal  = task?.program_total ?? steps.length
  const progressPct = progTotal > 0 ? Math.round(progStep / progTotal * 100) : 0

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', flex: 1, minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--tm)' }}>
          Program Builder
        </span>
        <span style={{ fontSize: 10, color: 'var(--tm)' }}>
          {steps.length} step{steps.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Save / Load bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <input
          value={progName}
          onChange={(e) => setProgName(e.target.value)}
          style={{
            flex: 1, background: 'var(--bg-surface)',
            border: '1px solid var(--border)', color: 'var(--text-primary)',
            borderRadius: 'var(--radius-sm)', padding: '3px 8px', fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={() => saveProgram(progName)}
          style={{
            fontSize: 11, padding: '3px 10px',
            background: 'var(--accent-dim)', color: 'var(--accent)',
            border: '1px solid var(--accent-border)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}>
          Save
        </button>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => { loadProgramList(); setShowLoadMenu((v) => !v) }}
            style={{
              fontSize: 11, padding: '3px 10px',
              background: 'var(--bg-surface)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}>
            Load ▾
          </button>
          {showLoadMenu && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, zIndex: 100,
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', minWidth: 160, marginTop: 2,
              boxShadow: '0 4px 16px rgba(0,0,0,.4)',
            }}>
              {savedPrograms.length === 0 && (
                <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
                  No saved programs
                </div>
              )}
              {savedPrograms.map((p) => (
                <div
                  key={p.name}
                  onClick={() => loadProgram(p.name)}
                  style={{
                    padding: '7px 12px', fontSize: 12, color: 'var(--text-primary)',
                    cursor: 'pointer', borderBottom: '1px solid var(--border)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'     }}>
                  {p.name}
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>
                    {p.step_count} steps
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {task?.running && (
        <div style={{
          height: 3, background: 'var(--bg-surface)', flexShrink: 0,
        }}>
          <div style={{
            height: '100%', background: 'var(--green)',
            width: `${progressPct}%`, transition: 'width .4s',
          }} />
        </div>
      )}

      {/* Steps list */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {steps.length === 0 ? (
          <div style={{
            padding: 24, textAlign: 'center',
            fontSize: 11, color: 'var(--text-muted)',
          }}>
            No steps — add one below
          </div>
        ) : (
          steps.map((step, i) => (
            <StepRow key={step.id} step={step} index={i} onRemove={removeStep} />
          ))
        )}
      </div>

      {/* Add step form */}
      <AddStepForm onAdd={addStep} />

      {/* Run bar */}
      <div style={{
        padding: '8px 12px', borderTop: '1px solid var(--border)',
        display: 'flex', gap: 6, flexShrink: 0,
      }}>
        <button
          onClick={runProgram}
          disabled={estop || steps.length === 0 || task?.running}
          style={{
            flex: 1, height: 30, fontSize: 11, fontWeight: 700,
            background: (!estop && steps.length > 0 && !task?.running) ? 'var(--green-dim)' : 'var(--bg-surface)',
            color: (!estop && steps.length > 0 && !task?.running) ? 'var(--green)' : 'var(--text-muted)',
            border: `1px solid ${(!estop && steps.length > 0 && !task?.running) ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: (estop || steps.length === 0 || task?.running) ? 0.4 : 1,
          }}>
          ▶ Run Program
        </button>
        <button
          onClick={() => sendCommand('task', { command: 'cancel' })}
          disabled={!task?.running}
          style={{
            height: 30, padding: '0 12px', fontSize: 11,
            background: 'var(--bg-surface)', color: 'var(--red)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: task?.running ? 1 : 0.4,
          }}>
          Stop
        </button>
      </div>
    </div>
  )
}

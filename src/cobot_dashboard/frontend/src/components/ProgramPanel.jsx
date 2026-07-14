import { useState, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'

const STEP_COLORS = {
  move:    'var(--accent)',
  gripper: '#A855F7',
  home:    'var(--text-muted)',
  wait:    'var(--yellow)',
}

const STATUS_COLORS = {
  done:    'var(--green)',
  active:  'var(--accent)',
  pending: 'transparent',
}

const STEP_TYPE_OPTIONS = ['move', 'gripper', 'home', 'wait']

function StatusCircle({ status, number }) {
  const color = STATUS_COLORS[status] ?? 'transparent'
  return (
    <div style={{
      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
      background: status === 'done' ? 'var(--green-dim)' : status === 'active' ? 'var(--accent-dim)' : 'var(--bg-active)',
      border: `1.5px solid ${status === 'done' ? 'var(--green)' : status === 'active' ? 'var(--accent)' : 'var(--border)'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 10, fontWeight: 600,
      color: status === 'done' ? 'var(--green)' : status === 'active' ? 'var(--accent)' : 'var(--text-muted)',
    }}>
      {status === 'done' ? '✓' : number}
    </div>
  )
}

function TypeChip({ type }) {
  const color = STEP_COLORS[type] ?? 'var(--text-muted)'
  return (
    <span style={{
      fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '1px 5px', borderRadius: 8,
      background: `${color}18`, color, border: `1px solid ${color}40`,
      fontWeight: 600,
    }}>
      {type}
    </span>
  )
}

function StepRow({ step, index, isDragOver, onDragStart, onDragOver, onDrop, onRemove }) {
  const [hovered, setHovered] = useState(false)

  const borderColor = step.status === 'done' ? 'var(--green)' : step.status === 'active' ? 'var(--accent)' : 'transparent'

  return (
    <div
      draggable
      onDragStart={() => onDragStart(step.id)}
      onDragOver={(e) => { e.preventDefault(); onDragOver(step.id) }}
      onDrop={() => onDrop(step.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderLeft: `2px solid ${borderColor}`,
        background: step.status === 'active' ? 'rgba(59,130,246,0.05)' : isDragOver ? 'rgba(255,255,255,0.03)' : 'transparent',
        cursor: 'grab',
        borderRadius: '0 4px 4px 0',
        transition: 'background 150ms',
        position: 'relative',
      }}
    >
      <StatusCircle status={step.status} number={index + 1} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 1 }}>
          {step.label}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>
          {step.detail}
        </div>
        <TypeChip type={step.type} />
      </div>

      {/* Delete button — shown on hover */}
      {hovered && step.status !== 'active' && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(step.id) }}
          title="Remove step"
          style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            fontSize: 14, cursor: 'pointer', flexShrink: 0, padding: '0 2px',
            position: 'absolute', top: 6, right: 6,
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

// Add step form
function AddStepForm({ onAdd, onCancel }) {
  const [type, setType]     = useState('move')
  const [label, setLabel]   = useState('')
  const [detail, setDetail] = useState('')

  function handleSubmit() {
    if (!label.trim()) return
    onAdd({ type, label: label.trim(), detail: detail.trim() })
    setLabel('')
    setDetail('')
  }

  const inputStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 8px',
    fontSize: 12,
    width: '100%',
    outline: 'none',
  }

  return (
    <div style={{
      padding: '10px',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      {/* Type pills */}
      <div style={{ display: 'flex', gap: 4 }}>
        {STEP_TYPE_OPTIONS.map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            style={{
              background: type === t ? `${STEP_COLORS[t]}20` : 'transparent',
              border: `1px solid ${type === t ? STEP_COLORS[t] : 'var(--border)'}`,
              color: type === t ? STEP_COLORS[t] : 'var(--text-muted)',
              padding: '2px 8px',
              borderRadius: 10,
              fontSize: 10,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              cursor: 'pointer',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <input
        style={inputStyle}
        placeholder="Label (required)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        autoFocus
      />

      <input
        style={inputStyle}
        placeholder={
          type === 'move'    ? 'Target position / offset'
          : type === 'gripper' ? 'Width mm · Speed%'
          : type === 'wait'  ? 'Duration (s)'
          : 'Detail / notes'
        }
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />

      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            background: 'none', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', padding: '4px 10px',
            borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!label.trim()}
          style={{
            background: 'var(--accent)', border: 'none',
            color: '#fff', padding: '4px 12px',
            borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Add Step →
        </button>
      </div>
    </div>
  )
}

// Voice bar
function VoiceBar() {
  const sendVoice = useStore((s) => s.sendVoice)
  const addToast  = useStore((s) => s.addToast)

  const [text, setText]       = useState('')
  const [lastResp, setLastResp] = useState('')
  const [listening, setListening] = useState(false)
  const recognitionRef          = useRef(null)

  async function submit() {
    if (!text.trim()) return
    const result = await sendVoice(text.trim())
    if (result) setLastResp(result.response ?? '')
    setText('')
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      addToast('Speech recognition not supported in this browser', 'warning')
      return
    }
    const recog = new SR()
    recog.lang = 'en-US'
    recog.interimResults = false
    recog.onresult = (ev) => {
      const transcript = ev.results[0][0].transcript
      setText(transcript)
    }
    recog.onend = () => setListening(false)
    recog.onerror = () => setListening(false)
    recog.start()
    recognitionRef.current = recog
    setListening(true)
  }

  function stopListening() {
    if (recognitionRef.current) recognitionRef.current.stop()
    setListening(false)
  }

  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      padding: '8px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Ask NeuRobots…"
          style={{
            flex: 1,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            borderRadius: 'var(--radius-sm)',
            padding: '5px 8px',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={listening ? stopListening : startListening}
          title={listening ? 'Stop listening' : 'Start voice input'}
          style={{
            background: listening ? 'rgba(239,68,68,0.15)' : 'var(--bg-surface)',
            border: `1px solid ${listening ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
            color: listening ? 'var(--red)' : 'var(--text-muted)',
            borderRadius: 'var(--radius-sm)',
            padding: '5px 8px',
            fontSize: 14,
            animation: listening ? 'pulse-opacity 1s ease-in-out infinite' : 'none',
          }}
        >
          🎤
        </button>
        <button
          onClick={submit}
          disabled={!text.trim()}
          style={{
            background: 'var(--accent)',
            border: 'none', color: '#fff',
            borderRadius: 'var(--radius-sm)',
            padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Send
        </button>
      </div>
      {lastResp && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '0 2px' }}>
          ↳ {lastResp}
        </div>
      )}
    </div>
  )
}

export default function ProgramPanel() {
  const program          = useStore((s) => s.program)
  const task             = useStore((s) => s.task)
  const addProgramStep   = useStore((s) => s.addProgramStep)
  const removeProgramStep= useStore((s) => s.removeProgramStep)
  const reorderSteps     = useStore((s) => s.reorderSteps)

  const steps        = program.steps ?? []
  const doneCount    = steps.filter((s) => s.status === 'done').length
  const totalCount   = steps.length

  const [showForm, setShowForm]   = useState(false)
  const [dragId, setDragId]       = useState(null)
  const [dragOverId, setDragOverId] = useState(null)

  function handleDragStart(id) {
    setDragId(id)
  }

  function handleDragOver(id) {
    setDragOverId(id)
  }

  function handleDrop(targetId) {
    if (dragId === null || dragId === targetId) {
      setDragId(null)
      setDragOverId(null)
      return
    }
    const ids   = steps.map((s) => s.id)
    const fromI = ids.indexOf(dragId)
    const toI   = ids.indexOf(targetId)
    const newIds = [...ids]
    newIds.splice(fromI, 1)
    newIds.splice(toI, 0, dragId)
    reorderSteps(newIds)
    setDragId(null)
    setDragOverId(null)
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-panel)',
      borderLeft: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Program</span>
        <span style={{
          fontSize: 10, background: 'var(--bg-active)',
          color: 'var(--text-secondary)', padding: '1px 7px', borderRadius: 10,
        }}>
          {totalCount} step{totalCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>Progress</span>
          <div style={{ flex: 1, height: 3, background: 'var(--bg-active)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              width: totalCount > 0 ? `${(doneCount / totalCount) * 100}%` : '0%',
              height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width 300ms',
            }} />
          </div>
          <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            {doneCount} / {totalCount}
          </span>
        </div>
      </div>

      {/* Step list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {steps.map((step, index) => (
          <div key={step.id}>
            <StepRow
              step={step}
              index={index}
              isDragOver={dragOverId === step.id}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onRemove={removeProgramStep}
            />
            {/* Connector line */}
            {index < steps.length - 1 && (
              <div style={{
                marginLeft: 20,
                width: 2,
                height: 8,
                background: 'var(--border)',
              }} />
            )}
          </div>
        ))}

        {/* Add step */}
        {showForm ? (
          <div style={{ padding: '6px 10px' }}>
            <AddStepForm
              onAdd={(step) => { addProgramStep(step); setShowForm(false) }}
              onCancel={() => setShowForm(false)}
            />
          </div>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            style={{
              display: 'block',
              width: 'calc(100% - 20px)',
              margin: '6px 10px',
              background: 'none',
              border: '1px dashed var(--border)',
              color: 'var(--text-muted)',
              borderRadius: 'var(--radius-md)',
              padding: '6px',
              fontSize: 11,
              cursor: 'pointer',
              textAlign: 'center',
              transition: 'border-color 150ms, color 150ms',
            }}
            onMouseEnter={(e) => {
              e.target.style.borderColor = 'var(--border-bright)'
              e.target.style.color = 'var(--text-secondary)'
            }}
            onMouseLeave={(e) => {
              e.target.style.borderColor = 'var(--border)'
              e.target.style.color = 'var(--text-muted)'
            }}
          >
            + Add step
          </button>
        )}
      </div>

      {/* Voice bar */}
      <VoiceBar />
    </div>
  )
}

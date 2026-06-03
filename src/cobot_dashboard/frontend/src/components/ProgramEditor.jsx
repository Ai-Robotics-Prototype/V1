import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import ProgramWizard from './ProgramWizard'

// The richer action taxonomy lives in the editor. Each action carries
// a coarse `type` (matching the existing backend schema: move/gripper/
// home/wait/etc.) so legacy consumers keep working, plus a list of
// typed parameter fields the editor knows how to render.
const ACTION_TYPES = [
  { value: 'move_home',     label: 'Move to Home',     type: 'home',    tag: 'HOME',    fields: [] },
  { value: 'open_gripper',  label: 'Open Gripper',     type: 'gripper', tag: 'GRIPPER', fields: ['width_mm', 'speed_pct', 'io_open', 'io_open_confirm'] },
  { value: 'close_gripper', label: 'Close Gripper',    type: 'gripper', tag: 'GRIPPER', fields: ['force_pct', 'io_close', 'io_close_confirm'] },
  { value: 'move_joint',    label: 'Move Joint',       type: 'move',    tag: 'MOVE',    fields: ['joints'] },
  { value: 'move_linear',   label: 'Move Linear',      type: 'move',    tag: 'MOVE',    fields: ['position', 'offset_z_mm', 'speed_pct'] },
  { value: 'approach',      label: 'Approach Object',  type: 'move',    tag: 'MOVE',    fields: ['target', 'offset_z_mm'] },
  { value: 'pick',          label: 'Pick and Close',   type: 'gripper', tag: 'PICK',    fields: ['descend_mm'] },
  { value: 'place',         label: 'Place at Target',  type: 'move',    tag: 'PLACE',   fields: ['position'] },
  { value: 'wait',          label: 'Wait',             type: 'wait',    tag: 'WAIT',    fields: ['duration_s'] },
  { value: 'detect',        label: 'Detect Objects',   type: 'move',    tag: 'DETECT',  fields: ['mode'] },
  { value: 'loop',          label: 'Loop',             type: 'move',    tag: 'LOOP',    fields: ['goto', 'count'] },
  { value: 'set_io',        label: 'Set I/O',          type: 'move',    tag: 'IO',      fields: ['io_id', 'value'] },
]

const TAG_COLORS = {
  HOME: '#6366f1', GRIPPER: '#f59e0b', MOVE: '#2563EB', PICK: '#16A34A',
  PLACE: '#0891b2', WAIT: '#6b7280', DETECT: '#8b5cf6', LOOP: '#ec4899', IO: '#f97316',
}

function actionFor(step) {
  return ACTION_TYPES.find((a) => a.value === step.action)
      ?? ACTION_TYPES.find((a) => a.type === step.type)
      ?? ACTION_TYPES[0]
}

// Format the secondary detail line under the label.
function detailLine(step, ioLabels) {
  const ioName = (id) => (ioLabels && ioLabels[id]) || id
  const bits = [step.action || step.type]
  if (step.target)      bits.push('target: ' + step.target)
  if (step.position)    bits.push('pos: [' + step.position.map((p) => Number(p).toFixed(2)).join(', ') + ']')
  if (step.joints)      bits.push('joints: [' + step.joints.join(',') + '] deg')
  if (step.duration_s)  bits.push(step.duration_s + 's')
  if (step.width_mm)    bits.push(step.width_mm + 'mm')
  if (step.descend_mm)  bits.push('descend ' + step.descend_mm + 'mm')
  if (step.offset_z_mm !== undefined) bits.push('z' + (step.offset_z_mm >= 0 ? '+' : '') + step.offset_z_mm + 'mm')
  if (step.speed_pct)   bits.push(step.speed_pct + '%')
  if (step.io_id)       bits.push(ioName(step.io_id) + '=' + (step.value ? 'ON' : 'OFF'))
  if (step.io_open)         bits.push('open→' + ioName(step.io_open))
  if (step.io_open_confirm) bits.push('verify ' + ioName(step.io_open_confirm))
  if (step.io_close)        bits.push('close→' + ioName(step.io_close))
  if (step.io_close_confirm) bits.push('verify ' + ioName(step.io_close_confirm))
  return bits.join(' | ')
}

// Shared label fetch — one round-trip per editor mount instead of one
// per IOPortSelector instance. Backend now always returns factory
// defaults merged with operator overrides so `labels[id]` is defined
// for every port.
function useIOLabels() {
  const [labels, setLabels] = useState({})
  useEffect(() => {
    let alive = true
    fetch('/api/io/config')
      .then((r) => r.json())
      .then((d) => { if (alive && d) setLabels(d.labels || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return labels
}

// Dropdown that lists DO* or DI* ports with their pin numbers and the
// operator-renamed labels from /api/io/config. Renders an "unassigned"
// option at the top so a step can opt out of I/O explicitly.
function IOPortSelector({ label, value, onChange, direction }) {
  const [labels, setLabels] = useState({})

  useEffect(() => {
    let alive = true
    fetch('/api/io/config')
      .then((r) => r.json())
      .then((d) => { if (alive && d) setLabels(d.labels || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const ports = Array.from({ length: 16 }, (_, i) => {
    const id  = (direction === 'output' ? 'DO' : 'DI') + i
    const pin = (direction === 'output' ? 'Y' : 'X') + Math.floor(i / 8) + '.' + (i % 8)
    return { id, pin, label: labels[id] || id }
  })

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{label}</div>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}
        style={{ ...selectStyle }}>
        <option value="">Not assigned</option>
        {ports.map((p) => (
          <option key={p.id} value={p.id}>{p.pin} — {p.label}</option>
        ))}
      </select>
    </div>
  )
}

function StepEditor({ step, onSave, onClose }) {
  const [draft, setDraft] = useState({ ...step })
  const actionDef = actionFor(draft)

  const update = (key, val) => setDraft((prev) => ({ ...prev, [key]: val }))

  function changeAction(actionValue) {
    const nextDef = ACTION_TYPES.find((a) => a.value === actionValue) || ACTION_TYPES[0]
    setDraft((prev) => ({ ...prev, action: nextDef.value, type: nextDef.type }))
  }

  function commit() {
    const def = actionFor(draft)
    const patch = { action: draft.action || def.value, type: def.type, label: draft.label }
    for (const f of def.fields) {
      if (draft[f] !== undefined) patch[f] = draft[f]
    }
    onSave(patch)
    onClose()
  }

  return (
    <div style={{
      background: '#fff', border: '2px solid #2563EB', borderRadius: 8,
      padding: 14, marginBottom: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#2563EB' }}>EDITING STEP</span>
        <div style={{ flex: 1 }} />
        <button onClick={commit} style={{
          padding: '4px 14px', fontSize: 11, fontWeight: 600,
          background: '#2563EB', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
        }}>Save</button>
        <button onClick={onClose} style={{
          padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#6b7280',
          border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
        }}>Cancel</button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Action</div>
        <select value={draft.action || actionDef.value} onChange={(e) => changeAction(e.target.value)} style={selectStyle}>
          {ACTION_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Label</div>
        <input value={draft.label || ''} onChange={(e) => update('label', e.target.value)}
          placeholder={actionDef.label} style={inputStyle} />
      </div>

      {actionDef.fields.includes('width_mm') && (
        <Field label="Gripper Width (mm)">
          <input type="number" value={draft.width_mm ?? 85}
            onChange={(e) => update('width_mm', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('speed_pct') && (
        <Field label="Speed (%)">
          <input type="number" min={1} max={100} value={draft.speed_pct ?? 80}
            onChange={(e) => update('speed_pct', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('force_pct') && (
        <Field label="Force (%)">
          <input type="number" min={1} max={100} value={draft.force_pct ?? 50}
            onChange={(e) => update('force_pct', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {(actionDef.fields.includes('io_open') || actionDef.fields.includes('io_close')) && (
        <div style={{
          padding: '8px 10px', marginTop: 4, marginBottom: 8,
          background: '#f8fafc', borderRadius: 6, border: '1px solid #e5e7eb',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
            I/O Port Assignment
          </div>
          {actionDef.fields.includes('io_open') && (
            <IOPortSelector
              label="Open signal (output to activate)"
              value={draft.io_open}
              onChange={(v) => update('io_open', v)}
              direction="output"
            />
          )}
          {actionDef.fields.includes('io_open_confirm') && (
            <IOPortSelector
              label="Open confirm (input to verify)"
              value={draft.io_open_confirm}
              onChange={(v) => update('io_open_confirm', v)}
              direction="input"
            />
          )}
          {actionDef.fields.includes('io_close') && (
            <IOPortSelector
              label="Close signal (output to activate)"
              value={draft.io_close}
              onChange={(v) => update('io_close', v)}
              direction="output"
            />
          )}
          {actionDef.fields.includes('io_close_confirm') && (
            <IOPortSelector
              label="Close confirm (input to verify)"
              value={draft.io_close_confirm}
              onChange={(v) => update('io_close_confirm', v)}
              direction="input"
            />
          )}
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
            Operator-renamed labels from the Sensors tab show here. The confirm input is optional — when set, the program waits for that signal before continuing.
          </div>
        </div>
      )}
      {actionDef.fields.includes('target') && (
        <Field label="Target">
          <select value={draft.target || 'auto'} onChange={(e) => update('target', e.target.value)} style={selectStyle}>
            <option value="auto">Auto (nearest object)</option>
            <option value="selected">Selected object</option>
            <option value="named">Named part...</option>
          </select>
        </Field>
      )}
      {actionDef.fields.includes('offset_z_mm') && (
        <Field label="Z Offset (mm above)">
          <input type="number" value={draft.offset_z_mm ?? 150}
            onChange={(e) => update('offset_z_mm', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('descend_mm') && (
        <Field label="Descend (mm)">
          <input type="number" value={draft.descend_mm ?? 130}
            onChange={(e) => update('descend_mm', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('position') && (
        <Field label="Position X, Y, Z (m)">
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 1, 2].map((i) => (
              <input key={i} type="number" step="0.01"
                value={(draft.position || [0.3, -0.2, 0.4])[i]}
                onChange={(e) => {
                  const pos = [...(draft.position || [0.3, -0.2, 0.4])]
                  pos[i] = parseFloat(e.target.value)
                  update('position', pos)
                }}
                style={{ ...inputStyle, flex: 1 }} />
            ))}
          </div>
        </Field>
      )}
      {actionDef.fields.includes('joints') && (
        <Field label="Joint Angles (deg)">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[0, 1, 2, 3, 4, 5].map((j) => (
              <input key={j} type="number" step="1"
                value={(draft.joints || [0, -90, 0, -90, 0, 0])[j]}
                onChange={(e) => {
                  const jts = [...(draft.joints || [0, -90, 0, -90, 0, 0])]
                  jts[j] = parseFloat(e.target.value)
                  update('joints', jts)
                }}
                placeholder={'J' + (j + 1)}
                style={{ ...inputStyle, width: 52, padding: '6px 4px', fontSize: 11, textAlign: 'center' }} />
            ))}
          </div>
        </Field>
      )}
      {actionDef.fields.includes('duration_s') && (
        <Field label="Duration (seconds)">
          <input type="number" step="0.5" value={draft.duration_s ?? 1}
            onChange={(e) => update('duration_s', parseFloat(e.target.value))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('mode') && (
        <Field label="Detection Mode">
          <select value={draft.mode || 'all'} onChange={(e) => update('mode', e.target.value)} style={selectStyle}>
            <option value="all">All Objects</option>
            <option value="library">Library Parts Only</option>
          </select>
        </Field>
      )}
      {actionDef.fields.includes('io_id') && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <IOPortSelector
              label="I/O Port"
              value={draft.io_id}
              onChange={(v) => update('io_id', v || 'DO0')}
              direction="output"
            />
          </div>
          <Field label="Value" style={{ flex: 1 }}>
            <select value={draft.value ?? 1} onChange={(e) => update('value', parseInt(e.target.value, 10))} style={selectStyle}>
              <option value={1}>ON</option>
              <option value={0}>OFF</option>
            </select>
          </Field>
        </div>
      )}
      {actionDef.fields.includes('goto') && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Field label="Go to step" style={{ flex: 1 }}>
            <input type="number" min={1} value={draft.goto ?? 1}
              onChange={(e) => update('goto', parseInt(e.target.value, 10))} style={inputStyle} />
          </Field>
          <Field label="Repeat count (0=infinite)" style={{ flex: 1 }}>
            <input type="number" min={0} value={draft.count ?? 0}
              onChange={(e) => update('count', parseInt(e.target.value, 10))} style={inputStyle} />
          </Field>
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 4,
  border: '1px solid #d1d5db', background: '#fafafa', outline: 'none',
}
const selectStyle = { ...inputStyle }

function Field({ label, children, style }) {
  return (
    <div style={{ marginBottom: 8, ...style }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}

function VoiceBar() {
  const sendVoice = useStore((s) => s.sendVoice)
  const addToast  = useStore((s) => s.addToast)
  const [text, setText]         = useState('')
  const [lastResp, setLastResp] = useState('')
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef(null)

  async function submit() {
    if (!text.trim()) return
    const result = await sendVoice(text.trim())
    if (result) setLastResp(result.response ?? '')
    setText('')
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { addToast('Speech recognition not supported in this browser', 'warning'); return }
    const recog = new SR()
    recog.lang = 'en-US'
    recog.interimResults = false
    recog.onresult = (ev) => { setText(ev.results[0][0].transcript) }
    recog.onend   = () => setListening(false)
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
      borderTop: '1px solid #e5e7eb',
      padding: '8px 12px',
      background: '#fafafa',
      display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Ask RoboAi…"
          style={{ flex: 1, padding: '5px 8px', fontSize: 12, borderRadius: 4,
                   border: '1px solid #d1d5db', background: '#fff', outline: 'none' }} />
        <button onClick={listening ? stopListening : startListening}
          title={listening ? 'Stop listening' : 'Start voice input'}
          style={{ padding: '5px 8px', fontSize: 14, borderRadius: 4,
                   background: listening ? 'rgba(239,68,68,0.15)' : '#fff',
                   border: `1px solid ${listening ? 'rgba(239,68,68,0.4)' : '#d1d5db'}`,
                   color: listening ? '#DC2626' : '#6b7280', cursor: 'pointer' }}>
          🎤
        </button>
        <button onClick={submit} disabled={!text.trim()}
          style={{ padding: '5px 12px', fontSize: 11, fontWeight: 600, borderRadius: 4,
                   border: 'none', background: '#2563EB', color: '#fff', cursor: 'pointer' }}>
          Send
        </button>
      </div>
      {lastResp && (
        <div style={{ fontSize: 10, color: '#6b7280', padding: '0 2px' }}>↳ {lastResp}</div>
      )}
    </div>
  )
}

function InsertionBar() {
  return (
    <div
      // Don't intercept drag events — the bar lives between rows but
      // we want dragover to keep firing on the rows themselves.
      style={{
        height: 4,
        background: '#2563EB',
        borderRadius: 2,
        margin: '2px 12px',
        boxShadow: '0 0 8px rgba(37, 99, 235, 0.45)',
        pointerEvents: 'none',
      }}
    />
  )
}

// Size the rename input to fit the current text, clamped between
// 80px (so a one-character draft is still clickable) and 300px (so a
// long paste doesn't push the row's buttons off the right edge).
function labelInputWidth(text) {
  return Math.max(80, Math.min(300, (text || '').length * 8 + 24))
}

function EditableStepLabel({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => {
    if (editing && ref.current) { ref.current.focus(); ref.current.select() }
  }, [editing])

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input ref={ref} value={draft}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        style={{
          fontSize: 12, fontWeight: 600, padding: '2px 6px',
          background: '#fff', color: '#111',
          border: '1px solid #2563EB', borderRadius: 3,
          outline: 'none',
          width: labelInputWidth(draft),
        }}
      />
    )
  }

  return (
    <span
      onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}
      title="Click to rename"
      style={{
        fontSize: 12, fontWeight: 600, color: '#111',
        cursor: 'text', padding: '2px 4px', borderRadius: 3,
        display: 'inline-block',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {value}
    </span>
  )
}

// Renumber step ids 1..N. Called after every local mutation so the
// drag/select handlers (which key off step.id) always have unique,
// stable ids.
function renumber(arr) {
  return arr.map((s, i) => ({ ...s, id: i + 1 }))
}

export default function ProgramEditor() {
  const currentProgram     = useStore((s) => s.currentProgram)
  const setCurrentProgram  = useStore((s) => s.setCurrentProgram)
  // setProgramSteps mirrors the editor's current steps to STATE.program
  // on Save / Load so the task runner (Run button) sees the same
  // program the editor displays. Edits between saves stay local.
  const setProgramSteps    = useStore((s) => s.setProgramSteps)
  const loadedProgram      = useStore((s) => s.loadedProgram)
  const setLoadedProgram   = useStore((s) => s.setLoadedProgram)
  // For execution highlights we still need to know what the task
  // runner thinks is the active step. status comes from STATE.program
  // (the saved version that's actually running); we match by index so
  // an unsaved edit doesn't desync the highlight when running matches
  // the last save.
  const runningSteps       = useStore((s) => s.program.steps ?? [])
  const taskRunning        = useStore((s) => Boolean(s.task?.running || s.task?.paused))

  // Operator-renamed I/O labels for the detail line + IOPortSelector
  // dropdowns. Fetched once per editor mount.
  const ioLabels           = useIOLabels()

  // Editor identity / steps / unsaved all live in the store now so a
  // tab swap unmount-and-remount doesn't reset them.
  const programId   = currentProgram.id
  const programName = currentProgram.name
  const steps       = currentProgram.steps || []
  const unsaved     = currentProgram.unsaved

  // Setters that wrap the store action with the right patch shape.
  const setProgramName = (name) => setCurrentProgram({ name, unsaved: true })
  const updateSteps    = (next) => setCurrentProgram({ steps: next, unsaved: true })

  // Transient UI state (selection / drag / wizard / load-menu / save
  // status) is fine to keep local — losing it on tab switch is the
  // expected behaviour, file-manager style.
  const [showWizard, setShowWizard]       = useState(false)
  const [editingId, setEditingId]         = useState(null)
  const [selectedId, setSelectedId]       = useState(null)
  const [dragId, setDragId]               = useState(null)
  const [dragOverId, setDragOverId]       = useState(null)
  const [dragOverPos, setDragOverPos]     = useState(null)
  const [saveStatus, setSaveStatus]       = useState(null)
  const [showLoadMenu, setShowLoadMenu]   = useState(false)
  const [savedPrograms, setSavedPrograms] = useState([])

  // Diagnostic: log what the editor sees on every mount so a future
  // "switching tabs lost my program" report can be verified — if
  // currentProgram is intact here the bug is in render, not state.
  useEffect(() => {
    console.log('[ProgramEditor] mounted with currentProgram',
      { id: currentProgram.id, name: currentProgram.name, steps: currentProgram.steps?.length, unsaved: currentProgram.unsaved })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ProgramLibrary writes a saved program into the store and switches
  // to this tab. Consume it once, populate currentProgram, mirror to
  // STATE.program so Run sees it, then clear the slot.
  useEffect(() => {
    if (!loadedProgram || !loadedProgram.id) return
    console.log('[ProgramEditor] consuming loadedProgram',
      { id: loadedProgram.id, name: loadedProgram.name, steps: loadedProgram.steps?.length })
    const steps = Array.isArray(loadedProgram.steps) ? loadedProgram.steps : []
    setCurrentProgram({
      id:     loadedProgram.id,
      name:   loadedProgram.name || 'Untitled Program',
      steps:  steps,
      unsaved: false,
    })
    setProgramSteps(steps)
    setLoadedProgram(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedProgram])

  // Execution highlight: when a task is running, map step ids to the
  // backend's status by index (the saved program is what's running, so
  // index alignment is correct as long as the editor matches the last
  // save). If editor has unsaved edits, indices may diverge — the
  // unsaved indicator already warns the operator.
  function statusOf(idx) {
    if (!taskRunning) return null
    return runningSteps[idx]?.status ?? null
  }
  const doneCount = taskRunning
    ? Math.min(steps.length, runningSteps.filter((s) => s.status === 'done').length)
    : 0

  function handleDragStart(e, id) {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id))
  }

  function handleDragOver(e, id) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    const pos  = e.clientY < midY ? 'before' : 'after'
    if (dragOverId !== id) setDragOverId(id)
    if (dragOverPos !== pos) setDragOverPos(pos)
  }

  function clearDrag() {
    setDragId(null)
    setDragOverId(null)
    setDragOverPos(null)
  }

  function handleDrop(e, targetId) {
    e.preventDefault()
    if (dragId === null) { clearDrag(); return }
    const ids   = steps.map((s) => s.id)
    const fromI = ids.indexOf(dragId)
    const toI   = ids.indexOf(targetId)
    if (fromI < 0 || toI < 0) { clearDrag(); return }
    // Compute the *post-removal* insertion index. 'after' lands after
    // the target (toI + 1); if we're removing from a position before
    // that, the splice shifts indices down by one.
    let insertI = dragOverPos === 'after' ? toI + 1 : toI
    if (fromI < insertI) insertI -= 1
    if (fromI === insertI) { clearDrag(); return }
    const next = [...steps]
    const [moved] = next.splice(fromI, 1)
    next.splice(insertI, 0, moved)
    updateSteps(renumber(next))
    clearDrag()
  }

  function handleDragEnd() { clearDrag() }

  function handleAdd() {
    const newStep = { type: 'wait', action: 'wait', label: 'Wait', duration_s: 1, detail: '' }
    updateSteps(renumber([...steps, newStep]))
  }

  function handleDelete(id) {
    updateSteps(renumber(steps.filter((s) => s.id !== id)))
  }

  function handleRename(id, newLabel) {
    updateSteps(renumber(steps.map((s) => s.id === id ? { ...s, label: newLabel } : s)))
  }

  function handleEditSave(id, patch) {
    updateSteps(renumber(steps.map((s) => s.id === id ? { ...s, ...patch } : s)))
  }

  async function handleSave() {
    if (saveStatus === 'saving') return
    const name = programName.trim() || 'Untitled Program'
    setSaveStatus('saving')
    try {
      const body = JSON.stringify({ name, steps })
      const res = await fetch(
        programId ? `/api/programs/${encodeURIComponent(programId)}` : '/api/programs',
        { method: programId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' }, body },
      )
      const data = await res.json().catch(() => ({}))
      if (res.ok && data && data.ok && data.program) {
        setCurrentProgram({ id: data.program.id, name: data.program.name || name, unsaved: false })
        // Mirror to backend STATE so the task runner sees the just-
        // saved program when the user clicks Run.
        setProgramSteps(steps)
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus(null), 2000)
      } else {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus(null), 3000)
      }
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus(null), 3000)
    }
  }

  async function openLoadMenu() {
    try {
      const res = await fetch('/api/programs')
      const data = await res.json()
      setSavedPrograms((data.programs || []).filter((p) => !p.builtin))
    } catch {
      setSavedPrograms([])
    }
    setShowLoadMenu(true)
  }

  async function loadProgram(id) {
    try {
      const res = await fetch(`/api/programs/${encodeURIComponent(id)}`)
      if (!res.ok) return
      const prog = await res.json()
      if (prog && Array.isArray(prog.steps)) {
        setCurrentProgram({
          id:      prog.id || id,
          name:    prog.name || 'Untitled Program',
          steps:   prog.steps,
          unsaved: false,
        })
        setProgramSteps(prog.steps)
      }
    } catch { /* swallow */ }
    setShowLoadMenu(false)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={programName}
          onChange={(e) => setProgramName(e.target.value)}
          placeholder="Untitled Program"
          style={{
            fontSize: 14, fontWeight: 700, flex: 1, padding: '4px 8px',
            background: 'transparent', color: '#111',
            border: '1px solid transparent', borderRadius: 4, outline: 'none',
            minWidth: 0,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#2563EB'; e.currentTarget.style.background = '#fff' }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'transparent' }}
        />
        {unsaved && (
          <div title="Unsaved changes"
            style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
        )}
        <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>

        <button onClick={handleSave} disabled={!unsaved || saveStatus === 'saving'}
          style={{
            padding: '6px 14px', fontSize: 12, fontWeight: 600,
            background: saveStatus === 'saved' ? '#16A34A'
                      : saveStatus === 'error' ? '#DC2626'
                      : unsaved ? '#2563EB' : '#e5e7eb',
            color:      (unsaved || saveStatus) ? '#fff' : '#9ca3af',
            border: 'none', borderRadius: 6,
            cursor: (unsaved && saveStatus !== 'saving') ? 'pointer' : 'default',
            minWidth: 80, flexShrink: 0,
          }}>
          {saveStatus === 'saving' ? 'Saving…'
            : saveStatus === 'saved' ? 'Saved'
            : saveStatus === 'error' ? 'Error'
            : unsaved ? 'Save' : 'Saved'}
        </button>

        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={openLoadMenu}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              background: '#f3f4f6', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
            }}>
            Load
          </button>
          {showLoadMenu && (
            <>
              <div onClick={() => setShowLoadMenu(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'transparent' }} />
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 21,
                background: '#fff', border: '1px solid #d1d5db', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                width: 280, maxHeight: 360, overflowY: 'auto',
              }}>
                <div style={{
                  padding: '8px 12px', borderBottom: '1px solid #e5e7eb',
                  fontSize: 11, color: '#6b7280', fontWeight: 600,
                }}>
                  Saved Programs
                </div>
                {savedPrograms.length === 0 ? (
                  <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
                    No saved programs yet
                  </div>
                ) : savedPrograms.map((p) => (
                  <button key={p.id} onClick={() => loadProgram(p.id)}
                    style={{
                      width: '100%', padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                      background: '#fff', border: 'none', borderBottom: '1px solid #f3f4f6',
                      display: 'block',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f9ff' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '#fff' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>
                      {p.steps} step{p.steps === 1 ? '' : 's'}{p.updated ? ' · ' + p.updated : ''}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button onClick={() => setShowWizard(true)}
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: '#2563EB', color: '#fff', border: 'none',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}>
          + Wizard
        </button>
      </div>

      <div style={{ padding: '8px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#6b7280' }}>PROGRESS</span>
        <div style={{ flex: 1, height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: (steps.length ? (doneCount / steps.length) : 0) * 100 + '%',
            height: '100%', background: '#2563EB', borderRadius: 2, transition: 'width 300ms',
          }} />
        </div>
        <span style={{ fontSize: 10, color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
          {doneCount} / {steps.length}
        </span>
      </div>

      <div
        // Clicking blank space inside the scroll area (not on a row)
        // clears the selection — file-manager style.
        onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null) }}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {steps.map((step, idx) => {
          const def = actionFor(step)
          const tagColor = TAG_COLORS[def.tag] || '#6b7280'

          if (editingId === step.id) {
            return (
              <StepEditor key={step.id} step={step}
                onSave={(patch) => handleEditSave(step.id, patch)}
                onClose={() => setEditingId(null)}
              />
            )
          }

          const runStatus  = statusOf(idx)
          const isActive   = runStatus === 'active'
          const isDone     = runStatus === 'done'
          const isSelected = selectedId === step.id
          const isDragging = dragId === step.id
          // Only show the insertion indicator if a drag is in progress
          // and we wouldn't be dropping onto ourselves.
          const indicator  = (dragId !== null && dragOverId === step.id && dragId !== step.id)
                              ? dragOverPos
                              : null

          return (
            <div key={step.id}>
              {indicator === 'before' && <InsertionBar />}

              <div
                draggable={!isActive}
                onClick={() => setSelectedId(step.id)}
                onDragStart={(e) => handleDragStart(e, step.id)}
                onDragOver={(e) => handleDragOver(e, step.id)}
                onDrop={(e) => handleDrop(e, step.id)}
                onDragEnd={handleDragEnd}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', marginBottom: 4, borderRadius: 6,
                  // Selection wins over the live-task highlight so the
                  // user can always tell what they just clicked.
                  background: isDragging ? '#f1f5f9'
                            : isSelected ? '#eff6ff'
                            : isActive   ? '#f0fdf4'
                            : '#fff',
                  border: isDragging ? '1px solid #e5e7eb'
                        : isSelected ? '2px solid #2563EB'
                        : isActive   ? '1px solid #bbf7d0'
                        : '1px solid #e5e7eb',
                  cursor: isActive ? 'default' : 'grab',
                  opacity: isDragging ? 0.3 : 1,
                  transform: isDragging ? 'scale(0.97)' : 'scale(1)',
                  transformOrigin: 'left center',
                  transition: 'opacity 150ms, transform 150ms, background 100ms, border 100ms',
                }}>
              <div style={{ color: '#9ca3af', fontSize: 14, flexShrink: 0, userSelect: 'none', lineHeight: 1 }}>:::</div>

              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: isDone ? '#16A34A' : isActive ? '#2563EB' : '#e5e7eb',
                color: isDone || isActive ? '#fff' : '#6b7280',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700,
              }}>
                {isDone ? '✓' : (idx + 1)}
              </div>

              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px',
                borderRadius: 3, flexShrink: 0, letterSpacing: '0.5px',
                background: tagColor + '18', color: tagColor,
              }}>
                {def.tag}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <EditableStepLabel
                  value={step.label || def.label}
                  onSave={(newLabel) => handleRename(step.id, newLabel)}
                />
                <div style={{ fontSize: 10, color: '#6b7280',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              padding: '0 4px' }}>
                  {detailLine(step, ioLabels)}
                </div>
              </div>

              <button onClick={(e) => { e.stopPropagation(); setEditingId(step.id) }}
                style={{ padding: '4px 10px', fontSize: 10, fontWeight: 600,
                         background: '#eff6ff', color: '#2563EB',
                         border: '1px solid #bfdbfe', borderRadius: 4,
                         cursor: 'pointer', flexShrink: 0 }}>
                Edit
              </button>
              <button onClick={(e) => { e.stopPropagation(); if (!isActive) handleDelete(step.id) }}
                disabled={isActive}
                title={isActive ? 'Cannot delete the active step' : 'Delete step'}
                style={{ padding: '3px 8px', fontSize: 10,
                         background: '#fef2f2', color: '#DC2626',
                         border: '1px solid #fecaca', borderRadius: 3,
                         cursor: isActive ? 'not-allowed' : 'pointer', flexShrink: 0,
                         opacity: isActive ? 0.4 : 1 }}>
                Del
              </button>
              </div>

              {indicator === 'after' && <InsertionBar />}
            </div>
          )
        })}

        <button onClick={handleAdd} style={{
          width: '100%', padding: 10, marginTop: 4,
          background: '#fafafa', color: '#6b7280', fontSize: 12,
          border: '2px dashed #d1d5db', borderRadius: 6, cursor: 'pointer',
        }}>
          + Add step
        </button>
      </div>

      <VoiceBar />

      {showWizard && (
        <ProgramWizard
          onClose={() => setShowWizard(false)}
          onSaved={(program) => {
            if (program) {
              setCurrentProgram({
                id:      program.id,
                name:    program.name || 'Untitled Program',
                steps:   program.steps || [],
                unsaved: false,
              })
              setProgramSteps(program.steps || [])
            }
            setShowWizard(false)
          }}
        />
      )}
    </div>
  )
}

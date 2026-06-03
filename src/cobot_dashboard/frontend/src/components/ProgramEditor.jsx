import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'

// The richer action taxonomy lives in the editor. Each action carries
// a coarse `type` (matching the existing backend schema: move/gripper/
// home/wait/etc.) so legacy consumers keep working, plus a list of
// typed parameter fields the editor knows how to render.
const ACTION_TYPES = [
  { value: 'move_home',     label: 'Move to Home',     type: 'home',    tag: 'HOME',    fields: [] },
  { value: 'open_gripper',  label: 'Open Gripper',     type: 'gripper', tag: 'GRIPPER', fields: ['width_mm', 'speed_pct'] },
  { value: 'close_gripper', label: 'Close Gripper',    type: 'gripper', tag: 'GRIPPER', fields: ['force_pct'] },
  { value: 'move_joint',    label: 'Move Joint',       type: 'move',    tag: 'MOVE',    fields: ['joints'] },
  { value: 'move_linear',   label: 'Move Linear',      type: 'move',    tag: 'MOVE',    fields: ['position', 'speed_pct'] },
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
function detailLine(step) {
  const bits = [step.action || step.type]
  if (step.target)      bits.push('target: ' + step.target)
  if (step.position)    bits.push('pos: [' + step.position.map((p) => Number(p).toFixed(2)).join(', ') + ']')
  if (step.joints)      bits.push('joints: [' + step.joints.join(',') + '] deg')
  if (step.duration_s)  bits.push(step.duration_s + 's')
  if (step.width_mm)    bits.push(step.width_mm + 'mm')
  if (step.descend_mm)  bits.push('descend ' + step.descend_mm + 'mm')
  if (step.io_id)       bits.push(step.io_id + '=' + (step.value ? 'ON' : 'OFF'))
  return bits.join(' | ')
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
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Field label="I/O ID" style={{ flex: 1 }}>
            <input value={draft.io_id || 'DO0'} onChange={(e) => update('io_id', e.target.value)} style={inputStyle} />
          </Field>
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

export default function ProgramEditor() {
  const steps              = useStore((s) => s.program.steps ?? [])
  const addProgramStep     = useStore((s) => s.addProgramStep)
  const removeProgramStep  = useStore((s) => s.removeProgramStep)
  const reorderSteps       = useStore((s) => s.reorderSteps)
  const updateProgramStep  = useStore((s) => s.updateProgramStep)

  const [editingId, setEditingId]   = useState(null)
  const [dragId, setDragId]         = useState(null)
  const [dragOverId, setDragOverId] = useState(null)

  // Resolve the "current step" pointer from real task state. The first
  // active step is the playhead; everything before it is done.
  const activeIdx = steps.findIndex((s) => s.status === 'active')
  const doneCount = steps.filter((s) => s.status === 'done').length

  function handleDragStart(e, id) {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id))
  }

  function handleDragOver(e, id) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(id)
  }

  function handleDrop(e, targetId) {
    e.preventDefault()
    setDragOverId(null)
    if (dragId === null || dragId === targetId) { setDragId(null); return }
    const ids   = steps.map((s) => s.id)
    const fromI = ids.indexOf(dragId)
    const toI   = ids.indexOf(targetId)
    if (fromI < 0 || toI < 0) { setDragId(null); return }
    const newIds = [...ids]
    newIds.splice(fromI, 1)
    newIds.splice(toI, 0, dragId)
    reorderSteps(newIds)
    setDragId(null)
  }

  function handleDragEnd() { setDragId(null); setDragOverId(null) }

  function handleAdd() {
    addProgramStep({ type: 'wait', action: 'wait', label: 'Wait', duration_s: 1, detail: '' })
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#111', flex: 1 }}>Program</span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{steps.length} step{steps.length === 1 ? '' : 's'}</span>
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

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {steps.map((step, idx) => {
          const def = actionFor(step)
          const tagColor = TAG_COLORS[def.tag] || '#6b7280'

          if (editingId === step.id) {
            return (
              <StepEditor key={step.id} step={step}
                onSave={(patch) => updateProgramStep(step.id, patch)}
                onClose={() => setEditingId(null)}
              />
            )
          }

          const isActive = step.status === 'active'
          const isDone   = step.status === 'done'
          const isDragOver = dragOverId === step.id

          return (
            <div key={step.id}
              draggable={!isActive}
              onDragStart={(e) => handleDragStart(e, step.id)}
              onDragOver={(e) => handleDragOver(e, step.id)}
              onDrop={(e) => handleDrop(e, step.id)}
              onDragEnd={handleDragEnd}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', marginBottom: 4, borderRadius: 6,
                background: isDragOver ? '#dbeafe' : isActive ? '#f0f9ff' : '#fff',
                border: isDragOver ? '2px dashed #2563EB'
                  : isActive ? '1px solid #93c5fd'
                  : '1px solid #e5e7eb',
                cursor: isActive ? 'default' : 'grab',
                opacity: dragId === step.id ? 0.4 : 1,
                transition: 'background 100ms, border 100ms',
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

              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setEditingId(step.id)}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#111',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {step.label || def.label}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {detailLine(step)}
                </div>
              </div>

              <button onClick={(e) => { e.stopPropagation(); setEditingId(step.id) }}
                style={{ padding: '3px 8px', fontSize: 10, background: '#f3f4f6', color: '#374151',
                         border: '1px solid #d1d5db', borderRadius: 3, cursor: 'pointer', flexShrink: 0 }}>
                Edit
              </button>
              <button onClick={(e) => { e.stopPropagation(); if (!isActive) removeProgramStep(step.id) }}
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
    </div>
  )
}

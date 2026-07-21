import { useState, useEffect, useRef, useCallback } from 'react'

// Colour palette pinned to IOPanel.jsx so the two sections read as one
// page. If you tweak this, tweak IOPanel too.
const C = {
  border:     '#e5e7eb',
  cardBg:     '#fafafa',
  headerBg:   '#f3f4f6',
  text:       '#111',
  textMuted:  '#6b7280',
  textDim:    '#9ca3af',
  accent:     '#2563EB',
  green:      '#16A34A',
  yellow:     '#CA8A04',
  purple:     '#9333EA',
  power:      '#DC2626',
  rowBg:      '#fff',
  rowBgDim:   '#f9fafb',
}

const BANK_META = {
  DI:    { color: '#3B82F6', label: 'Digital Inputs',  short: 'DI' },
  DO:    { color: '#16A34A', label: 'Digital Outputs', short: 'DO' },
  AI:    { color: '#CA8A04', label: 'Analog Inputs',   short: 'AI' },
  AO:    { color: '#9333EA', label: 'Analog Outputs',  short: 'AO' },
  POWER: { color: '#DC2626', label: 'Power',           short: '⚡' },
}

// ---------------------------------------------------------------------------
// Inline editable string — click to edit, Enter/blur to commit, Esc to
// cancel. Same behaviour as IOPanel's EditableLabel but a smaller
// footprint so it fits inside a port cell.
// ---------------------------------------------------------------------------
function InlineEditable({ value, onSave, placeholder = 'Unassigned', style }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select() } }, [editing])

  const commit = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== (value || '').trim()) onSave(v || placeholder)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter')  commit()
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        style={{
          padding: '1px 4px', fontSize: 11,
          background: '#fff', color: C.text,
          border: `1px solid ${C.accent}`, borderRadius: 3,
          outline: 'none', width: '100%', minWidth: 0,
          ...style,
        }}
      />
    )
  }

  const isPlaceholder = !value || value === placeholder
  return (
    <span
      onClick={(e) => { e.stopPropagation(); setEditing(true) }}
      title="Click to edit"
      style={{
        fontSize: 11,
        color: isPlaceholder ? C.textDim : C.text,
        fontStyle: isPlaceholder ? 'italic' : 'normal',
        cursor: 'text', padding: '1px 4px', borderRadius: 3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        display: 'block', minWidth: 0,
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#eef2ff' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {value || placeholder}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Live-state pill.
//
// Inert until /estun/io read verbs are captured on the driver side.
// Renders a muted dot + "—" so the layout is stable — once the live
// binding lands, this component becomes a real HIGH/LOW / ON/OFF /
// value indicator without a layout shift.
// ---------------------------------------------------------------------------
function LiveStatePill({ bank }) {
  const dotColor = C.textDim
  return (
    <span
      title="Live state — pending I/O capture"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 9, fontFamily: 'monospace',
        color: C.textDim, letterSpacing: '0.03em',
      }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dotColor, opacity: 0.5,
        border: `1px dashed ${dotColor}`,
      }} />
      {(bank === 'AI' || bank === 'AO') ? '— .-' : '—'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Single port cell — connector-diagram tile.
// ---------------------------------------------------------------------------
function PortCell({ id, bank, meta, onEdit }) {
  const inUse   = !!meta?.in_use
  const label   = meta?.assignment || 'Unassigned'
  const notes   = meta?.notes || ''
  const [showNotes, setShowNotes] = useState(false)
  const bankColor = BANK_META[bank]?.color || C.textMuted

  // Assigned ports are highlighted; free ports are dimmed. Power rails
  // always look "in use" — they aren't operator-assignable.
  const highlighted = inUse
  const isPower     = bank === 'POWER'

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        gap: 2,
        padding: '6px 8px',
        borderRadius: 5,
        background: highlighted ? '#fff' : C.rowBgDim,
        border: highlighted
          ? `1px solid ${bankColor}55`
          : `1px solid ${C.border}`,
        opacity: highlighted || isPower ? 1 : 0.72,
        minWidth: 0,
        position: 'relative',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        minWidth: 0,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
          color: bankColor,
          minWidth: 26, textAlign: 'left',
        }}>{id}</span>
        {!isPower && (
          <input
            type="checkbox"
            checked={inUse}
            onChange={(e) => onEdit(id, { in_use: e.target.checked })}
            title="Mark port as assigned / in use"
            style={{ margin: 0, cursor: 'pointer', flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {isPower ? (
            <span style={{
              fontSize: 11, color: C.text, fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'block',
            }}>{label}</span>
          ) : (
            <InlineEditable
              value={label}
              onSave={(v) => onEdit(id, {
                assignment: v,
                // Auto-toggle in_use: if operator gives a real label,
                // treat the port as assigned (they can uncheck).
                in_use: v && v !== 'Unassigned' ? true : !!meta?.in_use,
              })}
            />
          )}
        </div>
        <LiveStatePill bank={bank} />
      </div>

      {!isPower && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10, color: C.textMuted, minWidth: 0,
        }}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowNotes((v) => !v) }}
            style={{
              padding: '0 4px', fontSize: 10, lineHeight: '14px',
              background: 'transparent',
              color: notes ? C.accent : C.textDim,
              border: 'none', cursor: 'pointer',
            }}
            title={notes ? notes : 'Add notes'}
          >
            {notes ? '📝 notes' : '+ notes'}
          </button>
          {showNotes && (
            <input
              type="text"
              defaultValue={notes}
              placeholder="Wiring notes, tag numbers, etc."
              onBlur={(e) => {
                setShowNotes(false)
                if (e.target.value !== notes) onEdit(id, { notes: e.target.value })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') { setShowNotes(false); e.currentTarget.blur() }
              }}
              autoFocus
              style={{
                flex: 1, minWidth: 0,
                fontSize: 10, padding: '1px 4px',
                border: `1px solid ${C.accent}`, borderRadius: 3,
                outline: 'none',
              }}
            />
          )}
          {!showNotes && notes && (
            <span style={{
              flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontStyle: 'italic',
            }}>{notes}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bank — one grouped column (DI / DO / AI / AO / Power).
// ---------------------------------------------------------------------------
function Bank({ bank, ids, ports, onEdit, actions }) {
  const meta = BANK_META[bank]
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: C.rowBg,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      overflow: 'hidden',
      minWidth: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        background: C.headerBg,
        borderBottom: `1px solid ${C.border}`,
      }}>
        <span style={{ color: meta.color, fontSize: 12 }}>●</span>
        <span style={{
          flex: 1,
          fontSize: 11, fontWeight: 600, color: '#374151',
          letterSpacing: '0.02em',
        }}>
          {meta.label} <span style={{ color: C.textMuted, fontWeight: 400 }}>({ids.length})</span>
        </span>
        {actions}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: 8,
      }}>
        {ids.length === 0 ? (
          <div style={{ fontSize: 11, color: C.textDim, padding: '6px 4px' }}>
            No ports configured.
          </div>
        ) : ids.map((id) => (
          <PortCell key={id} id={id} bank={bank}
            meta={ports[id]}
            onEdit={onEdit} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Legend + live-state banner. Mounted once above the banks.
// ---------------------------------------------------------------------------
function Legend({ assignedCount, totalCount, aiN, aoN, onAiChange, onAoChange, onReset }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      flexWrap: 'wrap',
      padding: '8px 12px',
      background: C.headerBg,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      fontSize: 11, color: C.textMuted,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#fff', border: `1px solid ${BANK_META.DI.color}`,
        }} />
        assigned
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: C.rowBgDim, border: `1px solid ${C.border}`,
          opacity: 0.7,
        }} />
        free
      </span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        color: C.textDim,
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: C.textDim, opacity: 0.5,
          border: `1px dashed ${C.textDim}`,
        }} />
        Live state — pending I/O capture
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: C.textMuted, fontFamily: 'monospace' }}>
          {assignedCount}/{totalCount} assigned
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          AI
          <input
            type="number" min={0} max={16}
            value={aiN}
            onChange={(e) => onAiChange(parseInt(e.target.value, 10))}
            style={{
              width: 40, padding: '1px 4px', fontSize: 11,
              border: `1px solid ${C.border}`, borderRadius: 3,
              background: '#fff', color: C.text, outline: 'none',
            }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          AO
          <input
            type="number" min={0} max={16}
            value={aoN}
            onChange={(e) => onAoChange(parseInt(e.target.value, 10))}
            style={{
              width: 40, padding: '1px 4px', fontSize: 11,
              border: `1px solid ${C.border}`, borderRadius: 3,
              background: '#fff', color: C.text, outline: 'none',
            }}
          />
        </label>
        <button
          onClick={onReset}
          style={{
            padding: '3px 10px', fontSize: 10, background: '#fff',
            color: C.textMuted, border: `1px solid ${C.border}`,
            borderRadius: 4, cursor: 'pointer',
          }}>
          Reset assignments
        </button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public component.
//
// Fetches /api/io/portmap on mount, renders the connector-graphic banks,
// persists edits back with debounced PUTs. No live-state fetching — the
// live layer is inert until /estun/io read verbs land.
// ---------------------------------------------------------------------------
export default function IOPortMap() {
  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [saving, setSaving]   = useState(false)
  const saveTimer = useRef(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/io/portmap')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData(await r.json())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const scheduleSave = useCallback((body) => {
    setSaving(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/io/portmap', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        if (d.portmap) setData(d.portmap)
      } catch (e) {
        setError(e.message)
      } finally {
        setSaving(false)
      }
    }, 400)
  }, [])

  const onEdit = useCallback((id, patch) => {
    setData((prev) => {
      if (!prev) return prev
      const nextPorts = { ...prev.ports, [id]: { ...prev.ports[id], ...patch } }
      const next = { ...prev, ports: nextPorts }
      scheduleSave({ ports: { [id]: patch } })
      return next
    })
  }, [scheduleSave])

  const onAiChange = useCallback((n) => {
    if (!Number.isFinite(n)) return
    const clamped = Math.max(0, Math.min(16, n))
    setData((prev) => prev ? { ...prev, analog_input_count: clamped } : prev)
    scheduleSave({ analog_input_count: clamped })
  }, [scheduleSave])

  const onAoChange = useCallback((n) => {
    if (!Number.isFinite(n)) return
    const clamped = Math.max(0, Math.min(16, n))
    setData((prev) => prev ? { ...prev, analog_output_count: clamped } : prev)
    scheduleSave({ analog_output_count: clamped })
  }, [scheduleSave])

  const onReset = useCallback(async () => {
    if (!confirm('Reset every port to Unassigned? Notes are cleared too.')) return
    const emptyPatch = {}
    // Build a patch that clears every currently-configured port.
    if (data?.ports) {
      for (const pid of Object.keys(data.ports)) {
        if (pid === '24V' || pid === 'GND') continue
        emptyPatch[pid] = { assignment: 'Unassigned', in_use: false, notes: '' }
      }
    }
    scheduleSave({ ports: emptyPatch })
  }, [data, scheduleSave])

  if (!data && error) {
    return (
      <div style={{
        padding: 12, border: `1px solid ${C.border}`, borderRadius: 6,
        background: '#fff5f5', color: C.power, fontSize: 12,
      }}>
        Failed to load port map: {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div style={{ padding: 12, color: C.textMuted, fontSize: 12 }}>
        Loading port map…
      </div>
    )
  }

  const ports = data.ports || {}
  const diIds = Array.from({ length: 8 }, (_, i) => `DI${i}`)
  const doIds = Array.from({ length: 8 }, (_, i) => `DO${i}`)
  const aiIds = Array.from({ length: data.analog_input_count  || 0 }, (_, i) => `AI${i}`)
  const aoIds = Array.from({ length: data.analog_output_count || 0 }, (_, i) => `AO${i}`)
  const powerIds = ['24V', 'GND']

  const digitalIds = [...diIds, ...doIds, ...aiIds, ...aoIds]
  const assignedCount = digitalIds.reduce(
    (n, id) => n + (ports[id]?.in_use ? 1 : 0), 0)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: 14,
      background: '#fff',
      border: `1px solid ${C.border}`,
      borderRadius: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>
          I/O Port Map
        </span>
        <span style={{ fontSize: 11, color: C.textMuted, marginRight: 10 }}>
          Estun S10-140 · CC10-A
        </span>
        <span style={{ fontSize: 10, color: saving ? C.accent : C.textDim }}>
          {saving ? 'Saving…' : 'Saved'}
        </span>
      </div>

      <Legend
        assignedCount={assignedCount}
        totalCount={digitalIds.length}
        aiN={data.analog_input_count || 0}
        aoN={data.analog_output_count || 0}
        onAiChange={onAiChange}
        onAoChange={onAoChange}
        onReset={onReset}
      />

      {/* Connector-diagram layout: DI + DO side-by-side (the two
          digital banks are the largest and most symmetrical), Analog
          I/O below them, Power as a slim horizontal footer. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 10,
      }}>
        <Bank bank="DI" ids={diIds} ports={ports} onEdit={onEdit} />
        <Bank bank="DO" ids={doIds} ports={ports} onEdit={onEdit} />
        <Bank bank="AI" ids={aiIds} ports={ports} onEdit={onEdit} />
        <Bank bank="AO" ids={aoIds} ports={ports} onEdit={onEdit} />
      </div>

      <Bank bank="POWER" ids={powerIds} ports={ports} onEdit={onEdit} />
    </div>
  )
}

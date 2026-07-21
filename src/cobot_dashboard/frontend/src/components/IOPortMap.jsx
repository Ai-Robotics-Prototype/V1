import { useState, useEffect, useRef, useCallback } from 'react'

// Colour palette pinned to IOPanel.jsx so the two sections read as one
// page. Do not diverge — the port map lives beside the older list on
// the same tab.
const C = {
  border:     '#e5e7eb',
  cardBg:     '#fafafa',
  headerBg:   '#f3f4f6',
  text:       '#111',
  textMuted:  '#6b7280',
  textDim:    '#9ca3af',
  accent:     '#2563EB',
  amber:      '#CA8A04',
  power:      '#DC2626',
  rowBg:      '#fff',
  rowBgDim:   '#f9fafb',
}

// Per-kind colour + rendering hint. Kinds mirror the controller's own
// IOManager types plus HDI (M-FUNC high-speed inputs) and derived
// group kinds (M-FUNC, PWR-CFG, SAFETY, FLANGE).
const KIND_META = {
  'DI':      { color: '#3B82F6', short: 'DI',     kindLabel: 'Digital Input' },
  'DO':      { color: '#16A34A', short: 'DO',     kindLabel: 'Digital Output' },
  'AI':      { color: '#CA8A04', short: 'AI',     kindLabel: 'Analog Input' },
  'AO':      { color: '#9333EA', short: 'AO',     kindLabel: 'Analog Output' },
  'HDI':     { color: '#0EA5E9', short: 'HDI',    kindLabel: 'High-speed DI' },
  'M-FUNC':  { color: '#0EA5E9', short: 'M-FUNC', kindLabel: 'Multi-function' },
  'PWR-CFG': { color: '#DC2626', short: 'PWR',    kindLabel: 'Power / Fuse' },
  'SAFETY':  { color: '#B45309', short: 'SAFETY', kindLabel: 'Safety I/O' },
  'FLANGE':  { color: '#7C3AED', short: 'FLANGE', kindLabel: 'Tool Flange' },
}

// Non-signal terminal roles get a compact chip. Signal terminals are
// rendered through the ChannelRow path.
const ROLE_META = {
  power:   { label: '24V',  bg: '#FEE2E2', color: '#991B1B' },
  return:  { label: '0V',   bg: '#E0F2FE', color: '#075985' },
  bus:     { label: 'BUS',  bg: '#F3E8FF', color: '#6B21A8' },
  control: { label: 'CTL',  bg: '#FEF3C7', color: '#92400E' },
  safety:  { label: 'SAF',  bg: '#FFE4E6', color: '#9F1239' },
  aux:     { label: 'AUX',  bg: '#F3F4F6', color: '#374151' },
  shield:  { label: 'SHD',  bg: '#F3F4F6', color: '#374151' },
}

// Group meta — subtle tint on the block header.
const GROUP_META = {
  general: { label: 'General',         tint: 'transparent' },
  system:  { label: 'System-reserved', tint: '#FEF3C7' },
  flange:  { label: 'Flange (tool)',   tint: '#F3E8FF' },
  analog:  { label: 'Analog',          tint: '#FEF9C3' },
  safety:  { label: 'Safety',          tint: '#FFE4E6' },
}

// ---------------------------------------------------------------------------
// Inline editable string. Click → input; Enter/blur commits; Esc cancels.
// Placeholder styling matches the "Unassigned" convention.
// ---------------------------------------------------------------------------
function InlineEditable({ value, onSave, placeholder = 'Unassigned' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => {
    if (editing && ref.current) { ref.current.focus(); ref.current.select() }
  }, [editing])

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
// INERT until /estun/io read verbs land. Dashed muted dot + "—" so the
// layout is stable — the pill becomes a real HIGH/LOW / ON/OFF / value
// indicator once the live binding arrives, without any layout shift.
// ---------------------------------------------------------------------------
function LiveStatePill({ kind }) {
  const dot = C.textDim
  const isAnalog = kind === 'AI' || kind === 'AO'
  return (
    <span
      title={'Live state pending driver bridge — verbs captured '
              + '(IOManager/GetIOValue etc.) but not yet wired to the '
              + 'dashboard; awaits live-first force→read validation.'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 9, fontFamily: 'monospace',
        color: C.textDim, letterSpacing: '0.03em',
        flexShrink: 0,
      }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dot, opacity: 0.5,
        border: `1px dashed ${dot}`,
      }} />
      {isAnalog ? '— .-' : '—'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Single channel row inside a block.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Non-signal terminal row — power / return / bus / control / safety.
// Compact, non-editable, shows the exact silkscreen name + a role chip.
// ---------------------------------------------------------------------------
function TerminalRow({ name, role }) {
  const meta = ROLE_META[role] || ROLE_META.aux
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '3px 8px', borderRadius: 4,
      background: C.rowBgDim,
      border: `1px dashed ${C.border}`,
      minWidth: 0,
    }}>
      <span style={{
        fontSize: 10, fontFamily: 'monospace',
        color: C.textMuted, fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1,
      }}>{name}</span>
      <span style={{
        fontSize: 8, fontWeight: 700,
        color: meta.color, background: meta.bg,
        padding: '1px 5px', borderRadius: 3,
        letterSpacing: '0.05em', flexShrink: 0,
      }}>{meta.label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plate block (physical view). Renders every terminal in silkscreen
// order — signals through ChannelRow, non-signals through TerminalRow.
// ---------------------------------------------------------------------------
function PlateBlock({ block, ports, specs, onEdit }) {
  const kind    = block.kind
  const group   = block.group || 'general'
  const meta    = KIND_META[kind] || { color: C.textMuted, short: kind, kindLabel: kind }
  const grpMeta = GROUP_META[group] || GROUP_META.general
  const spec    = specs?.[kind] || {}
  const wiring  = block.wiring   // {mode: 'sink'|'source', return_rail: '0V'|'24V'} for DI/DO
  const terminals = Array.isArray(block.terminals) ? block.terminals : []
  const nSig    = terminals.filter((t) => t.role === 'signal').length
  const editable = group !== 'system' && group !== 'safety'
  const tip      = specTooltip(kind, specs)

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
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px',
        background: grpMeta.tint !== 'transparent' ? grpMeta.tint : C.headerBg,
        borderBottom: `1px solid ${C.border}`,
        borderTop: `3px solid ${meta.color}`,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700,
          color: '#fff', background: meta.color,
          padding: '1px 5px', borderRadius: 3,
          letterSpacing: '0.05em', flexShrink: 0,
          textTransform: 'uppercase',
        }}>
          {meta.short}
        </span>
        <span style={{
          flex: 1,
          fontSize: 11, fontWeight: 600, color: '#374151',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {block.label}
        </span>
        {wiring && (
          <span
            title={`${wiring.mode} wiring — return rail ${wiring.return_rail}`}
            style={{
              fontSize: 8, fontWeight: 700,
              padding: '1px 5px', borderRadius: 3,
              background: wiring.mode === 'sink' ? '#DBEAFE' : '#DCFCE7',
              color:      wiring.mode === 'sink' ? '#1E40AF' : '#166534',
              letterSpacing: '0.05em', flexShrink: 0,
              textTransform: 'uppercase',
            }}>
            {wiring.mode} · {wiring.return_rail}
          </span>
        )}
        <span style={{
          fontSize: 10, color: C.textMuted, fontFamily: 'monospace',
          flexShrink: 0,
        }} title={`${terminals.length} terminals · ${nSig} signals`}>
          {terminals.length}t
        </span>
        {tip && (
          <span
            title={tip}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, borderRadius: '50%',
              background: '#fff', color: C.textMuted,
              border: `1px solid ${C.border}`,
              fontSize: 9, fontWeight: 700, cursor: 'help',
              flexShrink: 0,
            }}>i</span>
        )}
      </div>

      {block.notes && (
        <div style={{
          padding: '3px 8px',
          fontSize: 9, color: C.textMuted,
          background: C.rowBgDim,
          borderBottom: `1px solid ${C.border}`,
          lineHeight: 1.3,
        }}>
          {block.notes}
        </div>
      )}

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: 5,
      }}>
        {terminals.length === 0 ? (
          <div style={{ fontSize: 11, color: C.textDim, padding: '6px 4px' }}>
            No terminals configured.
          </div>
        ) : terminals.map((t, i) => {
          if (t.role === 'signal') {
            return (
              <ChannelRow
                key={t.name || i}
                id={t.name}
                kind={t.kind || kind}
                meta={ports?.[t.name]}
                row={{
                  port: t.port,
                  default_name: t.default_name || t.name,
                  function: t.function,
                }}
                editable={editable}
                onEdit={onEdit}
              />
            )
          }
          return <TerminalRow key={t.name || i} name={t.name} role={t.role} />
        })}
      </div>
    </div>
  )
}

function ChannelRow({ id, kind, meta, row, onEdit, editable }) {
  const inUse = !!meta?.in_use
  const label = meta?.assignment || 'Unassigned'
  const notes = meta?.notes || ''
  const [showNotes, setShowNotes] = useState(false)
  const bankColor = KIND_META[kind]?.color || C.textMuted
  const fnTag = row?.function
  const port  = row?.port
  const defaultName = row?.default_name

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        gap: 2,
        padding: '5px 8px',
        borderRadius: 4,
        background: inUse ? '#fff' : C.rowBgDim,
        border: inUse
          ? `1px solid ${bankColor}55`
          : `1px solid ${C.border}`,
        opacity: inUse ? 1 : 0.78,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span
          title={port != null ? `port ${port} (${kind})` :
                 defaultName && defaultName !== id ? `factory: ${defaultName}` : id}
          style={{
            fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
            color: bankColor,
            minWidth: 64, textAlign: 'left',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{id}</span>
        {editable && (
          <input
            type="checkbox"
            checked={inUse}
            onChange={(e) => onEdit(id, { in_use: e.target.checked })}
            title="Mark port as assigned / in use"
            style={{ margin: 0, cursor: 'pointer', flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editable ? (
            <InlineEditable
              value={label}
              onSave={(v) => onEdit(id, {
                assignment: v,
                in_use: v && v !== 'Unassigned' ? true : !!meta?.in_use,
              })}
            />
          ) : (
            <span
              title={fnTag ? `controller function: ${JSON.stringify(fnTag)}` : undefined}
              style={{
                fontSize: 11, color: C.text,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                display: 'block',
              }}>
              {label}
              {fnTag && (
                <span style={{
                  marginLeft: 6, fontSize: 9, fontFamily: 'monospace',
                  color: C.amber, background: '#FEF3C7',
                  padding: '0 4px', borderRadius: 2,
                }}>fn</span>
              )}
            </span>
          )}
        </div>
        <LiveStatePill kind={kind} />
      </div>

      {editable && (
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
            title={notes || 'Add notes'}
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
// Spec tooltip content builder.
// ---------------------------------------------------------------------------
function specTooltip(kind, specs) {
  const s = specs?.[kind]
  if (!s) return ''
  const lines = []
  if (s.voltage_typ_v) lines.push(`Voltage ${s.voltage_typ_v} V typ / ${s.voltage_max_v} V max`)
  if (s.impedance_kohm) lines.push(`~${s.impedance_kohm} kΩ`)
  if (s.current_max_ma) lines.push(`Max ${s.current_max_ma} mA per group`)
  if (s.polarity) lines.push(`Polarity: ${s.polarity}`)
  if (s.flange_di_polarity) lines.push(`Flange DI: ${s.flange_di_polarity}`)
  if (Array.isArray(s.flange_do_modes)) lines.push(`Flange DO: ${s.flange_do_modes.join(', ')}`)
  if (Array.isArray(s.terminals)) lines.push(`Terminals: ${s.terminals.join(' / ')}`)
  if (s.notes) lines.push(s.notes)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// One block — CC10-A back-panel plug.
// ---------------------------------------------------------------------------
function Block({ block, ports, specs, onEdit }) {
  const kind    = block.kind
  const group   = block.group || 'general'
  const meta    = KIND_META[kind] || { color: C.textMuted, short: kind, kindLabel: kind }
  const grpMeta = GROUP_META[group] || GROUP_META.general
  const spec    = specs?.[kind] || {}
  const rows    = Array.isArray(block.rows) ? block.rows :
                  (Array.isArray(block.channels)
                    ? block.channels.map((ch) => ({ ch, port: null,
                                                     default_name: ch, function: null }))
                    : [])
  const editable = !block.readonly
  const tip      = specTooltip(kind, specs)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: C.rowBg,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      overflow: 'hidden',
      minWidth: 0,
    }}>
      {/* Connector header — kind badge + label + channel count + spec tooltip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        background: grpMeta.tint !== 'transparent' ? grpMeta.tint : C.headerBg,
        borderBottom: `1px solid ${C.border}`,
        borderTop: `3px solid ${meta.color}`,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700,
          color: '#fff', background: meta.color,
          padding: '1px 6px', borderRadius: 3,
          letterSpacing: '0.05em', flexShrink: 0,
          textTransform: 'uppercase',
        }}>
          {meta.short}
        </span>
        <span style={{
          flex: 1,
          fontSize: 11, fontWeight: 600, color: '#374151',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {block.label}
        </span>
        {block.readonly && (
          <span
            title="Read-only — controller owns this signal."
            style={{
              fontSize: 9, fontWeight: 700, color: '#92400E',
              background: '#FEF3C7', padding: '1px 6px', borderRadius: 3,
              flexShrink: 0,
            }}>read-only</span>
        )}
        <span style={{
          fontSize: 10, color: C.textMuted, fontFamily: 'monospace',
          flexShrink: 0,
        }}>
          {rows.length} ch
        </span>
        {tip && (
          <span
            title={tip}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, borderRadius: '50%',
              background: '#fff', color: C.textMuted,
              border: `1px solid ${C.border}`,
              fontSize: 9, fontWeight: 700, cursor: 'help',
              flexShrink: 0,
            }}>i</span>
        )}
      </div>

      {/* Terminal legend — kind-level fixed strings (e.g. "24V / COM / DI") */}
      {Array.isArray(spec.terminals) && spec.terminals.length > 0 && (
        <div style={{
          padding: '3px 10px',
          fontSize: 9, fontFamily: 'monospace',
          color: C.textMuted,
          background: C.rowBgDim,
          borderBottom: `1px solid ${C.border}`,
          letterSpacing: '0.02em',
        }}>
          {spec.terminals.join(' · ')}
        </div>
      )}

      {/* Channel rows */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 3,
        padding: 6,
      }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 11, color: C.textDim, padding: '6px 4px' }}>
            No channels configured.
          </div>
        ) : rows.map((row) => (
          <ChannelRow
            key={row.ch}
            id={row.ch} kind={kind}
            meta={ports?.[row.ch]}
            row={row}
            editable={editable}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Legend / status bar.
// ---------------------------------------------------------------------------
function Legend({ assignedCount, totalCount, saving, onReset, source }) {
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
      <span
        title={`Inventory verified from ${source || 'the factory-controller capture'}.`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 4,
          background: '#DCFCE7', color: '#166534',
          fontWeight: 600, fontSize: 10,
          border: '1px solid #BBF7D0',
        }}>
        VERIFIED
      </span>
      <span
        title={'IOManager/GetIOValue captured, IOManager/SetIOForcedFlag '
                + 'captured for type:"DI" only. Driver bridge + allow_io '
                + 'gate not yet wired — live values, force, and '
                + 'program-side SET_IO remain pending a live-first check.'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 4,
          background: '#FEF3C7', color: '#92400E',
          fontWeight: 600, fontSize: 10,
          border: '1px solid #FDE68A',
        }}>
        allow_io: PENDING
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#fff', border: `1px solid ${KIND_META.DI.color}`,
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
        Live state — driver bridge pending
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: 'monospace' }}>
          {assignedCount}/{totalCount} assigned
        </span>
        <span style={{ fontSize: 10, color: saving ? C.accent : C.textDim }}>
          {saving ? 'Saving…' : 'Saved'}
        </span>
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
// Public component. Fully data-driven from /api/io/portmap.
// ---------------------------------------------------------------------------
export default function IOPortMap() {
  const [data, setData]     = useState(null)
  const [error, setError]   = useState(null)
  const [saving, setSaving] = useState(false)
  const saveTimer  = useRef(null)
  const pendingRef = useRef({})   // accumulate per-port patches between debounces

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

  const flushSave = useCallback(async () => {
    const patch = pendingRef.current
    pendingRef.current = {}
    if (!patch || Object.keys(patch).length === 0) {
      setSaving(false)
      return
    }
    try {
      const r = await fetch('/api/io/portmap', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      if (d.portmap) setData(d.portmap)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }, [])

  const scheduleSave = useCallback((mergeIntoPending) => {
    setSaving(true)
    // Merge the new patch into pendingRef. Per-port meta is
    // shallow-merged; the caller supplies exactly the shape the
    // backend expects.
    const p = pendingRef.current
    if (mergeIntoPending.ports) {
      p.ports = p.ports || {}
      for (const [pid, meta] of Object.entries(mergeIntoPending.ports)) {
        p.ports[pid] = { ...(p.ports[pid] || {}), ...meta }
      }
    }
    if (mergeIntoPending.blocks) {
      p.blocks = p.blocks || []
      for (const patch of mergeIntoPending.blocks) {
        const existing = p.blocks.find((b) => b.id === patch.id)
        if (existing) Object.assign(existing, patch)
        else p.blocks.push({ ...patch })
      }
    }
    if ('provisional' in mergeIntoPending) p.provisional = mergeIntoPending.provisional
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushSave, 400)
  }, [flushSave])

  const onEdit = useCallback((id, patch) => {
    setData((prev) => {
      if (!prev) return prev
      const nextPorts = { ...prev.ports, [id]: { ...prev.ports?.[id], ...patch } }
      scheduleSave({ ports: { [id]: patch } })
      return { ...prev, ports: nextPorts }
    })
  }, [scheduleSave])

  const onReset = useCallback(() => {
    if (!confirm('Reset every assignable port to Unassigned? Notes are cleared.')) return
    if (!data?.blocks) return
    const clearPatch = {}
    for (const blk of data.blocks) {
      if (blk.kind === 'PWR-CFG') continue
      for (const ch of blk.channels || []) {
        clearPatch[ch] = { assignment: 'Unassigned', in_use: false, notes: '' }
      }
    }
    scheduleSave({ ports: clearPatch })
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

  const plate     = Array.isArray(data.plate) ? data.plate : []
  const flange    = data.flange || null
  const nameplate = data.nameplate || {}
  const sources   = data.sources || {}
  const specs     = data.specs || {}
  const verbs     = data.verbs || {}
  const ports     = data.ports || {}

  // Assignment tally — walk the plate + flange, count only signal
  // terminals in operator-assignable groups.
  let totalCount = 0
  let assignedCount = 0
  const walk = [...plate]
  if (flange) walk.push(flange)
  for (const blk of walk) {
    const g = blk.group
    if (g === 'system' || g === 'safety') continue
    for (const t of blk.terminals || []) {
      if (t.role !== 'signal') continue
      totalCount += 1
      if (ports[t.name]?.in_use) assignedCount += 1
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: 14,
      background: '#fff',
      border: `1px solid ${C.border}`,
      borderRadius: 6,
    }}>
      {/* Header + nameplate strip */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>
          I/O Port Map
        </span>
        <span style={{ fontSize: 11, color: C.textMuted }}>
          Estun S10-140 · silkscreen-verified
        </span>
      </div>

      {(nameplate.model || nameplate.serial) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '6px 10px',
          background: '#0F172A',
          color: '#E2E8F0',
          border: `1px solid #1E293B`,
          borderRadius: 6,
          fontSize: 11, fontFamily: 'monospace',
          letterSpacing: '0.02em',
        }}>
          <span style={{ color: '#94A3B8', fontSize: 9, textTransform: 'uppercase' }}>
            Nameplate
          </span>
          <span style={{ fontWeight: 700 }}>{nameplate.model}</span>
          {nameplate.power_w && <span>{nameplate.power_w} W</span>}
          {nameplate.voltage && <span>{nameplate.voltage}</span>}
          {nameplate.current_a && <span>{nameplate.current_a} A</span>}
          {nameplate.serial && (
            <span style={{ marginLeft: 'auto', color: '#94A3B8' }}>
              SN {nameplate.serial}
            </span>
          )}
        </div>
      )}

      <Legend
        assignedCount={assignedCount}
        totalCount={totalCount}
        saving={saving}
        onReset={onReset}
        source={sources.physical || sources.software}
      />

      {/* Physical plate — connectors in silkscreen order, left→right */}
      <div style={{
        fontSize: 10, fontWeight: 700, color: C.textMuted,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        paddingLeft: 2, marginTop: 4,
      }}>
        CC10-A back panel
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 6, alignItems: 'start',
      }}>
        {plate.map((blk) => (
          <PlateBlock key={blk.id} block={blk} ports={ports} specs={specs}
                      onEdit={onEdit} />
        ))}
      </div>

      {/* Tool-flange connector — separate row */}
      {flange && (
        <>
          <div style={{
            fontSize: 10, fontWeight: 700, color: C.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.08em',
            paddingLeft: 2, marginTop: 4,
          }}>
            Tool flange (arm-end connector)
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 6,
          }}>
            <PlateBlock block={flange} ports={ports} specs={specs}
                        onEdit={onEdit} />
          </div>
        </>
      )}

      {/* IOManager + Lua verb reference — collapsed by default */}
      <details style={{
        border: `1px solid ${C.border}`, borderRadius: 6,
        background: C.rowBgDim, padding: '6px 10px', fontSize: 11,
      }}>
        <summary style={{
          cursor: 'pointer', color: C.textMuted, fontWeight: 600,
          userSelect: 'none',
        }}>
          Verb reference · {Object.keys(verbs).length} documented (ws + lua)
        </summary>
        <div style={{
          marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {Object.entries(verbs).map(([slot, v]) => (
            <div key={slot} style={{
              display: 'grid',
              gridTemplateColumns: '80px 40px 220px 1fr',
              gap: 8, fontSize: 10, alignItems: 'baseline',
            }}>
              <span style={{ color: C.textMuted, fontFamily: 'monospace' }}>
                {slot}
              </span>
              <span style={{
                color: v.layer === 'lua' ? '#6B21A8' : '#075985',
                fontFamily: 'monospace', fontSize: 9, fontWeight: 700,
              }}>
                {(v.layer || '?').toUpperCase()}
              </span>
              <span style={{ color: C.text, fontFamily: 'monospace' }}>
                {v.signature || v.ty}
              </span>
              <span style={{ color: C.textMuted }}>
                {v.notes}
              </span>
            </div>
          ))}
        </div>
      </details>

      {/* Sources footer */}
      <div style={{
        fontSize: 10, color: C.textMuted, lineHeight: 1.5,
      }}>
        <b>Sources:</b>{' '}
        {sources.physical && <>physical · <code>{sources.physical}</code>; </>}
        {sources.software && <>software · <code>{sources.software}</code>; </>}
        {sources.lua && <>lua · <code>{sources.lua}</code>.</>}
      </div>
    </div>
  )
}

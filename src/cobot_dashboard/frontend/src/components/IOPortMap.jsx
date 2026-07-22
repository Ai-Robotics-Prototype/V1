import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react'

// Live-state + write context — 2026-07-22 I/O bridge (Task 30/31).
// The dashboard polls /api/io/live at 1 Hz and threads the merged
// snapshot + write callback through this context so every ChannelRow
// (not just the top-level component) can render authentic HIGH/LOW
// values and toggle DO/DI-force through the same shared plumbing.
const IOLiveContext = createContext({
  live:           null,    // last /api/io/live payload or null
  allowIo:        false,   // driver gate — false → toggles disabled
  bridgeUp:       false,   // /api/io/live returned ok:true recently
  expertMode:     false,   // Expert: force inputs toggle
  // Cabinet mode-selector key state, from RobotStatus.mode:
  //   0 = AUTO, 1 = MANUAL/TEACH, -1 = unknown
  // DO writes go through the Lua-runtime path (setDO() inside a
  // project/run) so they REQUIRE the physical key at AUTO. When the
  // key is at MANUAL, the controller raises alarm 10014 ("Robot not
  // in automatic mode.") and the write drops on the floor. Reading
  // this value here lets the UI grey out DO toggles before the
  // guaranteed-refusal round-trip.
  robotModeCode:  -1,
  writePort:      () => Promise.resolve({ ok: false }),
  bumpConfirm:    () => false,
})

function useIOLive() { return useContext(IOLiveContext) }


// Colour palette. Kept co-located with the component so the port map
// is self-contained; the legacy IOPanel that once shared this palette
// was retired on 2026-07-22 when the v2 map absorbed live values +
// manual actuation.
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
// Live-state pill. Reads from IOLiveContext — the dashboard polls
// /api/io/live at 1 Hz and threads the merged {DI,DO,AI,AO} snapshot
// through this context. Rows render HIGH/LOW (digital) or the raw
// float value (analog); if the bridge isn't up yet, falls back to a
// dashed placeholder so the layout is stable.
// ---------------------------------------------------------------------------
function LiveStatePill({ kind, port }) {
  const { live, bridgeUp } = useIOLive()
  const isAnalog = kind === 'AI' || kind === 'AO'
  const lookupKind = kind === 'HDI' ? 'DI' : kind  // HDI reads as DI
  const rows = live && live[lookupKind]
  const row  = rows ? rows.find((r) => r.port === port) : null
  if (!bridgeUp || !row || row.value == null) {
    // Bridge not up or port not in the driver's snapshot yet.
    return (
      <span
        title="Live state not available — driver I/O bridge polling has not seen this port yet."
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 9, fontFamily: 'monospace',
          color: C.textDim, letterSpacing: '0.03em',
          flexShrink: 0,
        }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: C.textDim, opacity: 0.5,
          border: `1px dashed ${C.textDim}`,
        }} />
        {isAnalog ? '—.-' : '—'}
      </span>
    )
  }
  if (isAnalog) {
    const num = Number(row.value)
    const text = Number.isFinite(num) ? num.toFixed(3) : '—'
    return (
      <span
        title={`Live value ${text} from IOManager/GetIOValue`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 9, fontFamily: 'monospace',
          color: KIND_META[kind]?.color || C.textMuted,
          letterSpacing: '0.03em', flexShrink: 0,
        }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: KIND_META[kind]?.color || C.textMuted,
        }} />
        {text}
      </span>
    )
  }
  const isHigh = !!Number(row.value)
  const isForced = !!Number(row.forced)
  const dot = isHigh ? '#16A34A' : C.textDim
  return (
    <span
      title={isForced
        ? `FORCED ${isHigh ? 'HIGH' : 'LOW'} — the controller reports this port is under a force override`
        : `Live: ${isHigh ? 'HIGH' : 'LOW'}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 9, fontFamily: 'monospace',
        color: isForced ? '#B45309' : (isHigh ? '#166534' : C.textDim),
        letterSpacing: '0.03em', flexShrink: 0, fontWeight: 700,
      }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dot,
        outline: isForced ? '2px solid #F59E0B' : 'none',
        outlineOffset: 1,
      }} />
      {isForced ? (isHigh ? 'HI◊' : 'LO◊') : (isHigh ? 'HI' : 'LO')}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Toggle switch. Reads live value + forced flag from context; writes
// via context.writePort(). Shows spinner while a write is pending
// (ack = the next /api/io/live snapshot that matches the requested
// value/forced). Optimistic UI is DELIBERATELY avoided — the toggle
// position reflects the driver's ACK, not the operator's intent.
// ---------------------------------------------------------------------------
function IOToggle({ kind, port, disabled, disabledReason }) {
  const { live, writePort, bumpConfirm } = useIOLive()
  const rows = live && live[kind]
  const row  = rows ? rows.find((r) => r.port === port) : null
  const [pending, setPending] = useState(null)   // { targetValue, sentTs }
  // Actual position: for DO we show HIGH iff (value=1 OR forced=1);
  // for DI-force we show HIGH iff forced=1 (that's what the toggle
  // controls). Both fall back to LOW when the row hasn't arrived.
  const isHighNow =
    kind === 'DO' ? (!!Number(row?.value) || !!Number(row?.forced))
                  : !!Number(row?.forced)
  const shownPosition = pending ? !!pending.targetValue : isHighNow

  // Clear pending once the snapshot matches (or after 3s regardless).
  useEffect(() => {
    if (!pending) return undefined
    if (isHighNow === !!pending.targetValue) {
      setPending(null); return undefined
    }
    const id = setTimeout(() => setPending(null), 3000)
    return () => clearTimeout(id)
  }, [pending, isHighNow])

  const onFlip = async (e) => {
    e.stopPropagation()
    if (disabled || pending) return
    if (kind === 'DO' && bumpConfirm()) {
      const ok = window.confirm(
        'Manual I/O control energizes connected hardware. Continue?')
      if (!ok) return
    }
    const target = shownPosition ? 0 : 1
    setPending({ targetValue: target, sentTs: Date.now() })
    try {
      await writePort({ port, value: target, type: kind })
    } catch { /* /api/io/force always returns JSON — swallow */ }
  }

  const isForced = !!Number(row?.forced)
  const trackBg = shownPosition
    ? (kind === 'DI' ? '#F59E0B' : '#16A34A')
    : C.textDim
  const opacity = disabled ? 0.4 : 1
  return (
    <button
      onClick={onFlip}
      disabled={disabled || pending != null}
      title={disabled
        ? (disabledReason || 'Toggle disabled — see gate status above')
        : `Click to ${shownPosition ? 'release' : 'assert'} ${kind}${port}. `
          + (kind === 'DI'
             ? 'DI force LIES to running programs — leave off unless testing.'
             : 'Manual DO drives the physical output.')}
      style={{
        position: 'relative',
        width: 40, height: 22, padding: 0, opacity,
        background: trackBg,
        border: 'none', borderRadius: 999,
        cursor: (disabled || pending) ? 'not-allowed' : 'pointer',
        transition: 'background 150ms',
        flexShrink: 0,
        outline: isForced ? '2px solid #F59E0B' : 'none',
        outlineOffset: 1,
      }}>
      <span style={{
        position: 'absolute',
        top: 2, left: shownPosition ? 20 : 2,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        transition: 'left 150ms',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {pending && (
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            border: '2px solid #6b7280', borderTopColor: 'transparent',
            animation: 'io-spin 800ms linear infinite',
            display: 'block',
          }} />
        )}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// PowerStripRow — collapses consecutive non-signal terminals of the
// SAME role (24V rail, 0V rail, FUSE, SHD, AUX) into a single thin
// row with an expandable list. Cuts 4+ repeated 24V/0V chips down to
// one strip per bank. Detail rows appear inline when expanded.
// ---------------------------------------------------------------------------
function PowerStripRow({ role, terminals }) {
  const [open, setOpen] = useState(false)
  const meta = ROLE_META[role] || ROLE_META.aux
  const label = role === 'power'   ? 'Power rail (24V)'
              : role === 'return'  ? 'Return rail (0V/COM)'
              : role === 'shield'  ? 'Shield'
              : role === 'aux'     ? 'Aux / FUSE'
              : ROLE_META[role]?.label || role
  return (
    <div style={{
      background: C.rowBgDim,
      border: `1px dashed ${C.border}`,
      borderRadius: 4, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${terminals.length} pins — ${terminals.map((t) => t.name).join(', ')}`}
        style={{
          width: '100%', background: 'transparent', border: 'none',
          padding: '3px 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          textAlign: 'left',
        }}>
        <span style={{
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 150ms',
          fontSize: 8, color: C.textDim,
        }}>▶</span>
        <span style={{
          fontSize: 10, color: C.textMuted, fontWeight: 600,
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{label}</span>
        <span style={{
          fontSize: 9, color: C.textMuted, fontFamily: 'monospace',
        }}>×{terminals.length}</span>
        <span style={{
          fontSize: 8, fontWeight: 700,
          color: meta.color, background: meta.bg,
          padding: '1px 5px', borderRadius: 3,
          letterSpacing: '0.05em',
        }}>{meta.label}</span>
      </button>
      {open && (
        <div style={{
          padding: '4px 8px 6px 22px',
          display: 'flex', flexWrap: 'wrap', gap: 4,
          borderTop: `1px dashed ${C.border}`,
        }}>
          {terminals.map((t) => (
            <span key={t.name} style={{
              fontSize: 10, fontFamily: 'monospace',
              color: C.textMuted, padding: '0 4px',
              background: '#fff', borderRadius: 3,
              border: `1px solid ${C.border}`,
            }}>{t.name}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BusPinsRow — collapses M-FUNC bus + control pins behind a single
// expandable summary. HDI pins stay visible as ChannelRows because
// they're operator-assignable I/O.
// ---------------------------------------------------------------------------
function BusPinsRow({ terminals }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{
      background: C.rowBgDim,
      border: `1px dashed ${C.border}`,
      borderRadius: 4, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={terminals.map((t) => `${t.name} (${t.role})`).join(', ')}
        style={{
          width: '100%', background: 'transparent', border: 'none',
          padding: '3px 8px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          textAlign: 'left',
        }}>
        <span style={{
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 150ms',
          fontSize: 8, color: C.textDim,
        }}>▶</span>
        <span style={{
          fontSize: 10, color: C.textMuted, fontWeight: 600, flex: 1,
        }}>bus &amp; control pins</span>
        <span style={{
          fontSize: 9, color: C.textMuted, fontFamily: 'monospace',
        }}>×{terminals.length}</span>
      </button>
      {open && (
        <div style={{
          padding: '4px 8px 6px 22px',
          display: 'flex', flexWrap: 'wrap', gap: 4,
          borderTop: `1px dashed ${C.border}`,
        }}>
          {terminals.map((t) => {
            const meta = ROLE_META[t.role] || ROLE_META.aux
            return (
              <span key={t.name} title={t.role} style={{
                fontSize: 10, fontFamily: 'monospace',
                color: C.textMuted, padding: '1px 4px',
                background: '#fff', borderRadius: 3,
                border: `1px solid ${C.border}`,
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
                {t.name}
                <span style={{
                  fontSize: 8, fontWeight: 700, color: meta.color,
                }}>{meta.label}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SafetyRail — the entire safety block collapses into one card by
// default. Operators never actuate these terminals from here (they
// live in the safety-PLC domain); the previous layout gave them 22
// rows of prime plate real estate for no operator benefit. Expand
// on demand for the full list.
// ---------------------------------------------------------------------------
function SafetyRail({ block }) {
  const [open, setOpen] = useState(false)
  const terminals = Array.isArray(block?.terminals) ? block.terminals : []
  if (terminals.length === 0) return null
  return (
    <div style={{
      background: '#FFE4E6',
      border: '1px solid #FBBF24',
      borderRadius: 6, overflow: 'hidden',
      gridColumn: '1 / -1',   // full-width row in the plate grid
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', background: 'transparent', border: 'none',
          padding: '8px 12px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10,
          textAlign: 'left',
        }}>
        <span style={{
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 150ms',
          fontSize: 10, color: '#9F1239',
        }}>▶</span>
        <span style={{
          fontSize: 9, fontWeight: 700,
          color: '#fff', background: '#B45309',
          padding: '1px 6px', borderRadius: 3,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}>SAFETY</span>
        <span style={{
          flex: 1, fontSize: 12, fontWeight: 600, color: '#9F1239',
        }}>
          Safety I/O — {terminals.length} terminals
        </span>
        <span style={{ fontSize: 10, color: '#9F1239', fontStyle: 'italic' }}>
          safety-PLC domain · not actuated from this UI
        </span>
      </button>
      {open && (
        <div style={{
          padding: '4px 12px 10px 32px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
          gap: 4,
          borderTop: '1px solid #FBBF24',
        }}>
          {terminals.map((t) => (
            <span key={t.name} style={{
              fontSize: 10, fontFamily: 'monospace',
              color: '#9F1239', padding: '1px 6px',
              background: '#fff', borderRadius: 3,
              border: '1px solid #FBBF24',
            }}>{t.name}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Non-signal terminal row (fallback for stray roles not otherwise
// bucketed into PowerStripRow / BusPinsRow — e.g. one-off safety
// pins on a non-safety block).
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
// SlotBadge — small position index (1-9) on each card header so the
// operator can count connectors left→right at the cabinet and match
// the screen 1:1. Blocks without a slot (SAFETY) render nothing.
// ---------------------------------------------------------------------------
function SlotBadge({ slot }) {
  if (slot == null) return null
  return (
    <span
      title={`Slot ${slot} — physical connector position, left→right on the CC10-A back panel.`}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, borderRadius: '50%',
        background: '#111827', color: '#fff',
        fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
        flexShrink: 0,
      }}>{slot}</span>
  )
}

// ---------------------------------------------------------------------------
// PairRowsBlock — two-column terminal grid used by M-FUNC and the
// PWR banks (v3 layout). Rows are `[left, right]` cells straight
// from the silkscreen; either cell can be a signal terminal (HDI1-4
// on M-FUNC) so we route through ChannelRow OR TerminalRow per cell.
// ---------------------------------------------------------------------------
function PairRowsBlock({ block, ports, specs, onEdit }) {
  const kind    = block.kind
  const group   = block.group || 'general'
  const meta    = KIND_META[kind] || { color: C.textMuted, short: kind, kindLabel: kind }
  const grpMeta = GROUP_META[group] || GROUP_META.general
  const tip     = specTooltip(kind, specs)
  const pairRows = Array.isArray(block.pair_rows) ? block.pair_rows : []
  const auxRows  = Array.isArray(block.aux) ? block.aux : []
  const editable = group !== 'system' && group !== 'safety'

  const renderCell = (cell, cellKey) => {
    if (!cell || typeof cell !== 'object') {
      return <div key={cellKey} style={{ minWidth: 0 }} />
    }
    if (cell.role === 'signal') {
      return (
        <ChannelRow
          key={cellKey}
          id={cell.name}
          kind={cell.kind || kind}
          meta={ports?.[cell.name]}
          row={{
            port: cell.port,
            default_name: cell.default_name || cell.name,
            function: cell.function,
            pair_tag: cell.pair_tag,
          }}
          editable={editable}
          onEdit={onEdit}
        />
      )
    }
    // Non-signal cells render as a compact single-terminal chip
    // (silkscreen-accurate: shows the literal terminal name + role).
    const roleMeta = ROLE_META[cell.role] || ROLE_META.aux
    return (
      <div key={cellKey} style={{
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
        }}>{cell.name}</span>
        <span style={{
          fontSize: 8, fontWeight: 700,
          color: roleMeta.color, background: roleMeta.bg,
          padding: '1px 5px', borderRadius: 3,
          letterSpacing: '0.05em', flexShrink: 0,
        }}>{roleMeta.label}</span>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: C.rowBg,
      border: `1px solid ${C.border}`,
      borderRadius: 6, overflow: 'hidden', minWidth: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px',
        background: grpMeta.tint !== 'transparent' ? grpMeta.tint : C.headerBg,
        borderBottom: `1px solid ${C.border}`,
        borderTop: `3px solid ${meta.color}`,
      }}>
        <SlotBadge slot={block.slot} />
        <span style={{
          fontSize: 9, fontWeight: 700,
          color: '#fff', background: meta.color,
          padding: '1px 5px', borderRadius: 3,
          letterSpacing: '0.05em', flexShrink: 0,
          textTransform: 'uppercase',
        }}>{meta.short}</span>
        <span style={{
          flex: 1, fontSize: 11, fontWeight: 600, color: '#374151',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{block.label}</span>
        <span
          title={block.notes || `${pairRows.length} paired rows — silkscreen exact.`}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, borderRadius: '50%',
            background: '#fff', color: C.textMuted,
            border: `1px solid ${C.border}`,
            fontSize: 9, fontWeight: 700, cursor: 'help',
            flexShrink: 0,
          }}>i</span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 3, padding: 5,
      }}>
        {pairRows.flatMap((row, ri) => [
          renderCell(row[0], `${ri}-L`),
          renderCell(row[1], `${ri}-R`),
        ])}
        {auxRows.length > 0 && (
          <div style={{
            gridColumn: '1 / -1',
            marginTop: 2, padding: '3px 8px',
            fontSize: 10, color: C.textMuted, fontFamily: 'monospace',
            background: '#FEF3C7', border: '1px solid #FBBF24',
            borderRadius: 4,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {auxRows.map((a) => (
              <span key={a.name}>{a.name}</span>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 8, fontWeight: 700,
                            color: '#92400E' }}>AUX</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SectionsBlock — one card, multiple labeled sub-sections, each with
// its own pair-row grid. Used by the AI/O connector (AO 0-3 on top,
// AI 0-3 below — one connector, two silkscreen sections).
// ---------------------------------------------------------------------------
function SectionsBlock({ block, ports, specs, onEdit }) {
  const kind    = block.kind
  const group   = block.group || 'general'
  const meta    = KIND_META[kind] || { color: C.textMuted, short: kind, kindLabel: kind }
  const grpMeta = GROUP_META[group] || GROUP_META.general
  const sections = Array.isArray(block.sections) ? block.sections : []
  const editable = group !== 'system' && group !== 'safety'

  const renderCell = (cell, key) => {
    if (!cell || typeof cell !== 'object') return null
    if (cell.role === 'signal') {
      return (
        <ChannelRow
          key={key}
          id={cell.name}
          kind={cell.kind || kind}
          meta={ports?.[cell.name]}
          row={{
            port: cell.port,
            default_name: cell.default_name || cell.name,
            function: cell.function,
            pair_tag: cell.pair_tag,
          }}
          editable={editable}
          onEdit={onEdit}
        />
      )
    }
    const roleMeta = ROLE_META[cell.role] || ROLE_META.aux
    return (
      <div key={key} style={{
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
        }}>{cell.name}</span>
        <span style={{
          fontSize: 8, fontWeight: 700,
          color: roleMeta.color, background: roleMeta.bg,
          padding: '1px 5px', borderRadius: 3,
          letterSpacing: '0.05em', flexShrink: 0,
        }}>{roleMeta.label}</span>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: C.rowBg,
      border: `1px solid ${C.border}`,
      borderRadius: 6, overflow: 'hidden', minWidth: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px',
        background: grpMeta.tint !== 'transparent' ? grpMeta.tint : C.headerBg,
        borderBottom: `1px solid ${C.border}`,
        borderTop: `3px solid ${meta.color}`,
      }}>
        <SlotBadge slot={block.slot} />
        <span style={{
          fontSize: 9, fontWeight: 700,
          color: '#fff', background: meta.color,
          padding: '1px 5px', borderRadius: 3,
          letterSpacing: '0.05em', flexShrink: 0,
          textTransform: 'uppercase',
        }}>{meta.short}</span>
        <span style={{
          flex: 1, fontSize: 11, fontWeight: 600, color: '#374151',
        }}>{block.label}</span>
        <span
          title={block.notes || ''}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, borderRadius: '50%',
            background: '#fff', color: C.textMuted,
            border: `1px solid ${C.border}`,
            fontSize: 9, fontWeight: 700, cursor: 'help', flexShrink: 0,
          }}>i</span>
      </div>
      <div style={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sections.map((sec, si) => (
          <div key={si} style={{
            border: `1px dashed ${C.border}`, borderRadius: 4,
          }}>
            <div style={{
              padding: '3px 8px', fontSize: 9, fontWeight: 700,
              color: C.textMuted, letterSpacing: '0.05em',
              textTransform: 'uppercase',
              borderBottom: `1px dashed ${C.border}`,
              background: C.rowBgDim,
            }}>{sec.label}</div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 3, padding: 4,
            }}>
              {(sec.rows || []).flatMap((row, ri) => [
                renderCell(row[0], `${si}-${ri}-L`),
                renderCell(row[1], `${si}-${ri}-R`),
              ])}
            </div>
          </div>
        ))}
      </div>
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
        <SlotBadge slot={block.slot} />
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
            title={(block.notes
                    ? `${block.notes}\n\n`
                    : '')
                   + `${wiring.mode.toUpperCase()} wiring — sensor return rail ${wiring.return_rail}.\n\n`
                   + (wiring.mode === 'sink'
                      ? 'Sink: sensor pulls the input LOW to the return rail. Wire signal → input, common → 0V.'
                      : 'Source: sensor drives the input HIGH from 24V. Wire signal → input, common → 24V.')}
            style={{
              fontSize: 8, fontWeight: 700,
              padding: '1px 5px', borderRadius: 3,
              background: wiring.mode === 'sink' ? '#DBEAFE' : '#DCFCE7',
              color:      wiring.mode === 'sink' ? '#1E40AF' : '#166534',
              letterSpacing: '0.05em', flexShrink: 0,
              textTransform: 'uppercase',
              cursor: 'help',
            }}>
            {wiring.mode} · {wiring.return_rail} <span style={{ opacity: 0.6, marginLeft: 2 }}>i</span>
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

      {/* block.notes was previously rendered here as a subhead
          paragraph — decluttered into the wiring badge's tooltip
          above so operators aren't paying attention to it every
          time they scan the port map. */}

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: 5,
      }}>
        {(() => {
          if (terminals.length === 0) {
            return (
              <div style={{ fontSize: 11, color: C.textDim, padding: '6px 4px' }}>
                No terminals configured.
              </div>
            )
          }
          // Bucket consecutive non-signal terminals into strips:
          // power/return each collapse to their own strip; bus/control
          // pins collapse together into one "bus & control" strip.
          // signal terminals render as usual. shield/aux/safety fall
          // into their nearest strip.
          const rendered = []
          const powerBuckets = { power: [], return: [], shield: [], aux: [] }
          const busPins = []
          for (const t of terminals) {
            if (t.role === 'signal') continue
            if (t.role === 'bus' || t.role === 'control') { busPins.push(t); continue }
            if (t.role in powerBuckets) { powerBuckets[t.role].push(t); continue }
          }
          for (const role of ['power', 'return', 'shield', 'aux']) {
            if (powerBuckets[role].length > 0) {
              rendered.push(
                <PowerStripRow key={`ps-${role}`} role={role}
                               terminals={powerBuckets[role]} />)
            }
          }
          if (busPins.length > 0) {
            rendered.push(<BusPinsRow key="bp" terminals={busPins} />)
          }
          for (const t of terminals) {
            if (t.role !== 'signal') continue
            rendered.push(
              <ChannelRow
                key={t.name}
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
              />)
          }
          // Fallback: any oddball role we didn't bucket falls through as
          // a plain TerminalRow so nothing disappears silently.
          for (const t of terminals) {
            if (t.role === 'signal' || t.role in powerBuckets
                || t.role === 'bus' || t.role === 'control') continue
            rendered.push(<TerminalRow key={t.name} name={t.name} role={t.role} />)
          }
          return rendered
        })()}
      </div>
    </div>
  )
}

function ChannelRow({ id, kind, meta, row, onEdit, editable }) {
  const inUse = !!meta?.in_use
  const rawLabel = meta?.assignment || ''
  // Empty / placeholder assignments render as a subtle em-dash — the
  // old fallback was the italic word "Unassigned", which truncated
  // to "Unassi…" on narrow lanes and read as active clutter. The
  // "—" reads as "nothing here" without adding text noise.
  const label = (rawLabel && rawLabel !== 'Unassigned') ? rawLabel : '—'
  const notes = meta?.notes || ''
  const [showNotes, setShowNotes] = useState(false)
  const [hover, setHover]         = useState(false)
  const bankColor = KIND_META[kind]?.color || C.textMuted
  const fnTag = row?.function
  const port  = row?.port
  const defaultName = row?.default_name
  // pair_tag = the terminal the operator physically lands the return
  // wire on for this row (0V for DI-A / DO-A, 24V for DI-B / DO-B,
  // AGNDn for analog rows). Rendered as a small right-side chip so
  // the on-screen row matches the silkscreen pairing 1:1.
  const pairTag = row?.pair_tag

  const { allowIo, bridgeUp, expertMode } = useIOLive()
  const showToggle =
       kind === 'DO'
    || (kind === 'DI' && expertMode)
  // DO writes flow through the Lua-runtime path (setDO() inside a
  // project/run — see driver's _do_do_write_lua). If the controller's
  // physical mode-selector key blocks the run, alarm 10014 fires and
  // the driver publishes a clean rejection on /estun/rejected with
  // the operator instruction. The earlier heuristic that gated on
  // RobotStatus.mode == 0 (AUTO) was a FALSE POSITIVE — live captures
  // show setDO() running successfully even when RobotStatus.mode == 1,
  // so we let the write proceed and rely on the alarm-catch fallback.
  // DI-force always works regardless of mode.
  const toggleDisabled = !allowIo || !bridgeUp
  const toggleDisabledReason = !bridgeUp
    ? 'Driver I/O bridge has not reported /estun/io yet — reconnect the driver.'
    : !allowIo
    ? 'allow_io gate closed on the driver — set ESTUN_ALLOW_IO=1 or allow_io:true in estun.yaml to enable manual I/O.'
    : ''

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column',
        gap: 2,
        padding: '5px 8px',
        borderRadius: 4,
        background: inUse ? '#fff' : C.rowBgDim,
        border: inUse
          ? `1px solid ${bankColor}55`
          : `1px solid ${C.border}`,
        opacity: inUse ? 1 : 0.85,
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
        <LiveStatePill kind={kind} port={port} />
        {pairTag && (
          <span
            title={`Physical return terminal for this row (silkscreen pairing): ${pairTag}. Land the return wire here.`}
            style={{
              fontSize: 8, fontWeight: 700,
              padding: '1px 5px', borderRadius: 3,
              background: pairTag === '24V' ? '#FEE2E2'
                        : pairTag === '0V'  ? '#E0F2FE'
                        : '#F3F4F6',
              color:      pairTag === '24V' ? '#991B1B'
                        : pairTag === '0V'  ? '#075985'
                        : '#374151',
              letterSpacing: '0.03em', flexShrink: 0,
              fontFamily: 'monospace',
            }}>{pairTag}</span>
        )}
        {showToggle && (
          <IOToggle kind={kind} port={port}
                    disabled={toggleDisabled}
                    disabledReason={toggleDisabledReason} />
        )}
      </div>

      {editable && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10, color: C.textMuted, minWidth: 0,
          // "+ notes" affordance is visible only on hover OR when the
          // row already carries notes / the notes input is open —
          // decluttered per Port Map v2.
          opacity: (hover || notes || showNotes) ? 1 : 0,
          transition: 'opacity 100ms',
          pointerEvents: (hover || notes || showNotes) ? 'auto' : 'none',
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
function Legend({ assignedCount, totalCount, saving, onReset, source,
                  allowIo, bridgeUp, expertMode, setExpertMode,
                  onClearForces, forcedCount }) {
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
        title={allowIo
          ? 'allow_io gate OPEN — DO toggles + DI force writes reach the '
            + 'controller via IOManager/SetIOForcedFlag.'
          : 'allow_io gate CLOSED on the driver. Set ESTUN_ALLOW_IO=1 '
            + 'in /etc/default/roboai-estun (or allow_io:true in '
            + 'estun.yaml) to enable manual I/O.'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 4,
          background: allowIo ? '#DCFCE7' : '#FEF3C7',
          color:      allowIo ? '#166534' : '#92400E',
          fontWeight: 600, fontSize: 10,
          border: `1px solid ${allowIo ? '#BBF7D0' : '#FDE68A'}`,
        }}>
        allow_io: {allowIo ? 'OPEN' : 'CLOSED'}
      </span>
      <span
        title={bridgeUp
          ? 'Driver I/O bridge is publishing /estun/io — GetIOValue / '
            + 'GetIOInfo polling live.'
          : 'Driver has not published /estun/io yet. Live-state pills + '
            + 'toggles are inert until the bridge is up.'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 4,
          background: bridgeUp ? '#DBEAFE' : '#F3F4F6',
          color:      bridgeUp ? '#1E40AF' : '#374151',
          fontWeight: 600, fontSize: 10,
          border: `1px solid ${bridgeUp ? '#93C5FD' : C.border}`,
        }}>
        bridge: {bridgeUp ? 'LIVE' : '—'}
      </span>
      <label
        title="Reveals DI force toggles. Forced inputs LIE to running programs — leave off unless bench-testing."
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 8px', borderRadius: 4,
          background: expertMode ? '#FEF3C7' : '#fff',
          color:      expertMode ? '#92400E' : C.textMuted,
          fontWeight: 600, fontSize: 10,
          border: `1px solid ${expertMode ? '#F59E0B' : C.border}`,
          cursor: 'pointer',
        }}>
        <input
          type="checkbox"
          checked={expertMode}
          onChange={(e) => setExpertMode(e.target.checked)}
          style={{ margin: 0 }} />
        Expert: force inputs
      </label>
      {expertMode && forcedCount > 0 && (
        <button
          onClick={onClearForces}
          title={`Release ${forcedCount} currently-forced port(s).`}
          style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 700,
            background: '#B45309', color: '#fff',
            border: 'none', borderRadius: 4, cursor: 'pointer',
          }}>
          Clear all {forcedCount} force{forcedCount === 1 ? '' : 's'}
        </button>
      )}
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
        color: bridgeUp ? '#166534' : C.textDim,
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: bridgeUp ? '#16A34A' : C.textDim,
          opacity: bridgeUp ? 1 : 0.5,
          border: bridgeUp ? 'none' : `1px dashed ${C.textDim}`,
        }} />
        {bridgeUp ? 'live · IOManager poll active' : 'live state pending'}
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

  // Live I/O bridge state. Polled at 1 Hz from /api/io/live. bridgeUp
  // becomes true after the first ok:true response and stays true unless
  // the endpoint drops back to ok:false (driver disconnected).
  const [live, setLive]         = useState(null)
  const [allowIo, setAllowIo]   = useState(false)
  const [bridgeUp, setBridgeUp] = useState(false)
  const [robotModeCode, setRobotModeCode] = useState(-1)
  const [expertMode, setExpertMode] = useState(false)
  // One-time confirm latch — first DO toggle after page load prompts;
  // subsequent toggles are direct. bumpConfirm() returns true IF the
  // confirm still needs to run, then flips the latch.
  const [doConfirmed, setDoConfirmed] = useState(false)
  const bumpConfirm = useCallback(() => {
    if (doConfirmed) return false
    setDoConfirmed(true)
    return true
  }, [doConfirmed])

  const writePort = useCallback(async ({ port, value, type }) => {
    try {
      const res = await fetch('/api/io/force', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, value, type }),
      })
      return await res.json()
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const r = await fetch('/api/io/live')
        const d = await r.json()
        if (cancelled) return
        if (d && d.ok) {
          setLive(d)
          setAllowIo(!!d.allow_io)
          setBridgeUp(true)
          setRobotModeCode(
            Number.isFinite(d.robot_mode_code) ? d.robot_mode_code : -1)
        } else {
          setBridgeUp(false)
          if (d && Number.isFinite(d.robot_mode_code)) {
            setRobotModeCode(d.robot_mode_code)
          }
        }
      } catch {
        if (!cancelled) setBridgeUp(false)
      }
    }
    pull()
    const id = setInterval(pull, 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Force-count for the Clear-All action.
  const forcedPorts = []
  if (live) {
    for (const kind of ['DI', 'DO']) {
      for (const r of live[kind] || []) {
        if (Number(r.forced) === 1) forcedPorts.push({ kind, port: r.port })
      }
    }
  }
  const onClearForces = useCallback(async () => {
    if (forcedPorts.length === 0) return
    if (!window.confirm(
      `Release ${forcedPorts.length} forced port(s)? This unforces every DI + DO currently in a force state.`)) return
    for (const p of forcedPorts) {
      // eslint-disable-next-line no-await-in-loop
      await writePort({ port: p.port, value: 0, type: p.kind })
    }
  }, [forcedPorts, writePort])

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
    <IOLiveContext.Provider value={{
      live, allowIo, bridgeUp, expertMode, writePort, bumpConfirm,
      robotModeCode,
    }}>
    <style>{`@keyframes io-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
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
        allowIo={allowIo}
        bridgeUp={bridgeUp}
        expertMode={expertMode}
        setExpertMode={setExpertMode}
        onClearForces={onClearForces}
        forcedCount={forcedPorts.length}
      />

      {/* Physical plate — connectors in silkscreen order, left→right.
          Safety block is intercepted and rendered as a single collapsed
          SafetyRail card at the bottom (nobody actuates safety-PLC
          terminals from this UI — see PORT-MAP v2 declutter). */}
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
        {plate
          .filter((b) => b.group !== 'safety')
          .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))
          .map((blk) => {
            // v3 dispatch — new layouts route to purpose-built cards.
            if (blk.layout === 'pair-rows') {
              return <PairRowsBlock key={blk.id} block={blk}
                                    ports={ports} specs={specs}
                                    onEdit={onEdit} />
            }
            if (blk.layout === 'sections') {
              return <SectionsBlock key={blk.id} block={blk}
                                    ports={ports} specs={specs}
                                    onEdit={onEdit} />
            }
            return <PlateBlock key={blk.id} block={blk}
                               ports={ports} specs={specs}
                               onEdit={onEdit} />
          })}
        {plate.filter((b) => b.group === 'safety').map((blk) => (
          <SafetyRail key={blk.id} block={blk} />
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
    </IOLiveContext.Provider>
  )
}

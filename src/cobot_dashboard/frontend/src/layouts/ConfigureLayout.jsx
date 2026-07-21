import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
// WorkspaceMaskSection removed from the Configure UI — the component
// file + backend endpoints are intentionally kept in the repo so
// the feature can be re-surfaced without re-implementation.
import SetupWizard from '../components/SetupWizard'
import CellDetailPanel from '../components/CellDetailPanel'
import { useCellWizardStore } from '../store/cellWizardStore'

const LS_KEY = 'roboai-config'

const BRANDS = ['xarm', 'jaka', 'dobot', 'generic']

function Section({ title, children }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-primary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        paddingBottom: 8,
        borderBottom: '1px solid var(--border)',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Field({ label, children, note }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <label style={{ fontSize: 12, color: 'var(--text-secondary)', width: 140, flexShrink: 0 }}>
        {label}
      </label>
      <div style={{ flex: 1 }}>
        {children}
        {note && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{note}</div>
        )}
      </div>
    </div>
  )
}

const inputStyle = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  padding: '5px 9px',
  fontSize: 12,
  width: '100%',
  outline: 'none',
  transition: 'border-color 150ms',
}

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
}

// SVG concentric rings for zone visualisation
function ZoneRingSVG({ green, yellow, red }) {
  const size = 180
  const cx   = size / 2
  const cy   = size / 2
  const maxR = 2.5
  const SCALE = (size / 2 - 10) / maxR

  const rings = [
    { r: parseFloat(green)  || 2.0, color: '#22C55E', label: 'Green' },
    { r: parseFloat(yellow) || 1.2, color: '#EAB308', label: 'Yellow' },
    { r: parseFloat(red)    || 0.6, color: '#EF4444', label: 'Red' },
  ]

  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      {rings.map(({ r, color, label }) => {
        const pxR = Math.min(r * SCALE, size / 2 - 4)
        return (
          <g key={label}>
            <circle cx={cx} cy={cy} r={pxR} fill={`${color}10`} stroke={color} strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={cx + pxR + 3} y={cy + 4} fontSize={8} fill={color} opacity={0.8}>
              {r}m
            </text>
          </g>
        )
      })}
      {/* Robot */}
      <rect x={cx - 6} y={cy - 8} width={12} height={16} rx={3} fill="#3B82F6" opacity={0.9} />
    </svg>
  )
}

function CellRow({ c, allCells, busy, onActivate, onDelete, expanded, onToggleExpand, onRefresh }) {
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div
        onClick={onToggleExpand}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px',
          cursor: 'pointer',
          background: expanded ? 'rgba(37,99,235,0.06)' : 'transparent',
          transition: 'background 120ms',
        }}>
        <span
          aria-label={expanded ? 'Collapse' : 'Expand'}
          style={{
            color: 'var(--text-muted)', fontSize: 13,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms',
            width: 12, display: 'inline-block',
          }}>▶</span>
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: c.is_active ? '#22c55e' : '#475569',
          flexShrink: 0,
        }} title={c.is_active ? 'Active cell' : 'Inactive'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {c.name}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {c.baseline_captured
              ? `Baseline ${(c.baseline_point_count || 0).toLocaleString()} pts`
              : 'No baseline'}
            {' · '}
            {(c.program_count ?? 0)} {(c.program_count === 1) ? 'program' : 'programs'}
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700,
          padding: '2px 8px', borderRadius: 999,
          background: c.commissioning_complete ? '#dcfce7' : '#fef3c7',
          color:      c.commissioning_complete ? '#166534' : '#92400e',
        }}>
          {c.commissioning_complete ? 'Complete' : 'Incomplete'}
        </span>
        {!c.is_active && (
          <button onClick={(e) => { e.stopPropagation(); onActivate(c.cell_id) }}
            disabled={busy} style={cellBtn('#2563EB')}>
            Activate
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onDelete(c.cell_id) }}
          disabled={busy} style={cellBtn('#DC2626')}>
          Delete
        </button>
      </div>
      <div style={{
        maxHeight: expanded ? 9999 : 0,
        opacity: expanded ? 1 : 0,
        overflow: expanded ? 'visible' : 'hidden',
        transition: 'opacity 180ms',
      }}>
        {expanded && (
          <CellDetailPanel
            cellId={c.cell_id}
            allCells={allCells}
            onRefresh={onRefresh}
            onDeleted={() => onRefresh()}
          />
        )}
      </div>
    </div>
  )
}

function CellSetupSection() {
  const openWizard       = useCellWizardStore((s) => s.openWizard)
  const wizardOpen       = useCellWizardStore((s) => s.open)
  const closeWizard      = useCellWizardStore((s) => s.closeWizard)
  const expandedId       = useCellWizardStore((s) => s.expandedCellId)
  const setExpandedCell  = useCellWizardStore((s) => s.setExpandedCell)
  const clearCellPanel   = useCellWizardStore((s) => s.clearCellPanelState)

  const [busy, setBusy] = useState(false)
  // Shared cells store — Configure is both a reader and a writer.
  // App.jsx kicks off `hydrateCells()` at boot, on tab focus, and on
  // navigation INTO this tab, so by the time we render here the
  // store usually already has the list. We never keep our own copy
  // in local state anymore — that was the source of the "no cells
  // until I refresh" bug (a silent fetch failure stranded local
  // state at the empty default).
  const cells           = useStore((s) => s.cellsList)
  const cellsHydrated   = useStore((s) => s.cellsHydrated)
  const setActiveCellId = useStore((s) => s.setActiveCellId)
  const refreshCells    = useStore((s) => s.refreshCells)
  const hydrateCells    = useStore((s) => s.hydrateCells)

  // Belt-and-suspenders: if this component mounts before App's
  // tab-change effect fires (or that effect was somehow skipped),
  // kick a hydrate. The store throttles redundant calls so this is
  // free when the data is already fresh.
  useEffect(() => { hydrateCells() }, [hydrateCells])

  // Local convenience: refresh the global store + return when done
  // so the existing callers (Activate, Delete, SetupWizard onSaved,
  // CellRow onRefresh) keep their await contract.
  const refresh = useCallback(() => refreshCells(), [refreshCells])

  const onToggleExpand = (cellId) => {
    setExpandedCell(cellId)
  }

  const onActivate = async (cellId) => {
    setBusy(true)
    try {
      await fetch(`/api/cells/${cellId}/activate`, { method: 'POST' })
      // Write the new active id into the shared store immediately so
      // the 3D View (and ProgramWizard etc.) flip without waiting for
      // the refresh round-trip. Pull the cell payload from the
      // currently-loaded list so the baseline_captured flag is correct.
      const cellPayload = (cells || []).find((c) => c.cell_id === cellId) || null
      setActiveCellId(cellId, cellPayload)
      await refresh()
    } finally { setBusy(false) }
  }

  const onDelete = async (cellId) => {
    if (!confirm('Delete this cell? This removes the profile and baseline cloud.')) return
    setBusy(true)
    try {
      await fetch(`/api/cells/${cellId}`, { method: 'DELETE' })
      clearCellPanel(cellId)
      await refresh()
    } finally { setBusy(false) }
  }

  return (
    <>
      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
          paddingBottom: 8, borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>Setup Wizard — Cells</span>
          <button
            onClick={() => openWizard(null)}
            style={{
              background: '#16A34A', color: '#fff', border: 'none',
              padding: '6px 14px', borderRadius: 'var(--radius-sm)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              textTransform: 'none', letterSpacing: 'normal',
            }}>
            + Commission a New Cell
          </button>
        </div>
        {!cellsHydrated ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, color: 'var(--text-muted)', padding: '8px 0',
          }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#94a3b8',
              animation: 'cellsLoadingPulse 1.2s ease-in-out infinite',
            }} />
            Loading cells…
          </div>
        ) : cells.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
            No cells commissioned yet. Click <strong>Commission a New Cell</strong> to set up your first workspace.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {cells.map((c) => (
              <CellRow key={c.cell_id} c={c}
                allCells={cells}
                busy={busy}
                onActivate={onActivate}
                onDelete={onDelete}
                expanded={expandedId === c.cell_id}
                onToggleExpand={() => onToggleExpand(c.cell_id)}
                onRefresh={refresh}
              />
            ))}
          </div>
        )}
        <style>{`@keyframes cellsLoadingPulse {
          0%, 100% { opacity: 0.3 } 50% { opacity: 1 }
        }`}</style>
      </div>
      {wizardOpen && (
        <SetupWizard
          onClose={() => { closeWizard(); refresh() }}
          onSaved={() => { refresh() }}
        />
      )}
    </>
  )
}

function cellBtn(color) {
  return {
    background: color, color: '#fff', border: 'none',
    padding: '4px 10px', borderRadius: 4,
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  }
}

// ---------------------------------------------------------------------------
// System Check
//
// Read-only readiness summary. Five rows, one dot + one short state each.
// No live-graph clutter. Details appear only when a row is amber/red and
// the operator expands it. Never auto-remediates: any per-row action is
// operator-initiated and behind a confirm.
// ---------------------------------------------------------------------------

const DOT_COLORS = {
  green: '#22C55E',
  amber: '#EAB308',
  red:   '#EF4444',
}

function StatusDot({ level }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 10, height: 10, borderRadius: '50%',
      background: DOT_COLORS[level] || '#475569',
      flexShrink: 0,
    }} />
  )
}

function SystemCheckRow({ row, expanded, onToggle, onRestart }) {
  const canExpand = row.level !== 'green' && (row.detail || row.services)
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
    }}>
      <div
        onClick={canExpand ? onToggle : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px',
          cursor: canExpand ? 'pointer' : 'default',
          background: expanded ? 'rgba(37,99,235,0.06)' : 'transparent',
          transition: 'background 120ms',
        }}>
        <span
          style={{
            color: 'var(--text-muted)', fontSize: 13,
            width: 12, display: 'inline-block',
            visibility: canExpand ? 'visible' : 'hidden',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms',
          }}>▶</span>
        <StatusDot level={row.level} />
        <div style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
          flex: 1, minWidth: 0,
        }}>
          {row.label}
        </div>
        <div style={{
          fontSize: 12,
          color: row.level === 'green'
            ? 'var(--text-secondary)'
            : DOT_COLORS[row.level],
          fontFamily: 'var(--font-mono)',
        }}>
          {row.state}
        </div>
      </div>
      {expanded && canExpand && (
        <div style={{
          padding: '8px 12px 12px 34px',
          borderTop: '1px solid var(--border)',
          fontSize: 11, color: 'var(--text-secondary)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {row.detail && (
            <div style={{ lineHeight: 1.5 }}>{row.detail}</div>
          )}
          {row.key === 'services' && row.services && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {Object.entries(row.services).map(([name, ok]) => (
                <div key={name} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontFamily: 'var(--font-mono)',
                }}>
                  <StatusDot level={ok ? 'green' : 'red'} />
                  <span>{name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {ok ? 'active' : 'inactive'}
                  </span>
                  {!ok && name === 'roboai-dashboard' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onRestart(name) }}
                      style={{
                        background: '#DC2626', color: '#fff', border: 'none',
                        padding: '3px 10px', borderRadius: 4,
                        fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        marginLeft: 'auto',
                      }}>
                      Restart…
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {row.key === 'software' && row.level === 'amber' && (
            <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
              How to refresh:
              <ol style={{ margin: '4px 0 0 20px', padding: 0 }}>
                <li>Rebuild the frontend: <code>cd frontend &amp;&amp; npm run build</code></li>
                <li>Copy <code>frontend/dist/</code> over <code>mock_server/static/</code></li>
                <li>Reload this browser tab (hard-refresh to bypass any cache)</li>
              </ol>
              {(row.served_hash || row.built_hash) && (
                <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)' }}>
                  served <b>{row.served_hash || '—'}</b>
                  {' · '}
                  built <b>{row.built_hash || '—'}</b>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SystemCheckSection() {
  const [data, setData]           = useState(null)
  const [error, setError]         = useState(null)
  const [expanded, setExpanded]   = useState(null)
  const [refreshing, setRefresh]  = useState(false)
  const [lastAt, setLastAt]       = useState(null)

  const load = useCallback(async () => {
    setRefresh(true)
    try {
      const r = await fetch('/api/systemcheck')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setData(d)
      setError(null)
      setLastAt(Date.now())
    } catch (e) {
      setError(e.message || 'fetch failed')
    } finally {
      setRefresh(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [load])

  const onRestart = async (service) => {
    if (!confirm(`Restart ${service}?\n\nThis will interrupt the dashboard briefly. The arm is not affected.`)) return
    try {
      const r = await fetch('/api/systemcheck/service/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.ok === false) {
        alert(`Restart failed (rc=${d.rc ?? '?'}):\n${d.stderr || d.error || 'unknown error'}`)
      }
      load()
    } catch (e) {
      alert(`Restart failed: ${e.message}`)
    }
  }

  const ready   = data?.ready
  const summary = data?.summary || (error ? 'CHECK FAILED' : 'Checking…')
  const summaryColor =
    ready === true  ? DOT_COLORS.green :
    ready === false ? DOT_COLORS.red   : 'var(--text-muted)'

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '16px 20px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        paddingBottom: 8, borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>System Check</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastAt && (
            <span style={{
              fontSize: 10, fontWeight: 400, color: 'var(--text-muted)',
              textTransform: 'none', letterSpacing: 'normal',
            }}>
              {refreshing ? 'checking…' : `updated ${Math.round((Date.now() - lastAt) / 1000)}s ago`}
            </span>
          )}
          <button
            onClick={load}
            disabled={refreshing}
            style={{
              background: 'var(--accent)', border: 'none', color: '#fff',
              padding: '4px 12px', borderRadius: 'var(--radius-sm)',
              fontSize: 11, fontWeight: 500, cursor: 'pointer',
              textTransform: 'none', letterSpacing: 'normal',
              opacity: refreshing ? 0.6 : 1,
            }}>
            Re-run
          </button>
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '4px 0 8px',
      }}>
        <span style={{
          width: 14, height: 14, borderRadius: '50%',
          background: summaryColor,
          boxShadow: `0 0 0 4px ${summaryColor}22`,
        }} />
        <div style={{
          fontSize: 18, fontWeight: 600,
          color: summaryColor,
          letterSpacing: '0.02em',
        }}>
          {ready ? 'System Ready' : summary}
        </div>
      </div>

      {error && !data && (
        <div style={{ fontSize: 12, color: 'var(--red)' }}>
          Failed to load system check: {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(data?.checks || []).map((row) => (
          <SystemCheckRow
            key={row.key}
            row={row}
            expanded={expanded === row.key}
            onToggle={() => setExpanded(expanded === row.key ? null : row.key)}
            onRestart={onRestart}
          />
        ))}
      </div>
    </div>
  )
}

export default function ConfigureLayout() {
  const setMode = useStore((s) => s.setMode)
  const mode    = useStore((s) => s.mode)

  const [cfg, setCfg] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    } catch {
      return {}
    }
  })
  const [apiConfig, setApiConfig]   = useState(null)
  const [connResult, setConnResult] = useState(null)
  const [connTesting, setConnTesting] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setApiConfig)
      .catch(() => {})
  }, [])

  function update(key, value) {
    const next = { ...cfg, [key]: value }
    setCfg(next)
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  }

  async function testConnection() {
    setConnTesting(true)
    setConnResult(null)
    try {
      const r = await fetch('/health')
      const d = await r.json()
      setConnResult({ ok: d.status === 'ok', msg: `Status: ${d.status} | Uptime: ${d.uptime_s}s | Mock: ${d.mock}` })
    } catch (e) {
      setConnResult({ ok: false, msg: `Connection failed: ${e.message}` })
    } finally {
      setConnTesting(false)
    }
  }

  const zoneGreen  = cfg.zone_green  ?? apiConfig?.safety?.zone_green_m  ?? '2.0'
  const zoneYellow = cfg.zone_yellow ?? apiConfig?.safety?.zone_yellow_m ?? '1.2'
  const zoneRed    = cfg.zone_red    ?? apiConfig?.safety?.zone_red_m    ?? '0.6'

  return (
    <div style={{
      height: '100%',
      overflowY: 'auto',
      padding: '20px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      background: 'var(--bg-app)',
    }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Configure
      </div>

      <SystemCheckSection />

      <CellSetupSection />

      {/* Robot Connection */}
      <Section title="Robot Connection">
        <Field label="Brand">
          <select
            style={selectStyle}
            value={cfg.brand ?? apiConfig?.robot?.brand ?? 'generic'}
            onChange={(e) => update('brand', e.target.value)}
          >
            {BRANDS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </Field>
        <Field label="IP Address">
          <input
            style={inputStyle}
            type="text"
            value={cfg.ip ?? apiConfig?.robot?.ip ?? '192.168.1.246'}
            onChange={(e) => update('ip', e.target.value)}
            placeholder="192.168.1.246"
          />
        </Field>
        <Field label="Port">
          <input
            style={inputStyle}
            type="number"
            value={cfg.port ?? apiConfig?.robot?.port ?? 502}
            onChange={(e) => update('port', parseInt(e.target.value, 10))}
            placeholder="502"
          />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={testConnection}
            disabled={connTesting}
            style={{
              background: 'var(--accent)',
              border: 'none',
              color: '#fff',
              padding: '6px 14px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {connTesting ? 'Testing…' : 'Test Connection'}
          </button>
          {connResult && (
            <span style={{
              fontSize: 11,
              color: connResult.ok ? 'var(--green)' : 'var(--red)',
              fontFamily: 'var(--font-mono)',
            }}>
              {connResult.ok ? '✓' : '✗'} {connResult.msg}
            </span>
          )}
        </div>
      </Section>

      {/* Safety Zones */}
      <Section title="Safety Zones">
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Green zone (m)" note="Max speed — > this radius">
              <input
                style={inputStyle}
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={zoneGreen}
                onChange={(e) => update('zone_green', e.target.value)}
              />
            </Field>
            <Field label="Yellow zone (m)" note="Slow speed — between yellow and green">
              <input
                style={inputStyle}
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={zoneYellow}
                onChange={(e) => update('zone_yellow', e.target.value)}
              />
            </Field>
            <Field label="Red zone (m)" note="Stop — within this radius">
              <input
                style={inputStyle}
                type="number"
                step="0.05"
                min="0.1"
                max="5"
                value={zoneRed}
                onChange={(e) => update('zone_red', e.target.value)}
              />
            </Field>
          </div>
          <ZoneRingSVG green={zoneGreen} yellow={zoneYellow} red={zoneRed} />
        </div>
      </Section>

      {/* Camera Settings */}
      <Section title="Camera Settings">
        {(apiConfig?.cameras ?? []).map((cam) => (
          <Field key={cam.id} label={`Camera ${cam.id} Topic`} note={`Stream FPS: ${cam.fps} (read-only)`}>
            <input
              style={{ ...inputStyle, color: 'var(--text-muted)' }}
              value={cam.topic}
              readOnly
            />
          </Field>
        ))}
        {!apiConfig?.cameras?.length && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading camera config…</div>
        )}
      </Section>

      {/* Interface */}
      <Section title="Interface">
        <Field label="Operator Mode">
          <div style={{ display: 'flex', gap: 3 }}>
            {['operator', 'engineer'].map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); update('mode', m) }}
                style={{
                  background: mode === m ? 'var(--accent-dim)' : 'var(--bg-panel)',
                  border: `1px solid ${mode === m ? 'var(--accent-border)' : 'var(--border)'}`,
                  color: mode === m ? 'var(--accent)' : 'var(--text-secondary)',
                  padding: '4px 14px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  fontWeight: mode === m ? 500 : 400,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Theme" note="Only dark theme supported">
          <button
            style={{
              background: 'var(--accent-dim)',
              border: '1px solid var(--accent-border)',
              color: 'var(--accent)',
              padding: '4px 14px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'default',
            }}
          >
            Dark
          </button>
        </Field>
      </Section>

      {/* Version info */}
      <div style={{
        fontSize: 10,
        color: 'var(--text-muted)',
        textAlign: 'center',
        padding: '8px 0 16px',
      }}>
        NeuRobots Control v1.0.0-mock — Settings saved to localStorage
      </div>
    </div>
  )
}

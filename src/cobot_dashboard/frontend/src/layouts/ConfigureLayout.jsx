import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import SetupWizard from '../components/SetupWizard'
import CellDetailPanel from '../components/CellDetailPanel'
import { useCellWizardStore } from '../store/cellWizardStore'
// 2026-09-04 Configure additions: Cam0CalibrationCard, RecentRunsCard,
// and getServedBundleHash imports retired along with the Camera
// calibration disclosure, Motion recordings, and Provenance card.
// SystemCheckSection + DeviceIdentitySection function bodies stay
// as dead code below (safe to remove in a later sweep — leaving
// them defined avoids touching helpers they share with active
// sections and keeps the diff surgical).

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

// eslint-disable-next-line no-unused-vars
function _SystemCheckRow_UNUSED_20260904({ row, expanded, onToggle, onRestart }) {
  // Green rows normally hide their detail, but Safety carries the
  // operator speed cap in `detail` even when green — always let the
  // row expand so the cap is discoverable.
  const canExpand = (row.detail || row.services) &&
    (row.level !== 'green' || row.key === 'safety')
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

// 2026-08-05 (identity root-cause fix, Directive item 2). One
// physical device = one identity + one human-readable label.
// The label is stored in ui_context.device_label on the Jetson
// and shown in every teach-lock banner + event log entry.
// Default derived from platform sniff on first run ("Tablet"
// on touch devices, "PC" otherwise); the operator renames it
// here.
// eslint-disable-next-line no-unused-vars
function _DeviceIdentitySection_UNUSED_20260904() {
  const label = useStore((s) => s._teachDeviceLabel)
  const setLabel = useStore((s) => s.setTeachDeviceLabel)
  const getDefault = useStore((s) => s._getTeachDeviceLabel)
  const getId    = useStore((s) => s._getTeachDeviceId)
  const [draft, setDraft] = useState(label || getDefault())
  useEffect(() => {
    // Sync draft when the cached label lands (post-mount fetch).
    if (label && label !== draft) setDraft(label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label])
  const id = getId()
  const dirty = draft.trim() && draft.trim() !== (label || '')
  const onSave = () => {
    const clean = draft.trim().slice(0, 64)
    if (!clean) return
    setLabel(clean)
  }
  return (
    <div style={{
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '12px 16px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
        This device
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        The name other devices see in teach-lock banners and the
        event log. Persists across tabs and refreshes.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <input
          data-testid="device-label-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Shop Tablet"
          maxLength={64}
          style={{
            flex: 1, minWidth: 0,
            background: 'var(--bg-app)', color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4, padding: '6px 10px', fontSize: 13,
          }}
        />
        <button
          data-testid="device-label-save"
          disabled={!dirty}
          onClick={onSave}
          style={{
            padding: '6px 14px',
            background: dirty ? 'var(--accent)' : 'var(--bg-app)',
            color: dirty ? '#0C0C0E' : 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4, fontSize: 12,
            cursor: dirty ? 'pointer' : 'default',
          }}>Save</button>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)' }}>
        device_id: {id}
      </div>
    </div>
  )
}

// 2026-08-06 (operator directive: ENTIRE self-collision system OFF).
// Single authoritative kill switch for the self-collision + ground-
// plane capsule guard, ALL tiers. Default OFF per the directive.
// This card is intentionally prominent (red when off) so the state
// is operator-visible, not buried. Every toggle lands in the event
// log — the boot state, every runtime flip, every observed change.
function SelfCollisionGuardSection() {
  const [state, setState]     = useState(null)   // last-known from GET
  const [busy, setBusy]       = useState(false)
  const [confirming, setConfirming] = useState(null) // 'on' | 'off' | null
  const collEnabled = useStore((s) => s.robot?.collision_enabled)
  const modelLoaded = useStore((s) => s.robot?.collision_model_loaded)

  // Poll once on mount + subscribe to live state via robot.collision_*.
  // Live state wins — the poll seeds before the WS frame arrives.
  useEffect(() => {
    let cancelled = false
    fetch('/api/collision_guard').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled && d) setState(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const enabled = (collEnabled != null) ? !!collEnabled
                : (state ? !!state.enabled : false)

  async function apply(target) {
    if (busy) return
    setBusy(true)
    try {
      const r = await fetch('/api/collision_guard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!target }),
      })
      if (r.ok) {
        const d = await r.json().catch(() => ({}))
        setState((s) => ({ ...(s || {}), enabled: !!d.enabled }))
      }
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const bg = enabled ? '#052E1C' : '#3F0F0F'
  const bd = enabled ? '#065F46' : '#DC2626'
  const fg = enabled ? '#A7F3D0' : '#FCA5A5'
  return (
    <div style={{
      background: bg, border: `2px solid ${bd}`,
      borderRadius: 'var(--radius-sm)',
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 8,
      color: fg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          display: 'inline-block', width: 10, height: 10,
          borderRadius: '50%',
          background: enabled ? '#22C55E' : '#EF4444',
        }} />
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Self-collision guard: {enabled ? 'ON' : 'OFF'}
        </div>
        <div style={{ flex: 1 }} />
        <button
          data-testid="collision-guard-toggle"
          disabled={busy}
          onClick={() => setConfirming(enabled ? 'off' : 'on')}
          style={{
            padding: '6px 14px', fontSize: 12, fontWeight: 700,
            background: enabled ? '#7F1D1D' : '#065F46',
            color: '#fff',
            border: `1px solid ${enabled ? '#DC2626' : '#059669'}`,
            borderRadius: 4, cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}>
          {enabled ? 'Turn OFF' : 'Turn ON'}
        </button>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: fg }}>
        {enabled
          ? ('The 15 mm hard self-collision stop, the 40 mm soft warn '
             + 'tier, and the ground-plane hard limit are ACTIVE. Motion '
             + 'that would put a link within stop distance of another '
             + 'link or the floor will be halted.')
          : ('ALL software collision guards are OFF. Nothing in software '
             + 'prevents a link-on-link crash or a link-on-table crash. '
             + 'This is the operator’s explicit informed choice — flip '
             + 'ON to re-arm.')}
      </div>
      {!modelLoaded && enabled && (
        <div style={{
          fontSize: 11, background: '#78350F', color: '#FEF3C7',
          padding: '6px 10px', borderRadius: 4,
        }}>
          Guard is ON but the capsule model failed to load — no
          pairs are being evaluated. Check
          /opt/cobot/config/self_collision_capsules.yaml.
        </div>
      )}
      {confirming && (
        <div style={{
          marginTop: 4, padding: 10,
          background: '#111827', border: '1px solid #1F2937',
          borderRadius: 6, color: '#E5E7EB',
        }}>
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            {confirming === 'off'
              ? 'Turn the self-collision guard OFF? Nothing in software will prevent link-on-link or link-on-table crashes.'
              : 'Turn the self-collision guard ON? Motion will be halted when a link comes within stop distance of another link or the floor.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              data-testid="collision-guard-confirm"
              disabled={busy}
              onClick={() => apply(confirming === 'on')}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 700,
                background: confirming === 'off' ? '#7F1D1D' : '#065F46',
                color: '#fff', border: 'none',
                borderRadius: 4, cursor: 'pointer',
              }}>
              Confirm — turn {confirming.toUpperCase()}
            </button>
            <button
              disabled={busy}
              onClick={() => setConfirming(null)}
              style={{
                padding: '6px 14px', fontSize: 12,
                background: 'transparent', color: '#E5E7EB',
                border: '1px solid #374151',
                borderRadius: 4, cursor: 'pointer',
              }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// eslint-disable-next-line no-unused-vars
function _SystemCheckSection_UNUSED_20260904() {
  const [data, setData]           = useState(null)
  const [error, setError]         = useState(null)
  const [expanded, setExpanded]   = useState(null)
  const [refreshing, setRefresh]  = useState(false)
  const [lastAt, setLastAt]       = useState(null)
  // 2026-09-04: `mode`/`setMode` reads retired. The Operator/Engineer
  // toggle that used to live at the bottom of this section is
  // deleted per operator directive — its only downstream consumer
  // was ControlStrip.jsx (which itself is unmounted). No other code
  // path reads useStore.mode.

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

      {/* 2026-09-04: the Operator / Engineer toggle here is retired.
          It was vestigial — only ControlStrip.jsx read useStore.mode,
          and ControlStrip is not mounted anywhere in the active tree.
          Store slots (`mode`/`setMode`, persist partialize entry) are
          also removed. */}
    </div>
  )
}

// 2026-09-04 operator directive: ProvenanceSection retired. The
// enforcement chain (DeployStatusBanner surfaces every non-green
// verdict; StaleGuard blocks the app on SHA mismatch) is unchanged
// — the well-lit Configure card was purely informational and
// duplicative. Detail is still reachable at /health +
// /api/deploy_status for anyone who needs it.


export default function ConfigureLayout() {
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

      {/* 2026-09-04 operator directive (Configure additions):
            * Configure tab flipped to full-only — hidden entirely
              on basic devices via FEATURE_MAP['configure']=full.
              App.jsx's tab filter + TAB_TO_FEATURE mapping do the
              hiding; this file never sees a basic render.
            * FULL Configure = cell wizard + collision-guard row,
              nothing else. Advanced disclosure (device rename),
              Camera calibration disclosure, SystemCheckSection
              (services health), and RecentRunsCard (motion
              recordings) are all retired from Configure per item
              10 acceptance. Their backends live on:
                  - device_label plumbing still writes via
                    POST /api/ui_context/{device_id}, called from
                    useStore.setTeachDeviceLabel (no UI now).
                  - cam0 calibration endpoints stay dormant on the
                    backend — re-expose when a camera is remounted.
                  - service restarts remain reachable via
                    systemctl + /api/systemcheck/service/restart.
                  - motion recordings live on /api/runs; no UI. */}

      {/* Cell commissioning — the page's centerpiece. Gated as
          `cell_commissioning` at the backend (see middleware); the
          UI is only reached on full because the whole tab hides
          on basic. */}
      <CellSetupSection />

      {/* Self-collision guard row — full section preserved (border,
          confirm dialog, red-when-OFF visuals, event-log wire).
          Always visible when OFF: the operator directive
          explicitly requires guards-off to always be reversible
          from the page. */}
      <SelfCollisionGuardSection />
    </div>
  )
}

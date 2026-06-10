import { useEffect, useState, useMemo, useCallback } from 'react'

// Quality Inspection tab — PART G of the inspection spec.
//
// The pipeline (inspection_pipeline ROS2 package) ships disabled until
// the Mech-Eye depth camera is wired in. This layout is fully navigable
// either way: every sub-tab renders empty states gracefully and the
// Configure sub-tab can be used in advance to set up tolerances and
// plans for when the camera arrives.

const SUB_TABS = [
  { id: 'overview',  label: 'Overview' },
  { id: 'history',   label: 'History' },
  { id: 'active',    label: 'Active' },
  { id: 'configure', label: 'Configure' },
  { id: 'analytics', label: 'Analytics' },
]

const PIPELINE_BANNER = (
  'Quality inspection requires the Mech-Eye NANO ULTRA camera. ' +
  'UI is ready for configuration — inspection execution will be ' +
  'available once the camera is connected.'
)

// ── Shared fetch helper ──────────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch(path, opts)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json') ? res.json() : res.text()
}

// ── Tokens (mirrors styles/tokens.css palette but used inline so this
//    component is portable across themes without surprises) ─────────
const T = {
  bg:         'var(--bg-panel, #fff)',
  bgAlt:      'var(--bg-alt, #f8fafc)',
  border:     'var(--border, #e5e7eb)',
  text:       'var(--text-primary, #111)',
  textMuted:  'var(--text-secondary, #6b7280)',
  accent:     'var(--accent, #1D6FD8)',
  green:      'var(--green, #16A34A)',
  yellow:     'var(--yellow, #D97706)',
  red:        'var(--red, #DC2626)',
  shadowSm:   'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.05))',
  radius:     6,
  radiusLg:   10,
}

const RESULT_COLOR = {
  pass:  T.green,
  warn:  T.yellow,
  fail:  T.red,
  error: T.red,
}

function ResultBadge({ result, size = 'md' }) {
  const r = (result || '').toLowerCase()
  const padding = size === 'lg' ? '8px 16px' : '3px 8px'
  const fontSize = size === 'lg' ? 14 : 11
  return (
    <span style={{
      display: 'inline-block', fontWeight: 700, padding,
      borderRadius: 4, color: '#fff', letterSpacing: '0.5px',
      fontSize, background: RESULT_COLOR[r] || T.textMuted,
    }}>
      {(result || 'unknown').toUpperCase()}
    </span>
  )
}

// ── Layout shell ────────────────────────────────────────────────────
export default function QualityInspectionLayout() {
  const [subTab, setSubTab] = useState('overview')
  const [storage, setStorage] = useState(null)

  // /ws/inspection lives for the lifetime of the tab so the Active
  // sub-tab can render a progress bar without re-opening the socket
  // every navigation.
  const [liveStatus, setLiveStatus] = useState(null)
  useEffect(() => {
    let ws
    try {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/inspection`
      ws = new WebSocket(url)
      ws.onmessage = (e) => {
        try { setLiveStatus(JSON.parse(e.data)) } catch (_) { /* swallow */ }
      }
    } catch (_) { /* dashboard offline — that's fine */ }
    return () => { if (ws) ws.close() }
  }, [])

  useEffect(() => {
    api('/api/inspections/storage').then(setStorage).catch(() => {})
  }, [])

  const startInspection = useCallback(async () => {
    try {
      await api('/api/inspections/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger_source: 'manual' }),
      })
      setSubTab('active')
    } catch (e) {
      alert('Failed to start inspection: ' + e.message)
    }
  }, [])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: T.bgAlt, color: T.text, overflow: 'hidden',
    }}>
      {/* Top toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '12px 16px', background: T.bg,
        borderBottom: `1px solid ${T.border}`, flexShrink: 0,
      }}>
        <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '0.5px' }}>
          QUALITY INSPECTION
        </div>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 4 }}>
          {SUB_TABS.map((st) => (
            <button key={st.id} onClick={() => setSubTab(st.id)}
              style={{
                padding: '6px 14px', fontSize: 13, fontWeight: 600,
                background: subTab === st.id ? T.accent : 'transparent',
                color: subTab === st.id ? '#fff' : T.text,
                border: 'none', borderRadius: 4, cursor: 'pointer',
              }}>{st.label}</button>
          ))}
        </div>
        <button onClick={startInspection} style={primaryBtn}>
          Start Manual Inspection
        </button>
      </div>

      {/* Pipeline-disabled banner (rollout strategy PART P) */}
      <div style={{
        background: '#fffbeb', borderBottom: `1px solid #f59e0b`,
        color: '#92400e', padding: '8px 16px', fontSize: 13,
        flexShrink: 0,
      }}>
        ⚠ {PIPELINE_BANNER}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {subTab === 'overview'  && <OverviewPane liveStatus={liveStatus} storage={storage} />}
        {subTab === 'history'   && <HistoryPane />}
        {subTab === 'active'    && <ActivePane liveStatus={liveStatus} />}
        {subTab === 'configure' && <ConfigurePane />}
        {subTab === 'analytics' && <AnalyticsPane />}
      </div>
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────
function OverviewPane({ liveStatus, storage }) {
  const [stats, setStats] = useState({})
  const [recent, setRecent] = useState({ items: [] })

  useEffect(() => {
    api('/api/inspections/stats?timeframe=24h').then(setStats).catch(() => {})
    api('/api/inspections?per_page=10&sort=-timestamp').then(setRecent).catch(() => {})
  }, [])

  const today = stats?.global || stats || {}
  const passRate = today?.pass_rate_24h
  const passRatePct = passRate != null ? (passRate * 100).toFixed(1) : '—'
  const passRateColor = passRate == null ? T.textMuted
    : passRate >= 0.95 ? T.green : passRate >= 0.9 ? T.yellow : T.red

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Top stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <Card title="TODAY">
          <BigMetric value={today.total_inspections_24h ?? today.total_inspections ?? 0}
                     label="Inspections" />
          <div style={{ marginTop: 8, color: passRateColor, fontSize: 22, fontWeight: 600 }}>
            {passRatePct}% pass
          </div>
          <div style={{ color: T.textMuted, fontSize: 12, marginTop: 4 }}>
            avg deviation {today.mean_deviation_24h_mm ?? '—'} mm
          </div>
        </Card>
        <Card title="ACTIVE INSPECTION">
          {liveStatus && liveStatus.status && liveStatus.status !== 'idle' ? (
            <>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{liveStatus.status}</div>
              <ProgressBar value={liveStatus.progress || 0} />
              <div style={{ color: T.textMuted, fontSize: 12, marginTop: 4 }}>
                ID {liveStatus.inspection_id || '—'}
              </div>
            </>
          ) : (
            <div style={{ color: T.textMuted, fontSize: 14 }}>No active inspection.</div>
          )}
        </Card>
        <Card title="ALERTS">
          <FailureList items={recent.items} />
        </Card>
      </div>

      {/* Per-part grid (placeholder when empty) */}
      <Card title="PER-PART PASS RATES (LAST 7 DAYS)">
        <PerPartGrid />
      </Card>

      {/* Recent inspections */}
      <Card title="RECENT INSPECTIONS">
        <RecentInspections items={recent.items} />
      </Card>

      <Card title="STORAGE">
        <StorageSummary storage={storage} />
      </Card>
    </div>
  )
}

function BigMetric({ value, label }) {
  return (
    <div>
      <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1 }}>{value}</div>
      <div style={{ color: T.textMuted, fontSize: 12, marginTop: 2 }}>{label}</div>
    </div>
  )
}

function ProgressBar({ value }) {
  return (
    <div style={{ marginTop: 8, height: 8, background: T.border, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${Math.max(0, Math.min(100, value))}%`,
        background: T.accent, transition: 'width 200ms',
      }}/>
    </div>
  )
}

function FailureList({ items }) {
  const failures = (items || []).filter((r) => r.result === 'fail').slice(0, 5)
  if (failures.length === 0) {
    return <div style={{ color: T.textMuted, fontSize: 13 }}>No recent failures.</div>
  }
  return (
    <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
      {failures.map((r) => (
        <div key={r.inspection_id} style={{ display: 'flex', gap: 8 }}>
          <ResultBadge result={r.result} />
          <span style={{ flex: 1 }}>{r.part_id}</span>
          <span style={{ color: T.textMuted }}>
            {new Date((r.timestamp || 0) * 1000).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
  )
}

function PerPartGrid() {
  return (
    <div style={{ color: T.textMuted, fontSize: 13, padding: '16px 0' }}>
      No per-part data yet. Run inspections to populate trends.
    </div>
  )
}

function RecentInspections({ items }) {
  if (!items || items.length === 0) {
    return <div style={{ color: T.textMuted, fontSize: 13, padding: '8px 0' }}>
      No inspections recorded yet.
    </div>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted }}>
          <th style={th}>Time</th>
          <th style={th}>Part</th>
          <th style={th}>Tier</th>
          <th style={th}>Result</th>
          <th style={th}>Max Dev</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {items.slice(0, 10).map((r) => (
          <tr key={r.inspection_id} style={{ borderBottom: `1px solid ${T.border}` }}>
            <td style={td}>{new Date((r.timestamp || 0) * 1000).toLocaleString()}</td>
            <td style={td}>{r.part_id}</td>
            <td style={td}>{r.tier}</td>
            <td style={td}><ResultBadge result={r.result} /></td>
            <td style={td}>{r.max_deviation != null ? r.max_deviation.toFixed(3) : '—'}</td>
            <td style={td}>
              <a href={`/api/inspections/${r.inspection_id}/report`} target="_blank" rel="noopener noreferrer"
                 style={linkStyle}>Report</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StorageSummary({ storage }) {
  if (!storage) {
    return <div style={{ color: T.textMuted, fontSize: 13 }}>Storage info loading…</div>
  }
  const mb = (storage.bytes_used / (1024 * 1024)).toFixed(1)
  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'center', fontSize: 13 }}>
      <div><strong>{storage.records}</strong> records</div>
      <div><strong>{mb}</strong> MB</div>
      <div>retention: <strong>{storage.retention?.mode ?? '90d'}</strong></div>
    </div>
  )
}

// ─── History ─────────────────────────────────────────────────────────
function HistoryPane() {
  const [filters, setFilters] = useState({
    timeframe: '7d', part_id: '', result: '', tier: '',
  })
  const [data, setData] = useState({ items: [], total: 0, page: 1, per_page: 25 })
  const [detailsId, setDetailsId] = useState(null)

  useEffect(() => {
    const since = ({
      '24h': Date.now() / 1000 - 24 * 3600,
      '7d':  Date.now() / 1000 - 7 * 24 * 3600,
      '30d': Date.now() / 1000 - 30 * 24 * 3600,
      '90d': Date.now() / 1000 - 90 * 24 * 3600,
    })[filters.timeframe]
    const params = new URLSearchParams()
    if (since) params.set('start_date', since)
    if (filters.part_id) params.set('part_id', filters.part_id)
    if (filters.result)  params.set('result', filters.result)
    if (filters.tier !== '') params.set('tier', filters.tier)
    params.set('page', data.page)
    params.set('per_page', data.per_page)
    api(`/api/inspections?${params}`).then(setData).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, data.page])

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FilterBar filters={filters} onChange={setFilters} />
      <Card>
        <ResultsTable items={data.items} onView={setDetailsId} />
        <Pagination total={data.total} page={data.page} per={data.per_page}
                    onPage={(p) => setData((d) => ({ ...d, page: p }))}/>
      </Card>
      {detailsId && (
        <DetailsPanel inspectionId={detailsId} onClose={() => setDetailsId(null)} />
      )}
    </div>
  )
}

function FilterBar({ filters, onChange }) {
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'center',
      background: T.bg, border: `1px solid ${T.border}`,
      borderRadius: T.radius, padding: 8, flexWrap: 'wrap',
    }}>
      <input placeholder="Search part or inspection ID…"
             value={filters.part_id}
             onChange={(e) => onChange({ ...filters, part_id: e.target.value })}
             style={inputStyle}/>
      <select value={filters.timeframe}
              onChange={(e) => onChange({ ...filters, timeframe: e.target.value })}
              style={inputStyle}>
        <option value="24h">Last 24h</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option>
      </select>
      <select value={filters.result}
              onChange={(e) => onChange({ ...filters, result: e.target.value })}
              style={inputStyle}>
        <option value="">All results</option>
        <option value="pass">Pass</option>
        <option value="warn">Warn</option>
        <option value="fail">Fail</option>
      </select>
      <select value={filters.tier}
              onChange={(e) => onChange({ ...filters, tier: e.target.value })}
              style={inputStyle}>
        <option value="">All tiers</option>
        <option value="1">Tier 1</option>
        <option value="2">Tier 2</option>
        <option value="3">Tier 3</option>
      </select>
      <div style={{ flex: 1 }}/>
      <button style={btnStyle}>Export CSV</button>
      <button style={btnStyle}>Export PDF</button>
    </div>
  )
}

function ResultsTable({ items, onView }) {
  if (!items || items.length === 0) {
    return <div style={{ color: T.textMuted, fontSize: 13, padding: 16 }}>
      No inspections match the current filters.
    </div>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted }}>
          <th style={th}>Timestamp</th><th style={th}>Part</th>
          <th style={th}>Result</th><th style={th}>Max Dev</th>
          <th style={th}>Mean Dev</th><th style={th}>Tier</th>
          <th style={th}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.inspection_id} style={{ borderBottom: `1px solid ${T.border}` }}>
            <td style={td}>{new Date((r.timestamp || 0) * 1000).toLocaleString()}</td>
            <td style={td}>{r.part_id}</td>
            <td style={td}><ResultBadge result={r.result} /></td>
            <td style={td}>{r.max_deviation != null ? r.max_deviation.toFixed(3) : '—'}</td>
            <td style={td}>{r.mean_deviation != null ? r.mean_deviation.toFixed(3) : '—'}</td>
            <td style={td}>{r.tier}</td>
            <td style={td}>
              <button onClick={() => onView(r.inspection_id)} style={btnStyle}>View</button>
              {' '}
              <a href={`/api/inspections/${r.inspection_id}/report`} target="_blank" rel="noopener noreferrer"
                 style={linkStyle}>Report</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Pagination({ total, page, per, onPage }) {
  const pages = Math.max(1, Math.ceil(total / per))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12 }}>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} style={btnStyle}>Prev</button>
      <span>Page {page} of {pages} ({total} total)</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)} style={btnStyle}>Next</button>
    </div>
  )
}

// ─── Active ──────────────────────────────────────────────────────────
function ActivePane({ liveStatus }) {
  if (!liveStatus || (liveStatus.status === 'idle' || !liveStatus.status)) {
    return (
      <Card title="ACTIVE INSPECTION">
        <div style={{ color: T.textMuted, fontSize: 14, padding: 24, textAlign: 'center' }}>
          No active inspection. Start one from the toolbar above.
        </div>
      </Card>
    )
  }
  return (
    <Card title="ACTIVE INSPECTION">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%',
          background: T.green, animation: 'pulse 1.5s infinite' }}/>
        <span style={{ fontWeight: 600, fontSize: 16 }}>{liveStatus.status}</span>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: T.textMuted }}>
        ID: {liveStatus.inspection_id || '—'}
      </div>
      <ProgressBar value={liveStatus.progress || 0} />
      <div style={{ marginTop: 8, fontSize: 12, color: T.textMuted }}>
        {liveStatus.progress || 0}%
      </div>
      <button style={{ ...btnStyle, marginTop: 16, background: T.red, color: '#fff' }}
              onClick={() => api('/api/inspections/' + liveStatus.inspection_id + '/cancel',
                                 { method: 'POST' })}>
        Cancel
      </button>
    </Card>
  )
}

// ─── Configure ───────────────────────────────────────────────────────
const CONFIGURE_SECTIONS = [
  { id: 'tolerances',  label: 'Tolerance Rules' },
  { id: 'plans',       label: 'Inspection Plans' },
  { id: 'references',  label: 'References' },
  { id: 'templates',   label: 'Report Templates' },
  { id: 'inspectors',  label: 'Feature Inspectors' },
  { id: 'retention',   label: 'Retention Policy' },
]

function ConfigurePane() {
  const [section, setSection] = useState('tolerances')
  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{
        width: 200, flexShrink: 0,
        background: T.bg, border: `1px solid ${T.border}`,
        borderRadius: T.radius, padding: 8, height: 'fit-content',
      }}>
        {CONFIGURE_SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 12px', fontSize: 13, fontWeight: 600,
              background: section === s.id ? T.accent : 'transparent',
              color: section === s.id ? '#fff' : T.text,
              border: 'none', borderRadius: 4, cursor: 'pointer',
              marginBottom: 2,
            }}>{s.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {section === 'tolerances' && <TolerancesEditor />}
        {section === 'plans'      && <PlansEditor />}
        {section === 'references' && <ReferencesEditor />}
        {section === 'templates'  && <TemplatesEditor />}
        {section === 'inspectors' && <InspectorsEditor />}
        {section === 'retention'  && <RetentionEditor />}
      </div>
    </div>
  )
}

function TolerancesEditor() {
  const [data, setData] = useState({})
  const [partId, setPartId] = useState('')
  const [draft, setDraft] = useState({ name: '', nominal: '', tol_warn: '', tol_fail: '' })

  const reload = useCallback(() => {
    api('/api/inspections/tolerances').then(setData).catch(() => {})
  }, [])
  useEffect(reload, [reload])

  const partIds = Object.keys(data)

  const save = async () => {
    if (!partId || !draft.name) return
    await api('/api/inspections/tolerances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        part_id: partId,
        name: draft.name,
        nominal: parseFloat(draft.nominal),
        tol_warn: parseFloat(draft.tol_warn),
        tol_fail: parseFloat(draft.tol_fail),
      }),
    })
    setDraft({ name: '', nominal: '', tol_warn: '', tol_fail: '' })
    reload()
  }

  const rules = partId ? Object.values(data[partId] || {}) : []

  return (
    <Card title="TOLERANCE RULES">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: T.textMuted }}>Part:</label>
        <select value={partId} onChange={(e) => setPartId(e.target.value)} style={inputStyle}>
          <option value="">— select part —</option>
          {partIds.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input placeholder="New part_id…" value={partId}
               onChange={(e) => setPartId(e.target.value)} style={inputStyle}/>
      </div>
      {partId ? (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted }}>
                <th style={th}>Name</th><th style={th}>Nominal</th>
                <th style={th}>Warn ±</th><th style={th}>Fail ±</th>
                <th style={th}/>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.rule_id} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={td}>{r.name}</td>
                  <td style={td}>{r.nominal}</td>
                  <td style={td}>{r.tol_warn}</td>
                  <td style={td}>{r.tol_fail}</td>
                  <td style={td}>
                    <button onClick={() => api(`/api/inspections/tolerances/${r.rule_id}`,
                                              { method: 'DELETE' }).then(reload)}
                            style={btnStyle}>Delete</button>
                  </td>
                </tr>
              ))}
              <tr>
                <td style={td}><input value={draft.name} onChange={(e) => setDraft({...draft, name: e.target.value})}
                                       placeholder="e.g. length_mm" style={inputStyle}/></td>
                <td style={td}><input value={draft.nominal} onChange={(e) => setDraft({...draft, nominal: e.target.value})}
                                       style={inputStyle}/></td>
                <td style={td}><input value={draft.tol_warn} onChange={(e) => setDraft({...draft, tol_warn: e.target.value})}
                                       style={inputStyle}/></td>
                <td style={td}><input value={draft.tol_fail} onChange={(e) => setDraft({...draft, tol_fail: e.target.value})}
                                       style={inputStyle}/></td>
                <td style={td}><button onClick={save} style={primaryBtn}>Add</button></td>
              </tr>
            </tbody>
          </table>
        </>
      ) : (
        <div style={{ color: T.textMuted, fontSize: 13 }}>
          Pick or type a part id above to manage its tolerance rules.
        </div>
      )}
    </Card>
  )
}

function PlansEditor() {
  const [plans, setPlans] = useState({})
  const [draft, setDraft] = useState({ plan_id: '', name: '', tier: 1, checks: [] })

  const reload = useCallback(() => {
    api('/api/inspections/plans').then(setPlans).catch(() => {})
  }, [])
  useEffect(reload, [reload])

  const save = async () => {
    if (!draft.name) return
    await api('/api/inspections/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    })
    setDraft({ plan_id: '', name: '', tier: 1, checks: [] })
    reload()
  }

  return (
    <Card title="INSPECTION PLANS">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted }}>
            <th style={th}>ID</th><th style={th}>Name</th>
            <th style={th}>Tier</th><th style={th}>Checks</th><th style={th}/>
          </tr>
        </thead>
        <tbody>
          {Object.values(plans).map((p) => (
            <tr key={p.plan_id} style={{ borderBottom: `1px solid ${T.border}` }}>
              <td style={td}>{p.plan_id}</td>
              <td style={td}>{p.name}</td>
              <td style={td}>{p.tier}</td>
              <td style={td}>{(p.checks || []).length}</td>
              <td style={td}>
                <button onClick={() => api(`/api/inspections/plans/${p.plan_id}`,
                                           { method: 'DELETE' }).then(reload)}
                        style={btnStyle}>Delete</button>
              </td>
            </tr>
          ))}
          <tr>
            <td style={td}>—</td>
            <td style={td}><input value={draft.name}
              onChange={(e) => setDraft({...draft, name: e.target.value})}
              placeholder="Plan name" style={inputStyle}/></td>
            <td style={td}>
              <select value={draft.tier}
                onChange={(e) => setDraft({...draft, tier: parseInt(e.target.value, 10)})}
                style={inputStyle}>
                <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
              </select>
            </td>
            <td style={td}>0</td>
            <td style={td}><button onClick={save} style={primaryBtn}>Add</button></td>
          </tr>
        </tbody>
      </table>
    </Card>
  )
}

function ReferencesEditor() {
  const [partId, setPartId] = useState('')
  const [refs, setRefs] = useState([])

  useEffect(() => {
    if (!partId) { setRefs([]); return }
    api(`/api/inspections/references/${partId}`).then(setRefs).catch(() => setRefs([]))
  }, [partId])

  return (
    <Card title="REFERENCES">
      <div style={{ marginBottom: 12 }}>
        <input placeholder="Part ID…" value={partId}
               onChange={(e) => setPartId(e.target.value)} style={inputStyle}/>
      </div>
      {!partId ? (
        <div style={{ color: T.textMuted, fontSize: 13 }}>
          Enter a part ID to manage its reference clouds.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted }}>
              <th style={th}>Type</th><th style={th}>Present</th>
              <th style={th}>Version</th><th style={th}>Points</th><th style={th}/>
            </tr>
          </thead>
          <tbody>
            {refs.map((r) => (
              <tr key={r.type} style={{ borderBottom: `1px solid ${T.border}` }}>
                <td style={td}>{r.type}</td>
                <td style={td}>{r.present ? '✓' : '—'}</td>
                <td style={td}>{r.version}</td>
                <td style={td}>{r.n_points || 0}</td>
                <td style={td}>
                  {r.type === 'step' && (
                    <button onClick={() => api(`/api/inspections/references/${partId}/build_from_step`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ step_path: prompt('Path to STEP file:') }),
                    })} style={btnStyle}>Build from STEP</button>
                  )}
                  {r.type === 'golden' && (
                    <button onClick={() => api(`/api/inspections/references/${partId}/capture_golden`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({}),
                    })} style={btnStyle}>Capture Golden</button>
                  )}
                  {r.type === 'statistical' && (
                    <button onClick={() => api(`/api/inspections/references/${partId}/build_statistical`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ min_samples: 30 }),
                    })} style={btnStyle}>Build Statistical</button>
                  )}
                  {' '}
                  {r.present && (
                    <button onClick={() => api(`/api/inspections/references/${partId}/set_active`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: r.type }),
                    })} style={btnStyle}>Set Active</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function TemplatesEditor() {
  const [templates, setTemplates] = useState({})
  useEffect(() => {
    api('/api/inspections/templates').then(setTemplates).catch(() => {})
  }, [])
  return (
    <Card title="REPORT TEMPLATES">
      <div style={{ color: T.textMuted, fontSize: 13, marginBottom: 12 }}>
        Configure company branding, page selection and footer text per
        template. Templates are referenced by name from inspection plans.
      </div>
      <pre style={{ background: T.bgAlt, padding: 12, borderRadius: 4,
                    fontSize: 11, maxHeight: 400, overflow: 'auto' }}>
        {JSON.stringify(templates, null, 2)}
      </pre>
    </Card>
  )
}

function InspectorsEditor() {
  return (
    <Card title="FEATURE INSPECTORS">
      <div style={{ color: T.textMuted, fontSize: 13 }}>
        Tier 3 inspectors are registered from the inspection_pipeline
        package. Add custom inspectors by dropping a Python plugin
        in /opt/cobot/inspections/config/plugins/ and editing
        feature_inspectors.json.
      </div>
    </Card>
  )
}

function RetentionEditor() {
  const [storage, setStorage] = useState(null)
  useEffect(() => {
    api('/api/inspections/storage').then(setStorage).catch(() => {})
  }, [])
  if (!storage) return <Card title="RETENTION POLICY">Loading…</Card>
  return (
    <Card title="RETENTION POLICY">
      <StorageSummary storage={storage} />
      <div style={{ marginTop: 16 }}>
        <button onClick={() => {
          if (!confirm('Run cleanup with current retention policy?')) return
          api('/api/inspections/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dry_run: false }),
          }).then((r) => alert(`Deleted ${r.deleted} records, freed ${r.freed_bytes} bytes.`))
        }} style={primaryBtn}>Run Cleanup Now</button>
      </div>
    </Card>
  )
}

// ─── Analytics ───────────────────────────────────────────────────────
function AnalyticsPane() {
  const [timeframe, setTimeframe] = useState('30d')
  const [pass, setPass] = useState(null)
  const [hist, setHist] = useState(null)

  useEffect(() => {
    api(`/api/inspections/stats/timeseries?metric=mean_deviation&timeframe=${timeframe}&granularity=day`)
      .then(setPass).catch(() => {})
    api(`/api/inspections/stats/distribution?metric=max_deviation&timeframe=${timeframe}&bins=30`)
      .then(setHist).catch(() => {})
  }, [timeframe])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: T.textMuted }}>Timeframe:</label>
        <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} style={inputStyle}>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
        </select>
      </div>
      <Card title="MEAN DEVIATION OVER TIME">
        <Sparkline data={pass?.series || []} valueKey="mean" />
      </Card>
      <Card title="MAX-DEVIATION DISTRIBUTION">
        <Histogram bins={hist?.bins} counts={hist?.counts} />
      </Card>
      <Card title="PROCESS CAPABILITY">
        <div style={{ color: T.textMuted, fontSize: 13 }}>
          Cp / Cpk indicators will appear when a statistical reference
          has been built and the part has &gt;= 30 passing inspections.
        </div>
      </Card>
    </div>
  )
}

function Sparkline({ data, valueKey = 'mean' }) {
  if (!data || data.length === 0) {
    return <div style={{ color: T.textMuted, fontSize: 13, padding: 24, textAlign: 'center' }}>
      No data in this timeframe.
    </div>
  }
  const w = 600, h = 120, pad = 8
  const xs = data.map((d) => d.t)
  const ys = data.map((d) => d[valueKey] ?? 0)
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  const yMin = Math.min(...ys), yMax = Math.max(...ys) || 1
  const sx = (x) => pad + (w - 2*pad) * ((x - xMin) / Math.max(1e-9, xMax - xMin))
  const sy = (y) => h - pad - (h - 2*pad) * ((y - yMin) / Math.max(1e-9, yMax - yMin))
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${sx(d.t)},${sy(d[valueKey])}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 120 }}>
      <path d={path} stroke={T.accent} strokeWidth={2} fill="none"/>
    </svg>
  )
}

function Histogram({ bins, counts }) {
  if (!bins || !counts || counts.length === 0) {
    return <div style={{ color: T.textMuted, fontSize: 13, padding: 24, textAlign: 'center' }}>
      No data in this timeframe.
    </div>
  }
  const w = 600, h = 120, pad = 8
  const maxC = Math.max(...counts) || 1
  const bw = (w - 2*pad) / counts.length
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 120 }}>
      {counts.map((c, i) => (
        <rect key={i}
              x={pad + i * bw}
              y={h - pad - (h - 2*pad) * (c / maxC)}
              width={bw - 1}
              height={(h - 2*pad) * (c / maxC)}
              fill={T.accent} />
      ))}
    </svg>
  )
}

// ─── Details panel ───────────────────────────────────────────────────
function DetailsPanel({ inspectionId, onClose }) {
  const [record, setRecord] = useState(null)
  useEffect(() => {
    api(`/api/inspections/${inspectionId}`).then(setRecord).catch(() => setRecord({ error: 'not found' }))
  }, [inspectionId])

  return (
    <div style={{
      position: 'fixed', top: 60, right: 0, bottom: 36,
      width: 'min(900px, 70vw)',
      background: T.bg, borderLeft: `1px solid ${T.border}`,
      boxShadow: '-4px 0 12px rgba(0,0,0,0.05)',
      display: 'flex', flexDirection: 'column', zIndex: 50,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 16px', borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ fontWeight: 700, flex: 1 }}>
          {record?.part_id || '—'} — {inspectionId}
        </div>
        <button onClick={onClose} style={btnStyle}>Close</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {!record && <div style={{ color: T.textMuted }}>Loading…</div>}
        {record?.error && <div style={{ color: T.red }}>{record.error}</div>}
        {record && !record.error && (
          <>
            <ResultBadge result={record.overall_result} size="lg"/>
            <div style={{ marginTop: 16, fontSize: 13 }}>
              <div><strong>Tier:</strong> {record.tier}</div>
              <div><strong>Plan:</strong> {record.plan_id}</div>
              <div><strong>Reference:</strong> {record.reference_type} ({(record.reference_hash || '').slice(0, 12)})</div>
            </div>

            <h3 style={{ marginTop: 24 }}>Measurements</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted }}>
                  <th style={th}>Name</th><th style={th}>Nominal</th><th style={th}>Measured</th>
                  <th style={th}>Deviation</th><th style={th}>Result</th>
                </tr>
              </thead>
              <tbody>
                {(record.measurements || []).map((m, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={td}>{m.name}</td>
                    <td style={td}>{m.nominal ?? '—'}</td>
                    <td style={td}>{typeof m.measured === 'number' ? m.measured.toFixed(3) : '—'}</td>
                    <td style={td}>{m.deviation != null ? m.deviation.toFixed(3) : '—'}</td>
                    <td style={td}><ResultBadge result={m.result}/></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 style={{ marginTop: 24 }}>Defects</h3>
            {(record.defects || []).length === 0
              ? <div style={{ color: T.textMuted, fontSize: 13 }}>No defects.</div>
              : (
                <ul style={{ fontSize: 13, paddingLeft: 16 }}>
                  {(record.defects || []).map((d, i) => (
                    <li key={i}>
                      {d.defect_type} at ({d.center_xyz?.map((v) => v.toFixed(1)).join(', ')})
                      &mdash; {d.deviation_mm?.toFixed(2)} mm, {d.severity}
                    </li>
                  ))}
                </ul>
              )}

            <div style={{ marginTop: 24, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a href={`/api/inspections/${inspectionId}/report`} target="_blank" rel="noopener noreferrer"
                 style={primaryBtn}>Download PDF</a>
              <a href={`/api/inspections/${inspectionId}/cloud`} download
                 style={btnStyle}>Export Cloud</a>
              <button onClick={() => api(`/api/inspections/${inspectionId}/re_run`, { method: 'POST' })
                  .then(() => alert('Re-run queued.'))}
                style={btnStyle}>Re-run</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Reusable bits ───────────────────────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={{
      background: T.bg, border: `1px solid ${T.border}`,
      borderRadius: T.radiusLg, boxShadow: T.shadowSm,
      padding: 16,
    }}>
      {title && (
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
          color: T.textMuted, marginBottom: 12,
        }}>{title}</div>
      )}
      {children}
    </div>
  )
}

const th = { textAlign: 'left', padding: '6px 8px', fontWeight: 600 }
const td = { padding: '6px 8px' }
const inputStyle = {
  fontSize: 13, padding: '4px 8px',
  border: `1px solid ${T.border}`, borderRadius: 4,
  background: T.bg, color: T.text,
}
const btnStyle = {
  fontSize: 12, fontWeight: 600, padding: '4px 10px',
  background: T.bg, color: T.text, border: `1px solid ${T.border}`,
  borderRadius: 4, cursor: 'pointer',
}
const primaryBtn = {
  ...btnStyle, background: T.accent, color: '#fff',
  border: `1px solid ${T.accent}`,
}
const linkStyle = { color: T.accent, textDecoration: 'none', fontSize: 12 }

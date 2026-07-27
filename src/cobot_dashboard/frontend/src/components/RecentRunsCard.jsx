import { useEffect, useState } from 'react'

// RecentRunsCard — always-on joint-recorder browser + excursion viewer.
//
// Fetches /api/runs newest-first, renders a compact list with a
// Download link (raw .jsonl) and an Excursion button that toggles the
// per-step per-joint table inline. Flagged cells (over-swing >=
// analysis threshold) get the amber/red palette the rest of the app
// uses for caution / alarm.
//
// This is the product surface for the always-on recorder — the same
// data that used to require pre-arming the one-shot /api/estun/
// joint_log endpoint is now one click away for every past run. J4
// investigation becomes: run the program, come here, click
// Excursions. No dashboard commands, no timing.

function formatDuration(s) {
  if (s == null) return '—'
  if (s < 60)    return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60); const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}

function formatWhen(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const now = new Date()
  const secs = Math.round((now - d) / 1000)
  if (secs < 45)      return 'just now'
  if (secs < 90)      return '1 min ago'
  if (secs < 3600)    return `${Math.round(secs / 60)} min ago`
  if (secs < 172800)  return `${Math.round(secs / 3600)} h ago`
  return d.toLocaleString()
}

export default function RecentRunsCard() {
  const [runs, setRuns]       = useState([])
  const [recorder, setRec]    = useState(null)
  const [expanded, setExpand] = useState(null)   // run_id currently showing table
  const [tables, setTables]   = useState({})     // run_id -> analysis dict (cached)
  const [loading, setLoading] = useState({})     // run_id -> bool
  const [errors, setErrors]   = useState({})     // run_id -> str

  // Poll /api/runs at 4 s. Real-time enough for the "just finished a
  // run" workflow; light on the network.
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/runs')
        if (!r.ok) return
        const d = await r.json()
        if (!alive) return
        if (d.ok) {
          setRuns(Array.isArray(d.runs) ? d.runs : [])
          setRec(d.recorder || null)
        }
      } catch { /* silent — next tick retries */ }
    }
    load()
    const iv = setInterval(load, 4000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  async function showExcursions(runId) {
    if (expanded === runId) { setExpand(null); return }
    setExpand(runId)
    if (tables[runId]) return   // cached
    setLoading((prev) => ({ ...prev, [runId]: true }))
    setErrors((prev) => ({ ...prev, [runId]: null }))
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/excursions`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) {
        setErrors((prev) => ({ ...prev, [runId]: d.error || `HTTP ${r.status}` }))
        return
      }
      setTables((prev) => ({ ...prev, [runId]: d.analysis }))
    } catch (e) {
      setErrors((prev) => ({ ...prev, [runId]: e?.message || String(e) }))
    } finally {
      setLoading((prev) => ({ ...prev, [runId]: false }))
    }
  }

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: 16, marginTop: 16,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
          Recent runs
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Motion history from every program execution — download raw
          samples or view the per-step per-joint excursion table.
        </div>
      </div>
      {recorder && (
        <div style={{
          fontSize: 11, color: '#9ca3af', marginBottom: 8,
          fontFamily: 'var(--font-mono, monospace)',
        }}>
          recorder: {recorder.samples_total?.toLocaleString?.() || 0} samples ·
          {' '}{recorder.disk_bytes != null
                ? (recorder.disk_bytes / 1e6).toFixed(1) + ' MB on disk'
                : '?'} ·
          {' '}{recorder.rate_hz} Hz ·
          {' '}cap {(recorder.retention_bytes / 1e9).toFixed(1)} GB /
          {' '}{Math.round((recorder.retention_age_s || 0) / 86400)} d
        </div>
      )}
      {runs.length === 0 ? (
        <div style={{
          padding: '18px 12px', textAlign: 'center',
          color: '#9ca3af', fontSize: 13,
        }}>
          No runs recorded yet. Run any program — this list appears
          within about a second of the program stopping.
        </div>
      ) : (
        <div>
          {runs.slice(0, 20).map((r) => {
            const isOpen = expanded === r.run_id
            const analysis = tables[r.run_id]
            const isLoading = loading[r.run_id]
            const err = errors[r.run_id]
            const worstFlagged = analysis?.worst && analysis?.rows?.some(
              (row) => row.joints?.some((j) => j.flagged))
            return (
              <div key={r.run_id} style={{
                borderTop: '1px solid #f3f4f6',
                paddingTop: 8, paddingBottom: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                      {r.program_name || r.program_id || 'unknown program'}
                      {worstFlagged && (
                        <span style={{
                          marginLeft: 8, fontSize: 10, fontWeight: 700,
                          background: '#fef3c7', color: '#92400e',
                          border: '1px solid #fde68a',
                          padding: '1px 6px', borderRadius: 4,
                        }}>⚠ excursion flagged</span>
                      )}
                    </div>
                    <div style={{
                      fontSize: 11, color: '#6b7280',
                      fontFamily: 'var(--font-mono, monospace)',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatWhen(r.t_start)} · {formatDuration(r.duration_s)} ·
                      {' '}{(r.segments || []).length} segment{(r.segments || []).length !== 1 ? 's' : ''} ·
                      {' '}<span style={{ opacity: 0.7 }}>{r.run_id}</span>
                    </div>
                  </div>
                  <a
                    href={`/api/runs/${encodeURIComponent(r.run_id)}/joints?format=jsonl`}
                    download={`${r.run_id}.jsonl`}
                    style={{
                      fontSize: 12, fontWeight: 600, padding: '5px 10px',
                      background: '#f3f4f6', color: '#374151',
                      border: '1px solid #e5e7eb', borderRadius: 5,
                      textDecoration: 'none',
                    }}
                  >Download</a>
                  <button
                    onClick={() => showExcursions(r.run_id)}
                    style={{
                      fontSize: 12, fontWeight: 600, padding: '5px 10px',
                      background: isOpen ? '#dbeafe' : '#eff6ff',
                      color: isOpen ? '#1e3a8a' : '#1d4ed8',
                      border: '1px solid #bfdbfe', borderRadius: 5,
                      cursor: 'pointer',
                    }}
                  >{isOpen ? 'Hide' : (isLoading ? 'Loading…' : 'Excursions')}</button>
                </div>
                {isOpen && err && (
                  <div style={{
                    marginTop: 8, padding: 8,
                    background: '#fef2f2', color: '#991b1b',
                    border: '1px solid #fecaca', borderRadius: 6,
                    fontSize: 12,
                  }}>{err}</div>
                )}
                {isOpen && analysis && (
                  <ExcursionTable analysis={analysis} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Per-step per-joint table. Cells: start → end / min|max / swing.
// Cell background palette:
//   - swing >= threshold                       amber (fef3c7)
//   - swing >= threshold AND joint ∈ {4,5,6}   red (fee2e2)  — wrist flip class
function ExcursionTable({ analysis }) {
  const rows = analysis?.rows || []
  const threshold = analysis?.threshold_deg ?? 10
  if (!rows.length) {
    return (
      <div style={{
        marginTop: 8, padding: 10, fontSize: 12, color: '#6b7280',
        background: '#fafafa', borderRadius: 6,
      }}>No sample data for this run.</div>
    )
  }
  const cellStyle = (j) => {
    if (!j.flagged) return {}
    // J4/J5/J6 flip = wrist re-solve, elevate to red.
    if (j.j >= 4)   return { background: '#fee2e2', color: '#991b1b' }
    return { background: '#fef3c7', color: '#92400e' }
  }
  return (
    <div style={{
      marginTop: 8, overflowX: 'auto',
      background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 6,
      padding: 10,
    }}>
      <table style={{
        borderCollapse: 'collapse', width: '100%',
        fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
      }}>
        <thead>
          <tr style={{ color: '#6b7280', textAlign: 'left' }}>
            <th style={{ padding: 4 }}>step</th>
            <th style={{ padding: 4 }}>line</th>
            <th style={{ padding: 4 }}>n</th>
            {[1,2,3,4,5,6].map((j) => (
              <th key={j} style={{ padding: 4 }}>J{j} start→end min|max <b>swing</b></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
              <td style={{ padding: 4 }}>{String(row.step_key)}</td>
              <td style={{ padding: 4, color: '#6b7280' }}>
                {row.program_line ?? '—'}
              </td>
              <td style={{ padding: 4, color: '#6b7280' }}>{row.samples}</td>
              {row.joints.map((j) => (
                <td key={j.j} style={{ padding: 4, ...cellStyle(j) }}>
                  {j.start.toFixed(1)}→{j.end.toFixed(1)}
                  {' · '}
                  {j.min.toFixed(1)}|{j.max.toFixed(1)}
                  {' · '}
                  <b>{j.swing.toFixed(1)}°</b>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 6, fontSize: 10, color: '#9ca3af' }}>
        threshold: {threshold}° &middot; amber = swing over threshold
        &middot; red = wrist-axis swing (J4/J5/J6) over threshold
      </div>
    </div>
  )
}

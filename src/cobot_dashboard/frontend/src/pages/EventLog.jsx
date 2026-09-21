// Event Log page — unified forensic view (2026-08-05).
//
// One table, reverse-chronological, backed by
// /api/event_log/day/{YYYYMMDD}. Filters: severity, source, and a
// free-text search over code + operator message + technical detail.
// Live-updating via a 2 s poll (state broadcast intentionally does
// NOT carry event records — the log can grow to thousands per day
// and would bloat every state frame).
//
// Downloads:
//   Today JSONL / CSV  — the day's raw and human-readable files
//   Last 7 days .zip   — bundle for a support ticket
//
// Fork registry: no separate log surface exists — this is IT. Any
// component that wants "show me the errors" reads /api/event_log/*.

import { useCallback, useEffect, useMemo, useState } from 'react'


function _yyyymmdd(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${dd}`
}

function _fmtTime(iso) {
  // Prefer ts_local when present; fall back to ts_utc. Trim to
  // seconds — the operator rarely cares about ms precision.
  if (!iso) return ''
  const s = String(iso)
  // Strip milliseconds + trailing timezone offset (keep tz sign
  // for the operator's mental model, though — a mixed-device fleet
  // sees local times per device).
  return s.replace(/\.\d{3}/, '')
}

const SEVERITY_STYLES = {
  error:   { bg: '#FEE2E2', bd: '#DC2626', fg: '#7F1D1D' },
  warning: { bg: '#FEF3C7', bd: '#D97706', fg: '#78350F' },
  info:    { bg: '#DBEAFE', bd: '#2563EB', fg: '#1E40AF' },
}


export default function EventLog() {
  const today = _yyyymmdd(new Date())
  const [day, setDay] = useState(today)
  const [records, setRecords] = useState([])
  const [availableDays, setAvailableDays] = useState([])
  const [severity, setSeverity] = useState('all')
  const [source, setSource]     = useState('all')
  const [query, setQuery]       = useState('')
  const [expanded, setExpanded] = useState(null)
  const [live, setLive]         = useState(true)
  const [loading, setLoading]   = useState(false)

  const fetchDays = useCallback(async () => {
    try {
      const res = await fetch('/api/event_log/list')
      const body = await res.json().catch(() => ({}))
      setAvailableDays(body?.days || [])
    } catch (_) { /* nop */ }
  }, [])

  const fetchDay = useCallback(async (d) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/event_log/day/${d}?limit=5000`)
      const body = await res.json().catch(() => ({}))
      const rs = Array.isArray(body?.records) ? body.records : []
      // Reverse chronological — newest first.
      setRecords([...rs].reverse())
    } catch (_) {
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDays() }, [fetchDays])
  useEffect(() => { fetchDay(day) }, [day, fetchDay])
  useEffect(() => {
    if (!live) return
    if (day !== _yyyymmdd(new Date())) return   // live only makes sense for today
    const t = setInterval(() => fetchDay(day), 2000)
    return () => clearInterval(t)
  }, [live, day, fetchDay])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter((r) => {
      if (severity !== 'all' && r.severity !== severity) return false
      if (source   !== 'all' && r.source   !== source)   return false
      if (q) {
        const hay = ((r.code || '') + '\n'
                     + (r.operator_message || '') + '\n'
                     + (r.technical_detail || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [records, severity, source, query])

  const sources = useMemo(() => {
    const s = new Set(records.map((r) => r.source).filter(Boolean))
    return ['all', ...Array.from(s).sort()]
  }, [records])

  return (
    <div style={{
      padding: 16, minHeight: 0, flex: 1,
      display: 'flex', flexDirection: 'column', gap: 12,
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Event Log</h2>
        <div style={{ flex: 1 }} />
        <a
          data-testid="event-log-download-jsonl"
          href={`/api/event_log/download/${day}.jsonl`}
          download
          style={_dlBtnStyle}>
          Download JSONL
        </a>
        <a
          data-testid="event-log-download-csv"
          href={`/api/event_log/download/${day}.csv`}
          download
          style={_dlBtnStyle}>
          Download CSV
        </a>
        <a
          data-testid="event-log-download-last7"
          href={`/api/event_log/download/last7.zip`}
          download
          style={_dlBtnStyle}>
          Last 7 days (zip)
        </a>
      </div>

      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        fontSize: 13,
      }}>
        <label>Date:{' '}
          <select
            data-testid="event-log-date-select"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            style={_inputStyle}>
            {(availableDays.length ? availableDays : [today]).map((d) => (
              <option key={d} value={d}>
                {d.slice(0, 4)}-{d.slice(4, 6)}-{d.slice(6, 8)}
                {d === today ? ' (today)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>Severity:{' '}
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}
                  style={_inputStyle}>
            <option value="all">All</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>Source:{' '}
          <select value={source} onChange={(e) => setSource(e.target.value)}
                  style={_inputStyle}>
            {sources.map((s) => (
              <option key={s} value={s}>{s === 'all' ? 'All' : s}</option>
            ))}
          </select>
        </label>
        <input
          type="search"
          placeholder="Search code / message / detail"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ..._inputStyle, minWidth: 240, flex: 1 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live
        </label>
        {loading && <span style={{ color: '#6B7280' }}>Loading…</span>}
      </div>

      <div style={{ fontSize: 12, color: '#6B7280' }}>
        Showing {filtered.length} of {records.length} records — {' '}
        <a href="#" onClick={(e) => { e.preventDefault(); fetchDay(day) }}
           style={{ color: '#2563EB' }}>Refresh</a>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflow: 'auto',
        border: '1px solid #E5E7EB', borderRadius: 6, background: '#fff',
      }}>
        <table data-testid="event-log-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{
            position: 'sticky', top: 0, background: '#F9FAFB',
            zIndex: 1, borderBottom: '1px solid #E5E7EB',
          }}>
            <tr>
              <th style={_thStyle}>Time</th>
              <th style={_thStyle}>Severity</th>
              <th style={_thStyle}>Source</th>
              <th style={_thStyle}>Code</th>
              <th style={{ ..._thStyle, width: '100%' }}>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr><td colSpan={5} style={{ padding: 16, color: '#6B7280', textAlign: 'center' }}>
                No records match the current filters.
              </td></tr>
            )}
            {filtered.map((r, i) => {
              const key = r.ts_utc + ':' + i
              const isOpen = expanded === key
              const sev = SEVERITY_STYLES[r.severity] || SEVERITY_STYLES.info
              return (
                <>
                  <tr
                    key={key}
                    onClick={() => setExpanded(isOpen ? null : key)}
                    style={{ borderBottom: '1px solid #F3F4F6', cursor: 'pointer',
                             background: isOpen ? '#FEF3C7' : undefined }}>
                    <td style={_tdStyle}>{_fmtTime(r.ts_local || r.ts_utc)}</td>
                    <td style={_tdStyle}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                        background: sev.bg, color: sev.fg,
                        border: `1px solid ${sev.bd}`,
                        fontSize: 11, fontWeight: 700,
                        textTransform: 'uppercase', letterSpacing: '0.03em',
                      }}>{r.severity || 'info'}</span>
                    </td>
                    <td style={_tdStyle}>{r.source || ''}</td>
                    <td style={{ ..._tdStyle, fontFamily: 'monospace', fontSize: 12, color: '#6B7280' }}>
                      {r.code || ''}
                    </td>
                    <td style={_tdStyle}>{r.operator_message || ''}</td>
                  </tr>
                  {isOpen && (
                    <tr key={key + ':detail'}>
                      <td colSpan={5} style={{ padding: '10px 16px', background: '#FFFBEB',
                                                fontSize: 12, color: '#374151' }}>
                        {r.technical_detail && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Technical detail</div>
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap',
                                          fontFamily: 'monospace', fontSize: 12 }}>
{r.technical_detail}</pre>
                          </div>
                        )}
                        {r.context && Object.keys(r.context).length > 0 && (
                          <div>
                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Context</div>
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap',
                                          fontFamily: 'monospace', fontSize: 12 }}>
{JSON.stringify(r.context, null, 2)}</pre>
                          </div>
                        )}
                        <div style={{ marginTop: 8, color: '#6B7280', fontSize: 11 }}>
                          UTC: {_fmtTime(r.ts_utc)}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}


const _inputStyle = {
  padding: '4px 8px', border: '1px solid #D1D5DB', borderRadius: 4,
  fontSize: 13, background: '#fff',
}
const _dlBtnStyle = {
  padding: '6px 12px', border: '1px solid #2563EB', borderRadius: 6,
  background: '#EFF6FF', color: '#1E40AF',
  fontSize: 13, fontWeight: 600, textDecoration: 'none',
}
const _thStyle = {
  textAlign: 'left', padding: '8px 12px', fontWeight: 700,
  color: '#374151', fontSize: 12, textTransform: 'uppercase',
  letterSpacing: '0.05em', whiteSpace: 'nowrap',
}
const _tdStyle = { padding: '6px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }

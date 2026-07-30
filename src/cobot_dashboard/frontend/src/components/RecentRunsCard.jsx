import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

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
  // Second inline panel: [Trajectory] expands a per-step joint chart
  // and pushes the FK'd flange polyline into the store so the 3D twin
  // viewer draws the path in the same scene the operator watches.
  const [trajExpanded, setTrajExpanded] = useState(null)   // run_id
  const [trajData,     setTrajData]     = useState({})     // run_id -> {step -> dict}
  const [trajStep,     setTrajStep]     = useState({})     // run_id -> step_index
  const [trajLoading,  setTrajLoading]  = useState({})
  const [trajErrors,   setTrajErrors]   = useState({})
  const setOverlay = useStore((s) => s.setTrajectoryOverlay)

  // Clear the trajectory overlay whenever the trajectory panel closes
  // — leaving a stale polyline on the 3D View tab is the exact "why is
  // this path still here?" bug this feature is supposed to prevent.
  useEffect(() => {
    if (!trajExpanded) setOverlay(null)
  }, [trajExpanded, setOverlay])

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

  // Fetch trajectory for a specific (runId, step) and push the TCP
  // path into the store overlay so the 3D twin viewer draws it.
  async function loadTrajectoryStep(runId, stepIdx) {
    setTrajLoading((prev) => ({ ...prev, [runId]: true }))
    setTrajErrors((prev) => ({ ...prev, [runId]: null }))
    try {
      const url = `/api/runs/${encodeURIComponent(runId)}/trajectory`
                + (stepIdx == null ? '' : `?step=${stepIdx}`)
      const r = await fetch(url)
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) {
        setTrajErrors((prev) => ({ ...prev, [runId]: d.error || `HTTP ${r.status}` }))
        return null
      }
      setTrajData((prev) => ({
        ...prev,
        [runId]: { ...(prev[runId] || {}), [stepIdx ?? '_all']: d },
      }))
      // Push polyline to store — 3D twin viewer picks it up.
      if (Array.isArray(d?.tcp?.xyz) && d.tcp.xyz.length >= 2) {
        setOverlay({
          points: d.tcp.xyz,
          step:   stepIdx,
          runId,
        })
      } else {
        setOverlay(null)
      }
      return d
    } catch (e) {
      setTrajErrors((prev) => ({ ...prev, [runId]: e?.message || String(e) }))
      return null
    } finally {
      setTrajLoading((prev) => ({ ...prev, [runId]: false }))
    }
  }

  async function showTrajectory(runId) {
    if (trajExpanded === runId) {
      setTrajExpanded(null)
      setOverlay(null)
      return
    }
    setTrajExpanded(runId)
    // Default to step 0 (home→approach) — matches the operator's blind
    // spot: the between-endpoints motion of the first commanded move.
    const step = trajStep[runId] ?? 0
    setTrajStep((prev) => ({ ...prev, [runId]: step }))
    const cached = trajData[runId]?.[step]
    if (cached) {
      if (Array.isArray(cached?.tcp?.xyz) && cached.tcp.xyz.length >= 2) {
        setOverlay({ points: cached.tcp.xyz, step, runId })
      }
      return
    }
    await loadTrajectoryStep(runId, step)
  }

  function pickStep(runId, stepIdx) {
    setTrajStep((prev) => ({ ...prev, [runId]: stepIdx }))
    const cached = trajData[runId]?.[stepIdx]
    if (cached) {
      if (Array.isArray(cached?.tcp?.xyz) && cached.tcp.xyz.length >= 2) {
        setOverlay({ points: cached.tcp.xyz, step: stepIdx, runId })
      }
      return
    }
    loadTrajectoryStep(runId, stepIdx)
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
                      {r.codegen_stale && (
                        <span
                          data-testid="run-row-stale-badge"
                          title={
                            `Run used STALE codegen. In-memory sha `
                            + `${((r.codegen_version || {}).src_sha256 || '').slice(0, 12)} `
                            + `≠ disk sha ${r.codegen_disk_sha || '?'} at push time. `
                            + `Restart roboai-dashboard + roboai-estun (or use `
                            + `scripts/deploy.sh) before the next run.`}
                          style={{
                            marginLeft: 8, fontSize: 10, fontWeight: 700,
                            background: '#fef3c7', color: '#92400e',
                            border: '1px solid #f59e0b',
                            padding: '1px 6px', borderRadius: 4,
                            cursor: 'help',
                          }}>⚠ used STALE codegen</span>
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
                  <button
                    onClick={() => showTrajectory(r.run_id)}
                    style={{
                      fontSize: 12, fontWeight: 600, padding: '5px 10px',
                      background: trajExpanded === r.run_id ? '#fce7f3' : '#fdf4ff',
                      color: trajExpanded === r.run_id ? '#831843' : '#a21caf',
                      border: '1px solid #f5d0fe', borderRadius: 5,
                      cursor: 'pointer',
                    }}
                  >{trajExpanded === r.run_id
                    ? 'Hide'
                    : (trajLoading[r.run_id] ? 'Loading…' : 'Trajectory')}</button>
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
                {trajExpanded === r.run_id && trajErrors[r.run_id] && (
                  <div style={{
                    marginTop: 8, padding: 8,
                    background: '#fef2f2', color: '#991b1b',
                    border: '1px solid #fecaca', borderRadius: 6,
                    fontSize: 12,
                  }}>{trajErrors[r.run_id]}</div>
                )}
                {trajExpanded === r.run_id && (
                  <TrajectoryPanel
                    runId={r.run_id}
                    step={trajStep[r.run_id] ?? 0}
                    data={trajData[r.run_id]?.[trajStep[r.run_id] ?? 0]}
                    onPickStep={(idx) => pickStep(r.run_id, idx)}
                    loading={!!trajLoading[r.run_id]}
                  />
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
            <th style={{ padding: 4 }}>TCP line<br/>dev (mm)</th>
            <th style={{ padding: 4 }}>TCP orient<br/>dev (°)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            // TCP thresholds — set to match a modest "the tool should
            // move straight and hold orientation" reading: 10 mm off-
            // line and 5° off-interpolation. Tune as the operator
            // learns what "normal" is on this program.
            const lineDev   = row.tcp_line_dev_max_mm
            const orientDev = row.tcp_orient_dev_max_deg
            const lineHot   = typeof lineDev   === 'number' && lineDev   >= 10
            const orientHot = typeof orientDev === 'number' && orientDev >= 5
            return (
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
                <td style={{
                  padding: 4,
                  ...(lineHot ? { background: '#fef3c7', color: '#92400e' } : {}),
                }}>
                  {typeof lineDev === 'number' ? <b>{lineDev.toFixed(1)}</b> : '—'}
                </td>
                <td style={{
                  padding: 4,
                  ...(orientHot ? { background: '#fef3c7', color: '#92400e' } : {}),
                }}>
                  {typeof orientDev === 'number' ? <b>{orientDev.toFixed(2)}</b> : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 6, fontSize: 10, color: '#9ca3af' }}>
        threshold: {threshold}° &middot; amber = swing over threshold
        &middot; red = wrist-axis swing (J4/J5/J6) over threshold
        &middot; TCP columns flag ≥10 mm line-dev or ≥5° orient-dev
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// TrajectoryPanel — inline per-step trajectory view. Shows a step
// selector (chips), a joint-vs-time SVG (6 traces), the FK'd TCP
// path stats (line + orientation deviation, max + rms), and a note
// pointing the operator at the 3D twin viewer where the polyline
// draws in-scene. The polyline itself is pushed into the store via
// setTrajectoryOverlay in the parent — TrajectoryPolylineOverlay in
// ArmViewer3D subscribes and renders it.
// ──────────────────────────────────────────────────────────────────
function TrajectoryPanel({ runId, step, data, onPickStep, loading }) {
  if (!data && loading) {
    return (
      <div style={{
        marginTop: 8, padding: 12, background: '#fdf4ff',
        border: '1px solid #f5d0fe', borderRadius: 6,
        fontSize: 12, color: '#86198f',
      }}>Computing trajectory & FK…</div>
    )
  }
  if (!data) return null
  const steps = data.steps || []
  const ld    = data.line_deviation
  const od    = data.orientation_deviation
  return (
    <div style={{
      marginTop: 8, padding: 10, background: '#fdf4ff',
      border: '1px solid #f5d0fe', borderRadius: 6,
    }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8,
        alignItems: 'center',
      }}>
        <span style={{
          fontSize: 11, color: '#86198f', fontWeight: 600, marginRight: 4,
        }}>step:</span>
        {steps.map((s) => (
          <button
            key={s.step_index}
            onClick={() => onPickStep(s.step_index)}
            title={`line ${s.program_line ?? '—'} · ${s.samples} samples`}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono, monospace)',
              padding: '3px 7px', borderRadius: 4,
              cursor: 'pointer',
              background: s.step_index === step ? '#a21caf' : '#fff',
              color:      s.step_index === step ? '#fff'    : '#86198f',
              border: '1px solid #f5d0fe',
            }}
          >{s.step_index}</button>
        ))}
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
        fontFamily: 'var(--font-mono, monospace)', fontSize: 12,
      }}>
        <div style={{
          padding: '8px 10px', background: '#fff', borderRadius: 6,
          border: '1px solid #f5d0fe',
        }}>
          <div style={{ color: '#6b7280', fontSize: 10, marginBottom: 2 }}>
            TCP line deviation (perp. distance from start→end chord)
          </div>
          <div style={{ fontSize: 15, color: '#111827' }}>
            max <b>{ld ? ld.max_mm.toFixed(2) : '—'} mm</b>
            {'  ·  '}
            rms <b>{ld ? ld.rms_mm.toFixed(2) : '—'} mm</b>
          </div>
        </div>
        <div style={{
          padding: '8px 10px', background: '#fff', borderRadius: 6,
          border: '1px solid #f5d0fe',
        }}>
          <div style={{ color: '#6b7280', fontSize: 10, marginBottom: 2 }}>
            TCP orientation deviation (vs endpoint SLERP)
          </div>
          <div style={{ fontSize: 15, color: '#111827' }}>
            max <b>{od ? od.max_deg.toFixed(2) : '—'}°</b>
            {'  ·  '}
            rms <b>{od ? od.rms_deg.toFixed(2) : '—'}°</b>
          </div>
        </div>
      </div>
      <JointTraceSvg joints={data.joints} />
      <div style={{ marginTop: 6, fontSize: 10, color: '#86198f' }}>
        Flange path overlay is drawn in the 3D View tab — polyline in
        blue, green dot at start, red at end.
      </div>
    </div>
  )
}

// Minimal SVG chart for the 6 joint traces. No external chart lib —
// this needs to render on the tablet without pulling recharts / d3.
function JointTraceSvg({ joints }) {
  const t = joints?.t || []
  const q = joints?.q_deg || []
  if (!t.length || !q.length) {
    return (
      <div style={{
        marginTop: 8, padding: 10, fontSize: 12, color: '#86198f',
        background: '#fff', borderRadius: 6, border: '1px solid #f5d0fe',
      }}>No joint samples for this step.</div>
    )
  }
  const W = 640
  const H = 200
  const PAD_L = 40
  const PAD_R = 10
  const PAD_T = 8
  const PAD_B = 22
  const t0 = t[0]
  const t1 = t[t.length - 1]
  const dt = Math.max(t1 - t0, 1e-6)
  // Per-joint min/max across the step (matched to the amber flag on
  // the excursion table — same convention).
  const COLORS = ['#3B82F6', '#16A34A', '#CA8A04', '#DC2626', '#9333EA', '#F97316']
  let qMin = Infinity, qMax = -Infinity
  for (let i = 0; i < q.length; i++) {
    for (let j = 0; j < 6; j++) {
      const v = q[i][j]
      if (v < qMin) qMin = v
      if (v > qMax) qMax = v
    }
  }
  if (!Number.isFinite(qMin) || !Number.isFinite(qMax)) {
    qMin = -180; qMax = 180
  }
  if (qMax - qMin < 1) { qMax = qMin + 1 }
  const xOf = (tv) => PAD_L + ((tv - t0) / dt) * (W - PAD_L - PAD_R)
  const yOf = (v)  => PAD_T + (1 - (v - qMin) / (qMax - qMin)) * (H - PAD_T - PAD_B)
  const paths = []
  for (let j = 0; j < 6; j++) {
    let d = ''
    for (let i = 0; i < q.length; i++) {
      d += (i === 0 ? 'M' : 'L') + xOf(t[i]).toFixed(2) + ' ' + yOf(q[i][j]).toFixed(2) + ' '
    }
    paths.push(d)
  }
  // Zero-line if in-range.
  const showZero = qMin < 0 && qMax > 0
  return (
    <div style={{
      marginTop: 8, padding: 6, background: '#fff',
      border: '1px solid #f5d0fe', borderRadius: 6,
      overflowX: 'auto',
    }}>
      <svg width={W} height={H} style={{ display: 'block' }}
           viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <rect x={PAD_L} y={PAD_T} width={W - PAD_L - PAD_R}
              height={H - PAD_T - PAD_B} fill="#fafafa" />
        {showZero && (
          <line x1={PAD_L} y1={yOf(0)} x2={W - PAD_R} y2={yOf(0)}
                stroke="#d1d5db" strokeDasharray="2 3" />
        )}
        {/* y ticks */}
        <text x={PAD_L - 4} y={PAD_T + 8}
              fontSize="10" fill="#6b7280" textAnchor="end">
          {qMax.toFixed(0)}°
        </text>
        <text x={PAD_L - 4} y={H - PAD_B - 2}
              fontSize="10" fill="#6b7280" textAnchor="end">
          {qMin.toFixed(0)}°
        </text>
        {/* x ticks */}
        <text x={PAD_L} y={H - 6} fontSize="10" fill="#6b7280">
          {t0.toFixed(2)}s
        </text>
        <text x={W - PAD_R} y={H - 6} fontSize="10" fill="#6b7280"
              textAnchor="end">
          {t1.toFixed(2)}s
        </text>
        {paths.map((d, j) => (
          <path key={j} d={d} fill="none"
                stroke={COLORS[j]} strokeWidth="1.4" />
        ))}
      </svg>
      <div style={{
        display: 'flex', gap: 12, marginTop: 4,
        fontFamily: 'var(--font-mono, monospace)', fontSize: 10,
        color: '#374151', flexWrap: 'wrap',
      }}>
        {[1,2,3,4,5,6].map((n, i) => (
          <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 10, height: 3, background: COLORS[i],
              display: 'inline-block',
            }} /> J{n}
          </span>
        ))}
      </div>
    </div>
  )
}

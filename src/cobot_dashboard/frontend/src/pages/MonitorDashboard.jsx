import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader'
import * as THREE from 'three'

function StatusBadge({ status }) {
  const colors = {
    idle:    { bg: '#f3f4f6', border: '#d1d5db', text: '#6b7280', label: 'IDLE' },
    running: { bg: '#f0fdf4', border: '#16A34A', text: '#16A34A', label: 'RUNNING' },
    paused:  { bg: '#fffbeb', border: '#CA8A04', text: '#CA8A04', label: 'PAUSED' },
    estop:   { bg: '#fef2f2', border: '#DC2626', text: '#DC2626', label: 'E-STOP' },
    homing:  { bg: '#eff6ff', border: '#2563EB', text: '#2563EB', label: 'HOMING' },
  }
  const c = colors[status] || colors.idle
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      padding: '12px 24px', borderRadius: 12,
      background: c.bg, border: '2px solid ' + c.border,
    }}>
      <div style={{
        width: 14, height: 14, borderRadius: '50%',
        background: c.text,
        animation: status === 'running' ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
      }} />
      <span style={{ fontSize: 20, fontWeight: 800, color: c.text, letterSpacing: '0.05em' }}>
        {c.label}
      </span>
    </div>
  )
}

function PickCounter() {
  const [counts, setCounts] = useState({ today: 0, shift: 0, total: 0, per_hour: [] })
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/stats/picks')
        if (!alive || !res.ok) return
        const data = await res.json()
        setCounts((prev) => ({ ...prev, ...data }))
      } catch { /* keep prior counts on transient failure */ }
    }
    poll()
    const iv = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const trend  = (counts.per_hour || []).slice(-12)
  const maxVal = Math.max(1, ...trend)

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: 20, flex: 1,
    }}>
      <div style={cardLabel}>Parts Picked</div>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 42, fontWeight: 800, color: '#111', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {counts.today}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>today</div>
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
            {counts.shift}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>this shift</div>
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
            {counts.total}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>all time</div>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, height: 40, marginLeft: 16 }}>
          {trend.map((v, i) => (
            <div key={i} style={{
              flex: 1, borderRadius: '2px 2px 0 0',
              height: Math.max(4, (v / maxVal) * 40),
              background: i === trend.length - 1 ? '#2563EB' : '#dbeafe',
              transition: 'height 300ms',
            }} />
          ))}
        </div>
      </div>
    </div>
  )
}

function CycleResults() {
  const [results, setResults] = useState([])
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/stats/cycles')
        if (alive && res.ok) {
          const data = await res.json()
          setResults(data.recent || [])
        }
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const last = results[results.length - 1]
  const passCount = results.filter((r) => r.result === 'pass').length
  const failCount = results.filter((r) => r.result === 'fail').length

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: 20, flex: 1,
    }}>
      <div style={cardLabel}>Cycle Results</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: !last ? '#f3f4f6' : last.result === 'pass' ? '#f0fdf4' : '#fef2f2',
          border:     !last ? '2px solid #d1d5db' : last.result === 'pass' ? '2px solid #16A34A' : '2px solid #DC2626',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 700,
          color: !last ? '#9ca3af' : last.result === 'pass' ? '#16A34A' : '#DC2626',
        }}>
          {!last ? '—' : last.result === 'pass' ? 'OK' : 'NG'}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
            {!last ? 'No cycles yet' : last.result === 'pass' ? 'Last cycle passed' : 'Last cycle FAILED'}
          </div>
          {last && last.message && (
            <div style={{ fontSize: 11, color: '#6b7280' }}>{last.message}</div>
          )}
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#16A34A' }}>{passCount}</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}> pass </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#DC2626' }}>{failCount}</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}> fail</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {results.slice(-20).map((r, i) => (
          <div key={i} style={{
            width: 14, height: 14, borderRadius: '50%',
            background: r.result === 'pass' ? '#16A34A' : '#DC2626',
            opacity: i === Math.min(results.length, 20) - 1 ? 1 : 0.5,
          }} title={r.message || r.result} />
        ))}
        {results.length === 0 && (
          <div style={{ fontSize: 11, color: '#9ca3af' }}>No cycle data yet</div>
        )}
      </div>
    </div>
  )
}

function FaultLog() {
  const [events, setEvents] = useState([])
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/stats/events')
        if (alive && res.ok) {
          const data = await res.json()
          setEvents(data.events || [])
        }
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const severity = { error: '#DC2626', warning: '#CA8A04', info: '#2563EB' }

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: 20,
    }}>
      <div style={{ ...cardLabel, marginBottom: 10 }}>Recent Events</div>
      {events.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>No events</div>
      ) : events.slice(-5).reverse().map((ev, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '8px 0',
          borderBottom: i < 4 ? '1px solid #f3f4f6' : 'none',
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 5,
            background: severity[ev.severity] || '#6b7280',
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: '#111' }}>{ev.message}</div>
            <div style={{ fontSize: 10, color: '#9ca3af' }}>{ev.timestamp}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function TimeRemaining({ cycleTime, repeatCount, cyclesDone }) {
  if (!repeatCount || repeatCount <= 0 || !cycleTime) return null
  const remaining = Math.max(0, (repeatCount - cyclesDone) * cycleTime)
  const mins = Math.floor(remaining / 60)
  const secs = Math.floor(remaining % 60)
  const eta = new Date(Date.now() + remaining * 1000)
  const etaStr = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: 20, display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
    }}>
      <div>
        <div style={cardLabel}>Time Remaining</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>
          {mins}:{secs.toString().padStart(2, '0')}
        </div>
      </div>
      <div>
        <div style={cardLabel}>ETA</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#2563EB', marginTop: 4 }}>{etaStr}</div>
      </div>
      <div>
        <div style={cardLabel}>Cycles</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#374151', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
          {cyclesDone} / {repeatCount}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ height: 10, borderRadius: 5, background: '#e5e7eb', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 5,
            width: (cyclesDone / repeatCount * 100) + '%',
            background: '#2563EB', transition: 'width 500ms',
          }} />
        </div>
        <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'right', marginTop: 3 }}>
          {Math.round(cyclesDone / repeatCount * 100)}% complete
        </div>
      </div>
    </div>
  )
}

function IOSummary() {
  const [ioState, setIoState] = useState({})
  const [labels, setLabels]   = useState({})

  useEffect(() => {
    fetch('/api/io/config').then((r) => r.json()).then((d) => setLabels(d.labels || {})).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/io/state')
        if (alive && res.ok) {
          const data = await res.json()
          setIoState(data.io || {})
        }
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 500)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  // Operator-relevant signals to surface as a strip. Same id space as
  // the I/O page so labels stay in sync if the operator renames them.
  const keySignals = ['DI0', 'DI1', 'DI4', 'DI8', 'DO0', 'DO1', 'DO2', 'DO4']

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: '14px 20px',
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginRight: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        I/O
      </span>
      {keySignals.map((id) => {
        const active = !!ioState[id]
        const label  = labels[id] || id
        return (
          <div key={id} style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', borderRadius: 6,
            background: active ? 'rgba(22,163,74,0.08)' : '#f3f4f6',
            border:     active ? '1px solid rgba(22,163,74,0.3)' : '1px solid #e5e7eb',
          }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: active ? '#16A34A' : '#9ca3af',
            }} />
            <span style={{ fontSize: 10, color: '#374151', fontWeight: 500 }}>
              {label.length > 15 ? label.slice(0, 15) + '…' : label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function PartModel({ stlUrl }) {
  const [mesh, setMesh] = useState(null)

  useEffect(() => {
    if (!stlUrl) { setMesh(null); return }
    let cancelled = false
    const loader = new STLLoader()
    loader.load(
      stlUrl,
      (geometry) => {
        if (cancelled) return
        geometry.computeBoundingBox()
        geometry.center()
        // Scale to fit within a ~0.1 unit cube so the camera default
        // works regardless of the part's real-world size.
        const box = geometry.boundingBox
        const size = Math.max(
          (box.max.x - box.min.x),
          (box.max.y - box.min.y),
          (box.max.z - box.min.z),
        ) || 1
        const scale = 0.1 / size
        geometry.scale(scale, scale, scale)
        const m = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: '#A8B0C0', metalness: 0.5, roughness: 0.35 }),
        )
        setMesh(m)
      },
      undefined,
      () => { if (!cancelled) setMesh(null) },
    )
    return () => { cancelled = true }
  }, [stlUrl])

  if (!mesh) return null
  return <primitive object={mesh} />
}

function PartViewer({ partId }) {
  const [partMeta, setPartMeta] = useState(null)

  useEffect(() => {
    if (!partId) { setPartMeta(null); return }
    let alive = true
    fetch('/api/parts/' + encodeURIComponent(partId))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setPartMeta(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [partId])

  const stlUrl = partMeta?.stl_file ? '/parts/' + partMeta.stl_file : null
  const name   = partMeta?.name || partId

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={cardLabel}>Current Part</div>
        <div style={{ flex: 1 }} />
        {name && <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{name}</span>}
      </div>

      {partId ? (
        <div style={{ height: 200, background: '#fafafa' }}>
          <Canvas camera={{ position: [0.15, 0.12, 0.15], fov: 45 }} style={{ background: '#fafafa' }}>
            <ambientLight intensity={0.7} />
            <directionalLight position={[5, 5, 5]} intensity={0.8} />
            <directionalLight position={[-5, 3, -5]} intensity={0.3} />
            <gridHelper args={[0.2, 10, '#d1d5db', '#e5e7eb']} />
            <PartModel stlUrl={stlUrl} />
            <OrbitControls enablePan={false} target={[0, 0, 0]} />
          </Canvas>
        </div>
      ) : (
        <div style={{
          height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#9ca3af', fontSize: 13, background: '#fafafa',
        }}>
          No part assigned to this program
        </div>
      )}

      {partMeta && (
        <div style={{ padding: '10px 16px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 16, fontSize: 11, color: '#6b7280', flexWrap: 'wrap' }}>
          {Array.isArray(partMeta.extents_cm) && (
            <span>
              {partMeta.extents_cm.map((e) => Number(e).toFixed(1)).join(' × ')} cm
            </span>
          )}
          {partMeta.teach_count !== undefined && (
            <span>{partMeta.teach_count} teach refs</span>
          )}
          {partMeta.templates?.num_templates !== undefined && (
            <span>{partMeta.templates.num_templates} templates</span>
          )}
        </div>
      )}
    </div>
  )
}

function ProgramPickStats({ programId }) {
  const [stats, setStats] = useState({ total: 0, pass: 0, fail: 0, fail_reasons: [] })

  useEffect(() => {
    if (!programId) { setStats({ total: 0, pass: 0, fail: 0, fail_reasons: [] }); return }
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/stats/program/' + encodeURIComponent(programId))
        if (!alive || !res.ok) return
        const data = await res.json()
        setStats((prev) => ({ ...prev, ...data }))
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(iv) }
  }, [programId])

  const passRate = stats.total > 0 ? Math.round(stats.pass / stats.total * 100) : 0
  const ringColor = passRate >= 90 ? '#16A34A' : passRate >= 70 ? '#CA8A04' : '#DC2626'
  const circumference = 2 * Math.PI * 34 // ≈ 213.6

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: 20,
    }}>
      <div style={{ ...cardLabel, marginBottom: 12 }}>Program Pick Performance</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 16 }}>
        <div style={{ position: 'relative', width: 80, height: 80 }}>
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="34" fill="none" stroke="#e5e7eb" strokeWidth="8" />
            <circle cx="40" cy="40" r="34" fill="none"
              stroke={ringColor} strokeWidth="8"
              strokeDasharray={`${(passRate / 100) * circumference} ${circumference}`}
              strokeLinecap="round"
              transform="rotate(-90 40 40)"
            />
          </svg>
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 800, color: '#111',
          }}>
            {stats.total > 0 ? passRate + '%' : '—'}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#16A34A', fontVariantNumeric: 'tabular-nums' }}>{stats.pass}</div>
            <div style={{ fontSize: 10, color: '#6b7280' }}>successful picks</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#DC2626', fontVariantNumeric: 'tabular-nums' }}>{stats.fail}</div>
            <div style={{ fontSize: 10, color: '#6b7280' }}>failed picks</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#374151', fontVariantNumeric: 'tabular-nums' }}>{stats.total}</div>
            <div style={{ fontSize: 10, color: '#6b7280' }}>total attempts</div>
          </div>
        </div>
      </div>

      {Array.isArray(stats.fail_reasons) && stats.fail_reasons.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#DC2626', marginBottom: 6 }}>Failure Reasons</div>
          {stats.fail_reasons.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 0', fontSize: 12, color: '#374151',
            }}>
              <div style={{ flex: 1 }}>{r.reason}</div>
              <div style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.count}</div>
              <div style={{ width: 60, height: 6, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3, background: '#DC2626',
                  width: stats.fail > 0 ? (r.count / stats.fail * 100) + '%' : '0%',
                }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {stats.total === 0 && (
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>No pick attempts recorded for this program yet</div>
      )}
    </div>
  )
}

function CycleTimeChart({ programId }) {
  const [data, setData] = useState([])

  useEffect(() => {
    if (!programId) { setData([]); return }
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/stats/program/' + encodeURIComponent(programId) + '/cycle_times')
        if (!alive || !res.ok) return
        const d = await res.json()
        setData(d.cycle_times || [])
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(iv) }
  }, [programId])

  if (data.length < 2) {
    return (
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 20 }}>
        <div style={{ ...cardLabel, marginBottom: 8 }}>Cycle Time History</div>
        <div style={{ fontSize: 12, color: '#9ca3af', padding: '20px 0', textAlign: 'center' }}>
          Need at least 2 cycles to show trend
        </div>
      </div>
    )
  }

  const sample = data.slice(-50)
  const times = sample.map((d) => Number(d.time) || 0)
  const maxTime = Math.max(...times)
  const minTime = Math.min(...times)
  const avgTime = times.reduce((s, t) => s + t, 0) / times.length
  const chartH  = 120

  const yFor = (t) => maxTime > minTime
    ? (1 - (t - minTime) / (maxTime - minTime)) * chartH
    : chartH / 2

  const points = sample.map((d, i) => {
    const x = (i / Math.max(1, sample.length - 1)) * 100
    return `${x},${yFor(Number(d.time) || 0)}`
  })
  const pathD = 'M ' + points.join(' L ')
  const avgY  = yFor(avgTime)

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={cardLabel}>Cycle Time History</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
          <span style={{ color: '#6b7280' }}>Avg: <strong style={{ color: '#2563EB' }}>{avgTime.toFixed(1)}s</strong></span>
          <span style={{ color: '#6b7280' }}>Min: <strong style={{ color: '#16A34A' }}>{minTime.toFixed(1)}s</strong></span>
          <span style={{ color: '#6b7280' }}>Max: <strong style={{ color: '#DC2626' }}>{maxTime.toFixed(1)}s</strong></span>
        </div>
      </div>

      <div style={{ position: 'relative', height: chartH }}>
        <svg width="100%" height={chartH} viewBox={'0 0 100 ' + chartH} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
          <line x1="0" y1={avgY} x2="100" y2={avgY}
            stroke="#2563EB" strokeWidth="0.3" strokeDasharray="2,2" />
          <path d={pathD + ' L 100,' + chartH + ' L 0,' + chartH + ' Z'} fill="#2563EB" fillOpacity="0.08" />
          <path d={pathD} fill="none" stroke="#2563EB" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          {(() => {
            const last = points[points.length - 1].split(',')
            return <circle cx={last[0]} cy={last[1]} r="1.4" fill="#2563EB" vectorEffect="non-scaling-stroke" />
          })()}
        </svg>
        <div style={{ position: 'absolute', top: 0, right: 0, fontSize: 9, color: '#9ca3af' }}>{maxTime.toFixed(1)}s</div>
        <div style={{ position: 'absolute', bottom: 0, right: 0, fontSize: 9, color: '#9ca3af' }}>{minTime.toFixed(1)}s</div>
      </div>

      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6, textAlign: 'right' }}>
        Last {sample.length} cycles
      </div>
    </div>
  )
}

const cardLabel = {
  fontSize: 11, fontWeight: 600, color: '#6b7280',
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

function StatCard({ label, value, unit, color }) {
  return (
    <div style={{
      padding: '16px 20px', background: '#fff',
      borderRadius: 10, border: '1px solid #e5e7eb',
      flex: 1, minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color || '#111', fontVariantNumeric: 'tabular-nums' }}>
        {value}{unit && <span style={{ fontSize: 14, fontWeight: 500, color: '#9ca3af', marginLeft: 4 }}>{unit}</span>}
      </div>
    </div>
  )
}

export default function MonitorDashboard() {
  const currentProgram = useStore((s) => s.currentProgram)
  const task           = useStore((s) => s.task)
  const safety         = useStore((s) => s.safety)
  const detectionsFromStore = useStore((s) => s.detections)
  const setTab         = useStore((s) => s.setTab)

  const runProgram     = useStore((s) => s.runProgram)
  const pauseProgram   = useStore((s) => s.pauseProgram)
  const resumeProgram  = useStore((s) => s.resumeProgram)
  const cancelProgram  = useStore((s) => s.cancelProgram)

  // Cycle bookkeeping lives in local state — the backend doesn't track
  // cycle count in STATE yet, so we maintain a counter on the client
  // by watching for running → !running transitions.
  const [cycleCount, setCycleCount] = useState(0)
  const [cycleStart, setCycleStart] = useState(null)
  const [lastCycleTime, setLastCycleTime] = useState(null)

  useEffect(() => {
    if (task?.running && !task?.paused && cycleStart === null) {
      setCycleStart(Date.now())
    }
    if (!task?.running && cycleStart !== null) {
      const dt = (Date.now() - cycleStart) / 1000
      setLastCycleTime(dt.toFixed(1))
      setCycleCount((c) => c + 1)
      setCycleStart(null)
    }
  }, [task?.running, task?.paused, cycleStart])

  // Derive the badge from real task + safety state.
  const status = safety?.estop ? 'estop'
               : task?.paused  ? 'paused'
               : task?.running ? 'running'
               :                  'idle'

  const programName    = currentProgram?.name || 'No program loaded'
  const steps          = currentProgram?.steps || []
  const currentStepIdx = task?.running || task?.paused ? (task?.program_step ?? 0) : -1
  const currentStepLabel = currentStepIdx >= 0 && steps[currentStepIdx]
    ? steps[currentStepIdx].label
    : 'Waiting'

  const detections = Array.isArray(detectionsFromStore) ? detectionsFromStore : []
  const detectionCount = detections.length
  const speedPct = Math.round((safety?.speed_scale ?? 1) * 100)

  // Wizard-saved programs carry the target part id in their config.
  const programConfig  = currentProgram?.config || {}
  const targetPartId   = programConfig.target_part || null
  const programIdForStats = currentProgram?.id || null

  const runDisabled    = safety?.estop || (task?.running && !task?.paused)
  const pauseDisabled  = !task?.running || task?.paused || safety?.estop
  const stopDisabled   = !task?.running && !task?.paused

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'auto',
      background: '#f8fafc', padding: 24,
    }}>
      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.5; transform: scale(1.3); }
        }
      `}</style>

      {/* Top row: Status + Program info | Live camera */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 360 }}>
          <StatusBadge status={status} />
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Current Program
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginTop: 4 }}>
              {programName}
            </div>
            {currentStepIdx >= 0 && steps.length > 0 && (
              <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>
                Step {currentStepIdx + 1} of {steps.length}: {currentStepLabel}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
            {status === 'paused' ? (
              <>
                <button onClick={resumeProgram} disabled={safety?.estop}
                  style={primaryBtn('#16A34A', safety?.estop)}>
                  ▶ Resume
                </button>
                <button onClick={cancelProgram} style={primaryBtn('#DC2626')}>
                  ✕ Stop
                </button>
              </>
            ) : status === 'running' ? (
              <>
                <button onClick={pauseProgram} disabled={pauseDisabled}
                  style={primaryBtn('#CA8A04', pauseDisabled)}>
                  ⏸ Pause
                </button>
                <button onClick={cancelProgram} disabled={stopDisabled}
                  style={primaryBtn('#DC2626', stopDisabled)}>
                  ✕ Stop
                </button>
              </>
            ) : (
              <button onClick={runProgram} disabled={runDisabled || steps.length === 0}
                style={primaryBtn('#16A34A', runDisabled || steps.length === 0)}>
                ▶ Run Program
              </button>
            )}
            <button onClick={() => setTab('program')} style={{
              padding: '14px 24px', fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            }}>
              Edit Program
            </button>
          </div>
        </div>

        {/* Top-right: 3D viewer of the current program's target part.
            The live camera moved out — it has its own home in the
            Cameras & LiDAR tab. */}
        <div style={{ width: 400, flexShrink: 0 }}>
          <PartViewer partId={targetPartId} />
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard label="Speed" value={speedPct} unit="%" color="#2563EB" />
        <StatCard label="Cycle Count" value={cycleCount} color="#16A34A" />
        <StatCard label="Last Cycle Time" value={lastCycleTime ?? '—'} unit={lastCycleTime ? 's' : ''} color="#374151" />
        <StatCard label="Objects Detected" value={detectionCount} color="#9333EA" />
      </div>

      {/* Production stats: parts picked + cycle results */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <PickCounter />
        <CycleResults />
      </div>

      {/* Per-program pick performance (PartViewer moved to the top-right
          slot vacated by the camera feed). */}
      <div style={{ marginBottom: 16 }}>
        <ProgramPickStats programId={programIdForStats} />
      </div>

      {/* Cycle time history for the loaded program */}
      <div style={{ marginBottom: 16 }}>
        <CycleTimeChart programId={programIdForStats} />
      </div>

      {/* Time remaining — only renders when a counted program is running */}
      <div style={{ marginBottom: 16 }}>
        <TimeRemaining
          cycleTime={parseFloat(lastCycleTime) || 12}
          repeatCount={currentProgram?.config?.repeat_count || 0}
          cyclesDone={cycleCount}
        />
      </div>

      {/* I/O strip on top, fault log below */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        <IOSummary />
        <FaultLog />
      </div>

      {/* Scan & Identify results — only visible while a scan program
          is running (or has just finished). The executor publishes
          scan_results / scan_count / identified_count on /task/state. */}
      {(task?.scan_results?.length > 0 || task?.scan_count > 0) && (
        <div style={{
          background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
          padding: 20, marginBottom: 24,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>
              Scan Results
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {task?.identified_count || 0} of {task?.scan_count || 0} identified
            </div>
          </div>
          {(task?.scan_results || []).length > 0 ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 8,
            }}>
              {task.scan_results.map((p, i) => {
                const known = p.part_id && p.part_id !== 'unknown'
                const bg     = p.is_defect ? '#fef2f2' : known ? '#f0fdf4' : '#f3f4f6'
                const border = p.is_defect ? '1px solid #fecaca'
                              : known      ? '1px solid #bbf7d0'
                                           : '1px solid #e5e7eb'
                const color  = p.is_defect ? '#DC2626' : known ? '#16A34A' : '#6b7280'
                return (
                  <div key={i} style={{
                    padding: '10px 12px', borderRadius: 8, background: bg, border,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color }}>
                      {p.is_defect ? `DEFECT: ${p.defect_name || ''}` : (p.part_id || 'Unknown')}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      {Number(p.confidence || 0).toFixed(0)}% · {p.orientation || 'unknown'}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#9ca3af' }}>
              Wide scan captured {task?.scan_count || 0} objects — close-up identification in progress…
            </div>
          )}
        </div>
      )}

      {/* Program steps progress */}
      {steps.length > 0 ? (
        <div style={{
          background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
          padding: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111', marginBottom: 14 }}>
            Program Steps
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {steps.map((step, i) => (
              <div key={step.id ?? i} style={{
                flex: 1, height: 8, borderRadius: 4,
                background: i < currentStepIdx ? '#16A34A'
                  : i === currentStepIdx ? '#2563EB'
                  : '#e5e7eb',
                transition: 'background 300ms',
              }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {steps.map((step, i) => (
              <div key={step.id ?? i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', borderRadius: 6,
                background: i === currentStepIdx ? '#eff6ff'
                  : i < currentStepIdx ? '#f0fdf4'
                  : '#fafafa',
                border: i === currentStepIdx ? '1px solid #93c5fd'
                  : i < currentStepIdx ? '1px solid #bbf7d0'
                  : '1px solid #e5e7eb',
              }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700,
                  background: i < currentStepIdx ? '#16A34A' : i === currentStepIdx ? '#2563EB' : '#e5e7eb',
                  color: i <= currentStepIdx ? '#fff' : '#6b7280',
                }}>
                  {i < currentStepIdx ? '✓' : i + 1}
                </div>
                <div style={{
                  fontSize: 12, fontWeight: i === currentStepIdx ? 700 : 400,
                  color: i === currentStepIdx ? '#2563EB' : '#374151',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {step.label || step.action}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{
          background: '#fff', borderRadius: 12, border: '2px dashed #d1d5db',
          padding: 40, textAlign: 'center',
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
            No program loaded
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
            Load a program from the library or create a new one with the wizard
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={() => setTab('programs')} style={{
              padding: '12px 24px', fontSize: 14, fontWeight: 600,
              background: '#2563EB', color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer',
            }}>
              Open Program Library
            </button>
            <button onClick={() => setTab('program')} style={{
              padding: '12px 24px', fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
            }}>
              Create New Program
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function primaryBtn(bg, disabled) {
  return {
    padding: '14px 28px', fontSize: 16, fontWeight: 700,
    background: bg, color: '#fff', border: 'none',
    borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
}

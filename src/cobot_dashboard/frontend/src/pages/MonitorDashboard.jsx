import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader'
import * as THREE from 'three'
import ProgramLibrary from './ProgramLibrary'
import IdentifiedObjectsCard from '../components/IdentifiedObjectsCard'
import RunProgramModal from '../components/RunProgramModal'
import ProgramErrorModal from '../components/ProgramErrorModal'
import StepPreviewPanel from '../components/StepPreviewPanel'
import { deriveRunState, isStopButtonEnabled,
         isStuckStopping as _computeStuckStopping,
         STUCK_STOPPING_MS } from '../lib/runState'

// Status badge — reads the unified deriveRunState() so pill matches
// footer matches banner. Rendered from a runState object (color, label,
// detail, pulse) so any future new state variant just needs an entry
// in runState.js.
function StatusBadge({ runState }) {
  const rs = runState || { kind: 'idle', label: 'IDLE', color: '#6b7280',
                           bg: '#f3f4f6', border: '#d1d5db', pulse: false }
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      padding: '12px 24px', borderRadius: 12,
      background: rs.bg, border: '2px solid ' + rs.border,
    }}>
      <div style={{
        width: 14, height: 14, borderRadius: '50%',
        background: rs.color,
        animation: rs.pulse ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
      }} />
      <span style={{ fontSize: 20, fontWeight: 800, color: rs.color, letterSpacing: '0.05em' }}>
        {rs.label}
      </span>
      {rs.detail && (
        <span style={{ fontSize: 12, color: rs.color, opacity: 0.75,
                       marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>
          {rs.detail}
        </span>
      )}
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

// Compact target-part viewer for the Monitor top section. Renders
// null whenever the loaded program either doesn't have a target_part
// or that part has no STL/GLB on disk — the right block disappears
// entirely so the left block can take the full width.
function TopPartViewer({ partId }) {
  const [partMeta, setPartMeta] = useState(null)
  const [loadErr,  setLoadErr]  = useState(false)

  useEffect(() => {
    if (!partId) { setPartMeta(null); setLoadErr(false); return }
    let alive = true
    setLoadErr(false)
    fetch('/api/parts/' + encodeURIComponent(partId))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) { if (d) setPartMeta(d); else { setPartMeta(null); setLoadErr(true) } } })
      .catch(() => { if (alive) { setPartMeta(null); setLoadErr(true) } })
    return () => { alive = false }
  }, [partId])

  if (!partId || loadErr) return null
  // Resolve the renderable URL. STL is what the parts pipeline
  // currently writes; GLB is reserved for the future grippers-style
  // upgrade — we try it first and fall through to STL.
  const partKey = partMeta?.id || partMeta?.part_id || partId
  const stlUrl  = partMeta?.stl_file ? '/parts/' + partMeta.stl_file : null
  if (!stlUrl) return null

  const name = partMeta?.name || partKey
  const ext  = Array.isArray(partMeta?.extents_cm) ? partMeta.extents_cm : null

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      overflow: 'hidden', width: 220, flexShrink: 0,
    }}>
      <div style={{
        padding: '8px 12px',
        fontSize: 11, fontWeight: 700, color: '#6b7280',
        textTransform: 'uppercase', letterSpacing: '0.06em',
        borderBottom: '1px solid #e5e7eb', background: '#fff',
      }}>
        Target Part
      </div>
      <div style={{ width: 200, height: 200, margin: '0 auto', background: '#fff' }}>
        <Canvas
          camera={{ position: [0.18, 0.14, 0.18], fov: 45 }}
          style={{ background: '#fff' }}
          gl={{ antialias: true }}>
          <ambientLight intensity={0.75} />
          <directionalLight position={[5, 5, 5]} intensity={0.85} />
          <directionalLight position={[-5, 3, -5]} intensity={0.3} />
          <PartModel stlUrl={stlUrl} />
          <OrbitControls enablePan={false} target={[0, 0, 0]}
            autoRotate autoRotateSpeed={1.5} />
        </Canvas>
      </div>
      <div style={{ padding: '8px 12px 12px', borderTop: '1px solid #f3f4f6' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111', lineHeight: 1.3 }}>
          {name}
        </div>
        {ext && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {ext.map((e) => Number(e).toFixed(1)).join(' × ')} cm
          </div>
        )}
      </div>
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

// Pallet progress widget — only renders while a pallet program is
// running. Subscribes to /task/state via the global store; reads
// pallet_mode / pallet_cycle / pallet_row / pallet_col / pallet_layer
// / pallet_total. Shows layer tabs (one per pallet layer) with a
// grid of rows × cols slot tiles for the active layer.
function PalletProgressWidget({ task, programConfig, lastCycleTime }) {
  const palletMode  = task?.pallet_mode || null
  const cycle       = task?.pallet_cycle ?? null
  const total       = task?.pallet_total ?? null
  const activeRow   = task?.pallet_row   ?? 0
  const activeCol   = task?.pallet_col   ?? 0
  const activeLayer = task?.pallet_layer ?? 0
  const isDepal     = palletMode === 'depalletize'

  // Selected layer tab — defaults to the layer the executor is on,
  // but the operator can click around to inspect others.
  const [selectedLayer, setSelectedLayer] = useState(0)
  useEffect(() => {
    if (typeof activeLayer === 'number') setSelectedLayer(activeLayer)
  }, [activeLayer])

  if (!palletMode || cycle === null || total === null) return null

  const pallet = programConfig?.pallet || {}
  const rows    = pallet.rows   || 4
  const cols    = pallet.cols   || 4
  const layers  = pallet.layers || 1
  const fillOrder = pallet.fill_order || 'row_lr'

  // Recreate the same slot ordering the executor uses so the widget's
  // grey/green/blue tiles match what the robot is doing. For
  // depalletize the layer order reverses (top first).
  const slotForCycle = (n) => {
    const layerSize = Math.max(1, rows * cols)
    const layerIdx  = Math.floor(n / layerSize)
    const within    = n % layerSize
    let r, c
    if (fillOrder === 'row_lr') {
      r = Math.floor(within / cols) % rows
      c = within % cols
    } else if (fillOrder === 'row_rl') {
      r = Math.floor(within / cols) % rows
      c = (cols - 1) - (within % cols)
    } else if (fillOrder === 'col') {
      r = within % rows
      c = Math.floor(within / rows) % cols
    } else {
      r = Math.floor(within / cols) % rows
      const wr = within % cols
      c = (r % 2 === 0) ? wr : (cols - 1 - wr)
    }
    const layer = isDepal ? (layers - 1) - (layerIdx % layers) : (layerIdx % layers)
    return { r, c, layer }
  }

  // Build a {layer -> {r,c -> status}} map. Anything with index < cycle
  // is done; index === cycle is active; else not yet.
  const slotState = {}
  for (let i = 0; i < total; i++) {
    const { r, c, layer } = slotForCycle(i)
    if (!slotState[layer]) slotState[layer] = {}
    const status = i < cycle ? 'done' : i === cycle ? 'active' : 'pending'
    slotState[layer][r + ',' + c] = status
  }

  const remaining = Math.max(0, total - cycle)
  const cycleSec  = parseFloat(lastCycleTime) || 12
  const etaSec    = Math.max(0, Math.round(remaining * cycleSec))
  const etaMin    = Math.floor(etaSec / 60)
  const etaRem    = etaSec - etaMin * 60
  const tileFor = (status) => ({
    background: status === 'done'    ? '#16A34A'
             : status === 'active'   ? '#2563EB'
             : status === 'failed'   ? '#DC2626'
             : '#e5e7eb',
    boxShadow: status === 'active' ? '0 0 0 3px rgba(37,99,235,0.25)' : 'none',
    animation: status === 'active' ? 'pulse-pallet 1.2s ease-in-out infinite' : 'none',
    color: status === 'done' || status === 'active' || status === 'failed' ? '#fff' : '#9ca3af',
  })

  const badgeBg     = isDepal ? '#fffbeb' : '#eff6ff'
  const badgeBorder = isDepal ? '#fde68a' : '#bfdbfe'
  const badgeColor  = isDepal ? '#CA8A04' : '#2563EB'
  const badgeLabel  = isDepal ? 'DEPALLETIZING' : 'PALLETIZING'

  return (
    <div style={{
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      padding: 20, marginBottom: 16,
    }}>
      <style>{`
        @keyframes pulse-pallet {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(0.92); }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 14px', borderRadius: 999,
          background: badgeBg, border: '1px solid ' + badgeBorder,
          color: badgeColor, fontSize: 12, fontWeight: 800, letterSpacing: '0.05em',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path d={isDepal
              ? "M12 20V8m0 0l-5 5m5-5l5 5"
              : "M12 4v12m0 0l-5-5m5 5l5-5"}
              stroke={badgeColor} strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          {badgeLabel}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {rows} × {cols} × {layers} = {total} slots
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Slot row {activeRow + 1}, col {activeCol + 1}, layer {activeLayer + 1}
        </div>
      </div>

      {/* Layer tabs */}
      {layers > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {Array.from({ length: layers }).map((_, i) => (
            <button key={i} onClick={() => setSelectedLayer(i)}
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 700,
                borderRadius: 6, cursor: 'pointer',
                background: selectedLayer === i ? badgeColor : '#f3f4f6',
                color:      selectedLayer === i ? '#fff'     : '#374151',
                border:     selectedLayer === i ? 'none'     : '1px solid #e5e7eb',
              }}>
              Layer {i + 1}{activeLayer === i ? ' •' : ''}
            </button>
          ))}
        </div>
      )}

      {/* Slot grid for the selected layer */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(28px, 44px))`,
        gridAutoRows: 'minmax(28px, 44px)',
        gap: 6, justifyContent: 'center',
        padding: 14, background: '#f8fafc', borderRadius: 8,
        border: '1px solid #e5e7eb', marginBottom: 12,
      }}>
        {Array.from({ length: rows }).map((_, r) =>
          Array.from({ length: cols }).map((__, c) => {
            const status = (slotState[selectedLayer] || {})[r + ',' + c] || 'pending'
            return (
              <div key={`${r}-${c}`} title={`Row ${r + 1}, Col ${c + 1} — ${status}`}
                style={{
                  borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700,
                  transition: 'background 200ms, box-shadow 200ms',
                  ...tileFor(status),
                }}>
                {status === 'done' ? '✓' : status === 'active' ? '●' : ''}
              </div>
            )
          })
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 13, color: '#374151', flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: '#111', fontVariantNumeric: 'tabular-nums' }}>{cycle}</strong> of{' '}
          <strong style={{ color: '#111', fontVariantNumeric: 'tabular-nums' }}>{total}</strong> done
        </div>
        <div style={{ color: '#9ca3af' }}>•</div>
        <div>
          approx {etaMin > 0 ? `${etaMin} min ` : ''}{etaRem} sec remaining
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#16A34A' }} />Done
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#2563EB', marginLeft: 8 }} />Active
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#e5e7eb', marginLeft: 8 }} />Pending
        </div>
      </div>
    </div>
  )
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
  const currentProgram     = useStore((s) => s.currentProgram)
  const setCurrentProgram  = useStore((s) => s.setCurrentProgram)
  const task               = useStore((s) => s.task)
  const safety             = useStore((s) => s.safety)
  const detectionsFromStore = useStore((s) => s.detections)
  const setTab             = useStore((s) => s.setTab)
  const addToast           = useStore((s) => s.addToast)

  const runProgram     = useStore((s) => s.runProgram)
  const pauseProgram   = useStore((s) => s.pauseProgram)
  const resumeProgram  = useStore((s) => s.resumeProgram)
  const cancelProgram  = useStore((s) => s.cancelProgram)
  const homeRobot      = useStore((s) => s.homeRobot)
  const robot          = useStore((s) => s.robot) || {}
  const runSpeedPct    = useStore((s) => s.runSpeedPct)
  const setRunSpeedPct = useStore((s) => s.setRunSpeedPct)

  // Change Program overlay state. The Program Library is rendered
  // inside a full-viewport modal here; onSelectProgram closes it and
  // makes the picked program the active one (without auto-starting).
  const [showLibrary, setShowLibrary] = useState(false)

  const onSelectProgram = async (prog) => {
    setShowLibrary(false)
    if (!prog || !prog.id) return
    try {
      const res = await fetch('/api/programs/' + encodeURIComponent(prog.id))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const full = await res.json()
      if (full && Array.isArray(full.steps)) {
        // Wholesale replace currentProgram so the Monitor (and the
        // 3D viewer's gripper subscription) re-renders against the
        // new program immediately.
        setCurrentProgram({
          id:          full.id,
          name:        full.name,
          description: full.description || '',
          steps:       full.steps,
          config:      full.config || {},
        })
        // Tell the executor about the new active program. action='load'
        // is treated as a frontend-facing 'set active'; the next Run
        // picks it up via the normal load+run flow.
        try {
          await fetch('/api/program/run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ action: 'load', program_id: full.id }),
          })
        } catch {}
        if (typeof addToast === 'function') {
          addToast('Loaded "' + (full.name || full.id) + '"', 'success')
        }
      }
    } catch (e) {
      if (typeof addToast === 'function') {
        addToast('Load failed: ' + (e?.message || e), 'error')
      }
    }
  }

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

  // Unified run-state — same helper the StatusBar footer and the
  // StepPreviewPanel consume, so pill / footer / banner never disagree.
  // See lib/runState.js for the precedence rules.
  const runState = deriveRunState({ robot, task, safety })
  const status = runState.kind   // kept for old code that keyed off the string
  const isRunning = runState.kind === 'running' || runState.kind === 'stopping'

  // Stuck-STOPPING detector. project/stop normally transitions the
  // controller state 2→3→0 in well under a second; if it sits at 3 for
  // >3s, either the driver's stop ack got dropped or the interpreter
  // stalled mid-motion. Surface a "Force stop / reset" affordance so
  // the operator isn't trapped without a way to unwedge.
  const [stoppingSince, setStoppingSince] = useState(null)
  const [nowTs, setNowTs] = useState(Date.now())
  useEffect(() => {
    if (runState.kind === 'stopping') {
      if (stoppingSince === null) setStoppingSince(Date.now())
    } else if (stoppingSince !== null) {
      setStoppingSince(null)
    }
  }, [runState.kind, stoppingSince])
  useEffect(() => {
    if (stoppingSince === null) return undefined
    const id = setInterval(() => setNowTs(Date.now()), 500)
    return () => clearInterval(id)
  }, [stoppingSince])
  const stuckStoppingMs = stoppingSince ? (nowTs - stoppingSince) : 0
  // Pure helper — unit-tested in src/lib/runState.test.js
  const isStuckStopping = _computeStuckStopping(runState.kind, stoppingSince, nowTs)

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

  // Enable/disable state machine — see README block above the button
  // row for the operator-facing summary.
  //
  //  Button      | idle | running | stopping | paused | estop | alarm
  //  ------------|------|---------|----------|--------|-------|------
  //  RUN         |  ✓   |    ·    |    ·     |   ·    |   ·   |   ·
  //  STOP        |  ·   |    ✓    |  ✓ (*)   |   ✓    |   ✓   |   ✓
  //  PAUSE       |  ·   |    ✓    |    ·     |   ·    |   ·   |   ·
  //  RESUME      |  ·   |    ·    |    ·     |   ✓    |   ·   |   ·
  //  RESTART     |  ✓   |    ✓    |    ✓     |   ✓    |   ·   |   ·
  //  HOME        |  ✓   |    ✓    |    ✓     |   ✓    |   ·   |   ·
  //  FORCE-STOP  |  ·   |    ·    | ✓ >3s    |   ·    |   ·   |   ·
  //
  // (*) STOP is intentionally exempt from the gate/estop/alarm greying
  //     that governs the other motion verbs — STOP works precisely when
  //     things are running or wedged. It is the only recovery affordance
  //     that must NEVER be unavailable while the arm is in motion.
  const runDisabled    = safety?.estop || runState.kind === 'running'
                          || runState.kind === 'stopping'
                          || runState.kind === 'paused'
  // Return Home: only disabled by estop. Gate/connection state is
  // surfaced by the confirm dialog so the operator can still ATTEMPT
  // (the driver will refuse with a specific reason if the gate is
  // closed — that's preferable to a greyed button the operator can't
  // reason about). Explicitly enabled during 'stopping' so the arm can
  // be returned home when a run wedges in state=3.
  const homeDisabled   = !!safety?.estop
  // Restart: enabled from any active state (running/stopping/paused)
  // AND from idle. The `restartProgram` helper below handles the
  // stop-then-run sequence when needed, so this button doubles as a
  // "get me unstuck by starting over" affordance during a wedged
  // STOPPING. Only estop or no-program disables it.
  const restartDisabled = !!safety?.estop
                          || !(currentProgram?.id)
                          || (steps.length === 0)
  const pauseDisabled  = runState.kind !== 'running' || safety?.estop
  // STOP: NEVER disabled by gate/estop — only by "there's nothing to
  // stop" (idle without a program-execution state). Estop path is
  // still permitted because the driver's stop verb is safe to send
  // repeatedly and won't itself move the arm — sending it when the
  // controller is already halted is a no-op that clears bookkeeping.
  // Uses the unit-tested isStopButtonEnabled helper so JSX and tests
  // agree on the rule.
  const stopDisabled   = !isStopButtonEnabled(runState.kind)

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
          <StatusBadge runState={runState} />
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
            {/* Live indicator from the Estun driver's publish/ProjectState
                mirror (STATE.robot.program). Renders whenever the driver
                reports state=2 (running) OR the operator is single-stepping.
                This is the ground truth from the controller, distinct from
                the sim executor's task.program_step. */}
            {(robot?.program?.state === 2 || robot?.program?.is_step) && (
              <div style={{
                marginTop: 8, padding: '8px 12px',
                background: '#F0FDF4', border: '1px solid #16A34A',
                borderRadius: 6, fontSize: 13, color: '#065F46',
                fontFamily: 'monospace',
              }}>
                <b>Estun:</b>{' '}
                state={robot.program.state}{' '}
                {robot.program.is_step ? '(single-step)' : '(auto)'}{' '}
                &middot; task={robot.program.task ?? '—'}{' '}
                &middot; line={robot.program.line ?? '—'}{' '}
                {robot.program.project_id && (
                  <> &middot; project={robot.program.project_id}</>
                )}
              </div>
            )}
            {/* Live step-preview panel — highlights the currently-executing
                step from publish/ProjectState.line. Only appears when
                the current program has steps. Collapsible; header shows
                "Step N / M" summary when collapsed. */}
            <StepPreviewPanel />
          </div>

          {/* Speed entry — editable integer % (1-100). Truth-in-UI:
              driver caps at operator_speed_limit (policy ceiling
              raised to 65% on 2026-07-22). We show the effective %
              right next to the box so entering above the cap doesn't
              silently accept an unhonored value. */}
          <ProgramSpeedEntry
            value={runSpeedPct}
            setValue={setRunSpeedPct}
            operatorCapFrac={robot?.operator_speed_limit}
          />

          {/* Mid-run speed control — only appears while a program is
              actively running. Publishes /api/estun/program/speed
              which clamps via operator_speed_limit and requires an
              explicit confirm for INCREASES above
              high_speed_confirm_threshold_pct (default 40). */}
          {isRunning && (
            <MidRunSpeedControl
              robot={robot}
              addToast={addToast}
            />
          )}

          {/* Recovery banner — appears when the controller has been
              STOPPING (state=3) for more than 3s. Offers Force stop
              (re-issues project/stop) + Clear alarms (System/ClearError)
              so the operator can escape a wedged stop without hunting
              for the button on another screen. */}
          {isStuckStopping && (
            <div style={{
              marginTop: 16, padding: 12,
              background: '#FEF3C7', border: '1px solid #F59E0B',
              borderRadius: 8, color: '#92400E', fontSize: 14,
              display: 'flex', alignItems: 'center', gap: 12,
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>
                  Controller wedged in STOPPING for {Math.floor(stuckStoppingMs / 1000)}s
                </div>
                <div style={{ fontSize: 12 }}>
                  project/stop should transition 2→3→0 in under a second.
                  Force-stop re-issues the verb; Reset also clears any
                  latched controller error so Home / Restart can proceed.
                </div>
              </div>
              <button onClick={() => forceStop({ addToast })}
                      style={{
                        padding: '10px 18px', fontSize: 14, fontWeight: 700,
                        background: '#DC2626', color: '#fff', border: 'none',
                        borderRadius: 8, cursor: 'pointer',
                      }}>
                ✕ Force stop
              </button>
              <button onClick={() => forceReset({ addToast })}
                      style={{
                        padding: '10px 18px', fontSize: 14, fontWeight: 700,
                        background: '#B45309', color: '#fff', border: 'none',
                        borderRadius: 8, cursor: 'pointer',
                      }}>
                ⟲ Reset (stop + clear alarms)
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
            {/* STOP — prominent, always visible when the program is in
                ANY active state (running / stopping / paused / alarm).
                Deliberately exempt from the gate-open/estop-clear checks
                that grey out the other motion verbs; STOP works precisely
                when things are running or wedged, so its enable-state
                must never depend on the same conditions that got the
                arm into trouble. */}
            {!stopDisabled && (
              <button onClick={cancelProgram}
                      title="project/stop — wire-proven rung 1 (always enabled while active)"
                      style={{
                        ...primaryBtn('#DC2626', false),
                        boxShadow: '0 0 0 3px rgba(220,38,38,0.15)',
                        fontSize: 17, minWidth: 140,
                      }}>
                ✕ STOP
              </button>
            )}
            {status === 'paused' && (
              <button onClick={resumeProgram} disabled={safety?.estop}
                style={primaryBtn('#16A34A', safety?.estop)}>
                ▶ Resume
              </button>
            )}
            {status === 'running' && (
              <button onClick={pauseProgram} disabled={pauseDisabled}
                title="project/pause — SOURCE-ONLY (behavior not yet wire-proven)"
                style={primaryBtn('#CA8A04', pauseDisabled)}>
                ⏸ Pause*
              </button>
            )}
            {!(status === 'running' || status === 'paused' || status === 'stopping') && (
              <button onClick={runProgram} disabled={runDisabled || steps.length === 0}
                style={primaryBtn('#16A34A', runDisabled || steps.length === 0)}>
                ▶ Run Program
              </button>
            )}
            {/* RESTART PROGRAM — stops the running program (project/stop,
                wire-proven) then re-invokes the same run path the Run
                button uses (POST /api/estun/program/run — codegen →
                save → project/run, with clearStartLine already inside
                that endpoint so it starts at step 1). Also works from
                stuck-STOPPING: the stop-then-run sequence handles the
                wedge (and forceReset() from the recovery banner can
                clear a latched alarm first if needed). */}
            <button onClick={() => restartProgram({
                              cancelProgram, currentProgram, runSpeedPct,
                              robot, isRunning, isStuckStopping, addToast,
                            })}
                    disabled={restartDisabled}
                    title="project/stop (if running) → /api/estun/program/run — restart from step 1"
                    style={primaryBtn('#0369A1', restartDisabled)}>
              ↻ Restart Program
            </button>
            {/* RETURN HOME — same store action the Jog panel's Home
                button uses (homeRobot → /api/program/run action='home'
                → executor → /cmd/task home). Confirms every press
                because it commands motion; the confirm surfaces gate/
                connection state so the operator knows whether the
                driver will honor it. Enabled during stuck-STOPPING too
                so the arm can be recovered from a wedged run. */}
            <button onClick={() => returnHome({
                              homeRobot, robot, runSpeedPct, safety,
                              runStateKind: runState.kind,
                              isStuckStopping, addToast,
                            })}
                    disabled={homeDisabled}
                    title="/api/program/run action='home' — dispatches to the executor"
                    style={primaryBtn('#0891B2', homeDisabled)}>
              ⌂ Return Home
            </button>
            <button onClick={() => setShowLibrary(true)} style={{
              padding: '14px 24px', fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            }}>
              Change Program
            </button>
            <button onClick={() => setTab('program')} style={{
              padding: '14px 24px', fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            }}>
              Edit Program
            </button>
          </div>

          {/* Provenance badge + description below the step indicator.
              Badge reads from the authoritative `source` field on the
              stored /opt/cobot/programs/{id}.json (also computed by
              backend inference for pre-provenance-field files, so
              older programs still get labeled correctly). Description
              gets the stale "poses pending perception" caveat filtered
              OUT when the backend flag has_taught_poses is true. */}
          <ProgramProvenance program={currentProgram} />
          {(() => {
            const desc = currentProgram?.description
            if (!desc) return null
            // Strip the stale caveat when poses are actually taught.
            // The backend sends has_taught_poses on the GET response;
            // it's a snapshot boolean, not stored persistently.
            const stripCaveat = currentProgram?.has_taught_poses === true
            const filtered = stripCaveat
              ? desc.replace(/^(?:PBD draft — |Generated from demonstration — )?poses pending perception\.\s*/i, '')
              : desc
            if (!filtered.trim()) return null
            return (
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 12, lineHeight: 1.4 }}>
                {filtered.trim()}
              </div>
            )
          })()}
        </div>

        {/* Top-right: compact 200×200 target part viewer.
            TopPartViewer self-hides when no target_part / no STL is
            available, so the left block reclaims the row width. */}
        <TopPartViewer partId={targetPartId} />
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard label="Speed" value={speedPct} unit="%" color="#2563EB" />
        <StatCard label="Cycle Count" value={cycleCount} color="#16A34A" />
        <StatCard label="Last Cycle Time" value={lastCycleTime ?? '—'} unit={lastCycleTime ? 's' : ''} color="#374151" />
        <StatCard label="Objects Detected" value={detectionCount} color="#9333EA" />
      </div>

      {/* Pallet progress — hidden unless the executor is publishing
          pallet_mode on /task/state for the active program. */}
      <PalletProgressWidget
        task={task}
        programConfig={programConfig}
        lastCycleTime={lastCycleTime}
      />

      {/* Production stats: parts picked + cycle results + LiDAR identifications */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <PickCounter />
        <CycleResults />
        <IdentifiedObjectsCard />
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

      {/* No-program placeholder. The previous "Program Steps" panel
          (progress bar + numbered step grid) was removed; only the
          empty-state hint remains so a fresh operator knows where to
          load a program from. */}
      {steps.length === 0 && (
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

      {/* Change Program overlay — full-viewport modal wrapping the
          shared ProgramLibrary component. The onSelectProgram prop
          routes program clicks back into our load-and-set handler
          instead of the library's default Edit/Duplicate/Delete
          details modal. */}
      {showLibrary && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowLibrary(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <div style={{
            width: '95%', maxWidth: 1100, height: '90vh',
            background: '#f8fafc', borderRadius: 16, overflow: 'hidden',
            boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
            display: 'flex', flexDirection: 'column',
            position: 'relative',
          }}>
            <div style={{
              padding: '14px 20px', borderBottom: '1px solid #e5e7eb',
              display: 'flex', alignItems: 'center', background: '#fff',
            }}>
              <div style={{ fontSize: 13, color: '#6b7280', flex: 1 }}>
                Pick a program to load as the active program
              </div>
              <button onClick={() => setShowLibrary(false)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 18, color: '#9ca3af', padding: '2px 8px',
              }} title="Close">X</button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <ProgramLibrary onSelectProgram={onSelectProgram} />
            </div>
          </div>
        </div>
      )}

      {/* Run-confirm modal (opens when the operator presses Run) and
          program error modal (opens on driver-side publish/Error
          transitions, deduped by the driver's ErrorDedup at ~3 Hz). */}
      <RunProgramModal />
      <ProgramErrorModal />
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

// Return-Home confirm. Reads the driver's advertised operator cap so
// the operator sees the actual effective speed before pressing OK.
// Uses window.confirm so it works without adding a modal component —
// same pattern as other destructive-motion prompts on this dashboard.
// Extra prompt copy when firing from stuck-STOPPING so the operator
// knows the wedge-recovery flow.
function returnHome({ homeRobot, robot, runSpeedPct, safety, runStateKind, isStuckStopping, addToast }) {
  const capFrac = Number(robot?.operator_speed_limit ?? 0.25)
  const capPct  = Math.max(1, Math.min(100, Math.round(capFrac * 100)))
  const reqPct  = Math.max(1, Math.min(100, Number(runSpeedPct || capPct)))
  const effPct  = Math.min(capPct, reqPct)
  const gateOK  = !safety?.estop && !!robot?.connected && !!robot?.allow_move
  const lines = [
    isStuckStopping
      ? 'Move to home from STUCK-STOPPING state?'
      : (runStateKind === 'stopping' ? 'Move to home from STOPPING state?' : 'Move to home?'),
    '',
    `Effective speed: ${effPct}%${effPct < reqPct ? ` (capped from ${reqPct}%)` : ''}`,
    `Gate: allow_move=${robot?.allow_move ? 'true' : 'false'}, ` +
      `monitor_only=${robot?.monitor_only ? 'true' : 'false'}, ` +
      `connected=${robot?.connected ? 'true' : 'false'}` +
      (safety?.estop ? ', ESTOP ACTIVE' : ''),
    '',
  ]
  if (isStuckStopping) {
    lines.push(
      'Controller has been in STOPPING >3s — the previous run may not',
      'have cleared. If Home is refused with a "state busy" reason, use',
      'the yellow "Reset" button first to clear alarms, then retry.',
      ''
    )
  }
  lines.push(
    gateOK
      ? 'OK to send home command.'
      : 'Gate is closed — the driver will refuse this. Press OK to try anyway.'
  )
  if (!window.confirm(lines.join('\n'))) return
  try { homeRobot() }
  catch (e) { if (addToast) addToast('Home dispatch failed: ' + e, 'error') }
}

// Restart-Program: stop-if-running then re-invoke the same run pipeline
// the Run button uses. The /api/estun/program/run endpoint already
// contains clearStartLine, so this restarts from step 1 by default.
// Confirms in any active state (running / stopping / paused) — a
// mid-run restart is destructive. Wedge-recovery: when the controller
// is stuck in STOPPING, the confirm surfaces that explicitly and the
// stop-then-run sequence still fires (the second stop is cheap; the
// run request re-establishes the pipeline from a known state).
async function restartProgram({ cancelProgram, currentProgram, runSpeedPct, robot, isRunning, isStuckStopping, addToast }) {
  const name = currentProgram?.name || currentProgram?.id || '(current)'
  const reqPct = Math.max(1, Math.min(100, Number(runSpeedPct || 10)))
  const capFrac = Number(robot?.operator_speed_limit ?? 0.25)
  const capPct  = Math.max(1, Math.min(100, Math.round(capFrac * 100)))
  const effPct  = Math.min(capPct, reqPct)
  if (isRunning || isStuckStopping) {
    const prompt = [
      isStuckStopping
        ? `Restart "${name}" from step 1? (recovering STUCK-STOPPING)`
        : `Restart "${name}" from step 1?`,
      '',
      isStuckStopping
        ? 'The controller has been in STOPPING >3s. Restart will:'
        : 'The program is currently RUNNING. This will:',
      '  1. Send project/stop (safe to re-issue if already stopping)',
      '  2. Re-save + re-run the program from the top',
      '',
      `Effective speed: ${effPct}%${effPct < reqPct ? ` (capped from ${reqPct}%)` : ''}`,
    ]
    if (isStuckStopping) {
      prompt.push('',
        'If restart is refused with a "state busy" reason, use the',
        'yellow "Reset" button in the recovery banner to clear alarms first.'
      )
    }
    if (!window.confirm(prompt.join('\n'))) return
  }
  try {
    if (isRunning || isStuckStopping) {
      // project/stop first — wire-proven rung 1. Give the driver a
      // beat to publish the state=0 transition before re-invoking
      // run, otherwise the two ops race on the controller.
      try { await cancelProgram() } catch (_) { /* fall through */ }
      await new Promise((r) => setTimeout(r, 350))
    }
    const res = await fetch('/api/estun/program/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        program_id: currentProgram?.id,
        run_speed_pct: reqPct,
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (body?.ok) {
      if (addToast) addToast(`Restarted "${name}" from step 1`, 'success')
    } else {
      const reason = body?.outcome?.reason || body?.error || `HTTP ${res.status}`
      if (addToast) addToast(`Restart refused: ${reason}`, 'error')
    }
  } catch (e) {
    if (addToast) addToast(`Restart failed: ${e}`, 'error')
  }
}

// Recovery from a stuck STOPPING (state=3 > 3s). Force-stop just
// re-issues project/stop — the driver treats a repeat stop as an ack
// re-request, which resolves a "the driver's stop ack got dropped by
// the ROS transport" wedge without any operator side effect.
async function forceStop({ addToast }) {
  try {
    const res = await fetch('/api/estun/program/stop', { method: 'POST' })
    if (res.ok) {
      if (addToast) addToast('Force-stop sent (project/stop re-issued)', 'info')
    } else {
      if (addToast) addToast(`Force-stop refused: HTTP ${res.status}`, 'error')
    }
  } catch (e) {
    if (addToast) addToast(`Force-stop failed: ${e}`, 'error')
  }
}

// Reset = force-stop + clear latched controller alarms. Used when the
// wedge is caused by a latched error (alarm 10001, ESTOP release, etc.)
// blocking the 3→0 transition. clear_error is wire-proven; safe to
// send when there's no active error.
async function forceReset({ addToast }) {
  try {
    await fetch('/api/estun/program/stop', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 150))
    const res = await fetch('/api/estun/program/clear_error', { method: 'POST' })
    if (res.ok) {
      if (addToast) addToast('Reset: stop re-issued + alarms cleared', 'success')
    } else {
      if (addToast) addToast(`Reset partial: clear_error HTTP ${res.status}`, 'error')
    }
  } catch (e) {
    if (addToast) addToast(`Reset failed: ${e}`, 'error')
  }
}

// Editable "Program speed" input + inline truth-in-UI effective %.
// - Enter/blur commits (uses store.setRunSpeedPct which does the
//   clamp + toast on invalid).
// - Displays "X%" plain, OR "X% → effective Y%" if the driver's
//   operator_speed_limit would cap it. The box's ceiling is 100 but
//   the operator sees exactly what the driver will honor.
// - When the driver isn't reporting (fresh page-load / disconnect),
//   we conservatively assume a 25% cap so the display doesn't lie in
//   the other direction.
function ProgramSpeedEntry({ value, setValue, operatorCapFrac }) {
  const [local, setLocal] = useState(String(value))

  // Keep the input reflecting store changes (program load, toast-
  // clamp). Only overwrite the visible text when it doesn't match
  // the store — otherwise the user's mid-typing would flicker.
  useEffect(() => {
    if (String(value) !== local) setLocal(String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const capFrac = Number.isFinite(operatorCapFrac) ? operatorCapFrac : 0.25
  const capPct  = Math.max(1, Math.min(100, Math.round(capFrac * 100)))
  const eff     = Math.max(1, Math.min(capPct, value))
  const capped  = value > capPct

  const commit = () => {
    const applied = setValue(local)
    setLocal(String(applied))
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      marginTop: 12,
    }}>
      <label style={{
        fontSize: 12, color: '#6b7280',
        fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        Speed
      </label>
      <input
        type="number"
        min={1}
        max={100}
        step={1}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        style={{
          width: 72, padding: '6px 10px',
          fontSize: 15, fontWeight: 600,
          border: '1px solid #d1d5db', borderRadius: 8,
          textAlign: 'right',
        }}
      />
      <span style={{ fontSize: 13, color: '#6b7280' }}>%</span>
      <span style={{
        fontSize: 13, marginLeft: 6,
        color: capped ? '#B45309' : '#059669',
        fontWeight: 600,
      }}>
        {capped
          ? `effective ${eff}% (cap ${capPct}%)`
          : `effective ${eff}% (cap ${capPct}%)`}
      </span>
    </div>
  )
}

// Mid-run auto-mode speed adjustment. Only rendered while
// deriveRunState says the program is running; posts to
// /api/estun/program/speed which returns 409 with
// {needs_confirm:true} when the requested increase exceeds the
// driver's high_speed_confirm_threshold_pct. On 409 we show the
// strong "High speed" confirm modal; on OK the local input updates
// to the effective (possibly-capped) value.
function MidRunSpeedControl({ robot, addToast }) {
  const capFrac = Number.isFinite(robot?.operator_speed_limit) ? robot.operator_speed_limit : 0.25
  const capPct  = Math.max(1, Math.min(100, Math.round(capFrac * 100)))
  const threshold = Number.isFinite(robot?.high_speed_confirm_threshold_pct)
    ? robot.high_speed_confirm_threshold_pct
    : 40
  const [input, setInput] = useState(String(Math.min(capPct, 10)))
  const [busy, setBusy]   = useState(false)
  const [pending, setPending] = useState(null)   // {pct, threshold} on 409

  async function submit(pct, confirmed) {
    setBusy(true)
    try {
      const res = await fetch('/api/estun/program/speed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct, confirmed_high_speed: !!confirmed }),
      })
      const body = await res.json()
      if (res.status === 409 && body?.needs_confirm) {
        setPending({ pct: body.effective_pct, threshold: body.threshold_pct })
        return
      }
      if (!res.ok || !body?.ok) {
        addToast(`Speed change refused: ${body?.reason || body?.error || res.status}`, 'error')
        return
      }
      const applied = body.effective_pct
      setInput(String(applied))
      addToast(
        body.capped
          ? `Program speed set to ${applied}% (capped from ${pct}%)`
          : `Program speed set to ${applied}%`,
        'info',
      )
      setPending(null)
    } catch (e) {
      addToast(`Speed change failed: ${e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  function onApply() {
    const n = Number(input)
    if (!Number.isFinite(n) || n < 1) {
      addToast('Speed must be an integer 1..100', 'warning'); return
    }
    submit(Math.round(n), false)
  }

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        marginTop: 8, padding: '8px 12px',
        background: '#FFFBEB', border: '1px solid #F59E0B',
        borderRadius: 8,
      }}>
        <span style={{
          fontSize: 12, color: '#92400E', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          Mid-run speed
        </span>
        <input
          type="number" min={1} max={100} step={1}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onApply() } }}
          style={{
            width: 72, padding: '6px 10px', fontSize: 15, fontWeight: 600,
            border: '1px solid #d1d5db', borderRadius: 8, textAlign: 'right',
          }}
        />
        <span style={{ fontSize: 13, color: '#92400E' }}>%</span>
        <button
          onClick={onApply}
          disabled={busy}
          style={{
            padding: '6px 14px', fontSize: 14, fontWeight: 600,
            background: busy ? '#9CA3AF' : '#B45309', color: '#fff',
            border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
          }}>
          Apply
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: '#92400E' }}>
          cap {capPct}% · high-speed confirm above {threshold}%
        </span>
      </div>

      {pending && (
        <HighSpeedConfirmModal
          pct={pending.pct}
          threshold={pending.threshold}
          cap={capPct}
          onCancel={() => setPending(null)}
          onConfirm={() => submit(pending.pct, true)}
        />
      )}
    </>
  )
}

function HighSpeedConfirmModal({ pct, threshold, cap, onCancel, onConfirm }) {
  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const panel = {
    background: '#fff', borderRadius: 12, padding: 24,
    minWidth: 440, maxWidth: 520,
    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
    borderTop: '4px solid #DC2626',
  }
  return (
    <div style={backdrop} onClick={onCancel}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#7F1D1D', marginBottom: 10 }}>
          High speed: increase to {pct}%?
        </div>
        <div style={{ fontSize: 14, color: '#374151', marginBottom: 12 }}>
          You are increasing the program's auto-mode speed above the
          high-speed threshold ({threshold}%). Ensure the cell is
          clear before confirming.
        </div>
        <div style={{
          padding: 10, background: '#FEE2E2',
          border: '1px solid #DC2626', borderRadius: 6,
          fontSize: 13, color: '#7F1D1D', marginBottom: 16,
        }}>
          New effective speed: <b>{pct}%</b> &nbsp;·&nbsp; policy cap: {cap}%
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '10px 18px', fontSize: 15, fontWeight: 600,
            background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={onConfirm} style={{
            padding: '10px 18px', fontSize: 15, fontWeight: 700,
            background: '#DC2626', color: '#fff',
            border: 'none', borderRadius: 8, cursor: 'pointer',
          }}>Confirm — Run at {pct}%</button>
        </div>
      </div>
    </div>
  )
}

// Provenance badge + PBD-metadata detail row. Reads the `source`
// field on the loaded program (backend backfills it via
// _infer_source() for older files that predate the field). Color-
// coded so a demonstration-derived program is visually distinct
// from a hand-built one — matters most during authoring where an
// operator might have loaded the wrong program.
function ProgramProvenance({ program }) {
  if (!program?.id) return null
  const source = program.source || 'unknown'
  const badgeStyle = {
    demonstration: { bg: '#EDE9FE', border: '#7C3AED', text: '#5B21B6', label: 'Demonstration' },
    manual:        { bg: '#ECFDF5', border: '#059669', text: '#065F46', label: 'Manual build' },
    imported:      { bg: '#EFF6FF', border: '#2563EB', text: '#1E40AF', label: 'Imported' },
    unknown:       { bg: '#F3F4F6', border: '#9CA3AF', text: '#4B5563', label: 'Unknown source' },
  }[source] || { bg: '#F3F4F6', border: '#9CA3AF', text: '#4B5563', label: source }

  const cfg = program.config || {}
  const pbd = cfg.pbd_metadata || null
  const detail = pbd?.demo_id ? `demo ${pbd.demo_id}` : null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
      <span style={{
        display: 'inline-block', padding: '3px 10px',
        background: badgeStyle.bg,
        border: `1px solid ${badgeStyle.border}`,
        color: badgeStyle.text, borderRadius: 999,
        fontSize: 12, fontWeight: 600,
      }}>
        {badgeStyle.label}
      </span>
      {detail && (
        <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>
          {detail}
        </span>
      )}
      {program.has_taught_poses === false && (
        <span style={{
          fontSize: 12, color: '#B45309', fontWeight: 600,
          marginLeft: 6,
        }}>
          — poses pending
        </span>
      )}
    </div>
  )
}

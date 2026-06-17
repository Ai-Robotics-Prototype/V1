import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { useCellWizardStore } from '../store/cellWizardStore'
import BoundsTopDownEditor, { normalizeBounds, serializeBounds } from './BoundsTopDownEditor'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'
const MAX_PTS  = 131072

// ─────────────────────────────────────────────────────────────────────────
// Shared 3D primitives
// ─────────────────────────────────────────────────────────────────────────

function heightColor(z) {
  if (z < 0.1) return [0.15, 0.35, 0.85]
  if (z < 0.5) return [0.15, 0.75, 0.50]
  if (z < 1.0) return [0.85, 0.75, 0.10]
  return         [0.85, 0.25, 0.15]
}

// Cloud rendered from a JSON payload {n, p:[x0,y0,z0,...]}. Used for the
// SAVED baseline. Uploaded to GPU once.
function StaticPoints({ data, color }) {
  const geoRef = useRef(new THREE.BufferGeometry())
  const upRef  = useRef(0)
  useEffect(() => {
    if (!data) return
    const n = Math.min(data.n || 0, MAX_PTS)
    const positions = new Float32Array(n * 3)
    const colors    = new Float32Array(n * 3)
    const p = data.p
    for (let i = 0; i < n; i++) {
      const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2]
      // LiDAR (x,y,z) -> Three (x, z, -y) — handedness-preserving, matches
      // LidarPanel/ArmViewer3D. The -y prevents the left/right mirror.
      positions[i * 3] = px
      positions[i * 3 + 1] = pz
      positions[i * 3 + 2] = -py
      const c = color || heightColor(pz)
      colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2]
    }
    const g = geoRef.current
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color',    new THREE.BufferAttribute(colors, 3))
    g.setDrawRange(0, n)
    upRef.current++
  }, [data, color])
  return (
    <points>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial size={0.005} vertexColors />
    </points>
  )
}

// Cloud rendered from a live ref updated by /ws/lidar. Per-frame upload.
function LivePoints({ pointsRef, color }) {
  const geoRef    = useRef(new THREE.BufferGeometry())
  const posBufRef = useRef(new Float32Array(MAX_PTS * 3))
  const colBufRef = useRef(new Float32Array(MAX_PTS * 3))
  useEffect(() => {
    const g = geoRef.current
    g.setAttribute('position', new THREE.BufferAttribute(posBufRef.current, 3))
    g.setAttribute('color',    new THREE.BufferAttribute(colBufRef.current, 3))
    g.setDrawRange(0, 0)
  }, [])
  useFrame(() => {
    const d = pointsRef.current
    if (!d) return
    const positions = posBufRef.current
    const colors    = colBufRef.current
    let n = 0
    if (d.binary && d.floats) {
      const f = d.floats
      n = Math.min(d.n, MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = f[i * 3], py = f[i * 3 + 1], pz = f[i * 3 + 2]
        // LiDAR -> Three (x, z, -y) — handedness-preserving.
        positions[i * 3] = px
        positions[i * 3 + 1] = pz
        positions[i * 3 + 2] = -py
        const c = color || heightColor(pz)
        colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2]
      }
    } else if (Array.isArray(d.p) && typeof d.n === 'number') {
      const p = d.p
      n = Math.min(d.n, MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2]
        positions[i * 3] = px
        positions[i * 3 + 1] = pz
        positions[i * 3 + 2] = -py
        const c = color || heightColor(pz)
        colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2]
      }
    } else return
    const g = geoRef.current
    g.setDrawRange(0, n)
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate    = true
  })
  return (
    <points>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial size={0.005} vertexColors />
    </points>
  )
}

function BoundsBox({ bounds }) {
  if (!bounds) return null
  const cx = (bounds.x_min + bounds.x_max) / 2
  const cy = (bounds.y_min + bounds.y_max) / 2
  const cz = (bounds.z_min + bounds.z_max) / 2
  const sx = Math.max(0.01, bounds.x_max - bounds.x_min)
  const sy = Math.max(0.01, bounds.y_max - bounds.y_min)
  const sz = Math.max(0.01, bounds.z_max - bounds.z_min)
  return (
    <mesh position={[cx, cz, cy]}>
      <boxGeometry args={[sx, sz, sy]} />
      <meshBasicMaterial color="#2563EB" wireframe transparent opacity={0.6} />
    </mesh>
  )
}

function CloudViewer({ baselineData, livePointsRef, showLive, showBaseline, bounds, height = 280 }) {
  return (
    <div style={{
      height, background: '#0f172a',
      borderRadius: 10, overflow: 'hidden',
      border: '1px solid var(--border)',
    }}>
      <Canvas camera={{ position: [2.5, 2.0, 2.5], fov: 50 }}>
        <ambientLight intensity={0.6} />
        <gridHelper args={[4, 16, '#334155', '#1e293b']} />
        <axesHelper args={[0.4]} />
        {showBaseline && baselineData && <StaticPoints data={baselineData} />}
        {showLive && <LivePoints pointsRef={livePointsRef} color={[0.95, 0.55, 0.10]} />}
        {bounds && <BoundsBox bounds={bounds} />}
        <OrbitControls />
      </Canvas>
    </div>
  )
}

// /ws/lidar subscription. Returns a pointsRef + status.
function useLiveLidar() {
  const pointsRef = useRef(null)
  const [live, setLive] = useState(false)
  const [livePointCount, setLivePointCount] = useState(0)
  useEffect(() => {
    const url = `${WS_PROTO}://${HOST}/ws/lidar`
    let ws
    let alive = true
    try { ws = new WebSocket(url) }
    catch { return () => {} }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const j = JSON.parse(ev.data)
          if (Array.isArray(j.p) && typeof j.n === 'number') {
            pointsRef.current = j; setLive(true); setLivePointCount(j.n)
          }
        } catch {}
      } else {
        const view = new DataView(ev.data)
        const n = view.getUint32(0, true)
        const floats = new Float32Array(ev.data, 4, n * 3)
        pointsRef.current = { binary: true, floats, n }
        setLive(true); setLivePointCount(n)
      }
    }
    ws.onclose = () => alive && setLive(false)
    ws.onerror = () => alive && setLive(false)
    return () => { alive = false; try { ws.close() } catch {} }
  }, [])
  return { pointsRef, live, livePointCount }
}

// ─────────────────────────────────────────────────────────────────────────
// Section frame + indicators
// ─────────────────────────────────────────────────────────────────────────

function SavedDot({ cellId, section }) {
  const dirty = useCellWizardStore((s) => !!s.panelDirty?.[cellId]?.[section])
  const savedAt = useCellWizardStore((s) => s.panelSaved?.[cellId]?.[section] || 0)
  const flashing = Date.now() - savedAt < 1800
  const [, force] = useState(0)
  useEffect(() => {
    if (!flashing) return
    const t = setTimeout(() => force((x) => x + 1), 1800)
    return () => clearTimeout(t)
  }, [flashing])
  const color = dirty ? '#f59e0b' : (flashing ? '#16A34A' : 'transparent')
  const label = dirty ? 'Unsaved' : (flashing ? 'Saved' : '')
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 10, color: dirty ? '#92400e' : '#166534',
      opacity: dirty || flashing ? 1 : 0, transition: 'opacity 200ms',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

function Section({ title, children, dirtySlot }) {
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 10,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>{title}</div>
        {dirtySlot}
      </div>
      {children}
    </div>
  )
}

const inputStyle = {
  background: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 4, color: 'var(--text-primary)',
  padding: '6px 10px', fontSize: 13, outline: 'none',
}

const smallBtn = (bg, fg = '#fff') => ({
  background: bg, color: fg, border: 'none',
  padding: '5px 10px', fontSize: 11, fontWeight: 600,
  borderRadius: 4, cursor: 'pointer',
})

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1 — Name + status + active toggle + delete
// ─────────────────────────────────────────────────────────────────────────

function SectionName({ cell, onChanged, onDeleted }) {
  const setDirty   = useCellWizardStore((s) => s.setSectionDirty)
  const markSaved  = useCellWizardStore((s) => s.markSectionSaved)
  const [draftName, setDraftName] = useState(cell.name || '')
  useEffect(() => { setDraftName(cell.name || '') }, [cell.cell_id, cell.name])

  const dirty = draftName.trim() !== (cell.name || '').trim()
  useEffect(() => { setDirty(cell.cell_id, 'name', dirty) }, [dirty, cell.cell_id, setDirty])

  const saveName = async () => {
    if (!dirty || !draftName.trim()) return
    try {
      await fetch(`/api/cells/${cell.cell_id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draftName.trim() }),
      })
      markSaved(cell.cell_id, 'name')
      onChanged?.()
    } catch {}
  }

  const activate = async () => {
    await fetch(`/api/cells/${cell.cell_id}/activate`, { method: 'POST' })
    markSaved(cell.cell_id, 'active')
    onChanged?.()
  }

  const del = async () => {
    if (!confirm(`Delete cell "${cell.name}"? Profile + baseline cloud will be removed.`)) return
    await fetch(`/api/cells/${cell.cell_id}`, { method: 'DELETE' })
    onDeleted?.()
  }

  return (
    <Section title="Cell name & status" dirtySlot={<SavedDot cellId={cell.cell_id} section="name" />}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') saveName() }}
          style={{ ...inputStyle, flex: 1, fontSize: 14, padding: '8px 12px' }}
        />
        <button onClick={saveName} disabled={!dirty || !draftName.trim()}
          style={smallBtn(dirty ? '#16A34A' : '#475569')}>
          ✓ Save name
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: cell.commissioning_complete ? '#dcfce7' : '#fef3c7',
          color:      cell.commissioning_complete ? '#166534' : '#92400e',
        }}>
          {cell.commissioning_complete ? 'Commissioned' : 'Incomplete'}
        </span>
        {cell.is_active ? (
          <span style={{ fontSize: 11, color: '#16A34A', fontWeight: 600 }}>● Active cell</span>
        ) : (
          <button onClick={activate} style={smallBtn('#2563EB')}>Activate this cell</button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Created {cell.created_at || '—'} · Updated {cell.updated_at || '—'}
        </span>
        <button onClick={del} style={smallBtn('#DC2626')}>Delete cell</button>
      </div>
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2 — Programs (open / edit / duplicate / remove / reassign)
// ─────────────────────────────────────────────────────────────────────────

function SectionPrograms({ cell, allCells, onChanged }) {
  const setLoadedProgram = useStore((s) => s.setLoadedProgram)
  const setTab           = useStore((s) => s.setTab)
  const addToast         = useStore((s) => s.addToast)

  const [programs, setPrograms] = useState(null)
  const [reassignBusy, setReassignBusy] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/cells/${cell.cell_id}/programs`)
      const j = await r.json()
      setPrograms(j.programs || [])
    } catch {
      setPrograms([])
    }
  }, [cell.cell_id])
  useEffect(() => { refresh() }, [refresh])

  const openInEditor = async (progId) => {
    try {
      const r = await fetch('/api/programs/' + encodeURIComponent(progId))
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const prog = await r.json()
      setLoadedProgram(prog)
      setTab('program')
      addToast(`Loaded "${prog.name}" into editor`, 'success')
    } catch (e) {
      addToast('Open failed: ' + (e.message || e), 'error')
    }
  }

  const duplicate = async (progId) => {
    try {
      const r = await fetch('/api/programs/' + encodeURIComponent(progId) + '/duplicate', { method: 'POST' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      addToast('Duplicated', 'success')
      refresh(); onChanged?.()
    } catch (e) {
      addToast('Duplicate failed: ' + (e.message || e), 'error')
    }
  }

  const reassign = async (progId, newCellId) => {
    setReassignBusy(progId)
    try {
      const body = newCellId ? { cell_id: newCellId } : { cell_id: null }
      const r = await fetch('/api/programs/' + encodeURIComponent(progId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      addToast(newCellId
        ? `Reassigned to "${allCells.find((c) => c.cell_id === newCellId)?.name || newCellId}"`
        : 'Removed from this cell', 'success')
      refresh(); onChanged?.()
    } catch (e) {
      addToast('Reassign failed: ' + (e.message || e), 'error')
    }
    setReassignBusy(null)
  }

  const count = programs?.length ?? 0
  return (
    <Section title={`Associated programs (${count})`}>
      {programs === null && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
      )}
      {programs && programs.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No programs assigned to this cell yet.
        </div>
      )}
      {programs && programs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {programs.map((p) => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {p.steps} step{p.steps === 1 ? '' : 's'} · last updated {p.updated || '—'}
                </div>
              </div>
              <button onClick={() => openInEditor(p.id)} style={smallBtn('#2563EB')}>Open</button>
              <button onClick={() => duplicate(p.id)} style={smallBtn('#475569')}>Duplicate</button>
              <button onClick={() => reassign(p.id, null)} disabled={reassignBusy === p.id}
                style={smallBtn('#CA8A04')}>
                Remove from cell
              </button>
              <select
                value=""
                disabled={reassignBusy === p.id}
                onChange={(e) => { if (e.target.value) reassign(p.id, e.target.value) }}
                style={{ ...inputStyle, fontSize: 11, padding: '4px 6px' }}
                title="Move this program to another cell"
              >
                <option value="">Move to…</option>
                {allCells
                  .filter((c) => c.cell_id !== cell.cell_id)
                  .map((c) => <option key={c.cell_id} value={c.cell_id}>{c.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3 — Baseline cloud (saved PCD) + Recapture + Live vs Baseline
// ─────────────────────────────────────────────────────────────────────────

function SectionBaseline({ cell, onChanged }) {
  const markSaved = useCellWizardStore((s) => s.markSectionSaved)
  const [baselineData, setBaselineData] = useState(null)
  const [baselineErr, setBaselineErr]   = useState(null)
  const [loading, setLoading]           = useState(false)
  const [showLive, setShowLive]         = useState(false)
  const [recap, setRecap]               = useState(null)   // {status, progress, ...} or null

  const { pointsRef, live, livePointCount } = useLiveLidar()

  const loadBaseline = useCallback(async () => {
    setLoading(true); setBaselineErr(null)
    try {
      const r = await fetch(`/api/cells/${cell.cell_id}/baseline/cloud?max_points=50000`)
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setBaselineData(null)
        setBaselineErr(j.error || `HTTP ${r.status}`)
      } else {
        const j = await r.json()
        setBaselineData(j)
      }
    } catch (e) {
      setBaselineErr(String(e))
    }
    setLoading(false)
  }, [cell.cell_id])
  useEffect(() => { if (cell.baseline_captured) loadBaseline() }, [loadBaseline, cell.baseline_captured])

  const startRecap = async () => {
    try {
      const r = await fetch(`/api/cells/${cell.cell_id}/baseline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_s: 10, voxel_m: 0.01 }),
      })
      const j = await r.json()
      setRecap(j.session || j)
    } catch (e) {
      setRecap({ status: 'error', error: String(e) })
    }
  }
  useEffect(() => {
    if (!recap) return
    if (recap.status !== 'capturing' && recap.status !== 'saving' && recap.status !== 'starting') return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/cells/${cell.cell_id}/baseline/status`)
        const j = await r.json()
        setRecap(j)
        if (j.status === 'done') {
          markSaved(cell.cell_id, 'baseline')
          loadBaseline()
          onChanged?.()
        }
      } catch {}
    }, 500)
    return () => clearInterval(t)
  }, [recap, cell.cell_id, loadBaseline, markSaved, onChanged])

  const progressPct = recap?.progress != null ? Math.round(recap.progress * 100) : 0
  const recapping = recap && (recap.status === 'capturing' || recap.status === 'saving' || recap.status === 'starting')

  return (
    <Section title="Environment baseline" dirtySlot={<SavedDot cellId={cell.cell_id} section="baseline" />}>
      <div style={{ marginBottom: 10 }}>
        <CloudViewer
          baselineData={baselineData}
          livePointsRef={pointsRef}
          showLive={showLive}
          showBaseline={true}
          height={300}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
          color: 'var(--text-muted)', marginTop: 6, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: '#3b82f6' }} />
            Saved baseline: {baselineData ? `${(baselineData.n || 0).toLocaleString()} pts` : (loading ? 'loading…' : '—')}
            {baselineData?.total_in_file && baselineData.n < baselineData.total_in_file && (
              <span> (downsampled from {baselineData.total_in_file.toLocaleString()})</span>
            )}
          </span>
          {showLive && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: '#f59e0b' }} />
              Live: {live ? `${livePointCount.toLocaleString()} pts` : 'no live data'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showLive} onChange={(e) => setShowLive(e.target.checked)} />
            <span>Overlay live cloud</span>
          </label>
        </div>
        {baselineErr && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#dc2626' }}>
            {baselineErr === 'baseline not captured'
              ? 'No baseline captured yet — click Recapture to scan.'
              : `Baseline load failed: ${baselineErr}`}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={startRecap} disabled={recapping} style={smallBtn(recapping ? '#475569' : '#7C3AED')}>
          {cell.baseline_captured ? 'Recapture baseline (10 s)' : 'Capture baseline (10 s)'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Captured {cell.updated_at || '—'} · stationary capture from the mounted LiDAR
        </span>
      </div>
      {recapping && (
        <div style={{ marginTop: 10 }}>
          <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#7C3AED', width: progressPct + '%', transition: 'width 200ms' }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {recap.status === 'saving' ? 'Saving…' : 'Capturing…'} ·
            {' '}frames {recap.frames || 0} · raw points {(recap.pts_collected || 0).toLocaleString()}
          </div>
        </div>
      )}
      {recap?.status === 'error' && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>Error: {recap.error}</div>
      )}
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3a — Static keep-out zones built from the baseline cloud.
// Reuses the live LiDAR clustering / OBB pipeline (server-side
// static_zones.py); the result is a list of merged AABBs the
// collision_monitor injects into /collision/objects with static:true
// for the existing capsule-vs-box proximity check, AND that the 3D
// viewer renders as red/orange permanent obstacles.
// ─────────────────────────────────────────────────────────────────────────

function SectionCollisionZones({ cell, onChanged }) {
  const [zones,    setZones]    = useState(null)
  const [building, setBuilding] = useState(false)
  const [error,    setError]    = useState(null)
  const [lastDiag, setLastDiag] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/cells/${cell.cell_id}/collision_zones`)
      if (!r.ok) { setZones(null); return }
      const j = await r.json()
      if (j.has_zones) setZones(j); else setZones({ zones: [], n_zones: 0 })
    } catch { setZones(null) }
  }, [cell.cell_id])
  useEffect(() => { refresh() }, [refresh])

  const canBuild = !!cell.baseline_captured
  const build = async () => {
    if (!canBuild || building) return
    setBuilding(true); setError(null)
    try {
      const r = await fetch(`/api/cells/${cell.cell_id}/collision_zones/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) {
        setError(j.message || j.error || `Build failed (HTTP ${r.status})`)
      } else {
        setLastDiag(j)
      }
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setBuilding(false)
      refresh()
      onChanged?.()
    }
  }

  const clear = async () => {
    if (!zones || (zones.n_zones ?? 0) === 0) return
    if (!confirm('Clear the static collision zones for this cell?')) return
    try {
      await fetch(`/api/cells/${cell.cell_id}/collision_zones`, { method: 'DELETE' })
    } catch {}
    refresh()
  }

  const count = zones?.n_zones ?? 0
  const builtAt = zones?.built_at || lastDiag?.built_at
  const diag = zones?.diag || lastDiag?.diag

  return (
    <Section title="Static collision zones (from baseline)"
             dirtySlot={<SavedDot cellId={cell.cell_id} section="collision_zones" />}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    marginBottom: 8 }}>
        <button onClick={build}
          disabled={!canBuild || building}
          style={smallBtn(!canBuild ? '#94a3b8' : (building ? '#475569' : '#ea580c'))}>
          {building ? 'Building…'
            : (count > 0 ? 'Rebuild zones' : 'Build zones')}
        </button>
        {count > 0 && (
          <button onClick={clear} style={smallBtn('#475569')}>
            Clear zones
          </button>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {!canBuild && 'Needs a baseline first — capture one above.'}
          {canBuild && count === 0 && 'No zones built yet.'}
          {canBuild && count > 0 && (
            <>
              <b style={{ color: '#ea580c' }}>{count}</b> static obstacle{count === 1 ? '' : 's'}
              {builtAt && <> · built {builtAt}</>}
            </>
          )}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        Clusters dense regions of the saved baseline (within the 1.4 m reach),
        merges adjacent boxes (one bench = one box), inflates 5 cm for
        clearance. The robot's capsule proximity check uses these for
        warning / slow / stop in real time.{' '}
        <b style={{ color: '#92400e' }}>Note:</b> trajectory planning <i>around</i>
        these obstacles requires MoveIt2 + the official Estun URDF
        (pending). The build also writes a MoveIt2-compatible
        planning_scene file so a future planner can ingest the obstacle
        set without re-running this build.
      </div>
      {diag && (
        <div style={{
          marginTop: 8, padding: '8px 10px',
          background: 'var(--surface, #f8fafc)', borderRadius: 6,
          border: '1px solid var(--border)',
          fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)',
        }}>
          {[
            ['voxel', diag.n_after_voxel],
            ['reach', diag.n_after_reach],
            ['self-filter', diag.n_after_self_filter],
            ['above-ground', diag.n_above_ground],
            ['raw clusters', diag.n_clusters_raw],
            ['kept (density)', diag.n_clusters_kept],
            ['merged groups', diag.n_merged_groups],
          ].filter(([, v]) => v !== undefined).map(([k, v]) => (
            <span key={k} style={{ marginRight: 12 }}>{k}: <b>{v}</b></span>
          ))}
          {diag.elapsed_s !== undefined && (
            <span>elapsed: <b>{(diag.elapsed_s).toFixed(2)} s</b></span>
          )}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{error}</div>
      )}
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4 — Workspace bounds (editable, save via PUT)
// ─────────────────────────────────────────────────────────────────────────

function SectionBounds({ cell, onChanged }) {
  const setDirty  = useCellWizardStore((s) => s.setSectionDirty)
  const markSaved = useCellWizardStore((s) => s.markSectionSaved)

  // Normalize once at load — the saved profile may still be in legacy
  // flat form. After this, internal state is canonical {center,size,...}.
  const saved = useMemo(() => normalizeBounds(cell.workspace_bounds), [cell.workspace_bounds])
  const [draft, setDraft] = useState(saved)
  useEffect(() => { setDraft(saved) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cell.cell_id])

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(() => { setDirty(cell.cell_id, 'bounds', dirty) }, [dirty, cell.cell_id, setDirty])

  const save = async () => {
    if (!dirty) return
    try {
      await fetch(`/api/cells/${cell.cell_id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_bounds: serializeBounds(draft) }),
      })
      markSaved(cell.cell_id, 'bounds')
      onChanged?.()
    } catch {}
  }

  return (
    <Section title="Workspace bounds" dirtySlot={
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SavedDot cellId={cell.cell_id} section="bounds" />
        <button onClick={save} disabled={!dirty} style={smallBtn(dirty ? '#16A34A' : '#475569')}>
          ✓ Save bounds
        </button>
      </div>
    }>
      <BoundsTopDownEditor
        cellId={cell.cell_id}
        value={draft}
        onChange={setDraft}
        height={420}
      />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5 — Hand-eye placeholder (disabled)
// ─────────────────────────────────────────────────────────────────────────

function SectionHandEye({ cell }) {
  const done = !!cell.calibration?.hand_eye_done
  return (
    <Section title="Hand-eye calibration">
      <div style={{
        padding: 14, background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.35)',
        borderRadius: 8, color: '#fde68a', fontSize: 13, lineHeight: 1.55,
      }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          {done ? 'Calibration complete' : 'Pending — MotionCam not present'}
        </div>
        Requires the MotionCam (arriving later). The AprilTag hand-eye calibration runs here once the camera is mounted.
      </div>
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 6 — Raw / Advanced
// ─────────────────────────────────────────────────────────────────────────

function ReRunWizardRow({ cell }) {
  const openWizard = useCellWizardStore((s) => s.openWizard)
  return (
    <div style={{
      display: 'flex', justifyContent: 'center',
      padding: '14px 6px 6px',
    }}>
      <button onClick={() => openWizard(cell)} style={{
        background: '#7C3AED', color: '#fff', border: 'none',
        padding: '8px 16px', borderRadius: 6,
        fontSize: 12, fontWeight: 600, cursor: 'pointer',
      }}>
        Re-run full Setup Wizard for this cell
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level panel
// ─────────────────────────────────────────────────────────────────────────

export default function CellDetailPanel({ cellId, allCells, onRefresh, onDeleted }) {
  const [cell, setCell] = useState(null)
  const [err, setErr]   = useState(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/cells/${cellId}`)
      if (!r.ok) { setErr(`HTTP ${r.status}`); return }
      const j = await r.json()
      setCell(j)
    } catch (e) { setErr(String(e)) }
  }, [cellId])
  useEffect(() => { refresh() }, [refresh])

  // Propagate cell-level changes (rename, activate, etc.) upward so the
  // list re-fetches and the row label refreshes.
  const localOnChanged = useCallback(() => { refresh(); onRefresh?.() }, [refresh, onRefresh])

  if (err) return (
    <div style={{ padding: 12, fontSize: 12, color: '#dc2626' }}>
      Failed to load cell: {err}
    </div>
  )
  if (!cell) return (
    <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
  )
  return (
    <div style={{ padding: '10px 12px 16px', background: 'rgba(0,0,0,0.12)', borderTop: '1px solid var(--border)' }}>
      <SectionName     cell={cell} onChanged={localOnChanged}
                       onDeleted={() => { onDeleted?.(cellId); onRefresh?.() }} />
      <SectionPrograms cell={cell} allCells={allCells || []} onChanged={localOnChanged} />
      <SectionBaseline cell={cell} onChanged={localOnChanged} />
      <SectionCollisionZones cell={cell} onChanged={localOnChanged} />
      <SectionBounds   cell={cell} onChanged={localOnChanged} />
      <SectionHandEye  cell={cell} />
      <ReRunWizardRow  cell={cell} />
    </div>
  )
}

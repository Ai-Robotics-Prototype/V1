import { useEffect, useRef, useState, useCallback } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useCellWizardStore } from '../store/cellWizardStore'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// ─────────────────────────────────────────────────────────────────────────
// Shared bits — same visual language as ProgramWizard
// ─────────────────────────────────────────────────────────────────────────

function QuestionCard({ question, description, children }) {
  return (
    <div style={{ padding: 32, maxWidth: 760, margin: '0 auto' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111', marginBottom: 8, lineHeight: 1.3 }}>
        {question}
      </div>
      {description && (
        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 24, lineHeight: 1.55 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  )
}

function NextButton({ onClick, disabled, label, primary = true }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '12px 22px', fontSize: 15, fontWeight: 700,
      background: disabled ? '#d1d5db' : (primary ? '#2563EB' : '#fff'),
      color: primary ? '#fff' : '#374151',
      border: primary ? 'none' : '1px solid #d1d5db',
      borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
    }}>
      {label || 'Next'}
    </button>
  )
}

function StatusBadge({ ok, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', fontSize: 12, fontWeight: 600,
      borderRadius: 999,
      background: ok ? '#dcfce7' : '#fee2e2',
      color:      ok ? '#166534' : '#991b1b',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: ok ? '#22c55e' : '#ef4444',
      }} />
      {label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Live 3D point-cloud preview pulled from /ws/lidar
// ─────────────────────────────────────────────────────────────────────────

const MAX_PTS = 131072
const REACH_RADIUS_M = 1.4   // S10-140 horizontal reach — defines the
                             // "in-reach" point layer for thicker rendering.

// Brightness-boosted ramp for the dark wizard backdrop. Each channel
// shifted upward so the cloud reads clearly without losing contrast
// between height bands. Channels still bottom-out where physically
// meaningful (floor stays blue, ceiling stays red-orange).
function brightHeightColor(z, boost, out) {
  let r, g, b
  if      (z < 0.1) { r = 0.40; g = 0.65; b = 1.00 }   // floor — punchier blue
  else if (z < 0.5) { r = 0.35; g = 0.95; b = 0.70 }   // mid    — bright teal
  else if (z < 1.0) { r = 1.00; g = 0.92; b = 0.30 }   // waist  — yellow
  else              { r = 1.00; g = 0.55; b = 0.30 }   // tall   — bright orange
  if (boost) {
    // In-reach gets an extra ~15% saturation/luma push so the working
    // zone visually pops without crushing the ramp.
    r = r * 1.15; if (r > 1) r = 1
    g = g * 1.15; if (g > 1) g = 1
    b = b * 1.15; if (b > 1) b = 1
  }
  out[0] = r; out[1] = g; out[2] = b
}

function LidarPoints({ pointsRef }) {
  // Split rendering into two <points> layers sharing one source cloud:
  //   • inner layer: points with sqrt(x²+y²) ≤ REACH_RADIUS_M
  //                  — larger size, boosted colors
  //   • outer layer: everything else
  //                  — smaller size, slightly faded
  // pointsMaterial can't vary per-vertex size, but two layers with their
  // own materials achieves the same look in one frame.
  const innerGeo    = useRef(new THREE.BufferGeometry())
  const outerGeo    = useRef(new THREE.BufferGeometry())
  const innerPosBuf = useRef(new Float32Array(MAX_PTS * 3))
  const innerColBuf = useRef(new Float32Array(MAX_PTS * 3))
  const outerPosBuf = useRef(new Float32Array(MAX_PTS * 3))
  const outerColBuf = useRef(new Float32Array(MAX_PTS * 3))
  const tmpCol      = useRef([0, 0, 0])

  useEffect(() => {
    innerGeo.current.setAttribute('position', new THREE.BufferAttribute(innerPosBuf.current, 3))
    innerGeo.current.setAttribute('color',    new THREE.BufferAttribute(innerColBuf.current, 3))
    innerGeo.current.setDrawRange(0, 0)
    outerGeo.current.setAttribute('position', new THREE.BufferAttribute(outerPosBuf.current, 3))
    outerGeo.current.setAttribute('color',    new THREE.BufferAttribute(outerColBuf.current, 3))
    outerGeo.current.setDrawRange(0, 0)
  }, [])

  useFrame(() => {
    const d = pointsRef.current
    if (!d) return
    const innerPos = innerPosBuf.current
    const innerCol = innerColBuf.current
    const outerPos = outerPosBuf.current
    const outerCol = outerColBuf.current
    const tmp = tmpCol.current
    const r2 = REACH_RADIUS_M * REACH_RADIUS_M
    let inIdx = 0, outIdx = 0, n = 0

    if (d.binary && d.floats) {
      const f = d.floats
      n = Math.min(d.n, MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = f[i * 3], py = f[i * 3 + 1], pz = f[i * 3 + 2]
        const inReach = (px * px + py * py) <= r2
        const pos = inReach ? innerPos : outerPos
        const col = inReach ? innerCol : outerCol
        const idx = inReach ? inIdx : outIdx
        // LiDAR (x,y,z) → Three (x, z, y) — same mapping as the live panel.
        pos[idx * 3]     = px
        pos[idx * 3 + 1] = pz
        pos[idx * 3 + 2] = py
        brightHeightColor(pz, inReach, tmp)
        col[idx * 3] = tmp[0]; col[idx * 3 + 1] = tmp[1]; col[idx * 3 + 2] = tmp[2]
        if (inReach) inIdx++; else outIdx++
      }
    } else if (Array.isArray(d.p) && typeof d.n === 'number') {
      const p = d.p
      n = Math.min(d.n, MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = p[i * 3], py = p[i * 3 + 1], pz = p[i * 3 + 2]
        const inReach = (px * px + py * py) <= r2
        const pos = inReach ? innerPos : outerPos
        const col = inReach ? innerCol : outerCol
        const idx = inReach ? inIdx : outIdx
        pos[idx * 3]     = px
        pos[idx * 3 + 1] = pz
        pos[idx * 3 + 2] = py
        brightHeightColor(pz, inReach, tmp)
        col[idx * 3] = tmp[0]; col[idx * 3 + 1] = tmp[1]; col[idx * 3 + 2] = tmp[2]
        if (inReach) inIdx++; else outIdx++
      }
    } else return

    innerGeo.current.setDrawRange(0, inIdx)
    innerGeo.current.attributes.position.needsUpdate = true
    innerGeo.current.attributes.color.needsUpdate    = true
    outerGeo.current.setDrawRange(0, outIdx)
    outerGeo.current.attributes.position.needsUpdate = true
    outerGeo.current.attributes.color.needsUpdate    = true
  })

  return (
    <>
      {/* Out-of-reach layer first so the in-reach layer paints over the
          boundary, keeping in-reach points crisp where ranges overlap. */}
      <points>
        <primitive object={outerGeo.current} attach="geometry" />
        <pointsMaterial
          size={0.006}
          vertexColors
          transparent
          opacity={0.65}
          sizeAttenuation
          depthWrite={false}
        />
      </points>
      <points>
        <primitive object={innerGeo.current} attach="geometry" />
        <pointsMaterial
          size={0.013}
          vertexColors
          transparent
          opacity={1.0}
          sizeAttenuation
          depthWrite={false}
        />
      </points>
    </>
  )
}

function WorkspaceBox({ bounds }) {
  if (!bounds) return null
  const cx = (bounds.x_min + bounds.x_max) / 2
  const cy = (bounds.y_min + bounds.y_max) / 2
  const cz = (bounds.z_min + bounds.z_max) / 2
  const sx = Math.max(0.01, bounds.x_max - bounds.x_min)
  const sy = Math.max(0.01, bounds.y_max - bounds.y_min)
  const sz = Math.max(0.01, bounds.z_max - bounds.z_min)
  // LiDAR (x,y,z) -> Three (x, z, y); both LiDAR and base are at the
  // same origin in this rigid-mount build.
  return (
    <mesh position={[cx, cz, cy]}>
      <boxGeometry args={[sx, sz, sy]} />
      <meshBasicMaterial color="#2563EB" wireframe transparent opacity={0.6} />
    </mesh>
  )
}

function LiveCloudViewer({ pointsRef, bounds, height = 260 }) {
  return (
    <div style={{
      height, background: '#0f172a',
      borderRadius: 12, overflow: 'hidden',
      border: '1px solid #e5e7eb',
    }}>
      <Canvas camera={{ position: [2.5, 2.0, 2.5], fov: 50 }}>
        <ambientLight intensity={0.6} />
        <gridHelper args={[4, 16, '#334155', '#1e293b']} />
        <axesHelper args={[0.4]} />
        <LidarPoints pointsRef={pointsRef} />
        {bounds && <WorkspaceBox bounds={bounds} />}
        <OrbitControls />
      </Canvas>
    </div>
  )
}

// Subscribe to /ws/lidar. Also tracks rolling Hz so the hardware-check
// step can display live publish rate.
function useLiveLidar() {
  const pointsRef = useRef(null)
  const [livePointCount, setLivePointCount] = useState(0)
  const [hz, setHz] = useState(0)
  const [live, setLive] = useState(false)
  const tStampsRef = useRef([])
  useEffect(() => {
    const url = `${WS_PROTO}://${HOST}/ws/lidar`
    let ws
    let alive = true
    try { ws = new WebSocket(url) }
    catch { return () => {} }
    ws.binaryType = 'arraybuffer'
    const recordTime = () => {
      const now = performance.now() / 1000
      tStampsRef.current.push(now)
      // keep only the last 2 seconds of timestamps
      tStampsRef.current = tStampsRef.current.filter((t) => now - t < 2.0)
      const arr = tStampsRef.current
      if (arr.length >= 2) {
        setHz((arr.length - 1) / Math.max(0.001, arr[arr.length - 1] - arr[0]))
      }
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const j = JSON.parse(ev.data)
          if (Array.isArray(j.p) && typeof j.n === 'number') {
            pointsRef.current = j
            setLivePointCount(j.n)
            setLive(true)
            recordTime()
          }
        } catch {}
      } else {
        const view = new DataView(ev.data)
        const n = view.getUint32(0, true)
        const floats = new Float32Array(ev.data, 4, n * 3)
        pointsRef.current = { binary: true, floats, n }
        setLivePointCount(n)
        setLive(true)
        recordTime()
      }
    }
    ws.onclose = () => alive && setLive(false)
    ws.onerror = () => alive && setLive(false)
    return () => { alive = false; try { ws.close() } catch {} }
  }, [])
  return { pointsRef, livePointCount, hz, live }
}

// ─────────────────────────────────────────────────────────────────────────
// Step content
// ─────────────────────────────────────────────────────────────────────────

function StepName({ draft, setField, goNext }) {
  const [val, setVal] = useState(draft.name || '')
  return (
    <QuestionCard
      question="What do you want to call this workspace?"
      description="A short, memorable name. e.g. &lsquo;Main Bench&rsquo;, &lsquo;Conveyor Line 2&rsquo;."
    >
      <input
        autoFocus
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) { setField('name', val.trim()); goNext() } }}
        placeholder="Cell name"
        style={{
          width: '100%', padding: '14px 18px', fontSize: 16,
          border: '2px solid #e5e7eb', borderRadius: 10, outline: 'none',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <NextButton
          onClick={() => { setField('name', val.trim()); goNext() }}
          disabled={!val.trim()}
        />
      </div>
    </QuestionCard>
  )
}

function StepHardware({ goNext, livePts, liveHz, liveOn }) {
  const [checks, setChecks] = useState({ loading: true })
  const run = useCallback(async () => {
    setChecks({ loading: true })
    try {
      const r = await fetch('/health')
      const j = await r.json()
      setChecks({
        loading: false,
        lidar:   !!j.lidar_live,
        lidar_pts: j.lidar_pts || 0,
        cam0:    !!j.cam0_live,
        cam1:    !!j.cam1_live,
        // No /health field for the arm yet — surface as "not connected"
        arm:     false,
      })
    } catch (e) {
      setChecks({ loading: false, error: String(e) })
    }
  }, [])
  useEffect(() => { run() }, [run])

  // Prefer live /ws/lidar numbers (current rate + last frame size) when
  // available; fall back to the /health snapshot (which only includes
  // a single point-count sample).
  const lidarPts = liveOn ? livePts : (checks.lidar_pts || 0)
  const lidarHz  = liveOn ? liveHz  : 0

  return (
    <QuestionCard
      question="Network &amp; hardware check"
      description="Live status of each device. Green = ready, red = not detected. You can continue even if the robot arm isn't connected yet."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
        {checks.loading && <div style={{ color: '#6b7280', fontSize: 13 }}>Checking&hellip;</div>}
        {!checks.loading && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusBadge ok={checks.lidar} label="LiDAR" />
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                {checks.lidar
                  ? `${lidarPts.toLocaleString()} pts · ${lidarHz.toFixed(1)} Hz on /ws/lidar`
                  : 'no LiDAR data on /ws/lidar'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusBadge ok={checks.cam0} label="Camera 0" />
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                {checks.cam0 ? 'streaming' : 'no frames'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusBadge ok={checks.cam1} label="Camera 1" />
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                {checks.cam1 ? 'streaming' : 'no frames'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusBadge ok={checks.arm} label="Robot arm" />
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                expected to be red until the arm is wired
              </span>
            </div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <NextButton onClick={run} primary={false} label="Re-check" />
        <NextButton onClick={goNext} disabled={checks.loading} />
      </div>
    </QuestionCard>
  )
}

function StepBaseline({ draft, editingId, pointsRef, live, livePointCount, goNext }) {
  const cellId = editingId || draft.cell_id
  const [session, setSession] = useState(null)
  const [polling, setPolling] = useState(false)

  const poll = useCallback(async () => {
    if (!cellId) return
    try {
      const r = await fetch(`/api/cells/${cellId}/baseline/status`)
      const j = await r.json()
      setSession(j)
      if (j.status === 'done' || j.status === 'error') setPolling(false)
    } catch {}
  }, [cellId])

  useEffect(() => {
    if (!polling) return
    const t = setInterval(poll, 500)
    return () => clearInterval(t)
  }, [polling, poll])

  const start = async () => {
    if (!cellId) return
    setPolling(true)
    try {
      const r = await fetch(`/api/cells/${cellId}/baseline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_s: 10, voxel_m: 0.01 }),
      })
      const j = await r.json()
      setSession(j.session || j)
    } catch (e) {
      setSession({ status: 'error', error: String(e) })
      setPolling(false)
    }
  }

  const done = session && session.status === 'done'
  const capturing = session && (session.status === 'capturing' || session.status === 'saving' || session.status === 'starting')
  const progressPct = session?.progress != null ? Math.round(session.progress * 100) : (done ? 100 : 0)

  return (
    <QuestionCard
      question="Environment baseline scan"
      description="Clear the workspace of anything that isn't permanent — no people, no parts, no carts. Keep the robot still. We'll learn what the empty cell looks like from the robot's mounted LiDAR. Anything that appears later but isn't in the baseline = a new/dynamic object."
    >
      <div style={{ marginBottom: 12 }}>
        <LiveCloudViewer pointsRef={pointsRef} height={260} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginTop: 6 }}>
          <span>{live ? `Live: ${livePointCount.toLocaleString()} pts via /ws/lidar` : 'Waiting for /ws/lidar…'}</span>
          <span>Drag to rotate · scroll to zoom</span>
        </div>
      </div>
      <div style={{
        padding: 16, background: '#f8fafc', border: '1px solid #e5e7eb',
        borderRadius: 10, marginBottom: 12,
      }}>
        {!session && (
          <button onClick={start} disabled={!cellId} style={{
            padding: '14px 20px', fontSize: 15, fontWeight: 700,
            background: cellId ? '#7C3AED' : '#d1d5db', color: '#fff',
            border: 'none', borderRadius: 10, cursor: cellId ? 'pointer' : 'default',
          }}>
            Start Baseline Capture (10 s)
          </button>
        )}
        {capturing && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              {session.status === 'saving' ? 'Saving baseline…' : 'Capturing…'}
            </div>
            <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', background: '#7C3AED', width: progressPct + '%', transition: 'width 200ms' }} />
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              Frames captured: {session.frames || 0} · Raw points seen: {(session.pts_collected || 0).toLocaleString()}
            </div>
          </div>
        )}
        {done && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: '#15803d' }}>
              Baseline captured.
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              Final point count: {(session.final_count || 0).toLocaleString()} (voxel-downsampled at 1cm).
              Saved to /opt/cobot/cells/{cellId}/baseline_cloud.pcd
            </div>
            <button onClick={() => { setSession(null) }} style={{
              marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
            }}>Recapture</button>
          </div>
        )}
        {session?.status === 'error' && (
          <div style={{ color: '#b91c1c', fontSize: 13 }}>
            Error: {session.error || 'unknown error'}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <NextButton onClick={goNext} disabled={capturing} />
      </div>
    </QuestionCard>
  )
}

function StepHandEye({ goNext }) {
  return (
    <QuestionCard
      question="Hand-eye calibration"
      description="Aligns the robot to the LiDAR using an AprilTag held by the gripper, observed by the MotionCam."
    >
      <div style={{
        padding: 20, background: '#fffbeb', border: '1px solid #fde68a',
        borderRadius: 10, color: '#92400e', lineHeight: 1.55, fontSize: 14,
      }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Disabled — hardware not present.</div>
        Requires the MotionCam (arriving later). The AprilTag hand-eye calibration runs here once the camera is mounted. You can come back and finish this step from the cell&apos;s Edit menu.
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <NextButton onClick={goNext} label="Skip" primary={false} />
      </div>
    </QuestionCard>
  )
}

function StepReview({ draft, onSaveActivate, saving }) {
  return (
    <QuestionCard
      question="Review &amp; save"
      description="Last look before this cell becomes the active workspace."
    >
      <div style={{
        background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10,
        padding: 16, lineHeight: 1.7, fontSize: 13, color: '#374151',
      }}>
        <div><strong>Name:</strong> {draft.name || '(unnamed)'}</div>
        <div><strong>Baseline:</strong> {draft.baseline_captured ? `${(draft.baseline_point_count || 0).toLocaleString()} pts saved` : 'not captured'}</div>
        <div><strong>Hand-eye calibration:</strong> deferred (hardware pending)</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Workspace bounds can be set later from the cell's Edit page.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button onClick={onSaveActivate} disabled={saving || !draft.name} style={{
          padding: '14px 22px', fontSize: 15, fontWeight: 700,
          background: (saving || !draft.name) ? '#d1d5db' : '#16A34A',
          color: '#fff', border: 'none', borderRadius: 10,
          cursor: (saving || !draft.name) ? 'default' : 'pointer',
        }}>
          {saving ? 'Saving…' : 'Save & Activate Cell'}
        </button>
      </div>
    </QuestionCard>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Main wizard — 6 steps
// ─────────────────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'name',     label: 'Name' },
  { key: 'hardware', label: 'Hardware' },
  { key: 'baseline', label: 'Baseline' },
  { key: 'hand_eye', label: 'Hand-eye' },
  { key: 'review',   label: 'Review' },
]

export default function SetupWizard({ onClose, onSaved }) {
  const {
    pageIdx, history, draft, editingId,
    setField, patchDraft, goNext, goBack, markStepComplete, closeWizard, resetWizard,
  } = useCellWizardStore()
  const [saving, setSaving] = useState(false)
  const [createdId, setCreatedId] = useState(editingId)

  const { pointsRef, livePointCount, hz, live } = useLiveLidar()

  // Materialize the backing cell record as soon as the operator names
  // it so baseline capture has an id to target.
  useEffect(() => {
    let cancelled = false
    async function ensure() {
      if (createdId) return
      if (!draft.name) return
      try {
        const r = await fetch('/api/cells', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: draft.name }),
        })
        const j = await r.json()
        if (!cancelled && j.ok) {
          setCreatedId(j.cell.cell_id)
          patchDraft({ cell_id: j.cell.cell_id })
        }
      } catch {}
    }
    ensure()
    return () => { cancelled = true }
  }, [draft.name, createdId])

  const handleClose = () => { closeWizard(); onClose?.() }

  const handleSaveActivate = async () => {
    setSaving(true)
    try {
      const cid = createdId || draft.cell_id
      if (!cid) { setSaving(false); return }
      await fetch(`/api/cells/${cid}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // workspace_bounds intentionally omitted — the wizard no longer
          // collects bounds. Operators can set them later from the Edit
          // page if needed; the backend default in profile.json is left
          // alone for cells that don't customize them here.
          name:                   draft.name,
          steps_completed:        STEPS.map((s) => s.key).filter((k) => k !== 'hand_eye'),
          commissioning_complete: true,
        }),
      })
      await fetch(`/api/cells/${cid}/activate`, { method: 'POST' })
      const fetched = await (await fetch(`/api/cells/${cid}`)).json()
      onSaved?.(fetched)
      resetWizard()
      onClose?.()
    } catch (e) {
      console.error('save failed', e)
    }
    setSaving(false)
  }

  const renderStep = () => {
    switch (pageIdx) {
      case 0: return <StepName draft={draft} setField={setField} goNext={goNext} />
      case 1: return <StepHardware
                       goNext={() => { markStepComplete('hardware'); goNext() }}
                       livePts={livePointCount} liveHz={hz} liveOn={live} />
      case 2: return <StepBaseline draft={draft} editingId={createdId} pointsRef={pointsRef}
                       live={live} livePointCount={livePointCount}
                       goNext={() => { markStepComplete('baseline'); goNext() }} />
      case 3: return <StepHandEye goNext={goNext} />
      case 4: return <StepReview draft={draft} onSaveActivate={handleSaveActivate} saving={saving} />
      default: return <div style={{ padding: 32 }}>Unknown step.</div>
    }
  }

  const progressPct = (pageIdx / (STEPS.length - 1)) * 100

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '95%', maxWidth: 880, maxHeight: '95vh',
        background: '#fff', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {history.length > 1 && (
            <button onClick={goBack} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, color: '#6b7280', padding: '2px 6px',
            }}>{'<'}</button>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Setup &amp; Commissioning Wizard
            </div>
            <div style={{ fontSize: 14, color: '#111', fontWeight: 600 }}>
              Step {pageIdx + 1} of {STEPS.length} · {STEPS[pageIdx]?.label}
            </div>
          </div>
          <button onClick={handleClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 18, color: '#9ca3af', padding: '2px 8px',
          }}>×</button>
        </div>
        <div style={{ height: 3, background: '#e5e7eb' }}>
          <div style={{
            height: '100%', background: '#16A34A',
            width: progressPct + '%', transition: 'width 300ms',
          }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {renderStep()}
        </div>
      </div>
    </div>
  )
}

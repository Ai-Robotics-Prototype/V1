import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import * as THREE from 'three'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// MotionCam frame in metres, camera-frame:
//   +X right, +Y down, +Z forward (away from the lens).
// Three.js viewer is +Y up so we map (X, Y, Z) → (X, -Y, Z) and frame the
// camera looking down the +Z axis. We also subtract the table-plane Z so
// the cloud sits near the origin (much nicer for OrbitControls).
const SCENE_Z_OFFSET = 0.9   // sweet-spot — see datasheet

function cameraToThree(x, y, z) {
  return [x, -y, z - SCENE_Z_OFFSET]
}

// Wire format (binary, /ws/motioncam_cloud):
//   header (24 bytes): magic('MCAM') u32, version u32, n_points u32,
//                      flags u32, fps f32, mean_conf f32
//   then n*float32 XYZ, optional n*uint8 RGB, optional n*float32 conf
const MAGIC = 0x4D43414D
function parseFrame(buf) {
  const v = new DataView(buf)
  if (v.getUint32(0, true) !== MAGIC) return null
  const version = v.getUint32(4, true)
  if (version !== 1) return null
  const n     = v.getUint32(8, true)
  const flags = v.getUint32(12, true)
  const fps   = v.getFloat32(16, true)
  const meanConf = v.getFloat32(20, true)
  let off = 24
  const points = n > 0 ? new Float32Array(buf, off, n * 3) : new Float32Array(0)
  off += n * 12
  let colors = null
  if (flags & 0x1) {
    colors = new Uint8Array(buf, off, n * 3)
    off += n * 3
  }
  let conf = null
  if (flags & 0x2) {
    conf = new Float32Array(buf, off, n)
    off += n * 4
  }
  return { n, fps, meanConf, points, colors, conf }
}

// ---------------------------------------------------------------------------
// Three.js point cloud (pre-allocated buffers)
// ---------------------------------------------------------------------------

const MAX_PTS = 200000

function depthColor(z) {
  // Map z (metres) into a warm→cool ramp around the sweet spot.
  const t = Math.max(0, Math.min(1, (z + 0.1) / 0.5 + 0.4))
  const r = 1.0 - t * 0.8
  const g = 0.3 + t * 0.5
  const b = 0.2 + t * 0.7
  return [r, g, b]
}

function MotionCloud({ frameRef, pointSize, colorMode }) {
  const geoRef    = useRef(new THREE.BufferGeometry())
  const posBufRef = useRef(new Float32Array(MAX_PTS * 3))
  const colBufRef = useRef(new Float32Array(MAX_PTS * 3))

  useEffect(() => {
    const geo = geoRef.current
    geo.setAttribute('position', new THREE.BufferAttribute(posBufRef.current, 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(colBufRef.current, 3))
    geo.setDrawRange(0, 0)
  }, [])

  useFrame(() => {
    const frame = frameRef.current
    if (!frame || frame.n === 0) {
      geoRef.current.setDrawRange(0, 0)
      return
    }
    const pos = posBufRef.current
    const col = colBufRef.current
    const n = Math.min(frame.n, MAX_PTS)
    const p = frame.points
    const c = frame.colors
    const useRGB = colorMode === 'rgb' && c
    for (let i = 0; i < n; i++) {
      const px = p[i * 3]
      const py = p[i * 3 + 1]
      const pz = p[i * 3 + 2]
      // cameraToThree mapping inlined for speed.
      pos[i * 3]     = px
      pos[i * 3 + 1] = -py
      pos[i * 3 + 2] = pz - SCENE_Z_OFFSET
      if (useRGB) {
        col[i * 3]     = c[i * 3]     / 255
        col[i * 3 + 1] = c[i * 3 + 1] / 255
        col[i * 3 + 2] = c[i * 3 + 2] / 255
      } else {
        const [r, g, b] = depthColor(pz - SCENE_Z_OFFSET)
        col[i * 3]     = r
        col[i * 3 + 1] = g
        col[i * 3 + 2] = b
      }
    }
    const geo = geoRef.current
    geo.setDrawRange(0, n)
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate    = true
  })

  return (
    <points>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial size={pointSize} vertexColors sizeAttenuation={true} />
    </points>
  )
}

// ---------------------------------------------------------------------------
// Recognized parts overlay — boxes + label + 3D axis triad + pick arrow
// ---------------------------------------------------------------------------

function colorForRecognition(r) {
  if (r.tentative) return '#F59E0B'
  if (r.match_source === null || r.part_name == null) return '#9CA3AF'
  if (r.confidence >= 0.8) return '#22C55E'
  if (r.confidence >= 0.5) return '#F59E0B'
  return '#9CA3AF'
}

function AxisTriad({ size = 0.04 }) {
  // Three lines from origin along +X, +Y, +Z. Three.js Y is up so the
  // viewer's Y axis maps to the camera's -Y (down). The triad communicates
  // the part's local frame regardless of that flip.
  const mk = (dx, dy, dz, color) => (
    <line>
      <bufferGeometry
        onUpdate={(g) => g.setAttribute('position',
          new THREE.BufferAttribute(new Float32Array([0, 0, 0, dx, dy, dz]), 3))}
      />
      <lineBasicMaterial color={color} linewidth={2} />
    </line>
  )
  return (
    <group>
      {mk(size, 0, 0, '#EF4444')}
      {mk(0, size, 0, '#22C55E')}
      {mk(0, 0, size, '#3B82F6')}
    </group>
  )
}

function PickArrow({ dir, length = 0.05, color = '#22D3EE' }) {
  // Cylinder shaft + cone tip pointing from origin in dir (3-vector in
  // viewer frame). We orient via setFromUnitVectors so it works for any dir.
  const arrowRef = useRef()
  useEffect(() => {
    if (!arrowRef.current) return
    const v = new THREE.Vector3(dir[0], -dir[1], dir[2]).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), v)
    arrowRef.current.quaternion.copy(q)
  }, [dir[0], dir[1], dir[2]])
  return (
    <group ref={arrowRef}>
      <mesh position={[0, length / 2, 0]}>
        <cylinderGeometry args={[0.002, 0.002, length, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[0, length, 0]}>
        <coneGeometry args={[0.006, 0.012, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

function RecognizedOverlay({ items, onPick, showLabels }) {
  if (!items || items.length === 0) return null
  return (
    <group>
      {items.map((r) => {
        const pos = r.pose?.position
        const dim = r.dimensions
        if (!pos || !dim) return null
        const [tx, ty, tz] = cameraToThree(pos.x, pos.y, pos.z)
        const W = Math.max(0.005, dim.x)
        const D = Math.max(0.005, dim.y)
        const H = Math.max(0.005, dim.z)
        const color = colorForRecognition(r)
        // Source icon — emoji tint for taught vs CAD, neutral for unknown.
        const srcIcon = r.match_source === 'taught' ? '🎓'
                      : r.match_source === 'cad'    ? '📐' : '·'
        const pct = Math.round((r.confidence ?? 0) * 100)
        const pick = r.pick_direction
        return (
          <group key={r.id} position={[tx, ty, tz]}>
            <mesh onClick={(e) => { e.stopPropagation(); onPick?.(r) }}>
              <boxGeometry args={[W, H, D]} />
              <meshStandardMaterial color={color} transparent opacity={0.18}
                                    depthWrite={false} />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(W, H, D)]} />
              <lineBasicMaterial color={color} linewidth={2} />
            </lineSegments>
            <AxisTriad size={Math.max(0.02, Math.min(W, D, H) * 0.9)} />
            {pick && <PickArrow dir={[pick.x, pick.y, pick.z]}
                                length={Math.max(0.03, H * 1.2)}
                                color="#22D3EE" />}
            {showLabels && (
              <Html position={[0, H / 2 + 0.015, 0]} center transform={false}
                    pointerEvents="none">
                <div style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 10,
                  color: '#fff',
                  background: 'rgba(15,17,22,0.85)',
                  border: `1px solid ${color}`,
                  borderRadius: 4,
                  padding: '2px 6px',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                }}>
                  <span style={{ fontWeight: 700 }}>
                    {r.part_name || 'unknown'}
                  </span>
                  <span style={{ opacity: 0.7, marginLeft: 6 }}>
                    {srcIcon} {pct}%
                  </span>
                </div>
              </Html>
            )}
          </group>
        )
      })}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Scene-view cloud: static accumulated buffer fetched from /api/motioncam/scene
// ---------------------------------------------------------------------------

function SceneCloud({ snapshot, pointSize, colorMode }) {
  const meshRef = useRef()
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    if (!snapshot || !snapshot.n) return g
    const n = snapshot.n
    const positions = new Float32Array(n * 3)
    const colors    = new Float32Array(n * 3)
    const p = snapshot.points
    const c = snapshot.colors
    const useRGB = colorMode === 'rgb' && c && c.length >= n * 3
    for (let i = 0; i < n; i++) {
      const px = p[i * 3]
      const py = p[i * 3 + 1]
      const pz = p[i * 3 + 2]
      positions[i * 3]     = px
      positions[i * 3 + 1] = -py
      positions[i * 3 + 2] = pz - SCENE_Z_OFFSET
      if (useRGB) {
        colors[i * 3]     = (c[i * 3]     ?? 200) / 255
        colors[i * 3 + 1] = (c[i * 3 + 1] ?? 200) / 255
        colors[i * 3 + 2] = (c[i * 3 + 2] ?? 200) / 255
      } else {
        const [r, gg, b] = depthColor(pz - SCENE_Z_OFFSET)
        colors[i * 3]     = r
        colors[i * 3 + 1] = gg
        colors[i * 3 + 2] = b
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color',    new THREE.BufferAttribute(colors, 3))
    return g
  }, [snapshot, colorMode])

  return (
    <points ref={meshRef}>
      <primitive object={geo} attach="geometry" />
      <pointsMaterial size={pointSize} vertexColors sizeAttenuation={true} />
    </points>
  )
}

// ---------------------------------------------------------------------------
// Mock color/depth image renderers — pure procedural so we don't ship binary
// ---------------------------------------------------------------------------

function MockColorImage({ width = 640, height = 480 }) {
  // Procedural workspace-like image: warm wood plane, two coloured blocks.
  return (
    <svg viewBox={`0 0 ${width} ${height}`}
         width="100%" height="100%" preserveAspectRatio="xMidYMid meet"
         style={{ background: '#1B1208' }}>
      <defs>
        <pattern id="grain" patternUnits="userSpaceOnUse" width="20" height="20">
          <rect width="20" height="20" fill="#B07C3B"/>
          <path d="M0 10 Q5 6 10 10 T20 10" stroke="#8C5A23"
                fill="none" strokeWidth="1" opacity="0.5"/>
        </pattern>
      </defs>
      <rect x={40} y={120} width={width - 80} height={height - 200} fill="url(#grain)"/>
      {/* Recognized blocks */}
      <rect x={210} y={210} width={70} height={45} fill="#E0AA40" stroke="#fff" strokeWidth={1}/>
      <rect x={360} y={250} width={70} height={45} fill="#B8C95A" stroke="#fff" strokeWidth={1}/>
      <rect x={310} y={300} width={28} height={28} fill="#A0A8B8" stroke="#fff" strokeWidth={1}/>
      <text x={10} y={20} fill="#94A3B8" fontSize="14" fontFamily="monospace">
        MOCK · color (RGB 1680×1200 downscaled)
      </text>
    </svg>
  )
}

function MockDepthImage({ width = 640, height = 480 }) {
  // Gradient depth map with warm-near / cool-far ramp.
  return (
    <svg viewBox={`0 0 ${width} ${height}`}
         width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="dramp" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0"   stopColor="#1E3A8A"/>
          <stop offset="0.4" stopColor="#06B6D4"/>
          <stop offset="0.7" stopColor="#FACC15"/>
          <stop offset="1"   stopColor="#DC2626"/>
        </linearGradient>
      </defs>
      <rect width={width} height={height} fill="url(#dramp)"/>
      <text x={10} y={20} fill="#fff" fontSize="14" fontFamily="monospace">
        MOCK · depth map (warm = near)
      </text>
      <g stroke="#fff" fill="none" strokeWidth={1.5}>
        <rect x={210} y={210} width={70} height={45} />
        <rect x={360} y={250} width={70} height={45} />
        <rect x={310} y={300} width={28} height={28} />
      </g>
      {/* Depth scale legend */}
      <g transform={`translate(${width - 100}, 80)`}>
        <rect width={24} height={300} fill="url(#dramp)"/>
        <text x={32} y={10}  fill="#fff" fontSize="11" fontFamily="monospace">0.5 m</text>
        <text x={32} y={155} fill="#fff" fontSize="11" fontFamily="monospace">0.9 m</text>
        <text x={32} y={300} fill="#fff" fontSize="11" fontFamily="monospace">1.3 m</text>
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1000

export default function MotionCamPanel() {
  const [view, setView]       = useState('live')         // live | scene | color | depth
  const [status, setStatus]   = useState(null)
  const [mockEnabled, setMockEnabled] = useState(false)
  const [mode, setMode]       = useState('camera')       // scanner | camera
  const [pointSize, setPointSize]   = useState(0.0045)
  const [colorMode, setColorMode]   = useState('rgb')    // rgb | depth | confidence | normals | plain
  const [showOverlay, setShowOverlay] = useState(true)
  const [sceneSnap, setSceneSnap]   = useState(null)
  const [recognitions, setRecognitions] = useState([])
  const [picked, setPicked] = useState(null)

  const frameRef = useRef({ n: 0, points: new Float32Array(0), colors: null, conf: null, fps: 0, meanConf: 0 })
  const wsCloudRef = useRef(null)
  const wsRecoRef  = useRef(null)
  const cloudConnected = useRef(false)

  // --- Status polling
  useEffect(() => {
    let stop = false
    async function tick() {
      try {
        const r = await fetch('/api/motioncam/status')
        const j = await r.json()
        if (!stop) {
          setStatus(j)
          setMockEnabled(!!j.mock_enabled)
          if (j.mode) setMode(j.mode)
        }
      } catch (_) {}
      if (!stop) setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
    return () => { stop = true }
  }, [])

  // --- Cloud WebSocket
  useEffect(() => {
    let retry = 0
    let timer = null
    function connect() {
      const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/motioncam_cloud`)
      ws.binaryType = 'arraybuffer'
      wsCloudRef.current = ws
      ws.onopen = () => { cloudConnected.current = true; retry = 0 }
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          const f = parseFrame(ev.data)
          if (f) frameRef.current = f
        }
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        cloudConnected.current = false
        retry++
        const delay = Math.min(1000 * Math.pow(2, retry), 10000)
        timer = setTimeout(connect, delay)
      }
    }
    connect()
    return () => {
      clearTimeout(timer)
      if (wsCloudRef.current) {
        wsCloudRef.current.onclose = null
        wsCloudRef.current.close()
      }
    }
  }, [])

  // --- Recognition WebSocket
  useEffect(() => {
    let retry = 0
    let timer = null
    function connect() {
      const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/motioncam_recognition`)
      wsRecoRef.current = ws
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data)
          if (Array.isArray(m.objects)) setRecognitions(m.objects)
        } catch (_) {}
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        retry++
        const delay = Math.min(1000 * Math.pow(2, retry), 10000)
        timer = setTimeout(connect, delay)
      }
    }
    connect()
    return () => {
      clearTimeout(timer)
      if (wsRecoRef.current) {
        wsRecoRef.current.onclose = null
        wsRecoRef.current.close()
      }
    }
  }, [])

  // --- Scene snapshot fetch when entering scene view
  useEffect(() => {
    if (view !== 'scene') return
    let stop = false
    async function load() {
      try {
        const r = await fetch('/api/motioncam/scene')
        const j = await r.json()
        if (!stop) setSceneSnap(j)
      } catch (_) {}
      if (!stop) setTimeout(load, 1000)
    }
    load()
    return () => { stop = true }
  }, [view])

  // --- Actions
  const toggleMock = useCallback(async () => {
    const next = !mockEnabled
    setMockEnabled(next)
    try {
      await fetch('/api/motioncam/mock', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ enabled: next }),
      })
    } catch (_) {}
  }, [mockEnabled])

  const toggleMode = useCallback(async () => {
    const next = mode === 'camera' ? 'scanner' : 'camera'
    setMode(next)
    try {
      await fetch('/api/motioncam/mode', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ mode: next }),
      })
    } catch (_) {}
  }, [mode])

  const sceneAction = useCallback(async (op) => {
    try { await fetch(`/api/motioncam/scene/${op}`, { method: 'POST' }) } catch (_) {}
  }, [])

  // --- Header derived values
  const connected = status?.connected
  const fps = status?.fps ?? 0
  const pointCount = status?.point_count ?? 0
  const meanConf = status?.mean_confidence_mm ?? 0
  const sceneStat = status?.scene ?? { active: false, frames: 0, points: 0, duration_s: 0 }

  let badgeColor, badgeText
  if (mockEnabled) { badgeColor = '#F59E0B'; badgeText = 'Mock data (simulated)' }
  else if (connected) { badgeColor = '#22C55E'; badgeText = 'Connected' }
  else { badgeColor = '#6B7280'; badgeText = 'Not connected — camera not detected' }

  // -----------------------------------------------------------------------
  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative',
      background: '#0A0B10', color: '#E6E8EE',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'Inter, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexWrap: 'wrap',
      }}>
        <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.02em' }}>
          MotionCam-3D Color S+
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '2px 9px', borderRadius: 12,
          background: `${badgeColor}22`,
          border: `1px solid ${badgeColor}`, color: badgeColor,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: badgeColor,
            boxShadow: `0 0 6px ${badgeColor}`,
          }}/>
          {badgeText}
        </div>
        <button onClick={toggleMode}
          style={{
            background: '#15171D', color: '#9AA0AC',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 6, padding: '3px 10px', fontSize: 11, cursor: 'pointer',
          }}
          title="Toggle Scanner (static, precise) vs Camera (dynamic, continuous)"
        >
          Mode: <span style={{ color: '#E6E8EE' }}>
            {mode === 'scanner' ? 'Scanner (Static)' : 'Camera (Dynamic)'}
          </span>
        </button>
        <div style={{ flex: 1 }} />
        {/* Real / Mock toggle */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          background: '#15171D', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 14, padding: 2,
        }}>
          <button onClick={() => mockEnabled && toggleMock()}
            style={pillStyle(!mockEnabled, '#3B82F6')}>Real</button>
          <button onClick={() => !mockEnabled && toggleMock()}
            style={pillStyle(mockEnabled, '#F59E0B')}>Mock</button>
        </div>
      </div>

      {/* View tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {[
          ['live',  'Live Feed'],
          ['scene', 'Scene'],
          ['color', 'Color'],
          ['depth', 'Depth'],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            style={{
              background: view === id ? 'rgba(59,130,246,0.20)' : 'transparent',
              color: view === id ? '#E6E8EE' : '#9AA0AC',
              border: view === id ? '1px solid #3B82F6' : '1px solid transparent',
              borderRadius: 6, padding: '4px 12px', fontSize: 11, cursor: 'pointer',
              fontWeight: 600, letterSpacing: '0.02em',
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* View body */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {view === 'live' && (
          <LiveView
            frameRef={frameRef}
            recognitions={recognitions}
            mockEnabled={mockEnabled}
            connected={connected}
            pointSize={pointSize}
            setPointSize={setPointSize}
            colorMode={colorMode}
            setColorMode={setColorMode}
            showOverlay={showOverlay}
            setShowOverlay={setShowOverlay}
            onPickRecognition={setPicked}
            stats={{ fps, pointCount, meanConf, mode }}
          />
        )}
        {view === 'scene' && (
          <SceneView
            snapshot={sceneSnap}
            sceneStat={sceneStat}
            mockEnabled={mockEnabled}
            connected={connected}
            recognitions={recognitions}
            showOverlay={showOverlay}
            setShowOverlay={setShowOverlay}
            colorMode={colorMode}
            setColorMode={setColorMode}
            pointSize={pointSize}
            setPointSize={setPointSize}
            onAction={sceneAction}
            onPickRecognition={setPicked}
          />
        )}
        {view === 'color' && (
          <ImageView mockEnabled={mockEnabled} connected={connected} kind="color"/>
        )}
        {view === 'depth' && (
          <ImageView mockEnabled={mockEnabled} connected={connected} kind="depth"/>
        )}
      </div>

      {picked && (
        <PickedPartCard part={picked} onClose={() => setPicked(null)} />
      )}
    </div>
  )
}

function pillStyle(active, accent) {
  return {
    background: active ? accent : 'transparent',
    color: active ? '#fff' : '#9AA0AC',
    border: 'none', borderRadius: 10, padding: '3px 12px',
    fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em',
  }
}

// ---------------------------------------------------------------------------
// Live view — color image (or mock) on the left, cloud on the right
// ---------------------------------------------------------------------------

function LiveView({ frameRef, recognitions, mockEnabled, connected, pointSize,
                    setPointSize, colorMode, setColorMode, showOverlay,
                    setShowOverlay, onPickRecognition, stats }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                  height: '100%', width: '100%', gap: 0 }}>
      <div style={{ position: 'relative', borderRight: '1px solid rgba(255,255,255,0.06)',
                    background: '#0A0B10', display: 'flex',
                    alignItems: 'center', justifyContent: 'center' }}>
        {mockEnabled ? (
          <MockColorImage />
        ) : connected ? (
          <img src="/stream/motioncam_color" alt="MotionCam color"
               style={{ width: '100%', height: '100%', objectFit: 'contain' }}/>
        ) : (
          <NotConnectedPlaceholder kind="color"/>
        )}
        <Badge>● COLOR · 1680×1200</Badge>
      </div>

      <div style={{ position: 'relative', background: '#0A0B10' }}>
        <Canvas camera={{ position: [0.6, 0.45, 0.6], fov: 50 }}
                gl={{ antialias: true, powerPreference: 'high-performance' }}>
          <color attach="background" args={['#0A0B10']}/>
          <ambientLight intensity={0.6}/>
          <gridHelper args={[1.2, 12, '#1e2030', '#1e2030']} position={[0, 0, 0]}/>
          <MotionCloud frameRef={frameRef} pointSize={pointSize} colorMode={colorMode}/>
          {showOverlay && (
            <RecognizedOverlay items={recognitions} onPick={onPickRecognition} showLabels/>
          )}
          <OrbitControls enableDamping dampingFactor={0.08}/>
        </Canvas>

        <ViewControls
          pointSize={pointSize} setPointSize={setPointSize}
          colorMode={colorMode} setColorMode={setColorMode}
          showOverlay={showOverlay} setShowOverlay={setShowOverlay}
        />

        <StatsOverlay {...stats} recognitions={recognitions.length}/>
        {!mockEnabled && !connected && <NotConnectedPlaceholder kind="cloud"/>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scene view — accumulated workspace cloud + scan controls
// ---------------------------------------------------------------------------

function SceneView({ snapshot, sceneStat, mockEnabled, connected, recognitions,
                     showOverlay, setShowOverlay, colorMode, setColorMode,
                     pointSize, setPointSize, onAction, onPickRecognition }) {
  const [bg, setBg] = useState('dark')   // dark | light | grid
  const bgColor = bg === 'dark' ? '#0A0B10' : bg === 'light' ? '#E6E8EE' : '#0A0B10'

  const coverage = Math.min(100, Math.round((sceneStat.points / 80000) * 100))

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative',
                  background: bgColor }}>
      <Canvas camera={{ position: [0.8, 0.6, 0.8], fov: 50 }}>
        <color attach="background" args={[bgColor]}/>
        <ambientLight intensity={0.6}/>
        {bg !== 'light' && <gridHelper args={[1.6, 16, '#1e2030', '#1e2030']}/>}
        {snapshot && <SceneCloud snapshot={snapshot} pointSize={pointSize} colorMode={colorMode}/>}
        {showOverlay && (
          <RecognizedOverlay items={recognitions} onPick={onPickRecognition} showLabels/>
        )}
        <OrbitControls enableDamping dampingFactor={0.08}/>
      </Canvas>

      {/* Scan controls */}
      <div style={{ position: 'absolute', top: 12, left: 12,
                    display: 'flex', flexDirection: 'column', gap: 8,
                    background: 'rgba(15,17,22,0.85)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 8, padding: 10, minWidth: 220 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#E6E8EE',
                      letterSpacing: '0.04em' }}>
          WORKSPACE SCAN
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <button onClick={() => onAction('start')}
            disabled={sceneStat.active}
            style={btnStyle('primary', sceneStat.active)}>Start Scan</button>
          <button onClick={() => onAction('stop')}
            disabled={!sceneStat.active}
            style={btnStyle('secondary', !sceneStat.active)}>Stop Scan</button>
          <button onClick={() => onAction('clear')}
            style={btnStyle('secondary')}>Clear Scene</button>
          <button onClick={() => onAction('save')}
            style={btnStyle('secondary')}>Save Scene</button>
        </div>
        <div style={{ fontSize: 10, color: '#9AA0AC', display: 'grid',
                      gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
          <span>Frames</span><span style={{ color: '#E6E8EE', textAlign: 'right' }}>
            {sceneStat.frames.toLocaleString()}</span>
          <span>Points</span><span style={{ color: '#E6E8EE', textAlign: 'right' }}>
            {sceneStat.points.toLocaleString()}</span>
          <span>Duration</span><span style={{ color: '#E6E8EE', textAlign: 'right' }}>
            {Math.round(sceneStat.duration_s ?? 0)} s</span>
          <span>Coverage</span><span style={{ color: '#E6E8EE', textAlign: 'right' }}>
            ~{coverage}%</span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: '#1F242C', overflow: 'hidden' }}>
          <div style={{
            width: `${coverage}%`, height: '100%',
            background: 'linear-gradient(90deg, #3B82F6, #22C55E)',
            transition: 'width 250ms',
          }}/>
        </div>
      </div>

      {/* Right-side options */}
      <ViewControls
        pointSize={pointSize} setPointSize={setPointSize}
        colorMode={colorMode} setColorMode={setColorMode}
        showOverlay={showOverlay} setShowOverlay={setShowOverlay}
        extra={
          <div style={{ display: 'flex', gap: 4 }}>
            {['dark', 'light', 'grid'].map((k) => (
              <button key={k} onClick={() => setBg(k)}
                style={{
                  background: bg === k ? 'rgba(59,130,246,0.25)' : 'transparent',
                  color: bg === k ? '#E6E8EE' : '#9AA0AC',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 4, padding: '2px 8px',
                  fontSize: 10, cursor: 'pointer',
                }}>{k}</button>
            ))}
          </div>
        }
      />

      {!mockEnabled && !connected && !snapshot?.n && (
        <NotConnectedPlaceholder kind="scene"/>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function btnStyle(kind, disabled = false) {
  const base = {
    border: '1px solid', borderRadius: 6, padding: '6px 10px',
    fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
  if (kind === 'primary') {
    return { ...base, background: '#3B82F6', color: '#fff', borderColor: '#3B82F6' }
  }
  return { ...base, background: 'transparent', color: '#E6E8EE',
           borderColor: 'rgba(255,255,255,0.18)' }
}

function ViewControls({ pointSize, setPointSize, colorMode, setColorMode,
                        showOverlay, setShowOverlay, extra }) {
  const colorOptions = [
    ['rgb',         'Color'],
    ['confidence',  'Confidence'],
    ['normals',     'Normals'],
    ['plain',       'Plain'],
  ]
  return (
    <div style={{
      position: 'absolute', top: 12, right: 12,
      background: 'rgba(15,17,22,0.85)',
      border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: 10,
      minWidth: 200, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 10, color: '#9AA0AC', display: 'flex',
                    justifyContent: 'space-between', alignItems: 'center' }}>
        <span>POINT SIZE</span>
        <span style={{ color: '#E6E8EE', fontFamily: 'monospace' }}>
          {pointSize.toFixed(4)}
        </span>
      </div>
      <input type="range" min="0.001" max="0.012" step="0.0005"
             value={pointSize} onChange={(e) => setPointSize(parseFloat(e.target.value))}
             style={{ width: '100%' }}/>
      <div style={{ fontSize: 10, color: '#9AA0AC' }}>VIEW</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {colorOptions.map(([id, label]) => (
          <button key={id} onClick={() => setColorMode(id)}
            style={{
              background: colorMode === id ? 'rgba(59,130,246,0.25)' : 'transparent',
              color: colorMode === id ? '#E6E8EE' : '#9AA0AC',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4, padding: '3px 6px', fontSize: 10, cursor: 'pointer',
            }}>{label}</button>
        ))}
      </div>
      <label style={{ fontSize: 11, color: '#E6E8EE', display: 'flex',
                       alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={showOverlay}
               onChange={(e) => setShowOverlay(e.target.checked)}/>
        Show Recognized Parts
      </label>
      {extra}
    </div>
  )
}

function StatsOverlay({ fps, pointCount, meanConf, mode, recognitions }) {
  return (
    <div style={{
      position: 'absolute', bottom: 12, left: 12,
      background: 'rgba(15,17,22,0.85)',
      border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
      padding: '6px 10px', fontSize: 10, color: '#9AA0AC',
      display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 12px',
    }}>
      <span>FPS</span>           <span style={{ color: '#22C55E', textAlign: 'right' }}>{fps.toFixed?.(1) ?? fps}</span>
      <span>Points</span>        <span style={{ color: '#E6E8EE', textAlign: 'right' }}>{pointCount.toLocaleString()}</span>
      <span>Mean conf</span>     <span style={{ color: '#E6E8EE', textAlign: 'right' }}>{meanConf.toFixed?.(2) ?? meanConf} mm</span>
      <span>Mode</span>          <span style={{ color: '#E6E8EE', textAlign: 'right' }}>{mode}</span>
      <span>Recognized</span>    <span style={{ color: '#3B82F6', textAlign: 'right' }}>{recognitions}</span>
    </div>
  )
}

function Badge({ children }) {
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8,
      background: 'rgba(0,0,0,0.6)', color: '#9AA0AC',
      fontSize: 10, letterSpacing: '0.08em',
      padding: '2px 7px', borderRadius: 3, fontWeight: 500,
      pointerEvents: 'none',
    }}>{children}</div>
  )
}

function NotConnectedPlaceholder({ kind }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 8, color: '#6B7280', pointerEvents: 'none',
    }}>
      <span style={{ fontSize: 32 }}>🛰️</span>
      <span style={{ fontSize: 12 }}>Not connected — camera not detected</span>
      <span style={{ fontSize: 10, opacity: 0.7 }}>
        Toggle Mock above to preview the {kind} view.
      </span>
    </div>
  )
}

function ImageView({ mockEnabled, connected, kind }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%',
                  background: '#0A0B10',
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {mockEnabled ? (
        kind === 'color' ? <MockColorImage /> : <MockDepthImage />
      ) : connected ? (
        <img src={`/stream/motioncam_${kind}`} alt={`MotionCam ${kind}`}
             style={{ width: '100%', height: '100%', objectFit: 'contain' }}/>
      ) : (
        <NotConnectedPlaceholder kind={kind}/>
      )}
      <Badge>{kind === 'color' ? '● COLOR' : '● DEPTH'}</Badge>
    </div>
  )
}

function PickedPartCard({ part, onClose }) {
  const pos = part.pose?.position ?? { x: 0, y: 0, z: 0 }
  const ori = part.pose?.orientation ?? { x: 0, y: 0, z: 0, w: 1 }
  const fmt = (v) => (Math.round(v * 1000) / 1000).toFixed(3)
  return (
    <div style={{
      position: 'absolute', right: 12, bottom: 12,
      background: 'rgba(15,17,22,0.92)',
      border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8,
      padding: 12, width: 260, color: '#E6E8EE', fontSize: 11, zIndex: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 700 }}>{part.part_name || 'unknown'}</div>
        <button onClick={onClose} style={{
          background: 'transparent', border: 'none', color: '#9AA0AC',
          cursor: 'pointer', fontSize: 14,
        }}>✖</button>
      </div>
      <div style={{ color: '#9AA0AC', display: 'grid',
                    gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
        <span>Confidence</span><span style={{ color: '#E6E8EE' }}>
          {Math.round((part.confidence ?? 0) * 100)}%</span>
        <span>Match</span><span style={{ color: '#E6E8EE' }}>
          {part.match_source ?? 'unknown'}</span>
        <span>Position</span><span style={{ color: '#E6E8EE', fontFamily: 'monospace' }}>
          {fmt(pos.x)}, {fmt(pos.y)}, {fmt(pos.z)} m</span>
        <span>Quaternion</span><span style={{ color: '#E6E8EE', fontFamily: 'monospace' }}>
          {fmt(ori.x)}, {fmt(ori.y)}, {fmt(ori.z)}, {fmt(ori.w)}</span>
        {part.pick_direction && (
          <>
            <span>Pick dir</span>
            <span style={{ color: '#22D3EE', fontFamily: 'monospace' }}>
              {fmt(part.pick_direction.x)}, {fmt(part.pick_direction.y)}, {fmt(part.pick_direction.z)}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

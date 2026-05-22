import { useEffect, useRef, useState, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const MAX_PTS = 15000

// ─── WebGL availability ───────────────────────────────────────────────────────
function webglAvailable() {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGLRenderingContext &&
              (c.getContext('webgl') || c.getContext('experimental-webgl')))
  } catch { return false }
}

// ─── Height → normalized RGB ──────────────────────────────────────────────────
function heightRGB(h) {
  if      (h < 0.1) return [0.63, 0.73, 0.90]
  else if (h < 0.5) return [0.31, 0.73, 0.53]
  else if (h < 1.0) return [0.90, 0.65, 0.18]
  else               return [0.82, 0.27, 0.27]
}

// ─── Point coordinate helpers ─────────────────────────────────────────────────
// LiDAR points arrive as {x,y,z} (Ouster) or [x,y,z,refl] (Livox).
// 2D canvas convention: p.x = lateral, p.z = forward/north, p.y = height.
// THREE.js y-up:  x=lateral, y=height, z=-forward (right-hand)
function ptX(p) { return Array.isArray(p) ? p[0] : (p.x ?? 0) }
function ptY(p) { return Array.isArray(p) ? p[2] : (p.y ?? 0) }  // height
function ptZ(p) { return Array.isArray(p) ? p[1] : (p.z ?? 0) }  // forward → negate for THREE

// ─── Safety rings on XZ plane ─────────────────────────────────────────────────
function SafetyRing({ r, color }) {
  const pts = useMemo(() => {
    const a = new Float32Array(64 * 3)
    for (let i = 0; i < 64; i++) {
      const θ = (i / 64) * Math.PI * 2
      a[i * 3]     = Math.cos(θ) * r
      a[i * 3 + 2] = Math.sin(θ) * r
    }
    return a
  }, [r])
  return (
    <lineLoop>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[pts, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.7} />
    </lineLoop>
  )
}

// ─── Floor grid ───────────────────────────────────────────────────────────────
function FloorGrid({ range }) {
  const geo = useMemo(() => {
    const v = []
    for (let i = -range; i <= range; i++) {
      v.push(-range, 0, i,  range, 0, i)
      v.push(i, 0, -range,  i, 0,  range)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
    return g
  }, [range])
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#D1D5DB" transparent opacity={0.35} />
    </lineSegments>
  )
}

// ─── Point cloud (imperative BufferGeometry update) ───────────────────────────
function PointCloud3D({ ptsRef }) {
  const geoRef = useRef()
  useFrame(() => {
    if (!ptsRef.current.dirty || !geoRef.current) return
    ptsRef.current.dirty = false
    const geo = geoRef.current
    const src = ptsRef.current.acc
    const n   = Math.min(src.length, MAX_PTS)
    if (!geo.getAttribute('position')) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PTS * 3), 3))
      geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(MAX_PTS * 3), 3))
    }
    const pa = geo.attributes.position.array
    const ca = geo.attributes.color.array
    for (let i = 0; i < n; i++) {
      const p = src[i]
      const x = ptX(p), y = ptY(p), z = ptZ(p)
      pa[i * 3] = x;  pa[i * 3 + 1] = y;  pa[i * 3 + 2] = -z
      const [r, g, b] = heightRGB(y)
      ca[i * 3] = r;  ca[i * 3 + 1] = g;  ca[i * 3 + 2] = b
    }
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate    = true
    geo.setDrawRange(0, n)
  })
  return (
    <points>
      <bufferGeometry ref={geoRef} />
      <pointsMaterial size={0.04} vertexColors sizeAttenuation />
    </points>
  )
}

// ─── nvblox mesh (rebuilt on each message) ────────────────────────────────────
function NvbloxMesh3D({ meshRef }) {
  const grpRef = useRef()
  useFrame(() => {
    if (!meshRef.current.dirty || !grpRef.current) return
    meshRef.current.dirty = false
    // Dispose and remove all existing children
    while (grpRef.current.children.length) {
      const c = grpRef.current.children[0]
      c.geometry?.dispose()
      c.material?.dispose()
      grpRef.current.remove(c)
    }
    for (const blk of meshRef.current.blocks) {
      if (!blk.v?.length) continue
      const geo = new THREE.BufferGeometry()
      const verts = new Float32Array(blk.v.length * 3)
      const cols  = new Float32Array(blk.v.length * 3)
      for (let i = 0; i < blk.v.length; i++) {
        const [vx, vy, vz] = blk.v[i]
        verts[i * 3] = vx;  verts[i * 3 + 1] = vy;  verts[i * 3 + 2] = -vz
        const cl = blk.c?.[i] ?? [0.6, 0.6, 0.6]
        cols[i * 3] = cl[0];  cols[i * 3 + 1] = cl[1];  cols[i * 3 + 2] = cl[2]
      }
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      geo.setAttribute('color',    new THREE.BufferAttribute(cols, 3))
      if (blk.f?.length) {
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(blk.f.flat()), 1))
      }
      geo.computeVertexNormals()
      grpRef.current.add(new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.65 })
      ))
    }
  })
  return <group ref={grpRef} />
}

// ─── Scene graph spheres ──────────────────────────────────────────────────────
const OBJ_COLORS_3D = {
  bottle: '#2563EB', box: '#16A34A', person: '#DC2626',
  cup: '#D97706', chair: '#7C3AED', default: '#0EA5E9',
}
function SceneObjs3D({ objects }) {
  return (
    <>
      {objects.map((obj, idx) => {
        const pos = obj.position
        if (!Array.isArray(pos) || pos.length < 3) return null
        const [ox, oy, oz] = pos
        const color = OBJ_COLORS_3D[obj.class_name] ?? OBJ_COLORS_3D.default
        return (
          <mesh key={obj.id ?? idx} position={[ox, Math.max(0.05, oy), -oz]}>
            <sphereGeometry args={[0.12, 10, 10]} />
            <meshStandardMaterial color={color} transparent opacity={0.85} />
          </mesh>
        )
      })}
    </>
  )
}

// ─── Full 3D scene ────────────────────────────────────────────────────────────
function Scene3D({ ptsRef, meshRef, objects, range }) {
  return (
    <>
      <color attach="background" args={['#F8FAFC']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 10, 4]} intensity={0.8} />
      <FloorGrid range={range} />
      <SafetyRing r={1.2} color="#16A34A" />
      <SafetyRing r={0.6} color="#D97706" />
      <SafetyRing r={0.3} color="#DC2626" />
      {/* Robot origin */}
      <mesh>
        <cylinderGeometry args={[0.08, 0.08, 0.04, 16]} />
        <meshStandardMaterial color="#2563EB" />
      </mesh>
      <PointCloud3D ptsRef={ptsRef} />
      <NvbloxMesh3D meshRef={meshRef} />
      <SceneObjs3D objects={objects} />
      <OrbitControls makeDefault target={[0, 0, 0]} />
    </>
  )
}

// ─── 2D canvas height → CSS color ────────────────────────────────────────────
const OBJ_COLORS_2D = {
  bottle: '#2563EB', box: '#16A34A', person: '#DC2626',
  cup: '#D97706', chair: '#7C3AED', default: '#0EA5E9',
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export default function LidarPanel() {
  const canvasRef  = useRef(null)
  const ptsRef     = useRef({ acc: [], dirty: false })
  const meshRef    = useRef({ blocks: [], dirty: false })
  const detsRef    = useRef([])
  const sparseRef  = useRef(false)
  const show3dInit = useRef(webglAvailable())

  const [live,     setLive]     = useState(false)
  const [ptCount,  setPtCnt]    = useState(0)
  const [hz,       setHz]       = useState(0)
  const [range,    setRange]    = useState(6)
  const [show3d,   setShow3d]   = useState(show3dInit.current)
  const [meshInfo, setMeshInfo] = useState(null)

  const sceneObjects = useStore((s) => s.sceneGraph?.objects ?? [])

  useEffect(() => useStore.subscribe(
    (s) => s.detections,
    (dets) => { detsRef.current = dets || [] }
  ), [])

  // ── WebSocket (never reconnects on mode toggle) ───────────────────────────
  useEffect(() => {
    let ws, dead = false
    let lastFlush = performance.now(), flushCount = 0

    function connect() {
      if (dead) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws/lidar`)
      ws.onopen  = () => setLive(true)
      ws.onclose = () => { setLive(false); if (!dead) setTimeout(connect, 2000) }
      ws.onerror = () => ws.close()
      ws.onmessage = ({ data }) => {
        try {
          const d = JSON.parse(data)
          if (d.type === 'mesh') {
            meshRef.current.blocks = d.blocks || []
            meshRef.current.dirty  = true
            if (d.total_verts > 0) setMeshInfo({ v: d.total_verts, t: d.total_tris })
          } else {
            const pts = d.points || []
            sparseRef.current = pts.length < 50
            const acc = ptsRef.current.acc
            for (const p of pts) acc.push(p)
            if (acc.length > MAX_PTS) acc.splice(0, acc.length - MAX_PTS)
            ptsRef.current.dirty = true
            setPtCnt(acc.length)
            flushCount++
            if (flushCount >= 10) {
              const now = performance.now()
              setHz(Math.round(10000 / Math.max(1, now - lastFlush)))
              lastFlush = now; flushCount = 0
            }
          }
        } catch (_) {}
      }
    }
    connect()
    return () => { dead = true; if (ws) ws.close() }
  }, [])

  // ── 2D canvas resize observer ─────────────────────────────────────────────
  useEffect(() => {
    if (show3d) return
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      canvas.width  = Math.max(1, Math.floor(width))
      canvas.height = Math.max(1, Math.floor(height))
    })
    ro.observe(parent)
    canvas.width  = parent.offsetWidth  || 400
    canvas.height = parent.offsetHeight || 400
    return () => ro.disconnect()
  }, [show3d])

  // ── 2D canvas render loop ─────────────────────────────────────────────────
  useEffect(() => {
    if (show3d) return
    let rafId
    function draw() {
      const canvas = canvasRef.current
      if (!canvas) { rafId = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')
      const W = canvas.width, H = canvas.height
      if (!W || !H) { rafId = requestAnimationFrame(draw); return }
      const cx = W / 2, cy = H / 2
      const scale = Math.min(W, H) / (range * 2)

      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, W, H)

      // Grid lines
      ctx.strokeStyle = '#E5E7EB'
      ctx.lineWidth = 1
      for (let m = 1; m <= range; m++) {
        const gx = m * scale
        ctx.beginPath()
        ctx.moveTo(cx + gx, 0); ctx.lineTo(cx + gx, H)
        ctx.moveTo(cx - gx, 0); ctx.lineTo(cx - gx, H)
        ctx.moveTo(0, cy + gx); ctx.lineTo(W, cy + gx)
        ctx.moveTo(0, cy - gx); ctx.lineTo(W, cy - gx)
        ctx.stroke()
      }
      ctx.strokeStyle = '#D1D5DB'
      ctx.beginPath()
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
      ctx.stroke()

      // Safety rings
      const rings = [
        { r: 1.2, fill: 'rgba(22,163,74,0.12)',  line: '#16A34A' },
        { r: 0.6, fill: 'rgba(217,119,6,0.20)',  line: '#D97706' },
        { r: 0.3, fill: 'rgba(220,38,38,0.25)',  line: '#DC2626' },
      ]
      for (const ring of rings) {
        const rr = ring.r * scale
        if (rr < 2) continue
        ctx.save()
        ctx.setLineDash([4, 3])
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2)
        ctx.fillStyle = ring.fill; ctx.fill()
        ctx.strokeStyle = ring.line; ctx.lineWidth = 1; ctx.stroke()
        ctx.restore()
      }

      // Accumulated point cloud
      const pts = ptsRef.current.acc
      for (let k = 0; k < pts.length; k++) {
        const p  = pts[k]
        const px = ptX(p), pz = ptZ(p), py = ptY(p)
        const sx = cx + px * scale
        const sy = cy - pz * scale
        if (sx < 0 || sx > W || sy < 0 || sy > H) continue
        const [r, g, b] = heightRGB(py)
        ctx.fillStyle = `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`
        ctx.fillRect(sx - 1, sy - 1, 2, 2)
      }

      // Detection overlays
      for (const det of detsRef.current) {
        const pos = det.pos_3d || det.position
        if (!pos || pos.length < 3) continue
        const [dx, , dz] = pos
        const ox = cx + dx * scale, oy = cy - dz * scale
        if (ox < 0 || ox > W || oy < 0 || oy > H) continue
        const cls   = det.class_name || 'object'
        const color = cls === 'person' ? '#DC2626' : '#2563EB'
        ctx.save()
        ctx.beginPath(); ctx.arc(ox, oy, 5, 0, Math.PI * 2)
        ctx.fillStyle = color + '33'; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.fillStyle = color
        ctx.font = `${Math.max(8, Math.floor(W * 0.022))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(cls[0].toUpperCase(), ox, oy + 3)
        ctx.restore()
      }

      // Scene graph objects
      for (const obj of sceneObjects) {
        const pos = obj.position
        if (!Array.isArray(pos) || pos.length < 3) continue
        const [ox_m, , oz_m] = pos
        const sx = cx + ox_m * scale
        const sy = cy - oz_m * scale
        if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue
        const cls   = obj.class_name || 'object'
        const color = OBJ_COLORS_2D[cls] || OBJ_COLORS_2D.default
        const conf  = obj.score != null ? Math.round(obj.score * 100) : null
        ctx.save()
        if (cls === 'person') {
          const pulse = 0.7 + 0.3 * Math.sin(Date.now() * 0.004)
          ctx.globalAlpha = pulse
          ctx.fillStyle = color
          ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        } else {
          const sz = 9
          ctx.fillStyle = color
          ctx.fillRect(sx - sz/2, sy - sz/2, sz, sz)
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
          ctx.strokeRect(sx - sz/2, sy - sz/2, sz, sz)
        }
        const labelText = conf ? `${cls} ${conf}%` : cls
        ctx.font = 'bold 9px sans-serif'
        ctx.textAlign = 'center'
        const tw = ctx.measureText(labelText).width
        ctx.fillStyle = 'rgba(0,0,0,0.65)'
        ctx.fillRect(sx - tw/2 - 2, sy - 20, tw + 4, 13)
        ctx.fillStyle = color
        ctx.textBaseline = 'bottom'
        ctx.fillText(labelText, sx, sy - 8)
        ctx.restore()
      }

      // Robot origin
      ctx.fillStyle = '#2563EB'
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill()

      // North label
      ctx.fillStyle = '#6B7280'
      ctx.font = `${Math.max(9, Math.floor(W * 0.025))}px sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
      ctx.fillText('N', cx, 10)

      // Motor-offline watermark
      if (sparseRef.current && ptsRef.current.acc.length < 200) {
        ctx.save()
        ctx.font = `bold ${Math.floor(W * 0.05)}px sans-serif`
        ctx.fillStyle = 'rgba(180,180,180,0.5)'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('LiDAR OFFLINE', W / 2, H / 2 + 40)
        ctx.restore()
      }

      rafId = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(rafId)
  }, [show3d, range, sceneObjects])

  const canClear = () => { ptsRef.current.acc = []; ptsRef.current.dirty = true; setPtCnt(0) }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden', height: '100%',
    }}>
      {/* ── Header ── */}
      <div style={{
        padding: '5px 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>LiDAR</span>

        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          {ptCount.toLocaleString()} pts
        </span>
        {sceneObjects.length > 0 && (
          <span style={{ fontSize: 9, color: 'var(--accent)' }}>
            · {sceneObjects.length} obj{sceneObjects.length !== 1 ? 's' : ''}
          </span>
        )}
        {hz > 0 && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{hz} Hz</span>
        )}
        {meshInfo && show3d && (
          <span style={{
            fontSize: 9, color: 'var(--accent)',
            padding: '1px 5px', borderRadius: 4,
            border: '1px solid var(--accent-dim)',
          }}>
            mesh {Math.round(meshInfo.v / 1000)}k v / {Math.round(meshInfo.t / 1000)}k t
          </span>
        )}

        <button
          onClick={canClear}
          style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
          title="Clear accumulated map"
        >CLR</button>

        {/* 3D / 2D toggle */}
        {show3dInit.current && (
          <button
            onClick={() => setShow3d(v => !v)}
            style={{
              fontSize: 9, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
              border:     `1px solid ${show3d ? 'var(--accent)' : 'var(--border)'}`,
              background: show3d ? 'var(--accent-dim)' : 'transparent',
              color:      show3d ? 'var(--accent)'     : 'var(--text-muted)',
            }}
            title="Toggle 3D / 2D view"
          >
            {show3d ? '3D' : '2D'}
          </button>
        )}

        {/* Range selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          {[6, 12, 25].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 5,
                border:     range === r ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: range === r ? 'var(--accent-dim)'       : 'transparent',
                color:      range === r ? 'var(--accent)'           : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >{r}m</button>
          ))}
        </div>

        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
          background: live ? 'var(--green-dim)'  : 'var(--bg-surface)',
          color:      live ? 'var(--green)'      : 'var(--text-muted)',
        }}>
          {live ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--bg-app)' }}>
        {show3d ? (
          <Canvas
            camera={{ position: [0, 5, 5], fov: 60, near: 0.05, far: 200 }}
            gl={{ antialias: true, powerPreference: 'high-performance' }}
            style={{ width: '100%', height: '100%' }}
          >
            <Scene3D
              ptsRef={ptsRef}
              meshRef={meshRef}
              objects={sceneObjects}
              range={range}
            />
          </Canvas>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
            />
            {!live && (
              <div style={{
                position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
                fontSize: 9, color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.85)', padding: '2px 8px', borderRadius: 6,
                pointerEvents: 'none',
              }}>
                connecting…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

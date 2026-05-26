import { useRef, useEffect, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// Height-based color ramp
function heightColor(z) {
  if (z < 0.1)  return new THREE.Color(0.15, 0.35, 0.85)  // blue — floor
  if (z < 0.5)  return new THREE.Color(0.15, 0.75, 0.5)   // teal
  if (z < 1.0)  return new THREE.Color(0.85, 0.75, 0.1)   // yellow
  return         new THREE.Color(0.85, 0.25, 0.15)          // red — high
}

// Point cloud that reads from a ref (no React re-render per frame)
function PointCloud({ pointsRef }) {
  const meshRef  = useRef()
  const geoRef   = useRef(new THREE.BufferGeometry())

  useFrame(() => {
    const pts = pointsRef.current
    if (!pts || pts.length === 0) return

    const positions = new Float32Array(pts.length * 3)
    const colors    = new Float32Array(pts.length * 3)

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      // LiDAR: x=right, y=forward, z=up → Three.js: x, y=up, z
      positions[i * 3]     = p.x
      positions[i * 3 + 1] = p.z   // z-up → y-up
      positions[i * 3 + 2] = p.y
      const c = heightColor(p.z)
      colors[i * 3]     = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }

    const geo = geoRef.current
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3))
    geo.computeBoundingSphere()

    if (meshRef.current) {
      meshRef.current.geometry = geo
    }
  })

  return (
    <points ref={meshRef}>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial size={0.025} vertexColors sizeAttenuation />
    </points>
  )
}

// Safety rings with active-zone pulse
function SafetyRings({ zone }) {
  const opacityRef = useRef({ 0.3: 0.5, 0.6: 0.5, 1.2: 0.5 })
  const meshRefs   = { 0.3: useRef(), 0.6: useRef(), 1.2: useRef() }

  useFrame(({ clock }) => {
    const t     = clock.getElapsedTime()
    const pulse = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3))

    const activeR = zone === 'RED' ? 0.3 : zone === 'YELLOW' ? 0.6 : 1.2
    for (const [r, ref] of Object.entries(meshRefs)) {
      if (ref.current) {
        ref.current.material.opacity = parseFloat(r) === activeR ? pulse : 0.08
      }
    }
  })

  const rings = [
    { r: 1.2, color: '#22C55E' },
    { r: 0.6, color: '#EAB308' },
    { r: 0.3, color: '#EF4444' },
  ]

  return (
    <>
      {rings.map(({ r, color }) => (
        <mesh key={r} ref={meshRefs[r]} position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r, 0.015, 8, 64]} />
          <meshBasicMaterial color={color} transparent opacity={0.3} />
        </mesh>
      ))}
    </>
  )
}

// Scene object markers (box wireframes at each detected object's position)
function ObjectMarkers({ objects }) {
  if (!objects || objects.length === 0) return null
  return (
    <>
      {objects.map((obj) => {
        const pos = obj.position ?? [0, 0, 0]
        return (
          <group key={obj.id} position={[pos[0], pos[2], pos[1]]}>
            <mesh>
              <boxGeometry args={[0.15, 0.15, 0.15]} />
              <meshBasicMaterial color="#3B82F6" wireframe />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

// Camera preset controller
function CameraController({ preset }) {
  const { camera } = useThree()

  useEffect(() => {
    if (preset === 'top') {
      camera.position.set(0, 6, 0.001)
      camera.lookAt(0, 0, 0)
    } else {
      camera.position.set(3, 4, 5)
      camera.lookAt(0, 0, 0)
    }
  }, [preset, camera])

  return null
}

function Scene({ pointsRef, zone, preset, sceneObjects }) {
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[3, 5, 3]} intensity={0.6} />

      {/* Floor grid */}
      <gridHelper args={[6, 12, '#1A1A1E', '#141416']} position={[0, 0, 0]} />

      {/* Robot marker */}
      <mesh position={[0, 0.025, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.05, 16]} />
        <meshStandardMaterial color="#3B82F6" />
      </mesh>

      {/* Safety rings */}
      <SafetyRings zone={zone} />

      {/* Point cloud */}
      <PointCloud pointsRef={pointsRef} />

      {/* Scene object overlays */}
      <ObjectMarkers objects={sceneObjects} />

      <CameraController preset={preset} />
      <OrbitControls enableDamping dampingFactor={0.08} />
    </>
  )
}

export default function LidarPanel() {
  const zone          = useStore((s) => s.safety.zone)
  const lidarWsStatus = useStore((s) => s.lidarWsStatus)
  const sceneObjects  = useStore((s) => s.scene_graph.objects)

  const pointsRef = useRef([])
  const wsRef     = useRef(null)
  const [preset,      setPreset]      = useState('3d')
  const [wsConnected, setWsConnected] = useState(false)
  const [isLive,      setIsLive]      = useState(false)

  // Direct WS connection — bypasses store to avoid re-render storm
  useEffect(() => {
    let retryTimer = null
    let retryCount = 0

    function connect() {
      const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/lidar`)
      wsRef.current = ws

      ws.onopen = () => {
        setWsConnected(true)
        retryCount = 0
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          pointsRef.current = msg.points ?? []
          setIsLive(msg.live ?? false)
        } catch (_) {}
      }

      ws.onerror = () => {}

      ws.onclose = () => {
        setWsConnected(false)
        retryCount++
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000)
        retryTimer = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      clearTimeout(retryTimer)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
      }
    }
  }, [])

  const offline = !wsConnected

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#08090c' }}>
      <Canvas
        camera={{ position: [3, 4, 5], fov: 50 }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
      >
        <Scene pointsRef={pointsRef} zone={zone} preset={preset} sceneObjects={sceneObjects} />
      </Canvas>

      {/* View buttons */}
      <div style={{
        position: 'absolute',
        top: 10,
        right: 10,
        display: 'flex',
        gap: 2,
        background: 'rgba(14,14,18,0.85)',
        borderRadius: 6,
        padding: 3,
        border: '1px solid var(--border)',
      }}>
        {['3D', 'Top'].map((v) => (
          <button
            key={v}
            onClick={() => setPreset(v.toLowerCase())}
            style={{
              background: preset === v.toLowerCase() ? 'var(--bg-hover)' : 'transparent',
              color: preset === v.toLowerCase() ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: 'none',
              padding: '3px 10px',
              borderRadius: 4,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {v}
          </button>
        ))}
      </div>

      {/* Live / Sim badge */}
      <div style={{
        position: 'absolute',
        top: 10,
        left: 10,
        background: isLive ? 'rgba(34,197,94,0.12)' : 'rgba(234,179,8,0.12)',
        border: `1px solid ${isLive ? '#22C55E' : '#EAB308'}`,
        color: isLive ? '#22C55E' : '#EAB308',
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.08em',
        pointerEvents: 'none',
      }}>
        {isLive ? '● LIVE' : '◌ SIM'}
      </div>

      {/* Zone legend */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        left: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        background: 'rgba(14,14,18,0.85)',
        padding: '6px 10px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        fontSize: 10,
        color: 'var(--text-secondary)',
      }}>
        {[['#22C55E', '> 1.2 m', 'GREEN'], ['#EAB308', '0.6–1.2 m', 'YELLOW'], ['#EF4444', '< 0.6 m', 'RED']].map(
          ([color, range, label]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
              <span>{label} {range}</span>
            </div>
          )
        )}
      </div>

      {/* Offline overlay */}
      {offline && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          background: 'rgba(0,0,0,0.3)',
        }}>
          <div style={{
            background: 'rgba(14,14,18,0.9)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 18px',
            fontSize: 13,
            color: 'var(--text-muted)',
          }}>
            📡 LiDAR offline — reconnecting…
          </div>
        </div>
      )}
    </div>
  )
}

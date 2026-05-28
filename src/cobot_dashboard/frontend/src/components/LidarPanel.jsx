import { useRef, useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// Height-based ramp tuned for legibility on the light theme background.
function heightColor(z) {
  if (z < 0.1) return new THREE.Color(0.05, 0.20, 0.55)  // navy — floor
  if (z < 0.5) return new THREE.Color(0.05, 0.50, 0.45)  // teal
  if (z < 1.0) return new THREE.Color(0.80, 0.55, 0.05)  // amber
  return         new THREE.Color(0.78, 0.15, 0.10)         // red — high
}

function PointCloud({ pointsRef }) {
  const meshRef = useRef()
  const geoRef  = useRef(new THREE.BufferGeometry())

  useFrame(() => {
    const pts = pointsRef.current
    if (!pts || pts.length === 0) return

    const positions = new Float32Array(pts.length * 3)
    const colors    = new Float32Array(pts.length * 3)

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      positions[i * 3]     = p.x
      positions[i * 3 + 1] = p.z
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

    if (meshRef.current) meshRef.current.geometry = geo
  })

  return (
    <points ref={meshRef}>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial size={0.025} vertexColors sizeAttenuation />
    </points>
  )
}

function SafetyRings({ zone }) {
  const meshRefs = { 0.3: useRef(), 0.6: useRef(), 1.2: useRef() }

  useFrame(({ clock }) => {
    const t     = clock.getElapsedTime()
    const pulse = 0.35 + 0.30 * (0.5 + 0.5 * Math.sin(t * 3))
    const activeR = zone === 'RED' ? 0.3 : zone === 'YELLOW' ? 0.6 : 1.2
    for (const [r, ref] of Object.entries(meshRefs)) {
      if (ref.current) {
        ref.current.material.opacity = parseFloat(r) === activeR ? pulse : 0.18
      }
    }
  })

  const rings = [
    { r: 1.2, color: '#16A34A' },
    { r: 0.6, color: '#CA8A04' },
    { r: 0.3, color: '#DC2626' },
  ]

  return (
    <>
      {rings.map(({ r, color }) => (
        <mesh key={r} ref={meshRefs[r]} position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r, 0.015, 8, 64]} />
          <meshBasicMaterial color={color} transparent opacity={0.25} />
        </mesh>
      ))}
    </>
  )
}

// Scene-graph object markers (Kalman-tracked objects).
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
              <meshBasicMaterial color="#1D6FD8" wireframe />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

// Real-time 3D detections from /perception/detections_3d (depth_segment_node).
//
// The camera frame is X=right, Y=down, Z=forward. The LiDAR panel's
// world is X=right, Y=up, Z=back. We map camera (X, Y, Z) → world
// (X, -Y, Z) so an object in front of the camera ends up in front of
// the floor cylinder marker (and a Y-down camera object is Y-up here).
//
// The OBB quaternion lives in camera frame; converting it to the panel's
// frame is the same 180° rotation about the X axis. Pre-multiplying by
// qFix = (1, 0, 0, 0) (xyzw) does that.
function DetectionMarkers({ detections }) {
  if (!detections || detections.length === 0) return null
  // Size-band colours (object scale, longest dimension).
  function bandColor(maxDim) {
    if (maxDim < 0.05) return '#16A34A'   // small (<5cm): green
    if (maxDim < 0.15) return '#1D6FD8'   // medium: blue
    return '#DC2626'                       // large (>=15cm): red
  }
  return (
    <>
      {detections.map((det, i) => {
        if (det.bbox_px || det.x == null || det.y == null || det.z == null) return null
        if (Math.abs(det.x) > 10 || Math.abs(det.y) > 10 || Math.abs(det.z) > 10) return null
        if (det.z <= 0) return null

        const sx = Math.max(0.01, det.w ?? 0.05)
        const sy = Math.max(0.01, det.h ?? 0.05)
        const sz = Math.max(0.01, det.d ?? 0.05)
        const color = bandColor(Math.max(sx, sy, sz))

        // Compose (180° rotation about X) ∘ (OBB orientation in camera frame).
        // Quaternion product (xyzw):  q1 * q2 with q1 = qFix.
        let qx, qy, qz, qw
        if (det.quat && det.quat.length === 4) {
          const [ox, oy, oz, ow] = det.quat
          // qFix = (1, 0, 0, 0); product simplifies:
          //   x' =  qw_fix*x  + qx_fix*w + qy_fix*z - qz_fix*y
          //      =  1*ox + 1*ow + 0 - 0
          // Stay with the explicit formula for clarity:
          const fx = 1, fy = 0, fz = 0, fw = 0
          qx =  fw*ox + fx*ow + fy*oz - fz*oy
          qy =  fw*oy - fx*oz + fy*ow + fz*ox
          qz =  fw*oz + fx*oy - fy*ox + fz*ow
          qw =  fw*ow - fx*ox - fy*oy - fz*oz
        } else {
          qx = 0; qy = 0; qz = 0; qw = 1
        }

        // OBB local size order from the publisher: x=longest, y=next, z=smallest.
        return (
          <group
            key={det.id ?? i}
            position={[det.x, -det.y, det.z]}
            quaternion={[qx, qy, qz, qw]}
          >
            <mesh>
              <boxGeometry args={[sx, sy, sz]} />
              <meshStandardMaterial color={color} transparent opacity={0.35} />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(sx, sy, sz)]} />
              <lineBasicMaterial color={color} linewidth={2} />
            </lineSegments>
          </group>
        )
      })}
    </>
  )
}

// Grasp pose markers: short downward arrow at the grasp centre + two
// jaw segments showing the gripper opening width.
function GraspMarkers({ grasps }) {
  if (!grasps || grasps.length === 0) return null
  return (
    <>
      {grasps.map((g, i) => {
        if (g.x == null || g.y == null || g.z == null) return null
        if (Math.abs(g.x) > 10 || Math.abs(g.y) > 10) return null
        const width = Math.max(0.005, Math.min(0.1, g.gripper_width_m ?? 0.05))
        const yaw   = g.grasp_yaw_rad ?? 0
        const lowConf = (g.confidence ?? 1) < 0.7
        const color = lowConf ? '#CA8A04' : '#16A34A'

        // Camera-optical (x right, y down, z forward) -> panel world
        // (x right, y up, z back). Same convention as DetectionMarkers.
        const px = g.x
        const py = -g.y
        const pz = g.z
        // Approach is the camera "above" direction (-z in optical), which
        // maps to -z in the panel world too. Arrow drops onto the object.
        return (
          <group key={g.object_id ?? i} position={[px, py, pz]} rotation={[0, yaw, 0]}>
            {/* approach arrow (small downward shaft) */}
            <mesh position={[0, 0.05, 0]}>
              <cylinderGeometry args={[0.003, 0.003, 0.10, 8]} />
              <meshStandardMaterial color={color} />
            </mesh>
            <mesh position={[0, 0, 0]} rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[0.008, 0.02, 12]} />
              <meshStandardMaterial color={color} />
            </mesh>
            {/* two jaw segments, perpendicular to the approach */}
            <mesh position={[+width / 2, 0.01, 0]}>
              <boxGeometry args={[0.004, 0.025, 0.02]} />
              <meshStandardMaterial color={color} />
            </mesh>
            <mesh position={[-width / 2, 0.01, 0]}>
              <boxGeometry args={[0.004, 0.025, 0.02]} />
              <meshStandardMaterial color={color} />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

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

function Scene({ pointsRef, zone, preset, sceneObjects, detections, grasps }) {
  return (
    <>
      <color attach="background" args={['#F0F2F5']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 3]} intensity={0.5} />

      <gridHelper args={[6, 12, '#9CA3AF', '#D0D4DC']} position={[0, 0, 0]} />

      {/* Robot footprint marker */}
      <mesh position={[0, 0.025, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.05, 16]} />
        <meshStandardMaterial color="#1D6FD8" />
      </mesh>

      <SafetyRings zone={zone} />
      <PointCloud pointsRef={pointsRef} />
      <ObjectMarkers objects={sceneObjects} />
      <DetectionMarkers detections={detections} />
      <GraspMarkers grasps={grasps} />

      <CameraController preset={preset} />
      <OrbitControls enableDamping dampingFactor={0.08} />
    </>
  )
}

export default function LidarPanel() {
  const zone         = useStore((s) => s.safety.zone)
  const sceneObjects = useStore((s) => s.scene_graph.objects)
  const detections   = useStore((s) => s.detections)
  const grasps       = useStore((s) => s.grasp_poses)

  const pointsRef = useRef([])
  const wsRef     = useRef(null)
  const [preset,      setPreset]      = useState('3d')
  const [wsConnected, setWsConnected] = useState(false)
  const [isLive,      setIsLive]      = useState(false)
  const [pointCount,  setPointCount]  = useState(0)

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
          setPointCount(msg.count ?? pointsRef.current.length)
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

  // Light-theme inline styles for the overlay chrome
  const overlayBg = 'rgba(255,255,255,0.92)'
  const overlayBorder = '1px solid var(--border)'
  const overlayText = 'var(--text-primary)'

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--bg-app)' }}>
      <Canvas
        camera={{ position: [3, 4, 5], fov: 50 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <Scene
          pointsRef={pointsRef}
          zone={zone}
          preset={preset}
          sceneObjects={sceneObjects}
          detections={detections}
          grasps={grasps}
        />
      </Canvas>

      {/* View buttons */}
      <div style={{
        position: 'absolute', top: 10, right: 10, display: 'flex', gap: 2,
        background: overlayBg, borderRadius: 6, padding: 3, border: overlayBorder,
        boxShadow: 'var(--shadow-sm)',
      }}>
        {['3D', 'Top'].map((v) => (
          <button
            key={v}
            onClick={() => setPreset(v.toLowerCase())}
            style={{
              background: preset === v.toLowerCase() ? 'var(--bg-hover)' : 'transparent',
              color: preset === v.toLowerCase() ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: 'none', padding: '3px 10px', borderRadius: 4, fontSize: 12,
            }}
          >
            {v}
          </button>
        ))}
      </div>

      {/* Live / Sim badge + point count */}
      <div style={{
        position: 'absolute', top: 10, left: 10,
        display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <div style={{
          background: isLive ? 'var(--green-dim)' : 'var(--yellow-dim)',
          border: `1px solid ${isLive ? 'var(--green)' : 'var(--yellow)'}`,
          color: isLive ? 'var(--green)' : 'var(--yellow)',
          borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 600,
          letterSpacing: '0.08em', pointerEvents: 'none',
        }}>
          {isLive ? '● LIVE' : '◌ SIM'}
        </div>
        <div style={{
          background: overlayBg, border: overlayBorder, color: 'var(--text-secondary)',
          borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 500,
          letterSpacing: '0.04em',
        }}>
          {pointCount.toLocaleString()} pts
        </div>
      </div>

      {/* Zone legend */}
      <div style={{
        position: 'absolute', bottom: 10, left: 10,
        display: 'flex', flexDirection: 'column', gap: 3,
        background: overlayBg, padding: '6px 10px', borderRadius: 6,
        border: overlayBorder, fontSize: 10, color: overlayText,
        boxShadow: 'var(--shadow-sm)',
      }}>
        {[['var(--green)', '> 1.2 m', 'GREEN'],
          ['var(--yellow)', '0.6–1.2 m', 'YELLOW'],
          ['var(--red)', '< 0.6 m', 'RED']].map(([color, range, label]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
            <span>{label} {range}</span>
          </div>
        ))}
      </div>

      {offline && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', background: 'rgba(240,242,245,0.6)',
        }}>
          <div style={{
            background: overlayBg, border: overlayBorder, borderRadius: 8,
            padding: '10px 18px', fontSize: 13, color: 'var(--text-muted)',
            boxShadow: 'var(--shadow-md)',
          }}>
            LiDAR offline — reconnecting…
          </div>
        </div>
      )}
    </div>
  )
}

import { useRef, useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// Height-based ramp tuned for legibility on the dark panel background.
function heightColor(z) {
  if (z < 0.1) return new THREE.Color(0.15, 0.35, 0.85)  // blue — floor
  if (z < 0.5) return new THREE.Color(0.15, 0.75, 0.50)  // teal
  if (z < 1.0) return new THREE.Color(0.85, 0.75, 0.10)  // yellow
  return         new THREE.Color(0.85, 0.25, 0.15)         // orange/red — high
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
// Detections are now published in livox_frame (ROS: X=forward, Y=left,
// Z=up). PointCloud uses the mapping  three.x = lidar.x,
// three.y = lidar.z, three.z = lidar.y  — we match it here so detection
// markers and points coexist in the same world.
//
// OBB orientations are also in livox_frame; for the yaw-only quaternions
// we publish, the rotation is about lidar Z, which is three.js Y. We
// extract the yaw component and re-build a three.js-Y rotation, which
// avoids the parity issue of the y/z axis swap (it's a reflection, not
// a pure rotation, so we can't reuse the lidar quaternion verbatim).
function DetectionMarkers({ detections }) {
  if (!detections || detections.length === 0) return null
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

        const W = Math.max(0.01, det.w ?? 0.05)  // longest XY in OBB local frame
        const D = Math.max(0.01, det.h ?? 0.05)  // shorter XY ("h" in dashboard JSON)
        const H = Math.max(0.01, det.d ?? 0.05)  // Z extent       ("d" in dashboard JSON)
        const color = bandColor(Math.max(W, D, H))

        // Extract yaw from the lidar-frame quaternion (rotation about Z).
        // For yaw-only quats (qx≈qy≈0): yaw = 2 * atan2(qz, qw). Use the
        // general formula so residual roll/pitch noise doesn't break us.
        let yaw = 0
        if (det.quat && det.quat.length === 4) {
          const [qx, qy, qz, qw] = det.quat
          yaw = Math.atan2(2*(qw*qz + qx*qy), 1 - 2*(qy*qy + qz*qz))
        }

        // boxGeometry args are (extent along three.X, .Y, .Z).
        // OBB axes in lidar at identity: W along lidar.X (-> three.X),
        // D along lidar.Y (-> three.Z), H along lidar.Z (-> three.Y).
        return (
          <group
            key={det.id ?? i}
            position={[det.x, det.z, det.y]}
            rotation={[0, yaw, 0]}
          >
            <mesh>
              <boxGeometry args={[W, H, D]} />
              <meshStandardMaterial color={color} transparent opacity={0.35} />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(W, H, D)]} />
              <lineBasicMaterial color={color} linewidth={2} />
            </lineSegments>
          </group>
        )
      })}
    </>
  )
}

// Reconstruction mesh from /ws/mesh: BufferGeometry built from the
// vertices/triangles JSON, height-based vertex colours, semi-transparent
// overlay on top of the raw point cloud. Uses the same axis convention
// as the point cloud (z-up in LiDAR frame -> y-up in three.js).
function ReconstructionMesh({ meshRef }) {
  const groupRef = useRef()
  useFrame(() => {
    const data = meshRef.current
    if (!data) return
    const verts = data.vertices
    const tris  = data.triangles
    const cols  = data.colors  // server-side per-vertex colours, optional
    if (!verts || !tris) return

    const N = verts.length
    const positions = new Float32Array(N * 3)
    const colors    = new Float32Array(N * 3)
    const haveCols  = Array.isArray(cols) && cols.length === N
    for (let i = 0; i < N; i++) {
      const v = verts[i]
      positions[i * 3]     = v[0]
      positions[i * 3 + 1] = v[2]   // z-up -> y-up
      positions[i * 3 + 2] = v[1]
      if (haveCols) {
        const c = cols[i]
        colors[i * 3]     = c[0]
        colors[i * 3 + 1] = c[1]
        colors[i * 3 + 2] = c[2]
      } else {
        // Local fallback palette — same bands as the server.
        const z = v[2]
        let c
        if (z < 0.1)      c = [0.753, 0.769, 0.800]   // light grey
        else if (z < 0.8) c = [0.576, 0.773, 0.992]   // light blue
        else if (z < 1.5) c = [0.525, 0.937, 0.675]   // light green
        else              c = [0.992, 0.902, 0.541]   // light amber
        colors[i * 3]     = c[0]
        colors[i * 3 + 1] = c[1]
        colors[i * 3 + 2] = c[2]
      }
    }

    const M = tris.length
    const index = new Uint32Array(M * 3)
    for (let i = 0; i < M; i++) {
      const t = tris[i]
      index[i * 3]     = t[0]
      index[i * 3 + 1] = t[1]
      index[i * 3 + 2] = t[2]
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    geo.computeVertexNormals()

    if (groupRef.current) {
      // Dispose any previous geometry so we don't leak GPU memory.
      while (groupRef.current.children.length > 0) {
        const child = groupRef.current.children[0]
        if (child.geometry) child.geometry.dispose()
        groupRef.current.remove(child)
      }
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          flatShading: true,
        }),
      )
      groupRef.current.add(mesh)
    }

    meshRef.current = null  // consume so we don't rebuild every frame
  })
  return <group ref={groupRef} />
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

        // Grasp positions live in livox_frame now (forwarded from
        // depth_segment_node via grasp_planner). Map to the same three.js
        // convention the PointCloud uses.
        const px = g.x
        const py = g.z       // lidar Z (up) -> three.js Y (up)
        const pz = g.y       // lidar Y (left) -> three.js Z (back)
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

function Scene({ pointsRef, meshRef, zone, preset, sceneObjects, detections, grasps }) {
  return (
    <>
      <color attach="background" args={['#0A0A0B']} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 5, 3]} intensity={0.6} />

      <gridHelper args={[6, 12, '#1e2030', '#1e2030']} position={[0, 0, 0]} />

      {/* Robot footprint marker */}
      <mesh position={[0, 0.025, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.05, 16]} />
        <meshStandardMaterial color="#1D6FD8" />
      </mesh>

      <SafetyRings zone={zone} />
      <PointCloud pointsRef={pointsRef} />
      <ReconstructionMesh meshRef={meshRef} />
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
  const meshRef   = useRef(null)
  const wsRef     = useRef(null)
  const meshWsRef = useRef(null)
  const [preset,       setPreset]       = useState('3d')
  const [wsConnected,  setWsConnected]  = useState(false)
  const [isLive,       setIsLive]       = useState(false)
  const [pointCount,   setPointCount]   = useState(0)
  const [meshTriCount, setMeshTriCount] = useState(0)

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

  // Separate WS for the reconstruction mesh — 2 Hz updates, lazy attach.
  useEffect(() => {
    let retryTimer = null
    let retryCount = 0
    function connect() {
      const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/mesh`)
      meshWsRef.current = ws
      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data)
          meshRef.current = d
          setMeshTriCount(d.n_tris ?? (d.triangles ? d.triangles.length : 0))
        } catch (_) {}
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        retryCount++
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000)
        retryTimer = setTimeout(connect, delay)
      }
    }
    connect()
    return () => {
      clearTimeout(retryTimer)
      if (meshWsRef.current) {
        meshWsRef.current.onclose = null
        meshWsRef.current.close()
      }
    }
  }, [])

  const offline = !wsConnected

  // Dark-on-dark overlay chrome (LiDAR panel only — the rest of the
  // dashboard stays on the light theme).
  const overlayBg = 'rgba(14,14,18,0.85)'
  const overlayBorder = '1px solid rgba(255,255,255,0.12)'
  const overlayText = '#E6E8EE'

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#0A0A0B' }}>
      <Canvas
        camera={{ position: [3, 4, 5], fov: 50 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <Scene
          pointsRef={pointsRef}
          meshRef={meshRef}
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
              background: preset === v.toLowerCase() ? 'rgba(255,255,255,0.10)' : 'transparent',
              color: preset === v.toLowerCase() ? '#E6E8EE' : '#9AA0AC',
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
          background: overlayBg, border: overlayBorder, color: '#9AA0AC',
          borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 500,
          letterSpacing: '0.04em',
        }}>
          {pointCount.toLocaleString()} pts
        </div>
        {meshTriCount > 0 && (
          <div style={{
            background: overlayBg, border: overlayBorder, color: '#9AA0AC',
            borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 500,
            letterSpacing: '0.04em',
          }}>
            mesh {meshTriCount.toLocaleString()}△
          </div>
        )}
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
          pointerEvents: 'none', background: 'rgba(0,0,0,0.45)',
        }}>
          <div style={{
            background: overlayBg, border: overlayBorder, borderRadius: 8,
            padding: '10px 18px', fontSize: 13, color: '#9AA0AC',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}>
            LiDAR offline — reconnecting…
          </div>
        </div>
      )}
    </div>
  )
}

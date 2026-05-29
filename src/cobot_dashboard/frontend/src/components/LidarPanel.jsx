import { useRef, useEffect, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const HOST     = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// Single source of truth for livox_frame (ROS: X=forward, Y=left, Z=up)
// to three.js (X=right, Y=up, Z=toward camera). The PointCloud, mesh,
// detections, and grasps all use this — they must, or 3D objects from
// different streams end up rendered at inconsistent positions.
function lidarToThree(x, y, z) {
  return [x, z, y]
}

// Height-based ramp tuned for legibility on the dark panel background.
function heightColor(z) {
  if (z < 0.1) return new THREE.Color(0.15, 0.35, 0.85)  // blue — floor
  if (z < 0.5) return new THREE.Color(0.15, 0.75, 0.50)  // teal
  if (z < 1.0) return new THREE.Color(0.85, 0.75, 0.10)  // yellow
  return         new THREE.Color(0.85, 0.25, 0.15)         // orange/red — high
}

// Pre-allocated point cloud renderer. Buffers are sized once at mount
// for MAX_PTS and reused every frame — `needsUpdate=true` + setDrawRange
// avoids allocating new ArrayBuffers / BufferAttributes on the hot path.
// Consumes the dashboard's flat-array payload (msg.p = interleaved
// float32 XYZ, msg.n = point count). Falls back to the legacy list-of-
// dicts payload if the server is still on the old format.
const MAX_PTS = 16384
function PointCloud({ pointsRef }) {
  const meshRef    = useRef()
  const geoRef     = useRef(new THREE.BufferGeometry())
  const posBufRef  = useRef(new Float32Array(MAX_PTS * 3))
  const colBufRef  = useRef(new Float32Array(MAX_PTS * 3))

  useEffect(() => {
    const geo = geoRef.current
    geo.setAttribute('position', new THREE.BufferAttribute(posBufRef.current, 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(colBufRef.current, 3))
    geo.setDrawRange(0, 0)
  }, [])

  useFrame(() => {
    const data = pointsRef.current
    if (!data) return

    const positions = posBufRef.current
    const colors    = colBufRef.current
    let n = 0

    // Flat-array format from the new dashboard.
    if (Array.isArray(data.p) && typeof data.n === 'number') {
      const p = data.p
      n = Math.min(data.n, MAX_PTS)
      for (let i = 0; i < n; i++) {
        const px = p[i * 3]
        const py = p[i * 3 + 1]
        const pz = p[i * 3 + 2]
        // lidarToThree mapping inlined: (x, y, z) -> (x, z, y)
        positions[i * 3]     = px
        positions[i * 3 + 1] = pz
        positions[i * 3 + 2] = py
        const c = heightColor(pz)
        colors[i * 3]     = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      }
    } else if (Array.isArray(data) || Array.isArray(data.points)) {
      // Legacy {x, y, z} dict array.
      const pts = Array.isArray(data) ? data : data.points
      n = Math.min(pts.length, MAX_PTS)
      for (let i = 0; i < n; i++) {
        const q = pts[i]
        positions[i * 3]     = q.x
        positions[i * 3 + 1] = q.z
        positions[i * 3 + 2] = q.y
        const c = heightColor(q.z)
        colors[i * 3]     = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      }
    } else {
      return
    }

    const geo = geoRef.current
    geo.setDrawRange(0, n)
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate    = true
    // Skip computeBoundingSphere — wastes CPU; OrbitControls already
    // knows where to look and frustum culling is unnecessary here.
  })

  return (
    <points ref={meshRef}>
      <primitive object={geoRef.current} attach="geometry" />
      <pointsMaterial
        size={2.0}
        vertexColors
        sizeAttenuation={false}
      />
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

// Scene-graph tracked objects: orientation arrow + motion trail + velocity vector.
// Reads from STATE.scene_graph.objects (persistent track IDs); the per-frame
// raw LiDAR detections are rendered separately by DetectionMarkers.
function SceneObjects({ objects }) {
  if (!objects || objects.length === 0) return null
  return (
    <>
      {objects.map((obj, idx) => {
        const pos = obj.position
        if (!pos || pos.length < 3) return null
        const [tx, ty, tz] = lidarToThree(pos[0], pos[1], pos[2])
        const size = obj.size && obj.size.length >= 3 ? obj.size : [0.05, 0.05, 0.05]
        const W = Math.max(0.01, size[0])
        const D = Math.max(0.01, size[1])
        const H = Math.max(0.01, size[2])

        // Orientation: prefer the published euler[2] (yaw, degrees); fall
        // back to extracting from the quaternion if only that's present.
        let yawRad = 0
        if (obj.orientation && obj.orientation.length >= 3) {
          yawRad = obj.orientation[2] * Math.PI / 180
        } else if (obj.quat && obj.quat.length === 4) {
          const [qx, qy, qz, qw] = obj.quat
          yawRad = Math.atan2(2*(qw*qz + qx*qy), 1 - 2*(qy*qy + qz*qz))
        }

        const speed = obj.speed_mps || 0
        const moving = !!obj.is_moving

        // Box colour: green static / orange moving.
        const boxColor = moving ? '#F59E0B' : '#16A34A'

        // Orientation arrow — in three.js world (Y up), placed slightly
        // above the box centre, length scaled by the larger XY extent.
        const arrowLen = Math.max(W, D) * 0.9 + 0.04
        const arrowEnd = [
          tx + Math.cos(yawRad) * arrowLen,
          ty + H * 0.5 + 0.01,
          tz - Math.sin(yawRad) * arrowLen,
        ]

        // Motion trail.
        const path = obj.path
        let trailPositions = null
        let trailColors = null
        if (path && path.length >= 2) {
          trailPositions = new Float32Array(path.length * 3)
          trailColors    = new Float32Array(path.length * 3)
          for (let i = 0; i < path.length; i++) {
            const p = path[i]
            const [px, py, pz] = lidarToThree(p[0], p[1], p[2])
            trailPositions[i * 3]     = px
            trailPositions[i * 3 + 1] = py + 0.005    // float just above floor
            trailPositions[i * 3 + 2] = pz
            const t = i / (path.length - 1)             // 0=oldest, 1=newest
            // Fade from dark to cyan along the trail.
            trailColors[i * 3]     = 0.0
            trailColors[i * 3 + 1] = 0.4 + 0.6 * t
            trailColors[i * 3 + 2] = 0.5 + 0.5 * t
          }
        }

        // Velocity vector — fixed-length 10 cm direction line if moving.
        let velSeg = null
        if (moving && obj.velocity && obj.velocity.length >= 3) {
          const v = obj.velocity
          const vmag = Math.hypot(v[0], v[1], v[2])
          if (vmag > 1e-4) {
            const vlen = Math.min(0.15, vmag * 5.0)
            const vx = v[0] / vmag * vlen
            const vy = v[1] / vmag * vlen
            const vz = v[2] / vmag * vlen
            const [evx, evy, evz] = lidarToThree(pos[0] + vx, pos[1] + vy, pos[2] + vz)
            velSeg = new Float32Array([tx, ty + H * 0.5 + 0.04, tz, evx, evy + H * 0.5 + 0.04, evz])
          }
        }

        const yawDeg = (yawRad * 180 / Math.PI).toFixed(0)

        return (
          <group key={obj.id ?? idx}>
            {/* Wireframe box at the track centre */}
            <group position={[tx, ty, tz]} rotation={[0, yawRad, 0]}>
              <lineSegments>
                <edgesGeometry args={[new THREE.BoxGeometry(W, H, D)]} />
                <lineBasicMaterial color={boxColor} linewidth={2} />
              </lineSegments>
            </group>

            {/* Orientation arrow: line from box centre out by arrowLen */}
            <line>
              <bufferGeometry
                onUpdate={(g) => g.setAttribute('position',
                  new THREE.BufferAttribute(new Float32Array([
                    tx, ty + H * 0.5 + 0.01, tz,
                    arrowEnd[0], arrowEnd[1], arrowEnd[2],
                  ]), 3))}
              />
              <lineBasicMaterial color="#22D3EE" linewidth={2} />
            </line>
            {/* Cone arrowhead */}
            <mesh
              position={arrowEnd}
              rotation={[0, yawRad - Math.PI / 2, 0]}
            >
              <coneGeometry args={[0.012, 0.03, 8]} />
              <meshBasicMaterial color="#22D3EE" />
            </mesh>

            {/* Motion trail */}
            {trailPositions && (
              <line>
                <bufferGeometry
                  onUpdate={(g) => {
                    g.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))
                    g.setAttribute('color',    new THREE.BufferAttribute(trailColors, 3))
                  }}
                />
                <lineBasicMaterial vertexColors transparent opacity={0.85} />
              </line>
            )}

            {/* Velocity vector — short red line above the box */}
            {velSeg && (
              <line>
                <bufferGeometry
                  onUpdate={(g) => g.setAttribute('position',
                    new THREE.BufferAttribute(velSeg, 3))}
                />
                <lineBasicMaterial color="#EF4444" linewidth={3} />
              </line>
            )}
          </group>
        )
      })}
    </>
  )
}

// Backwards-compat alias used by Scene below.
const ObjectMarkers = SceneObjects

// Stereo-verified placed objects from /perception/placed_objects.
// position_lidar carries the surface-anchored XYZ (camera XY + LiDAR
// Z). We render the box AT that position with its real size — the
// publisher chose center_z = surface + height/2 so the box bottom sits
// exactly on the point-cloud surface.
//   green solid wireframe : both cameras agreed (verified)
//   amber dashed-look     : only one camera saw it
function PlacedObjects({ objects }) {
  if (!objects || objects.length === 0) return null
  return (
    <>
      {objects.map((o, i) => {
        const pos = o.position_lidar
        if (!pos || pos.length < 3) return null
        const [tx, ty, tz] = lidarToThree(pos[0], pos[1], pos[2])
        const size = o.size && o.size.length >= 3 ? o.size : [0.05, 0.05, 0.05]
        const W = Math.max(0.01, size[0])
        const D = Math.max(0.01, size[1])
        const H = Math.max(0.01, size[2])
        const yawDeg = (o.orientation && o.orientation.length >= 3) ? o.orientation[2] : 0
        const yaw = yawDeg * Math.PI / 180
        const verified = !!o.verified
        // Green for stereo-verified, amber for single-camera, grey if
        // the LiDAR couldn't anchor it (surface_unknown).
        const color = o.surface_unknown ? '#9CA3AF'
                       : verified         ? '#16A34A'
                       :                    '#F59E0B'
        return (
          <group key={o.id ?? i} position={[tx, ty, tz]} rotation={[0, yaw, 0]}>
            {/* Solid translucent box for verified, wireframe-only for single-cam */}
            {verified && (
              <mesh>
                <boxGeometry args={[W, H, D]} />
                <meshStandardMaterial color={color} transparent opacity={0.30} />
              </mesh>
            )}
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

// Real-time 3D detections from /perception/detections_3d (depth_segment_node).
//
// Detections are published in livox_frame (ROS: X=forward, Y=left, Z=up).
// PointCloud uses the mapping  three.x = lidar.x, three.y = lidar.z,
// three.z = lidar.y  — we match it here so markers and points share a
// world. OBB orientations are also in livox_frame; we extract the yaw
// component (rotation about lidar Z, which is three.js Y) and re-build a
// three.js-Y rotation — the y/z swap from lidar to three.js is a
// reflection, not a pure rotation, so the lidar quaternion can't be
// reused verbatim.
//
// Detections are positioned at the published centroid using the shared
// lidarToThree mapping — identical to PointCloud, mesh, and grasps. The
// publisher's bbox.center.z and bbox.size.z are constructed so that the
// box bottom (center.z - size.z/2) sits at the cluster's lowest point,
// which for the lidar_detector is on the table.
//
// The previous floor-anchor heuristic (median Z of nearby LiDAR points)
// was broken: for LiDAR-primary detections the cluster's own points
// are nearby, so the median lands MID-OBJECT instead of on the floor.
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

        const W = Math.max(0.01, det.w ?? 0.05)
        const D = Math.max(0.01, det.h ?? 0.05)
        const H = Math.max(0.01, det.d ?? 0.05)
        const color = bandColor(Math.max(W, D, H))

        let yaw = 0
        if (det.quat && det.quat.length === 4) {
          const [qx, qy, qz, qw] = det.quat
          yaw = Math.atan2(2*(qw*qz + qx*qy), 1 - 2*(qy*qy + qz*qz))
        }

        // Direct centroid mapping — shared with PointCloud and Mesh.
        const [tx, ty, tz] = lidarToThree(det.x, det.y, det.z)

        return (
          <group
            key={det.id ?? i}
            position={[tx, ty, tz]}
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
function ReconstructionMesh({ meshRef, meshWireRef }) {
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
      const [tx, ty, tz] = lidarToThree(v[0], v[1], v[2])
      positions[i * 3]     = tx
      positions[i * 3 + 1] = ty
      positions[i * 3 + 2] = tz
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
          opacity: 0.75,
          side: THREE.DoubleSide,
          flatShading: false,
          wireframe: meshWireRef.current === true,
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

        const [px, py, pz] = lidarToThree(g.x, g.y, g.z)
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

function Scene({ pointsRef, meshRef, meshWireRef, zone, preset, sceneObjects, detections, grasps, placedObjects }) {
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
      <ReconstructionMesh meshRef={meshRef} meshWireRef={meshWireRef} />
      <ObjectMarkers objects={sceneObjects} />
      <DetectionMarkers detections={detections} />
      <PlacedObjects objects={placedObjects} />
      <GraspMarkers grasps={grasps} />

      <CameraController preset={preset} />
      <OrbitControls enableDamping dampingFactor={0.08} />
    </>
  )
}

export default function LidarPanel() {
  const zone         = useStore((s) => s.safety.zone)
  const sceneObjects = useStore((s) => s.scene_graph.objects)
  // LiDAR-derived 3D objects only. Camera detections (s.detections)
  // stay on the camera feeds, never in the 3D view.
  const detections   = useStore((s) => s.lidar_objects)
  const grasps       = useStore((s) => s.grasp_poses)
  const placedObjects = useStore((s) => s.placed_objects)

  const pointsRef   = useRef([])
  const meshRef     = useRef(null)
  const meshWireRef = useRef(false)
  const wsRef       = useRef(null)
  const meshWsRef   = useRef(null)
  const [preset,       setPreset]       = useState('3d')
  const [wireframe,    setWireframe]    = useState(false)
  const [wsConnected,  setWsConnected]  = useState(false)
  const [isLive,       setIsLive]       = useState(false)
  const [pointCount,   setPointCount]   = useState(0)
  const [meshTriCount, setMeshTriCount] = useState(0)
  useEffect(() => { meshWireRef.current = wireframe }, [wireframe])

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
          // New flat-array format: {p: [...], n: N, live, t}
          // Legacy:                 {points: [{x,y,z},...], live, count, t}
          pointsRef.current = msg
          setIsLive(msg.live ?? false)
          setPointCount(msg.n ?? msg.count ?? (msg.points ? msg.points.length : 0))
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
          meshWireRef={meshWireRef}
          zone={zone}
          preset={preset}
          sceneObjects={sceneObjects}
          detections={detections}
          grasps={grasps}
          placedObjects={placedObjects}
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
        <button
          onClick={() => setWireframe((w) => !w)}
          title="Toggle mesh wireframe"
          style={{
            background: wireframe ? 'rgba(255,255,255,0.10)' : 'transparent',
            color: wireframe ? '#E6E8EE' : '#9AA0AC',
            border: 'none', padding: '3px 10px', borderRadius: 4, fontSize: 12,
            marginLeft: 4,
          }}
        >
          Wire
        </button>
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

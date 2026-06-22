import { useEffect, useMemo, useState } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

// LiDAR (ROS) frame:  +X forward, +Y left, +Z up  (right-handed).
// Three.js scene used by ArmViewer3D: lidarToThree maps
//   (x, y, z) → (x, z, -y)
// — handedness-preserving (det = +1, NOT a reflection). The previous
// bare (x, z, y) swap was a reflection and produced a mirrored scene
// where a known left-side object appeared on the right. Every cloud
// loop + helper in LidarPanel / ArmViewer3D / CellDetailPanel uses
// this exact mapping; collision-box positions must match.
//
// Under this mapping a positive ROS yaw (rotation about ROS Z) maps
// to a positive Three.js Y rotation by the same angle — same sign.
function lidarToThree(x, y, z) { return [x, z, -y] }

function statusColors(status) {
  switch (status) {
    case 'collision': return { stroke: '#dc2626', fill: '#ef444433' }
    case 'warning':   return { stroke: '#eab308', fill: '#facc1533' }
    default:          return { stroke: '#22c55e', fill: '#22c55e22' }
  }
}

// ────────────────────────────────────────────────────────────────────────
// 3D pieces — mount inside <Canvas>{ ... }</Canvas>
// ────────────────────────────────────────────────────────────────────────

function ReachCylinder({ radius }) {
  // Dashed circle at the floor (z=0) + at a sensible head-height plane to
  // make the cylindrical reach volume obvious without occluding objects.
  // Three.js cylinder geometry would block the points behind it, so use
  // line loops + a faint floor disc instead.
  const segs = 96
  const z0 = 0.0
  const zUpper = 1.6
  const pointsFloor = []
  const pointsTop   = []
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2
    const x = Math.cos(t) * radius
    const y = Math.sin(t) * radius
    const [tx, ty, tz] = lidarToThree(x, y, z0)
    pointsFloor.push(new THREE.Vector3(tx, ty, tz))
    const [tx2, ty2, tz2] = lidarToThree(x, y, zUpper)
    pointsTop.push(new THREE.Vector3(tx2, ty2, tz2))
  }
  const geoFloor = useMemo(() => new THREE.BufferGeometry().setFromPoints(pointsFloor), [radius])
  const geoTop   = useMemo(() => new THREE.BufferGeometry().setFromPoints(pointsTop),   [radius])
  return (
    <group>
      <lineSegments>
        <primitive object={geoFloor} attach="geometry" />
        <lineDashedMaterial color="#a3a3a3" dashSize={0.08} gapSize={0.05} transparent opacity={0.55} />
      </lineSegments>
      <line>
        <primitive object={geoFloor} attach="geometry" />
        <lineBasicMaterial color="#a3a3a3" transparent opacity={0.65} />
      </line>
      <line>
        <primitive object={geoTop} attach="geometry" />
        <lineBasicMaterial color="#a3a3a3" transparent opacity={0.35} />
      </line>
    </group>
  )
}

// Build a THREE.BufferGeometry from a {vertices, triangles} payload
// in the LiDAR/ROS frame, applying the same handedness-preserving
// lidarToThree mapping element-wise so the mesh sits exactly where
// the box would have. Memoise on the object identity so repeated
// store updates don't rebuild the geometry on every render.
function useMeshGeometry(payload) {
  return useMemo(() => {
    if (!payload?.vertices?.length || !payload?.triangles?.length) return null
    const v = payload.vertices
    const t = payload.triangles
    const positions = new Float32Array(v.length * 3)
    for (let i = 0; i < v.length; i++) {
      const [x, y, z] = v[i]
      const [tx, ty, tz] = lidarToThree(x || 0, y || 0, z || 0)
      positions[i * 3 + 0] = tx
      positions[i * 3 + 1] = ty
      positions[i * 3 + 2] = tz
    }
    const indices = new Uint32Array(t.length * 3)
    for (let i = 0; i < t.length; i++) {
      indices[i * 3 + 0] = t[i][0]
      indices[i * 3 + 1] = t[i][1]
      indices[i * 3 + 2] = t[i][2]
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(new THREE.BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    return geo
  }, [payload])
}

// Render a baseline-static keep-out zone as its CONCAVE alpha-shape
// (when present) with an edge wireframe overlay — tightly contoured
// to the cluster surface, not a box. Falls back to the convex
// collision hull when the alpha mesh is missing, so the operator
// never sees nothing where a zone should be.
function ContouredZone({ obj, fillColor, strokeColor, fillOpacity }) {
  // Try the visual mesh first, then the collision hull. We do this
  // unconditionally — the hooks run on every render regardless of
  // which mesh we end up drawing.
  const visualGeo = useMeshGeometry(obj.visual_mesh)
  const hullGeo   = useMeshGeometry(obj.collision_hull)
  const geo = visualGeo || hullGeo
  if (!geo) return null
  return (
    <group>
      <mesh geometry={geo}>
        <meshStandardMaterial
          color={fillColor}
          transparent
          opacity={fillOpacity}
          roughness={0.85}
          metalness={0.0}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <lineSegments>
        <wireframeGeometry attach="geometry" args={[geo]} />
        <lineBasicMaterial color={strokeColor} transparent opacity={0.55} />
      </lineSegments>
    </group>
  )
}

function ObjectBox({ obj, showLabel }) {
  const { center, dimensions, orientation = {}, status, static: isStatic, source } = obj
  // Baseline-built static zones (source=='baseline_static') render as
  // red/orange "permanent obstacle" volumes — distinct from the live
  // dynamic boxes which are green/yellow/red by proximity. We still
  // overlay the proximity color when the capsule check elevates them
  // to warning/collision, since those edges are what the operator
  // needs to react to.
  const isBaselineStatic = source === 'baseline_static'
  const fillColor   = isBaselineStatic ? '#ea580c' : statusColors(status).stroke
  const strokeColor = (isBaselineStatic && status === 'clear')
    ? '#ea580c'
    : statusColors(status).stroke

  // Tight contoured rendering for baseline-static zones that ship a
  // visual mesh (alpha-shape) or convex collision hull. The mesh
  // vertices are already in the LiDAR/ROS frame; ContouredZone applies
  // lidarToThree per vertex, so we render the mesh in scene space
  // without an enclosing group transform — keeps the cluster pinned
  // to its real points regardless of orientation.
  if (isBaselineStatic && (obj.visual_mesh || obj.collision_hull)) {
    return (
      <ContouredZone
        obj={obj}
        fillColor={fillColor}
        strokeColor={strokeColor}
        fillOpacity={0.22}
      />
    )
  }

  if (!center || !dimensions) return null
  const [px, py, pz] = lidarToThree(center.x || 0, center.y || 0, center.z || 0)
  // Map LiDAR/ROS quaternion (rotation about Z is "yaw" in LiDAR frame)
  // into Three's frame. Under the handedness-preserving lidarToThree
  // mapping (x, z, -y), ROS yaw about +Z is the same sign as Three Y
  // rotation about +Y — so we use +yaw directly. (The old scene used
  // `-yaw` to compensate for the previous mirrored mapping; that
  // negation is no longer needed.)
  const q = orientation
  const yaw = 2 * Math.atan2(q.z || 0, q.w || 1)
  // Three's box geometry argument order is X, Y, Z which after our axis
  // remap corresponds to LiDAR (X, Z, Y).
  const dx = Math.max(0.005, dimensions.x || 0)
  const dy = Math.max(0.005, dimensions.y || 0)
  const dz = Math.max(0.005, dimensions.z || 0)

  return (
    <group position={[px, py, pz]} rotation={[0, yaw, 0]}>
      <mesh>
        <boxGeometry args={[dx, dz, dy]} />
        <meshBasicMaterial
          color={fillColor}
          transparent
          opacity={isBaselineStatic ? 0.18 : isStatic ? 0.05 : 0.10}
        />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(dx, dz, dy)]} />
        {isBaselineStatic ? (
          <lineDashedMaterial color={strokeColor} dashSize={0.05} gapSize={0.025}
            transparent opacity={0.95} />
        ) : isStatic ? (
          <lineDashedMaterial color={strokeColor} dashSize={0.04} gapSize={0.025}
            transparent opacity={0.95} />
        ) : (
          <lineBasicMaterial color={strokeColor} linewidth={2} />
        )}
      </lineSegments>
      {/* Baseline-static keep-out boxes render WITHOUT a floating
          label — the orange box itself is enough signal and the
          "static obstacle · 47 mm" text clutter wasn't useful.
          Live dynamic detections keep their ID + min-distance label
          since those change as the scene changes and the number is
          actually informative. */}
      {showLabel && !isBaselineStatic && (
        <Html position={[0, dz / 2 + 0.05, 0]} center distanceFactor={2.5}
              style={{ pointerEvents: 'none' }}>
          <div style={{
            background: 'rgba(0,0,0,0.78)', color: '#fff',
            padding: '2px 6px', borderRadius: 4,
            fontSize: 10, fontFamily: 'ui-monospace, monospace',
            whiteSpace: 'nowrap',
            border: `1px solid ${strokeColor}`,
          }}>
            #{obj.id} · {(obj.min_distance_m * 1000).toFixed(0)} mm
            {isStatic ? ' · static' : ' · dynamic'}
          </div>
        </Html>
      )}
    </group>
  )
}

export function CollisionScene3D({ showLabels = true, showStatic = true, showDynamic = true }) {
  const collision = useStore((s) => s.collision)
  // Mesh data is persisted in collision_zones.json on the dashboard
  // side — too heavy for the 10 Hz /collision/objects feed but stable
  // across rebuilds. We fetch it once on mount and re-fetch when the
  // set of static-zone ids changes (i.e. operator rebuilt zones).
  const [zoneMeshes, setZoneMeshes] = useState({})
  const objects = collision?.objects || []
  const staticIds = useMemo(() => objects
    .filter((o) => o.source === 'baseline_static')
    .map((o) => o.id).sort().join(','), [objects])
  useEffect(() => {
    let aborted = false
    fetch('/api/collision/static_zones')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (aborted || !data) return
        const map = {}
        for (const z of (data.zones || [])) {
          if (!z?.id) continue
          map[z.id] = {
            visual_mesh:    z.visual_mesh    || null,
            collision_hull: z.collision_hull || null,
          }
        }
        setZoneMeshes(map)
      })
      .catch(() => {})
    return () => { aborted = true }
  }, [staticIds])

  if (!collision) return null
  const reach = collision.reach_radius_m || 1.4
  const filtered = objects.filter((o) => {
    const isBaselineStatic = o.source === 'baseline_static'
    if (isBaselineStatic) return showStatic
    return showDynamic
  })
  return (
    <group>
      <ReachCylinder radius={reach} />
      {filtered.map((o, i) => {
        // Join: per-tick payload is small, mesh data comes from the
        // persisted-zones fetch above. Both must be present for the
        // contoured render to take over.
        const meshes = zoneMeshes[o.id]
        const merged = meshes ? { ...o, ...meshes } : o
        return (
          <ObjectBox key={`${o.id ?? 'obj'}-${i}`} obj={merged} showLabel={showLabels} />
        )
      })}
    </group>
  )
}

// ────────────────────────────────────────────────────────────────────────
// HTML pieces — render OUTSIDE <Canvas>
// ────────────────────────────────────────────────────────────────────────

function statusToBanner(status) {
  if (status === 'collision') return { color: '#fff', bg: '#dc2626', label: 'COLLISION RISK' }
  if (status === 'warning')   return { color: '#1f2937', bg: '#facc15', label: 'PROXIMITY WARNING' }
  return                              { color: '#fff', bg: '#16a34a', label: 'CLEAR' }
}

export function CollisionBanner({ style }) {
  const status   = useStore((s) => s.collision?.status || 'clear')
  const minDist  = useStore((s) => s.collision?.min_distance_m)
  const count    = useStore((s) => (s.collision?.objects || []).length)
  const b = statusToBanner(status)
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      padding: '6px 14px', borderRadius: 999,
      background: b.bg, color: b.color,
      fontSize: 12, fontWeight: 700, letterSpacing: '0.05em',
      textTransform: 'uppercase',
      boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      ...style,
    }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: b.color, opacity: 0.85 }} />
      <span>{b.label}</span>
      <span style={{ opacity: 0.85, fontWeight: 500 }}>
        · {count} in-reach
        {Number.isFinite(minDist) && `, nearest ${(minDist * 1000).toFixed(0)} mm`}
      </span>
    </div>
  )
}

export function CollisionSidePanel({ style }) {
  const collision = useStore((s) => s.collision)
  const [mockOpen, setMockOpen] = useState(false)
  const [mock, setMock] = useState({ x: 0.6, y: 0.0, z: 0.30, sx: 0.10, sy: 0.10, sz: 0.20 })
  if (!collision) return null
  const objects = collision.objects || []

  const placeMock = async () => {
    try {
      await fetch('/api/collision/mock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center:     { x: Number(mock.x), y: Number(mock.y), z: Number(mock.z) },
          dimensions: { x: Number(mock.sx), y: Number(mock.sy), z: Number(mock.sz) },
          name:       'mock',
        }),
      })
    } catch {}
  }
  const clearMock = async () => {
    try { await fetch('/api/collision/mock', { method: 'DELETE' }) } catch {}
  }

  return (
    <div style={{
      pointerEvents: 'auto',
      background: 'rgba(15,23,42,0.92)', color: '#e5e7eb',
      border: '1px solid #1f2937', borderRadius: 10,
      padding: 10, fontSize: 11, lineHeight: 1.45,
      maxHeight: 360, overflowY: 'auto', minWidth: 220,
      ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Collision monitor
        </span>
        <span style={{ flex: 1 }} />
        {!collision.have_joints && (
          <span title="No /joint_states publisher — using URDF home pose"
            style={{ fontSize: 9, color: '#fbbf24', fontWeight: 700 }}>
            home pose
          </span>
        )}
      </div>
      {objects.length === 0 && (
        <div style={{ color: '#94a3b8' }}>No objects in reach.</div>
      )}
      {objects.map((o, i) => {
        const { stroke } = statusColors(o.status)
        return (
          <div key={`${o.id ?? 'obj'}-${i}`} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 0',
            borderTop: i > 0 ? '1px solid #1f2937' : 'none',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: 2, background: stroke, flexShrink: 0,
            }} />
            <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}>
              #{o.id} {o.name || o.identified_as || '?'} {o.mock ? '· mock' : (o.static ? '· static' : '· dyn')}
            </span>
            <span style={{ fontFamily: 'ui-monospace, monospace', color: stroke, fontWeight: 700 }}>
              {(o.min_distance_m * 1000).toFixed(0)} mm
            </span>
          </div>
        )
      })}
      <div style={{
        marginTop: 8, paddingTop: 8, borderTop: '1px solid #1f2937',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <button onClick={() => setMockOpen((o) => !o)} style={mockBtn('#475569')}>
          {mockOpen ? '− Mock injection' : '+ Mock injection'}
        </button>
      </div>
      {mockOpen && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          <NumRow label="X (m)"  v={mock.x}  onChange={(v) => setMock({ ...mock, x: v })} />
          <NumRow label="Y (m)"  v={mock.y}  onChange={(v) => setMock({ ...mock, y: v })} />
          <NumRow label="Z (m)"  v={mock.z}  onChange={(v) => setMock({ ...mock, z: v })} />
          <NumRow label="Size X" v={mock.sx} onChange={(v) => setMock({ ...mock, sx: v })} />
          <NumRow label="Size Y" v={mock.sy} onChange={(v) => setMock({ ...mock, sy: v })} />
          <NumRow label="Size Z" v={mock.sz} onChange={(v) => setMock({ ...mock, sz: v })} />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button onClick={placeMock} style={mockBtn('#7C3AED')}>Place mock</button>
            <button onClick={clearMock} style={mockBtn('#dc2626')}>Clear</button>
          </div>
          <div style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>
            Distance is the nearest AABB face to the origin, minus the
            base capsule radius (0.15 m). With a 0.10 m wide box: X=0.50
            → clear · X=0.30 → warning · X=0.22 → collision.
          </div>
        </div>
      )}
    </div>
  )
}

function mockBtn(bg) {
  return {
    background: bg, color: '#fff', border: 'none',
    padding: '4px 10px', borderRadius: 4,
    fontSize: 10, fontWeight: 600, cursor: 'pointer',
  }
}

function NumRow({ label, v, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <label style={{ width: 56, fontSize: 10, color: '#94a3b8' }}>{label}</label>
      <input
        type="number" step="0.05"
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          flex: 1, padding: '3px 6px', fontSize: 11,
          background: '#0f172a', color: '#e5e7eb',
          border: '1px solid #1f2937', borderRadius: 3, outline: 'none',
        }}
      />
    </div>
  )
}

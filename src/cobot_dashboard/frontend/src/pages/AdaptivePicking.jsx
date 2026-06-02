import { useState, useEffect, useRef, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader'

// step_parser.py writes a .stl alongside each uploaded .step. The
// dashboard's upload endpoint copies that .stl into the dashboard's
// static dir under /parts/<file>.stl, which we load here via STLLoader.
// (No GLTFLoader / no GLB — keeps the toolchain shallow.)

const SURFACE_OPTIONS = [
  { label: '+Z up (top)',         rotation: [0, 0, 0]            },
  { label: '−Z up (bottom)',      rotation: [Math.PI, 0, 0]       },
  { label: '+X up (right side)',  rotation: [0, 0, -Math.PI / 2] },
  { label: '−X up (left side)',   rotation: [0, 0,  Math.PI / 2] },
  { label: '+Y up (front)',       rotation: [-Math.PI / 2, 0, 0] },
  { label: '−Y up (back)',        rotation: [ Math.PI / 2, 0, 0] },
]

const FRONT_OPTIONS = [
  { label: '↑', angle: 0   },
  { label: '→', angle: 90  },
  { label: '↓', angle: 180 },
  { label: '←', angle: 270 },
]

// ── 3D model loaded from STL ─────────────────────────────────────────

function PartModel3D({ url, rotation, frontAngle }) {
  const groupRef = useRef()
  const meshRef  = useRef(null)
  const [ready, setReady] = useState(false)

  // Load the STL, build the mesh, and attach it imperatively to the
  // group. Imperative attach guarantees the mesh is in the scene graph
  // by the time the rotation effect's Box3 measurement runs — JSX
  // children + ref + effect ordering was unreliable on the first frame.
  useEffect(() => {
    setReady(false)
    if (!url || !groupRef.current) return
    // Tear down any previous mesh
    if (meshRef.current) {
      groupRef.current.remove(meshRef.current)
      meshRef.current.geometry?.dispose()
      meshRef.current.material?.dispose()
      meshRef.current = null
    }
    const loader = new STLLoader()
    loader.load(
      url,
      (g) => {
        g.computeVertexNormals()
        g.center()
        g.computeBoundingBox()
        const b = g.boundingBox
        const max = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
        if (max > 0) g.scale(0.4 / max, 0.4 / max, 0.4 / max)
        // Matte material — metallic on a white background with no env
        // map ends up reading near-black. roughness=0.65 keeps a hint
        // of specular without needing an environment.
        const mat = new THREE.MeshStandardMaterial({
          color:     '#9aa3b2',
          metalness: 0.05,
          roughness: 0.65,
        })
        const mesh = new THREE.Mesh(g, mat)
        mesh.castShadow = true
        mesh.receiveShadow = true
        meshRef.current = mesh
        if (groupRef.current) {
          groupRef.current.add(mesh)
          setReady(true)
        }
      },
      undefined,
      (err) => console.warn('STL load failed:', err),
    )
    return () => {
      if (groupRef.current && meshRef.current) {
        groupRef.current.remove(meshRef.current)
      }
      meshRef.current?.geometry?.dispose()
      meshRef.current?.material?.dispose()
      meshRef.current = null
    }
  }, [url])

  // Apply rotation + snap bottom to Y=0. Runs once when `ready` flips
  // true (first frame the mesh is in the group) and on every
  // rotation/frontAngle change after that.
  useEffect(() => {
    if (!groupRef.current || !ready) return
    groupRef.current.rotation.set(
      rotation[0],
      rotation[1] + (frontAngle * Math.PI / 180),
      rotation[2],
    )
    groupRef.current.position.set(0, 0, 0)
    groupRef.current.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(groupRef.current)
    if (isFinite(box.min.y)) {
      groupRef.current.position.y = -box.min.y
    }
  }, [rotation, frontAngle, ready])

  return <group ref={groupRef} />
}

// ── Gripper previews (world-space, sits above the part) ─────────────

const APPROACH_HEIGHT = 0.35   // world Y above the table
const VIEWER_SCALE    = 2.5    // cm/mm -> viewer-units multiplier

function FingerGripperPreview({ settings }) {
  const width    = ((settings.gripper_width_cm ?? 5) / 100) * VIEWER_SCALE
  const depth    = ((settings.finger_depth_cm   ?? 3) / 100) * VIEWER_SCALE
  const thick    = 0.015 * VIEWER_SCALE
  const halfOpen = width / 2
  return (
    <group position={[0, APPROACH_HEIGHT, 0]}>
      {/* Mount plate */}
      <mesh position={[0, 0.04, 0]}>
        <boxGeometry args={[width * 1.2, 0.02 * VIEWER_SCALE, depth * 0.8]} />
        <meshStandardMaterial color="#404550" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Fingers */}
      <mesh position={[-halfOpen, -0.02, 0]}>
        <boxGeometry args={[thick, 0.06 * VIEWER_SCALE, depth]} />
        <meshStandardMaterial color="#606876" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[halfOpen, -0.02, 0]}>
        <boxGeometry args={[thick, 0.06 * VIEWER_SCALE, depth]} />
        <meshStandardMaterial color="#606876" metalness={0.6} roughness={0.35} />
      </mesh>
      {/* Approach arrow */}
      <mesh position={[0, 0.12, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.015 * VIEWER_SCALE, 0.04 * VIEWER_SCALE, 8]} />
        <meshBasicMaterial color="#16A34A" />
      </mesh>
    </group>
  )
}

function SuctionCupPreview({ settings }) {
  const cupDiameter = ((settings.cup_diameter_mm ?? 30) / 1000) * VIEWER_SCALE
  const numCups     = settings.num_cups ?? 1
  const cupRadius   = cupDiameter / 2

  const cupPositions = []
  if (numCups === 1) {
    cupPositions.push([0, 0, 0])
  } else if (numCups === 2) {
    cupPositions.push([-cupDiameter * 0.8, 0, 0])
    cupPositions.push([ cupDiameter * 0.8, 0, 0])
  } else if (numCups === 4) {
    cupPositions.push([-cupDiameter * 0.8, 0, -cupDiameter * 0.8])
    cupPositions.push([ cupDiameter * 0.8, 0, -cupDiameter * 0.8])
    cupPositions.push([-cupDiameter * 0.8, 0,  cupDiameter * 0.8])
    cupPositions.push([ cupDiameter * 0.8, 0,  cupDiameter * 0.8])
  }
  const plateR = Math.max(cupDiameter * 1.5, cupDiameter * 0.8 * Math.SQRT2 + cupRadius)

  return (
    <group position={[0, APPROACH_HEIGHT, 0]}>
      {/* Vacuum manifold */}
      <mesh position={[0, 0.04, 0]}>
        <cylinderGeometry args={[plateR, plateR, 0.015 * VIEWER_SCALE, 24]} />
        <meshStandardMaterial color="#404550" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Vacuum tube */}
      <mesh position={[0, 0.08, 0]}>
        <cylinderGeometry args={[0.006 * VIEWER_SCALE, 0.006 * VIEWER_SCALE, 0.06 * VIEWER_SCALE, 12]} />
        <meshStandardMaterial color="#505560" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Cups */}
      {cupPositions.map((pos, i) => (
        <group key={i} position={pos}>
          <mesh position={[0, -0.01, 0]}>
            <cylinderGeometry args={[cupRadius, cupRadius * 0.7, 0.025 * VIEWER_SCALE, 16]} />
            <meshStandardMaterial color="#2563EB" transparent opacity={0.85} roughness={0.7} />
          </mesh>
          <mesh position={[0, -0.025, 0]}>
            <torusGeometry args={[cupRadius, 0.003 * VIEWER_SCALE, 8, 24]} />
            <meshStandardMaterial color="#1D4ED8" roughness={0.6} />
          </mesh>
        </group>
      ))}
      {/* Approach arrow */}
      <mesh position={[0, 0.14, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.015 * VIEWER_SCALE, 0.04 * VIEWER_SCALE, 8]} />
        <meshBasicMaterial color="#16A34A" />
      </mesh>
    </group>
  )
}

function GripperPreview3D({ type, settings }) {
  if (type === 'suction') return <SuctionCupPreview settings={settings} />
  return <FingerGripperPreview settings={settings} />
}

function PartCanvas({ url, rotation, frontAngle, gripperType, graspSettings }) {
  return (
    <Canvas shadows camera={{ position: [1.0, 0.8, 1.0], fov: 38 }}
            style={{ width: '100%', height: '100%', background: '#FFFFFF' }}>
      {/* Brighter lighting so metallic surfaces read against white. */}
      <ambientLight intensity={0.75} />
      <directionalLight position={[3, 5, 3]} intensity={0.9} castShadow
                        shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[-3, 4, -2]} intensity={0.35} />
      {/* Ground plane carries only the shadow — keeps the floor white. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[2, 2]} />
        <shadowMaterial opacity={0.18} />
      </mesh>
      <gridHelper args={[2, 20, '#D0D4DC', '#E8EAF0']} />
      {/* Front-direction marker (always renders flat to the table). */}
      <group rotation={[0, -(frontAngle * Math.PI / 180), 0]}>
        <mesh position={[0, 0.005, -0.4]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.035, 0.09, 16]} />
          <meshBasicMaterial color="#3B82F6" />
        </mesh>
      </group>
      <group position={[-0.7, 0, -0.7]}>
        <axesHelper args={[0.18]} />
      </group>
      <Suspense fallback={null}>
        <PartModel3D url={url} rotation={rotation} frontAngle={frontAngle} />
      </Suspense>
      {gripperType && <GripperPreview3D type={gripperType} settings={graspSettings || {}} />}
      <OrbitControls enableDamping dampingFactor={0.08} />
    </Canvas>
  )
}

// ── Tagging components (operations, program, station, notes) ────────

const OP_COLORS = {
  pick:         '#16A34A',
  place:        '#2563EB',
  insert:       '#9333EA',
  inspect:      '#CA8A04',
  sort:         '#0891B2',
  assemble:     '#DC2626',
  package:      '#7C3AED',
  machine_tend: '#4B5563',
}

const ALL_OPS = [
  { id: 'pick',         label: 'Pick',         icon: '🤏' },
  { id: 'place',        label: 'Place',        icon: '📍' },
  { id: 'insert',       label: 'Insert',       icon: '🔩' },
  { id: 'inspect',      label: 'Inspect',      icon: '🔍' },
  { id: 'sort',         label: 'Sort',         icon: '📊' },
  { id: 'assemble',     label: 'Assemble',     icon: '🔧' },
  { id: 'package',      label: 'Package',      icon: '📦' },
  { id: 'machine_tend', label: 'Machine Tend', icon: '🏭' },
]

function OperationTags({ selected, onChange }) {
  const toggle = (id) =>
    onChange(selected.includes(id) ? selected.filter(o => o !== id) : [...selected, id])
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        Operations
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted, #9ca3af)', marginBottom: 8 }}>
        What will the robot do with this part? Select all that apply.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {ALL_OPS.map((op) => {
          const c = OP_COLORS[op.id] || '#666'
          const active = selected.includes(op.id)
          return (
            <button key={op.id} onClick={() => toggle(op.id)}
              style={{
                padding: '6px 10px', fontSize: 11, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4, borderRadius: 20,
                background: active ? `${c}28`               : 'var(--bg-surface)',
                color:      active ? c                       : 'var(--text-muted, #9ca3af)',
                border:     active ? `1px solid ${c}80`      : '1px solid var(--border)',
                fontWeight: active ? 600 : 400,
              }}
            >
              <span>{op.icon}</span><span>{op.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ProgramLinker({ programId, onChange }) {
  const [programs, setPrograms] = useState([])
  useEffect(() => {
    fetch('/api/programs')
      .then(r => r.json())
      .then(d => setPrograms(d.programs || []))
      .catch(() => setPrograms([]))
  }, [])
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        Robot Program
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted, #9ca3af)', marginBottom: 8 }}>
        Link this part to a specific robot program
      </div>
      <select value={programId || ''}
        onChange={(e) => {
          const id = e.target.value || null
          const prog = id ? programs.find((p) => p.id === id) : null
          onChange(id, prog?.name || '')
        }}
        style={{
          width: '100%', padding: 8, fontSize: 12,
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 4px)',
        }}
      >
        <option value="">No program linked</option>
        {programs.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.steps} steps)
          </option>
        ))}
      </select>
    </div>
  )
}

function StationPriority({ station, priority, onStationChange, onPriorityChange }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Station</div>
        <input type="text" value={station}
          onChange={(e) => onStationChange(e.target.value)}
          placeholder="e.g. Station A"
          style={{
            width: '100%', padding: 8, fontSize: 12,
            background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 4px)',
          }}
        />
      </div>
      <div style={{ width: 120 }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
          Priority: {priority}
        </div>
        <input type="range" min="1" max="5" step="1" value={priority}
          onChange={(e) => onPriorityChange(parseInt(e.target.value, 10))}
          style={{ width: '100%' }}
        />
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--text-muted, #9ca3af)',
        }}><span>High</span><span>Low</span></div>
      </div>
    </div>
  )
}

function PartNotes({ notes, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Notes</div>
      <textarea value={notes} rows={3}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Any special handling instructions…"
        style={{
          width: '100%', padding: 8, fontSize: 12, resize: 'vertical',
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 4px)',
          fontFamily: 'inherit',
        }}
      />
    </div>
  )
}

// ── Configurator ─────────────────────────────────────────────────────

function PartConfigurator({ partId, onSave, onDelete }) {
  const [part, setPart]           = useState(null)
  const [tableSurface, setTSurf]  = useState(SURFACE_OPTIONS[0].label)
  const [rotation, setRotation]   = useState(SURFACE_OPTIONS[0].rotation)
  const [frontDir, setFrontDir]   = useState(FRONT_OPTIONS[0].label)
  const [frontAngle, setFAng]     = useState(0)
  const [operations,  setOperations]  = useState([])
  const [programId,   setProgramId]   = useState(null)
  const [programName, setProgramName] = useState('')
  const [station,     setStation]     = useState('')
  const [priority,    setPriority]    = useState(3)
  const [notes,       setNotes]       = useState('')
  const [gripperType, setGripperType] = useState('finger')
  const [grasp, setGrasp]         = useState({
    approach:         'top_down',
    gripper_width_cm: 5.0,
    pick_offset_cm:   2.0,
    finger_depth_cm:  3.0,
    cup_diameter_mm:  30,
    num_cups:         1,
    vacuum_threshold: 70,
  })
  const [saving, setSaving]       = useState(false)

  useEffect(() => {
    fetch(`/api/parts/${partId}`)
      .then(r => r.json())
      .then(d => {
        if (!d || d.error) return
        setPart(d)
        if (d.table_surface)   setTSurf(d.table_surface)
        if (d.table_rotation)  setRotation(d.table_rotation)
        if (d.front_direction) setFrontDir(d.front_direction)
        if (d.front_angle_deg !== undefined) setFAng(d.front_angle_deg)
        if (Array.isArray(d.operations))     setOperations(d.operations)
        if (d.program_id)                    setProgramId(d.program_id)
        if (d.program_name)                  setProgramName(d.program_name)
        if (d.station)                       setStation(d.station)
        if (typeof d.priority === 'number')  setPriority(d.priority)
        if (d.notes)                         setNotes(d.notes)
        if (d.grasp) {
          if (d.grasp.gripper_type) setGripperType(d.grasp.gripper_type)
          setGrasp({
            approach:         d.grasp.approach || 'top_down',
            gripper_width_cm: d.grasp.gripper_width_cm
              ?? ((d.grasp.gripper_opening_m ?? 0.05) * 100),
            pick_offset_cm:   d.grasp.pick_offset_cm ?? 2.0,
            finger_depth_cm:  d.grasp.finger_depth_cm ?? 3.0,
            cup_diameter_mm:  d.grasp.cup_diameter_mm ?? 30,
            num_cups:         d.grasp.num_cups ?? 1,
            vacuum_threshold: d.grasp.vacuum_threshold ?? 70,
          })
        }
      })
  }, [partId])

  async function save() {
    setSaving(true)
    try {
      const cfgRes = await fetch(`/api/parts/${partId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:            part?.name,
          table_surface:   tableSurface,
          table_rotation:  rotation,
          front_direction: frontDir,
          front_angle_deg: frontAngle,
          grasp: { ...grasp, gripper_type: gripperType },
        }),
      })
      const tagRes = await fetch(`/api/parts/${partId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operations,
          program_id:   programId,
          program_name: programName,
          station,
          priority,
          notes,
        }),
      })
      const cfgD = await cfgRes.json()
      const tagD = await tagRes.json()
      if (cfgRes.ok && tagRes.ok) {
        // tagRes is freshest — it overwrote the same file last.
        setPart(tagD.part || cfgD.part)
        onSave?.()
      } else {
        console.warn('save error:', cfgD.error || tagD.error)
      }
    } finally {
      setSaving(false)
    }
  }

  if (!part) {
    return (
      <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>
        Loading…
      </div>
    )
  }

  const stlUrl = part.stl_file ? `/parts/${part.stl_file}` : null
  const ex = part.extents_cm || [0, 0, 0]

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* 3D viewer — 60% */}
      <div style={{ flex: 3, background: '#FFFFFF', position: 'relative' }}>
        <PartCanvas url={stlUrl} rotation={rotation} frontAngle={frontAngle}
                    gripperType={gripperType} graspSettings={grasp} />
        <div style={{
          position: 'absolute', top: 12, left: 12,
          background: 'rgba(255,255,255,0.85)', color: '#111827',
          padding: '6px 12px', borderRadius: 6,
          fontSize: 14, fontWeight: 600,
          border: '1px solid rgba(0,0,0,0.06)',
        }}>{part.name}</div>
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(255,255,255,0.85)', color: '#374151',
          padding: '4px 10px', borderRadius: 4, fontSize: 11,
          border: '1px solid rgba(0,0,0,0.06)',
        }}>
          {ex[0]}×{ex[1]}×{ex[2]} cm · {part.vertices} verts
          {part.volume_cm3 ? ` · ${part.volume_cm3} cm³` : ''}
        </div>
      </div>

      {/* Config panel — 40% */}
      <div style={{
        flex: 2, overflowY: 'auto', padding: 20,
        background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0,
      }}>
        {/* Table surface */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            Table Surface
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted, #9ca3af)', marginBottom: 8 }}>
            Which face sits on the table?
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {SURFACE_OPTIONS.map((opt) => {
              const active = tableSurface === opt.label
              return (
                <button key={opt.label}
                  onClick={() => { setTSurf(opt.label); setRotation(opt.rotation) }}
                  style={{
                    padding: 8, fontSize: 11, cursor: 'pointer',
                    background: active ? 'rgba(59,130,246,0.18)' : 'var(--bg-surface)',
                    color:      active ? '#60a5fa' : 'var(--text-secondary)',
                    border:     active ? '1px solid rgba(59,130,246,0.6)' : '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm, 4px)',
                    fontWeight: active ? 600 : 400,
                    textAlign: 'center',
                  }}
                >{opt.label}</button>
              )
            })}
          </div>
        </div>

        {/* Front direction */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            Front Direction
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted, #9ca3af)', marginBottom: 8 }}>
            Which way does the front face?
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
            {FRONT_OPTIONS.map((opt) => {
              const active = frontDir === opt.label
              return (
                <button key={opt.label}
                  onClick={() => { setFrontDir(opt.label); setFAng(opt.angle) }}
                  style={{
                    padding: 10, fontSize: 18, cursor: 'pointer',
                    background: active ? 'rgba(59,130,246,0.18)' : 'var(--bg-surface)',
                    color:      active ? '#60a5fa' : 'var(--text-secondary)',
                    border:     active ? '1px solid rgba(59,130,246,0.6)' : '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm, 4px)',
                  }}
                >{opt.label}</button>
              )
            })}
          </div>
        </div>

        {/* Gripper type */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            Gripper Type
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { type: 'finger',  label: 'Finger Gripper', icon: '🤏',
                desc: 'Two parallel jaws. Rigid parts with flat sides.' },
              { type: 'suction', label: 'Suction Cup',    icon: '🔵',
                desc: 'Vacuum. Flat, smooth, non-porous surfaces.' },
            ].map((opt) => {
              const active = gripperType === opt.type
              return (
                <button key={opt.type} onClick={() => setGripperType(opt.type)}
                  style={{
                    padding: '14px 12px', cursor: 'pointer', textAlign: 'center',
                    background: active ? 'rgba(59,130,246,0.18)' : 'var(--bg-surface)',
                    border:     active ? '2px solid rgba(59,130,246,0.7)' : '2px solid var(--border)',
                    borderRadius: 'var(--radius-md, 6px)',
                  }}
                >
                  <div style={{ fontSize: 28, marginBottom: 6 }}>{opt.icon}</div>
                  <div style={{
                    fontSize: 12, fontWeight: 600,
                    color: active ? '#60a5fa' : 'var(--text-primary)',
                  }}>{opt.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted, #9ca3af)', marginTop: 4 }}>
                    {opt.desc}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Grasp settings */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            Grasp Settings
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
              Approach
            </div>
            <select value={grasp.approach}
              onChange={(e) => setGrasp({ ...grasp, approach: e.target.value })}
              style={{
                width: '100%', padding: 8, fontSize: 12,
                background: 'var(--bg-surface)', color: 'var(--text-primary)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 4px)',
              }}
            >
              <option value="top_down">Top down (↓)</option>
              <option value="side">Side approach (→)</option>
              <option value="angled">Angled (↘ 45°)</option>
            </select>
          </div>

          {gripperType === 'finger' ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Gripper opening: {grasp.gripper_width_cm.toFixed(1)} cm
                </div>
                <input type="range" min="0.5" max="15" step="0.1"
                  value={grasp.gripper_width_cm}
                  onChange={(e) => setGrasp({ ...grasp, gripper_width_cm: parseFloat(e.target.value) })}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Finger depth: {(grasp.finger_depth_cm ?? 3).toFixed(1)} cm
                </div>
                <input type="range" min="1" max="8" step="0.5"
                  value={grasp.finger_depth_cm ?? 3}
                  onChange={(e) => setGrasp({ ...grasp, finger_depth_cm: parseFloat(e.target.value) })}
                  style={{ width: '100%' }}
                />
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Cup diameter: {(grasp.cup_diameter_mm ?? 30).toFixed(0)} mm
                </div>
                <input type="range" min="10" max="80" step="5"
                  value={grasp.cup_diameter_mm ?? 30}
                  onChange={(e) => setGrasp({ ...grasp, cup_diameter_mm: parseFloat(e.target.value) })}
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Number of cups
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1, 2, 4].map((n) => {
                    const active = (grasp.num_cups ?? 1) === n
                    return (
                      <button key={n}
                        onClick={() => setGrasp({ ...grasp, num_cups: n })}
                        style={{
                          flex: 1, padding: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          background: active ? 'rgba(59,130,246,0.18)' : 'var(--bg-surface)',
                          color:      active ? '#60a5fa' : 'var(--text-secondary)',
                          border:     active ? '1px solid rgba(59,130,246,0.6)' : '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm, 4px)',
                        }}
                      >{n} cup{n > 1 ? 's' : ''}</button>
                    )
                  })}
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Vacuum threshold: {(grasp.vacuum_threshold ?? 70).toFixed(0)}%
                </div>
                <input type="range" min="30" max="95" step="5"
                  value={grasp.vacuum_threshold ?? 70}
                  onChange={(e) => setGrasp({ ...grasp, vacuum_threshold: parseFloat(e.target.value) })}
                  style={{ width: '100%' }}
                />
              </div>
            </>
          )}

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
              Pick height offset: {grasp.pick_offset_cm.toFixed(1)} cm
            </div>
            <input type="range" min="0" max="10" step="0.5"
              value={grasp.pick_offset_cm}
              onChange={(e) => setGrasp({ ...grasp, pick_offset_cm: parseFloat(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        {/* Operation tags */}
        <OperationTags selected={operations} onChange={setOperations} />

        {/* Robot program link */}
        <ProgramLinker programId={programId}
          onChange={(id, name) => { setProgramId(id); setProgramName(name) }}
        />

        {/* Station + priority */}
        <StationPriority station={station} priority={priority}
          onStationChange={setStation} onPriorityChange={setPriority}
        />

        {/* Free-text notes */}
        <PartNotes notes={notes} onChange={setNotes} />

        {/* Actions */}
        <div style={{
          display: 'flex', gap: 8,
          marginTop: 'auto', paddingTop: 12,
          borderTop: '1px solid var(--border)',
        }}>
          <button onClick={save} disabled={saving} style={{
            flex: 1, padding: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: 'rgba(34,197,94,0.18)', color: '#22c55e',
            border: '1px solid rgba(34,197,94,0.6)', borderRadius: 'var(--radius-md, 6px)',
          }}>{saving ? 'Saving…' : 'Save Configuration'}</button>
          <button onClick={onDelete} style={{
            padding: '10px 16px', fontSize: 13, cursor: 'pointer',
            background: 'rgba(239,68,68,0.12)', color: '#ef4444',
            border: '1px solid rgba(239,68,68,0.5)', borderRadius: 'var(--radius-md, 6px)',
          }}>Delete</button>
        </div>
      </div>
    </div>
  )
}

// ── Teaching wizard ──────────────────────────────────────────────────
//
// Operators were never finding the tiny "teach as <part>" button on the
// detections panel. This wizard walks them through 4 angles of the same
// part, posting to /api/parts/:id/teach for each one. depth_segment_node
// stores the resulting .npz fingerprints under /opt/cobot/parts/teach/:id
// and api_parts_list counts them back to render the green "Taught" pill.

function TeachWizard({ part, onClose, onComplete }) {
  const [step, setStep]                       = useState(0)
  const [captures, setCaptures]               = useState([])
  const [capturing, setCapturing]             = useState(false)
  const [error, setError]                     = useState(null)
  const [liveDetections, setLiveDetections]   = useState([])
  const [selectedDetection, setSelectedDet]   = useState(null)
  const [flashGreen, setFlashGreen]           = useState(false)
  // 'pickable' = part lying as it should be picked
  // 'flipped'  = part upside-down (robot must flip before pick)
  // 'on_side'  = part on its side (robot must reorient before pick)
  const [orientation, setOrientation]         = useState('pickable')
  // Rendered image bounds inside the camera pane. The MJPEG stream is
  // 640×480 native; the <img> uses object-fit:contain so the actual
  // drawn area is letterboxed inside its container. Detection boxes
  // need to be positioned against the *drawn* area, not the container.
  const imgRef                                = useRef(null)
  const [imgBounds, setImgBounds]             = useState({
    w: 640, h: 480, offX: 0, offY: 0,
  })

  // Poll live detections from dashboard state at 2 Hz.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch('/api/state')
        const data = await res.json()
        if (!cancelled) setLiveDetections(data.detections || [])
      } catch { /* network blip — keep last list */ }
    }
    tick()
    const interval = setInterval(tick, 500)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Track the rendered image area so overlays line up with object-fit:contain.
  useEffect(() => {
    const updateBounds = () => {
      const el = imgRef.current
      if (!el || !el.parentElement) return
      const c = el.parentElement.getBoundingClientRect()
      const natW = 640, natH = 480
      const scale = Math.min(c.width / natW, c.height / natH)
      const renderedW = natW * scale
      const renderedH = natH * scale
      setImgBounds({
        w: renderedW,
        h: renderedH,
        offX: (c.width - renderedW) / 2,
        offY: (c.height - renderedH) / 2,
      })
    }
    updateBounds()
    let observer = null
    if (imgRef.current?.parentElement && 'ResizeObserver' in window) {
      observer = new ResizeObserver(updateBounds)
      observer.observe(imgRef.current.parentElement)
    }
    window.addEventListener('resize', updateBounds)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [step])

  async function captureTeach(detectionIndex) {
    setCapturing(true)
    setError(null)
    let ok = false
    try {
      // If nothing selected, idx=0 — depth_segment_node treats index 0
      // as the first (typically nearest/largest) detection.
      const idx = detectionIndex ?? 0
      const res = await fetch(`/api/parts/${part.id}/teach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          detection_index: idx,
          action: 'teach',
          part_id: part.id,
          orientation,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.captured === false) {
        // Endpoint succeeded but no file appeared — depth_segment_node
        // didn't have a usable detection. Tell the user to wait.
        setError('No object captured — make sure the part is in view '
          + 'and a green box is visible, then try again.')
      } else if (res.ok && (data.ok || data.status)) {
        setCaptures(prev => [...prev, {
          step,
          angle: (step - 1) * 90,
          timestamp: Date.now(),
          teach_count: data.teach_count,
        }])
        setFlashGreen(true)
        setTimeout(() => setFlashGreen(false), 600)
        ok = true
      } else {
        setError(data.error || `Capture failed (HTTP ${res.status})`)
      }
    } catch (e) {
      setError(e.message || 'Network error')
    }
    setCapturing(false)
    return ok
  }

  const totalSteps = 6

  const stepContent = {
    0: {
      title:      'Teach Part Recognition',
      subtitle:   `Teaching: ${part.name}`,
      instruction:
        'This wizard will guide you through teaching the robot to recognise this part. ' +
        'You will show the part to the camera from 4 different angles so the robot ' +
        'can identify it reliably.',
      detail: part.extents_cm
        ? `Part dimensions: ${part.extents_cm[0]}×${part.extents_cm[1]}×${part.extents_cm[2]} cm`
        : null,
      showCamera: false,
      action: { label: 'Start Teaching →', onClick: () => setStep(1) },
    },
    1: {
      title:       'Angle 1 of 4 — Front (0°)',
      subtitle:    'Place the part in front of Camera 0',
      instruction:
        '1. Place the part on the table in its normal orientation\n' +
        '2. Make sure the ENTIRE part is visible in the camera\n' +
        '3. Click on the detection box that matches this part\n' +
        '4. Then click "Capture" to teach this angle',
      showCamera: true,
    },
    2: {
      title:       'Angle 2 of 4 — Right (90°)',
      subtitle:    'Rotate the part 90° clockwise',
      instruction:
        '1. Rotate the part approximately 90° clockwise on the table\n' +
        '2. Wait for the detection box to appear\n' +
        '3. Click the detection box for this part\n' +
        '4. Click "Capture"',
      showCamera: true,
    },
    3: {
      title:       'Angle 3 of 4 — Back (180°)',
      subtitle:    'Rotate another 90° (now 180° from start)',
      instruction:
        '1. Rotate the part another 90° clockwise\n' +
        '2. The part should now be facing backwards from the starting position\n' +
        '3. Click the detection box and capture',
      showCamera: true,
    },
    4: {
      title:       'Angle 4 of 4 — Left (270°)',
      subtitle:    'Rotate another 90° (now 270° from start)',
      instruction:
        '1. Rotate the part one more 90° clockwise\n' +
        '2. This is the last angle to teach\n' +
        '3. Click the detection box and capture',
      showCamera: true,
    },
    5: {
      title:    'Teaching Complete!',
      subtitle: `${captures.length} angle${captures.length === 1 ? '' : 's'} captured for ${part.name}`,
      instruction: captures.length >= 3
        ? 'Teaching was successful. The robot can now recognise this part from ' +
          'multiple angles. You can close this wizard and test recognition on the ' +
          'Monitor tab.'
        : `Only ${captures.length} angle(s) captured. For reliable recognition, ` +
          'teach at least 3 angles. You can go back and capture more.',
      showCamera: false,
      action: {
        label:   captures.length >= 3 ? 'Done ✓' : 'Close Anyway',
        onClick: () => { onComplete?.(); onClose?.() },
      },
    },
  }

  const current = stepContent[step] || stepContent[0]

  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'var(--bg-app)', zIndex: 50,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 16,
        background: 'var(--bg-panel)',
      }}>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 18, color: 'var(--text-muted)', padding: '4px 8px',
        }}>✕</button>

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {current.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {current.subtitle}
          </div>
        </div>

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 6 }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} style={{
              width: i === step ? 24 : 8, height: 8, borderRadius: 4,
              background: i < step ? 'var(--green)'
                : i === step ? 'var(--accent)'
                : 'var(--bg-active)',
              transition: 'all 200ms',
            }} />
          ))}
        </div>

        <div style={{
          fontSize: 12, color: 'var(--text-muted)',
          minWidth: 80, textAlign: 'right',
        }}>
          {captures.length} captured
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {current.showCamera ? (
          <>
            {/* Camera + overlay (3/5) */}
            <div style={{
              flex: 3, position: 'relative', background: '#111',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: flashGreen ? '4px solid var(--green)' : '4px solid transparent',
              transition: 'border-color 200ms',
            }}>
              <img
                ref={imgRef}
                src="/stream/cam0"
                alt="cam0"
                style={{
                  width: '100%', height: '100%', objectFit: 'contain',
                }}
                onLoad={() => {
                  // Trigger a re-measure once the MJPEG kicks off.
                  const el = imgRef.current
                  if (!el?.parentElement) return
                  const c = el.parentElement.getBoundingClientRect()
                  const scale = Math.min(c.width / 640, c.height / 480)
                  setImgBounds({
                    w: 640 * scale, h: 480 * scale,
                    offX: (c.width - 640 * scale) / 2,
                    offY: (c.height - 480 * scale) / 2,
                  })
                }}
              />

              {/* Detection overlay — clickable boxes positioned against
                  the actual drawn image area (object-fit:contain leaves
                  letterbox margins on whichever axis isn't constrained). */}
              {liveDetections.map((det, i) => {
                const bp = det.bbox_px
                if (!bp || bp.length < 4) return null
                const [x1, y1, x2, y2] = bp
                const left   = imgBounds.offX + (x1 / 640) * imgBounds.w
                const top    = imgBounds.offY + (y1 / 480) * imgBounds.h
                const width  = ((x2 - x1) / 640) * imgBounds.w
                const height = ((y2 - y1) / 480) * imgBounds.h
                const isSelected = selectedDetection === i
                return (
                  <div
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedDet(isSelected ? null : i)
                    }}
                    style={{
                      position: 'absolute',
                      left:   `${left}px`,
                      top:    `${top}px`,
                      width:  `${width}px`,
                      height: `${height}px`,
                      border:    isSelected ? '3px solid #3B82F6' : '2px solid #22C55E',
                      background: isSelected ? 'rgba(59,130,246,0.20)' : 'rgba(34,197,94,0.08)',
                      borderRadius: 4, cursor: 'pointer',
                      transition: 'border-color 150ms, background 150ms',
                      zIndex: 10,
                      pointerEvents: 'auto',
                    }}
                  >
                    {isSelected && (
                      <div style={{
                        position: 'absolute', top: -22, left: 0,
                        background: '#3B82F6', color: '#fff',
                        fontSize: 10, fontWeight: 600,
                        padding: '2px 8px', borderRadius: 4, whiteSpace: 'nowrap',
                      }}>
                        ✓ Selected
                      </div>
                    )}
                  </div>
                )
              })}

              {liveDetections.length === 0 && (
                <div style={{
                  position: 'absolute', bottom: 20, left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(0,0,0,0.7)', color: '#FCD34D',
                  padding: '8px 16px', borderRadius: 8, fontSize: 13,
                }}>
                  No objects detected — place the part in view of Camera 0
                </div>
              )}

              {flashGreen && (
                <div style={{
                  position: 'absolute',
                  top: '50%', left: '50%',
                  transform: 'translate(-50%, -50%)',
                  background: 'rgba(22, 163, 74, 0.9)',
                  color: '#fff',
                  fontSize: 24, fontWeight: 700,
                  padding: '16px 32px', borderRadius: 12, zIndex: 60,
                }}>
                  ✓ Captured!
                </div>
              )}
            </div>

            {/* Right panel — instructions + capture (2/5) */}
            <div style={{
              flex: 2, padding: 24,
              display: 'flex', flexDirection: 'column', gap: 16,
              background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)',
            }}>
              {/* Angle indicator */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
                {[0, 90, 180, 270].map((angle, i) => {
                  const stepNum  = i + 1
                  const captured = captures.some(c => c.step === stepNum)
                  const isCurrent = step === stepNum
                  return (
                    <div key={angle} style={{
                      width: 56, height: 56, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: captured ? 'var(--green-dim)'
                        : isCurrent ? 'var(--accent-dim)'
                        : 'var(--bg-surface)',
                      border: captured ? '2px solid var(--green)'
                        : isCurrent ? '2px solid var(--accent)'
                        : '2px solid var(--border)',
                    }}>
                      <div style={{
                        fontSize: 14, fontWeight: 700,
                        color: captured ? 'var(--green)'
                          : isCurrent ? 'var(--accent)'
                          : 'var(--text-muted)',
                      }}>
                        {captured ? '✓' : `${angle}°`}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Instructions */}
              <div style={{
                background: 'var(--bg-surface)',
                borderRadius: 'var(--radius-md)', padding: 16,
              }}>
                <div style={{
                  fontSize: 13, fontWeight: 600,
                  color: 'var(--text-primary)', marginBottom: 8,
                }}>
                  Instructions
                </div>
                {current.instruction.split('\n').map((line, i) => (
                  <div key={i} style={{
                    fontSize: 12, color: 'var(--text-secondary)',
                    marginBottom: 4,
                  }}>
                    {line}
                  </div>
                ))}
              </div>

              <div style={{
                background: 'var(--accent-dim)',
                border: '1px solid var(--accent-border)',
                borderRadius: 'var(--radius-md)', padding: 12,
                fontSize: 12, color: 'var(--accent)',
              }}>
                💡 Place the part 40–60 cm from the camera for best results.
                The distance will be recorded as a reference.
              </div>

              {error && (
                <div style={{
                  background: 'var(--red-dim)', border: '1px solid var(--red)',
                  borderRadius: 'var(--radius-md)', padding: 12,
                  fontSize: 12, color: 'var(--red)',
                }}>
                  {error}
                </div>
              )}

              {/* Orientation selector — operator picks how the part is
                  currently presented so the robot knows whether it can
                  be picked directly, must be flipped first, or has
                  fallen on its side. The tag rides along on the teach
                  POST and is stored in the .npz; the matcher returns it
                  alongside the match so the task planner can branch. */}
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
                padding: 12,
              }}>
                <div style={{
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--text-primary)',
                }}>
                  Part orientation
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[
                    { id: 'pickable', label: 'Pickable',  hint: 'Ready to grasp' },
                    { id: 'flipped',  label: 'Flipped',   hint: 'Upside-down'    },
                    { id: 'on_side',  label: 'On Side',   hint: 'Lying on side'  },
                  ].map(opt => {
                    const active = orientation === opt.id
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setOrientation(opt.id)}
                        title={opt.hint}
                        style={{
                          flex: 1,
                          padding: '8px 6px',
                          fontSize: 12,
                          fontWeight: active ? 700 : 500,
                          background: active ? 'var(--accent)' : 'var(--bg-panel)',
                          color: active ? '#fff' : 'var(--text-secondary)',
                          border: active
                            ? '1px solid var(--accent)'
                            : '1px solid var(--border)',
                          borderRadius: 'var(--radius-md)',
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* BIG CAPTURE BUTTON — prominent, centred. Enabled as
                  soon as we have any detections (no need to click a
                  box first); selecting a box just overrides which
                  detection index is captured. */}
              <div style={{
                padding: '16px 24px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
              }}>
                <div style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}>
                  Step {step} of 4 — {['', 'Front (0°)', 'Right (90°)', 'Back (180°)', 'Left (270°)'][step]}
                </div>

                {(() => {
                  const hasDetections = liveDetections.length > 0
                  const canCapture    = hasDetections && !capturing
                  const doCapture = async () => {
                    const idx = selectedDetection ?? 0
                    const ok = await captureTeach(idx)
                    if (ok) {
                      setSelectedDet(null)
                      if (step < 4) setTimeout(() => setStep(step + 1), 800)
                      else setStep(5)
                    }
                  }
                  return (
                    <>
                      <button
                        onClick={() => { if (canCapture) doCapture() }}
                        disabled={!canCapture}
                        style={{
                          padding: '16px 36px',
                          fontSize: 15,
                          fontWeight: 700,
                          background: canCapture ? 'var(--accent)' : 'var(--bg-surface)',
                          color: canCapture ? '#fff' : 'var(--text-muted)',
                          border: 'none',
                          borderRadius: 'var(--radius-lg)',
                          cursor: canCapture ? 'pointer' : 'not-allowed',
                          boxShadow: canCapture ? '0 4px 12px rgba(29,111,216,0.35)' : 'none',
                          minWidth: 260,
                          transition: 'all 150ms',
                        }}
                      >
                        {capturing
                          ? '⏳ Capturing…'
                          : !hasDetections
                            ? 'Waiting for object…'
                            : selectedDetection !== null
                              ? `📸 Capture Selected (Angle ${step}/4)`
                              : `📸 Capture Nearest (Angle ${step}/4)`}
                      </button>

                      <div style={{
                        fontSize: 12,
                        color: 'var(--text-muted)',
                        textAlign: 'center',
                        maxWidth: 280,
                      }}>
                        {!hasDetections
                          ? 'Place the part in front of Camera 0. Detection boxes appear here when one is seen.'
                          : selectedDetection !== null
                            ? 'Click the box again to deselect, or tap Capture.'
                            : `${liveDetections.length} object${liveDetections.length === 1 ? '' : 's'} detected — tap a green box to choose, or just press Capture to teach the nearest.`}
                      </div>
                    </>
                  )
                })()}
              </div>

              {/* Navigation */}
              <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                {step > 1 && (
                  <button
                    onClick={() => setStep(step - 1)}
                    style={{
                      padding: '8px 16px', fontSize: 12,
                      background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    }}
                  >
                    ← Back
                  </button>
                )}
                <button
                  onClick={() => step < 5 ? setStep(step + 1) : (onComplete?.(), onClose?.())}
                  style={{
                    padding: '8px 16px', fontSize: 12,
                    background: 'transparent', color: 'var(--text-muted)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    marginLeft: 'auto',
                  }}
                >
                  {step < 4 ? 'Skip this angle →' : step === 4 ? 'Finish →' : 'Close'}
                </button>
              </div>
            </div>
          </>
        ) : (
          /* Intro and review screens */
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: 40, gap: 24, textAlign: 'center',
          }}>
            <div style={{ fontSize: 48 }}>
              {step === 0 ? '🎯' : captures.length >= 3 ? '✅' : '⚠️'}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
              {current.title}
            </div>
            <div style={{
              fontSize: 14, color: 'var(--text-secondary)',
              maxWidth: 500, whiteSpace: 'pre-wrap',
            }}>
              {current.instruction}
            </div>
            {current.detail && (
              <div style={{
                fontSize: 13, color: 'var(--text-muted)',
                background: 'var(--bg-surface)',
                padding: '8px 16px', borderRadius: 'var(--radius-md)',
              }}>
                {current.detail}
              </div>
            )}
            {step === 5 && captures.length > 0 && (
              <div style={{ display: 'flex', gap: 12 }}>
                {captures.map((c, i) => (
                  <div key={i} style={{
                    width: 60, height: 60, borderRadius: '50%',
                    background: 'var(--green-dim)',
                    border: '2px solid var(--green)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, color: 'var(--green)',
                  }}>
                    {c.angle}°
                  </div>
                ))}
              </div>
            )}
            {current.action && (
              <button
                onClick={current.action.onClick}
                style={{
                  padding: '14px 32px', fontSize: 15, fontWeight: 700,
                  background: 'var(--accent)', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius-lg)',
                  cursor: 'pointer',
                }}
              >
                {current.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────

export default function AdaptivePicking() {
  const [parts, setParts]               = useState([])
  const [selectedPart, setSelected]     = useState(null)
  const [uploading, setUploading]       = useState(false)
  const [uploadError, setUploadError]   = useState(null)
  const [filterOp, setFilterOp]         = useState(null)
  const [teachingPart, setTeachingPart] = useState(null)
  const fileInputRef = useRef(null)

  const filteredParts = filterOp
    ? parts.filter(p => (p.operations || []).includes(filterOp))
    : parts

  async function refresh() {
    try {
      const d = await fetch('/api/parts').then(r => r.json())
      setParts(d.parts || [])
    } catch (e) {
      console.warn('parts list failed:', e)
    }
  }

  useEffect(() => { refresh() }, [])

  async function handleUpload(file) {
    if (!file) return
    if (!/\.(step|stp)$/i.test(file.name)) {
      setUploadError('Only .STEP and .STP files are accepted')
      return
    }
    setUploading(true); setUploadError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/parts/upload', { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok || !d.ok) {
        setUploadError(d.error || 'Upload failed')
      } else {
        await refresh()
        setSelected(d.part_id)
      }
    } catch (e) {
      setUploadError(String(e.message || e))
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete() {
    if (!selectedPart) return
    if (!confirm('Delete this part?')) return
    try {
      await fetch(`/api/parts/${selectedPart}`, { method: 'DELETE' })
      setSelected(null)
      await refresh()
    } catch (e) {
      console.warn('delete failed:', e)
    }
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div style={{
        display: 'flex', height: '100%',
        background: 'var(--bg-app)', overflow: 'hidden',
      }}>
      {/* LEFT — Parts library list (fixed 280px) */}
      <div style={{
        width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)', background: 'var(--bg-panel)',
      }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
          <div style={{
            fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: 'var(--text-muted, #9ca3af)', marginBottom: 4,
          }}>Parts Library</div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12,
          }}>{parts.length} part{parts.length === 1 ? '' : 's'}</div>

          <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
            style={{
              width: '100%', padding: 10, fontSize: 13, fontWeight: 600,
              cursor: uploading ? 'wait' : 'pointer',
              background: 'rgba(59,130,246,0.85)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md, 6px)', marginBottom: 8,
            }}
          >{uploading ? 'Processing STEP file…' : '+ Upload STEP File'}</button>
          <input ref={fileInputRef} type="file" accept=".step,.stp,.STEP,.STP"
            style={{ display: 'none' }}
            onChange={(e) => handleUpload(e.target.files?.[0])}
          />

          <div
            onDrop={(e) => { e.preventDefault(); handleUpload(e.dataTransfer.files?.[0]) }}
            onDragOver={(e) => e.preventDefault()}
            style={{
              padding: 12, fontSize: 11, textAlign: 'center',
              border: '2px dashed var(--border)', borderRadius: 'var(--radius-md, 6px)',
              color: 'var(--text-muted, #9ca3af)', background: 'rgba(255,255,255,0.02)',
            }}
          >or drop a .STEP file here</div>

          {uploadError && (
            <div style={{
              marginTop: 8, padding: '6px 10px', fontSize: 11,
              background: 'rgba(239,68,68,0.1)', color: '#ef4444',
              borderRadius: 'var(--radius-sm, 4px)',
            }}>{uploadError}</div>
          )}
        </div>

        {/* Operation filter bar */}
        {parts.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 4,
            padding: '8px 16px 4px',
          }}>
            {[null, 'pick', 'insert', 'inspect', 'sort', 'assemble'].map((op) => {
              const active = filterOp === op
              return (
                <button key={op ?? 'all'} onClick={() => setFilterOp(op)}
                  style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 12, cursor: 'pointer',
                    background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
                    color:      active ? '#60a5fa'              : 'var(--text-muted, #9ca3af)',
                    border:     active ? '1px solid rgba(59,130,246,0.5)' : '1px solid var(--border)',
                    textTransform: 'capitalize',
                  }}
                >{op ?? 'All'}</button>
              )
            })}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {parts.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '40px 16px',
              color: 'var(--text-muted, #9ca3af)', fontSize: 12, lineHeight: 1.6,
            }}>
              No parts uploaded yet.<br />
              Upload a STEP file to start adaptive picking.
            </div>
          ) : filteredParts.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '24px 16px',
              color: 'var(--text-muted, #9ca3af)', fontSize: 11,
            }}>
              No parts tagged "{filterOp}".
            </div>
          ) : (
            filteredParts.map(part => {
              const active = selectedPart === part.id
              const ex = part.extents_cm || [0, 0, 0]
              const ops = part.operations || []
              const taught = (part.teach_count || 0) > 0
              return (
                <div key={part.id} onClick={() => setSelected(part.id)}
                  style={{
                    padding: '10px 12px', marginBottom: 4,
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sm, 4px)',
                    background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
                    border:     active ? '1px solid rgba(59,130,246,0.5)' : '1px solid transparent',
                  }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <div style={{
                      flex: 1, minWidth: 0,
                      fontSize: 13, fontWeight: 500,
                      color: active ? '#60a5fa' : 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{part.name}</div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setTeachingPart(part)
                      }}
                      style={{
                        padding: '4px 10px', fontSize: 11, fontWeight: 600,
                        background: taught ? 'var(--green-dim)' : 'var(--accent)',
                        color:      taught ? 'var(--green)'    : '#fff',
                        border: 'none',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {taught ? `Taught (${part.teach_count})` : 'Teach'}
                    </button>
                    {taught && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (!confirm(
                            `Clear all ${part.teach_count} taught samples for ${part.name}?`
                          )) return
                          try {
                            await fetch(`/api/parts/${part.id}/teach_clear`, { method: 'POST' })
                          } catch { /* ignore */ }
                          refresh()
                        }}
                        style={{
                          padding: '4px 8px', fontSize: 10,
                          background: 'var(--red-dim)', color: 'var(--red)',
                          border: 'none', borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div style={{
                    fontSize: 11, marginTop: 2,
                    color: 'var(--text-muted, #9ca3af)',
                  }}>
                    {ex.map(e => Number(e).toFixed(1)).join(' × ')} cm · {
                      part.grasp?.approach === 'top_down' ? '↓ top' : '→ side'
                    } grasp
                  </div>
                  <div style={{
                    fontSize: 10, marginTop: 2,
                    color: taught ? '#22c55e' : 'var(--text-muted, #9ca3af)',
                  }}>
                    {taught
                      ? `${part.teach_count} taught sample${part.teach_count > 1 ? 's' : ''}`
                      : 'Not taught yet — click "Teach" to start the wizard'}
                  </div>
                  {(ops.length > 0 || part.program_name) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                      {ops.map((op) => {
                        const c = OP_COLORS[op] || '#666'
                        return (
                          <span key={op} style={{
                            fontSize: 9, padding: '1px 6px', borderRadius: 10, fontWeight: 500,
                            background: `${c}28`, color: c,
                          }}>{op}</span>
                        )
                      })}
                      {part.program_name && (
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 10, fontWeight: 500,
                          background: 'rgba(59,130,246,0.15)', color: '#60a5fa',
                        }}>{part.program_name}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* CENTER — Configurator (or empty hint) */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {selectedPart ? (
          <PartConfigurator
            key={selectedPart}
            partId={selectedPart}
            onSave={refresh}
            onDelete={handleDelete}
          />
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted, #9ca3af)', fontSize: 14,
          }}>
            Select a part from the library or upload a new STEP file
          </div>
        )}
      </div>
      </div>

      {/* Teaching wizard overlay — sits above the entire page when
          teachingPart is set. Closing or completing refreshes the parts
          list so the new teach_count is picked up. */}
      {teachingPart && (
        <TeachWizard
          part={teachingPart}
          onClose={() => { setTeachingPart(null); refresh() }}
          onComplete={() => refresh()}
        />
      )}
    </div>
  )
}

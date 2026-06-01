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
  const [geo, setGeo] = useState(null)

  useEffect(() => {
    if (!url) { setGeo(null); return }
    const loader = new STLLoader()
    loader.load(url, (g) => {
      g.computeVertexNormals()
      g.center()
      g.computeBoundingBox()
      const b = g.boundingBox
      const max = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
      if (max > 0) g.scale(0.4 / max, 0.4 / max, 0.4 / max)
      setGeo(g)
    }, undefined, (err) => console.warn('STL load failed:', err))
  }, [url])

  useEffect(() => {
    if (!groupRef.current) return
    // Apply surface rotation; yaw on the WORLD Y axis layered on top so
    // selecting a front direction rotates the standing part in place.
    groupRef.current.rotation.set(
      rotation[0],
      rotation[1] + (frontAngle * Math.PI / 180),
      rotation[2],
    )
  }, [rotation, frontAngle])

  if (!geo) return null
  return (
    <group ref={groupRef}>
      <mesh geometry={geo} castShadow receiveShadow>
        <meshStandardMaterial color="#A8B0C0" metalness={0.5} roughness={0.35} />
      </mesh>
    </group>
  )
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
        <meshBasicMaterial color="#22C55E" />
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
        <meshBasicMaterial color="#22C55E" />
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
            style={{ width: '100%', height: '100%' }}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 5, 3]} intensity={0.7} castShadow />
      <directionalLight position={[-3, 4, -2]} intensity={0.25} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[2, 2]} />
        <meshStandardMaterial color="#1e2030" />
      </mesh>
      <gridHelper args={[2, 20, '#2a3040', '#1e2030']} />
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

// ── Configurator ─────────────────────────────────────────────────────

function PartConfigurator({ partId, onSave, onDelete }) {
  const [part, setPart]           = useState(null)
  const [tableSurface, setTSurf]  = useState(SURFACE_OPTIONS[0].label)
  const [rotation, setRotation]   = useState(SURFACE_OPTIONS[0].rotation)
  const [frontDir, setFrontDir]   = useState(FRONT_OPTIONS[0].label)
  const [frontAngle, setFAng]     = useState(0)
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
      const r = await fetch(`/api/parts/${partId}/config`, {
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
      const d = await r.json()
      if (r.ok) {
        setPart(d.part)
        onSave?.()
      } else {
        console.warn('save error:', d.error)
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
      <div style={{ flex: 3, background: '#0a0a12', position: 'relative' }}>
        <PartCanvas url={stlUrl} rotation={rotation} frontAngle={frontAngle}
                    gripperType={gripperType} graspSettings={grasp} />
        <div style={{
          position: 'absolute', top: 12, left: 12,
          background: 'rgba(0,0,0,0.6)', color: '#fff',
          padding: '6px 12px', borderRadius: 6,
          fontSize: 14, fontWeight: 600,
        }}>{part.name}</div>
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(0,0,0,0.6)', color: 'var(--text-muted, #9ca3af)',
          padding: '4px 10px', borderRadius: 4, fontSize: 11,
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

// ── Page ─────────────────────────────────────────────────────────────

export default function AdaptivePicking() {
  const [parts, setParts]               = useState([])
  const [selectedPart, setSelected]     = useState(null)
  const [uploading, setUploading]       = useState(false)
  const [uploadError, setUploadError]   = useState(null)
  const fileInputRef = useRef(null)

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

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {parts.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '40px 16px',
              color: 'var(--text-muted, #9ca3af)', fontSize: 12, lineHeight: 1.6,
            }}>
              No parts uploaded yet.<br />
              Upload a STEP file to start adaptive picking.
            </div>
          ) : (
            parts.map(part => {
              const active = selectedPart === part.id
              const ex = part.extents_cm || [0, 0, 0]
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
                    fontSize: 13, fontWeight: 500,
                    color: active ? '#60a5fa' : 'var(--text-primary)',
                  }}>{part.name}</div>
                  <div style={{
                    fontSize: 11, marginTop: 2,
                    color: 'var(--text-muted, #9ca3af)',
                  }}>
                    {ex.map(e => Number(e).toFixed(1)).join(' × ')} cm · {
                      part.grasp?.approach === 'top_down' ? '↓ top' : '→ side'
                    } grasp
                  </div>
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
  )
}

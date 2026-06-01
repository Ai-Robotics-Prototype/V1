import { useState, useRef, useEffect, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader'

// step_parser writes a .stl alongside each .step, copied into the
// dashboard static dir under /parts/. Loading STL keeps things simple —
// no GLTFLoader, no intermediate GLB step.

const SURFACE_OPTIONS = [
  { label: '+Z up (default)', value: [0, 0, 0],          desc: 'Top face on table' },
  { label: '−Z up (flipped)', value: [Math.PI, 0, 0],     desc: 'Bottom face on table' },
  { label: '+X up',           value: [0, 0, -Math.PI/2], desc: 'Right side on table' },
  { label: '−X up',           value: [0, 0,  Math.PI/2], desc: 'Left side on table' },
  { label: '+Y up',           value: [-Math.PI/2, 0, 0], desc: 'Front face on table' },
  { label: '−Y up',           value: [ Math.PI/2, 0, 0], desc: 'Back face on table' },
]

const FRONT_OPTIONS = [
  { label: '↑ Forward', value: [0, 0, -1], angle: 0   },
  { label: '→ Right',   value: [1, 0,  0], angle: 90  },
  { label: '↓ Back',    value: [0, 0,  1], angle: 180 },
  { label: '← Left',    value: [-1, 0, 0], angle: 270 },
]

// ── 3D viewer ────────────────────────────────────────────────────────

function StlPart({ url, rotation, frontVec }) {
  const [geo, setGeo] = useState(null)

  useEffect(() => {
    if (!url) return
    const loader = new STLLoader()
    loader.load(url, (g) => {
      g.computeVertexNormals()
      g.center()
      // Auto-scale so the longest dim is ~0.4 (model units)
      g.computeBoundingBox()
      const b = g.boundingBox
      const max = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
      if (max > 0) g.scale(0.4 / max, 0.4 / max, 0.4 / max)
      setGeo(g)
    }, undefined, (err) => {
      console.warn('STL load failed', err)
    })
  }, [url])

  return (
    <>
      {geo && (
        <mesh geometry={geo} rotation={rotation} castShadow receiveShadow>
          <meshStandardMaterial color="#A0A8B8" metalness={0.55} roughness={0.4} />
        </mesh>
      )}
      {frontVec && (
        <arrowHelper
          args={[
            new THREE.Vector3(frontVec[0], frontVec[1], frontVec[2]).normalize(),
            new THREE.Vector3(0, 0, 0),
            0.28,
            '#3b82f6', 0.05, 0.03,
          ]}
        />
      )}
    </>
  )
}

function PartCanvas({ url, rotation, frontVec }) {
  return (
    <Canvas
      shadows
      camera={{ position: [0.7, 0.6, 0.7], fov: 38 }}
      style={{ width: '100%', height: '100%', background: '#0d0f14' }}
    >
      <ambientLight intensity={0.45} />
      <directionalLight position={[2, 3, 2]} intensity={0.7} castShadow />
      <gridHelper args={[1, 10, '#2a3040', '#1e2030']} position={[0, -0.25, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.251, 0]} receiveShadow>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color="#1a1c24" />
      </mesh>
      <group position={[-0.4, -0.2, -0.4]}>
        <arrowHelper args={[new THREE.Vector3(1,0,0), new THREE.Vector3(0,0,0), 0.1, '#ef4444', 0.02, 0.01]} />
        <arrowHelper args={[new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,0), 0.1, '#22c55e', 0.02, 0.01]} />
        <arrowHelper args={[new THREE.Vector3(0,0,1), new THREE.Vector3(0,0,0), 0.1, '#3b82f6', 0.02, 0.01]} />
      </group>
      <Suspense fallback={null}>
        <StlPart url={url} rotation={rotation} frontVec={frontVec} />
      </Suspense>
      <OrbitControls enableDamping dampingFactor={0.08} />
    </Canvas>
  )
}

// ── small UI helpers ─────────────────────────────────────────────────

const btnBase = {
  padding: '8px 10px',
  fontSize: 11,
  background: 'var(--bg-surface)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  textAlign: 'left',
}
const btnActive = {
  background: 'rgba(59, 130, 246, 0.15)',
  color: 'var(--accent, #60a5fa)',
  border: '1px solid rgba(59, 130, 246, 0.5)',
}
const sectionTitle = { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }

function SurfaceSelector({ selectedLabel, onChange }) {
  return (
    <div>
      <div style={sectionTitle}>Which surface sits on the table?</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {SURFACE_OPTIONS.map((opt) => (
          <button key={opt.label}
            style={selectedLabel === opt.label ? { ...btnBase, ...btnActive } : btnBase}
            onClick={() => onChange(opt)}
          >
            <div style={{ fontWeight: 500 }}>{opt.label}</div>
            <div style={{ fontSize: 10, opacity: 0.7 }}>{opt.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function FrontSelector({ selectedLabel, onChange }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={sectionTitle}>Which direction is the front?</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
        {FRONT_OPTIONS.map((opt) => (
          <button key={opt.label}
            style={{
              ...(selectedLabel === opt.label ? { ...btnBase, ...btnActive } : btnBase),
              padding: '8px',
              fontSize: 14,
              textAlign: 'center',
            }}
            onClick={() => onChange(opt)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function GraspSettings({ settings, onChange }) {
  const upd = (k, v) => onChange({ ...settings, [k]: v })
  return (
    <div style={{ marginTop: 14 }}>
      <div style={sectionTitle}>Grasp Settings</div>
      <label style={{ display: 'block', marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: 'var(--text-secondary)' }}>Approach</span>
        <select
          value={settings.approach}
          onChange={(e) => upd('approach', e.target.value)}
          style={{
            display: 'block', width: '100%', marginTop: 4,
            padding: '6px 8px', fontSize: 12,
            background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          }}
        >
          <option value="top_down">Top down (↓)</option>
          <option value="side">Side approach (→)</option>
          <option value="angled">Angled (↘)</option>
        </select>
      </label>

      <label style={{ display: 'block', marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: 'var(--text-secondary)' }}>
          Gripper width: {(settings.gripper_width_cm ?? 5).toFixed(1)} cm
        </span>
        <input type="range" min="1" max="15" step="0.1"
          value={settings.gripper_width_cm ?? 5}
          onChange={(e) => upd('gripper_width_cm', parseFloat(e.target.value))}
          style={{ display: 'block', width: '100%', marginTop: 4 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 8, fontSize: 11 }}>
        <span style={{ color: 'var(--text-secondary)' }}>
          Pick height offset: {(settings.pick_offset_cm ?? 2).toFixed(1)} cm
        </span>
        <input type="range" min="0" max="10" step="0.5"
          value={settings.pick_offset_cm ?? 2}
          onChange={(e) => upd('pick_offset_cm', parseFloat(e.target.value))}
          style={{ display: 'block', width: '100%', marginTop: 4 }}
        />
      </label>
    </div>
  )
}

function PartInfo({ part, name, onNameChange }) {
  if (!part) return null
  const ex = part.extents_cm || [0, 0, 0]
  return (
    <div style={{ marginTop: 14 }}>
      <div style={sectionTitle}>Part Info</div>
      <input type="text" value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Part name"
        style={{
          width: '100%', padding: '6px 8px', fontSize: 12, marginBottom: 8,
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        }}
      />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <div>Dimensions: {ex[0].toFixed(1)} × {ex[1].toFixed(1)} × {ex[2].toFixed(1)} cm</div>
        <div>Volume: {(part.volume_cm3 ?? 0).toFixed(1)} cm³</div>
        <div>Surface: {(part.surface_area_cm2 ?? 0).toFixed(1)} cm²</div>
        <div>Mesh: {part.vertices ?? 0} verts / {part.faces ?? 0} faces</div>
      </div>
    </div>
  )
}

// ── Library grid (cards) ─────────────────────────────────────────────

function PartCard({ part, onConfigure, onDelete }) {
  const ex = part.extents_cm || [0, 0, 0]
  const stl = part.stl_file ? `/parts/${part.stl_file}` : null
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md, 8px)',
      padding: 10,
      display: 'flex',
      gap: 12,
    }}>
      <div style={{ width: 120, height: 120, flexShrink: 0, borderRadius: 6, overflow: 'hidden' }}>
        {stl ? <PartCanvas url={stl} rotation={[0, 0, 0]} /> : <div style={{ background: '#0d0f14', width: '100%', height: '100%' }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {part.name || part.id}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {ex.map(e => e.toFixed(1)).join(' × ')} cm
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted, #6b7280)', marginTop: 4 }}>
          grasp: {part.grasp?.approach || '—'} · {((part.grasp?.gripper_width_cm) || 5).toFixed(1)} cm
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => onConfigure(part.id)}
            style={{
              padding: '4px 10px', fontSize: 11, cursor: 'pointer',
              background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa',
              border: '1px solid rgba(59, 130, 246, 0.5)', borderRadius: 4,
            }}>Configure</button>
          <button onClick={() => onDelete(part.id)}
            style={{
              padding: '4px 10px', fontSize: 11, cursor: 'pointer',
              background: 'transparent', color: '#ef4444',
              border: '1px solid #4b1d1d', borderRadius: 4,
            }}>Delete</button>
        </div>
      </div>
    </div>
  )
}

// ── Drop zone ────────────────────────────────────────────────────────

function UploadZone({ onUpload, busy }) {
  const inputRef = useRef()
  const [drag, setDrag] = useState(false)
  function pick(f) { if (f) onUpload(f) }
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false)
        const f = e.dataTransfer.files?.[0]
        pick(f)
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${drag ? '#3b82f6' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md, 8px)',
        padding: 24,
        background: drag ? 'rgba(59, 130, 246, 0.08)' : 'rgba(255,255,255,0.02)',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 6 }}>{busy ? '⏳' : '📦'}</div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
        {busy ? 'Parsing…' : 'Drop a .STEP / .STP file here'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted, #6b7280)', marginTop: 4 }}>
        or click to choose
      </div>
      <input ref={inputRef} type="file" accept=".step,.stp"
        style={{ display: 'none' }}
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </div>
  )
}

// ── Setup view ───────────────────────────────────────────────────────

function PartSetup({ part, onCancel, onSaved }) {
  const [surface, setSurface] = useState({
    label: part.table_surface || SURFACE_OPTIONS[0].label,
    value: part.table_rotation || SURFACE_OPTIONS[0].value,
  })
  const [front, setFront] = useState({
    label: part.front_direction || FRONT_OPTIONS[0].label,
    value: FRONT_OPTIONS.find(o => o.label === (part.front_direction || FRONT_OPTIONS[0].label))?.value || FRONT_OPTIONS[0].value,
    angle: part.front_angle_deg ?? 0,
  })
  const [grasp, setGrasp] = useState({
    approach:         part.grasp?.approach         || 'top_down',
    gripper_width_cm: part.grasp?.gripper_width_cm || (((part.grasp?.width_m ?? 0.05) * 100) + 1),
    pick_offset_cm:   part.grasp?.pick_offset_cm   || 2.0,
  })
  const [name, setName] = useState(part.name || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true); setError(null)
    try {
      const r = await fetch(`/api/parts/${part.id}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          table_surface:   surface.label,
          table_rotation:  surface.value,
          front_direction: front.label,
          front_angle_deg: front.angle,
          grasp,
        }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'save failed')
      onSaved && onSaved(data.part)
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  const stlUrl = part.stl_file ? `/parts/${part.stl_file}` : null

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ flex: '0 0 60%', borderRight: '1px solid var(--border)' }}>
        <PartCanvas url={stlUrl} rotation={surface.value} frontVec={front.value} />
      </div>
      <div style={{ flex: '1 1 40%', padding: 16, overflowY: 'auto' }}>
        <SurfaceSelector
          selectedLabel={surface.label}
          onChange={(opt) => setSurface({ label: opt.label, value: opt.value })}
        />
        <FrontSelector
          selectedLabel={front.label}
          onChange={(opt) => setFront({ label: opt.label, value: opt.value, angle: opt.angle })}
        />
        <GraspSettings settings={grasp} onChange={setGrasp} />
        <PartInfo part={part} name={name} onNameChange={setName} />

        {error && (
          <div style={{ marginTop: 12, padding: 8, background: 'rgba(239,68,68,0.1)',
                        color: '#ef4444', fontSize: 11, borderRadius: 4 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button onClick={onCancel} disabled={saving} style={{
            flex: 1, padding: '8px 12px', fontSize: 12, cursor: saving ? 'not-allowed' : 'pointer',
            background: 'transparent', color: 'var(--text-secondary)',
            border: '1px solid var(--border)', borderRadius: 4,
          }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{
            flex: 2, padding: '8px 12px', fontSize: 12, cursor: saving ? 'not-allowed' : 'pointer',
            background: 'rgba(34, 197, 94, 0.18)', color: '#22c55e',
            border: '1px solid rgba(34, 197, 94, 0.6)', borderRadius: 4,
            fontWeight: 600,
          }}>{saving ? 'Saving…' : 'Save Part'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Top-level page ───────────────────────────────────────────────────

export default function PartsLibrary() {
  const [parts, setParts] = useState([])
  const [uploading, setUploading] = useState(false)
  const [setupPart, setSetupPart] = useState(null)  // full part metadata
  const [error, setError] = useState(null)

  async function refresh() {
    try {
      const r = await fetch('/api/parts')
      const d = await r.json()
      setParts(d.parts || [])
    } catch (e) {
      setError(String(e.message || e))
    }
  }

  useEffect(() => { refresh() }, [])

  async function handleUpload(file) {
    setUploading(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/parts/upload', { method: 'POST', body: fd })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'upload failed')
      // Fetch full metadata + open setup
      const detail = await fetch(`/api/parts/${data.part_id}`).then(x => x.json())
      setSetupPart(detail)
      await refresh()
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setUploading(false)
    }
  }

  async function handleConfigure(id) {
    try {
      const detail = await fetch(`/api/parts/${id}`).then(r => r.json())
      setSetupPart(detail)
    } catch (e) { setError(String(e.message || e)) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this part?')) return
    try {
      await fetch(`/api/parts/${id}`, { method: 'DELETE' })
      await refresh()
    } catch (e) { setError(String(e.message || e)) }
  }

  // SETUP VIEW
  if (setupPart) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#08090c' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            Configure: {setupPart.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted, #6b7280)' }}>
            id {setupPart.id}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PartSetup part={setupPart}
            onCancel={() => setSetupPart(null)}
            onSaved={() => { setSetupPart(null); refresh() }}
          />
        </div>
      </div>
    )
  }

  // LIBRARY VIEW
  return (
    <div style={{ width: '100%', height: '100%', background: '#08090c', padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
                        color: 'var(--text-muted, #6b7280)' }}>Parts Library</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
            {parts.length} part{parts.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <UploadZone onUpload={handleUpload} busy={uploading} />

      {error && (
        <div style={{ marginTop: 12, padding: 10, background: 'rgba(239,68,68,0.1)',
                      color: '#ef4444', fontSize: 12, borderRadius: 4 }}>
          {error}
        </div>
      )}

      {parts.length === 0 && !uploading && (
        <div style={{ marginTop: 24, padding: 24, textAlign: 'center',
                      color: 'var(--text-muted, #6b7280)', fontSize: 12 }}>
          No parts uploaded yet. Drop a STEP file above to get started.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
        {parts.map(p => (
          <PartCard key={p.id} part={p}
            onConfigure={handleConfigure} onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  )
}

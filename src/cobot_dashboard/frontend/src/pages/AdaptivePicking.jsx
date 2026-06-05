import { useState, useEffect, useRef, useMemo, useCallback, Suspense } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
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

function PartModel3D({ url, rotation, frontAngle, onFaceClick }) {
  const groupRef = useRef()
  const meshRef  = useRef(null)
  const [ready, setReady] = useState(false)
  const { raycaster, camera, pointer } = useThree()

  // Raycast on click to find which face of the model was hit. The face
  // normal (in world space) becomes the operator's chosen pick approach.
  const handleClick = useCallback(() => {
    if (!groupRef.current || !onFaceClick) return
    const meshes = []
    groupRef.current.traverse(child => {
      if (child.isMesh) meshes.push(child)
    })
    if (meshes.length === 0) return
    raycaster.setFromCamera(pointer, camera)
    const intersects = raycaster.intersectObjects(meshes, true)
    if (intersects.length === 0) return
    const hit = intersects[0]
    if (!hit.face) return
    const normal = hit.face.normal.clone()
    normal.transformDirection(hit.object.matrixWorld)
    normal.normalize()
    // Approach type comes from how vertical the surface normal is:
    //   |y| > 0.7 → top/bottom face  → top_down
    //   |y| < 0.3 → vertical face    → side
    //   between  → angled face       → angled
    const ay = Math.abs(normal.y)
    const approach = ay > 0.7 ? 'top_down' : ay < 0.3 ? 'side' : 'angled'
    onFaceClick({
      normal: [normal.x, normal.y, normal.z],
      point:  [hit.point.x, hit.point.y, hit.point.z],
      approach,
    })
  }, [raycaster, camera, pointer, onFaceClick])

  // Reset cursor on unmount so it doesn't get stuck as 'crosshair' if
  // the user closes the configurator mid-hover.
  useEffect(() => () => { document.body.style.cursor = 'default' }, [])

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

  return (
    <group
      ref={groupRef}
      onClick={handleClick}
      onPointerOver={() => { if (onFaceClick) document.body.style.cursor = 'crosshair' }}
      onPointerOut={() => { document.body.style.cursor = 'default' }}
    />
  )
}

// ── Pick-direction arrow (unified: button mode or face-click mode) ──

function PickArrow({ offsetCm, faceNormal, facePoint }) {
  const offset = ((offsetCm || 2) / 100) * 2.5

  const { position, quaternion } = useMemo(() => {
    const n = new THREE.Vector3(faceNormal[0], faceNormal[1], faceNormal[2]).normalize()
    const standoff = 0.05 + offset
    const p = new THREE.Vector3(
      facePoint[0] + n.x * standoff,
      facePoint[1] + n.y * standoff,
      facePoint[2] + n.z * standoff,
    )
    const defaultDir = new THREE.Vector3(0, -1, 0)
    const targetDir  = n.clone().negate()
    const q = new THREE.Quaternion().setFromUnitVectors(defaultDir, targetDir)
    return { position: [p.x, p.y, p.z], quaternion: q }
  }, [offset, faceNormal, facePoint])

  return (
    <group position={position} quaternion={quaternion}>
      {/* Shaft sits above the cone, both inside a group whose origin is the tip. */}
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.004, 0.004, 0.12, 8]} />
        <meshStandardMaterial color="#16A34A" />
      </mesh>
      {/* Cone tip points in -Y (toward the surface in local frame). */}
      <mesh position={[0, -0.005, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.016, 0.035, 12]} />
        <meshStandardMaterial color="#16A34A" />
      </mesh>
    </group>
  )
}

// ── Green disc marking the clicked face ─────────────────────────────

function FaceHighlight({ point, normal }) {
  const quaternion = useMemo(() => {
    if (!normal) return new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const n  = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize()
    return new THREE.Quaternion().setFromUnitVectors(up, n)
  }, [normal])
  if (!point || !normal) return null
  return (
    <mesh position={point} quaternion={quaternion}>
      <circleGeometry args={[0.025, 32]} />
      <meshBasicMaterial color="#16A34A" transparent opacity={0.4} side={THREE.DoubleSide} />
    </mesh>
  )
}

function PartCanvas({ url, rotation, frontAngle, approach, partExtents, selectedFace, onFaceClick, offsetCm }) {
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
        <PartModel3D
          url={url}
          rotation={rotation}
          frontAngle={frontAngle}
          onFaceClick={onFaceClick}
        />
      </Suspense>
      {selectedFace && (
        <>
          <PickArrow
            offsetCm={offsetCm}
            faceNormal={selectedFace.normal}
            facePoint={selectedFace.point}
          />
          <FaceHighlight point={selectedFace.point} normal={selectedFace.normal} />
        </>
      )}
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
  const [grasp, setGrasp]         = useState({
    approach:       'top_down',
    pick_offset_cm: 2.0,
  })
  // selectedFace = { normal: [x,y,z], point: [x,y,z], approach: 'top_down'|'side'|'angled' }
  const [selectedFace, setSelectedFace] = useState(null)
  const [saving, setSaving]       = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)  // null | 'saved' | error string

  const handleFaceClick = (faceData) => {
    setSelectedFace(faceData)
    setGrasp(prev => ({
      ...prev,
      approach:    faceData.approach,
      pick_normal: faceData.normal,
      pick_point:  faceData.point,
    }))
  }

  const resetSelectedFace = () => {
    setSelectedFace(null)
    setGrasp(prev => {
      const { pick_normal: _pn, pick_point: _pp, ...rest } = prev
      return rest
    })
  }

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
          const g = {
            approach:       d.grasp.approach || 'top_down',
            pick_offset_cm: d.grasp.pick_offset_cm ?? 2.0,
          }
          if (Array.isArray(d.grasp.pick_normal) && Array.isArray(d.grasp.pick_point)) {
            g.pick_normal = d.grasp.pick_normal
            g.pick_point  = d.grasp.pick_point
            setSelectedFace({
              normal:   d.grasp.pick_normal,
              point:    d.grasp.pick_point,
              approach: g.approach,
            })
          }
          setGrasp(g)
        }
      })
  }, [partId])

  async function save() {
    if (!partId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/parts/${partId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:            part?.name,
          table_surface:   tableSurface,
          table_rotation:  rotation,
          front_direction: frontDir,
          front_angle_deg: frontAngle,
          grasp: { ...grasp },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        if (data.part) setPart(data.part)
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus(null), 2000)
        onSave?.()
      } else {
        const msg = data.error || `HTTP ${res.status}`
        setSaveStatus(`error: ${msg}`)
        setTimeout(() => setSaveStatus(null), 3000)
      }
    } catch (e) {
      setSaveStatus(`error: ${e.message}`)
      setTimeout(() => setSaveStatus(null), 3000)
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
                    approach={grasp.approach} partExtents={part?.extents_m}
                    selectedFace={selectedFace} onFaceClick={handleFaceClick}
                    offsetCm={grasp.pick_offset_cm} />
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

        {/* Pick direction */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            Pick Direction
          </div>

          {selectedFace ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', marginBottom: 12,
              background: 'var(--green-dim)',
              borderRadius: 'var(--radius-sm)', fontSize: 12,
            }}>
              <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                ✓ Pick face selected
              </span>
              <button
                onClick={resetSelectedFace}
                style={{
                  marginLeft: 'auto',
                  padding: '2px 8px', fontSize: 10,
                  background: 'transparent', color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                }}
              >
                Reset
              </button>
            </div>
          ) : (
            <div style={{
              padding: '10px 12px', marginBottom: 12,
              background: 'var(--accent-dim)',
              border: '1px solid var(--accent-border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12, color: 'var(--accent)',
            }}>
              👆 Click a face on the 3D model to set where the gripper approaches from
            </div>
          )}

          <div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
              Approach Height: {(grasp.pick_offset_cm ?? 2).toFixed(1)} cm above part
            </div>
            <input type="range" min="0.5" max="15" step="0.5"
              value={grasp.pick_offset_cm ?? 2}
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
            flex: 1, padding: 10, fontSize: 13, fontWeight: 600,
            cursor: saving ? 'wait' : 'pointer',
            background: saveStatus === 'saved' ? 'rgba(34,197,94,0.32)'
                      : saveStatus && saveStatus.startsWith('error') ? 'rgba(239,68,68,0.18)'
                      : 'rgba(34,197,94,0.18)',
            color: saveStatus && saveStatus.startsWith('error') ? '#ef4444' : '#22c55e',
            border: saveStatus && saveStatus.startsWith('error')
              ? '1px solid rgba(239,68,68,0.6)'
              : '1px solid rgba(34,197,94,0.6)',
            borderRadius: 'var(--radius-md, 6px)',
          }}>
            {saving ? 'Saving…'
              : saveStatus === 'saved' ? '✓ Saved!'
              : saveStatus && saveStatus.startsWith('error') ? saveStatus
              : 'Save Configuration'}
          </button>
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
// Conversational, page-by-page flow modeled on ProgramWizard. Each
// page asks ONE question; the answer determines the next page. The
// same modal overlay + PAGES-array pattern gives operators one mental
// model for every wizard in the app.
//
// Entry points:
//   • Library "Teach New Part" button  → starts at part_name (page 0)
//   • Per-row "Teach" button           → part exists; pages 0–3 skip,
//                                        wizard begins at pickable_count

function QuestionCard({ question, description, children }) {
  return (
    <div style={{ padding: 28, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 8, lineHeight: 1.3 }}>
        {question}
      </div>
      {description && (
        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 22, lineHeight: 1.5 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  )
}

function ChoiceButton({ label, description, selected, onClick, accent = '#2563EB' }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', padding: '14px 16px', textAlign: 'left', cursor: 'pointer',
      background: selected ? '#eff6ff' : '#fff',
      border: selected ? `2px solid ${accent}` : '2px solid #e5e7eb',
      borderRadius: 10, marginBottom: 8, minHeight: 44,
      transition: 'all 100ms',
    }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: selected ? accent : '#111' }}>{label}</div>
      {description && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{description}</div>
      )}
    </button>
  )
}

function NextButton({ onClick, disabled, label, color = '#2563EB' }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: '100%', padding: '14px', fontSize: 16, fontWeight: 700, marginTop: 14,
      background: disabled ? '#d1d5db' : color, color: '#fff',
      border: 'none', borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
      minHeight: 44,
    }}>
      {label || 'Next'}
    </button>
  )
}

// Inline capture component used on every "Capture: X" page so the
// accent colour (green / amber / red) tracks the orientation type.
function CaptureView({
  partId, orientation, orientationNumber, orientationLabel,
  isPickable, isDefect, defectName, defectDescription, defectSeverity,
  onCapture, captureCount,
}) {
  const [capturing, setCapturing] = useState(false)
  const [error,     setError]     = useState(null)

  const accent = isDefect    ? '#DC2626'
              : isPickable   ? '#16A34A'
              :                '#CA8A04'  // non-pickable → amber
  const tint   = isDefect    ? '#fef2f2'
              : isPickable   ? '#f0fdf4'
              :                '#fffbeb'

  const handleCapture = async () => {
    if (!partId) {
      setError('Part is not registered yet. Go back one step.')
      return
    }
    setCapturing(true); setError(null)
    try {
      const res = await fetch(`/api/parts/${partId}/teach`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          orientation,
          orientation_number: orientationNumber,
          orientation_label:  orientationLabel,
          is_pickable:        !!isPickable,
          is_defect:          !!isDefect,
          defect_name:        defectName        || '',
          defect_description: defectDescription || '',
          defect_severity:    defectSeverity    || '',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.captured === false) {
        setError('No object captured — make sure a green detection box is visible, then try again.')
      } else if (res.ok) {
        onCapture()
      } else {
        setError(data.error || `Capture failed (HTTP ${res.status})`)
      }
    } catch (e) {
      setError(e.message || 'Network error')
    }
    setCapturing(false)
  }

  return (
    <div>
      <div style={{
        width: '100%', borderRadius: 10, overflow: 'hidden',
        border: `2px solid ${accent}`, marginBottom: 10, background: '#111',
      }}>
        <img src="/stream/annotated" alt="Camera"
          style={{ width: '100%', display: 'block' }} />
      </div>

      {(isDefect || !isPickable) && (
        <div style={{
          display: 'inline-block', padding: '4px 10px', borderRadius: 4,
          background: accent, color: '#fff',
          fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
          marginBottom: 10,
        }}>{isDefect ? 'NON-PICKABLE — DEFECT' : 'NON-PICKABLE'}</div>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
        padding: '10px 14px', background: tint,
        borderRadius: 8, border: `1px solid ${accent}40`,
      }}>
        <div style={{
          fontSize: 28, fontWeight: 800, color: accent,
          fontVariantNumeric: 'tabular-nums',
        }}>{captureCount}</div>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          capture{captureCount === 1 ? '' : 's'} taken
          {captureCount < 2 && (
            <span style={{ color: accent, fontWeight: 600 }}> — need at least 2</span>
          )}
        </div>
      </div>

      <div style={{
        fontSize: 12, color: '#6b7280', lineHeight: 1.7,
        marginBottom: 12, padding: '10px 14px',
        background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb',
      }}>
        1. Place the part in view of the camera<br/>
        2. Wait for the green detection box<br/>
        3. Click <b>Capture</b><br/>
        4. Rotate slightly and capture again for better recognition
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', marginBottom: 10,
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6,
          fontSize: 12, color: '#DC2626',
        }}>{error}</div>
      )}

      <button onClick={handleCapture} disabled={capturing} style={{
        width: '100%', padding: '16px', fontSize: 16, fontWeight: 700,
        background: capturing ? '#9ca3af' : accent, color: '#fff',
        border: 'none', borderRadius: 10, cursor: capturing ? 'wait' : 'pointer',
        minHeight: 48,
      }}>
        {capturing ? 'Capturing...' : 'Capture'}
      </button>
    </div>
  )
}

const MAX_PICKABLE     = 6
const MAX_NON_PICKABLE = 5

const PAGES = [
  // 0. Part name (skip when teaching an existing part)
  {
    id: 'part_name',
    skip: (a) => !!a.part_id,
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What is this part called?"
        description="Give it a name you'll recognize in the parts library."
      >
        <input
          autoFocus
          value={answers.part_name || ''}
          onChange={(e) => setAnswer('part_name', e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && answers.part_name?.trim()) goNext() }}
          placeholder="e.g. M6 hex bolt"
          style={{
            width: '100%', padding: '14px 16px', fontSize: 17, fontWeight: 600,
            border: '2px solid #2563EB', borderRadius: 10, outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <NextButton onClick={goNext} disabled={!answers.part_name?.trim()} />
      </QuestionCard>
    ),
  },

  // 1. Part description
  {
    id: 'part_description',
    skip: (a) => !!a.part_id,
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Describe this part briefly"
        description="This helps operators identify it. For example: small steel bracket with two mounting holes."
      >
        <textarea
          autoFocus
          value={answers.part_description || ''}
          onChange={(e) => setAnswer('part_description', e.target.value)}
          rows={2}
          placeholder="e.g. Small steel bracket with two mounting holes"
          style={{
            width: '100%', padding: '12px 14px', fontSize: 14,
            border: '2px solid #e5e7eb', borderRadius: 10, outline: 'none',
            resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
        <NextButton onClick={goNext} />
      </QuestionCard>
    ),
  },

  // 2. Has STEP?
  {
    id: 'has_step',
    skip: (a) => !!a.part_id,
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Do you have a 3D model (STEP file) for this part?"
        description="A STEP file gives exact dimensions and enables automatic template generation. If you don't have one, the system will learn from camera captures only."
      >
        <ChoiceButton
          label="Yes — upload STEP file"
          description="Best accuracy. Provides dimensions and a 3D preview."
          selected={answers.has_step === true}
          onClick={() => { setAnswer('has_step', true); goNext() }}
        />
        <ChoiceButton
          label="No — teach from camera only"
          description="Skip the STEP upload and teach the robot purely from camera captures."
          selected={answers.has_step === false}
          onClick={() => { setAnswer('has_step', false); goNext() }}
        />
      </QuestionCard>
    ),
  },

  // 3. STEP upload
  {
    id: 'step_upload',
    skip: (a) => !!a.part_id || a.has_step !== true,
    render: ({ answers, setAnswer, goNext }) => {
      const [uploading, setUploading] = useState(false)
      const [err, setErr]             = useState(null)
      const inputRef                  = useRef(null)

      const upload = async (file) => {
        if (!file) return
        if (!/\.(step|stp)$/i.test(file.name)) {
          setErr('Only .STEP / .STP files are accepted')
          return
        }
        setUploading(true); setErr(null)
        try {
          const fd = new FormData()
          fd.append('file', file)
          const r = await fetch('/api/parts/upload', { method: 'POST', body: fd })
          const d = await r.json()
          if (!r.ok || !d.ok) {
            setErr(d.error || 'Upload failed')
          } else {
            setAnswer('part_id',     d.part_id)
            setAnswer('part_name',   d.name || answers.part_name)
            setAnswer('step_file_id', d.part_id)
            setAnswer('dimensions',  d.extents_cm)
            setAnswer('stl_url',     d.stl_url)
          }
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setUploading(false)
        }
      }

      const dims = answers.dimensions
      return (
        <QuestionCard
          question="Upload the STEP file"
          description="Drag and drop or click to browse. The system will extract dimensions and generate recognition templates."
        >
          <div
            onClick={() => !uploading && inputRef.current?.click()}
            onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files?.[0]) }}
            onDragOver={(e) => e.preventDefault()}
            style={{
              padding: 32, textAlign: 'center', cursor: uploading ? 'wait' : 'pointer',
              border: '2px dashed #93c5fd', borderRadius: 12,
              background: '#f0f9ff', color: '#2563EB',
              fontSize: 15, fontWeight: 600, marginBottom: 12, minHeight: 100,
            }}
          >
            {uploading
              ? 'Processing STEP file...'
              : answers.part_id
                ? '+ STEP uploaded — click to replace'
                : 'Click to browse, or drop a .STEP file here'}
          </div>
          <input ref={inputRef} type="file" accept=".step,.stp,.STEP,.STP"
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files?.[0])}
          />

          {err && (
            <div style={{
              padding: '8px 12px', marginBottom: 10,
              background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6,
              fontSize: 12, color: '#DC2626',
            }}>{err}</div>
          )}

          {dims && (
            <div style={{
              padding: 14, background: '#f0fdf4', border: '1px solid #bbf7d0',
              borderRadius: 10, marginBottom: 12,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#16A34A', marginBottom: 4 }}>
                Dimensions extracted
              </div>
              <div style={{ fontSize: 13, color: '#374151', fontFamily: 'monospace' }}>
                {Number(dims[0]).toFixed(1)} × {Number(dims[1]).toFixed(1)} × {Number(dims[2]).toFixed(1)} cm
              </div>
            </div>
          )}

          <NextButton onClick={goNext} disabled={!answers.part_id} />
        </QuestionCard>
      )
    },
  },

  // 4. Pickable count
  {
    id: 'pickable_count',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How many ways can the robot pick up this part?"
        description="Think about all the positions where the gripper can safely grab the part. A simple cube has 3 pickable faces. A bracket might only have 1 or 2."
      >
        <div style={{
          padding: 12, background: '#f8fafc', borderRadius: 8,
          border: '1px solid #e5e7eb', marginBottom: 16,
          fontSize: 13, color: '#374151', lineHeight: 1.6,
        }}>
          <div><b>1 orientation</b> — part can only be picked one way (e.g. always right-side up)</div>
          <div><b>2 orientations</b> — part can be picked two ways (e.g. right-side up or on its side)</div>
          <div><b>3+ orientations</b> — part has multiple stable pickable positions</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[1, 2, 3, 4, 5, 6].map((n) => {
            const selected = answers.pickable_count === n
            return (
              <button key={n}
                onClick={() => {
                  setAnswer('pickable_count', n)
                  const labels = (answers.pickable_labels || []).slice(0, n)
                  while (labels.length < n) labels.push('')
                  setAnswer('pickable_labels', labels)
                  goNext()
                }}
                style={{
                  padding: '18px', fontSize: 22, fontWeight: 700,
                  background: selected ? '#16A34A' : '#fff',
                  color:      selected ? '#fff'    : '#111',
                  border:     selected ? '2px solid #16A34A' : '2px solid #e5e7eb',
                  borderRadius: 10, cursor: 'pointer', minHeight: 56,
                }}>{n}</button>
            )
          })}
        </div>
      </QuestionCard>
    ),
  },

  // 5..16. Per-pickable-orientation NAME then CAPTURE pages
  ...Array.from({ length: MAX_PICKABLE }, (_, i) => ([
    {
      id: `pickable_name_${i}`,
      skip: (a) => (a.pickable_count || 0) <= i,
      render: ({ answers, setAnswer, goNext }) => {
        const labels = answers.pickable_labels || []
        const value  = labels[i] || ''
        const update = (v) => {
          const next = labels.slice()
          next[i] = v
          setAnswer('pickable_labels', next)
        }
        return (
          <QuestionCard
            question={`Describe pickable orientation ${i + 1}`}
            description="What does the part look like in this position? For example: 'Right side up — holes facing up' or 'Flat on table — logo visible'"
          >
            <input
              autoFocus
              value={value}
              onChange={(e) => update(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) goNext() }}
              placeholder="e.g. Right side up, holes facing up"
              style={{
                width: '100%', padding: '14px 16px', fontSize: 16, fontWeight: 600,
                border: '2px solid #16A34A', borderRadius: 10, outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <NextButton onClick={goNext} disabled={!value.trim()} color="#16A34A" />
          </QuestionCard>
        )
      },
    },
    {
      id: `pickable_capture_${i}`,
      skip: (a) => (a.pickable_count || 0) <= i,
      render: ({ answers, setAnswer, goNext }) => {
        const label  = answers.pickable_labels?.[i] || ''
        const counts = answers.pickable_captures || []
        const count  = counts[i] || 0
        const bump = () => {
          const next = counts.slice()
          next[i] = (next[i] || 0) + 1
          setAnswer('pickable_captures', next)
        }
        return (
          <QuestionCard
            question={`Capture: ${label || 'Pickable orientation ' + (i + 1)}`}
            description="Place the part in this orientation in front of the camera. Rotate it to different angles and capture multiple views. More captures = better recognition."
          >
            <CaptureView
              partId={answers.part_id}
              orientation="pickable"
              orientationNumber={i}
              orientationLabel={label}
              isPickable={true}
              isDefect={false}
              onCapture={bump}
              captureCount={count}
            />
            <NextButton onClick={goNext} disabled={count < 2} color="#16A34A"
              label={count < 2 ? `Need ${2 - count} more capture${2 - count === 1 ? '' : 's'}` : 'Next'} />
          </QuestionCard>
        )
      },
    },
  ])).flat(),

  // 17. Non-pickable count
  {
    id: 'non_pickable_count',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How many non-pickable orientations do you want to teach?"
        description="Non-pickable means the robot should NOT try to grab it in this position. For example: upside down, balanced on an edge, or standing up. Teaching these helps the robot recognize them and either skip the part or flip it first."
      >
        <div style={{
          padding: 12, background: '#fffbeb', borderRadius: 8,
          border: '1px solid #fde68a', marginBottom: 16,
          fontSize: 13, color: '#92400E',
        }}>
          You can also skip this — the robot will only pick parts matching the pickable orientations you just taught.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[0, 1, 2, 3, 4, 5].map((n) => {
            const selected = answers.non_pickable_count === n
            return (
              <button key={n}
                onClick={() => {
                  setAnswer('non_pickable_count', n)
                  const labels = (answers.non_pickable_labels || []).slice(0, n)
                  while (labels.length < n) labels.push('')
                  setAnswer('non_pickable_labels', labels)
                  goNext()
                }}
                style={{
                  padding: '18px', fontSize: 22, fontWeight: 700,
                  background: selected ? '#CA8A04' : '#fff',
                  color:      selected ? '#fff'    : '#111',
                  border:     selected ? '2px solid #CA8A04' : '2px solid #e5e7eb',
                  borderRadius: 10, cursor: 'pointer', minHeight: 56,
                }}>{n === 0 ? 'Skip' : n}</button>
            )
          })}
        </div>
      </QuestionCard>
    ),
  },

  // 18..27. Per-non-pickable NAME then CAPTURE
  ...Array.from({ length: MAX_NON_PICKABLE }, (_, i) => ([
    {
      id: `non_pickable_name_${i}`,
      skip: (a) => (a.non_pickable_count || 0) <= i,
      render: ({ answers, setAnswer, goNext }) => {
        const labels = answers.non_pickable_labels || []
        const value  = labels[i] || ''
        const update = (v) => {
          const next = labels.slice()
          next[i] = v
          setAnswer('non_pickable_labels', next)
        }
        return (
          <QuestionCard
            question={`Describe non-pickable orientation ${i + 1}`}
            description="What does the part look like in this position? The robot will learn NOT to pick it this way."
          >
            <input
              autoFocus
              value={value}
              onChange={(e) => update(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) goNext() }}
              placeholder="e.g. Upside down, Balanced on edge, Standing vertical"
              style={{
                width: '100%', padding: '14px 16px', fontSize: 16, fontWeight: 600,
                border: '2px solid #CA8A04', borderRadius: 10, outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <NextButton onClick={goNext} disabled={!value.trim()} color="#CA8A04" />
          </QuestionCard>
        )
      },
    },
    {
      id: `non_pickable_capture_${i}`,
      skip: (a) => (a.non_pickable_count || 0) <= i,
      render: ({ answers, setAnswer, goNext }) => {
        const label  = answers.non_pickable_labels?.[i] || ''
        const counts = answers.non_pickable_captures || []
        const count  = counts[i] || 0
        const bump = () => {
          const next = counts.slice()
          next[i] = (next[i] || 0) + 1
          setAnswer('non_pickable_captures', next)
        }
        return (
          <QuestionCard
            question={`Capture: ${label} (Non-pickable)`}
            description="Place the part in this NON-PICKABLE orientation. The robot will learn to recognize this and avoid picking it."
          >
            <CaptureView
              partId={answers.part_id}
              orientation="non_pickable"
              orientationNumber={i}
              orientationLabel={label}
              isPickable={false}
              isDefect={false}
              onCapture={bump}
              captureCount={count}
            />
            <NextButton onClick={goNext} disabled={count < 2} color="#CA8A04"
              label={count < 2 ? `Need ${2 - count} more capture${2 - count === 1 ? '' : 's'}` : 'Next'} />
          </QuestionCard>
        )
      },
    },
  ])).flat(),

  // 28. Teach defects?
  {
    id: 'teach_defects',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Do you want to teach defective versions of this part?"
        description="If this part has known defects (cracks, bends, missing features), you can teach what they look like. The robot will flag defective parts during operation."
      >
        <ChoiceButton
          label="Yes — teach defects"
          description="Walk through each defect type one at a time."
          selected={answers.teach_defects === true}
          onClick={() => { setAnswer('teach_defects', true); goNext() }}
          accent="#DC2626"
        />
        <ChoiceButton
          label="No — skip"
          description="No defect references will be taught. You can come back later."
          selected={answers.teach_defects === false}
          onClick={() => { setAnswer('teach_defects', false); goNext() }}
        />
      </QuestionCard>
    ),
  },

  // 29. Defect name
  {
    id: 'defect_name',
    skip: (a) => a.teach_defects !== true,
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What is this defect called?"
        description="Short, memorable name. You'll see this name in the operator's reject log."
      >
        <input
          autoFocus
          value={answers.cur_defect_name || ''}
          onChange={(e) => setAnswer('cur_defect_name', e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && answers.cur_defect_name?.trim()) goNext() }}
          placeholder="e.g. Cracked, Bent, Missing hole, Scratched"
          style={{
            width: '100%', padding: '14px 16px', fontSize: 16, fontWeight: 600,
            border: '2px solid #DC2626', borderRadius: 10, outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <NextButton onClick={goNext} disabled={!answers.cur_defect_name?.trim()} color="#DC2626" />
      </QuestionCard>
    ),
  },

  // 30. Defect description
  {
    id: 'defect_description',
    skip: (a) => a.teach_defects !== true,
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Describe what this defect looks like"
        description="Be specific — operators will read this when triaging the reject bin."
      >
        <textarea
          autoFocus
          value={answers.cur_defect_description || ''}
          onChange={(e) => setAnswer('cur_defect_description', e.target.value)}
          rows={3}
          placeholder="e.g. Visible crack on the top surface near the left mounting hole"
          style={{
            width: '100%', padding: '12px 14px', fontSize: 14,
            border: '2px solid #e5e7eb', borderRadius: 10, outline: 'none',
            resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
        <NextButton onClick={goNext} color="#DC2626" />
      </QuestionCard>
    ),
  },

  // 31. Defect severity
  {
    id: 'defect_severity',
    skip: (a) => a.teach_defects !== true,
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How serious is this defect?"
        description="Determines how the robot handles it during operation."
      >
        <ChoiceButton
          label="Reject"
          description="Part must be removed, cannot be used."
          selected={answers.cur_defect_severity === 'reject'}
          onClick={() => { setAnswer('cur_defect_severity', 'reject'); goNext() }}
          accent="#DC2626"
        />
        <ChoiceButton
          label="Warning"
          description="Part is borderline — operator should inspect."
          selected={answers.cur_defect_severity === 'warning'}
          onClick={() => { setAnswer('cur_defect_severity', 'warning'); goNext() }}
          accent="#CA8A04"
        />
        <ChoiceButton
          label="Cosmetic"
          description="Minor visual issue, part still functional."
          selected={answers.cur_defect_severity === 'cosmetic'}
          onClick={() => { setAnswer('cur_defect_severity', 'cosmetic'); goNext() }}
        />
      </QuestionCard>
    ),
  },

  // 32. Defect capture
  {
    id: 'defect_capture',
    skip: (a) => a.teach_defects !== true,
    render: ({ answers, setAnswer, goNext, goTo }) => {
      const name  = answers.cur_defect_name || ''
      const count = answers.cur_defect_capture_count || 0
      const bump  = () => setAnswer('cur_defect_capture_count', count + 1)

      const folder = () => {
        const defects = answers.defects || []
        const next = defects.concat([{
          name,
          description:   answers.cur_defect_description || '',
          severity:      answers.cur_defect_severity || 'reject',
          capture_count: count,
        }])
        setAnswer('defects', next)
        setAnswer('cur_defect_name', '')
        setAnswer('cur_defect_description', '')
        setAnswer('cur_defect_severity', 'reject')
        setAnswer('cur_defect_capture_count', 0)
      }

      const addAnother      = () => { folder(); goTo('defect_name') }
      const doneWithDefects = () => { folder(); goNext() }

      return (
        <QuestionCard
          question={`Capture: ${name}`}
          description="Place a defective part showing this defect in front of the camera."
        >
          <CaptureView
            partId={answers.part_id}
            orientation="non_pickable"
            orientationNumber={(answers.defects || []).length}
            orientationLabel={name}
            isPickable={false}
            isDefect={true}
            defectName={name}
            defectDescription={answers.cur_defect_description || ''}
            defectSeverity={answers.cur_defect_severity || 'reject'}
            onCapture={bump}
            captureCount={count}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={addAnother} disabled={count < 2}
              style={{
                flex: 1, padding: '14px', fontSize: 14, fontWeight: 700,
                background: count < 2 ? '#f3f4f6' : '#fff',
                color:      count < 2 ? '#9ca3af' : '#DC2626',
                border:     count < 2 ? '2px solid #e5e7eb' : '2px solid #DC2626',
                borderRadius: 10, cursor: count < 2 ? 'default' : 'pointer',
                minHeight: 44,
              }}>+ Add another defect</button>
            <button onClick={doneWithDefects} disabled={count < 2}
              style={{
                flex: 1, padding: '14px', fontSize: 14, fontWeight: 700,
                background: count < 2 ? '#d1d5db' : '#16A34A', color: '#fff',
                border: 'none', borderRadius: 10,
                cursor: count < 2 ? 'default' : 'pointer',
                minHeight: 44,
              }}>Done — Review</button>
          </div>
        </QuestionCard>
      )
    },
  },

  // 33. Review + save
  {
    id: 'review',
    render: ({ answers, saving, onSave, goTo }) => {
      const pickable = (answers.pickable_labels || []).slice(0, answers.pickable_count || 0)
      const pickCaps = answers.pickable_captures || []
      const nonPick  = (answers.non_pickable_labels || []).slice(0, answers.non_pickable_count || 0)
      const nonCaps  = answers.non_pickable_captures || []
      const defects  = answers.defects || []
      const total = pickCaps.reduce((a, b) => a + (b || 0), 0)
                  + nonCaps.reduce((a, b) => a + (b || 0), 0)
                  + defects.reduce((a, d) => a + (d.capture_count || 0), 0)

      return (
        <QuestionCard
          question="Review your part teaching"
          description={`${answers.part_name || 'Unnamed part'} — ${total} total capture${total === 1 ? '' : 's'}`}
        >
          {answers.part_description && (
            <div style={{
              fontSize: 13, color: '#374151', marginBottom: 12,
              padding: '10px 14px', background: '#f8fafc',
              borderRadius: 8, border: '1px solid #e5e7eb',
            }}>{answers.part_description}</div>
          )}

          {answers.dimensions && answers.dimensions[0] > 0 && (
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
              STEP dimensions: {Number(answers.dimensions[0]).toFixed(1)} × {Number(answers.dimensions[1]).toFixed(1)} × {Number(answers.dimensions[2]).toFixed(1)} cm
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#16A34A', marginBottom: 6 }}>
              Pickable orientations
            </div>
            {pickable.length === 0 && (
              <div style={{ fontSize: 12, color: '#9ca3af' }}>None taught</div>
            )}
            {pickable.map((label, i) => {
              const c = pickCaps[i] || 0
              const ok = c >= 2
              return (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '8px 12px', marginBottom: 4,
                  background: '#f0fdf4', border: '1px solid #bbf7d0',
                  borderRadius: 6, fontSize: 13,
                }}>
                  <span style={{ color: '#16A34A', fontWeight: 600 }}>
                    {label || `(unnamed ${i + 1})`} {ok ? '✓' : ''}
                  </span>
                  <span style={{ color: '#6b7280' }}>{c} capture{c === 1 ? '' : 's'}</span>
                </div>
              )
            })}
          </div>

          {nonPick.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#CA8A04', marginBottom: 6 }}>
                Non-pickable orientations
              </div>
              {nonPick.map((label, i) => {
                const c = nonCaps[i] || 0
                return (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '8px 12px', marginBottom: 4,
                    background: '#fffbeb', border: '1px solid #fde68a',
                    borderRadius: 6, fontSize: 13,
                  }}>
                    <span style={{ color: '#92400E', fontWeight: 600 }}>{label}</span>
                    <span style={{ color: '#6b7280' }}>{c} capture{c === 1 ? '' : 's'}</span>
                  </div>
                )
              })}
            </div>
          )}

          {defects.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>
                Defects
              </div>
              {defects.map((d, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px', marginBottom: 4,
                  background: '#fef2f2', border: '1px solid #fecaca',
                  borderRadius: 6, fontSize: 13,
                }}>
                  <span style={{ color: '#DC2626', fontWeight: 600, flex: 1 }}>{d.name}</span>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, color: '#fff',
                    background: d.severity === 'reject'  ? '#DC2626'
                             : d.severity === 'warning'  ? '#CA8A04' : '#6b7280',
                  }}>{(d.severity || '').toUpperCase()}</span>
                  <span style={{ color: '#6b7280' }}>{d.capture_count} ref{d.capture_count === 1 ? '' : 's'}</span>
                </div>
              ))}
            </div>
          )}

          <button onClick={onSave} disabled={saving} style={{
            width: '100%', padding: 16, fontSize: 17, fontWeight: 700,
            background: saving ? '#9ca3af' : '#16A34A', color: '#fff',
            border: 'none', borderRadius: 10, cursor: saving ? 'wait' : 'pointer',
            marginTop: 6, minHeight: 48,
          }}>
            {saving ? 'Saving...' : 'Save Part'}
          </button>

          <button onClick={() => goTo('pickable_count')} style={{
            width: '100%', padding: 12, fontSize: 14, marginTop: 8,
            background: 'transparent', color: '#6b7280',
            border: '1px solid #d1d5db', borderRadius: 10, cursor: 'pointer',
            minHeight: 44,
          }}>
            Teach More
          </button>
        </QuestionCard>
      )
    },
  },
]

function TeachWizard({ part, onClose, onComplete }) {
  // `part` from per-row "Teach" button pre-fills + skips pages 0–3.
  // "Teach New Part" passes no part and the wizard starts at page 0.
  const initialAnswers = useMemo(() => ({
    part_id:                  part?.id || null,
    part_name:                part?.name || '',
    part_description:         part?.description || '',
    has_step:                 part?.id ? !!part?.source_file : null,
    dimensions:               part?.extents_cm || null,
    stl_url:                  null,
    pickable_count:           1,
    pickable_labels:          [''],
    pickable_captures:        [],
    non_pickable_count:       0,
    non_pickable_labels:      [],
    non_pickable_captures:    [],
    teach_defects:            null,
    defects:                  [],
    cur_defect_name:          '',
    cur_defect_description:   '',
    cur_defect_severity:      'reject',
    cur_defect_capture_count: 0,
  }), [part])

  const firstUnskipped = (a) => {
    let i = 0
    while (i < PAGES.length && PAGES[i].skip?.(a)) i++
    return Math.min(i, PAGES.length - 1)
  }

  const [answers,   setAnswers]   = useState(initialAnswers)
  const [pageIdx,   setPageIdx]   = useState(() => firstUnskipped(initialAnswers))
  const [history,   setHistory]   = useState(() => [firstUnskipped(initialAnswers)])
  const [saving,    setSaving]    = useState(false)
  const [creating,  setCreating]  = useState(false)
  const [createErr, setCreateErr] = useState(null)

  // Pause the matcher while the wizard is open so teach captures
  // don't drive false positives in the main detector.
  useEffect(() => {
    fetch('/api/teach_mode/start', { method: 'POST' }).catch(() => {})
    return () => {
      fetch('/api/teach_mode/stop', { method: 'POST' }).catch(() => {})
    }
  }, [])

  const setAnswer = useCallback((key, value) => {
    setAnswers((prev) => ({ ...prev, [key]: value }))
  }, [])

  const ensurePartExists = useCallback(async () => {
    if (answers.part_id) return answers.part_id
    setCreating(true); setCreateErr(null)
    try {
      const r = await fetch('/api/parts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:        (answers.part_name || '').trim() || 'Untitled part',
          description: (answers.part_description || '').trim(),
        }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) {
        setCreateErr(d.error || 'Failed to create part')
        return null
      }
      setAnswer('part_id', d.part_id)
      return d.part_id
    } catch (e) {
      setCreateErr(String(e.message || e))
      return null
    } finally {
      setCreating(false)
    }
  }, [answers.part_id, answers.part_name, answers.part_description, setAnswer])

  const goNext = useCallback(async () => {
    let next = pageIdx + 1
    while (next < PAGES.length && PAGES[next].skip?.(answers)) next++
    if (next >= PAGES.length) return
    // Capture pages need a real part_id. Create one if the STEP-upload
    // branch was skipped (camera-only flow).
    const target = PAGES[next]
    if (target.id?.endsWith('_capture_0') || target.id === 'defect_capture') {
      if (!answers.part_id) {
        const id = await ensurePartExists()
        if (!id) return
      }
    }
    setPageIdx(next)
    setHistory((prev) => [...prev, next])
  }, [pageIdx, answers, ensurePartExists])

  const goBack = useCallback(() => {
    if (history.length > 1) {
      const trimmed = history.slice(0, -1)
      setHistory(trimmed)
      setPageIdx(trimmed[trimmed.length - 1])
    }
  }, [history])

  const goTo = useCallback((pageId) => {
    const idx = PAGES.findIndex((p) => p.id === pageId)
    if (idx < 0) return
    setPageIdx(idx)
    setHistory((prev) => [...prev, idx])
  }, [])

  const onSave = useCallback(async () => {
    setSaving(true)
    // Captures are persisted as they happen via /api/parts/<id>/teach.
    // Save just closes the wizard and triggers the parent refresh.
    onComplete?.()
    onClose?.()
    setSaving(false)
  }, [onClose, onComplete])

  const page = PAGES[pageIdx]
  const progressPct = Math.min(100, ((history.length - 1) / Math.max(1, PAGES.length - 1)) * 100)

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '95%', maxWidth: 700, maxHeight: '95vh',
        background: '#fff', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {history.length > 1 && (
            <button onClick={goBack} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, color: '#6b7280', padding: '2px 6px',
              minWidth: 28, minHeight: 28,
            }}>{'<'}</button>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              Teach Part Recognition
            </div>
            {answers.part_name && (
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>
                {answers.part_name}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 18, color: '#9ca3af', padding: '2px 8px',
            minWidth: 28, minHeight: 28,
          }}>X</button>
        </div>

        <div style={{ height: 3, background: '#e5e7eb' }}>
          <div style={{
            height: '100%', background: '#2563EB',
            width: progressPct + '%',
            transition: 'width 300ms',
          }} />
        </div>

        {creating && (
          <div style={{
            padding: '8px 16px', background: '#eff6ff', borderTop: '1px solid #bfdbfe',
            fontSize: 12, color: '#2563EB',
          }}>Creating part record...</div>
        )}
        {createErr && (
          <div style={{
            padding: '8px 16px', background: '#fef2f2', borderTop: '1px solid #fecaca',
            fontSize: 12, color: '#DC2626',
          }}>{createErr}</div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {page.render({ answers, setAnswer, goNext, goBack, goTo, saving, onSave })}
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

          <button onClick={() => setTeachingPart('NEW')}
            style={{
              width: '100%', padding: 12, fontSize: 13, fontWeight: 700,
              cursor: 'pointer',
              background: '#16A34A', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md, 6px)', marginBottom: 8,
            }}
          >+ Teach New Part</button>

          <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
            style={{
              width: '100%', padding: 10, fontSize: 12, fontWeight: 600,
              cursor: uploading ? 'wait' : 'pointer',
              background: 'rgba(59,130,246,0.85)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md, 6px)', marginBottom: 8,
            }}
          >{uploading ? 'Processing STEP file…' : 'Upload STEP File only'}</button>
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
              Upload a STEP file to start part recognition.
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
                  {(part.defect_types?.length || 0) > 0 && (
                    <div style={{
                      fontSize: 10, marginTop: 2, color: '#DC2626', fontWeight: 600,
                    }} title={part.defect_types.map(d => d.name).join(', ')}>
                      {part.defect_types.length} defect type{part.defect_types.length > 1 ? 's' : ''}: {part.defect_types.map(d => d.name).join(', ')}
                    </div>
                  )}
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
          part={teachingPart === 'NEW' ? null : teachingPart}
          onClose={() => { setTeachingPart(null); refresh() }}
          onComplete={() => refresh()}
        />
      )}
    </div>
  )
}

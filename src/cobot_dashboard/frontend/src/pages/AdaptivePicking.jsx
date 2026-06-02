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

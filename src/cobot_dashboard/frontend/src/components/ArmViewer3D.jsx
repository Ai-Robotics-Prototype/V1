import { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

// ---------------------------------------------------------------------------
// ArmViewer3D — static (non-articulated) viewer of the converted Estun
// S10-140 GLB. Loads /robot/model_lite.glb first (~3 MB, fast on the
// tablet) and falls back to the full /robot/model.glb if the lite file
// is missing.
//
// Articulation is deliberately not wired up here — the previous
// link-splitting attempt produced a disjointed mesh because the
// part-to-link assignment can't be done cleanly without measuring
// against the real arm. The articulated viewer is a follow-up; this
// gets us a clean visual that stands upright and reads correctly.
// ---------------------------------------------------------------------------

const JOINT_COLORS = ['#3B82F6', '#16A34A', '#CA8A04', '#DC2626', '#9333EA', '#F97316']

// Camera presets — chosen for an arm whose base sits on Y=0 and
// extends up to roughly Y=2 after the in-loader normalisation.
const PRESETS = {
  front: [0, 1.2, 3],
  side:  [3, 1.2, 0],
  top:   [0, 4, 0.01],
  iso:   [2, 1.5, 2],
}

const LITE_URL = '/robot/model_lite.glb'
const FULL_URL = '/robot/model.glb'

function RobotModel({ onLoaded, onError }) {
  const [model, setModel] = useState(null)

  useEffect(() => {
    const loader = new GLTFLoader()
    let disposed = false

    const fit = (scene) => {
      // Phong (not Standard) so we don't need an environment map —
      // metallic Standard material reads as nearly black on a plain
      // white background. Phong has a usable specular highlight
      // without an env probe.
      scene.traverse((child) => {
        if (child.isMesh) {
          child.material = new THREE.MeshPhongMaterial({
            color:     0xC0C8D4,
            specular:  0x666666,
            shininess: 30,
            side:      THREE.DoubleSide,
          })
        }
      })

      // 1) Center on the geometric centroid.
      const box    = new THREE.Box3().setFromObject(scene)
      const center = box.getCenter(new THREE.Vector3())
      const size   = box.getSize(new THREE.Vector3())
      scene.position.sub(center)

      // 2) Auto-detect the tallest axis in the source file and
      //    rotate so it becomes three.js +Y. STEP files often use
      //    Z-up; the GLB exporter may or may not have converted.
      //    Doing this from the actual bounds keeps us robust.
      const dims = [size.x, size.y, size.z]
      const tallest = dims.indexOf(Math.max(...dims))
      if (tallest === 0)        scene.rotation.z =  Math.PI / 2  // X is up
      else if (tallest === 2)   scene.rotation.x = -Math.PI / 2  // Z is up
      // tallest === 1: Y is already up, no rotation needed.

      // 3) Scale to a ~2-unit envelope so the OrbitControls preset
      //    distances make sense regardless of the source units.
      scene.updateMatrixWorld(true)
      const box2  = new THREE.Box3().setFromObject(scene)
      const size2 = box2.getSize(new THREE.Vector3())
      const maxDim = Math.max(size2.x, size2.y, size2.z)
      if (maxDim > 0) scene.scale.multiplyScalar(2.0 / maxDim)

      // 4) Plant the base on the grid (so the floor isn't a foot
      //    above or below the bottom of the model).
      scene.updateMatrixWorld(true)
      const box3 = new THREE.Box3().setFromObject(scene)
      scene.position.y -= box3.min.y

      setModel(scene)
      onLoaded && onLoaded()
    }

    loader.load(
      LITE_URL,
      (gltf) => { if (!disposed) fit(gltf.scene) },
      undefined,
      () => {
        // Lite missing — try the full GLB. Slower (~114 MB) but
        // ensures the operator sees *something* even on a fresh
        // checkout where the decimator hasn't run yet.
        if (disposed) return
        console.warn('Lite GLB missing, falling back to full model')
        loader.load(
          FULL_URL,
          (gltf) => { if (!disposed) fit(gltf.scene) },
          undefined,
          (err) => { if (!disposed && onError) onError(`GLB load failed: ${err?.message || err}`) },
        )
      },
    )

    return () => {
      disposed = true
      if (model) {
        model.traverse((o) => {
          if (o.geometry) o.geometry.dispose()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((m) => m.dispose && m.dispose())
          }
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!model) return null
  return <primitive object={model} />
}

const ArmViewer3D = forwardRef(function ArmViewer3D({ joints }, ref) {
  const controlsRef = useRef(null)
  const [loaded, setLoaded] = useState(false)
  const [error,  setError]  = useState(null)

  // Joint angles for the on-canvas readout. Caller-provided `joints`
  // wins (degrees array); otherwise pull from the Zustand store
  // (positions in radians) and convert. The store is updated by the
  // WebSocket broadcast at 25 Hz, which is faster and cheaper than
  // polling /api/state — and avoids the j1/.../j6 shape mismatch the
  // /api/state response doesn't have.
  const storePositions = useStore((s) => s.joints?.positions)
  let liveJointsDeg
  if (joints && joints.length >= 6) {
    liveJointsDeg = joints
  } else if (storePositions && storePositions.length >= 6) {
    liveJointsDeg = storePositions.slice(0, 6).map((rad) => (rad || 0) * 180 / Math.PI)
  } else {
    liveJointsDeg = [0, 0, 0, 0, 0, 0]
  }

  const applyPreset = (name) => {
    const pos = PRESETS[name] ?? PRESETS.iso
    const c = controlsRef.current
    if (!c) return
    c.object.position.set(pos[0], pos[1], pos[2])
    c.target.set(0, 1, 0)
    c.update()
  }

  // Expose imperative camera-preset API so View3DLayout's external
  // preset row can drive the viewer without prop-drilling.
  useImperativeHandle(ref, () => ({
    setCameraPreset(name) { applyPreset(name) },
  }))

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#fafafa' }}>
      <Canvas camera={{ position: PRESETS.iso, fov: 45 }} gl={{ antialias: true }}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 10, 5]}  intensity={0.9} />
        <directionalLight position={[-5, 5, -5]} intensity={0.4} />
        <pointLight       position={[0, 3, 0]}   intensity={0.3} />
        <RobotModel onLoaded={() => setLoaded(true)} onError={setError} />
        <OrbitControls
          ref={controlsRef}
          enablePan enableZoom
          target={[0, 1, 0]}
          minDistance={0.5}
          maxDistance={8}
        />
        <gridHelper args={[4, 20, '#cccccc', '#e5e5e5']} />
      </Canvas>

      {/* Joint readout, top-right */}
      <div style={{
        position: 'absolute', top: 8, right: 8, padding: '8px 12px',
        background: 'rgba(255,255,255,0.95)', borderRadius: 8, fontSize: 12,
        fontFamily: 'var(--font-mono, monospace)', color: '#374151', zIndex: 10,
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
      }}>
        {['J1', 'J2', 'J3', 'J4', 'J5', 'J6'].map((name, i) => (
          <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ fontWeight: 600, color: JOINT_COLORS[i] }}>{name}</span>
            <span>{(liveJointsDeg[i] || 0).toFixed(1)}°</span>
          </div>
        ))}
      </div>

      {/* Camera presets, top-left */}
      <div style={{
        position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4, zIndex: 10,
      }}>
        {[
          { label: 'Front', key: 'front' },
          { label: 'Side',  key: 'side'  },
          { label: 'Top',   key: 'top'   },
          { label: 'Iso',   key: 'iso'   },
        ].map((p) => (
          <button
            key={p.key}
            onClick={() => applyPreset(p.key)}
            style={{
              padding: '4px 10px', fontSize: 10, fontWeight: 600,
              background: 'rgba(255,255,255,0.92)', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Status bottom-left — error or loading */}
      {error && (
        <div style={{
          position: 'absolute', bottom: 10, left: 10,
          background: '#fef2f2', border: '1px solid #DC2626',
          color: '#b91c1c', padding: '4px 8px', borderRadius: 4, fontSize: 10,
        }}>
          {error}
        </div>
      )}
      {!loaded && !error && (
        <div style={{
          position: 'absolute', bottom: 10, left: 10,
          background: 'rgba(255,255,255,0.92)', border: '1px solid #e5e7eb',
          color: '#6b7280', padding: '4px 8px', borderRadius: 4, fontSize: 10,
        }}>
          Loading robot model…
        </div>
      )}
    </div>
  )
})

export default ArmViewer3D

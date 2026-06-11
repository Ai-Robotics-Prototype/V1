import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

// Loads the custom gripper GLB attached to the currently-loaded
// program and renders it parented to the (currently stationary)
// flange origin. -0.05m on Z places it just below where tool0 sits
// in the existing camera frame (origin at y=1 in this scene because
// OrbitControls targets [0, 1, 0]). When the URDF returns we can
// parent this group to the actual flange link.
function CustomGripperModel({ url }) {
  const [scene, setScene] = useState(null)
  useEffect(() => {
    if (!url) { setScene(null); return }
    let cancelled = false
    const loader = new GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        if (cancelled) return
        const root = gltf.scene
        // Apply the parts-viewer style material to every mesh so the
        // gripper renders with the metallic grey look the operator
        // already associates with parts in the library.
        const mat = new THREE.MeshStandardMaterial({
          color: '#A8B0C0', metalness: 0.5, roughness: 0.35,
        })
        root.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = true } })
        // Normalise size and centre the model on its own origin.
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        const scale = 0.2 / maxDim
        root.position.sub(center).multiplyScalar(scale)
        root.scale.setScalar(scale)
        setScene(root)
      },
      undefined,
      () => { if (!cancelled) setScene(null) },
    )
    return () => { cancelled = true }
  }, [url])
  if (!scene) return null
  return (
    // Park at the flange origin. y=1 matches the OrbitControls target
    // (the scene's notional flange height); z offset is the spec's
    // -0.05 m below tool0 along the tool axis.
    <group position={[0, 1, -0.05]}>
      <primitive object={scene} />
    </group>
  )
}

// ---------------------------------------------------------------------------
// ArmViewer3D — empty 3D workspace.
//
// The robot mesh has been removed pending an Estun-supplied URDF —
// the static GLB approach worked visually but offered no articulation,
// and the link-split articulated attempt produced a disjointed model
// because the part-to-link mapping can't be done reliably without
// measuring joint axes against the real arm.
//
// What's left: a clean 3D scene with grid, lights, orbit controls,
// camera presets, and the joint-angle readout. When the URDF arrives,
// drop the robot back in here.
// ---------------------------------------------------------------------------

const JOINT_COLORS = ['#3B82F6', '#16A34A', '#CA8A04', '#DC2626', '#9333EA', '#F97316']

// Camera presets — chosen for an empty ~2-unit scene with the
// origin on the ground plane. Tweak when the model returns.
const PRESETS = {
  front: [0, 1.2, 3],
  side:  [3, 1.2, 0],
  top:   [0, 4, 0.01],
  iso:   [2, 1.5, 2],
}

const ArmViewer3D = forwardRef(function ArmViewer3D({ joints, children, overlay }, ref) {
  const controlsRef = useRef(null)

  // Joint readout. Caller-provided `joints` prop wins (degrees array);
  // otherwise pull from the Zustand store (positions in radians) and
  // convert. The store is fed by the 25 Hz WebSocket broadcast — no
  // /api/state polling needed.
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

  // Imperative API for View3DLayout's external camera-preset row.
  useImperativeHandle(ref, () => ({
    setCameraPreset(name) { applyPreset(name) },
  }))

  // Custom gripper attached to the loaded program (if any). The
  // viewer hides the GLB block entirely when the program either has
  // no gripper config or uses a non-custom (finger / vacuum) gripper.
  const currentProgram = useStore((s) => s.currentProgram)
  const gripperCfg     = currentProgram?.config?.gripper || {}
  const gripperType    = gripperCfg.gripper_type || gripperCfg.type || null
  const gripperGlbUrl  = gripperType === 'custom' && gripperCfg.gripper_model_id
    ? (gripperCfg.gripper_glb_url || `/grippers/glb/${gripperCfg.gripper_model_id}.glb`)
    : null
  const gripperName    = gripperCfg.gripper_name || gripperCfg.name || ''

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#fafafa' }}>
      <Canvas camera={{ position: PRESETS.iso, fov: 45 }} gl={{ antialias: true }}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 10, 5]}  intensity={0.9} />
        <directionalLight position={[-5, 5, -5]} intensity={0.4} />
        <pointLight       position={[0, 3, 0]}   intensity={0.3} />
        <OrbitControls
          ref={controlsRef}
          enablePan enableZoom
          target={[0, 1, 0]}
          minDistance={0.5}
          maxDistance={8}
        />
        <gridHelper args={[4, 20, '#cccccc', '#e5e5e5']} />
        <CustomGripperModel url={gripperGlbUrl} />
        {children}
      </Canvas>
      {overlay}

      {/* Label below the viewer when a custom gripper is loaded. */}
      {gripperGlbUrl && (
        <div style={{
          position: 'absolute', bottom: 8, left: 8,
          padding: '6px 12px', borderRadius: 8,
          background: 'rgba(255,255,255,0.95)',
          border: '1px solid #e5e7eb',
          fontSize: 12, color: '#374151', fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)', zIndex: 10,
        }}>
          Custom Gripper: {gripperName || '(unnamed)'}
        </div>
      )}

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
    </div>
  )
})

export default ArmViewer3D

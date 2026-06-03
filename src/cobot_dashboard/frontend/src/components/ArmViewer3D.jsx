import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import URDFLoader from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const URDF_URL = '/robot_model/ur5e.urdf'
const JOINT_ORDER = [
  'shoulder_pan_joint', 'shoulder_lift_joint', 'elbow_joint',
  'wrist_1_joint',      'wrist_2_joint',       'wrist_3_joint',
]
const SMOOTH = 0.15
const DEG = (r) => ((r * 180) / Math.PI).toFixed(1)

// URDFRobot: loads the URDF once, then advances joint values toward the
// store's `joints.positions` every frame with a simple low-pass filter.
function URDFRobot({ onLoaded, onError }) {
  const robotRef = useRef(null)
  const { scene } = useThree()
  const targetRef = useRef([0, -Math.PI / 2, 0, -Math.PI / 2, 0, 0])

  // Keep the latest desired joint angles in a ref so useFrame doesn't
  // need to subscribe to every Zustand change.
  const positions = useStore((s) => s.joints?.positions)
  useEffect(() => {
    if (positions && positions.length >= 6) {
      targetRef.current = positions.slice(0, 6).map((v) => v || 0)
    }
  }, [positions])

  useEffect(() => {
    const loader = new URDFLoader()
    // Force every mesh ref (.stl after our URDF rewrite) through the
    // STLLoader — the urdf-loader default works but being explicit
    // dodges the case where a future URDF accidentally references .dae
    // again and silently fails.
    loader.loadMeshCb = (path, manager, done) => {
      const stl = new STLLoader(manager)
      stl.load(
        path,
        (geom) => {
          geom.computeVertexNormals()
          const mat = new THREE.MeshStandardMaterial({
            color: 0xbac3cf, metalness: 0.35, roughness: 0.55,
          })
          const mesh = new THREE.Mesh(geom, mat)
          mesh.castShadow = true
          mesh.receiveShadow = true
          done(mesh)
        },
        undefined,
        (err) => done(null, err),
      )
    }

    let disposed = false
    let robot = null
    loader.load(
      URDF_URL,
      (r) => {
        if (disposed) return
        robot = r
        robotRef.current = r
        // URDF Z-up -> three.js Y-up
        r.rotation.x = -Math.PI / 2
        // Apply initial joint values so the first frame isn't at zero
        JOINT_ORDER.forEach((name, i) => {
          const j = r.joints[name]
          if (j) j.setJointValue(targetRef.current[i] || 0)
        })
        scene.add(r)
        onLoaded && onLoaded()
      },
    )
    // urdf-loader's .load doesn't take an error callback — surface
    // a manual fetch check so we know if the URDF itself is missing.
    fetch(URDF_URL, { method: 'HEAD' }).then((res) => {
      if (!res.ok && onError) onError(`URDF HTTP ${res.status}`)
    }).catch((e) => onError && onError(`URDF fetch failed: ${e.message}`))

    return () => {
      disposed = true
      if (robot) {
        scene.remove(robot)
        robot.traverse((o) => {
          if (o.geometry) o.geometry.dispose()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((m) => m.dispose && m.dispose())
          }
        })
      }
    }
  }, [scene])

  useFrame(() => {
    const r = robotRef.current
    if (!r) return
    for (let i = 0; i < JOINT_ORDER.length; i++) {
      const j = r.joints[JOINT_ORDER[i]]
      if (!j) continue
      const cur = j.angle || 0
      const tgt = targetRef.current[i] || 0
      const next = cur + (tgt - cur) * SMOOTH
      j.setJointValue(next)
    }
  })

  return null
}

function CameraPreset({ preset }) {
  const { camera } = useThree()
  useEffect(() => {
    const presets = {
      front: [0, 0.6, 1.6],
      side:  [1.6, 0.6, 0],
      top:   [0, 2.0, 0.001],
      iso:   [1.2, 1.0, 1.4],
    }
    const pos = presets[preset] ?? presets.iso
    camera.position.set(...pos)
    camera.lookAt(0, 0.4, 0)
  }, [preset, camera])
  return null
}

function JointReadout() {
  const positions = useStore((s) => s.joints?.positions)
  const names = useStore((s) => s.joints?.names)
  const list = names && names.length ? names : ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']
  return (
    <div style={{
      position: 'absolute', top: 10, left: 10,
      background: 'rgba(255,255,255,0.92)',
      border: '1px solid #e5e7eb',
      borderRadius: 6, padding: '6px 10px',
      fontSize: 10, fontFamily: 'var(--font-mono)',
      color: '#374151', width: 140,
    }}>
      {list.map((name, i) => (
        <div key={name + i} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#2563EB', fontWeight: 600 }}>{name}</span>
          <span style={{ color: '#111' }}>{DEG(positions?.[i] || 0)}°</span>
        </div>
      ))}
    </div>
  )
}

const ArmViewer3D = forwardRef(function ArmViewer3D(props, ref) {
  const [preset, setPreset] = useState('iso')
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useImperativeHandle(ref, () => ({
    setCameraPreset(name) { setPreset(name) },
  }))

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#FFFFFF' }}>
      <Canvas
        camera={{ position: [1.2, 1.0, 1.4], fov: 45 }}
        shadows
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#FFFFFF']} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 6, 3]} intensity={1.0} castShadow />
        <directionalLight position={[-3, 4, -3]} intensity={0.4} />

        <gridHelper args={[3, 30, '#d1d5db', '#e5e7eb']} />

        {/* Shadow catcher */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
          <planeGeometry args={[3, 3]} />
          <shadowMaterial opacity={0.3} />
        </mesh>

        <URDFRobot
          onLoaded={() => setLoaded(true)}
          onError={(e) => setError(e)}
        />

        <CameraPreset preset={preset} />
        <OrbitControls
          target={[0, 0.4, 0]}
          enableDamping dampingFactor={0.08}
          minDistance={0.5} maxDistance={4}
        />
      </Canvas>

      <JointReadout />

      <div style={{
        position: 'absolute', top: 10, right: 10, display: 'flex', gap: 2,
        background: 'rgba(255,255,255,0.92)', borderRadius: 6, padding: 3,
        border: '1px solid #e5e7eb',
      }}>
        {['Front', 'Side', 'Top', 'Iso'].map((p) => (
          <button
            key={p}
            onClick={() => setPreset(p.toLowerCase())}
            style={{
              background: preset === p.toLowerCase() ? '#eff6ff' : 'transparent',
              color:      preset === p.toLowerCase() ? '#2563EB' : '#6b7280',
              border: 'none', padding: '3px 9px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            }}
          >
            {p}
          </button>
        ))}
      </div>

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

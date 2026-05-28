import {
  useRef, useEffect, useState, useMemo, forwardRef, useImperativeHandle, Suspense,
} from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const URDF_JSON_URL = '/robot_model/ur5e_kinematic.json'
const HOME = [0, -Math.PI / 2, 0, -Math.PI / 2, 0, 0]
const LERP_FACTOR = 0.08
const DEG = (r) => ((r * 180) / Math.PI).toFixed(1)
const lerp = (a, b, t) => a + (b - a) * t

// ── helpers ────────────────────────────────────────────────────────

// Compose T_origin * R_origin * R(axis, angle) into one Matrix4.
const _vAxis = new THREE.Vector3()
const _eRpy  = new THREE.Euler()
const _mT    = new THREE.Matrix4()
const _mR    = new THREE.Matrix4()
const _mA    = new THREE.Matrix4()
function composeJointMatrix(xyz, rpy, axis, angle, out) {
  _mT.makeTranslation(xyz[0], xyz[1], xyz[2])
  _eRpy.set(rpy[0], rpy[1], rpy[2], 'XYZ')
  _mR.makeRotationFromEuler(_eRpy)
  _vAxis.set(axis[0], axis[1], axis[2]).normalize()
  _mA.makeRotationAxis(_vAxis, angle)
  out.identity().multiply(_mT).multiply(_mR).multiply(_mA)
}

// ── mesh + tree primitives ─────────────────────────────────────────

function LinkMesh({ url, xyz, rpy }) {
  // drei caches by URL, so loading the same link mesh many times is cheap.
  const gltf = useGLTF(url)
  // Clone the scene so multiple instances don't share matrices.
  const scene = useMemo(() => gltf.scene.clone(true), [gltf])
  return <primitive object={scene} position={xyz} rotation={rpy} />
}

function JointGroup({ joint, jointIndex, currentRef, children }) {
  const ref = useRef()
  useFrame(() => {
    if (!ref.current) return
    const angle = jointIndex >= 0 ? (currentRef.current[jointIndex] || 0) : 0
    composeJointMatrix(joint.origin_xyz, joint.origin_rpy, joint.axis,
                       angle, ref.current.matrix)
  })
  // Set initial matrix once so the first render isn't a flash at identity.
  useEffect(() => {
    if (!ref.current) return
    composeJointMatrix(joint.origin_xyz, joint.origin_rpy, joint.axis, 0,
                       ref.current.matrix)
    ref.current.matrixAutoUpdate = false
  }, [joint])
  return <group ref={ref}>{children}</group>
}

function buildLinkTree(linkName, urdf, linksByName, jointsByParent, currentRef) {
  const link = linksByName.get(linkName)
  const children = (jointsByParent.get(linkName) || []).map((joint) => {
    const jointIndex = urdf.joint_order.indexOf(joint.name)
    return (
      <JointGroup
        key={joint.name}
        joint={joint}
        jointIndex={joint.type === 'fixed' ? -1 : jointIndex}
        currentRef={currentRef}
      >
        {buildLinkTree(joint.child, urdf, linksByName, jointsByParent, currentRef)}
      </JointGroup>
    )
  })
  return (
    <group key={`L:${linkName}`}>
      {link && link.mesh && (
        <Suspense fallback={null}>
          <LinkMesh url={link.mesh} xyz={link.visual_xyz} rpy={link.visual_rpy} />
        </Suspense>
      )}
      {children}
    </group>
  )
}

// ── arm root ───────────────────────────────────────────────────────

function URDFArm({ urdf, currentRef }) {
  const { linksByName, jointsByParent } = useMemo(() => {
    const lbn = new Map(urdf.links.map((l) => [l.name, l]))
    const jbp = new Map()
    for (const j of urdf.joints) {
      if (!jbp.has(j.parent)) jbp.set(j.parent, [])
      jbp.get(j.parent).push(j)
    }
    return { linksByName: lbn, jointsByParent: jbp }
  }, [urdf])

  // URDF: Z-up, X-forward, Y-left. three.js: Y-up. Rotate -90° about X.
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {buildLinkTree(urdf.root_link, urdf, linksByName, jointsByParent, currentRef)}
    </group>
  )
}

// ── lerp + overlays (carryover) ───────────────────────────────────

function AngleLerper({ currentRef, targetRef }) {
  useFrame(() => {
    const cur = currentRef.current
    const tgt = targetRef.current
    for (let i = 0; i < 6; i++) cur[i] = lerp(cur[i], tgt[i], LERP_FACTOR)
  })
  return null
}

function CameraPreset({ preset }) {
  const { camera } = useThree()
  useEffect(() => {
    const presets = {
      front: [0, 0.5, 1.4],
      side:  [1.4, 0.5, 0],
      top:   [0, 1.8, 0.001],
      iso:   [0.8, 0.8, 1.1],
    }
    const pos = presets[preset] ?? presets.iso
    camera.position.set(...pos)
    camera.lookAt(0, 0.4, 0)
  }, [preset, camera])
  return null
}

function JointTable({ currentRef, names }) {
  const [angles, setAngles] = useState(new Array(6).fill(0))
  useEffect(() => {
    const id = setInterval(() => setAngles([...currentRef.current]), 100)
    return () => clearInterval(id)
  }, [currentRef])
  return (
    <Html position={[-0.05, 1.0, 0]} style={{ pointerEvents: 'none' }}>
      <div style={{
        background: 'rgba(10,10,14,0.85)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: '#9A9A9E',
        width: 132,
      }}>
        {names.map((n, i) => (
          <div key={n} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <span style={{ color: '#3B82F6' }}>{n}</span>
            <span style={{ color: '#E8E8EA' }}>{DEG(angles[i])}°</span>
          </div>
        ))}
      </div>
    </Html>
  )
}

// Placeholder while urdf JSON loads (or if it failed).
function ArmPlaceholder() {
  return (
    <group position={[0, 0.4, 0]}>
      <mesh>
        <cylinderGeometry args={[0.06, 0.08, 0.8, 16]} />
        <meshStandardMaterial color="#444" />
      </mesh>
    </group>
  )
}

// ── scene + wrapper ───────────────────────────────────────────────

function Scene({ urdf, currentRef, targetRef, preset, jointNames }) {
  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight position={[2, 4, 2]} intensity={1.0} castShadow />
      <directionalLight position={[-2, 2, -2]} intensity={0.3} />
      <gridHelper args={[2, 10, '#1A1A1E', '#141416']} position={[0, 0, 0]} />
      <mesh position={[0, 0.5, 0]}>
        <sphereGeometry args={[0.85, 16, 16]} />
        <meshBasicMaterial color="#3B82F6" wireframe transparent opacity={0.04} />
      </mesh>

      {urdf
        ? <URDFArm urdf={urdf} currentRef={currentRef} />
        : <ArmPlaceholder />
      }

      <AngleLerper currentRef={currentRef} targetRef={targetRef} />
      <JointTable currentRef={currentRef} names={jointNames} />
      <CameraPreset preset={preset} />
      <OrbitControls
        target={[0, 0.4, 0]}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.4}
        maxDistance={3}
      />
    </>
  )
}

const ArmViewer3D = forwardRef(function ArmViewer3D(props, ref) {
  const positions = useStore((s) => s.joints.positions)
  const names     = useStore((s) => s.joints.names)

  const currentRef = useRef([...HOME])
  const targetRef  = useRef([...HOME])
  const [preset, setPreset] = useState('iso')
  const [urdf, setUrdf]     = useState(null)
  const [urdfError, setUrdfError] = useState(null)

  // Load the kinematic JSON once.
  useEffect(() => {
    let alive = true
    fetch(URDF_JSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!alive) return
        setUrdf(data)
        // Preload GLBs so the first render doesn't pop.
        for (const link of data.links) {
          if (link.mesh) {
            try { useGLTF.preload(link.mesh) } catch (_) {}
          }
        }
      })
      .catch((e) => alive && setUrdfError(e.message))
    return () => { alive = false }
  }, [])

  useEffect(() => { targetRef.current = [...positions] }, [positions])

  useImperativeHandle(ref, () => ({
    setCameraPreset(name) { setPreset(name) },
  }))

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#09090c' }}>
      <Canvas
        camera={{ position: [0.8, 0.8, 1.1], fov: 50 }}
        shadows
        gl={{ antialias: true }}
      >
        <Scene
          urdf={urdf}
          currentRef={currentRef}
          targetRef={targetRef}
          preset={preset}
          jointNames={names}
        />
      </Canvas>

      <div style={{
        position: 'absolute', top: 10, right: 10, display: 'flex', gap: 2,
        background: 'rgba(10,10,14,0.85)', borderRadius: 6, padding: 3,
        border: '1px solid var(--border)',
      }}>
        {['Front', 'Side', 'Top', 'Iso'].map((p) => (
          <button
            key={p}
            onClick={() => setPreset(p.toLowerCase())}
            style={{
              background: preset === p.toLowerCase() ? 'var(--bg-hover)' : 'transparent',
              color: preset === p.toLowerCase() ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: 'none', padding: '3px 9px', borderRadius: 4, fontSize: 11,
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {urdfError && (
        <div style={{
          position: 'absolute', bottom: 10, left: 10,
          background: 'rgba(220,38,38,0.18)', border: '1px solid #DC2626',
          color: '#FECACA', padding: '4px 8px', borderRadius: 4, fontSize: 10,
        }}>
          URDF load failed: {urdfError}
        </div>
      )}
    </div>
  )
})

export default ArmViewer3D

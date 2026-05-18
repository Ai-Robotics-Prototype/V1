import { useRef, useEffect, forwardRef, useImperativeHandle, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const HOME     = [0, -Math.PI / 2, 0, -Math.PI / 2, 0, 0]
const DEG      = (r) => ((r * 180) / Math.PI).toFixed(1)

const JOINT_COLOR = '#3B82F6'
const LINK_COLOR  = '#1C1C1E'
const BASE_COLOR  = '#2A2A2E'

// Smooth lerp factor per frame at 60 fps
const LERP_FACTOR = 0.08

function lerp(a, b, t) {
  return a + (b - a) * t
}

// Kinematic chain with 6 nested groups
function ArmModel({ currentRef, gripperOpenRef }) {
  const j1Ref = useRef()
  const j2Ref = useRef()
  const j3Ref = useRef()
  const j4Ref = useRef()
  const j5Ref = useRef()
  const j6Ref = useRef()
  const lf1Ref = useRef()
  const lf2Ref = useRef()

  useFrame(() => {
    const cur = currentRef.current
    if (j1Ref.current) j1Ref.current.rotation.y  = cur[0]
    if (j2Ref.current) j2Ref.current.rotation.z  = cur[1]
    if (j3Ref.current) j3Ref.current.rotation.z  = cur[2]
    if (j4Ref.current) j4Ref.current.rotation.x  = cur[3]
    if (j5Ref.current) j5Ref.current.rotation.z  = cur[4]
    if (j6Ref.current) j6Ref.current.rotation.x  = cur[5]

    // Gripper fingers spread
    const spread = (gripperOpenRef.current / 85) * 0.04
    if (lf1Ref.current) lf1Ref.current.position.x =  spread
    if (lf2Ref.current) lf2Ref.current.position.x = -spread
  })

  const jointMat  = <meshStandardMaterial color={JOINT_COLOR} roughness={0.4} metalness={0.6} />
  const linkMat   = <meshStandardMaterial color={LINK_COLOR}  roughness={0.5} metalness={0.5} />
  const baseMat   = <meshStandardMaterial color={BASE_COLOR}  roughness={0.5} metalness={0.4} />

  return (
    <group position={[0, 0.03, 0]}>
      {/* Base */}
      <mesh>
        <cylinderGeometry args={[0.08, 0.09, 0.06, 24]} />
        {baseMat}
      </mesh>

      {/* J1 — rotates around Y */}
      <group ref={j1Ref} position={[0, 0.03, 0]}>
        {/* J1 sphere */}
        <mesh>
          <sphereGeometry args={[0.04, 12, 12]} />
          {jointMat}
        </mesh>

        {/* Link 1 */}
        <mesh position={[0, 0.14, 0]}>
          <cylinderGeometry args={[0.03, 0.035, 0.28, 12]} />
          {linkMat}
        </mesh>

        {/* J2 — rotates around Z */}
        <group ref={j2Ref} position={[0, 0.28, 0]}>
          <mesh>
            <sphereGeometry args={[0.038, 12, 12]} />
            {jointMat}
          </mesh>

          {/* Link 2 */}
          <mesh position={[0, 0.125, 0]}>
            <cylinderGeometry args={[0.028, 0.03, 0.25, 12]} />
            {linkMat}
          </mesh>

          {/* J3 — rotates around Z */}
          <group ref={j3Ref} position={[0, 0.25, 0]}>
            <mesh>
              <sphereGeometry args={[0.033, 12, 12]} />
              {jointMat}
            </mesh>

            {/* Link 3 */}
            <mesh position={[0, 0.10, 0]}>
              <cylinderGeometry args={[0.025, 0.028, 0.20, 12]} />
              {linkMat}
            </mesh>

            {/* J4 — rotates around X */}
            <group ref={j4Ref} position={[0, 0.20, 0]}>
              <mesh>
                <sphereGeometry args={[0.030, 12, 12]} />
                {jointMat}
              </mesh>

              {/* Link 4 */}
              <mesh position={[0, 0.085, 0]}>
                <cylinderGeometry args={[0.022, 0.025, 0.17, 12]} />
                {linkMat}
              </mesh>

              {/* J5 — rotates around Z */}
              <group ref={j5Ref} position={[0, 0.17, 0]}>
                <mesh>
                  <sphereGeometry args={[0.027, 12, 12]} />
                  {jointMat}
                </mesh>

                {/* Link 5 */}
                <mesh position={[0, 0.065, 0]}>
                  <cylinderGeometry args={[0.02, 0.022, 0.13, 12]} />
                  {linkMat}
                </mesh>

                {/* J6 — rotates around X */}
                <group ref={j6Ref} position={[0, 0.13, 0]}>
                  <mesh>
                    <sphereGeometry args={[0.024, 12, 12]} />
                    {jointMat}
                  </mesh>

                  {/* Gripper mount */}
                  <mesh position={[0, 0.04, 0]}>
                    <boxGeometry args={[0.07, 0.03, 0.04]} />
                    <meshStandardMaterial color="#333340" />
                  </mesh>

                  {/* Finger 1 */}
                  <mesh ref={lf1Ref} position={[0.025, 0.065, 0]}>
                    <boxGeometry args={[0.012, 0.05, 0.012]} />
                    <meshStandardMaterial color="#555560" />
                  </mesh>

                  {/* Finger 2 */}
                  <mesh ref={lf2Ref} position={[-0.025, 0.065, 0]}>
                    <boxGeometry args={[0.012, 0.05, 0.012]} />
                    <meshStandardMaterial color="#555560" />
                  </mesh>

                  {/* TCP sphere */}
                  <mesh position={[0, 0.095, 0]}>
                    <sphereGeometry args={[0.015, 8, 8]} />
                    <meshStandardMaterial color="#EF4444" emissive="#EF4444" emissiveIntensity={0.5} />
                  </mesh>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  )
}

// Lerp angles and update ref
function AngleLerper({ currentRef, targetRef }) {
  useFrame(() => {
    const cur = currentRef.current
    const tgt = targetRef.current
    for (let i = 0; i < 6; i++) {
      cur[i] = lerp(cur[i], tgt[i], LERP_FACTOR)
    }
  })
  return null
}

// Camera preset controller
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
    camera.lookAt(0, 0.5, 0)
  }, [preset, camera])
  return null
}

// Overlay: joint table
function JointTable({ currentRef, names }) {
  const [angles, setAngles] = useState(new Array(6).fill(0))

  useEffect(() => {
    const id = setInterval(() => {
      setAngles([...currentRef.current])
    }, 100)
    return () => clearInterval(id)
  }, [currentRef])

  return (
    <Html position={[-0.05, 1.2, 0]} style={{ pointerEvents: 'none' }}>
      <div style={{
        background: 'rgba(10,10,14,0.85)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: '#9A9A9E',
        width: 120,
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

function Scene({ currentRef, targetRef, gripperOpenRef, preset, jointNames }) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 4, 2]} intensity={1.0} castShadow />
      <directionalLight position={[-2, 2, -2]} intensity={0.3} />

      {/* Floor grid */}
      <gridHelper args={[2, 10, '#1A1A1E', '#141416']} position={[0, 0, 0]} />

      {/* Workspace wireframe sphere */}
      <mesh position={[0, 0.5, 0]}>
        <sphereGeometry args={[0.85, 16, 16]} />
        <meshBasicMaterial color="#3B82F6" wireframe transparent opacity={0.04} />
      </mesh>

      {/* Arm */}
      <ArmModel currentRef={currentRef} gripperOpenRef={gripperOpenRef} />

      {/* Lerper — no visual output */}
      <AngleLerper currentRef={currentRef} targetRef={targetRef} />

      {/* Joint table overlay */}
      <JointTable currentRef={currentRef} names={jointNames} />

      <CameraPreset preset={preset} />
      <OrbitControls
        target={[0, 0.5, 0]}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.4}
        maxDistance={3}
      />
    </>
  )
}

const ArmViewer3D = forwardRef(function ArmViewer3D(props, ref) {
  const positions  = useStore((s) => s.joints.positions)
  const names      = useStore((s) => s.joints.names)
  const gripperMm  = useStore((s) => s.gripper.position_mm)

  const currentRef    = useRef([...HOME])
  const targetRef     = useRef([...HOME])
  const gripperRef    = useRef(gripperMm)

  const [preset, setPreset] = useState('iso')

  // Update target from store
  useEffect(() => {
    targetRef.current = [...positions]
  }, [positions])

  useEffect(() => {
    gripperRef.current = gripperMm
  }, [gripperMm])

  // Expose setCameraPreset to parent
  useImperativeHandle(ref, () => ({
    setCameraPreset(name) {
      setPreset(name)
    },
  }))

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#09090c' }}>
      <Canvas
        camera={{ position: [0.8, 0.8, 1.1], fov: 50 }}
        shadows
        gl={{ antialias: true }}
      >
        <Scene
          currentRef={currentRef}
          targetRef={targetRef}
          gripperOpenRef={gripperRef}
          preset={preset}
          jointNames={names}
        />
      </Canvas>

      {/* Camera preset buttons */}
      <div style={{
        position: 'absolute',
        top: 10,
        right: 10,
        display: 'flex',
        gap: 2,
        background: 'rgba(10,10,14,0.85)',
        borderRadius: 6,
        padding: 3,
        border: '1px solid var(--border)',
      }}>
        {['Front', 'Side', 'Top', 'Iso'].map((p) => (
          <button
            key={p}
            onClick={() => setPreset(p.toLowerCase())}
            style={{
              background: preset === p.toLowerCase() ? 'var(--bg-hover)' : 'transparent',
              color: preset === p.toLowerCase() ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: 'none',
              padding: '3px 9px',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
})

export default ArmViewer3D

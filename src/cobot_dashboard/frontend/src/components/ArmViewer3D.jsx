import { useRef, useState, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

// ── Camera preset positions ────────────────────────────────────────────────────
const CAM_PRESETS = {
  front: { pos: [0.15, 0.3,  1.3],  tgt: [0.15, 0.15, 0] },
  side:  { pos: [1.3,  0.3,  0.15], tgt: [0.15, 0.15, 0] },
  top:   { pos: [0.15, 1.6,  0.01], tgt: [0.15, 0.15, 0] },
  iso:   { pos: [0.6,  0.5,  0.9],  tgt: [0.15, 0.15, 0] },
}

// ── Material factory ──────────────────────────────────────────────────────────
function useArmMaterials() {
  return useMemo(() => ({
    jointMat: <meshStandardMaterial color="#2563EB" roughness={0.3} metalness={0.6}
      emissive="#1d4ed8" emissiveIntensity={0.15} />,
    linkMat:  <meshStandardMaterial color="#d4d4d8" roughness={0.4} metalness={0.3} />,
    baseMat:  <meshStandardMaterial color="#1a1a1e" roughness={0.5} metalness={0.4} />,
  }), [])
}

// ── Safety zone ring (pulsing when active) ────────────────────────────────────
function SafetyRing({ radius, color, activeZone, zoneName }) {
  const matRef = useRef()
  useFrame(() => {
    if (!matRef.current) return
    if (activeZone === zoneName) {
      matRef.current.opacity = 0.5 + 0.4 * Math.sin(Date.now() * 0.003)
    } else {
      matRef.current.opacity = 0.5
    }
  })
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
      <torusGeometry args={[radius, 0.005, 8, 64]} />
      <meshBasicMaterial ref={matRef} color={color} transparent opacity={0.5}
        side={THREE.DoubleSide} />
    </mesh>
  )
}

// ── Animated arm ──────────────────────────────────────────────────────────────
function RobotArm() {
  const joints  = useStore((s) => s.joints)
  const gripper = useStore((s) => s.gripper)
  const safety  = useStore((s) => s.safety)
  const { jointMat, linkMat, baseMat } = useArmMaterials()

  // Group refs for each joint + gripper fingers
  const j1Ref  = useRef()
  const j2Ref  = useRef()
  const j3Ref  = useRef()
  const j4Ref  = useRef()
  const j5Ref  = useRef()
  const j6Ref  = useRef()
  const lf1Ref = useRef()
  const lf2Ref = useRef()

  // Smoothed current angles
  const cur = useRef([0, -1.5708, 0, -1.5708, 0, 0])

  useFrame(() => {
    const tgt = joints.positions
    for (let i = 0; i < 6; i++) {
      const d = tgt[i] - cur.current[i]
      if (Math.abs(d) > 0.0003) cur.current[i] += d * 0.10
    }

    // Apply rotations — correct DH axes per the kinematic chain
    if (j1Ref.current) j1Ref.current.rotation.y = cur.current[0]   // base swing Y
    if (j2Ref.current) j2Ref.current.rotation.z = cur.current[1]   // shoulder Z
    if (j3Ref.current) j3Ref.current.rotation.z = cur.current[2]   // elbow Z
    if (j4Ref.current) j4Ref.current.rotation.y = cur.current[3]   // wrist1 roll Y (FIX 3)
    if (j5Ref.current) j5Ref.current.rotation.z = cur.current[4]   // wrist2 pitch Z
    if (j6Ref.current) j6Ref.current.rotation.y = cur.current[5]   // wrist3 roll Y (FIX 3)

    // Gripper fingers spread along Y (FIX 3)
    const spread = gripper.state === 'open' ? 0.025 : 0.004
    if (lf1Ref.current) lf1Ref.current.position.y =  spread
    if (lf2Ref.current) lf2Ref.current.position.y = -spread
  })

  return (
    <group>
      {/* Safety zone rings */}
      <SafetyRing radius={1.2} color="#22C55E" activeZone={safety.zone} zoneName="GREEN"  />
      <SafetyRing radius={0.6} color="#EAB308" activeZone={safety.zone} zoneName="YELLOW" />
      <SafetyRing radius={0.3} color="#EF4444" activeZone={safety.zone} zoneName="RED"    />

      {/* Floor shadow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <circleGeometry args={[0.12, 32]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} />
      </mesh>

      {/* Base pedestal */}
      <mesh position={[0, 0.14, 0]}>
        <cylinderGeometry args={[0.09, 0.10, 0.28, 32]} />
        {baseMat}
      </mesh>

      {/* ── J1 — base rotation around Y ────────────────────────────────── */}
      <group ref={j1Ref}>

        {/* J1 joint sphere at top of base */}
        <mesh position={[0, 0.28, 0]}>
          <sphereGeometry args={[0.048, 20, 16]} />
          {jointMat}
        </mesh>

        {/* ── J2 — shoulder, rotates around Z ─────────────────────────── */}
        <group ref={j2Ref} position={[0, 0.28, 0]}>
          <mesh>
            <sphereGeometry args={[0.038, 16, 16]} />
            {jointMat}
          </mesh>

          {/* Upper arm — extends along X so J2 Z-rotation swings it */}
          <mesh position={[0.125, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
            <cylinderGeometry args={[0.028, 0.030, 0.25, 12]} />
            {linkMat}
          </mesh>

          {/* ── J3 — elbow, rotates around Z ───────────────────────────── */}
          <group ref={j3Ref} position={[0.25, 0, 0]}>
            <mesh>
              <sphereGeometry args={[0.033, 16, 16]} />
              {jointMat}
            </mesh>

            {/* Forearm — along X */}
            <mesh position={[0.10, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
              <cylinderGeometry args={[0.025, 0.028, 0.20, 12]} />
              {linkMat}
            </mesh>

            {/* ── J4 — wrist1, rotates around Y (roll) ────────────────── */}
            <group ref={j4Ref} position={[0.20, 0, 0]}>
              <mesh>
                <sphereGeometry args={[0.030, 16, 16]} />
                {jointMat}
              </mesh>

              {/* Wrist link 1 — along X */}
              <mesh position={[0.07, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
                <cylinderGeometry args={[0.022, 0.025, 0.14, 12]} />
                {linkMat}
              </mesh>

              {/* ── J5 — wrist2, rotates around Z (pitch) ────────────── */}
              <group ref={j5Ref} position={[0.14, 0, 0]}>
                <mesh>
                  <sphereGeometry args={[0.027, 16, 16]} />
                  {jointMat}
                </mesh>

                {/* Wrist link 2 — along X */}
                <mesh position={[0.055, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
                  <cylinderGeometry args={[0.020, 0.022, 0.11, 12]} />
                  {linkMat}
                </mesh>

                {/* ── J6 — wrist3, rotates around Y (roll) ─────────────── */}
                <group ref={j6Ref} position={[0.11, 0, 0]}>
                  <mesh>
                    <sphereGeometry args={[0.024, 16, 16]} />
                    {jointMat}
                  </mesh>

                  {/* Tool flange */}
                  <mesh position={[0.03, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
                    <cylinderGeometry args={[0.035, 0.035, 0.03, 16]} />
                    <meshStandardMaterial color="#333340" roughness={0.3} metalness={0.7} />
                  </mesh>

                  {/* Gripper body */}
                  <mesh position={[0.055, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
                    <boxGeometry args={[0.04, 0.07, 0.04]} />
                    <meshStandardMaterial color="#2a2a30" />
                  </mesh>

                  {/* Finger 1 — position.y animated in useFrame */}
                  <mesh ref={lf1Ref} position={[0.075, 0.025, 0]}>
                    <boxGeometry args={[0.05, 0.012, 0.012]} />
                    <meshStandardMaterial color="#555560" />
                  </mesh>

                  {/* Finger 2 — position.y animated in useFrame */}
                  <mesh ref={lf2Ref} position={[0.075, -0.025, 0]}>
                    <boxGeometry args={[0.05, 0.012, 0.012]} />
                    <meshStandardMaterial color="#555560" />
                  </mesh>

                  {/* TCP sphere */}
                  <mesh position={[0.105, 0, 0]}>
                    <sphereGeometry args={[0.015, 8, 8]} />
                    <meshStandardMaterial
                      color="#EF4444" emissive="#EF4444" emissiveIntensity={0.5} />
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

// ── Camera preset controller ──────────────────────────────────────────────────
function CameraController({ preset }) {
  const { camera, controls } = useThree((s) => ({ camera: s.camera, controls: s.controls }))
  if (preset && camera) {
    const p = CAM_PRESETS[preset]
    if (p) {
      camera.position.set(...p.pos)
      if (controls) controls.target.set(...p.tgt)
    }
  }
  return null
}

// ── Joint angle overlay (HTML) ────────────────────────────────────────────────
function JointOverlay() {
  const joints = useStore((s) => s.joints)
  const gripper = useStore((s) => s.gripper)

  const RANGES = [180, 180, 135, 180, 120, 360]
  const degs   = joints.positions.map((r) => r * 180 / Math.PI)

  return (
    <div style={{
      position: 'absolute', bottom: 8, left: 8, zIndex: 10,
      background: 'rgba(10,10,14,.82)', backdropFilter: 'blur(6px)',
      border: '1px solid rgba(255,255,255,.09)',
      borderRadius: 6, padding: '6px 9px', fontSize: 10,
      fontFamily: 'monospace', color: 'rgba(220,220,230,.9)',
      pointerEvents: 'none',
    }}>
      <div style={{ fontSize: 9, color: 'rgba(150,150,165,.9)', marginBottom: 4,
        textTransform: 'uppercase', letterSpacing: '.05em' }}>
        Joint Angles
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {degs.map((d, i) => {
            const pct = Math.min(100, Math.abs(d) / RANGES[i] * 100)
            const barColor = pct > 75 ? '#F59E0B' : '#3b82f6'
            return (
              <tr key={i}>
                <td style={{ padding: '1px 4px 1px 0', fontWeight: 700 }}>J{i+1}</td>
                <td style={{ padding: '1px 0', width: 50, textAlign: 'right' }}>
                  {d.toFixed(1)}°
                </td>
                <td style={{ padding: '1px 0 1px 6px' }}>
                  <div style={{ width: 56, height: 3,
                    background: 'rgba(255,255,255,.1)', borderRadius: 2 }}>
                    <div style={{ width: `${pct}%`, height: '100%',
                      background: barColor, borderRadius: 2 }} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: gripper.state === 'open' ? '#22C55E' : '#EF4444',
        }} />
        <span style={{ color: gripper.state === 'open' ? '#22C55E' : '#EF4444' }}>
          Gripper: {gripper.state === 'open' ? 'Open' : 'Closed'}
        </span>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function ArmViewer3D() {
  const [activePreset, setActivePreset] = useState(null)

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '8px 13px', borderBottom: '1px solid var(--bd)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--tm)' }}>
          3D Robot Viewer
        </span>
        <div id="fps-lbl" style={{ fontSize: 10, color: 'var(--tm)' }} />
      </div>

      {/* Canvas + overlays */}
      <div style={{ flex: 1, position: 'relative', minHeight: 200 }}>
        {/* Camera preset buttons */}
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 10,
          display: 'flex', gap: 3, pointerEvents: 'auto',
        }}>
          {Object.keys(CAM_PRESETS).map((p) => (
            <button key={p} onClick={() => setActivePreset(p)} style={{
              padding: '3px 8px', fontSize: 9, fontWeight: 700, borderRadius: 4,
              border: '1px solid rgba(255,255,255,.15)',
              background: 'rgba(15,15,20,.78)', color: 'rgba(200,200,215,.9)',
              cursor: 'pointer', textTransform: 'capitalize',
            }}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>

        <JointOverlay />

        <Canvas
          camera={{ position: [0.6, 0.5, 0.9], fov: 55, near: 0.01, far: 50 }}
          style={{ background: '#111114' }}
          gl={{ antialias: true, powerPreference: 'default' }}
        >
          {/* Lights */}
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 6, 4]} intensity={1.2} castShadow />
          <directionalLight position={[-2, 3, -2]} intensity={0.4} />

          {/* Floor */}
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.9, 48]} />
            <meshStandardMaterial color="#0f0f12" metalness={0.1} />
          </mesh>
          <Grid
            position={[0, 0.001, 0]}
            args={[2, 2]}
            cellSize={0.2}
            sectionSize={1}
            cellColor="#1e1e24"
            sectionColor="#1e1e24"
            fadeDistance={3}
            infiniteGrid={false}
          />

          <RobotArm />

          <OrbitControls
            makeDefault
            target={[0.15, 0.15, 0]}
            enableDamping
            dampingFactor={0.07}
            minDistance={0.4}
            maxDistance={3.0}
            maxPolarAngle={Math.PI * 0.85}
          />

          {activePreset && (
            <CameraController
              preset={activePreset}
              onDone={() => setActivePreset(null)}
            />
          )}
        </Canvas>
      </div>
    </div>
  )
}

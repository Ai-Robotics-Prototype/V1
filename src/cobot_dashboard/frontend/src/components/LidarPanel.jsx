import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../store'
import { useState } from 'react'

// Height-based colour: blue(low)→green→yellow→red(high)
function heightColor(z, zMin = -0.1, zMax = 0.9) {
  const t = Math.max(0, Math.min(1, (z - zMin) / (zMax - zMin)))
  if (t < 0.33) {
    const f = t / 0.33
    return new THREE.Color(0, f, 1 - f)
  } else if (t < 0.66) {
    const f = (t - 0.33) / 0.33
    return new THREE.Color(f, 1, 0)
  } else {
    const f = (t - 0.66) / 0.34
    return new THREE.Color(1, 1 - f, 0)
  }
}

function PointCloud() {
  const { lidarPoints } = useStore()
  const ref = useRef()

  const { positions, colors } = useMemo(() => {
    const pts = lidarPoints
    const positions = new Float32Array(pts.length * 3)
    const colors    = new Float32Array(pts.length * 3)
    pts.forEach((p, i) => {
      positions[i*3]   = p.x
      positions[i*3+1] = p.z  // z-up → y-up in Three.js
      positions[i*3+2] = p.y
      const c = heightColor(p.z)
      colors[i*3]   = c.r
      colors[i*3+1] = c.g
      colors[i*3+2] = c.b
    })
    return { positions, colors }
  }, [lidarPoints])

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color"    args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.02} vertexColors sizeAttenuation />
    </points>
  )
}

function SafetyRings({ zone }) {
  const rings = [
    { r: 1.2, color: '#00C47A', opacity: 0.06 },
    { r: 0.6, color: '#F5A623', opacity: 0.10 },
    { r: 0.3, color: '#FF3B3B', opacity: 0.18 },
  ]
  const activeR = zone === 'RED' ? 0.3 : zone === 'YELLOW' ? 0.6 : null

  return (
    <>
      {rings.map(({ r, color, opacity }) => (
        <mesh key={r} position={[0, 0.01, 0]} rotation={[-Math.PI/2, 0, 0]}>
          <ringGeometry args={[r - 0.015, r, 64]} />
          <meshBasicMaterial
            color={color}
            opacity={activeR === r ? opacity * 3 : opacity}
            transparent side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </>
  )
}

function RobotMarker() {
  return (
    <mesh position={[0, 0.45, 0]}>
      <cylinderGeometry args={[0.15, 0.15, 0.9, 16]} />
      <meshStandardMaterial color="#555" />
    </mesh>
  )
}

function Scene({ topView }) {
  const { robotState } = useStore()
  const zone = robotState?.safety?.zone ?? 'GREEN'
  const { camera } = useThree()

  useEffect(() => {
    if (topView) {
      camera.position.set(0, 6, 0)
      camera.lookAt(0, 0, 0)
    } else {
      camera.position.set(0, 3, 4)
      camera.lookAt(0, 0, 0)
    }
  }, [topView, camera])

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 4, 2]} intensity={0.8} />
      <Grid
        args={[4, 4]}
        cellSize={0.2} cellThickness={0.4}
        cellColor="#242428" sectionColor="#2A2A2E"
        sectionSize={1} position={[0, 0, 0]}
      />
      <SafetyRings zone={zone} />
      <RobotMarker />
      <PointCloud />
      <OrbitControls enableDamping dampingFactor={0.08} makeDefault />
    </>
  )
}

export default function LidarPanel() {
  const { lidarWsStatus } = useStore()
  const [topView, setTopView] = useState(false)
  const offline = lidarWsStatus === 'disconnected'

  return (
    <div style={styles.wrap}>
      <Canvas camera={{ position: [0, 3, 4], fov: 50 }}>
        <Scene topView={topView} />
      </Canvas>

      {offline && (
        <div style={styles.offline}>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>LiDAR offline</span>
        </div>
      )}

      <div style={styles.toggle}>
        {['3D', 'Top'].map(v => (
          <button
            key={v}
            onClick={() => setTopView(v === 'Top')}
            style={{
              ...styles.toggleBtn,
              ...(topView === (v === 'Top') ? styles.toggleActive : {}),
            }}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}

const styles = {
  wrap: { position:'relative', width:'100%', height:'100%', background:'#0A0A0B' },
  offline: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',
  },
  toggle: {
    position: 'absolute', top: 10, right: 10,
    display: 'flex', gap: 2,
    background: 'rgba(20,20,22,0.8)',
    borderRadius: 6, padding: 3,
  },
  toggleBtn: {
    background: 'transparent', color: 'var(--text-secondary)',
    padding: '3px 10px', borderRadius: 4, fontSize: 12,
  },
  toggleActive: {
    background: 'var(--bg-hover)', color: 'var(--text-primary)',
  },
}

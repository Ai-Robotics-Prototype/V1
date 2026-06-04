import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

// ---------------------------------------------------------------------------
// Asset URLs. The dashboard serves /robot/* from the active robot model
// directory (/opt/cobot/models/robot -> models/robots/<robot_id>/).
// ---------------------------------------------------------------------------

const LINKS_JSON_URL  = '/robot/links.json'
const LINK_FILE_BASE  = '/robot/links/'
// Order matters: lite first, full second, STL last-ditch.
const STATIC_GLB_URLS = ['/robot/model_lite.glb', '/robot/model.glb']
const STATIC_STL_URL  = '/robot/model.stl'

const SMOOTH = 0.15
const DEG = (r) => ((r * 180) / Math.PI).toFixed(1)

function applyMetallicMaterial(root) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.material = new THREE.MeshStandardMaterial({
        color: '#B0B8C8', metalness: 0.6, roughness: 0.3,
      })
      child.castShadow = true
      child.receiveShadow = true
    }
  })
}

// ---------------------------------------------------------------------------
// ArticulatedRobot — builds the kinematic chain from links.json.
//
// Each link's GLB has been pre-translated so its parent joint sits at
// the mesh-local origin (see scripts/split_robot_links.py). That means
// every link group rotates around (0,0,0), and the joint offset is
// carried purely by the group's `position` in its parent's frame.
//
// On every frame we slew each joint group's rotation toward the
// store's joints.positions[ji] value with a low-pass filter — the
// same approach the old URDFRobot used.
// ---------------------------------------------------------------------------

function ArticulatedRobot({ links, onLoaded, onError }) {
  const { scene } = useThree()
  const rootRef     = useRef(null)
  const groupsRef   = useRef({})
  const targetsRef  = useRef([0, 0, 0, 0, 0, 0])

  // Keep the latest desired angles in a ref so useFrame doesn't have
  // to subscribe to every Zustand change.
  const positions = useStore((s) => s.joints?.positions)
  useEffect(() => {
    if (positions && positions.length >= 6) {
      targetsRef.current = positions.slice(0, 6).map((v) => v || 0)
    }
  }, [positions])

  useEffect(() => {
    let disposed = false
    const loader = new GLTFLoader()

    const loadOne = (link) => new Promise((resolve) => {
      const file = link.file_lite || link.file
      if (!file) {
        resolve({ link, mesh: null })
        return
      }
      loader.load(
        LINK_FILE_BASE + file,
        (gltf) => resolve({ link, mesh: gltf.scene }),
        undefined,
        (err) => {
          console.warn(`Link ${link.name} load failed`, err)
          resolve({ link, mesh: null })
        },
      )
    })

    Promise.all(links.map(loadOne)).then((entries) => {
      if (disposed) return
      const groups = {}

      // First pass: create groups, position them at their joint
      // offset in the parent's frame.
      entries.forEach(({ link }) => {
        const g = new THREE.Group()
        g.name = link.name
        const o = link.joint_origin || [0, 0, 0]
        g.position.set(o[0], o[1], o[2])
        g.userData = {
          axis:       link.joint_axis || [0, 0, 0],
          jointIndex: link.joint_index,
        }
        groups[link.name] = g
      })

      // Second pass: attach meshes, wire parent/child.
      entries.forEach(({ link, mesh }) => {
        const g = groups[link.name]
        if (mesh) {
          applyMetallicMaterial(mesh)
          g.add(mesh)
        }
        if (link.parent && groups[link.parent]) {
          groups[link.parent].add(g)
        } else {
          // The split GLBs came out of trimesh which preserves the
          // STEP file's Z-up convention. three.js renders Y-up, so
          // wrap the root in a parent group that applies the
          // classic -90° X rotation — same correction the previous
          // URDFRobot used on the UR5e model.
          const worldWrap = new THREE.Group()
          worldWrap.rotation.x = -Math.PI / 2
          worldWrap.add(g)
          rootRef.current = worldWrap
          scene.add(worldWrap)
        }
      })

      groupsRef.current = groups
      onLoaded && onLoaded()
    }).catch((e) => {
      if (!disposed && onError) onError(`Articulated load failed: ${e?.message || e}`)
    })

    return () => {
      disposed = true
      if (rootRef.current) {
        scene.remove(rootRef.current)
        rootRef.current.traverse((o) => {
          if (o.geometry) o.geometry.dispose()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((m) => m.dispose && m.dispose())
          }
        })
      }
      rootRef.current   = null
      groupsRef.current = {}
    }
  }, [scene, links])

  useFrame(() => {
    const groups = groupsRef.current
    if (!groups) return
    Object.values(groups).forEach((g) => {
      const ji   = g.userData?.jointIndex
      const axis = g.userData?.axis
      if (typeof ji !== 'number' || ji < 0 || ji > 5) return
      if (!axis) return
      // Dominant component picks the Euler axis. Axis sign carries
      // direction (e.g. [0,-1,0] flips J1's rotation).
      const ax = Math.abs(axis[0]), ay = Math.abs(axis[1]), az = Math.abs(axis[2])
      let prop, dir
      if (ax >= ay && ax >= az) { prop = 'x'; dir = axis[0] >= 0 ? 1 : -1 }
      else if (ay >= az)        { prop = 'y'; dir = axis[1] >= 0 ? 1 : -1 }
      else                      { prop = 'z'; dir = axis[2] >= 0 ? 1 : -1 }
      const target = dir * (targetsRef.current[ji] || 0)
      const cur    = g.rotation[prop]
      g.rotation[prop] = cur + (target - cur) * SMOOTH
    })
  })

  return null
}

// ---------------------------------------------------------------------------
// StaticRobotModel — fallback when links.json is missing. Loads the
// monolithic GLB (lite first, full second, STL last). No articulation.
// ---------------------------------------------------------------------------

function StaticRobotModel({ onLoaded, onError }) {
  const { scene } = useThree()
  const rootRef = useRef(null)

  useEffect(() => {
    let disposed = false
    let model = null

    const fit = (root) => {
      const box  = new THREE.Box3().setFromObject(root)
      const size = box.getSize(new THREE.Vector3())
      const ctr  = box.getCenter(new THREE.Vector3())
      root.position.sub(ctr)
      const maxDim = Math.max(size.x, size.y, size.z)
      if (maxDim > 0) root.scale.multiplyScalar(2.0 / maxDim)
    }

    const onSuccess = (root) => {
      if (disposed) return
      applyMetallicMaterial(root)
      // Same Z-up -> Y-up correction the ArticulatedRobot applies.
      const wrap = new THREE.Group()
      wrap.rotation.x = -Math.PI / 2
      wrap.add(root)
      fit(wrap)
      model = wrap
      rootRef.current = model
      scene.add(model)
      onLoaded && onLoaded()
    }

    const tryStl = () => {
      console.warn('All GLBs failed, trying STL (last resort, ~240 MB)')
      const stl = new STLLoader()
      stl.load(
        STATIC_STL_URL,
        (geom) => {
          geom.computeVertexNormals()
          const mesh = new THREE.Mesh(
            geom,
            new THREE.MeshStandardMaterial({
              color: '#B0B8C8', metalness: 0.6, roughness: 0.3,
            }),
          )
          const wrap = new THREE.Group()
          wrap.add(mesh)
          onSuccess(wrap)
        },
        undefined,
        (e) => { if (!disposed && onError) onError(`GLB+STL load failed: ${e?.message || e}`) },
      )
    }

    const tryGlbCascade = (idx) => {
      if (idx >= STATIC_GLB_URLS.length) return tryStl()
      const url = STATIC_GLB_URLS[idx]
      const loader = new GLTFLoader()
      loader.load(
        url,
        (gltf) => onSuccess(gltf.scene),
        undefined,
        (err) => {
          if (disposed) return
          console.warn(`GLB load failed (${url}):`, err)
          tryGlbCascade(idx + 1)
        },
      )
    }

    tryGlbCascade(0)

    return () => {
      disposed = true
      if (model) {
        scene.remove(model)
        model.traverse((o) => {
          if (o.geometry) o.geometry.dispose()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((m) => m.dispose && m.dispose())
          }
        })
      }
    }
  }, [scene])

  return null
}

// ---------------------------------------------------------------------------
// Camera + readout widgets
// ---------------------------------------------------------------------------

function CameraPreset({ preset }) {
  const { camera } = useThree()
  useEffect(() => {
    const presets = {
      front: [0,   0.9, 2.4],
      side:  [2.4, 0.9, 0],
      top:   [0,   3.0, 0.001],
      iso:   [1.5, 1.2, 1.8],
    }
    const pos = presets[preset] ?? presets.iso
    camera.position.set(...pos)
    camera.lookAt(0, 0.8, 0)
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

// ---------------------------------------------------------------------------
// ArmViewer3D — top-level. Probes /robot/links.json:
//   - 200 with body → mount ArticulatedRobot (S10-140 kinematic chain)
//   - 404 / network error → mount StaticRobotModel (monolithic GLB)
// ---------------------------------------------------------------------------

const ArmViewer3D = forwardRef(function ArmViewer3D(props, ref) {
  const [preset, setPreset] = useState('iso')
  const [error,  setError]  = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [mode,   setMode]   = useState('probing')
  const [linksData, setLinksData] = useState(null)

  useEffect(() => {
    let alive = true
    fetch(LINKS_JSON_URL)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((data) => {
        if (!alive) return
        if (!data?.links || !Array.isArray(data.links) || data.links.length === 0) {
          setMode('static')
          return
        }
        setLinksData(data)
        setMode('articulated')
      })
      .catch(() => { if (alive) setMode('static') })
    return () => { alive = false }
  }, [])

  useImperativeHandle(ref, () => ({
    setCameraPreset(name) { setPreset(name) },
  }))

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#FFFFFF' }}>
      <Canvas
        camera={{ position: [1.5, 1.2, 1.8], fov: 45 }}
        shadows
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#FFFFFF']} />
        {/* Environment map gives metallic surfaces something to
            reflect. Without it, MeshStandardMaterial(metalness=0.6)
            reads as nearly black because metals don't scatter
            diffuse light. The 'warehouse' preset is neutral white-
            grey and renders well on a light background. */}
        <Environment preset="warehouse" background={false} />
        <ambientLight intensity={0.45} />
        <directionalLight position={[3, 6, 3]} intensity={0.8} castShadow />
        <directionalLight position={[-3, 4, -3]} intensity={0.3} />

        <gridHelper args={[3, 30, '#d1d5db', '#e5e7eb']} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
          <planeGeometry args={[3, 3]} />
          <shadowMaterial opacity={0.3} />
        </mesh>

        {mode === 'articulated' && linksData && (
          <ArticulatedRobot
            links={linksData.links}
            onLoaded={() => setLoaded(true)}
            onError={(e) => setError(e)}
          />
        )}
        {mode === 'static' && (
          <StaticRobotModel
            onLoaded={() => setLoaded(true)}
            onError={(e) => setError(e)}
          />
        )}

        <CameraPreset preset={preset} />
        <OrbitControls
          target={[0, 0.8, 0]}
          enableDamping dampingFactor={0.08}
          minDistance={0.5} maxDistance={6}
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
          {mode === 'probing' ? 'Probing model…'
           : mode === 'articulated' ? 'Loading articulated robot…'
           : 'Loading static model…'}
        </div>
      )}
    </div>
  )
})

export default ArmViewer3D

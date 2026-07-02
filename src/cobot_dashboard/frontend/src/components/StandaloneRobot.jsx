import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import URDFLoader from 'urdf-loader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

const JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

// StandaloneRobot — self-contained URDF loader intended for the 3D View
// tab's LiDAR scene. Mount as a child of a react-three-fiber <Canvas>.
//
// Loads /robot/urdf via URDFLoader with a GLTFLoader mesh callback (same
// pattern as ArmViewer3D's URDFArm, verified working on the standalone
// robot_test.html page). The URDF is Y-up native so we apply NO rotation;
// the robot base sits at world origin, which is also the LiDAR frame
// origin per cell configuration.
//
// Joint animation: mirrors s.joints.positions from the shared store onto
// robot.joints.joint_1..joint_6 via setJointValue. Store values are
// radians (server default is now all zeros = URDF export pose; real
// /joint_states from the driver replace these). A 25 Hz lerp keeps the
// arm visually responsive to /ws/state without triggering React renders.
export default function StandaloneRobot() {
  const { scene } = useThree()
  const robotRef   = useRef(null)
  const targetsRef = useRef([0, 0, 0, 0, 0, 0])
  const currentRef = useRef([0, 0, 0, 0, 0, 0])

  const storePositions = useStore((s) => s.joints?.positions)

  useEffect(() => {
    if (Array.isArray(storePositions) && storePositions.length >= 6) {
      targetsRef.current = storePositions
        .slice(0, 6)
        .map((v) => (Number.isFinite(v) ? Number(v) : 0))
    }
  }, [storePositions])

  useEffect(() => {
    let cancelled = false
    let attached  = null

    const loader = new URDFLoader()
    loader.parseVisual    = true
    loader.parseCollision = false

    // Material swap MUST happen inside loadMeshCb (per-mesh, before
    // done()) — the meshes are only guaranteed to exist here. Any later
    // traverse over the URDF root fires before per-link GLB fetches
    // resolve, so it silently no-ops.
    //
    // The GLB meshes ship with MeshStandardMaterial metalness≈1, which
    // without an environment map renders as flat dark grey — same bug as
    // the earlier static-model saga. Replacing with Phong bypasses that.
    loader.loadMeshCb = (path, manager, done) => {
      new GLTFLoader(manager).load(
        path,
        (gltf) => {
          gltf.scene.traverse((c) => {
            if (c.isMesh) {
              c.material = new THREE.MeshPhongMaterial({
                color: 0xd8dce2, specular: 0x444444, shininess: 30,
                side: THREE.DoubleSide,
              })
              // Decimation to 18.3k tris can leave stale / faceted
              // normals — recompute so Phong shading reads smooth.
              c.geometry.computeVertexNormals()
            }
          })
          done(gltf.scene)
        },
        undefined,
        (e) => {
          // eslint-disable-next-line no-console
          console.error('[3dview] mesh fail', path, e)
          done(new THREE.Object3D())
        },
      )
    }

    loader.load(
      '/robot/urdf',
      (robot) => {
        if (cancelled) return
        // Y-up URDF (see file header) — no rotation applied. If the
        // arm ever renders on its side, try `robot.rotation.x = -Math.PI/2`
        // (Z-up input) or `+Math.PI/2` (opposite handedness).
        scene.add(robot)
        attached = robot
        robotRef.current = robot
        let n = 0
        robot.traverse((c) => { if (c.isMesh) n += 1 })
        // eslint-disable-next-line no-console
        console.log(`[3dview] loaded ${n} meshes`)
      },
      undefined,
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[3dview] URDF load failed:', err)
      },
    )

    return () => {
      cancelled = true
      if (attached && attached.parent) attached.parent.remove(attached)
      robotRef.current = null
    }
    // Load once for the lifetime of this component; parent re-renders
    // must not re-trigger the URDF fetch (matches URDFArm's contract).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      const robot = robotRef.current
      if (!robot || !robot.joints) return
      const tgt = targetsRef.current
      const cur = currentRef.current
      for (let i = 0; i < 6; i++) {
        const t = tgt[i] || 0
        cur[i] = cur[i] + (t - cur[i]) * 0.3
        const j = robot.joints[JOINT_NAMES[i]]
        if (j && typeof j.setJointValue === 'function') {
          j.setJointValue(cur[i])
        }
      }
    }, 40)
    return () => clearInterval(id)
  }, [])

  // Lights ride with the robot so this component is self-contained on
  // any Canvas that mounts it (the 3D View / LiDAR scene has no lights
  // of its own — the LiDAR points and zone wireframes are unlit
  // materials so these lights are invisible to them).
  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight position={[3, 5, 4]}  intensity={1.1} />
      <directionalLight position={[-3, 2, -2]} intensity={0.4} />
    </>
  )
}

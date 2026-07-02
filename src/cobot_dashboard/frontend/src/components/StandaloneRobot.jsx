import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment'
import URDFLoader from 'urdf-loader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'

// Shared DRACOLoader — registered once for the app lifetime. The
// per-link GLBs shipped today are not Draco-compressed but future
// exports may be, and registering unconditionally is cheap; the
// wasm/js pair lives at /draco/ on the served static dir.
const DRACO = new DRACOLoader()
DRACO.setDecoderPath('/draco/')

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
  const { scene, gl } = useThree()
  const robotRef   = useRef(null)
  const targetsRef = useRef([0, 0, 0, 0, 0, 0])
  const currentRef = useRef([0, 0, 0, 0, 0, 0])

  // Environment map — PMREM of RoomEnvironment. Even though the current
  // baked GLB material is metalness=0, the reflection contribution kills
  // the "flat gray" look on curved surfaces (§71 Issue 2). Sets scene.environment
  // so any surviving MeshStandardMaterial (baked or otherwise) shades correctly.
  useEffect(() => {
    if (!gl || !scene) return undefined
    const pmrem = new THREE.PMREMGenerator(gl)
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    const prev  = scene.environment
    scene.environment = envRT.texture
    return () => {
      scene.environment = prev
      envRT.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])

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

    // Do NOT override the GLB's baked material — the exported PBR
    // (metallicFactor 0, roughnessFactor 0.18, white) is what the model
    // was designed to look like; the scene.environment (PMREM of
    // RoomEnvironment, set above) + HemisphereLight (in the JSX) give
    // it correct shading. Only backstop meshes that were exported
    // without any material.
    //
    // Also register the shared Draco decoder — no-op for the current
    // (non-Draco) GLBs, harmless for future compressed exports.
    loader.loadMeshCb = (path, manager, done) => {
      const gltf = new GLTFLoader(manager)
      gltf.setDRACOLoader(DRACO)
      gltf.load(
        path,
        (g) => {
          g.scene.traverse((c) => {
            if (c.isMesh) {
              if (!c.material) {
                c.material = new THREE.MeshStandardMaterial({
                  color: 0xd8dce2, roughness: 0.5, metalness: 0.0,
                })
              }
              // Decimated meshes sometimes ship faceted normals;
              // recompute so PBR shading reads smooth.
              if (c.geometry && !c.geometry.attributes.normal) {
                c.geometry.computeVertexNormals()
              }
            }
          })
          done(g.scene)
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
  // any Canvas that mounts it. Hemisphere (sky/ground bounce) is what
  // separates a PBR robot from "flat gray" — the two prior directionals
  // alone left the underside black. Ambient stays low to keep contrast.
  // LiDAR points and zone wireframes use unlit materials → unaffected.
  return (
    <>
      <hemisphereLight args={['#e6ecf5', '#1f2937', 0.55]} />
      <directionalLight position={[3, 5, 4]} intensity={0.9} />
      <ambientLight intensity={0.15} />
    </>
  )
}

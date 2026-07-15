import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment'
import URDFLoader from 'urdf-loader'
import * as THREE from 'three'
import { useStore } from '../store/useStore'
import { startHomeMove } from '../lib/homeAnim'
import { startJointAnimation } from '../lib/jointAnim'

// Shared DRACOLoader — registered once for the app lifetime. Twin GLBs
// are Draco-compressed now (see models/robots/estun_s10-140/links/),
// so the decoder actually runs on each mesh.
const DRACO = new DRACOLoader()
DRACO.setDecoderPath('/draco/')

// GLB byte cache across mounts. Same rationale as ArmViewer3D: keeps
// the second-tab load from re-fetching what the first tab already
// pulled. Setting it here is idempotent — ArmViewer3D sets it too.
THREE.Cache.enabled = true

const JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

// URDF axis-convention gate — mirrors ArmViewer3D. Current served URDF
// (s10-140-full) is Y-up native. Flip to 'Z' if the /robot/urdf route
// swings back to a REP-103 URDF variant.
const URDF_UP_AXIS = 'Y'  // 'Y' → no tilt · 'Z' → rotation.x = -π/2
const URDF_ROT_X   = URDF_UP_AXIS === 'Y' ? 0 : -Math.PI / 2

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
export default function StandaloneRobot({ onRobotReady } = {}) {
  const { scene, gl } = useThree()
  const robotRef   = useRef(null)
  const targetsRef = useRef([0, 0, 0, 0, 0, 0])
  const currentRef = useRef([0, 0, 0, 0, 0, 0])
  // Per-joint manual-jog override. When mask[i] is true the store→
  // targets mirror skips joint i, so the slider write is the single
  // source of truth for that joint until Reset. Other joints keep
  // tracking the store (per instruction 6 of the fix).
  const manualMaskRef = useRef([false, false, false, false, false, false])
  // Active Home animation handle (see lib/homeAnim.js).
  const homeAnimRef   = useRef(null)

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
    if (!Array.isArray(storePositions) || storePositions.length < 6) return
    const mask = manualMaskRef.current
    const t    = targetsRef.current
    // In-place mutation (not array replacement) so that
    // JointJogPanel writes to targetsRef.current[i] between mirror
    // ticks survive when mask[i] is false — and are protected
    // outright when mask[i] is true.
    for (let i = 0; i < 6; i++) {
      if (mask[i]) continue
      const v = Number(storePositions[i])
      t[i] = Number.isFinite(v) ? v : 0
    }
  }, [storePositions])

  useEffect(() => {
    let cancelled = false
    let attached  = null

    const timeLabel = '[urdf-load] StandaloneRobot /robot/urdf'
    // eslint-disable-next-line no-console
    console.time(timeLabel)

    const loader = new URDFLoader()
    // package://robot_description/links/foo.glb -> /robot/links/foo.glb
    // Required now that /robot/urdf serves the provisional URDF, which
    // references its meshes via package:// URIs.
    loader.packages       = { robot_description: '/robot' }
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
        // Axis convention gate (URDF_UP_AXIS at top). Current URDF
        // (s10-140-full) is Y-up → rotation stays 0.
        robot.rotation.x = URDF_ROT_X
        scene.add(robot)
        attached = robot
        robotRef.current = robot

        // Inject tool0 at link6 so IK / TCP readout have a stable name.
        // See ArmViewer3D URDFArm for the matching insertion.
        if (robot.links && robot.links.link6 && !robot.links.tool0) {
          const tool0 = new THREE.Object3D()
          tool0.name = 'tool0'
          robot.links.link6.add(tool0)
          robot.links.tool0 = tool0
        }

        // Same jog handle shape as URDFArm's — see ArmViewer3D.jsx.
        // Writes both targetsRef and currentRef so the 25 Hz lerp
        // below holds the slider pose instead of yanking back to the
        // store target.
        const cancelHome = () => {
          if (homeAnimRef.current) {
            homeAnimRef.current.cancel()
            homeAnimRef.current = null
          }
        }
        const jogApi = {
          robot,
          setJointRad: (idx, rad) => {
            if (idx < 0 || idx >= 6) return
            const j = robot.joints?.[JOINT_NAMES[idx]]
            if (!j || typeof j.setJointValue !== 'function') return
            cancelHome()
            manualMaskRef.current[idx] = true
            j.setJointValue(rad)
            currentRef.current[idx] = rad
            targetsRef.current[idx] = rad
          },
          resetAll: () => {
            cancelHome()
            for (let i = 0; i < 6; i++) {
              manualMaskRef.current[i] = false
              robot.joints?.[JOINT_NAMES[i]]?.setJointValue?.(0)
              currentRef.current[i] = 0
              targetsRef.current[i] = 0
            }
          },
          setJointsRad: (rads) => {
            if (!Array.isArray(rads) || rads.length < 6) return
            cancelHome()
            for (let i = 0; i < 6; i++) {
              const rad = Number(rads[i])
              if (!Number.isFinite(rad)) continue
              const j = robot.joints?.[JOINT_NAMES[i]]
              if (!j || typeof j.setJointValue !== 'function') continue
              manualMaskRef.current[i] = true
              j.setJointValue(rad)
              currentRef.current[i] = rad
              targetsRef.current[i] = rad
            }
          },
          // Smooth coordinated return to all-zeros. Same behavior as
          // URDFArm's home(); see lib/homeAnim.js for the animation.
          home: () => {
            cancelHome()
            homeAnimRef.current = startHomeMove({
              robot,
              currentRef, targetsRef, manualMaskRef,
              onComplete: () => { homeAnimRef.current = null },
            })
          },
          // Twin-only interpolated move to an arbitrary target joint
          // vector. Used by QuickOrientButtons. Masks stay latched at
          // completion so the twin holds at the target pose. Shares
          // the homeAnimRef slot with home() so cancels are unified.
          runJointAnimation: (q_target, durationMs) => {
            cancelHome()
            homeAnimRef.current = startJointAnimation({
              robot,
              q_target,
              duration: Number(durationMs) || 1500,
              currentRef, targetsRef, manualMaskRef,
              onComplete: () => { homeAnimRef.current = null },
            })
          },
        }
        onRobotReady?.(jogApi)

        let n = 0
        let m = 0
        robot.traverse((c) => {
          if (c.isMesh) {
            n += 1
            if (c.material) m += 1
          }
        })
        // eslint-disable-next-line no-console
        console.log(`[3dview] loaded ${n} meshes, withMaterial ${m}`)
        // eslint-disable-next-line no-console
        try { console.timeEnd(timeLabel) } catch {}
      },
      undefined,
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[3dview] URDF load failed:', err)
      },
    )

    return () => {
      cancelled = true
      if (homeAnimRef.current) {
        homeAnimRef.current.cancel()
        homeAnimRef.current = null
      }
      if (attached && attached.parent) attached.parent.remove(attached)
      robotRef.current = null
      onRobotReady?.(null)
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

  // ── Self-collision tint (Phase 3) ────────────────────────────────
  // Driver publishes {collision_pair:[a,b], collision_min_mm, warn,
  // stop, warning} in /estun/status; backend mirrors into
  // robot.collision_*. When the min-pair distance drops into the
  // warn zone we tint the two offending links amber; below stop,
  // red. On clear, restore the baked material properties. Twin URDF
  // uses short link names (link1..link6); driver's capsule YAML uses
  // long names (link1_shoulder..link6_flange) — LINK_NAME_TWIN maps
  // one to the other.
  const collisionPair    = useStore((s) => s.robot?.collision_pair)
  const collisionMinMm   = useStore((s) => s.robot?.collision_min_mm)
  const collisionWarnMm  = useStore((s) => s.robot?.collision_warn_mm) || 80
  const collisionStopMm  = useStore((s) => s.robot?.collision_stop_mm) || 30
  const tintedLinksRef = useRef({})   // { linkName: [{mesh, origEmissive, origHex}] }
  useEffect(() => {
    const LINK_NAME_TWIN = {
      base_link: 'base_link',
      link1_shoulder:  'link1', link2_upper_arm: 'link2',
      link3_forearm:   'link3', link4_wrist1:    'link4',
      link5_wrist2:    'link5', link6_flange:    'link6',
    }
    const robot = robotRef.current
    if (!robot || !robot.links) return
    // Determine tint color: below stop → red, else amber. If pair
    // is null or clearance above warn, restore (no tint).
    const shouldTint = collisionPair && Array.isArray(collisionPair)
      && collisionMinMm != null && collisionMinMm <= collisionWarnMm
    const isStopLevel = shouldTint && collisionMinMm <= collisionStopMm
    const tintHex     = isStopLevel ? 0xB91C1C : 0xD97706   // red / amber
    // Restore any previously tinted meshes that aren't in the new pair.
    const activeShort = shouldTint
      ? new Set(collisionPair.map((n) => LINK_NAME_TWIN[n]).filter(Boolean))
      : new Set()
    Object.keys(tintedLinksRef.current).forEach((linkName) => {
      if (activeShort.has(linkName)) return
      const entries = tintedLinksRef.current[linkName] || []
      entries.forEach(({ mesh, origEmissive, origHex }) => {
        if (mesh.material && mesh.material.emissive) {
          mesh.material.emissive.setHex(origHex || 0x000000)
          mesh.material.emissiveIntensity = origEmissive ?? 0
        }
      })
      delete tintedLinksRef.current[linkName]
    })
    if (!shouldTint) return
    // Apply tint to each active link's meshes.
    activeShort.forEach((linkName) => {
      const linkObj = robot.links?.[linkName]
      if (!linkObj) return
      if (tintedLinksRef.current[linkName]) {
        // Already tinted — update color in place (warn → stop transition).
        tintedLinksRef.current[linkName].forEach(({ mesh }) => {
          if (mesh.material && mesh.material.emissive) {
            mesh.material.emissive.setHex(tintHex)
            mesh.material.emissiveIntensity = 0.55
          }
        })
        return
      }
      const entries = []
      linkObj.traverse((c) => {
        if (c.isMesh && c.material && c.material.emissive) {
          entries.push({
            mesh: c,
            origHex: c.material.emissive.getHex(),
            origEmissive: c.material.emissiveIntensity ?? 0,
          })
          c.material.emissive.setHex(tintHex)
          c.material.emissiveIntensity = 0.55
        }
      })
      tintedLinksRef.current[linkName] = entries
    })
  }, [collisionPair, collisionMinMm, collisionWarnMm, collisionStopMm])

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

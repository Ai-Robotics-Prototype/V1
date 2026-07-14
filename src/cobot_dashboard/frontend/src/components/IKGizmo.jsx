import { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls'
import * as THREE from 'three'
import { ikStep } from '../lib/ik'

// IKGizmo — mounts a three.js TransformControls handle at the current
// tool0 pose and runs damped-least-squares IK toward the gizmo's target
// each frame while it's being dragged. Twin-only; the solver only
// mutates the loaded URDFRobot + writes back via jogApi.setJointsRad.
//
// Sticky-boundary drag: after ikStep clamps to joint limits, the gizmo
// target is snapped to the ACHIEVED tool FK pose. This prevents the
// gizmo from being dragged into unreachable space — it clings to the
// edge of reach instead of detaching. Position/orientation error
// between commanded and achieved lights the AT LIMIT indicator.
//
// Props:
//   jogApi        — from URDFArm or StandaloneRobot (see ArmViewer3D)
//   enabled       — bool; when false the gizmo is not mounted
//   mode          — 'translate' | 'rotate'
//   onDragChange  — (dragging: bool) => void; typically toggles OrbitControls
//   onTargetPose  — (pose: {position, quaternion, atLimit}) => void; the
//                   IKGizmo emits current pose + a limit flag each frame
//                   the drag advances so the UI can render an indicator.

// Sticky-boundary detection thresholds — tune here if the AT LIMIT
// badge flickers in normal reachable poses from DLS residual, OR if it
// fails to light near actual joint limits.
//
//   Position: 3 mm is well above the DLS-converged residual (< 0.1 mm
//   in typical reachable poses) but under a visible detach.
//   Rotation: 0.02 rad (~1.15°) is above DLS quaternion residual
//   (< 0.1° typical) but well below what feels detached.
// Raise if flickering, lower if the badge misses genuine limit-hits.
const AT_LIMIT_POS_M   = 0.003
const AT_LIMIT_ROT_RAD = 0.02

function resolveTool(robot) {
  return robot?.links?.tool0 || robot?.links?.link6 || null
}

// Reused scratch objects for the useFrame IK+snap path so we're not
// allocating three.js math each frame at ~60 Hz.
const _achievedPos  = new THREE.Vector3()
const _achievedQuat = new THREE.Quaternion()

export default function IKGizmo({ jogApi, enabled, mode = 'translate', onDragChange, onTargetPose }) {
  const { scene, camera, gl } = useThree()
  const targetRef  = useRef(null)   // proxy Object3D the gizmo manipulates
  const tcRef      = useRef(null)
  const draggingRef = useRef(false)
  const lastPos    = useRef(new THREE.Vector3(Infinity, Infinity, Infinity))
  const lastQuat   = useRef(new THREE.Quaternion(2, 2, 2, 2))

  // Stable refs for the arrow-prop callbacks. Parents typically pass
  // fresh arrows every render; if those went into the setup effect's
  // deps we'd tear the gizmo down mid-drag. Keeping identity out of
  // the setup effect is what fixes the Program-tab stutter (see the
  // Cartesian-drag stutter diagnosis).
  const onDragChangeRef  = useRef(onDragChange)
  const onTargetPoseRef  = useRef(onTargetPose)
  useEffect(() => { onDragChangeRef.current  = onDragChange  }, [onDragChange])
  useEffect(() => { onTargetPoseRef.current  = onTargetPose  }, [onTargetPose])
  // Same trick for initial mode — the setup effect wants the value at
  // mount time only; the separate mode-swap effect below handles live
  // switches without teardown.
  const initialModeRef = useRef(mode)

  useEffect(() => {
    if (!enabled) return undefined
    const robot = jogApi?.robot
    if (!robot) return undefined
    const tool = resolveTool(robot)
    if (!tool) return undefined

    // eslint-disable-next-line no-console
    console.info('[IKGizmo] setup')

    // Proxy Object3D that TransformControls will move. It sits in the
    // scene (not parented to the robot) so its world pose is what the
    // gizmo reports directly.
    const target = new THREE.Object3D()
    target.name = 'ik-target'
    tool.updateWorldMatrix(true, false)
    target.position.setFromMatrixPosition(tool.matrixWorld)
    target.quaternion.setFromRotationMatrix(tool.matrixWorld)
    target.updateMatrixWorld(true)
    scene.add(target)
    targetRef.current = target
    lastPos.current.copy(target.position)
    lastQuat.current.copy(target.quaternion)
    onTargetPoseRef.current?.({
      position: target.position.clone(),
      quaternion: target.quaternion.clone(),
    })

    const tc = new TransformControls(camera, gl.domElement)
    tc.setMode(initialModeRef.current || 'translate')
    tc.setSize(0.9)
    tc.attach(target)
    scene.add(tc)
    tcRef.current = tc

    const onDragging = (e) => {
      draggingRef.current = !!e.value
      onDragChangeRef.current?.(!!e.value)
    }
    tc.addEventListener('dragging-changed', onDragging)

    return () => {
      // eslint-disable-next-line no-console
      console.info('[IKGizmo] cleanup')
      tc.removeEventListener('dragging-changed', onDragging)
      try { tc.detach() } catch {}
      try { scene.remove(tc) } catch {}
      try { scene.remove(target) } catch {}
      try { tc.dispose?.() } catch {}
      tcRef.current = null
      targetRef.current = null
      draggingRef.current = false
      onDragChangeRef.current?.(false)
    }
    // Deliberately narrow: parent-arrow identity churn no longer
    // retriggers setup. mode is handled by the separate swap effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, jogApi, scene, camera, gl])

  // Live mode swap without tearing down the gizmo.
  useEffect(() => {
    if (tcRef.current) tcRef.current.setMode(mode)
  }, [mode])

  useFrame(() => {
    if (!enabled || !jogApi?.robot || !targetRef.current) return
    if (!draggingRef.current) return
    const target = targetRef.current
    if (
      target.position.equals(lastPos.current) &&
      target.quaternion.equals(lastQuat.current)
    ) return
    lastPos.current.copy(target.position)
    lastQuat.current.copy(target.quaternion)

    const tool = resolveTool(jogApi.robot)
    if (!tool) return
    const q = ikStep(jogApi.robot, tool, target.position, target.quaternion)
    if (q && q.length === 6 && q.every((v) => Number.isFinite(v))) {
      jogApi.setJointsRad?.(q)
    }

    // Sticky-boundary snap: read the ACHIEVED tool FK after ikStep +
    // clampToLimits ran, measure the delta vs commanded, then pin the
    // gizmo to the achieved pose. The delta powers the AT LIMIT flag.
    tool.updateWorldMatrix(true, false)
    _achievedPos.setFromMatrixPosition(tool.matrixWorld)
    _achievedQuat.setFromRotationMatrix(tool.matrixWorld)

    const posErr = _achievedPos.distanceTo(target.position)
    // Rotation error: angle between commanded and achieved quaternions.
    // dot on unit quats: 1 = aligned, -1 = double-cover of aligned;
    // |dot| = 1 either way. clamp to guard acos numerical range.
    const rotDot = Math.min(1, Math.abs(_achievedQuat.dot(target.quaternion)))
    const rotErr = 2 * Math.acos(rotDot)
    const atLimit = posErr > AT_LIMIT_POS_M || rotErr > AT_LIMIT_ROT_RAD

    target.position.copy(_achievedPos)
    target.quaternion.copy(_achievedQuat)
    target.updateMatrixWorld(true)
    // Update the no-op guard refs so the very next useFrame doesn't
    // treat our own snap as a fresh user drag.
    lastPos.current.copy(target.position)
    lastQuat.current.copy(target.quaternion)

    onTargetPoseRef.current?.({
      position: target.position.clone(),
      quaternion: target.quaternion.clone(),
      atLimit,
      posErr,
      rotErr,
    })
  })

  return null
}

// Convenience — position the target at the current tool0 pose. Called
// by parents on "Home" and after external joint writes (e.g. slider
// fine-tune) so the gizmo doesn't drift away from the arm.
export function snapTargetToTool(gizmoRef, jogApi) {
  const target = gizmoRef?.current
  const tool = resolveTool(jogApi?.robot)
  if (!target || !tool) return
  tool.updateWorldMatrix(true, false)
  target.position.setFromMatrixPosition(tool.matrixWorld)
  target.quaternion.setFromRotationMatrix(tool.matrixWorld)
  target.updateMatrixWorld(true)
}

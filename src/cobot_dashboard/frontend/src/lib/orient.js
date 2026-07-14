import * as THREE from 'three'
import { ikStep } from './ik'

// Quick-orient support: keeps current TCP position, rotates the flange
// so its APPROACH AXIS points along a chosen world direction.
// Twin-only. Uses the same damped-least-squares solver as the
// interactive IK gizmo (via ikStep), but iterates to convergence (or
// the closest reachable pose) for a one-shot solve.
//
// Bug fixed on iteration 2 (2026-07-10):
//   The first version aligned tool0's LOCAL Z to the target world
//   direction — which was wrong for THIS URDF. The verified twin
//   (s10-140-full.urdf) is Y-up native, and joint_6's axis is
//   `-1 0 0` in link5's local frame. tool0 (injected as identity
//   child of link6) inherits link6's frame; its local Z has no
//   meaningful relationship to the flange face.
//
//   The correct approach: the flange APPROACH AXIS is joint_6's
//   rotation axis (that's what "roll" means — spinning about the
//   axis you'd insert a tool along). We read joint_6.axis, transform
//   it to world via the joint's world matrix, and orient THAT to the
//   target world direction. This is URDF-convention-agnostic: it
//   works whether the URDF puts the approach on local X, Y, Z, or
//   any signed variant.
//
// Scene frame: URDF is Y-up native (URDF_UP_AXIS = 'Y' in ArmViewer3D).
// So the user-facing "world -Z / at floor" maps to scene (0, -1, 0)
// and "world +Z / ceiling" maps to scene (0, +1, 0). Face SIDE is the
// scene +X direction (labeled +X in the UI). All target-direction
// vectors below are in scene coordinates.

const JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

// Convergence targets for one-shot IK. Loosened vs the per-frame gizmo
// path because we care about the FINAL pose, not per-frame residuals.
const IK_MAX_OUTER   = 12
const IK_INNER_ITER  = 8
const CONVERGE_POS_M   = 5e-4     // 0.5 mm
const CONVERGE_ROT_RAD = 2e-3     // ~0.11°

// Scratch objects reused across calls.
const _pos    = new THREE.Vector3()
const _quat   = new THREE.Quaternion()
const _delta  = new THREE.Quaternion()
const _tmp    = new THREE.Vector3()

function readJoints(robot) {
  const q = new Array(6)
  for (let i = 0; i < 6; i++) {
    const raw = robot?.joints?.[JOINT_NAMES[i]]?.jointValue
    const v   = Array.isArray(raw) ? raw[0] : raw
    const n   = Number(v)
    q[i] = Number.isFinite(n) ? n : 0
  }
  return q
}

function writeJoints(robot, q) {
  for (let i = 0; i < 6; i++) {
    robot?.joints?.[JOINT_NAMES[i]]?.setJointValue?.(q[i])
  }
}

// Read the flange approach axis in world coordinates by transforming
// joint_6's local axis via its world matrix. This yields the CURRENT
// world direction of the roll axis (i.e., the direction the tool
// would extend from the flange face) regardless of the URDF's local-
// frame convention. Returns a unit vector.
export function readApproachWorld(robot) {
  const j6 = robot?.joints?.joint_6
  if (!j6) return new THREE.Vector3(0, 0, 1)
  j6.updateWorldMatrix(true, false)
  const local = j6.axis || new THREE.Vector3(0, 0, 1)
  const out = new THREE.Vector3().copy(local).transformDirection(j6.matrixWorld).normalize()
  return out
}

// Given the tool's current world quaternion and the CURRENT approach
// direction in world, compute the target world quaternion whose
// approach direction aligns with `targetApproachWorld`. Minimum-
// rotation (shortest angular delta) preserves flange twist about the
// target axis where possible.
export function orientApproachTo(currentQuat, currentApproachWorld, targetApproachWorld) {
  _tmp.copy(targetApproachWorld).normalize()
  _delta.setFromUnitVectors(currentApproachWorld, _tmp)
  // three.js: q1.multiply(q2) sets q1 = q1 * q2. Applied to a vector,
  // (delta * currentQuat) * v = delta * (currentQuat * v). So the
  // vector is first rotated by currentQuat, then by delta. Applied to
  // the current approach direction:  delta * currentApproach = target. ✓
  return new THREE.Quaternion().copy(_delta).multiply(currentQuat)
}

// Resolve the tool link in a URDFRobot, preferring the injected tool0.
export function resolveTool(robot) {
  return robot?.links?.tool0 || robot?.links?.link6 || null
}

// One-shot IK: iterate ikStep until the tool matrix converges within
// CONVERGE_* thresholds or IK_MAX_OUTER passes elapse. Returns the
// final joint vector. Restores the URDF to `q_start` before returning
// so the caller sees the twin unchanged — the caller decides whether
// to animate to the target or apply it directly.
export function solveIKToPose(robot, tool, targetPos, targetQuat) {
  if (!robot || !tool) return null
  const q_start = readJoints(robot)
  let q_final   = q_start.slice()
  try {
    for (let i = 0; i < IK_MAX_OUTER; i++) {
      const q = ikStep(robot, tool, targetPos, targetQuat, { maxIter: IK_INNER_ITER })
      if (!q || q.length !== 6) break
      q_final = q
      tool.updateWorldMatrix(true, false)
      _pos.setFromMatrixPosition(tool.matrixWorld)
      _quat.setFromRotationMatrix(tool.matrixWorld)
      const posErr = _pos.distanceTo(targetPos)
      const rotDot = Math.min(1, Math.abs(_quat.dot(targetQuat)))
      const rotErr = 2 * Math.acos(rotDot)
      if (posErr < CONVERGE_POS_M && rotErr < CONVERGE_ROT_RAD) break
    }
  } finally {
    writeJoints(robot, q_start)
  }
  return q_final
}

// Measure how far the achieved FK from `q` is from the requested pose.
// Applies q, reads FK, restores prior URDF state. Used to decide the
// AT LIMIT flag after solveIKToPose returns a clamped-but-not-converged
// solution.
export function measureAchievedError(robot, tool, q, targetPos, targetQuat) {
  const q_start = readJoints(robot)
  try {
    writeJoints(robot, q)
    tool.updateWorldMatrix(true, false)
    _pos.setFromMatrixPosition(tool.matrixWorld)
    _quat.setFromRotationMatrix(tool.matrixWorld)
    const posErr = _pos.distanceTo(targetPos)
    const rotDot = Math.min(1, Math.abs(_quat.dot(targetQuat)))
    const rotErr = 2 * Math.acos(rotDot)
    return { posErr, rotErr }
  } finally {
    writeJoints(robot, q_start)
  }
}

// Apply q to the URDF temporarily, read the world approach direction
// via joint_6.axis, restore. Used to log the achieved approach
// direction after the solve — the empirical check for the fix.
export function measureAchievedApproach(robot, q) {
  const q_start = readJoints(robot)
  try {
    writeJoints(robot, q)
    return readApproachWorld(robot)
  } finally {
    writeJoints(robot, q_start)
  }
}

// Snapshot the tool's current world position + quaternion.
export function readToolWorldPose(tool) {
  tool.updateWorldMatrix(true, false)
  const pos = new THREE.Vector3().setFromMatrixPosition(tool.matrixWorld)
  const quat = new THREE.Quaternion().setFromRotationMatrix(tool.matrixWorld)
  return { pos, quat }
}

import * as THREE from 'three'

// Damped-least-squares 6-DOF IK for the S10-140 twin. Analytical
// Jacobian from urdf-loader's joint world transforms; no finite
// differences. Twin-only — nothing here talks to a real driver.
//
// Pose convention: world position (m) + quaternion of the tool link.
// Joint chain fixed to joint_1..joint_6; caller passes the tool link
// object (tool0 is a child of link6 injected on URDF load).

const JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']
const N = 6

const _pos      = new THREE.Vector3()
const _axisLoc  = new THREE.Vector3()
const _axisW    = new THREE.Vector3()
const _pi       = new THREE.Vector3()
const _dp       = new THREE.Vector3()
const _linear   = new THREE.Vector3()
const _quatCur  = new THREE.Quaternion()
const _quatErr  = new THREE.Quaternion()
const _quatInv  = new THREE.Quaternion()

function readCurrentJointValues(robot) {
  const q = new Array(N)
  for (let i = 0; i < N; i++) {
    const joint = robot.joints?.[JOINT_NAMES[i]]
    const raw = joint?.jointValue
    const v = Array.isArray(raw) ? raw[0] : raw
    const n = Number(v)
    q[i] = Number.isFinite(n) ? n : 0
  }
  return q
}

function applyJointValues(robot, q) {
  for (let i = 0; i < N; i++) {
    const joint = robot.joints?.[JOINT_NAMES[i]]
    if (joint && typeof joint.setJointValue === 'function') {
      joint.setJointValue(q[i])
    }
  }
}

function clampToLimits(robot, q) {
  for (let i = 0; i < N; i++) {
    const joint = robot.joints?.[JOINT_NAMES[i]]
    const lim = joint?.limit || {}
    const lo = Number(lim.lower)
    const hi = Number(lim.upper)
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) {
      if (q[i] < lo) q[i] = lo
      else if (q[i] > hi) q[i] = hi
    }
  }
}

// Fills J (6×N array of arrays) at the current pose, and writes the
// tool link's world position + quaternion into posOut/quatOut. Assumes
// caller has just applied the current q so joint transforms are current.
function computeJacobian(robot, toolLink, J, posOut, quatOut) {
  toolLink.updateWorldMatrix(true, false)
  posOut.setFromMatrixPosition(toolLink.matrixWorld)
  quatOut.setFromRotationMatrix(toolLink.matrixWorld)

  for (let i = 0; i < N; i++) {
    const joint = robot.joints?.[JOINT_NAMES[i]]
    if (!joint) {
      for (let r = 0; r < 6; r++) J[r][i] = 0
      continue
    }
    joint.updateWorldMatrix(true, false)
    _pi.setFromMatrixPosition(joint.matrixWorld)

    // Joint axis in world space. joint.axis is a local-frame Vector3;
    // rotating a vector by a rotation that INCLUDES rotation about that
    // same vector leaves it unchanged, so it's fine to use matrixWorld's
    // rotation for transformDirection.
    _axisLoc.copy(joint.axis || { x: 0, y: 0, z: 1 })
    _axisW.copy(_axisLoc).transformDirection(joint.matrixWorld).normalize()

    _dp.subVectors(posOut, _pi)
    _linear.crossVectors(_axisW, _dp)

    J[0][i] = _linear.x
    J[1][i] = _linear.y
    J[2][i] = _linear.z
    J[3][i] = _axisW.x
    J[4][i] = _axisW.y
    J[5][i] = _axisW.z
  }
}

// In-place Gauss elimination with partial pivoting. Solves A x = b for
// an n×n A (destroyed) and length-n b, returns x (length n) or null on
// singular (should be rare given the damping term).
function solveLinear(A, b) {
  const n = b.length
  for (let i = 0; i < n; i++) {
    let maxRow = i
    let maxVal = Math.abs(A[i][i])
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(A[k][i])
      if (v > maxVal) { maxVal = v; maxRow = k }
    }
    if (maxRow !== i) {
      const tmpRow = A[i]; A[i] = A[maxRow]; A[maxRow] = tmpRow
      const tmpB   = b[i]; b[i] = b[maxRow]; b[maxRow] = tmpB
    }
    if (Math.abs(A[i][i]) < 1e-14) return null
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i]
      if (f === 0) continue
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j]
      b[k] -= f * b[i]
    }
  }
  const x = new Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]
    x[i] = s / A[i][i]
  }
  return x
}

// One frame's worth of IK. Iterates up to maxIter times toward
// (targetPos, targetQuat), applying joint updates to the URDF as it
// goes (needed to update the Jacobian each iteration). Returns the
// final joint vector, always finite; on any NaN or singular solve the
// starting q is restored and returned. Never diverges.
export function ikStep(robot, toolLink, targetPos, targetQuat, opts = {}) {
  const {
    maxIter      = 5,
    lambda       = 0.05,   // DLS damping
    maxPosStep   = 0.05,   // m per iteration (linear)
    maxRotStep   = 0.20,   // rad per iteration (angular)
    convergePos  = 1e-4,   // m
    convergeRot  = 1e-3,   // rad
  } = opts

  if (!robot || !toolLink) return null

  const q_start = readCurrentJointValues(robot)
  let q = q_start.slice()

  const J    = [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ]
  const A    = [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ]
  const err  = new Array(6)

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      computeJacobian(robot, toolLink, J, _pos, _quatCur)

      // Position error, clamped to maxPosStep magnitude.
      let ex = targetPos.x - _pos.x
      let ey = targetPos.y - _pos.y
      let ez = targetPos.z - _pos.z
      const posMag = Math.hypot(ex, ey, ez)
      if (posMag > maxPosStep) {
        const s = maxPosStep / posMag
        ex *= s; ey *= s; ez *= s
      }

      // Orientation error via error quaternion → rotation vector.
      _quatInv.copy(_quatCur).invert()
      _quatErr.copy(targetQuat).multiply(_quatInv)
      if (_quatErr.w < 0) {
        _quatErr.x = -_quatErr.x
        _quatErr.y = -_quatErr.y
        _quatErr.z = -_quatErr.z
        _quatErr.w = -_quatErr.w
      }
      const sinHalf = Math.hypot(_quatErr.x, _quatErr.y, _quatErr.z)
      const angle   = 2 * Math.atan2(sinHalf, _quatErr.w)
      let rx = 0, ry = 0, rz = 0
      if (sinHalf > 1e-9) {
        const a = angle > maxRotStep ? maxRotStep : angle
        const k = a / sinHalf
        rx = _quatErr.x * k
        ry = _quatErr.y * k
        rz = _quatErr.z * k
      }

      // Convergence check on the UN-clamped magnitudes.
      if (posMag < convergePos && Math.abs(angle) < convergeRot) break

      err[0] = ex; err[1] = ey; err[2] = ez
      err[3] = rx; err[4] = ry; err[5] = rz

      // A = J J^T + λ² I  (6×6, symmetric).
      for (let i = 0; i < 6; i++) {
        for (let j = i; j < 6; j++) {
          let s = 0
          for (let k = 0; k < N; k++) s += J[i][k] * J[j][k]
          A[i][j] = s + (i === j ? lambda * lambda : 0)
          A[j][i] = A[i][j]
        }
      }

      // Solve A x = err, then dq = J^T x.
      const x = solveLinear(A, err.slice())
      if (!x) break
      let bad = false
      for (let i = 0; i < N; i++) {
        let dqi = 0
        for (let k = 0; k < 6; k++) dqi += J[k][i] * x[k]
        if (!Number.isFinite(dqi)) { bad = true; break }
        q[i] += dqi
      }
      if (bad) throw new Error('NaN in dq')

      clampToLimits(robot, q)
      applyJointValues(robot, q)
    }
  } catch (e) {
    // Restore starting pose on any numerical failure.
    // eslint-disable-next-line no-console
    console.warn('[IK] restoring q_start:', e?.message || e)
    applyJointValues(robot, q_start)
    return q_start
  }

  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(q[i])) {
      applyJointValues(robot, q_start)
      return q_start
    }
  }
  return q
}

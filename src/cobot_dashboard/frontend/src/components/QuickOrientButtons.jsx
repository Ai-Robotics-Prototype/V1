import { useState } from 'react'
import { useStore } from '../store/useStore'
import * as THREE from 'three'
import {
  resolveTool,
  readToolWorldPose,
  readApproachWorld,
  orientApproachTo,
  solveIKToPose,
  measureAchievedError,
} from '../lib/orient'

// 2026-09-08 amendment: retained "Face Down" only from the original
// QuickOrient trio. Row label + Face Side + Face Up stayed retired.
//
// Face Down = TCP-preserving reorientation:
//   * SAME xyz position (< 1 mm drift through the motion — enforced
//     by the achieved-error check below; if solveIKToPose can't
//     achieve the pose within tolerance, we REFUSE by name instead
//     of approximating).
//   * Flange approach axis aligned with world -Y (scene "down"; see
//     lib/orient.js:readApproachWorld for the frame contract).
//   * Slow by design: fixed orient rate ≤10°/s, computed from the
//     angular distance between current and target orientation. NOT
//     tied to jog speed.
//   * Refusal copy (plain text, no jargon):
//       "can't face down from this pose without moving the tool point"
//
// Twin path: always available. jogApi.runJointAnimation() interpolates
// the six joint values over the computed slow duration; the animation
// can be cancelled by any subsequent jog / IK / home command (they
// share homeAnimRef in StandaloneRobot / ArmViewer3D).
//
// Real-arm path: NOT wired in this commit. Real-arm coordinated
// Cartesian orient needs a new backend endpoint (single-axis /cmd/jog
// pulses would let joints move independently and drift the TCP —
// which is exactly what this operation forbids). On real-arm-enabled
// devices, the button still gates on the same interlock as other jog
// motions (enabled + allow_jog + !estop + !alarm); a subsequent
// operator directive is the trigger to wire the backend and lift the
// twin-only limit.

// TCP drift tolerance for the achieved-error check. If solveIKToPose
// returns a joint vector whose FK'd TCP position differs from the
// input `currentPos` by more than this, we refuse. 1 mm per operator
// directive item 1.
const TCP_DRIFT_TOL_M = 0.001

// Orientation rate cap: 10°/s = 0.1745 rad/s. Duration for the
// animation = angular_distance / rate, floored at a minimum so a
// near-noop rotation still animates visibly.
const ORIENT_RATE_RAD_PER_S = (10 * Math.PI) / 180
const MIN_DURATION_MS = 400
const MAX_DURATION_MS = 8000

function angleBetweenQuats(q1, q2) {
  // 2 * acos(|q1.dot(q2)|). Clamp for FP safety.
  const dot = Math.min(1, Math.max(-1, Math.abs(q1.dot(q2))))
  return 2 * Math.acos(dot)
}

function fmt(v) {
  if (!v || typeof v.x !== 'number') return String(v)
  return `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`
}

export default function FaceDownButton({ jogApi, onAtLimit }) {
  const [refusalMsg, setRefusalMsg] = useState('')
  const robot   = useStore((s) => s.robot) || {}
  const safety  = useStore((s) => s.safety) || {}
  // Real-arm interlock: same conditions as JogControls' jogGateOk.
  // Twin path ignores these — the twin is always safe to animate.
  const realArmReady = !!robot.connected && !!robot.enabled
                    && !!robot.allow_jog && !safety.estop
                    && !robot.alarm

  const ready = !!jogApi?.robot?.joints && !!jogApi?.runJointAnimation

  const handleClick = () => {
    setRefusalMsg('')
    if (!ready) return
    const armRobot = jogApi.robot
    const tool = resolveTool(armRobot)
    if (!tool) {
      setRefusalMsg('twin not fully loaded — try again in a moment')
      return
    }

    // Snapshot current TCP pose + world approach direction.
    const { pos: currentPos, quat: currentQuat } = readToolWorldPose(tool)
    const currentApproachWorld = readApproachWorld(armRobot)

    // Target: flange approach → scene -Y (down).
    const targetApproachWorld = new THREE.Vector3(0, -1, 0)
    const targetQuat = orientApproachTo(
      currentQuat, currentApproachWorld, targetApproachWorld)

    // One-shot IK at the SAME TCP position + new orientation.
    const q_target = solveIKToPose(armRobot, tool, currentPos, targetQuat)
    if (!q_target || q_target.length !== 6) {
      setRefusalMsg("can't face down from this pose without moving the tool point")
      return
    }

    // Verify the achieved solution keeps the TCP within tolerance.
    const { posErr, rotErr } = measureAchievedError(
      armRobot, tool, q_target, currentPos, targetQuat)
    // eslint-disable-next-line no-console
    console.log(
      `[face-down] posErr=${posErr.toExponential(2)} m  `
      + `rotErr=${rotErr.toExponential(2)} rad  `
      + `currentApproach=${fmt(currentApproachWorld)}`)

    if (posErr > TCP_DRIFT_TOL_M) {
      setRefusalMsg("can't face down from this pose without moving the tool point")
      onAtLimit?.(true)
      return
    }
    // rotErr = achieved-vs-target orientation residual. If it's large
    // (joint-clamped), IK didn't converge to the intended pose. Same
    // refusal — no approximation.
    if (rotErr > 0.05) {
      setRefusalMsg("can't face down from this pose without moving the tool point")
      onAtLimit?.(true)
      return
    }

    onAtLimit?.(false)

    // Slow fixed-rate duration. angle_between(current, target) /
    // (10°/s), clamped to [MIN, MAX] so tiny rotations still animate
    // visibly and huge rotations don't run for minutes.
    const angleRad = angleBetweenQuats(currentQuat, targetQuat)
    const durationMs = Math.max(
      MIN_DURATION_MS,
      Math.min(MAX_DURATION_MS,
               (angleRad / ORIENT_RATE_RAD_PER_S) * 1000))

    jogApi.runJointAnimation(q_target, durationMs)
  }

  const disabled = !ready
  return (
    <div style={styles.wrap} data-testid="face-down-button">
      <button
        type="button"
        disabled={disabled}
        title={realArmReady
          ? 'Face Down — TCP stays in place, tool orients to world -Y. '
            + 'Twin previews the pose (real-arm path pending backend '
            + 'wiring). Slow by design (~10°/s).'
          : 'Face Down — TCP-preserving twin orient to world -Y. '
            + 'Slow by design (~10°/s).'}
        onClick={handleClick}
        style={{
          ...styles.btn,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        Face Down
      </button>
      {refusalMsg && (
        <div
          data-testid="face-down-refusal"
          style={styles.refusal}>
          {refusalMsg}
        </div>
      )}
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 },
  btn: {
    padding: '8px 12px',
    background: '#0284c7', color: '#fff',
    border: '1px solid #0369a1', borderRadius: 6,
    fontSize: 12, fontWeight: 700, letterSpacing: 0.4,
    fontFamily: 'inherit',
  },
  refusal: {
    padding: '6px 10px',
    background: '#FEF3C7', color: '#92400E',
    border: '1px solid #FDE68A', borderRadius: 4,
    fontSize: 11, lineHeight: 1.4,
  },
}

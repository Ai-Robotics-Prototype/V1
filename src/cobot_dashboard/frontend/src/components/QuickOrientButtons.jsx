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
// Real-arm path (2026-09-09): wired through POST /api/estun/orient/
// face_down. Same gate matrix as every real jog motion (E-STOP /
// zone-GREEN / connected / enabled / !alarm / allow_jog / no program
// running) plus a server-side 30°-per-joint step guard. The dashboard
// endpoint enforces the rate cap (≤10°/s) by computing duration_ms
// server-side from the max per-joint delta so an under-driver-cap
// speed can't sneak through. The driver-side subscriber on
// /robot/orient_command is a follow-up wire — until it lands, the
// endpoint returns outcome.kind='executor_not_wired_yet' with a 503
// and the frontend surfaces the specific message. Twin preview always
// runs first; the "Send to real arm" button is a separate deliberate
// tap so the FIRST REAL PRESS IS THE OPERATOR'S, slow, hand near
// E-STOP (per the 2026-09-09 safety framing).

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
  // Last successful twin preview — the joint target the real-arm
  // press will send. `null` until the operator taps Face Down and IK
  // succeeds; cleared on any refusal or on a robot-state change that
  // would invalidate the pose. The "Send to real arm" button reads
  // this — no shadow copies of q_target live elsewhere.
  const [previewedTarget, setPreviewedTarget] = useState(null)
  const [realArmBusy, setRealArmBusy] = useState(false)
  const [realArmStatus, setRealArmStatus] = useState(null)   // {ok, kind, reason}

  const robot   = useStore((s) => s.robot) || {}
  const safety  = useStore((s) => s.safety) || {}
  // Live joint state from the WS stream — the ONLY authoritative
  // seed for IK. StandaloneRobot's twin URDF lags (25 Hz LERP with
  // 0.3/tick converges asymptotically; 100+ ms to catch a rapid
  // manual move) so using twin.joints as the IK seed reintroduces
  // the stale-pose bug (2026-09-09 §NN operator report: Face Down
  // levels at a PAST pose because the twin was mid-lerp when the
  // press fired). The store slice is populated from
  // publish/RobotPosture at controller rate (~17 Hz, <60 ms old).
  const liveJointsRad = useStore((s) => s.joints?.positions) || []
  // Real-arm interlock: same conditions as JogControls' jogGateOk.
  // Twin path ignores these — the twin is always safe to animate.
  // Wire authority: state_code==2 is the numeric truth per FACTS.md;
  // boolean `enabled` is a legacy fallback for older builds.
  const enabledByState = Number.isFinite(robot.state_code)
    ? robot.state_code === 2 : !!robot.enabled
  const realArmReady = !!robot.connected && enabledByState
                    && !!robot.allow_jog && !safety.estop
                    && !robot.alarm && safety.zone === 'GREEN'

  const ready = !!jogApi?.robot?.joints && !!jogApi?.runJointAnimation

  const handleClick = () => {
    setRefusalMsg('')
    setPreviewedTarget(null)
    setRealArmStatus(null)
    if (!ready) return
    const armRobot = jogApi.robot
    const tool = resolveTool(armRobot)
    if (!tool) {
      setRefusalMsg('twin not fully loaded — try again in a moment')
      return
    }
    // 2026-09-09 §NN stale-seed fix. Force-sync the twin URDF to
    // the LIVE WS joint state RIGHT BEFORE IK. Bypasses jogApi.
    // setJointsRad (which latches masks) — we call setJointValue on
    // each URDFJoint directly so LIVE-FOLLOW keeps working after
    // this press. This closes the class of bug where twin's LERP
    // (StandaloneRobot line 275 useEffect) hadn't caught up to a
    // rapid manual move, and IK computed q_target relative to a
    // stale pose.
    if (Array.isArray(liveJointsRad) && liveJointsRad.length >= 6) {
      const JN = ['joint_1', 'joint_2', 'joint_3',
                    'joint_4', 'joint_5', 'joint_6']
      for (let i = 0; i < 6; i++) {
        const v = Number(liveJointsRad[i])
        if (!Number.isFinite(v)) continue
        const j = armRobot?.joints?.[JN[i]]
        if (j && typeof j.setJointValue === 'function') {
          j.setJointValue(v)
        }
      }
      // Touch scene matrixes so TCP FK samples off the freshly-
      // written joint values (URDFLoader defers matrix update to
      // the render loop; IK reads world matrices).
      try { armRobot.updateMatrixWorld?.(true) } catch { /* nop */ }
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

    // Latch the IK-solved target so the "Send to real arm" button
    // has something authoritative to POST. Storing the joint vector
    // (not the pose) means the server can validate a 30°-per-joint
    // step guard without redoing IK. Array.from() clones so a later
    // preview overwrite can't mutate this snapshot.
    setPreviewedTarget(Array.from(q_target))
  }

  // Send to real arm — separate deliberate press per 2026-09-09
  // safety framing. Sends the LAST successful twin preview's
  // q_target. Server runs the full interlock gate matrix (same as
  // every real jog motion); refusals show inline. Rate cap enforced
  // server-side. The 3D twin preview is unchanged — this button only
  // fires the real-arm wire.
  const sendToRealArm = async () => {
    if (!realArmReady || !previewedTarget || realArmBusy) return
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      'Send Face Down to real arm?\n\n'
      + 'The arm will coordinate all six joints to the twin-previewed '
      + 'pose at ≤10°/s. Keep your hand near E-STOP.'
    )) return
    setRealArmBusy(true)
    setRealArmStatus(null)
    try {
      // Do NOT send q_current_snapshot: the server uses live_joints
      // (STATE.joints from /joint_states via WS) as its own authority
      // for BOTH the step guard AND the trajectory anchor — client
      // input can't influence either. Prior versions sent the twin's
      // post-animation URDF joints (which equal q_target) as the
      // snapshot; the server's staleness cross-check then refused
      // every real-arm press with kind='snapshot_stale', which
      // rendered as a yellow banner the operator missed. Stripping
      // the field kills that class outright.
      const resp = await fetch('/api/estun/orient/face_down', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q_target: previewedTarget }),
      })
      // Belt+braces JSON parse — some infra returns text on 500;
      // fall back to a synthetic outcome so realArmStatus is
      // NEVER null after this branch (silence bug fence).
      let body = null
      try { body = await resp.json() } catch { body = null }
      if (resp.ok && body && body.ok) {
        const drv = (typeof body.driver_subs === 'number')
          ? ` · driver_subs=${body.driver_subs}` : ''
        const nxt = body.next ? ` — ${body.next}` : ''
        setRealArmStatus({ ok: true,
          message: `Command published to /robot/jog_command`
            + ` (duration ${body.duration_ms} ms${drv})${nxt}` })
      } else if (body && body.outcome) {
        const outcome = body.outcome
        // Plain-language rewrites for the known refusal kinds
        // (snapshot_stale copy lesson: "no debug-speak"). Server's
        // outcome.reason is the technical narrative — surfaced in
        // the tooltip / debug pane, not the operator banner.
        const OP_COPY = {
          bad_input:          "The face-down target didn't reach the arm cleanly. Try Face Down again.",
          step_too_large:     "That orientation would swing joints too far from the current pose. Reposition and retry.",
          estop_active:       "E-STOP is active. Release the E-STOP button, then try Face Down again.",
          zone_not_green:     "Safety zone isn't clear. Step away from the cell and try again.",
          driver_disconnected: "The robot controller is offline. Check the arm connection and retry.",
          not_enabled:        "The arm isn't enabled. Press Enable, then try Face Down.",
          alarm_active:       "An alarm is active. Clear it, then try Face Down.",
          jog_gate_closed:    "Manual jog is disabled on the controller. Enable jog and try again.",
          program_running:    "A program is running. Stop it before commanding Face Down.",
          no_live_joint_state: "The arm isn't reporting its pose yet. Wait a moment and try again.",
          driver_not_discovered: "The estun driver isn't up yet. Wait a few seconds and retry.",
          bad_q_target:       "The face-down target didn't reach the driver cleanly. Try Face Down again.",
          allow_move_closed:  "The controller's motion write path is closed. Ask a supervisor to open it.",
          orient_save_fail:   "The controller refused to save the face-down move. Try again; if it persists, the controller may need a restart.",
          orient_run_fail:    "The controller accepted the face-down move but refused to run it. Check controller mode + alarms.",
          orient_slot_malformed: "The controller stored the face-down move in the wrong place and can't run it. Report this to support — it's a driver-side bug guard, not an operator condition.",
          orient_verify_saved_fail: "The controller didn't respond when the driver checked the saved face-down move. Check the controller connection and try again.",
          stale_joint_state: "Couldn't read the robot's current position — try again.",
          stale_ik_seed:     "The arm moved after Face Down was pressed. Press it again to re-level from the current position.",
        }
        setRealArmStatus({
          ok: false,
          kind: outcome.kind || 'unknown',
          message: OP_COPY[outcome.kind]
                || outcome.reason
                || `Refused (HTTP ${resp.status})`,
          technicalDetail: outcome.reason,
        })
      } else {
        // Non-JSON error OR fully-empty body — synthesize a message
        // so the operator never gets silence.
        setRealArmStatus({
          ok: false,
          kind: 'response_unparseable',
          message: `Server returned HTTP ${resp.status} without a `
            + `parseable outcome. Check dashboard journal for the request.`,
        })
      }
    } catch (e) {
      setRealArmStatus({
        ok: false, kind: 'network',
        message: `Network error contacting dashboard: ${e?.message || e}`,
      })
    } finally {
      setRealArmBusy(false)
    }
  }

  const disabled = !ready
  return (
    <div style={styles.wrap} data-testid="face-down-button">
      <button
        type="button"
        disabled={disabled}
        title={realArmReady
          ? 'Face Down — TCP stays in place, tool orients to world -Y. '
            + 'Twin previews the pose; a separate button then commands '
            + 'the real arm at ≤10°/s (server enforces the interlock).'
          : 'Face Down — TCP-preserving twin orient to world -Y. '
            + 'Slow by design (~10°/s). Real-arm path enabled once the '
            + 'arm is connected + enabled + jog-gated + zone-green.'}
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
      {/* Real-arm button — only rendered after a successful twin
          preview (previewedTarget != null). Disabled unless the same
          interlock gates the server enforces are also green on the
          client, so operators don't tap only to eat a 409. */}
      {previewedTarget && (
        <button
          data-testid="face-down-send-real"
          type="button"
          disabled={!realArmReady || realArmBusy}
          onClick={sendToRealArm}
          title={realArmReady
            ? 'Command the real arm to the previewed pose at ≤10°/s. '
              + 'Keep your hand near E-STOP.'
            : 'Real arm not ready — check enable / allow_jog / alarm / '
              + 'zone-green / E-STOP.'}
          style={{
            ...styles.btnReal,
            cursor: (!realArmReady || realArmBusy) ? 'not-allowed' : 'pointer',
            opacity: (!realArmReady || realArmBusy) ? 0.55 : 1,
          }}
        >
          {realArmBusy ? 'Sending…' : 'Send to real arm'}
        </button>
      )}
      {realArmStatus && (
        <div
          data-testid={realArmStatus.ok
            ? 'face-down-real-ok'
            : 'face-down-real-refusal'}
          data-kind={realArmStatus.kind || (realArmStatus.ok ? 'ok' : '')}
          style={realArmStatus.ok ? styles.okBanner : styles.refusal}>
          {realArmStatus.message}
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
  btnReal: {
    padding: '8px 12px',
    background: '#B91C1C', color: '#fff',
    border: '2px solid #7F1D1D', borderRadius: 6,
    fontSize: 12, fontWeight: 700, letterSpacing: 0.4,
    textTransform: 'uppercase',
    fontFamily: 'inherit',
  },
  refusal: {
    padding: '6px 10px',
    background: '#FEF3C7', color: '#92400E',
    border: '1px solid #FDE68A', borderRadius: 4,
    fontSize: 11, lineHeight: 1.4,
  },
  okBanner: {
    padding: '6px 10px',
    background: 'rgba(34,197,94,0.12)', color: '#166534',
    border: '1px solid rgba(34,197,94,0.55)', borderRadius: 4,
    fontSize: 11, lineHeight: 1.4,
  },
}

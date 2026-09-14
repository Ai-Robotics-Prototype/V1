import { useEffect, useRef, useState } from 'react'
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

// 2026-09-14 operator directive — Orient Flange Down control.
//
// Retired in this session:
//   * JointJogPanel (J1..J6 sliders, PREVIEWING banner, Cartesian
//     checkbox, Send-to-real-arm button) from the 3D View.
//
// Kept + reshaped: ONE button labeled "Orient Flange Down" that
// opens a centered confirm modal. Continue fires the SAME guarded
// real-arm endpoint (/api/estun/orient/face_down) — fresh live
// joints server-side, 30° step guard, dry-run preflight, immediate-
// stop latch. Cancel / Escape closes with no motion.
//
// Refusal copy: reuses the 2026-09-14 plain-copy OP_COPY table —
// step_too_large + IK-drift refusals render:
//   "Too far from flat for an automatic move. Jog the flange
//    closer to flat, then press Orient Flange Down again."
//
// The filename stays QuickOrientButtons.jsx to preserve git
// history (grep-follow), even though only ONE control lives here
// now. Default export renamed to OrientFlangeDownControl.
//
// Contract for the caller: pass `jogApi` from StandaloneRobot's
// onRobotReady callback. We need jogApi.robot for the URDF handle
// to run IK against; if it's not ready, the button is disabled.
// No twin animation runs on Continue — the WS mirror updates the
// twin once the real arm moves. If the real-arm interlocks refuse,
// the refusal renders inline; no motion, no twin drift.

// TCP drift tolerance for the achieved-error check. Same 1 mm
// budget the endpoint's server-side FK cross-check uses.
const TCP_DRIFT_TOL_M = 0.001

// Rotation-residual tolerance for the achieved-error check.
const ROT_ERR_TOL_RAD = 0.05

// Named refusal copy — mapped from server outcome.kind to plain
// operator language. Same table shape the prior FaceDownButton
// used; the two IK-refusal classes (client can't solve, server
// says step_too_large) share the same too-tilted operator string.
const REFUSAL_COPY = {
  // Client-side IK could not preserve the TCP or converge on the
  // face-down orientation — same operator situation as the
  // server's step_too_large refusal (the flange is too tilted for
  // an automatic reorient from here).
  ik_unreachable:      "Too far from flat for an automatic move. Jog the flange closer to flat, then press Orient Flange Down again.",
  bad_input:           "The face-down target didn't reach the arm cleanly. Try Orient Flange Down again.",
  step_too_large:      "Too far from flat for an automatic move. Jog the flange closer to flat, then press Orient Flange Down again.",
  estop_active:        "E-STOP is active. Release the E-STOP button, then try Orient Flange Down again.",
  zone_not_green:      "Safety zone isn't clear. Step away from the cell and try again.",
  driver_disconnected: "The robot controller is offline. Check the arm connection and retry.",
  not_enabled:         "The arm isn't enabled. Press Enable, then try Orient Flange Down.",
  alarm_active:        "An alarm is active. Clear it, then try Orient Flange Down.",
  jog_gate_closed:     "Manual jog is disabled on the controller. Enable jog and try again.",
  program_running:     "A program is running. Stop it before commanding Orient Flange Down.",
  no_live_joint_state: "The arm isn't reporting its pose yet. Wait a moment and try again.",
  driver_not_discovered: "The estun driver isn't up yet. Wait a few seconds and retry.",
  bad_q_target:        "The face-down target didn't reach the driver cleanly. Try Orient Flange Down again.",
  allow_move_closed:   "The controller's motion write path is closed. Ask a supervisor to open it.",
  orient_save_fail:    "The controller refused to save the face-down move. Try again; if it persists, the controller may need a restart.",
  orient_run_fail:     "The controller accepted the face-down move but refused to run it. Check controller mode + alarms.",
  orient_slot_malformed: "The controller stored the face-down move in the wrong place and can't run it. Report this to support — it's a driver-side bug guard, not an operator condition.",
  orient_verify_saved_fail: "The controller didn't respond when the driver checked the saved face-down move. Check the controller connection and try again.",
  stale_joint_state:   "Couldn't read the robot's current position — try again.",
  stale_ik_seed:       "The arm moved after Orient Flange Down was pressed. Press it again to re-level from the current position.",
  orient_near_singularity: "Too close to a stretched-out pose. Use joint jog to move away from the extension, then try Orient Flange Down again.",
}

// One IK compute per Continue press. Reads LIVE joint state from
// the store as the seed (bypasses the twin's LERP mask — same
// stale-seed fix the 2026-09-09 pass landed for the prior two-
// step flow). Writes the live seed onto the URDF joints, samples
// current TCP + approach, then solves IK for the same TCP at a
// world-down approach. Returns q_target or null on any failure.
function computeFaceDownTarget(armRobot, liveJointsRad) {
  if (!armRobot?.joints) return null
  const tool = resolveTool(armRobot)
  if (!tool) return null

  const JN = ['joint_1', 'joint_2', 'joint_3',
              'joint_4', 'joint_5', 'joint_6']
  if (Array.isArray(liveJointsRad) && liveJointsRad.length >= 6) {
    for (let i = 0; i < 6; i++) {
      const v = Number(liveJointsRad[i])
      if (!Number.isFinite(v)) continue
      const j = armRobot.joints[JN[i]]
      if (j && typeof j.setJointValue === 'function') {
        j.setJointValue(v)
      }
    }
    try { armRobot.updateMatrixWorld?.(true) } catch { /* nop */ }
  }

  const { pos: currentPos, quat: currentQuat } = readToolWorldPose(tool)
  const currentApproachWorld = readApproachWorld(armRobot)
  const targetApproachWorld = new THREE.Vector3(0, -1, 0)
  const targetQuat = orientApproachTo(
    currentQuat, currentApproachWorld, targetApproachWorld)

  const q_target = solveIKToPose(armRobot, tool, currentPos, targetQuat)
  if (!q_target || q_target.length !== 6) return null

  const { posErr, rotErr } = measureAchievedError(
    armRobot, tool, q_target, currentPos, targetQuat)
  if (posErr > TCP_DRIFT_TOL_M) return null
  if (rotErr > ROT_ERR_TOL_RAD) return null

  return Array.from(q_target)
}

export default function OrientFlangeDownControl({ jogApi }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)   // {ok, kind, message}
  const continueBtnRef = useRef(null)

  const robot   = useStore((s) => s.robot) || {}
  const safety  = useStore((s) => s.safety) || {}
  const liveJointsRad = useStore((s) => s.joints?.positions) || []

  // Wire authority: state_code==2 is the numeric truth per FACTS.md;
  // boolean `enabled` is a legacy fallback for older builds. Same
  // shape the retired two-step control used.
  const enabledByState = Number.isFinite(robot.state_code)
    ? robot.state_code === 2 : !!robot.enabled
  const realArmReady = !!robot.connected && enabledByState
                    && !!robot.allow_jog && !safety.estop
                    && !robot.alarm && safety.zone === 'GREEN'

  const twinReady = !!jogApi?.robot?.joints
  const disabled = !twinReady

  // Escape / Cancel close the modal without firing any request.
  // No click-through — the backdrop is a full-viewport overlay that
  // captures clicks (see backdropStyle). Only Cancel and Escape
  // dismiss; clicks on the backdrop are inert per the operator
  // order ("dismissible via Cancel/Escape only — no click-through").
  useEffect(() => {
    if (!modalOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) {
        setModalOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    // Autofocus Continue so keyboard-only operators reach it first
    // (Enter fires Continue, Escape cancels).
    try { continueBtnRef.current?.focus() } catch { /* nop */ }
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, busy])

  const openModal = () => {
    if (disabled) return
    setStatus(null)
    setModalOpen(true)
  }

  const onCancel = () => {
    if (busy) return
    setModalOpen(false)
  }

  const onContinue = async () => {
    if (busy || !twinReady) return
    setBusy(true)
    setStatus(null)
    try {
      // Client-side IK is a preflight so we can name the ik_unreachable
      // class in plain operator copy WITHOUT waiting on the endpoint's
      // step_too_large fallback (server refuses too, but the round trip
      // is slower and less specific). Server remains the authority for
      // the interlock gate matrix + the 30°-per-joint step guard.
      const q_target = computeFaceDownTarget(
        jogApi?.robot, liveJointsRad)
      if (!q_target) {
        setStatus({
          ok: false,
          kind: 'ik_unreachable',
          message: REFUSAL_COPY.ik_unreachable,
        })
        return
      }

      // Real-arm gate stays authoritative on the server — but we hint
      // via a client-side check so the modal doesn't POST an obviously-
      // doomed request. If the arm isn't ready, close the modal and
      // render an inline refusal named to the failing gate. This mirrors
      // the retired two-step control's realArmReady derivation.
      if (!realArmReady) {
        const kind = safety.estop      ? 'estop_active'
                   : safety.zone !== 'GREEN' ? 'zone_not_green'
                   : !robot.connected  ? 'driver_disconnected'
                   : !enabledByState   ? 'not_enabled'
                   : robot.alarm       ? 'alarm_active'
                   : !robot.allow_jog  ? 'jog_gate_closed'
                   :                     'not_enabled'
        setStatus({
          ok: false,
          kind,
          message: REFUSAL_COPY[kind] || 'Arm not ready.',
        })
        return
      }

      const resp = await fetch('/api/estun/orient/face_down', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q_target }),
      })
      let body = null
      try { body = await resp.json() } catch { body = null }

      if (resp.ok && body && body.ok) {
        // 2026-09-14 operator directive: no dev-confirmation toast
        // on success. The arm moving is the confirmation. Prior
        // build leaked "Command published (duration N ms)." here —
        // topic / req_id / duration_ms are diagnostic-only. Failures
        // still render plain operator copy (setStatus below).
        setStatus(null)
        setModalOpen(false)
        return
      }

      const outcome = body && body.outcome
      if (outcome) {
        setStatus({
          ok: false,
          kind: outcome.kind || 'unknown',
          message: REFUSAL_COPY[outcome.kind]
                || outcome.reason
                || `Refused (HTTP ${resp.status})`,
          technicalDetail: outcome.reason,
        })
      } else {
        setStatus({
          ok: false,
          kind: 'response_unparseable',
          message: `Server returned HTTP ${resp.status} without a `
            + `parseable outcome. Check dashboard journal.`,
        })
      }
    } catch (e) {
      setStatus({
        ok: false,
        kind: 'network',
        message: `Network error contacting dashboard: ${e?.message || e}`,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={styles.wrap} data-testid="orient-flange-down-control">
        <button
          type="button"
          data-testid="orient-flange-down-button"
          disabled={disabled}
          onClick={openModal}
          title={realArmReady
            ? 'Orient the flange straight down at the current TCP '
              + 'position. Opens a confirmation modal; Continue '
              + 'commands the real arm through the guarded Face '
              + 'Down endpoint.'
            : 'Orient Flange Down — the arm must be connected, '
              + 'enabled, jog-gated, alarm-free, and in a green '
              + 'safety zone before Continue will command motion.'}
          style={{
            ...styles.btn,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.55 : 1,
          }}
        >
          Orient Flange Down
        </button>
        {status && !status.ok && !modalOpen && (
          <div
            data-testid="orient-flange-down-refusal"
            data-kind={status.kind || ''}
            style={styles.refusal}>
            {status.message}
          </div>
        )}
      </div>

      {modalOpen && (
        <div
          data-testid="orient-flange-down-backdrop"
          style={styles.backdrop}
          role="presentation"
        >
          <div
            data-testid="orient-flange-down-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="orient-flange-down-title"
            style={styles.modal}
          >
            <div id="orient-flange-down-title" style={styles.modalTitle}>
              Orient flange down?
            </div>
            <div style={styles.modalBody}>
              The arm will rotate the flange to point straight down at
              its current position.
            </div>
            {status && !status.ok && (
              <div
                data-testid="orient-flange-down-modal-refusal"
                data-kind={status.kind || ''}
                style={styles.refusal}>
                {status.message}
              </div>
            )}
            <div style={styles.modalButtons}>
              <button
                type="button"
                data-testid="orient-flange-down-cancel"
                onClick={onCancel}
                disabled={busy}
                style={{
                  ...styles.btnSecondary,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.55 : 1,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                ref={continueBtnRef}
                data-testid="orient-flange-down-continue"
                onClick={onContinue}
                disabled={busy}
                style={{
                  ...styles.btnPrimary,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.55 : 1,
                }}
              >
                {busy ? 'Sending…' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const styles = {
  // 2026-09-14 operator directive: control lives INSIDE the jog
  // surface (right of the Rotation cluster in the bottom pad row),
  // not as a top-right absolute-positioned overlay on the twin.
  // The parent's flex layout controls placement; the wrap is a
  // vertical stack (button + optional inline refusal) with no
  // fixed positioning.
  wrap: {
    display: 'flex', flexDirection: 'column', gap: 8,
    minWidth: 160, maxWidth: 240,
    fontFamily: 'var(--font, system-ui)',
  },
  btn: {
    padding: '12px 18px',
    background: '#0284c7', color: '#fff',
    border: '1px solid #0369a1', borderRadius: 6,
    fontSize: 13, fontWeight: 700, letterSpacing: 0.4,
    fontFamily: 'inherit',
    boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
    whiteSpace: 'nowrap',
  },
  refusal: {
    padding: '8px 12px',
    background: '#FEF3C7', color: '#92400E',
    border: '1px solid #FDE68A', borderRadius: 4,
    fontSize: 12, lineHeight: 1.4,
  },
  // 2026-09-14: okBanner style retired with the "Command published"
  // dev-confirmation toast (topic / req_id / duration_ms leak).
  // Full-viewport backdrop. Click-through is intentionally NOT
  // wired — the operator directive forbids backdrop dismissal.
  // pointerEvents:'auto' keeps the dark overlay from letting
  // clicks fall through to the twin viewer beneath.
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'auto',
  },
  modal: {
    background: '#fff', color: '#111318',
    border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8,
    boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
    padding: 20, minWidth: 320, maxWidth: 440,
    display: 'flex', flexDirection: 'column', gap: 12,
    fontFamily: 'var(--font, system-ui)', fontSize: 13,
  },
  modalTitle: {
    fontSize: 16, fontWeight: 700, color: '#0f172a',
    letterSpacing: 0.2,
  },
  modalBody: {
    fontSize: 13, lineHeight: 1.5, color: '#334155',
  },
  modalButtons: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    marginTop: 4,
  },
  btnPrimary: {
    padding: '8px 16px',
    background: '#0284c7', color: '#fff',
    border: '1px solid #0369a1', borderRadius: 6,
    fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
    fontFamily: 'inherit',
  },
  btnSecondary: {
    padding: '8px 16px',
    background: '#fff', color: '#334155',
    border: '1px solid #cbd5e1', borderRadius: 6,
    fontSize: 13, fontWeight: 600, letterSpacing: 0.3,
    fontFamily: 'inherit',
  },
}

// Generic joint-space animation with easeInOutCubic. Used by the
// quick-orient buttons to smoothly move the twin from the current
// pose to a solved target pose. Modeled on lib/homeAnim.js, but
// generalized:
//   - Interpolates to an arbitrary q_target (not just zero)
//   - Duration is caller-supplied (driven by the jog-speed slider)
//   - Masks stay latched at natural completion by default (twin holds
//     at the target pose — matches "preview the commanded orientation"
//     UX). Callers that want live-tracking to resume can pass
//     `releaseAtCompletion: true`.
//
// Twin-only. This module never publishes to any /estun/* command
// topic; it only writes to the URDF twin. Motion command wiring is a
// separate future concern — see TODOs in QuickOrientButtons.jsx.

const JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

// Duration bounds for jog-speed-scaled animations. At 100 % the move
// takes MIN_MS; at 0 % it takes MAX_MS. Linear scale between the two.
export const JOINT_ANIM_MIN_MS = 500
export const JOINT_ANIM_MAX_MS = 5000

// Map a 0-100 % jog-speed to an animation duration in ms.
export function durationForJogSpeed(jogSpeedPct) {
  const p = Math.max(0, Math.min(100, Number(jogSpeedPct) || 0))
  return JOINT_ANIM_MAX_MS - (JOINT_ANIM_MAX_MS - JOINT_ANIM_MIN_MS) * (p / 100)
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// Start a joint-space animation from the URDF's current pose to
// `q_target`. Latches all six manual masks so the interpolation loop
// in ArmViewer3D can't stomp our writes.
//
// Args:
//   robot                – urdf-loader URDFRobot
//   q_target             – 6-vector target joint values (rad)
//   duration             – ms
//   currentRef           – ref shared with ArmViewer3D FK path
//   targetsRef           – ref shared with ArmViewer3D FK path
//   manualMaskRef        – ref of six booleans, latched during anim
//   releaseAtCompletion  – if true, release masks + zero refs on done;
//                          if false (default), keep masks latched so
//                          the twin holds at the target pose.
//   onComplete           – callback fired when the anim finishes (not
//                          on cancel).
//
// Returns { cancel } — same protocol as startHomeMove. On cancel, masks
// stay latched (the interrupting caller is about to seize authority).
export function startJointAnimation({
  robot, q_target, duration,
  currentRef, targetsRef, manualMaskRef,
  releaseAtCompletion = false,
  onComplete,
}) {
  if (!robot || !Array.isArray(q_target) || q_target.length < 6) {
    return { cancel: () => {} }
  }

  const q_start = new Array(6)
  for (let i = 0; i < 6; i++) {
    const j = robot?.joints?.[JOINT_NAMES[i]]
    const raw = j?.jointValue
    const v   = Array.isArray(raw) ? raw[0] : raw
    const n   = Number(v)
    q_start[i] = Number.isFinite(n) ? n : 0
  }

  // Latch masks up front — the ArmViewer3D interpolation loop skips
  // masked joints, so our writes stick.
  for (let i = 0; i < 6; i++) manualMaskRef.current[i] = true

  const t0 = performance.now()
  let rafId = null
  let cancelled = false

  const step = () => {
    if (cancelled) return
    const elapsed = performance.now() - t0
    const raw = elapsed >= duration ? 1 : elapsed / duration
    const t   = easeInOutCubic(raw)

    if (raw >= 1) {
      // Snap exactly to the target — no lingering epsilon.
      for (let i = 0; i < 6; i++) {
        robot?.joints?.[JOINT_NAMES[i]]?.setJointValue?.(q_target[i])
        currentRef.current[i] = q_target[i]
        targetsRef.current[i] = q_target[i]
        if (releaseAtCompletion) manualMaskRef.current[i] = false
      }
      onComplete?.()
      return
    }

    for (let i = 0; i < 6; i++) {
      const q = q_start[i] + (q_target[i] - q_start[i]) * t
      robot?.joints?.[JOINT_NAMES[i]]?.setJointValue?.(q)
      currentRef.current[i] = q
      targetsRef.current[i] = q
    }

    rafId = requestAnimationFrame(step)
  }

  rafId = requestAnimationFrame(step)

  return {
    cancel: () => {
      cancelled = true
      if (rafId) cancelAnimationFrame(rafId)
      // Masks stay latched intentionally — same convention as
      // startHomeMove: the interrupting caller takes authority.
    },
  }
}

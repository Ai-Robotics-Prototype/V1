// Coordinated timed move to home pose (all joints 0) with easeInOutCubic.
// Wired into jogApi.home() by URDFArm and StandaloneRobot. Latches all
// six manual masks for the duration so the store mirror can't fight,
// releases them at natural completion so the store resumes ownership;
// on cancel (interrupted by slider / IK), masks stay latched — the new
// caller becomes the authority. Twin-only.

const JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

// Duration of the smooth Home move, ms. Single source of truth for both
// viewers — bump this here to tune globally.
export const HOME_MOVE_MS = 2000

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// Kicks off an rAF-driven animation that interpolates all six joints
// simultaneously from their current values to zero over `duration` ms.
// All joints start and finish together (coordinated, not per-joint
// exponential).
//
// Writes joint values to the URDF and mirrors them into currentRef and
// targetsRef so the existing 25 Hz FK lerp is a no-op alongside — it
// still calls setJointValue on its own tick but with the identical
// value we just wrote, so nothing fights.
//
// Returns { cancel }. The animation self-clears via onComplete when it
// arrives; cancel() halts it mid-flight without unlatching masks (the
// interrupting caller is about to seize authority).
export function startHomeMove({
  robot, currentRef, targetsRef, manualMaskRef,
  duration = HOME_MOVE_MS, onComplete,
}) {
  const q_start = new Array(6)
  for (let i = 0; i < 6; i++) {
    const j = robot?.joints?.[JOINT_NAMES[i]]
    const raw = j?.jointValue
    const v = Array.isArray(raw) ? raw[0] : raw
    const n = Number(v)
    q_start[i] = Number.isFinite(n) ? n : 0
  }

  // Latch all masks up front. Store mirror is blocked for the duration.
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
      // Snap exactly to zero — no lingering epsilon — and release the
      // masks so the store resumes ownership on the next mirror tick.
      for (let i = 0; i < 6; i++) {
        robot?.joints?.[JOINT_NAMES[i]]?.setJointValue?.(0)
        currentRef.current[i] = 0
        targetsRef.current[i] = 0
        manualMaskRef.current[i] = false
      }
      onComplete?.()
      return
    }

    for (let i = 0; i < 6; i++) {
      // q(t) = q_start + (0 - q_start) * ease(raw) = q_start * (1 - t)
      const q = q_start[i] * (1 - t)
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
      // Masks stay latched intentionally — the caller that interrupts
      // us is about to take authority for the joints it writes.
    },
  }
}

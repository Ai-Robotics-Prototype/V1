// twinFollowState — the tiny state machine that decides whether the
// 3D twin mirrors the real arm's joints (LIVE-FOLLOW) or holds an
// operator-set preview (TWIN-POSING), one joint at a time.
//
// The twin viewer (StandaloneRobot / URDFArm) subscribes to
// s.joints.positions from the store and mirrors those onto the twin's
// six URDF joints on each WS frame. When the operator drags a joint
// slider (JointJogPanel.onSlide) or previews a Face Down orient
// (jogApi.runJointAnimation), the corresponding joint's `mask[i]`
// latches true — the mirror tick SKIPS that joint until an explicit
// release path clears the mask.
//
// Release paths (mapped in JointJogPanel + StandaloneRobot):
//   * releaseJointMask(i) — slider pointerup / lostpointercapture /
//                            blur for a single slider
//   * followLive()        — "Follow robot" button clears all six
//
// Neither release path yanks joints anywhere — the next mirror tick
// seeds targets from the LATEST store positions, so the twin catches
// up smoothly from wherever the preview left it.
//
// This module is a pure state machine (no React, no three) so the
// invariants can be unit-tested without a browser. StandaloneRobot's
// jogApi.setJointRad / releaseJointMask / followLive delegate to
// these primitives via the shared manualMaskRef.

export const JOINT_COUNT = 6

/** Build a fresh mask (all LIVE-FOLLOW). */
export function newMask() {
  return [false, false, false, false, false, false]
}

/** True iff any joint is currently TWIN-POSING. */
export function anyPosing(mask) {
  return Array.isArray(mask) && mask.some(Boolean)
}

/** Apply one WS mirror tick: copy `storePositions[i]` into `targets[i]`
 * for every joint whose mask is false. Masked joints are untouched —
 * their operator-set target survives the tick. Returns the mutated
 * `targets` for chaining; callers may pass the same ref array in
 * repeatedly (mutation is in-place, matching the ref pattern in
 * StandaloneRobot). */
export function applyStoreTick(mask, targets, storePositions) {
  if (!Array.isArray(storePositions) || storePositions.length < JOINT_COUNT) {
    return targets
  }
  for (let i = 0; i < JOINT_COUNT; i++) {
    if (mask[i]) continue
    const v = Number(storePositions[i])
    targets[i] = Number.isFinite(v) ? v : 0
  }
  return targets
}

/** Latch one joint into TWIN-POSING (operator wrote it). Returns true
 * iff the mask transitioned from live→posing for that joint (callers
 * use this to decide whether to notify listeners — no notify on
 * redundant writes). */
export function poseJoint(mask, idx) {
  if (idx < 0 || idx >= JOINT_COUNT) return false
  if (mask[idx]) return false
  mask[idx] = true
  return true
}

/** Release one joint's mask back to LIVE-FOLLOW. Returns true iff the
 * mask transitioned from posing→live for that joint. */
export function releaseJoint(mask, idx) {
  if (idx < 0 || idx >= JOINT_COUNT) return false
  if (!mask[idx]) return false
  mask[idx] = false
  return true
}

/** Release ALL joints back to LIVE-FOLLOW ("Follow robot" reset).
 * Returns true iff at least one joint transitioned. */
export function followLiveAll(mask) {
  let changed = false
  for (let i = 0; i < JOINT_COUNT; i++) {
    if (mask[i]) { mask[i] = false; changed = true }
  }
  return changed
}

/** Latch every joint (used by Face Down / home preview to hold the
 * animated target once the interpolation completes). Returns true iff
 * at least one joint transitioned from live→posing (allows callers to
 * skip a redundant notify). */
export function poseAll(mask) {
  let changed = false
  for (let i = 0; i < JOINT_COUNT; i++) {
    if (!mask[i]) { mask[i] = true; changed = true }
  }
  return changed
}

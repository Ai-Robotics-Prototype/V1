// Pose-display freshness helpers for the Orient Flange Down modal.
//
// Operator-reported bug: pressing Orient Flange Down sometimes raised
// "couldn't read the robot's orientation," yet Continue then executed
// a correct orient. The driver reads pose from its own posture stream
// and moves correctly; the FRONTEND modal was reading a stale display
// pose (WS-stream age) and warning as if the robot's pose was
// unreadable. This module is the single source of truth for "is the
// dashboard's pose display fresh right now" — the modal and the 3D
// render both consume it against the same store field
// (lastMessageTime) so there is provably one pose source.
//
// Thresholds:
//   POSE_FRESH_MS         — anything newer counts as fresh. 1000 ms
//                            covers a full WS frame at 25 Hz with
//                            ~15× headroom against a single dropped
//                            frame.
//   POSE_WAIT_TIMEOUT_MS  — on press, if stale, wait up to this
//                            long for a fresh frame before giving up.
//                            2000 ms is bounded so the operator gets
//                            a definite answer within one heartbeat
//                            of a slow tablet-WiFi link.

export const POSE_FRESH_MS        = 1000
export const POSE_WAIT_TIMEOUT_MS = 2000

// Age of the newest WS frame in milliseconds. `lastMessageTime` is
// wall-clock Date.now() recorded when the WS state message landed
// (see store/useStore.js line 773). Returns Infinity when we've
// never received a frame (lastMessageTime === 0) so callers treat
// the "no signal yet" case as maximally stale.
export function computePoseAgeMs(lastMessageTime, now) {
  if (!Number.isFinite(lastMessageTime) || lastMessageTime <= 0) {
    return Infinity
  }
  const _now = Number.isFinite(now) ? now : Date.now()
  const age = _now - lastMessageTime
  return age < 0 ? 0 : age
}

// Fresh-enough gate. `true` iff we've received a WS frame within
// POSE_FRESH_MS. The modal calls this at press time; the 3D view
// implicitly depends on the same signal via lastMessageTime.
export function isPoseFresh(lastMessageTime, now) {
  return computePoseAgeMs(lastMessageTime, now) <= POSE_FRESH_MS
}

// Format the age for operator copy. Below 10 s we show one decimal
// ("3.4 s"); at or above 10 s we drop the decimal ("14 s"); ∞ /
// no-signal renders as "no signal yet" so the warning stays honest
// when the WS has never delivered a frame.
export function formatPoseAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'no signal yet'
  const s = ageMs / 1000
  if (s >= 10) return `${Math.round(s)} s`
  if (s >= 1)  return `${s.toFixed(1)} s`
  return `${Math.round(ageMs)} ms`
}

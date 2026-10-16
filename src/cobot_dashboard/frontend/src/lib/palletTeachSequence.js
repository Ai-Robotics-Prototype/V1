// Sequence helpers for the pallet 4-point teach flow.
//
// Owns two things that BOTH hosts (wizard page teach + editor
// row-button teach) must agree on — never forked:
//
//   1. Role order + role↔field mapping — the operator walks
//      ① → ② → ③ → ④, and each role writes to a specific
//      pallet_place field.
//   2. Sequence transitions — back, forward, tap-jump — plus the
//      teach vs re-teach mode a given (role, program-state) pair
//      resolves to. Re-teach is "the operator revisited a role that
//      already has a taught pose"; the pose is KEPT until Record.
//
// Frame validation is intentionally NOT here (§465 fork-1 kill,
// 2026-08-04). All frame geometry runs on the backend via
// POST /api/pallet/validate_frame → pallet_geometry.compute_frame
// / validate_frame — the shared truth surface with v1→v2
// migration, Gram-Schmidt-orthogonalized frame, and named
// `involves_corners` metadata for re-teach suppression. See
// frontend/src/lib/palletFrameValidator.js for the async client.

import { palletFrameStatus, PALLET_ROLE_ORDER } from './programTruth.js'

export { PALLET_ROLE_ORDER }

export const PALLET_ROLE_TO_FIELD = {
  pallet_c1:   'corner1_tcp',
  pallet_c2:   'corner2_tcp',
  pallet_c3:   'corner3_tcp',
  pallet_part: 'part_tcp',
}

export const PALLET_ROLE_TO_STATUS_KEY = {
  pallet_c1:   'corner1',
  pallet_c2:   'corner2',
  pallet_c3:   'corner3',
  pallet_part: 'part',
}


// ── Sequence transitions ────────────────────────────────────────

// Next role in ①→②→③→④ order. null after ④ (sequence closes).
export function nextRoleFrom(role) {
  const i = PALLET_ROLE_ORDER.indexOf(role)
  if (i < 0 || i >= PALLET_ROLE_ORDER.length - 1) return null
  return PALLET_ROLE_ORDER[i + 1]
}

// Previous role. null at ① (no back).
export function backRoleFrom(role) {
  const i = PALLET_ROLE_ORDER.indexOf(role)
  if (i <= 0) return null
  return PALLET_ROLE_ORDER[i - 1]
}

// Mode a role resolves to for a given program state:
//   'teach'     — the point has no taught pose yet; Record captures.
//   're-teach'  — the point already has a taught pose; the operator
//                 is revisiting. The pose is KEPT until Record fires,
//                 so "backing up to look" ≠ overwriting.
export function modeForRole(role, frameStatus) {
  if (!role) return null
  const key = PALLET_ROLE_TO_STATUS_KEY[role]
  if (!key) return null
  return frameStatus && frameStatus[key] ? 're-teach' : 'teach'
}


// ── Progress counting ────────────────────────────────────────────

// Number of frame points already recorded (0..4). Reads the shared
// palletFrameStatus resolver so the counter agrees with everything
// else the editor + wizard show.
export function taughtCount(frameStatus) {
  if (!frameStatus) return 0
  let n = 0
  if (frameStatus.corner1) n++
  if (frameStatus.corner2) n++
  if (frameStatus.corner3) n++
  if (frameStatus.part)    n++
  return n
}


// ── State-machine actions (host-shared) ──────────────────────────
//
// Each returns the next role (or null when the sequence closes).
// Hosts wire these to their own state setters; the important
// property is the transition math lives HERE — not in each host.

// Where the Back button should land from `role`, given a program.
// Returns { role, mode } — mode is 're-teach' when the target
// already has a taught pose.
export function backFrom(role, program) {
  const prev = backRoleFrom(role)
  if (!prev) return null
  const fs = palletFrameStatus(program)
  return { role: prev, mode: modeForRole(prev, fs) }
}

// Where a Record on `role` should advance. Returns { role, mode }
// or null to close the sequence.
export function advanceFrom(role, program) {
  const next = nextRoleFrom(role)
  if (!next) return null
  const fs = palletFrameStatus(program)
  return { role: next, mode: modeForRole(next, fs) }
}

// Where a tap-jump to `role` lands. Same math as backFrom /
// advanceFrom, but any role is a legal target — the sequence is a
// guide, not a cage. Tapping the CURRENT role is a no-op (returns
// null so the host can skip the state change).
export function jumpTo(role, program, currentRole) {
  if (!role) return null
  if (role === currentRole) return null
  const fs = palletFrameStatus(program)
  return { role, mode: modeForRole(role, fs) }
}

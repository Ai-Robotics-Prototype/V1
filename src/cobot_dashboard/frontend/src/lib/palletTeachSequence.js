// Sequence + validation helpers for the pallet 4-point teach flow.
//
// Owns three things that BOTH hosts (wizard page teach + editor
// row-button teach) must agree on — never forked:
//
//   1. Role order + role↔field mapping — the operator walks
//      ① → ② → ③ → ④, and each role writes to a specific
//      pallet_place field.
//   2. Sequence transitions — back, forward, tap-jump — plus the
//      teach vs re-teach mode a given (role, program-state) pair
//      resolves to. Re-teach is "the operator revisited a role that
//      already has a taught pose"; the pose is KEPT until Record.
//   3. Frame validation — after any ①②③ record, verify the frame
//      geometry (orthogonality, tilt) and surface a warning when
//      the numbers get worse. Runs pre-advance so the operator sees
//      what changed before the flow moves on.

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


// ── Frame validation ────────────────────────────────────────────
//
// Runs any time ①②③ get (re-)recorded. Compares the just-taught
// frame against two geometric expectations:
//   * ROW ⊥ COL — the vectors c1→c2 and c1→c3 should be roughly
//     perpendicular. Deviation > 5° is worth surfacing.
//   * Frame not tilted — |Z| of each edge relative to its length
//     should stay small (< 5%). Anything larger means the taught
//     poses aren't co-planar with the pallet surface, which
//     invalidates the flat-grid slot derivation.
//
// Returns [] when the frame is fine or when fewer than the three
// corners are taught (nothing to check). Each warning is
// {key, message, numbers}: `key` lets the UI de-dupe and pin tests
// look up by name; `numbers` is a compact object the UI can format.

function has6(v) { return Array.isArray(v) && v.length >= 6 }

function sub3(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]] }
function len3(v)    { return Math.hypot(v[0], v[1], v[2]) }
function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }

export function validatePalletFrame(place) {
  const warnings = []
  if (!place) return warnings
  const c1 = place.corner1_tcp
  const c2 = place.corner2_tcp
  const c3 = place.corner3_tcp
  if (!(has6(c1) && has6(c2) && has6(c3))) return warnings
  const row = sub3(c2, c1)   // c1 → c2
  const col = sub3(c3, c1)   // c1 → c3
  const rowLen = len3(row)
  const colLen = len3(col)
  if (rowLen < 1 || colLen < 1) {
    warnings.push({
      key: 'degenerate',
      message: 'Row or column vector has near-zero length — corners appear coincident.',
      numbers: { rowLenMm: rowLen, colLenMm: colLen },
    })
    return warnings
  }
  // ROW ⊥ COL — angular deviation from 90°.
  const cosA = dot3(row, col) / (rowLen * colLen)
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI
  const orthoDev = Math.abs(angleDeg - 90)
  if (orthoDev > 5) {
    warnings.push({
      key: 'orthogonality',
      message: `Row and column not perpendicular — measured ${angleDeg.toFixed(1)}°, `
             + `off by ${orthoDev.toFixed(1)}° from 90°.`,
      numbers: { angleDeg, orthoDev },
    })
  }
  // Tilt — |Z| component vs total edge length. > 5% is worth flagging.
  const rowTilt = Math.abs(row[2]) / rowLen
  const colTilt = Math.abs(col[2]) / colLen
  if (rowTilt > 0.05 || colTilt > 0.05) {
    warnings.push({
      key: 'tilt',
      message: `Frame is tilted off the XY plane — row Z/L=${(rowTilt*100).toFixed(1)}%, `
             + `col Z/L=${(colTilt*100).toFixed(1)}% (>5% threshold).`,
      numbers: { rowTilt, colTilt },
    })
  }
  return warnings
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

// teachingDebt — the single "what still needs teaching?" resolver.
//
// 2026-07-31 consolidation: the editor used to render TWO banners —
// a red "N positions not taught" banner (untaught step count) and a
// blue "re-teach ④" info nudge (legacy pallet migration). The
// operator directive: those are one concern. Merge them behind ONE
// resolver + ONE banner so the count reflects reality (untaught
// steps + owed re-teaches) and the color carries the nuance.
//
// Shape returned by computeTeachingDebt(program):
//
//   {
//     stepIds:        number[]                   // required (blocking)
//     palletReTeaches: [{ role, reason, findingId }]   // quality (info)
//     total:          number      // stepIds.length + palletReTeaches.length
//     severity:       'error' | 'warn' | null
//   }
//
// Severity:
//   * 'error' — any untaught STEP is present. Program won't run.
//     Banner renders red; Teach All button is required.
//   * 'warn'  — every step is taught but at least one re-teach is
//     owed. Program runs; the operator can improve it.
//   * null    — no debt. Banner is hidden.

import { untaughtStepIds, palletFrameStatus } from './programTruth.js'
import { PALLET_ROLE_ORDER, PALLET_ROLE_TO_STATUS_KEY }
  from './palletTeachSequence.js'


// A program is a "pallet program" when its config exposes a pallet
// block — either the v2 pallet_place shape or the legacy pallet
// dict. Non-pallet programs never owe corner teaches.
function isPalletProgram(program) {
  const cfg = (program && program.config) || {}
  const p1 = cfg.pallet_place
  const p2 = cfg.pallet
  const hasBlock = (b) => b && typeof b === 'object'
    && (Number.isFinite(Number(b.rows)) || Number.isFinite(Number(b.cols))
        || Number.isFinite(Number(b.pitch_row_mm))
        || Number.isFinite(Number(b.pitch_col_mm))
        || 'corner1_tcp' in b || 'corner_a_tcp' in b || 'corner_tcp' in b)
  return hasBlock(p1) || hasBlock(p2)
}


// Every untaught pallet frame point on a pallet program is an owed
// teach. Adds the ④ re-teach reason ONLY when a legacy v1→v2
// migration is in play — the corners that migrate cleanly are marked
// "taught" by palletFrameStatus, so they don't double-up.
function palletReTeachesFor(program) {
  if (!isPalletProgram(program)) return []
  const fs = palletFrameStatus(program)
  const out = []
  for (const role of PALLET_ROLE_ORDER) {
    const key = PALLET_ROLE_TO_STATUS_KEY[role]
    if (fs[key]) continue    // corner is (validly) taught → no debt
    const isMigrationPart = fs.migratedFromV1 && role === 'pallet_part'
    out.push({
      role,
      findingId: isMigrationPart ? 'pallet-legacy-migration' : null,
      reason: isMigrationPart
        ? 'seeded from corner A during migration — teach with a '
          + 'real part in slot [1,1]'
        : 'pallet frame point not yet taught',
    })
  }
  return out
}


export function computeTeachingDebt(program) {
  const stepIds = untaughtStepIds(program) || []
  const palletReTeaches = palletReTeachesFor(program)
  // Future re-teaches (analyzer-flagged, quality signals) append here.
  const total = stepIds.length + palletReTeaches.length
  const severity = (stepIds.length > 0 || palletReTeaches.length > 0)
                 && (stepIds.length > 0 || palletReTeaches.some(
                     (r) => r.findingId !== 'pallet-legacy-migration'))
    ? 'error'
    : (palletReTeaches.length > 0 ? 'warn' : null)
  return { stepIds, palletReTeaches, total, severity }
}


// Text used by the banner. Kept here so the banner's copy and the
// pinned test stay in sync.
export function debtBannerLabel(debt) {
  if (!debt || debt.total === 0) return ''
  const noun = debt.total === 1 ? 'position needs' : 'positions need'
  return `${debt.total} ${noun} teaching`
}

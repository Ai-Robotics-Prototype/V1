// collisionPresentation — decides HOW self-collision proximity gets
// shown to the operator. Owns the two-tier presentation rule from
// §396 (2026-07-31 ships):
//
//   WARN ZONE  (dist ≤ warn AND dist > stop)
//     → slim non-blocking banner with live distance.
//     → per-pair session mute available.
//     → toggleable off entirely via the Safety-page switch.
//     → NEVER a modal. Jog / teach / drag flow unaffected.
//
//   STOP ZONE  (dist ≤ stop)
//     → modal + escape jogs (ObstacleEscapeModal).
//     → NOT gated by the banner toggle — this is the last line
//       of defense.
//     → during drag-active, the modal is suppressed (the driver's
//       motion-block still applies) — a screen-blocking dialog
//       mid-hand-guide is worse UX than a jog block.
//
// This module owns the DECISION only. The banner + modal components
// are the RENDERERS. Both consume presentDecision() so a rule change
// touches one place.

const HYSTERESIS_MM_DEFAULT = 5.0

export const PAIR_MUTE_SEPARATOR = '↔'

// Canonical mute key so [a,b] and [b,a] map to the same session
// mute. Sorted so the key is stable regardless of driver-report order.
export function pairMuteKey(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return null
  const a = String(pair[0])
  const b = String(pair[1])
  return a < b ? `${a}${PAIR_MUTE_SEPARATOR}${b}` : `${b}${PAIR_MUTE_SEPARATOR}${a}`
}

// Return { show, level, reason } for the given proximity state.
//   show   — 'none' | 'banner' | 'modal'
//   level  — 'near' | 'warn' | 'stop' | null
//   reason — one of the tags used by the pinned tests
//            ('below-stop' | 'in-warn' | 'above-warn' | 'unknown'
//             | 'muted' | 'banner-off' | 'drag-suppresses-modal')
//
// Inputs:
//   distMm       — current min distance in mm (null when unknown)
//   warnMm       — active warn threshold in mm
//   stopMm       — active stop threshold in mm
//   pair         — [linkA, linkB] or null
//   pairMuted    — boolean; caller resolves via pairMuteKey + a Set
//   bannerOn     — Safety-page toggle for the banner layer only
//   dragActive   — controller in drag mode (from the drag task's
//                  bench-verified signal); when true, modal is
//                  suppressed even in the stop zone.
export function presentDecision({
  distMm, warnMm, stopMm, pair,
  pairMuted = false,
  bannerOn = true,
  dragActive = false,
}) {
  // Nothing to say when we can't read distance.
  if (distMm == null || warnMm == null || stopMm == null) {
    return { show: 'none', level: null, reason: 'unknown' }
  }
  if (distMm <= stopMm) {
    // Stop zone. Modal owns this — unless the operator is
    // hand-guiding, in which case the driver's motion-block is
    // enough and a modal on top is punishment.
    if (dragActive) {
      return { show: 'banner', level: 'stop', reason: 'drag-suppresses-modal' }
    }
    return { show: 'modal', level: 'stop', reason: 'below-stop' }
  }
  if (distMm <= warnMm) {
    // Warn zone. Non-blocking banner — unless the operator muted
    // this pair for the session or turned banners off entirely.
    if (!bannerOn) {
      return { show: 'none', level: 'warn', reason: 'banner-off' }
    }
    if (pairMuted) {
      return { show: 'none', level: 'warn', reason: 'muted' }
    }
    return { show: 'banner', level: 'warn', reason: 'in-warn' }
  }
  return { show: 'none', level: 'near', reason: 'above-warn' }
}


// Copy for the banner. Compact: "linkA↔linkB: 48 mm" — see the
// directive's exact example. Shortens common link suffixes so the
// banner reads at a glance ("link3↔link5" over the fully qualified
// URDF names).
export function bannerLabel(pair, distMm) {
  const shorten = (n) => String(n || '')
    .replace('_shoulder',  '')
    .replace('_upper_arm', '')
    .replace('_forearm',   '')
    .replace('_wrist1',    '')
    .replace('_wrist2',    '')
    .replace('_flange',    '')
    .replace('__ground__', 'ground')
    .replace(/^zone#/, 'zone:')
  const a = shorten(pair?.[0]) || '?'
  const b = shorten(pair?.[1]) || '?'
  const d = Number.isFinite(distMm) ? `${distMm.toFixed(0)} mm` : '—'
  return `${a}${PAIR_MUTE_SEPARATOR}${b}: ${d}`
}


// Hysteresis for the modal's session latch — exposed for callers
// that want to reuse the same margin. Default 5 mm keeps the popup
// from thrashing on jitter near the stop threshold.
export const HYSTERESIS_MM = HYSTERESIS_MM_DEFAULT

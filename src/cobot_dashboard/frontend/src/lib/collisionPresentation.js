// collisionPresentation — decides HOW proximity gets shown.
//
// 2026-08-05 (operator directive: clearance warnings OFF).
// The soft warn tier is disabled by directive. presentDecision
// NEVER returns show='banner' anywhere in this codebase; the
// WARN ZONE path returns show='none' unconditionally. The
// stop-zone modal path is preserved only for env-obstacle
// (guard_kind='env'); self and ground hard-stops are surfaced
// via a global toast keyed off robot.stop_cause_copy (fork
// registry: jog_stop_cause_propagation — the canonical
// translator lives in _jog_stop_cause_operator_copy).
//
// Pre-directive doctrine (kept here for the archaeology):
//
//   WARN ZONE  (dist ≤ warn AND dist > stop)
//     → non-blocking banner with live distance. [DISABLED]
//
//   STOP ZONE  (dist ≤ stop)
//     → modal + escape jogs (ObstacleEscapeModal). [ENV ONLY]
//     → self/ground now surface as a toast, not a modal —
//       the operator explicitly asked for a single dismissable
//       signal, not a screen-blocking dialog.

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
  distMm, warnMm, stopMm,
  // Pre-directive params retained for signature stability so the
  // existing callers (SelfCollisionWarnBanner, ObstacleEscapeModal)
  // don't need signature edits. They're ignored below: the warn
  // tier is OFF, so pair / mute / bannerOn / dragActive have no
  // presentation effect any more.
  pair,               // eslint-disable-line no-unused-vars
  pairMuted = false,  // eslint-disable-line no-unused-vars
  bannerOn = true,    // eslint-disable-line no-unused-vars
  dragActive = false, // eslint-disable-line no-unused-vars
}) {
  // Nothing to say when we can't read distance.
  if (distMm == null || stopMm == null) {
    return { show: 'none', level: null, reason: 'unknown' }
  }
  // Stop zone → modal (env only — self/ground callers gate on
  // guard_kind themselves; see ObstacleEscapeModal).
  if (distMm <= stopMm) {
    return { show: 'modal', level: 'stop', reason: 'below-stop' }
  }
  // 2026-08-05 (clearance warnings OFF): warn band never renders.
  // Left as an explicit 'warn-off' reason so a pinned test can
  // assert nothing but 'none' ever falls out of the warn range.
  if (warnMm != null && distMm <= warnMm) {
    return { show: 'none', level: 'warn', reason: 'warn-tier-off' }
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

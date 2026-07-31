// SelfCollisionWarnBanner — the non-blocking warn-zone presentation
// (§396, 2026-07-31).
//
// One thin amber strip at the top of the app when a self-collision
// pair is inside the warn band. Dismissible per-pair for the current
// session; the Safety-page toggle can hide the whole layer.
//
// The STOP-zone modal (ObstacleEscapeModal) is a separate component
// and is NOT gated by the toggle — see collisionPresentation.js for
// the decision rule that keeps the two in sync.
//
// This banner reads live driver state, so the distance updates in
// place as the arm moves.

import { useStore } from '../store/useStore'
import { presentDecision, pairMuteKey, bannerLabel }
  from '../lib/collisionPresentation'


export default function SelfCollisionWarnBanner() {
  // Unified guard state (self / ground / env aggregated by the
  // driver). Fall back to the legacy self-collision keys for driver
  // builds pre-guard-unification. ALL useStore hooks called
  // unconditionally at the top so hook order stays stable across
  // renders (React #300 lessons: no ||/?? between hook calls).
  const guardPair    = useStore((s) => s.robot?.guard_pair)
  const collisionPair = useStore((s) => s.robot?.collision_pair)
  const guardMin     = useStore((s) => s.robot?.guard_min_mm)
  const collisionMin = useStore((s) => s.robot?.collision_min_mm)
  const guardWarn    = useStore((s) => s.robot?.guard_warn_mm)
  const collisionWarn = useStore((s) => s.robot?.collision_warn_mm)
  const guardStop    = useStore((s) => s.robot?.guard_stop_mm)
  const collisionStop = useStore((s) => s.robot?.collision_stop_mm)
  const collisionEnabled = useStore((s) => s.robot?.collision_enabled)
  const dragActive   = useStore((s) => !!s.robot?.drag_active)

  const bannerOn     = useStore((s) => s.selfCollisionBannerEnabled)
  const mutedPairs   = useStore((s) => s.mutedCollisionPairs)
  const muteCollisionPair = useStore((s) => s.muteCollisionPair)

  const pair    = guardPair || collisionPair
  const distMm  = guardMin != null ? guardMin : collisionMin
  const warnMm  = guardWarn || collisionWarn
  const stopMm  = guardStop || collisionStop
  const muteKey = pairMuteKey(pair)
  const pairMuted = !!(muteKey && mutedPairs && mutedPairs.has(muteKey))

  if (!collisionEnabled) return null

  const decision = presentDecision({
    distMm, warnMm, stopMm, pair,
    pairMuted, bannerOn, dragActive,
  })
  if (decision.show !== 'banner') return null

  // Stop-zone-while-dragging edge: the resolver hands us a banner
  // (not a modal) in that case, but paint it red so the operator
  // sees the severity even though we're not popping the modal.
  const isStopWhileDrag = decision.level === 'stop'
  const bg     = isStopWhileDrag ? '#7F1D1D' : '#78350F'
  const border = isStopWhileDrag ? '#FCA5A5' : '#F59E0B'
  const fg     = '#FFF7ED'

  return (
    <div
      data-testid="self-collision-warn-banner"
      data-level={decision.level}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        zIndex: 3500,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '4px 12px',
        background: bg, color: fg,
        borderBottom: `1px solid ${border}`,
        fontSize: 12, fontWeight: 700,
        fontFamily: 'var(--font-mono, monospace)',
        letterSpacing: 0.4,
      }}>
      <span aria-hidden="true">⚠</span>
      <span data-testid="self-collision-warn-banner-label">
        {bannerLabel(pair, distMm)}
      </span>
      {isStopWhileDrag && (
        <span style={{
          fontWeight: 600, opacity: 0.85, letterSpacing: 0.2,
          fontFamily: 'inherit',
        }}>
          hand-guiding — motion blocked by controller
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button
        data-testid="self-collision-warn-banner-mute"
        onClick={() => muteCollisionPair(muteKey)}
        title={`Mute ${muteKey} for this session. Refresh to re-enable.`}
        style={{
          padding: '2px 10px', fontSize: 11, fontWeight: 600,
          background: 'transparent',
          color: fg, border: `1px solid ${border}`,
          borderRadius: 4, cursor: 'pointer',
        }}>
        Mute pair
      </button>
    </div>
  )
}

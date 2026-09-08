import { useStore } from '../store/useStore'

// 2026-09-08 operator directive (footer removal, revised): problem
// states surface as banners ONLY when bad. Healthy = nothing shown.
// Two banners live here:
//   * Self-collision guard OFF — mirrors the always-visible red
//     badge from the guard row's own rendering; a global banner
//     surfaces it on every screen so a basic device on a page
//     without the guard row (Monitor / I/O / Event Log) still
//     sees the state and can navigate to un-hide it.
//   * WS disconnected — driver has stopped publishing /ws/state.
//     Same trigger the retired footer "Offline" dot used. Amber
//     for 'connecting', red for 'disconnected'; hidden when
//     'connected'.
//
// Both banners are non-dismissible: their condition is what
// dismisses them. Kept small (top of viewport, single line each)
// so they don't compete with the app-critical modals
// (E-STOP, AlarmRecoveryModal, StaleGuard).
export default function SystemBanners() {
  const wsStatus    = useStore((s) => s.wsStatus)
  const collision   = useStore((s) => s.robot?.collision_enabled)
  const modelLoaded = useStore((s) => s.robot?.collision_model_loaded)

  // Nothing to say when everything is healthy.
  const wsBad = wsStatus === 'disconnected' || wsStatus === 'connecting'
  const guardOff = collision === false   // strict === false, not null (unknown)
  if (!wsBad && !guardOff) return null

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      zIndex: 200, display: 'flex', flexDirection: 'column',
      pointerEvents: 'none',
    }}>
      {wsBad && (
        <div
          data-testid="banner-ws-status"
          data-status={wsStatus}
          style={{
            padding: '6px 14px',
            background: wsStatus === 'disconnected' ? '#7F1D1D' : '#78350F',
            color: '#FFF7ED',
            fontSize: 12, fontWeight: 600,
            letterSpacing: '0.03em',
            textAlign: 'center',
            borderBottom: '1px solid rgba(0,0,0,0.25)',
            pointerEvents: 'auto',
          }}>
          {wsStatus === 'disconnected'
            ? 'Dashboard disconnected from the driver — no live state.'
            : 'Reconnecting to the driver…'}
        </div>
      )}
      {guardOff && (
        <div
          data-testid="banner-guard-off"
          data-model-loaded={modelLoaded ? 'true' : 'false'}
          style={{
            padding: '6px 14px',
            background: '#7F1D1D', color: '#FCA5A5',
            fontSize: 12, fontWeight: 700,
            letterSpacing: '0.03em',
            textAlign: 'center',
            borderBottom: '1px solid rgba(0,0,0,0.25)',
            pointerEvents: 'auto',
          }}>
          <span aria-hidden="true"
                style={{
                  display: 'inline-block', width: 8, height: 8,
                  borderRadius: '50%', background: '#EF4444',
                  marginRight: 8, verticalAlign: 'middle',
                }} />
          Self-collision guard is OFF — link-on-link and ground crashes are not prevented in software.
        </div>
      )}
    </div>
  )
}

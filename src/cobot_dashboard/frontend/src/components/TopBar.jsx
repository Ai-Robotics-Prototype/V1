import { useStore } from '../store/useStore'
import Brand from './Brand'
import { isFeatureEnabled, TAB_TO_FEATURE } from '../lib/edition'
import UserChip from './UserChip'

const TABS = [
  { id: 'monitor',          label: 'Monitor' },
  { id: 'programs',         label: 'Program Library' },
  { id: 'program',          label: 'Program' },
  { id: '3dview',           label: '3D View' },
  { id: 'sensors',          label: 'Cameras & LiDAR' },
  { id: 'adaptive_picking', label: 'Part Recognition' },
  { id: 'io',               label: 'I/O' },
  { id: 'safety',           label: 'Safety' },
  // 2026-08-05 unified event log (fork registry: event_log).
  // Persistent forensic record of every error/warning/info the
  // platform surfaces. Sits under Safety in nav order so operators
  // reach for it in the "something went wrong" mental sequence.
  { id: 'event_log',        label: 'Event Log' },
  { id: 'configure',        label: 'Configure' },
]

const WS_DOT = {
  connected:    '#22C55E',
  connecting:   '#EAB308',
  disconnected: '#EF4444',
}

export default function TopBar() {
  const activeTab    = useStore((s) => s.activeTab)
  const setTab       = useStore((s) => s.setTab)
  const wsStatus     = useStore((s) => s.wsStatus)
  const estop        = useStore((s) => s.safety.estop)
  const triggerEstop = useStore((s) => s.triggerEstop)
  const releaseEstop = useStore((s) => s.releaseEstop)
  const edition      = useStore((s) => s.edition)
  // Fleet-home affordances (2026-09-21 operator directive).
  //   * `fleetTotal > 1` → render the "Fleet" chip so the operator
  //     can return to the grid from any tab.
  //   * `robotIdentity.friendly_name` labels the E-STOP so the
  //     operator on the connected dashboard always knows which
  //     robot they're stopping — E-STOP stays per-robot and never
  //     migrates to the fleet grid (safety invariant).
  const fleetTotal   = useStore((s) => s.fleetTotal)
  const robotName    = useStore((s) => s.robotIdentity?.friendly_name) || ''

  // Edition filter (2026-09-04): tabs not in this edition's feature
  // map render NOTHING (not disabled-greyed — absent). Safety is
  // edition-INDEPENDENT and left unmapped in TAB_TO_FEATURE, so
  // isFeatureEnabled returns true for every edition on that key.
  const visibleTabs = TABS.filter((tab) => {
    const feature = TAB_TO_FEATURE[tab.id] || tab.id
    return isFeatureEnabled(feature, edition)
  })

  // Safety: trigger fires on the first tap with no confirmation — an
  // emergency stop must act with zero delay. Release stays guarded by
  // the store's releaseEstop() (requires zone=GREEN), so an active
  // E-STOP can't be un-stopped by an accidental tap.
  function handleEstopClick() {
    if (estop) {
      releaseEstop()
    } else {
      triggerEstop()
    }
  }

  return (
    <div style={{
      width: '100%',
      maxWidth: '100%',
      height: '100%',
      boxSizing: 'border-box',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: 8,
      userSelect: 'none',
      overflow: 'hidden',
      minWidth: 0,
    }}>
      {/* Left: brand */}
      <div style={{ flexShrink: 0, fontSize: 14, color: 'var(--accent)', paddingRight: 8 }}>
        <Brand />
      </div>

      {/* Back-to-fleet chip. Renders only when the registry holds >1
          robot — a single-robot install NEVER sees this affordance
          (single-robot-skips-grid). Cross-origin-safe: navigates the
          CURRENT origin to ?view=fleet, so the fleet grid re-renders
          on the robot the operator is already looking at. From there
          they can pick another robot's dashboard. */}
      {fleetTotal > 1 && (
        <button
          type="button"
          data-testid="topbar-fleet-chip"
          onClick={() => {
            try {
              const url = new URL(window.location.href)
              url.searchParams.set('view', 'fleet')
              window.location.href = url.toString()
            } catch (_) {
              window.location.href = '/?view=fleet'
            }
          }}
          title="Back to fleet grid"
          style={{
            flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(47,127,255,0.10)',
            color: 'var(--text-primary)',
            border: '1px solid rgba(47,127,255,0.35)',
            fontSize: 13, fontWeight: 700,
            padding: '8px 14px', borderRadius: 8,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          <span aria-hidden="true">←</span>
          <span>Fleet</span>
        </button>
      )}

      {/* Centre: tab pills. The strip scrolls horizontally on narrow
          viewports — no-scrollbar hides the visible bar so the pill
          height isn't reduced. The brand on the left and the right
          cluster are flexShrink: 0 so they can't be squeezed. */}
      <nav className="no-scrollbar" style={{
        flex: '1 1 0',
        width: 0,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 6,
        padding: '4px 8px',
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
      }}>
        {visibleTabs.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              style={{
                background: active ? 'rgba(47,127,255,0.14)' : 'transparent',
                border:     active ? '1px solid rgba(47,127,255,0.45)' : '1px solid transparent',
                color:      active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 16,
                fontWeight: active ? 700 : 500,
                padding: '12px 22px',
                minHeight: 50,
                borderRadius: 10,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                transition: 'background 120ms, border-color 120ms, color 120ms',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              {tab.label}
            </button>
          )
        })}
      </nav>

      {/* Right: user chip + WS status + E-STOP */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        {/* Auth-model pivot (add-61 §690): user chip shows the
            signed-in username + sign-out, or a "Sign in"
            affordance under enforced+unauth, or nothing under
            dev posture with no session. */}
        <UserChip />
        {/* WS indicator — fixed width so the centred tabs never shift
            when the status text or latency digit-count changes. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: WS_DOT[wsStatus] ?? '#9A9A9E',
            display: 'inline-block',
            boxShadow: wsStatus === 'connected' ? `0 0 4px ${WS_DOT.connected}` : 'none',
            flexShrink: 0,
          }} />
          <span style={{ display: 'inline-block', minWidth: 72, textAlign: 'left' }}>
            {wsStatus === 'connected' ? 'Connected' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}
          </span>
        </div>

        {/* 2026-08-31 directive: latency ms chip retired from the
            header. wsLatency is still tracked in the store for
            diagnostics and remains in the footer (StatusBar) at
            reduced prominence; the header stays as identity /
            connection dot / E-STOP. */}

        {/* E-STOP — fires on first tap (no confirm). Sized large for
            safety: it must be the most prominent control in the row.
            Robot-name subtitle renders ONLY under a multi-robot
            registry (fleetTotal > 1), matching the Fleet chip gate —
            wrong-robot confusion is a multi-robot problem and the
            subtitle solves it there. Single-robot dashboards render
            E-STOP exactly as they did pre-fleet (no subtitle, no
            column-flex layout, no name in the title). Operator
            correction 2026-09-21. */}
        <button
          data-testid="topbar-estop"
          data-robot-name={robotName || ''}
          data-multi-robot={String(fleetTotal > 1)}
          onClick={handleEstopClick}
          title={
            fleetTotal > 1
              ? (estop
                  ? `E-Stop active on ${robotName || 'this robot'}`
                    + ' — click to release (requires green zone)'
                  : `Click to trigger emergency stop on ${robotName || 'this robot'}`)
              : (estop
                  ? 'E-Stop active — click to release (requires green zone)'
                  : 'Click to trigger emergency stop')
          }
          style={{
            background: '#DC2626',
            border: 'none',
            color: '#fff',
            fontSize: 18,
            fontWeight: 700,
            padding: '14px 32px',
            minHeight: 56,
            borderRadius: 10,
            cursor: 'pointer',
            // Column-flex layout is a fleet-context enhancement (it
            // makes room for the subtitle). Single-robot dashboards
            // keep the pre-fleet default button layout.
            ...(fleetTotal > 1
              ? { display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  lineHeight: 1.05 }
              : {}),
            animation: estop ? 'pulse-opacity 1s ease-in-out infinite' : 'none',
            letterSpacing: '0.06em',
            boxShadow: '0 2px 6px rgba(220,38,38,0.35)',
          }}
        >
          {fleetTotal > 1 ? (
            <>
              <span>{estop ? 'ESTOP ACTIVE' : 'E-STOP'}</span>
              {robotName && (
                <span
                  data-testid="topbar-estop-robot-subtitle"
                  style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                    opacity: 0.85, marginTop: 2, textTransform: 'uppercase',
                  }}
                >
                  {robotName}
                </span>
              )}
            </>
          ) : (
            estop ? 'ESTOP ACTIVE' : 'E-STOP'
          )}
        </button>
      </div>
    </div>
  )
}

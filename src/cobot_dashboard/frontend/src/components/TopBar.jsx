import { useState } from 'react'
import { useStore } from '../store/useStore'

const TABS = [
  { id: 'monitor',          label: 'Monitor' },
  { id: 'programs',         label: 'Program Library' },
  { id: 'program',          label: 'Program' },
  { id: '3dview',           label: '3D View' },
  { id: 'sensors',          label: 'Cameras & LiDAR' },
  { id: 'adaptive_picking', label: 'Part Recognition' },
  { id: 'io',               label: 'I/O' },
  { id: 'safety',           label: 'Safety' },
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
  const wsLatency    = useStore((s) => s.wsLatency)
  const estop        = useStore((s) => s.safety.estop)
  const triggerEstop = useStore((s) => s.triggerEstop)
  const releaseEstop = useStore((s) => s.releaseEstop)

  const [confirming, setConfirming] = useState(false)

  function handleEstopClick() {
    if (estop) {
      releaseEstop()
    } else {
      setConfirming(true)
    }
  }

  function confirmEstop() {
    setConfirming(false)
    triggerEstop()
  }

  return (
    <div style={{
      height: '100%',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: 8,
      userSelect: 'none',
    }}>
      {/* Left: brand */}
      <div style={{ width: 64, flexShrink: 0, fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>
        RoboAi
      </div>

      {/* Centre: tab pills. The strip scrolls horizontally on narrow
          viewports — no-scrollbar hides the visible bar so the pill
          height isn't reduced. The brand on the left and the right
          cluster are flexShrink: 0 so they can't be squeezed. */}
      <nav className="no-scrollbar" style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 6,
        padding: '4px 8px',
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              style={{
                background: active ? 'rgba(47,127,255,0.14)' : 'transparent',
                border:     active ? '1px solid rgba(47,127,255,0.45)' : '1px solid transparent',
                color:      active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 14,
                fontWeight: active ? 700 : 500,
                padding: '10px 18px',
                minHeight: 44,
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

      {/* Right: WS status + E-STOP */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
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

        {/* Latency — always rendered (visibility-hidden when disconnected)
            so its width is reserved and the tabs don't reflow. */}
        <span style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
          display: 'inline-block',
          minWidth: 52,
          textAlign: 'right',
          visibility: wsStatus === 'connected' ? 'visible' : 'hidden',
        }}>
          {wsLatency} ms
        </span>

        {/* E-STOP button / inline confirm */}
        {confirming ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Trigger E-Stop?</span>
            <button
              onClick={() => setConfirming(false)}
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirmEstop}
              style={{
                background: '#DC2626',
                border: 'none',
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Confirm
            </button>
          </div>
        ) : (
          <button
            onClick={handleEstopClick}
            title={
              estop
                ? 'E-Stop active — click to release (requires green zone)'
                : 'Click to trigger emergency stop'
            }
            style={{
              background: '#DC2626',
              border: 'none',
              color: '#fff',
              fontSize: 14,
              fontWeight: 700,
              padding: '10px 22px',
              minHeight: 44,
              borderRadius: 8,
              cursor: 'pointer',
              animation: estop ? 'pulse-opacity 1s ease-in-out infinite' : 'none',
              letterSpacing: '0.04em',
            }}
          >
            {estop ? 'ESTOP ACTIVE' : 'E-STOP'}
          </button>
        )}
      </div>
    </div>
  )
}

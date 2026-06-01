import { useState } from 'react'
import { useStore } from '../store/useStore'

const TABS = [
  { id: 'monitor',          label: 'Monitor' },
  { id: 'program',          label: 'Program' },
  { id: '3dview',           label: '3D View' },
  { id: 'sensors',          label: 'Sensors' },
  { id: 'adaptive_picking', label: 'Adaptive Picking' },
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
      <div style={{ width: 52, flexShrink: 0, fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>
        RoboAi
      </div>

      {/* Centre: tab pills */}
      <nav style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 2 }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: active ? '2px solid #fff' : '2px solid transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: active ? 500 : 400,
                padding: '0 14px',
                height: 48,
                cursor: 'pointer',
                transition: 'color 150ms',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </nav>

      {/* Right: WS status + E-STOP */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* WS indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: WS_DOT[wsStatus] ?? '#9A9A9E',
            display: 'inline-block',
            boxShadow: wsStatus === 'connected' ? `0 0 4px ${WS_DOT.connected}` : 'none',
          }} />
          {wsStatus === 'connected' ? 'Connected' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}
        </div>

        {/* Latency */}
        {wsStatus === 'connected' && (
          <span style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {wsLatency} ms
          </span>
        )}

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
              fontSize: 12,
              fontWeight: 500,
              padding: '5px 16px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              animation: estop ? 'pulse-opacity 1s ease-in-out infinite' : 'none',
              letterSpacing: '0.02em',
            }}
          >
            {estop ? 'ESTOP ACTIVE' : 'E-STOP'}
          </button>
        )}
      </div>
    </div>
  )
}

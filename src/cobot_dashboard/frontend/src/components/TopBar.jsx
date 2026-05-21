import { useStore } from '../store/useStore'

const TABS = [
  { id: 'monitor',   label: 'Monitor'   },
  { id: 'scene',     label: 'Scene'     },
  { id: 'program',   label: 'Program'   },
  { id: 'sensors',   label: 'Sensors'   },
  { id: 'configure', label: 'Configure' },
]

export default function TopBar({ tab, onTabChange }) {
  const connected    = useStore((s) => s.connected)
  const wsLatency    = useStore((s) => s.wsLatency)
  const safety       = useStore((s) => s.safety)
  const triggerEstop = useStore((s) => s.triggerEstop)
  const releaseEstop = useStore((s) => s.releaseEstop)

  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 0,
      height: 48, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
      paddingLeft: 16, paddingRight: 12,
      zIndex: 100,
    }}>
      {/* Wordmark */}
      <div style={{
        fontWeight: 600, fontSize: 15, letterSpacing: -0.3,
        color: 'var(--accent)', marginRight: 20, flexShrink: 0,
        fontFamily: 'var(--font)',
      }}>
        RoboAi
      </div>

      {/* Tab navigation */}
      <nav style={{ display: 'flex', height: '100%', gap: 0 }}>
        {TABS.map((t) => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              style={{
                height: '100%', padding: '0 16px',
                border: 'none', borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: active ? 600 : 400,
                cursor: 'pointer', transition: 'all .15s',
                marginBottom: active ? 0 : 0,
              }}
            >
              {t.label}
            </button>
          )
        })}
      </nav>

      <div style={{ flex: 1 }} />

      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 14 }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: connected ? 'var(--green)' : 'var(--text-muted)',
          boxShadow: connected ? '0 0 5px var(--green)' : 'none',
          transition: 'all .3s',
        }} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {connected ? 'Connected' : 'Offline'}
        </span>
        {connected && wsLatency > 0 && (
          <span style={{
            fontSize: 10, padding: '1px 5px', borderRadius: 10,
            background: 'var(--bg-surface)', color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}>
            {wsLatency}ms
          </span>
        )}
      </div>

      {/* E-STOP button */}
      <button
        onClick={() => safety.estop ? releaseEstop() : triggerEstop()}
        style={{
          padding: '7px 16px', borderRadius: 6,
          border: safety.estop ? '2px solid var(--zone-estop)' : '2px solid var(--red)',
          background: safety.estop ? 'var(--zone-estop)' : 'var(--red)',
          color: '#fff', fontSize: 12, fontWeight: 700,
          letterSpacing: '.05em', cursor: 'pointer',
          animation: safety.estop ? 'estopPulse 1s ease infinite' : 'none',
          transition: 'background .15s, border-color .15s',
        }}
      >
        {safety.estop ? '▪ STOPPED' : '⬛ E-STOP'}
      </button>
    </header>
  )
}

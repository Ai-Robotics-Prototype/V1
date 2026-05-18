import { useStore } from '../store'

const VIEWS = ['camera', 'lidar', 'split', 'scene']
const LABELS = { camera: 'Camera', lidar: 'LiDAR', split: 'Split', scene: 'Scene' }

export default function TopBar() {
  const { mode, setMode, activeView, setView, wsStatus, wsLatency } = useStore()

  const dotColor = wsStatus === 'connected' ? 'var(--zone-green)'
                 : wsStatus === 'connecting' ? 'var(--zone-yellow)'
                 : 'var(--zone-red)'

  return (
    <div style={styles.bar}>
      {/* Brand */}
      <div style={styles.brand}>
        <span style={styles.name}>RoboAi</span>
        <span style={styles.sub}>Cobot Controller</span>
      </div>

      {/* View tabs */}
      <div style={styles.tabs}>
        {VIEWS.map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{ ...styles.tab, ...(activeView === v ? styles.tabActive : {}) }}
          >
            {LABELS[v]}
          </button>
        ))}
      </div>

      {/* Right: mode + status */}
      <div style={styles.right}>
        <div style={styles.modeToggle}>
          {['operator', 'engineer'].map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{ ...styles.modeBtn, ...(mode === m ? styles.modeBtnActive : {}) }}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <div style={styles.latency}>
          <span style={{ color: dotColor, fontSize: 8 }}>●</span>
          <span style={styles.latencyNum}>
            {wsStatus === 'connected' ? `${wsLatency} ms` : wsStatus}
          </span>
        </div>
      </div>
    </div>
  )
}

const styles = {
  bar: {
    height: 56,
    background: 'var(--bg-panel)',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: 16,
    flexShrink: 0,
  },
  brand: { display: 'flex', flexDirection: 'column', gap: 1, width: 140 },
  name:  { fontSize: 18, fontWeight: 500, color: 'var(--text-primary)' },
  sub:   { fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.04em' },
  tabs:  {
    flex: 1, display: 'flex', justifyContent: 'center',
    gap: 4, background: 'var(--bg-surface)',
    borderRadius: 8, padding: 4,
  },
  tab: {
    background: 'transparent', color: 'var(--text-secondary)',
    padding: '5px 16px', borderRadius: 6, fontSize: 13,
    transition: 'background 0.15s, color 0.15s',
  },
  tabActive: {
    background: 'var(--bg-hover)', color: 'var(--text-primary)',
  },
  right: { display: 'flex', alignItems: 'center', gap: 12, width: 200, justifyContent: 'flex-end' },
  modeToggle: {
    display: 'flex', gap: 2,
    background: 'var(--bg-surface)', borderRadius: 6, padding: 2,
  },
  modeBtn: {
    background: 'transparent', color: 'var(--text-secondary)',
    padding: '4px 10px', borderRadius: 4, fontSize: 12,
  },
  modeBtnActive: {
    background: 'var(--bg-hover)', color: 'var(--text-primary)',
  },
  latency: { display: 'flex', alignItems: 'center', gap: 5 },
  latencyNum: { fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' },
}

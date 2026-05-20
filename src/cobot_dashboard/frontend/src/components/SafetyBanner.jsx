import { useStore } from '../store/useStore'

const ZONE_CFG = {
  GREEN:   { bg: 'rgba(0,196,122,.1)',  border: 'rgba(0,196,122,.25)',  color: '#00C47A', label: 'All Clear'          },
  YELLOW:  { bg: 'rgba(245,166,35,.1)', border: 'rgba(245,166,35,.25)', color: '#F5A623', label: 'Slow Zone'          },
  RED:     { bg: 'rgba(255,59,59,.12)', border: 'rgba(255,59,59,.3)',   color: '#FF3B3B', label: 'Stop Zone'          },
  UNKNOWN: { bg: 'rgba(96,96,112,.1)',  border: 'rgba(96,96,112,.2)',   color: '#606070', label: 'Initialising'       },
}

export default function SafetyBanner() {
  const safety       = useStore((s) => s.safety)
  const releaseEstop = useStore((s) => s.releaseEstop)

  const zone = safety.zone ?? 'UNKNOWN'
  const cfg  = ZONE_CFG[zone] ?? ZONE_CFG.UNKNOWN
  const speedPct = Math.round((safety.speed_scale ?? 0) * 100)

  if (!safety.estop && zone === 'GREEN') return null

  return (
    <div style={{
      flexShrink: 0,
      padding: '6px 14px',
      background: safety.estop ? 'rgba(255,59,59,.12)' : cfg.bg,
      borderBottom: `1px solid ${safety.estop ? 'rgba(255,59,59,.35)' : cfg.border}`,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      {/* Zone dot */}
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: safety.estop ? '#FF3B3B' : cfg.color,
        flexShrink: 0,
        animation: safety.estop ? 'safeBlink .8s ease infinite' : 'none',
      }} />

      {/* Status text */}
      <span style={{ fontSize: 11, fontWeight: 700, color: safety.estop ? '#FF3B3B' : cfg.color }}>
        {safety.estop ? 'E-STOP ACTIVE' : `${zone} — ${cfg.label}`}
      </span>

      {/* Speed scale */}
      {!safety.estop && (
        <span style={{ fontSize: 10, color: 'var(--tm)' }}>
          speed {speedPct}%
        </span>
      )}

      {/* Proximity */}
      {(safety.human_proximity ?? 99) < 5 && (
        <span style={{ fontSize: 10, color: cfg.color }}>
          human {safety.human_proximity.toFixed(2)} m
        </span>
      )}

      <div style={{ flex: 1 }} />

      {/* Release button */}
      {safety.estop && (
        <button
          onClick={releaseEstop}
          style={{
            padding: '3px 12px', fontSize: 11, fontWeight: 700, borderRadius: 5,
            border: '1px solid rgba(255,59,59,.5)', background: 'rgba(255,59,59,.15)',
            color: '#FF3B3B', cursor: 'pointer',
          }}>
          Release E-Stop
        </button>
      )}

      <style>{`
        @keyframes safeBlink {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}

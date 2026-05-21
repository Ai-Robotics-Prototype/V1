import { useStore } from '../store/useStore'

const ZONE_CFG = {
  GREEN:   { bg: 'var(--zone-green)',  label: 'SAFE — Full Speed'        },
  YELLOW:  { bg: 'var(--zone-yellow)', label: 'CAUTION — Reduced Speed'  },
  RED:     { bg: 'var(--zone-red)',    label: 'STOP — Human in Zone'     },
  UNKNOWN: { bg: '#6B7280',            label: 'Initialising'              },
}

export default function SafetyBanner() {
  const safety       = useStore((s) => s.safety)
  const releaseEstop = useStore((s) => s.releaseEstop)

  const zone  = safety?.zone ?? 'UNKNOWN'
  const cfg   = ZONE_CFG[zone] ?? ZONE_CFG.UNKNOWN
  const prox  = safety?.human_proximity ?? 99
  const estop = safety?.estop ?? false

  const bg = estop ? 'var(--zone-estop)' : cfg.bg

  return (
    <div style={{
      height: 44, flexShrink: 0,
      background: bg,
      display: 'flex', alignItems: 'center',
      padding: '0 16px', gap: 10,
      transition: 'background .3s',
      animation: estop ? 'safeBlink 1s ease infinite' : 'none',
    }}>
      {/* Status text */}
      <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', letterSpacing: '.03em' }}>
        {estop ? 'E-STOP ACTIVE' : cfg.label}
      </span>

      <div style={{ flex: 1 }} />

      {/* Proximity */}
      {prox < 5 && (
        <span style={{ fontSize: 18, fontWeight: 700, color: '#fff', fontFamily: 'var(--font-mono)' }}>
          {prox.toFixed(2)} m
        </span>
      )}

      {/* Release button */}
      {estop && (
        <button
          onClick={releaseEstop}
          style={{
            padding: '5px 14px', fontSize: 11, fontWeight: 700,
            borderRadius: 5, border: '1px solid rgba(255,255,255,.5)',
            background: 'rgba(255,255,255,.15)', color: '#fff',
            cursor: 'pointer',
          }}
        >
          Release E-Stop
        </button>
      )}
    </div>
  )
}

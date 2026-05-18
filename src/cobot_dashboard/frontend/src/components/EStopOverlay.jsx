import { useStore } from '../store/useStore'

export default function EStopOverlay() {
  const estop        = useStore((s) => s.safety.estop)
  const zone         = useStore((s) => s.safety.zone)
  const proximity    = useStore((s) => s.safety.human_proximity)
  const releaseEstop = useStore((s) => s.releaseEstop)

  if (!estop) return null

  const canRelease = zone === 'GREEN'

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.65)',
      zIndex: 500,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      {/* Card */}
      <div style={{
        width: 420,
        background: 'var(--bg-panel)',
        border: '1px solid var(--red)',
        borderRadius: 12,
        padding: 32,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        {/* Title */}
        <h1 style={{
          fontSize: 24,
          fontWeight: 700,
          color: 'var(--red)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ fontSize: 28 }}>⚠</span>
          E-STOP ACTIVE
        </h1>

        {/* Zone + proximity */}
        <div style={{
          background: 'var(--red-dim)',
          border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: 'var(--radius-md)',
          padding: '10px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 13,
        }}>
          <span style={{ color: 'var(--text-secondary)' }}>Zone</span>
          <span style={{
            fontWeight: 600,
            color: zone === 'GREEN' ? 'var(--green)' : zone === 'YELLOW' ? 'var(--yellow)' : 'var(--red)',
          }}>
            {zone}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>Proximity</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {proximity.toFixed(2)} m
          </span>
        </div>

        {/* Instructions */}
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Move clear of the robot <strong style={{ color: 'var(--text-primary)' }}>({'>'} 1.2 m)</strong> until
          the zone indicator turns green, then press Release.
        </p>

        {/* Zone requirement indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: canRelease ? 'var(--green)' : 'var(--red)',
          fontWeight: 500,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: canRelease ? 'var(--green)' : 'var(--red)',
            display: 'inline-block',
            animation: canRelease ? 'none' : 'pulse-opacity 1s infinite',
          }} />
          {canRelease ? 'Zone is GREEN — safe to release' : 'Requires green zone — clear the area'}
        </div>

        {/* Release button */}
        <button
          onClick={releaseEstop}
          disabled={!canRelease}
          title={!canRelease ? 'Move clear of robot to enable release (> 1.2 m)' : 'Release emergency stop'}
          style={{
            background: canRelease ? '#16A34A' : 'var(--bg-active)',
            border: canRelease ? 'none' : '1px solid var(--border)',
            color: canRelease ? '#fff' : 'var(--text-muted)',
            fontSize: 14,
            fontWeight: 600,
            padding: '12px 24px',
            borderRadius: 'var(--radius-md)',
            cursor: canRelease ? 'pointer' : 'not-allowed',
            opacity: canRelease ? 1 : 0.6,
            transition: 'background 200ms',
            letterSpacing: '0.02em',
          }}
        >
          Release E-Stop
        </button>
      </div>
    </div>
  )
}

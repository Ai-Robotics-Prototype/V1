import { useStore } from '../store/useStore'

// Safety view with proximity ring diagram. Was the 'safety' sub-view
// inside MonitorLayout's sidebar; now its own top-nav tab.
export default function SafetyPage() {
  const safety = useStore((s) => s.safety)
  const { zone, human_proximity, speed_scale, estop } = safety

  const RING_RADII  = [1.2, 0.6, 0.3]
  const RING_COLORS = ['#22C55E', '#EAB308', '#EF4444']
  const SVG_SIZE = 280
  const SCALE = SVG_SIZE / (2 * 1.8)

  const personR = Math.min(human_proximity, 1.8) * SCALE
  const cx = SVG_SIZE / 2
  const cy = SVG_SIZE / 2

  return (
    <div style={{
      width: '100%', height: '100%', background: '#08090c',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 16, padding: 16, overflow: 'auto',
    }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>
        Safety Zone Monitor
      </div>

      <svg width={SVG_SIZE} height={SVG_SIZE}>
        {RING_RADII.map((r, i) => (
          <circle
            key={r}
            cx={cx} cy={cy}
            r={r * SCALE}
            fill="none"
            stroke={RING_COLORS[i]}
            strokeWidth={1.5}
            strokeDasharray={zone === (['GREEN', 'YELLOW', 'RED'][i]) ? '4 3' : 'none'}
            opacity={0.4}
          />
        ))}
        <circle
          cx={cx} cy={cy - personR} r={8}
          fill={zone === 'RED' ? '#EF4444' : zone === 'YELLOW' ? '#EAB308' : '#22C55E'}
          opacity={0.9}
        />
        <rect x={cx - 8} y={cy - 10} width={16} height={20} rx={3} fill="#3B82F6" opacity={0.9} />
        <text x={cx + 1.2 * SCALE + 4} y={cy + 4} fontSize={9} fill="#22C55E" opacity={0.7}>1.2 m</text>
        <text x={cx + 0.6 * SCALE + 4} y={cy + 4} fontSize={9} fill="#EAB308" opacity={0.7}>0.6 m</text>
        <text x={cx + 0.3 * SCALE + 4} y={cy + 4} fontSize={9} fill="#EF4444" opacity={0.7}>0.3 m</text>
      </svg>

      <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>Zone</div>
          <div style={{
            fontWeight: 700, fontSize: 15,
            color: zone === 'GREEN' ? 'var(--green)' : zone === 'YELLOW' ? 'var(--yellow)' : 'var(--red)',
          }}>{zone}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>Proximity</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15 }}>{human_proximity.toFixed(2)} m</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>Speed</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15 }}>{Math.round(speed_scale * 100)}%</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>E-Stop</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: estop ? 'var(--red)' : 'var(--green)' }}>
            {estop ? 'ACTIVE' : 'Clear'}
          </div>
        </div>
      </div>

      {/* 2026-08-05 (operator directive: clearance warnings OFF).
          Warn tier disabled everywhere — no toggle, no per-pair
          mute, no banner. The 15 mm hard self-collision stop and
          the ground-plane hard limit remain active as the physical
          last-resort guard. The only visible collision signal is
          the hard-stop toast. */}
      <div
        data-testid="clearance-warnings-off-row"
        style={{
          marginTop: 24, padding: '10px 14px',
          background: '#111827', border: '1px solid #1f2937',
          borderRadius: 6, color: '#e5e7eb', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 12,
          maxWidth: 520,
        }}>
        <span aria-hidden="true" style={{
          display: 'inline-block', width: 10, height: 10,
          borderRadius: '50%', background: '#6b7280',
        }} />
        <span style={{ fontWeight: 700 }}>
          Clearance warnings: OFF
        </span>
        <div style={{
          flex: 1, fontSize: 11, color: '#9ca3af', lineHeight: 1.45,
        }}>
          The 15 mm hard self-collision stop and the ground-plane
          limit are <b>on</b>. When either fires, jog halts and a
          toast names the reason.
        </div>
      </div>
    </div>
  )
}

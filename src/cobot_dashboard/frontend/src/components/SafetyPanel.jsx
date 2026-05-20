import { useStore } from '../store/useStore'

const Z_COLORS = { GREEN: '#00C47A', YELLOW: '#F5A623', RED: '#FF3B3B', UNKNOWN: '#606070' }

export default function SafetyPanel() {
  const safety = useStore((s) => s.safety)
  const task   = useStore((s) => s.task)

  const zColor = Z_COLORS[safety.zone] ?? Z_COLORS.UNKNOWN
  const speedPct = Math.round(safety.speed_scale * 100)

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--tm)' }}>
        Safety Status
      </div>

      {/* Zone indicator */}
      <div style={{
        padding: '14px 0', borderRadius: 8, textAlign: 'center',
        background: zColor + '18', border: `1px solid ${zColor}44`,
        transition: 'all .3s',
      }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: zColor, letterSpacing: '.06em' }}>
          {safety.zone}
        </div>
        <div style={{ fontSize: 10, color: 'var(--tm)', marginTop: 3 }}>
          Safety Zone
        </div>
      </div>

      {/* Speed */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4,
          fontSize: 11, color: 'var(--t2)' }}>
          <span>Speed Scale</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{speedPct}%</span>
        </div>
        <div style={{ height: 5, background: 'var(--surf)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3, transition: 'width .4s',
            width: `${speedPct}%`,
            background: speedPct > 0 ? 'var(--g)' : 'var(--tm)',
          }} />
        </div>
      </div>

      {/* Proximity */}
      <Row label="Human Proximity" value={
        safety.human_proximity < 50
          ? `${safety.human_proximity.toFixed(2)} m`
          : '— m'
      } />

      {/* Task */}
      <Row label="Task State" value={task.state} accent={task.running} />
    </div>
  )
}

function Row({ label, value, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between',
      fontSize: 11, alignItems: 'center' }}>
      <span style={{ color: 'var(--t2)' }}>{label}</span>
      <span style={{
        fontFamily: 'monospace', fontWeight: 700,
        color: accent ? 'var(--acc)' : 'var(--t1)',
      }}>
        {value}
      </span>
    </div>
  )
}

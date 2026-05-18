import { useStore } from '../store/useStore'

function Block({ children, style }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 12px',
      borderRight: '1px solid var(--border)',
      fontSize: 10,
      color: 'var(--text-secondary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      height: '100%',
      ...style,
    }}>
      {children}
    </div>
  )
}

const ZONE_COLORS = {
  GREEN:  '#22C55E',
  YELLOW: '#EAB308',
  RED:    '#EF4444',
}

export default function StatusBar() {
  const wsStatus  = useStore((s) => s.wsStatus)
  const wsLatency = useStore((s) => s.wsLatency)
  const task      = useStore((s) => s.task)
  const safety    = useStore((s) => s.safety)

  const zoneColor = ZONE_COLORS[safety.zone] ?? '#9A9A9E'
  const dotColor  = wsStatus === 'connected' ? '#22C55E'
                  : wsStatus === 'connecting' ? '#EAB308'
                  : '#EF4444'

  return (
    <div style={{
      height: '100%',
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden',
    }}>
      {/* Connection dot */}
      <Block>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
        {wsStatus === 'connected' ? 'Connected' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}
      </Block>

      <Block>ROS2 Humble</Block>
      <Block>Robot Generic TCP</Block>
      <Block>IP&nbsp;192.168.1.246</Block>

      {/* Task state */}
      <Block>
        State&nbsp;
        <span style={{
          color: task.state === 'IDLE'   ? 'var(--text-secondary)'
               : task.state === 'PAUSED' ? 'var(--yellow)'
               : task.state === 'HOME'   ? 'var(--green)'
               : 'var(--accent)',
          fontWeight: 500,
        }}>
          {task.state}
        </span>
      </Block>

      {/* Zone + proximity */}
      <Block style={{ color: zoneColor }}>
        Zone&nbsp;
        <span style={{ color: zoneColor, fontWeight: 600 }}>{safety.zone}</span>
        &nbsp;·&nbsp;
        {safety.human_proximity.toFixed(1)} m
      </Block>

      {/* WS freq + latency */}
      <Block>
        WS&nbsp;25Hz&nbsp;·&nbsp;
        <span style={{ fontFamily: 'var(--font-mono)' }}>{wsLatency} ms</span>
      </Block>

      <div style={{ flex: 1 }} />

      {/* Right side: version */}
      <Block style={{ borderRight: 'none', borderLeft: '1px solid var(--border)', color: 'var(--text-muted)' }}>
        v1.0.0-mock
      </Block>
    </div>
  )
}

import { useStore } from '../store/useStore'

const Z_COLORS = { GREEN: '#00C47A', YELLOW: '#F5A623', RED: '#FF3B3B', UNKNOWN: '#606070' }

export default function Header() {
  const connected   = useStore((s) => s.connected)
  const safety      = useStore((s) => s.safety)
  const task        = useStore((s) => s.task)
  const mode        = useStore((s) => s.mode)
  const setMode     = useStore((s) => s.setMode)
  const sendCommand = useStore((s) => s.sendCommand)

  async function handleEstop() {
    if (safety.estop) {
      await sendCommand('resume', {})
    } else {
      await sendCommand('estop', {})
    }
  }

  const zColor = Z_COLORS[safety.zone] ?? Z_COLORS.UNKNOWN

  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '0 14px', height: 50, flexShrink: 0,
      background: 'var(--panel)', borderBottom: '1px solid var(--bd)',
    }}>
      {/* Brand */}
      <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: -0.3 }}>
        <span style={{ color: 'var(--acc)' }}>Robo</span>Ai
      </div>
      <div style={{ fontSize: 11, color: 'var(--tm)', borderLeft: '1px solid var(--bd)', paddingLeft: 8 }}>
        Cobot 01
      </div>

      {/* Mode tabs */}
      <div style={{
        display: 'flex', background: 'var(--surf)', borderRadius: 7,
        padding: 2, marginLeft: 6, gap: 1,
      }}>
        {['operator', 'engineer'].map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: '4px 12px', borderRadius: 5, border: 'none', fontSize: 11,
            fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
            background: mode === m ? 'var(--panel)' : 'transparent',
            color:      mode === m ? 'var(--t1)'    : 'var(--tm)',
            boxShadow:  mode === m ? 'var(--sh)'    : 'none',
          }}>
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Safety zone badge */}
      <div style={{
        padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700,
        letterSpacing: '.05em', background: zColor + '22', color: zColor,
        transition: 'all .3s',
      }}>
        {safety.zone}
      </div>

      {/* Task state */}
      <div style={{ fontSize: 11, color: 'var(--t2)', minWidth: 60, textAlign: 'center' }}>
        {task.state}
      </div>

      {/* Connection dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', transition: 'all .3s',
          background:   connected ? 'var(--g)' : 'var(--r)',
          boxShadow:    connected ? '0 0 6px var(--g)' : 'none',
        }} />
        <span style={{ fontSize: 10, color: 'var(--tm)' }}>
          {connected ? 'Live' : 'Offline'}
        </span>
      </div>

      {/* E-STOP */}
      <button onClick={handleEstop} style={{
        padding: '7px 14px', borderRadius: 7, border: '2px solid',
        fontSize: 12, fontWeight: 800, letterSpacing: '.06em', transition: 'all .15s',
        borderColor: safety.estop ? '#991b1b' : 'var(--r)',
        background:  safety.estop ? '#991b1b' : 'var(--r)',
        color: '#fff',
        animation: safety.estop ? 'estopPulse 1s ease infinite' : 'none',
      }}>
        {safety.estop ? '▪ STOPPED' : '⬛ E-STOP'}
      </button>

      <style>{`
        @keyframes estopPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(255,59,59,.5); }
          50%      { box-shadow: 0 0 0 8px rgba(255,59,59,0); }
        }
      `}</style>
    </header>
  )
}

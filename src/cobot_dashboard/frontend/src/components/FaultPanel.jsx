import { useStore } from '../store/useStore'

const ERROR_MESSAGES = {
  0: 'No fault',           1: 'Joint limit exceeded',
  2: 'Collision detected', 3: 'Communication timeout',
  4: 'Overheat',           5: 'Power fault',
}

export default function FaultPanel() {
  const robot       = useStore((s) => s.robot)
  const safety      = useStore((s) => s.safety)
  const sendCommand = useStore((s) => s.sendCommand)
  const homeRobot   = useStore((s) => s.homeRobot)

  const errorCode = robot?.error_code ?? 0
  const estop     = safety?.estop ?? false

  if (errorCode === 0 && !estop) return null

  return (
    <div style={{
      position: 'fixed', bottom: 80, right: 16, zIndex: 500,
      background: 'var(--bg-panel)',
      border: '1px solid var(--zone-red)',
      borderRadius: 'var(--radius-lg)',
      padding: 16, minWidth: 280,
      boxShadow: '0 4px 20px rgba(0,0,0,.6)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--zone-red)', marginBottom: 8 }}>
        ⚠ {estop ? 'E-Stop Active' : 'Fault Detected'}
      </div>
      {errorCode !== 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Error {errorCode}: {ERROR_MESSAGES[errorCode] || 'Unknown error'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={() => sendCommand('clear_error', {})}
          style={{
            flex: 1, height: 30, fontSize: 12, cursor: 'pointer',
            background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          }}>
          Clear Error
        </button>
        <button
          onClick={homeRobot}
          style={{
            flex: 1, height: 30, fontSize: 12, cursor: 'pointer',
            background: 'var(--green-dim)', color: 'var(--green)',
            border: '1px solid var(--green)', borderRadius: 'var(--radius-sm)',
          }}>
          Go Home
        </button>
      </div>
    </div>
  )
}

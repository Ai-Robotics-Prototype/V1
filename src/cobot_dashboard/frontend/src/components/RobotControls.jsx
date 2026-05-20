import { useStore } from '../store/useStore'

const JOINT_NAMES = ['J1 — Base', 'J2 — Shoulder', 'J3 — Elbow', 'J4 — Wrist 1', 'J5 — Wrist 2', 'J6 — Wrist 3']
const STEP_SIZES  = [1, 5, 10, 45]

export default function RobotControls() {
  const safety        = useStore((s) => s.safety)
  const joints        = useStore((s) => s.joints)
  const task          = useStore((s) => s.task)
  const mode          = useStore((s) => s.mode)
  const jogEnabled    = useStore((s) => s.jogEnabled)
  const selectedJoint = useStore((s) => s.selectedJoint)
  const sendCommand   = useStore((s) => s.sendCommand)
  const unlockJog     = useStore((s) => s.enableJog)
  const setJoint      = useStore((s) => s.setSelectedJoint)
  const jogJoint      = useStore((s) => s.jogJoint)

  const canJog = jogEnabled && !safety.estop && !task.running

  async function jog(joint, deltaDeg) {
    if (!canJog) return
    const deltaRad = deltaDeg * Math.PI / 180
    await jogJoint(joint, deltaRad)
  }

  async function handleHome() {
    await sendCommand('home', {})
  }

  async function handleGripper(action) {
    await sendCommand('gripper', { action })
  }

  const deg = (rad) => ((rad * 180) / Math.PI).toFixed(1)

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--tm)' }}>
        Robot Controls
      </div>

      {/* JOG LOCK banner */}
      {!jogEnabled && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, border: '1px solid var(--bd)',
          background: 'rgba(245,166,35,.08)', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 8,
        }}>
          <span style={{ fontSize: 11, color: 'var(--y)' }}>Jog locked — confirm to enable</span>
          <button onClick={unlockJog} style={{
            padding: '5px 12px', borderRadius: 6, border: '1px solid var(--y)',
            background: 'transparent', color: 'var(--y)', fontSize: 11,
            fontWeight: 700, cursor: 'pointer',
          }}>
            Unlock
          </button>
        </div>
      )}

      {/* E-STOP banner */}
      {safety.estop && jogEnabled && (
        <div style={{
          padding: '8px 14px', borderRadius: 8,
          background: 'rgba(255,59,59,.1)', border: '1px solid rgba(255,59,59,.3)',
          fontSize: 11, color: 'var(--r)', textAlign: 'center', fontWeight: 700,
        }}>
          E-STOP ACTIVE — clear via header button
        </div>
      )}

      {/* Joint selector */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {joints.positions.map((pos, i) => (
          <button key={i} onClick={() => setJoint(i)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '7px 10px', borderRadius: 6, border: '1px solid',
            borderColor: selectedJoint === i ? 'var(--acc)' : 'transparent',
            background:  selectedJoint === i ? 'rgba(59,130,246,.1)' : 'transparent',
            cursor: 'pointer', transition: 'all .15s',
          }}>
            <span style={{ fontSize: 11, color: selectedJoint === i ? 'var(--acc)' : 'var(--t2)' }}>
              {JOINT_NAMES[i]}
            </span>
            <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
              color: selectedJoint === i ? 'var(--t1)' : 'var(--tm)' }}>
              {deg(pos)}°
            </span>
          </button>
        ))}
      </div>

      {/* Jog buttons */}
      {mode === 'engineer' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10, color: 'var(--tm)', marginBottom: 2 }}>
            Jog — {JOINT_NAMES[selectedJoint]}
          </div>
          {STEP_SIZES.map((step) => (
            <div key={step} style={{ display: 'flex', gap: 5 }}>
              <JogBtn label={`−${step}°`} onClick={() => jog(selectedJoint, -step)} disabled={!canJog} />
              <span style={{ flex: 1, textAlign: 'center', fontSize: 11,
                color: 'var(--tm)', alignSelf: 'center' }}>
                {step}°
              </span>
              <JogBtn label={`+${step}°`} onClick={() => jog(selectedJoint, step)} disabled={!canJog} />
            </div>
          ))}
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <ActionBtn label="Home" onClick={handleHome} disabled={safety.estop || task.running} />
        <ActionBtn label="Open" onClick={() => handleGripper('open')} />
        <ActionBtn label="Close" onClick={() => handleGripper('close')} />
      </div>

      {/* TCP Pose — engineer only */}
      {mode === 'engineer' && <TcpPose />}
    </div>
  )
}

function JogBtn({ label, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      flex: 1, padding: '7px 0', borderRadius: 6, border: '1px solid var(--bd)',
      background: disabled ? 'transparent' : 'var(--surf)',
      color: disabled ? 'var(--tm)' : 'var(--t1)',
      fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'all .15s', opacity: disabled ? 0.4 : 1,
    }}>
      {label}
    </button>
  )
}

function ActionBtn({ label, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      flex: 1, padding: '8px 0', borderRadius: 7, border: '1px solid var(--bd)',
      background: 'var(--surf)', color: disabled ? 'var(--tm)' : 'var(--t1)',
      fontSize: 11, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'all .15s', opacity: disabled ? 0.4 : 1,
    }}>
      {label}
    </button>
  )
}

function TcpPose() {
  const tcpPose = useStore((s) => s.tcpPose)
  const fields  = ['x', 'y', 'z', 'rx', 'ry', 'rz']
  const fmt     = (v, k) => k.startsWith('r') ? `${(v * 180 / Math.PI).toFixed(1)}°` : `${v.toFixed(1)} mm`

  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--tm)', marginBottom: 7 }}>
        TCP Pose
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px' }}>
        {fields.map((k) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
            fontSize: 11, alignItems: 'center' }}>
            <span style={{ color: 'var(--tm)', textTransform: 'uppercase' }}>{k}</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--t1)' }}>
              {fmt(tcpPose[k] ?? 0, k)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

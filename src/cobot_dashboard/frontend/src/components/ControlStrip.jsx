import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'

const MAX_TORQUES = [150, 150, 150, 28, 28, 28]

// ── RunControl ────────────────────────────────────────────────────────────────
function RunControl() {
  const safety        = useStore((s) => s.safety)
  const task          = useStore((s) => s.task)
  const mode          = useStore((s) => s.mode)
  const gripper       = useStore((s) => s.gripper)
  const tcp_pose      = useStore((s) => s.tcp_pose)
  const storeOverride = useStore((s) => s.speed_override)
  const sendCommand   = useStore((s) => s.sendCommand)

  const [speedOverride, setSpeedOverride] = useState(storeOverride ?? 100)

  // Sync when store changes from WS
  useEffect(() => {
    setSpeedOverride(storeOverride ?? 100)
  }, [storeOverride])

  const estop    = safety?.estop ?? true
  const speedPct = Math.round((safety?.speed_scale ?? 0) * 100)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Speed scale bar */}
      <div>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 10, color: 'var(--text-muted)', marginBottom: 4,
        }}>
          <span>Speed Scale</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
            {speedPct}%
          </span>
        </div>
        <div style={{
          height: 4, background: 'var(--bg-surface)',
          borderRadius: 2, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 2, transition: 'width .3s',
            width: `${speedPct}%`,
            background: speedPct > 50 ? 'var(--green)' : speedPct > 0 ? 'var(--yellow)' : 'var(--text-muted)',
          }} />
        </div>
      </div>

      {/* Speed override slider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          width: 36, flexShrink: 0,
        }}>
          Override
        </span>
        <input
          type="range" min={0} max={100} step={5}
          value={speedOverride}
          disabled={estop}
          onChange={(e) => {
            const v = Number(e.target.value)
            setSpeedOverride(v)
            sendCommand('speed_override', { percent: v })
          }}
          style={{ flex: 1, accentColor: 'var(--accent)', opacity: estop ? 0.4 : 1 }}
        />
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)', width: 32, textAlign: 'right',
        }}>
          {speedOverride}%
        </span>
      </div>

      {/* TCP Position — engineer mode only */}
      {mode === 'engineer' && (
        <div style={{
          padding: '6px 8px',
          background: 'var(--bg-surface)', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
        }}>
          <div style={{
            fontSize: 9, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4,
          }}>
            TCP Position
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3,1fr)',
            gap: 4, fontFamily: 'var(--font-mono)', fontSize: 11,
          }}>
            {['X', 'Y', 'Z'].map((ax, i) => (
              <div key={ax}>
                <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>{ax} </span>
                <span style={{ color: 'var(--text-primary)' }}>
                  {(tcp_pose?.[i] ?? 0).toFixed(3)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gripper buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={() => sendCommand('gripper', { action: 'open' })}
          disabled={estop}
          style={{
            flex: 1, height: 28, fontSize: 11,
            background: gripper?.state === 'open' ? 'var(--green-dim)' : 'var(--bg-surface)',
            color:      gripper?.state === 'open' ? 'var(--green)'     : 'var(--text-secondary)',
            border:    `1px solid ${gripper?.state === 'open' ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: estop ? 0.4 : 1, transition: 'all .15s',
          }}>
          Open
        </button>
        <button
          onClick={() => sendCommand('gripper', { action: 'close' })}
          disabled={estop}
          style={{
            flex: 1, height: 28, fontSize: 11,
            background: gripper?.state === 'closed' ? 'var(--accent-dim)' : 'var(--bg-surface)',
            color:      gripper?.state === 'closed' ? 'var(--accent)'     : 'var(--text-secondary)',
            border:    `1px solid ${gripper?.state === 'closed' ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: estop ? 0.4 : 1, transition: 'all .15s',
          }}>
          Close
        </button>
      </div>

      {/* Run / Pause / Home */}
      <div style={{ display: 'flex', gap: 5 }}>
        <button
          disabled={estop || task?.running}
          onClick={() => sendCommand('task', { command: 'run' })}
          style={{
            flex: 2, height: 30, fontSize: 11, fontWeight: 700,
            background: (!estop && !task?.running) ? 'var(--green-dim)' : 'var(--bg-surface)',
            color: (!estop && !task?.running) ? 'var(--green)' : 'var(--text-muted)',
            border: `1px solid ${(!estop && !task?.running) ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: (estop || task?.running) ? 0.4 : 1,
          }}>
          ▶ Run
        </button>
        <button
          disabled={!task?.running}
          onClick={() => sendCommand('task', { command: task?.paused ? 'resume' : 'pause' })}
          style={{
            flex: 1, height: 30, fontSize: 11,
            background: 'var(--bg-surface)',
            color: task?.running ? 'var(--yellow)' : 'var(--text-muted)',
            border: `1px solid ${task?.running ? 'var(--yellow)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: task?.running ? 1 : 0.4,
          }}>
          {task?.paused ? '▶' : '⏸'}
        </button>
        <button
          onClick={() => sendCommand('task', { command: 'home' })}
          style={{
            flex: 1, height: 30, fontSize: 11,
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}>
          ⌂
        </button>
      </div>
    </div>
  )
}

// ── Joint positions with torque bars ─────────────────────────────────────────
function JointPositions() {
  const joints  = useStore((s) => s.joints)
  const mode    = useStore((s) => s.mode)
  const torques = joints?.torques || [0, 0, 0, 0, 0, 0]
  const pos     = joints?.positions || [0, 0, 0, 0, 0, 0]

  const RANGES = [180, 180, 135, 180, 120, 360]

  return (
    <div>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6,
      }}>
        Joints
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {pos.map((rad, i) => {
          const deg  = rad * 180 / Math.PI
          const pct  = Math.min(100, Math.abs(deg) / RANGES[i] * 100)
          const tPct = Math.min(100, Math.abs(torques[i] ?? 0) / MAX_TORQUES[i] * 100)
          const warn = pct > 75
          return (
            <div key={i}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 10, marginBottom: 2,
              }}>
                <span style={{ color: 'var(--text-muted)' }}>J{i + 1}</span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  color: warn ? 'var(--yellow)' : 'var(--text-primary)',
                }}>
                  {deg.toFixed(1)}°
                </span>
              </div>
              {/* Position bar */}
              <div style={{
                height: 3, background: 'var(--bg-surface)',
                borderRadius: 2, overflow: 'hidden', marginBottom: 2,
              }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 2,
                  background: warn ? 'var(--yellow)' : 'var(--accent)',
                  transition: 'width 200ms',
                }} />
              </div>
              {/* Torque bar — engineer only */}
              {mode === 'engineer' && (
                <div style={{
                  height: 2, background: 'var(--bg-active)',
                  borderRadius: 1, overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${tPct}%`, height: '100%', borderRadius: 1,
                    background: tPct > 80 ? 'var(--red)' : 'var(--yellow)',
                    transition: 'width 200ms',
                  }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── ControlStrip ──────────────────────────────────────────────────────────────
export default function ControlStrip() {
  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--tm)',
      }}>
        Controls
      </div>
      <RunControl />
      <div style={{ height: 1, background: 'var(--bd)' }} />
      <JointPositions />
    </div>
  )
}

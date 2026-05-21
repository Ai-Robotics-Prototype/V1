import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'

const MAX_TORQUES = [150, 150, 150, 28, 28, 28]
const JOINT_RANGES = [180, 180, 135, 180, 120, 360]

// ── Column 1: Run Control ─────────────────────────────────────────────────────
function RunControl() {
  const safety        = useStore((s) => s.safety)
  const task          = useStore((s) => s.task)
  const gripper       = useStore((s) => s.gripper)
  const storeOverride = useStore((s) => s.speed_override)
  const sendCommand   = useStore((s) => s.sendCommand)
  const [speedOverride, setSpeedOverride] = useState(storeOverride ?? 100)

  useEffect(() => { setSpeedOverride(storeOverride ?? 100) }, [storeOverride])

  const estop    = safety?.estop ?? true
  const zone     = safety?.zone ?? 'UNKNOWN'
  const speedPct = Math.round((safety?.speed_scale ?? 0) * 100)
  const running  = task?.running ?? false
  const paused   = task?.paused  ?? false
  const state    = task?.state   ?? 'IDLE'

  const STATE_COLORS = {
    IDLE: 'var(--text-muted)', RUNNING: 'var(--green)', PAUSED: 'var(--yellow)',
    HOME: 'var(--accent)', ERROR: 'var(--red)', APPROACH: 'var(--accent)',
  }
  const ZONE_COLORS = {
    GREEN: 'var(--green)', YELLOW: 'var(--yellow)', RED: 'var(--red)', UNKNOWN: 'var(--text-muted)',
  }

  return (
    <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        RUN CONTROL
      </div>

      {/* Run / Pause / Home buttons */}
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          disabled={estop}
          onClick={() => sendCommand('task', { command: running && !paused ? 'run' : paused ? 'resume' : 'run' })}
          style={{
            flex: 2, height: 30, fontSize: 11, fontWeight: 700,
            background: (!estop) ? 'var(--green-dim)' : 'var(--bg-surface)',
            color:      (!estop) ? 'var(--green)'     : 'var(--text-muted)',
            border:    `1px solid ${!estop ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: estop ? 0.4 : 1, transition: 'all .15s',
          }}
        >
          {paused ? '▶ Resume' : '▶ Run'}
        </button>
        <button
          disabled={!running || paused}
          onClick={() => sendCommand('task', { command: 'pause' })}
          style={{
            flex: 1, height: 30, fontSize: 11,
            background: 'var(--bg-surface)', color: running ? 'var(--yellow)' : 'var(--text-muted)',
            border: `1px solid ${running ? 'var(--yellow)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            opacity: (!running || paused) ? 0.4 : 1, transition: 'all .15s',
          }}
        >
          ⏸
        </button>
        <button
          onClick={() => { if (confirm('Move to home position?')) sendCommand('task', { command: 'home' }) }}
          style={{
            flex: 1, height: 30, fontSize: 11,
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}
        >
          ⌂
        </button>
      </div>

      {/* Task state pill */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 8px', borderRadius: 10,
        background: 'var(--bg-surface)', alignSelf: 'flex-start',
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: STATE_COLORS[state] || 'var(--text-muted)',
        }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: STATE_COLORS[state] || 'var(--text-muted)' }}>
          {state}
        </span>
      </div>

      {/* Speed scale bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginBottom: 3 }}>
          <span>Speed</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{speedPct}%</span>
        </div>
        <div style={{ height: 4, background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2, transition: 'width .3s',
            width: `${speedPct}%`,
            background: speedPct > 50 ? 'var(--green)' : speedPct > 0 ? 'var(--yellow)' : 'var(--text-muted)',
          }} />
        </div>
      </div>

      {/* Speed override slider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 48, flexShrink: 0 }}>Override</span>
        <input
          type="range" min={0} max={100} step={5} value={speedOverride}
          disabled={estop}
          onChange={(e) => { const v = Number(e.target.value); setSpeedOverride(v); sendCommand('speed_override', { percent: v }) }}
          style={{ flex: 1, accentColor: 'var(--accent)', opacity: estop ? 0.4 : 1 }}
        />
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', width: 28, textAlign: 'right' }}>
          {speedOverride}%
        </span>
      </div>

      {/* Gripper */}
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={() => sendCommand('gripper', { action: 'open' })} disabled={estop}
          style={{
            flex: 1, height: 26, fontSize: 10,
            background: gripper?.state === 'open' ? 'var(--green-dim)' : 'var(--bg-surface)',
            color:      gripper?.state === 'open' ? 'var(--green)'     : 'var(--text-secondary)',
            border:    `1px solid ${gripper?.state === 'open' ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: estop ? 0.4 : 1,
          }}
        >
          Open
        </button>
        <button
          onClick={() => sendCommand('gripper', { action: 'close' })} disabled={estop}
          style={{
            flex: 1, height: 26, fontSize: 10,
            background: gripper?.state === 'closed' ? 'var(--accent-dim)' : 'var(--bg-surface)',
            color:      gripper?.state === 'closed' ? 'var(--accent)'     : 'var(--text-secondary)',
            border:    `1px solid ${gripper?.state === 'closed' ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: estop ? 0.4 : 1,
          }}
        >
          Close
        </button>
      </div>

      {/* Safety status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: ZONE_COLORS[zone] || 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ color: ZONE_COLORS[zone] || 'var(--text-muted)', fontWeight: 600 }}>{zone}</span>
        {(safety?.human_proximity ?? 99) < 5 && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {(safety.human_proximity ?? 0).toFixed(2)} m
          </span>
        )}
      </div>
    </div>
  )
}

// ── Column 2: Joint Positions ─────────────────────────────────────────────────
function JointPositions() {
  const joints        = useStore((s) => s.joints)
  const safety        = useStore((s) => s.safety)
  const task          = useStore((s) => s.task)
  const mode          = useStore((s) => s.mode)
  const jogEnabled    = useStore((s) => s.jogEnabled)
  const selectedJoint = useStore((s) => s.selectedJoint)
  const enableJog     = useStore((s) => s.enableJog)
  const disableJog    = useStore((s) => s.disableJog)
  const setJoint      = useStore((s) => s.setSelectedJoint)
  const jogJoint      = useStore((s) => s.jogJoint)

  const pos     = joints?.positions || [0, 0, 0, 0, 0, 0]
  const torques = joints?.torques   || [0, 0, 0, 0, 0, 0]
  const estop   = safety?.estop ?? true
  const zone    = safety?.zone ?? 'UNKNOWN'
  const canJog  = jogEnabled && !estop && zone === 'GREEN' && !(task?.running)

  async function jog(joint, deltaDeg) {
    if (!canJog) return
    await jogJoint(joint, deltaDeg * Math.PI / 180)
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        JOINT POSITIONS
      </div>

      {/* 2×3 tile grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {pos.map((rad, i) => {
          const deg   = rad * 180 / Math.PI
          const pct   = Math.min(100, Math.abs(deg) / JOINT_RANGES[i] * 100)
          const tPct  = Math.min(100, Math.abs(torques[i] ?? 0) / MAX_TORQUES[i] * 100)
          const warn  = pct > 75
          const sel   = selectedJoint === i

          return (
            <button
              key={i}
              onClick={() => setJoint(i)}
              style={{
                padding: '5px 6px', borderRadius: 'var(--radius-sm)',
                border: `1px solid ${sel ? 'var(--accent-border)' : 'var(--border)'}`,
                background: sel ? 'var(--accent-dim)' : 'var(--bg-surface)',
                cursor: 'pointer', textAlign: 'left', transition: 'all .15s',
              }}
            >
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>J{i + 1}</div>
              <div style={{
                fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700,
                color: warn ? 'var(--yellow)' : 'var(--text-primary)',
              }}>
                {deg.toFixed(1)}°
              </div>
              <div style={{ height: 3, background: 'var(--bg-hover)', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 2,
                  background: warn ? 'var(--yellow)' : 'var(--accent)',
                  transition: 'width 200ms',
                }} />
              </div>
              {mode === 'engineer' && (
                <div style={{ height: 2, background: 'var(--bg-hover)', borderRadius: 1, marginTop: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${tPct}%`, height: '100%', borderRadius: 1,
                    background: tPct > 80 ? 'var(--red)' : 'var(--yellow)',
                    transition: 'width 200ms',
                  }} />
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Jog controls — engineer mode */}
      {mode === 'engineer' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              Jog J{selectedJoint + 1}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {jogEnabled && (
                <span style={{ fontSize: 9, color: 'var(--yellow)' }}>⚠ UNLOCKED</span>
              )}
              <button
                onClick={jogEnabled ? disableJog : enableJog}
                style={{
                  fontSize: 9, padding: '2px 8px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${jogEnabled ? 'var(--yellow)' : 'var(--border)'}`,
                  background: jogEnabled ? 'var(--yellow-dim)' : 'transparent',
                  color: jogEnabled ? 'var(--yellow)' : 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                {jogEnabled ? 'Lock' : 'Unlock Jog'}
              </button>
            </div>
          </div>
          {!estop && zone === 'GREEN' ? null : (
            <div style={{ fontSize: 9, color: 'var(--red)', padding: '2px 0' }}>
              {estop ? 'E-Stop active' : `Zone ${zone} — jog requires GREEN`}
            </div>
          )}
          <div style={{ display: 'flex', gap: 3 }}>
            {[-5, -1, 1, 5].map((d) => (
              <button
                key={d}
                disabled={!canJog}
                onClick={() => jog(selectedJoint, d)}
                style={{
                  flex: 1, height: 26, fontSize: 10, fontWeight: 600,
                  background: canJog ? 'var(--bg-surface)' : 'transparent',
                  color: canJog ? 'var(--text-primary)' : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', cursor: canJog ? 'pointer' : 'not-allowed',
                  opacity: canJog ? 1 : 0.4, transition: 'all .15s',
                }}
              >
                {d > 0 ? `+${d}` : d}°
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Column 3: Detected Objects ────────────────────────────────────────────────
function DetectedObjects() {
  const detections = useStore((s) => s.detections)

  const sorted = [...(detections || [])].sort((a, b) => {
    const da = a.distance ?? a.depth_m ?? 99
    const db = b.distance ?? b.depth_m ?? 99
    return da - db
  })

  const CLASS_COLORS = {
    bottle: 'var(--accent)', box: 'var(--green)', person: 'var(--red)',
    cup: 'var(--yellow)', default: '#7C3AED',
  }

  return (
    <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        DETECTED OBJECTS
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 140 }}>
        {sorted.length === 0 ? (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '8px 0' }}>
            No objects detected
          </div>
        ) : (
          sorted.map((det, i) => {
            const cls   = det.class_name || det.class || 'object'
            const conf  = det.confidence ? Math.round(det.confidence * 100) : null
            const dist  = det.distance ?? det.depth_m ?? null
            const color = CLASS_COLORS[cls] || CLASS_COLORS.default

            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '3px 5px', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-surface)', animation: 'slideIn .2s ease',
                }}
              >
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-primary)', flex: 1 }}>{cls}</span>
                {conf !== null && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {conf}%
                  </span>
                )}
                {dist !== null && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {dist.toFixed(2)}m
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── ControlStrip ──────────────────────────────────────────────────────────────
export default function ControlStrip() {
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-sm)',
      padding: '10px 14px',
      display: 'flex', gap: 16, alignItems: 'flex-start',
      flexShrink: 0,
    }}>
      <RunControl />
      <div style={{ width: 1, background: 'var(--border)', alignSelf: 'stretch' }} />
      <JointPositions />
      <div style={{ width: 1, background: 'var(--border)', alignSelf: 'stretch' }} />
      <DetectedObjects />
    </div>
  )
}

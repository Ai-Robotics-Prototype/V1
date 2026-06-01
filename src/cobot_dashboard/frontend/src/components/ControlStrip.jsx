import { useState } from 'react'
import { useStore } from '../store/useStore'

const RAD = (deg) => (deg * Math.PI) / 180

// Task state colour
function stateStyle(state) {
  switch (state) {
    case 'IDLE':    return { bg: 'var(--bg-hover)',    text: 'var(--text-secondary)', anim: 'none' }
    case 'PAUSED':  return { bg: 'var(--yellow-dim)',  text: 'var(--yellow)',          anim: 'none' }
    case 'HOME':    return { bg: 'var(--green-dim)',   text: 'var(--green)',           anim: 'none' }
    case 'ERROR':   return { bg: 'var(--red-dim)',     text: 'var(--red)',             anim: 'shake 0.4s ease' }
    default:        return { bg: 'var(--accent-dim)',  text: 'var(--accent)',          anim: 'pulse-opacity 2s ease-in-out infinite' }
  }
}

function SpeedBar({ value }) {
  const pct   = Math.round(value * 100)
  const color = pct >= 90 ? 'var(--green)' : pct >= 20 ? 'var(--yellow)' : 'var(--red)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 36, flexShrink: 0 }}>Speed</span>
      <div style={{
        flex: 1, height: 4, background: 'var(--bg-active)', borderRadius: 2, overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color,
          transition: 'width 300ms, background 300ms',
          borderRadius: 2,
        }} />
      </div>
      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color, width: 28, textAlign: 'right' }}>
        {pct}%
      </span>
    </div>
  )
}

// Styled toggle switch
function ToggleSwitch({ checked, onChange, disabled }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <div style={{
        position: 'relative', width: 32, height: 18,
        background: checked ? 'var(--accent)' : 'var(--bg-active)',
        borderRadius: 9, transition: 'background 200ms',
        opacity: disabled ? 0.4 : 1,
      }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
        />
        <div style={{
          position: 'absolute',
          top: 2, left: checked ? 16 : 2,
          width: 14, height: 14,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 200ms',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </div>
    </label>
  )
}

// Column 1: Run control
function RunControl() {
  const task         = useStore((s) => s.task)
  const safety       = useStore((s) => s.safety)
  const runProgram   = useStore((s) => s.runProgram)
  const pauseProgram = useStore((s) => s.pauseProgram)
  const resumeProgram= useStore((s) => s.resumeProgram)
  const homeRobot    = useStore((s) => s.homeRobot)
  const openGripper  = useStore((s) => s.openGripper)
  const closeGripper = useStore((s) => s.closeGripper)
  const gripper      = useStore((s) => s.gripper)
  const mode         = useStore((s) => s.mode)

  const [confirmHome, setConfirmHome] = useState(false)
  const { estop } = safety
  const { running, paused, state } = task
  const st = stateStyle(state)

  function handleHomeClick() {
    if (confirmHome) {
      setConfirmHome(false)
      homeRobot()
    } else {
      setConfirmHome(true)
    }
  }

  return (
    <div style={{ width: 220, flexShrink: 0, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 2 }}>
        Run Control
      </div>

      {/* Buttons row */}
      <div style={{ display: 'flex', gap: 4 }}>
        {/* Run / Resume */}
        <button
          onClick={paused ? resumeProgram : runProgram}
          disabled={estop || running}
          title={estop ? 'Cannot run: estop active' : running && !paused ? 'Already running' : paused ? 'Resume program' : 'Run program'}
          style={{
            flex: 1,
            background: '#16A34A',
            color: '#fff',
            border: 'none',
            padding: '5px 0',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {paused ? '▶ Resume' : '▶ Run'}
        </button>

        {/* Pause */}
        <button
          onClick={pauseProgram}
          disabled={!running || paused || estop}
          title={!running ? 'Not running' : paused ? 'Already paused' : estop ? 'Estop active' : 'Pause program'}
          style={{
            flex: 1,
            background: 'var(--yellow-dim)',
            color: 'var(--yellow)',
            border: '1px solid rgba(234,179,8,0.3)',
            padding: '5px 0',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          ⏸ Pause
        </button>

        {/* Home */}
        {confirmHome ? (
          <div style={{ display: 'flex', gap: 3 }}>
            <button
              onClick={() => setConfirmHome(false)}
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '5px 7px', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
            >
              ✕
            </button>
            <button
              onClick={handleHomeClick}
              disabled={estop}
              style={{ background: 'var(--green-dim)', border: '1px solid rgba(34,197,94,0.3)', color: 'var(--green)', padding: '5px 7px', borderRadius: 'var(--radius-sm)', fontSize: 11 }}
            >
              ✓
            </button>
          </div>
        ) : (
          <button
            onClick={handleHomeClick}
            disabled={estop}
            title={estop ? 'Cannot home: estop active' : 'Move to home position (confirm)'}
            style={{
              flex: 1,
              background: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              padding: '5px 0',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ⌂ Home
          </button>
        )}
      </div>

      {/* Task state pill */}
      <div style={{
        background: st.bg,
        color: st.text,
        fontSize: 10,
        fontWeight: 600,
        padding: '3px 8px',
        borderRadius: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        alignSelf: 'flex-start',
        animation: st.anim,
        letterSpacing: '0.05em',
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%', background: st.text, display: 'inline-block',
        }} />
        {state}
      </div>

      {/* Speed bar */}
      <SpeedBar value={safety.speed_scale} />

      {/* Safety status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-secondary)' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
          background: safety.zone === 'GREEN' ? 'var(--green)' : safety.zone === 'YELLOW' ? 'var(--yellow)' : 'var(--red)',
        }} />
        {safety.zone === 'GREEN' ? 'Safe' : safety.zone === 'YELLOW' ? 'Slow' : 'Stop'}
        &nbsp;·&nbsp;{safety.human_proximity.toFixed(1)} m&nbsp;·&nbsp;{safety.zone} zone
      </div>

      {/* Gripper (engineer mode only) */}
      {mode === 'engineer' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 40, flexShrink: 0 }}>Gripper</span>
          <button
            onClick={openGripper}
            disabled={estop}
            title={estop ? 'Estop active' : 'Open gripper'}
            style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', padding: '3px 8px', borderRadius: 'var(--radius-sm)', fontSize: 11,
            }}
          >
            Open
          </button>
          <button
            onClick={closeGripper}
            disabled={estop}
            title={estop ? 'Estop active' : 'Close gripper'}
            style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', padding: '3px 8px', borderRadius: 'var(--radius-sm)', fontSize: 11,
            }}
          >
            Close
          </button>
          <span style={{
            fontSize: 10, color: 'var(--text-muted)',
            background: 'var(--bg-active)', padding: '2px 6px', borderRadius: 3, marginLeft: 2,
          }}>
            {gripper.state}
          </span>
        </div>
      )}
    </div>
  )
}

// Column 2: Joint positions
function JointPositions() {
  const joints    = useStore((s) => s.joints)
  const safety    = useStore((s) => s.safety)
  const mode      = useStore((s) => s.mode)
  const jogEnabled = useStore((s) => s.jogEnabled)
  const jogJoint  = useStore((s) => s.jogJoint)
  const enableJog  = useStore((s) => s.enableJog)
  const disableJog = useStore((s) => s.disableJog)
  const setJogJoint= useStore((s) => s.setJogJoint)
  const jogJointFn = useStore((s) => s.jogJoint)
  const estop      = safety.estop
  const isGreen    = safety.zone === 'GREEN'

  const { names, positions } = joints

  function jog(delta) {
    jogJointFn(jogJoint, RAD(delta))
  }

  return (
    <div style={{ flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 2 }}>
        Joint Positions
      </div>

      {/* 2×3 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
        {names.map((name, i) => {
          const deg = (positions[i] * 180) / Math.PI
          const pct = Math.min(100, (Math.abs(deg) / 180) * 100)
          return (
            <div key={name} style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '5px 6px',
            }}>
              <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 1 }}>{name}</div>
              <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                {deg.toFixed(1)}°
              </div>
              <div style={{ height: 2, background: 'var(--bg-active)', borderRadius: 1, marginTop: 3, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 1 }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Engineer: jog controls */}
      {mode === 'engineer' && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ToggleSwitch
              checked={jogEnabled}
              onChange={(e) => e.target.checked ? enableJog() : disableJog()}
              disabled={estop}
            />
            <span style={{ fontSize: 10, color: jogEnabled ? 'var(--yellow)' : 'var(--text-muted)' }}>
              Manual jog
            </span>
          </div>

          {jogEnabled && (
            <div style={{
              background: 'rgba(234,179,8,0.08)',
              border: '1px solid rgba(234,179,8,0.2)',
              borderRadius: 'var(--radius-sm)',
              padding: '4px 7px',
              fontSize: 10,
              color: 'var(--yellow)',
            }}>
              ⚠ Manual jog active — robot will move
            </div>
          )}

          {/* Joint pills */}
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {names.map((n, i) => (
              <button
                key={n}
                onClick={() => setJogJoint(i)}
                style={{
                  background: jogJoint === i ? 'var(--accent-dim)' : 'var(--bg-surface)',
                  border: jogJoint === i ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                  color: jogJoint === i ? 'var(--accent)' : 'var(--text-secondary)',
                  padding: '2px 7px',
                  borderRadius: 10,
                  fontSize: 10,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {n}
              </button>
            ))}
          </div>

          {/* Jog buttons */}
          <div style={{ display: 'flex', gap: 3 }}>
            {[-5, -1, 1, 5].map((d) => (
              <button
                key={d}
                onClick={() => jog(d)}
                disabled={!jogEnabled || estop || !isGreen}
                title={
                  estop     ? 'E-Stop active'
                  : !isGreen ? 'Requires green zone'
                  : !jogEnabled ? 'Enable manual jog first'
                  : `Jog J${jogJoint + 1} by ${d}°`
                }
                style={{
                  flex: 1,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  padding: '4px 0',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                }}
              >
                {d > 0 ? `+${d}°` : `${d}°`}
              </button>
            ))}
          </div>

          {!isGreen && (
            <div style={{ fontSize: 10, color: 'var(--red)', textAlign: 'center' }}>
              Requires green zone to jog
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Column 3: Detected objects
function DetectedObjects() {
  const detections    = useStore((s) => s.detections)
  const detectionMode = useStore((s) => s.detectionMode || 'all')

  const CLASS_COLORS = {
    bottle: 'var(--accent)',
    box:    'var(--green)',
    person: 'var(--red)',
  }
  const MATCHED_COLOR = '#3B82F6'

  function dist(det) {
    return Math.sqrt(det.x ** 2 + det.y ** 2 + det.z ** 2)
  }

  const filtered = detectionMode === 'library'
    ? detections.filter(d => d.part_name && Number(d.match_score) >= 0.5)
    : detections
  const sorted = [...filtered].sort((a, b) => dist(a) - dist(b))

  return (
    <div style={{ width: 200, flexShrink: 0, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 2, display: 'flex', justifyContent: 'space-between' }}>
        <span>Detected Objects</span>
        {detectionMode === 'library' && (
          <span style={{ color: MATCHED_COLOR, fontWeight: 600 }}>LIB</span>
        )}
      </div>

      {sorted.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 16 }}>
          {detectionMode === 'library' ? 'No library parts in view' : 'No objects detected'}
        </div>
      ) : (
        sorted.map((det) => {
          const d        = dist(det)
          const isMatch  = det.part_name && Number(det.match_score) >= 0.5
          const color    = isMatch ? MATCHED_COLOR : (CLASS_COLORS[det.class_name] ?? 'var(--text-muted)')
          const label    = isMatch ? det.part_name : (det.class_name || 'object')
          const barPct   = isMatch ? Math.round((det.match_score ?? 0) * 100)
                                   : Math.round((det.score       ?? 0) * 100)
          return (
            <div key={det.id} style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '5px 7px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              animation: 'none',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0,
              }} />
              <span style={{
                fontSize: 11, textTransform: isMatch ? 'none' : 'uppercase',
                fontWeight: 500, color, width: 64, flexShrink: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={label}>
                {label}
              </span>
              <div style={{ flex: 1, height: 3, background: 'var(--bg-active)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', flexShrink: 0 }}>
                {d.toFixed(2)} m
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}

export default function ControlStrip() {
  return (
    <div style={{
      height: 180,
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'row',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      <RunControl />
      <JointPositions />
      <DetectedObjects />
    </div>
  )
}

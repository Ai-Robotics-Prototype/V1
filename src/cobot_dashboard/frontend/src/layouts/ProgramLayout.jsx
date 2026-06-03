import { useRef } from 'react'
import { useStore } from '../store/useStore'
import ProgramEditor from '../components/ProgramEditor'
import ArmViewer3D from '../components/ArmViewer3D'

function JointReadout() {
  const joints = useStore((s) => s.joints)
  const gripper = useStore((s) => s.gripper)
  const { names, positions } = joints

  return (
    <div style={{
      padding: '10px 12px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 2 }}>
        Joint Positions
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
        {names.map((n, i) => (
          <div key={n} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{n}</span>
            <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
              {((positions[i] * 180) / Math.PI).toFixed(1)}°
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 3, display: 'flex', gap: 6, fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted)' }}>Gripper</span>
        <span style={{ color: gripper.state === 'open' ? 'var(--green)' : gripper.state === 'closed' ? 'var(--accent)' : 'var(--yellow)', fontWeight: 500 }}>
          {gripper.state}
        </span>
        <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          {gripper.position_mm.toFixed(0)} mm
        </span>
      </div>
    </div>
  )
}

function RunControlsCompact() {
  const task          = useStore((s) => s.task)
  const safety        = useStore((s) => s.safety)
  const runProgram    = useStore((s) => s.runProgram)
  const pauseProgram  = useStore((s) => s.pauseProgram)
  const resumeProgram = useStore((s) => s.resumeProgram)
  const homeRobot     = useStore((s) => s.homeRobot)
  const cancelProgram = useStore((s) => s.cancelProgram)
  const { estop }     = safety
  const { running, paused, state } = task

  const btnBase = {
    flex: 1, padding: '5px 0', borderRadius: 'var(--radius-sm)',
    fontSize: 11, fontWeight: 500, cursor: 'pointer', border: 'none',
  }

  return (
    <div style={{
      padding: '8px 12px',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>Run Control</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={paused ? resumeProgram : runProgram}
          disabled={estop || (running && !paused)}
          title={estop ? 'E-Stop active' : running && !paused ? 'Already running' : ''}
          style={{ ...btnBase, background: '#16A34A', color: '#fff' }}
        >
          {paused ? '▶ Resume' : '▶ Run'}
        </button>
        <button
          onClick={pauseProgram}
          disabled={!running || paused || estop}
          title={!running ? 'Not running' : paused ? 'Already paused' : ''}
          style={{ ...btnBase, background: 'var(--yellow-dim)', color: 'var(--yellow)', border: '1px solid rgba(234,179,8,0.3)' }}
        >
          ⏸ Pause
        </button>
        <button
          onClick={cancelProgram}
          disabled={!running && !paused}
          title="Cancel / stop program"
          style={{ ...btnBase, background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          ✕ Stop
        </button>
        <button
          onClick={homeRobot}
          disabled={estop}
          title={estop ? 'E-Stop active' : 'Move to home position'}
          style={{ ...btnBase, background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          ⌂ Home
        </button>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
        State:&nbsp;
        <span style={{
          fontWeight: 600,
          color: state === 'IDLE' ? 'var(--text-muted)'
              : state === 'PAUSED' ? 'var(--yellow)'
              : 'var(--accent)',
        }}>
          {state}
        </span>
        &nbsp;·&nbsp;Step {task.program_step + 1} / {task.program_total}
      </div>
    </div>
  )
}

export default function ProgramLayout() {
  const armRef = useRef(null)

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: Program panel — larger */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <ProgramEditor />
      </div>

      {/* Right sidebar: 3D arm + readout + controls */}
      <div style={{
        width: 280,
        flexShrink: 0,
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-panel)',
      }}>
        {/* 3D arm preview */}
        <div style={{ height: 240, flexShrink: 0 }}>
          <ArmViewer3D ref={armRef} />
        </div>

        <JointReadout />
        <RunControlsCompact />
      </div>
    </div>
  )
}

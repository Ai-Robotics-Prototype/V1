import { useRef } from 'react'
import { useStore } from '../store/useStore'

// ArmViewer3D import removed — the 3D arm viewer has been pulled
// pending the Estun-supplied URDF. The component file is left in
// place so it can be reintroduced later.

const PRESETS = ['Front', 'Side', 'Top', 'Iso']

function LeftPanel({ armRef }) {
  const joints  = useStore((s) => s.joints)
  const gripper = useStore((s) => s.gripper)
  const task    = useStore((s) => s.task)
  const { names, positions } = joints

  // Approximate TCP pose from last 3 joint angles (simplified FK readout)
  const j1 = positions[0] ?? 0
  const j2 = positions[1] ?? -Math.PI / 2
  const j3 = positions[2] ?? 0

  // Very rough forward kinematics for display only
  const L1 = 0.28, L2 = 0.25, L3 = 0.20
  const tcpX = (L1 * Math.cos(j2) + L2 * Math.cos(j2 + j3)) * Math.sin(j1)
  const tcpY = L1 * Math.sin(j2) + L2 * Math.sin(j2 + j3)
  const tcpZ = (L1 * Math.cos(j2) + L2 * Math.cos(j2 + j3)) * Math.cos(j1)

  return (
    <div style={{
      width: 240,
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      padding: '12px 14px',
      gap: 14,
    }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
          3D Robot View
        </div>

        {/* Camera presets */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
            Camera
          </div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => armRef.current?.setCameraPreset(p.toLowerCase())}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  padding: '3px 10px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Joint table */}
        <div>
          <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
            Joint Angles
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {names.map((n, i) => (
              <div key={n} style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', fontSize: 11,
              }}>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{n}</span>
                <div style={{ flex: 1, height: 2, background: 'var(--bg-active)', borderRadius: 1, margin: '0 8px', overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, (Math.abs(positions[i] * 180 / Math.PI) / 180) * 100)}%`,
                    height: '100%',
                    background: 'var(--accent)',
                    borderRadius: 1,
                  }} />
                </div>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                  {((positions[i] * 180) / Math.PI).toFixed(1)}°
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Gripper state */}
      <div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
          Gripper
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{
            fontSize: 11, fontWeight: 600,
            color: gripper.state === 'open' ? 'var(--green)'
                 : gripper.state === 'closed' ? 'var(--accent)'
                 : 'var(--yellow)',
          }}>
            {gripper.state.toUpperCase()}
          </span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            {gripper.position_mm.toFixed(0)} mm
          </span>
        </div>
        <div style={{ marginTop: 4, height: 4, background: 'var(--bg-active)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: `${(gripper.position_mm / 85) * 100}%`,
            height: '100%',
            background: 'var(--accent)',
            borderRadius: 2,
            transition: 'width 300ms',
          }} />
        </div>
      </div>

      {/* TCP pose readout */}
      <div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
          TCP Pose (approx.)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {[['X', tcpX], ['Y', tcpY], ['Z', tcpZ]].map(([axis, val]) => (
            <div key={axis} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{axis}</span>
              <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                {val.toFixed(3)} m
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Task state */}
      <div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
          Task
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          State:&nbsp;
          <span style={{
            fontWeight: 600,
            color: task.state === 'IDLE' ? 'var(--text-muted)'
                : task.state === 'PAUSED' ? 'var(--yellow)'
                : 'var(--accent)',
          }}>
            {task.state}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function View3DLayout() {
  // armRef kept so LeftPanel's preset buttons don't blow up — they
  // no-op (armRef.current is always null) which is fine while the
  // viewer is absent.
  const armRef = useRef(null)

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <LeftPanel armRef={armRef} />
      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#fafafa', color: '#6b7280', fontSize: 14, padding: 24,
        textAlign: 'center',
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
            3D viewer unavailable
          </div>
          <div>
            The articulated arm viewer is paused until Estun provides
            a URDF with verified joint axes.
          </div>
        </div>
      </div>
    </div>
  )
}

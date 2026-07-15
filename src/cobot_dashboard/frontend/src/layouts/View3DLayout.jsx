import { useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ArmViewer3D from '../components/ArmViewer3D'
import StandaloneRobot from '../components/StandaloneRobot'
import JointJogPanel from '../components/JointJogPanel'
import JogControls from '../components/JogControls'
import IKGizmo from '../components/IKGizmo'

// The 3D View tab hosts three separate jog surfaces:
//   • JointJogPanel  (right-dock sliders, TWIN ONLY)  — no wire traffic.
//   • JogControls    (bottom dock, REAL ARM)          — hold-to-jog via
//                                                        /cmd/jog → driver.
//   • IKGizmo        (cartesian drag when cartMode)    — twin-only IK.
//
// The REAL ARM panel is the same component the Program tab renders —
// one source of truth. Its three-state visibility (MINIMIZED / NORMAL /
// EXPANDED) lives in the Zustand store so it survives tab-switches
// without persisting to localStorage.
//
// The retired IncrementalJogPanel used to live in LeftPanel; its API
// path (/cmd/jog with delta_deg) still works, but the pendant
// increments are superseded by hold-to-jog + step-size inching.

const PRESETS = ['Front', 'Side', 'Top', 'Iso']

const REAL_ARM_RED = '#7F1D1D'
const REAL_ARM_HINT = '#FCA5A5'

function LeftPanel({ armRef }) {
  const task = useStore((s) => s.task)

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

        <div>
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
      </div>

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

// The chrome that wraps JogControls when it's docked (NORMAL) or
// expanded (EXPANDED). Draws the red REAL ARM band, the state toggle,
// and the sizing container.
function RealArmChrome({ mode, setMode, children }) {
  const isExpanded = mode === 'EXPANDED'
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderTop: '2px solid ' + REAL_ARM_RED,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      // 440 px NORMAL matches the Program tab's JOG_MIN_HEIGHT (360) after
      // accounting for the red band (28 px) and a small margin so the
      // right-column action stack (6× 44 px + gaps + status + Teach ≈
      // 370 px demand) fits without vertical clipping.
      height: isExpanded ? '100%' : 440,
    }}>
      <div style={{
        background: REAL_ARM_RED, color: '#fff',
        padding: '6px 10px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}>
        <span>REAL ARM · Hold to Jog</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setMode('MINIMIZED')}
            title="Minimize"
            style={chromeBtn}>−</button>
          <button
            onClick={() => setMode(isExpanded ? 'NORMAL' : 'EXPANDED')}
            title={isExpanded ? 'Restore split layout' : 'Expand panel'}
            style={chromeBtn}>{isExpanded ? '✕' : '⛶'}</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  )
}

const chromeBtn = {
  width: 24, height: 24, padding: 0,
  background: 'rgba(255,255,255,0.15)', color: '#fff',
  border: '1px solid rgba(255,255,255,0.35)', borderRadius: 4,
  cursor: 'pointer', fontSize: 13, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

// The docked minimized pill — shows a subtle red button that expands
// the panel back to NORMAL on click.
function RealArmMinimizedPill({ setMode }) {
  const robot = useStore((s) => s.robot) || {}
  const active = !!robot.jog_active
  const label = active
    ? `REAL ARM · J${robot.jog_index} ${robot.jog_direction > 0 ? '+' : robot.jog_direction < 0 ? '−' : ''}`
    : 'REAL ARM · Jog'
  return (
    <button
      onClick={() => setMode('NORMAL')}
      title="Open the real-arm jog pendant"
      style={{
        position: 'absolute',
        bottom: 12, right: 12, zIndex: 15,
        padding: '10px 14px',
        background: active ? REAL_ARM_RED : '#B91C1C',
        color: '#fff',
        border: 'none', borderRadius: 999,
        fontSize: 12, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        cursor: 'pointer',
        boxShadow: '0 4px 10px rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', gap: 8,
        minHeight: 44,   // tablet touch minimum
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: active ? '#FCA5A5' : '#FEE2E2',
        boxShadow: active ? '0 0 6px #FCA5A5' : 'none',
      }} />
      {label}
    </button>
  )
}

export default function View3DLayout() {
  const armRef = useRef(null)
  const [jogApi, setJogApi] = useState(null)
  const [cartMode, setCartMode]     = useState(false)
  const [gizmoMode, setGizmoMode]   = useState('translate')
  const [ikAtLimit, setIkAtLimit] = useState(false)

  const view3dJogPanel   = useStore((s) => s.view3dJogPanel)
  const setView3dJogPanel = useStore((s) => s.setView3dJogPanel)
  const jogPanelMode = view3dJogPanel || 'NORMAL'

  const isExpanded = jogPanelMode === 'EXPANDED'
  const isMinimized = jogPanelMode === 'MINIMIZED'

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <LeftPanel armRef={armRef} />

      <div style={{
        flex: 1, overflow: 'hidden', position: 'relative',
        display: 'flex', flexDirection: 'column', minWidth: 0,
      }}>
        {/* Twin viewer — hidden when the REAL ARM panel is expanded. */}
        {!isExpanded && (
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <ArmViewer3D ref={armRef} noRobot>
              <StandaloneRobot onRobotReady={setJogApi} />
              {cartMode && (
                <IKGizmo
                  jogApi={jogApi}
                  enabled
                  mode={gizmoMode}
                  onDragChange={(d) => {
                    armRef.current?.setOrbitEnabled?.(!d)
                    if (!d) setIkAtLimit(false)
                  }}
                  onTargetPose={(p) => {
                    if (!!p.atLimit !== ikAtLimit) setIkAtLimit(!!p.atLimit)
                  }}
                />
              )}
            </ArmViewer3D>
            {cartMode && ikAtLimit && (
              <div style={{
                position: 'absolute', top: 8, right: 8, zIndex: 20,
                padding: '4px 10px', borderRadius: 4,
                background: '#DC2626', color: '#fff',
                fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
                fontWeight: 700, letterSpacing: 0.6,
                boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                pointerEvents: 'none',
              }}>
                AT LIMIT
              </div>
            )}
            <JointJogPanel
              jogApi={jogApi}
              cartesianMode={cartMode}
              onCartesianModeChange={setCartMode}
              gizmoMode={gizmoMode}
              onGizmoModeChange={setGizmoMode}
              onHome={() => jogApi?.home?.()}
              onAtLimit={(atLimit) => setIkAtLimit(!!atLimit)}
            />
            {isMinimized && <RealArmMinimizedPill setMode={setView3dJogPanel} />}
          </div>
        )}

        {/* REAL ARM jog dock */}
        {!isMinimized && (
          <RealArmChrome mode={jogPanelMode} setMode={setView3dJogPanel}>
            {/* runConfirm — 3D View's Run button opens a confirm modal
                showing the program name + step count, so a stray click
                on this tab doesn't start motion. Program tab bypasses. */}
            <JogControls maximized={isExpanded} runConfirm />
          </RealArmChrome>
        )}
      </div>
    </div>
  )
}

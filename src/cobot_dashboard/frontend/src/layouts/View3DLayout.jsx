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

// Slim left rail (Part 3b, 2026-07-17). Previous 240 px width was
// wide enough for a full label column but wasted canvas real estate at
// 1155-1280 px tablet widths where the 3D twin needs every pixel. New:
// camera presets as a compact segmented row, TASK as a single-line
// chip. Touch targets stay ≥ 44 px so tablet ops still hit the presets
// cleanly. Total rail width now ~130 px (borders + padding included).
const RAIL_W = 130
function LeftPanel({ armRef }) {
  const task = useStore((s) => s.task) || {}
  const taskState = task.state || 'IDLE'
  const taskColor = taskState === 'IDLE' ? 'var(--text-muted)'
                  : taskState === 'PAUSED' ? 'var(--yellow)'
                  : 'var(--accent)'
  return (
    <div style={{
      width: RAIL_W,
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      padding: '10px 8px',
      gap: 12,
    }}>
      <div>
        <div style={{
          fontSize: 9, textTransform: 'uppercase',
          color: 'var(--text-muted)', letterSpacing: '0.06em',
          marginBottom: 4,
        }}>
          Camera
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 3,
        }}>
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => armRef.current?.setCameraPreset(p.toLowerCase())}
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                padding: 0,
                minHeight: 44,   // tablet touch target
                borderRadius: 'var(--radius-sm)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: '0.02em',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 10, color: 'var(--text-muted)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <span>Task</span>
        <span style={{ fontWeight: 700, color: taskColor,
                       letterSpacing: 0, textTransform: 'none' }}>
          {taskState}
        </span>
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
      {/* Part 3a parity fix (2026-07-17): hide the left rail while the
          REAL ARM panel is EXPANDED so the shared JogControls receives
          the SAME width as it does on the Program tab's expanded view.
          Without this, LeftPanel eats ~130 px and the pad's tablet-
          breakpoint sizing kicked in one step earlier than on the
          Program tab, producing a visibly smaller layout for the same
          `maximized=true` flag. */}
      {!isExpanded && <LeftPanel armRef={armRef} />}

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
            <MinClearanceReadout />
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

// Live min-clearance chip — appears in the 3D View top-left whenever
// the unified guard reports any pair closer than 2× warn distance. This
// is the NON-BLOCKING presentation for the warn band; the popup only
// takes over at stop. Amber in warn, red in stop. Renders under the
// AT-LIMIT chip so both stay visible when they co-occur.
function MinClearanceReadout() {
  // Prefer the unified guard state (self / ground / env aggregated by
  // the driver) so a self-collision fold surfaces the same way as an
  // env obstacle. Fall back to the legacy self-collision keys for
  // driver builds pre-guard-unification. ALL useStore hooks are called
  // unconditionally at the top of the component — the fallback merge
  // happens in plain JS below (previously used `||`/`??` between hook
  // calls, which broke hook-order on any state transition where the
  // primary key flipped truthiness → React #300).
  const guardPair    = useStore((s) => s.robot?.guard_pair)
  const collisionPair = useStore((s) => s.robot?.collision_pair)
  const guardMin     = useStore((s) => s.robot?.guard_min_mm)
  const collisionMin = useStore((s) => s.robot?.collision_min_mm)
  const guardWarn    = useStore((s) => s.robot?.guard_warn_mm)
  const collisionWarn = useStore((s) => s.robot?.collision_warn_mm)
  const guardStop    = useStore((s) => s.robot?.guard_stop_mm)
  const collisionStop = useStore((s) => s.robot?.collision_stop_mm)
  const enabled      = useStore((s) => s.robot?.collision_enabled)

  const pair = guardPair || collisionPair
  const dist = guardMin != null ? guardMin : collisionMin
  const warn = (guardWarn || collisionWarn || 80)
  const stop = (guardStop || collisionStop || 30)
  if (!enabled || dist == null || !pair) return null
  if (dist > 2 * warn) return null   // only show when actually close
  const level = dist <= stop ? 'stop' : (dist <= warn ? 'warn' : 'near')
  const bg = level === 'stop' ? '#B91C1C'
           : level === 'warn' ? '#D97706'
           :                    '#0f172a'
  const label = level === 'stop' ? 'CONTACT'
              : level === 'warn' ? 'CLEARANCE'
              :                    'clearance'
  const shorten = (n) => n
    .replace('_shoulder', '').replace('_upper_arm', '')
    .replace('_forearm',  '').replace('_wrist1',    '')
    .replace('_wrist2',   '').replace('_flange',    '')
    .replace('__ground__', 'ground')
    .replace(/^zone#/, 'zone:')
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8, zIndex: 20,
      padding: '4px 10px', borderRadius: 4,
      background: bg, color: '#fff',
      fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
      fontWeight: 700, letterSpacing: 0.5,
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      pointerEvents: 'none',
    }}>
      {label}: {dist.toFixed(0)} mm  {shorten(pair[0])}↔{shorten(pair[1])}
    </div>
  )
}

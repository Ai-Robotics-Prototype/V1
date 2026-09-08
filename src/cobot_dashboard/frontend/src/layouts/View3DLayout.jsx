import { useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ArmViewer3D from '../components/ArmViewer3D'
import StandaloneRobot from '../components/StandaloneRobot'
import JointJogPanel from '../components/JointJogPanel'
import JogControls from '../components/JogControls'
import IKGizmo from '../components/IKGizmo'
import ArmEnableControl from '../components/ArmEnableControl'
import JogReadyBadge from '../components/JogReadyBadge'
// 2026-09-08 operator directive: MODE • MANUAL chip + its confirm
// dialog RETIRED. Mode switching from the UI is gone; operators
// route mode via the physical pendant selector. Backend endpoint
// (POST /api/estun/mode) stays live for CRI / driver internal use.

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

const REAL_ARM_RED = '#7F1D1D'

// 2026-09-08 operator directive: left sidebar (Camera preset tiles
// + Task readout) RETIRED. The single view-switcher lives in the
// top-left corner overlay of the 3D viewport itself (ArmViewer3D's
// existing preset pill row at L1632). The 3D canvas expands to
// use the reclaimed 130 px width.
//
// TASK/IDLE readout consumers: LeftPanel was the ONLY renderer;
// no other surface reads useStore.task from this layout. Dropped
// per directive item 3 ("otherwise drop it") — task state is
// already visible on the Monitor page's StatusBadge.

// The chrome that wraps JogControls when it's docked (NORMAL) or
// expanded (EXPANDED). The 2026-08-06 operator directive retires the
// full-width red REAL ARM band in favor of the shared
// <ArmEnableControl /> chip (fork registry: arm_enable_control) —
// the ONE canonical arm-enable surface, rendered here AND on the
// Monitor page so toggling in either reflects live in the other via
// the shared useStore state.
function RealArmChrome({ mode, setMode, children }) {
  const isExpanded = mode === 'EXPANDED'
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderTop: '2px solid ' + REAL_ARM_RED,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      // 440 px NORMAL preserves the Program tab's JOG_MIN_HEIGHT (360)
      // budget after the compact chip header (~34 px w/ borders).
      height: isExpanded ? '100%' : 440,
    }}>
      <div style={{
        padding: '5px 8px',
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexShrink: 0,
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <ArmEnableControl />
          {/* 2026-09-04 operator directive: compact READY / NOT-READY
              badge replaces the full-width green banner inside
              JogControls. Placed directly next to the enable button
              so the operator's pre-jog cue stays visible at a glance
              without eating banner-height. */}
          <JogReadyBadge />
          {/* 2026-09-08 operator directive: <ModeControl /> retired. */}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {/* 2026-09-08 operator directive: coherent pair with the
              "Expand Jog Buttons" pill — this button reads
              "Collapse Jog Buttons" when collapsing back to the
              minimized pill state. Full-width toggle between
              NORMAL and EXPANDED still uses the ⛶ / ✕ glyph
              since it's a layout modifier, not the jog-visibility
              toggle. */}
          <button
            data-testid="collapse-jog-buttons"
            onClick={() => setMode('MINIMIZED')}
            title="Collapse Jog Buttons"
            style={{
              ...chromeBtn,
              width: 'auto', padding: '0 12px',
              fontSize: 11, fontWeight: 600,
              letterSpacing: '0.02em',
            }}>Collapse Jog Buttons</button>
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
  width: 26, height: 26, padding: 0,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4,
  cursor: 'pointer', fontSize: 14, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

// The docked minimized pill — GREEN button labeled "Expand Jog
// Buttons" (matches the Monitor Run button's #16A34A green, per
// 2026-09-08 operator directive). When the jog surface is open,
// the chrome header's collapse control reads "Collapse Jog
// Buttons" — the pair stays coherent.
//
// If a jog hold is live, the button surfaces the joint + direction
// as a subtitle so a stray tab-switch operator sees the arm is
// under load; button copy stays "Expand Jog Buttons" so activation
// language is consistent.
function RealArmMinimizedPill({ setMode }) {
  const robot = useStore((s) => s.robot) || {}
  const active = !!robot.jog_active
  const holdLabel = active
    ? `J${robot.jog_index} ${robot.jog_direction > 0 ? '+' : robot.jog_direction < 0 ? '−' : ''}`
    : ''
  return (
    <button
      data-testid="expand-jog-buttons"
      onClick={() => setMode('NORMAL')}
      title="Open the jog pad"
      style={{
        position: 'absolute',
        bottom: 12, right: 12, zIndex: 15,
        padding: '12px 22px',
        background: '#16A34A', color: '#fff',
        border: 'none', borderRadius: 10,
        fontSize: 15, fontWeight: 700,
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(22,163,74,0.35)',
        display: 'flex', alignItems: 'center', gap: 10,
        minHeight: 44,
      }}
    >
      {active && (
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#FEE2E2',
          boxShadow: '0 0 6px #FCA5A5',
        }} />
      )}
      <span>Expand Jog Buttons</span>
      {holdLabel && (
        <span style={{
          fontSize: 11, opacity: 0.85, fontWeight: 600,
          fontFamily: 'var(--font-mono, monospace)',
        }}>{holdLabel}</span>
      )}
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
      {/* 2026-09-08 operator directive: left sidebar retired. The
          view-switcher moved into the ArmViewer3D top-left overlay
          (already there at L1632); the 3D canvas reclaims the
          ~130 px LeftPanel used to occupy. */}

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

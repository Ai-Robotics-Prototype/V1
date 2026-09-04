// components/JogReadyBadge.jsx — compact READY / NOT READY badge
// placed next to <ArmEnableControl /> on the 3D View jog surface.
//
// 2026-09-04 operator directive: the full-width READY / NOT-READY
// banner inside JogControls goes away in favour of this small chip
// (green dot + word). The state information stays visible at a
// glance — it's the operator's pre-jog cue — just compact.
//
// The precedence table below MUST stay byte-aligned with the
// bannerLevel / bannerText computation in JogControls.jsx so the
// two never disagree about "is jog gated open right now". JogControls
// still owns the gate itself (see `jogGateOk`); this component is a
// PURELY VISUAL mirror.

import { useStore } from '../store/useStore'

const DOT_READY = '#22C55E'
const DOT_WARN  = '#EAB308'
const DOT_ERROR = '#EF4444'

const BG_READY  = 'rgba(16, 185, 129, 0.10)'
const BG_WARN   = 'rgba(234, 179,   8, 0.10)'
const BG_ERROR  = 'rgba(239,  68,  68, 0.12)'

const BORDER_READY = '#059669'
const BORDER_WARN  = '#B45309'
const BORDER_ERROR = '#B91C1C'

function computeReadyState(store) {
  const robot   = store.robot || {}
  const safety  = store.safety || {}
  const estop   = !!safety.estop
  const task    = store.task || {}
  const state   = String(task.state || '').toLowerCase()
  const running = state === 'running' || state === 'paused'
  const outOfRangeJoints = Array.isArray(robot.joint_limits)
    ? robot.joint_limits.filter((j) => j && j.out_of_range)
    : []
  const anyOutOfRange = outOfRangeJoints.length > 0

  // Precedence matches JogControls.jsx bannerText: E-STOP → driver
  // disconnected → joint past limit → alarm → back-in-range → enabling
  // → disabled → program running → jog gate closed → READY.
  if (estop)             return { level: 'error', text: 'NOT READY: E-STOP' }
  if (!robot.connected)  return { level: 'error', text: 'NOT READY: DRIVER DISCONNECTED' }
  if (anyOutOfRange) {
    const label = outOfRangeJoints.length > 1
      ? `NOT READY: JOINTS PAST LIMIT (${outOfRangeJoints.map((j) => 'J' + j.joint).join(', ')})`
      : `NOT READY: J${outOfRangeJoints[0].joint} PAST LIMIT`
    return { level: 'error', text: label }
  }
  if (robot.alarm)       return { level: 'error', text: 'NOT READY: ALARM' }
  if (robot.enabling)    return { level: 'warn',  text: 'ENABLING…' }
  if (!robot.enabled)    return { level: 'warn',  text: 'NOT READY: DISABLED' }
  if (running)           return { level: 'warn',  text: 'NOT READY: PROGRAM RUNNING' }
  if (!robot.allow_jog)  return { level: 'warn',  text: 'NOT READY: JOG GATE CLOSED' }
  return { level: 'ready', text: 'READY' }
}

export default function JogReadyBadge() {
  const state = useStore(computeReadyState)
  const dot    = state.level === 'ready' ? DOT_READY
               : state.level === 'warn'  ? DOT_WARN
               :                           DOT_ERROR
  const bg     = state.level === 'ready' ? BG_READY
               : state.level === 'warn'  ? BG_WARN
               :                           BG_ERROR
  const border = state.level === 'ready' ? BORDER_READY
               : state.level === 'warn'  ? BORDER_WARN
               :                           BORDER_ERROR
  return (
    <div
      data-testid="jog-ready-badge"
      data-ready={state.level === 'ready' ? 'true' : 'false'}
      data-level={state.level}
      title={state.text}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px',
        fontSize: 11, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        border: `1px solid ${border}`,
        borderRadius: 6,
        background: bg,
        color: border,
        minHeight: 26,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}>
      <span aria-hidden="true"
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: dot,
              boxShadow: `0 0 4px ${dot}`,
              flexShrink: 0,
            }} />
      <span>{state.text}</span>
    </div>
  )
}

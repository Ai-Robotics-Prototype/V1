// components/ArmEnableControl.jsx — the SINGLE canonical arm-enable
// control surface (fork registry: arm_enable_control).
//
// One compact chip that:
//   1. Renders the arm state (ALARM | ENABLING | JOG J<i>±  | READY |
//      DISABLED) with a colored status dot.
//   2. Offers an Enable / Disable toggle button, gated by
//      `robot.allow_power`.
//   3. Uses the SAME safety path as JogControls' Enable/Disable
//      modal: sendPowerCommand('enable'|'disable') behind a
//      window.confirm() with the same copy the JogControls modal
//      shows. Hold-to-jog dead-man is unrelated and untouched.
//
// Rendered on BOTH surfaces that need to change arm power:
//   • layouts/View3DLayout.jsx (RealArmChrome header)
//   • pages/MonitorDashboard.jsx (near the run controls)
//
// Both instances bind the same `useStore` state (`robot.enabled`,
// `robot.enabling`, `robot.alarm`, `robot.allow_power`, ...), so
// toggling on one surface immediately reflects on the other via the
// existing WS-mirrored store.
//
// This component MUST be the ONLY implementation of the enable/
// disable control. Fork registry entry `arm_enable_control` blocks a
// second one at deploy time.

import { useStore } from '../store/useStore'

const REAL_ARM_RED = '#7F1D1D'

export default function ArmEnableControl() {
  const robot = useStore((s) => s.robot) || {}
  const sendPowerCommand = useStore((s) => s.sendPowerCommand)
  const enabled    = !!robot.enabled
  const enabling   = !!robot.enabling
  const alarm      = !!robot.alarm
  const allowPower = !!robot.allow_power
  const jogActive  = !!robot.jog_active

  // Terse state label. Priority: ALARM > ENABLING > JOG (active hold)
  // > controller state_name > ENABLED > DISABLED.
  const stateLabel =
      alarm    ? 'ALARM'
    : enabling ? 'ENABLING'
    : (enabled && jogActive)
             ? `JOG J${robot.jog_index ?? '?'}${robot.jog_direction > 0 ? '+' : robot.jog_direction < 0 ? '−' : ''}`
    : enabled  ? (robot.state_name || 'READY')
    :            'DISABLED'
  const stateColor =
      alarm    ? '#B91C1C'
    : enabling ? '#D97706'
    : enabled  ? '#059669'
    :            '#6b7280'

  const wantEnable = !enabled
  const canToggle  = allowPower && !enabling

  const onTogglePower = () => {
    if (!canToggle) return
    const msg = wantEnable
      ? 'Enable robot power?\n\nEnsure the cell is clear before applying servo power.'
      : 'Disable robot power?\n\nServo power will drop. Any active motion is stopped first.'
    // Same confirmation invariant as the JogControls modal — plain
    // window.confirm is enough for a safety gate; the operator can't
    // accidentally click through it. Do NOT change this to a bespoke
    // dialog without also updating the JogControls twin path — the
    // safety gate lives in the two-step (confirm → dispatch) shape.
    // eslint-disable-next-line no-alert
    if (window.confirm(msg)) {
      sendPowerCommand?.(wantEnable ? 'enable' : 'disable')
    }
  }

  return (
    <div
      data-testid="arm-enable-control"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'rgba(127, 29, 29, 0.08)',
        border: '1px solid ' + REAL_ARM_RED,
        borderRadius: 6, padding: '3px 8px',
        fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
        color: REAL_ARM_RED, textTransform: 'uppercase',
        minHeight: 26,
      }}>
      <span>REAL ARM</span>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: stateColor,
        boxShadow: `0 0 4px ${stateColor}`,
      }} />
      <span style={{ color: stateColor }}>{stateLabel}</span>
      <button
        onClick={onTogglePower}
        disabled={!canToggle}
        title={enabled
          ? (allowPower ? 'Disable robot power' : 'Power gate closed — pendant only')
          : (allowPower ? 'Enable robot power'  : 'Power gate closed — pendant only')}
        style={{
          marginLeft: 4, padding: '2px 8px', minHeight: 22,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase',
          border: '1px solid ' + REAL_ARM_RED,
          borderRadius: 4,
          background: enabled ? '#fff' : REAL_ARM_RED,
          color:      enabled ? REAL_ARM_RED : '#fff',
          cursor: canToggle ? 'pointer' : 'not-allowed',
          opacity: canToggle ? 1 : 0.5,
        }}>
        {enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  )
}

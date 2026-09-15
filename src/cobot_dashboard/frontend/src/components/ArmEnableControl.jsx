// components/ArmEnableControl.jsx — the SINGLE canonical arm-enable
// control surface (fork registry: arm_enable_control).
//
// 2026-08-31 directive: a SINGLE stateful button — no more
// chip+button combo, no more state label. Wire state is authority
// (state === 2 numeric = ENABLED per FACTS.md); the button label
// flips accordingly ("Disable" when enabled, "Enable" when
// disabled). In-flight spinner during the transition. Confirm
// dialog on ENABLE only — motion becomes possible on enable, so
// the safety gate lives there; disable stops motion and is
// non-destructive from a "did I mean it" perspective.
//
// Rendered on both surfaces that need to change arm power:
//   • layouts/View3DLayout.jsx (RealArmChrome header)
//   • pages/MonitorDashboard.jsx (near the run controls)
//
// Both instances bind the same `useStore` state, so toggling on
// one surface immediately reflects on the other via the existing
// WS-mirrored store.
//
// This component MUST be the ONLY implementation of the enable/
// disable control. Fork registry entry `arm_enable_control` blocks
// a second one at deploy time.

import { useStore } from '../store/useStore'

const ENABLED_GREEN  = '#059669'
const DISABLED_RED   = '#7F1D1D'
const ENABLING_AMBER = '#D97706'

export default function ArmEnableControl() {
  const robot = useStore((s) => s.robot) || {}
  const sendPowerCommand = useStore((s) => s.sendPowerCommand)
  // Wire authority: numeric state code (per FACTS.md > silent
  // classes — enabled ≡ state === 2). Boolean `robot.enabled`
  // stays as a legacy fallback for older builds / mocks where
  // `state_code` isn't populated yet.
  const stateCode  = Number.isFinite(robot.state_code) ? robot.state_code : null
  const enabled    = stateCode === 2
                     || (stateCode === null && !!robot.enabled)
  const enabling   = !!robot.enabling
  const allowPower = !!robot.allow_power

  const wantEnable = !enabled
  const canToggle  = allowPower && !enabling

  const onTogglePower = () => {
    if (!canToggle) return
    if (wantEnable) {
      // Confirm on enable ONLY — motion becomes possible from
      // this action, so the gate lives here. Disable stops
      // motion and needs no confirm (the operator has already
      // decided to remove power).
      // eslint-disable-next-line no-alert
      if (!window.confirm(
        'Enable robot power?\n\n'
        + 'Ensure the cell is clear before applying servo power.'
      )) return
      sendPowerCommand?.('enable')
    } else {
      sendPowerCommand?.('disable')
    }
  }

  // Terse label. In-flight state (enabling) spells out ENABLING…
  // so the operator sees the transition without any dot.
  const label = enabling
    ? 'Enabling…'
    : enabled ? 'Disable' : 'Enable'
  const accent = enabling
    ? ENABLING_AMBER
    : enabled ? DISABLED_RED : ENABLED_GREEN
  const bg = enabling
    ? '#fff'
    : enabled ? DISABLED_RED : ENABLED_GREEN
  const fg = enabling
    ? ENABLING_AMBER
    : '#fff'

  const title =
      !allowPower ? 'Power gate closed — pendant only'
    : enabling    ? 'Enable request in flight'
    : enabled     ? 'Disable robot power'
    :               'Enable robot power'

  return (
    <button
      data-testid="arm-enable-control"
      data-enabled={enabled ? 'true' : 'false'}
      data-enabling={enabling ? 'true' : 'false'}
      onClick={onTogglePower}
      disabled={!canToggle}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        minHeight: 34,
        padding: '6px 14px',
        fontSize: 13, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        border: `1px solid ${accent}`,
        borderRadius: 6,
        background: bg, color: fg,
        cursor: canToggle ? 'pointer' : 'not-allowed',
        opacity: canToggle ? 1 : 0.55,
      }}>
      {enabling && (
        <span aria-hidden="true"
              data-testid="arm-enable-spinner"
              style={{
                width: 12, height: 12,
                border: `2px solid ${ENABLING_AMBER}`,
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'arm-enable-spin 0.8s linear infinite',
                display: 'inline-block',
              }} />
      )}
      <span>{label}</span>
      <style>{`
        @keyframes arm-enable-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </button>
  )
}

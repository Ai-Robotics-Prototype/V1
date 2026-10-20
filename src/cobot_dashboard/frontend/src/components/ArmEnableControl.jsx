// components/ArmEnableControl.jsx — the SINGLE canonical arm-enable
// control surface (fork registry: arm_enable_control).
//
// 2026-08-31 directive: a SINGLE stateful button — no more
// chip+button combo, no more state label. Wire state is authority
// (state === 2 numeric = ENABLED per FACTS.md); the button label
// flips accordingly ("Disable" when enabled, "Enable" when
// disabled). In-flight spinner during the transition.
//
// 2026-09-17 native-popup ban: both Enable AND Disable now open the
// app-theme confirmation modal (mirror of OrientFlangeDownControl —
// same backdrop / no click-through / Escape-cancels contract). No
// native window.confirm anywhere in the enable flow. Enable primary
// button is green (matches ENABLED_GREEN chip); Disable primary is
// red (matches DISABLED_RED chip). Body copy plain-language:
//   Enable:  "The arm will power its motors and be ready to move."
//   Disable: "Motor power will be turned off."
// Backdrop dismissal disabled per app doctrine — Cancel + Escape
// only. Fetch (sendPowerCommand) fires ONLY on Confirm click, so
// endpoint gating is unchanged vs the retired native-confirm path.
//
// Rendered on both surfaces that need to change arm power:
//   • layouts/View3DLayout.jsx (LEFT column top slot, immersive)
//   • pages/MonitorDashboard.jsx (near the run controls)
//
// Both instances bind the same `useStore` state, so toggling on
// one surface immediately reflects on the other via the existing
// WS-mirrored store.
//
// This component MUST be the ONLY implementation of the enable/
// disable control. Fork registry entry `arm_enable_control` blocks
// a second one at deploy time.

import { useEffect, useRef, useState } from 'react'
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

  // Modal state — replaces window.confirm per 2026-09-17 operator
  // directive. `pendingAction` captures which flow the modal is
  // gating (mirror of OrientFlangeDownControl's modalOpen +
  // implicit action pattern; here we track the action explicitly
  // so a mid-modal state flip doesn't send the wrong command).
  const [pendingAction, setPendingAction] = useState(null)   // 'enable' | 'disable' | null
  const confirmBtnRef = useRef(null)

  useEffect(() => {
    if (!pendingAction) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setPendingAction(null)
    }
    window.addEventListener('keydown', onKey)
    // Autofocus the primary button — Enter fires Confirm, Escape
    // cancels (matches the Orient modal keyboard contract).
    try { confirmBtnRef.current?.focus() } catch { /* nop */ }
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingAction])

  const onTogglePower = () => {
    if (!canToggle) return
    setPendingAction(wantEnable ? 'enable' : 'disable')
  }

  const onCancel = () => setPendingAction(null)

  const onConfirm = () => {
    const action = pendingAction
    setPendingAction(null)
    if (action) sendPowerCommand?.(action)
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

  // Modal copy — plain-language per operator directive. Colors and
  // labels mirror the terminal state each action drives toward
  // (enable → green, disable → red).
  const modalCopy = pendingAction === 'enable' ? {
    title: 'Enable robot?',
    body: 'The arm will power its motors and be ready to move.',
    cta: 'Enable',
    cta_bg: ENABLED_GREEN,
    cta_border: '#047857',
  } : pendingAction === 'disable' ? {
    title: 'Disable robot?',
    body: 'Motor power will be turned off.',
    cta: 'Disable',
    cta_bg: DISABLED_RED,
    cta_border: '#5B1414',
  } : null

  return (
    <>
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

      {pendingAction && modalCopy && (
        <div
          data-testid="arm-enable-backdrop"
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            // Backdrop click-through intentionally NOT wired —
            // dismissal via Cancel + Escape only (mirrors the
            // Orient modal contract).
            pointerEvents: 'auto',
          }}
          role="presentation"
        >
          <div
            data-testid="arm-enable-modal"
            data-action={pendingAction}
            role="dialog"
            aria-modal="true"
            aria-labelledby="arm-enable-modal-title"
            style={{
              background: '#fff', color: '#111318',
              border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8,
              boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
              padding: 20, minWidth: 320, maxWidth: 440,
              display: 'flex', flexDirection: 'column', gap: 12,
              fontFamily: 'var(--font, system-ui)', fontSize: 13,
            }}
          >
            <div
              id="arm-enable-modal-title"
              style={{
                fontSize: 16, fontWeight: 700, color: '#0f172a',
                letterSpacing: 0.2,
              }}>
              {modalCopy.title}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
              {modalCopy.body}
            </div>
            <div style={{
              display: 'flex', justifyContent: 'flex-end', gap: 8,
              marginTop: 4,
            }}>
              <button
                type="button"
                data-testid="arm-enable-cancel"
                onClick={onCancel}
                style={{
                  padding: '8px 14px', borderRadius: 6,
                  background: '#F3F4F6', color: '#111827',
                  border: '1px solid #D1D5DB', fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                ref={confirmBtnRef}
                data-testid="arm-enable-confirm"
                onClick={onConfirm}
                style={{
                  padding: '8px 14px', borderRadius: 6,
                  background: modalCopy.cta_bg, color: '#fff',
                  border: `1px solid ${modalCopy.cta_border}`,
                  fontWeight: 700, cursor: 'pointer',
                }}
              >
                {modalCopy.cta}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

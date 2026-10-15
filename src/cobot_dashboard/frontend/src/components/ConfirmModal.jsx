// components/ConfirmModal.jsx — the shared app-theme confirm dialog.
//
// 2026-10-15 operator directive: replace native window.confirm on
// delete-program (and sibling destructive confirms) with the app's
// standard styled modal. ArmEnableControl and OrientFlangeDownControl
// have inlined the same shape since 2026-09-17 (backdrop, no-click-
// through, Escape cancels, autofocus primary); the audit flagged ~22
// grandfathered native popups. This component extracts their proven
// pattern token-for-token into a reusable mount point so new destructive
// confirms don't bring back the native dialog by accident.
//
// Tokens are byte-identical to ArmEnableControl.jsx:170-243:
//   * Backdrop:   fixed inset-0, z 1000, rgba(15,23,42,0.55)
//   * Card:       #fff bg, radius 8, 12/32 shadow, 20px pad, 320-440 w
//   * Title:      16px / 700 / #0f172a / letter-spacing 0.2
//   * Body:       13px / #334155 / line-height 1.5
//   * Buttons:    8/14 pad, radius 6, Cancel #F3F4F6/#111827, primary
//                 colored per `danger` (red/danger) or default (green).
//
// Keyboard contract (mirrors ArmEnable / Orient / profile-switch):
//   * Escape → onCancel.
//   * Confirm button autofocused → Enter fires onConfirm.
//   * Backdrop click-through NOT wired — Cancel + Escape only. This
//     is the app doctrine for destructive actions (prevents a stray
//     tap outside the card from dismissing a confirmation).
//
// Props:
//   open:          boolean — render + mount keyboard listener only when true.
//   title:         string  — modal headline.
//   body:          string | React node — operator-facing explanation.
//   confirmLabel:  string  — primary button copy ("Delete").
//   cancelLabel:   string  — secondary button copy (default "Cancel").
//   danger:        boolean — true styles the primary as the destructive
//                            red (matches DISABLED_RED token from
//                            ArmEnableControl); false styles as green.
//   onConfirm:     () => void — fires when primary is clicked.
//   onCancel:      () => void — fires on Cancel click AND on Escape.
//   testIdPrefix:  string  — namespace the data-testids (e.g.
//                            "program-delete-confirm" → "-backdrop",
//                            "-modal", "-cancel", "-confirm").

import { useEffect, useRef } from 'react'

// Token mirror of ArmEnableControl / OrientFlangeDownControl.
const DANGER_BG     = '#7F1D1D'
const DANGER_BORDER = '#5B1414'
const ENABLE_BG     = '#059669'
const ENABLE_BORDER = '#047857'

export default function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  testIdPrefix = 'confirm',
}) {
  const confirmBtnRef = useRef(null)

  // Keyboard contract — Escape cancels, Enter is implicit via the
  // autofocused primary button's default-button behavior. Only wire
  // when open so unrelated keyboard events on other pages aren't
  // intercepted when the modal is dormant.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.()
    }
    window.addEventListener('keydown', onKey)
    try { confirmBtnRef.current?.focus() } catch { /* nop */ }
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const ctaBg     = danger ? DANGER_BG     : ENABLE_BG
  const ctaBorder = danger ? DANGER_BORDER : ENABLE_BORDER

  return (
    <div
      data-testid={`${testIdPrefix}-backdrop`}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Backdrop click-through intentionally NOT wired —
        // dismissal via Cancel + Escape only (mirrors the
        // Orient / Enable modal contract).
        pointerEvents: 'auto',
      }}
      role="presentation"
    >
      <div
        data-testid={`${testIdPrefix}-modal`}
        data-danger={danger ? 'true' : 'false'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testIdPrefix}-title`}
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
          id={`${testIdPrefix}-title`}
          style={{
            fontSize: 16, fontWeight: 700, color: '#0f172a',
            letterSpacing: 0.2,
          }}>
          {title}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
          {body}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          marginTop: 4,
        }}>
          <button
            type="button"
            data-testid={`${testIdPrefix}-cancel`}
            onClick={onCancel}
            style={{
              padding: '8px 14px', borderRadius: 6,
              background: '#F3F4F6', color: '#111827',
              border: '1px solid #D1D5DB', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            data-testid={`${testIdPrefix}-confirm`}
            onClick={onConfirm}
            style={{
              padding: '8px 14px', borderRadius: 6,
              background: ctaBg, color: '#fff',
              border: `1px solid ${ctaBorder}`,
              fontWeight: 700, cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

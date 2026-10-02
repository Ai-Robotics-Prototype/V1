// TeachLockBanner — shared lock UI (2026-08-05 fork-1 kill).
//
// Fork registry: teach_lock_banner. Every surface that renders the
// "teaching in progress on another device" state must use THIS
// component — no bare disabledReason strings, no ad-hoc banners.
// The 0f884c6 spec required a locked banner PLUS a Take Over button
// on every lock surface; a fork was landing "Record disabled —
// observing" on the fullscreen teach overlay with the button missing
// (only accessible on the underlying editor tab, which the overlay
// obscures). This component is the fix.
//
// Copy follows the 267108a register:
//   "Teaching in progress on <device> (last active Xm ago) —
//    Take over to teach here."
// If the age is under 60s, we render "just now" instead of "0m ago"
// so the reader doesn't wonder whether "0m" means expired.

import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store/useStore'


// ── Age helper ─────────────────────────────────────────────────

function ageLabel(updatedTs) {
  if (!updatedTs) return null
  const t = Date.parse(updatedTs)          // 'YYYY-MM-DDTHH:MM:SSZ' → epoch ms
  if (!Number.isFinite(t)) return null
  const ageS = Math.max(0, (Date.now() - t) / 1000)
  if (ageS < 60)     return 'just now'
  if (ageS < 90)     return '1m ago'
  if (ageS < 3600)   return `${Math.round(ageS / 60)}m ago`
  const h = ageS / 3600
  if (h < 2)         return '1h ago'
  return `${Math.round(h)}h ago`
}


// ── Shared banner ──────────────────────────────────────────────

/**
 * Props:
 *   session:       Teach-session dict from robot.teach_sessions[pid].
 *                  Reads owner_device_id, owner_label, updated_ts.
 *   programId:     For the Take Over API call.
 *   variant:       'inline' (default — thin banner for the editor tab)
 *                  or 'overlay' (elevated, high-contrast — for the
 *                  fullscreen teach overlay, sits above the arrow pad).
 *   onTakeOver:    Optional post-takeover callback. Called with the
 *                  raw takeOverTeachSession result. If omitted, no
 *                  post-action navigation; the caller reacts to the
 *                  session state update via the WS state stream.
 */
export default function TeachLockBanner({ session, programId, variant = 'inline', onTakeOver }) {
  const takeOverTeachSession = useStore((s) => s.takeOverTeachSession)
  const [inFlight, setInFlight] = useState(false)

  const ownerName = session?.owner_label || session?.owner_device_id || 'another device'
  const age = useMemo(() => ageLabel(session?.updated_ts), [session?.updated_ts])

  const confirm = useCallback(async () => {
    if (inFlight) return
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Take over teaching from ${ownerName}? `
      + `Their record buttons will lock. Poses already recorded are preserved.`)
    if (!ok) return
    setInFlight(true)
    try {
      const result = await takeOverTeachSession(programId, '')
      if (onTakeOver) {
        try { onTakeOver(result) } catch (_) { /* nop */ }
      }
    } finally {
      setInFlight(false)
    }
  }, [inFlight, ownerName, programId, takeOverTeachSession, onTakeOver])

  if (!session || !programId) return null

  const isOverlay = variant === 'overlay'
  const bg     = isOverlay ? '#78350F' : '#FEF3C7'
  const border = isOverlay ? '#B45309' : '#F59E0B'
  const fg     = isOverlay ? '#FEF3C7' : '#78350f'
  const btnBg  = isOverlay ? '#FDE68A' : '#FDE68A'
  const btnBd  = isOverlay ? '#78350F' : '#B45309'
  const btnFg  = '#78350f'

  return (
    <div
      data-testid="teach-lock-banner"
      data-variant={variant}
      style={{
        padding: isOverlay ? '10px 16px' : '8px 16px',
        background: bg,
        borderTop:    isOverlay ? `2px solid ${border}` : undefined,
        borderBottom: isOverlay ? `2px solid ${border}` : `1px solid ${border}`,
        display: 'flex', alignItems: 'center',
        gap: 12,
        fontSize: isOverlay ? 14 : 13,
        color: fg,
        fontWeight: isOverlay ? 600 : 400,
      }}>
      <span style={{ flex: 1 }}>
        ⚠ Teaching in progress on{' '}
        <b>{ownerName}</b>
        {age ? ` (last active ${age})` : ''}
        {' '}— Take over to teach here.
      </span>
      <button
        data-testid="teach-lock-take-over"
        disabled={inFlight}
        onClick={confirm}
        style={{
          padding: isOverlay ? '8px 18px' : '4px 12px',
          background: btnBg,
          border: `1px solid ${btnBd}`,
          borderRadius: 4,
          fontSize: isOverlay ? 14 : 12,
          color: btnFg,
          fontWeight: 700,
          cursor: inFlight ? 'wait' : 'pointer',
          opacity: inFlight ? 0.55 : 1,
          whiteSpace: 'nowrap',
        }}>
        {inFlight ? 'Taking over…' : 'Take over teaching →'}
      </button>
    </div>
  )
}

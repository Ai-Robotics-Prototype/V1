// components/ModeControl.jsx — the SINGLE canonical mode-switch
// control (fork registry: mode_switch, 2026-08-28 feature).
//
// One compact pill next to <ArmEnableControl /> that:
//   1. Renders the CURRENT mode with a colored dot
//      (green AUTO / blue MANUAL / purple REMOTE / grey UNKNOWN).
//      Reads robot.robot_mode_code from the WS-mirrored store.
//   2. On click, opens a confirm dialog naming the CONSEQUENCE:
//        Auto: programs run at configured speed.
//        Manual: drag-teach + jog only; programs will not run.
//        Remote: reserved for CRI control (advanced).
//   3. Refuses gracefully when the arbiter is holding — the
//      /api/estun/mode endpoint returns kind='arbiter_refused'
//      with a named reason. Refusal renders as a toast; the pill
//      stays on the current mode.
//   4. Confirms only after read-back — the dashboard's response
//      arrives after the driver observed publish/RobotStatus.mode
//      hit the target numeric code (L298 ground truth). No
//      optimistic UI.
//
// This component MUST be the ONLY implementation of the mode-
// switch control. Fork registry entry `mode_switch` refuses a
// second one at deploy time.

import { useState } from 'react'
import { useStore } from '../store/useStore'


const MODE_LABEL = { 0: 'AUTO', 1: 'MANUAL', 2: 'REMOTE' }
const MODE_COLOR = {
  0: '#059669',  // AUTO green
  1: '#2563EB',  // MANUAL blue
  2: '#7C3AED',  // REMOTE purple
}
const MODE_ORDER = [
  { key: 'manual', code: 1, label: 'Manual',
    detail: 'Drag-teach + jog only. Programs will NOT run in this mode.' },
  { key: 'auto',   code: 0, label: 'Auto',
    detail: 'Programs run at their configured speed. Do NOT enter Manual '
          + 'mid-cycle — stop the program first.' },
  // Remote is a driver-side capability (CRI setup uses it); we
  // expose it in the dialog for completeness but flag it as
  // advanced. Operators rarely need it directly.
  { key: 'remote', code: 2, label: 'Remote',
    detail: 'Advanced: reserved for CRI motion control setup. Only use if '
          + 'you know what you are doing.' },
]


export default function ModeControl() {
  const robot = useStore((s) => s.robot) || {}
  const addToast = useStore((s) => s.addToast)
  const [dialog, setDialog] = useState(null)   // {key,code,label,detail} | null
  const [pending, setPending] = useState(false)

  const code   = Number.isFinite(robot.robot_mode_code) ? robot.robot_mode_code : -1
  const label  = MODE_LABEL[code] || 'UNKNOWN'
  const color  = MODE_COLOR[code] || '#6b7280'
  const allowMode = !!robot.allow_mode
  const jogActive = !!robot.jog_active
  const progRunning = ((robot.program || {}).state === 2)
  const arbiterBlocked = jogActive || progRunning
  const canOpen = allowMode && !pending && !arbiterBlocked
  // 2026-08-28 enable-interlock: the controller silently refuses
  // toAuto/toManual/toRemote while enabled=True. /api/estun/mode
  // orchestrates disable → switch → re-enable behind one confirm;
  // the dialog surfaces the sub-steps so the operator sees the
  // consequence before consenting.
  const enabled = !!robot.enabled
  const needsInterlockDance = enabled

  const openDialog = () => {
    if (!canOpen) return
    // Default the dialog to the OPPOSITE of the current mode when
    // it's Auto or Manual; otherwise show the choice list.
    if (code === 0)      setDialog(MODE_ORDER[0])   // AUTO → offer Manual first
    else if (code === 1) setDialog(MODE_ORDER[1])   // MANUAL → offer Auto first
    else                 setDialog(MODE_ORDER[1])   // UNKNOWN/REMOTE → default Auto
  }

  const runSwitch = async (target) => {
    setPending(true)
    try {
      const res = await fetch('/api/estun/mode', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ target: target.key }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.ok) {
        addToast?.(
          `Robot mode → ${target.label}` +
          (body.outcome?.no_change ? ' (already there).' : '.'),
          'info', 3000)
        setDialog(null)
      } else {
        const reason = body?.outcome?.reason
                    || body?.outcome?.detail
                    || `Mode switch refused (HTTP ${res.status}).`
        addToast?.(`Mode switch refused: ${reason}`, 'error', 6000)
        // Keep the dialog open so the operator can retry or cancel.
      }
    } catch (e) {
      addToast?.(`Mode switch error: ${String(e && e.message || e)}`,
                 'error', 6000)
    } finally {
      setPending(false)
    }
  }

  const tooltip =
      arbiterBlocked
        ? `Mode switch blocked: ${jogActive ? 'jog hold active' : 'program running'}. `
          + 'Release the jog / stop the program first.'
    : !allowMode
        ? 'Mode gate closed on the driver — set ESTUN_ALLOW_MODE=1 to enable.'
    : `Current mode: ${label}. Click to switch.`

  return (
    <>
      <div
        data-testid="mode-control"
        data-mode-code={code}
        onClick={openDialog}
        title={tooltip}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'rgba(148, 163, 184, 0.08)',
          border: '1px solid ' + color,
          borderRadius: 6, padding: '3px 8px',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          color, textTransform: 'uppercase',
          minHeight: 26,
          cursor: canOpen ? 'pointer' : 'not-allowed',
          opacity: canOpen ? 1 : 0.65,
          userSelect: 'none',
        }}>
        <span style={{ color: '#94A3B8' }}>MODE</span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: color, boxShadow: `0 0 4px ${color}`,
        }} />
        <span style={{ color }}>{label}</span>
      </div>
      {dialog && (
        <ModeConfirmDialog
          currentLabel={label}
          currentColor={color}
          target={dialog}
          pending={pending}
          onCancel={() => setDialog(null)}
          onConfirm={() => runSwitch(dialog)}
          onPickOther={(t) => setDialog(t)}
          currentCode={code}
          needsInterlockDance={needsInterlockDance}
        />
      )}
    </>
  )
}


// Dialog rendered when the pill is clicked. Explicit consequence
// text (no cute copy). Offers to swap the target so the operator
// can pick any of the three modes without dismissing and
// re-clicking.
function ModeConfirmDialog({
  currentLabel, currentColor, target, pending, currentCode,
  onCancel, onConfirm, onPickOther, needsInterlockDance,
}) {
  const targetColor = MODE_COLOR[target.code] || '#6b7280'
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="mode-confirm-dialog"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(15,23,42,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 3300,
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 420, maxWidth: 560,
          background: 'var(--bg-panel, #0F172A)',
          border: '1px solid var(--border, #334155)',
          borderRadius: 8,
          padding: '20px 24px',
          color: '#E2E8F0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
        <div style={{
          fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase',
          color: '#94A3B8', marginBottom: 8,
        }}>Switch robot mode</div>
        <div style={{ fontSize: 15, marginBottom: 14, lineHeight: 1.4 }}>
          Currently <b style={{ color: currentColor }}>{currentLabel}</b>.
          Switch to <b style={{ color: targetColor }}>{target.label}</b>?
        </div>
        <div style={{
          fontSize: 12, color: '#CBD5E1', marginBottom: 12,
          padding: '10px 12px',
          background: 'rgba(148,163,184,0.06)',
          borderLeft: '3px solid ' + targetColor,
          borderRadius: 3, lineHeight: 1.5,
        }}>{target.detail}</div>
        {needsInterlockDance && (
          <div style={{
            fontSize: 12, color: '#FDBA74', marginBottom: 12,
            padding: '10px 12px',
            background: 'rgba(251,146,60,0.08)',
            borderLeft: '3px solid #FB923C',
            borderRadius: 3, lineHeight: 1.5,
          }}>
            <b>Robot is ENABLED.</b> The controller refuses mode switches
            while enabled, so confirming will run the following sequence
            behind this dialog:
            <ol style={{ margin: '6px 0 0 20px', padding: 0, fontSize: 11.5 }}>
              <li>Disable the arm (servos drop).</li>
              <li>Switch mode to <b>{target.label}</b>.</li>
              <li>Re-enable the arm.</li>
            </ol>
          </div>
        )}
        <div style={{
          display: 'flex', gap: 6, flexWrap: 'wrap',
          marginBottom: 16, alignItems: 'center',
        }}>
          <span style={{
            fontSize: 10, letterSpacing: 1,
            color: '#94A3B8', textTransform: 'uppercase',
            marginRight: 4,
          }}>Pick a different target:</span>
          {MODE_ORDER
            .filter((t) => t.key !== target.key && t.code !== currentCode)
            .map((t) => (
              <button
                key={t.key}
                onClick={() => onPickOther(t)}
                disabled={pending}
                style={{
                  padding: '4px 10px',
                  fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  border: '1px solid ' + (MODE_COLOR[t.code] || '#334155'),
                  background: 'transparent',
                  color: MODE_COLOR[t.code] || '#94A3B8',
                  borderRadius: 4,
                  cursor: pending ? 'wait' : 'pointer',
                }}>{t.label}</button>
            ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            data-testid="mode-confirm-cancel"
            onClick={onCancel} disabled={pending}
            style={{
              padding: '8px 16px', fontSize: 13,
              border: '1px solid #475569', background: 'transparent',
              color: '#CBD5E1', borderRadius: 4,
              cursor: pending ? 'wait' : 'pointer',
            }}>Cancel</button>
          <button
            data-testid="mode-confirm-ok"
            onClick={onConfirm} disabled={pending}
            style={{
              padding: '8px 18px', fontSize: 13, fontWeight: 700,
              background: targetColor, color: '#fff', border: 'none',
              borderRadius: 4,
              cursor: pending ? 'wait' : 'pointer',
              opacity: pending ? 0.7 : 1,
              letterSpacing: 0.4,
            }}>{pending ? 'Switching…' : `Switch to ${target.label}`}</button>
        </div>
      </div>
    </div>
  )
}

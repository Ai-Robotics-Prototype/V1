// WristWindIndicator — persistent affordance shown near the jog
// panel whenever J4 or J6 wind past ±150° (2026-08-28 operator
// directive: "teaching sessions wind wrists; the UI should coach
// it before cartesian strangles").
//
// Layout: bottom-right pill (above DeployStatusBanner). Renders
// only when at least one wrist joint is beyond the threshold.
// Click the pill → one-tap "unwind" suggestion popover.
//
// The pill is INFORMATIONAL, not a jog trigger. Actually unwinding
// still goes through the jog surface — the operator sees a named
// direction and speed suggestion; they do the motion. This keeps
// the safety envelope (hold-to-jog, deadman, arbiter) intact.

import { useState } from 'react'
import { useStore } from '../store/useStore'


const WRIST_JOINTS = [4, 6]      // J4 + J6 (1-based)
const WIND_THRESHOLD_DEG = 150.0


function unwindHintFor(idx1, currentDeg) {
  // Unwind direction is toward zero. Positive angle → jog −;
  // negative angle → jog +.
  const dir = currentDeg > 0 ? '−' : '+'
  const targetMag = Math.min(90, Math.abs(currentDeg))  // half-way suggestion
  return {
    joint: idx1,
    currentDeg,
    direction: dir,
    suggestion: `Jog ${dir}J${idx1} in Joint mode to unwind. Target: `
              + `bring |J${idx1}| below ${targetMag.toFixed(0)}° before `
              + 'starting the next cartesian hold.',
  }
}


export default function WristWindIndicator() {
  const robot = useStore((s) => s.robot) || {}
  const [open, setOpen] = useState(false)

  const joints = Array.isArray(robot.joints_deg) ? robot.joints_deg : null
  if (!joints || joints.length < 6) return null

  const wound = WRIST_JOINTS
    .map((n) => ({ n, deg: Number(joints[n - 1]) }))
    .filter((x) => Number.isFinite(x.deg)
                   && Math.abs(x.deg) > WIND_THRESHOLD_DEG)

  if (wound.length === 0) {
    if (open) setOpen(false)
    return null
  }

  const most = wound.reduce((a, b) =>
    Math.abs(a.deg) > Math.abs(b.deg) ? a : b)
  const hint = unwindHintFor(most.n, most.deg)
  const label = wound.length === 1
    ? `WRIST WIND — J${most.n} at ${most.deg.toFixed(0)}°`
    : `WRIST WIND — ${wound.map((x) => `J${x.n} ${x.deg.toFixed(0)}°`).join(' · ')}`

  return (
    <>
      <div
        data-testid="wrist-wind-indicator"
        onClick={() => setOpen(true)}
        title={`Click for unwind suggestion. Threshold: ±${WIND_THRESHOLD_DEG}°`}
        style={{
          position: 'fixed',
          right: 8, bottom: 40,       // sits above DeployStatusBanner
          zIndex: 3199,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          background: '#78350F', color: '#FEF3C7',
          border: '1px solid #F59E0B',
          borderRadius: 4,
          fontSize: 11, fontWeight: 700,
          fontFamily: 'var(--font-mono, monospace)',
          letterSpacing: 0.3,
          cursor: 'pointer',
          maxWidth: 'calc(100vw - 16px)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          userSelect: 'none',
        }}>
        ⚠ {label}
      </div>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="wrist-wind-hint"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(15,23,42,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 3300,
          }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              minWidth: 360, maxWidth: 480,
              background: 'var(--bg-panel, #0F172A)',
              border: '1px solid #F59E0B', borderRadius: 8,
              padding: '20px 24px',
              color: '#E2E8F0',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}>
            <div style={{
              fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase',
              color: '#FDBA74', marginBottom: 8, fontWeight: 700,
            }}>Wrist wind — unwind suggestion</div>
            <div style={{ fontSize: 15, marginBottom: 12, lineHeight: 1.4 }}>
              <b>J{hint.joint}</b> is at <b>{hint.currentDeg.toFixed(1)}°</b>.
              Cartesian holds near this wrist geometry will trip the
              joint-velocity governor and slow down or stop.
            </div>
            <div style={{
              fontSize: 13, color: '#CBD5E1', marginBottom: 14,
              padding: '10px 12px',
              background: 'rgba(148,163,184,0.06)',
              borderLeft: '3px solid #F59E0B',
              borderRadius: 3, lineHeight: 1.5,
            }}>{hint.suggestion}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setOpen(false)}
                style={{
                  padding: '8px 16px', fontSize: 13,
                  border: '1px solid #475569', background: 'transparent',
                  color: '#CBD5E1', borderRadius: 4, cursor: 'pointer',
                }}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

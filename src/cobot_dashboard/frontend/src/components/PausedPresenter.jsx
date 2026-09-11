import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { deriveRunState } from '../lib/runState'

// PausedPresenter — the paused-state UI, distinct from the alarm
// pipeline. Renders NOTHING when the run isn't paused; when it is,
// renders a caution-styled full-screen overlay on the pause ENTRY
// event, and after the operator taps Understood keeps a persistent
// amber banner pinned at the top of the screen so the paused state
// can never go silent.
//
// Palette is deliberately amber, not red. Red stays reserved for
// e-stop and real alarms; caution overlays a paused program that
// MAY resume motion. If a real alarm arrives while paused, the
// AlarmRecoveryModal (mounted alongside this in App.jsx) already
// outranks by precedence — deriveRunState's `kind` transitions to
// 'alarm' which flips our render off.
//
// Understood tracking is LOCAL state that latches on pause entry:
//   prev !== 'paused' && current === 'paused'  → understood = false
// So a fresh pause always shows the overlay first, and the same
// paused session never re-nags after Understood. Leaving the paused
// state (resume, stop, real alarm takeover) resets the flag so the
// next pause is a fresh session.

const AMBER_500  = '#F59E0B'
const AMBER_600  = '#D97706'
const AMBER_50   = '#FFFBEB'
const AMBER_100  = '#FEF3C7'
const AMBER_200  = '#FDE68A'
const AMBER_800  = '#92400E'
const TEXT_INK   = '#111827'
const TEXT_MUTE  = '#6B7280'
const NEUTRAL_BG = '#F3F4F6'
const NEUTRAL_BORDER = '#D1D5DB'

export default function PausedPresenter() {
  const robot  = useStore((s) => s.robot)  || {}
  const task   = useStore((s) => s.task)   || {}
  const safety = useStore((s) => s.safety) || {}
  const resumeProgram = useStore((s) => s.resumeProgram)
  const cancelProgram = useStore((s) => s.cancelProgram)

  const runState = deriveRunState({ robot, task, safety })
  const isPaused = runState.kind === 'paused'

  // Latch Understood on pause ENTRY. `prevKind` is refreshed once
  // per commit so we don't false-positive on a re-render inside the
  // same paused session.
  const [understood, setUnderstood] = useState(false)
  const [resumeConfirming, setResumeConfirming] = useState(false)
  const prevKind = useRef(runState.kind)
  useEffect(() => {
    // Entered paused: force a fresh overlay session.
    if (prevKind.current !== 'paused' && isPaused) {
      setUnderstood(false)
      setResumeConfirming(false)
    }
    // Left paused: reset for the next pause.
    if (prevKind.current === 'paused' && !isPaused) {
      setUnderstood(false)
      setResumeConfirming(false)
    }
    prevKind.current = runState.kind
  }, [isPaused, runState.kind])

  if (!isPaused) return null

  const progName = task.program_name || task.program_id || 'the program'
  const stepN    = Number.isFinite(task.program_step)  ? Math.max(0, task.program_step) + 1
                                                       : null
  const stepM    = Number.isFinite(task.program_total) ? task.program_total : null
  const stepLine = (stepN && stepM)
    ? `Paused at step ${stepN} of ${stepM}`
    : null
  const bannerStepLine = (stepN && stepM) ? `step ${stepN}/${stepM}` : ''

  // Overlay only renders on pause ENTRY (until Understood). After
  // that the banner takes over until the paused state ends.
  const showOverlay = !understood

  return (
    <>
      {showOverlay && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, zIndex: 3900,
            // Warm-dark backdrop — amber-tinted rather than the
            // slate-blue backdrop the alarm modal uses. Keeps the
            // caution palette consistent all the way to the edge.
            background: 'rgba(69, 26, 3, 0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{
            background: '#fff', color: TEXT_INK,
            borderRadius: 14, width: '100%', maxWidth: 640,
            boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
            overflow: 'hidden',
            border: `1px solid ${AMBER_200}`,
          }}>
            {/* Amber header bar — matches the modal-family shell but
                in caution palette so the operator instantly reads
                this as NOT-an-alarm-but-attend-anyway. */}
            <div style={{
              background: AMBER_500,
              color: AMBER_800,
              padding: '14px 20px',
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              <div style={{
                fontSize: 40, lineHeight: 1,
                filter: 'drop-shadow(0 1px 0 rgba(255,255,255,0.35))',
              }}>⚠</div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 12, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', opacity: 0.85,
                }}>Caution</div>
                <div style={{
                  fontSize: 24, fontWeight: 800, letterSpacing: '0.02em',
                  marginTop: 2, color: '#3B1D00',
                }}>Program paused</div>
              </div>
            </div>

            <div style={{
              padding: '18px 22px 20px 22px',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ fontSize: 16, color: TEXT_INK, lineHeight: 1.45 }}>
                <b>{progName}</b> is running and is currently paused.
              </div>
              <div style={{
                fontSize: 15, color: AMBER_800, fontWeight: 600,
                background: AMBER_50, border: `1px solid ${AMBER_200}`,
                borderRadius: 8, padding: '10px 14px', lineHeight: 1.4,
              }}>
                The robot may resume motion. Keep clear of the work area.
              </div>
              {stepLine && (
                <div style={{
                  fontSize: 14, color: TEXT_MUTE, fontVariantNumeric: 'tabular-nums',
                }}>{stepLine}</div>
              )}

              <div style={{
                display: 'flex', gap: 10, justifyContent: 'flex-end',
                marginTop: 8, flexWrap: 'wrap',
              }}>
                <button
                  onClick={() => cancelProgram()}
                  style={btnNeutral}
                >
                  Stop
                </button>
                <button
                  onClick={() => setResumeConfirming(true)}
                  style={btnResume}
                >
                  ▶ Resume
                </button>
                <button
                  onClick={() => setUnderstood(true)}
                  style={btnUnderstood}
                >
                  Understood
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Persistent banner — visible for the full paused session
          AFTER Understood is tapped. Sits above the top of the
          content area so it's always in the operator's field of view
          without occluding the app chrome. */}
      {understood && (
        <div style={{
          position: 'fixed', top: 60,   // clear the 60px TopBar
          left: 0, right: 0, zIndex: 3800,
          background: AMBER_500, color: AMBER_800,
          padding: '10px 18px',
          display: 'flex', alignItems: 'center', gap: 14,
          borderBottom: `1px solid ${AMBER_600}`,
          boxShadow: '0 4px 12px rgba(217, 119, 6, 0.25)',
        }}>
          <span style={{ fontSize: 20 }}>⚠</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>
            Program paused
            {progName ? <> — {progName}</> : null}
            {bannerStepLine ? <>, {bannerStepLine}</> : null}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => cancelProgram()} style={bannerBtnNeutral}>Stop</button>
          <button onClick={() => setResumeConfirming(true)} style={bannerBtnResume}>
            ▶ Resume
          </button>
        </div>
      )}

      {resumeConfirming && (
        <ResumeConfirmModal
          progName={progName}
          onConfirm={() => {
            setResumeConfirming(false)
            resumeProgram?.()
          }}
          onCancel={() => setResumeConfirming(false)}
        />
      )}
    </>
  )
}

// Resume confirm — the "increases confirm; decreases never wait"
// rule from Lesson 125. Resuming a paused program restarts motion,
// which is the direction that must confirm. Same modal shell the
// rest of the app uses (PositionReuseModal / RecordConfirmModal /
// AlarmRecoveryModal). Palette stays neutral (blue primary) rather
// than green so it doesn't compete visually with the amber caution
// underneath.
function ResumeConfirmModal({ progName, onConfirm, onCancel }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 4200,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: TEXT_INK,
          borderRadius: 12, width: '100%', maxWidth: 480,
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '16px 20px 8px 20px',
          borderBottom: '1px solid #E5E7EB',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: TEXT_MUTE,
                        textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Confirm resume
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: TEXT_INK,
                        marginTop: 4 }}>
            Resume program?
          </div>
          <div style={{ fontSize: 13, color: TEXT_MUTE, marginTop: 6, lineHeight: 1.4 }}>
            Robot will move. <b>{progName}</b> will pick up from where it
            was paused. Keep clear of the work area.
          </div>
        </div>
        <div style={{
          padding: '14px 20px 16px 20px',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button onClick={onCancel} style={btnNeutralCompact}>Cancel</button>
          <button onClick={onConfirm} style={btnResumeCompact}>▶ Resume</button>
        </div>
      </div>
    </div>
  )
}

// ── Button styles ─────────────────────────────────────────────

const btnUnderstood = {
  minHeight: 48, padding: '0 22px',
  fontSize: 15, fontWeight: 700,
  background: AMBER_600, color: '#fff',
  border: 'none', borderRadius: 8, cursor: 'pointer',
  letterSpacing: '0.02em',
}
const btnResume = {
  minHeight: 48, padding: '0 22px',
  fontSize: 15, fontWeight: 700,
  background: '#16A34A', color: '#fff',
  border: 'none', borderRadius: 8, cursor: 'pointer',
  letterSpacing: '0.02em',
}
const btnNeutral = {
  minHeight: 48, padding: '0 18px',
  fontSize: 14, fontWeight: 600,
  background: NEUTRAL_BG, color: TEXT_INK,
  border: `1px solid ${NEUTRAL_BORDER}`, borderRadius: 8, cursor: 'pointer',
}
const bannerBtnResume = {
  height: 32, padding: '0 14px',
  fontSize: 13, fontWeight: 700,
  background: '#16A34A', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer',
}
const bannerBtnNeutral = {
  height: 32, padding: '0 12px',
  fontSize: 13, fontWeight: 600,
  background: '#fff', color: TEXT_INK,
  border: `1px solid ${NEUTRAL_BORDER}`, borderRadius: 6, cursor: 'pointer',
}
const btnResumeCompact = {
  minHeight: 44, padding: '0 20px',
  fontSize: 14, fontWeight: 700,
  background: '#16A34A', color: '#fff',
  border: 'none', borderRadius: 8, cursor: 'pointer',
}
const btnNeutralCompact = {
  minHeight: 44, padding: '0 16px',
  fontSize: 14, fontWeight: 600,
  background: 'transparent', color: TEXT_MUTE,
  border: '1px solid #E5E7EB', borderRadius: 8, cursor: 'pointer',
}

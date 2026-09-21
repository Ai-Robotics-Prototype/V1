// JointRecoveryModal — guided recovery from the escape-only zone
// (Lesson 165 extension, 2026-08-05).
//
// Trigger: any joint reports `past_escape_only: true` on the state
// broadcast (driver side: abs(current_deg) > limit - joint_escape_
// only_margin_deg). Renders a modal on top of the operator's current
// surface (teach overlay, Monitor, jog page) with a single
// press-and-hold "Recover" affordance.
//
// Doctrine (Lesson 165 extension): the system OFFERS the recovery
// move; only an explicit operator press EXECUTES it; no auto-motion
// ever. The Recover button reuses the standard `jogHold` path — same
// dead-man, same speed cap, same collision guard — so the escape
// direction move is subject to every existing safety rail.
//
// Fork registry: guided_recovery_dialog. This is the canonical
// implementation of the guided-recovery pattern; future recovery
// dialogs (e-stop clear, controller-link recovery) route through
// the same primitives.

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { HoldButton } from './JogControls'

// Target inside the physical limit — the recovery move stops when the
// joint has 10° of margin under the physical limit (well inside the
// escape-only zone's threshold of 12°). Feels like "back to comfort".
const RECOVERY_TARGET_INSIDE_DEG = 10

// Crawl speed for the recovery move. 5% of the operator cap → plenty
// slow that a hover-then-lift reads as "I need to stop right now."
const RECOVERY_SPEED_PCT = 5

// Auto-close after a successful recovery — long enough for the operator
// to read "recovered", short enough not to obstruct the next task.
const AUTO_CLOSE_MS = 1800


export default function JointRecoveryModal() {
  const robot        = useStore((s) => s.robot) || {}
  const jogHold      = useStore((s) => s.jogHold)
  const jogRelease   = useStore((s) => s.jogRelease)
  const addToast     = useStore((s) => s.addToast)
  const jl           = Array.isArray(robot.joint_limits) ? robot.joint_limits : []

  // Every joint currently inside the escape-only zone, worst-first
  // (worst = smallest signed headroom, i.e. deepest into the zone).
  const pastEscape = jl
    .filter((j) => j?.past_escape_only)
    .sort((a, b) => (Number(a?.headroom_deg) || 0) - (Number(b?.headroom_deg) || 0))

  const hasCondition = pastEscape.length > 0

  // Dismissed for THIS incident — resets when past_escape_only becomes
  // False (condition cleared) OR when a new joint enters the zone
  // (multi-joint case: the dialog re-asserts for the new joint).
  const [dismissed, setDismissed] = useState(false)
  const [successUntil, setSuccessUntil] = useState(0)
  const prevJoints = useRef(new Set())

  useEffect(() => {
    const cur = new Set(pastEscape.map((j) => Number(j.joint)))
    const prev = prevJoints.current
    // Fresh joint entered → re-open even if the operator dismissed.
    for (const j of cur) {
      if (!prev.has(j)) setDismissed(false)
    }
    // Condition cleared for every joint → reset dismissed and mark
    // success so the auto-close success line renders briefly.
    if (prev.size > 0 && cur.size === 0) {
      setDismissed(false)
      setSuccessUntil(Date.now() + AUTO_CLOSE_MS)
      try { addToast?.('Joint recovered — you can jog normally', 'info', 4000) }
      catch (_) { /* nop */ }
    }
    prevJoints.current = cur
  }, [pastEscape, addToast])

  const inSuccessWindow = successUntil > 0 && Date.now() < successUntil

  useEffect(() => {
    if (!inSuccessWindow) return
    const t = setTimeout(() => setSuccessUntil(0), AUTO_CLOSE_MS + 100)
    return () => clearTimeout(t)
  }, [inSuccessWindow])

  if (!hasCondition && !inSuccessWindow) return null
  if (dismissed && hasCondition) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 4100,
      background: 'rgba(15, 23, 42, 0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: '#fff', color: '#111827',
        borderRadius: 12, width: '100%', maxWidth: 640,
        boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {inSuccessWindow ? (
          <SuccessBody onClose={() => setSuccessUntil(0)} />
        ) : (
          <RecoveryBody
            jointRow={pastEscape[0]}
            allRows={pastEscape}
            jogHold={jogHold}
            jogRelease={jogRelease}
            onDismiss={() => setDismissed(true)}
          />
        )}
      </div>
    </div>
  )
}


function RecoveryBody({ jointRow, allRows, jogHold, jogRelease, onDismiss }) {
  const j       = Number(jointRow.joint)
  const cur     = Number(jointRow.current_deg)
  const limit   = Number(jointRow.limit_deg)
  const edge    = Number(jointRow.escape_only_edge_deg)
  const past    = Math.max(0, edge - Math.abs(cur))   // how deep into the escape zone
  const target  = limit - RECOVERY_TARGET_INSIDE_DEG  // absolute target: come inside by 10°
  // Escape direction: reduce abs(current). If cur is positive, jog -.
  const escDir  = cur >= 0 ? -1 : 1
  const escSym  = escDir > 0 ? '+' : '−'
  const softStr = `${limit.toFixed(0)}°`

  // Live-firing indicator so the operator SEES that the press is
  // dispatching frames. Ticker fires ~10 Hz on the client; we bump
  // a fires counter so the button label switches to "Recovering — Jn
  // {escape} 5%" while held. The invisibility of the press was a
  // real bug (P0-A, 2026-08-05): white-on-white default HoldButton
  // background + no visual confirmation the frames were flying.
  const firesRef = useRef(0)
  const [pressed, setPressed] = useState(false)

  const holdStart = useCallback((meta) => {
    firesRef.current += 1
    setPressed(true)   // React skips re-render if already true
    return jogHold(j, escDir, RECOVERY_SPEED_PCT, meta)
  }, [j, escDir, jogHold])
  const holdEnd = useCallback((meta) => {
    setPressed(false)
    firesRef.current = 0
    return jogRelease('joint', meta)
  }, [jogRelease])

  // useMemo the wire object so HoldButton's callback identities stay
  // stable across state broadcasts (25 Hz idle, 8 Hz mid-hold). A
  // fresh identity every render doesn't stop the button from firing,
  // but it churns useCallback deps unnecessarily.
  const wire = useMemo(() => ({
    jogStyle:     'CONTINUOUS',
    onTap:        undefined,
    onPressStart: holdStart,
    onPressTick:  holdStart,
    onPressEnd:   holdEnd,
  }), [holdStart, holdEnd])

  return (
    <>
      {/* Header — same phase-red chrome as the AlarmRecoveryModal's
          out_of_range phase, so the operator recognizes it instantly */}
      <div style={{
        background: '#7F1D1D', color: '#FFF7ED',
        padding: '12px 16px 10px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 12, height: 12, borderRadius: '50%',
          background: '#FCA5A5', flexShrink: 0,
        }} />
        <div style={{ flex: 1, fontSize: 16, fontWeight: 700, letterSpacing: '0.02em' }}>
          J{j} is past its rotation limit
          {allRows.length > 1 ? ` (${allRows.length} joints total)` : ''}
        </div>
      </div>

      <div style={{ padding: '16px 20px 20px 20px',
                    display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.5 }}>
          J{j} is at{' '}
          <b style={{ fontVariantNumeric: 'tabular-nums' }}>
            {cur >= 0 ? '+' : ''}{cur.toFixed(0)}°
          </b>{' '}
          (soft limit {edge >= 0 ? '±' : ''}{Math.abs(edge).toFixed(0)}° of{' '}
          ±{softStr}). The robot can rotate J{j} back to a safe angle.
          Clear the area around the robot wrist, then press and hold
          Recover.
        </div>

        <div style={{
          padding: 12, background: '#FEF2F2', borderRadius: 8,
          border: '1px solid #FCA5A5',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#7F1D1D' }}>
              J{j}
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#111827',
                          fontVariantNumeric: 'tabular-nums' }}>
              {cur >= 0 ? '+' : ''}{cur.toFixed(1)}°
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginLeft: 'auto' }}>
              limit ±{limit.toFixed(0)}° · {past.toFixed(1)}° past soft edge
            </div>
          </div>
          <div style={{ fontSize: 13, color: '#374151' }}>
            Escape direction: J{j} <b>{escSym}</b>. Recovery target:
            back inside ±{target.toFixed(0)}° (10° of margin).
          </div>
        </div>

        {/* Multi-joint hint. Only the FIRST joint's Recover button is
            rendered; the operator repeats for each row. */}
        {allRows.length > 1 && (
          <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>
            {allRows.slice(1).map((r) => `J${r.joint} at ${r.current_deg >= 0 ? '+' : ''}${Number(r.current_deg).toFixed(0)}°`).join(', ')} — recover each in turn.
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center',
                      justifyContent: 'flex-end', paddingTop: 4 }}>
          <button
            onClick={onDismiss}
            style={{
              padding: '10px 18px', borderRadius: 6,
              background: '#F3F4F6', color: '#374151',
              border: '1px solid #D1D5DB',
              fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}
          >
            Dismiss — I'll fix it manually
          </button>

          {/* The Recover control uses the shared HoldButton primitive
              from JogControls (fork registry canonical for hold-to-jog
              press mechanics). CONTINUOUS style + 100 ms ticker + the
              driver's 200 ms freshness deadman = release ⇒ stop.

              2026-08-05 P0-A contrast fix: HoldButton's default `bg`
              is white — passing `color="#059669"` gave a colored
              HOVER state only (see JogControls.jsx onPointerEnter),
              leaving the resting button white-on-white which the
              operator literally could not see. Pass `bg="#059669"`
              (green resting fill) and a darker hover so the button
              is readable in every state, on both themes. Live-firing
              indicator swaps the label when the ticker is firing. */}
          <HoldButton
            {...wire}
            color="#059669"
            bg="#059669"
            bgHover="#047857"
            borderColor="#065F46"
            width={260}
            height={68}
            data-testid="joint-recover-hold"
          >
            <span style={{ color: '#fff', fontSize: 15, fontWeight: 800,
                           textShadow: '0 1px 1px rgba(0,0,0,0.25)' }}>
              {pressed
                ? `Recovering — J${j} ${escSym} @ ${RECOVERY_SPEED_PCT}%`
                : `Hold to Recover J${j} ${escSym}`}
            </span>
          </HoldButton>
        </div>
      </div>
    </>
  )
}


function SuccessBody({ onClose }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'stretch',
    }}>
      <div style={{
        background: '#065F46', color: '#ECFDF5',
        padding: '12px 16px 10px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 12, height: 12, borderRadius: '50%',
          background: '#6EE7B7', flexShrink: 0,
        }} />
        <div style={{ flex: 1, fontSize: 16, fontWeight: 700, letterSpacing: '0.02em' }}>
          Joint recovered
        </div>
      </div>
      <div style={{ padding: '16px 20px 20px 20px', color: '#065F46', fontSize: 14 }}>
        You can jog normally.
      </div>
    </div>
  )
}

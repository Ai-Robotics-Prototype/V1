import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'

const HOLD_MS = 3000   // ms to hold the override button

export default function EStopOverlay() {
  const estop         = useStore((s) => s.safety.estop)
  const zone          = useStore((s) => s.safety.zone)
  const proximity     = useStore((s) => s.safety.human_proximity)
  const releaseEstop  = useStore((s) => s.releaseEstop)
  const overrideEstop = useStore((s) => s.overrideEstop)

  const [showOverride, setShowOverride]   = useState(false)
  const [holding, setHolding]             = useState(false)
  const [holdProgress, setHoldProgress]   = useState(0)   // 0–1
  const rafRef    = useRef(null)
  const holdStart = useRef(null)

  const canRelease = zone === 'GREEN'

  // Reset override state whenever estop clears or zone turns green
  useEffect(() => {
    if (!estop || canRelease) {
      setShowOverride(false)
      setHolding(false)
      setHoldProgress(0)
    }
  }, [estop, canRelease])

  // Pointer-down: start hold timer
  const startHold = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId)   // keep pointer even if cursor leaves circle
    holdStart.current = performance.now()
    setHolding(true)

    const tick = () => {
      const elapsed  = performance.now() - holdStart.current
      const progress = Math.min(elapsed / HOLD_MS, 1)
      setHoldProgress(progress)
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        overrideEstop()
        setHolding(false)
        setHoldProgress(0)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [overrideEstop])

  // Pointer-up / leave: cancel hold
  const cancelHold = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setHolding(false)
    setHoldProgress(0)
  }, [])

  // Clean up RAF on unmount
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  if (!estop) return null

  const ZONE_COLOR = { GREEN: 'var(--green)', YELLOW: 'var(--yellow)', RED: 'var(--red)' }
  const zoneColor  = ZONE_COLOR[zone] ?? 'var(--text-muted)'

  // SVG arc for hold-progress ring
  const R   = 28
  const C   = 2 * Math.PI * R
  const arc = C * (1 - holdProgress)

  return (
    <div style={s.backdrop}>
      <div style={s.card}>

        {/* Title */}
        <div style={s.titleRow}>
          <span style={{ fontSize: 26 }}>⚠</span>
          <h1 style={s.title}>E-STOP ACTIVE</h1>
        </div>

        {/* Zone / proximity row */}
        <div style={s.statusRow}>
          <div style={s.statusCell}>
            <span style={s.statusLabel}>Zone</span>
            <span style={{ ...s.statusValue, color: zoneColor, fontWeight: 600 }}>{zone}</span>
          </div>
          <div style={{ width: 1, background: 'var(--border)' }} />
          <div style={s.statusCell}>
            <span style={s.statusLabel}>Proximity</span>
            <span style={{ ...s.statusValue, fontFamily: 'var(--font-mono)' }}>
              {proximity != null ? proximity.toFixed(2) : '—'} m
            </span>
          </div>
        </div>

        {/* Normal release path */}
        {!showOverride && (
          <>
            <p style={s.instructions}>
              Move clear of the robot{' '}
              <strong style={{ color: 'var(--text-primary)' }}>(&#62; 1.2 m)</strong>{' '}
              until the zone indicator turns green, then press Release.
            </p>

            <div style={s.requirementRow}>
              <span style={{
                ...s.dot,
                background: canRelease ? 'var(--green)' : zoneColor,
                animation: canRelease ? 'none' : 'pulse-opacity 1s infinite',
              }} />
              <span style={{ color: canRelease ? 'var(--green)' : 'var(--text-secondary)', fontSize: 12 }}>
                {canRelease ? 'Zone is GREEN — safe to release' : 'Requires green zone — clear the area'}
              </span>
            </div>

            <button
              onClick={releaseEstop}
              disabled={!canRelease}
              title={canRelease ? 'Release emergency stop' : 'Move clear of robot (> 1.2 m)'}
              style={{
                ...s.releaseBtn,
                background: canRelease ? '#16A34A' : 'var(--bg-active)',
                color:      canRelease ? '#fff'    : 'var(--text-muted)',
                cursor:     canRelease ? 'pointer' : 'not-allowed',
                opacity:    canRelease ? 1         : 0.6,
              }}
            >
              Release E-Stop
            </button>

            {/* Override entry — only when zone isn't green */}
            {!canRelease && (
              <button
                onClick={() => setShowOverride(true)}
                style={s.overrideEntryBtn}
                title="Override: release E-Stop without green zone (requires hold confirmation)"
              >
                Override — release in {zone} zone ▸
              </button>
            )}
          </>
        )}

        {/* Override confirmation panel */}
        {showOverride && (
          <div style={s.overridePanel}>
            <div style={s.overrideWarningBadge}>
              ⚠ OVERRIDE MODE
            </div>

            <p style={s.overrideText}>
              Zone is <strong style={{ color: zoneColor }}>{zone}</strong> ({proximity != null ? proximity.toFixed(2) : '—'} m).
              Releasing the E-Stop now may expose personnel to robot motion.
            </p>
            <p style={{ ...s.overrideText, color: 'var(--text-muted)', marginTop: 4 }}>
              Only proceed if you have <strong style={{ color: 'var(--text-primary)' }}>manually
              verified</strong> the area is clear. Speed scale remains 0 until zone returns GREEN.
            </p>

            {/* Hold-to-confirm button */}
            <div style={s.holdWrap}>
              <button
                onPointerDown={startHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                style={{
                  ...s.holdBtn,
                  background: holding ? 'rgba(239,68,68,0.25)' : 'var(--red-dim)',
                  borderColor: holding ? 'var(--red)' : 'rgba(239,68,68,0.4)',
                }}
              >
                {/* Progress ring */}
                <svg width={64} height={64} style={{ position: 'absolute' }}>
                  <circle cx={32} cy={32} r={R}
                    fill="none" stroke="rgba(239,68,68,0.15)" strokeWidth={4} />
                  <circle cx={32} cy={32} r={R}
                    fill="none" stroke="var(--red)" strokeWidth={4}
                    strokeDasharray={C} strokeDashoffset={arc}
                    strokeLinecap="round"
                    transform="rotate(-90 32 32)"
                    style={{ transition: holding ? 'none' : 'stroke-dashoffset 0.1s' }}
                  />
                </svg>
                <span style={s.holdLabel}>
                  {holding
                    ? `${Math.round(holdProgress * 100)}%`
                    : 'Hold\n3s'}
                </span>
              </button>
              <span style={s.holdHint}>
                {holding ? 'Keep holding…' : 'Hold to force-release'}
              </span>
            </div>

            <button
              onClick={() => { setShowOverride(false); cancelHold() }}
              style={s.cancelOverrideBtn}
            >
              ← Back to normal release
            </button>
          </div>
        )}

      </div>
    </div>
  )
}

const s = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.72)',
    zIndex: 500,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  card: {
    width: 440,
    background: 'var(--bg-panel)',
    border: '1px solid var(--red)',
    borderRadius: 12,
    padding: '28px 32px',
    pointerEvents: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--red)',
    letterSpacing: '0.04em',
  },
  statusRow: {
    display: 'flex',
    background: 'var(--red-dim)',
    border: '1px solid rgba(239,68,68,0.2)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  statusCell: {
    flex: 1,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 14px',
    fontSize: 13,
  },
  statusLabel: { color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' },
  statusValue: { color: 'var(--text-primary)' },
  instructions: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
  },
  requirementRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
  },
  releaseBtn: {
    fontSize: 14,
    fontWeight: 600,
    padding: '11px 24px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    transition: 'background 200ms, opacity 200ms',
    letterSpacing: '0.02em',
  },
  overrideEntryBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '4px 0',
    textAlign: 'left',
    letterSpacing: '0.02em',
    textDecoration: 'underline',
    textDecorationStyle: 'dotted',
  },

  // Override panel
  overridePanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  overrideWarningBadge: {
    background: 'rgba(239,68,68,0.15)',
    border: '1px solid rgba(239,68,68,0.5)',
    borderRadius: 'var(--radius-sm)',
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--red)',
    letterSpacing: '0.08em',
    alignSelf: 'flex-start',
  },
  overrideText: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
  },
  holdWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '8px 0',
  },
  holdBtn: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    border: '2px solid rgba(239,68,68,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    cursor: 'pointer',
    flexShrink: 0,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    transition: 'background 150ms, border-color 150ms',
  },
  holdLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--red)',
    textAlign: 'center',
    whiteSpace: 'pre',
    lineHeight: 1.3,
    zIndex: 1,
    pointerEvents: 'none',
  },
  holdHint: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  cancelOverrideBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '2px 0',
    textAlign: 'left',
  },
}

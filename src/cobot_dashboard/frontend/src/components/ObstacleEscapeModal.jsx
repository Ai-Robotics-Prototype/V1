import { useEffect, useRef, useState, useCallback } from 'react'
import { useStore } from '../store/useStore'

// Escape-guidance popup for arm-vs-environment (and self / ground) proximity.
//
// TIERED PRESENTATION (2026-07-16):
//   warn band (stop < d ≤ warn)  — a NON-BLOCKING chip lives in the 3D
//     view chrome (see MinClearanceChip in View3DLayout). This popup
//     STAYS SILENT there; jog is fully unrestricted at warn level.
//   stop band (d ≤ stop)         — this popup opens with hold-to-jog
//     escape controls. Speed is capped, direction is filtered by the
//     driver's supervise tick, and the fallback override appears only
//     when NO direction opens.
//   hysteresis                   — once the popup opens, it stays until
//     d > stop + HYSTERESIS_MM. Chip in the chrome tracks live warn/stop
//     bands independently (no hysteresis there — the chip is cheap).
//
// Escape jogs use the standard jog transport (WS-first, HTTP fallback,
// server-side keepalive) with the speed hard-capped at ESCAPE_SPEED_PCT
// so a slip never becomes a slam. The driver's own direction-aware
// refinement is the second line of defense — even if this UI hands
// the operator the wrong button, the driver's supervise tick still
// blocks any motion that closes clearance further.
const HYSTERESIS_MM   = 20    // clearance must exceed stop + this to dismiss
const ESCAPE_SPEED_PCT = 6    // capped speed while modal is up (percent)
const AUTO_CLOSE_FLASH_MS = 1400

function shortLink(name) {
  return name
    .replace('_shoulder', '').replace('_upper_arm', '')
    .replace('_forearm', '' ).replace('_wrist1',   '')
    .replace('_wrist2',   '').replace('_flange',   '')
}
function shortZone(name) {
  return name.startsWith('zone#') ? name.slice(5) : name
}

// For any pair, pick which side is the arm-link and which is the
// non-arm counterpart. Non-arm side may be another link (self-collision),
// '__ground__' (floor pseudo-body), or 'zone#<id>' (static obstacle).
function splitPair(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return { link: null, other: null }
  const [a, b] = pair
  const isNonArm = (n) => typeof n === 'string'
    && (n === '__ground__' || n.startsWith('zone#'))
  if (isNonArm(a)) return { link: b, other: a }
  return { link: a, other: b }
}

function otherLabel(other) {
  if (other === '__ground__') return 'the floor'
  if (typeof other === 'string' && other.startsWith('zone#')) {
    return 'zone ' + other.slice(5)
  }
  return String(other)
}

function headlineForKind(kind, link, other, dist) {
  const dstr = dist != null ? `${dist.toFixed(0)} mm` : '—'
  if (kind === 'ground') {
    return `Arm near floor: ${shortLink(link)} is ${dstr} above the floor`
  }
  if (kind === 'self') {
    return `Arm links close: ${shortLink(link)} is ${dstr} from ${shortLink(other)}`
  }
  return `Arm near obstacle: ${shortLink(link)} is ${dstr} from ${otherLabel(other)}`
}

function stopHeadlineForKind(kind, other, dist) {
  const dstr = dist != null ? `${dist.toFixed(0)} mm` : '—'
  if (kind === 'ground')
    return `Motion toward the floor blocked at ${dstr}`
  if (kind === 'self')
    return `Motion between ${shortLink(other)} and the closest link blocked at ${dstr}`
  return `Motion toward ${otherLabel(other)} blocked at ${dstr}`
}

export default function ObstacleEscapeModal() {
  const robot          = useStore((s) => s.robot) || {}
  const safety         = useStore((s) => s.safety) || {}
  const jogHold        = useStore((s) => s.jogHold)
  const jogRelease     = useStore((s) => s.jogRelease)

  // Unified guard state — driver publishes the DOMINANT threat
  // (self / ground / env) into these keys with a `guard_kind`
  // discriminator. This popup handles all three the same way:
  // show the pair + live distance, offer escape jog buttons,
  // fallback to slow all-axis override when the model gives up.
  const {
    guard_active, guard_kind, guard_pair, guard_min_mm,
    guard_warn_mm, guard_stop_mm, guard_escapes,
    enabled, alarm, allow_jog,
  } = robot
  // Legacy names still consumed elsewhere (twin tint reads
  // collision_pair). Alias them here for the local naming.
  const env_pair = guard_pair
  const env_min_mm = guard_min_mm
  const env_warn_mm = guard_warn_mm
  const env_stop_mm = guard_stop_mm
  const env_escape_dirs = guard_escapes

  // Trigger + phase logic — single source of truth. Session latches
  // when d ≤ stop; releases when d > stop + HYSTERESIS_MM (with a brief
  // "Clear" flash for operator feedback). Warn-band proximity does NOT
  // open this popup — the MinClearanceChip in the 3D view chrome owns
  // that presentation.
  const [minimized, setMinimized] = useState(false)
  const [sessionActive, setSessionActive] = useState(false)
  const [flashClearUntil, setFlashClearUntil] = useState(0)
  const prevInStop = useRef(false)

  const inStop = env_min_mm != null && env_stop_mm != null
                 && env_min_mm <= env_stop_mm
  const isJogCapable = !!enabled && !alarm && !safety?.estop

  useEffect(() => {
    if (inStop && !prevInStop.current) {
      // Freshly entered stop band — pop the modal, reset minimize.
      setSessionActive(true)
      setMinimized(false)
    }
    if (!inStop && prevInStop.current && sessionActive) {
      // Just exited stop — check hysteresis, kick off flash + close.
      if (env_min_mm != null && env_stop_mm != null
          && env_min_mm > env_stop_mm + HYSTERESIS_MM) {
        setFlashClearUntil(Date.now() + AUTO_CLOSE_FLASH_MS)
      }
    }
    prevInStop.current = inStop
  }, [inStop, sessionActive, env_min_mm, env_stop_mm])

  useEffect(() => {
    if (flashClearUntil === 0) return
    const remaining = flashClearUntil - Date.now()
    if (remaining <= 0) {
      setSessionActive(false)
      setFlashClearUntil(0)
      return
    }
    const t = setTimeout(() => {
      setSessionActive(false)
      setFlashClearUntil(0)
    }, remaining + 30)
    return () => clearTimeout(t)
  }, [flashClearUntil])

  // Nothing to show if we've never had a proximity event, or arm
  // isn't jog-capable (in which case AlarmRecoveryModal owns the
  // screen — env popup would fight it).
  if (!sessionActive) return null
  if (!isJogCapable) return null
  if (minimized && flashClearUntil === 0) return null   // banner takes over

  const flashing = flashClearUntil > 0
  const isStopLevel = !flashing && env_min_mm != null && env_stop_mm != null
                     && env_min_mm <= env_stop_mm

  const { link, other } = splitPair(env_pair)
  const chromeBg = flashing        ? '#065F46'   // green flash
                 : isStopLevel     ? '#7F1D1D'   // red-amber
                 :                   '#78350F'   // amber warn

  const headline = flashing
    ? `Clear — ${env_min_mm?.toFixed(0) ?? '—'} mm`
    : isStopLevel
      ? stopHeadlineForKind(guard_kind, other, env_min_mm)
      : headlineForKind(guard_kind, link, other, env_min_mm)

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 4000,
      background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, pointerEvents: 'auto',
    }}>
      <div style={{
        background: '#fff', color: '#111827',
        borderRadius: 12, width: '100%', maxWidth: 680,
        boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          background: chromeBg, color: '#FFF7ED',
          padding: '12px 16px 10px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 12, height: 12, borderRadius: '50%',
            background: flashing        ? '#6EE7B7'
                      : isStopLevel     ? '#FCA5A5'
                      :                   '#FDE68A',
            flexShrink: 0,
          }} />
          <div style={{
            flex: 1, fontSize: 15, fontWeight: 700,
            letterSpacing: '0.02em',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {headline}
          </div>
          {!flashing && (
            <button
              onClick={() => setMinimized(true)}
              title="Minimize to banner"
              style={{
                background: 'rgba(255,255,255,0.15)',
                color: '#FFF7ED',
                border: '1px solid rgba(255,255,255,0.35)',
                borderRadius: 6, padding: '3px 10px',
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              ↓ Minimize
            </button>
          )}
        </div>

        {!flashing && (
          <div style={{
            padding: '16px 20px 20px 20px',
            display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            {/* Big live distance readout */}
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 16,
              padding: 12, background: '#FEF3C7',
              borderRadius: 8, border: '1px solid #FCD34D',
            }}>
              <div style={{
                fontSize: 34, fontWeight: 800, color: '#7C2D12',
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.02em',
              }}>
                {env_min_mm != null ? env_min_mm.toFixed(0) : '—'} mm
              </div>
              <div style={{ fontSize: 13, color: '#78350F', lineHeight: 1.4 }}>
                {shortLink(link)} ↔ {other === '__ground__' ? 'floor' : (
                  typeof other === 'string' && other.startsWith('zone#')
                    ? shortZone(other) : shortLink(other))}<br/>
                {isStopLevel
                  ? `motion toward the ${guard_kind === 'ground' ? 'floor' : guard_kind === 'self' ? 'other link' : 'obstacle'} is blocked — escape directions still live`
                  : `warn threshold ${env_warn_mm?.toFixed(0)} mm  ·  stop at ${env_stop_mm?.toFixed(0)} mm`}
              </div>
            </div>

            {/* Escape controls */}
            <EscapeControls
              escapes={env_escape_dirs || []}
              jogHold={jogHold}
              jogRelease={jogRelease}
              speedPct={ESCAPE_SPEED_PCT}
              allowJog={!!allow_jog}
              fallback={!env_escape_dirs || env_escape_dirs.length === 0}
            />

            <div style={{ fontSize: 11, color: '#6B7280', fontStyle: 'italic', lineHeight: 1.5 }}>
              Escape jogs are capped at {ESCAPE_SPEED_PCT}% speed while this popup is open. The driver
              blocks any motion that closes clearance further — the buttons above are the only
              directions currently proven to open it.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Escape-hold-to-jog buttons. Each button uses the SAME jog transport
// as the pendant (WS-first via store.jogHold/jogRelease), passing a
// per-button hold_id so the server-side keepalive treats each press
// as its own session. Speed cap is enforced by passing 6 through
// speedPct; driver's own governor caps below anyway.
const FALLBACK_SPEED_PCT = 3    // matches driver's collision_fallback_speed_frac

function EscapeControls({ escapes, jogHold, jogRelease, speedPct, allowJog, fallback }) {
  if (!allowJog) {
    return (
      <div style={{ fontSize: 13, color: '#78350F' }}>
        Jog is disabled on this driver (ESTUN_ALLOW_JOG=0). Use the pendant to escape.
      </div>
    )
  }
  // Fallback: model found no single-axis escape. Operator has an
  // e-stop and outranks a possibly-wrong geometry model — render
  // ALL 12 joint directions at the fallback speed, plainly labeled
  // as an override. Driver enforces the same 3% cap on the wire.
  if (fallback) {
    const dirs = []
    for (let j = 1; j <= 6; j++) {
      dirs.push({ joint: j, direction: +1 })
      dirs.push({ joint: j, direction: -1 })
    }
    return (
      <div>
        <div style={{
          fontSize: 12, color: '#7F1D1D', background: '#FEE2E2',
          border: '1px solid #FCA5A5', borderRadius: 6, padding: 10,
          marginBottom: 10, lineHeight: 1.4,
        }}>
          <b>Model sees no single-axis escape.</b> Slow joint jog enabled,
          all axes, {FALLBACK_SPEED_PCT}% — e-stop in hand. The geometry
          model can be wrong; use these buttons with caution and keep the
          e-stop reachable.
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 6,
        }}>
          {dirs.map((d) => (
            <EscapeButton
              key={`${d.joint}${d.direction}`}
              joint={d.joint} direction={d.direction}
              projectedMm={null} currentMm={null}
              jogHold={jogHold} jogRelease={jogRelease}
              speedPct={FALLBACK_SPEED_PCT}
              best={false}
              label="override"
            />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase',
                    letterSpacing: '0.08em', marginBottom: 8, fontWeight: 700 }}>
        Escape directions (hold to jog)
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 8,
      }}>
        {escapes.slice(0, 6).map((e, i) => (
          <EscapeButton
            key={`${e.joint}${e.direction}`}
            joint={e.joint}
            direction={e.direction}
            projectedMm={e.projected_mm}
            currentMm={e.current_mm}
            jogHold={jogHold}
            jogRelease={jogRelease}
            speedPct={speedPct}
            best={i === 0}
          />
        ))}
      </div>
    </div>
  )
}

// Individual hold-to-jog button. Sends the initial jogHold on press,
// keeps sending refreshes at 100 ms while held (matches HoldButton in
// JogControls but simpler — this button is single-purpose), and
// releases on any lift path.
function EscapeButton({ joint, direction, projectedMm, currentMm,
                        jogHold, jogRelease, speedPct, best, label }) {
  const holdIdRef = useRef(null)
  const seqRef    = useRef(0)
  const tickRef   = useRef(null)
  const pressed   = useRef(false)

  const stop = useCallback(() => {
    if (!pressed.current) return
    pressed.current = false
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (holdIdRef.current) {
      jogRelease('joint', { hold_id: holdIdRef.current, seq: ++seqRef.current })
      holdIdRef.current = null
    }
  }, [jogRelease])
  const start = useCallback((e) => {
    if (pressed.current) return
    if (e?.preventDefault) e.preventDefault()
    pressed.current = true
    holdIdRef.current = Math.random().toString(36).slice(2, 12)
    seqRef.current = 0
    const meta = { hold_id: holdIdRef.current, seq: ++seqRef.current }
    jogHold(joint, direction, speedPct, meta)
    tickRef.current = setInterval(() => {
      if (!pressed.current || !holdIdRef.current) return
      const m = { hold_id: holdIdRef.current, seq: ++seqRef.current }
      jogHold(joint, direction, speedPct, m)
    }, 100)
  }, [joint, direction, jogHold, speedPct])
  useEffect(() => () => stop(), [stop])

  const sym  = direction > 0 ? '+' : '−'
  const gain = projectedMm != null && currentMm != null
               ? Math.max(0, projectedMm - currentMm)
               : null

  return (
    <button
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={(e) => { if (e.buttons === 0) stop() }}
      onTouchStart={start}
      onTouchEnd={stop}
      onTouchCancel={stop}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        gap: 4, padding: '10px 12px',
        background: best ? '#065F46' : '#0F766E',
        color: '#fff', border: 'none', borderRadius: 8,
        cursor: 'pointer', userSelect: 'none', touchAction: 'none',
        textAlign: 'left',
        boxShadow: best ? '0 2px 8px rgba(6,95,70,0.35)' : 'none',
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
        J{joint} {sym}
      </div>
      <div style={{ fontSize: 11, opacity: 0.85 }}>
        {label ? label : (best ? 'BEST • opens ' : 'opens ')}{gain != null ? `${gain.toFixed(0)} mm` : ''}
      </div>
    </button>
  )
}

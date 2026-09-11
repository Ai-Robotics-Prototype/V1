// Jog stop-cause banner + live joint-margin HUD (2026-08-04, Lesson 165).
//
// Renders the operator-language stop cause and the live approach-margin
// warning on any jog surface (main JogControls + teach drawer overlay).
// Fork registry: `jog_stop_cause_propagation` — the ONLY renderer of
// `robot.stop_cause_copy`. Frontend must not re-parse the raw
// `last_stop_reason` text; the dashboard already translated it.

import React, { useEffect, useRef, useState } from 'react'

// Show the stop banner for this long after last_stop_ts (seconds).
// The driver publishes the fresh cause the moment the stop lands
// (see _publish_status_blob call at the end of _stop_jog_locked),
// so a 6 s persistence covers a full glance-away cycle without
// lingering into the next intentional press.
const STOP_BANNER_TTL_S = 6

// Any joint within this many degrees of its safe_edge counts as
// "approaching" — HUD renders the joint name + current + headroom.
const APPROACH_HUD_MARGIN_DEG = 20

// 2026-09-11 governor-noise audit: the softening HUD renders ONLY
// when the governor is MEANINGFULLY intervening — TCP speed actually
// slowed by more than the below threshold. Below that: silence. A
// momentary kiss of the cap during direction change is normal
// physics, not news.
//
//   * SCALE_MEANINGFUL: render iff scale < 0.90 (>10% reduction)
//   * SCALE_CLEAR_HYSTERESIS: once shown, persist until scale ≥ 0.95
//   * SCALE_CLEAR_DEBOUNCE_MS: … for 500 ms above the clear threshold
//   * SCALE_ENTER_DEBOUNCE_MS: a scaled state must persist 300 ms
//     before it first renders (transients <300 ms never render)
//
// Stop-cause softenings (cart_limit_at_wall / cart_limit_deepening)
// carry no `scale` field — they render immediately (the arm HAS
// stopped; there's nothing transient about that).
const SCALE_MEANINGFUL          = 0.90
const SCALE_CLEAR_HYSTERESIS    = 0.95
const SCALE_CLEAR_DEBOUNCE_MS   = 500
const SCALE_ENTER_DEBOUNCE_MS   = 300
// Causes that carry a `scale` field — the gate applies to these.
// Everything else renders on presence (stops, unknown causes).
const SCALED_CAUSES = new Set([
  'joint_overspeed',
  'joint_limit_soft',
  'sigma_soft',
])

// Tags the operator's own gestures produce — suppressed on the banner
// because the operator already knows they released the button.
const OPERATOR_GESTURE_TAGS = new Set([
  'release_cmd',
  'increment_end',
])

export function JogStopBanner({ robot }) {
  const copy = robot?.stop_cause_copy
  if (!copy || !copy.title) return null
  const tag = String(copy.tag || '')
  if (OPERATOR_GESTURE_TAGS.has(tag)) return null
  const ts = Number(copy.ts || 0)
  if (!ts) return null
  const ageS = Date.now() / 1000 - ts
  if (ageS > STOP_BANNER_TTL_S || ageS < 0) return null

  // Severity by tag. joint_limit / collision_guard are the operator-
  // actionable "you hit a wall" surfaces; freshness_deadman /
  // send_failed are transport/environment (warn tint).
  const severity = (tag === 'joint_limit'
                    || tag === 'collision_guard'
                    || tag === 'zero_speed')
    ? 'block'
    : 'warn'

  const bg = severity === 'block' ? '#FEE2E2' : '#FEF3C7'
  const bd = severity === 'block' ? '#DC2626' : '#B45309'
  const fg = severity === 'block' ? '#7F1D1D' : '#78350F'

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="jog-stop-banner"
      style={{
        background: bg,
        border: `2px solid ${bd}`,
        borderRadius: 8,
        padding: '8px 12px',
        margin: '6px 0',
        color: fg,
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 2 }}>
        {copy.title}
      </div>
      <div style={{ fontWeight: 400 }}>
        {copy.detail}
      </div>
    </div>
  )
}

export function LiveMarginHUD({ robot }) {
  const softening = robot?.cart_softening
  const joints = Array.isArray(robot?.joint_limits) ? robot.joint_limits : []

  // 2026-09-11 gated softening: run raw `cart_softening` through
  // the scale-meaningful gate + enter/clear debounces. `soft` is
  // whatever the operator actually needs to see, not every wobble
  // the driver reports. See threshold constants above.
  const soft = useGatedSoftening(softening)

  // Static approach warnings — every joint within APPROACH_HUD_MARGIN_DEG
  // of its safe_edge is listed. Persistent while in the zone (directive
  // item 3: not a transient toast). 2026-08-05: past-limit joints render
  // the honest "past its limit — jog {escape} to recover" line; approach
  // joints render the softer distance-to-edge line.
  const approaching = joints
    .map((j) => {
      const cur   = Number(j?.current_deg)
      const lim   = Number(j?.limit_deg)
      const mrg   = Number(j?.margin_deg)
      if (!Number.isFinite(cur) || !Number.isFinite(lim) || !Number.isFinite(mrg)) return null
      const safeEdge = lim - mrg
      const headroom = safeEdge - Math.abs(cur)
      const past     = headroom < 0
      if (headroom > APPROACH_HUD_MARGIN_DEG) return null
      const escapeSym = cur >= 0 ? '−' : '+'
      return {
        joint:    Number(j.joint) || 0,
        current:  cur,
        limit:    lim,
        headroom,
        past,
        escapeSym,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.headroom - b.headroom)

  if (!soft && approaching.length === 0) return null

  const bg = soft ? '#FEF3C7' : '#FEF9C3'
  const bd = soft ? '#B45309' : '#CA8A04'
  const fg = soft ? '#78350F' : '#713F12'

  return (
    <div
      data-testid="live-margin-hud"
      style={{
        background: bg,
        border: `1.5px solid ${bd}`,
        borderRadius: 6,
        padding: '6px 10px',
        margin: '4px 0',
        color: fg,
        fontSize: 13,
        lineHeight: 1.35,
      }}
    >
      {soft ? (
        <div style={{ fontWeight: 600 }}>
          {/* 2026-09-09 §NN singularity governor — plain-language
              copy per operator directive item 4. Every `cause` the
              driver emits gets its own rewrite; unknown causes fall
              through to the legacy joint-limit line so a new sink
              still renders something readable. */}
          {(() => {
            const cause = String(soft.cause || '')
            const j = soft.limiting_joint_1based
            if (cause === 'singularity_guard') {
              return 'Slowing down — arm approaching a stretched-out pose.'
            }
            if (cause === 'joint_overspeed' && j) {
              return `Slowing down — J${j} would move faster than its safe rate.`
            }
            if (cause === 'cart_limit_at_wall' && j) {
              return `Stopping — J${j} is at its physical limit.`
            }
            if (cause === 'cart_limit_deepening' && j) {
              return `Stopping — J${j} would push past its safe edge.`
            }
            // Legacy joint_limit_soft (and unknown causes) — keep the
            // existing copy so nothing regresses.
            const headroomTail = Number.isFinite(soft.headroom_deg)
              ? ` (${soft.headroom_deg.toFixed(1)}° to safe edge)`
              : ''
            return `Slowing down — J${j || '?'} approaching its limit${headroomTail}.`
          })()}
        </div>
      ) : null}
      {approaching.map((r) => (
        <div key={r.joint} style={{ fontWeight: r.past ? 700 : 400 }}>
          {r.past
            ? `J${r.joint} past its limit (${r.current.toFixed(0)}° / ±${r.limit.toFixed(0)}°) — jog ${r.escapeSym}J${r.joint} to recover`
            : `J${r.joint} at ${r.current.toFixed(0)}° — ${r.headroom.toFixed(0)}° to the safety edge`}
        </div>
      ))}
    </div>
  )
}

// Gate incoming `cart_softening` frames by scale + enter/clear
// debounce so brief transients + shallow scaling don't flash the
// operator with warnings that aren't news.
//
// Behavior:
//   * A scaled cause (joint_overspeed / joint_limit_soft /
//     sigma_soft) with scale ≥ SCALE_MEANINGFUL never renders.
//   * A first-seen scaled-and-meaningful cause is DELAYED for
//     SCALE_ENTER_DEBOUNCE_MS; if the driver clears it before the
//     delay elapses, nothing renders.
//   * Once rendered, the note persists until scale has been ≥
//     SCALE_CLEAR_HYSTERESIS for SCALE_CLEAR_DEBOUNCE_MS (no
//     flicker on a bob back into scaling territory).
//   * Stop causes (cart_limit_at_wall / cart_limit_deepening) or
//     any cause without a `scale` field render immediately — the
//     arm has stopped, no debounce, nothing transient.
export function useGatedSoftening(raw) {
  const [shown, setShown] = useState(null)
  // Refs so the pending-enter / pending-clear timers survive
  // re-renders without triggering their own re-runs.
  const enterAtRef = useRef(0)    // ms since epoch — first tick over the gate
  const clearAtRef = useRef(0)    // ms since epoch — first tick above hysteresis
  useEffect(() => {
    const now = Date.now()
    const active = raw && raw.active
    const cause  = active ? String(raw.cause || '') : null
    const isScaled = cause && SCALED_CAUSES.has(cause)
    const scale = (raw && typeof raw.scale === 'number') ? raw.scale : null

    if (!active) {
      // Driver reports nothing — clear both state and the timers.
      enterAtRef.current = 0
      clearAtRef.current = 0
      if (shown !== null) setShown(null)
      return
    }
    if (!isScaled) {
      // Non-scaled cause (a stop, or an unknown cause). Render on
      // presence — no debounce.
      enterAtRef.current = 0
      clearAtRef.current = 0
      if (shown !== raw) setShown(raw)
      return
    }
    // Scaled cause path — apply the gates.
    const meaningful = scale !== null && scale < SCALE_MEANINGFUL
    if (meaningful) {
      // Reset the clear timer — we're back below the meaningful gate.
      clearAtRef.current = 0
      if (shown === null) {
        // First tick of a scaled state. Start the enter debounce.
        if (enterAtRef.current === 0) enterAtRef.current = now
        if (now - enterAtRef.current >= SCALE_ENTER_DEBOUNCE_MS) {
          // Debounce elapsed — start rendering.
          setShown(raw)
        }
      } else {
        // Already rendering — refresh the payload so scale + joint
        // stay live in the copy.
        setShown(raw)
      }
      return
    }
    // Scaled cause but scale ≥ SCALE_MEANINGFUL — under the gate.
    // Reset enter-debounce timer.
    enterAtRef.current = 0
    if (shown !== null) {
      // Previously rendering — apply clear hysteresis.
      const above = scale === null || scale >= SCALE_CLEAR_HYSTERESIS
      if (above) {
        if (clearAtRef.current === 0) clearAtRef.current = now
        if (now - clearAtRef.current >= SCALE_CLEAR_DEBOUNCE_MS) {
          setShown(null)
          clearAtRef.current = 0
        }
      } else {
        clearAtRef.current = 0
      }
    }
  }, [raw, shown])
  return shown
}

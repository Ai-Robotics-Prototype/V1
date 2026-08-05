// Jog stop-cause banner + live joint-margin HUD (2026-08-04, Lesson 165).
//
// Renders the operator-language stop cause and the live approach-margin
// warning on any jog surface (main JogControls + teach drawer overlay).
// Fork registry: `jog_stop_cause_propagation` — the ONLY renderer of
// `robot.stop_cause_copy`. Frontend must not re-parse the raw
// `last_stop_reason` text; the dashboard already translated it.

import React from 'react'

// Show the stop banner for this long after last_stop_ts (seconds).
// The driver publishes the fresh cause the moment the stop lands
// (see _publish_status_blob call at the end of _stop_jog_locked),
// so a 6 s persistence covers a full glance-away cycle without
// lingering into the next intentional press.
const STOP_BANNER_TTL_S = 6

// Any joint within this many degrees of its safe_edge counts as
// "approaching" — HUD renders the joint name + current + headroom.
const APPROACH_HUD_MARGIN_DEG = 20

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

  // Active-softening line always renders when the driver is scaling.
  // Even if no joint is inside the display's static 20° zone, the
  // driver has decided to protect a joint — say so explicitly.
  const soft = softening && softening.active ? softening : null

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
          Slowing down — J{soft.limiting_joint_1based} approaching its limit
          {Number.isFinite(soft.headroom_deg)
            ? ` (${soft.headroom_deg.toFixed(1)}° to safe edge)`
            : ''}
          .
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

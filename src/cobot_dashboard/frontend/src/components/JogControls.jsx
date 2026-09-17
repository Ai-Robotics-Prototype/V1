import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import { createHoldTicker } from '../lib/holdTicker'
import { pushJogEvent, pushJogInterval, pushJogStop,
         startJogSession, endJogSession } from '../lib/jogTelemetry'
import { JogStopBanner, LiveMarginHUD } from './JogStopSurface'

// JogControls — the shared REAL-ARM hold-to-jog panel.
//
// Extracted from ProgramLayout so the Program tab and the 3D View tab
// render one source of truth. Every jog action here maps to the same
// /cmd/jog endpoint on the dashboard server, which publishes onto
// /robot/jog_command for the Estun driver's continuous-jog state
// machine to consume.
//
// Message contract:
//   press          → POST /cmd/jog {joint|axis, direction, speed_pct, hold: true}
//   150 ms repeat  → same shape (driver treats as refresh, no re-send)
//   release        → POST /cmd/jog {hold: false}
//   any transition → POST /cmd/jog {hold: false} first, then new hold
//
// A release message is sent on: onPointerUp, onPointerCancel,
// window blur / visibilitychange (hidden) / pagehide, disabled-mid-
// hold, and component unmount (useEffect cleanup). If the browser
// or tab dies before release, the driver's 300 ms freshness deadman
// fires with tag `keepalive_timeout`, and if that also fails the
// controller's heartbeat starvation is the final backstop.
// pointerleave is deliberately NOT a release path (2026-09-11
// standing-debt #6 fix): setPointerCapture routes true drift to
// pointercancel, so pointerleave firing during a captured hold is
// a re-render / hit-test / synthetic-event artefact — treating it
// as a release produced spurious mid-hold stops.
//
// Cartesian mode: the UI stays visible so the operator sees the full
// pendant surface, but every XYZ/RXYZ button is disabled behind a
// "pending validation" tooltip while allow_cartesian_jog is false on
// the driver. Joint mode is the only mode that commands motion today.

// 2026-09-11 OPERATOR ORDER (supersedes same-day speed-unlock):
// jog slider ceiling is 50 %. Wire the display max to this value so
// the DOM never promises speed the driver won't deliver. Any future
// change requires an explicit operator directive — mirrored on the
// driver by pin
// test_jog_speed_cap_is_fifty_percent_per_operator_order.
const JOG_SLIDER_MAX_PCT = 50

// -----------------------------------------------------------------------------
// HoldButton — mode is EXPLICIT via `jogStyle`. No timing heuristic.
//
//   • jogStyle='STEP'       → onTap fires once on press. No interval.
//                              Release is a no-op (nothing running).
//                              Press-and-hold does NOT repeat.
//
//   • jogStyle='CONTINUOUS' → onPressStart fires on press, onPressTick
//                              fires every 100 ms while held, onPressEnd
//                              fires on release. Release handlers:
//                              onPointerUp, onPointerCancel (OS
//                              interrupt), window blur / visibility
//                              (hidden) / pagehide, disabled-mid-hold,
//                              and useEffect cleanup on unmount. NO
//                              pointerleave — see file docblock above.
//                              and stop() always cancels the interval
//                              and fires onPressEnd exactly once.
// -----------------------------------------------------------------------------

export function HoldButton({
  jogStyle,
  onTap, onPressStart, onPressTick, onPressEnd,
  color, width, height, disabled, tooltip, children,
  bg = '#fff', bgHover, borderColor = '#d1d5db',
}) {
  // 2026-07-22 tablet-jitter fix — swap setInterval for a
  // dual-source ticker (Web Worker + rAF with time accounting) so
  // mobile timer throttling can't stretch keepalives past the
  // driver's 200 ms deadman. Deadman UNCHANGED — this is a
  // client-side reliability fix (Lesson 102 stands).
  const tickerRef      = useRef(null)
  const pressed        = useRef(false)
  // pointerId currently captured on this button — set on pointerdown,
  // cleared on pointerup/cancel. setPointerCapture routes ALL
  // subsequent move / up / cancel to the button element even if the
  // finger drifts off, so slight movement never cancels the hold.
  const capturedPointerId = useRef(null)
  // Per-session hold_id — regenerated on every fresh press so the
  // driver can distinguish "old cancelled session" refreshes from
  // "new session" holds. Any refresh whose hold_id doesn't match the
  // driver's active hold_id is discarded, so a browser-queued straggler
  // that arrives after release cannot restart motion.
  const holdIdRef      = useRef(null)
  const seqRef         = useRef(0)
  // AbortController for the current in-flight refresh fetch. On stop
  // we abort it before firing release — the release never queues
  // behind refreshes.
  const inFlightAbort  = useRef(null)
  // Coalesce guard: skip this tick if a previous refresh is still in
  // flight. WS transport (the fast path) sends synchronously and never
  // leaves this true; the guard only ever fires on HTTP fallback where
  // it keeps the pending queue capped at 1 so a slow HTTPS pool can't
  // stack a backlog. The old 400 ms abort-and-refire self-heal has been
  // removed — a slow-but-viable HTTP fetch is now allowed to complete,
  // and the driver's 200 ms freshness deadman is the safety backstop.
  const refreshInFlight = useRef(false)
  const refreshStartMs  = useRef(0)

  const nextSeq = () => { seqRef.current += 1; return seqRef.current }
  const newHoldId = () => Math.random().toString(36).slice(2, 12)

  const doRefresh = useCallback(async () => {
    if (!pressed.current || !holdIdRef.current) return
    // Coalesce: skip this tick if a previous refresh is still in flight.
    // Only ever true on the HTTP fallback path — the WS path returns
    // synchronously and never leaves refreshInFlight true. The previous
    // 400 ms abort-and-refire self-heal was removed: it was killing
    // slow-but-viable HTTP requests on a degraded dashboard, and the
    // driver's 200 ms freshness deadman is the correct final backstop.
    if (refreshInFlight.current) {
      pushJogEvent('tick_skip_inflight', { hold_id: holdIdRef.current })
      return
    }
    refreshInFlight.current = true
    refreshStartMs.current = Date.now()
    const ctrl = new AbortController()
    inFlightAbort.current = ctrl
    const meta = {
      hold_id: holdIdRef.current,
      seq:     nextSeq(),
      signal:  ctrl.signal,
    }
    try {
      await onPressTick?.(meta)
      pushJogEvent('tick_sent', { hold_id: holdIdRef.current, seq: meta.seq })
    } catch {
      pushJogEvent('tick_send_error', { hold_id: holdIdRef.current, seq: meta.seq })
      /* network failure — driver's deadman handles it */
    }
    finally {
      refreshInFlight.current = false
      if (inFlightAbort.current === ctrl) inFlightAbort.current = null
    }
  }, [onPressTick])

  // Track the wall-clock delta between successive tick_sent events so
  // the telemetry panel can show what the operator's actual keepalive
  // cadence looked like (not just the ticker's target).
  const lastSentTs = useRef(0)
  const doRefreshWithSampling = useCallback(() => {
    const now = performance.now()
    if (lastSentTs.current) {
      pushJogInterval('sent', 100, now - lastSentTs.current)
    }
    lastSentTs.current = now
    doRefresh()
  }, [doRefresh])

  // Route the "release" fallback (mouse-up while pointer is OFF the button)
  // through a window-level pointerup/mouseup listener, wired at press and
  // torn down at stop. Reading the LATEST stop via stopRef keeps this
  // decoupled from stop's identity churn.
  const globalUpHandlerRef = useRef(null)
  const start = useCallback((e) => {
    if (disabled) return
    if (e && e.preventDefault) e.preventDefault()
    if (pressed.current) return
    pressed.current = true
    if (jogStyle === 'CONTINUOUS') {
      holdIdRef.current = newHoldId()
      seqRef.current = 0
      const meta = {
        hold_id: holdIdRef.current,
        seq:     nextSeq(),
      }
      // First frame — no abort signal; we want it to complete, and
      // there's nothing to coalesce against.
      onPressStart?.(meta)
      startJogSession(holdIdRef.current)
      pushJogEvent('press_start', { hold_id: holdIdRef.current })
      lastSentTs.current = performance.now()
      pushJogInterval('sent', 100, 0)
      // 100 ms cadence via createHoldTicker — Worker + rAF hybrid.
      // Both sources fire; the ticker coalesces so a single 100 ms
      // effective cadence hits the send path. Mobile timer throttling
      // (Lesson-102-adjacent: tablet browsers can stretch setInterval
      // past the 200 ms deadman when the main thread is jank-y) can't
      // stretch this because the Worker runs off-thread. rAF is the
      // belt-and-braces path and stays foreground-only.
      if (tickerRef.current) tickerRef.current.destroy()
      tickerRef.current = createHoldTicker({
        interval_ms: 100,
        coalesce_ms: 40,
        onFire: () => { doRefreshWithSampling() },
      })
      tickerRef.current.start()
    } else {
      // STEP: one increment per press, no interval, no hold repeat.
      onTap?.()
    }
  }, [disabled, jogStyle, onTap, onPressStart, doRefreshWithSampling])

  const stop = useCallback(() => {
    if (!pressed.current) return
    pressed.current = false
    // Kill the ticker BEFORE sending the release so no straggler
    // tick can queue behind it. destroy() also terminates the
    // Worker so the Blob URL / off-thread timer are cleaned up.
    if (tickerRef.current) {
      try { tickerRef.current.destroy() } catch { /* nop */ }
      tickerRef.current = null
    }
    // Abort any in-flight refresh so it releases its connection slot;
    // then send the release. Release travels on its own fresh request.
    if (inFlightAbort.current) {
      try { inFlightAbort.current.abort() } catch { /* nop */ }
      inFlightAbort.current = null
    }
    refreshInFlight.current = false
    if (jogStyle === 'CONTINUOUS' && holdIdRef.current) {
      const meta = {
        hold_id: holdIdRef.current,
        seq:     nextSeq(),
      }
      pushJogEvent('release_sent', { hold_id: holdIdRef.current, seq: meta.seq })
      // Fire-and-forget — we don't await so a slow release POST doesn't
      // block subsequent UI actions. The driver still processes the
      // hold:false frame immediately on receipt.
      onPressEnd?.(meta)
      holdIdRef.current = null
      endJogSession()
    }
  }, [jogStyle, onPressEnd])

  // Fire release ONLY on real unmount, not on every stop-identity change.
  // Why this mattered: `stop`'s useCallback deps include `onPressEnd`, and
  // JogControls creates a fresh `(meta) => holdEnd(meta)` closure in wire()
  // on every render. The store's /ws state stream updates `robot`/`safety`/
  // `task` slices ~25 Hz, so JogControls re-renders ~25 Hz, so onPressEnd
  // gets a new identity ~25 Hz, so stop got a new identity ~25 Hz, so this
  // effect's cleanup fired ~25 Hz — sending release POSTs mid-hold.
  // Symptom in the driver log: every "continuous hold: …" was followed
  // ~100–200 ms later by "Robot/stopJog sent (release cmd)" (client
  // release), NOT "hold staleness" (deadman). Look like step mode.
  // Fix: route unmount through a ref so cleanup identity is decoupled
  // from the per-render closure churn — the ref holds the latest stop,
  // but the effect deps are empty so cleanup only runs on real unmount.
  const stopRef = useRef(stop)
  useEffect(() => { stopRef.current = stop })
  useEffect(() => () => stopRef.current?.(), [])

  // 2026-08-03 §3: window-level release paths.  The server's 300 ms
  // freshness deadman catches every one of these anyway, but the
  // client should ALSO proactively stop on any "the press logically
  // ended" signal so an offline dashboard doesn't have to fall back
  // to the driver's timer.  Enumerated release paths (task §3):
  //   * pointerup     — pointer released on the button (existing).
  //   * pointercancel — OS/browser interrupted the pointer (existing).
  //     Genuine finger-off-screen or OS-level interrupt (scroll,
  //     notification, contextmenu, alt-tab into another app).
  //   * pointerleave  — NOT a release. 2026-09-11 standing-debt #6:
  //                     setPointerCapture routes true drift-off to
  //                     pointercancel; any pointerleave that STILL
  //                     fires with the pointer captured is a re-
  //                     render / hit-test artefact and must not
  //                     stop the hold.
  //   * blur          — window lost focus (alt-tab, task switcher).
  //                     A jog is a hands-on gesture; if the operator's
  //                     attention moved off the tab, releasing motion
  //                     is the right default.
  //   * visibilitychange (hidden) — tab hidden or backgrounded.
  //                     Timer throttling can starve the ticker within
  //                     ~200 ms on mobile; stop before the driver
  //                     deadman does.
  //   * WS drop / disabled — the connected slice went false; parent
  //                     disables the button. Effect below watches
  //                     the `disabled` prop and stops.
  useEffect(() => {
    if (!pressed.current) return
    const stopIt = (eventName) => {
      if (!pressed.current) return
      pushJogEvent(eventName, {})
      stopRef.current?.()
    }
    const onBlur     = () => {
      pushJogStop('blur',       { hold_id: holdIdRef.current })
      stopIt('release_window_blur')
    }
    const onVis      = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        pushJogStop('visibility', { hold_id: holdIdRef.current, kind: 'hidden' })
        stopIt('release_visibility_hidden')
      }
    }
    const onPageHide = () => {
      pushJogStop('visibility', { hold_id: holdIdRef.current, kind: 'pagehide' })
      stopIt('release_pagehide')
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('blur',     onBlur)
      window.addEventListener('pagehide', onPageHide)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('blur',     onBlur)
        window.removeEventListener('pagehide', onPageHide)
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis)
      }
    }
    // We deliberately re-attach on every render (empty dep array would
    // capture a stale `pressed.current`). Cost is a few addEventListener
    // calls per frame — cheaper than missing a release path.
  })

  // If the parent disables us mid-hold (WS drop, allow_jog gate closed,
  // safety zone changed) → stop immediately. `disabled` is the umbrella
  // signal the JogControls parent uses for "the driver won't accept
  // motion right now"; treating it as a release keeps the client's
  // ticker from spinning against a wall.
  useEffect(() => {
    if (disabled && pressed.current) {
      pushJogEvent('release_disabled_midhold', {})
      // `disabled` toggles for several reasons — WS drop, allow_jog
      // gate closing, safety zone flip. Tag as `disabled` and let
      // the bench analyzer cross-reference with driver logs to
      // narrow down which specific reason. The store's WS drop
      // handler adds its own `ws_drop` entry too so the log will
      // typically carry both when the trigger is a WS event.
      pushJogStop('disabled', { hold_id: holdIdRef.current })
      stopRef.current?.()
    }
  }, [disabled])

  // Pointer events replace the earlier mouse + touch pair. Advantages:
  //   * setPointerCapture routes all subsequent move/up/cancel events
  //     to THIS button even if the finger drifts off — no movement
  //     tolerance heuristic needed.
  //   * pointercancel (OS/browser interrupt — scroll gesture, phone
  //     call notification, long-press context menu) is a safe release.
  //   * touch-action:none blocks the browser from claiming the touch
  //     for a scroll/pinch gesture (also mirrored in the button style).
  //   * preventDefault on pointerdown suppresses the long-press context
  //     menu and other synthesized events (mousedown, click, etc.)
  //     that would otherwise fire alongside on touch devices.
  const onPointerDown = useCallback((e) => {
    pushJogEvent('pointerdown', { pointerType: e.pointerType, id: e.pointerId })
    if (disabled) return
    if (e.preventDefault) e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* nop */ }
    capturedPointerId.current = e.pointerId
    start(e)
  }, [disabled, start])
  const onPointerUp = useCallback((e) => {
    pushJogEvent('pointerup', { pointerType: e.pointerType, id: e.pointerId })
    pushJogStop('pointer_up',
      { hold_id: holdIdRef.current, pointerType: e.pointerType, id: e.pointerId })
    if (capturedPointerId.current != null) {
      try { e.currentTarget.releasePointerCapture(capturedPointerId.current) } catch { /* nop */ }
      capturedPointerId.current = null
    }
    stop()
  }, [stop])
  const onPointerCancel = useCallback((e) => {
    pushJogEvent('pointercancel', { pointerType: e.pointerType, id: e.pointerId })
    pushJogStop('pointer_cancel',
      { hold_id: holdIdRef.current, pointerType: e.pointerType, id: e.pointerId })
    if (capturedPointerId.current != null) {
      try { e.currentTarget.releasePointerCapture(capturedPointerId.current) } catch { /* nop */ }
      capturedPointerId.current = null
    }
    stop()
  }, [stop])

  return (
    <button
      disabled={disabled}
      title={disabled ? (tooltip || 'disabled') : undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.background = bgHover || (color + '15')
        e.currentTarget.style.borderColor = color
      }}
      onPointerLeave={(e) => {
        // 2026-09-11 standing-debt #6 fix: cosmetic ONLY. Do NOT stop
        // the hold. Prior behavior: any pointerleave (even while the
        // pointer was captured) released the hold, on the theory that
        // "capture-still-firing = intentional drift-off". That theory
        // was wrong: pointerleave also fires when a re-render swaps
        // the button element (React key change, memoization miss, an
        // in-render style change that triggers a layout/hit-test),
        // producing spurious `release_cmd` stops mid-hold — the
        // documented standing-debt #6 class. Genuine release paths
        // remain: pointerup, pointercancel (OS interrupt), blur,
        // visibilitychange (hidden), pagehide, disabled-mid-hold.
        e.currentTarget.style.background = bg
        e.currentTarget.style.borderColor = borderColor
        pushJogEvent('pointerleave_ignored',
          { pointerType: e.pointerType, id: e.pointerId,
            captured: capturedPointerId.current != null,
            pressed: pressed.current })
      }}
      style={{
        width, height, padding: 0,
        background: bg,
        border: `1px solid ${borderColor}`, borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4,
        transition: 'background 100ms, border-color 100ms',
        userSelect: 'none', touchAction: 'none',
        WebkitTapHighlightColor: 'transparent',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}

// 2026-09-16 immersive layout — loose labels rendered directly over
// the 3D scene get a compact white text-shadow so they read on any
// floor tone (dark shadow OR bright light-floor). Kept subtle per
// operator directive (no large chips behind labels).
const LABEL_TEXT_SHADOW =
  '0 1px 2px rgba(255,255,255,0.9), 0 0 3px rgba(255,255,255,0.7)'

// 2026-09-16 operator directive: every jog direction button uses
// the app's PRIMARY BLUE, replacing the per-axis red/green/blue/
// purple/gold. Same #2563EB the mode toggles + step-size chips use
// when active. Callers of ArrowPad still pass a `color` prop (kept
// for potential future re-tinting) but the button chip renders in
// this uniform blue; hover/held dims via _jogDarken; disabled
// dims 40 % via HoldButton's existing opacity rule.
const JOG_BUTTON_BLUE = '#2563EB'

// 2026-09-16 immersive layout — jog buttons render as SOLID colored
// chips with white glyphs so they read instantly over the 3D scene.
// Directional color coding preserved (X red, Y green, Z blue,
// rotation purple/gold). Hover darkens slightly; pressed dips further
// via the hover branch already wired in HoldButton (mouse still over
// the button while pressed = darker); disabled goes muted via
// HoldButton's existing opacity:0.4 rule.
function _jogDarken(hex) {
  // Simple 15%-darken by hex arithmetic. Handles both #RGB and #RRGGBB.
  const s = String(hex || '').replace('#', '')
  if (s.length !== 6) return hex
  const clamp = (v) => Math.max(0, Math.min(255, v))
  const r = clamp(parseInt(s.slice(0, 2), 16) * 0.82) | 0
  const g = clamp(parseInt(s.slice(2, 4), 16) * 0.82) | 0
  const b = clamp(parseInt(s.slice(4, 6), 16) * 0.82) | 0
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function ArrowPad({ jogStyle, onTap, onPressStart, onPressTick, onPressEnd,
                    rotation, label, color, size, svgSize, labelSize,
                    disabled, tooltip }) {
  // 2026-09-16 operator directive: uniform blue for every direction.
  // The caller-provided `color` is ignored for the chip fill — kept
  // in the signature so a future re-tint (per-axis colored variant)
  // is a one-liner rather than a call-site sweep. Held-state and
  // hover use _jogDarken(blue); disabled uses HoldButton's opacity.
  void color   // eslint: mark as intentionally unused for the fill
  const chipBg = JOG_BUTTON_BLUE
  const chipDim = _jogDarken(chipBg)
  return (
    <HoldButton
      jogStyle={jogStyle}
      onTap={onTap}
      onPressStart={onPressStart}
      onPressTick={onPressTick}
      onPressEnd={onPressEnd}
      color={chipBg}
      bg={chipBg}
      bgHover={chipDim}
      borderColor={chipDim}
      width={size} height={size}
      disabled={disabled}
      tooltip={tooltip}
    >
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24"
           style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill="#fff" />
      </svg>
      <span style={{ fontSize: labelSize, fontWeight: 800, color: '#fff', textShadow: '0 1px 1px rgba(0,0,0,0.25)' }}>{label}</span>
    </HoldButton>
  )
}

function PadCenter({ label, width = 80, height = 80, labelSize = 12 }) {
  return (
    <div style={{
      width, height,
      background: '#f3f4f6', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: labelSize, fontWeight: 700, color: '#9ca3af',
    }}>
      {label}
    </div>
  )
}

// -----------------------------------------------------------------------------
// JogControls — the pendant. Prop `maximized` picks the size tier;
// callers wrap it in whatever chrome / minimize toggle they need.
// -----------------------------------------------------------------------------
export default function JogControls({
  maximized = false,
  rightSlot = null,
  // 2026-09-16 side-column directive: Collapse Jog Buttons (+
  // fullscreen icon) move DOWN from the RealArmChrome header to
  // sit adjacent to Orient Flange Down at the bottom of the RIGHT
  // column. Prop is opaque JSX so JogControls doesn't have to know
  // about panel-mode state — View3DLayout composes the buttons
  // with the setView3dJogPanel callback it already owns.
  collapseSlot = null,
  // 2026-09-16 EXPAND-mode + SIDE-COLUMN OWNERSHIP directive:
  //   * `immersive=true` — portal the LEFT column (mode/step/speed
  //     stack) AND the RIGHT column (Orient + Collapse) OUT of the
  //     jog surface container into page-level slots identified by
  //     `#jog-left-column-slot` + `#jog-right-column-slot`. State
  //     stays owned by JogControls (React tree unchanged) but the
  //     DOM hierarchy has the side columns as page-level overlays
  //     — no longer descendants of the jog window/surface.
  //   * `expanded=true` — scale ONLY the CENTER pad container up
  //     via CSS transform. Side columns stay at their portaled
  //     positions and normal size (still usable while expanded).
  //     Program tab consumer passes neither prop → row layout is
  //     unchanged.
  immersive = false,
  expanded = false,
  // 2026-09-16 LEFT-column cleanup directive: caller supplies the
  // DISABLE/READY row (typically ArmEnableControl + JogReadyBadge)
  // so it lives INSIDE the LEFT column top instead of the panel
  // chrome header (which was creating a z-overlap with the "Jog"
  // heading beneath it). Program-tab consumer passes null → the
  // top slot slot renders nothing and the middle groups float up.
  leftTopSlot = null,
  // 2026-09-17 collapse-scope operator directive: `hidePads=true`
  // nulls the CENTER container (jog-center-pads + scaler + inner
  // pad grid) WITHOUT unmounting JogControls itself. LEFT + RIGHT
  // portals stay populated so the collapse chip and Orient stay
  // reachable. Program-tab consumer (immersive=false) passes no
  // prop and gets the legacy fill layout.
  hidePads = false,
  // 2026-09-17 tablet-clip fix (measured): the caller (View3DLayout)
  // measures the actual space between the LEFT/RIGHT slots and
  // the scaler's natural width, then passes a fitScale in
  // [MIN_FIT_SCALE, 1]. The scaler transform composes fitScale
  // with the expand scale so the cluster NEVER exceeds the space
  // between the rendered columns — clipping becomes structurally
  // impossible. Default 1 for the Program-tab consumer.
  fitScale = 1,
}) {
  const winW = (typeof window !== 'undefined') ? window.innerWidth : 1280
  // 2026-09-17 tablet-portrait breakpoint — the previous isTabletW
  // (winW ≤ 1280) was tuned for landscape tablets and overflowed
  // the Rotation cluster's Rz+ button off-screen at portrait 768.
  // The new isTabletPortrait breakpoint uses smaller pad tokens
  // so the (Position + Height + Rotation) cluster fits inside
  // the CENTER available width (viewport - LEFT slot 150 - RIGHT
  // slot 200 - 32 insets = 386 at 768w).
  const isTabletPortrait = winW <= 900
  const isTabletW = winW <= 1280
  const isNarrowW = winW <= 1500

  const jogHold        = useStore((s) => s.jogHold)
  const jogHoldCartesian = useStore((s) => s.jogHoldCartesian)
  const jogRelease     = useStore((s) => s.jogRelease)
  const jogIncrement       = useStore((s) => s.jogIncrement)
  const jogPulseCartesian  = useStore((s) => s.jogPulseCartesian)
  const sendPowerCommand   = useStore((s) => s.sendPowerCommand)
  // Banner is the MINIMIZED form of AlarmRecoveryModal. When the modal
  // 2026-09-04: the banner's "Recovery guide" reopen chip is retired
  // along with the banner itself. AlarmRecoveryModal owns its own
  // minimize/restore lifecycle; JogControls no longer participates.
  const jogStyle          = useStore((s) => s.jogStyle) || 'CONTINUOUS'
  const setJogStyle       = useStore((s) => s.setJogStyle)
  // 2026-09-08: program / triggerEstop / homeRobot / runProgram /
  // pauseProgram / resumeProgram / cancelProgram store hooks retired
  // with the RIGHT column. Program execution lives on Monitor; TopBar
  // owns E-STOP as the single always-visible surface.
  const task           = useStore((s) => s.task)
  const safety         = useStore((s) => s.safety)
  const robot          = useStore((s) => s.robot) || {}
  // Joint angles for the alarm banner's "J<n> is at <deg>°" recovery line.
  const joints         = useStore((s) => s.joints) || { positions: [] }

  // Default 'cartesian' matches the Program tab so operators see the
  // same layout (XYZ + Height + Rotation d-pads) on both tabs. If the
  // driver's allow_cartesian_jog gate is closed the XYZ pad renders
  // disabled and the operator can tap the Joint mode button to switch.
  const [jogMode, setJogMode] = useState('cartesian')
  const [step, setStep]       = useState(1.0)      // vestigial in continuous mode (kept for future inching / IncrementalJogPanel path)
  // Speed is a SHARED store field (jogSpeedPct) so this pad's slider
  // AND the standalone JogSpeedSlider write to the same source of
  // truth. Prior local `useState(20)` state was invisible to the
  // JogSpeedSlider — moving that widget changed the store but the
  // pad's hold handler kept reading its own state, so the wire showed
  // whatever value the pad's inline slider was last set to
  // (defaulting to 20% at page load). Symptom: slider "did nothing"
  // when the operator moved the pretty slider (jogSpeedPct changed;
  // wire stayed at 20% → driver capped at 15% → identical motion).
  const speed    = useStore((s) => s.jogSpeedPct)
  const setSpeed = useStore((s) => s.setJogSpeedPct)

  const speedRef = useRef(speed)
  const modeRef  = useRef(jogMode)
  const stepRef  = useRef(step)
  const jogStyleRef = useRef(jogStyle)
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { modeRef.current = jogMode }, [jogMode])
  useEffect(() => { stepRef.current = step }, [step])
  useEffect(() => { jogStyleRef.current = jogStyle }, [jogStyle])

  // Cartesian gate — allow_cartesian_jog flows from the driver via the
  // /estun/status mirror. Default false until validated on hardware.
  const cartesianEnabled = !!robot.allow_cartesian_jog

  // 2026-09-11 speed-unlock (operator directive, third repeat).
  // OUR software-side jog cap is retired. Slider commands 1:1 to
  // the wire. The controller's Manual/Auto rate applies its own
  // ceiling on the far side (Manual: 250 mm/s Cartesian / 30 °/s
  // joint; Auto: 2600 mm/s) — the UI names that wall explicitly
  // at slider ≥ 50% so operators know where the actual limit lives.
  //
  // Fallback 1.00 for pre-report builds / cold boot: absence of
  // driver report is NOT permission to invent a soft cap. Real
  // safety layers below this UI cap: per-joint velocity governor
  // ([2.41×3, 2.89×3] rad/s at ~92% of rated), σ_min governor,
  // controller alarm 2015. Removing our soft cap does not remove
  // any of those.
  const _effCap = Number.isFinite(robot.effective_speed_cap) ? robot.effective_speed_cap : 1.00
  const _hwCap  = Number.isFinite(robot.jog_speed_cap)        ? robot.jog_speed_cap        : 1.00
  const _opLim  = Number.isFinite(robot.operator_speed_limit) ? robot.operator_speed_limit : 1.00
  const effectivePct = Math.round(_effCap * 100)
  const hwPct        = Math.round(_hwCap  * 100)
  const opPct        = Math.round(_opLim  * 100)
  // Robot mode from the driver's mode mirror. 0 = Auto, 1 = Manual,
  // 2 = Remote (per HARDWARE.md > Robot-mode code table). Manual is
  // the default for jog. The UI hint tells the operator which wall
  // is enforcing high-slider values on the far side.
  const _robotModeCode = Number.isFinite(robot.robot_mode_code)
                          ? robot.robot_mode_code : 1
  const _isManual      = _robotModeCode === 1
  const _ctrlWall      = _isManual
    ? '250 mm/s / 30 °/s (Manual mode wall)'
    : '2600 mm/s (Auto)'

  const holdStart = useCallback((axis, direction, meta) => {
    if (modeRef.current === 'joint') {
      // axis is 1..6 already for joint pads.
      return jogHold(axis, direction, speedRef.current, meta)
    } else {
      // Cartesian pad passes 'x'/'y'/'z'/'rx'/'ry'/'rz'.
      return jogHoldCartesian(axis, direction, speedRef.current, meta)
    }
  }, [jogHold, jogHoldCartesian])

  const holdEnd = useCallback((meta) => {
    return jogRelease(modeRef.current, meta)
  }, [jogRelease])

  // STEP-mode press: one increment per press. Joint uses the driver's
  // time-boxed delta_deg path; Cartesian uses the fixed 150 ms mode:2
  // pulse (see driver docstring for why duration is fixed until TCP
  // velocity is characterized).
  const tap = useCallback((axis, direction) => {
    if (modeRef.current === 'joint') {
      const deltaDeg = direction * stepRef.current
      jogIncrement(axis, deltaDeg)
    } else {
      jogPulseCartesian(axis, direction, speedRef.current)
    }
  }, [jogIncrement, jogPulseCartesian])

  const { estop } = safety
  const { running, paused, state, program_step, program_total } = task

  // ── Alarm + stop-reason interpreters ──────────────────────────────
  // Map raw driver telemetry to actionable operator text. Codes are
  // from wire-captured publish/Error entries (see driver's _on_error
  // docstring for the full observed list).
  //
  // Joint-limit lockout: text pattern "Joint<n> exceeded limit."
  //   Recovery is not "clear the alarm"; the controller refuses to clear
  //   while the joint is still past limits. Operator must physically
  //   jog it back toward center on the factory UI first.
  // Emergency stop: recovery is the physical E-stop button reset,
  //   then Clear Alarm becomes effective.
  // Singular position: controller stalled at a kinematic singularity;
  //   operator has to jog away from the pose. Clear Alarm won't help
  //   until pose changes.
  // Servo error / power loss: generic reset via Clear Alarm; the
  //   operator likely needs to power-cycle if the cause is persistent.
  const alarm = robot.active_alarm || null
  const jointNumFromText = (txt) => {
    const m = /Joint\s*(\d)/i.exec(txt || '')
    return m ? parseInt(m[1], 10) : null
  }
  const jointLiveDeg = (jointNum) => {
    // /joint_states is 6-long, radians. Match by 1-based joint number.
    const positions = joints?.positions || []
    if (!jointNum || jointNum < 1 || jointNum > positions.length) return null
    return (positions[jointNum - 1] * 180 / Math.PI)
  }
  // Live joint-limit recovery data. If ANY joint reports out_of_range
  // in the driver's per-joint evaluation, we take over the banner with
  // a live recovery guide — direction, target, progress. This lets the
  // operator watch the arm come back into range in real time (posture
  // still streams during alarm state) instead of guessing.
  const outOfRangeJoints = (robot.joint_limits || []).filter((j) => j?.out_of_range)
  const anyOutOfRange = outOfRangeJoints.length > 0
  const recoveryGuideText = (() => {
    if (!anyOutOfRange) return null
    const lines = outOfRangeJoints.map((j) => {
      const dir = j.current_deg > 0 ? 'NEGATIVE' : 'POSITIVE'
      const targetInside = (j.limit_deg - 10).toFixed(0)
      return (
        `J${j.joint} PAST LIMIT: ${j.current_deg.toFixed(1)}° `
        + `(limit ±${j.limit_deg.toFixed(0)}°)\n`
        + `→ On the factory UI (Manual → Move → Joint), jog J${j.joint} `
        + `${dir} until below ${targetInside}°. `
        + `Live: ${j.current_deg.toFixed(1)}°`
      )
    })
    return lines.join('\n\n')
      + '\n\nOur jog is unavailable until the alarm clears — this step uses the pendant/factory UI by controller design.'
  })()
  const alarmCopy = (() => {
    if (!alarm) return null
    const { code, text } = alarm
    const jn = jointNumFromText(text)
    // 2002 joint-limit alarms hand off to the live recovery guide when
    // we can see the offending joint is still out_of_range — otherwise
    // fall back to the static copy.
    if (code === 2002 && jn != null) {
      const deg = jointLiveDeg(jn)
      const degStr = deg != null ? `${deg.toFixed(1)}°` : 'past its limit'
      return {
        headline: `ALARM: J${jn} exceeded limit`,
        recovery: `J${jn} is at ${degStr}. Clear is blocked while the joint is past its limit — use the factory UI (Manual → Jog) to move J${jn} toward center, then Clear Alarm → Enable.`,
      }
    }
    if (code === 2006 || code === 13046) {
      return {
        headline: `ALARM: Emergency stop`,
        recovery: `Reset the physical E-stop button on the pendant, then Clear Alarm → Enable.`,
      }
    }
    if (code === 2023) {
      return {
        headline: `ALARM: Singular position`,
        recovery: `The arm is at a kinematic singularity. Jog away from this pose on the factory UI first — Clear Alarm won't help until the pose changes.`,
      }
    }
    if (code === 9012) {
      return {
        headline: `ALARM: Power disconnection`,
        recovery: `Servo power was lost. Check the E-stop chain and pendant power, then Clear Alarm → Enable.`,
      }
    }
    // Fallback for any code we haven't specifically mapped — surface
    // the controller's own text verbatim and let the operator interpret.
    return {
      headline: `ALARM ${code ?? ''}: ${text || 'unknown'}`.trim(),
      recovery: 'Try Clear Alarm; if it re-appears immediately, the underlying condition is still active — check the pendant.',
    }
  })()

  // Driver-initiated jog stop cause + live joint-margin HUD are now
  // rendered by the shared <JogStopBanner /> + <LiveMarginHUD />
  // components sourced from robot.stop_cause_copy / robot.cart_softening.
  // The dashboard's `_jog_stop_cause_operator_copy` translator is the
  // single canonical source of operator-language strings — no regex
  // fork on the raw reason lives here anymore (fork registry:
  // `jog_stop_cause_propagation`, 2026-08-04 Lesson 165).

  // ── Jog-gate state (2026-09-04 banner retirement) ────────────
  // The full-width banner + inline action pills are retired per
  // operator directive; the visual "READY / NOT READY" cue lives in
  // <JogReadyBadge /> up in RealArmChrome's header, next to the
  // enable button. This block keeps ONLY the internal state we still
  // need:
  //   * `bannerLevel` → drives `jogGateOk` (used to grey out pad
  //     buttons and pick the not-ready tooltip below).
  //   * `bannerText`  → tooltip on greyed jog buttons ("why can't I
  //     jog right now"). The badge upstream also shows this, so the
  //     precedence table here is byte-aligned with the one in
  //     JogReadyBadge.computeReadyState.
  //
  // Actions previously rendered inline in the banner are ALL gone:
  //   * Enable / Disable        → <ArmEnableControl /> owns power
  //   * Clear Alarm             → AlarmRecoveryModal owns it
  //   * ↗ Recovery guide        → AlarmRecoveryModal re-opens itself
  //                               when its underlying condition
  //                               re-fires; the escape hatch chip
  //                               is retired with the banner.
  let bannerLevel = 'ready'
  let bannerText  = 'READY'
  if (estop) {
    bannerLevel = 'error'
    bannerText  = 'E-STOP — release to jog'
  } else if (!robot.connected) {
    bannerLevel = 'error'
    bannerText  = 'DRIVER DISCONNECTED'
  } else if (anyOutOfRange) {
    bannerLevel = 'error'
    bannerText  = outOfRangeJoints.length > 1
      ? `JOINTS PAST LIMIT: ${outOfRangeJoints.map((j) => 'J' + j.joint).join(', ')}`
      : `J${outOfRangeJoints[0].joint} PAST LIMIT`
  } else if (robot.alarm) {
    bannerLevel = 'error'
    bannerText  = alarmCopy?.headline
      || (robot.alarm_count > 1 ? `ALARM (${robot.alarm_count} active)` : 'ALARM')
  } else if (robot.enabling) {
    bannerLevel = 'warn'
    bannerText  = 'ENABLING…'
  } else if (!robot.enabled) {
    bannerLevel = 'warn'
    bannerText  = robot.allow_power ? 'ROBOT DISABLED' : 'ROBOT DISABLED — enable on pendant'
  } else if (running) {
    const stateLabel = paused ? 'paused' : (state || 'running')
    bannerLevel = 'warn'
    bannerText  = `PROGRAM RUNNING (${stateLabel} ${program_step + 1}/${program_total}) — press STOP to jog`
  } else if (!robot.allow_jog) {
    bannerLevel = 'warn'
    bannerText  = 'JOG GATE CLOSED — set ESTUN_ALLOW_JOG=1 on the driver'
  }
  const jogGateOk = bannerLevel === 'ready'

  // Sizing tiers (unchanged from the Program-tab original).
  // 2026-09-17 tablet-portrait sizing: at winW≤900 use ~48px pads so
  // Position(3×48+2×4=152) + gap12 + Height(48) + gap12 + Rotation(152)
  // = 376 fits inside the 386 available CENTER width at 768w portrait
  // (viewport - LEFT150 - RIGHT200 - insets32 = 386). Landscape tablet
  // and desktop tiers unchanged.
  const padBtn = maximized
    ? (isTabletPortrait ? 64 : isTabletW ? 84 : isNarrowW ? 108 : 140)
    : (isTabletPortrait ? 48 : isTabletW ? 72 : isNarrowW ?  84 : 96)
  const zBtnWidth  = padBtn
  const jointBtnW  = padBtn
  const jointBtnH  = padBtn
  const svgPx = maximized ? (isTabletW ? 38 : isNarrowW ? 48 : 60)
                          : (isTabletW ? 32 : isNarrowW ? 38 : 42)
  const lblPx = maximized ? (isTabletW ? 12 : isNarrowW ? 14 : 16)
                          : (isTabletW ? 11 : isNarrowW ? 12 : 13)
  // 2026-09-14 operator directive: spread the clusters. Prior values
  // were too tight — Position / Height / Rotation ran together and
  // individual pad buttons touched at wider viewports. New tokens are
  // bumped ~40% at padInner (within-cluster) and ~50% at padGroup
  // (between clusters); jointColGap follows the same scale for XYZ /
  // Joint parity. Container is overflowX:'hidden' + the pad row uses
  // flexWrap so nothing scrolls horizontally at any breakpoint.
  const padInner = maximized ? (isTabletPortrait ? 8  : isTabletW ? 12 : isNarrowW ? 16 : 20)
                             : (isTabletPortrait ? 4  : isTabletW ?  8 : isNarrowW ? 12 : 14)
  const padGroup = maximized ? (isTabletPortrait ? 16 : isTabletW ? 24 : isNarrowW ? 36 : 60)
                             : (isTabletPortrait ? 12 : isTabletW ? 20 : isNarrowW ? 30 : 44)
  const jointColGap = maximized ? (isTabletW ? 20 : isNarrowW ? 28 : 40)
                                : (isTabletW ? 14 : isNarrowW ? 20 : 28)
  const jointLblFont = maximized ? (isTabletW ? 12 : isNarrowW ? 14 : 16)
                                 : (isTabletW ? 11 : isNarrowW ? 12 : 13)
  const jointLblMb = maximized ? (isTabletW ? 6 : isNarrowW ? 8 : 10)
                               : (isTabletW ? 4 : isNarrowW ? 5 : 6)
  // 2026-09-08: actionMinH/actionFont/actionMinW/actionGap retired
  // with the RIGHT column (Run/Pause/STOP/Home/E-STOP/Teach buttons).
  const modeMinH = maximized ? (isTabletW ? 46 : isNarrowW ? 50 : 56)
                             : (isTabletW ? 40 : isNarrowW ? 42 : 44)
  const modeFont = maximized ? (isTabletW ? 13 : isNarrowW ? 14 : 16)
                             : (isTabletW ? 12 : isNarrowW ? 13 : 13)
  const modePadX = maximized ? (isTabletW ? 14 : isNarrowW ? 18 : 24)
                             : (isTabletW ? 12 : isNarrowW ? 14 : 18)
  const stepBtnH = maximized ? (isTabletW ? 44 : isNarrowW ? 48 : 56)
                             : (isTabletW ? 32 : isNarrowW ? 34 : 36)
  const stepBtnFont = maximized ? (isTabletW ? 13 : isNarrowW ? 14 : 15)
                                : (isTabletW ? 11 : isNarrowW ? 12 : 12)
  const sectionLabelFont = maximized ? (isTabletW ? 12 : 13)
                                     : (isTabletW ? 11 : 11)
  const speedFont = maximized ? (isTabletW ? 13 : isNarrowW ? 14 : 15)
                              : (isTabletW ? 12 : 13)
  const containerPad = maximized ? (isTabletW ? 10 : isNarrowW ? 16 : 20)
                                 : (isTabletW ?  8 : isNarrowW ? 10 : 12)
  const leftColW = maximized ? (isTabletW ? 168 : isNarrowW ? 196 : 220)
                             : (isTabletW ? 132 : isNarrowW ? 156 : 180)
  // 2026-09-08: rightColW retired with the RIGHT column.
  const rowGap = maximized ? (isTabletW ? 14 : isNarrowW ? 20 : 28)
                           : (isTabletW ?  8 : isNarrowW ? 12 : 16)

  const modeBtnStyle = (on, disabled = false) => ({
    padding: `0 ${modePadX}px`,
    minHeight: modeMinH,
    fontSize: modeFont, fontWeight: 700,
    background: on ? '#2563EB' : '#f3f4f6',
    color:      on ? '#fff'    : '#374151',
    border:     on ? '2px solid #2563EB' : '2px solid #d1d5db',
    borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    width: '100%',
    transition: 'all 100ms',
  })
  // 2026-09-08: runBtnBase retired with the RIGHT column.
  // 2026-09-16 immersive correction: loose labels sit directly over
  // the 3D scene now — add a compact white text-shadow chip so
  // "Position" / "Height" / "Rotation" stay readable on any floor
  // tone. No large card behind the label; the shadow does the work.
  const padLabel = (text) => (
    <div style={{
      fontSize: 12, fontWeight: 700, color: '#111',
      textAlign: 'center', marginBottom: 6,
      textShadow: LABEL_TEXT_SHADOW,
    }}>{text}</div>
  )

  // Wire a directional pad button. Joint mode uses 1..6; cartesian
  // uses letter axis strings. HoldButton passes a `meta` bag
  // (hold_id, seq, client_ts_ms, signal?) into each callback for the
  // driver's session-tracked drop-stale logic.
  const wire = (axis, direction) => ({
    jogStyle,
    onTap:        () => tap(axis, direction),
    onPressStart: (meta) => holdStart(axis, direction, meta),
    onPressTick:  (meta) => holdStart(axis, direction, meta),
    onPressEnd:   (meta) => holdEnd(meta),
    disabled: !jogGateOk || (jogMode === 'cartesian' && !cartesianEnabled),
    tooltip: !jogGateOk
      ? bannerText
      : (jogMode === 'cartesian' && !cartesianEnabled ? 'Cartesian jog pending validation' : undefined),
  })

  // Power-transition confirmation. `kind` is 'enable' | 'disable' |
  // 'clear_alarm'; null = no dialog open. Nothing on this component
  // ever calls sendPowerCommand without going through this state.
  const [pendingPower, setPendingPower] = useState(null)
  const openPowerConfirm = useCallback((kind) => {
    setPendingPower(kind)
  }, [])
  const cancelPowerConfirm = useCallback(() => {
    setPendingPower(null)
  }, [])
  const confirmPowerAction = useCallback(() => {
    const kind = pendingPower
    setPendingPower(null)
    if (kind) sendPowerCommand(kind)
  }, [pendingPower, sendPowerCommand])
  const powerCopy = pendingPower === 'enable'
    ? { title: 'Enable robot power?',
        body: 'Ensure the cell is clear before applying servo power.',
        cta: 'Enable', cta_bg: '#059669', cta_color: '#fff' }
    : pendingPower === 'disable'
    ? { title: 'Disable robot power?',
        body: 'Servo power will drop. Any active motion is stopped first.',
        cta: 'Disable', cta_bg: '#B45309', cta_color: '#fff' }
    : pendingPower === 'clear_alarm'
    ? { title: 'Clear active alarms?',
        body: 'Alarms will be dismissed on the controller. Enable is offered next if the alarm state clears.',
        cta: 'Clear', cta_bg: '#B91C1C', cta_color: '#fff' }
    : null
  // 2026-09-16 side-column ownership — resolve the page-level portal
  // targets when immersive mode is on. Slots are absolute-positioned
  // <div>s owned by View3DLayout at `#jog-left-column-slot` +
  // `#jog-right-column-slot`. Names carry an "El" suffix so they
  // don't shadow the caller-supplied `rightSlot` React-node prop.
  const [leftSlotEl,  setLeftSlotEl]  = useState(null)
  const [rightSlotEl, setRightSlotEl] = useState(null)
  useEffect(() => {
    if (!immersive || typeof document === 'undefined') return undefined
    const resolve = () => {
      setLeftSlotEl(document.getElementById('jog-left-column-slot'))
      setRightSlotEl(document.getElementById('jog-right-column-slot'))
    }
    // Double-RAF so React has committed AND the slot <div>s are in
    // the DOM before we grab them.
    let raf2 = null
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(resolve)
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [immersive, maximized])
  return (
    // 2026-09-17 SINGLE-WINDOW RESTRUCTURE — in immersive mode the
    // outer wrapper drops height:100% and pointer-events so the
    // pad-cluster overlay (view3d-layout owner) sizes to content
    // and passes clicks through everywhere except on actual
    // buttons/inputs. Program-tab consumer (immersive=false) keeps
    // the legacy full-height panel layout.
    <div style={{
      height: immersive ? 'auto' : '100%',
      display: 'flex', flexDirection: 'column', position: 'relative',
      pointerEvents: immersive ? 'none' : undefined,
    }}>
      {/* 2026-09-04: the full-width State banner is retired. The
          READY / NOT-READY cue lives in <JogReadyBadge /> up in the
          RealArmChrome header, next to the enable button. Actions
          previously in the banner (Enable / Disable / Clear Alarm /
          Recovery-guide reopen) route through their canonical
          owners: ArmEnableControl for power, AlarmRecoveryModal for
          alarms. Vertical space reclaimed for the 3D viewport. */}

      {/* Recovery sub-line — shown at the top of the pendant. Two
          sources, in
          priority order:
            1. Live joint-limit recovery guide (any joint out_of_range) —
               multi-line with direction + live-degrees readout,
               overrides any static alarm copy.
            2. Static alarm recovery copy (2002/2006/2023/9012/etc.).
          Kept mixed-case (banner is uppercase) so this reads as prose.
          Transient mid-session jog-stop reason moved to <JogStopBanner />
          below (2026-08-04 Lesson 165: fork registry-canonical surface). */}
      {(recoveryGuideText || alarmCopy?.recovery) && (
        <div style={{
          background: recoveryGuideText ? '#7F1D1D' : '#7F1D1D',
          color: '#FFF7ED',
          padding: '6px 12px',
          fontSize: 12,
          lineHeight: 1.4,
          flexShrink: 0,
          whiteSpace: 'pre-wrap',   // preserve the line breaks in the guide
          fontVariantNumeric: 'tabular-nums',   // keep live degrees readable
        }}>
          {recoveryGuideText || alarmCopy?.recovery}
        </div>
      )}

      <div style={{ padding: '0 12px', flexShrink: 0 }}>
        <JogStopBanner robot={robot} />
        <LiveMarginHUD robot={robot} />
      </div>

      {pendingPower && powerCopy && (
        <div
          onClick={cancelPowerConfirm}
          style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 10, padding: 20, minWidth: 320,
              maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
              display: 'flex', flexDirection: 'column', gap: 14,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>{powerCopy.title}</div>
            <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.4 }}>{powerCopy.body}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={cancelPowerConfirm}
                style={{
                  padding: '8px 14px', borderRadius: 6,
                  background: '#F3F4F6', color: '#111827',
                  border: '1px solid #D1D5DB', fontWeight: 600, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmPowerAction}
                style={{
                  padding: '8px 14px', borderRadius: 6,
                  background: powerCopy.cta_bg, color: powerCopy.cta_color,
                  border: 'none', fontWeight: 700, cursor: 'pointer',
                }}
              >
                {powerCopy.cta}
              </button>
            </div>
          </div>
        </div>
      )}

    <div
      data-testid="jog-surface-row"
      style={{
        padding: immersive ? 0 : containerPad,
        // 2026-09-16 operator directive: surface fully TRANSPARENT.
        // 2026-09-17 SINGLE-WINDOW RESTRUCTURE — in immersive mode
        // the row is content-sized (no width:100%, no flex:1) so
        // it doesn't form a full-width band over the canvas. It
        // hosts only the CENTER pads (LEFT and RIGHT are portaled
        // to page-level slots). pointer-events:none so the row's
        // padding gaps let clicks through to the canvas; the
        // buttons and inputs inside carry their own auto.
        background: 'transparent',
        width: immersive ? 'auto' : '100%',
        flex: immersive ? 'none' : 1,
        minHeight: immersive ? undefined : 0,
        pointerEvents: immersive ? 'none' : undefined,
        // 2026-09-16 tint correction — no internal scrollbar on the
        // translucent surface. Content lays out at its natural size
        // over the canvas (previous overflowY:'auto' was the source
        // of the operator-reported scrollbar).
        overflowX: 'hidden', overflowY: 'visible',
        display: 'flex', flexDirection: 'row',
        alignItems: 'flex-start', justifyContent: 'space-evenly',
        gap: immersive ? 0 : rowGap,
        boxSizing: 'border-box',
      }}>
      {/* LEFT — mode, step, speed. 2026-09-16 immersive side-column
          directive: distribute the stack vertically along the left
          edge instead of packing at the top. justifyContent:
          space-around gives even gaps between groups; the taller
          RealArmChrome (viewport-aware) provides the room to
          spread. flex-start is retired — it was the 2026-09-09
          fix for the tablet-XYZ-clip bug at 440-height, but the
          spread layout + taller chrome eliminates that clip class
          because the LEFT column now owns the full panel height
          and never overflows past its own top edge.

          IMMERSIVE portal (2026-09-16 SIDE-COLUMN OWNERSHIP): the
          operator directive is that in the 3D View, the LEFT
          column is a PAGE-LEVEL overlay — NOT a descendant of the
          jog surface container. The IIFE below keeps the JSX in
          ONE place (no duplication) and returns it either portaled
          to `#jog-left-column-slot` (immersive mode) or inline
          (Program tab default). React state ownership is
          unaffected — the tree is unchanged, only the DOM
          placement differs. Rendering `null` if the slot hasn't
          mounted yet is safe: the double-RAF in the effect above
          re-resolves the slot on next paint. */}
      {/* 2026-09-16 LEFT column cleanup — 3-section flex layout so
          the DISABLE/READY row pins to the top, the mode / step /
          step-size groups spread with generous even spacing in the
          middle, and the Speed slider pins to the bottom. Retired
          from THIS surface (per operator order Sep-16):
            * The 'Jog' heading — the controls below are self-
              evident, and the heading was rendering z-under the
              DISABLE button in the chrome header.
            * The 'moves while held' / 'one step per press' caption
              — inferable from Step/Continuous button selection.
            * The 'wire N.NN — jog ceiling N% (operator order)'
              hint line — kept as a `title` (tooltip) on the slider
              for cheap discoverability; not rendered. */}
      {(() => {
        const speedClamped = Math.min(speed, JOG_SLIDER_MAX_PCT)
        const effClampedPct = Math.min(effectivePct, JOG_SLIDER_MAX_PCT)
        const wireFrac = Math.min(speedClamped, effClampedPct) / 100
        const wireHintTitle = `wire ${wireFrac.toFixed(2)} — jog ceiling ${effClampedPct}% (operator order)`
                            + (speedClamped >= 50 ? ` — controller wall: ${_ctrlWall}` : '')
        // 2026-09-16 LEFT column layout #2 — equal-width chip
        // vocabulary. All 4 button groups (XYZ/Joint/Step/Continuous)
        // and the step-size chip row use `width:100%` so they align
        // on the left edge and share identical widths. Step and
        // Continuous stack vertically like XYZ/Joint (were side-by-
        // side, breaking the equal-width contract).
        const chipBtnStyle = (on, disabled = false) => ({
          ...modeBtnStyle(on, disabled),
          width: '100%',
        })
        const leftEl = (
      <div style={{
        display: 'flex', flexDirection: 'column',
        width: leftColW,
        // 2026-09-16 side-column FILL — inside the page-level slot
        // (immersive) we want the column to occupy the slot's full
        // height so top/middle/bottom pinning is meaningful. In the
        // Program-tab inline layout, alignSelf:stretch inherits the
        // parent flex-row height.
        flex: immersive ? 1 : undefined,
        alignSelf: 'stretch',
        // 2026-09-16 layout #2 — single column, space-between so the
        // 4 upper groups (DISABLE+READY, XYZ+Joint, Step+Continuous,
        // step-size chips) get uniform even gaps computed from
        // available height, with Speed pinned at the bottom. The
        // outer wrapper hosts 5 children; space-between then puts
        // DISABLE at top, Speed at bottom, and distributes the mid-3
        // with equal residual gaps.
        justifyContent: 'space-between',
        boxSizing: 'border-box',
        paddingLeft: 4, paddingRight: 4, paddingTop: 4, paddingBottom: 4,
        // 2026-09-17 SINGLE-WINDOW — LEFT column outer stays
        // pointer-events:none so the residual GAPS between the 5
        // content groups (space-between) let orbit through to the
        // canvas. Each of the 5 content groups (TOP slot, XYZ/Joint,
        // Step/Continuous, step-size chips, Speed) opts back into
        // pointer-events:auto inline below.
        pointerEvents: immersive ? 'none' : undefined,
      }}>
        {/* 2026-09-17 pointer-events walk — each of the 5 group
            wrappers below opts back INTO pointer-events:auto (the
            column outer + parent overlay are none) so canvas orbit
            still receives events in the GAPS between groups
            (space-between residual space). The wrapper is content-
            sized to its buttons, so this only blocks input on the
            actual chip surfaces. */}
        {/* TOP — caller-provided DISABLE + READY row. Program-tab
            consumer passes null; slot then renders nothing and
            other groups take its share of the space. minHeight:44
            mirrors the RIGHT column Orient block for equal top-row
            heights. */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, pointerEvents: immersive ? 'auto' : undefined }}>
          {leftTopSlot}
        </div>
        {/* Frame: XYZ / Joint (equal-width, stacked). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: immersive ? 'auto' : undefined }}>
          <button
            onClick={() => cartesianEnabled && setJogMode('cartesian')}
            disabled={!cartesianEnabled}
            title={cartesianEnabled ? undefined : 'Cartesian jog pending validation'}
            style={chipBtnStyle(jogMode === 'cartesian', !cartesianEnabled)}
          >
            XYZ {cartesianEnabled ? '' : '(TBD)'}
          </button>
          <button onClick={() => setJogMode('joint')} style={chipBtnStyle(jogMode === 'joint')}>Joint</button>
        </div>
        {/* Press style: Step / Continuous (equal-width, stacked so
            they match XYZ/Joint widths). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: immersive ? 'auto' : undefined }}>
          <button
            onClick={() => setJogStyle('STEP')}
            style={{ ...chipBtnStyle(jogStyle === 'STEP'), minHeight: Math.max(36, modeMinH - 8), fontSize: modeFont - 1 }}>
            Step
          </button>
          <button
            onClick={() => setJogStyle('CONTINUOUS')}
            style={{ ...chipBtnStyle(jogStyle === 'CONTINUOUS'), minHeight: Math.max(36, modeMinH - 8), fontSize: modeFont - 1 }}>
            Continuous
          </button>
        </div>
        {/* Step Size — 5-column grid so all chips have identical
            width and align in ONE row (no ragged 3+2 wrap). Caption
            "· speed controls motion" retired per 2026-09-16 order:
            the chips grey out in Continuous mode, communicating the
            same fact without extra text. */}
        <div style={{ opacity: jogStyle === 'STEP' ? 1 : 0.4, pointerEvents: immersive ? 'auto' : undefined }}>
          <div style={{ fontSize: sectionLabelFont, fontWeight: 700, color: '#111', marginBottom: 6, textShadow: LABEL_TEXT_SHADOW }}>
            Step Size
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s}
                onClick={() => { if (jogStyle === 'STEP') setStep(s) }}
                disabled={jogStyle !== 'STEP'}
                style={{
                  padding: '8px 0',
                  fontSize: stepBtnFont, fontWeight: 600, borderRadius: 4,
                  cursor: jogStyle === 'STEP' ? 'pointer' : 'not-allowed',
                  minHeight: stepBtnH,
                  background: step === s ? '#2563EB' : '#f3f4f6',
                  color:      step === s ? '#fff'    : '#6b7280',
                  border:     step === s ? 'none'    : '1px solid #e5e7eb',
                  minWidth: 0,
                }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
            ))}
          </div>
        </div>
        {/* BOTTOM — Speed slider pinned to bottom edge (last child
            in the space-between distribution). Speed:N% label stays;
            wire-hint line retired to slider `title` tooltip per
            2026-09-16 operator order. */}
        <div style={{ flexShrink: 0, pointerEvents: immersive ? 'auto' : undefined }} data-testid="jog-speed-group">
          <div style={{ fontSize: speedFont, fontWeight: 700, color: '#111', marginBottom: 6, textShadow: LABEL_TEXT_SHADOW }}>
            Speed: {speedClamped}%
          </div>
          <input type="range" min={1} max={JOG_SLIDER_MAX_PCT} value={speedClamped}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            data-testid="jog-speed-slider"
            title={wireHintTitle}
            style={{
              width: '100%', height: maximized ? 10 : 6,
              // 2026-09-16 zoom-capture — parent immersive root sets
              // touch-action:none to block browser pinch/double-tap-
              // zoom. Native range inputs need pan-x to keep touch-
              // drag on the thumb, so opt back in for THIS element.
              touchAction: 'pan-x',
            }} />
        </div>
      </div>
        )
        return immersive
          ? (leftSlotEl ? createPortal(leftEl, leftSlotEl) : null)
          : leftEl
      })()}

      {/* CENTER — jog arrow pads. 2026-09-16 testid added so
          View3DLayout's framing measurement targets THIS element
          (not the whole surface wrapper). The LEFT/RIGHT side
          columns spread up the edges under the new immersive
          side-column layout; measuring the wrapper would shrink
          the arm region unnecessarily. The center-pads box tells
          the framing exactly where the arm bottom must clear to. */}
      {/* 2026-09-16 PAD ANCHORING — operator screenshot #2: the pad
          clusters were floating mid-page; anchor them toward the
          BASE of the viewport so the arm region gains vertical
          room. alignItems:'flex-end' bottom-aligns the scaler
          cluster inside the full-height CENTER container; padding-
          bottom keeps a comfortable margin above the Collapse row.
          Framing (View3DLayout) targets the scaler element directly
          so surfaceTop reflects the ACTUAL pad-top position (lower
          now → larger arm region above), not the empty container
          top.

          2026-09-17 collapse-scope UPDATE: when hidePads=true the
          CENTER container renders null so MINIMIZED collapses ONLY
          the pad cluster. LEFT + RIGHT portals stay populated —
          the operator can still Enable / mode-switch / expand from
          the collapsed state. */}
      {!hidePads && (
      <div
        data-testid="jog-center-pads"
        style={{
          // 2026-09-17 SINGLE-WINDOW — in immersive mode this
          // container sizes to its content (no flex:1, no
          // alignSelf:stretch) so the pad cluster is a compact
          // floating overlay, not a full-width band. Program-tab
          // consumer keeps the legacy fill layout.
          flex: immersive ? 'none' : 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: immersive ? 'center' : 'flex-end',
          minWidth: 0,
          alignSelf: immersive ? 'auto' : 'stretch',
          paddingBottom: immersive ? 0 : (expanded ? 40 : 20),
          pointerEvents: immersive ? 'none' : undefined,
        }}>
        {/* 2026-09-16 EXPAND MODE — when `expanded` is true the pad
            CLUSTER scales up (1.6×) via CSS transform so the SAME
            arrangement (Position pad + Height + Rotation, joint tiles)
            just renders larger. transformOrigin:'bottom' keeps the
            growth anchored at the base — the cluster grows UP from
            its bottom edge without needing to move down first. */}
        <div
          data-testid="jog-center-cluster-scaler"
          style={{
            // 2026-09-17 UNIFIED FIT: fitScale is now the ONE
            // authoritative scale, computed by View3DLayout as
            //   max(MIN_FIT_SCALE, min(cap, sLeft, sRight, sHeight))
            // where cap = 1 (normal) or EXPAND_MAX 1.6 (expand).
            // No more composition with expand — the caller has
            // already folded the mode cap into the measurement,
            // guaranteeing the visual cluster fits at BOTH modes.
            // Passthrough (transform:none) when fitScale is
            // exactly 1 (Program-tab consumer with fitScale=1
            // default, and desktop normal at natural size).
            transform: fitScale === 1
              ? 'none'
              : `scale(${fitScale.toFixed(4)})`,
            transformOrigin: 'center bottom',
            transition: 'transform 120ms ease-out',
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            // 2026-09-17 SINGLE-WINDOW — the scaler is content-sized
            // and hosts only the actual pad buttons; re-enable
            // pointer-events here (overlay + parents are none) so
            // taps land on the pads while surrounding empty regions
            // pass through to the canvas.
            pointerEvents: immersive ? 'auto' : undefined,
          }}>
        {jogMode === 'cartesian' ? (
          <div style={{ display: 'flex', gap: padGroup, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <div>
              {padLabel('Position')}
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                gridTemplateAreas: '". up ." "left center right" ". down ."',
                gap: padInner,
              }}>
                <div style={{ gridArea: 'up' }}>
                  <ArrowPad {...wire('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'left' }}>
                  <ArrowPad {...wire('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'center' }}>
                  <PadCenter label="XY" width={padBtn} height={padBtn} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'right' }}>
                  <ArrowPad {...wire('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'down' }}>
                  <ArrowPad {...wire('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
              </div>
            </div>

            <div>
              {padLabel('Height')}
              <div style={{ display: 'flex', flexDirection: 'column', gap: padInner, width: zBtnWidth }}>
                <ArrowPad {...wire('z',  1)} rotation={0}   label="Z+" color="#3B82F6" size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
                <ArrowPad {...wire('z', -1)} rotation={180} label="Z−" color="#3B82F6" size={zBtnWidth} svgSize={svgPx} labelSize={lblPx} />
              </div>
            </div>

            <div>
              {padLabel('Rotation')}
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
                gap: padInner,
              }}>
                <div style={{ gridArea: 'rxp' }}>
                  <ArrowPad {...wire('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'rzn' }}>
                  <ArrowPad {...wire('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'center' }}>
                  <PadCenter label="Rot" width={padBtn} height={padBtn} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'rzp' }}>
                  <ArrowPad {...wire('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
                <div style={{ gridArea: 'rxn' }}>
                  <ArrowPad {...wire('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} svgSize={svgPx} labelSize={lblPx} />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: jointColGap, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' }}>
            {[1, 2, 3, 4, 5, 6].map((j) => {
              // Live angle: reuse the same /joint_states-derived slice
              // JogControls already reads for the alarm banner (line 378);
              // no new subscription. Radians → degrees, one decimal.
              const posRad = joints?.positions?.[j - 1]
              const angleDeg = Number.isFinite(posRad) ? (posRad * 180 / Math.PI) : null
              // Limits: the driver publishes per-joint {limit_deg, headroom_deg}
              // via /estun/status → robot.joint_limits. Single source of
              // truth (URDF/config-loaded, ±200 / ±166 family). If the
              // driver hasn't broadcast yet (cold boot), hide the line
              // rather than hardcode — hardcoding is a bug per §134.
              const jl = (robot.joint_limits || []).find((x) => x?.joint === j)
              const limitDeg  = Number.isFinite(jl?.limit_deg)     ? jl.limit_deg     : null
              const headroom  = Number.isFinite(jl?.headroom_deg)  ? jl.headroom_deg  : null
              // Proximity tint from headroom (driver-computed as
              // limit_deg − |current_deg|). Palette matches existing
              // caution/alarm tokens used elsewhere in this file.
              let angleColor = '#111827'
              if (headroom != null) {
                if (headroom <= 3)       angleColor = '#DC2626'   // alarm / near-limit red
                else if (headroom <= 10) angleColor = '#d97706'   // caution amber
              }
              return (
                <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: padInner }}>
                  <div style={{ fontSize: jointLblFont, fontWeight: 700, color: '#374151', marginBottom: 2 }}>
                    {'J' + j}
                  </div>
                  <div style={{
                    fontSize: jointLblFont + 2, fontWeight: 700, color: angleColor,
                    fontVariantNumeric: 'tabular-nums',
                    minHeight: jointLblFont + 4,
                    marginBottom: jointLblMb,
                  }}>
                    {angleDeg != null ? `${angleDeg.toFixed(1)}°` : '—'}
                  </div>
                  <ArrowPad {...wire(j,  1)} rotation={0}   label="+" color="#16A34A" size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
                  <ArrowPad {...wire(j, -1)} rotation={180} label="−" color="#DC2626" size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
                  {limitDeg != null && (
                    <div style={{
                      fontSize: Math.max(10, jointLblFont - 2),
                      color: '#9ca3af', fontVariantNumeric: 'tabular-nums',
                      marginTop: 2, whiteSpace: 'nowrap',
                    }}>
                      {`−${limitDeg.toFixed(0)}° … +${limitDeg.toFixed(0)}°`}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        </div>
      </div>
      )}

      {/* RIGHT — auxiliary control slot. 2026-09-08 retired the
          program-execution column; 2026-09-14 reintroduced this
          slot as a general-purpose right column for the 3D View's
          "Orient Flange Down" control (see rightSlot prop). Empty
          on the Program tab (where JogControls is also mounted).
          padGroup gap keeps it visually separated from the
          Rotation cluster.

          IMMERSIVE portal (2026-09-16): mirrors the LEFT-column
          treatment. When `immersive=true`, this JSX is portaled to
          the page-level `#jog-right-column-slot` div owned by
          View3DLayout, so the column sits OUTSIDE the jog surface
          container. The Program tab (which passes neither immersive
          nor rightSlot) renders nothing here. */}
      {(rightSlot || collapseSlot) && (() => {
        const rightEl = (
        <div
          data-testid="jog-right-slot"
          style={{
            display: 'flex', flexDirection: 'column',
            alignSelf: 'stretch',
            // 2026-09-16 side-column: Orient Flange Down + Collapse
            // spread vertically along the right edge. space-between
            // pushes Orient to the top and Collapse to the bottom so
            // both are easy to reach without hunting.
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            flexShrink: 0,
            paddingLeft: 4,
            minHeight: 0,
            width: '100%',
            // 2026-09-17 SINGLE-WINDOW — RIGHT column outer stays
            // pointer-events:none so the middle GAP between Orient
            // (top) and Collapse (bottom) lets orbit through.
            pointerEvents: immersive ? 'none' : undefined,
          }}>
          <div style={{ flexShrink: 0, pointerEvents: immersive ? 'auto' : undefined }}>{rightSlot}</div>
          {collapseSlot && (
            <div
              data-testid="jog-collapse-slot"
              style={{
                flexShrink: 0,
                display: 'flex', gap: 6,
                marginTop: 'auto',   // belt-and-braces: pins to bottom
                pointerEvents: immersive ? 'auto' : undefined,
              }}>
              {collapseSlot}
            </div>
          )}
        </div>
        )
        return immersive
          ? (rightSlotEl ? createPortal(rightEl, rightSlotEl) : null)
          : rightEl
      })()}
    </div>

    </div>
  )
}

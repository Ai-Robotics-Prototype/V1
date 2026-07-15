import { useState, useRef, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'

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
// A release message is sent on: onMouseUp, onMouseLeave, onTouchEnd,
// onTouchCancel, and component unmount (useEffect cleanup). If the
// browser or tab dies before release, the driver's 300 ms freshness
// deadman fires, and if that also fails the controller's heartbeat
// starvation is the final backstop.
//
// Cartesian mode: the UI stays visible so the operator sees the full
// pendant surface, but every XYZ/RXYZ button is disabled behind a
// "pending validation" tooltip while allow_cartesian_jog is false on
// the driver. Joint mode is the only mode that commands motion today.

// -----------------------------------------------------------------------------
// HoldButton — mode is EXPLICIT via `jogStyle`. No timing heuristic.
//
//   • jogStyle='STEP'       → onTap fires once on press. No interval.
//                              Release is a no-op (nothing running).
//                              Press-and-hold does NOT repeat.
//
//   • jogStyle='CONTINUOUS' → onPressStart fires on press, onPressTick
//                              fires every 150 ms while held, onPressEnd
//                              fires on release. Release handlers:
//                              onMouseUp, onMouseLeave (pointer-leave),
//                              onTouchEnd, onTouchCancel, and useEffect
//                              cleanup on unmount. NO latching — every
//                              path that ends the press calls stop(),
//                              and stop() always cancels the interval
//                              and fires onPressEnd exactly once.
// -----------------------------------------------------------------------------

function HoldButton({
  jogStyle,
  onTap, onPressStart, onPressTick, onPressEnd,
  color, width, height, disabled, tooltip, children,
}) {
  const tickTimer      = useRef(null)
  const pressed        = useRef(false)
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
  // Coalesce guard: if the previous refresh POST is still in flight,
  // skip this tick. Caps the pending queue at 1 regardless of network
  // conditions, so a slow HTTPS pool can't build a backlog.
  // A stuck fetch could otherwise starve the refresh stream forever
  // (driver's 300 ms deadman would fire mid-hold). Self-heal: if the
  // in-flight fetch is older than 400 ms, abort it and issue a fresh
  // request on the same tick.
  const refreshInFlight = useRef(false)
  const refreshStartMs  = useRef(0)
  const HUNG_FETCH_ABORT_MS = 400

  const nextSeq = () => { seqRef.current += 1; return seqRef.current }
  const newHoldId = () => Math.random().toString(36).slice(2, 12)

  const doRefresh = useCallback(async () => {
    if (!pressed.current || !holdIdRef.current) return
    if (refreshInFlight.current) {
      // Coalesce (do not stack) — unless the current fetch is hung.
      const age = Date.now() - refreshStartMs.current
      if (age < HUNG_FETCH_ABORT_MS) return
      // Self-heal: abort the stuck one and fall through to fire fresh.
      if (inFlightAbort.current) {
        try { inFlightAbort.current.abort() } catch { /* nop */ }
      }
      refreshInFlight.current = false
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
    } catch { /* aborted or network failure — driver's deadman handles it */ }
    finally {
      refreshInFlight.current = false
      if (inFlightAbort.current === ctrl) inFlightAbort.current = null
    }
  }, [onPressTick])

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
      if (tickTimer.current) clearInterval(tickTimer.current)
      tickTimer.current = setInterval(() => { doRefresh() }, 150)
      // Fallback release for mouse: if the operator drags off the button
      // and releases in dead space, neither onMouseUp nor onMouseLeave
      // (in buttons==0 mode) fires on the button element. This global
      // listener catches that case. Removed in stop().
      const handler = () => stopRef.current?.()
      globalUpHandlerRef.current = handler
      window.addEventListener('mouseup', handler)
      window.addEventListener('pointerup', handler)
    } else {
      // STEP: one increment per press, no interval, no hold repeat.
      onTap?.()
    }
  }, [disabled, jogStyle, onTap, onPressStart, doRefresh])

  const stop = useCallback(() => {
    if (!pressed.current) return
    pressed.current = false
    if (tickTimer.current) {
      clearInterval(tickTimer.current)
      tickTimer.current = null
    }
    // Detach the global mouse/pointer-up fallback if we set one up.
    if (globalUpHandlerRef.current) {
      window.removeEventListener('mouseup', globalUpHandlerRef.current)
      window.removeEventListener('pointerup', globalUpHandlerRef.current)
      globalUpHandlerRef.current = null
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
      // Fire-and-forget — we don't await so a slow release POST doesn't
      // block subsequent UI actions. The driver still processes the
      // hold:false frame immediately on receipt.
      onPressEnd?.(meta)
      holdIdRef.current = null
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

  return (
    <button
      disabled={disabled}
      title={disabled ? (tooltip || 'disabled') : undefined}
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#fff'
        e.currentTarget.style.borderColor = '#d1d5db'
        // Only end the hold if the mouse button is genuinely up. During a
        // mouse-drag off the button the browser fires mouseleave but the
        // press is still active — old behavior treated that as a release,
        // cutting motion short on any twitch. Global mouseup handles the
        // "released while off the button" case (attached below in start).
        if (!pressed.current) return
        if (e.buttons === 0) stop()
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.background = color + '15'
        e.currentTarget.style.borderColor = color
      }}
      onTouchStart={start}
      onTouchEnd={stop}
      onTouchCancel={stop}
      style={{
        width, height, padding: 0,
        background: '#fff',
        border: '1px solid #d1d5db', borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4,
        transition: 'background 100ms, border-color 100ms',
        userSelect: 'none', touchAction: 'none',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}

function ArrowPad({ jogStyle, onTap, onPressStart, onPressTick, onPressEnd,
                    rotation, label, color, size, svgSize, labelSize,
                    disabled, tooltip }) {
  return (
    <HoldButton
      jogStyle={jogStyle}
      onTap={onTap}
      onPressStart={onPressStart}
      onPressTick={onPressTick}
      onPressEnd={onPressEnd}
      color={color}
      width={size} height={size}
      disabled={disabled}
      tooltip={tooltip}
    >
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24"
           style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: labelSize, fontWeight: 700, color: '#374151' }}>{label}</span>
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
export default function JogControls({ maximized = false, onTeach, runConfirm = false }) {
  const winW = (typeof window !== 'undefined') ? window.innerWidth : 1280
  const isTabletW = winW <= 1280
  const isNarrowW = winW <= 1500

  const jogHold        = useStore((s) => s.jogHold)
  const jogHoldCartesian = useStore((s) => s.jogHoldCartesian)
  const jogRelease     = useStore((s) => s.jogRelease)
  const jogIncrement       = useStore((s) => s.jogIncrement)
  const jogPulseCartesian  = useStore((s) => s.jogPulseCartesian)
  const sendPowerCommand   = useStore((s) => s.sendPowerCommand)
  const jogStyle          = useStore((s) => s.jogStyle) || 'STEP'
  const setJogStyle       = useStore((s) => s.setJogStyle)
  const program           = useStore((s) => s.program) || { steps: [] }
  const triggerEstop   = useStore((s) => s.triggerEstop)
  const homeRobot      = useStore((s) => s.homeRobot)
  const runProgram     = useStore((s) => s.runProgram)
  const pauseProgram   = useStore((s) => s.pauseProgram)
  const resumeProgram  = useStore((s) => s.resumeProgram)
  const cancelProgram  = useStore((s) => s.cancelProgram)
  const task           = useStore((s) => s.task)
  const safety         = useStore((s) => s.safety)
  const robot          = useStore((s) => s.robot) || {}

  // Default 'cartesian' matches the Program tab so operators see the
  // same layout (XYZ + Height + Rotation d-pads) on both tabs. If the
  // driver's allow_cartesian_jog gate is closed the XYZ pad renders
  // disabled and the operator can tap the Joint mode button to switch.
  const [jogMode, setJogMode] = useState('cartesian')
  const [step, setStep]       = useState(1.0)      // vestigial in continuous mode (kept for future inching / IncrementalJogPanel path)
  const [speed, setSpeed]     = useState(20)

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
  const { running, paused, state, program_step, program_total, program_name } = task

  // ── State banner ─────────────────────────────────────────────
  // Explicit reason surface — buttons only grey when banner is not
  // READY. No silent disables. `bannerAction` is a small affordance
  // rendered inline (Enable / Disable / Clear-Alarm) so the banner
  // itself is the control point for power transitions. Nothing here
  // auto-fires — every action goes through a confirm dialog below.
  let bannerLevel = 'ready'
  let bannerText  = 'READY'
  let bannerAction = null   // { kind, label, appearance }
  if (estop) {
    bannerLevel = 'error'
    bannerText  = 'E-STOP — release to jog'
  } else if (!robot.connected) {
    bannerLevel = 'error'
    bannerText  = 'DRIVER DISCONNECTED'
  } else if (robot.alarm) {
    // Alarm gates enable — the controller refuses switchOn while
    // errors are latched. Match the pendant's recovery order: Clear
    // Alarm first, then Enable becomes offered.
    bannerLevel = 'error'
    bannerText  = robot.alarm_count > 1
      ? `ALARM (${robot.alarm_count} active)`
      : 'ALARM'
    if (robot.allow_power) {
      bannerAction = { kind: 'clear_alarm', label: 'Clear Alarm', appearance: 'danger' }
    }
  } else if (robot.enabling) {
    // Transient state observed on the wire (state=1 "Enabling"). The
    // banner shows this until state transitions to 2/3 (enabled) or
    // back to 0 (failure to enable, which drops us to the disabled case).
    bannerLevel = 'warn'
    bannerText  = 'ENABLING…'
  } else if (!robot.enabled) {
    bannerLevel = 'warn'
    bannerText  = 'ROBOT DISABLED'
    if (robot.allow_power) {
      bannerAction = { kind: 'enable', label: 'Enable', appearance: 'primary' }
    } else {
      // Match the previous message for the closed-gate case so the
      // operator still knows the pendant fallback path.
      bannerText = 'ROBOT DISABLED — enable on pendant'
    }
  } else if (running) {
    const stateLabel = paused ? 'paused' : (state || 'running')
    bannerLevel = 'warn'
    bannerText  = `PROGRAM RUNNING (${stateLabel} ${program_step + 1}/${program_total}) — press STOP to jog`
  } else if (!robot.allow_jog) {
    bannerLevel = 'warn'
    bannerText  = 'JOG GATE CLOSED — set ESTUN_ALLOW_JOG=1 on the driver'
    // Enabled but jog closed — still offer Disable to safe the arm.
    if (robot.allow_power) {
      bannerAction = { kind: 'disable', label: 'Disable', appearance: 'subtle' }
    }
  } else {
    // READY. Subtle Disable button on the right so the operator can
    // safe the arm without hunting through menus. Present but not
    // inviting: neutral colour, small target.
    if (robot.allow_power) {
      bannerAction = { kind: 'disable', label: 'Disable', appearance: 'subtle' }
    }
  }
  const jogGateOk = bannerLevel === 'ready'

  // Sizing tiers (unchanged from the Program-tab original).
  const padBtn = maximized
    ? (isTabletW ? 84 : isNarrowW ? 108 : 140)
    : (isTabletW ? 72 : isNarrowW ? 84  : 96)
  const zBtnWidth  = padBtn
  const jointBtnW  = padBtn
  const jointBtnH  = padBtn
  const svgPx = maximized ? (isTabletW ? 38 : isNarrowW ? 48 : 60)
                          : (isTabletW ? 32 : isNarrowW ? 38 : 42)
  const lblPx = maximized ? (isTabletW ? 12 : isNarrowW ? 14 : 16)
                          : (isTabletW ? 11 : isNarrowW ? 12 : 13)
  const padInner = maximized ? (isTabletW ? 8  : isNarrowW ? 10 : 14)
                             : (isTabletW ? 6  : isNarrowW ? 8  : 10)
  const padGroup = maximized ? (isTabletW ? 16 : isNarrowW ? 24 : 40)
                             : (isTabletW ? 12 : isNarrowW ? 20 : 28)
  const jointColGap = maximized ? (isTabletW ? 12 : isNarrowW ? 18 : 24)
                                : (isTabletW ?  8 : isNarrowW ? 12 : 16)
  const jointLblFont = maximized ? (isTabletW ? 12 : isNarrowW ? 14 : 16)
                                 : (isTabletW ? 11 : isNarrowW ? 12 : 13)
  const jointLblMb = maximized ? (isTabletW ? 6 : isNarrowW ? 8 : 10)
                               : (isTabletW ? 4 : isNarrowW ? 5 : 6)
  const actionMinH = maximized ? (isTabletW ? 56 : isNarrowW ? 60 : 68)
                               : (isTabletW ? 44 : isNarrowW ? 48 : 52)
  const actionFont = maximized ? (isTabletW ? 14 : isNarrowW ? 16 : 17)
                               : (isTabletW ? 12 : isNarrowW ? 13 : 14)
  const actionMinW = maximized ? (isTabletW ? 84  : isNarrowW ? 92  : 100)
                               : (isTabletW ? 64  : isNarrowW ? 72  : 80)
  const actionGap = maximized ? (isTabletW ? 8  : isNarrowW ? 12 : 14)
                              : (isTabletW ? 6  : isNarrowW ?  8 : 10)
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
  const rightColW = maximized ? (isTabletW ? 132 : isNarrowW ? 156 : 180)
                              : (isTabletW ? 108 : isNarrowW ? 128 : 150)
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
  const runBtnBase = (bg, color, disabled, weight = 700) => ({
    width: '100%',
    minWidth: actionMinW,
    padding: maximized ? '16px' : '12px',
    minHeight: actionMinH,
    fontSize: actionFont, fontWeight: weight,
    background: bg, color,
    border: bg.startsWith('#f') ? '1px solid #d1d5db' : 'none',
    borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  })
  const padLabel = (text) => (
    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textAlign: 'center', marginBottom: 6 }}>{text}</div>
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

  const [confirmingRun, setConfirmingRun] = useState(false)
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
  const stepCount = Array.isArray(program?.steps) ? program.steps.length : 0
  const programLabel = program_name || 'program'

  const handleRun = paused ? resumeProgram : runProgram
  const runClick = () => {
    if (runConfirm) setConfirmingRun(true)
    else handleRun()
  }
  const confirmRun = () => {
    setConfirmingRun(false)
    handleRun()
  }

  const bannerBg = bannerLevel === 'ready' ? '#065F46'
                 : bannerLevel === 'warn'  ? '#B45309'
                 : /* error */              '#991B1B'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* State banner — always visible. Buttons grey only when non-READY. */}
      <div style={{
        background: bannerBg,
        color: '#fff',
        padding: '4px 10px',
        fontSize: 11, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: bannerLevel === 'ready' ? '#34D399'
                    : bannerLevel === 'warn'  ? '#FDE68A'
                    : '#FCA5A5',
        }} />
        <span style={{ flex: 1 }}>{bannerText}</span>
        {bannerAction && (
          <button
            onClick={() => openPowerConfirm(bannerAction.kind)}
            style={{
              // Three appearances so DISABLE looks unlike ENABLE.
              // primary — filled green (invites the transition)
              // danger  — filled red   (only used for Clear-Alarm)
              // subtle  — outline over the READY banner (present, not inviting)
              background:
                bannerAction.appearance === 'primary' ? '#059669'
                : bannerAction.appearance === 'danger'  ? '#B91C1C'
                :                                        'transparent',
              color:  bannerAction.appearance === 'subtle' ? '#fff' : '#fff',
              border: bannerAction.appearance === 'subtle'
                ? '1px solid rgba(255,255,255,0.55)'
                : '1px solid transparent',
              padding: bannerAction.appearance === 'subtle' ? '2px 8px' : '3px 10px',
              borderRadius: 6,
              fontSize: 10, fontWeight: 700,
              letterSpacing: '0.04em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {bannerAction.label}
          </button>
        )}
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

    <div style={{
      padding: containerPad, background: '#fff',
      width: '100%', flex: 1, minHeight: 0,
      overflowX: 'hidden', overflowY: 'auto',
      display: 'flex', flexDirection: 'row',
      // flex-start (not center) so any vertical overflow scrolls from
      // the top. With alignItems:center overflow clips symmetrically,
      // hiding the "Jog" title and top of the action column under the
      // panel band — that was the reported clipping.
      alignItems: 'flex-start', justifyContent: 'space-evenly',
      gap: rowGap,
      boxSizing: 'border-box',
    }}>
      {/* LEFT — mode, step, speed */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        width: leftColW, flexShrink: 0,
        alignSelf: 'stretch', justifyContent: 'center',
      }}>
        <div style={{ fontSize: maximized ? 16 : 14, fontWeight: 700, color: '#111' }}>Jog</div>

        {/* Frame: Joint vs Cartesian */}
        <button
          onClick={() => cartesianEnabled && setJogMode('cartesian')}
          disabled={!cartesianEnabled}
          title={cartesianEnabled ? undefined : 'Cartesian jog pending validation'}
          style={modeBtnStyle(jogMode === 'cartesian', !cartesianEnabled)}
        >
          XYZ {cartesianEnabled ? '' : '(TBD)'}
        </button>
        <button onClick={() => setJogMode('joint')} style={modeBtnStyle(jogMode === 'joint')}>Joint</button>

        {/* Press style: STEP vs CONTINUOUS. Applies to both frames. */}
        <div style={{ marginTop: 2, display: 'flex', gap: 4 }}>
          <button
            onClick={() => setJogStyle('STEP')}
            style={{
              ...modeBtnStyle(jogStyle === 'STEP'),
              minHeight: Math.max(36, modeMinH - 8),
              fontSize: modeFont - 1,
            }}>Step</button>
          <button
            onClick={() => setJogStyle('CONTINUOUS')}
            style={{
              ...modeBtnStyle(jogStyle === 'CONTINUOUS'),
              minHeight: Math.max(36, modeMinH - 8),
              fontSize: modeFont - 1,
            }}>Continuous</button>
        </div>
        <div style={{ fontSize: 10, color: '#6b7280', marginTop: -4 }}>
          {jogStyle === 'STEP' ? 'one step per press' : 'moves while held'}
        </div>

        {/* Step Size — only interactive in STEP mode; greyed in CONTINUOUS. */}
        <div style={{ marginTop: 4, opacity: jogStyle === 'STEP' ? 1 : 0.4 }}>
          <div style={{ fontSize: sectionLabelFont, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>
            Step Size {jogStyle === 'CONTINUOUS' && <span style={{ fontWeight: 400 }}>· speed controls motion</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s}
                onClick={() => { if (jogStyle === 'STEP') setStep(s) }}
                disabled={jogStyle !== 'STEP'}
                style={{
                  padding: maximized ? '12px 16px' : '8px 12px',
                  fontSize: stepBtnFont, fontWeight: 600, borderRadius: 4,
                  cursor: jogStyle === 'STEP' ? 'pointer' : 'not-allowed',
                  minHeight: stepBtnH,
                  background: step === s ? '#2563EB' : '#f3f4f6',
                  color:      step === s ? '#fff'    : '#6b7280',
                  border:     step === s ? 'none'    : '1px solid #e5e7eb',
                }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: speedFont, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Speed: {speed}%</div>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ width: '100%', height: maximized ? 10 : 6 }} />
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
            effective ≤ 15% (cap)
          </div>
        </div>

        <div style={{ flex: 1 }} />
      </div>

      {/* CENTER — jog arrow pads */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', minWidth: 0, alignSelf: 'stretch' }}>
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
            {[1, 2, 3, 4, 5, 6].map((j) => (
              <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: padInner }}>
                <div style={{ fontSize: jointLblFont, fontWeight: 700, color: '#374151', marginBottom: jointLblMb }}>
                  {'J' + j}
                </div>
                <ArrowPad {...wire(j,  1)} rotation={0}   label="+" color="#16A34A" size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
                <ArrowPad {...wire(j, -1)} rotation={180} label="−" color="#DC2626" size={jointBtnW} svgSize={svgPx} labelSize={lblPx + 2} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RIGHT — Run/Pause/Stop/Home + Teach */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: actionGap,
        width: rightColW, flexShrink: 0,
        alignSelf: 'stretch', justifyContent: 'center',
      }}>
        <button onClick={runClick}
          disabled={estop || (running && !paused)}
          style={runBtnBase('#16A34A', '#fff', estop || (running && !paused))}>
          {paused ? '▶ Resume' : (runConfirm ? '▶ Run…' : '▶ Run')}
        </button>
        <button onClick={pauseProgram}
          disabled={!running || paused || estop}
          style={runBtnBase('#fef3c7', '#92400e', !running || paused || estop, 600)}>
          ⏸ Pause
        </button>
        <button onClick={cancelProgram}
          disabled={!running && !paused}
          style={runBtnBase('#DC2626', '#fff', !running && !paused)}>
          STOP
        </button>
        <button onClick={homeRobot} disabled={estop}
          style={runBtnBase('#f3f4f6', '#374151', estop, 600)}>
          ⌂ Home
        </button>

        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', padding: '4px 0', borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb' }}>
          {state} · {program_step + 1}/{program_total}
        </div>

        <button onClick={triggerEstop}
          title="Emergency stop"
          style={{
            width: '100%',
            minWidth: actionMinW,
            padding: maximized ? '14px' : '10px',
            minHeight: actionMinH,
            fontSize: actionFont, fontWeight: 700,
            background: '#fff', color: '#DC2626',
            border: '2px solid #DC2626', borderRadius: 8, cursor: 'pointer',
          }}>
          E-STOP
        </button>
        <button
          onClick={onTeach}
          disabled={!onTeach}
          title={onTeach ? 'Save current pose as a teach point' : 'Teach not available in this view'}
          style={{
            width: '100%',
            minWidth: actionMinW,
            padding: maximized ? '16px' : '12px',
            minHeight: actionMinH,
            fontSize: actionFont, fontWeight: 700,
            background: onTeach ? '#2563EB' : '#e5e7eb',
            color: onTeach ? '#fff' : '#9ca3af',
            border: 'none', borderRadius: 8,
            cursor: onTeach ? 'pointer' : 'not-allowed',
          }}>
          Teach Position
        </button>
      </div>
    </div>

    {/* Run confirm modal — only used when runConfirm=true (3D View
        instance). Program tab bypasses this. */}
    {confirmingRun && (
      <div
        onClick={() => setConfirmingRun(false)}
        style={{
          position: 'absolute', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: '#fff', border: '1px solid #e5e7eb',
            borderRadius: 10, padding: 20, maxWidth: 420,
            boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
          }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 6 }}>
            Start the program?
          </div>
          <div style={{ fontSize: 13, color: '#374151', marginBottom: 14 }}>
            Run <b>“{programLabel}”</b> — {stepCount} step{stepCount === 1 ? '' : 's'}?
            The arm will begin moving on your next click.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setConfirmingRun(false)}
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 600,
                background: '#f3f4f6', color: '#374151',
                border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
              }}>Cancel</button>
            <button
              onClick={confirmRun}
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 700,
                background: '#16A34A', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer',
              }}>Run program</button>
          </div>
        </div>
      </div>
    )}
    </div>
  )
}

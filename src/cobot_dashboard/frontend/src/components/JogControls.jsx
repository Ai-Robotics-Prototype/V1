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
  // Coalesce guard: skip this tick if a previous refresh is still in
  // flight. WS transport (the fast path) sends synchronously and never
  // leaves this true; the guard only ever fires on HTTP fallback where
  // it keeps the pending queue capped at 1 so a slow HTTPS pool can't
  // stack a backlog. The old 400 ms abort-and-refire self-heal has been
  // removed — a slow-but-viable HTTP fetch is now allowed to complete,
  // and the driver's 300 ms freshness deadman is the safety backstop.
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
    // driver's 300 ms freshness deadman is the correct final backstop.
    if (refreshInFlight.current) return
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
    } catch { /* network failure — driver's deadman handles it */ }
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
      // 100 ms cadence: driver's 300 ms deadman gets 3× headroom, so a
      // single dropped/late frame no longer trips staleness. WS transport
      // makes this cheap — each refresh is one send() on an already-open
      // socket. HTTP fallback uses the same cadence; the coalesce guard
      // one layer above skips ticks while a previous fetch is in flight.
      tickTimer.current = setInterval(() => { doRefresh() }, 100)
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
  // Banner is the MINIMIZED form of AlarmRecoveryModal. When the modal
  // is minimized AND a condition still exists, the banner grows a
  // "Recovery guide" chip that flips minimized back to false to
  // reopen the modal. Single source of truth: same store slice as the
  // modal reads.
  const alarmModalMinimized = useStore((s) => s.alarmModalMinimized)
  const setAlarmModalMinimized = useStore((s) => s.setAlarmModalMinimized)
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

  // Recent driver-side jog stop reason. Rendered as a sub-line under
  // the banner for a few seconds after last_stop_ts so the operator
  // can see WHY motion stopped, not just that it did. Silent for
  // routine "release cmd" and "increment complete" — those are the
  // operator's own gestures ending normally.
  const nowSec = Date.now() / 1000
  const stopAgeS = robot.last_stop_ts ? (nowSec - robot.last_stop_ts) : Infinity
  const stopReasonRaw = robot.last_stop_reason || ''
  const routineStop = /^release cmd|^increment complete|^increment expiry|^node shutdown|^ws disconnect/i.test(stopReasonRaw)
  const showStopReason = stopReasonRaw && stopAgeS < 6 && !routineStop
  const stopReasonHuman = (() => {
    if (!showStopReason) return null
    // "hold staleness 0.31s"  → connection jitter
    if (/^hold staleness/i.test(stopReasonRaw)) {
      return 'Connection jitter — release and re-press to continue.'
    }
    // "limit approach J3 at +198.20° (+198.00°)" → limit approach
    let m = /limit approach J(\d) at ([+-]?[\d.]+)°/i.exec(stopReasonRaw)
    if (m) {
      return `J${m[1]} near ${m[2]}° limit — jog the other direction.`
    }
    // "cart limit approach J2 at +198.20° (|>198.00°|)" (cartesian)
    m = /cart limit approach J(\d) at ([+-]?[\d.]+)°/i.exec(stopReasonRaw)
    if (m) {
      return `J${m[1]} near limit — cartesian jog blocked; jog joints back first.`
    }
    // "clamp: J3 target +170.50° exceeds ±164.00° ..."
    m = /clamp: J(\d) target/i.exec(stopReasonRaw)
    if (m) {
      return `J${m[1]} would exceed its safety limit — pick a smaller step or the other direction.`
    }
    // "increment freshness fallback 0.35s" — backup stop, still connection-ish
    if (/freshness fallback/i.test(stopReasonRaw)) {
      return 'Connection jitter (backup stop) — release and re-press.'
    }
    if (/send failed|hb send failed|send returned False/i.test(stopReasonRaw)) {
      return 'Controller send failed — connection dropped or busy; retry the jog.'
    }
    return `Jog stopped: ${stopReasonRaw}`
  })()

  // ── State banner ─────────────────────────────────────────────
  // Explicit reason surface — buttons only grey when banner is not
  // READY. No silent disables. `bannerAction` is a small affordance
  // rendered inline (Enable / Disable / Clear-Alarm) so the banner
  // itself is the control point for power transitions. Nothing here
  // auto-fires — every action goes through a confirm dialog below.
  let bannerLevel = 'ready'
  let bannerText  = 'READY'
  // Array of {kind, label, appearance, disabled?, tooltip?}. Rendered
  // inline right-aligned in the banner in array order. Alarm state
  // gets two entries so the operator sees the intended sequence
  // (Clear Alarm → then Enable) — the second is disabled while the
  // alarm is active, so it can't be clicked out of order.
  let bannerActions = []
  if (estop) {
    bannerLevel = 'error'
    bannerText  = 'E-STOP — release to jog'
  } else if (!robot.connected) {
    bannerLevel = 'error'
    bannerText  = 'DRIVER DISCONNECTED'
  } else if (anyOutOfRange) {
    // Joint(s) past controller limit. The AlarmRecoveryModal is the
    // PRIMARY surface; this banner is the minimized form. When the
    // operator has minimized the modal, we grow a "Recovery guide"
    // chip so they can reopen it. Direction/progress live inside the
    // modal now — not duplicated here.
    bannerLevel = 'error'
    bannerText  = outOfRangeJoints.length > 1
      ? `JOINTS PAST LIMIT: ${outOfRangeJoints.map((j) => 'J' + j.joint).join(', ')}`
      : `J${outOfRangeJoints[0].joint} PAST LIMIT`
    bannerActions = alarmModalMinimized
      ? [{ kind: 'reopen_alarm_modal', label: '↗ Recovery guide', appearance: 'danger' }]
      : []
  } else if (robot.alarm) {
    // Alarm without out-of-range — same story: modal is primary,
    // banner is the minimized form. When minimized, offer the reopen
    // affordance. The Clear Alarm / Enable buttons live in the modal
    // now; keeping them in the banner would duplicate state and split
    // the operator's attention.
    bannerLevel = 'error'
    bannerText  = alarmCopy?.headline
      || (robot.alarm_count > 1 ? `ALARM (${robot.alarm_count} active)` : 'ALARM')
    bannerActions = alarmModalMinimized
      ? [{ kind: 'reopen_alarm_modal', label: '↗ Recovery guide', appearance: 'danger' }]
      : []
  } else if (robot.alarm_count === 0 && robot.joint_limits?.some &&
             robot.joint_limits.some((j) => j?.near_limit) && !robot.enabled) {
    // Transitional "back in range" state: the operator has jogged the
    // joint(s) back below limit but hasn't cleared the alarm yet, OR
    // the alarm has just cleared and we're still disabled. This is the
    // amber sweet spot that tells the operator "you're clear, now
    // Clear Alarm → Enable". Only fires when no joint is out_of_range
    // AND no active_alarm — safe to click both actions in sequence.
    // (We check near_limit as a soft indicator; not a gate.)
    bannerLevel = 'warn'
    bannerText  = 'BACK IN RANGE — CLEAR ALARM, THEN ENABLE'
    if (robot.allow_power) {
      bannerActions = [
        { kind: 'clear_alarm', label: 'Clear Alarm', appearance: 'danger' },
        { kind: 'enable', label: 'Enable', appearance: 'primary' },
      ]
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
      bannerActions = [{ kind: 'enable', label: 'Enable', appearance: 'primary' }]
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
      bannerActions = [{ kind: 'disable', label: 'Disable', appearance: 'subtle' }]
    }
  } else {
    // READY. Subtle Disable button on the right so the operator can
    // safe the arm without hunting through menus. Present but not
    // inviting: neutral colour, small target.
    if (robot.allow_power) {
      bannerActions = [{ kind: 'disable', label: 'Disable', appearance: 'subtle' }]
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
        {bannerActions.map((a) => (
          <button
            key={a.kind}
            onClick={() => {
              if (a.disabled) return
              // `reopen_alarm_modal` is the banner's escape hatch back
              // into the modal — different action from the power verbs.
              if (a.kind === 'reopen_alarm_modal') {
                setAlarmModalMinimized(false)
                return
              }
              openPowerConfirm(a.kind)
            }}
            disabled={!!a.disabled}
            title={a.tooltip || undefined}
            style={{
              // Three appearances so DISABLE looks unlike ENABLE.
              // primary — filled green (invites the transition)
              // danger  — filled red   (only used for Clear-Alarm)
              // subtle  — outline over the READY banner (present, not inviting)
              background:
                a.appearance === 'primary' ? '#059669'
                : a.appearance === 'danger'  ? '#B91C1C'
                :                              'transparent',
              color:  '#fff',
              border: a.appearance === 'subtle'
                ? '1px solid rgba(255,255,255,0.55)'
                : '1px solid transparent',
              padding: a.appearance === 'subtle' ? '2px 8px' : '3px 10px',
              borderRadius: 6,
              fontSize: 10, fontWeight: 700,
              letterSpacing: '0.04em',
              cursor: a.disabled ? 'not-allowed' : 'pointer',
              opacity: a.disabled ? 0.45 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* Recovery sub-line — shown UNDER the banner. Three sources, in
          priority order:
            1. Live joint-limit recovery guide (any joint out_of_range) —
               multi-line with direction + live-degrees readout,
               overrides any static alarm copy.
            2. Static alarm recovery copy (2002/2006/2023/9012/etc.).
            3. Transient mid-session jog-stop reason.
          Kept mixed-case (banner is uppercase) so this reads as prose. */}
      {(recoveryGuideText || alarmCopy?.recovery || stopReasonHuman) && (
        <div style={{
          background: recoveryGuideText ? '#7F1D1D'
                    : alarmCopy         ? '#7F1D1D'
                    :                     '#78350F',
          color: '#FFF7ED',
          padding: '6px 12px',
          fontSize: 12,
          lineHeight: 1.4,
          flexShrink: 0,
          whiteSpace: 'pre-wrap',   // preserve the line breaks in the guide
          fontVariantNumeric: 'tabular-nums',   // keep live degrees readable
        }}>
          {recoveryGuideText || alarmCopy?.recovery || stopReasonHuman}
        </div>
      )}

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
          <div style={{ fontSize: speedFont, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>
            Speed: {speed}%
            {speed > 15 && (
              <span style={{ color: '#d97706', fontWeight: 700, marginLeft: 6 }}>
                → 15% (capped)
              </span>
            )}
          </div>
          <input type="range" min={1} max={100} value={speed}
            onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            style={{ width: '100%', height: maximized ? 10 : 6 }} />
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
            {speed <= 15
              ? `wire ${(speed / 100).toFixed(2)} — mid-hold changes take effect on next press`
              : `wire 0.15 cap — driver clamps ≥15%`}
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

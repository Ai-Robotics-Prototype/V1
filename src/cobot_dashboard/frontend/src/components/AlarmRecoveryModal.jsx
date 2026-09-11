import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'

// Centered modal that walks the operator out of any active alarm or
// out-of-range condition. Single source of truth: reads the same
// `robot.joint_limits`, `robot.active_alarm`, `robot.enabled`, etc.
// that JogControls uses for its banner. The banner is the minimized
// form of THIS modal — one state, two renderings.
//
// TODO(alarm-jog): controller behavior on Robot/jog while alarmed is
// not wire-validated. Until we capture a session showing the frame
// accepted (or explicitly rejected), inward jog stays on the pendant.
// The `ALARM_JOG_VALIDATED` const below flips to true after that
// capture lands and the modal will grow live inward-only jog keys.
const ALARM_JOG_VALIDATED = false

// Modal auto-closes 2 s after a successful transition to enabled.
const AUTO_CLOSE_MS = 2000

// Target angle for recovery: bring the joint at least 10° INSIDE the
// controller limit so the operator has margin, not a hair-width margin.
const RECOVERY_TARGET_INSIDE_DEG = 10

export default function AlarmRecoveryModal() {
  const robot          = useStore((s) => s.robot) || {}
  const minimized      = useStore((s) => s.alarmModalMinimized)
  const setMinimized   = useStore((s) => s.setAlarmModalMinimized)
  const sendPowerCommand = useStore((s) => s.sendPowerCommand)

  const jointLimits    = Array.isArray(robot.joint_limits) ? robot.joint_limits : []
  const outOfRange     = jointLimits.filter((j) => j?.out_of_range)
  const anyOutOfRange  = outOfRange.length > 0
  const alarm          = robot.active_alarm || null
  const alarmCount     = robot.alarm_count || 0
  const hasCondition   = anyOutOfRange || alarmCount > 0 || !!alarm

  // Phase derivation — single source of truth for BOTH modal and banner
  // (banner reads the same store slice). Phases:
  //   'out_of_range'    at least one joint past limit
  //   'back_in_range'   joints all inside limits, alarm still active
  //   'cleared'         no alarm, arm still disabled → offer Enable
  //   'enabled_confirm' arm just enabled — show green then auto-close
  //   null              nothing to do
  //
  // sessionActive tracks whether we've entered a recovery flow this
  // session. It latches true when hasCondition first goes true and
  // stays true through all phases until either (a) auto-close after
  // enabled_confirm, or (b) the operator explicitly minimizes (banner
  // takes over). A fresh page load with a healthy disabled arm shows
  // no modal — sessionActive stays false because nothing latched it.
  const [sessionActive, setSessionActive] = useState(false)
  const [enableConfirmSince, setEnableConfirmSince] = useState(0)
  const prevEnabled = useRef(robot.enabled)
  const prevHasCondition = useRef(false)

  useEffect(() => {
    // Latch sessionActive on entry to any condition; also reset the
    // minimized flag so the modal reasserts itself for each new alarm.
    if (hasCondition && !prevHasCondition.current) {
      setSessionActive(true)
      setMinimized(false)
    }
    prevHasCondition.current = hasCondition
  }, [hasCondition, setMinimized])

  useEffect(() => {
    // Detect disabled → enabled during an active session. That kicks
    // off the 2-second READY confirmation, after which the session
    // fully closes.
    const wasEnabled = prevEnabled.current
    if (!wasEnabled && robot.enabled && sessionActive) {
      setEnableConfirmSince(Date.now())
    }
    prevEnabled.current = robot.enabled
  }, [robot.enabled, sessionActive])

  const inEnableConfirmWindow =
    enableConfirmSince > 0 && (Date.now() - enableConfirmSince) < AUTO_CLOSE_MS

  useEffect(() => {
    if (!inEnableConfirmWindow) return
    const t = setTimeout(() => {
      setEnableConfirmSince(0)
      setSessionActive(false)
    }, AUTO_CLOSE_MS + 60)
    return () => clearTimeout(t)
  }, [inEnableConfirmWindow])

  const phase =
      !sessionActive              ? null
    : anyOutOfRange               ? 'out_of_range'
    : (alarmCount > 0 || alarm)   ? 'back_in_range'
    : inEnableConfirmWindow       ? 'enabled_confirm'
    : !robot.enabled              ? 'cleared'
    :                               null

  // Nothing to show?
  if (phase === null) return null
  if (minimized) return null   // banner takes over

  // ── Render tokens ──────────────────────────────────────────────
  const bgByPhase = {
    out_of_range:    { chrome: '#7F1D1D', accent: '#FCA5A5', headline: '#FFF7ED' },
    back_in_range:   { chrome: '#78350F', accent: '#FDE68A', headline: '#FFFBEB' },
    cleared:         { chrome: '#065F46', accent: '#6EE7B7', headline: '#ECFDF5' },
    enabled_confirm: { chrome: '#065F46', accent: '#6EE7B7', headline: '#ECFDF5' },
  }[phase]

  // Actions available per phase. sendPowerCommand routes via WS-first
  // (see useStore._sendJogWS) with HTTP fallback; power gestures are
  // gated by the driver's allow_power flag either way.
  const canClearAlarm = phase === 'back_in_range' && robot.allow_power
  const canEnable     = phase === 'cleared'       && robot.allow_power

  const headline =
      phase === 'out_of_range'    ? outOfRangeHeadline(outOfRange)
    : phase === 'back_in_range'   ? backInRangeHeadline(alarm)
    : phase === 'cleared'         ? 'Alarm cleared — enable the arm'
    :                               'Ready'   // enabled_confirm

  return (
    <div
      // Full-screen dim; no click-through close (operator must minimize
      // or heal the condition).
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(15, 23, 42, 0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#fff', color: '#111827',
          borderRadius: 12, width: '100%', maxWidth: 640,
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header bar — phase-colored so the operator sees phase at a glance */}
        <div style={{
          background: bgByPhase.chrome, color: bgByPhase.headline,
          padding: '12px 16px 10px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 12, height: 12, borderRadius: '50%',
            background: bgByPhase.accent,
            flexShrink: 0,
          }} />
          <div style={{ flex: 1, fontSize: 16, fontWeight: 700, letterSpacing: '0.02em' }}>
            {headline}
          </div>
          <button
            onClick={() => setMinimized(true)}
            title="Minimize to banner"
            style={{
              background: 'rgba(255,255,255,0.15)',
              color: bgByPhase.headline,
              border: '1px solid rgba(255,255,255,0.35)',
              borderRadius: 6,
              padding: '3px 10px',
              fontSize: 11, fontWeight: 700, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            ↓ Minimize
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 20px 20px 20px',
                      display: 'flex', flexDirection: 'column', gap: 16 }}>
          {phase === 'out_of_range' && (
            <OutOfRangeBody
              outOfRange={outOfRange}
              alarmJogValidated={ALARM_JOG_VALIDATED}
            />
          )}
          {phase === 'back_in_range' && (
            <BackInRangeBody alarm={alarm} />
          )}
          {phase === 'cleared' && (
            <ClearedBody />
          )}
          {phase === 'enabled_confirm' && (
            <EnabledBody />
          )}

          {/* Action row — only visible in phases where an action is available. */}
          {(canClearAlarm || canEnable) && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end',
                          marginTop: 4 }}>
              {canClearAlarm && (
                <button
                  onClick={() => sendPowerCommand('clear_alarm')}
                  style={buttonStyle('#B91C1C', true)}
                >
                  Clear Alarm
                </button>
              )}
              {canEnable && (
                <button
                  onClick={() => sendPowerCommand('enable')}
                  style={buttonStyle('#059669', true)}
                >
                  Enable
                </button>
              )}
            </div>
          )}
          {/* Disabled action shadows for the OoR and confirm phases — so
              the operator sees the sequence they'll follow. */}
          {phase === 'out_of_range' && robot.allow_power && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end',
                          marginTop: 4 }}>
              <button style={buttonStyle('#B91C1C', false, 'Blocked while joint is out of range')}>
                Clear Alarm
              </button>
              <button style={buttonStyle('#059669', false, 'Clear alarm first')}>
                Enable
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Phase body components ────────────────────────────────────────────

function OutOfRangeBody({ outOfRange, alarmJogValidated }) {
  return (
    <>
      <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
        {outOfRange.length > 1
          ? `${outOfRange.length} joints are past their controller limits. Each must be jogged back before the alarm can clear:`
          : `The controller latched an alarm because a joint moved past its safe range. It will stay latched — Clear Alarm is refused — until the joint is back inside its limit.`}
      </div>
      {outOfRange.map((j) => (
        <JointRecoveryRow key={j.joint} j={j} alarmJogValidated={alarmJogValidated} />
      ))}
      <div style={{ fontSize: 12, color: '#6B7280', fontStyle: 'italic', lineHeight: 1.5 }}>
        Our jog is unavailable while the arm is alarmed — the controller rejects external motion commands
        in this state. This recovery step uses the factory pendant / controller UI by design.
      </div>
    </>
  )
}

function JointRecoveryRow({ j, alarmJogValidated }) {
  // Direction to jog inward: if current is positive, we need to go
  // NEGATIVE; if negative, POSITIVE. Symbol shown on the disabled key
  // matches the pendant's convention (+ / −).
  const inwardIsPositive = j.current_deg < 0
  const symbol   = inwardIsPositive ? '+' : '−'
  const outward  = inwardIsPositive ? '−' : '+'
  const target   = (j.limit_deg - RECOVERY_TARGET_INSIDE_DEG).toFixed(0)
  const targetLive = j.current_deg > 0
    ? `below +${target}°`
    : `above −${target}°`
  // Progress: from worst excursion (arbitrary anchor at the current
  // out-of-range value) toward 0 headroom. Once headroom crosses 0
  // and reaches +RECOVERY_TARGET_INSIDE_DEG the phase transitions.
  const worstAbs = Math.abs(j.current_deg)
  const targetAbs = j.limit_deg - RECOVERY_TARGET_INSIDE_DEG
  const startAbs  = Math.max(worstAbs, j.limit_deg + 4)   // anchor a bit past current
  // pct = fraction of recovery still remaining
  const remainAbs = Math.max(0, worstAbs - targetAbs)
  const totalAbs  = Math.max(1, startAbs - targetAbs)
  const progressPct = Math.max(0, Math.min(100,
    100 * (1 - remainAbs / totalAbs)))

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: 12, background: '#FEF2F2', borderRadius: 8,
      border: '1px solid #FCA5A5',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#7F1D1D' }}>
          J{j.joint}
        </div>
        <div style={{ fontSize: 28, fontWeight: 700, color: '#111827',
                      fontVariantNumeric: 'tabular-nums' }}>
          {j.current_deg >= 0 ? '+' : ''}{j.current_deg.toFixed(1)}°
        </div>
        <div style={{ fontSize: 12, color: '#6B7280', marginLeft: 'auto' }}>
          limit ±{j.limit_deg.toFixed(0)}° · past by {Math.abs(j.headroom_deg).toFixed(1)}°
        </div>
      </div>

      <div style={{ fontSize: 13, color: '#374151' }}>
        On the pendant / factory UI, jog <b>J{j.joint} {symbol}</b> until{' '}
        <b>{targetLive}</b>.
      </div>

      {/* Live progress bar. Fills as the joint moves inward. */}
      <div style={{
        height: 8, background: '#FECACA', borderRadius: 4, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${progressPct.toFixed(1)}%`,
          background: '#DC2626',
          transition: 'width 200ms',
        }} />
      </div>

      {/* Pendant key hint — a large visual pair with the outward key
          crossed out. Even when we CAN'T jog from here, the operator
          instantly maps our advice to the physical pendant key. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase',
                      letterSpacing: '0.08em' }}>
          Pendant key:
        </div>
        <div style={{
          minWidth: 60, textAlign: 'center', padding: '10px 14px',
          background: '#B91C1C', color: '#fff',
          borderRadius: 8, fontSize: 22, fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
        }}>
          J{j.joint} {symbol}
        </div>
        <div style={{
          minWidth: 60, textAlign: 'center', padding: '10px 14px',
          background: '#F3F4F6', color: '#9CA3AF',
          borderRadius: 8, fontSize: 22, fontWeight: 800,
          textDecoration: 'line-through',
          border: '1px dashed #D1D5DB',
        }}>
          J{j.joint} {outward}
        </div>
        <div style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.4 }}>
          Only the inward direction moves you<br />out of the lockout.
        </div>
      </div>

      {alarmJogValidated && (
        // Reserved for the future WS-jog-in-alarm path. Currently the
        // ALARM_JOG_VALIDATED flag is false — this block never renders
        // until we've wire-captured the controller accepting inward
        // Robot/jog in alarm state. When flipped, only the inward
        // key becomes an actual hold-to-jog; outward stays a diagram.
        <div style={{ fontSize: 12, color: '#6B7280', fontStyle: 'italic' }}>
          (alarm-state jog available — live inward-only keys would render here)
        </div>
      )}
    </div>
  )
}

function BackInRangeBody({ alarm }) {
  // Two subcases: (a) a joint-limit alarm (code 2002) has been resolved
  // by the operator jogging back into range but the controller hasn't
  // dropped the latch yet, (b) any other alarm — 2015 speed/acceleration,
  // 2000 servo, 2006 e-stop, 2023 singular, 9012 power — where there
  // was no "joint out of range" phase at all. Using the joint-back copy
  // for (b) would be a lie ("the joint is back inside its limit" reads
  // as a joint-recovery claim when there was no joint recovery).
  const isJointLimit = alarm && alarm.code === 2002
  const detail = alarm
    ? `Controller reports code ${alarm.code}: ${alarm.text}`
    : 'Alarm still latched on the controller.'
  return (
    <>
      <div style={{ fontSize: 15, color: '#78350F', fontWeight: 600 }}>
        {isJointLimit
          ? 'The joint is back inside its limit. The controller still holds the alarm — clear it below to proceed.'
          : 'Controller alarm — clear to proceed.'}
      </div>
      <div style={{ fontSize: 12, color: '#6B7280' }}>{detail}</div>
    </>
  )
}

function ClearedBody() {
  return (
    <div style={{ fontSize: 14, color: '#065F46', lineHeight: 1.5 }}>
      Alarms are clear. Enable the arm to resume jogging and program execution.
    </div>
  )
}

function EnabledBody() {
  return (
    <div style={{ fontSize: 15, color: '#065F46', fontWeight: 600 }}>
      READY — arm is enabled. Closing this window…
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function outOfRangeHeadline(outOfRange) {
  if (outOfRange.length === 1) {
    const j = outOfRange[0]
    return `J${j.joint} past its limit`
  }
  return `${outOfRange.length} joints past their limits: `
    + outOfRange.map((j) => 'J' + j.joint).join(', ')
}
function backInRangeHeadline(alarm) {
  if (alarm && alarm.code === 2002) return 'Joint back in range — clear the alarm'
  if (alarm) return `Alarm ${alarm.code}: ${alarm.text || 'active'}`
  return 'Alarm active — clear to proceed'
}

function buttonStyle(bg, enabled, tooltip) {
  return {
    padding: '9px 18px',
    borderRadius: 6,
    background: bg,
    color: '#fff',
    border: 'none',
    fontWeight: 700, fontSize: 13,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.45,
    letterSpacing: '0.02em',
  }
}

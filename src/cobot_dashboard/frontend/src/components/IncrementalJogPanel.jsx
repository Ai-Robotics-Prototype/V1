import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore'

// IncrementalJogPanel — the REAL ARM jog UI.
//
// Unlike JointJogPanel (twin-only sliders that write to jogApi.setJointRad),
// this panel POSTs to /cmd/jog with {joint: 1-6, delta_deg: ±1|±5}. That
// message flows to the Estun driver, which turns it into a time-boxed
// Robot/jog + heartbeat + Robot/stopJog sequence — the driver owns the
// stop timing so a browser crash mid-move cannot leave the arm running.
//
// Every button is disabled unless: /estun/status says the driver is
// connected + arm enabled, no jog is already in flight (`robot.jog_active`),
// and estop isn't asserted.
//
// The panel is a plain React function component — no useEffect subscribes
// to anything the store doesn't already surface, so it obeys the hook
// rules and reruns only on relevant store changes.

const JOINT_ROWS = [
  { idx: 1, label: 'J1 · base yaw' },
  { idx: 2, label: 'J2 · shoulder pitch' },
  { idx: 3, label: 'J3 · elbow pitch' },
  { idx: 4, label: 'J4 · wrist tilt' },
  { idx: 5, label: 'J5 · wrist pitch' },
  { idx: 6, label: 'J6 · flange roll' },
]

const DELTAS = [-5, -1, +1, +5]

const BAND_BG   = '#7F1D1D'   // deep red — matches --danger family
const BAND_TEXT = '#FFF'
const BAND_HINT = '#FCA5A5'

function rad2deg(r) { return (r * 180) / Math.PI }

export default function IncrementalJogPanel() {
  const positions   = useStore((s) => s.joints?.positions)
  const robot       = useStore((s) => s.robot) || {}
  const estop       = useStore((s) => s.safety?.estop)
  const addToast    = useStore((s) => s.addToast)

  const [pendingKey, setPendingKey] = useState(null)  // "J<i>:<delta>" while /cmd/jog is in flight
  const [lastError,  setLastError]  = useState(null)

  // Gate the whole panel. Note: allow_jog is what the driver reports —
  // it goes true only when monitor_only=false AND ESTUN_ALLOW_JOG=1 (or
  // allow_jog:true in YAML). If the operator opens the panel and this
  // flag is false, the driver will reject the write anyway; disabling
  // here just gives clearer UI + no wasted round-trip.
  const enabled = useMemo(() => {
    if (estop)                     return false
    if (!robot.connected)          return false
    if (robot.mode !== 'enabled')  return false
    if (robot.jog_active)          return false
    return true
  }, [estop, robot.connected, robot.mode, robot.jog_active])

  async function sendJog(joint1based, deltaDeg) {
    const key = `J${joint1based}:${deltaDeg}`
    setPendingKey(key)
    setLastError(null)
    try {
      const res = await fetch('/cmd/jog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joint: joint1based, delta_deg: deltaDeg }),
      })
      if (!res.ok) {
        let msg
        try { msg = (await res.json()).error } catch { msg = res.statusText }
        setLastError(`J${joint1based} ${deltaDeg > 0 ? '+' : ''}${deltaDeg}°: ${msg}`)
        addToast?.(`Jog rejected: ${msg}`, 'error')
      }
    } catch (e) {
      setLastError(`J${joint1based} ${deltaDeg > 0 ? '+' : ''}${deltaDeg}°: ${e.message}`)
      addToast?.(`Jog request failed: ${e.message}`, 'error')
    } finally {
      // Small settle delay so rapid double-clicks don't stack while
      // the driver is between accept and jog_active=true.
      setTimeout(() => setPendingKey(null), 150)
    }
  }

  // Reason strings for the disabled-band hint so operators know why
  // they can't press a button.
  const disabledReason = useMemo(() => {
    if (estop)                      return 'E-Stop active'
    if (!robot.connected)           return 'Driver not connected'
    if (robot.mode !== 'enabled')   return `Arm ${robot.mode || 'disabled'} on pendant`
    if (!robot.allow_jog)           return 'Jog gate closed (ESTUN_ALLOW_JOG)'
    if (robot.jog_active)           return `Jog in flight on J${robot.jog_index}`
    return null
  }, [estop, robot.connected, robot.mode, robot.allow_jog, robot.jog_active, robot.jog_index])

  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      fontFamily: 'inherit',
    }}>
      {/* Red band — visual clear signal this is NOT the twin panel */}
      <div style={{
        background: BAND_BG,
        color: BAND_TEXT,
        padding: '6px 10px',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>REAL ARM · Incremental Jog</span>
        <span style={{
          fontSize: 9,
          fontWeight: 500,
          color: BAND_HINT,
          textTransform: 'none',
          letterSpacing: 0,
        }}>
          {enabled ? 'ready' : (disabledReason || 'disabled')}
        </span>
      </div>

      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {JOINT_ROWS.map(({ idx, label }) => {
          const posRad = Array.isArray(positions) ? positions[idx - 1] : 0
          const deg = rad2deg(posRad || 0)
          return (
            <div key={idx} style={{
              display: 'grid',
              gridTemplateColumns: '96px 1fr',
              alignItems: 'center',
              gap: 8,
            }}>
              <div style={{
                fontSize: 11,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono, monospace)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label.split(' · ')[0]}</div>
                <div>{deg.toFixed(1)}°</div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {DELTAS.map((d) => {
                  const key = `J${idx}:${d}`
                  const busy = pendingKey === key
                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={!enabled || busy}
                      onClick={() => sendJog(idx, d)}
                      title={enabled ? `Jog ${label.split(' · ')[0]} by ${d > 0 ? '+' : ''}${d}°` : (disabledReason || 'disabled')}
                      style={{
                        flex: 1,
                        background: enabled ? 'var(--bg-surface)' : 'var(--bg-active, #1c1c1e)',
                        border: '1px solid var(--border)',
                        color: enabled ? 'var(--text-primary)' : 'var(--text-muted)',
                        padding: '5px 0',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 12,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                        cursor: enabled && !busy ? 'pointer' : 'not-allowed',
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      {d > 0 ? `+${d}°` : `${d}°`}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {lastError && (
          <div style={{
            fontSize: 10,
            color: '#FCA5A5',
            background: 'rgba(220,38,38,0.10)',
            border: '1px solid rgba(220,38,38,0.25)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            marginTop: 2,
          }}>
            {lastError}
          </div>
        )}
      </div>
    </div>
  )
}

// ControllerOfflineBanner — top-of-viewport indicator for controller
// link loss (2026-09-15, auto-recovery directive).
//
// Backing state: STATE.robot.controller_offline is set by the dashboard's
// controller-staleness watchdog (dashboard_server._cri_proxy_staleness_loop)
// when /estun/status + /joint_states both stay silent past the 3-tick
// hysteresis threshold. The watchdog now runs for both JOG_BACKEND=ws
// and ros2. When a fresh /estun/status message arrives, the mirror in
// _on_estun_status syncs the flag to the driver's own `connected` field,
// so the banner also reflects a driver-reported "controller not
// connected" state (e.g. before the first successful WS handshake).
//
// Copy is operator-language only per the auto-recovery directive:
//   - "Controller offline — reconnecting…" (amber) while offline
//   - "Reconnected"                       (green, auto-dismiss ~3s)
// No dev jargon. No SHA. No error codes. Controls elsewhere are
// disabled (not hidden) via existing gates on robot.connected.
//
// Placement matches StaleCodegenBanner — top strip, non-blocking
// pointerEvents. Same edition-independent mount pattern.

import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'


const RECOVERED_TOAST_MS = 3000


export default function ControllerOfflineBanner() {
  const robot = useStore((s) => s.robotState?.robot) || {}
  const offline = robot.controller_offline === true
  const [showRecovered, setShowRecovered] = useState(false)
  const [wasOffline, setWasOffline] = useState(false)

  useEffect(() => {
    if (offline) {
      setWasOffline(true)
      setShowRecovered(false)
      return
    }
    if (!wasOffline) return
    setWasOffline(false)
    setShowRecovered(true)
    const t = setTimeout(() => setShowRecovered(false), RECOVERED_TOAST_MS)
    return () => clearTimeout(t)
  }, [offline, wasOffline])

  if (!offline && !showRecovered) return null

  const amber = {
    background: '#FEF3C7',
    border:     '#F59E0B',
    color:      '#92400E',
  }
  const green = {
    background: '#D1FAE5',
    border:     '#10B981',
    color:      '#065F46',
  }
  const style = offline ? amber : green
  const label = offline
    ? 'Controller offline — reconnecting…'
    : 'Reconnected'

  return (
    <div
      role="alert"
      data-testid="controller-offline-banner"
      data-state={offline ? 'offline' : 'recovered'}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9996,   // below StaleCodegenBanner (9997)
        background: style.background,
        borderBottom: `1px solid ${style.border}`,
        color: style.color,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontSize: 13,
        lineHeight: 1.4,
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',
      }}>
      <span style={{ fontSize: 18, lineHeight: 1 }}>
        {offline ? '⚠' : '✓'}
      </span>
      <span>{label}</span>
    </div>
  )
}

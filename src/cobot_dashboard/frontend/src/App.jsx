import { useEffect, useState } from 'react'
import { useStore }         from './store/useStore'
import TopBar               from './components/TopBar'
import SideNav              from './components/SideNav'
import SafetyBanner         from './components/SafetyBanner'
import ConnectionOverlay    from './components/ConnectionOverlay'
import FaultPanel           from './components/FaultPanel'
import CameraPanel          from './components/CameraPanel'
import LidarPanel           from './components/LidarPanel'
import ProgramPanel         from './components/ProgramPanel'
import ScenePanel           from './components/ScenePanel'
import MonitorLayout        from './layouts/MonitorLayout'
import ConfigureLayout      from './layouts/ConfigureLayout'

// ── Status bar ─────────────────────────────────────────────────────────────────
function StatusBar() {
  const system    = useStore((s) => s.system)
  const connected = useStore((s) => s.connected)
  const robot     = useStore((s) => s.robot)
  const uptime    = system?.uptime_s ?? 0
  const mins      = Math.floor(uptime / 60)
  const secs      = Math.floor(uptime % 60)

  return (
    <div style={{
      height: 36, flexShrink: 0,
      background: 'var(--bg-panel)', borderTop: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 14px', gap: 16,
      fontSize: 10, color: 'var(--text-muted)',
    }}>
      <span>{system?.mock ? 'Simulation Mode' : 'ROS2 Live'}</span>
      <span>Uptime {mins}m {String(secs).padStart(2, '0')}s</span>
      {robot?.ip && <span>Robot {robot.ip}</span>}
      <div style={{ flex: 1 }} />
      <span>{connected ? 'WebSocket connected' : 'Reconnecting…'}</span>
    </div>
  )
}

// ── Toast stack ────────────────────────────────────────────────────────────────
function ToastStack() {
  const toasts       = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)

  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dismissToast(t.id), 3000))
    return () => timers.forEach(clearTimeout)
  }, [toasts, dismissToast])

  if (!toasts.length) return null

  const COLORS = { success: 'var(--green)', error: 'var(--red)', info: 'var(--accent)' }

  return (
    <div style={{
      position: 'fixed', bottom: 48, left: '50%', transform: 'translateX(-50%)',
      zIndex: 600, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
    }}>
      {toasts.map((t) => (
        <div key={t.id} style={{
          padding: '8px 16px', borderRadius: 8, fontSize: 12,
          background: 'var(--bg-panel)',
          border: `1px solid ${COLORS[t.type] || 'var(--border)'}`,
          color: 'var(--text-primary)', boxShadow: 'var(--shadow-md)',
          animation: 'toastIn .2s ease',
        }}>
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Sensors tab ────────────────────────────────────────────────────────────────
function SensorsLayout() {
  return (
    <div style={{ display: 'flex', gap: 8, padding: 8, height: '100%', overflow: 'hidden' }}>
      <CameraPanel cam={0} />
      <CameraPanel cam={1} />
      <LidarPanel />
    </div>
  )
}

// ── Program tab ────────────────────────────────────────────────────────────────
function ProgramLayout() {
  return (
    <div style={{ height: '100%', padding: 8, overflow: 'hidden' }}>
      <ProgramPanel />
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const connectWS = useStore((s) => s.connectWS)
  const [tab, setTab] = useState('monitor')

  useEffect(() => { connectWS() }, [connectWS])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', overflow: 'hidden',
      background: 'var(--bg-app)', fontFamily: 'var(--font)', color: 'var(--text-primary)',
    }}>
      <TopBar tab={tab} onTabChange={setTab} />
      <SafetyBanner />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <SideNav tab={tab} onTabChange={setTab} />
        <main style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
          {tab === 'monitor'   && <MonitorLayout />}
          {tab === 'scene'     && <ScenePanel />}
          {tab === 'program'   && <ProgramLayout />}
          {tab === 'sensors'   && <SensorsLayout />}
          {tab === 'configure' && <ConfigureLayout onClose={() => setTab('monitor')} />}
        </main>
      </div>

      <StatusBar />
      <ConnectionOverlay />
      <FaultPanel />
      <ToastStack />
    </div>
  )
}

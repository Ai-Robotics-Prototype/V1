import { useEffect, useState } from 'react'
import { useStore }       from './store/useStore'
import Header             from './components/Header'
import SafetyBanner       from './components/SafetyBanner'
import SafetyPanel        from './components/SafetyPanel'
import CameraFeed         from './components/CameraFeed'
import ArmViewer3D        from './components/ArmViewer3D'
import RobotControls      from './components/RobotControls'
import ControlStrip       from './components/ControlStrip'
import ProgramPanel       from './components/ProgramPanel'
import FaultPanel         from './components/FaultPanel'
import ConfigureLayout    from './layouts/ConfigureLayout'

// ── Toast notifications ────────────────────────────────────────────────────────
function ToastStack() {
  const toasts      = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)

  useEffect(() => {
    const timers = toasts.map((t) =>
      setTimeout(() => dismissToast(t.id), 3000)
    )
    return () => timers.forEach(clearTimeout)
  }, [toasts, dismissToast])

  if (!toasts.length) return null

  const COLORS = { success: 'var(--green)', error: 'var(--red)', info: 'var(--accent)' }

  return (
    <div style={{
      position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 600, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
    }}>
      {toasts.map((t) => (
        <div key={t.id} style={{
          padding: '8px 16px', borderRadius: 8, fontSize: 12,
          background: 'var(--panel)', border: `1px solid ${COLORS[t.type] || 'var(--bd)'}`,
          color: 'var(--t1)', boxShadow: 'var(--sh)',
          animation: 'toastIn .2s ease',
        }}>
          {t.message}
        </div>
      ))}
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateY(8px); } }`}</style>
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const connectWS = useStore((s) => s.connectWS)
  const mode      = useStore((s) => s.mode)

  const [showConfigure, setShowConfigure] = useState(false)

  useEffect(() => { connectWS() }, [connectWS])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', overflow: 'hidden',
      background: 'var(--bg)', color: 'var(--t1)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <Header onConfigure={() => setShowConfigure(true)} />
      <SafetyBanner />

      <div style={{
        flex: 1, overflow: 'hidden', minHeight: 0,
        display: 'grid',
        gridTemplateColumns: mode === 'engineer'
          ? '240px 1fr 270px'
          : '240px 1fr',
        gap: 8, padding: 8,
      }}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto', minHeight: 0 }}>
          <SafetyPanel />
          <ControlStrip />
          {mode !== 'engineer' && <RobotControls />}
        </div>

        {/* Center column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ArmViewer3D />
          </div>
          <div style={{ flexShrink: 0, height: 210 }}>
            <CameraFeed />
          </div>
        </div>

        {/* Right column (engineer) */}
        {mode === 'engineer' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', minHeight: 0 }}>
            <RobotControls />
            <ProgramPanel />
          </div>
        )}
      </div>

      {/* Floating overlays */}
      <FaultPanel />
      <ToastStack />
      {showConfigure && <ConfigureLayout onClose={() => setShowConfigure(false)} />}
    </div>
  )
}

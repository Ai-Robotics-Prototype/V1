import { useEffect } from 'react'
import { useStore }  from './store/useStore'
import Header        from './components/Header'
import SafetyPanel   from './components/SafetyPanel'
import CameraFeed    from './components/CameraFeed'
import ArmViewer3D   from './components/ArmViewer3D'
import RobotControls from './components/RobotControls'

export default function App() {
  const connectWS = useStore((s) => s.connectWS)
  const mode      = useStore((s) => s.mode)

  useEffect(() => { connectWS() }, [connectWS])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', overflow: 'hidden',
      background: 'var(--bg)', color: 'var(--t1)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <Header />

      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: mode === 'engineer'
          ? '260px 1fr 280px'
          : '260px 1fr',
        gridTemplateRows: '1fr',
        gap: 10, padding: 10,
      }}>
        {/* Left column: safety + controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', minHeight: 0 }}>
          <SafetyPanel />
          <RobotControls />
        </div>

        {/* Center: 3D arm + camera */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden', minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ArmViewer3D />
          </div>
          <div style={{ flexShrink: 0, height: 220 }}>
            <CameraFeed />
          </div>
        </div>

        {/* Right column: engineer extras */}
        {mode === 'engineer' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', minHeight: 0 }}>
            <SceneGraph />
            <LogPanel />
          </div>
        )}
      </div>
    </div>
  )
}

function SceneGraph() {
  const objects = useStore((s) => s.sceneGraph.objects)

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, padding: 14,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--tm)', marginBottom: 10 }}>
        Scene Graph
      </div>
      {objects.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--tm)', textAlign: 'center', padding: '16px 0' }}>
          No objects detected
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {objects.slice(0, 12).map((obj, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '5px 8px', borderRadius: 5,
              background: 'var(--surf)', fontSize: 11,
            }}>
              <span style={{ color: 'var(--t2)' }}>{obj.label ?? `obj_${i}`}</span>
              <span style={{ fontFamily: 'monospace', color: 'var(--acc)' }}>
                {obj.confidence != null ? `${(obj.confidence * 100).toFixed(0)}%` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LogPanel() {
  const task = useStore((s) => s.task)

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, padding: 14, flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
        textTransform: 'uppercase', color: 'var(--tm)', marginBottom: 10 }}>
        Task Log
      </div>
      <div style={{
        flex: 1, fontFamily: 'monospace', fontSize: 10,
        color: 'var(--tm)', overflowY: 'auto',
        lineHeight: 1.6,
      }}>
        <div style={{ color: task.running ? 'var(--g)' : 'var(--tm)' }}>
          state: {task.state}
        </div>
        {task.paused && <div style={{ color: 'var(--y)' }}>PAUSED</div>}
      </div>
    </div>
  )
}

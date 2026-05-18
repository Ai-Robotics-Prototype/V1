import { useEffect } from 'react'
import { useStore } from './store'
import SafetyBanner  from './components/SafetyBanner'
import TopBar        from './components/TopBar'
import EStopButton   from './components/EStopButton'
import CameraPanel   from './components/CameraPanel'
import LidarPanel    from './components/LidarPanel'
import DetectionsPanel  from './components/DetectionsPanel'
import SceneGraphPanel  from './components/SceneGraphPanel'
import RobotControls    from './components/RobotControls'

const s = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-app)',
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    gap: 1,
  },
  // Left column: camera / lidar / split view
  left: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  // Right column: controls + side panels
  right: {
    width: 320,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    overflow: 'hidden',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border)',
  },
  rightScroll: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
}

export default function App() {
  const { connectWebSockets, activeView, mode } = useStore()

  useEffect(() => { connectWebSockets() }, [])

  return (
    <div style={s.root}>
      <SafetyBanner />
      <TopBar />

      <div style={s.body}>
        {/* ── left: visual panels ─────────────────────────────── */}
        <div style={s.left}>
          {activeView === 'camera' && <CameraPanel view="single-cam0" />}
          {activeView === 'lidar'  && <LidarPanel />}
          {activeView === 'split'  && (
            <div style={{ display:'flex', flex:1, overflow:'hidden', height:'100%' }}>
              <div style={{ flex:1 }}><CameraPanel view="single-cam0" /></div>
              <div style={{ flex:1, borderLeft:'1px solid var(--border)' }}>
                <CameraPanel view="single-cam1" />
              </div>
            </div>
          )}
          {activeView === 'scene' && (
            <div style={{ display:'flex', flex:1, overflow:'hidden', height:'100%' }}>
              <div style={{ flex:1 }}><LidarPanel /></div>
              <div style={{ flex:1, borderLeft:'1px solid var(--border)' }}>
                <CameraPanel view="single-cam0" />
              </div>
            </div>
          )}
        </div>

        {/* ── right: controls + data panels ───────────────────── */}
        <div style={s.right}>
          <RobotControls />
          <div style={s.rightScroll}>
            <DetectionsPanel />
            <SceneGraphPanel />
          </div>
        </div>
      </div>

      <EStopButton />
    </div>
  )
}

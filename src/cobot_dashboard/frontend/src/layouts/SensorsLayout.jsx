import { Component, useState } from 'react'
import CameraPanel from '../components/CameraPanel'
import LidarPanel from '../components/LidarPanel'
import MotionCamPanel from '../components/MotionCamPanel'

// Local error boundary so a render error inside any sensor panel
// (camera / lidar / motioncam) shows an inline "retry" fallback
// instead of crashing the whole Cameras & LiDAR screen to the
// global React error page. Added after a dangling component
// reference in the cam0 expand path crashed the view; the underlying
// bug is fixed below, but this catches future regressions.
class SensorErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) {
    return { err }
  }
  componentDidCatch(err, info) {
    // eslint-disable-next-line no-console
    console.error('[SensorErrorBoundary]', err, info?.componentStack)
  }
  retry = () => this.setState({ err: null })
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 10,
        background: '#0b1018', color: '#e2e8f0',
        padding: 16, textAlign: 'center',
      }}>
        <span style={{ fontSize: 32 }}>⚠️</span>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Camera view error</div>
        <div style={{ fontSize: 11, color: '#94a3b8', maxWidth: 360 }}>
          {String(this.state.err?.message || this.state.err || 'render failed')}
        </div>
        <button onClick={this.retry} style={{
          marginTop: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600,
          background: '#1f2937', color: '#e5e7eb',
          border: '1px solid #334155', borderRadius: 6, cursor: 'pointer',
        }}>Retry</button>
      </div>
    )
  }
}

// Cameras & LiDAR shows cam0 with its server-burned Isaac/COCO
// detection boxes. The open-vocabulary detection panel (formerly
// "NanoOWL") moved to Part Recognition → per-part config so each
// part owns its own prompt — `NanoOWLOverlay` / `NanoOWLPanel`
// are no longer mounted here. The components still exist for
// diagnostics; just nothing imports them on this screen.
function Cam0(_props) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <CameraPanel cam={0} />
    </div>
  )
}

function PanelChrome({ expanded, onToggle, children }) {
  return (
    <div style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%' }}>
      <button
        onClick={onToggle}
        title={expanded ? 'Collapse' : 'Expand'}
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 10,
          width: 32, height: 32, borderRadius: 6,
          background: 'rgba(0,0,0,0.55)', color: '#fff',
          border: 'none', cursor: 'pointer',
          fontSize: 14, lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {expanded ? '✖' : '⛶'}
      </button>
      {children}
    </div>
  )
}

export default function SensorsLayout() {
  // null = default grid; 'cam0' | 'cam1' | 'lidar' | 'motioncam' fills the
  // whole Cameras & LiDAR area with that one panel.
  const [expanded, setExpanded] = useState(null)
  const collapse = () => setExpanded(null)

  if (expanded === 'cam0') {
    // Was `<Cam0WithNanoOWL />` — a component that doesn't exist
    // (the NanoOWL wrapper moved to Part Recognition long ago and the
    // expand path never got updated). React mounted an `undefined`
    // element and threw "Element type is invalid". cam1 was fine
    // because its expand path pointed at the real CameraPanel.
    return (
      <SensorErrorBoundary>
        <PanelChrome expanded onToggle={collapse}>
          <Cam0 />
        </PanelChrome>
      </SensorErrorBoundary>
    )
  }
  if (expanded === 'cam1') {
    return (
      <SensorErrorBoundary>
        <PanelChrome expanded onToggle={collapse}>
          <CameraPanel cam={1} />
        </PanelChrome>
      </SensorErrorBoundary>
    )
  }
  if (expanded === 'lidar') {
    return (
      <SensorErrorBoundary>
        <PanelChrome expanded onToggle={collapse}>
          <LidarPanel />
        </PanelChrome>
      </SensorErrorBoundary>
    )
  }
  if (expanded === 'motioncam') {
    return (
      <SensorErrorBoundary>
        <PanelChrome expanded onToggle={collapse}>
          <MotionCamPanel />
        </PanelChrome>
      </SensorErrorBoundary>
    )
  }

  // Default grid: two cameras on top, LiDAR in the middle, MotionCam on the
  // bottom — the MotionCam panel needs the wider width to host its split
  // live-feed view + point cloud + recognition overlay.
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: 'minmax(220px, 1fr) minmax(260px, 1fr) minmax(380px, 1.4fr)',
      height: '100%',
      overflow: 'auto',
      gap: 0,
    }}>
      <div style={{ borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <SensorErrorBoundary>
          <PanelChrome expanded={false} onToggle={() => setExpanded('cam0')}>
            <Cam0 />
          </PanelChrome>
        </SensorErrorBoundary>
      </div>

      <div style={{ borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <SensorErrorBoundary>
          <PanelChrome expanded={false} onToggle={() => setExpanded('cam1')}>
            <CameraPanel cam={1} />
          </PanelChrome>
        </SensorErrorBoundary>
      </div>

      <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <SensorErrorBoundary>
          <PanelChrome expanded={false} onToggle={() => setExpanded('lidar')}>
            <LidarPanel />
          </PanelChrome>
        </SensorErrorBoundary>
      </div>

      <div style={{ gridColumn: '1 / -1', overflow: 'hidden' }}>
        <SensorErrorBoundary>
          <PanelChrome expanded={false} onToggle={() => setExpanded('motioncam')}>
            <MotionCamPanel />
          </PanelChrome>
        </SensorErrorBoundary>
      </div>
    </div>
  )
}

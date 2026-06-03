import { useState } from 'react'
import CameraPanel from '../components/CameraPanel'
import LidarPanel from '../components/LidarPanel'

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
  // null = default 2-row grid; 'cam0' | 'cam1' | 'lidar' fills the
  // whole Cameras & LiDAR area with that one panel.
  const [expanded, setExpanded] = useState(null)
  const collapse = () => setExpanded(null)

  if (expanded === 'cam0') {
    return (
      <PanelChrome expanded onToggle={collapse}>
        <CameraPanel cam={0} />
      </PanelChrome>
    )
  }
  if (expanded === 'cam1') {
    return (
      <PanelChrome expanded onToggle={collapse}>
        <CameraPanel cam={1} />
      </PanelChrome>
    )
  }
  if (expanded === 'lidar') {
    return (
      <PanelChrome expanded onToggle={collapse}>
        <LidarPanel />
      </PanelChrome>
    )
  }

  // Default grid: two cameras on top, LiDAR full-width on the bottom
  // — point clouds benefit from the wider aspect ratio.
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      height: '100%',
      overflow: 'hidden',
      gap: 0,
    }}>
      <div style={{ borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <PanelChrome expanded={false} onToggle={() => setExpanded('cam0')}>
          <CameraPanel cam={0} />
        </PanelChrome>
      </div>

      <div style={{ borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <PanelChrome expanded={false} onToggle={() => setExpanded('cam1')}>
          <CameraPanel cam={1} />
        </PanelChrome>
      </div>

      <div style={{ gridColumn: '1 / -1', overflow: 'hidden' }}>
        <PanelChrome expanded={false} onToggle={() => setExpanded('lidar')}>
          <LidarPanel />
        </PanelChrome>
      </div>
    </div>
  )
}

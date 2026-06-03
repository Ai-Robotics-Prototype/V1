import { useState } from 'react'
import CameraPanel from './CameraPanel'
import LidarPanel from './LidarPanel'

function PanelChrome({ expanded, onToggle, children }) {
  return (
    <div style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%' }}>
      <button
        onClick={onToggle}
        title={expanded ? 'Collapse' : 'Expand'}
        style={{
          position: 'absolute', top: 6, right: 6, zIndex: 10,
          width: 28, height: 28, borderRadius: 4,
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

export default function SplitView() {
  // null = default 2×2 grid; 'cam0' | 'cam1' | 'lidar' = that panel
  // fills the entire viewport with a close button to return.
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

  // Default: 2×2 grid — two cameras on top, LiDAR full-width on the
  // bottom (point clouds benefit from the wider aspect ratio).
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      gap: 2,
      background: 'var(--border)',
    }}>
      <PanelChrome expanded={false} onToggle={() => setExpanded('cam0')}>
        <CameraPanel cam={0} />
      </PanelChrome>

      <PanelChrome expanded={false} onToggle={() => setExpanded('cam1')}>
        <CameraPanel cam={1} />
      </PanelChrome>

      <div style={{ gridColumn: '1 / -1' }}>
        <PanelChrome expanded={false} onToggle={() => setExpanded('lidar')}>
          <LidarPanel />
        </PanelChrome>
      </div>
    </div>
  )
}

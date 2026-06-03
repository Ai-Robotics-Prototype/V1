import { useStore } from '../store/useStore'
import CameraPanel from '../components/CameraPanel'
import LidarPanel from '../components/LidarPanel'
import SplitView from '../components/SplitView'
import ArmViewer3D from '../components/ArmViewer3D'
import ProgramPanel from '../components/ProgramPanel'
import ControlStrip from '../components/ControlStrip'
import PartsLibrary from '../components/PartsLibrary'

// Scene graph panel (compact table view for 'scene' mode)
function SceneGraphPanel() {
  const objects = useStore((s) => s.scene_graph.objects)

  function dist(position) {
    const [px, py, pz] = position ?? [0, 0, 0]
    return Math.sqrt(px ** 2 + py ** 2 + pz ** 2).toFixed(2)
  }

  return (
    <div style={{ width: '100%', height: '100%', background: '#08090c', padding: 12, overflowY: 'auto' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 8 }}>
        Scene Graph
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, color: 'var(--text-secondary)' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['ID', 'Class', 'Position', 'Distance', 'Conf'].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '3px 6px', color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {objects.map((obj) => (
            <tr key={obj.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '4px 6px', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{obj.id}</td>
              <td style={{ padding: '4px 6px', textTransform: 'uppercase', fontWeight: 500, color: 'var(--text-primary)' }}>{obj.class_name}</td>
              <td style={{ padding: '4px 6px', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                {(() => { const [px, py, pz] = obj.position ?? [0,0,0]; return `(${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)})` })()}
              </td>
              <td style={{ padding: '4px 6px', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{dist(obj.position)} m</td>
              <td style={{ padding: '4px 6px', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{((obj.score ?? obj.confidence ?? 0) * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ViewportArea() {
  const activeView = useStore((s) => s.activeView)

  const sharedStyle = { flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex' }

  if (activeView === 'split') return <div style={sharedStyle}><SplitView /></div>
  if (activeView === 'cam0')  return <div style={sharedStyle}><CameraPanel cam={0} /></div>
  if (activeView === 'cam1')  return <div style={sharedStyle}><CameraPanel cam={1} /></div>
  if (activeView === 'lidar') return <div style={sharedStyle}><LidarPanel /></div>
  if (activeView === 'arm')   return <div style={sharedStyle}><ArmViewer3D /></div>
  if (activeView === 'scene') return <div style={sharedStyle}><SceneGraphPanel /></div>
  if (activeView === 'parts') return <div style={sharedStyle}><PartsLibrary /></div>

  // Default: split view
  return <div style={sharedStyle}><SplitView /></div>
}

export default function MonitorLayout() {
  return (
    <div style={{
      display: 'flex',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Left: viewport + control strip */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <ViewportArea />
        <ControlStrip />
      </div>

      {/* Right: Program panel */}
      <div style={{ width: 320, flexShrink: 0, overflow: 'hidden' }}>
        <ProgramPanel />
      </div>
    </div>
  )
}

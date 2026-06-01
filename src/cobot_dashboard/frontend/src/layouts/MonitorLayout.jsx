import { useStore } from '../store/useStore'
import CameraPanel from '../components/CameraPanel'
import LidarPanel from '../components/LidarPanel'
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

// Safety view with proximity ring diagram
function SafetyView() {
  const safety = useStore((s) => s.safety)
  const { zone, human_proximity, speed_scale, estop } = safety

  const RING_RADII = [1.2, 0.6, 0.3]
  const RING_COLORS = ['#22C55E', '#EAB308', '#EF4444']
  const SVG_SIZE = 280
  const SCALE = SVG_SIZE / (2 * 1.8)

  const personR = Math.min(human_proximity, 1.8) * SCALE
  const cx = SVG_SIZE / 2
  const cy = SVG_SIZE / 2

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: '#08090c',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      padding: 16,
    }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>
        Safety Zone Monitor
      </div>

      {/* Ring diagram */}
      <svg width={SVG_SIZE} height={SVG_SIZE}>
        {RING_RADII.map((r, i) => (
          <circle
            key={r}
            cx={cx} cy={cy}
            r={r * SCALE}
            fill="none"
            stroke={RING_COLORS[i]}
            strokeWidth={1.5}
            strokeDasharray={zone === (['GREEN','YELLOW','RED'][i]) ? '4 3' : 'none'}
            opacity={0.4}
          />
        ))}

        {/* Person dot */}
        <circle
          cx={cx}
          cy={cy - personR}
          r={8}
          fill={zone === 'RED' ? '#EF4444' : zone === 'YELLOW' ? '#EAB308' : '#22C55E'}
          opacity={0.9}
        />

        {/* Robot (center) */}
        <rect x={cx - 8} y={cy - 10} width={16} height={20} rx={3} fill="#3B82F6" opacity={0.9} />

        {/* Labels */}
        <text x={cx + 1.2 * SCALE + 4} y={cy + 4} fontSize={9} fill="#22C55E" opacity={0.7}>1.2 m</text>
        <text x={cx + 0.6 * SCALE + 4} y={cy + 4} fontSize={9} fill="#EAB308" opacity={0.7}>0.6 m</text>
        <text x={cx + 0.3 * SCALE + 4} y={cy + 4} fontSize={9} fill="#EF4444" opacity={0.7}>0.3 m</text>
      </svg>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>Zone</div>
          <div style={{
            fontWeight: 700, fontSize: 15,
            color: zone === 'GREEN' ? 'var(--green)' : zone === 'YELLOW' ? 'var(--yellow)' : 'var(--red)',
          }}>
            {zone}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>Proximity</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15 }}>{human_proximity.toFixed(2)} m</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>Speed</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15 }}>{Math.round(speed_scale * 100)}%</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', marginBottom: 2 }}>E-Stop</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: estop ? 'var(--red)' : 'var(--green)' }}>
            {estop ? 'ACTIVE' : 'Clear'}
          </div>
        </div>
      </div>
    </div>
  )
}

function ViewportArea() {
  const activeView = useStore((s) => s.activeView)

  const sharedStyle = { flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex' }

  if (activeView === 'split') {
    return (
      <div style={{ ...sharedStyle }}>
        <div style={{ flex: 1 }}><CameraPanel cam={0} /></div>
        <div style={{ width: 1, background: 'var(--border)', flexShrink: 0 }} />
        <div style={{ flex: 1 }}><CameraPanel cam={1} /></div>
      </div>
    )
  }
  if (activeView === 'cam0') return <div style={sharedStyle}><CameraPanel cam={0} /></div>
  if (activeView === 'cam1') return <div style={sharedStyle}><CameraPanel cam={1} /></div>
  if (activeView === 'lidar') return <div style={sharedStyle}><LidarPanel /></div>
  if (activeView === 'arm')   return <div style={sharedStyle}><ArmViewer3D /></div>
  if (activeView === 'scene') return <div style={sharedStyle}><SceneGraphPanel /></div>
  if (activeView === 'parts') return <div style={sharedStyle}><PartsLibrary /></div>
  if (activeView === 'safety') return <div style={sharedStyle}><SafetyView /></div>

  // Default: split
  return (
    <div style={{ ...sharedStyle }}>
      <div style={{ flex: 1 }}><CameraPanel cam={0} /></div>
      <div style={{ width: 1, background: 'var(--border)', flexShrink: 0 }} />
      <div style={{ flex: 1 }}><CameraPanel cam={1} /></div>
    </div>
  )
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

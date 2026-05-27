import { useStore } from '../store/useStore'
import CameraPanel from '../components/CameraPanel'
import LidarPanel from '../components/LidarPanel'

function SceneGraphTable() {
  const objects = useStore((s) => s.scene_graph.objects)

  function dist(pos) {
    return Math.sqrt(pos[0] ** 2 + pos[1] ** 2 + pos[2] ** 2)
  }

  function ageLabel(ms) {
    if (ms < 1000) return `${ms} ms`
    return `${(ms / 1000).toFixed(1)} s`
  }

  function isOld(ms) {
    return ms > 1000
  }

  const sorted = [...objects].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: '#08090c',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--text-muted)',
        flexShrink: 0,
      }}>
        Scene Graph
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead style={{ position: 'sticky', top: 0, background: '#08090c', zIndex: 1 }}>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['ID', 'Class', 'Position', 'Distance', 'Age', 'Confidence'].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    padding: '5px 8px',
                    color: 'var(--text-muted)',
                    fontSize: 9,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    fontWeight: 500,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((obj) => {
              const pos   = obj.position ?? [0, 0, 0]
              const conf  = obj.score ?? obj.confidence ?? 0
              const d     = dist(pos)
              const old   = isOld(obj.last_seen_ms)
              return (
                <tr
                  key={obj.id}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                    {obj.id}
                  </td>
                  <td style={{ padding: '5px 8px', textTransform: 'uppercase', fontWeight: 500, color: 'var(--text-primary)', fontSize: 11 }}>
                    {obj.class_name}
                  </td>
                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                    ({pos[0].toFixed(3)},&nbsp;{pos[1].toFixed(3)},&nbsp;{pos[2].toFixed(3)})
                  </td>
                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {d.toFixed(2)} m
                  </td>
                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, color: old ? 'var(--red)' : 'var(--text-secondary)' }}>
                    {ageLabel(obj.last_seen_ms)}
                  </td>
                  <td style={{ padding: '5px 8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 48, height: 3, background: 'var(--bg-active)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          width: `${conf * 100}%`,
                          height: '100%',
                          background: conf > 0.8 ? 'var(--green)' : 'var(--yellow)',
                          borderRadius: 2,
                        }} />
                      </div>
                      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {(conf * 100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                  No objects in scene graph
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SensorsLayout() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      height: '100%',
      overflow: 'hidden',
      gap: 0,
    }}>
      {/* Top-left: Camera 0 */}
      <div style={{ borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <CameraPanel cam={0} />
      </div>

      {/* Top-right: Camera 1 */}
      <div style={{ borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <CameraPanel cam={1} />
      </div>

      {/* Bottom-left: LiDAR */}
      <div style={{ borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
        <LidarPanel />
      </div>

      {/* Bottom-right: Scene graph table */}
      <div style={{ overflow: 'hidden' }}>
        <SceneGraphTable />
      </div>
    </div>
  )
}

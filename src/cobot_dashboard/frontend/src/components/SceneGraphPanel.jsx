import { useStore } from '../store/useStore'

const BAR_MAX = 2.0

function XYZBar({ value, color }) {
  const pct = Math.min(Math.abs(value) / BAR_MAX * 100, 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <div style={{
        flex: 1, height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden',
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{
        fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
        width: 32, textAlign: 'right',
      }}>
        {value.toFixed(2)}m
      </span>
    </div>
  )
}

export default function SceneGraphPanel() {
  const sceneGraph  = useStore((s) => s.sceneGraph)
  const sendCommand = useStore((s) => s.sendCommand)
  const objects     = sceneGraph?.objects ?? []

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '5px 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          Scene Graph
        </span>
        <span style={{
          fontSize: 9, padding: '1px 5px', borderRadius: 6,
          background: 'var(--bg-surface)', color: 'var(--text-muted)',
        }}>
          {objects.length} tracked
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {objects.length === 0 ? (
          <div style={{ padding: 12, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
            No tracked objects
          </div>
        ) : objects.map((obj, i) => {
          const pos  = obj.position || obj.pos_3d || [0, 0, 0]
          const [x, y, z] = pos
          const cls      = obj.class_name || obj.class || 'object'
          const conf     = obj.score != null ? Math.round(obj.score * 100) : null
          const pickable = obj.pickable !== false

          return (
            <div key={obj.id ?? i} style={{
              padding: '6px 8px', marginBottom: 4,
              background: 'var(--bg-surface)', borderRadius: 6,
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', flex: 1,
                }}>
                  {cls}
                </span>
                {conf !== null && (
                  <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>{conf}%</span>
                )}
                {pickable && (
                  <button
                    onClick={() => sendCommand('pick', { object_id: obj.id, class_name: cls })}
                    style={{
                      fontSize: 8, padding: '2px 6px', borderRadius: 4,
                      border: '1px solid var(--accent)', background: 'var(--accent-dim)',
                      color: 'var(--accent)', cursor: 'pointer',
                    }}
                  >
                    Pick
                  </button>
                )}
              </div>
              <XYZBar value={x ?? 0} color="#2563EB" />
              <XYZBar value={y ?? 0} color="#16A34A" />
              <XYZBar value={z ?? 0} color="#D97706" />
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store/useStore'

function fmtAge(ms) {
  if (ms > 1000) return { text: '>1s', old: true }
  return { text: `${ms} ms`, old: false }
}

export default function SceneGraphPanel() {
  const objects = useStore((s) => s.scene_graph.objects)

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span className="label">Scene Graph</span>
        <span style={styles.badge}>{objects.length}</span>
      </div>

      {objects.length === 0 ? (
        <div style={styles.empty}>No tracked objects</div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                {['ID','Class','X','Y','Z','Yaw','Speed','Status','Age','Conf'].map(h => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {objects.map(obj => {
                  const age = fmtAge(obj.last_seen_ms ?? 0)
                  const pos = obj.position ?? [0, 0, 0]
                  const [x, y, z] = pos
                  const yaw = obj.orientation && obj.orientation.length >= 3
                    ? obj.orientation[2] : null
                  const speedMps = obj.speed_mps ?? 0
                  const moving = !!obj.is_moving
                  const status = age.old ? 'LOST' : (moving ? 'MOVING' : 'STATIC')
                  const statusColor = age.old ? 'var(--zone-red)'
                    : moving ? '#F59E0B' : '#16A34A'
                  return (
                    <motion.tr
                      key={obj.id}
                      layout
                      initial={{ backgroundColor: 'rgba(47,127,255,0.12)' }}
                      animate={{ backgroundColor: 'rgba(0,0,0,0)' }}
                      transition={{ duration: 0.6 }}
                    >
                      <td style={styles.td}>{(obj.id || '').slice(0, 8)}</td>
                      <td style={styles.td}>{obj.class_name}</td>
                      <td style={styles.tdNum}>{(x ?? 0).toFixed(2)} m</td>
                      <td style={styles.tdNum}>{(y ?? 0).toFixed(2)} m</td>
                      <td style={styles.tdNum}>{(z ?? 0).toFixed(2)} m</td>
                      <td style={styles.tdNum}>
                        {yaw == null ? '—' : `${yaw.toFixed(0)}°`}
                      </td>
                      <td style={styles.tdNum}>
                        {moving ? `${(speedMps * 100).toFixed(1)} cm/s` : '—'}
                      </td>
                      <td style={{ ...styles.tdNum, color: statusColor, fontWeight: 600 }}>
                        {status}
                      </td>
                      <td style={{ ...styles.tdNum, color: age.old ? 'var(--zone-red)' : 'var(--text-secondary)' }}>
                        {age.text}
                      </td>
                      <td style={styles.tdNum}>{((obj.score ?? obj.confidence ?? 0) * 100).toFixed(0)}%</td>
                    </motion.tr>
                  )
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const styles = {
  panel: {
    background: 'var(--bg-panel)',
    borderTop: '1px solid var(--border)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px 8px',
  },
  badge: {
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    fontSize: 11, borderRadius: 10,
    padding: '1px 7px',
  },
  tableWrap: { overflowX: 'auto', padding: '0 8px 8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    padding: '4px 6px', textAlign: 'left',
    color: 'var(--text-muted)', fontSize: 11,
    letterSpacing: '0.06em', borderBottom: '1px solid var(--border)',
  },
  td: { padding: '5px 6px', color: 'var(--text-secondary)' },
  tdNum: {
    padding: '5px 6px', color: 'var(--text-secondary)',
    fontVariantNumeric: 'tabular-nums',
  },
  empty: { padding: '12px 14px', color: 'var(--text-muted)', fontSize: 13 },
}

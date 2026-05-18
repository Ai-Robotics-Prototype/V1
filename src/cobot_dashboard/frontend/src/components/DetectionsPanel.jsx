import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

const CLASS_COLORS = {
  person: 'var(--zone-red)',
  bottle: 'var(--accent)',
  box:    'var(--zone-green)',
}
function classColor(name) { return CLASS_COLORS[name] ?? 'var(--text-muted)' }

function distance(d) {
  const dist = Math.sqrt(d.x**2 + d.y**2 + d.z**2)
  return dist.toFixed(2) + ' m'
}

export default function DetectionsPanel() {
  const { robotState } = useStore()
  const raw = robotState?.detections ?? []
  const sorted = [...raw].sort((a, b) => {
    const da = Math.sqrt(a.x**2 + a.y**2 + a.z**2)
    const db = Math.sqrt(b.x**2 + b.y**2 + b.z**2)
    return da - db
  })

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span className="label">Detections</span>
        <span style={styles.badge}>{sorted.length}</span>
      </div>

      {sorted.length === 0 ? (
        <div style={styles.empty}>No objects detected</div>
      ) : (
        <div style={styles.list}>
          <AnimatePresence initial={false}>
            {sorted.map(det => (
              <motion.div
                key={det.id}
                layout
                initial={{ opacity: 0, x: 20, backgroundColor: 'rgba(47,127,255,0.15)' }}
                animate={{ opacity: 1, x: 0,  backgroundColor: 'rgba(0,0,0,0)' }}
                transition={{ duration: 0.2 }}
                style={styles.row}
              >
                <span style={{ ...styles.dot, background: classColor(det.class_name) }} />
                <span style={styles.name}>{det.class_name.toUpperCase()}</span>
                <div style={styles.scoreWrap}>
                  <div style={{ ...styles.scoreBar,
                    width: `${det.score * 100}%`,
                    background: classColor(det.class_name) }} />
                </div>
                <span style={styles.dist}>{distance(det)}</span>
              </motion.div>
            ))}
          </AnimatePresence>
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
  list: { padding: '0 8px 8px' },
  row: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 6px', borderRadius: 6,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontSize: 12, fontWeight: 500, width: 60, flexShrink: 0, letterSpacing: '0.04em' },
  scoreWrap: {
    flex: 1, height: 3,
    background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden',
  },
  scoreBar: { height: '100%', borderRadius: 2, transition: 'width 0.3s' },
  dist: { fontSize: 12, color: 'var(--text-secondary)', width: 52, textAlign: 'right',
          fontVariantNumeric: 'tabular-nums' },
  empty: { padding: '12px 14px', color: 'var(--text-muted)', fontSize: 13 },
}

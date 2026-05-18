import { motion, AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import { useStore } from '../store'

const ZONE_BG = {
  GREEN:  'var(--zone-green)',
  YELLOW: 'var(--zone-yellow)',
  RED:    'var(--zone-red)',
}

const ZONE_DESC = {
  GREEN:  'All clear — full speed',
  YELLOW: 'Human nearby — reduced speed',
  RED:    'Human in danger zone — stopped',
}

export default function SafetyBanner() {
  const { robotState, sendCommand, setPendingEstop } = useStore()
  const [confirming, setConfirming] = useState(false)

  const safety  = robotState?.safety ?? {}
  const zone    = safety.zone  ?? 'GREEN'
  const estop   = safety.estop ?? false
  const prox    = safety.human_proximity ?? null

  async function releaseEstop() {
    setPendingEstop('releasing')
    await sendCommand('estop', { active: false })
    setPendingEstop(null)
    setConfirming(false)
  }

  if (estop) {
    return (
      <motion.div
        animate={{ backgroundColor: ['#FF0033', '#990020', '#FF0033'] }}
        transition={{ duration: 0.7, repeat: Infinity }}
        style={styles.banner}
      >
        <span style={styles.estopLabel}>E-STOP ACTIVE</span>
        {confirming ? (
          <button style={styles.confirmBtn} onClick={releaseEstop}>
            Confirm Release E-Stop
          </button>
        ) : (
          <button style={styles.releaseBtn} onClick={() => setConfirming(true)}>
            Release E-Stop?
          </button>
        )}
      </motion.div>
    )
  }

  const bg = ZONE_BG[zone] ?? 'var(--bg-surface)'

  return (
    <div style={{ ...styles.banner, background: bg }}>
      <div style={styles.left}>
        <span style={styles.zoneLabel}>{zone}</span>
        <span style={styles.desc}>{ZONE_DESC[zone]}</span>
      </div>
      <div style={styles.right}>
        {prox !== null && (
          <span style={styles.prox}>{prox.toFixed(2)} m</span>
        )}
      </div>
    </div>
  )
}

const styles = {
  banner: {
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
    flexShrink: 0,
    transition: 'background 0.4s',
  },
  left: { display: 'flex', alignItems: 'center', gap: 12 },
  right: {},
  zoneLabel: { fontSize: 13, fontWeight: 500, color: '#000', letterSpacing: '0.06em' },
  desc:      { fontSize: 12, color: 'rgba(0,0,0,0.65)' },
  prox:      { fontSize: 18, fontWeight: 500, color: '#000' },
  estopLabel:{ fontSize: 15, fontWeight: 500, color: '#fff', letterSpacing: '0.1em' },
  releaseBtn: {
    background: 'rgba(255,255,255,0.15)',
    color: '#fff',
    padding: '6px 16px',
    borderRadius: 6,
    fontSize: 13,
  },
  confirmBtn: {
    background: '#fff',
    color: '#FF0033',
    padding: '6px 16px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
  },
}

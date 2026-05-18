import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

const TASK_COLORS = {
  IDLE:     'var(--text-muted)',
  APPROACH: 'var(--accent)',
  PICK:     'var(--accent)',
  PLACE:    'var(--accent)',
  HOME:     'var(--zone-green)',
  PAUSED:   'var(--zone-yellow)',
  ERROR:    'var(--zone-red)',
}

const JOINT_NAMES = ['J1','J2','J3','J4','J5','J6']
const JOG_DELTAS  = [-5, -1, 1, 5]   // degrees

function rad2deg(r) { return (r * 180 / Math.PI).toFixed(1) }

export default function RobotControls() {
  const { robotState, mode, sendCommand, jogEnabled, unlockJog } = useStore()
  const [homeConfirm, setHomeConfirm]   = useState(false)
  const [jogWarning, setJogWarning]     = useState(false)
  const [activeJoint, setActiveJoint]   = useState(0)

  const safety = robotState?.safety ?? {}
  const joints = robotState?.joints ?? {}
  const task   = robotState?.task   ?? {}

  const estop      = safety.estop ?? false
  const zone       = safety.zone  ?? 'GREEN'
  const speedScale = safety.speed_scale ?? 1.0
  const taskState  = task.state ?? '—'

  const speedPct   = Math.round(speedScale * 100)
  const speedColor = zone === 'GREEN' ? 'var(--zone-green)'
                   : zone === 'YELLOW' ? 'var(--zone-yellow)'
                   : 'var(--zone-red)'

  async function go()   { await sendCommand('task', { command: 'go' }) }
  async function pause(){ await sendCommand('task', { command: 'pause' }) }
  async function home() {
    setHomeConfirm(false)
    await sendCommand('task', { command: 'home' })
  }
  async function jog(joint, deltaDeg) {
    await sendCommand('jog', { joint, delta: deltaDeg * Math.PI / 180 })
  }

  function enableJog() {
    setJogWarning(false)
    unlockJog()
  }

  return (
    <div style={styles.panel}>
      {/* Task state pill */}
      <div style={styles.stateRow}>
        <span className="label">Task</span>
        <span style={{ ...styles.statePill, background: `${TASK_COLORS[taskState] ?? 'var(--text-muted)'}22`,
          color: TASK_COLORS[taskState] ?? 'var(--text-muted)', border: `1px solid ${TASK_COLORS[taskState] ?? 'var(--text-muted)'}44` }}>
          {taskState}
        </span>
        {task.target && <span style={styles.target}>{task.target}</span>}
      </div>

      {/* Speed scale bar */}
      <div style={styles.speedRow}>
        <span className="label">Speed</span>
        <div style={styles.speedTrack}>
          <motion.div
            animate={{ width: `${speedPct}%`, background: speedColor }}
            transition={{ duration: 0.4 }}
            style={styles.speedFill}
          />
        </div>
        <span style={{ ...styles.speedNum, color: speedColor }}>{speedPct}%</span>
      </div>

      {/* Main control buttons */}
      <div style={styles.btnRow}>
        <button
          style={{ ...styles.btn, ...styles.btnGo }}
          onClick={go}
          disabled={estop}
        >
          GO / RESUME
        </button>
        <button
          style={{ ...styles.btn, ...styles.btnPause }}
          onClick={pause}
          disabled={estop}
        >
          PAUSE
        </button>
        {homeConfirm ? (
          <button style={{ ...styles.btn, ...styles.btnHomeConfirm }}
                  onClick={home}>
            CONFIRM HOME
          </button>
        ) : (
          <button style={{ ...styles.btn, ...styles.btnHome }}
                  onClick={() => setHomeConfirm(true)}
                  disabled={estop}>
            HOME
          </button>
        )}
      </div>

      {estop && (
        <div style={styles.estopOverlay}>E-Stop active — controls locked</div>
      )}

      {/* Engineer mode extras */}
      {mode === 'engineer' && (
        <div style={styles.engineerSection}>
          {/* Joint readout grid */}
          <div style={styles.sectionLabel} className="label">Joint Angles</div>
          <div style={styles.jointGrid}>
            {JOINT_NAMES.map((name, i) => {
              const pos = joints.positions?.[i] ?? 0
              const deg = parseFloat(rad2deg(pos))
              const pct = Math.min(100, Math.abs(deg) / 180 * 100)
              return (
                <div key={name} style={styles.jointTile}>
                  <span style={styles.jointName}>{name}</span>
                  <span style={styles.jointVal}>{deg}°</span>
                  <div style={styles.jointTrack}>
                    <div style={{ ...styles.jointFill, width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Manual jog */}
          <div style={styles.jogHeader}>
            <span className="label">Manual Jog</span>
            {!jogEnabled && (
              <button style={styles.jogUnlock} onClick={() => setJogWarning(true)}>
                Enable
              </button>
            )}
          </div>

          <AnimatePresence>
            {jogWarning && (
              <motion.div
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }} style={styles.jogWarningBox}>
                <span style={{ fontSize: 12, color: 'var(--zone-yellow)' }}>
                  Manual jog bypasses safety logic. Auto-disables after 30s.
                </span>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button style={{ ...styles.btn, padding: '4px 12px', fontSize: 12,
                    background: 'var(--zone-yellow)', color: '#000' }}
                    onClick={enableJog}>Enable Jog</button>
                  <button style={{ ...styles.btn, padding: '4px 12px', fontSize: 12,
                    background: 'var(--bg-surface)', color: 'var(--text-secondary)' }}
                    onClick={() => setJogWarning(false)}>Cancel</button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {jogEnabled && (
            <div style={styles.jogControls}>
              {/* Joint selector */}
              <div style={styles.jointPills}>
                {JOINT_NAMES.map((name, i) => (
                  <button key={name}
                    onClick={() => setActiveJoint(i)}
                    style={{ ...styles.jointPill,
                      ...(activeJoint === i ? styles.jointPillActive : {}) }}>
                    {name}
                  </button>
                ))}
              </div>
              {/* Delta buttons */}
              <div style={styles.jogBtns}>
                {JOG_DELTAS.map(d => (
                  <button key={d}
                    style={{ ...styles.btn, ...styles.jogBtn }}
                    onClick={() => jog(activeJoint, d)}
                    disabled={estop}>
                    {d > 0 ? `+${d}°` : `${d}°`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const styles = {
  panel: {
    background: 'var(--bg-panel)',
    padding: 12,
    flexShrink: 0,
    position: 'relative',
  },
  stateRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginBottom: 8,
  },
  statePill: {
    fontSize: 11, fontWeight: 500,
    padding: '2px 10px', borderRadius: 20,
    letterSpacing: '0.06em',
  },
  target: { fontSize: 12, color: 'var(--text-muted)' },

  speedRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginBottom: 10,
  },
  speedTrack: {
    flex: 1, height: 4,
    background: 'var(--bg-surface)', borderRadius: 2, overflow: 'hidden',
  },
  speedFill: { height: '100%', borderRadius: 2, minWidth: 2 },
  speedNum: { fontSize: 12, width: 36, textAlign: 'right',
              fontVariantNumeric: 'tabular-nums' },

  btnRow: { display: 'flex', gap: 6, marginBottom: 4 },
  btn: {
    flex: 1, height: 72, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontSize: 11, letterSpacing: '0.06em', fontWeight: 500,
    borderRadius: 'var(--radius-btn)',
  },
  btnGo:    { background: '#00C47A22', color: 'var(--zone-green)',
              border: '1px solid #00C47A44' },
  btnPause: { background: '#F5A62322', color: 'var(--zone-yellow)',
              border: '1px solid #F5A62344' },
  btnHome:        { background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                    border: '1px solid var(--border)' },
  btnHomeConfirm: { background: '#2F7FFF22', color: 'var(--accent)',
                    border: '1px solid #2F7FFF44' },

  estopOverlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(10,10,11,0.7)',
    color: 'var(--zone-red)', fontSize: 13, borderRadius: 'var(--radius-panel)',
    pointerEvents: 'none',
  },

  engineerSection: { borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 },

  sectionLabel: { marginBottom: 6, display: 'block' },

  jointGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 6, marginBottom: 10,
  },
  jointTile: {
    background: 'var(--bg-surface)', borderRadius: 6,
    padding: '6px 8px',
  },
  jointName: { fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' },
  jointVal:  { display: 'block', fontSize: 14, fontVariantNumeric: 'tabular-nums',
               color: 'var(--text-primary)', margin: '2px 0' },
  jointTrack: { height: 2, background: 'var(--bg-hover)', borderRadius: 1 },
  jointFill:  { height: '100%', background: 'var(--accent)', borderRadius: 1 },

  jogHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
               marginBottom: 6 },
  jogUnlock: {
    background: 'var(--bg-surface)', color: 'var(--text-secondary)',
    fontSize: 11, padding: '3px 10px', borderRadius: 4,
    border: '1px solid var(--border)',
  },
  jogWarningBox: {
    background: 'rgba(245,166,35,0.08)',
    border: '1px solid rgba(245,166,35,0.3)',
    borderRadius: 6, padding: 10, marginBottom: 8,
  },
  jogControls: {},
  jointPills: { display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' },
  jointPill: {
    background: 'var(--bg-surface)', color: 'var(--text-secondary)',
    fontSize: 12, padding: '3px 10px', borderRadius: 20,
    border: '1px solid var(--border)',
  },
  jointPillActive: {
    background: '#2F7FFF22', color: 'var(--accent)',
    border: '1px solid #2F7FFF66',
  },
  jogBtns: { display: 'flex', gap: 6 },
  jogBtn: {
    height: 40, background: 'var(--bg-surface)',
    color: 'var(--text-primary)', border: '1px solid var(--border)',
    fontSize: 13,
  },
}

import { useStore } from '../store/useStore'

// Jog speed slider — 0-100 %. Currently drives ONLY the twin animation
// speed (quick-orient buttons via durationForJogSpeed()). Named, reused
// across the Program window and the 3D View so a single operator gesture
// governs both. Persisted in the Zustand store (see partialize in
// store/useStore.js).
//
// TODO(motion): when commanded motion is enabled (write-command format
// captured on the Codroid v2.3 wire, joint-direction signs verified
// end-to-end, pendant in Remote mode), this same value becomes the
// speed_pct on /estun/move — safety-capped by global_speed_cap_pct in
// estun_driver.yaml. Do NOT flip that on without an explicit safety
// review; monitor_only stays true.

export default function JogSpeedSlider() {
  const jogSpeedPct    = useStore((s) => s.jogSpeedPct)
  const setJogSpeedPct = useStore((s) => s.setJogSpeedPct)
  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <span style={styles.label}>Jog speed</span>
        <span style={styles.val}>{Math.round(jogSpeedPct)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={jogSpeedPct}
        onChange={(e) => setJogSpeedPct(Number(e.target.value))}
        aria-label="Jog speed (twin animation speed; also future commanded-motion speed)"
        style={styles.range}
      />
      <div style={styles.hint}>
        Twin animation only — motion command wiring is TODO.
      </div>
    </div>
  )
}

const styles = {
  wrap: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: '8px 0 4px 0',
    borderTop: '1px solid var(--border, #1f2937)',
    marginTop: 6,
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
  },
  label: {
    fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)',
    letterSpacing: '0.06em',
  },
  val: {
    fontSize: 11, fontFamily: 'var(--font-mono, monospace)',
    color: 'var(--text-primary)', fontWeight: 600,
  },
  range: { width: '100%' },
  hint: {
    fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic',
  },
}

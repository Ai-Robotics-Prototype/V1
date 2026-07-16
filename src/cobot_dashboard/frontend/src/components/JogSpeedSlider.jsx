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

// Driver-side hard cap on commanded jog speed_frac. Mirrors
// estun_driver_node.declare_parameter('jog_speed_cap', 0.15) — anything
// above 15% on the slider is clamped there. Surfaced in the UI so the
// operator isn't surprised that pushing the slider past 15% looks the
// same on the wire (it hits the same 15% cap the driver enforces).
const JOG_SPEED_CAP_PCT = 15

export default function JogSpeedSlider() {
  const jogSpeedPct    = useStore((s) => s.jogSpeedPct)
  const setJogSpeedPct = useStore((s) => s.setJogSpeedPct)
  const capped = jogSpeedPct > JOG_SPEED_CAP_PCT
  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <span style={styles.label}>Jog speed</span>
        <span style={styles.val}>
          {Math.round(jogSpeedPct)}%
          {capped && (
            <span style={styles.capped}>
              &nbsp;→ {JOG_SPEED_CAP_PCT}% (capped)
            </span>
          )}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={jogSpeedPct}
        onChange={(e) => setJogSpeedPct(Number(e.target.value))}
        aria-label="Jog speed. Driver caps commanded speed at 15%."
        style={styles.range}
      />
      <div style={styles.hint}>
        {capped
          ? `Driver caps commanded speed at ${JOG_SPEED_CAP_PCT}%. Speed changes apply at the next hold — mid-hold jogs keep the starting speed.`
          : `Applies at hold-start; mid-hold slider changes take effect on the next press.`}
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
  capped: {
    color: 'var(--text-warn, #f59e0b)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 10, fontWeight: 700, letterSpacing: '0.03em',
  },
  range: { width: '100%' },
  hint: {
    fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic',
  },
}

import { useStore } from '../store/useStore'

// Fallback if the driver hasn't published effective_speed_cap yet
// (pre-safety-pass driver builds, cold-boot before first status blob).
// Matches the pre-pass 0.15 baseline so the UI is conservative when
// the number is unknown.
const FALLBACK_EFFECTIVE_CAP = 0.15

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
  // Effective ceiling from the driver's status blob. Two-tier cap:
  //   effective = min(jog_speed_cap, operator_speed_limit)
  // Fallback when the driver isn't yet reporting (cold boot,
  // pre-safety-pass build): the conservative 0.15 pre-pass baseline.
  const effCap = useStore((s) => s.robot?.effective_speed_cap)
  const opLim  = useStore((s) => s.robot?.operator_speed_limit)
  const hwCap  = useStore((s) => s.robot?.jog_speed_cap)
  const effectivePct = Math.round(
    (Number.isFinite(effCap) ? effCap : FALLBACK_EFFECTIVE_CAP) * 100
  )
  const capped = jogSpeedPct > effectivePct
  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <span style={styles.label}>Jog speed</span>
        <span style={styles.val}>
          {Math.round(jogSpeedPct)}%
          {capped && (
            <span style={styles.capped}>
              &nbsp;→ {effectivePct}% (capped)
            </span>
          )}
        </span>
      </div>
      <div style={styles.rangeWrap}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={jogSpeedPct}
          onChange={(e) => setJogSpeedPct(Number(e.target.value))}
          aria-label={`Jog speed. Driver ceiling ${effectivePct}%.`}
          style={styles.range}
        />
        {/* Effective-ceiling tick mark below the slider — a small
            colored bar the operator can see the ceiling at a glance. */}
        <div style={{
          position: 'relative', width: '100%', height: 6, marginTop: 2,
        }}>
          <div style={{
            position: 'absolute',
            left: `calc(${effectivePct}% - 1px)`,
            top: 0, width: 2, height: 6,
            background: 'var(--text-warn, #f59e0b)',
          }} />
        </div>
      </div>
      <div style={styles.hint}>
        {capped
          ? `Driver clamps to ${effectivePct}% (min(hw ${Math.round((hwCap || 0.15) * 100)}%, op-limit ${Math.round((opLim || 0.15) * 100)}%)). Speed changes apply at next hold — mid-hold jogs keep the starting speed.`
          : `Ceiling ${effectivePct}% (hw ${Math.round((hwCap || 0.15) * 100)}% / op-limit ${Math.round((opLim || 0.15) * 100)}%). Mid-hold changes take effect on next press.`}
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
  rangeWrap: { display: 'flex', flexDirection: 'column' },
  hint: {
    fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic',
  },
}

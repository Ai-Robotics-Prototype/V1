import { useEffect, useState } from 'react'
// 2026-09-08 operator directive: Reset all / Home / QuickOrient
// row / TCP (twin frame) box / JogSpeedSlider all retired from
// this panel. QuickOrientButtons + JogSpeedSlider are no longer
// imported here; the jog surface (Expand Jog Buttons) hosts the
// jog-speed control as the ONE authority. `three` is no longer
// used either — the TCP FK matrix computation went with the box.

// JointJogPanel — right-docked FK verification pane for the S10-140
// verified twin. Wired to ArmViewer3D via a jogApi handle exposed from
// URDFArm; when the URDF is loaded the six sliders drive
// robot.joints.joint_N.setJointValue directly AND seed the FK loop's
// currentRef / targetsRef so the 25 Hz lerp holds the pose (same sync
// pattern the click-drag release uses). NO inverse kinematics — that
// belongs in a separate pane, see TODO below.
//
// Also hosts the QuickOrientButtons (twin-only IK-solved orient
// presets) and the JogSpeedSlider (currently drives twin animation
// speed only). Both work in the Program window and the 3D View since
// this panel mounts in both.

const JOINT_META = [
  { name: 'joint_1', label: 'J1 · base yaw' },
  { name: 'joint_2', label: 'J2 · shoulder pitch' },
  { name: 'joint_3', label: 'J3 · elbow pitch' },
  { name: 'joint_4', label: 'J4 · wrist tilt' },
  { name: 'joint_5', label: 'J5 · wrist pitch' },
  { name: 'joint_6', label: 'J6 · flange roll' },
]

const NAVY  = '#263454'
const AMBER = '#F59E0B'
const STEP  = (0.5 * Math.PI) / 180

function rad2deg(r) { return (r * 180) / Math.PI }

// TODO(ik): a Cartesian jog pane belongs BELOW this one (or in a right-
// column tab). It should share the same jogApi.robot handle to sample
// FK, but must NOT compute IK inside this file — keep this pane FK only.

export default function JointJogPanel({
  jogApi,
  cartesianMode = false,
  onCartesianModeChange,
  gizmoMode = 'translate',
  onGizmoModeChange,
  // eslint-disable-next-line no-unused-vars
  onHome,        // 2026-09-08: Home button retired; prop kept so
                 // callers don't break their prop wiring.
  // eslint-disable-next-line no-unused-vars
  // eslint-disable-next-line no-unused-vars
  onAtLimit,     // was a callback from the retired orient row.
}) {
  const [values, setValues] = useState([0, 0, 0, 0, 0, 0])

  useEffect(() => {
    if (!jogApi?.robot?.joints) return
    const j = jogApi.robot.joints
    const initial = JOINT_META.map((meta) => {
      const v = j[meta.name]?.jointValue
      const raw = Array.isArray(v) ? v[0] : v
      const n = Number(raw)
      return Number.isFinite(n) ? n : 0
    })
    setValues(initial)
  }, [jogApi])

  useEffect(() => {
    // Mirror robot joint values into the sliders so IK-driven or
    // remote-driven motion shows on the fine-tune controls. Skips
    // sliders under active operator drag by checking magnitude
    // delta only (no focus tracking needed for this cadence).
    if (!jogApi) return undefined
    const id = setInterval(() => {
      const j = jogApi.robot?.joints
      if (!j) return
      setValues((prev) => {
        const next = prev.slice()
        let changed = false
        for (let i = 0; i < 6; i++) {
          const raw = j[JOINT_META[i].name]?.jointValue
          const n = Number(Array.isArray(raw) ? raw[0] : raw)
          if (Number.isFinite(n) && Math.abs(n - next[i]) > 1e-5) {
            next[i] = n
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 66)
    return () => clearInterval(id)
  }, [jogApi])

  const onSlide = (idx, radStr) => {
    const rad = Number(radStr)
    if (!Number.isFinite(rad)) return
    setValues((prev) => {
      const next = prev.slice()
      next[idx] = rad
      return next
    })
    jogApi?.setJointRad?.(idx, rad)
  }

  const ready = !!jogApi?.robot?.joints

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div style={styles.title}>Joint Jog</div>
        <div style={styles.twinTag}>TWIN ONLY</div>
      </div>

      {!ready && (
        <div style={styles.empty}>Waiting for URDF…</div>
      )}

      {ready && (
        <>
          {/* Cartesian mode toggle + gizmo axis mode. Sliders stay
              functional in either mode — the fine-tune tier per the
              spec. */}
          <div style={styles.modeRow}>
            <label style={styles.modeToggle}>
              <input
                type="checkbox"
                checked={cartesianMode}
                onChange={(e) => onCartesianModeChange?.(e.target.checked)}
              />
              <span>Cartesian mode</span>
            </label>
            {cartesianMode && (
              <div style={styles.gizmoMode}>
                <button
                  style={{ ...styles.modeBtn, ...(gizmoMode === 'translate' ? styles.modeBtnActive : {}) }}
                  onClick={() => onGizmoModeChange?.('translate')}
                >
                  Move
                </button>
                <button
                  style={{ ...styles.modeBtn, ...(gizmoMode === 'rotate' ? styles.modeBtnActive : {}) }}
                  onClick={() => onGizmoModeChange?.('rotate')}
                >
                  Rotate
                </button>
              </div>
            )}
          </div>

          {/* 2026-09-08 operator directive: Reset all / Home /
              QuickOrient row RETIRED. The panel now hosts ONLY the
              Cartesian mode toggle above + the six joint sliders
              below. Reasoning:
                * Reset (twin-only) had no wire consumer; operators
                  moved joints with the sliders or the jog surface.
                * Home button drove `jogApi.home()` on the twin only;
                  the arm's true home lives on the Monitor page.
                * Quick Orient was a novelty IK preset row with no
                  downstream consumer. */}
          {JOINT_META.map((jm, i) => {
            const joint = jogApi.robot.joints[jm.name]
            const lim = joint?.limit || {}
            const lo = Number.isFinite(Number(lim.lower)) ? Number(lim.lower) : -Math.PI
            const hi = Number.isFinite(Number(lim.upper)) ? Number(lim.upper) :  Math.PI
            const v  = values[i]
            const deg = rad2deg(v)
            return (
              <div key={jm.name} style={styles.row}>
                <div style={styles.rowHead}>
                  <span style={styles.rowLabel}>{jm.label}</span>
                  <span>
                    <span style={styles.rowValDeg}>{deg.toFixed(1)}°</span>
                    <span style={styles.rowValRad}>({v.toFixed(3)} rad)</span>
                  </span>
                </div>
                <input
                  type="range"
                  min={lo} max={hi} step={STEP}
                  value={v}
                  onInput={(e) => onSlide(i, e.target.value)}
                  onChange={(e) => onSlide(i, e.target.value)}
                  style={styles.slider}
                />
                <div style={styles.limitStrip}>
                  <span>{rad2deg(lo).toFixed(0)}°</span>
                  <span>{rad2deg(hi).toFixed(0)}°</span>
                </div>
              </div>
            )
          })}

          {/* 2026-09-08 operator directive: TCP (TWIN FRAME) readout
              box + JogSpeedSlider RETIRED from this panel.
                * TCP box was display-only; no consumer.
                * JogSpeedSlider wrote to the shared store slot
                  `jogSpeedPct` — the SAME slot the jog surface
                  (Expand Jog Buttons → JogControls) writes.
                  Audited pre-removal: both readers/writers unify
                  to the store field, no hidden speed state
                  remains. The jog surface is now the ONE
                  authority. */}
        </>
      )}
    </div>
  )
}

const styles = {
  panel: {
    position: 'absolute', top: 8, right: 8, width: 300,
    maxHeight: 'calc(100% - 16px)', overflowY: 'auto',
    background: 'rgba(255,255,255,0.97)',
    border: '1px solid var(--border, rgba(0,0,0,0.09))',
    borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
    padding: 12, zIndex: 11,
    fontFamily: 'var(--font, system-ui)', fontSize: 12,
    color: 'var(--text-primary, #111318)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10, paddingBottom: 6,
    borderBottom: `2px solid ${NAVY}`,
  },
  title: { fontSize: 13, fontWeight: 700, color: NAVY, letterSpacing: 0.2 },
  twinTag: {
    fontSize: 10, fontWeight: 700, color: '#fff',
    background: AMBER, padding: '2px 6px', borderRadius: 3,
    letterSpacing: 0.4,
  },
  row: { marginBottom: 10 },
  rowHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    marginBottom: 4,
  },
  rowLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-primary, #111)' },
  rowValDeg: {
    fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
    fontVariantNumeric: 'tabular-nums', color: NAVY, fontWeight: 700,
  },
  rowValRad: {
    fontSize: 10, fontFamily: 'var(--font-mono, monospace)',
    fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted, #8A8F9E)',
    marginLeft: 4,
  },
  slider: { width: '100%', accentColor: NAVY, margin: 0 },
  limitStrip: {
    display: 'flex', justifyContent: 'space-between',
    fontSize: 9, color: 'var(--text-muted, #8A8F9E)',
    fontFamily: 'var(--font-mono, monospace)',
    marginTop: 1,
  },
  modeRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, marginBottom: 8, paddingBottom: 8,
    borderBottom: '1px dashed var(--border, rgba(0,0,0,0.09))',
  },
  modeToggle: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 600, color: NAVY, cursor: 'pointer',
  },
  gizmoMode: { display: 'flex', gap: 4 },
  modeBtn: {
    padding: '3px 8px', fontSize: 10, fontWeight: 600,
    background: '#fff', color: 'var(--text-secondary, #4B5063)',
    border: '1px solid var(--border, rgba(0,0,0,0.09))', borderRadius: 3,
    cursor: 'pointer', letterSpacing: 0.3,
  },
  modeBtnActive: {
    background: NAVY, color: '#fff', borderColor: NAVY,
  },
  // btnRow / resetBtn / homeBtn / tcpBox / tcpTitle / tcpRow /
  // tcpCell / tcpKey / tcpVal styles retired 2026-09-08 along with
  // the Reset / Home / TCP-box render blocks.
  empty: {
    fontSize: 11, color: 'var(--text-muted, #8A8F9E)',
    textAlign: 'center', padding: '18px 0',
  },
}

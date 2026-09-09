import { useEffect, useState } from 'react'
import FaceDownButton from './QuickOrientButtons'
// 2026-09-08 operator directive: Reset all / Home / Quick Orient
// row label / Face Side / Face Up / TCP (twin frame) box /
// JogSpeedSlider all retired. AMENDMENT: Face Down retained as a
// standalone TCP-preserving button (see QuickOrientButtons.jsx
// — file kept for git history + import continuity, now exports
// FaceDownButton default). Jog surface owns jog-speed as the ONE
// authority; `three` no longer imported here (TCP FK box gone).

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
  onAtLimit,     // fired by FaceDownButton when IK can't achieve
                 // the target within tolerance — parents can wire
                 // it to their own AT-LIMIT indicator.
}) {
  const [values, setValues] = useState([0, 0, 0, 0, 0, 0])
  // TWIN-POSING vs LIVE-FOLLOW indicator. `previewing` is true when
  // ANY of the six joint masks in StandaloneRobot are latched (i.e.,
  // operator dragged a slider or previewed Face Down). The panel
  // renders a small chip + Follow-Robot button so the operator always
  // has an obvious way back to LIVE-FOLLOW — no silent frozen state.
  const [previewing, setPreviewing] = useState(false)

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

  // Subscribe to StandaloneRobot's manual-mask signal so the chip +
  // Follow-Robot button track TWIN-POSING state without polling.
  useEffect(() => {
    if (!jogApi?.onManualMaskChange) return undefined
    const unsub = jogApi.onManualMaskChange((maskArr) => {
      setPreviewing(Array.isArray(maskArr) && maskArr.some(Boolean))
    })
    return unsub
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

  // Slider pointer released → return this joint to LIVE-FOLLOW. Fires
  // on pointerup AND on any interaction end that surrenders the input
  // (blur, lost pointer capture). The next store→robot mirror tick
  // seeds targets from the LATEST /joint_states, so the twin catches
  // up smoothly from wherever the preview left it.
  const onSlideEnd = (idx) => {
    jogApi?.releaseJointMask?.(idx)
  }

  const ready = !!jogApi?.robot?.joints

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div style={styles.title}>Joint Jog</div>
        <div style={styles.twinTag}>TWIN ONLY</div>
      </div>

      {/* LIVE-FOLLOW / TWIN-POSING banner. The twin viewer is either
          mirroring the real arm at WS stream rate (LIVE-FOLLOW,
          default) or held on an operator-set preview (TWIN-POSING,
          triggered by dragging any slider or by Face Down). The chip
          + Follow-Robot button guarantee there is no silent frozen
          state — a preview always has an obvious way back to live. */}
      <div
        data-testid="follow-state-banner"
        data-state={previewing ? 'twin-posing' : 'live-follow'}
        style={previewing ? styles.followBannerPosing : styles.followBannerLive}
      >
        <span aria-hidden="true"
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: previewing ? '#F59E0B' : '#22C55E',
                boxShadow: `0 0 4px ${previewing ? '#F59E0B' : '#22C55E'}`,
                marginRight: 6, display: 'inline-block',
              }} />
        <span style={{ flex: 1 }}>
          {previewing ? 'PREVIEWING (twin only)' : 'Live: mirroring real arm'}
        </span>
        {previewing && (
          <button
            data-testid="follow-robot-btn"
            type="button"
            onClick={() => jogApi?.followLive?.()}
            style={styles.followRobotBtn}
            title="Return twin to LIVE-FOLLOW — clears any operator-set preview.">
            Follow robot
          </button>
        )}
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

          {/* 2026-09-08 amendment: Face Down retained from the
              retired Quick Orient row. TCP-preserving orient to
              world -Y, slow fixed rate (~10°/s), refuses by name
              when IK can't achieve the pose without moving the
              tool point. Twin only in this commit — real-arm path
              is a follow-up (needs a new coordinated-orient
              backend endpoint; single-axis /cmd/jog pulses would
              drift the TCP, which the operator explicitly
              forbids). */}
          <FaceDownButton jogApi={jogApi} onAtLimit={onAtLimit} />
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
                  onPointerUp={() => onSlideEnd(i)}
                  onLostPointerCapture={() => onSlideEnd(i)}
                  onBlur={() => onSlideEnd(i)}
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
  followBannerLive: {
    display: 'flex', alignItems: 'center',
    padding: '4px 8px', marginBottom: 8,
    borderRadius: 4,
    background: 'rgba(34,197,94,0.10)',
    border: '1px solid rgba(34,197,94,0.40)',
    color: '#166534',
    fontSize: 10, fontWeight: 700,
    letterSpacing: 0.4, textTransform: 'uppercase',
  },
  followBannerPosing: {
    display: 'flex', alignItems: 'center',
    padding: '4px 8px', marginBottom: 8,
    borderRadius: 4,
    background: 'rgba(245,158,11,0.14)',
    border: '1px solid rgba(245,158,11,0.55)',
    color: '#78350F',
    fontSize: 10, fontWeight: 700,
    letterSpacing: 0.4, textTransform: 'uppercase',
  },
  followRobotBtn: {
    padding: '2px 8px', marginLeft: 6,
    fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: '#fff', background: '#059669',
    border: '1px solid #047857', borderRadius: 3,
    cursor: 'pointer', fontFamily: 'inherit',
  },
}

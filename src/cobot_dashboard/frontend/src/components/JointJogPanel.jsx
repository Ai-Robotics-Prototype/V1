import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import QuickOrientButtons from './QuickOrientButtons'
import JogSpeedSlider from './JogSpeedSlider'

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
  onHome,
  onAtLimit,   // (bool) called by QuickOrientButtons after its solve
}) {
  const [values, setValues] = useState([0, 0, 0, 0, 0, 0])
  const [tcp, setTcp] = useState(null)
  const linkRef = useRef(null)

  useEffect(() => {
    if (!jogApi?.robot?.joints) {
      linkRef.current = null
      return
    }
    // Prefer tool0 (injected on URDF load); fall back to link6 for
    // early-mount ordering where the injection hasn't run yet.
    linkRef.current = jogApi.robot.links?.tool0
                   || jogApi.robot.links?.link6
                   || null
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
    if (!jogApi) return undefined
    const mat  = new THREE.Matrix4()
    const pos  = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scl  = new THREE.Vector3()
    const eul  = new THREE.Euler()
    const id = setInterval(() => {
      const link = linkRef.current
      if (!link) return
      link.updateWorldMatrix(true, false)
      mat.copy(link.matrixWorld)
      mat.decompose(pos, quat, scl)
      eul.setFromQuaternion(quat, 'ZYX')
      // Also mirror the robot's current joint values into the sliders
      // so IK-driven motion shows up on the fine-tune controls without
      // remounting the panel. Only touches un-focused sliders (avoid
      // fighting the operator's drag).
      const j = jogApi.robot?.joints
      if (j) {
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
      }
      setTcp({
        x_mm: pos.x * 1000,
        y_mm: pos.y * 1000,
        z_mm: pos.z * 1000,
        rz_deg: rad2deg(eul.z),
        ry_deg: rad2deg(eul.y),
        rx_deg: rad2deg(eul.x),
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

  const onReset = () => {
    setValues([0, 0, 0, 0, 0, 0])
    jogApi?.resetAll?.()
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

          <div style={styles.btnRow}>
            <button style={styles.resetBtn} onClick={onReset}>
              Reset all → 0°
            </button>
            <button style={styles.homeBtn} onClick={() => onHome?.()}>
              Home
            </button>
          </div>

          <QuickOrientButtons jogApi={jogApi} onAtLimit={onAtLimit} />

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

          <div style={styles.tcpBox}>
            <div style={styles.tcpTitle}>TCP (TWIN FRAME) · tool0</div>
            <div style={styles.tcpRow}>
              <TcpCell k="X"  v={tcp ? `${tcp.x_mm.toFixed(1)} mm` : '—'} />
              <TcpCell k="Y"  v={tcp ? `${tcp.y_mm.toFixed(1)} mm` : '—'} />
              <TcpCell k="Z"  v={tcp ? `${tcp.z_mm.toFixed(1)} mm` : '—'} />
              <TcpCell k="Rz" v={tcp ? `${tcp.rz_deg.toFixed(1)}°` : '—'} />
              <TcpCell k="Ry" v={tcp ? `${tcp.ry_deg.toFixed(1)}°` : '—'} />
              <TcpCell k="Rx" v={tcp ? `${tcp.rx_deg.toFixed(1)}°` : '—'} />
            </div>
          </div>

          <JogSpeedSlider />
        </>
      )}
    </div>
  )
}

function TcpCell({ k, v }) {
  return (
    <div style={styles.tcpCell}>
      <span style={styles.tcpKey}>{k}</span>
      <span style={styles.tcpVal}>{v}</span>
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
  btnRow: {
    display: 'flex', gap: 6, marginBottom: 10,
  },
  resetBtn: {
    flex: 1, padding: '6px 10px',
    background: '#fff', color: NAVY, border: `1px solid ${NAVY}`,
    borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  homeBtn: {
    flex: 1, padding: '6px 10px',
    background: AMBER, color: '#fff', border: `1px solid ${AMBER}`,
    borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  tcpBox: {
    marginTop: 8, padding: 8,
    background: 'var(--bg-surface, #F7F8FA)',
    border: '1px solid var(--border, rgba(0,0,0,0.09))',
    borderRadius: 4,
  },
  tcpTitle: {
    fontSize: 10, fontWeight: 700, color: NAVY,
    letterSpacing: 0.6, marginBottom: 6,
  },
  tcpRow: {
    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
    gap: 6, fontSize: 11,
    fontFamily: 'var(--font-mono, monospace)',
    fontVariantNumeric: 'tabular-nums',
  },
  tcpCell: { display: 'flex', flexDirection: 'column', gap: 1 },
  tcpKey:  { fontSize: 9, color: 'var(--text-muted, #8A8F9E)', letterSpacing: 0.4 },
  tcpVal:  { color: 'var(--text-primary, #111)' },
  empty: {
    fontSize: 11, color: 'var(--text-muted, #8A8F9E)',
    textAlign: 'center', padding: '18px 0',
  },
}

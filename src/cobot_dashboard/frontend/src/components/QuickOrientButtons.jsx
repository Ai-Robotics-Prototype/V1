import { useStore } from '../store/useStore'
import * as THREE from 'three'
import {
  resolveTool,
  readToolWorldPose,
  readApproachWorld,
  orientApproachTo,
  solveIKToPose,
  measureAchievedError,
  measureAchievedApproach,
} from '../lib/orient'
import { durationForJogSpeed } from '../lib/jointAnim'

// Quick-orient buttons: FACE DOWN / FACE SIDE / FACE UP. Solves IK for
// the current TCP position with the flange approach axis rotated to
// the chosen world direction, then animates the twin to the solved
// pose in joint space with easeInOutCubic. Twin-only.
//
// Frame + axis contract (verified 2026-07-10):
//   - Scene is Y-up native (URDF_UP_AXIS = 'Y'). "Down" = scene -Y.
//   - Flange approach axis is joint_6's rotation axis transformed to
//     world (see lib/orient.js:readApproachWorld). Works regardless
//     of local-frame convention — no assumptions about local X/Y/Z.
//
// AT LIMIT feedback: after the solver returns, we compare the achieved
// FK against the requested pose. If the residual exceeds the shared
// AT-LIMIT thresholds, we fire onAtLimit(true) so the parent viewer's
// existing AT LIMIT badge (from the IK-gizmo path) lights up.
//
// Every click prints a diagnostic block to the console:
//   [quick-orient] preset=<key>
//     current approach world = [x, y, z]
//     target  approach world = [x, y, z]
//     achieved approach world = [x, y, z]
//     posErr = <m>  rotErr = <rad>  atLimit = <bool>
// Use this to verify the fix — Face Down should print achieved ≈ [0,-1,0].
//
// TODO(motion): when commanded motion is enabled (write-command format
// captured on the Codroid v2.3 wire, joint-direction signs verified
// end-to-end, pendant in Remote mode), this handler also publishes
// the target joint vector to /estun/move at jog-speed — currently
// twin-only. See estun_driver's global_speed_cap_pct for the server-
// side ceiling. Do NOT flip that on without an explicit safety
// review; monitor_only stays true.

// Same thresholds the IK gizmo uses for its sticky-boundary snap.
const AT_LIMIT_POS_M   = 0.003
const AT_LIMIT_ROT_RAD = 0.02

const PRESETS = [
  { key: 'down', label: 'Face Down',
    // Scene Y is up, so floor = -Y.
    targetApproach: new THREE.Vector3(0, -1, 0),
    color: '#0284c7',
    hint: 'Flange approach → world -Y (floor)' },
  { key: 'side', label: 'Face Side',
    // Deterministic horizontal: scene +X. Labeled clearly.
    targetApproach: new THREE.Vector3(1, 0, 0),
    color: '#0891b2',
    hint: 'Flange approach → world +X (horizontal)' },
  { key: 'up',   label: 'Face Up',
    targetApproach: new THREE.Vector3(0, 1, 0),
    color: '#0ea5e9',
    hint: 'Flange approach → world +Y (ceiling)' },
]

function fmt(v) {
  if (!v || typeof v.x !== 'number') return String(v)
  return `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`
}

export default function QuickOrientButtons({ jogApi, onAtLimit }) {
  const jogSpeedPct = useStore((s) => s.jogSpeedPct)
  const ready = !!jogApi?.robot?.joints && !!jogApi?.runJointAnimation

  const handleClick = (preset) => {
    if (!ready) return
    const robot = jogApi.robot
    const tool  = resolveTool(robot)
    if (!tool) return

    // Snapshot current pose + approach direction.
    const { pos: currentPos, quat: currentQuat } = readToolWorldPose(tool)
    const currentApproachWorld = readApproachWorld(robot)

    // Build the target world quaternion by rotating the approach axis.
    const targetApproachWorld = preset.targetApproach.clone().normalize()
    const targetQuat = orientApproachTo(
      currentQuat, currentApproachWorld, targetApproachWorld,
    )

    // Solve one-shot IK to the (currentPos, targetQuat) pose.
    const q_target = solveIKToPose(robot, tool, currentPos, targetQuat)
    if (!q_target || q_target.length !== 6) {
      console.warn(`[quick-orient] ${preset.key}: solveIKToPose returned nothing`)
      return
    }

    // Measure residuals and the achieved approach direction.
    const { posErr, rotErr } = measureAchievedError(
      robot, tool, q_target, currentPos, targetQuat,
    )
    const achievedApproach = measureAchievedApproach(robot, q_target)
    const atLimit = posErr > AT_LIMIT_POS_M || rotErr > AT_LIMIT_ROT_RAD

    // eslint-disable-next-line no-console
    console.log(
      `[quick-orient] preset=${preset.key}\n` +
      `  current  approach world = ${fmt(currentApproachWorld)}\n` +
      `  target   approach world = ${fmt(targetApproachWorld)}\n` +
      `  achieved approach world = ${fmt(achievedApproach)}\n` +
      `  posErr = ${posErr.toExponential(2)} m   rotErr = ${rotErr.toExponential(2)} rad   atLimit = ${atLimit}\n` +
      `  q_target = [${q_target.map((v) => (v * 180 / Math.PI).toFixed(1)).join(', ')}]°`
    )

    onAtLimit?.(atLimit)

    const duration = durationForJogSpeed(jogSpeedPct)
    jogApi.runJointAnimation(q_target, duration)
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.label}>Quick orient (twin only)</div>
      <div style={styles.row}>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={!ready}
            title={p.hint}
            onClick={() => handleClick(p)}
            style={{
              ...styles.btn,
              borderColor: p.color,
              color:       ready ? p.color : '#94a3b8',
              cursor:      ready ? 'pointer' : 'not-allowed',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: {
    fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)',
    letterSpacing: '0.06em',
  },
  row: { display: 'flex', gap: 6 },
  btn: {
    flex: 1,
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.2,
    fontFamily: 'inherit',
  },
}

import { useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ArmViewer3D from '../components/ArmViewer3D'
import StandaloneRobot from '../components/StandaloneRobot'
import JointJogPanel from '../components/JointJogPanel'
import IKGizmo from '../components/IKGizmo'

// The LiDAR identified-objects overlay previously mounted here has
// been removed from the 3D twin scene — the floating labels + boxes
// cluttered the twin view. The identification pipeline still runs
// (roboai-lidar-identifier publishes /lidar_objects/identified) and
// the data is consumed by the Monitor tab's IdentifiedObjectsCard,
// PartsLibrary, WorkspaceMaskSection, and /api/lidar_objects/*. This
// twin viewer is now robot + collision + IK gizmo only.

const PRESETS = ['Front', 'Side', 'Top', 'Iso']

function LeftPanel({ armRef }) {
  // Joint angles + Gripper + TCP-pose readouts were intentionally
  // removed: the joint table duplicated the (since-removed) top-right
  // chip in the canvas, the TCP "pose" was a rough analytic-FK
  // approximation that didn't match the URDF, and the gripper state
  // is already surfaced on the Monitor + Program tabs. The LiDAR
  // identified-objects section was removed with the overlay itself —
  // see the top-of-file note. The panel now hosts only camera presets
  // and the current task state.
  const task = useStore((s) => s.task)

  return (
    <div style={{
      width: 240,
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      padding: '12px 14px',
      gap: 14,
    }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
          3D Robot View
        </div>

        {/* Camera presets */}
        <div>
          <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
            Camera
          </div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => armRef.current?.setCameraPreset(p.toLowerCase())}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-secondary)',
                  padding: '3px 10px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Task state */}
      <div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>
          Task
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          State:&nbsp;
          <span style={{
            fontWeight: 600,
            color: task.state === 'IDLE' ? 'var(--text-muted)'
                : task.state === 'PAUSED' ? 'var(--yellow)'
                : 'var(--accent)',
          }}>
            {task.state}
          </span>
        </div>
      </div>

    </div>
  )
}

export default function View3DLayout() {
  const armRef = useRef(null)
  // FK jog handle exposed by StandaloneRobot once its URDF resolves.
  // Drives JointJogPanel below without re-parsing anything.
  const [jogApi, setJogApi] = useState(null)
  // Cartesian-drag state for the 3D View tab's gizmo. Program tab has
  // its own copy inside ArmViewer3D; the two viewers don't share.
  const [cartMode, setCartMode]     = useState(false)
  const [gizmoMode, setGizmoMode]   = useState('translate')
  // AT LIMIT indicator — IKGizmo emits atLimit each frame the drag
  // advances, cleared on drag-release. Ref-not-state to avoid a re-
  // render every RAF; a small ticker below flips the visible state
  // only when the flag changes.
  const [ikAtLimit, setIkAtLimit] = useState(false)

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <LeftPanel armRef={armRef} />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <ArmViewer3D ref={armRef} noRobot>
          <StandaloneRobot onRobotReady={setJogApi} />
          {cartMode && (
            <IKGizmo
              jogApi={jogApi}
              enabled
              mode={gizmoMode}
              onDragChange={(d) => {
                armRef.current?.setOrbitEnabled?.(!d)
                if (!d) setIkAtLimit(false)   // clear on release
              }}
              onTargetPose={(p) => {
                if (!!p.atLimit !== ikAtLimit) setIkAtLimit(!!p.atLimit)
              }}
            />
          )}
        </ArmViewer3D>
        {cartMode && ikAtLimit && (
          <div style={{
            position: 'absolute', top: 8, right: 8, zIndex: 20,
            padding: '4px 10px', borderRadius: 4,
            background: '#DC2626', color: '#fff',
            fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
            fontWeight: 700, letterSpacing: 0.6,
            boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
          }}>
            AT LIMIT
          </div>
        )}
        <JointJogPanel
          jogApi={jogApi}
          cartesianMode={cartMode}
          onCartesianModeChange={setCartMode}
          gizmoMode={gizmoMode}
          onGizmoModeChange={setGizmoMode}
          onHome={() => jogApi?.home?.()}
          onAtLimit={(atLimit) => setIkAtLimit(!!atLimit)}
        />
      </div>
    </div>
  )
}

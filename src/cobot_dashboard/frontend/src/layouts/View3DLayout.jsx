import { useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ArmViewer3D from '../components/ArmViewer3D'
import LidarObjectsOverlay from '../components/LidarObjectsOverlay'
import StandaloneRobot from '../components/StandaloneRobot'

const PRESETS = ['Front', 'Side', 'Top', 'Iso']

function ToggleRow({ label, checked, onChange }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer',
    }}>
      <span>{label}</span>
      <input type="checkbox" checked={checked}
             onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function LidarLayerSection({ controls, setControls, lastPick }) {
  return (
    <div>
      <div style={{
        fontSize: 9, textTransform: 'uppercase', color: 'var(--text-muted)',
        letterSpacing: '0.06em', marginBottom: 6,
      }}>
        Identified Objects (LiDAR)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <ToggleRow label="Show Identified Objects"
                   checked={controls.show}
                   onChange={(v) => setControls({ ...controls, show: v })} />
        <ToggleRow label="Show Tentative"
                   checked={controls.tentative}
                   onChange={(v) => setControls({ ...controls, tentative: v })} />
        <ToggleRow label="Show Unknown"
                   checked={controls.unknown}
                   onChange={(v) => setControls({ ...controls, unknown: v })} />
        <ToggleRow label="Show Confidence Labels"
                   checked={controls.labels}
                   onChange={(v) => setControls({ ...controls, labels: v })} />
        <ToggleRow label="Group by Part Type"
                   checked={controls.groupByPart}
                   onChange={(v) => setControls({ ...controls, groupByPart: v })} />
      </div>
      {lastPick && (
        <div style={{
          marginTop: 8, padding: '6px 8px', borderRadius: 4,
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {lastPick.identified_name || 'unknown'}
          </div>
          <div>Confidence: {Math.round(lastPick.confidence * 100)}%</div>
          <div>Size {Math.round((lastPick.size_match_score || 0) * 100)}% ·
            Shape {Math.round((lastPick.shape_match_score || 0) * 100)}%</div>
          <div>Frames observed: {lastPick.frames_observed}</div>
        </div>
      )}
    </div>
  )
}

function LeftPanel({ armRef, lidarControls, setLidarControls, lastPick }) {
  // Joint angles + Gripper + TCP-pose readouts were intentionally
  // removed: the joint table duplicated the (since-removed) top-right
  // chip in the canvas, the TCP "pose" was a rough analytic-FK
  // approximation that didn't match the URDF, and the gripper state
  // is already surfaced on the Monitor + Program tabs. The panel now
  // hosts only what's unique to this view: camera presets + the
  // current task state + the LiDAR layer controls.
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

      <LidarLayerSection
        controls={lidarControls}
        setControls={setLidarControls}
        lastPick={lastPick}
      />
    </div>
  )
}

export default function View3DLayout() {
  const armRef = useRef(null)
  const [lidarControls, setLidarControls] = useState({
    show: true, tentative: true, unknown: false,
    labels: true, groupByPart: false,
  })
  const [lastPick, setLastPick] = useState(null)

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <LeftPanel armRef={armRef}
                 lidarControls={lidarControls}
                 setLidarControls={setLidarControls}
                 lastPick={lastPick} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ArmViewer3D ref={armRef} noRobot>
          <StandaloneRobot />
          {lidarControls.show && (
            <LidarObjectsOverlay
              showTentative={lidarControls.tentative}
              showUnknown={lidarControls.unknown}
              showLabels={lidarControls.labels}
              groupByPartType={lidarControls.groupByPart}
              onPick={setLastPick}
            />
          )}
        </ArmViewer3D>
      </div>
    </div>
  )
}

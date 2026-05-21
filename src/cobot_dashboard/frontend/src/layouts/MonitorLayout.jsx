import CameraPanel      from '../components/CameraPanel'
import LidarPanel       from '../components/LidarPanel'
import ProgramPanel     from '../components/ProgramPanel'
import ControlStrip     from '../components/ControlStrip'
import SceneGraphPanel  from '../components/SceneGraphPanel'
import TaskFlowPanel    from '../components/TaskFlowPanel'
import VoiceCommandBar  from '../components/VoiceCommandBar'

export default function MonitorLayout() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden', padding: 8, gap: 8,
    }}>
      {/* Main 4-column area */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 28% 18%',
        gap: 8,
      }}>
        {/* CAM 0 */}
        <CameraPanel cam={0} />

        {/* CAM 1 */}
        <CameraPanel cam={1} />

        {/* LiDAR top-down */}
        <LidarPanel />

        {/* Right column: AI panels stacked */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', minWidth: 0 }}>
          <SceneGraphPanel />
          <TaskFlowPanel />
          <VoiceCommandBar />
          <div style={{ flex: 1, minHeight: 0 }}>
            <ProgramPanel />
          </div>
        </div>
      </div>

      {/* Bottom: ControlStrip full width */}
      <ControlStrip />
    </div>
  )
}

import CameraPanel  from '../components/CameraPanel'
import LidarPanel   from '../components/LidarPanel'
import ProgramPanel from '../components/ProgramPanel'
import ControlStrip from '../components/ControlStrip'

export default function MonitorLayout() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden', padding: 8, gap: 8,
    }}>
      {/* Main three-column area */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: '1fr 30% 20%',
        gap: 8,
      }}>
        {/* Left 50%: dual cameras side by side */}
        <div style={{ display: 'flex', gap: 8, overflow: 'hidden', minWidth: 0 }}>
          <CameraPanel cam={0} />
          <CameraPanel cam={1} />
        </div>

        {/* Middle 30%: LiDAR top-down */}
        <LidarPanel />

        {/* Right 20%: Program builder */}
        <ProgramPanel />
      </div>

      {/* Bottom: ControlStrip full width */}
      <ControlStrip />
    </div>
  )
}

import CameraPanel from '../components/CameraPanel'
import LidarPanel from '../components/LidarPanel'
import IOPanel from '../components/IOPanel'

export default function SensorsLayout() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      height: '100%',
      overflow: 'hidden',
      gap: 0,
    }}>
      {/* Top-left: Camera 0 */}
      <div style={{ borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <CameraPanel cam={0} />
      </div>

      {/* Top-right: Camera 1 */}
      <div style={{ borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
        <CameraPanel cam={1} />
      </div>

      {/* Bottom-left: LiDAR */}
      <div style={{ borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
        <LidarPanel />
      </div>

      {/* Bottom-right: I/O panel (Estun S10-140 digital + analog signals) */}
      <div style={{ overflow: 'hidden' }}>
        <IOPanel />
      </div>
    </div>
  )
}

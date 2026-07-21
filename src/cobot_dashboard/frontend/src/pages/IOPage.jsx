import IOPanel   from '../components/IOPanel'
import IOPortMap from '../components/IOPortMap'

// IOPortMap and IOPanel each manage their own inner padding; the page
// just gives them a shared scrolling white surface.
export default function IOPage() {
  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'auto',
      background: '#fff',
      display: 'flex', flexDirection: 'column',
      padding: '14px 14px 0',
      boxSizing: 'border-box',
    }}>
      <IOPortMap />
      <IOPanel />
    </div>
  )
}

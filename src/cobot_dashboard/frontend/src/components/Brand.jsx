export const BRAND_NAME = 'NeuRobots'

export default function Brand({ style }) {
  return (
    <span style={{ fontWeight: 700, letterSpacing: '0.01em', ...style }}>
      {BRAND_NAME}
    </span>
  )
}

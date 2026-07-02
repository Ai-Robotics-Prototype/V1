import { Component } from 'react'

// Reusable inline error boundary modelled on SensorErrorBoundary
// (layouts/SensorsLayout.jsx). Catches render errors in any panel /
// subtree and shows a graceful "section failed — retry" card instead
// of crashing the whole tab to the App-level "React Render Error".
//
// Caveats:
//  - Only catches render / lifecycle / constructor errors. Event
//    handlers, async effects, and store-update side effects are NOT
//    caught (React's design) — guard those at the call site.
//  - The boundary itself must not throw in its own render, so the
//    fallback below is intentionally trivial.
export default class PanelErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) {
    return { err }
  }
  componentDidCatch(err, info) {
    // eslint-disable-next-line no-console
    console.error(`[PanelErrorBoundary:${this.props.label || 'panel'}]`,
      err, info?.componentStack)
  }
  retry = () => this.setState({ err: null })
  render() {
    if (!this.state.err) return this.props.children
    const label = this.props.label || 'section'
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 10,
        background: '#0b1018', color: '#e2e8f0',
        padding: 16, textAlign: 'center',
      }}>
        <span style={{ fontSize: 28 }}>⚠️</span>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {`${label} failed to render`}
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', maxWidth: 420 }}>
          {String(this.state.err?.message || this.state.err || 'unknown error')}
        </div>
        <button onClick={this.retry} style={{
          marginTop: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600,
          background: '#1f2937', color: '#e5e7eb',
          border: '1px solid #334155', borderRadius: 6, cursor: 'pointer',
        }}>Retry</button>
      </div>
    )
  }
}

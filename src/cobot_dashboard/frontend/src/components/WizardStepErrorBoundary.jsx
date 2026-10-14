import { Component } from 'react'

// Per-step error boundary for ProgramWizard pages. Isolates a single
// PAGES[i].render failure so the wizard shell (header, progress bar,
// back button, close) stays interactive instead of blanking the whole
// prompt — the 2026-10-14 payload-step field report (operator saw a
// white screen after reaching the tool/payload step) traces back to
// an unhandled render error inside a page's render function
// propagating up past the overlay root. Belt-and-braces alongside the
// per-field value guards in each step; the boundary catches the next
// one, so an operator never sees a dead wizard again.
//
// resetKey — pass the page index. React re-mounts the boundary when
// the key changes, so navigating to a different step clears the
// error state automatically.
export default class WizardStepErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) {
    // eslint-disable-next-line no-console
    console.error(`[WizardStepErrorBoundary:${this.props.stepId || '?'}]`,
      err, info?.componentStack)
  }
  retry = () => this.setState({ err: null })
  render() {
    if (!this.state.err) return this.props.children
    const stepId = this.props.stepId || 'this step'
    const onBack = this.props.onBack
    return (
      <div data-testid="wizard-step-error"
           style={{ padding: 32, maxWidth: 600, margin: '0 auto' }}>
        <div style={{
          padding: 16, background: '#FEF2F2',
          border: '1px solid #FCA5A5', borderRadius: 10,
          color: '#7F1D1D',
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
            Something went wrong on this step
          </div>
          <div style={{ fontSize: 13, color: '#991B1B', lineHeight: 1.5 }}>
            The <code>{stepId}</code> step hit an unexpected error and
            couldn’t render. Try again, or go back a step and re-enter.
          </div>
          <div style={{
            marginTop: 10, fontSize: 12, color: '#991B1B',
            fontFamily: 'monospace', wordBreak: 'break-word',
          }}>
            {String(this.state.err?.message || this.state.err || 'unknown error')}
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
            <button onClick={this.retry} style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              background: '#DC2626', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
            }}>Try again</button>
            {onBack && (
              <button onClick={onBack} style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 600,
                background: '#fff', color: '#991B1B',
                border: '1px solid #FCA5A5', borderRadius: 6, cursor: 'pointer',
              }}>Back</button>
            )}
          </div>
        </div>
      </div>
    )
  }
}

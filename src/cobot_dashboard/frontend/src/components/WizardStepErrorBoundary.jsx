import { Component } from 'react'

// Per-step error boundary for ProgramWizard pages. Isolates a single
// PAGES[i].render failure so the wizard shell (header, progress bar,
// back button, close) stays interactive instead of blanking the whole
// prompt — the 2026-10-14 payload-step field report (tablet-only
// blank screen on the merged tool/payload step).
//
// Belt-and-braces: on the tablet, errors are ALSO forwarded to the
// index.html global error overlay via window.__cobotReportError so a
// render error that happens to blow up this boundary's own render
// still produces a visible message. The in-boundary fallback below
// uses zero optional chaining and zero template literals in the
// render path so it cannot itself trip on an older browser engine.
//
// resetKey — pass the page index. React re-mounts the boundary when
// the key changes, so navigating to a different step clears the
// error state automatically.
export default class WizardStepErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null, info: null }
    this.retry = this.retry.bind(this)
  }
  static getDerivedStateFromError(err) { return { err: err, info: null } }
  componentDidCatch(err, info) {
    this.setState({ info: info || null })
    var cs = (info && info.componentStack) || ''
    var msg = (err && err.message) || String(err)
    var stack = (err && err.stack) || ''
    // eslint-disable-next-line no-console
    console.error('[WizardStepErrorBoundary:' +
      ((this.props && this.props.stepId) || '?') + '] ' + msg, err, cs)
    try {
      if (typeof window !== 'undefined' &&
          typeof window.__cobotReportError === 'function') {
        window.__cobotReportError(
          'WizardStep ' + ((this.props && this.props.stepId) || '?'),
          msg, '', stack + '\n' + cs)
      }
    } catch (_e) { /* never let the reporter re-throw */ }
  }
  retry() { this.setState({ err: null, info: null }) }
  render() {
    if (!this.state.err) return this.props.children
    var err = this.state.err
    var info = this.state.info
    var stepId = (this.props && this.props.stepId) || 'this step'
    var onBack = (this.props && this.props.onBack) || null
    var msg = (err && err.message) ? err.message : String(err)
    var stack = (err && err.stack) ? String(err.stack) : ''
    var cs = (info && info.componentStack) ? String(info.componentStack) : ''
    return (
      <div data-testid="wizard-step-error"
           style={{ padding: 24, maxWidth: 640, margin: '0 auto' }}>
        <div style={{
          padding: 16, background: '#FEF2F2',
          border: '2px solid #F87171', borderRadius: 10,
          color: '#7F1D1D',
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
            Something went wrong on this step
          </div>
          <div style={{ fontSize: 13, color: '#991B1B',
                        lineHeight: 1.5, marginBottom: 10 }}>
            Step id: <b>{stepId}</b>. The error is shown below so you can
            screenshot or copy it. Try again, or go back a step.
          </div>
          <div style={{
            padding: 10, background: '#fff',
            border: '1px solid #FCA5A5', borderRadius: 6,
            fontSize: 12, color: '#7F1D1D',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 240, overflowY: 'auto',
          }}>
            {msg}
            {stack ? '\n\n' + stack : ''}
            {cs   ? '\n\n' + cs    : ''}
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
            <button onClick={this.retry} style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              background: '#DC2626', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
            }}>Try again</button>
            {onBack ? (
              <button onClick={onBack} style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 600,
                background: '#fff', color: '#991B1B',
                border: '1px solid #FCA5A5', borderRadius: 6, cursor: 'pointer',
              }}>Back</button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }
}

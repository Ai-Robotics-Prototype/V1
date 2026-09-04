import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'

const TYPE_COLORS = {
  success: 'var(--green)',
  error:   'var(--red)',
  warning: 'var(--yellow)',
  info:    'var(--accent)',
}

function Toast({ toast, onRemove }) {
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    // Trigger slide-in
    const t = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(t)
  }, [])

  function dismiss() {
    setLeaving(true)
    setTimeout(() => onRemove(toast.id), 280)
  }

  // Structured content (2026-08-04). Prefer title/detail from the
  // structured toast API; fall back to `message` (legacy 2-arg
  // callers). Each string renders EXACTLY ONCE — no concatenation.
  // technicalDetail (raw wire reason: firmware bug numbers,
  // mm2mAndDeg2rad, sha hashes, etc) is demoted behind a "Details"
  // toggle so the operator's default view is operator-language
  // only.
  const title  = toast.title  || toast.message || ''
  const detail = toast.detail || ''
  const tech   = toast.technicalDetail || ''

  return (
    <div
      data-testid="toast"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 0,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${TYPE_COLORS[toast.type] ?? 'var(--accent)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '8px 10px',
        minWidth: 220,
        maxWidth: 360,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        transform: visible && !leaving ? 'translateX(0)' : 'translateX(110%)',
        opacity: visible && !leaving ? 1 : 0,
        transition: 'transform 280ms cubic-bezier(0.16,1,0.3,1), opacity 280ms',
      }}
    >
      <div style={{
        flex: 1,
        fontSize: 13,
        color: 'var(--text-primary)',
        lineHeight: 1.4,
        wordBreak: 'break-word',
      }}>
        <div data-testid="toast-title"
             style={{ fontWeight: detail || tech ? 600 : 400 }}>
          {title}
          {toast.repeatCount > 1 && (
            <span data-testid="toast-repeat-count"
                  style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    background: 'var(--surface-muted, #e5e7eb)',
                    color: 'var(--text-muted, #4b5563)',
                  }}>
              ×{toast.repeatCount}
            </span>
          )}
        </div>
        {detail && (
          <div data-testid="toast-detail"
               style={{ marginTop: 4, fontWeight: 400,
                        color: 'var(--text-secondary, #6b7280)' }}>
            {detail}
          </div>
        )}
        {tech && (
          <div style={{ marginTop: 6 }}>
            <button
              data-testid="toast-details-toggle"
              onClick={(e) => {
                e.stopPropagation()
                setDetailsOpen((v) => !v)
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted, #9ca3af)',
                fontSize: 11,
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              {detailsOpen ? 'Hide details' : 'Details'}
            </button>
            {detailsOpen && (
              <div data-testid="toast-technical-detail"
                   style={{ marginTop: 4, fontSize: 11,
                            fontFamily: 'ui-monospace, monospace',
                            color: 'var(--text-muted, #9ca3af)',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word' }}>
                {tech}
              </div>
            )}
          </div>
        )}
      </div>
      <button
        onClick={dismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: 14,
          lineHeight: 1,
          cursor: 'pointer',
          padding: '0 0 0 8px',
          flexShrink: 0,
        }}
        title="Dismiss"
      >
        ×
      </button>
    </div>
  )
}

export default function ToastContainer() {
  const toasts      = useStore((s) => s.toasts)
  const removeToast = useStore((s) => s.removeToast)

  return (
    <div style={{
      position: 'fixed',
      top: 56,
      right: 16,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.map((toast) => (
        <div key={toast.id} style={{ pointerEvents: 'auto' }}>
          <Toast toast={toast} onRemove={removeToast} />
        </div>
      ))}
    </div>
  )
}

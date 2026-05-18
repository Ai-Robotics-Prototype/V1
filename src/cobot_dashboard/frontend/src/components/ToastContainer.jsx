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

  useEffect(() => {
    // Trigger slide-in
    const t = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(t)
  }, [])

  function dismiss() {
    setLeaving(true)
    setTimeout(() => onRemove(toast.id), 280)
  }

  return (
    <div
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
        maxWidth: 320,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        transform: visible && !leaving ? 'translateX(0)' : 'translateX(110%)',
        opacity: visible && !leaving ? 1 : 0,
        transition: 'transform 280ms cubic-bezier(0.16,1,0.3,1), opacity 280ms',
      }}
    >
      <span style={{
        flex: 1,
        fontSize: 13,
        color: 'var(--text-primary)',
        lineHeight: 1.4,
        wordBreak: 'break-word',
      }}>
        {toast.message}
      </span>
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

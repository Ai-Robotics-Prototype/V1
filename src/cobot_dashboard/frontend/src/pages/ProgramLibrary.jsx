import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../store/useStore'

export default function ProgramLibrary() {
  const setTab             = useStore((s) => s.setTab)
  const setLoadedProgram   = useStore((s) => s.setLoadedProgram)
  const addToast           = useStore((s) => s.addToast)
  const [programs, setPrograms] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [busyId, setBusyId]     = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/programs')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setPrograms(data.programs || [])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function callAction(method, url, id) {
    setBusyId(id)
    try {
      const res = await fetch(url, { method })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 120)}` : ''}`)
      }
      return await res.json().catch(() => ({}))
    } catch (e) {
      setError(e.message || String(e))
      return null
    } finally {
      setBusyId(null)
    }
  }

  async function handleRun(p) {
    const ok = await callAction('POST', `/api/programs/${encodeURIComponent(p.id)}/run`, p.id)
    if (ok) setTab('program')
  }

  async function handleEdit(p) {
    setBusyId(p.id)
    setError(null)
    try {
      const res = await fetch(`/api/programs/${encodeURIComponent(p.id)}`)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 120)}` : ''}`)
      }
      const prog = await res.json()
      if (!prog || !Array.isArray(prog.steps)) {
        throw new Error('program payload missing steps')
      }
      setLoadedProgram(prog)
      setTab('program')
      addToast(`Loaded "${prog.name || p.name}" into editor`, 'success')
    } catch (e) {
      setError(e.message || String(e))
      addToast(`Edit failed: ${e.message || e}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDuplicate(p) {
    const ok = await callAction('POST', `/api/programs/${encodeURIComponent(p.id)}/duplicate`, p.id)
    if (ok) load()
  }

  async function handleDelete(p) {
    if (!confirm(`Delete program "${p.name}"?`)) return
    const ok = await callAction('DELETE', `/api/programs/${encodeURIComponent(p.id)}`, p.id)
    if (ok) load()
  }

  async function handleNew() {
    const name = prompt('New program name:')
    if (!name) return
    const ok = await callAction('POST', '/api/programs', null)
    if (ok) load()
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: 'var(--bg-app)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Program Library
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {loading ? 'loading…' : `${programs.length} program${programs.length === 1 ? '' : 's'}`}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={load}
          disabled={loading}
          style={btnSecondary}
        >
          Refresh
        </button>
        <button
          onClick={handleNew}
          style={btnPrimary}
        >
          + New Program
        </button>
      </div>

      {error && (
        <div style={{
          padding: '8px 16px',
          background: '#2a1010',
          borderBottom: '1px solid #5a1f1f',
          color: '#fca5a5',
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
        }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {programs.length === 0 && !loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 40 }}>
            No saved programs yet.
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}>
            {programs.map((p) => (
              <div
                key={p.id}
                style={{
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md, 6px)',
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  opacity: busyId === p.id ? 0.5 : 1,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', minHeight: 16 }}>
                  {p.description || '—'}
                </div>
                <div style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  display: 'flex',
                  gap: 12,
                }}>
                  <span>id: {p.id}</span>
                  <span>steps: {p.steps ?? 0}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => handleRun(p)}
                    disabled={busyId === p.id}
                    style={btnPrimary}
                  >
                    Run
                  </button>
                  <button
                    onClick={() => handleEdit(p)}
                    disabled={busyId === p.id || p.builtin}
                    title={p.builtin ? 'Built-in templates are read-only — duplicate or use the wizard to make an editable copy' : 'Open in Program editor'}
                    style={p.builtin ? { ...btnSecondary, opacity: 0.4, cursor: 'not-allowed' } : btnEdit}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDuplicate(p)}
                    disabled={busyId === p.id}
                    style={btnSecondary}
                  >
                    Duplicate
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={busyId === p.id || p.builtin}
                    title={p.builtin ? 'Built-in templates cannot be deleted' : 'Delete program'}
                    style={p.builtin ? { ...btnDanger, opacity: 0.3, cursor: 'not-allowed' } : btnDanger}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const btnBase = {
  fontSize: 12,
  padding: '5px 12px',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
  border: '1px solid var(--border)',
}

const btnPrimary = {
  ...btnBase,
  background: 'var(--accent, #2563eb)',
  borderColor: 'transparent',
  color: '#fff',
  fontWeight: 500,
}

const btnSecondary = {
  ...btnBase,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
}

const btnDanger = {
  ...btnBase,
  background: 'transparent',
  borderColor: '#7f1d1d',
  color: '#fca5a5',
}

const btnEdit = {
  ...btnBase,
  background: '#eff6ff',
  borderColor: '#bfdbfe',
  color: '#2563EB',
  fontWeight: 600,
}

import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store/useStore'

function EditableText({ value, onSave, style }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => {
    if (editing && ref.current) { ref.current.focus(); ref.current.select() }
  }, [editing])

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input ref={ref} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          ...style,
          border: '1px solid #2563EB',
          borderRadius: 4,
          padding: '2px 6px',
          outline: 'none',
          background: '#fff',
        }} />
    )
  }
  return (
    <span
      onDoubleClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}
      title="Double-click to rename"
      style={{ ...style, cursor: 'text' }}>
      {value}
    </span>
  )
}

function ProgramCard({ prog, onEdit, onDuplicate, onDelete }) {
  const [showDetails, setShowDetails] = useState(false)
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('programId', prog.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      style={{
        padding: '12px 14px', marginBottom: 6, borderRadius: 8,
        background: '#fff', border: '1px solid #e5e7eb',
        cursor: 'grab', transition: 'box-shadow 100ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)' }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{prog.name}</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            {prog.steps} step{prog.steps !== 1 ? 's' : ''}
            {prog.description ? ' — ' + prog.description.slice(0, 40) : ''}
          </div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); setShowDetails(!showDetails) }} style={{
          padding: '4px 10px', fontSize: 10, fontWeight: 600,
          background: '#f3f4f6', color: '#374151',
          border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
        }}>{showDetails ? 'Hide' : 'Details'}</button>
      </div>

      {showDetails && (
        <div style={{
          marginTop: 10, padding: '10px 12px', background: '#f8fafc',
          borderRadius: 6, border: '1px solid #e5e7eb',
        }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
            <strong>Last edited:</strong> {prog.updated || prog.created || 'Unknown'}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
            <strong>Created:</strong> {prog.created || 'Unknown'}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
            <strong>Steps:</strong> {prog.steps}
          </div>
          {prog.tags && prog.tags.length > 0 && (
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
              <strong>Tags:</strong> {prog.tags.join(', ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button onClick={(e) => { e.stopPropagation(); onEdit(prog.id) }} style={detailBtn('#eff6ff', '#2563EB', '#bfdbfe')}>Edit</button>
            <button onClick={(e) => { e.stopPropagation(); onDuplicate(prog.id) }} style={detailBtn('#f3f4f6', '#374151', '#d1d5db')}>Duplicate</button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(prog.id) }} style={detailBtn('#fef2f2', '#DC2626', '#fecaca')}>Delete</button>
          </div>
        </div>
      )}
    </div>
  )
}

function detailBtn(bg, color, border) {
  return {
    padding: '6px 14px', fontSize: 11, fontWeight: 600,
    background: bg, color, border: `1px solid ${border}`,
    borderRadius: 5, cursor: 'pointer',
  }
}

function FolderCard({ folder, programs, onRename, onDelete, onDrop, onEditProgram, onDuplicateProgram, onDeleteProgram, expanded, onToggle }) {
  const [dragOver, setDragOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const progId = e.dataTransfer.getData('programId')
        if (progId) onDrop(progId, folder.id)
      }}
      style={{
        marginBottom: 8, borderRadius: 10,
        border:    dragOver ? '2px dashed #2563EB' : '2px solid #e5e7eb',
        background: dragOver ? '#eff6ff'           : '#fafafa',
        transition: 'all 150ms',
      }}>
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px', cursor: 'pointer',
      }}>
        <span style={{ fontSize: 14, color: '#CA8A04', flexShrink: 0, fontFamily: 'monospace' }}>
          {expanded ? '▾' : '▸'}
        </span>
        <EditableText value={folder.name}
          onSave={(name) => onRename(folder.id, name)}
          style={{ fontSize: 14, fontWeight: 700, color: '#111', flex: 1 }} />
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {programs.length} program{programs.length !== 1 ? 's' : ''}
        </span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(folder.id) }} style={{
          padding: '3px 8px', fontSize: 10, background: '#fef2f2', color: '#DC2626',
          border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer',
        }}>Del</button>
      </div>

      {expanded && (
        <div style={{ padding: '0 14px 12px 36px' }}>
          {programs.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0', fontStyle: 'italic' }}>
              Drag programs here
            </div>
          ) : programs.map((p) => (
            <ProgramCard key={p.id} prog={p}
              onEdit={onEditProgram}
              onDuplicate={onDuplicateProgram}
              onDelete={onDeleteProgram} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function ProgramLibrary() {
  const [programs, setPrograms]                 = useState([])
  const [folders, setFolders]                   = useState([])
  const [search, setSearch]                     = useState('')
  const [expandedFolders, setExpandedFolders]   = useState({})
  const [unfiledDragOver, setUnfiledDragOver]   = useState(false)
  const [error, setError]                       = useState(null)

  const setLoadedProgram = useStore((s) => s.setLoadedProgram)
  const setTab           = useStore((s) => s.setTab)
  const addToast         = useStore((s) => s.addToast)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [pRes, fRes] = await Promise.all([
        fetch('/api/programs'),
        fetch('/api/folders'),
      ])
      const pData = await pRes.json()
      const fData = await fRes.json()
      setPrograms(pData.programs || [])
      setFolders(fData.folders || [])
    } catch (e) {
      setError(e.message || String(e))
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function editProgram(progId) {
    try {
      const res = await fetch('/api/programs/' + encodeURIComponent(progId))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const prog = await res.json()
      if (prog && Array.isArray(prog.steps)) {
        setLoadedProgram(prog)
        setTab('program')
        addToast(`Loaded "${prog.name || progId}" into editor`, 'success')
      }
    } catch (e) {
      addToast('Edit failed: ' + (e.message || e), 'error')
    }
  }

  async function duplicateProgram(progId) {
    try {
      const res = await fetch('/api/programs/' + encodeURIComponent(progId) + '/duplicate', { method: 'POST' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      addToast('Program duplicated', 'success')
      load()
    } catch (e) {
      addToast('Duplicate failed: ' + (e.message || e), 'error')
    }
  }

  async function deleteProgram(progId) {
    if (!confirm('Delete this program?')) return
    try {
      const res = await fetch('/api/programs/' + encodeURIComponent(progId), { method: 'DELETE' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      load()
    } catch (e) {
      addToast('Delete failed: ' + (e.message || e), 'error')
    }
  }

  async function createFolder() {
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Folder' }),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      // Auto-expand the new folder so the operator can see they can drop into it.
      if (data?.folder?.id) {
        setExpandedFolders((prev) => ({ ...prev, [data.folder.id]: true }))
      }
      load()
    } catch (e) {
      addToast('New folder failed: ' + (e.message || e), 'error')
    }
  }

  async function renameFolder(folderId, name) {
    try {
      await fetch('/api/folders/' + encodeURIComponent(folderId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      load()
    } catch {}
  }

  async function deleteFolder(folderId) {
    if (!confirm('Delete this folder? Programs inside will be moved to Unfiled.')) return
    try {
      await fetch('/api/folders/' + encodeURIComponent(folderId), { method: 'DELETE' })
      load()
    } catch {}
  }

  async function moveToFolder(progId, folderId) {
    try {
      await fetch('/api/programs/' + encodeURIComponent(progId) + '/folder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folderId }),
      })
      load()
    } catch {}
  }

  function toggleFolder(folderId) {
    setExpandedFolders((prev) => ({ ...prev, [folderId]: !prev[folderId] }))
  }

  // Filter
  const q = search.trim().toLowerCase()
  const filtered = !q ? programs : programs.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q) ||
    (p.tags || []).some((t) => t.toLowerCase().includes(q))
  )

  const unfiled  = filtered.filter((p) => !p.folder)
  const byFolder = {}
  folders.forEach((f) => { byFolder[f.id] = filtered.filter((p) => p.folder === f.id) })

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 20, background: 'var(--bg-app)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>Program Library</div>
          <button onClick={load}
            style={{
              padding: '8px 14px', fontSize: 12, fontWeight: 600,
              background: 'var(--bg-surface)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
            }}>Refresh</button>
          <button onClick={createFolder} style={{
            padding: '8px 16px', fontSize: 12, fontWeight: 600,
            background: '#f3f4f6', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
          }}>+ New Folder</button>
        </div>

        <input type="text" placeholder="Search programs..."
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '10px 14px', fontSize: 14,
            background: '#fff', color: '#111',
            border: '1px solid #d1d5db', borderRadius: 8,
            marginBottom: 16, outline: 'none',
          }}
          onFocus={(e) => { e.target.style.borderColor = '#2563EB' }}
          onBlur={(e)  => { e.target.style.borderColor = '#d1d5db' }} />

        {error && (
          <div style={{
            padding: '8px 12px', marginBottom: 12,
            background: '#fef2f2', color: '#b91c1c',
            border: '1px solid #fecaca', borderRadius: 6, fontSize: 12,
          }}>{error}</div>
        )}

        {folders.map((folder) => (
          <FolderCard key={folder.id} folder={folder}
            programs={byFolder[folder.id] || []}
            expanded={!!expandedFolders[folder.id]}
            onToggle={() => toggleFolder(folder.id)}
            onRename={renameFolder}
            onDelete={deleteFolder}
            onDrop={moveToFolder}
            onEditProgram={editProgram}
            onDuplicateProgram={duplicateProgram}
            onDeleteProgram={deleteProgram} />
        ))}

        {/* Unfiled drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setUnfiledDragOver(true) }}
          onDragLeave={() => setUnfiledDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setUnfiledDragOver(false)
            const progId = e.dataTransfer.getData('programId')
            if (progId) moveToFolder(progId, null)
          }}
          style={{
            marginTop: folders.length > 0 ? 16 : 0,
            padding: unfiledDragOver ? 8 : 0,
            borderRadius: 10,
            border:    unfiledDragOver ? '2px dashed #2563EB' : '2px solid transparent',
            background: unfiledDragOver ? '#eff6ff'           : 'transparent',
            transition: 'all 150ms',
          }}>
          {folders.length > 0 && unfiled.length > 0 && (
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, padding: '0 4px' }}>
              Unfiled Programs
            </div>
          )}
          {unfiled.map((p) => (
            <ProgramCard key={p.id} prog={p}
              onEdit={editProgram}
              onDuplicate={duplicateProgram}
              onDelete={deleteProgram} />
          ))}
        </div>

        {filtered.length === 0 && (
          <div style={{
            padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14,
            border: '2px dashed var(--border)', borderRadius: 10, marginTop: folders.length > 0 ? 16 : 0,
          }}>
            {search ? 'No programs match your search' : 'No saved programs yet'}
          </div>
        )}
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store/useStore'

// ---------------------------------------------------------------------------
// Program Library — file-explorer style grid view
//
// At root: folders + unfiled programs as tiles in a responsive grid.
// Click a folder tile → enter that folder (breadcrumb shows its name).
// Click a program tile → details modal (Edit / Duplicate / Delete).
// Drag a program tile onto a folder tile → moves into that folder.
// Drag a program tile onto the "Program Library" breadcrumb crumb
//   while inside a folder → moves back to root.
// When a search query is active, the grid switches to a flat
// global-match view (folders hidden) so the operator can find a
// program without first guessing which folder it lives in.
// ---------------------------------------------------------------------------

// Deterministic colour for a program tile's initial-letter avatar.
const PROGRAM_COLORS = [
  '#2563EB', '#16A34A', '#CA8A04', '#DC2626',
  '#9333EA', '#0891B2', '#EA580C', '#0EA5E9',
]
function programColor(id) {
  let h = 0
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xfffff
  return PROGRAM_COLORS[h % PROGRAM_COLORS.length]
}

function FolderIcon({ size = 56, color = '#CA8A04' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
  )
}

function cornerBtn(bg = 'rgba(255,255,255,0.92)', color = '#6b7280', border = '#d1d5db') {
  return {
    padding: '4px 10px', fontSize: 11, fontWeight: 600,
    background: bg, color, border: `1px solid ${border}`,
    borderRadius: 4, cursor: 'pointer', minHeight: 28,
  }
}

function modalBtn(bg, color, border) {
  return {
    flex: 1, minHeight: 44,
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
    background: bg, color, border: `1px solid ${border}`,
    borderRadius: 8, cursor: 'pointer',
  }
}

function FolderTile({ folder, programCount, onOpen, onRename, onDelete, onDrop }) {
  const [dragOver, setDragOver]       = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [draft, setDraft]             = useState(folder.name)
  const inputRef = useRef(null)

  useEffect(() => { setDraft(folder.name) }, [folder.name])
  useEffect(() => {
    if (editingName && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingName])

  function commitRename() {
    setEditingName(false)
    const t = draft.trim()
    if (t && t !== folder.name) onRename(folder.id, t)
    else setDraft(folder.name)
  }

  return (
    <div
      onClick={() => { if (!editingName) onOpen(folder.id) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const progId = e.dataTransfer.getData('programId')
        if (progId) onDrop(progId, folder.id)
      }}
      style={{
        position: 'relative',
        padding: 20, minHeight: 160,
        background: dragOver ? '#eff6ff' : '#fff',
        border:     dragOver ? '2px dashed #2563EB' : '1px solid #e5e7eb',
        borderRadius: 12,
        cursor: editingName ? 'default' : 'pointer',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 10,
        transition: 'box-shadow 120ms, border-color 120ms, background 120ms',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)' }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none' }}
    >
      {/* Corner action buttons */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}>
        <button
          onClick={(e) => { e.stopPropagation(); setEditingName(true) }}
          title="Rename folder"
          style={cornerBtn()}
        >
          Rename
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(folder.id) }}
          title="Delete folder"
          style={cornerBtn('#fef2f2', '#DC2626', '#fecaca')}
        >
          ×
        </button>
      </div>

      <FolderIcon size={56} />

      {editingName ? (
        <input
          ref={inputRef}
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') { setDraft(folder.name); setEditingName(false) }
          }}
          style={{
            fontSize: 15, fontWeight: 700, color: '#111', textAlign: 'center',
            padding: '6px 10px', border: '2px solid #2563EB',
            borderRadius: 6, outline: 'none', width: '90%', background: '#fff',
          }}
        />
      ) : (
        <div
          style={{
            fontSize: 15, fontWeight: 700, color: '#111', textAlign: 'center',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            width: '100%',
          }}
          title={folder.name}
        >
          {folder.name}
        </div>
      )}

      <div style={{ fontSize: 12, color: '#6b7280' }}>
        {programCount} program{programCount !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

function ProgramTile({ prog, onClick, folderName }) {
  const initial = ((prog.name || '?').trim()[0] || '?').toUpperCase()
  const color   = programColor(prog.id)

  return (
    <div
      draggable
      onClick={() => onClick(prog)}
      onDragStart={(e) => {
        e.dataTransfer.setData('programId', prog.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      style={{
        position: 'relative',
        padding: 20, minHeight: 160,
        background: '#fff', border: '1px solid #e5e7eb',
        borderRadius: 12, cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 8,
        transition: 'box-shadow 120ms',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)' }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none' }}
    >
      <div style={{
        width: 56, height: 56, borderRadius: '50%',
        background: color, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 24, fontWeight: 700, flexShrink: 0,
      }}>
        {initial}
      </div>

      <div
        style={{
          fontSize: 15, fontWeight: 700, color: '#111', textAlign: 'center',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          width: '100%',
        }}
        title={prog.name}
      >
        {prog.name}
      </div>

      <div style={{ fontSize: 12, color: '#6b7280' }}>
        {prog.steps} step{prog.steps !== 1 ? 's' : ''}
        {folderName ? ` · in ${folderName}` : ''}
      </div>
    </div>
  )
}

function ProgramDetailsModal({ prog, onClose, onEdit, onDuplicate, onDelete }) {
  if (!prog) return null
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: 24,
      }}
    >
      <div style={{
        background: '#fff', borderRadius: 14, padding: 24,
        minWidth: 360, maxWidth: 560, width: '100%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: programColor(prog.id), color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 700, flexShrink: 0,
          }}>
            {((prog.name || '?').trim()[0] || '?').toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#111',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {prog.name}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {prog.steps} step{prog.steps !== 1 ? 's' : ''}
            </div>
          </div>
        </div>

        <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.8 }}>
          <div><strong>Created:</strong> {prog.created || 'Unknown'}</div>
          <div><strong>Last edited:</strong> {prog.updated || prog.created || 'Unknown'}</div>
          {prog.tags && prog.tags.length > 0 && (
            <div><strong>Tags:</strong> {prog.tags.join(', ')}</div>
          )}
          {prog.description && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
              {prog.description}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 24, flexWrap: 'wrap' }}>
          <button onClick={() => onEdit(prog.id)}
                  style={modalBtn('#eff6ff', '#2563EB', '#bfdbfe')}>Edit</button>
          <button onClick={() => onDuplicate(prog.id)}
                  style={modalBtn('#f3f4f6', '#374151', '#d1d5db')}>Duplicate</button>
          <button onClick={() => onDelete(prog.id)}
                  style={modalBtn('#fef2f2', '#DC2626', '#fecaca')}>Delete</button>
          <button onClick={onClose}
                  style={modalBtn('#fff', '#6b7280', '#d1d5db')}>Close</button>
        </div>
      </div>
    </div>
  )
}

// onSelectProgram (optional): when provided, single-clicking a program
// tile invokes the callback with the program record instead of opening
// the details modal. Used by Monitor's "Change Program" overlay so the
// operator can pick an active program without the Edit/Duplicate/Delete
// affordances getting in the way.
export default function ProgramLibrary({ onSelectProgram } = {}) {
  const [programs, setPrograms]             = useState([])
  const [folders, setFolders]               = useState([])
  const [search, setSearch]                 = useState('')
  const [currentFolder, setCurrentFolder]   = useState(null)   // null = root
  const [selectedProgram, setSelectedProgram] = useState(null)
  const [rootDragOver, setRootDragOver]     = useState(false)
  const [error, setError]                   = useState(null)

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

  // Drop the selected-program if it was deleted out from under us by
  // another tab or a refresh.
  useEffect(() => {
    if (selectedProgram && !programs.find((p) => p.id === selectedProgram.id)) {
      setSelectedProgram(null)
    }
  }, [programs, selectedProgram])

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
    if (!confirm('Delete this folder? Programs inside will be moved to the root level.')) return
    try {
      await fetch('/api/folders/' + encodeURIComponent(folderId), { method: 'DELETE' })
      if (currentFolder === folderId) setCurrentFolder(null)
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

  // ── View selection ────────────────────────────────────────────────
  const q = search.trim().toLowerCase()
  const filtered = !q ? programs : programs.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q) ||
    (p.tags || []).some((t) => t.toLowerCase().includes(q))
  )

  const folderById = {}
  folders.forEach((f) => { folderById[f.id] = f })

  let viewFolders, viewPrograms, isSearchMode, isInFolder
  isSearchMode = !!q
  isInFolder   = !isSearchMode && currentFolder !== null
  if (isSearchMode) {
    viewFolders  = []
    viewPrograms = filtered
  } else if (isInFolder) {
    viewFolders  = []
    viewPrograms = filtered.filter((p) => p.folder === currentFolder)
  } else {
    viewFolders  = folders
    viewPrograms = filtered.filter((p) => !p.folder)
  }

  const programCountFor = (folderId) =>
    programs.filter((p) => p.folder === folderId).length

  const currentFolderObj = currentFolder ? folderById[currentFolder] : null

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24, background: 'var(--bg-app)' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* Title + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', flex: 1 }}>
            Program Library
          </div>
          <button onClick={load} style={{
            padding: '12px 18px', fontSize: 13, fontWeight: 600,
            background: 'var(--bg-surface)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 8,
            cursor: 'pointer', minHeight: 48,
          }}>Refresh</button>
          <button onClick={createFolder} style={{
            padding: '12px 20px', fontSize: 14, fontWeight: 600,
            background: '#f3f4f6', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 8,
            cursor: 'pointer', minHeight: 48,
          }}>+ New Folder</button>
        </div>

        {/* Breadcrumb. The "Program Library" crumb doubles as a drop
            target for programs when the operator is inside a folder
            and wants to move a program back to root. */}
        {(isInFolder || isSearchMode) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 14 }}>
            <span
              onClick={() => { setCurrentFolder(null); setSearch('') }}
              onDragOver={(e) => { e.preventDefault(); setRootDragOver(true) }}
              onDragLeave={() => setRootDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setRootDragOver(false)
                const progId = e.dataTransfer.getData('programId')
                if (progId) moveToFolder(progId, null)
              }}
              style={{
                padding: '8px 14px', cursor: 'pointer',
                color: '#2563EB', fontWeight: 600,
                border: rootDragOver ? '2px dashed #2563EB' : '2px solid transparent',
                borderRadius: 6,
                background: rootDragOver ? '#eff6ff' : 'transparent',
                minHeight: 36,
              }}
            >
              ← Program Library
            </span>
            <span style={{ color: '#9ca3af' }}>/</span>
            <span style={{ color: '#374151', fontWeight: 600 }}>
              {isSearchMode ? `Search: "${search}"` : (currentFolderObj?.name || '?')}
            </span>
          </div>
        )}

        {/* Search */}
        <input
          type="text" placeholder="Search programs..."
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '14px 18px', fontSize: 16,
            background: '#fff', color: '#111',
            border: '1px solid #d1d5db', borderRadius: 10,
            marginBottom: 20, outline: 'none', minHeight: 50,
          }}
          onFocus={(e) => { e.target.style.borderColor = '#2563EB' }}
          onBlur={(e)  => { e.target.style.borderColor = '#d1d5db' }}
        />

        {error && (
          <div style={{
            padding: '10px 14px', marginBottom: 14, fontSize: 13,
            background: '#fef2f2', color: '#b91c1c',
            border: '1px solid #fecaca', borderRadius: 8,
          }}>{error}</div>
        )}

        {/* The grid — folders first, then programs */}
        {(viewFolders.length > 0 || viewPrograms.length > 0) ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 16,
          }}>
            {viewFolders.map((folder) => (
              <FolderTile
                key={folder.id}
                folder={folder}
                programCount={programCountFor(folder.id)}
                onOpen={(id) => setCurrentFolder(id)}
                onRename={renameFolder}
                onDelete={deleteFolder}
                onDrop={moveToFolder}
              />
            ))}
            {viewPrograms.map((prog) => (
              <ProgramTile
                key={prog.id}
                prog={prog}
                folderName={isSearchMode && prog.folder ? folderById[prog.folder]?.name : null}
                onClick={(p) => {
                  // Modal-mode pick → fire the callback and skip the
                  // details modal. The Monitor's Change Program flow
                  // owns the close + load-on-executor steps.
                  if (onSelectProgram) onSelectProgram(p)
                  else setSelectedProgram(p)
                }}
              />
            ))}
          </div>
        ) : (
          <div style={{
            padding: 60, textAlign: 'center', color: 'var(--text-muted)',
            border: '2px dashed var(--border)', borderRadius: 12,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
          }}>
            <svg width={72} height={72} viewBox="0 0 24 24" fill="#d1d5db">
              <path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10H7v-2h10v2zm0 4H7v-2h10v2zm0-8H7V7h10v2z" />
            </svg>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#374151' }}>
              {isSearchMode ? 'No programs match your search'
               : isInFolder ? 'This folder is empty'
               : 'No programs yet'}
            </div>
            <div style={{ fontSize: 14, color: '#6b7280' }}>
              {isSearchMode ? 'Try a different search term'
               : isInFolder ? 'Drag a program tile here from the root level'
               : 'Create one with the Wizard'}
            </div>
          </div>
        )}
      </div>

      <ProgramDetailsModal
        prog={selectedProgram}
        onClose={() => setSelectedProgram(null)}
        onEdit={editProgram}
        onDuplicate={duplicateProgram}
        onDelete={deleteProgram}
      />
    </div>
  )
}

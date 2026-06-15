import { useState, useRef, useEffect } from 'react'

/*
 * Program from Demonstration — three-step modal mirroring the wizard's
 * visual language.
 *
 *   1. UPLOAD    — pick a video, hit Generate
 *   2. PROCESSING — transcribing / understanding / composing spinner
 *   3. REVIEW    — operator inspects intent + ambiguities, can edit
 *                  name/description before saving, then Accept saves to
 *                  the library AND writes human_corrected.json to the
 *                  learning store.
 *
 * Generated programs carry pose_status="awaiting_perception" on every
 * move step. They LOAD and DISPLAY here but the executor will refuse
 * to run them until the perception stack resolves the poses later.
 */

const PHASE_UPLOAD     = 'upload'
const PHASE_PROCESSING = 'processing'
const PHASE_REVIEW     = 'review'

const POSE_AWAITING = 'awaiting_perception'

export default function ProgramFromDemonstration({ onClose, onSaved }) {
  const [phase, setPhase]             = useState(PHASE_UPLOAD)
  const [file, setFile]               = useState(null)
  const [demoId, setDemoId]           = useState(null)
  const [videoPath, setVideoPath]     = useState(null)
  const [generating, setGenerating]   = useState(false)
  const [generateError, setGenError]  = useState('')
  const [intent, setIntent]           = useState(null)
  const [draft, setDraft]             = useState(null)
  const [transcript, setTranscript]   = useState('')
  const [usedExamples, setUsedExamples] = useState([])
  const [backendId, setBackendId]     = useState('')
  const [transitedExternally, setTransited] = useState(false)
  const [accepting, setAccepting]     = useState(false)
  const [acceptError, setAcceptError] = useState('')
  // Editable mirrors of the draft fields — operator corrections.
  const [editName, setEditName]       = useState('')
  const [editDesc, setEditDesc]       = useState('')

  const fileInputRef = useRef(null)
  const videoRef     = useRef(null)
  const objectUrlRef = useRef(null)

  // Release blob URLs when the file changes or the modal closes.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  function pickFile(f) {
    if (!f) return
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(f)
    objectUrlRef.current = url
    setFile(f)
    setDemoId(null)
    setVideoPath(null)
    setGenError('')
  }

  async function upload() {
    if (!file) return
    setGenerating(true)
    setGenError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/pbd/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!data.ok) {
        setGenError(data.error || 'upload failed')
        setGenerating(false)
        return null
      }
      setDemoId(data.demo_id)
      setVideoPath(data.video_path)
      return data
    } catch (e) {
      setGenError(`upload error: ${e?.message || e}`)
      setGenerating(false)
      return null
    }
  }

  async function generate() {
    setGenError('')
    const up = await upload()
    if (!up) return
    setPhase(PHASE_PROCESSING)
    try {
      const res = await fetch('/api/pbd/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ demo_id: up.demo_id, video_path: up.video_path }),
      })
      const data = await res.json()
      if (!data.ok) {
        setGenError(data.error || 'generate failed')
        setPhase(PHASE_UPLOAD)
        setGenerating(false)
        return
      }
      setIntent(data.intent || null)
      setDraft(data.draft || null)
      setTranscript(data.transcript || '')
      setUsedExamples(data.used_examples || [])
      setBackendId(data.backend_id || '')
      setTransited(!!data.transited_externally)
      const draftName = data.draft?.name || (data.intent?.task_summary?.slice(0, 60))
                        || `Demo ${up.demo_id}`
      setEditName(draftName)
      setEditDesc(data.draft?.description || '')
      setPhase(PHASE_REVIEW)
    } catch (e) {
      setGenError(`generate error: ${e?.message || e}`)
      setPhase(PHASE_UPLOAD)
    }
    setGenerating(false)
  }

  async function accept() {
    if (!draft || !demoId) return
    setAccepting(true)
    setAcceptError('')
    try {
      const program = {
        ...draft,
        name:        editName.trim() || draft.name,
        description: editDesc,
      }
      const res = await fetch(`/api/pbd/${demoId}/correct`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ program, save_to_library: true }),
      })
      const data = await res.json()
      if (!data.ok) {
        setAcceptError(data.error || 'save failed')
        setAccepting(false)
        return
      }
      onSaved?.({ id: data.program_id, name: program.name, ...program })
      onClose?.()
    } catch (e) {
      setAcceptError(`save error: ${e?.message || e}`)
      setAccepting(false)
    }
  }

  // ── Renderers ───────────────────────────────────────────────────

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '95%', maxWidth: 900, maxHeight: '95vh',
        background: '#fff', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Program from Demonstration</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
              {phase === PHASE_UPLOAD     && 'Upload a video + voice narration'}
              {phase === PHASE_PROCESSING && 'Generating draft program…'}
              {phase === PHASE_REVIEW     && 'Review the AI’s understanding'}
            </div>
          </div>
          <button onClick={onClose} style={iconBtn}>X</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {phase === PHASE_UPLOAD && (
            <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
              <div style={{ fontSize: 14, color: '#374151', marginBottom: 16, lineHeight: 1.6 }}>
                Upload a short clip showing &mdash; and narrating &mdash; the
                task you want the robot to perform (e.g.&nbsp;&ldquo;pick the
                BT225L24 brackets from the bin and place them in the
                left tray&rdquo;). RoboAi will transcribe the voice locally,
                interpret the demonstration, and produce a draft program
                you can review before saving.
              </div>

              <div
                onDragOver={(e) => { e.preventDefault() }}
                onDrop={(e) => {
                  e.preventDefault()
                  const f = e.dataTransfer?.files?.[0]
                  if (f) pickFile(f)
                }}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: '2px dashed #d1d5db', borderRadius: 10,
                  padding: 30, textAlign: 'center', cursor: 'pointer',
                  background: file ? '#f8fafc' : '#fafafa', marginBottom: 16,
                }}>
                <input ref={fileInputRef} type="file" accept="video/*"
                  style={{ display: 'none' }}
                  onChange={(e) => pickFile(e.target.files?.[0])} />
                {file ? (
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
                      {file.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>
                      Click or drop a video file here
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>
                      MP4 / MOV / WebM &mdash; voice narration in any clip language
                    </div>
                  </>
                )}
              </div>

              {file && (
                <video ref={videoRef} controls
                  src={objectUrlRef.current}
                  style={{ width: '100%', maxHeight: 280, background: '#000',
                    borderRadius: 8, marginBottom: 16 }} />
              )}

              {generateError && <ErrorBanner msg={generateError} />}

              <div style={{
                padding: 10, marginBottom: 14, fontSize: 12, color: '#6b7280',
                background: '#f8fafc', border: '1px solid #e5e7eb',
                borderRadius: 8, lineHeight: 1.5,
              }}>
                <strong style={{ color: '#374151' }}>Heads up:</strong>{' '}
                generated programs are <em>drafts</em> with placeholder poses
                &mdash; they load in the library but can&rsquo;t run until the
                recognition stack resolves the pick/place poses on the real
                robot.
              </div>

              <button onClick={generate}
                disabled={!file || generating}
                style={{
                  width: '100%', padding: 14, fontSize: 16, fontWeight: 700,
                  background: !file ? '#d1d5db' : '#2563EB',
                  color: '#fff', border: 'none', borderRadius: 10,
                  cursor: !file ? 'default' : 'pointer',
                }}>
                {generating ? 'Uploading…' : 'Generate Draft Program'}
              </button>
            </div>
          )}

          {phase === PHASE_PROCESSING && (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <div style={{
                width: 56, height: 56, margin: '0 auto 16px',
                border: '4px solid #bfdbfe', borderTopColor: '#2563EB',
                borderRadius: '50%', animation: 'pbd-spin 1s linear infinite',
              }} />
              <style>{`@keyframes pbd-spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>
                Transcribing voice, understanding the demonstration,
                composing the draft…
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                This can take a minute or two depending on clip length.
              </div>
            </div>
          )}

          {phase === PHASE_REVIEW && draft && intent && (
            <ReviewPanel
              intent={intent} draft={draft} transcript={transcript}
              backendId={backendId} transitedExternally={transitedExternally}
              usedExamples={usedExamples}
              editName={editName} setEditName={setEditName}
              editDesc={editDesc} setEditDesc={setEditDesc}
              accepting={accepting} acceptError={acceptError}
              onAccept={accept} onCancel={onClose}
            />
          )}
        </div>
      </div>
    </div>
  )
}


function ReviewPanel({
  intent, draft, transcript, backendId, transitedExternally, usedExamples,
  editName, setEditName, editDesc, setEditDesc,
  accepting, acceptError, onAccept, onCancel,
}) {
  return (
    <div style={{ padding: 22 }}>
      <Banner
        kind={transitedExternally ? 'warn' : 'info'}
        title="Generated from demonstration — poses pending perception"
        body={
          `${transitedExternally
            ? 'Interpreted by external API (' + backendId + '); your demonstration data and the human-corrected program are stored locally only.'
            : 'Interpreted by the on-device backend (' + backendId + ').'}`
        }
      />

      <Section title="Task summary">
        <div style={{ fontSize: 14, color: '#111', marginBottom: 8 }}>
          {intent.task_summary || <em style={{ color: '#9ca3af' }}>No summary produced.</em>}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Confidence: {(intent.confidence_overall * 100).toFixed(0)}%
        </div>
      </Section>

      <Section title={`Operations (${intent.operations?.length || 0})`}>
        {(intent.operations || []).length === 0 ? (
          <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>
            No operations recognised — check ambiguities below.
          </div>
        ) : intent.operations.map((op, i) => (
          <div key={i} style={{
            padding: 12, marginBottom: 8, borderRadius: 8,
            background: '#f8fafc', border: '1px solid #e5e7eb',
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                          marginBottom: 4 }}>
              <span style={{
                background: '#2563EB', color: '#fff', fontSize: 11,
                padding: '2px 6px', borderRadius: 4, fontWeight: 700,
              }}>
                {i + 1}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                {op.operation_type}
              </span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                — count: {String(op.count_hint ?? 'all')}
              </span>
            </div>
            <Field label="Part">
              <PartChip part={op.target_part} />
            </Field>
            <Field label="Pick">
              <PoseHint slot={op.pick} role="pick" />
            </Field>
            <Field label="Place">
              <PoseHint slot={op.place} role="place" />
            </Field>
          </div>
        ))}
      </Section>

      {(intent.ambiguities || []).length > 0 && (
        <Section title={`Ambiguities (${intent.ambiguities.length})`}>
          {intent.ambiguities.map((a, i) => (
            <div key={i} style={{
              padding: '8px 10px', marginBottom: 4, borderRadius: 6,
              background: '#fffbeb', border: '1px solid #fde68a',
              fontSize: 12, color: '#92400e',
            }}>{a}</div>
          ))}
        </Section>
      )}

      {(usedExamples || []).length > 0 && (
        <Section title={`Informed by ${usedExamples.length} similar past demo${usedExamples.length === 1 ? '' : 's'}`}>
          {usedExamples.map((ex, i) => (
            <div key={i} style={{
              padding: 8, marginBottom: 4, borderRadius: 6,
              background: '#eff6ff', border: '1px solid #bfdbfe',
              fontSize: 12, color: '#1e3a8a', display: 'flex', gap: 8,
            }}>
              <span style={{ fontFamily: 'monospace' }}>{ex.demo_id}</span>
              <span style={{ flex: 1 }}>{ex.task_summary || ''}</span>
              <span>score {ex._score}</span>
            </div>
          ))}
        </Section>
      )}

      <Section title="Program name (editable)">
        <input value={editName} onChange={(e) => setEditName(e.target.value)}
          style={inputBox} />
        <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
          rows={2} style={{ ...inputBox, marginTop: 6, resize: 'vertical' }} />
      </Section>

      <Section title={`Draft steps (${draft.steps?.length || 0})`}>
        <div style={{
          maxHeight: 220, overflowY: 'auto', borderRadius: 8,
          border: '1px solid #e5e7eb',
        }}>
          {(draft.steps || []).map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px',
              borderBottom: i < draft.steps.length - 1 ? '1px solid #f3f4f6' : 'none',
              background: i % 2 ? '#fafafa' : '#fff',
            }}>
              <span style={{
                fontFamily: 'monospace', fontSize: 11, color: '#6b7280',
                minWidth: 26, textAlign: 'right',
              }}>{i + 1}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 110 }}>
                {s.action}
              </span>
              <span style={{ fontSize: 12, color: '#111', flex: 1 }}>{s.label}</span>
              {s.pose_status === POSE_AWAITING && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 6px',
                  borderRadius: 4, color: '#92400e', background: '#fef3c7',
                  border: '1px solid #fde68a',
                }}>awaiting perception</span>
              )}
            </div>
          ))}
        </div>
      </Section>

      {transcript && (
        <Section title="Voice transcript">
          <div style={{
            padding: 10, fontSize: 12, color: '#374151',
            background: '#f8fafc', border: '1px solid #e5e7eb',
            borderRadius: 6, lineHeight: 1.5, whiteSpace: 'pre-wrap',
          }}>{transcript}</div>
        </Section>
      )}

      {acceptError && <ErrorBanner msg={acceptError} />}

      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button onClick={onCancel} disabled={accepting}
          style={{
            flex: 1, padding: 14, fontSize: 14, fontWeight: 700,
            background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 10,
            cursor: accepting ? 'wait' : 'pointer',
          }}>Cancel</button>
        <button onClick={onAccept} disabled={accepting || !editName.trim()}
          style={{
            flex: 2, padding: 14, fontSize: 15, fontWeight: 700,
            background: accepting ? '#9ca3af' : '#16A34A',
            color: '#fff', border: 'none', borderRadius: 10,
            cursor: accepting ? 'wait' : 'pointer',
          }}>
          {accepting ? 'Saving…' : 'Accept → Save to Program Library'}
        </button>
      </div>
    </div>
  )
}


// ── Tiny presentational helpers ──────────────────────────────────

const inputBox = {
  width: '100%', padding: '8px 10px', fontSize: 14,
  border: '1px solid #d1d5db', borderRadius: 6, outline: 'none',
  boxSizing: 'border-box',
}

const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 18, color: '#9ca3af', padding: '2px 8px',
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#6b7280',
        textTransform: 'uppercase', letterSpacing: '0.06em',
        marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12, color: '#374151', marginTop: 2 }}>
      <span style={{ minWidth: 44, color: '#6b7280' }}>{label}:</span>
      {children}
    </div>
  )
}

function PartChip({ part }) {
  if (!part) return null
  const isUnknown = part.part_id === 'unknown'
  return (
    <span style={{
      padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
      background: isUnknown ? '#fef3c7' : '#eff6ff',
      color:      isUnknown ? '#92400e' : '#1e3a8a',
      border: '1px solid ' + (isUnknown ? '#fde68a' : '#bfdbfe'),
    }}>
      {part.name || part.part_id}
      {!isUnknown && (
        <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 500 }}>
          ({part.part_id} · {(part.confidence * 100).toFixed(0)}%)
        </span>
      )}
      {isUnknown && (
        <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 500 }}>
          not in library
        </span>
      )}
    </span>
  )
}

function PoseHint({ slot }) {
  return (
    <span style={{ fontSize: 12, color: '#111' }}>
      {slot?.location_hint || <em style={{ color: '#9ca3af' }}>(no hint)</em>}
      <span style={{
        marginLeft: 6, padding: '1px 5px', borderRadius: 4,
        fontSize: 10, fontWeight: 700, background: '#fef3c7',
        color: '#92400e', border: '1px solid #fde68a',
      }}>awaiting perception</span>
    </span>
  )
}

function Banner({ kind, title, body }) {
  const palette = kind === 'warn'
    ? { bg: '#fffbeb', border: '#fde68a', title: '#92400e', body: '#78350f' }
    : { bg: '#eff6ff', border: '#bfdbfe', title: '#1e3a8a', body: '#1e40af' }
  return (
    <div style={{
      padding: 12, marginBottom: 14, borderRadius: 8,
      background: palette.bg, border: '1px solid ' + palette.border,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: palette.title, marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: palette.body, lineHeight: 1.5 }}>
        {body}
      </div>
    </div>
  )
}

function ErrorBanner({ msg }) {
  return (
    <div style={{
      padding: 10, marginBottom: 12, fontSize: 13, fontWeight: 600,
      background: '#fef2f2', border: '1px solid #fecaca',
      borderRadius: 6, color: '#DC2626',
    }}>{msg}</div>
  )
}

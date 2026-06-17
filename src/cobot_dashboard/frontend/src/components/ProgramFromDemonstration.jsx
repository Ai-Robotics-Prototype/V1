import { useState, useRef, useEffect } from 'react'
import LiveRecorder from './LiveRecorder'
import { useStore } from '../store/useStore'

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
  // Which capture mode is shown in the upload phase: in-browser
  // recorder vs file upload. Both feed pickFile() so the rest of the
  // wizard is mode-agnostic.
  const [captureMode, setCaptureMode] = useState('record')
  // Editable mirror of the AI's scene understanding. We deep-clone
  // the AI's scene into local state on REVIEW entry so edits don't
  // mutate the intent object we display elsewhere.
  const [editScene, setEditScene]     = useState(null)
  // The parts library — used to populate the matched-part dropdown
  // when the operator corrects an unmatched/mismatched object.
  const [partsLibrary, setPartsLibrary] = useState([])
  useEffect(() => {
    let alive = true
    fetch('/api/parts').then((r) => r.json()).then((d) => {
      if (alive) setPartsLibrary(d?.parts || [])
    }).catch(() => {})
    return () => { alive = false }
  }, [])

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

  // LiveRecorder hands us a raw Blob (its lifetime is owned here once
  // we wrap it in a File). Wrap with a meaningful filename so the
  // backend's extension allowlist accepts it and the upload directory
  // shows a sensible name. Type-fall-back to webm — that's what
  // MediaRecorder produces on every Android Chrome we've shipped to.
  function handleRecordedClip(blob, filename, mimeType) {
    if (!blob) return
    const f = new File(
      [blob],
      filename || `pbd_recording_${Date.now()}.webm`,
      { type: mimeType || blob.type || 'video/webm' },
    )
    pickFile(f)
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
      // Editable mirror of the AI's scene — deep-cloned so edits don't
      // mutate the intent we display in the AI-output sections.
      const aiScene = data.intent?.scene || {
        objects: [], locations: [], spatial_summary: '',
      }
      setEditScene(JSON.parse(JSON.stringify(aiScene)))
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
      // The operator may have corrected the scene (renamed an object,
      // fixed an unmatched part, changed a location's role, edited the
      // spatial summary). Send the corrected scene + a corrected
      // intent (intent with the scene swapped in) so the learning
      // store captures both as supervised training targets for the
      // future on-Jetson model.
      const correctedScene = editScene || (intent && intent.scene) || null
      const correctedIntent = intent && correctedScene
        ? { ...intent, scene: correctedScene }
        : intent
      const res = await fetch(`/api/pbd/${demoId}/correct`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          program,
          scene:   correctedScene,
          intent:  correctedIntent,
          save_to_library: true,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setAcceptError(data.error || 'save failed')
        setAccepting(false)
        return
      }
      // Refresh the shared programs list so ProgramLibrary reflects
      // the new draft program immediately (no mount-fetch lag).
      try { useStore.getState().refreshPrograms?.() } catch {}
      onSaved?.({ id: data.program_id, name: program.name, ...program })
      onClose?.()
    } catch (e) {
      setAcceptError(`save error: ${e?.message || e}`)
      setAccepting(false)
    }
  }

  // ── Renderers ───────────────────────────────────────────────────

  // Stretchable card that fills the actual visible viewport (100dvh on
  // tablets so the address bar doesn't clip us) with a fixed header
  // and footer flanking a scrollable body. min-height:0 on the body is
  // mandatory inside a flex column or the body won't actually scroll —
  // it would just grow to fit its content and push past the card edge,
  // which is exactly the bug we hit before this refactor.
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'stretch', justifyContent: 'center',
      paddingTop:    'env(safe-area-inset-top, 0px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      paddingLeft:   'env(safe-area-inset-left, 0px)',
      paddingRight:  'env(safe-area-inset-right, 0px)',
      boxSizing: 'border-box',
    }}>
      <div style={{
        width: '100%', maxWidth: 980,
        // `height: 100dvh` is the modern fix for tablet/phone where the
        // URL bar makes `vh` lie. The earlier overlay padding already
        // respects safe areas, so the card itself just needs to fill
        // what's available.
        height: '100dvh',
        maxHeight: '100dvh',
        background: '#fff', borderRadius: 12,
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}>
        {/* Header — never compresses under content pressure. */}
        <div style={{
          flexShrink: 0,
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

        {/* Body — scrolls when content exceeds available height. The
            min-height:0 here is what actually unlocks the scroll inside
            this flex column. */}
        <div style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}>
          {phase === PHASE_UPLOAD && (
            <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
              <div style={{ fontSize: 14, color: '#374151', marginBottom: 16, lineHeight: 1.6 }}>
                Film the workspace while narrating &mdash; or upload a clip
                you already recorded on your phone. RoboAi will transcribe
                the voice locally, fuse video and narration into one
                understanding, and produce a draft program you can review.
              </div>

              {/* Capture-mode tabs. Both paths produce a File handed to
                  pickFile() — the rest of the wizard (preview, generate)
                  is mode-agnostic. */}
              <div style={{
                display: 'flex', gap: 4, marginBottom: 14,
                background: '#f3f4f6', padding: 4, borderRadius: 8,
              }}>
                <CaptureTab
                  label="● Record live"
                  active={captureMode === 'record'}
                  onClick={() => setCaptureMode('record')}
                />
                <CaptureTab
                  label="↥ Upload clip"
                  active={captureMode === 'upload'}
                  onClick={() => setCaptureMode('upload')}
                />
              </div>

              {captureMode === 'record' && (
                <LiveRecorder
                  onClipReady={handleRecordedClip}
                  disabled={generating}
                  autoStart
                />
              )}

              {captureMode === 'upload' && (
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
              )}

              {/* Always show a tiny "selected clip" summary + preview
                  when a file is queued — works for both record and
                  upload modes so the user can verify before generating. */}
              {file && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{
                    padding: '8px 10px', marginBottom: 8,
                    background: '#f0fdf4', border: '1px solid #bbf7d0',
                    borderRadius: 6, fontSize: 12, color: '#166534',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{ fontWeight: 700 }}>✓ Ready</span>
                    <span style={{ flex: 1 }}>
                      {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  <video ref={videoRef} controls
                    src={objectUrlRef.current}
                    style={{ width: '100%', maxHeight: 280, background: '#000',
                      borderRadius: 8 }} />
                </div>
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
              {/* Generate button now lives in the sticky footer below
                  so it stays tappable even when the body scrolls. */}
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
              editScene={editScene} setEditScene={setEditScene}
              partsLibrary={partsLibrary}
              accepting={accepting} acceptError={acceptError}
            />
          )}
        </div>

        {/* Sticky footer — never scrolls, always tappable. Per-phase
            actions live here. PHASE_PROCESSING has no footer because
            it's a spinner-only state. */}
        {phase === PHASE_UPLOAD && (
          <div style={footerRow}>
            <button onClick={generate}
              disabled={!file || generating}
              style={{
                flex: 1, padding: 14, fontSize: 16, fontWeight: 700,
                background: (!file || generating) ? '#d1d5db' : '#2563EB',
                color: '#fff', border: 'none', borderRadius: 10,
                cursor: (!file || generating) ? 'default' : 'pointer',
              }}>
              {generating ? 'Uploading…' : 'Generate Draft Program'}
            </button>
          </div>
        )}
        {phase === PHASE_REVIEW && draft && intent && (
          <div style={footerRow}>
            <button onClick={onClose} disabled={accepting}
              style={{
                flex: 1, padding: 14, fontSize: 14, fontWeight: 700,
                background: '#fff', color: '#374151',
                border: '1px solid #d1d5db', borderRadius: 10,
                cursor: accepting ? 'wait' : 'pointer',
              }}>Cancel</button>
            <button onClick={accept} disabled={accepting || !editName.trim()}
              style={{
                flex: 2, padding: 14, fontSize: 15, fontWeight: 700,
                background: accepting ? '#9ca3af' : '#16A34A',
                color: '#fff', border: 'none', borderRadius: 10,
                cursor: accepting ? 'wait' : 'pointer',
              }}>
              {accepting ? 'Saving…' : 'Accept → Save to Program Library'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const footerRow = {
  flexShrink: 0,
  padding: '12px 20px',
  borderTop: '1px solid #e5e7eb',
  background: '#fff',
  display: 'flex', alignItems: 'center', gap: 10,
}


function ReviewPanel({
  intent, draft, transcript, backendId, transitedExternally, usedExamples,
  editName, setEditName, editDesc, setEditDesc,
  editScene, setEditScene, partsLibrary,
  accepting, acceptError,
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

      <SceneSection
        scene={editScene}
        onChange={setEditScene}
        partsLibrary={partsLibrary}
      />

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
      {/* Cancel + Accept buttons live in the wizard's sticky footer
          now so they remain tappable even when this review content is
          taller than the viewport. */}
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

function CaptureTab({ label, active, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        flex: 1, padding: '10px 14px', fontSize: 13, fontWeight: 700,
        background: active ? '#fff' : 'transparent',
        color:      active ? '#111' : '#6b7280',
        border:     active ? '1px solid #e5e7eb' : '1px solid transparent',
        borderRadius: 6, cursor: 'pointer',
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
        transition: 'all 100ms',
      }}>{label}</button>
  )
}


// ── Scene Understanding section ────────────────────────────────────
// What the AI extracted by FUSING the video and the narration: the
// objects on the table, the named places, and a free-text spatial
// summary. Every field is editable — the operator's corrections feed
// the learning store as a separate supervised training target for the
// future on-Jetson model. v1 captures CORE scene only: objects,
// locations, summary. Metric poses stay null/awaiting_perception in
// the operations below and will be resolved by perception later.

const SOURCE_OPTIONS = [
  { value: 'both',      label: 'Video + Voice' },
  { value: 'video',     label: 'Video only' },
  { value: 'narration', label: 'Voice only' },
]

const LOCATION_ROLES = [
  { value: 'pick_source',  label: 'Pick source' },
  { value: 'place_target', label: 'Place target' },
  { value: 'fixture',      label: 'Fixture' },
  { value: 'other',        label: 'Other' },
]

function SceneSection({ scene, onChange, partsLibrary }) {
  if (!scene) return null
  const objects   = scene.objects   || []
  const locations = scene.locations || []

  const update = (next) => onChange?.(next)
  const updateObject = (idx, patch) => {
    const objs = objects.map((o, i) => (i === idx ? { ...o, ...patch } : o))
    update({ ...scene, objects: objs })
  }
  const updateLocation = (idx, patch) => {
    const locs = locations.map((l, i) => (i === idx ? { ...l, ...patch } : l))
    update({ ...scene, locations: locs })
  }
  const removeObject = (idx) => update({
    ...scene, objects: objects.filter((_, i) => i !== idx),
  })
  const removeLocation = (idx) => update({
    ...scene, locations: locations.filter((_, i) => i !== idx),
  })
  const addObject = () => update({
    ...scene,
    objects: [...objects, {
      label: '', matched_part_id: null, matched_part_name: null,
      match_confidence: 0.0, source: 'video',
      approx_location: '', count_seen: 1,
    }],
  })
  const addLocation = () => update({
    ...scene,
    locations: [...locations, {
      label: '', role: 'other', approx_position: '', source: 'video',
    }],
  })
  const updateSummary = (text) => update({ ...scene, spatial_summary: text })

  // Build the part-id options once per render.
  const partOptions = (partsLibrary || []).map((p) => ({
    value: p.id || p.part_id || '', label: p.name || p.id,
  })).filter((p) => p.value)

  return (
    <Section title="Scene Understanding (video + voice fused)">
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
        Here&rsquo;s what RoboAi understood from the demonstration by
        combining the video and your narration. Correct anything that&rsquo;s
        wrong — your corrections train the model.
      </div>

      <SubTitle text="Spatial summary" />
      <textarea value={scene.spatial_summary || ''}
        onChange={(e) => updateSummary(e.target.value)}
        placeholder="e.g. A bin of brackets on the right; an empty tray on the left."
        rows={2}
        style={{ ...inputBox, marginBottom: 14, resize: 'vertical', fontSize: 13 }} />

      {/* Objects */}
      <SubTitle text={`Objects detected (${objects.length})`} />
      {objects.length === 0 ? (
        <Empty>No objects extracted.</Empty>
      ) : objects.map((o, i) => (
        <SceneCard key={i}>
          <Row>
            <Label>Label</Label>
            <input value={o.label || ''}
              onChange={(e) => updateObject(i, { label: e.target.value })}
              placeholder="e.g. white bracket"
              style={miniInput} />
            <SourceBadge value={o.source}
              onChange={(v) => updateObject(i, { source: v })} />
            <RemoveBtn onClick={() => removeObject(i)} />
          </Row>
          <Row>
            <Label>Matched part</Label>
            <select value={o.matched_part_id || ''}
              onChange={(e) => {
                const v = e.target.value || null
                const found = partOptions.find((p) => p.value === v)
                updateObject(i, {
                  matched_part_id:   v,
                  matched_part_name: found?.label || null,
                })
              }}
              style={miniInput}>
              <option value="">— not matched —</option>
              {partOptions.map((p) => (
                <option key={p.value} value={p.value}>{p.label} ({p.value})</option>
              ))}
            </select>
            <span style={{
              fontSize: 11, color: '#6b7280', minWidth: 80,
              textAlign: 'right',
            }}>
              conf {(o.match_confidence * 100).toFixed(0)}%
            </span>
          </Row>
          <Row>
            <Label>Approx location</Label>
            <input value={o.approx_location || ''}
              onChange={(e) => updateObject(i, { approx_location: e.target.value })}
              placeholder="e.g. in the right bin"
              style={miniInput} />
            <Label>Count</Label>
            <input value={String(o.count_seen ?? '')}
              onChange={(e) => updateObject(i, { count_seen: e.target.value })}
              placeholder="1 or 'multiple'"
              style={{ ...miniInput, maxWidth: 110 }} />
          </Row>
        </SceneCard>
      ))}
      <AddBtn onClick={addObject} label="+ Add object" />

      {/* Locations */}
      <SubTitle text={`Locations (${locations.length})`} style={{ marginTop: 14 }} />
      {locations.length === 0 ? (
        <Empty>No named locations extracted.</Empty>
      ) : locations.map((l, i) => (
        <SceneCard key={i}>
          <Row>
            <Label>Label</Label>
            <input value={l.label || ''}
              onChange={(e) => updateLocation(i, { label: e.target.value })}
              placeholder="e.g. left tray"
              style={miniInput} />
            <SourceBadge value={l.source}
              onChange={(v) => updateLocation(i, { source: v })} />
            <RemoveBtn onClick={() => removeLocation(i)} />
          </Row>
          <Row>
            <Label>Role</Label>
            <select value={l.role || 'other'}
              onChange={(e) => updateLocation(i, { role: e.target.value })}
              style={miniInput}>
              {LOCATION_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <Label>Approx position</Label>
            <input value={l.approx_position || ''}
              onChange={(e) => updateLocation(i, { approx_position: e.target.value })}
              placeholder="e.g. left side, front edge"
              style={miniInput} />
          </Row>
        </SceneCard>
      ))}
      <AddBtn onClick={addLocation} label="+ Add location" />
    </Section>
  )
}

// Small primitives kept local to the scene section. They mirror the
// existing Section/Field/PartChip styling so the panel feels native.

function SubTitle({ text, style }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 700, color: '#374151',
      marginBottom: 6, ...(style || {}),
    }}>{text}</div>
  )
}

function SceneCard({ children }) {
  return (
    <div style={{
      padding: 10, marginBottom: 6, borderRadius: 6,
      background: '#f8fafc', border: '1px solid #e5e7eb',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>{children}</div>
  )
}

function Row({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      flexWrap: 'wrap',
    }}>{children}</div>
  )
}

function Label({ children }) {
  return (
    <span style={{
      fontSize: 11, color: '#6b7280', minWidth: 70,
    }}>{children}</span>
  )
}

const miniInput = {
  flex: 1, minWidth: 0,
  padding: '6px 8px', fontSize: 12,
  border: '1px solid #d1d5db', borderRadius: 4,
  outline: 'none', boxSizing: 'border-box',
  background: '#fff',
}

function SourceBadge({ value, onChange }) {
  return (
    <select value={value || 'both'}
      onChange={(e) => onChange?.(e.target.value)}
      style={{
        ...miniInput, flex: '0 0 auto', maxWidth: 130,
        fontSize: 11, fontWeight: 600,
        background: value === 'both' ? '#eff6ff'
                  : value === 'video' ? '#f5f3ff'
                  : '#fffbeb',
        color:      value === 'both' ? '#1e3a8a'
                  : value === 'video' ? '#5b21b6'
                  : '#92400e',
        border:     value === 'both' ? '1px solid #bfdbfe'
                  : value === 'video' ? '1px solid #ddd6fe'
                  : '1px solid #fde68a',
      }}>
      {SOURCE_OPTIONS.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  )
}

function RemoveBtn({ onClick }) {
  return (
    <button onClick={onClick} title="Remove"
      style={{
        flex: '0 0 auto', padding: '4px 8px', fontSize: 11,
        background: 'transparent', color: '#DC2626',
        border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer',
      }}>×</button>
  )
}

function AddBtn({ onClick, label }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '6px 12px', fontSize: 12, fontWeight: 600,
        background: '#fff', color: '#1d4ed8',
        border: '1px dashed #93c5fd', borderRadius: 6, cursor: 'pointer',
        marginTop: 2,
      }}>{label}</button>
  )
}

function Empty({ children }) {
  return (
    <div style={{
      padding: '8px 10px', marginBottom: 6, borderRadius: 4,
      background: '#fafafa', border: '1px dashed #e5e7eb',
      fontSize: 12, color: '#9ca3af', fontStyle: 'italic',
    }}>{children}</div>
  )
}

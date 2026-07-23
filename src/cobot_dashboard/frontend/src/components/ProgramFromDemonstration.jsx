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
  // Map of clarification.id → operator answer (or suggested default
  // until they change it). Reset every time a new draft loads. Empty
  // string means "explicitly pending" (used for text/number inputs
  // the operator hasn't touched yet when no suggested existed).
  const [clarAnswers, setClarAnswers] = useState({})
  // Set of clarification ids the operator has EXPLICITLY interacted
  // with — clicked a choice, edited a text/number, picked a part.
  // Deliberately independent from clarAnswers: seeding the answer to
  // `c.suggested` on draft-load pre-fills the value but does NOT count
  // as an operator interaction, so the chip stays PENDING (or SUGGESTED
  // if we want to display that) until the operator does something.
  // "Accept all suggested defaults" ALSO does not mark anything as
  // interacted — that's an implicit-accept path, treated in the
  // learning store as answered=false / chose_suggested=true.
  const [clarInteracted, setClarInteracted] = useState(() => new Set())
  // How many times the composed program should cycle (default 1 —
  // matches the pre-cycles behaviour, byte-identical Lua). Set > 1 to
  // wrap the composed body in a Lua for-loop at codegen time
  // (initial move_home outside, body + return-to-home inside).
  // Continuous (count=0) is not offered here — the operator can flip
  // that in the ProgramEditor after Accept if they want it.
  const [cycles, setCycles] = useState(1)
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
      const data = await safeParseJsonResponse(res, 'upload')
      if (data._parseError) {
        setGenError(data._parseError)
        setGenerating(false)
        return null
      }
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
      const data = await safeParseJsonResponse(res, 'generate')
      if (data._parseError) {
        setGenError(data._parseError)
        setPhase(PHASE_UPLOAD)
        setGenerating(false)
        return
      }
      if (!data.ok) {
        // Backend now always returns JSON on error (even on 500), so
        // surface its real message + optional traceback excerpt.
        const detail = data.traceback_excerpt
          ? ` — ${data.traceback_excerpt.split('\n').slice(-3).join(' ').slice(0, 280)}`
          : ''
        setGenError(`${data.error || 'generate failed'}${detail}`)
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
      // Seed each clarification's answer with its `suggested` default
      // so "Accept all suggested defaults" is just an Accept with no
      // edits — the operator only needs to TOUCH the ones they want
      // to override. Plain-string legacy ambiguities (answerable=false)
      // are skipped here so they never poison the diff/learning store.
      const seed = {}
      for (const c of (data.intent?.ambiguities || [])) {
        if (c && c.answerable !== false && c.id) {
          seed[c.id] = c.suggested !== undefined ? c.suggested : ''
        }
      }
      setClarAnswers(seed)
      setClarInteracted(new Set())
      setCycles(1)
      setPhase(PHASE_REVIEW)
    } catch (e) {
      setGenError(`generate error: ${e?.message || e}`)
      setPhase(PHASE_UPLOAD)
    }
    setGenerating(false)
  }

  // Re-invoke the server-side composer on the CURRENT (in-memory,
  // possibly clarification-modified) intent. Used when an operator's
  // answer to an effector clarification would change the draft's
  // step list — a simple text relabelling wouldn't cover it because
  // the vacuum effector inserts a blow-off triplet and swaps two
  // step actions. Returns the fresh draft + intent from the server;
  // both replace the local state so the review re-renders with the
  // regenerated program.
  const [regenerating, setRegenerating] = useState(false)
  const [regenError,   setRegenError]   = useState('')
  async function regenerateDraft() {
    if (!demoId || !intent) return
    setRegenerating(true)
    setRegenError('')
    try {
      const applied = applyClarifications(draft, intent, clarAnswers)
      const res = await fetch(`/api/pbd/${demoId}/recompose`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ intent: applied.intent }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) {
        setRegenError(data.error || `regenerate failed (HTTP ${res.status})`)
        return
      }
      // Server returns { draft, intent }. Replace local state; keep
      // clarification answers as-is (they still align with the same
      // clarification set).
      if (data.draft)  setDraft(data.draft)
      if (data.intent) setIntent(data.intent)
      // Editable name mirrors the fresh draft.
      if (data.draft?.name) setEditName(data.draft.name)
    } catch (e) {
      setRegenError(`regenerate error: ${e?.message || e}`)
    } finally {
      setRegenerating(false)
    }
  }

  async function accept() {
    if (!draft || !demoId) return
    setAccepting(true)
    setAcceptError('')
    try {
      // Fold clarification answers into the draft + intent BEFORE the
      // POST so the saved program already reflects every answered
      // question (no second round-trip). The applied intent is what
      // gets persisted as the training target.
      const applied = applyClarifications(draft, intent, clarAnswers)
      // Cycles: 1 = no loop step (byte-identical to today). N ≥ 2
      // appends a loop step at the tail; codegen wraps the body in
      // `for i=1,N do ... end` with the initial move_home outside.
      // Strip any pre-existing loop step first so a re-accept doesn't
      // double up (shouldn't happen — the composer never emits one —
      // but defensive against a legacy PBD draft that already has
      // one on disk).
      const cyclesN = Math.max(1, Math.min(9999, Number.isFinite(cycles) ? cycles : 1))
      let outSteps = Array.isArray(applied.draft.steps)
        ? applied.draft.steps.filter((s) => s?.action !== 'loop')
        : []
      if (cyclesN > 1) {
        outSteps = outSteps.concat([{
          action: 'loop',
          label: 'Repeat ' + cyclesN + ' times',
          goto: 1,
          count: cyclesN,
        }])
      }
      const program = {
        ...applied.draft,
        steps:       outSteps,
        name:        editName.trim() || applied.draft.name,
        description: editDesc,
      }
      // The operator may have corrected the scene (renamed an object,
      // fixed an unmatched part, changed a location's role, edited the
      // spatial summary). Send the corrected scene + a corrected
      // intent (intent with the scene swapped in) so the learning
      // store captures both as supervised training targets for the
      // future on-Jetson model.
      const correctedScene = editScene || (applied.intent && applied.intent.scene) || null
      const correctedIntent = applied.intent && correctedScene
        ? { ...applied.intent, scene: correctedScene }
        : applied.intent
      const res = await fetch(`/api/pbd/${demoId}/correct`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          program,
          scene:   correctedScene,
          intent:  correctedIntent,
          // Operator's answers, keyed by clarification.id. Persisted
          // as a separate file (clarifications_answered.json) so the
          // learning loop can see which questions the AI needed to
          // ask and how the human answered them.
          //
          // Richer per-id shape: {answered, chose_suggested, value}.
          //   answered         = operator explicitly interacted with
          //                      this clarification (clicked / edited).
          //   chose_suggested  = the final value equals the AI's
          //                      suggested default (regardless of
          //                      whether the operator interacted).
          //   value            = the final answer stored on the draft.
          // Both signals matter for training: explicit-accept and
          // implicit-accept-of-default are DIFFERENT signals — one
          // means "the operator agreed", the other means "the operator
          // never looked". The backend also accepts the older flat
          // {id: value} shape for back-compat.
          clarifications_answered: (() => {
            const out = {}
            const byId = {}
            for (const c of (intent?.ambiguities || [])) {
              if (c && c.id) byId[c.id] = c
            }
            for (const [cid, v] of Object.entries(clarAnswers || {})) {
              const c = byId[cid]
              const suggested = c ? c.suggested : undefined
              let choseSuggested = false
              try {
                choseSuggested = (suggested !== undefined && suggested !== null)
                                 && JSON.stringify(v) === JSON.stringify(suggested)
              } catch { choseSuggested = false }
              out[cid] = {
                answered: clarInteracted.has(cid),
                chose_suggested: choseSuggested,
                value: v,
              }
            }
            return out
          })(),
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
                you already recorded on your phone. NeuRobots will transcribe
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
              clarAnswers={clarAnswers} setClarAnswers={setClarAnswers}
              clarInteracted={clarInteracted}
              setClarInteracted={setClarInteracted}
              cycles={cycles} setCycles={setCycles}
              regenerateDraft={regenerateDraft}
              regenerating={regenerating}
              regenError={regenError}
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
  clarAnswers, setClarAnswers,
  clarInteracted, setClarInteracted,
  cycles, setCycles,
  regenerateDraft, regenerating, regenError,
  accepting, acceptError,
}) {
  return (
    <div style={{ padding: 22 }}>
      {/* Provenance banner removed 2026-07-23 — the "generated from
          demonstration — poses pending perception" block was
          review-screen clutter (backendId still logged in
          metadata.json / backend_used.json for provenance). The
          transitedExternally flag remains available on props for any
          future warning; it just no longer renders here. */}

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
        <ClarificationsPanel
          clarifications={intent.ambiguities}
          answers={clarAnswers}
          setAnswers={setClarAnswers}
          interacted={clarInteracted}
          setInteracted={setClarInteracted}
          partsLibrary={partsLibrary}
        />
      )}

      {/* Regenerate draft — re-invokes the server-side composer on the
          current (in-memory) intent so answers that change step
          SHAPE (effector, source, etc.) can restructure the draft
          without re-recording the demo. applyClarifications already
          updates the in-memory intent; this button pushes that
          through the composer to get the fresh step list. */}
      {typeof regenerateDraft === 'function' && (
        <div style={{
          margin: '4px 0 14px', display: 'flex', alignItems: 'center',
          gap: 10,
        }}>
          <button onClick={regenerateDraft} disabled={!!regenerating}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: regenerating ? '#f3f4f6' : '#eff6ff',
              color:      regenerating ? '#9ca3af' : '#1d4ed8',
              border:     '1px solid ' + (regenerating ? '#e5e7eb' : '#bfdbfe'),
              borderRadius: 6,
              cursor: regenerating ? 'default' : 'pointer',
            }}>
            {regenerating ? 'Regenerating…' : '↻ Regenerate draft'}
          </button>
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            Rebuild the step list from the current answers (effector,
            fixed vs vision, part choice) without re-recording.
          </span>
          {regenError && (
            <span style={{ fontSize: 12, color: '#DC2626' }}>{regenError}</span>
          )}
        </div>
      )}

      {/* Retrieval-augment few-shot examples are still fetched, logged
          to metadata.retrieval.used_examples, and shape the AI's draft
          — the operator-facing "Informed by N past demos" indicator
          was removed as review-screen clutter. The retrieval mechanism
          itself and its provenance record are unchanged. */}

      <Section title="Program name (editable)">
        <input value={editName} onChange={(e) => setEditName(e.target.value)}
          style={inputBox} />
        <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
          rows={2} style={{ ...inputBox, marginTop: 6, resize: 'vertical' }} />
      </Section>

      <Section title="Run mode">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, color: '#111' }}>Run for</span>
          <input type="number" min={1} step={1}
            value={Number.isFinite(cycles) ? cycles : 1}
            onChange={(e) => {
              const raw = parseInt(e.target.value, 10)
              setCycles(Number.isFinite(raw) && raw >= 1 ? raw : 1)
            }}
            style={{ ...inputBox, width: 84, textAlign: 'right' }} />
          <span style={{ fontSize: 14, color: '#111' }}>
            cycle{cycles === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          The initial move-to-home runs once at program start; the
          pick/place body then cycles the number of times you set here.
          Continuous (run-forever) programs can be enabled in the
          Program editor after saving.
        </div>
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

      {/* Voice transcript display removed 2026-07-23. The transcript
          is still parsed, persisted (audio_transcript.json), and fed
          to the understanding backend — the read-only review-screen
          echo was clutter. The `transcript` prop is still received in
          case a future placement wants it. */}

      {acceptError && <ErrorBanner msg={acceptError} />}
      {/* Cancel + Accept buttons live in the wizard's sticky footer
          now so they remain tappable even when this review content is
          taller than the viewport. */}
    </div>
  )
}


// ── ClarificationsPanel — interactive question/answer block ──────
//
// Renders each structured clarification with the right input for its
// `type`, pre-filled from `suggested`. Legacy plain-string ambiguities
// (answerable=false after schema wrapping) render as read-only chips
// so old demos still display.
//
// STATUS MODEL — three visible states:
//   PENDING   — operator has not interacted AND no seeded value.
//   SUGGESTED — operator has not interacted BUT a suggested default
//               is pre-loaded (accept-as-is is one click of the button
//               below or an explicit click on the highlighted option).
//   ANSWERED  — operator explicitly interacted with the input, regardless
//               of whether the chosen value equals the suggested default.
//
// This distinguishes "the AI proposed X and the operator agreed" from
// "the AI proposed X and the operator never looked" — both are useful
// training signals, but they're not the same signal. The prior
// implementation derived status from (value === suggested), so
// explicitly clicking the option that matched the default kept the
// chip stuck on SUGGESTED — the bug this panel now fixes.
//
// The "Accept all suggested defaults" button ONLY populates values;
// it does NOT mark the entry as interacted. That preserves the
// implicit-accept-of-default signal in the learning store.
function ClarificationsPanel({
  clarifications, answers, setAnswers,
  interacted, setInteracted,
  partsLibrary,
}) {
  const list = Array.isArray(clarifications) ? clarifications : []
  const interactive = list.filter((c) => c && c.answerable !== false && c.id)
  const passive     = list.filter((c) => c && (c.answerable === false || !c.id))

  // Defensive default: if the parent didn't thread the interaction set
  // through (a prop-drilling regression like the one this file already
  // crashed on before this guard landed), fall back to an empty Set so
  // the review screen still renders with every chip PENDING/SUGGESTED —
  // it will never white-screen over chip state. Warn once per mount so
  // the drop stays visible without spamming the console. A no-op setter
  // keeps the choice buttons clickable even when interaction tracking
  // is disconnected — the answer still writes through to `answers`,
  // just without a learning-store answered flag.
  const noopSet = (fn) => { if (typeof fn === 'function') fn(new Set()) }
  const interactedSet = interacted instanceof Set ? interacted : null
  const _setInteracted = typeof setInteracted === 'function' ? setInteracted : noopSet
  if (!interactedSet) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // (Intentionally not a hook — a one-shot render-time warn is enough
    // for the operator/dev-console breadcrumb.)
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[PBD] ClarificationsPanel: `interacted` prop missing or not a Set — falling back to empty; chips will read as SUGGESTED/PENDING only.')
    }
  }

  // Answered = explicitly interacted. Pending = not interacted (whether
  // or not a suggested default is pre-loaded — the operator hasn't
  // confirmed anything yet).
  const answeredCount = interactive.reduce(
    (n, c) => n + (interactedSet && interactedSet.has(c.id) ? 1 : 0), 0)
  const pendingCount = interactive.length - answeredCount

  function markInteracted(id) {
    _setInteracted((prev) => {
      if (prev && prev.has(id)) return prev
      const next = new Set(prev || [])
      next.add(id)
      return next
    })
  }
  function setOne(id, v) {
    setAnswers((prev) => ({ ...(prev || {}), [id]: v }))
    markInteracted(id)
  }
  function acceptAllSuggested() {
    // Populate values only — deliberately does NOT touch the interacted
    // set, so the learning store still records these as implicit
    // accepts (answered:false, chose_suggested:true).
    const next = { ...(answers || {}) }
    for (const c of interactive) {
      if (next[c.id] === undefined || next[c.id] === '') {
        if (c.suggested !== undefined && c.suggested !== null) {
          next[c.id] = c.suggested
        }
      }
    }
    setAnswers(next)
  }

  return (
    <Section title={`Clarifications (${interactive.length})`}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
        fontSize: 12, color: '#374151',
      }}>
        <span><b>{answeredCount}</b> answered · <b>{pendingCount}</b> pending</span>
        <div style={{ flex: 1 }} />
        {pendingCount > 0 && (
          <button onClick={acceptAllSuggested}
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 600,
              background: '#eff6ff', color: '#1d4ed8',
              border: '1px solid #bfdbfe', borderRadius: 4, cursor: 'pointer',
            }}>
            Accept all suggested defaults
          </button>
        )}
      </div>

      {interactive.map((c) => {
        const v = answers ? answers[c.id] : undefined
        const isEmpty = (v === undefined || v === null || v === '')
        const isInteracted = !!(interactedSet && interactedSet.has(c.id))
        const isPending = !isInteracted && isEmpty
        // Not interacted but a seeded suggestion is pre-loaded — the
        // AI proposed something and the operator hasn't confirmed it
        // yet. Rendered distinctly from PENDING (empty) so the review
        // screen makes the "seeded default is here for you to confirm"
        // read at a glance.
        const isSuggestedOnly = !isInteracted && !isEmpty
        return (
          <ClarificationRow
            key={c.id}
            c={c}
            value={v}
            isPending={isPending}
            isSuggestedOnly={isSuggestedOnly}
            isAnswered={isInteracted}
            onChange={(next) => setOne(c.id, next)}
            partsLibrary={partsLibrary}
          />
        )
      })}

      {passive.length > 0 && (
        <div style={{ marginTop: interactive.length ? 10 : 0 }}>
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
            Notes (read-only — legacy format):
          </div>
          {passive.map((c, i) => (
            <div key={`p${i}`} style={{
              padding: '6px 10px', marginBottom: 4, borderRadius: 6,
              background: '#fffbeb', border: '1px solid #fde68a',
              fontSize: 12, color: '#92400e',
            }}>{c.question || c}</div>
          ))}
        </div>
      )}
    </Section>
  )
}

function ClarificationRow({
  c, value,
  isPending, isSuggestedOnly, isAnswered,
  onChange, partsLibrary,
}) {
  // Colour by state, not by value: an interacted answer that happens
  // to equal the suggested default still reads as ANSWERED.
  const borderColor = isAnswered
    ? '#86efac'
    : (isSuggestedOnly ? '#bfdbfe' : '#fde68a')
  const tintColor = isAnswered
    ? '#f0fdf4'
    : (isSuggestedOnly ? '#eff6ff' : '#fffbeb')
  const statusText = isAnswered
    ? 'ANSWERED'
    : (isSuggestedOnly ? 'SUGGESTED' : 'PENDING')
  const statusColor = isAnswered
    ? '#166534'
    : (isSuggestedOnly ? '#1d4ed8' : '#92400e')

  return (
    <div style={{
      padding: 10, marginBottom: 6, borderRadius: 6,
      background: tintColor, border: '1px solid ' + borderColor,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
          padding: '1px 6px', borderRadius: 4,
          color: '#fff', background: '#6b7280',
          textTransform: 'uppercase',
        }}>{c.field}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
          padding: '1px 6px', borderRadius: 4,
          color: statusColor, background: '#fff',
          border: '1px solid ' + borderColor,
        }}>{statusText}</span>
      </div>
      <div style={{ fontSize: 13, color: '#111', marginBottom: 8 }}>
        {c.question || <em>(no question text)</em>}
      </div>
      <ClarificationInput
        c={c} value={value} onChange={onChange}
        partsLibrary={partsLibrary}
      />
    </div>
  )
}

function ClarificationInput({ c, value, onChange, partsLibrary }) {
  const type = c?.type || 'text'

  if (type === 'choice') {
    const opts = Array.isArray(c.options) ? c.options : []
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {opts.map((opt, i) => {
          const label = typeof opt === 'string' ? opt : (opt?.label || JSON.stringify(opt))
          const val   = typeof opt === 'string' ? opt : (opt?.value !== undefined ? opt.value : opt)
          const active = JSON.stringify(val) === JSON.stringify(value)
          return (
            <button key={i} onClick={() => onChange(val)}
              style={{
                padding: '6px 10px', fontSize: 12,
                fontWeight: active ? 700 : 500,
                background: active ? '#2563EB' : '#fff',
                color: active ? '#fff' : '#374151',
                border: '1px solid ' + (active ? '#2563EB' : '#d1d5db'),
                borderRadius: 6, cursor: 'pointer',
              }}>{label}</button>
          )
        })}
      </div>
    )
  }

  if (type === 'number') {
    return (
      <input type="number"
        value={value ?? ''}
        onChange={(e) => {
          const n = e.target.value
          onChange(n === '' ? '' : Number(n))
        }}
        placeholder={c.suggested !== undefined ? String(c.suggested) : ''}
        style={{ ...inputBox, maxWidth: 160 }} />
    )
  }

  if (type === 'part_select') {
    // Build the dropdown from `c.options` (the AI's top matches) plus
    // every taught library part — the operator may know it's actually
    // a different taught part the AI ignored. Untaught parts stay
    // hidden, mirroring the program editor's Detect Part dropdown.
    // A trailing "New part — not in library" option lets the operator
    // record a match against a part that has not been taught yet;
    // applyClarifications stores part_id=null with part_source='new'
    // so downstream consumers can render the demo-derived descriptor
    // instead of dereferencing a library entry that isn't there.
    // TODO: hook this into an add-to-library flow when one exists —
    // right now it just leaves the descriptor as the display name.
    const seen = new Set()
    const merged = []
    for (const opt of (Array.isArray(c.options) ? c.options : [])) {
      const pid = typeof opt === 'string' ? opt : opt?.part_id
      const name = typeof opt === 'string'
        ? opt
        : (opt?.name || opt?.part_id || '')
      if (!pid || seen.has(pid)) continue
      seen.add(pid)
      merged.push({ part_id: pid, name })
    }
    for (const p of (partsLibrary || [])) {
      if (!p?.id || seen.has(p.id)) continue
      if (Number(p.teach_count || 0) <= 0) continue
      seen.add(p.id)
      merged.push({ part_id: p.id, name: p.name || p.id })
    }
    const NEW_PART = '__new_part__'
    const current = typeof value === 'string'
      ? value
      : (value?.part_id === null ? NEW_PART : (value?.part_id || ''))
    return (
      <select value={current}
        onChange={(e) => {
          const pid = e.target.value
          if (pid === NEW_PART) {
            // Sentinel — applyClarifications interprets this as
            // "part_id: null, part_source: 'new'".
            onChange(NEW_PART)
            return
          }
          const hit = merged.find((p) => p.part_id === pid)
          onChange(hit ? { part_id: pid, name: hit.name } : pid)
        }}
        style={{ ...inputBox, maxWidth: 320 }}>
        <option value="">— pick a part —</option>
        {merged.map((p) => (
          <option key={p.part_id} value={p.part_id}>{p.name} ({p.part_id})</option>
        ))}
        <option value={NEW_PART}>New part — not in library</option>
      </select>
    )
  }

  // Default: text.
  return (
    <input type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={c.suggested ? String(c.suggested) : ''}
      style={inputBox} />
  )
}


// Tolerant parser for /api/pbd/* responses.
// - If the body is valid JSON → return it as-is.
// - If the body isn't JSON (e.g. FastAPI's bare-text 500 page, an
//   nginx HTML page, a truncated stream), return {_parseError: "<label>
//   failed (HTTP <status>): <first 200 chars of body>"} so the UI can
//   show a real message instead of "Unexpected token 'I' is not valid
//   JSON".
// - On res.ok=false WITH valid JSON, the caller still sees data.ok=false
//   and renders data.error.
async function safeParseJsonResponse(res, label) {
  let raw = ''
  try { raw = await res.text() } catch { /* network died mid-body */ }
  const ctype = (res.headers.get('content-type') || '').toLowerCase()
  if (ctype.includes('application/json') || (raw.startsWith('{') || raw.startsWith('['))) {
    try {
      return JSON.parse(raw)
    } catch (e) {
      return {
        _parseError: `${label} response was not valid JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`,
      }
    }
  }
  // Plain-text / HTML body — the symptom the original bug created.
  // Show the first 200 chars verbatim so the operator can read the
  // actual server message.
  return {
    _parseError: `${label} failed (HTTP ${res.status} ${res.statusText || ''}): ${raw.slice(0, 200).trim() || '<empty body>'}`,
  }
}


// ── Clarifications: apply operator answers to draft + intent ─────
//
// Reads each clarification's `affects` metadata (scope + path) and
// writes the answer to the right field on a DEEP COPY of the draft
// + intent. The frontend never mutates the props it received — the
// returned objects are what gets POSTed to /correct, so the saved
// program is the post-answers version. Unknown affects/paths are
// ignored silently (better than throwing and blocking Accept on a
// malformed AI response).
function applyClarifications(draft, intent, answers) {
  const d = draft ? JSON.parse(JSON.stringify(draft)) : null
  const i = intent ? JSON.parse(JSON.stringify(intent)) : null
  if (!d || !i) return { draft: d, intent: i }

  const ambs = Array.isArray(i.ambiguities) ? i.ambiguities : []
  for (const c of ambs) {
    if (!c || c.answerable === false || !c.id) continue
    if (!(c.id in (answers || {}))) continue
    const ans = answers[c.id]
    // Empty-string answers from a text/number input that the operator
    // cleared aren't applied — the AI's existing draft value stays.
    if (ans === '' || ans === null || ans === undefined) continue
    const aff = c.affects || {}
    const scope = aff.scope || 'other'
    const path  = String(aff.path || '')
    try {
      // Legacy config.gripper clarification (older AI outputs) routes
      // to op.effector — the composer's new discriminator that drives
      // Engage/Disengage vacuum vs Open/Grip/Release step naming.
      // Options "Suction cup" / "Vacuum" → 'vacuum'; anything with
      // "finger", "parallel", "jaw", or "gripper" → 'finger'; magnet
      // variants → 'magnetic'. Route AND recompose (the operator sees
      // a "Regenerate draft" prompt after answering — see the footer).
      if (scope === 'config' && path === 'config.gripper'
          && Array.isArray(i.operations)) {
        const s = String(ans || '').toLowerCase()
        const chosen = /vacuum|suction/.test(s) ? 'vacuum'
                     : /magnet/.test(s) ? 'magnetic'
                     : 'finger'
        for (const op of i.operations) op.effector = chosen
        continue   // draft-step restructuring happens via recompose
      }
      if (scope === 'config' && path === 'config.pallet') {
        // Expected shape: { rows, cols, layers, fill_order? }. Falls
        // back to the AI's existing config.pallet for missing keys so
        // partial answers keep spacing/corner_tcp intact.
        const existing = (d.config && d.config.pallet) || {}
        const r = Number(ans.rows ?? existing.rows ?? 1)
        const cN = Number(ans.cols ?? existing.cols ?? 1)
        const l = Number(ans.layers ?? existing.layers ?? 1)
        d.config = { ...(d.config || {}) }
        d.config.pallet = {
          ...existing,
          rows:   Math.max(1, r),
          cols:   Math.max(1, cN),
          layers: Math.max(1, l),
          fill_order: ans.fill_order || existing.fill_order || 'row_lr',
        }
        // Mirror the same shape onto the intent op so the saved
        // intent (training target) tells the same story.
        const opIdx = Number(aff.operation_index ?? 0)
        if (Array.isArray(i.operations) && i.operations[opIdx]) {
          i.operations[opIdx].pallet = {
            ...(i.operations[opIdx].pallet || {}),
            rows: d.config.pallet.rows,
            cols: d.config.pallet.cols,
            layers: d.config.pallet.layers,
            fill_order: d.config.pallet.fill_order,
            assumed: false,
          }
        }
      } else if (scope === 'operation' && Array.isArray(i.operations)) {
        const opIdx = Number(aff.operation_index ?? 0)
        const op = i.operations[opIdx]
        if (!op) continue
        // Legacy-compat routing: older AI outputs put the fixed-vs-
        // vision clarification on `place.location_hint` (or occasionally
        // `pick.location_hint`) with the option strings themselves
        // describing the choice. Detect that specific pattern — options
        // containing "fixed" AND ("vision" OR "detect") — and route the
        // answer to `op.source` PLUS restructure the draft's steps.
        // Anything that doesn't match this narrow pattern keeps the
        // pre-existing text-field behaviour so unrelated multi-choice
        // location clarifications aren't hijacked.
        const optStrs = Array.isArray(c.options)
          ? c.options.map((o) => typeof o === 'string' ? o : (o?.label || ''))
          : []
        const looksLikeFixedVsVision =
             optStrs.length === 2
          && optStrs.some((s) => /fixed/i.test(s))
          && optStrs.some((s) => /vision|detect|camera/i.test(s))
        const isSourcePath = path === 'source'
          || ((path === 'place.location_hint' || path === 'pick.location_hint')
              && looksLikeFixedVsVision)

        if (isSourcePath) {
          // Normalise the answer to one of the two canonical values.
          const s = String(ans || '').toLowerCase()
          const chosen = (s === 'fixed_position' || /fixed/i.test(s))
            ? 'fixed_position'
            : 'camera_library'
          op.source = chosen
          // Restructure the DRAFT's steps to match — the composer
          // already gates its detect emission on op.source, but this
          // draft was built once and won't be re-composed unless we
          // splice the step list. Bidirectional so flipping the
          // answer restores the previous shape cleanly.
          if (Array.isArray(d.steps)) {
            if (chosen === 'fixed_position') {
              d.steps = d.steps.filter((st) => st?.action !== 'detect')
            } else {
              // Add a detect step back if none exists. Canonical
              // position is right after the opening grip-open step
              // (or at the top if there isn't one) and before the
              // first derived-from='pick' approach. Uses the current
              // target_part.name for the label so the operator sees
              // the same wording the composer would emit.
              const hasDetect = d.steps.some((st) => st?.action === 'detect')
              if (!hasDetect) {
                const partName = op.target_part?.name || 'library part'
                const detectStep = {
                  action: 'detect',
                  label:  'Find ' + partName,
                  mode:   'library',
                }
                // Insert just before the first pick-approach step; if
                // that can't be found, drop the detect right after the
                // first gripper-open (or at index 0).
                let insertAt = d.steps.findIndex(
                  (st) => st?.action === 'move_linear' && st?.derived_from === 'pick')
                if (insertAt < 0) {
                  const gripIdx = d.steps.findIndex((st) => st?.action === 'open_gripper')
                  insertAt = gripIdx >= 0 ? gripIdx + 1 : 0
                }
                d.steps = [
                  ...d.steps.slice(0, insertAt),
                  detectStep,
                  ...d.steps.slice(insertAt),
                ]
              }
            }
          }
          // Fall through — don't run any of the other operation-scope
          // handlers on this answer.
          continue
        }
        if (path === 'effector') {
          // New AI-emitted shape. Value is one of 'vacuum' | 'finger'
          // | 'magnetic' (canonical). Route to op.effector; the draft
          // steps get restructured when the operator hits Regenerate
          // draft (calls /api/pbd/{demo_id}/recompose on the server).
          const s = String(ans || '').toLowerCase()
          op.effector = /vacuum|suction/.test(s) ? 'vacuum'
                      : /magnet/.test(s) ? 'magnetic'
                      : 'finger'
          continue
        }
        if (path === 'target_part') {
          // ans is one of:
          //   • '__new_part__' sentinel  → part_id:null, part_source:'new'
          //   • a part_id string
          //   • { part_id, name } object
          if (ans === '__new_part__') {
            // Descriptor stays whatever the AI/operator already put
            // in target_part.name — the scene section is the single
            // source of truth for the descriptor.
            op.target_part = {
              ...(op.target_part || {}),
              part_id: null,
              part_source: 'new',
              // Preserve the current name; if unset, drop back to a
              // generic placeholder so downstream renderers never see
              // an empty label.
              name: op.target_part?.name || 'new part',
            }
          } else {
            const pid  = typeof ans === 'string' ? ans : ans?.part_id
            const name = typeof ans === 'string' ? '' : (ans?.name || '')
            if (pid) {
              op.target_part = {
                ...(op.target_part || {}),
                part_id: pid,
                name: name || op.target_part?.name || pid,
                source: 'matched_to_library',
                part_source: 'library',
              }
            }
          }
        } else if (path === 'count_hint') {
          const n = Number(ans)
          op.count_hint = Number.isFinite(n) && n > 0 ? n : ans
        } else if (path === 'pick.location_hint') {
          op.pick = { ...(op.pick || {}), location_hint: String(ans) }
        } else if (path === 'place.location_hint') {
          op.place = { ...(op.place || {}), location_hint: String(ans) }
        }
      } else if (scope === 'step' && Array.isArray(d.steps)) {
        // Generic step.<field> path — best-effort. Used for one-off
        // step tweaks the model might emit.
        const stepIdx = Number(aff.step_index ?? -1)
        if (stepIdx >= 0 && d.steps[stepIdx] && path) {
          // path is dot-delimited from the step root.
          const keys = path.split('.')
          let cur = d.steps[stepIdx]
          for (let k = 0; k < keys.length - 1; k++) {
            const key = keys[k]
            cur[key] = cur[key] || {}
            cur = cur[key]
          }
          cur[keys[keys.length - 1]] = ans
        }
      }
    } catch {
      // Don't let a malformed `affects` block break Accept.
    }
  }
  return { draft: d, intent: i }
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
        Here&rsquo;s what NeuRobots understood from the demonstration by
        combining the video and your narration. Correct anything that&rsquo;s
        wrong — your corrections train the model.
      </div>

      <SubTitle text="Spatial summary" />
      <textarea value={scene.spatial_summary || ''}
        onChange={(e) => updateSummary(e.target.value)}
        placeholder="e.g. A bin of brackets on the right; an empty tray on the left."
        rows={2}
        style={{ ...inputBox, marginBottom: 14, resize: 'vertical' }} />

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

import { useCallback, useEffect, useRef, useState } from 'react'

/*
 * LiveRecorder — in-browser video+audio capture for the PBD wizard.
 *
 * Hands the parent a single Blob containing both video AND narration
 * audio captured from the same MediaStream, so the PBD pipeline gets
 * the equivalent of a single uploaded clip. Parent decides what to do
 * with the blob (PBD wizard wraps it in a File and feeds the existing
 * /api/pbd/upload path).
 *
 * ────────────────────────────────────────────────────────────────────
 * SECURE-CONTEXT NOTE
 * ────────────────────────────────────────────────────────────────────
 * Browsers gate getUserMedia behind window.isSecureContext — true for
 * https:// and http://localhost, false for http:// over a LAN IP.
 * The RoboAi dashboard is served at http://192.168.1.246:8080, so on
 * the tablet this component will refuse to enable the camera until
 * the dashboard is served over HTTPS (or accessed via localhost, e.g.
 * on the Jetson itself).
 *
 * We detect the condition explicitly and surface a clear, actionable
 * message — the parent's file-upload control remains available as the
 * fallback. We still ATTEMPT getUserMedia even on non-secure contexts
 * because some Android setups allow it for LAN IPs; we catch the
 * rejection cleanly when they don't.
 *
 * To unlock live recording on the tablet over the network: serve the
 * dashboard over HTTPS, or add the dashboard origin to Chrome's
 * `chrome://flags/#unsafely-treat-insecure-origin-as-secure` list (per
 * tablet, dev-only workaround).
 * ────────────────────────────────────────────────────────────────────
 */

// State machine. Linear-ish — `recorded` falls back to `streaming` on
// re-record. `denied` and `unsupported` are terminal states that show
// a clear message + the upload fallback.
const S_IDLE        = 'idle'         // haven't asked for permission yet
const S_REQUESTING  = 'requesting'   // permission prompt is up
const S_STREAMING   = 'streaming'    // live preview, ready to record
const S_RECORDING   = 'recording'    // MediaRecorder running
const S_RECORDED    = 'recorded'     // playback of the captured clip
const S_DENIED      = 'denied'       // user denied or browser blocked
const S_UNSUPPORTED = 'unsupported'  // no getUserMedia / not a secure context

// Pick the best mimeType the browser actually supports. The PBD
// backend accepts .webm and .mp4 (and others) so we prefer WebM with
// VP8 + Opus for broad Android Chrome compatibility, and fall through
// to plain mp4 / browser default if that's all that's available.
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return ''
  }
  const candidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
  ]
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

function extForMime(mime) {
  if (!mime) return 'webm'
  if (mime.startsWith('video/webm')) return 'webm'
  if (mime.startsWith('video/mp4'))  return 'mp4'
  return 'webm'
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60).toString().padStart(2, '0')
  const s = (total % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function LiveRecorder({ onClipReady, disabled, autoStart = false }) {
  const [state, setState]       = useState(S_IDLE)
  const [error, setError]       = useState('')
  const [facing, setFacing]     = useState('environment')  // rear by default
  const [hasMultipleCams, setHasMultipleCams] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Imperative refs so we can stop tracks reliably from any state.
  const streamRef     = useRef(null)
  const recorderRef   = useRef(null)
  const chunksRef     = useRef([])
  const previewRef    = useRef(null)
  const playbackRef   = useRef(null)
  const timerRef      = useRef(null)
  const startedAtRef  = useRef(0)
  const recordedRef   = useRef(null)  // { blob, url, mimeType, filename }

  const secureCtx     = typeof window !== 'undefined' ? !!window.isSecureContext : false
  const hasGetUserMedia = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'

  // ── lifecycle: tear everything down on unmount ─────────────────

  useEffect(() => {
    return () => {
      stopTracks()
      if (timerRef.current) clearInterval(timerRef.current)
      if (recordedRef.current?.url) {
        URL.revokeObjectURL(recordedRef.current.url)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── auto-enter camera mode ─────────────────────────────────────
  // When the parent passes autoStart={true} (the PBD wizard does, so
  // the user lands straight into the live preview), kick off
  // getUserMedia on first mount. We gate on hasGetUserMedia so we
  // don't fire the permission prompt on browsers that can't satisfy
  // it (the secure-context banner above explains the situation
  // already). The ref guards against re-trigger on prop changes /
  // re-renders — if the user denies once, they hit "Try again" to
  // re-prompt, not an effect loop.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStart) return
    if (autoStartedRef.current) return
    if (!hasGetUserMedia) return
    if (state !== S_IDLE) return
    autoStartedRef.current = true
    startStream(facing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, hasGetUserMedia])

  // Wire the latest stream into the preview <video> whenever either
  // changes. Doing this in an effect (vs. inline in startStream) keeps
  // re-renders consistent and avoids race conditions when the
  // <video> mounts after the stream resolves.
  useEffect(() => {
    if (state === S_STREAMING || state === S_RECORDING) {
      const v = previewRef.current
      if (v && streamRef.current && v.srcObject !== streamRef.current) {
        v.srcObject = streamRef.current
      }
    }
  }, [state])

  // ── helpers ────────────────────────────────────────────────────

  function stopTracks() {
    const s = streamRef.current
    if (s) {
      for (const t of s.getTracks()) {
        try { t.stop() } catch { /* swallow */ }
      }
    }
    streamRef.current = null
  }

  async function probeDeviceCount() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter((d) => d.kind === 'videoinput')
      setHasMultipleCams(cams.length > 1)
    } catch { /* swallow */ }
  }

  async function startStream(useFacing) {
    if (!hasGetUserMedia) {
      setState(S_UNSUPPORTED)
      setError(
        'Your browser does not expose getUserMedia. Use the Upload tab to '
        + 'record on the tablet camera app and upload the clip.',
      )
      return
    }
    setState(S_REQUESTING)
    setError('')
    // Free any previous stream before requesting a new one.
    stopTracks()
    const constraints = {
      audio: true,
      video: { facingMode: { ideal: useFacing } },
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      setFacing(useFacing)
      setState(S_STREAMING)
      probeDeviceCount()
    } catch (e) {
      // NotAllowedError / SecurityError = user denied or the origin
      // isn't a secure context. NotFoundError = no camera. Anything
      // else surfaces verbatim.
      const name = e?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setState(S_DENIED)
        setError(
          secureCtx
            ? 'Camera/microphone permission was denied. Allow access in the '
              + 'browser permission menu, then click Enable camera again.'
            : 'Live recording requires a secure connection (HTTPS or '
              + 'localhost). This page is plain HTTP, which the browser '
              + 'blocks from using the camera. Use the Upload tab below, '
              + 'or enable HTTPS on the Jetson — run '
              + '`sudo scripts/generate_dashboard_cert.sh` and restart '
              + 'roboai-dashboard, then reload as https://<jetson-ip>:8080.',
        )
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setState(S_DENIED)
        setError(`No camera available (${name}). Use the Upload tab below.`)
      } else {
        setState(S_DENIED)
        setError(`Camera error: ${e?.message || name || 'unknown'}. Use the Upload tab below.`)
      }
    }
  }

  function switchCamera() {
    if (state !== S_STREAMING) return
    const next = facing === 'environment' ? 'user' : 'environment'
    startStream(next)
  }

  function beginRecording() {
    const stream = streamRef.current
    if (!stream) return
    const mime = pickMimeType()
    let recorder
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
    } catch (e) {
      setError(`MediaRecorder init failed: ${e?.message || e}`)
      return
    }
    chunksRef.current = []
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data)
    }
    recorder.onstop = () => finalizeRecording(recorder.mimeType || mime)
    recorder.onerror = (ev) => {
      setError(`recorder error: ${ev?.error?.message || 'unknown'}`)
    }
    recorderRef.current = recorder
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 250)
    try {
      recorder.start(1000)  // 1s timeslice — chunks arrive periodically
    } catch (e) {
      setError(`recorder start failed: ${e?.message || e}`)
      return
    }
    setState(S_RECORDING)
  }

  function endRecording() {
    const r = recorderRef.current
    if (!r) return
    try { r.stop() } catch { /* swallow */ }
  }

  function finalizeRecording(mimeType) {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const ext = extForMime(mimeType)
    const blob = new Blob(chunksRef.current, { type: mimeType || `video/${ext}` })
    chunksRef.current = []
    if (recordedRef.current?.url) URL.revokeObjectURL(recordedRef.current.url)
    const url = URL.createObjectURL(blob)
    const filename = `pbd_recording_${Date.now()}.${ext}`
    recordedRef.current = { blob, url, mimeType, filename }
    // Release the camera now so the user can review without the light on.
    stopTracks()
    setState(S_RECORDED)
  }

  function useRecording() {
    const r = recordedRef.current
    if (!r) return
    onClipReady?.(r.blob, r.filename, r.mimeType)
  }

  async function reRecord() {
    if (recordedRef.current?.url) {
      URL.revokeObjectURL(recordedRef.current.url)
      recordedRef.current = null
    }
    setElapsedMs(0)
    await startStream(facing)
  }

  // ── render ─────────────────────────────────────────────────────

  // First-paint UX — when the user hasn't clicked Enable Camera yet,
  // we render an inert affordance plus the secure-context warning if
  // applicable. We don't auto-request the camera; that's a permission
  // prompt and should always be explicit.
  return (
    <div style={{ marginBottom: 16 }}>
      {(!secureCtx || !hasGetUserMedia) && state !== S_RECORDED && (
        <InsecureContextBanner
          secureCtx={secureCtx}
          hasGetUserMedia={hasGetUserMedia}
        />
      )}

      {state === S_IDLE && (
        <RecorderShell>
          <div style={{ textAlign: 'center', padding: '24px 16px' }}>
            <div style={{ fontSize: 14, color: '#374151', marginBottom: 12 }}>
              Film the workspace while narrating what should happen.
              NeuRobots will fuse the video and your voice into a draft
              program.
            </div>
            <button onClick={() => startStream(facing)}
              disabled={disabled}
              style={primaryBtn(disabled)}>
              ● Enable camera + microphone
            </button>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
              Defaults to the rear camera + on-device microphone.
            </div>
          </div>
        </RecorderShell>
      )}

      {state === S_REQUESTING && (
        <RecorderShell>
          <div style={{ textAlign: 'center', padding: '24px 16px' }}>
            <Spinner />
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 10 }}>
              Waiting for browser permission…
            </div>
          </div>
        </RecorderShell>
      )}

      {(state === S_STREAMING || state === S_RECORDING) && (
        <RecorderShell>
          <video
            ref={previewRef}
            autoPlay
            muted
            playsInline
            style={{
              width: '100%', maxHeight: 360, background: '#000',
              display: 'block', objectFit: 'contain',
            }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 14px',
            background: '#0f172a', color: '#fff',
          }}>
            {state === S_RECORDING ? (
              <>
                <span style={{
                  display: 'inline-block', width: 10, height: 10,
                  borderRadius: '50%', background: '#DC2626',
                  animation: 'roboai-rec-pulse 1s ease-in-out infinite',
                }} />
                <style>{
                  '@keyframes roboai-rec-pulse {'
                  + '0%,100%{opacity:1}50%{opacity:0.3}}'
                }</style>
                <span style={{ fontSize: 13, fontWeight: 600 }}>REC</span>
                <span style={{
                  fontFamily: 'ui-monospace,monospace', fontSize: 14,
                  fontVariantNumeric: 'tabular-nums',
                }}>{formatElapsed(elapsedMs)}</span>
                <div style={{ flex: 1 }} />
                <button onClick={endRecording} style={stopBtn}>
                  ■ Stop
                </button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 13, color: '#cbd5e1' }}>
                  Ready · {facing === 'environment' ? 'rear camera' : 'front camera'}
                </span>
                <div style={{ flex: 1 }} />
                {hasMultipleCams && (
                  <button onClick={switchCamera} style={ghostBtn}>
                    Switch camera
                  </button>
                )}
                <button onClick={beginRecording} style={recordBtn}>
                  ● Start Recording
                </button>
              </>
            )}
          </div>
        </RecorderShell>
      )}

      {state === S_RECORDED && recordedRef.current && (
        <RecorderShell>
          <video
            ref={playbackRef}
            controls
            src={recordedRef.current.url}
            style={{
              width: '100%', maxHeight: 360, background: '#000',
              display: 'block', objectFit: 'contain',
            }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: '#f8fafc',
            borderTop: '1px solid #e5e7eb',
          }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {(recordedRef.current.blob.size / 1024 / 1024).toFixed(2)} MB ·
              {' '}{recordedRef.current.mimeType || 'unknown type'}
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={reRecord} style={ghostBtnLight}>
              ↻ Re-record
            </button>
            <button onClick={useRecording} style={primaryBtn(false)}>
              Use this recording →
            </button>
          </div>
        </RecorderShell>
      )}

      {state === S_DENIED && (
        <RecorderShell>
          <div style={{ padding: 16 }}>
            <div style={{
              padding: 12, marginBottom: 10, borderRadius: 6,
              background: '#fef2f2', border: '1px solid #fecaca',
              color: '#b91c1c', fontSize: 13, lineHeight: 1.5,
            }}>{error || 'Camera/microphone unavailable.'}</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => startStream(facing)}
                style={ghostBtnLight}>
                Try again
              </button>
            </div>
          </div>
        </RecorderShell>
      )}

      {state === S_UNSUPPORTED && (
        <RecorderShell>
          <div style={{ padding: 16 }}>
            <div style={{
              padding: 12, borderRadius: 6,
              background: '#fffbeb', border: '1px solid #fde68a',
              color: '#92400e', fontSize: 13, lineHeight: 1.5,
            }}>{error || 'Live recording is not available in this browser.'}</div>
          </div>
        </RecorderShell>
      )}

      {error && state !== S_DENIED && state !== S_UNSUPPORTED && (
        <div style={{
          marginTop: 8, padding: '8px 10px',
          background: '#fffbeb', border: '1px solid #fde68a',
          borderRadius: 6, fontSize: 12, color: '#92400e',
        }}>{error}</div>
      )}
    </div>
  )
}

// ── shells / primitives ─────────────────────────────────────────

function RecorderShell({ children }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: 10, overflow: 'hidden',
    }}>{children}</div>
  )
}

function InsecureContextBanner({ secureCtx, hasGetUserMedia }) {
  const lines = []
  if (!hasGetUserMedia) {
    lines.push('navigator.mediaDevices.getUserMedia is not available in this browser.')
  }
  if (!secureCtx) {
    lines.push(
      'The page is served over plain HTTP, so the browser will likely '
      + 'block camera/microphone access. Live recording works on '
      + 'http://localhost or any https:// origin. If recording fails, '
      + 'use the Upload tab — record on the tablet camera app and '
      + 'upload the clip.',
    )
  }
  return (
    <div style={{
      padding: 10, marginBottom: 10, borderRadius: 6,
      background: '#fffbeb', border: '1px solid #fde68a',
      fontSize: 12, color: '#92400e', lineHeight: 1.5,
    }}>
      <strong style={{ display: 'block', marginBottom: 4 }}>
        Heads up — secure context required
      </strong>
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  )
}

function Spinner() {
  return (
    <>
      <div style={{
        width: 28, height: 28, margin: '0 auto',
        border: '3px solid #bfdbfe', borderTopColor: '#2563EB',
        borderRadius: '50%', animation: 'roboai-rec-spin 1s linear infinite',
      }} />
      <style>{'@keyframes roboai-rec-spin { to { transform: rotate(360deg); } }'}</style>
    </>
  )
}

const primaryBtn = (disabled) => ({
  padding: '12px 18px', fontSize: 14, fontWeight: 700,
  background: disabled ? '#d1d5db' : '#7C3AED', color: '#fff',
  border: 'none', borderRadius: 8,
  cursor: disabled ? 'default' : 'pointer',
})

const recordBtn = {
  padding: '8px 14px', fontSize: 13, fontWeight: 700,
  background: '#DC2626', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer',
}

const stopBtn = {
  padding: '8px 14px', fontSize: 13, fontWeight: 700,
  background: '#fff', color: '#111',
  border: 'none', borderRadius: 6, cursor: 'pointer',
}

const ghostBtn = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'transparent', color: '#cbd5e1',
  border: '1px solid #334155', borderRadius: 6, cursor: 'pointer',
}

const ghostBtnLight = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: '#fff', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
}

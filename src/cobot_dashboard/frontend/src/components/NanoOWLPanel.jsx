import { useEffect, useState, useCallback } from 'react'
import { useStore } from '../store/useStore'

// NanoOWLPanel — the controls panel that sits next to / under the cam0
// MJPEG view in the Cameras & LiDAR layout. Owns:
//   - enable/disable toggle (gates publishing of prompts; when off the
//     node receives [] and the overlay stays hidden)
//   - text input for prompts (comma-separated OR chip-style add)
//   - detections list (highest-confidence first, with approx distance)
//   - status: stalled banner when cam0 freezes, model + fps + inference_ms
//   - honest labeling: every distance is tagged "approx (D435i)" so the
//     operator never confuses NanoOWL output with pick-grade pose

async function pushPrompts(prompts, enabled) {
  const res = await fetch('/api/openvocab/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompts, enabled }),
  })
  return res.ok
}

export default function NanoOWLPanel() {
  const ov = useStore((s) => s.openvocab) || {}
  // Local mirror of the operator-typed text. The store mirrors the
  // server-side prompts; on first mount we sync local from server, but
  // after that the local state owns the input edits and pushes them
  // out on submit (avoids edit-cursor jumps when the WS state echoes).
  const [draft, setDraft] = useState('')
  const [syncedOnce, setSyncedOnce] = useState(false)
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    if (syncedOnce) return
    if (!ov) return
    setDraft((ov.prompts || []).join(', '))
    setEnabled(!!ov.enabled)
    setSyncedOnce(true)
  }, [ov, syncedOnce])

  const submit = useCallback(async (overrides = {}) => {
    const parsedDraft = (overrides.draft ?? draft)
      .split(',').map((s) => s.trim()).filter(Boolean)
    const next = overrides.enabled !== undefined ? overrides.enabled : enabled
    await pushPrompts(parsedDraft, next)
  }, [draft, enabled])

  const onToggle = async () => {
    const next = !enabled
    setEnabled(next)
    submit({ enabled: next })
  }

  const dets = ov.detections || []
  const stalled = !!ov.stalled
  const error = ov.error
  const fps = Number(ov.fps || 0).toFixed(1)
  const ms  = Number(ov.inference_ms || 0).toFixed(0)
  const device = ov.device || '?'
  const frameAge = ov.frame_age_s

  return (
    <div style={{
      background: '#0f172a', color: '#e5e7eb',
      border: '1px solid #1f2937', borderRadius: 8,
      padding: 12, fontSize: 12, lineHeight: 1.45,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: '#cbd5e1',
        }}>Open-Vocabulary Detection (NanoOWL)</span>
        <span style={{ flex: 1 }} />
        <button onClick={onToggle} style={{
          background: enabled ? '#16A34A' : '#475569',
          color: '#fff', border: 'none', padding: '4px 10px',
          borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer',
        }}>
          {enabled ? '● ON' : '○ OFF'}
        </button>
      </div>

      {/* Stalled banner */}
      {stalled && (
        <div style={{
          padding: '6px 10px', borderRadius: 6,
          background: '#7f1d1d', border: '1px solid #ef4444',
          color: '#fecaca', fontSize: 11, fontWeight: 700,
        }}>
          ⚠ Camera stalled (no frame for {frameAge !== null ? `${frameAge.toFixed(1)}s` : '>2s'})
          {' '}— detections frozen. Restart roboai-cameras if persistent.
        </div>
      )}

      {/* Model error banner */}
      {error && (
        <div style={{
          padding: '6px 10px', borderRadius: 6,
          background: '#7f1d1d', border: '1px solid #ef4444',
          color: '#fecaca', fontSize: 11,
        }}>
          NanoOWL error: {String(error).slice(0, 200)}
        </div>
      )}

      {/* Prompt input — type comma-separated, push on Enter or button */}
      <div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>
          Prompts (comma-separated, e.g. <code>metal bracket, plastic clip, screwdriver</code>):
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="type parts to detect…"
            style={{
              flex: 1, padding: '6px 10px', fontSize: 13,
              background: '#020617', color: '#f3f4f6',
              border: '1px solid #334155', borderRadius: 4, outline: 'none',
              fontFamily: 'ui-monospace, monospace',
            }}
          />
          <button onClick={() => submit()} style={{
            background: '#2563EB', color: '#fff', border: 'none',
            padding: '6px 12px', borderRadius: 4,
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
          }}>
            Update
          </button>
        </div>
      </div>

      {/* Status line */}
      <div style={{
        display: 'flex', gap: 12, fontSize: 10, color: '#94a3b8',
        flexWrap: 'wrap',
      }}>
        <span>device: <strong style={{ color: device === 'cuda' ? '#22c55e' : '#fbbf24' }}>{device}</strong></span>
        <span>inference: {ms} ms</span>
        <span>{fps} FPS</span>
        <span>model: {ov.model || '—'}</span>
        {ov.image_w > 0 && <span>{ov.image_w}×{ov.image_h}</span>}
      </div>

      {/* Detections list */}
      <div style={{
        marginTop: 4, paddingTop: 8, borderTop: '1px solid #1e293b',
      }}>
        <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>
          Detections ({dets.length}) — sorted by confidence
        </div>
        {dets.length === 0 ? (
          <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic' }}>
            {enabled ? 'No matches.' : 'Turn ON to start detecting.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
            {dets.map((d, i) => {
              const conf = Math.round((d.confidence || 0) * 100)
              const z = d.approx_xyz_cam?.z
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 8px', borderRadius: 4,
                  background: '#020617', border: '1px solid #1e293b',
                  fontFamily: 'ui-monospace, monospace', fontSize: 11,
                }}>
                  <span style={{
                    width: 36, color: '#e11d48', fontWeight: 700, textAlign: 'right',
                  }}>{conf}%</span>
                  <span style={{ flex: 1, color: '#f3f4f6' }}>{d.prompt}</span>
                  <span style={{ color: '#94a3b8' }}>
                    {Number.isFinite(z)
                      ? `~${(z * 1000).toFixed(0)} mm`
                      : 'no depth'}
                  </span>
                  <span style={{ fontSize: 9, color: '#475569' }}>approx (D435i)</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

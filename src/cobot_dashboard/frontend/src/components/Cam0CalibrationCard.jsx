import { useEffect, useState, useCallback, useRef } from 'react'

// Cam0 extrinsic calibration — touch-point workflow with a printed
// AprilTag as the visual target.
//
// Flow:
//   1. Operator places the tag anywhere in cam0's view.
//   2. Jogs the TCP to touch the tag centre.
//   3. Clicks Capture. We record (TCP_base, cam_tag_center).
//   4. Move the tag, repeat 4-6 times spread across the workspace.
//   5. Solve → RMS reported. Save gated at RMS < 3 mm.
//
// Detection preview polls /api/calib/cam0/tag_preview at ~2 Hz so
// the operator sees "tag detected" before pressing Capture.
//
// This is the calibration bridge for the vision-pick MVP. The
// resolved cam0 → base_link transform gets broadcast as a static TF
// on Save; downstream consumers (pick_at_detection step, hover
// validation) read it via TF or via the persisted YAML directly.

function formatVec(v, prec = 3) {
  if (!Array.isArray(v)) return '—'
  return '[' + v.slice(0, 3).map((x) => Number(x).toFixed(prec)).join(', ') + ']'
}

export default function Cam0CalibrationCard() {
  const [status, setStatus]     = useState(null)
  const [preview, setPreview]   = useState(null)     // {detected, cam_t?, tag_id?}
  const [busy, setBusy]         = useState('')       // action name in flight
  const [error, setError]       = useState(null)
  const [msg, setMsg]           = useState(null)
  const streamKeyRef            = useRef(Date.now())

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/calib/cam0/status')
      if (!r.ok) return
      const d = await r.json()
      if (d.ok) setStatus(d)
    } catch { /* transient */ }
  }, [])

  const refreshPreview = useCallback(async () => {
    try {
      const r = await fetch('/api/calib/cam0/tag_preview')
      if (!r.ok) return
      const d = await r.json()
      if (d.ok) setPreview(d)
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshPreview()
    const iv1 = setInterval(refreshStatus, 2000)
    const iv2 = setInterval(refreshPreview, 500)
    return () => { clearInterval(iv1); clearInterval(iv2) }
  }, [refreshStatus, refreshPreview])

  async function run(action, method = 'POST', path = null, body = null) {
    setBusy(action)
    setError(null); setMsg(null)
    try {
      const opts = { method }
      if (body !== null) {
        opts.headers = { 'Content-Type': 'application/json' }
        opts.body = JSON.stringify(body)
      }
      const url = path || `/api/calib/cam0/${action}`
      const r = await fetch(url, opts)
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) {
        setError(d.error || `${action} failed (HTTP ${r.status})`)
      } else {
        if (action === 'capture') {
          setMsg(`captured point #${d.session_count}`)
        } else if (action === 'solve') {
          const rms = d.result?.rms_mm
          setMsg(
            `solved: rms ${rms?.toFixed(2)}mm · ` +
            (d.meets_accept
              ? 'meets accept threshold — Save enabled'
              : `above ${d.accept_rms_mm}mm accept — recollect or drop the worst point`)
          )
        } else if (action === 'save') {
          setMsg('saved cam0_extrinsic.yaml · TF broadcast')
        } else if (action === 'start') {
          setMsg('session cleared')
        }
        refreshStatus()
      }
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy('')
    }
  }

  const sess    = status?.session || {}
  const points  = Array.isArray(sess.points) ? sess.points : []
  const result  = sess.result
  const persisted = status?.persisted
  const minPoints = status?.min_points ?? 4
  const acceptRms = status?.accept_rms_mm ?? 3.0
  const canSolve  = points.length >= minPoints && !busy
  const canSave   = result && result.rms_mm < acceptRms && !busy
  const canCapture = status?.have_frame && status?.have_intr &&
                     status?.detector_ok && preview?.detected && !busy

  const captureBlock = (() => {
    if (!status) return 'loading…'
    if (!status.detector_ok) return `dt_apriltags unavailable (${status.detector_err})`
    if (!status.have_frame)  return 'no cam0 frame yet — is the camera up?'
    if (!status.have_intr)   return 'no cam0 camera_info yet — waiting for intrinsics'
    if (!preview?.detected)  return 'no tag detected in cam0'
    return `tag #${preview.tag_id} detected · cam_t ≈ ${formatVec(preview.cam_t)}`
  })()

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: 16,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
          cam0 extrinsic calibration
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Touch-point method · printed AprilTag · {minPoints}+ spread points ·
          accept RMS &lt; {acceptRms} mm
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Live view */}
        <div style={{ flex: '0 0 auto' }}>
          <img
            src={`/stream/cam0?ck=${streamKeyRef.current}`}
            alt="cam0"
            style={{
              width: 480, height: 'auto', borderRadius: 6,
              border: '1px solid #e5e7eb',
              background: '#000',
            }}
          />
          <div style={{
            marginTop: 6, fontSize: 12, color: '#6b7280',
            fontFamily: 'var(--font-mono, monospace)',
          }}>
            {captureBlock}
          </div>
        </div>

        {/* Right column: actions + capture list */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => run('capture', 'POST', null, {})}
              disabled={!canCapture}
              style={btnStyle(canCapture ? '#2563EB' : '#e5e7eb',
                              canCapture ? '#fff' : '#9ca3af')}
            >
              {busy === 'capture' ? 'Capturing…' : '+ Capture point'}
            </button>
            <button
              onClick={() => run('solve')}
              disabled={!canSolve}
              style={btnStyle(canSolve ? '#0f766e' : '#e5e7eb',
                              canSolve ? '#fff' : '#9ca3af')}
            >
              {busy === 'solve' ? 'Solving…' : 'Solve'}
            </button>
            <button
              onClick={() => run('save')}
              disabled={!canSave}
              style={btnStyle(canSave ? '#16A34A' : '#e5e7eb',
                              canSave ? '#fff' : '#9ca3af')}
            >
              {busy === 'save' ? 'Saving…' : 'Save + broadcast TF'}
            </button>
            <button
              onClick={() => run('start')}
              disabled={!!busy}
              style={btnStyle('#f3f4f6', '#374151')}
            >
              Reset
            </button>
          </div>

          {error && (
            <div style={{
              padding: 8, marginBottom: 8, fontSize: 12,
              background: '#fef2f2', color: '#991b1b',
              border: '1px solid #fecaca', borderRadius: 6,
            }}>{error}</div>
          )}
          {msg && !error && (
            <div style={{
              padding: 8, marginBottom: 8, fontSize: 12,
              background: '#f0fdf4', color: '#166534',
              border: '1px solid #bbf7d0', borderRadius: 6,
            }}>{msg}</div>
          )}

          {/* Captured pairs */}
          <div style={{
            border: '1px solid #e5e7eb', borderRadius: 6,
            maxHeight: 260, overflowY: 'auto',
          }}>
            {points.length === 0 ? (
              <div style={{
                padding: 12, fontSize: 12, color: '#9ca3af',
                textAlign: 'center',
              }}>
                No points yet. Place the tag, jog the cup to touch its centre,
                click <b>Capture point</b>. Repeat for {minPoints}+ spread
                positions.
              </div>
            ) : (
              <table style={{
                width: '100%', borderCollapse: 'collapse', fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
              }}>
                <thead>
                  <tr style={{ color: '#6b7280' }}>
                    <th style={cellStyle}>#</th>
                    <th style={cellStyle}>TCP (base, m)</th>
                    <th style={cellStyle}>tag (cam0, m)</th>
                    <th style={cellStyle}>resid</th>
                    <th style={cellStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p, i) => {
                    const r = result?.per_point_mm?.[i]
                    const flag = r != null && r >= acceptRms
                    return (
                      <tr key={p.idx} style={{ borderTop: '1px solid #f3f4f6' }}>
                        <td style={cellStyle}>{p.idx}</td>
                        <td style={cellStyle}>{formatVec(p.tcp_base)}</td>
                        <td style={cellStyle}>{formatVec(p.cam_pt)}</td>
                        <td style={{ ...cellStyle,
                                     color: flag ? '#991b1b' : '#374151',
                                     fontWeight: flag ? 700 : 400 }}>
                          {r != null ? `${r.toFixed(2)}mm` : '—'}
                        </td>
                        <td style={cellStyle}>
                          <button
                            onClick={() => run(`point/${p.idx}`, 'DELETE',
                              `/api/calib/cam0/point/${p.idx}`)}
                            disabled={!!busy}
                            style={{
                              padding: '2px 8px', fontSize: 11,
                              background: '#fef2f2', color: '#991b1b',
                              border: '1px solid #fecaca', borderRadius: 4,
                              cursor: 'pointer',
                            }}
                          >×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {result && (
            <div style={{
              marginTop: 8, padding: 8,
              background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6,
              fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
              color: '#374151',
            }}>
              <div>
                solve · n={result.n_points} ·
                <b style={{
                  color: result.rms_mm < acceptRms ? '#166534' : '#991b1b',
                  marginLeft: 6,
                }}>RMS {result.rms_mm.toFixed(2)} mm</b>
                <span style={{ color: '#9ca3af', marginLeft: 6 }}>
                  (accept &lt; {acceptRms} mm)
                </span>
              </div>
              <div style={{ marginTop: 4 }}>
                t = {formatVec(result.t)}
              </div>
              <div>
                R[0] = {formatVec(result.R?.[0])}
              </div>
              <div>
                R[1] = {formatVec(result.R?.[1])}
              </div>
              <div>
                R[2] = {formatVec(result.R?.[2])}
              </div>
            </div>
          )}

          {persisted && (
            <div style={{
              marginTop: 8, padding: 8,
              background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6,
              fontSize: 11, color: '#1e3a8a',
              fontFamily: 'var(--font-mono, monospace)',
            }}>
              persisted: cam0_extrinsic.yaml · saved {persisted.date} ·
              RMS {Number(persisted.rms_mm).toFixed(2)} mm ·
              n={persisted.n_points}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const cellStyle = { padding: '4px 8px', textAlign: 'left' }
function btnStyle(bg, fg) {
  return {
    padding: '8px 14px', fontSize: 13, fontWeight: 600,
    background: bg, color: fg,
    border: 'none', borderRadius: 5, cursor: 'pointer',
  }
}

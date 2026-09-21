// DeviceManagementPanel.jsx — list + revoke paired devices.
//
// Rendered inside the I/O page (adjacent to the hardware setup UX,
// per session directive "Settings/I-O-adjacent"). Reads
// /api/paired_devices, renders each row with name + created + last
// seen + Revoke. Revoke hits DELETE /api/paired_devices/{token_id};
// the backend closes any live WS holding that token immediately.
//
// Fork-registry `device_pairing_auth` — the ONE frontend surface that
// mutates paired-device state.

import { useCallback, useEffect, useState } from 'react'

// Light theme to match IOPage's white background (see
// pages/IOPage.jsx `background: '#fff'`). 2026-09-21 field bug:
// on tab-nav to I/O the panel's previous dark bg #141418 flashed
// against the white IOPortMap above it — the operator saw it as
// "a brief pair device prompt". Aligning colors kills the flash;
// the panel now sits quietly under IOPortMap as an in-page section.
const C = {
  panel:   '#FFFFFF',
  border:  '#E5E7EB',
  text:    '#111827',
  muted:   '#6B7280',
  bad:     '#DC2626',
}

function fmtAgo(iso) {
  if (!iso) return '—'
  try {
    const t = new Date(iso).getTime()
    if (!isFinite(t)) return iso
    const s = Math.max(0, Math.round((Date.now() - t) / 1000))
    if (s < 60)      return `${s}s ago`
    if (s < 3600)    return `${Math.round(s / 60)}m ago`
    if (s < 86400)   return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
  } catch (_) { return iso }
}

export default function DeviceManagementPanel() {
  const [devices, setDevices] = useState(null)  // null = loading, [] = none
  const [err, setErr]         = useState('')
  const [busy, setBusy]       = useState('')    // token_id being revoked
  const [pendingRevoke, setPendingRevoke] = useState(null) // token_id awaiting inline confirm

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/paired_devices')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setDevices(Array.isArray(j.devices) ? j.devices : [])
      setErr('')
    } catch (e) {
      setErr(e.message || String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 6000)
    return () => clearInterval(id)
  }, [refresh])

  async function doRevoke(tokenId) {
    if (busy) return
    setBusy(tokenId); setPendingRevoke(null)
    try {
      const res = await fetch(`/api/paired_devices/${encodeURIComponent(tokenId)}`,
        { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refresh()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <section style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12,
      padding: 20, color: C.text, marginTop: 16,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
      }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Paired devices</div>
        <div style={{ marginLeft: 'auto', color: C.muted, fontSize: 12 }}>
          {devices ? `${devices.length}` : ''}
        </div>
      </div>
      {err && <div style={{ color: C.bad, fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {devices === null && (
        <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>
      )}
      {devices !== null && devices.length === 0 && (
        <div style={{ color: C.muted, fontSize: 13 }}>
          No paired devices yet. New tablets pair from their setup wizard.
        </div>
      )}
      {devices && devices.length > 0 && (
        <div>
          {devices.map((d) => {
            const isPending = pendingRevoke === d.token_id
            const isBusy    = busy === d.token_id
            return (
              <div key={d.token_id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 12px', border: `1px solid ${isPending ? C.bad : C.border}`,
                borderRadius: 10, marginBottom: 8,
                background: isPending ? 'rgba(239,68,68,0.06)' : 'transparent',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap',
                                overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.device_name || d.token_id}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                    {isPending
                      ? 'This device will be signed out immediately.'
                      : `${d.token_id.slice(0, 8)} · last seen ${fmtAgo(d.last_seen)} · paired ${fmtAgo(d.created)}`}
                  </div>
                </div>
                {isPending ? (
                  <>
                    <button onClick={() => setPendingRevoke(null)}
                      style={{
                        padding: '8px 12px', borderRadius: 8,
                        border: `1px solid ${C.border}`, background: 'transparent',
                        color: C.text, cursor: 'pointer', fontSize: 13,
                      }}>Cancel</button>
                    <button onClick={() => doRevoke(d.token_id)}
                      disabled={isBusy}
                      style={{
                        padding: '8px 14px', borderRadius: 8,
                        border: 'none', background: C.bad,
                        color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                        opacity: isBusy ? 0.6 : 1,
                      }}>{isBusy ? 'Revoking…' : 'Revoke device'}</button>
                  </>
                ) : (
                  <button onClick={() => setPendingRevoke(d.token_id)}
                    disabled={isBusy}
                    style={{
                      padding: '8px 14px', borderRadius: 8,
                      border: `1px solid ${C.bad}`, background: 'transparent',
                      color: C.bad, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                      opacity: isBusy ? 0.6 : 1,
                    }}>{isBusy ? 'Revoking…' : 'Revoke'}</button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

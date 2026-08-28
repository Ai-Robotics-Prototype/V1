// StaleGuard — full-screen BLOCKING overlay for provenance
// mismatch (2026-08-28 stale-class close).
//
// 2026-08-28 lockout incident: a bug in deploy.sh briefly advanced
// dist/.build-sha on build-skip, making the server always report a
// frontend SHA the JS bundle could never contain — the guard fired
// on every fresh tab and the operator was locked out of the whole
// dashboard including the deploy control surface used to fix it.
// Escape hatch below prevents that class of self-inflicted lockout:
// after N mount cycles against the SAME (expected, actual) pair
// within a short window, an OVERRIDE button surfaces that clears
// staleProvenance and lets the operator through with a persistent
// amber "OVERRIDE ACTIVE" indicator (see StaleOverrideIndicator).
//
// The BLOCKING semantics are preserved for the normal single-reload
// case (dismissible-toast pattern retired). The override only appears
// when the reload strategy is DEMONSTRABLY not working, and it costs
// the operator a visible indicator until they clear it — never a
// silent bypass.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/useStore'


const HISTORY_KEY   = 'staleguard.reload_history'
const HISTORY_TTL_S = 300            // 5 minutes
const OVERRIDE_AFTER = 3             // 3 mounts against same pair


function _readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const cutoff = Date.now() / 1000 - HISTORY_TTL_S
    return arr.filter((e) => e && e.ts >= cutoff)
  } catch { return [] }
}


function _writeHistory(arr) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)) }
  catch { /* private-mode / quota — no-op */ }
}


function _sameSpair(a, b) {
  return a && b && a.expected === b.expected && a.actual === b.actual
}


export default function StaleGuard() {
  const sp = useStore((s) => s.staleProvenance)
  const setStaleProvenance = useStore((s) => s._setStaleProvenance)

  // Log every mount cycle against a mismatch so we can detect "reload
  // isn't fixing it". Ephemeral state — history lives in localStorage.
  useEffect(() => {
    if (!sp) return
    const arr = _readHistory()
    arr.push({ ts: Date.now() / 1000,
               expected: sp.expected, actual: sp.actual, layer: sp.layer })
    // Keep the tail bounded even inside the TTL window.
    const trimmed = arr.slice(-16)
    _writeHistory(trimmed)
  }, [sp])

  // Count identical-pair mounts within the TTL. When this reaches
  // OVERRIDE_AFTER we surface the escape hatch.
  const historyCount = useMemo(() => {
    if (!sp) return 0
    return _readHistory().filter((e) => _sameSpair(e, sp)).length
  }, [sp])
  const showOverride = sp && historyCount >= OVERRIDE_AFTER

  if (!sp) return null

  const isFrontend = sp.layer === 'frontend'
  const title = isFrontend
    ? 'This tab is running an old build.'
    : 'The controller has been updated since this tab connected.'
  const body = isFrontend
    ? 'The server has been redeployed with a newer frontend. Continuing '
      + 'to use this tab could hit the classic what-you-see-is-not-'
      + 'what-runs stale-class failures. Reload to load the current build.'
    : 'The dashboard backend restarted with a different git SHA. Reload '
      + 'to reconnect against the current backend, so any provenance '
      + 'assumptions this tab made are refreshed.'
  const detail = `expected ${(sp.expected || '?').slice(0, 12)} · `
               + `actual ${(sp.actual || '?').slice(0, 12)}`

  const reload = () => {
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('_r', Date.now().toString(36))
      window.location.replace(u.toString())
    } catch {
      window.location.reload()
    }
  }

  const override = () => {
    // Persist the fact that the operator overrode a specific pair so
    // StaleOverrideIndicator can surface it. Clear staleProvenance
    // in the store so the overlay unmounts.
    try {
      localStorage.setItem('staleguard.override', JSON.stringify({
        ts: Date.now() / 1000,
        expected: sp.expected, actual: sp.actual, layer: sp.layer,
      }))
    } catch { /* nop */ }
    if (typeof setStaleProvenance === 'function') {
      setStaleProvenance(null)
    } else {
      // Fallback for older store shapes — reload without cache-bust
      // to at least drop the mount cycle count.
      _writeHistory([])
    }
  }

  return (
    <div
      data-testid="stale-guard-overlay"
      data-layer={sp.layer}
      data-override-available={showOverride ? 'true' : 'false'}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stale-guard-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999999,
        background: 'rgba(15, 23, 42, 0.94)',
        color: '#F8FAFC',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'auto',
        userSelect: 'none',
      }}>
      <div
        style={{
          maxWidth: 560,
          padding: '32px 36px',
          background: '#0F172A',
          border: '2px solid #DC2626',
          borderRadius: 8,
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.6)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
        <div style={{
          fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase',
          color: '#FCA5A5', fontWeight: 700, marginBottom: 12,
        }}>Reload required — {sp.layer} SHA mismatch</div>
        <h2 id="stale-guard-title" style={{
          margin: 0, fontSize: 22, fontWeight: 700, color: '#FEE2E2',
        }}>{title}</h2>
        <p style={{
          marginTop: 12, marginBottom: 20, fontSize: 14, lineHeight: 1.5,
          color: '#E2E8F0',
        }}>{body}</p>
        <div style={{
          fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
          color: '#94A3B8', marginBottom: 18,
        }}>{detail}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            data-testid="stale-guard-reload"
            onClick={reload}
            style={{
              background: '#DC2626', color: '#FFF',
              border: 'none', borderRadius: 4,
              padding: '10px 20px', fontSize: 14, fontWeight: 700,
              cursor: 'pointer', letterSpacing: 0.4,
            }}>Reload now</button>
          {showOverride && (
            <button
              data-testid="stale-guard-override"
              onClick={override}
              style={{
                background: 'transparent',
                color: '#FCA5A5',
                border: '1px solid #7F1D1D',
                borderRadius: 4,
                padding: '10px 16px',
                fontSize: 12, fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: 0.3,
              }}>Continue anyway (report this)</button>
          )}
        </div>
        {showOverride && (
          <div style={{
            marginTop: 14, fontSize: 11, lineHeight: 1.4,
            color: '#FDBA74',
          }}>
            Reload has been attempted {historyCount}× against the same
            SHA pair. The guard may be misfiring. Override lets you
            through; a persistent OVERRIDE ACTIVE indicator will remain
            until you clear it, and this event should be reported.
          </div>
        )}
      </div>
    </div>
  )
}

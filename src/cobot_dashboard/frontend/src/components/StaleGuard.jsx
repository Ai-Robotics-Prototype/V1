// StaleGuard — full-screen BLOCKING overlay for provenance
// mismatch (2026-08-28 stale-class close). Kills the stale-tab
// class as an operator burden: the UI refuses to operate when
// its embedded git SHA differs from the server's frontend SHA.
//
// The dismissible-toast approach used pre-2026-08-28 taught the
// operator to click through the warning and keep working on a
// stale tab. This overlay does NOT have a close button — the
// only path forward is a hard reload (the button reloads the
// page with cache bypass).
//
// Trigger source: useStore.staleProvenance is set to
//   { layer: 'frontend'|'backend', expected, actual, detectedAt }
// when the /ws/state hello frame's SHAs disagree with our own
// __GIT_SHA__ (frontend layer) or the previous hello's backend
// SHA (backend layer). See store/useStore.js onmessage.

import { useStore } from '../store/useStore'


export default function StaleGuard() {
  const sp = useStore((s) => s.staleProvenance)
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
    // Cache-bypass reload: query-string cache-buster on top of
    // location.reload's own cache-bypass semantics.
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('_r', Date.now().toString(36))
      window.location.replace(u.toString())
    } catch {
      window.location.reload()
    }
  }

  return (
    <div
      data-testid="stale-guard-overlay"
      data-layer={sp.layer}
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
        <button
          data-testid="stale-guard-reload"
          onClick={reload}
          style={{
            background: '#DC2626', color: '#FFF',
            border: 'none', borderRadius: 4,
            padding: '10px 20px', fontSize: 14, fontWeight: 700,
            cursor: 'pointer', letterSpacing: 0.4,
          }}>Reload now</button>
      </div>
    </div>
  )
}

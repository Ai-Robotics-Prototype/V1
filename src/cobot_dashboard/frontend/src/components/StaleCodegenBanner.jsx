import { useEffect, useState } from 'react'

// Global staleness indicator — 2026-07-30 §3.
//
// Motivated by the FOURTH staleness episode in one day: a committed
// fix ran stale because the manual restart step was skippable. The
// dashboard already computed codegen_stale (boot-sha vs disk-sha) but
// surfaced it only in the run manifest, which nobody reads.
//
// This banner polls /api/codegen/status every 4 s and, when stale,
// renders a persistent AMBER strip fixed to the top of the viewport.
// It NEVER blocks any UI element — the operator can still click Run,
// jog, teach, etc. It's a can't-miss inform.
//
// The polling interval is intentionally short: the banner needs to
// disappear within one full cycle after `scripts/deploy.sh` restarts
// the services and the boot-sha catches up to the disk-sha. Four
// seconds keeps the perceptual gap under "did the deploy work?"
// impatience without flooding the endpoint.

const POLL_MS = 4000

export default function StaleCodegenBanner() {
  const [codegen, setCodegen] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const r = await fetch('/api/codegen/status')
        if (!r.ok) return
        const body = await r.json()
        if (!cancelled) setCodegen(body)
      } catch {
        // Silent — the banner is a nice-to-have; network flap
        // shouldn't crash the UI. Existing sha stays displayed.
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!codegen || !codegen.stale) return null

  return (
    <div
      role="alert"
      data-testid="stale-codegen-banner"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9997,   // below modals (9998) + toasts, above content
        background: '#FEF3C7',
        borderBottom: '1px solid #F59E0B',
        color: '#92400E',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13,
        lineHeight: 1.4,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none',  // never blocks clicks on the topbar
      }}>
      <span style={{ fontSize: 18, lineHeight: 1 }}>⚠</span>
      <span style={{ pointerEvents: 'auto' }}>
        <b>Code updated on disk — restart required to apply</b>
        {' '}(<code>roboai-dashboard</code>,{' '}
        <code>roboai-estun</code>).
        {' '}Boot codegen <code>{codegen.boot_sha}</code>;
        {' '}disk <code>{codegen.disk_sha}</code>.
        {' '}Runs pressed in this state will use the OLD codegen and
        will stamp <code>codegen_stale=true</code> on the manifest.
        {' '}Run <code>scripts/deploy.sh</code> to apply.
      </span>
    </div>
  )
}

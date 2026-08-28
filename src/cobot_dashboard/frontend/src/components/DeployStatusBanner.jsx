// DeployStatusBanner — footer indicator for the auto-deploy state
// (2026-07-31 directive: "a failed deploy is a red banner on
// every client, not a silent nothing").
//
// 2026-08-28 stale-class close: verdict is now composed on the
// server (/api/deploy_status.provenance.verdict) across three
// layers — deploy_log phase, backend SHA, frontend SHA. Green
// ONLY when all three agree with the deploy_log's sha; any
// mismatch renders red with the NAMED failing layer (never green
// while any layer is drifting).
//
// Reads /api/deploy_status every 3s. Operator-facing states:
//   * green   "current — <hash8> · <age>"   — all three layers ok
//   * blue    "deploying — <phase>"          — start/building in-flight
//   * amber   "deploy waiting for idle"     — path fired but arm busy
//   * amber   "frontend stale — <before>→<after>" — silent rebuild skip
//   * red     "DEPLOY FAILED: <step>"        — deploy_log fail
//   * red     "STALE: <layer(s)>"            — layers drift (backend/frontend)
//
// Non-blocking. Position: bottom-right, pinned. Height stays under
// 32px so the tablet footer chrome isn't disrupted.

import { useEffect, useState } from 'react'


const POLL_MS = 3000

// Small age formatter — deploy age is the wall-clock time since
// the last successful deploy landed. "<1m ago" / "3m ago" / "2h ago".
function fmtAgeFromIso(iso) {
  if (!iso) return '?'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '?'
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60)   return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}


export default function DeployStatusBanner() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    let cancelled = false
    let timer = null
    const tick = async () => {
      try {
        const r = await fetch('/api/deploy_status', { cache: 'no-store' })
        if (!r.ok) return
        const body = await r.json()
        if (!cancelled) setStatus(body)
      } catch { /* silent — retry next tick */ }
    }
    tick()
    timer = setInterval(tick, POLL_MS)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [])

  if (!status) return null
  const state = status.state
  const last  = status.last_ok
  const latest = status.latest || {}
  const prov = status.provenance || {}
  const verdict = prov.verdict || state
  const failing = prov.failing_layers || []

  let bg, fg, border, label, title
  // 2026-08-28: layers-drift RED comes BEFORE the state-derived
  // branches so a backend/frontend SHA mismatch that landed WITHOUT
  // a deploy_log fail (surviving old worker after ostensibly-ok
  // deploy) doesn't get papered over with a green pill.
  if (verdict === 'red' && failing.length > 0 && state === 'current') {
    bg = '#7F1D1D'; fg = '#FEE2E2'; border = '#DC2626'
    const layers = failing.join('+')
    const expected = (prov.deploy_sha || '?').slice(0, 8)
    const backend  = (prov.backend_sha  || '?').slice(0, 8)
    const frontend = (prov.frontend_sha || '?').slice(0, 8)
    label = `✗ STALE: ${layers} (expected ${expected})`
    title = `Provenance mismatch — deploy_log says ${expected}, `
          + `backend=${backend}, frontend=${frontend}. `
          + `Failing layers: ${failing.join(', ')}. `
          + `Restart may not have taken (surviving old worker) or the frontend rebuild skipped.`
  } else if (state === 'current') {
    const hash = String(prov.deploy_sha
                     || last?.served_asset_after
                     || last?.sha
                     || '?').slice(0, 8)
    const age  = fmtAgeFromIso(last?.ts)
    bg = '#064E3B'; fg = '#D1FAE5'; border = '#065F46'
    label = `✓ current — ${hash} · ${age}`
    title = `All three layers agree at ${prov.deploy_sha || '?'} — `
          + `deploy=ok, backend=${(prov.backend_sha || '?').slice(0, 8)}, `
          + `frontend=${(prov.frontend_sha || '?').slice(0, 8)}. `
          + `Last successful deploy: ${last?.ts || ''}`
  } else if (state === 'deploying') {
    bg = '#1E3A8A'; fg = '#DBEAFE'; border = '#3B82F6'
    const phase = latest.phase === 'building' ? 'building…' : 'starting…'
    label = `⟳ deploying — ${phase}`
    title = `Auto-deploy in progress (sha ${(latest.sha || '?').slice(0, 8)})`
  } else if (state === 'waiting') {
    bg = '#78350F'; fg = '#FEF3C7'; border = '#F59E0B'
    label = '⏱ deploy waiting for idle'
    title = 'Arm is jogging or running a program; deploy will fire once idle.'
  } else if (state === 'stale') {
    // 2026-08-06 (silent-frontend-rebuild-skip class): the last
    // commit touched frontend/src but the served asset hash did
    // NOT advance. Build itself succeeded; the tab is running an
    // old bundle. Amber warning — actionable, not "everything is
    // broken".
    bg = '#78350F'; fg = '#FEF3C7'; border = '#F59E0B'
    const beforeHash = latest.served_asset_before || '?'
    const afterHash  = latest.served_asset_after || '?'
    label = `⚠ frontend stale — ${beforeHash} → ${afterHash} unchanged`
    title = latest.detail
      ? `${latest.detail} (this tab is running the OLD bundle; force-reload to check)`
      : 'Frontend source changed since the last deploy but the served ' +
        'asset hash did not advance. This tab is running the OLD bundle.'
  } else if (state === 'failed') {
    bg = '#7F1D1D'; fg = '#FEE2E2'; border = '#DC2626'
    const step = latest.step || 'unknown step'
    label = `✗ DEPLOY FAILED: ${step}`
    title = latest.detail
      ? `${step} — ${latest.detail}`
      : step
  } else {
    // unknown — never happened yet (fresh install) or the log path
    // isn't readable. Render nothing rather than a scary "unknown"
    // when the operator hasn't set up the auto-deployer.
    return null
  }

  return (
    <div
      data-testid="deploy-status-banner"
      data-state={state}
      title={title}
      style={{
        position: 'fixed',
        right: 8, bottom: 6,
        zIndex: 3200,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 10px',
        background: bg, color: fg,
        border: `1px solid ${border}`, borderRadius: 4,
        fontSize: 11, fontWeight: 700,
        fontFamily: 'var(--font-mono, monospace)',
        letterSpacing: 0.3,
        maxWidth: 'calc(100vw - 16px)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        pointerEvents: 'none',
        userSelect: 'none',
      }}>
      {label}
    </div>
  )
}

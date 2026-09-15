// StaleOverrideIndicator — persistent amber pill shown after the
// operator has used StaleGuard's escape hatch (2026-08-28 lockout
// close). The overlay's "Continue anyway" path drops a marker in
// localStorage; this indicator surfaces the fact that the running
// tab is operating without the provenance guarantee that
// StaleGuard normally enforces.
//
// Cleared explicitly by clicking the pill (which removes the
// localStorage marker) or naturally on the next successful reload
// against matching SHAs.

import { useEffect, useState } from 'react'


const OVERRIDE_KEY = 'staleguard.override'
const POLL_MS      = 5000


function _read() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}


export default function StaleOverrideIndicator() {
  const [override, setOverride] = useState(_read())

  useEffect(() => {
    const tick = () => setOverride(_read())
    const t = setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [])

  if (!override) return null

  const clear = () => {
    try { localStorage.removeItem(OVERRIDE_KEY) } catch { /* nop */ }
    setOverride(null)
  }

  const detail = `${override.layer || '?'}: expected `
               + `${(override.expected || '?').slice(0, 8)} · actual `
               + `${(override.actual   || '?').slice(0, 8)}`

  return (
    <div
      data-testid="stale-override-indicator"
      title={`Provenance guard bypassed at ${
        override.ts
          ? new Date(override.ts * 1000).toISOString()
          : 'unknown time'}. ${detail}. Click to clear.`}
      onClick={clear}
      style={{
        position: 'fixed',
        left: 8, bottom: 6,
        zIndex: 3200,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 10px',
        background: '#78350F', color: '#FEF3C7',
        border: '1px solid #F59E0B',
        borderRadius: 4,
        fontSize: 11, fontWeight: 700,
        fontFamily: 'var(--font-mono, monospace)',
        letterSpacing: 0.3,
        cursor: 'pointer',
        maxWidth: 'calc(50vw - 8px)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
      ⚠ OVERRIDE ACTIVE — {detail}
    </div>
  )
}

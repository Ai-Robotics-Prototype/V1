import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { isFeatureEnabled } from '../lib/edition'

// SERVED bundle identifier — read at runtime from the actual script
// URL the browser loaded. This is Vite's content-hashed filename
// (assets/index-<HASH>.js), so it matches whatever the server's
// mock_server/static/ directory currently ships and CANNOT diverge
// like a compile-time __BUILD_ID__ (which lies when a newer bundle
// is served but the tab wasn't reloaded).
//
// Kept exported for consumers that used to render the served-hash
// pill on Configure's Provenance card. That card is now retired,
// but a small handful of source-string tests still reference the
// export name; keep the function reachable.
export function getServedBundleHash() {
  if (typeof document === 'undefined') return null
  for (const el of document.querySelectorAll('script[src]')) {
    const m = el.src && el.src.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)
    if (m) return m[1]
  }
  return null
}

// 2026-09-08 operator directive (footer removal, revised): the
// StatusBar shrinks to a single "Disk <free>" element with WARN/
// CRITICAL/DEAD coloring. Everything else — connection dot,
// ROS2 tag, Robot Generic TCP, IP, State pill, Zone chip,
// Cell/environment-guard note, WS rate, Edition affordance — is
// retired. Edition chip/unlock relocated to the NeuRobots wordmark
// in TopBar (Brand.jsx).
//
// 2026-09-08 (later same day) BANNER REMOVAL directive:
//   * SystemBanners entirely retired — no more red top strip
//     covering the tab bar.
//   * Guard-state visibility is FULL edition only: compact footer
//     text next to the disk readout — red dot + "Guards OFF"
//     when guard.enabled === false, nothing when on. BASIC shows
//     nothing about the guard anywhere. Enforcement is
//     edition-INDEPENDENT (safety invariant) — this gates ONLY
//     operator-visible state.
//
// Engineer info still lives at /health.
export default function StatusBar() {
  const [disk, setDisk] = useState(null)
  // Guard-state read for the full-only footer text. `collision ===
  // false` is the strict "guard is OFF" state; null/undefined
  // means "not yet reported" and renders nothing (same as ON — we
  // do not want to falsely alert on stale/unknown state).
  const edition   = useStore((s) => s.edition)
  const collision = useStore((s) => s.robot?.collision_enabled)
  const guardVisible   = isFeatureEnabled('guard_visibility', edition)
  const guardOffShown  = guardVisible && collision === false
  useEffect(() => {
    let cancelled = false
    async function pollDisk() {
      try {
        const r = await fetch('/api/disk_status')
        if (!r.ok) return
        const d = await r.json()
        if (!cancelled) setDisk(d)
      } catch { /* keep last known value */ }
    }
    pollDisk()
    const t = setInterval(pollDisk, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const level = disk?.level || 'ok'
  const color =
      (level === 'dead' || level === 'critical') ? '#DC2626'
    : level === 'warn'                            ? '#B45309'
    :                                               'var(--text-secondary)'

  return (
    <div style={{
      height: '100%',
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      overflow: 'hidden',
    }}>
      <div
        data-testid="disk-status-block"
        title={disk
          ? `Disk /opt/cobot: ${disk.free_human} free.\n`
            + (disk.dirs || []).map((d) =>
                `${d.path}: ${d.size_human} / ${d.cap_human}`)
                .join('\n')
          : 'Disk status polling…'}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10, fontVariantNumeric: 'tabular-nums',
          color,
          whiteSpace: 'nowrap',
          height: '100%',
        }}>
        Disk&nbsp;
        <span style={{ fontWeight: 600 }}>
          {disk ? disk.free_human : '—'}
        </span>
        {disk && level !== 'ok' && (
          <span style={{ marginLeft: 6, fontSize: 10,
                         textTransform: 'uppercase',
                         letterSpacing: '0.05em' }}>
            {level}
          </span>
        )}
      </div>
      {guardOffShown && (
        <div
          data-testid="footer-guards-off"
          title="Self-collision + ground guards are OFF — link-on-link and ground crashes are not prevented in software. Turn ON in Configure."
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginLeft: 14, paddingLeft: 14,
            borderLeft: '1px solid var(--border)',
            fontSize: 10, fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: '#DC2626',
            whiteSpace: 'nowrap', height: '100%',
          }}>
          <span aria-hidden="true"
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: '#DC2626',
                  boxShadow: '0 0 4px #DC2626',
                  display: 'inline-block', flexShrink: 0,
                }} />
          Guards OFF
        </div>
      )}
    </div>
  )
}

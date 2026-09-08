import { useEffect, useState } from 'react'

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
// retired. The two load-bearing pieces are relocated:
//   * Edition chip/unlock → click the NeuRobots wordmark in
//     TopBar (Brand.jsx).
//   * Collision-guard-off + WS-disconnected → global banners
//     rendered by SystemBanners.jsx, only when bad.
// Engineer info still lives at /health.
export default function StatusBar() {
  const [disk, setDisk] = useState(null)
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
    </div>
  )
}

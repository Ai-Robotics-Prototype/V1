import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { deriveRunState } from '../lib/runState'

// SERVED bundle identifier — read at runtime from the actual script
// URL the browser loaded. This is Vite's content-hashed filename
// (assets/index-<HASH>.js), so it matches whatever the server's
// mock_server/static/ directory currently ships and CANNOT diverge
// like a compile-time __BUILD_ID__ (which lies when a newer bundle
// is served but the tab wasn't reloaded).
function getServedBundleHash() {
  if (typeof document === 'undefined') return null
  for (const el of document.querySelectorAll('script[src]')) {
    const m = el.src && el.src.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)
    if (m) return m[1]
  }
  return null
}

function Block({ children, style }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 12px',
      borderRight: '1px solid var(--border)',
      fontSize: 10,
      color: 'var(--text-secondary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      height: '100%',
      ...style,
    }}>
      {children}
    </div>
  )
}

const ZONE_COLORS = {
  GREEN:  '#22C55E',
  YELLOW: '#EAB308',
  RED:    '#EF4444',
}

export default function StatusBar() {
  const wsStatus  = useStore((s) => s.wsStatus)
  const wsLatency = useStore((s) => s.wsLatency)
  const task      = useStore((s) => s.task)
  const safety    = useStore((s) => s.safety)
  const robot     = useStore((s) => s.robot) || {}
  // Same unified derivation the Monitor pill uses so the footer
  // "State" chip can't disagree with what the operator sees above.
  const runState  = deriveRunState({ robot, task, safety })

  // Cell-scoped environment-guard visibility (2026-07-28).
  //   active_cell_id set  → 'Cell: <name>' in neutral text
  //   active_cell_id null → 'No cell — environment guard off' in amber
  //                         (#B45309, matches the FooterBuild stale-
  //                         bundle warning — deliberately NOT alarm red).
  // Polls /api/cells/active every 15s so a wizard-side activation flip
  // (or an operator running `POST /api/cells/{id}/activate` from another
  // tab) shows up here without a page reload. Silence is not an option:
  // if this cell around the arm is unmodeled, the operator MUST see it.
  const [cell, setCell] = useState(null)
  const [cellLoaded, setCellLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch('/api/cells/active')
        if (!r.ok) return
        const d = await r.json()
        if (cancelled) return
        setCell(d && d.cell ? d.cell : null)
        setCellLoaded(true)
      } catch { /* keep last known value */ }
    }
    poll()
    const t = setInterval(poll, 15000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // 2026-08-05 disk watchdog — footer widget shows free space
  // on /opt/cobot. Amber below 2 GB (WARN), red below 500 MB
  // (CRITICAL). Polls every 30 s. Same source of truth the
  // /api/disk_status endpoint exposes (fork registry:
  // disk_watchdog).
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

  const zoneColor = ZONE_COLORS[safety.zone] ?? '#9A9A9E'
  const dotColor  = wsStatus === 'connected' ? '#22C55E'
                  : wsStatus === 'connecting' ? '#EAB308'
                  : '#EF4444'

  return (
    <div style={{
      height: '100%',
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden',
    }}>
      {/* Connection dot */}
      <Block>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
        {wsStatus === 'connected' ? 'Connected' : wsStatus === 'connecting' ? 'Connecting…' : 'Offline'}
      </Block>

      <Block>ROS2 Humble</Block>
      <Block>Robot Generic TCP</Block>
      <Block>IP&nbsp;192.168.1.246</Block>

      {/* 2026-08-05 disk watchdog widget — ok/warn/critical/dead
          from /api/disk_status. Amber below 2 GB free, red below
          500 MB. Same colors runState uses. */}
      {disk && (
        <Block
          data-testid="disk-status-block"
          style={{
            color: (disk.level === 'dead' || disk.level === 'critical')
                       ? '#DC2626'
                   : disk.level === 'warn'
                       ? '#B45309'
                       : 'var(--text-secondary)',
          }}
          title={`Disk /opt/cobot: ${disk.free_human} free.\n`
               + disk.dirs.map((d) =>
                   `${d.path}: ${d.size_human} / ${d.cap_human}`)
                   .join('\n')}>
          Disk&nbsp;
          <span style={{ fontWeight: 600 }}>{disk.free_human}</span>
          {disk.level !== 'ok' && (
            <span style={{ marginLeft: 6, fontSize: 10,
                           textTransform: 'uppercase',
                           letterSpacing: '0.05em' }}>
              {disk.level}
            </span>
          )}
        </Block>
      )}

      {/* Unified run-state (same source as the Monitor pill). Was
          previously reading task.state directly — that only reflected
          the executor's own machine, so an Estun-pipeline run stayed
          IDLE here even though the arm was moving. */}
      <Block>
        State&nbsp;
        <span style={{ color: runState.color, fontWeight: 600 }}>
          {runState.label}
        </span>
        {runState.detail && (
          <span style={{ marginLeft: 6, color: 'var(--text-secondary)',
                         fontSize: 10 }}>
            {runState.detail}
          </span>
        )}
      </Block>

      {/* Zone + proximity */}
      <Block style={{ color: zoneColor }}>
        Zone&nbsp;
        <span style={{ color: zoneColor, fontWeight: 600 }}>{safety.zone}</span>
        &nbsp;·&nbsp;
        {safety.human_proximity.toFixed(1)} m
      </Block>

      {/* Cell scope — silence is not an option. When no cell is active
          the environment-obstacle guard is off (robot-intrinsic guards
          still enforce: self-collision, ground plane, joint limits).
          Amber text, not alarm styling. */}
      <Block
        title={
          cell
            ? `Environment keep-out zones from cell ${cell.name || cell.cell_id} are enforced. `
              + 'Robot-intrinsic guards (self-collision, ground, joint limits) always on.'
            : 'No commissioned cell selected — environment keep-out zones are NOT enforced. '
              + 'Robot-intrinsic guards (self-collision, ground, joint limits) still on. '
              + 'Configure → Cells to activate a commissioned cell.'
        }
        style={{ color: cell ? 'var(--text-secondary)' : '#B45309', fontWeight: cell ? 400 : 600 }}
      >
        {cellLoaded
          ? (cell ? <>Cell&nbsp;<span style={{ fontWeight: 600 }}>{cell.name || cell.cell_id}</span></>
                  : <>No cell&nbsp;—&nbsp;environment guard off</>)
          : 'Cell…'}
      </Block>

      {/* WS freq + latency */}
      <Block>
        WS&nbsp;25Hz&nbsp;·&nbsp;
        <span style={{ fontFamily: 'var(--font-mono)' }}>{wsLatency} ms</span>
      </Block>

      <div style={{ flex: 1 }} />

      {/* Right side: SERVED bundle identity.
          `served <hash>` is Vite's content-hash of index-<HASH>.js — read
          from the actual <script> element the browser loaded. This is
          the SAME sha256 that System Check Software row displays
          (dashboard_server _check_software → bundle_hash_for), so the
          two ALWAYS agree on which bundle the tab is running.
          BUILD_TIME is retained as a secondary freshness signal (a
          rebuild with the same source tree emits the same hash but a
          new BUILD_TIME).
          If a newer bundle lands on the server, the footer stays
          pinned to what THIS tab actually loaded — telling the operator
          they need to reload. That was the whole point of the fix. */}
      <FooterBuild />
    </div>
  )
}

function FooterBuild() {
  const [servedHash] = useState(() => getServedBundleHash())
  const [systemHash, setSystemHash] = useState(null)
  useEffect(() => {
    // Fetch System Check ONCE for the "does what this tab loaded
    // match what the server currently serves?" comparison. Refreshing
    // won't help if the tab is stale — the operator has to reload.
    let cancelled = false
    fetch('/api/systemcheck')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (cancelled || !d) return
        const sw = (d.checks || []).find((c) => c.key === 'software')
        // Use the Vite content-hash from the JS asset filename (same
        // hash space as our footer's DOM lookup). Falls back to the
        // sha256 of index.html for older backends that don't emit
        // served_asset_hash yet.
        if (sw) setSystemHash(sw.served_asset_hash || sw.served_hash)
      }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const shortHash = servedHash ? servedHash.slice(0, 8) : null
  const stale = systemHash && servedHash && systemHash !== servedHash
  return (
    <Block style={{
      borderRight: 'none',
      borderLeft: '1px solid var(--border)',
      color: stale ? '#B45309' : 'var(--text-muted)',
    }}>
      {shortHash
        ? <>served <span style={{ fontFamily: 'var(--font-mono)' }}>{shortHash}</span></>
        : 'dev'}
      {typeof __BUILD_TIME__ !== 'undefined' && (
        <span style={{ marginLeft: 6, opacity: 0.55 }}>{__BUILD_TIME__}</span>
      )}
      {stale && (
        <span style={{ marginLeft: 6, fontWeight: 700 }}
              title={`server now serves ${systemHash.slice(0,8)} — reload to pick it up`}>
          ⟳ RELOAD
        </span>
      )}
    </Block>
  )
}

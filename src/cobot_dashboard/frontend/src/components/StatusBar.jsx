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

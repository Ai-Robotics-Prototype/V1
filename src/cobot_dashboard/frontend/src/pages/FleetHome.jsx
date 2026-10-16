import { useEffect, useState } from 'react'
import {
  fetchFleetPeers,
  normalizeCard,
  statusPalette,
} from '../lib/fleet'

// FleetHome — Standard-Bots-style landing grid.
//
// 2026-09-21 operator directive: when the mDNS registry holds >1
// robot, the app's landing surface is a fleet grid. One card per
// robot: friendly name, model + serial, live status pill
// (Ready/Running/Alarm/Idle/Offline), current program name when
// running, alarm badge. Tap a card → cross-origin redirect to that
// robot's own dashboard.
//
// Rules pinned by tests/doctrine/D_fleet_home.test.js:
//   1. grid-renders-per-registry — App.jsx routes here when the
//      registry (self + Avahi peers) exceeds 1.
//   2. offline-card-honest — a peer probe timeout renders the card
//      as "Offline"; no fabricated status.
//   3. no-control-on-cards — v1 has ONE tap action per card (open).
//      NO start/stop, NO enable/disable, NO emergency-stop from the
//      grid. Fleet-level control is deliberately deferred to v2.
//   4. single-robot-skips-grid — App.jsx never mounts this page
//      when the registry has ≤ 1 robot.
//
// Safety stops stay PER-ROBOT inside the connected dashboard,
// labeled with the robot's friendly_name via the TopBar surface.
// This file MUST NOT reference any safety-stop verb or component.

const REFRESH_MS = 5000

export default function FleetHome() {
  const [data, setData] = useState({ self: null, peers: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      setError(null)
      try {
        const next = await fetchFleetPeers()
        if (cancelled) return
        setData(next)
      } catch (e) {
        if (cancelled) return
        setError(String(e?.message || e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    refresh()
    const iv = setInterval(refresh, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [])

  // Combine self + peers into a single ordered list. Self first so
  // the operator's current robot is anchored top-left; peers sorted
  // by friendly_name so the layout is stable across polls.
  const cards = []
  if (data.self) cards.push({ ...normalizeCard(data.self), isSelf: true })
  const peerCards = (data.peers || []).map(normalizeCard)
  peerCards.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName))
  cards.push(...peerCards)

  return (
    <div data-testid="fleet-home" style={styles.root}>
      <header style={styles.header}>
        <div style={styles.title}>Fleet</div>
        <div style={styles.subtitle}>
          {data.total} robot{data.total === 1 ? '' : 's'} discovered on this network.
          Tap a card to open that robot&apos;s dashboard.
        </div>
      </header>

      {loading && cards.length === 0 && (
        <div data-testid="fleet-home-loading" style={styles.notice}>
          Discovering robots…
        </div>
      )}
      {error && cards.length === 0 && (
        <div data-testid="fleet-home-error" style={styles.notice}>
          Couldn&apos;t reach the fleet endpoint. The dashboard&apos;s
          discovery layer is degraded — retrying automatically.
        </div>
      )}

      <div data-testid="fleet-home-grid" style={styles.grid}>
        {cards.map((card, idx) => (
          <FleetCard
            key={card.serial || card.host || `card-${idx}`}
            card={card}
          />
        ))}
      </div>
    </div>
  )
}

function FleetCard({ card }) {
  const palette = statusPalette(card.status)
  const label   = card.friendlyName
                  || (card.isOffline ? (card.host || 'Unknown robot')
                                     : 'Unnamed robot')

  // Cross-origin redirect. Never in-app switch — every robot owns
  // its own dashboard state; a fleet-side proxy would need its own
  // auth + WS multiplexing and belongs to fleet-level-control v2.
  const onOpen = () => {
    if (card.isSelf) {
      // Own robot — stay on this origin, drop the ?view=fleet param.
      try {
        const url = new URL(window.location.href)
        url.searchParams.set('view', 'dashboard')
        window.location.href = url.toString()
      } catch (_) {
        window.location.href = '/?view=dashboard'
      }
      return
    }
    if (!card.url) return
    window.location.href = card.url
  }

  const disabled = !card.isSelf && !card.url

  return (
    <button
      type="button"
      data-testid="fleet-card"
      data-serial={card.serial || ''}
      data-status={card.status}
      data-is-self={String(!!card.isSelf)}
      data-is-offline={String(!!card.isOffline)}
      onClick={onOpen}
      disabled={disabled}
      style={{
        ...styles.card,
        opacity: disabled ? 0.6 : 1,
        cursor:  disabled ? 'not-allowed' : 'pointer',
      }}
      aria-label={`Open ${label} dashboard`}
    >
      <div style={styles.cardHeader}>
        <div style={styles.cardName}>{label}</div>
        {card.isSelf && (
          <span data-testid="fleet-card-self-tag" style={styles.selfTag}>
            this dashboard
          </span>
        )}
      </div>

      <div style={styles.cardMeta}>
        {card.model || (card.isOffline ? '—' : 'unknown model')}
        {card.serial ? ` · ${card.serial}` : ''}
      </div>

      <div style={styles.cardStatusRow}>
        <span
          data-testid="fleet-card-status-pill"
          style={{
            ...styles.statusPill,
            background:   palette.bg,
            color:        palette.fg,
            borderColor:  palette.border,
          }}
        >
          {card.status}
        </span>
        {card.alarm && card.alarm.code && (
          <span
            data-testid="fleet-card-alarm-badge"
            style={styles.alarmBadge}
          >
            Alarm {card.alarm.code}
          </span>
        )}
      </div>

      {card.currentProgram && (
        <div data-testid="fleet-card-program" style={styles.cardProgram}>
          Running:{' '}
          {card.currentProgram.task
            || card.currentProgram.id
            || 'program'}
          {card.currentProgram.line
            ? ` (line ${card.currentProgram.line})`
            : ''}
        </div>
      )}

      {card.isOffline && !card.isSelf && (
        <div data-testid="fleet-card-offline-note" style={styles.offlineNote}>
          This robot didn&apos;t respond from your device
          {card.host ? ` (${card.host})` : ''}. It may be off, on a
          different network, or the dashboard is down.
        </div>
      )}
    </button>
  )
}

const styles = {
  root: {
    padding: '32px 32px 48px',
    minHeight: '100%',
    background: 'var(--bg-app, #0C0C0E)',
    color: '#E5E7EB',
    fontFamily: 'var(--font, system-ui)',
    overflow: 'auto',
    boxSizing: 'border-box',
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 800,
    letterSpacing: 0.4,
    color: '#F3F4F6',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 14,
    color: '#9CA3AF',
    lineHeight: 1.5,
  },
  notice: {
    padding: '12px 16px',
    background: '#1F2937',
    border: '1px solid #374151',
    borderRadius: 8,
    color: '#D1D5DB',
    fontSize: 13,
    marginBottom: 16,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    textAlign: 'left',
    gap: 8,
    padding: 20,
    background: '#111827',
    border: '1px solid #1F2937',
    borderRadius: 12,
    color: '#F3F4F6',
    fontFamily: 'inherit',
    fontSize: 13,
    boxShadow: '0 4px 12px rgba(0,0,0,0.24)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardName: {
    fontSize: 18,
    fontWeight: 700,
    color: '#F9FAFB',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  selfTag: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: '#93C5FD',
    background: 'rgba(59,130,246,0.10)',
    border: '1px solid rgba(59,130,246,0.30)',
    borderRadius: 4,
    padding: '2px 6px',
  },
  cardMeta: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  cardStatusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  statusPill: {
    display: 'inline-block',
    padding: '3px 10px',
    border: '1px solid',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.3,
  },
  alarmBadge: {
    display: 'inline-block',
    padding: '3px 8px',
    background: '#7F1D1D',
    color: '#FEE2E2',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.3,
  },
  cardProgram: {
    fontSize: 12,
    color: '#BFDBFE',
    marginTop: 2,
  },
  offlineNote: {
    marginTop: 6,
    fontSize: 11,
    color: '#A8A29E',
    lineHeight: 1.4,
  },
}

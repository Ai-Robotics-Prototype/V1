import { useEffect, useState } from 'react'
import m8PanelUrl from '../assets/hookup/panel_m8_placeholder.svg'
import airPanelUrl from '../assets/hookup/panel_air_placeholder.svg'

// HookupGuide — data-driven peripheral hookup instructions.
//
// 2026-09-08 operator directive: display-only guide, gated on
// gripper type from the wizard OR read-only reopen from the
// program editor. Sends NO IO or motion; writes only an
// informational `hookup_confirmed` flag when the caller commits.
//
// Data source: /api/hookup_map → /opt/cobot/hookup/hookup_map.json.
// Panel artwork is placeholder SVG for now (M8 grid + air-station
// manifold). Real panel photos drop into
// src/cobot_dashboard/frontend/src/assets/hookup/ and the JSON
// asset field switches to their filenames — SVG highlight overlay
// keeps positioning correct because it's computed from x_pct /
// y_pct fractions of whatever panel image is loaded.
//
// Props:
//   gripperType : 'finger' | 'vacuum' | 'custom'
//   mode        : 'wizard' | 'editor'   (labels + primary button copy)
//   confirmed   : bool                  (initial checked state per card)
//   onConfirm(all_checked)              (wizard: goNext override)
//   onSkip()                            (wizard: 'already connected')
//   onClose()                           (editor read-only reopen)

const PANEL_ASSETS = {
  m8_panel:  m8PanelUrl,
  air_panel: airPanelUrl,
}

export default function HookupGuide({
  gripperType, mode = 'wizard', confirmed = false,
  onConfirm, onSkip, onClose,
}) {
  const [map, setMap]     = useState(null)
  const [err, setErr]     = useState(null)
  const [checked, setChecked] = useState({})

  useEffect(() => {
    let alive = true
    fetch('/api/hookup_map').then((r) => r.ok ? r.json() : null)
      .then((body) => {
        if (!alive) return
        if (!body || !body.ok) {
          setErr((body && body.detail) || 'hookup map unavailable')
          return
        }
        setMap(body.map)
      })
      .catch((e) => { if (alive) setErr(String(e && e.message || e)) })
    return () => { alive = false }
  }, [])

  const hookups = (map && map.gripper_hookups && map.gripper_hookups[gripperType]) || []
  const allChecked = hookups.length > 0 && hookups.every((h) => checked[h.id])

  function toggle(id) {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // Editor mode: read-only, one Close button, checkboxes render
  // disabled (mirroring the last-known confirm state).
  const readOnly = mode === 'editor'

  return (
    <div
      data-testid="hookup-guide"
      data-gripper={gripperType}
      data-mode={mode}
      style={{
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>
          Connect your hardware
        </div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
          {readOnly
            ? 'Reference view — the guide below is what you saw during setup.'
            : 'One checkbox per connection. Skip if the robot is already wired.'}
        </div>
      </div>

      {err && (
        <div style={{
          padding: '10px 12px', borderRadius: 6,
          background: '#FEF3C7', color: '#92400E', fontSize: 12,
          border: '1px solid #FDE68A',
        }}>
          Hookup guide unavailable: {err}
        </div>
      )}

      {!err && !map && (
        <div style={{ color: '#6b7280', fontSize: 13 }}>Loading hookup map…</div>
      )}

      {!err && map && hookups.length === 0 && (
        <div style={{
          padding: 14, borderRadius: 8, background: '#F3F4F6',
          color: '#374151', fontSize: 13, lineHeight: 1.5,
        }}>
          No pre-defined hookup for the <b>{gripperType}</b> gripper —
          custom end-effectors wire their own I/O in Configure. Skip
          this page and set up ports on the I/O tab.
        </div>
      )}

      {!err && map && hookups.map((h) => (
        <HookupCard
          key={h.id}
          hookup={h}
          coords={map.coordinates}
          images={map.images}
          checked={!!checked[h.id]}
          disabled={readOnly}
          onToggle={() => !readOnly && toggle(h.id)}
        />
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        {readOnly ? (
          <button
            data-testid="hookup-guide-close"
            onClick={onClose}
            style={btn('#2563EB', '#fff')}>
            Close
          </button>
        ) : (
          <>
            <button
              data-testid="hookup-guide-skip"
              onClick={() => onSkip?.()}
              style={btn('#fff', '#6b7280', '#d1d5db')}>
              Skip — already connected
            </button>
            <button
              data-testid="hookup-guide-confirm"
              onClick={() => onConfirm?.(allChecked)}
              disabled={hookups.length > 0 && !allChecked}
              style={{
                ...btn('#16A34A', '#fff', '#15803d'),
                opacity: (hookups.length > 0 && !allChecked) ? 0.55 : 1,
                cursor: (hookups.length > 0 && !allChecked) ? 'not-allowed' : 'pointer',
              }}>
              {hookups.length === 0
                ? 'Next'
                : allChecked ? 'All connected — Next' : `Check ${hookups.length - Object.values(checked).filter(Boolean).length} more`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function btn(bg, color, border) {
  return {
    flex: 1, minHeight: 44,
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
    background: bg, color, border: `1px solid ${border || bg}`,
    borderRadius: 8, cursor: 'pointer',
  }
}

function HookupCard({ hookup, coords, images, checked, disabled, onToggle }) {
  // Resolve the coord entry and panel key by target type. The map
  // is display-only: if a coord is missing, render the card with an
  // annotation so the operator sees which id lost its mapping (the
  // guide never silently drops a connection).
  let coord = null
  let idLabel = ''
  if (hookup.target === 'm8') {
    coord = coords?.m8?.[hookup.m8_id] || null
    idLabel = hookup.m8_id
  } else if (hookup.target === 'air_station') {
    coord = coords?.air_stations?.[hookup.air_station_label] || null
    idLabel = hookup.air_station_label
  }
  const panelKey = coord?.panel || 'm8_panel'
  const asset = PANEL_ASSETS[panelKey]

  return (
    <label
      data-testid="hookup-card"
      data-connection-id={hookup.id}
      data-needs-confirm={hookup.needs_operator_confirmation ? 'true' : 'false'}
      style={{
        display: 'flex', gap: 14, padding: 12,
        background: checked ? '#F0FDF4' : '#fff',
        border: `2px solid ${checked ? '#16A34A' : '#e5e7eb'}`,
        borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
        alignItems: 'flex-start',
        transition: 'background 120ms, border-color 120ms',
      }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        data-testid="hookup-card-check"
        style={{
          marginTop: 4, width: 18, height: 18, flexShrink: 0,
          cursor: disabled ? 'default' : 'pointer',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          fontSize: 14, fontWeight: 700, color: '#111',
        }}>
          <span style={{ fontFamily: 'var(--font-mono, monospace)',
                         padding: '2px 6px', background: '#EEF2FF',
                         color: '#3730A3', borderRadius: 4,
                         fontSize: 11 }}>
            {idLabel || '?'}
          </span>
          <span>{hookup.purpose_text}</span>
        </div>
        {hookup.needs_operator_confirmation && (
          <div style={{
            fontSize: 10, color: '#92400E', marginTop: 6,
            padding: '2px 6px', background: '#FEF3C7',
            border: '1px solid #FDE68A', borderRadius: 3,
            display: 'inline-block',
          }}>
            PLACEHOLDER — operator will confirm this mapping.
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <PanelWithHighlight
            asset={asset}
            highlight={coord}
            idLabel={idLabel} />
        </div>
      </div>
    </label>
  )
}

function PanelWithHighlight({ asset, highlight, idLabel }) {
  if (!asset) {
    return (
      <div style={{
        padding: 12, background: '#F3F4F6', color: '#6b7280',
        fontSize: 12, borderRadius: 6,
      }}>
        Panel artwork missing.
      </div>
    )
  }
  if (!highlight) {
    return (
      <div style={{ position: 'relative', width: '100%', maxWidth: 500 }}>
        <img src={asset} alt=""
             style={{ width: '100%', height: 'auto', display: 'block',
                      background: '#111827', borderRadius: 6 }} />
        <div style={{
          padding: '4px 8px', fontSize: 10, color: '#B45309',
          background: '#FEF3C7', borderTop: '1px solid #FDE68A',
          borderRadius: '0 0 6px 6px',
        }}>
          Highlight coordinates missing for <b>{idLabel}</b>.
        </div>
      </div>
    )
  }
  // Position overlay as a percentage-anchored SVG on top of the
  // panel image. Overlay is intentionally NEVER baked into the
  // artwork — remapping requires no new art, only a JSON edit.
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 500 }}>
      <img src={asset} alt=""
           style={{ width: '100%', height: 'auto', display: 'block',
                    background: '#111827', borderRadius: 6 }} />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"
           style={{
             position: 'absolute', inset: 0,
             width: '100%', height: '100%', pointerEvents: 'none',
           }}>
        <circle
          cx={highlight.x_pct}
          cy={highlight.y_pct}
          r={5}
          fill="none"
          stroke="#DC2626"
          strokeWidth={0.8}
          style={{ filter: 'drop-shadow(0 0 4px rgba(220,38,38,0.7))' }}
        />
        <text
          x={highlight.x_pct}
          y={Math.max(0, highlight.y_pct - 7)}
          fill="#FCA5A5"
          fontSize={4}
          textAnchor="middle"
          fontFamily="system-ui, sans-serif">
          {idLabel}
        </text>
      </svg>
    </div>
  )
}

import { useEffect, useState } from 'react'
import frontPanelUrl from '../assets/hookup/hookup_panel_front.svg'
import isoPanelUrl   from '../assets/hookup/hookup_panel_iso.svg'

// HookupGuide — data-driven peripheral hookup instructions.
//
// 2026-09-08 v2 schema: air stations carry two ports (A + B); each
// input-direction connection can be "no sensor" per operator
// directive (persisted on program.config.hookup_no_sensor). The
// glow overlay is percentage-anchored SVG (feGaussianBlur halo +
// ring stroke + slow pulse animation, dim mask on the rest of the
// panel) so remapping to real panel PNGs requires no code change
// — just drop the .png and update the JSON asset field.
//
// 2026-09-08 blow-off audit: hookup entries with `optional: true`
// + `toggle_answer_key` render a positive-framing prompt card
// ("Use blow-off on release? Recommended…"). Selected answer
// (default = `toggle_default`) flows through onConfirm's
// optionalToggles map to answers.<toggle_answer_key>, which the
// buildSteps flow reads to gate codegen emission (e.g.
// answers.blow_off_enabled → _vocabOpts.withBlowOff →
// effectorDisengage vacuum-blow-off triplet).
//
// Data source: GET /api/hookup_map → /opt/cobot/hookup/hookup_map.json.
//
// Props:
//   gripperType       : 'finger' | 'vacuum' | 'custom'
//   mode              : 'wizard' | 'editor'
//   confirmed         : bool                            (checked state per card)
//   noSensor          : { [connectionId]: true }        (per-connection sensor toggles)
//   optionalAnswers   : { [answer_key]: boolean }       (initial values for optional
//                                                        connection toggles)
//   onConfirm(all_checked, noSensorMap, optionalAnswers) (wizard confirm)
//   onSkip()
//   onClose()

const PANEL_ASSETS = { front: frontPanelUrl, iso: isoPanelUrl }

function usePrefersReducedMotion() {
  const [pref, setPref] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPref(mq.matches)
    const on = (e) => setPref(e.matches)
    try { mq.addEventListener('change', on) } catch { mq.addListener(on) }
    return () => {
      try { mq.removeEventListener('change', on) } catch { mq.removeListener(on) }
    }
  }, [])
  return pref
}

export default function HookupGuide({
  gripperType, mode = 'wizard', confirmed = false,
  noSensor: initialNoSensor = null,
  optionalAnswers: initialOptional = null,
  onConfirm, onSkip, onClose,
}) {
  const [map, setMap]     = useState(null)
  const [err, setErr]     = useState(null)
  const [checked, setChecked]     = useState({})
  const [noSensor, setNoSensor]   = useState(() => ({ ...(initialNoSensor || {}) }))
  // Optional-connection toggles (e.g. blow-off). Keyed by
  // hookup.toggle_answer_key. Seeded from the hookup entries'
  // toggle_default when the map loads (see the effect below).
  const [optional, setOptional]   = useState(() => ({ ...(initialOptional || {}) }))
  const reducedMotion = usePrefersReducedMotion()

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

  const rawHookups = (map && map.gripper_hookups && map.gripper_hookups[gripperType]) || []

  // Seed optional-toggle defaults from the map when it first
  // lands (only for keys the caller didn't pre-set). e.g. the
  // vacuum blow-off entry ships toggle_default:true so the
  // toggle mirrors today's silent-default behaviour until the
  // operator makes a fresh choice.
  useEffect(() => {
    if (!map) return
    setOptional((prev) => {
      let next = prev
      for (const h of rawHookups) {
        if (h.optional && h.toggle_answer_key
            && !(h.toggle_answer_key in next)) {
          if (next === prev) next = { ...prev }
          next[h.toggle_answer_key] = h.toggle_default === true
        }
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  // Filter out sensors the operator marked "no sensor" — the card
  // is hidden AND, downstream, program.config.hookup_no_sensor
  // gates codegen paths that would otherwise wait on a
  // never-connected input.
  //
  // Also filter out optional cards the operator has toggled OFF
  // (e.g. blow-off). Their toggle prompt stays visible above the
  // filtered card list so the choice is discoverable.
  const hookups = rawHookups.filter((h) => {
    if (noSensor[h.id]) return false
    if (h.optional && h.toggle_answer_key) {
      return optional[h.toggle_answer_key] === true
    }
    return true
  })
  // Optional prompts render regardless of current answer so the
  // operator can flip the toggle back on. Sorted stable — the
  // JSON order defines display order.
  const optionalPrompts = rawHookups.filter(
    (h) => h.optional && h.toggle_answer_key)
  const allChecked = hookups.length > 0 && hookups.every((h) => checked[h.id])
  const readOnly = mode === 'editor'

  function toggleCheck(id) {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }))
  }
  function setNoSensorFlag(id, value) {
    setNoSensor((prev) => {
      const next = { ...prev, [id]: value }
      if (!value) delete next[id]
      return next
    })
    // Also drop any check on a hidden card so a re-toggle back
    // doesn't leave a stale check.
    if (value) setChecked((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  return (
    <div
      data-testid="hookup-guide"
      data-gripper={gripperType}
      data-mode={mode}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

      {!err && map && rawHookups.length === 0 && (
        <div style={{
          padding: 14, borderRadius: 8, background: '#F3F4F6',
          color: '#374151', fontSize: 13, lineHeight: 1.5,
        }}>
          No pre-defined hookup for the <b>{gripperType}</b> gripper —
          custom end-effectors wire their own I/O in Configure. Skip
          this page and set up ports on the I/O tab.
        </div>
      )}

      {/* Optional-connection prompt cards (e.g. blow-off).
          Positive framing per operator directive; toggle drives
          both card visibility AND codegen emission via the
          `toggle_answer_key` → answers.<key> spread on confirm. */}
      {!err && map && optionalPrompts.map((h) => {
        const on = optional[h.toggle_answer_key] === true
        return (
          <div key={`optional-${h.id}`}
               data-testid="hookup-optional-prompt"
               data-answer-key={h.toggle_answer_key}
               data-on={on ? 'true' : 'false'}
               style={{
                 padding: 12, borderRadius: 8,
                 background: on ? '#EEF2FF' : '#F9FAFB',
                 border: `1px solid ${on ? '#C7D2FE' : '#E5E7EB'}`,
                 display: 'flex', gap: 10,
                 alignItems: 'center', justifyContent: 'space-between',
               }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>
                {h.toggle_prompt || h.purpose_text}
              </div>
              {!on && (
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                  Off — no instruction card, no code step.
                </div>
              )}
            </div>
            {!readOnly && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  data-testid="hookup-optional-btn-on"
                  data-answer-key={h.toggle_answer_key}
                  onClick={() => setOptional(
                    (prev) => ({ ...prev, [h.toggle_answer_key]: true }))}
                  style={optBtn(on ? '#4F46E5' : '#fff',
                                on ? '#fff' : '#374151',
                                on ? '#4338CA' : '#D1D5DB')}>
                  On
                </button>
                <button
                  data-testid="hookup-optional-btn-off"
                  data-answer-key={h.toggle_answer_key}
                  onClick={() => setOptional(
                    (prev) => ({ ...prev, [h.toggle_answer_key]: false }))}
                  style={optBtn(!on ? '#6B7280' : '#fff',
                                !on ? '#fff' : '#374151',
                                !on ? '#4B5563' : '#D1D5DB')}>
                  Off
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* Hidden-cards summary — when the operator picks "No sensor"
          for one or more inputs, show a small acknowledgement line
          so it's clear WHICH cards are hidden (auditability). */}
      {rawHookups.filter((h) => noSensor[h.id]).map((h) => (
        <div key={`nosensor-${h.id}`}
             data-testid="hookup-no-sensor-note"
             data-connection-id={h.id}
             style={{
               padding: '6px 10px', fontSize: 11, lineHeight: 1.5,
               borderRadius: 6, background: '#F3F4F6',
               color: '#4B5563', display: 'flex', gap: 10,
               alignItems: 'center', justifyContent: 'space-between',
             }}>
          <span>
            <b>{h.purpose_text.split(' — ')[0]}</b>: no sensor.
            {' '}<span style={{ color: '#B45309' }}>
              {h.no_sensor_recommendation || 'Recommended: a sensor lets the robot verify state instead of assuming.'}
            </span>
          </span>
          {!readOnly && (
            <button
              onClick={() => setNoSensorFlag(h.id, false)}
              style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4,
                background: '#fff', color: '#374151',
                border: '1px solid #D1D5DB', cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}>
              Re-add sensor
            </button>
          )}
        </div>
      ))}

      {!err && map && hookups.map((h) => (
        <HookupCard
          key={h.id}
          hookup={h}
          coords={map.coordinates}
          checked={!!checked[h.id]}
          disabled={readOnly}
          reducedMotion={reducedMotion}
          onToggle={() => !readOnly && toggleCheck(h.id)}
          onNoSensor={h.direction === 'input' && !readOnly
            ? () => setNoSensorFlag(h.id, true)
            : null}
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
              onClick={() => onConfirm?.(allChecked, noSensor, optional)}
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

function optBtn(bg, color, border) {
  return {
    minWidth: 52, padding: '6px 12px',
    fontSize: 12, fontWeight: 700,
    background: bg, color, border: `1px solid ${border || bg}`,
    borderRadius: 6, cursor: 'pointer',
  }
}

// Resolve a hookup entry to {panelKey, x_pct, y_pct, idLabel}.
function resolveTarget(hookup, coords) {
  if (hookup.target === 'm8') {
    const c = coords?.m8?.[hookup.m8_id]
    if (!c) return { idLabel: hookup.m8_id, panelKey: null }
    return {
      idLabel: hookup.m8_id,
      panelKey: c.panel || 'front',
      x_pct: c.x_pct, y_pct: c.y_pct,
    }
  }
  if (hookup.target === 'air_station') {
    const station = coords?.air_stations?.[hookup.station]
    if (!station) return { idLabel: `${hookup.station} — port ${hookup.port}`, panelKey: null }
    const portKey = hookup.port === 'B' ? 'port_b' : 'port_a'
    const p = station[portKey]
    return {
      idLabel: `${hookup.station} — port ${hookup.port || 'A'}`,
      panelKey: station.panel || 'front',
      x_pct: p?.x_pct, y_pct: p?.y_pct,
    }
  }
  return { idLabel: '?', panelKey: null }
}

function HookupCard({ hookup, coords, checked, disabled, reducedMotion,
                     onToggle, onNoSensor }) {
  const { idLabel, panelKey, x_pct, y_pct } = resolveTarget(hookup, coords)
  const asset = panelKey ? PANEL_ASSETS[panelKey] : null
  return (
    <div
      data-testid="hookup-card"
      data-connection-id={hookup.id}
      data-direction={hookup.direction}
      data-needs-confirm={hookup.needs_operator_confirmation ? 'true' : 'false'}
      style={{
        display: 'flex', gap: 14, padding: 12,
        background: checked ? '#F0FDF4' : '#fff',
        border: `2px solid ${checked ? '#16A34A' : '#e5e7eb'}`,
        borderRadius: 10, alignItems: 'flex-start',
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
          display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
          fontSize: 14, fontWeight: 700, color: '#111',
        }}>
          <span style={{ fontFamily: 'var(--font-mono, monospace)',
                         padding: '2px 6px', background: '#EEF2FF',
                         color: '#3730A3', borderRadius: 4, fontSize: 11 }}>
            {idLabel}
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
        {hookup.direction === 'input' && onNoSensor && (
          <div style={{ marginTop: 8 }}>
            <button
              data-testid="hookup-no-sensor-btn"
              data-connection-id={hookup.id}
              onClick={onNoSensor}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 4,
                background: '#fff', color: '#374151',
                border: '1px solid #D1D5DB', cursor: 'pointer',
              }}>
              No sensor / not using a sensor
            </button>
            {hookup.no_sensor_recommendation && (
              <div style={{
                marginTop: 4, fontSize: 10, color: '#6B7280',
                lineHeight: 1.5,
              }}>
                {hookup.no_sensor_recommendation}
              </div>
            )}
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <PanelWithGlow
            asset={asset}
            x_pct={x_pct}
            y_pct={y_pct}
            idLabel={idLabel}
            reducedMotion={reducedMotion} />
        </div>
      </div>
    </div>
  )
}

// PanelWithGlow — commercial-quality highlight overlay.
//
//   * Panel image renders at full opacity.
//   * A dim mask (~35 % dark) covers the whole panel EXCEPT the
//     glowing port (mask cut-out).
//   * A soft radial glow (feGaussianBlur halo + solid ring stroke)
//     draws the eye. The ring pulses at 1.8 s cadence unless the
//     user has prefers-reduced-motion set — then static.
//
// The overlay is a single SVG absolutely positioned on top of the
// image; every position is percentage-anchored so remapping =
// JSON edit, no artwork churn.
function PanelWithGlow({ asset, x_pct, y_pct, idLabel, reducedMotion }) {
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
  const haveCoord = Number.isFinite(x_pct) && Number.isFinite(y_pct)
  return (
    <div style={{
      position: 'relative', width: '100%', maxWidth: 520,
      borderRadius: 8, overflow: 'hidden',
      background: '#0F172A',
    }}>
      <img src={asset} alt=""
           style={{
             width: '100%', height: 'auto', display: 'block',
           }} />
      {haveCoord && (
        <svg
          data-testid="hookup-glow-overlay"
          data-reduced-motion={reducedMotion ? 'true' : 'false'}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%', pointerEvents: 'none',
          }}>
          <defs>
            {/* Soft radial halo around the target port. */}
            <radialGradient id={`halo-${x_pct}-${y_pct}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stop-color="#3B82F6" stop-opacity="0.65"/>
              <stop offset="45%"  stop-color="#3B82F6" stop-opacity="0.25"/>
              <stop offset="100%" stop-color="#3B82F6" stop-opacity="0"/>
            </radialGradient>
            {/* Dim mask — full-panel dark rectangle with a
                punch-out at the target port so the port renders at
                full brightness while the rest is quieted. */}
            <mask id={`dim-${x_pct}-${y_pct}`}>
              <rect x="0" y="0" width="100" height="100" fill="white"/>
              <circle cx={x_pct} cy={y_pct} r="6" fill="black"/>
            </mask>
            {/* Pulse animation on the ring stroke width. Reduced-
                motion callers get a static ring (see below). */}
            <style>{`
              @keyframes hookup-glow-pulse {
                0%   { opacity: 0.75; transform: scale(1);   }
                50%  { opacity: 1;    transform: scale(1.05); }
                100% { opacity: 0.75; transform: scale(1);   }
              }
              .hookup-halo-pulse {
                transform-origin: ${x_pct}px ${y_pct}px;
                animation: hookup-glow-pulse 1.8s ease-in-out infinite;
              }
            `}</style>
          </defs>
          {/* Dim overlay — masks everything except the port cut-out. */}
          <rect
            x="0" y="0" width="100" height="100"
            fill="#000000" opacity="0.35"
            mask={`url(#dim-${x_pct}-${y_pct})`}
          />
          {/* Halo — radial gradient behind the ring. Pulses unless
              reduced-motion. */}
          <circle
            className={reducedMotion ? '' : 'hookup-halo-pulse'}
            cx={x_pct} cy={y_pct} r="8"
            fill={`url(#halo-${x_pct}-${y_pct})`}
          />
          {/* Ring stroke — the crisp accent outline the eye lands on. */}
          <circle
            cx={x_pct} cy={y_pct} r="3.5"
            fill="none" stroke="#3B82F6" stroke-width="0.6"
            style={{ filter: 'drop-shadow(0 0 1.2px rgba(59,130,246,0.9))' }}
          />
          {/* Id label above the ring. */}
          <text
            x={x_pct} y={Math.max(2, y_pct - 5)}
            fill="#DBEAFE" font-size="3" text-anchor="middle"
            font-family="system-ui, sans-serif"
            style={{ paintOrder: 'stroke', stroke: '#0F172A',
                     strokeWidth: 0.5 }}>
            {idLabel}
          </text>
        </svg>
      )}
    </div>
  )
}

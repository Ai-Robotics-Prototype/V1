import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import IOPortMap from '../components/IOPortMap'

// Synapse — Connection Map (2026-09-21 operator directive).
//
// A static, read-only wiring reference for the Synapse controller:
// pneumatic valve ports, digital inputs/outputs on M8, and safety
// devices on M12. Every connector glyph carries a `data-io=`
// attribute so a LATER pass can bind live state (glow-when-
// energized) by grepping the DOM without touching this file.
//
// Design decisions (operator directive 2026-09-21):
//   * Restyle to the app's existing look — pages are WHITE with
//     `#e5e7eb` borders, 12px radius, 20px padding, `#111` primary
//     text, muted `#6b7280`, and the app blue #2563EB. The mock is
//     dark; that dark chrome is retired at the page level here.
//   * Section accents survive as ACCENTS ONLY (not backgrounds):
//     pneumatic → blue #2563EB, inputs → green #16A34A, outputs →
//     amber #D97706, safety → red #DC2626. Chips + connector rings
//     borrow the accent; card fills stay white.
//   * Data lives in ONE array per section (SECTIONS below). Hardware
//     changes edit data; JSX stays untouched.
//   * VIEW-tier: no fetch, no dispatch, no control verb. If a later
//     pass adds live state it MUST come through a prop (LIVE_STATE
//     map keyed by data-io) so the D_synapse_view_only pin stays green.
//
// Native-app fit: renders inside the App's content grid area (which
// has the dark bg-app underneath) as a full white surface — mirrors
// IOPage / EventLog page shape. Not a poster.

const CARD_BG        = '#FFFFFF'
const CARD_BORDER    = '#E5E7EB'
const TEXT_PRIMARY   = '#111111'
const TEXT_SECONDARY = '#6B7280'
const TEXT_MUTED     = '#9CA3AF'
const APP_BLUE       = '#2563EB'
const PNEUM_ACCENT   = '#2563EB'   // app blue
const INPUT_ACCENT   = '#16A34A'   // green
const OUTPUT_ACCENT  = '#D97706'   // amber
const SAFETY_ACCENT  = '#DC2626'   // red

// ── Data (edit these arrays, not the JSX) ────────────────────────────

const VALVES = [
  { id: 'V01', label: 'Valve 01', type: '5/2 SS' },
  { id: 'V02', label: 'Valve 02', type: '5/2 SS' },
  { id: 'V03', label: 'Valve 03', type: 'HI/LO 3/2 N/C' },
  { id: 'V04', label: 'Valve 04', type: 'HI/LO 2/2 N/C' },
  { id: 'V05', label: 'Valve 05', type: 'SPARE 1' },
  { id: 'V06', label: 'Valve 06', type: '5/3' },
  { id: 'V07', label: 'Valve 07', type: 'HI/LO 3/2 N/O' },
  { id: 'V08', label: 'Valve 08', type: 'HI/LO 3/2 N/C' },
  { id: 'V09', label: 'Valve 09', type: '5/2 DS' },
  { id: 'V10', label: 'Valve 10', type: 'SPARE 2' },
]

const DIGITAL_INPUTS = Array.from({ length: 10 }, (_, i) => ({
  id:    `IN${String(i + 1).padStart(2, '0')}`,
  label: `IN ${String(i + 1).padStart(2, '0')}`,
}))

const DIGITAL_OUTPUTS = Array.from({ length: 10 }, (_, i) => ({
  id:    `OUT${String(i + 1).padStart(2, '0')}`,
  label: `OUT ${String(i + 1).padStart(2, '0')}`,
}))

const SAFETY_DEVICES = Array.from({ length: 4 }, (_, i) => ({
  id:    `SAFETY${String(i + 1).padStart(2, '0')}`,
  label: `SAFETY ${String(i + 1).padStart(2, '0')}`,
}))


// ── Connector glyphs (inline SVG, crisp at any scale) ────────────────
//
// One component per connector type. Each takes `dataIo` + `accent`
// and renders a hexagonal fitting with an inner motif; the outer
// ring uses the accent color, the inner motif is the same accent
// at reduced opacity. Sized for the ~40 px cells in the mock; scales
// via CSS width/height on the wrapping span.

function HexOutline({ size = 44, accent, children }) {
  const w = size, h = size
  // Regular hex, flat-top. cx/cy = center.
  const cx = w / 2, cy = h / 2, r = w * 0.46
  const pts = []
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 3) * i + Math.PI / 6
    pts.push(`${cx + r * Math.cos(ang)},${cy + r * Math.sin(ang)}`)
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}
         style={{ display: 'block' }} aria-hidden="true">
      <polygon
        points={pts.join(' ')}
        fill="#FFFFFF"
        stroke={accent}
        strokeWidth={1.5}
      />
      {children}
    </svg>
  )
}

function PneumaticPortGlyph({ dataIo, size = 44 }) {
  // Pneumatic quick-connect: hex fitting + inner O-ring circle.
  const cx = size / 2, cy = size / 2
  return (
    <span data-io={dataIo} data-glyph="pneumatic"
          style={{ display: 'inline-block' }}>
      <HexOutline size={size} accent={PNEUM_ACCENT}>
        <circle cx={cx} cy={cy} r={size * 0.20}
                fill="none" stroke={PNEUM_ACCENT} strokeWidth={1.5} />
        <circle cx={cx} cy={cy} r={size * 0.08}
                fill={PNEUM_ACCENT} opacity={0.85} />
      </HexOutline>
    </span>
  )
}

function DigitalInputGlyph({ dataIo, size = 44 }) {
  // M8 3-pin sensor input: hex + 3-pin pattern.
  const cx = size / 2, cy = size / 2, r = size * 0.14
  return (
    <span data-io={dataIo} data-glyph="digital_input"
          style={{ display: 'inline-block' }}>
      <HexOutline size={size} accent={INPUT_ACCENT}>
        <circle cx={cx} cy={cy - r * 0.9} r={size * 0.05}
                fill={INPUT_ACCENT} opacity={0.9} />
        <circle cx={cx - r * 0.85} cy={cy + r * 0.55} r={size * 0.05}
                fill={INPUT_ACCENT} opacity={0.9} />
        <circle cx={cx + r * 0.85} cy={cy + r * 0.55} r={size * 0.05}
                fill={INPUT_ACCENT} opacity={0.9} />
        <circle cx={cx} cy={cy} r={size * 0.22}
                fill="none" stroke={INPUT_ACCENT} strokeWidth={1.2} />
      </HexOutline>
    </span>
  )
}

function DigitalOutputGlyph({ dataIo, size = 44 }) {
  // M8 output — same hex frame, different accent + slightly heavier
  // center dot to signal a driven pin.
  const cx = size / 2, cy = size / 2, r = size * 0.14
  return (
    <span data-io={dataIo} data-glyph="digital_output"
          style={{ display: 'inline-block' }}>
      <HexOutline size={size} accent={OUTPUT_ACCENT}>
        <circle cx={cx} cy={cy - r * 0.9} r={size * 0.05}
                fill={OUTPUT_ACCENT} opacity={0.9} />
        <circle cx={cx - r * 0.85} cy={cy + r * 0.55} r={size * 0.05}
                fill={OUTPUT_ACCENT} opacity={0.9} />
        <circle cx={cx + r * 0.85} cy={cy + r * 0.55} r={size * 0.05}
                fill={OUTPUT_ACCENT} opacity={0.9} />
        <circle cx={cx} cy={cy} r={size * 0.10}
                fill={OUTPUT_ACCENT} />
      </HexOutline>
    </span>
  )
}

function SafetyGlyph({ dataIo, size = 52 }) {
  // M12 safety: hex + downward arrow (mock's safety mark).
  const cx = size / 2, cy = size / 2
  return (
    <span data-io={dataIo} data-glyph="safety"
          style={{ display: 'inline-block' }}>
      <HexOutline size={size} accent={SAFETY_ACCENT}>
        <path
          d={`M ${cx - size * 0.13} ${cy - size * 0.08}
              L ${cx} ${cy + size * 0.18}
              L ${cx + size * 0.13} ${cy - size * 0.08}
              M ${cx} ${cy - size * 0.20}
              L ${cx} ${cy + size * 0.06}`}
          stroke={SAFETY_ACCENT} strokeWidth={2}
          fill="none" strokeLinecap="round" strokeLinejoin="round"
        />
      </HexOutline>
    </span>
  )
}


// ── Reusable pieces ──────────────────────────────────────────────────

function Chip({ label, accent = APP_BLUE }) {
  return (
    <span
      data-testid="synapse-chip"
      data-chip={label.toLowerCase().replace(/\s+/g, '_')}
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '4px 10px', borderRadius: 999,
        background: _tint(accent, 0.08),
        color: accent,
        border: `1px solid ${_tint(accent, 0.28)}`,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', fontFamily: 'inherit',
      }}>
      {label}
    </span>
  )
}

function SectionHeader({ index, title, chipLabel, chipAccent }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      marginBottom: 14,
    }}>
      <span style={{
        display: 'inline-block', width: 4, height: 18,
        background: chipAccent || APP_BLUE, borderRadius: 2,
      }} aria-hidden="true" />
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: 0.6,
        color: TEXT_PRIMARY, textTransform: 'uppercase',
        flex: 1,
      }}>{title}</div>
      {chipLabel && <Chip label={chipLabel} accent={chipAccent} />}
      {index != null && (
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
          color: TEXT_MUTED, textTransform: 'uppercase',
        }}>Section {index}</span>
      )}
    </div>
  )
}

function SubHeader({ text, right, accent }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 12,
      margin: '4px 0 10px',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.6,
        color: accent || TEXT_SECONDARY, textTransform: 'uppercase',
      }}>{text}</div>
      {right && (
        <div style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                       letterSpacing: 0.6, color: TEXT_MUTED,
                       textTransform: 'uppercase' }}>{right}</div>
      )}
    </div>
  )
}


// ── Cards ────────────────────────────────────────────────────────────

function ValveCard({ valve }) {
  return (
    <div
      data-testid="synapse-valve-card"
      data-valve-id={valve.id}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 6, padding: 12,
        background: CARD_BG, border: `1px solid ${CARD_BORDER}`,
        borderRadius: 10, minWidth: 0,
      }}
    >
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
        color: TEXT_MUTED, textTransform: 'uppercase',
      }}>{valve.label}</div>
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
        color: TEXT_PRIMARY, textAlign: 'center', lineHeight: 1.2,
        minHeight: 28,
      }}>{valve.type}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <PneumaticPortGlyph dataIo={`${valve.id}_PA`} />
        <PneumaticPortGlyph dataIo={`${valve.id}_PB`} />
      </div>
    </div>
  )
}

function IoCard({ item, kind }) {
  const Glyph = kind === 'input' ? DigitalInputGlyph : DigitalOutputGlyph
  const accent = kind === 'input' ? INPUT_ACCENT : OUTPUT_ACCENT
  return (
    <div
      data-testid={`synapse-io-card-${kind}`}
      data-io-id={item.id}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 6, padding: 10,
        background: CARD_BG, border: `1px solid ${CARD_BORDER}`,
        borderRadius: 10, minWidth: 0,
      }}
    >
      <Glyph dataIo={item.id} />
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        color: accent, textTransform: 'uppercase',
      }}>{item.label}</div>
    </div>
  )
}

function SafetyCard({ item }) {
  return (
    <div
      data-testid="synapse-safety-card"
      data-safety-id={item.id}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 8, padding: 14,
        background: CARD_BG, border: `1px solid ${CARD_BORDER}`,
        borderRadius: 10, minWidth: 0,
      }}
    >
      <SafetyGlyph dataIo={item.id} />
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: SAFETY_ACCENT, textTransform: 'uppercase',
      }}>{item.label}</div>
    </div>
  )
}


// ── Section wrappers ─────────────────────────────────────────────────

function Section({ children, testid }) {
  return (
    <section
      data-testid={testid}
      style={{
        background: CARD_BG, border: `1px solid ${CARD_BORDER}`,
        borderRadius: 12, padding: 20, marginBottom: 16,
      }}>{children}</section>
  )
}

function Grid5({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
      gap: 10,
    }}>{children}</div>
  )
}


// ── Page ─────────────────────────────────────────────────────────────

export default function SynapsePage() {
  // 2026-09-21 operator directive: I/O tab retired. The IOPortMap
  // (which owns the port map, manual override switches, DO2 confirm,
  // refusal copy, and the 1 Hz /api/io/live poll) mounts inside the
  // expandable section below. Rules:
  //   * Collapsed by default (fresh visits).
  //   * Auto-expanded when App.jsx redirected from a stale
  //     activeTab='io' (setSynapseIOSectionOpen(true)); we clear
  //     the flag on mount so the next fresh visit is collapsed.
  //   * Mount-once: while collapsed we render NO IOPortMap — the
  //     component simply isn't in the tree, and its 1 Hz fetch
  //     doesn't run. On expand it mounts once. On collapse it
  //     unmounts (stops the poll). No flash of the port map on
  //     expand — the section is inside a stable parent.
  const autoOpen = useStore((s) => s.synapseIOSectionOpen)
  const setSynapseIOSectionOpen = useStore(
    (s) => s.setSynapseIOSectionOpen)
  const [ioExpanded, setIoExpanded] = useState(false)
  useEffect(() => {
    if (autoOpen) {
      setIoExpanded(true)
      setSynapseIOSectionOpen(false)
    }
    // Intentionally not re-running on setSynapseIOSectionOpen ref
    // changes — the store action reference is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen])

  return (
    <div
      data-testid="synapse-page"
      style={{
        width: '100%', height: '100%', overflow: 'auto',
        background: '#FFFFFF',
        padding: '20px 20px 32px',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        color: TEXT_PRIMARY,
      }}
    >
      {/* Page header — matches EventLog / IOPage page-title style */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 20,
      }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800,
                      color: TEXT_PRIMARY, letterSpacing: 0.2 }}>
          Synapse
          <span style={{ color: TEXT_SECONDARY, fontWeight: 600,
                          letterSpacing: 0.4, marginLeft: 8 }}>
            — Connection Map
          </span>
        </h2>
        <div style={{ flex: 1 }} />
        <Chip label="UI Guide" accent={APP_BLUE} />
      </div>

      {/* Section 1 — Pneumatic valves */}
      <Section testid="synapse-section-pneumatic">
        <SectionHeader
          title="Pneumatic Valve Ports"
          chipLabel="AIR"
          chipAccent={PNEUM_ACCENT}
        />
        <Grid5>
          {VALVES.slice(0, 5).map((v) => (
            <ValveCard key={v.id} valve={v} />
          ))}
        </Grid5>
        <div style={{ height: 10 }} />
        <Grid5>
          {VALVES.slice(5, 10).map((v) => (
            <ValveCard key={v.id} valve={v} />
          ))}
        </Grid5>
      </Section>

      {/* Section 2 — Sensor inputs + outputs */}
      <Section testid="synapse-section-io">
        <SectionHeader
          title="Sensor Inputs & Outputs"
          chipLabel="M8 · 24 VDC"
          chipAccent={APP_BLUE}
        />
        <SubHeader text="Digital Inputs" accent={INPUT_ACCENT}
                    right="Top 10 Connections" />
        <Grid5>
          {DIGITAL_INPUTS.slice(0, 5).map((i) => (
            <IoCard key={i.id} item={i} kind="input" />
          ))}
        </Grid5>
        <div style={{ height: 10 }} />
        <Grid5>
          {DIGITAL_INPUTS.slice(5, 10).map((i) => (
            <IoCard key={i.id} item={i} kind="input" />
          ))}
        </Grid5>

        <hr style={{
          border: 'none', borderTop: `1px solid ${CARD_BORDER}`,
          margin: '18px 0',
        }} />

        <SubHeader text="Digital Outputs" accent={OUTPUT_ACCENT}
                    right="Bottom 10 Connections" />
        <Grid5>
          {DIGITAL_OUTPUTS.slice(0, 5).map((o) => (
            <IoCard key={o.id} item={o} kind="output" />
          ))}
        </Grid5>
        <div style={{ height: 10 }} />
        <Grid5>
          {DIGITAL_OUTPUTS.slice(5, 10).map((o) => (
            <IoCard key={o.id} item={o} kind="output" />
          ))}
        </Grid5>
      </Section>

      {/* Section 3 — Safety devices */}
      <Section testid="synapse-section-safety">
        <SectionHeader
          title="Safety Device Connections"
          chipLabel="M12"
          chipAccent={SAFETY_ACCENT}
        />
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 12,
        }}>
          {SAFETY_DEVICES.map((s) => (
            <SafetyCard key={s.id} item={s} />
          ))}
        </div>
      </Section>

      {/* Section 4 — Main Internal Robot Controller I/O (expandable) */}
      <section
        data-testid="synapse-section-internal-io"
        data-expanded={String(ioExpanded)}
        style={{
          background: CARD_BG, border: `1px solid ${CARD_BORDER}`,
          borderRadius: 12, marginBottom: 16, overflow: 'hidden',
        }}
      >
        <button
          type="button"
          data-testid="synapse-internal-io-toggle"
          onClick={() => setIoExpanded((v) => !v)}
          aria-expanded={ioExpanded}
          aria-controls="synapse-internal-io-body"
          style={{
            width: '100%', display: 'flex', alignItems: 'center',
            gap: 12, padding: '16px 20px',
            background: 'transparent', border: 'none',
            cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
            color: TEXT_PRIMARY,
          }}
        >
          <span style={{
            display: 'inline-block', width: 4, height: 18,
            background: APP_BLUE, borderRadius: 2,
          }} aria-hidden="true" />
          <span style={{
            fontSize: 12, fontWeight: 700, letterSpacing: 0.6,
            textTransform: 'uppercase', flex: 1,
          }}>
            Main Internal Robot Controller I/O
          </span>
          <span style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
            color: TEXT_MUTED, textTransform: 'uppercase',
          }}>
            {ioExpanded ? 'Hide' : 'Show'}
          </span>
          {/* Chevron — rotates 180° on expand. SVG so it stays
              crisp at any zoom + inherits the current text color. */}
          <svg width={14} height={14} viewBox="0 0 14 14"
               aria-hidden="true"
               style={{
                 transform: ioExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                 transition: 'transform 150ms ease',
                 color: TEXT_SECONDARY,
               }}>
            <path d="M 2 4 L 7 10 L 12 4"
                  stroke="currentColor" strokeWidth={2}
                  fill="none" strokeLinecap="round"
                  strokeLinejoin="round" />
          </svg>
        </button>
        {ioExpanded && (
          <div
            id="synapse-internal-io-body"
            data-testid="synapse-internal-io-body"
            style={{
              borderTop: `1px solid ${CARD_BORDER}`,
              padding: 16,
              background: '#FFFFFF',
            }}
          >
            {/* IOPortMap is the ONLY child — owns port map viz +
                manual overrides + DO2 confirm + refusal copy +
                the 1 Hz /api/io/live poll. Rendering it here only
                while `ioExpanded` guarantees the poll runs only
                while the section is open. Same component, same
                handlers, same testids. */}
            <IOPortMap />
          </div>
        )}
      </section>

      {/* Footer note */}
      <div style={{
        fontSize: 11, color: TEXT_MUTED, textAlign: 'center',
        letterSpacing: 0.4, textTransform: 'uppercase',
        padding: '8px 0 4px',
      }}>
        Connect only the devices assigned in the application setup wizard.
      </div>
    </div>
  )
}


// ── Tiny color helper (module-local, no runtime dep on lib/) ────────
// Mixes `hex` with white by `mix` (0..1) to produce a soft tint.
function _tint(hex, mix) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const w = 255
  const rr = Math.round(r + (w - r) * (1 - mix))
  const gg = Math.round(g + (w - g) * (1 - mix))
  const bb = Math.round(b + (w - b) * (1 - mix))
  return `rgb(${rr}, ${gg}, ${bb})`
}

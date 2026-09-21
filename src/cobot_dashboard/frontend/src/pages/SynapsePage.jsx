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

// 2026-09-21 operator directive: each valve card is clickable and
// opens an information panel with plain-language copy per valve
// TYPE. Content lives on the data structure (title / plain_
// explanation / best_use) so future revisions edit these fields
// only — never the JSX. Copy is operator-plain, not textbook.

const VALVE_TYPE_INFO = {
  '5/2 SS': {
    title: '5/2 Single Solenoid',
    plain_explanation:
      'This valve has one electric coil and an internal spring. '
      + 'Energize the coil and the valve shifts one way; drop power '
      + 'and the spring snaps it back to home. That means on power '
      + 'loss OR air loss, this valve automatically returns to its '
      + 'safe/home position — a fail-safe you get for free.',
    best_use:
      'Grippers, cylinders, and air dumps that MUST return to a '
      + 'safe state on stop or E-STOP. The spring return does '
      + 'the safe-home job for you.',
  },
  '5/2 DS': {
    title: '5/2 Double Solenoid',
    plain_explanation:
      'Two coils, one for each direction, and NO spring. When '
      + 'power drops the valve HOLDS whatever position it was last '
      + 'commanded to; it only changes when you send a new signal '
      + 'to the opposite coil. Safety difference from a Single '
      + 'Solenoid: this one does not snap home — it remembers.',
    best_use:
      'Motion that must NOT let go on power loss — a clamp holding '
      + 'a part, a load-lift cylinder. Pick 5/2 SS instead if you '
      + 'WANT the actuator to snap home when power drops.',
  },
  '5/3': {
    title: '5/3 Three-Position',
    plain_explanation:
      'Three states instead of two: extend, retract, and a middle '
      + 'rest position. The center usually either BLOCKS air '
      + '(freezing the cylinder wherever it is) or VENTS it '
      + '(releasing all pressure). That gives you a real "stop '
      + 'mid-stroke" capability the two-position valves cannot do.',
    best_use:
      'Positioning a cylinder at intermediate points, pausing '
      + 'motion partway through a stroke, or isolating / venting '
      + 'air on a controlled stop.',
  },
  'HI/LO 3/2 N/C': {
    title: '3/2 Normally Closed',
    plain_explanation:
      'A simple on/off valve with a built-in exhaust port. The '
      + 'default state is CLOSED — no air flows through the output '
      + 'until you energize the coil. When you drop the coil, the '
      + 'output line vents through the exhaust rather than staying '
      + 'pressurized.',
    best_use:
      'On-demand air — blow-off nozzles, vacuum ejectors, air '
      + 'blasts. Anything that should sit OFF by default and only '
      + 'run when the program commands it.',
  },
  'HI/LO 3/2 N/O': {
    title: '3/2 Normally Open',
    plain_explanation:
      'The inverse of a Normally Closed 3/2: the output flows by '
      + 'DEFAULT and shuts off when you energize the coil. '
      + 'Uncommon — pick this only when you specifically need air '
      + 'to be on unless something actively commands it off.',
    best_use:
      'Air bearings, cooling purges, or continuous utility flows '
      + 'that must stay on unless explicitly commanded to stop.',
  },
  'HI/LO 2/2 N/C': {
    title: '2/2 Normally Closed',
    plain_explanation:
      'Simple two-port on/off shutoff — one inlet, one outlet, NO '
      + 'exhaust port. Different from a 3/2 in one important way: '
      + 'when this valve closes, the downstream line STAYS '
      + 'pressurized because there is no vent path. Use only when '
      + 'you do not want the downstream side to bleed off.',
    best_use:
      'Supply isolation — turning a manifold or subsystem on and '
      + 'off without venting the lines below it.',
  },
  'SPARE 1': {
    title: 'Spare Port',
    plain_explanation:
      'This valve slot is unassigned. Reserved for future devices.',
    best_use:
      'Assign this port in the application setup wizard before '
      + 'connecting any device.',
  },
  'SPARE 2': {
    title: 'Spare Port',
    plain_explanation:
      'This valve slot is unassigned. Reserved for future devices.',
    best_use:
      'Assign this port in the application setup wizard before '
      + 'connecting any device.',
  },
}

// Build the VALVES array by merging the per-type info into each
// slot. Every valve entry ends up with { id, label, type, title,
// plain_explanation, best_use } — the data-completeness pin asserts
// non-empty explanation + best_use on every entry.
const _VALVE_SLOTS = [
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

const VALVES = _VALVE_SLOTS.map((v) => ({
  ...v,
  ...(VALVE_TYPE_INFO[v.type] || {}),
}))

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

// ── M8 3-pin face (shared by inputs + outputs) ──────────────────────
//
// Operator correction 2026-09-21: outputs must render the SAME
// physical connector face as inputs — only the color differs. One
// component, `M8ThreePinFace`, is parameterized by accent color.
// DigitalInputGlyph and DigitalOutputGlyph are thin wrappers that
// pass the correct accent (green / amber) + data-glyph tag, so
// downstream test / live-state selectors that key on `data-glyph`
// stay stable.

function M8ThreePinFace({ dataIo, size, accent, glyph }) {
  const cx = size / 2, cy = size / 2, r = size * 0.14
  return (
    <span data-io={dataIo} data-glyph={glyph}
          style={{ display: 'inline-block' }}>
      <HexOutline size={size} accent={accent}>
        <circle cx={cx} cy={cy - r * 0.9} r={size * 0.05}
                fill={accent} opacity={0.9} />
        <circle cx={cx - r * 0.85} cy={cy + r * 0.55} r={size * 0.05}
                fill={accent} opacity={0.9} />
        <circle cx={cx + r * 0.85} cy={cy + r * 0.55} r={size * 0.05}
                fill={accent} opacity={0.9} />
        <circle cx={cx} cy={cy} r={size * 0.22}
                fill="none" stroke={accent} strokeWidth={1.2} />
      </HexOutline>
    </span>
  )
}

function DigitalInputGlyph({ dataIo, size = 44 }) {
  return (
    <M8ThreePinFace dataIo={dataIo} size={size}
                     accent={INPUT_ACCENT}
                     glyph="digital_input" />
  )
}

function DigitalOutputGlyph({ dataIo, size = 44 }) {
  // 2026-09-21 operator correction: same face as DigitalInputGlyph,
  // amber accent. NO custom shape here — this thin wrapper is what
  // the "output-glyph-equals-input-glyph-component" pin locks in.
  return (
    <M8ThreePinFace dataIo={dataIo} size={size}
                     accent={OUTPUT_ACCENT}
                     glyph="digital_output" />
  )
}

// ── M12 5-pin safety face ───────────────────────────────────────────
//
// 2026-09-21 operator correction: safety must depict a face-on 5-pin
// M12 connector, not the previous downward-arrow icon. Standard M12
// 5-pin layout: four pins at the compass positions of a square
// (rotated 45° so they sit at N/E/S/W) plus one center pin. Same
// hex housing as the M8 face family, red accent.

function SafetyGlyph({ dataIo, size = 52 }) {
  const cx = size / 2, cy = size / 2
  // Ring radius from center to the four outer pins.
  const ringR = size * 0.20
  const pinR  = size * 0.055
  const pinFill = SAFETY_ACCENT
  return (
    <span data-io={dataIo} data-glyph="safety"
          style={{ display: 'inline-block' }}>
      <HexOutline size={size} accent={SAFETY_ACCENT}>
        {/* Inner housing ring — matches the M8 face's inner circle
            styling family for visual coherence with inputs/outputs. */}
        <circle cx={cx} cy={cy} r={size * 0.30}
                fill="none" stroke={SAFETY_ACCENT} strokeWidth={1.2} />
        {/* Four outer pins — N / E / S / W layout. */}
        <circle data-pin="N" cx={cx}          cy={cy - ringR}
                r={pinR} fill={pinFill} opacity={0.95} />
        <circle data-pin="E" cx={cx + ringR}  cy={cy}
                r={pinR} fill={pinFill} opacity={0.95} />
        <circle data-pin="S" cx={cx}          cy={cy + ringR}
                r={pinR} fill={pinFill} opacity={0.95} />
        <circle data-pin="W" cx={cx - ringR}  cy={cy}
                r={pinR} fill={pinFill} opacity={0.95} />
        {/* Fifth pin — center. Slightly larger so the eye reads
            it as the shared common/GND pin per M12 convention. */}
        <circle data-pin="C" cx={cx} cy={cy}
                r={pinR * 1.15} fill={pinFill} />
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

function ValveCard({ valve, onOpen }) {
  const [hover, setHover] = useState(false)
  // 2026-09-21 operator directive: valve cards are clickable —
  // tapping opens the ValveInfoPanel with the type explanation.
  // Card is a <button> so keyboard operators get Enter/Space for
  // free; hover/press adds a subtle lift so clickability is
  // discoverable. All VIEW-tier — no control affordance on the
  // card or the panel.
  return (
    <button
      type="button"
      data-testid="synapse-valve-card"
      data-valve-id={valve.id}
      onClick={() => onOpen(valve)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-label={`Open explainer for ${valve.label}, ${valve.type}`}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 6, padding: 12,
        background: CARD_BG,
        border: `1px solid ${hover ? APP_BLUE : CARD_BORDER}`,
        borderRadius: 10, minWidth: 0,
        cursor: 'pointer',
        textAlign: 'inherit',
        color: 'inherit',
        fontFamily: 'inherit',
        // Subtle lift on hover/focus; no motion on rest so the
        // page reads as calm at idle.
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hover
          ? '0 4px 10px rgba(37,99,235,0.12)'
          : '0 0 0 rgba(0,0,0,0)',
        transition: 'transform 120ms ease, border-color 120ms ease,'
                    + ' box-shadow 120ms ease',
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
      {/* 2026-09-21 operator correction: ports STACK VERTICALLY
          (PA above PB) to match the original mock. */}
      <div
        data-testid="synapse-valve-card-ports"
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 8, marginTop: 4,
        }}
      >
        <PneumaticPortGlyph dataIo={`${valve.id}_PA`} />
        <PneumaticPortGlyph dataIo={`${valve.id}_PB`} />
      </div>
    </button>
  )
}


// ── ValveInfoPanel — modal-family explainer, VIEW-tier only ─────────
//
// Matches the Orient/Enable modal token set: white card, subtle
// shadow, rgba(15,23,42,0.55) backdrop, X + Escape + backdrop-click
// dismissal. Zero control affordances — the panel is a read view
// of the valve TYPE's plain_explanation + best_use. Mount-once:
// mounted while `valve` prop is non-null, unmounted when null.
// Body sits above pointer-events:auto backdrop so operator taps
// on the backdrop cleanly dismiss without click-through.

function ValveInfoPanel({ valve, onClose }) {
  // Escape dismisses. Handler installed only while open.
  useEffect(() => {
    if (!valve) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [valve, onClose])
  if (!valve) return null

  const title = valve.title
    ? `${valve.label} — ${valve.title}`
    : `${valve.label} — ${valve.type}`

  return (
    <div
      data-testid="synapse-valve-info-backdrop"
      role="presentation"
      onClick={onClose}   // backdrop dismiss
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'auto',
      }}
    >
      <div
        data-testid="synapse-valve-info-panel"
        data-valve-id={valve.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby="synapse-valve-info-title"
        onClick={(e) => e.stopPropagation()}   // don't dismiss on card taps
        style={{
          background: '#fff', color: '#111318',
          border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
          padding: 20, minWidth: 320, maxWidth: 520,
          display: 'flex', flexDirection: 'column', gap: 14,
          fontFamily: 'inherit', fontSize: 13,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <div
            id="synapse-valve-info-title"
            data-testid="synapse-valve-info-title"
            style={{
              fontSize: 16, fontWeight: 700, color: '#0f172a',
              flex: 1,
            }}>
            {title}
          </div>
          <button
            type="button"
            data-testid="synapse-valve-info-close"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none',
              color: TEXT_SECONDARY, fontSize: 20, lineHeight: 1,
              cursor: 'pointer', padding: '0 4px',
              fontFamily: 'inherit',
            }}
          >
            ×
          </button>
        </div>

        <div
          data-testid="synapse-valve-info-explanation"
          style={{
            fontSize: 13, lineHeight: 1.55, color: '#334155',
          }}>
          {valve.plain_explanation}
        </div>

        <div
          data-testid="synapse-valve-info-best-use"
          style={{
            padding: '10px 12px',
            background: '#EFF6FF',
            border: '1px solid #BFDBFE',
            borderRadius: 6,
            fontSize: 13, lineHeight: 1.5, color: '#1E3A8A',
          }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
            color: '#1E40AF', textTransform: 'uppercase',
            marginBottom: 4,
          }}>
            Best use
          </div>
          {valve.best_use}
        </div>
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
  // 2026-09-21 operator directive: clicking a valve card opens the
  // ValveInfoPanel with plain-language copy for that valve type.
  // openValve holds the ENTIRE valve object (id + label + type +
  // title + plain_explanation + best_use) so the panel is a pure
  // render of its prop — no lookups, no store access, no fetch.
  const [openValve, setOpenValve] = useState(null)
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
        // 2026-09-21 operator correction: use the app's font token
        // (global.css `body { font-family: 'Inter', system-ui,
        // sans-serif; }`), not a page-local system-ui override. The
        // mock's wide-tracking stylized headers are normalized to
        // the Monitor / EventLog page-title style. Grep-pin:
        // `no font-family declaration on the Synapse page other
        // than 'inherit'` in D_synapse_tab.test.js.
        fontFamily: 'inherit',
        color: TEXT_PRIMARY,
      }}
    >
      {/* Page header — matches EventLog / IOPage page-title style.
          h2 uses no letterSpacing (Monitor/EventLog convention);
          subtitle span uses inherit weight tokens only. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 20,
      }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800,
                      color: TEXT_PRIMARY }}>
          Synapse
          <span style={{ color: TEXT_SECONDARY, fontWeight: 600,
                          marginLeft: 8 }}>
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
            <ValveCard key={v.id} valve={v} onOpen={setOpenValve} />
          ))}
        </Grid5>
        <div style={{ height: 10 }} />
        <Grid5>
          {VALVES.slice(5, 10).map((v) => (
            <ValveCard key={v.id} valve={v} onOpen={setOpenValve} />
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

      {/* Valve-info panel — mounted while `openValve` is non-null,
          unmounted when closed. Mount-once on open (single fiber
          creation, no repeated setup between mount and close);
          mount-once on close (single fiber destruction, no re-run
          during subsequent card taps because `openValve` state
          transitions null→valve→null cleanly). */}
      <ValveInfoPanel
        valve={openValve}
        onClose={() => setOpenValve(null)}
      />
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

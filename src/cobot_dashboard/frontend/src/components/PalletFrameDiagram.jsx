// PalletFrameDiagram — top-view of the pallet grid with a target
// marker on the point currently being taught. Rendered alongside the
// pallet teach flow so the operator sees WHICH point (①②③④) they're
// teaching and WHERE it is on the pallet.
//
// v2 (2026-07-30) uses four taught points:
//   ① CORNER at [1,1]           — fixture corner marker
//   ② CORNER at [1,N] (row far) — corner marker + row arrow
//   ③ CORNER at [M,1] (col far) — corner marker + col arrow
//   ④ FIRST PART at [1,1]       — part icon in the slot cell
//
// The 2026-07-31 extract: originally lived in ProgramWizard.jsx; now
// a shared component so the wizard AND the editor's Teach overlay
// mount ONE diagram — no fork.
//
// Enhancements over the wizard-only inline version:
//   * `frameStatus` prop — solid green dots on ALREADY-TAUGHT points,
//     hollow grey on upcoming untaught points. Threads
//     palletFrameStatus() output directly.
//   * `size` prop — 'small' (wizard side-card, default) or 'large'
//     (teach overlay's prominent placement, ~min 240px wide).
//   * ROW → / COL ↓ axis labels so the diagram's frame matches the
//     operator's configured fill order.
//   * data-testid markers on the container + per-role target so
//     the pinned tests can assert the right point highlights.

const CELL_SM = 28
// CELL_LG tuned so a 4×4 pallet renders inside a 240 px side-panel
// even after the COL ↓ axis label + inner padding. See the layout
// constraint in TeachOverlay (no vertical scroll invariant).
const CELL_LG = 40
const PAD_SM  = 24
const PAD_LG  = 24

const ROLE_TARGET_CELL = {
  pallet_c1:   (R, C) => [0, 0],
  pallet_c2:   (R, C) => [0, C - 1],
  pallet_c3:   (R, C) => [R - 1, 0],
  pallet_part: (R, C) => [0, 0],
}

const ROLE_TITLE = {
  pallet_c1:   '① Corner at slot [1,1]',
  pallet_c2:   '② Corner at end of row [1,N]',
  pallet_c3:   '③ Corner at end of column [M,1]',
  pallet_part: '④ First part in slot [1,1]',
}

const ROLE_CAPTION = {
  pallet_c1:   'Touch the pallet corner at slot [1,1] — fixture reference.',
  pallet_c2:   'Touch the pallet corner at the far end of the first row.',
  pallet_c3:   'Touch the pallet corner at the far end of the first column.',
  pallet_part: 'Place a real part in slot [1,1] and teach the tool contact.',
}

// Map palletFrameStatus() booleans to per-corner "taught" state so
// the SVG can render solid green dots on already-recorded points.
function taughtMapFor(frameStatus) {
  if (!frameStatus) {
    return { pallet_c1: false, pallet_c2: false, pallet_c3: false, pallet_part: false }
  }
  return {
    pallet_c1:   !!frameStatus.corner1,
    pallet_c2:   !!frameStatus.corner2,
    pallet_c3:   !!frameStatus.corner3,
    pallet_part: !!frameStatus.part,
  }
}

export default function PalletFrameDiagram({
  role,
  rows,
  cols,
  fillOrder,
  frameStatus,
  size = 'small',
  onRoleTap,
  mode,
}) {
  // Tap-navigation makes the point markers a natural affordance:
  // tap a taught-green dot to jump to that role in re-teach; tap
  // a hollow untaught dot to jump forward. Tapping the CURRENT
  // point is a no-op (handled by the caller).
  const tappable = typeof onRoleTap === 'function'
  const isReTeach = mode === 're-teach'
  // The wrapping <g> gets a stable data-testid + cursor:pointer.
  const wrapTap = (key, node) => tappable ? (
    <g
      data-testid={`pallet-diagram-tap-${key}`}
      style={{ cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); onRoleTap(key) }}
    >
      {node}
    </g>
  ) : node
  const R = Math.max(1, Math.min(20, rows || 4))
  const C = Math.max(1, Math.min(20, cols || 4))
  const cell = size === 'large' ? CELL_LG : CELL_SM
  const pad  = size === 'large' ? PAD_LG  : PAD_SM
  const width  = pad * 2 + C * cell
  const height = pad * 2 + R * cell
  const cellCenter = (r, c) => [pad + c * cell + cell / 2,
                                pad + r * cell + cell / 2]
  const [c1x, c1y] = [pad, pad]
  const [c2x, c2y] = [pad + C * cell, pad]
  const [c3x, c3y] = [pad, pad + R * cell]
  const [partCX, partCY] = cellCenter(0, 0)
  const targetFn = ROLE_TARGET_CELL[role]
  const highlightCell = targetFn ? targetFn(R, C) : null

  const taught = taughtMapFor(frameStatus)

  // Dot: solid green if already taught; blue with pulse if current
  // target; hollow grey if upcoming/untaught. Ring size scales with
  // diagram size so it stays legible at arm's length in the teach
  // overlay.
  const dotR = size === 'large' ? 9 : 6
  const cornerDot = (cx, cy, key) => {
    const isActive = role === key
    const isTaught = taught[key]
    // Active + re-teach: the operator revisited an already-taught
    // corner. Show a green dot (still taught, pose kept) inside a
    // pulsing blue RING — the ring signals "you're re-teaching
    // here", and the green core says "the existing pose is still
    // recorded; Record overwrites it". Distinct from a fresh
    // teach (pulsing blue solid) so the operator can tell whether
    // backing up put them in overwrite territory.
    if (isActive && isReTeach && isTaught) {
      const rCore = dotR
      const rRing = dotR + 4
      const node = (
        <g key={`dot-${key}`}
           data-testid={`pallet-diagram-target-${key}`}
           data-mode="re-teach">
          <circle cx={cx} cy={cy} r={rRing}
            fill="none" stroke="#2563EB" strokeWidth={2}>
            <animate attributeName="r"
              values={`${rRing};${rRing + 3};${rRing}`}
              dur="1.2s" repeatCount="indefinite" />
            <animate attributeName="opacity"
              values="0.9;0.3;0.9"
              dur="1.2s" repeatCount="indefinite" />
          </circle>
          <circle cx={cx} cy={cy} r={rCore}
            fill="#16A34A" stroke="#065f46" strokeWidth={1.5} />
        </g>
      )
      return wrapTap(key, node)
    }
    if (isActive) {
      const rAct = dotR + 2
      const node = (
        <circle key={`dot-${key}`}
          data-testid={`pallet-diagram-target-${key}`}
          data-mode="teach"
          cx={cx} cy={cy} r={rAct}
          fill="#2563EB" stroke="#1e3a8a" strokeWidth={2}>
          <animate attributeName="r"
            values={`${rAct};${rAct + 3};${rAct}`}
            dur="1.2s" repeatCount="indefinite" />
        </circle>
      )
      return wrapTap(key, node)
    }
    if (isTaught) {
      const node = (
        <circle key={`dot-${key}`}
          data-testid={`pallet-diagram-taught-${key}`}
          cx={cx} cy={cy} r={dotR}
          fill="#16A34A" stroke="#065f46" strokeWidth={1.5} />
      )
      return wrapTap(key, node)
    }
    const node = (
      <circle key={`dot-${key}`}
        data-testid={`pallet-diagram-untaught-${key}`}
        cx={cx} cy={cy} r={dotR}
        fill="#ffffff" stroke="#94a3b8" strokeWidth={1.5} />
    )
    return wrapTap(key, node)
  }

  const arrowColor = '#2563EB'
  const gray       = '#94a3b8'
  // Font size scales up in the large layout so labels remain
  // readable from arm's length.
  const fs = size === 'large' ? 14 : 11
  const axisFs = size === 'large' ? 12 : 10

  return (
    <div
      data-testid="pallet-frame-diagram"
      data-role={role || ''}
      data-size={size}
      style={{
        padding: size === 'large' ? 14 : 10,
        background: '#f8fafc', border: '1px solid #e5e7eb',
        borderRadius: 8,
        display: 'flex',
        flexDirection: size === 'large' ? 'column' : 'row',
        gap: size === 'large' ? 10 : 14,
        alignItems: size === 'large' ? 'stretch' : 'center',
        minWidth: size === 'large' ? 260 : undefined,
      }}>
      {/* ROW → axis label above the grid (matches wizard fill-order arrows) */}
      {size === 'large' && (
        <div style={{
          fontSize: axisFs, fontWeight: 700, color: '#0f766e',
          textAlign: 'center', letterSpacing: 0.5,
        }}>
          ROW →
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        {/* COL ↓ axis label to the left of the grid */}
        {size === 'large' && (
          <div style={{
            fontSize: axisFs, fontWeight: 700, color: '#0f766e',
            writingMode: 'vertical-rl', transform: 'rotate(180deg)',
            textAlign: 'center', letterSpacing: 0.5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            COL ↓
          </div>
        )}
        <svg width={width} height={height} style={{ flexShrink: 0 }}>
          {/* Grid cells */}
          {Array.from({ length: R }).map((_, ri) =>
            Array.from({ length: C }).map((_, ci) => {
              const isTarget = highlightCell
                && highlightCell[0] === ri && highlightCell[1] === ci
              return (
                <rect key={`${ri}-${ci}`}
                  x={pad + ci * cell} y={pad + ri * cell}
                  width={cell - 2} height={cell - 2} rx={3}
                  fill={isTarget ? '#dbeafe' : '#ffffff'}
                  stroke={isTarget ? '#2563EB' : '#e5e7eb'}
                  strokeWidth={isTarget ? 2 : 1}>
                  {isTarget && role !== 'pallet_part' && (
                    <animate attributeName="opacity"
                      values="1;0.65;1" dur="1.2s"
                      repeatCount="indefinite" />
                  )}
                </rect>
              )
            })
          )}
          {/* Corner markers — dots at pallet fixture corners */}
          {cornerDot(c1x, c1y, 'pallet_c1')}
          {cornerDot(c2x, c2y, 'pallet_c2')}
          {cornerDot(c3x, c3y, 'pallet_c3')}
          {/* Corner labels */}
          <text x={c1x - 8} y={c1y - 8} fontSize={fs} fontWeight={700}
            fill={role === 'pallet_c1' ? '#1e3a8a' : gray}
            textAnchor="end">①</text>
          <text x={c2x + 8} y={c2y - 8} fontSize={fs} fontWeight={700}
            fill={role === 'pallet_c2' ? '#1e3a8a' : gray}>②</text>
          <text x={c3x - 8} y={c3y + 12} fontSize={fs} fontWeight={700}
            fill={role === 'pallet_c3' ? '#1e3a8a' : gray}
            textAnchor="end">③</text>
          {/* Directional arrows on the outside of the grid */}
          {role === 'pallet_c2' && (
            <line x1={c1x} y1={c1y - 14} x2={c2x} y2={c2y - 14}
              stroke={arrowColor} strokeWidth={2} markerEnd="url(#arrp)" />
          )}
          {role === 'pallet_c3' && (
            <line x1={c1x - 14} y1={c1y} x2={c3x - 14} y2={c3y}
              stroke={arrowColor} strokeWidth={2} markerEnd="url(#arrp)" />
          )}
          {/* Part-position ④ — three visual states in cell [0,0]:
              * active fresh teach → yellow part icon (pulsing)
              * active re-teach    → green core + pulsing blue ring
              * not active         → small green (taught) or hollow (untaught) dot
              Always tappable when onRoleTap is provided. */}
          {(() => {
            const key = 'pallet_part'
            const isActive = role === key
            const isTaught = taught[key]
            let node
            if (isActive && isReTeach && isTaught) {
              const rCore = dotR
              const rRing = dotR + 4
              node = (
                <g data-testid="pallet-diagram-target-pallet_part"
                   data-mode="re-teach">
                  <circle cx={partCX} cy={partCY} r={rRing}
                    fill="none" stroke="#2563EB" strokeWidth={2}>
                    <animate attributeName="r"
                      values={`${rRing};${rRing + 3};${rRing}`}
                      dur="1.2s" repeatCount="indefinite" />
                    <animate attributeName="opacity"
                      values="0.9;0.3;0.9"
                      dur="1.2s" repeatCount="indefinite" />
                  </circle>
                  <circle cx={partCX} cy={partCY} r={rCore}
                    fill="#16A34A" stroke="#065f46" strokeWidth={1.5} />
                  <text x={partCX} y={partCY + 4} fontSize={fs} fontWeight={700}
                    fill="#065f46" textAnchor="middle">④</text>
                </g>
              )
            } else if (isActive) {
              node = (
                <g data-testid="pallet-diagram-target-pallet_part"
                   data-mode="teach">
                  <circle cx={partCX} cy={partCY} r={cell / 2 - 5}
                    fill="#fde68a" stroke="#b45309" strokeWidth={2}>
                    <animate attributeName="opacity"
                      values="1;0.7;1" dur="1.2s"
                      repeatCount="indefinite" />
                  </circle>
                  <text x={partCX} y={partCY + 4} fontSize={fs} fontWeight={700}
                    fill="#7c2d12" textAnchor="middle">④</text>
                </g>
              )
            } else if (isTaught) {
              node = (
                <g data-testid="pallet-diagram-taught-pallet_part">
                  <circle cx={partCX} cy={partCY} r={dotR}
                    fill="#16A34A" stroke="#065f46" strokeWidth={1.5} />
                </g>
              )
            } else {
              node = (
                <g data-testid="pallet-diagram-untaught-pallet_part">
                  <circle cx={partCX} cy={partCY} r={dotR}
                    fill="#ffffff" stroke="#94a3b8" strokeWidth={1.5} />
                </g>
              )
            }
            return wrapTap(key, node)
          })()}
          {/* Arrow marker def */}
          <defs>
            <marker id="arrp" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill={arrowColor} />
            </marker>
          </defs>
        </svg>
      </div>
      <div style={{
        fontSize: size === 'large' ? 14 : 12,
        color: '#374151', lineHeight: 1.5,
        flex: size === 'large' ? '0 0 auto' : 1,
      }}>
        <div style={{
          fontWeight: 700, marginBottom: 4, color: '#111827',
        }}>
          {ROLE_TITLE[role] || ''}
        </div>
        <div data-testid="pallet-diagram-caption">
          {ROLE_CAPTION[role] || ''}
        </div>
        {fillOrder && (
          <div style={{
            fontSize: size === 'large' ? 11 : 10,
            color: '#6b7280', marginTop: 6,
          }}>
            Fill order: {fillOrder}
          </div>
        )}
      </div>
    </div>
  )
}

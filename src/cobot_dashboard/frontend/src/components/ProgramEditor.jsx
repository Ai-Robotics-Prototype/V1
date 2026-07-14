import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import ProgramWizard from './ProgramWizard'
import ProgramFromDemonstration from './ProgramFromDemonstration'

// The richer action taxonomy lives in the editor. Each action carries
// a coarse `type` (matching the existing backend schema: move/gripper/
// home/wait/etc.) so legacy consumers keep working, plus a list of
// typed parameter fields the editor knows how to render.
const ACTION_TYPES = [
  { value: 'move_home',          label: 'Move to Home',     type: 'home',    tag: 'HOME',    fields: [] },
  { value: 'open_gripper',       label: 'Open Gripper',     type: 'gripper', tag: 'GRIPPER', fields: ['width_mm', 'speed_pct', 'io_open', 'io_open_confirm'] },
  { value: 'close_gripper',      label: 'Close Gripper',    type: 'gripper', tag: 'GRIPPER', fields: ['force_pct', 'io_close', 'io_close_confirm'] },
  { value: 'move_joint',         label: 'Move Joint',       type: 'move',    tag: 'MOVE',    fields: ['joints'] },
  { value: 'move_linear',        label: 'Move Linear',      type: 'move',    tag: 'MOVE',    fields: ['position', 'offset_z_mm', 'speed_pct'] },
  { value: 'approach',           label: 'Approach Object',  type: 'move',    tag: 'MOVE',    fields: ['target', 'offset_z_mm'] },
  { value: 'pick',               label: 'Pick and Close',   type: 'gripper', tag: 'PICK',    fields: ['descend_mm'] },
  { value: 'place',              label: 'Place at Target',  type: 'move',    tag: 'PLACE',   fields: ['position'] },
  { value: 'wait',               label: 'Wait',             type: 'wait',    tag: 'WAIT',    fields: ['duration_s'] },
  { value: 'detect',             label: 'Detect Objects',   type: 'move',    tag: 'DETECT',  fields: ['target_part'] },
  { value: 'loop',               label: 'Loop',             type: 'move',    tag: 'LOOP',    fields: ['goto', 'count'] },
  { value: 'set_io',             label: 'Set I/O',          type: 'move',    tag: 'IO',      fields: ['io_id', 'value'] },
  { value: 'scan_workspace',     label: 'Scan Workspace',   type: 'move',    tag: 'SCAN',    fields: ['scan_height_mm', 'scan_speed_pct'] },
  { value: 'scan_identify_each', label: 'Identify Each',    type: 'move',    tag: 'SCAN',    fields: ['scan_height_mm', 'scan_speed_pct', 'settle_time_ms', 'capture_frames', 'match_threshold_pct'] },
  { value: 'sort_scanned',       label: 'Sort Scanned',     type: 'move',    tag: 'SCAN',    fields: [] },
  { value: 'remove_defects',     label: 'Remove Defects',   type: 'move',    tag: 'SCAN',    fields: [] },
  // Pallet operations — slot positions are computed at runtime from
  // the program's pallet config, so move_to_pallet has no manually-
  // editable fields. The editor shows a greyed Edit button for it.
  { value: 'move_to_pallet',     label: 'Move to Pallet',   type: 'move',    tag: 'PALLET',  fields: [] },
]

const TAG_COLORS = {
  HOME: '#6366f1', GRIPPER: '#f59e0b', MOVE: '#2563EB', PICK: '#16A34A',
  PLACE: '#0891b2', WAIT: '#6b7280', DETECT: '#8b5cf6', LOOP: '#ec4899',
  IO: '#f97316', SCAN: '#9333EA', PALLET: '#0f766e',
}

// LoadProgramsPanel — the "Load" dropdown for the Program editor.
// Rendered through a portal to document.body and positioned with
// position:fixed at the button's screen coordinates so the
// toolbar's `overflowY:hidden` doesn't clip it. The previous
// position:absolute + zIndex:21 implementation was both clipped by
// the toolbar AND sat below most other page chrome (modals use
// zIndex ~2000, the teach overlay 1000, etc.) — fixed here with
// zIndex 4000+ which is well above any in-editor surface.
function LoadProgramsPanel({ anchorRect, programs, onSelect, onDismiss }) {
  // Position the dropdown's right edge under the button's right
  // edge (matching the visual it had when it worked). Fall back to
  // a safe top-right corner if the rect was lost between clicks.
  const r = anchorRect
  const PANEL_W = 280
  const top = r ? Math.round(r.bottom + 4)
                : 56
  const left = r ? Math.max(8, Math.round(r.right - PANEL_W))
                 : Math.max(8, (typeof window !== 'undefined' ? window.innerWidth : 1024) - PANEL_W - 16)
  // Cap height to viewport so the dropdown never runs off the
  // bottom on small displays / tablets.
  const maxH = (typeof window !== 'undefined' ? window.innerHeight : 800) - top - 16
  return (
    <>
      {/* Click-outside backdrop. zIndex sits just below the panel and
          above all editor chrome. pointerEvents must NOT be 'none'
          here — we need the backdrop to actually catch outside
          clicks. */}
      <div onClick={onDismiss}
        style={{
          position: 'fixed', inset: 0, zIndex: 4000,
          background: 'transparent',
        }} />
      <div style={{
        position: 'fixed', top, left,
        zIndex: 4001,
        width: PANEL_W, maxHeight: Math.max(120, maxH), overflowY: 'auto',
        background: '#fff', color: '#111',
        border: '1px solid #d1d5db', borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid #e5e7eb',
          fontSize: 11, color: '#6b7280', fontWeight: 600,
        }}>
          Saved Programs
        </div>
        {(!programs || programs.length === 0) ? (
          <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
            No saved programs yet
          </div>
        ) : programs.map((p) => (
          <button key={p.id} onClick={() => onSelect(p.id)}
            style={{
              width: '100%', padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
              background: '#fff', border: 'none', borderBottom: '1px solid #f3f4f6',
              display: 'block',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f9ff' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#fff' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{p.name}</div>
            <div style={{ fontSize: 10, color: '#6b7280' }}>
              {p.steps} step{p.steps === 1 ? '' : 's'}{p.updated ? ' · ' + p.updated : ''}
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

// move_to_pallet steps are config-driven — the executor computes the
// row/col/layer at runtime and there's nothing to edit on the step
// itself. The editor renders a greyed Edit button to make this clear.
function isPalletDriven(step) {
  return step?.action === 'move_to_pallet'
}

// Actions that move the robot to a specific pose. Gripper open/close
// are pure I/O signals — the pose at which they fire is owned by the
// previous move step, so they don't get their own taught position.
const TEACHABLE_ACTIONS = [
  'move_home', 'move_joint', 'move_linear',
  'approach',  'pick',       'place',
]

// A derived offset move (descend / lift / retreat / "approach finished
// part") computes its target at runtime as <source taught_tcp> + Z
// offset; the operator never teaches it directly. Explicit derived_from
// tag is the new shape emitted by the wizard; the offset_z_mm heuristic
// covers older saved programs that were generated before the tag
// existed (their descend/lift had offset_z_mm set and no taught data of
// their own, which uniquely identifies them as wizard-derived).
//
// Override semantics: a derived step can be manually overridden by the
// operator (overridden:true + its own taught_tcp). When overridden, we
// stop treating it as auto-derived so the editor exposes pose inputs
// and the Teach button works on it directly. The executor also reads
// the overridden taught_tcp instead of base+offset (see
// program_executor_node.py _resolve_base_tcp call site).
function isDerivedOffsetMove(step) {
  if (!step) return false
  if (step.overridden) return false
  if (step.derived_from) return true
  const isMoveLinear = step.action === 'move_linear' || step.type === 'move'
  if (!isMoveLinear) return false
  if (step.offset_z_mm === undefined || step.offset_z_mm === null) return false
  const hasJoints = Array.isArray(step.taught_joints) && step.taught_joints.length >= 6
  const hasTcp    = Array.isArray(step.taught_tcp)    && step.taught_tcp.length    >= 3
  return !hasJoints && !hasTcp
}

// True when this step has been derived but the operator manually
// overrode the pose. Used by the editor to badge the row and surface
// the Reset-to-auto control.
function isDerivedOverridden(step) {
  if (!step) return false
  if (!step.overridden) return false
  return step.derived_from != null
}

// True when this step is a source-of-link for derived steps (the
// operator's teach point that descend/lift/retract use as the base).
function isPoseSource(step) {
  if (!step) return false
  if (!step.position_role) return false
  return ['pick', 'place', 'home'].includes(step.position_role)
}

// Resolve the auto-derived pose for a derived step from the surrounding
// step list. Mirrors program_executor_node._resolve_base_tcp on the JS
// side so the editor can show the operator what the runtime will land
// at. Returns a 6-array [x,y,z,rx,ry,rz] in meters/radians, or null if
// the link source isn't taught yet.
function resolveDerivedPose(step, allSteps) {
  if (!step || !Array.isArray(allSteps)) return null
  const derivedFrom = step.derived_from
  const idx = allSteps.findIndex((s) => s === step || s.id === step.id)
  if (idx < 0) return null
  // Walk backward looking for the source.
  for (let i = idx - 1; i >= 0; i--) {
    const src = allSteps[i]
    if (derivedFrom != null) {
      if (src.position_role !== derivedFrom) continue
    }
    const tcp = (Array.isArray(src.taught_tcp) ? src.taught_tcp
                : Array.isArray(src.position)   ? src.position : null)
    if (!tcp || tcp.length < 3) continue
    const offsetMm = Number(step.offset_z_mm) || 0
    // tcp from /api/state is in meters; convert offset mm → m.
    const out = [
      Number(tcp[0]) || 0,
      Number(tcp[1]) || 0,
      (Number(tcp[2]) || 0) + offsetMm / 1000,
      Number(tcp[3]) || 0,
      Number(tcp[4]) || 0,
      Number(tcp[5]) || 0,
    ]
    return out
  }
  return null
}

function isTeachable(step) {
  if (!step) return false
  // Derived offset moves resolve at runtime from their source step's
  // taught pose, so the operator must NOT teach them independently.
  if (isDerivedOffsetMove(step)) return false
  // Prefer the explicit action when set (wizard-emitted or PUT'd via
  // /api/programs). Fall back to deriving an action from the legacy
  // 'type' field (default STATE.program.steps used 'type' only) — but
  // only if 'type' actually matches an ACTION_TYPES entry, so we
  // don't trip a default fallback into "always teachable".
  if (step.action) return TEACHABLE_ACTIONS.includes(step.action)
  if (step.type) {
    const match = ACTION_TYPES.find((a) => a.type === step.type)
    if (match) return TEACHABLE_ACTIONS.includes(match.value)
  }
  return false
}

// /api/state returns joints.positions in radians; the step model
// stores degrees so it round-trips through the editor / JSON files
// in a human-friendly form.
function radiansToJointDegrees(positions) {
  if (!Array.isArray(positions)) return [0, 0, 0, 0, 0, 0]
  return positions.slice(0, 6).map((rad) => Number((rad * 180 / Math.PI).toFixed(2)))
}

function actionFor(step) {
  return ACTION_TYPES.find((a) => a.value === step.action)
      ?? ACTION_TYPES.find((a) => a.type === step.type)
      ?? ACTION_TYPES[0]
}

// Format the always-visible secondary detail line under the label.
// Raw position data (taught_joints, taught_tcp, joints, position) is
// intentionally NOT included here — that lives in the collapsible
// "position data" block triggered by the "View position data" link.
function detailLine(step, ioLabels) {
  const ioName = (id) => (ioLabels && ioLabels[id]) || id
  const bits = [step.action || step.type]
  if (step.target)      bits.push('target: ' + step.target)
  if (step.duration_s)  bits.push(step.duration_s + 's')
  if (step.width_mm)    bits.push(step.width_mm + 'mm')
  if (step.descend_mm)  bits.push('descend ' + step.descend_mm + 'mm')
  // Derived offset moves: show "from <role>, z+Nmm" so the operator can
  // see at a glance that this step is computed at runtime from a taught
  // source — no Teach button, no separate pose to record.
  if (isDerivedOffsetMove(step)) {
    const role = step.derived_from || 'prev'
    const z = step.offset_z_mm ?? 0
    bits.push('from ' + role + ', z' + (z >= 0 ? '+' : '') + z + 'mm')
  } else if (step.offset_z_mm !== undefined) {
    bits.push('z' + (step.offset_z_mm >= 0 ? '+' : '') + step.offset_z_mm + 'mm')
  }
  if (step.speed_pct)   bits.push(step.speed_pct + '%')
  if (step.io_id)       bits.push(ioName(step.io_id) + '=' + (step.value ? 'ON' : 'OFF'))
  if (step.io_open)         bits.push('open→' + ioName(step.io_open))
  if (step.io_open_confirm) bits.push('verify ' + ioName(step.io_open_confirm))
  if (step.io_close)        bits.push('close→' + ioName(step.io_close))
  if (step.io_close_confirm) bits.push('verify ' + ioName(step.io_close_confirm))
  if (step.scan_height_mm)      bits.push('scan@' + step.scan_height_mm + 'mm')
  if (step.scan_speed_pct)      bits.push('scan ' + step.scan_speed_pct + '%')
  if (step.settle_time_ms)      bits.push('settle ' + step.settle_time_ms + 'ms')
  if (step.capture_frames)      bits.push(step.capture_frames + ' frames')
  if (step.match_threshold_pct) bits.push('match≥' + step.match_threshold_pct + '%')
  return bits.join(' | ')
}

// Does this step have anything worth showing in the collapsible
// position-data block? Drives whether the "View position data" link
// is rendered (empty steps don't need a no-op toggle).
function hasPositionData(step) {
  if (!step) return false
  if (Array.isArray(step.taught_joints) && step.taught_joints.length) return true
  if (Array.isArray(step.taught_tcp)    && step.taught_tcp.length)    return true
  if (Array.isArray(step.joints)        && step.joints.length)        return true
  if (Array.isArray(step.position)      && step.position.length)      return true
  if (step.taught_at)                                                  return true
  return false
}

// Compact monospace lines for the position-data drawer.
function positionDataLines(step) {
  const out = []
  const tj = Array.isArray(step.taught_joints) ? step.taught_joints
            : Array.isArray(step.joints)        ? step.joints : null
  const tt = Array.isArray(step.taught_tcp)    ? step.taught_tcp
            : Array.isArray(step.position)      ? step.position : null
  if (tj) {
    out.push('joints: ' + tj.slice(0, 6).map((v, i) => `J${i + 1}:${Number(v).toFixed(2)}`).join('  '))
  }
  if (tt) {
    const keys = ['x', 'y', 'z', 'rx', 'ry', 'rz']
    out.push('tcp:    ' + tt.slice(0, 6).map((v, i) => `${keys[i]}:${Number(v).toFixed(3)}`).join('  '))
  }
  if (step.taught_at) out.push('taught_at: ' + step.taught_at)
  return out
}

// Shared label fetch — one round-trip per editor mount instead of one
// per IOPortSelector instance. Backend now always returns factory
// defaults merged with operator overrides so `labels[id]` is defined
// for every port.
function useIOLabels() {
  const [labels, setLabels] = useState({})
  useEffect(() => {
    let alive = true
    fetch('/api/io/config')
      .then((r) => r.json())
      .then((d) => { if (alive && d) setLabels(d.labels || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return labels
}

// Dropdown that lists DO* or DI* ports with their pin numbers and the
// operator-renamed labels from /api/io/config. Renders an "unassigned"
// option at the top so a step can opt out of I/O explicitly.
function IOPortSelector({ label, value, onChange, direction }) {
  const [labels, setLabels] = useState({})

  useEffect(() => {
    let alive = true
    fetch('/api/io/config')
      .then((r) => r.json())
      .then((d) => { if (alive && d) setLabels(d.labels || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const ports = Array.from({ length: 16 }, (_, i) => {
    const id  = (direction === 'output' ? 'DO' : 'DI') + i
    const pin = (direction === 'output' ? 'Y' : 'X') + Math.floor(i / 8) + '.' + (i % 8)
    return { id, pin, label: labels[id] || id }
  })

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{label}</div>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}
        style={{ ...selectStyle }}>
        <option value="">Not assigned</option>
        {ports.map((p) => (
          <option key={p.id} value={p.id}>{p.pin} — {p.label}</option>
        ))}
      </select>
    </div>
  )
}

// Pull the live robot pose from /api/state and shape it into the
// {x,y,z,rx,ry,rz} TCP object the saved program stores.
async function fetchTcpFromState() {
  try {
    const res = await fetch('/api/state')
    if (!res.ok) return null
    const state = await res.json()
    const tcp = Array.isArray(state?.tcp_pose) ? state.tcp_pose : null
    if (!tcp || tcp.length < 6) return null
    return { x: tcp[0], y: tcp[1], z: tcp[2], rx: tcp[3], ry: tcp[4], rz: tcp[5] }
  } catch {
    return null
  }
}

// Rebuild the move_to_pallet step list when pallet config changes. This
// is a focused port of buildPalletizeSteps from ProgramWizard.jsx — we
// only regenerate the inside-loop move_to_pallet step + the loop count;
// the surrounding home / approach / pick / place skeleton is preserved
// from the existing program so taught poses don't get clobbered.
//
// Returns the new steps array (renumbered downstream by the caller).
function regenerateMoveToPalletSteps(steps, palletCfg, palletMode) {
  if (!Array.isArray(steps)) return steps
  const rows   = Number(palletCfg?.rows   ?? 4)
  const cols   = Number(palletCfg?.cols   ?? 4)
  const layers = Number(palletCfg?.layers ?? 1)
  const cycles = Math.max(1, rows * cols * layers)
  const mode   = palletMode === 'depalletize' ? 'depalletize' : 'palletize'
  return steps.map((s) => {
    if (s?.action === 'move_to_pallet') {
      return { ...s, mode, pallet_phase: mode === 'palletize' ? 'place' : 'pick' }
    }
    if (s?.action === 'loop' && s.pallet_loop) {
      return {
        ...s,
        goto: s.goto || 2,
        count: cycles,
        label: `Pallet loop — ${cycles} cycles (${rows} × ${cols} × ${layers})`,
      }
    }
    return s
  })
}

// PalletCornerIcon — compact top-down preview of the pallet grid for
// each taught-position row. Renders rows × cols as cells, highlights
// the cell the taught pose corresponds to (origin corner / pick corner
// / place start), shows a robot marker on the operator-facing side,
// and a small arrow conveying fill_order direction from the reference
// corner. Renders SVG so it stays crisp at the 36 px size used in the
// rows. Honest about precision: the robot-vs-pallet geometry isn't a
// measured transform — we use the convention "robot sits in front of
// the pallet" and label the row as such, so the icon is an orientation
// aid, not a transformed render.
function PalletCornerIcon({ rows = 4, cols = 4, role = 'corner',
                             mode = 'palletize', fillOrder = 'row_lr',
                             size = 36 }) {
  const R = Math.max(1, Math.min(20, Number(rows) || 1))
  const C = Math.max(1, Math.min(20, Number(cols) || 1))
  // External glyph for the role that doesn't map to a pallet corner
  // (pick in palletize mode → camera/source; place in depalletize
  // mode → external destination). Keeps the row meaningful instead of
  // forcing a grid where there isn't one.
  const externalRole =
    (mode === 'palletize'   && role === 'pick')  ? 'source' :
    (mode === 'depalletize' && role === 'place') ? 'sink'   : null
  // Pallet-corner roles all reference the [1,1] corner — corner_tcp
  // IS that corner; pick in depalletize starts at [1,1,top]; place
  // in palletize starts at [1,1,1]. So one consistent highlight cell.
  const origin = { row: 0, col: 0 }
  // SVG layout: leave a strip at the bottom for the robot marker so
  // it's clearly OUTSIDE the grid (robot-side convention).
  const pad = 3
  const robotStripH = 8
  const gridW = size - pad * 2
  const gridH = size - pad * 2 - robotStripH
  const cellW = gridW / C
  const cellH = gridH / R
  const x0 = pad
  const y0 = pad
  const stroke = '#475569'

  if (externalRole) {
    // Camera-feed glyph for "source" (palletize pick) and a target
    // glyph for "sink" (depalletize place). Both share the same robot
    // marker so the rows stay visually consistent.
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
           style={{ flexShrink: 0 }}>
        <rect x={pad} y={pad} width={size - pad * 2}
              height={gridH} rx={3} ry={3}
              fill="#f1f5f9" stroke={stroke} strokeWidth={1} />
        {externalRole === 'source' ? (
          <>
            <rect x={pad + 5} y={pad + 6}
                  width={size - pad * 2 - 10} height={gridH - 12}
                  rx={1.5} ry={1.5}
                  fill="#fff" stroke="#0f766e" strokeWidth={1.2} />
            <circle cx={size / 2} cy={pad + gridH / 2 - 1} r={2.6}
                    fill="#0f766e" />
            <text x={size / 2} y={pad + gridH - 2}
                  textAnchor="middle" fontSize={6}
                  fill="#0f766e" fontWeight={700}
                  fontFamily="ui-monospace, monospace">FEED</text>
          </>
        ) : (
          <>
            <circle cx={size / 2} cy={pad + gridH / 2} r={gridH / 2 - 4}
                    fill="none" stroke="#0f766e" strokeWidth={1.2} />
            <circle cx={size / 2} cy={pad + gridH / 2} r={2.6}
                    fill="#0f766e" />
            <text x={size / 2} y={pad + gridH - 2}
                  textAnchor="middle" fontSize={6}
                  fill="#0f766e" fontWeight={700}
                  fontFamily="ui-monospace, monospace">OUT</text>
          </>
        )}
        {/* Robot marker — same convention as the grid icon. */}
        <rect x={size / 2 - 5} y={size - pad - robotStripH + 1}
              width={10} height={robotStripH - 2} rx={2}
              fill="#1e293b" />
        <text x={size / 2} y={size - pad - 1.5}
              textAnchor="middle" fontSize={5.5}
              fill="#fff" fontWeight={700}
              fontFamily="ui-monospace, monospace">R</text>
      </svg>
    )
  }

  // Build the cell grid with the origin corner highlighted.
  const cells = []
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const isOrigin = (r === origin.row && c === origin.col)
      cells.push(
        <rect key={`${r}-${c}`}
              x={x0 + c * cellW + 0.5}
              y={y0 + r * cellH + 0.5}
              width={cellW - 1}
              height={cellH - 1}
              fill={isOrigin ? '#2563EB' : '#fff'}
              stroke={stroke} strokeWidth={0.75} rx={0.6} />
      )
    }
  }

  // Fill-direction arrow from the [1,1] cell. Per the executor's
  // semantics: row_lr → → ; row_rl → ← (still starts at [1,1] but
  // walks right-to-left along the row, which we depict as an arrow
  // *into* [1,1] from the right); col → ↓ ; snake → ⤵ (right then
  // down).
  const cx = x0 + cellW / 2
  const cy = y0 + cellH / 2
  let arrow = null
  const arrColor = '#dc2626'
  const sw = 1.4
  if (fillOrder === 'row_lr') {
    const x2 = x0 + Math.min(C, 2) * cellW - cellW / 3
    arrow = (
      <g stroke={arrColor} strokeWidth={sw} fill="none" strokeLinecap="round">
        <line x1={cx} y1={cy} x2={x2} y2={cy} />
        <polyline points={`${x2 - 2},${cy - 2} ${x2},${cy} ${x2 - 2},${cy + 2}`} />
      </g>
    )
  } else if (fillOrder === 'row_rl') {
    // arrow walks from the inside *toward* the highlighted [1,1] cell
    // to indicate "this corner is the start, fill direction is RTL".
    const xs = x0 + Math.min(C, 2) * cellW - cellW / 3
    arrow = (
      <g stroke={arrColor} strokeWidth={sw} fill="none" strokeLinecap="round">
        <line x1={xs} y1={cy} x2={cx} y2={cy} />
        <polyline points={`${cx + 2},${cy - 2} ${cx},${cy} ${cx + 2},${cy + 2}`} />
      </g>
    )
  } else if (fillOrder === 'col') {
    const y2 = y0 + Math.min(R, 2) * cellH - cellH / 3
    arrow = (
      <g stroke={arrColor} strokeWidth={sw} fill="none" strokeLinecap="round">
        <line x1={cx} y1={cy} x2={cx} y2={y2} />
        <polyline points={`${cx - 2},${y2 - 2} ${cx},${y2} ${cx + 2},${y2 - 2}`} />
      </g>
    )
  } else if (fillOrder === 'snake') {
    // Row right + down + row left — fits in the first two rows.
    const xMid = x0 + Math.min(C, 2) * cellW - cellW / 3
    const yMid = y0 + Math.min(R, 2) * cellH - cellH / 2
    const xEnd = x0 + cellW / 2
    arrow = (
      <g stroke={arrColor} strokeWidth={sw} fill="none" strokeLinecap="round">
        <polyline points={`${cx},${cy} ${xMid},${cy} ${xMid},${yMid} ${xEnd},${yMid}`} />
        <polyline points={`${xEnd + 2},${yMid - 2} ${xEnd},${yMid} ${xEnd + 2},${yMid + 2}`} />
      </g>
    )
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
         style={{ flexShrink: 0 }}>
      {cells}
      {arrow}
      {/* Robot marker — placed below the grid, by convention, since
          we don't have a measured pallet-vs-base transform. The
          row's title text ("relative to robot · front") names the
          convention so the icon isn't ambiguous. */}
      <rect x={size / 2 - 5} y={size - pad - robotStripH + 1}
            width={10} height={robotStripH - 2} rx={2}
            fill="#1e293b" />
      <text x={size / 2} y={size - pad - 1.5}
            textAnchor="middle" fontSize={5.5}
            fill="#fff" fontWeight={700}
            fontFamily="ui-monospace, monospace">R</text>
    </svg>
  )
}

// PalletConfigEditor — modal for editing the program-level pallet
// block (rows/cols/layers/spacing/fill order/heights + taught
// corner TCP + taught pick/place TCP). Pre-fills from the program's
// existing config; "Use current pose" buttons re-record TCPs from the
// live robot. Save writes back through onSave; the parent regenerates
// the steps + PUT's the program.
function PalletConfigEditor({ config, onSave, onClose }) {
  const initialMode = config?.pallet_mode === 'depalletize' ? 'depalletize' : 'palletize'
  const initialPallet = (config?.pallet && typeof config.pallet === 'object') ? config.pallet : {}
  const [mode,       setMode]       = useState(initialMode)
  const [rows,       setRows]       = useState(Number(initialPallet.rows   ?? 4))
  const [cols,       setCols]       = useState(Number(initialPallet.cols   ?? 4))
  const [layers,     setLayers]     = useState(Number(initialPallet.layers ?? 1))
  const [spacingX,   setSpacingX]   = useState(Number(initialPallet.spacing_x_mm   ?? 150))
  const [spacingY,   setSpacingY]   = useState(Number(initialPallet.spacing_y_mm   ?? 150))
  const [layerH,     setLayerH]     = useState(Number(initialPallet.layer_height_mm ?? 100))
  const [fillOrder,  setFillOrder]  = useState(initialPallet.fill_order || 'row_lr')
  const [approachH,  setApproachH]  = useState(Number(initialPallet.approach_height_mm ?? config?.pallet_approach_height_mm ?? 100))
  const [retractH,   setRetractH]   = useState(Number(initialPallet.retract_height_mm  ?? config?.pallet_retract_height_mm  ?? 200))
  const [speed,      setSpeed]      = useState(Number(config?.speed_pct ?? config?.speed ?? 60))
  const [cornerTcp,  setCornerTcp]  = useState(initialPallet.corner_tcp || null)
  const [pickTcp,    setPickTcp]    = useState(config?.pick_tcp || null)
  const [placeTcp,   setPlaceTcp]   = useState(config?.place_tcp || null)
  const [busy,       setBusy]       = useState(null)
  const [error,      setError]      = useState(null)

  const cycles = Math.max(1, rows * cols * layers)
  const isDepal = mode === 'depalletize'

  async function captureTcp(role) {
    setBusy(role)
    setError(null)
    try {
      const tcp = await fetchTcpFromState()
      if (!tcp) {
        setError('Could not read TCP from robot. Is the driver connected?')
        return
      }
      if (role === 'corner') setCornerTcp(tcp)
      else if (role === 'pick') setPickTcp(tcp)
      else if (role === 'place') setPlaceTcp(tcp)
    } finally {
      setBusy(null)
    }
  }

  function commit() {
    const pallet = {
      rows: Number(rows) || 1,
      cols: Number(cols) || 1,
      layers: Number(layers) || 1,
      spacing_x_mm: Number(spacingX) || 0,
      spacing_y_mm: Number(spacingY) || 0,
      layer_height_mm: Number(layerH) || 0,
      fill_order: fillOrder || 'row_lr',
      corner_tcp: cornerTcp || { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      approach_height_mm: Number(approachH) || 0,
      retract_height_mm:  Number(retractH)  || 0,
    }
    onSave({
      pallet,
      pallet_mode: mode,
      source: mode === 'palletize' ? 'camera_library' : 'fixed_grid',
      speed_pct: Number(speed) || 60,
      pick_tcp:  pickTcp  || undefined,
      place_tcp: placeTcp || undefined,
    })
    onClose()
  }

  const fillOptions = [
    { value: 'row_lr', label: 'Rows (left → right)' },
    { value: 'row_rl', label: 'Rows (right → left)' },
    { value: 'col',    label: 'Columns (front → back)' },
    { value: 'snake',  label: 'Snake (alternate)' },
  ]

  // Hover-title that describes what the icon is showing — useful when
  // the convention ("robot at front") isn't obvious from the row label.
  const iconTitle = (role) => {
    if (mode === 'palletize' && role === 'pick')
      return 'Pick source (camera feed) · robot R at front'
    if (mode === 'depalletize' && role === 'place')
      return 'Place destination (external) · robot R at front'
    const cell = (mode === 'depalletize' && role === 'pick')
      ? '[1,1, top layer]' : '[1,1]'
    return `Reference corner ${cell} · fill order ${fillOrder} · robot R at front (convention)`
  }

  const tcpRow = (label, tcp, role) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', marginBottom: 6,
      background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6,
    }}>
      <div title={iconTitle(role)} style={{ flexShrink: 0, lineHeight: 0 }}>
        <PalletCornerIcon rows={rows} cols={cols}
          role={role} mode={mode} fillOrder={fillOrder} size={36} />
      </div>
      <div style={{ minWidth: 110, fontSize: 11, fontWeight: 600, color: '#374151' }}>{label}</div>
      <div style={{ flex: 1, fontSize: 11, color: tcp ? '#111' : '#9ca3af', fontFamily: 'var(--font-mono, monospace)' }}>
        {tcp
          ? `x=${(+tcp.x).toFixed(1)} y=${(+tcp.y).toFixed(1)} z=${(+tcp.z).toFixed(1)}  rx=${(+tcp.rx).toFixed(2)} ry=${(+tcp.ry).toFixed(2)} rz=${(+tcp.rz).toFixed(2)}`
          : '— not taught'}
      </div>
      <button onClick={() => captureTcp(role)} disabled={busy === role}
        style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600,
                 background: '#eff6ff', color: '#2563EB',
                 border: '1px solid #bfdbfe', borderRadius: 4,
                 cursor: busy === role ? 'wait' : 'pointer' }}>
        {busy === role ? '...' : 'Use current pose'}
      </button>
    </div>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1200,
    }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, width: 'min(560px, 92vw)',
          maxHeight: '90vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 48px rgba(0,0,0,0.18)',
        }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#0f766e',
            background: '#ccfbf1', padding: '2px 8px', borderRadius: 4,
            letterSpacing: 0.5,
          }}>PALLET</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>
            Edit pallet configuration
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose}
            style={{ padding: '4px 10px', fontSize: 11, background: '#f3f4f6',
                     color: '#6b7280', border: '1px solid #d1d5db',
                     borderRadius: 4, cursor: 'pointer' }}>Cancel</button>
          <button onClick={commit}
            style={{ padding: '4px 14px', fontSize: 11, fontWeight: 600,
                     background: '#2563EB', color: '#fff', border: 'none',
                     borderRadius: 4, cursor: 'pointer' }}>Save</button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto' }}>
          <Field label="Mode">
            <div style={{ display: 'flex', gap: 6 }}>
              {['palletize', 'depalletize'].map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  style={{
                    flex: 1, padding: '8px 12px', fontSize: 12, fontWeight: 600,
                    background: mode === m ? '#eff6ff' : '#fff',
                    color: mode === m ? '#2563EB' : '#374151',
                    border: mode === m ? '2px solid #2563EB' : '1px solid #d1d5db',
                    borderRadius: 5, cursor: 'pointer',
                  }}>
                  {m === 'palletize' ? 'PALLETIZE' : 'DEPALLETIZE'}
                </button>
              ))}
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="Rows">
              <input type="number" min={1} max={20} value={rows}
                onChange={(e) => setRows(parseInt(e.target.value, 10) || 1)} style={inputStyle} />
            </Field>
            <Field label="Cols">
              <input type="number" min={1} max={20} value={cols}
                onChange={(e) => setCols(parseInt(e.target.value, 10) || 1)} style={inputStyle} />
            </Field>
            <Field label="Layers">
              <input type="number" min={1} max={10} value={layers}
                onChange={(e) => setLayers(parseInt(e.target.value, 10) || 1)} style={inputStyle} />
            </Field>
          </div>
          <div style={{ marginBottom: 6, fontSize: 11, color: '#0f766e', fontWeight: 600 }}>
            Total slots: {cycles}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="Spacing X (mm)">
              <input type="number" min={0} value={spacingX}
                onChange={(e) => setSpacingX(parseInt(e.target.value, 10) || 0)} style={inputStyle} />
            </Field>
            <Field label="Spacing Y (mm)">
              <input type="number" min={0} value={spacingY}
                onChange={(e) => setSpacingY(parseInt(e.target.value, 10) || 0)} style={inputStyle} />
            </Field>
            <Field label="Layer height (mm)">
              <input type="number" min={0} value={layerH}
                onChange={(e) => setLayerH(parseInt(e.target.value, 10) || 0)} style={inputStyle} />
            </Field>
          </div>

          <Field label="Fill order">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {fillOptions.map((o) => (
                <button key={o.value} onClick={() => setFillOrder(o.value)}
                  style={{
                    padding: '6px 10px', fontSize: 11, fontWeight: 600,
                    background: fillOrder === o.value ? '#eff6ff' : '#fff',
                    color:      fillOrder === o.value ? '#2563EB' : '#374151',
                    border:     fillOrder === o.value ? '2px solid #2563EB' : '1px solid #d1d5db',
                    borderRadius: 4, cursor: 'pointer',
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="Approach height (mm)">
              <input type="number" min={0} value={approachH}
                onChange={(e) => setApproachH(parseInt(e.target.value, 10) || 0)} style={inputStyle} />
            </Field>
            <Field label="Retract height (mm)">
              <input type="number" min={0} value={retractH}
                onChange={(e) => setRetractH(parseInt(e.target.value, 10) || 0)} style={inputStyle} />
            </Field>
            <Field label="Speed (%)">
              <input type="number" min={1} max={100} value={speed}
                onChange={(e) => setSpeed(parseInt(e.target.value, 10) || 60)} style={inputStyle} />
            </Field>
          </div>

          <div style={{ marginTop: 8, marginBottom: 8, fontSize: 11, fontWeight: 700, color: '#374151' }}>
            Taught positions
          </div>
          {tcpRow(
            isDepal ? 'Corner [1,1,top]' : 'Corner [1,1,1]',
            cornerTcp, 'corner',
          )}
          {isDepal
            ? tcpRow('Place TCP', placeTcp, 'place')
            : tcpRow('Pick TCP',  pickTcp,  'pick')}

          {error && (
            <div style={{ marginTop: 8, padding: '6px 10px', fontSize: 11,
              background: '#fef2f2', color: '#DC2626',
              border: '1px solid #fecaca', borderRadius: 4 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StepEditor({ step, allSteps, onSave, onClose }) {
  // Sanity probe: if "Edit on one step opens all" ever happens again,
  // the DevTools console will show one [StepEditor] line per render.
  // More than one per Edit click means the parent is mounting the
  // editor inside a non-conditional branch.
  console.log('[StepEditor] render id=' + step?.id + ' action=' + step?.action)
  const [draft, setDraft] = useState({ ...step })
  const actionDef = actionFor(draft)

  // Taught library parts for the detect step's "Detect Part" dropdown.
  // Fetched lazily — only when the editor renders a detect step — and
  // re-fetched whenever the operator returns from teaching a new part
  // (setActiveTab back to 'program' bumps partsReloadKey).
  const setActiveTab = useStore((s) => s.setActiveTab)
  const setPendingTeachNew = useStore((s) => s.setPendingTeachNew)
  const [taughtParts, setTaughtParts] = useState(null)
  const [partsLoading, setPartsLoading] = useState(false)
  const [partsReloadKey, setPartsReloadKey] = useState(0)

  useEffect(() => {
    if (draft.action !== 'detect') return
    let cancelled = false
    setPartsLoading(true)
    fetch('/api/parts')
      .then((r) => r.ok ? r.json() : { parts: [] })
      .then((d) => {
        if (cancelled) return
        const all = Array.isArray(d?.parts) ? d.parts : []
        setTaughtParts(all.filter((p) => Number(p?.teach_count || 0) > 0))
      })
      .catch(() => { if (!cancelled) setTaughtParts([]) })
      .finally(() => { if (!cancelled) setPartsLoading(false) })
    return () => { cancelled = true }
  }, [draft.action, partsReloadKey])

  // Refresh the dropdown when the window regains focus — the operator
  // may have just finished teaching on the Part Recognition tab and
  // come back; without this they'd have to close+reopen the editor to
  // see the newly-taught part.
  useEffect(() => {
    if (draft.action !== 'detect') return
    const onFocus = () => setPartsReloadKey((k) => k + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [draft.action])

  const update = (key, val) => setDraft((prev) => ({ ...prev, [key]: val }))

  function changeAction(actionValue) {
    const nextDef = ACTION_TYPES.find((a) => a.value === actionValue) || ACTION_TYPES[0]
    setDraft((prev) => ({ ...prev, action: nextDef.value, type: nextDef.type }))
  }

  function commit() {
    const def = actionFor(draft)
    const patch = { action: draft.action || def.value, type: def.type, label: draft.label }
    for (const f of def.fields) {
      if (f === 'target_part') {
        if (draft.target_part_id !== undefined)   patch.target_part_id   = draft.target_part_id
        if (draft.target_part_name !== undefined) patch.target_part_name = draft.target_part_name
        continue
      }
      if (draft[f] !== undefined) patch[f] = draft[f]
    }
    // Pose fields live outside the per-action `fields` list — they're
    // shown for every step that carries a position_role / derived_from
    // / taught_tcp. Pass them through commit explicitly so a numeric
    // nudge to xyz/rpy or an override toggle survives Save.
    const POSE_KEYS = [
      'taught_tcp', 'taught_joints', 'taught',
      'position', 'position_role', 'derived_from',
      'overridden', 'offset_z_mm',
    ]
    for (const k of POSE_KEYS) {
      if (draft[k] !== undefined) patch[k] = draft[k]
    }
    onSave(patch)
    onClose()
  }

  // Pose section visibility: shown for any step that's part of the
  // pick/place/approach link graph — either a base pose source, a
  // derived offset move, or a step that already carries a taught_tcp.
  const isDerived         = !!draft.derived_from
  const isOverridden      = !!draft.overridden && isDerived
  const showPosePanel     =
    isPoseSource(draft) || isDerived ||
    (Array.isArray(draft.taught_tcp) && draft.taught_tcp.length >= 3)
  const derivedAuto       = isDerived ? resolveDerivedPose(draft, allSteps) : null

  // Active pose displayed/edited in the panel. For base steps and
  // overridden derived steps this is taught_tcp; for auto-derived
  // steps it's the computed pose (read-only).
  const liveTcp = (Array.isArray(draft.taught_tcp) && draft.taught_tcp.length >= 6)
    ? draft.taught_tcp
    : (isDerived && !isOverridden && derivedAuto) ? derivedAuto
    : null

  async function capturePoseFromRobot() {
    try {
      const res = await fetch('/api/state')
      if (!res.ok) return
      const state = await res.json()
      const tcp = Array.isArray(state?.tcp_pose) ? state.tcp_pose : null
      const joints = Array.isArray(state?.joints?.positions) ? state.joints.positions : null
      if (!tcp || tcp.length < 6) return
      setDraft((prev) => ({
        ...prev,
        taught: true,
        taught_tcp: tcp,
        taught_joints: joints ? radiansToJointDegrees(joints) : prev.taught_joints,
        taught_at: new Date().toISOString(),
        position: tcp.slice(0, 3),
        // If this is a derived step, capturing a pose implicitly
        // overrides the auto-link.
        ...(prev.derived_from ? { overridden: true } : {}),
      }))
    } catch { /* ignore */ }
  }

  function updatePoseAxis(i, val) {
    const v = parseFloat(val)
    const start = Array.isArray(liveTcp) && liveTcp.length >= 6
      ? liveTcp.map(Number)
      : [0, 0, 0, 0, 0, 0]
    start[i] = isNaN(v) ? 0 : v
    setDraft((prev) => ({
      ...prev,
      taught: true,
      taught_tcp: start,
      position: start.slice(0, 3),
      // Manual numeric edit on a derived step → override the link.
      ...(prev.derived_from ? { overridden: true } : {}),
    }))
  }

  function resetToAuto() {
    // Clear the manual override on a derived step so the executor
    // (and editor preview) falls back to base + offset_z_mm.
    setDraft((prev) => {
      const next = { ...prev }
      delete next.taught_tcp
      delete next.taught_joints
      delete next.taught_at
      delete next.position
      next.taught = false
      next.overridden = false
      return next
    })
  }

  return (
    <div style={{
      background: '#fff', border: '2px solid #2563EB', borderRadius: 8,
      padding: 14, marginBottom: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#2563EB' }}>EDITING STEP</span>
        <div style={{ flex: 1 }} />
        <button onClick={commit} style={{
          padding: '4px 14px', fontSize: 11, fontWeight: 600,
          background: '#2563EB', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
        }}>Save</button>
        <button onClick={onClose} style={{
          padding: '4px 10px', fontSize: 11, background: '#f3f4f6', color: '#6b7280',
          border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
        }}>Cancel</button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Action</div>
        <select value={draft.action || actionDef.value} onChange={(e) => changeAction(e.target.value)} style={selectStyle}>
          {ACTION_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Label</div>
        <input value={draft.label || ''} onChange={(e) => update('label', e.target.value)}
          placeholder={actionDef.label} style={inputStyle} />
      </div>

      {showPosePanel && (
        <div style={{
          padding: '10px 12px', marginBottom: 10,
          background: isOverridden ? '#fffbeb' : '#f8fafc',
          border: isOverridden ? '1px solid #fcd34d' : '1px solid #e5e7eb',
          borderRadius: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              padding: '2px 6px', borderRadius: 4,
              background: isDerived ? (isOverridden ? '#fde68a' : '#dbeafe') : '#dcfce7',
              color:      isDerived ? (isOverridden ? '#92400e' : '#1d4ed8') : '#166534',
            }}>
              {isDerived
                ? (isOverridden ? 'OVERRIDDEN' : 'AUTO (derived)')
                : (draft.position_role ? draft.position_role.toUpperCase() : 'POSE')}
            </span>
            {isDerived && (
              <span style={{ fontSize: 10, color: '#6b7280' }}>
                from <b>{String(draft.derived_from)}</b>
                {(draft.offset_z_mm !== undefined && draft.offset_z_mm !== null)
                  ? ` + Z ${draft.offset_z_mm}mm` : ''}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button onClick={capturePoseFromRobot}
              title="Capture the current robot TCP and apply it to this step (overrides auto-link for derived steps)."
              style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 600,
                background: '#eff6ff', color: '#2563EB',
                border: '1px solid #bfdbfe', borderRadius: 4, cursor: 'pointer',
              }}>
              Use current pose
            </button>
            {isOverridden && (
              <button onClick={resetToAuto}
                title="Drop the manual pose; revert to base + offset link."
                style={{
                  padding: '4px 10px', fontSize: 10, fontWeight: 600,
                  background: '#fef2f2', color: '#b91c1c',
                  border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer',
                }}>
                Reset to auto
              </button>
            )}
          </div>

          {isDerived && !isOverridden && (
            <div style={{ fontSize: 10, color: '#0369a1', marginBottom: 6 }}>
              Computed at runtime from <b>{String(draft.derived_from)}</b> + Z {draft.offset_z_mm ?? 0}mm.
              Edit any axis below or click "Use current pose" to override the link.
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {['X (m)', 'Y (m)', 'Z (m)'].map((lbl, i) => (
              <div key={lbl}>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{lbl}</div>
                <input type="number" step="0.001"
                  value={liveTcp ? Number(liveTcp[i] ?? 0).toFixed(4) : ''}
                  placeholder={liveTcp ? '' : '—'}
                  onChange={(e) => updatePoseAxis(i, e.target.value)}
                  style={inputStyle} />
              </div>
            ))}
            {['Rx (rad)', 'Ry (rad)', 'Rz (rad)'].map((lbl, i) => (
              <div key={lbl}>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{lbl}</div>
                <input type="number" step="0.01"
                  value={liveTcp ? Number(liveTcp[i + 3] ?? 0).toFixed(4) : ''}
                  placeholder={liveTcp ? '' : '—'}
                  onChange={(e) => updatePoseAxis(i + 3, e.target.value)}
                  style={inputStyle} />
              </div>
            ))}
          </div>
          {isDerived && !liveTcp && (
            <div style={{ marginTop: 6, fontSize: 10, color: '#b45309' }}>
              Source pose isn't taught yet — teach the base step (e.g. pick/place) first to see this resolve.
            </div>
          )}
          {!isDerived && !liveTcp && (
            <div style={{ marginTop: 6, fontSize: 10, color: '#b45309' }}>
              Not taught yet. Use the Teach button on the row, or "Use current pose" above.
            </div>
          )}
        </div>
      )}

      {actionDef.fields.includes('width_mm') && (
        <Field label="Gripper Width (mm)">
          <input type="number" value={draft.width_mm ?? 85}
            onChange={(e) => update('width_mm', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('speed_pct') && (
        <Field label="Speed (%)">
          <input type="number" min={1} max={100} value={draft.speed_pct ?? 80}
            onChange={(e) => update('speed_pct', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('force_pct') && (
        <Field label="Force (%)">
          <input type="number" min={1} max={100} value={draft.force_pct ?? 50}
            onChange={(e) => update('force_pct', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {(actionDef.fields.includes('io_open') || actionDef.fields.includes('io_close')) && (
        <div style={{
          padding: '8px 10px', marginTop: 4, marginBottom: 8,
          background: '#f8fafc', borderRadius: 6, border: '1px solid #e5e7eb',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
            I/O Port Assignment
          </div>
          {actionDef.fields.includes('io_open') && (
            <IOPortSelector
              label="Open signal (output to activate)"
              value={draft.io_open}
              onChange={(v) => update('io_open', v)}
              direction="output"
            />
          )}
          {actionDef.fields.includes('io_open_confirm') && (
            <IOPortSelector
              label="Open confirm (input to verify)"
              value={draft.io_open_confirm}
              onChange={(v) => update('io_open_confirm', v)}
              direction="input"
            />
          )}
          {actionDef.fields.includes('io_close') && (
            <IOPortSelector
              label="Close signal (output to activate)"
              value={draft.io_close}
              onChange={(v) => update('io_close', v)}
              direction="output"
            />
          )}
          {actionDef.fields.includes('io_close_confirm') && (
            <IOPortSelector
              label="Close confirm (input to verify)"
              value={draft.io_close_confirm}
              onChange={(v) => update('io_close_confirm', v)}
              direction="input"
            />
          )}
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
            Operator-renamed labels from the Sensors tab show here. The confirm input is optional — when set, the program waits for that signal before continuing.
          </div>
        </div>
      )}
      {actionDef.fields.includes('target') && (
        <Field label="Target">
          <select value={draft.target || 'auto'} onChange={(e) => update('target', e.target.value)} style={selectStyle}>
            <option value="auto">Auto (nearest object)</option>
            <option value="selected">Selected object</option>
            <option value="named">Named part...</option>
          </select>
        </Field>
      )}
      {actionDef.fields.includes('offset_z_mm') && (
        <Field label="Z Offset (mm above)">
          <input type="number" value={draft.offset_z_mm ?? 150}
            onChange={(e) => update('offset_z_mm', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('descend_mm') && (
        <Field label="Descend (mm)">
          <input type="number" value={draft.descend_mm ?? 130}
            onChange={(e) => update('descend_mm', parseInt(e.target.value, 10))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('position') && (
        <Field label="Position X, Y, Z (m)">
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 1, 2].map((i) => (
              <input key={i} type="number" step="0.01"
                value={(draft.position || [0.3, -0.2, 0.4])[i]}
                onChange={(e) => {
                  const pos = [...(draft.position || [0.3, -0.2, 0.4])]
                  pos[i] = parseFloat(e.target.value)
                  update('position', pos)
                }}
                style={{ ...inputStyle, flex: 1 }} />
            ))}
          </div>
        </Field>
      )}
      {actionDef.fields.includes('joints') && (
        <Field label="Joint Angles (deg)">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[0, 1, 2, 3, 4, 5].map((j) => (
              <input key={j} type="number" step="1"
                value={(draft.joints || [0, -90, 0, -90, 0, 0])[j]}
                onChange={(e) => {
                  const jts = [...(draft.joints || [0, -90, 0, -90, 0, 0])]
                  jts[j] = parseFloat(e.target.value)
                  update('joints', jts)
                }}
                placeholder={'J' + (j + 1)}
                style={{ ...inputStyle, width: 52, padding: '6px 4px', fontSize: 11, textAlign: 'center' }} />
            ))}
          </div>
        </Field>
      )}
      {actionDef.fields.includes('duration_s') && (
        <Field label="Duration (seconds)">
          <input type="number" step="0.5" value={draft.duration_s ?? 1}
            onChange={(e) => update('duration_s', parseFloat(e.target.value))} style={inputStyle} />
        </Field>
      )}
      {actionDef.fields.includes('target_part') && (
        <Field label="Detect Part">
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <select
              value={draft.target_part_id || ''}
              disabled={partsLoading || !taughtParts || taughtParts.length === 0}
              onChange={(e) => {
                const id = e.target.value || null
                const match = (taughtParts || []).find((p) => String(p.id) === String(id))
                setDraft((prev) => ({
                  ...prev,
                  target_part_id: id,
                  target_part_name: match?.name || null,
                }))
              }}
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="">
                {partsLoading
                  ? 'Loading…'
                  : (taughtParts && taughtParts.length === 0)
                    ? 'No taught parts yet — teach one first'
                    : 'Select a taught part…'}
              </option>
              {(taughtParts || []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setPendingTeachNew(true)
                setActiveTab('adaptive_picking')
              }}
              title="Open the Part Recognition tab and start the Teach New Part wizard. The dropdown refreshes when you return."
              style={{
                padding: '6px 10px', fontSize: 11, fontWeight: 600,
                background: '#16A34A', color: '#fff', border: 'none',
                borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >+ Teach New Part</button>
          </div>
        </Field>
      )}
      {actionDef.fields.includes('io_id') && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <IOPortSelector
              label="I/O Port"
              value={draft.io_id}
              onChange={(v) => update('io_id', v || 'DO0')}
              direction="output"
            />
          </div>
          <Field label="Value" style={{ flex: 1 }}>
            <select value={draft.value ?? 1} onChange={(e) => update('value', parseInt(e.target.value, 10))} style={selectStyle}>
              <option value={1}>ON</option>
              <option value={0}>OFF</option>
            </select>
          </Field>
        </div>
      )}
      {actionDef.fields.includes('goto') && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Field label="Go to step" style={{ flex: 1 }}>
            <input type="number" min={1} value={draft.goto ?? 1}
              onChange={(e) => update('goto', parseInt(e.target.value, 10))} style={inputStyle} />
          </Field>
          <Field label="Repeat count (0=infinite)" style={{ flex: 1 }}>
            <input type="number" min={0} value={draft.count ?? 0}
              onChange={(e) => update('count', parseInt(e.target.value, 10))} style={inputStyle} />
          </Field>
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 4,
  border: '1px solid #d1d5db', background: '#fafafa', outline: 'none',
}
const selectStyle = { ...inputStyle }

function Field({ label, children, style }) {
  return (
    <div style={{ marginBottom: 8, ...style }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}

function VoiceBar() {
  const sendVoice = useStore((s) => s.sendVoice)
  const addToast  = useStore((s) => s.addToast)
  const [text, setText]         = useState('')
  const [lastResp, setLastResp] = useState('')
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef(null)

  async function submit() {
    if (!text.trim()) return
    const result = await sendVoice(text.trim())
    if (result) setLastResp(result.response ?? '')
    setText('')
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { addToast('Speech recognition not supported in this browser', 'warning'); return }
    const recog = new SR()
    recog.lang = 'en-US'
    recog.interimResults = false
    recog.onresult = (ev) => { setText(ev.results[0][0].transcript) }
    recog.onend   = () => setListening(false)
    recog.onerror = () => setListening(false)
    recog.start()
    recognitionRef.current = recog
    setListening(true)
  }

  function stopListening() {
    if (recognitionRef.current) recognitionRef.current.stop()
    setListening(false)
  }

  return (
    <div style={{
      borderTop: '1px solid #e5e7eb',
      padding: '8px 12px',
      background: '#fafafa',
      display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Ask NeuRobots…"
          style={{ flex: 1, padding: '5px 8px', fontSize: 12, borderRadius: 4,
                   border: '1px solid #d1d5db', background: '#fff', outline: 'none' }} />
        <button onClick={listening ? stopListening : startListening}
          title={listening ? 'Stop listening' : 'Start voice input'}
          style={{ padding: '5px 8px', fontSize: 14, borderRadius: 4,
                   background: listening ? 'rgba(239,68,68,0.15)' : '#fff',
                   border: `1px solid ${listening ? 'rgba(239,68,68,0.4)' : '#d1d5db'}`,
                   color: listening ? '#DC2626' : '#6b7280', cursor: 'pointer' }}>
          🎤
        </button>
        <button onClick={submit} disabled={!text.trim()}
          style={{ padding: '5px 12px', fontSize: 11, fontWeight: 600, borderRadius: 4,
                   border: 'none', background: '#2563EB', color: '#fff', cursor: 'pointer' }}>
          Send
        </button>
      </div>
      {lastResp && (
        <div style={{ fontSize: 10, color: '#6b7280', padding: '0 2px' }}>↳ {lastResp}</div>
      )}
    </div>
  )
}

// Right-click context menu for a step row. Position is screen-fixed
// at the cursor; closes on any outside mousedown or after an action.
function StepContextMenu({ x, y, items, onAction, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose() }
    function onEsc(e)  { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  return (
    <div ref={ref} style={{
      position: 'fixed', left: x, top: y, zIndex: 1000,
      background: '#fff', borderRadius: 8, padding: '4px 0',
      boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
      border: '1px solid #e5e7eb', minWidth: 200,
    }}>
      {items.map((item, i) => {
        if (item.divider) {
          return <div key={'div'+i} style={{ height: 1, background: '#e5e7eb', margin: '4px 0' }} />
        }
        return (
          <button key={item.action}
            onClick={() => { onAction(item.action); onClose() }}
            disabled={item.disabled}
            style={{
              width: '100%', padding: '9px 14px',
              display: 'flex', alignItems: 'center', gap: 12,
              background: 'transparent', border: 'none',
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              fontSize: 13, color: item.danger ? '#DC2626' : '#374151',
              textAlign: 'left', opacity: item.disabled ? 0.4 : 1,
            }}
            onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = item.danger ? '#fef2f2' : '#f3f4f6' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
            <span style={{ flex: 1 }}>{item.label}</span>
            <span style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' }}>{item.hint || ''}</span>
          </button>
        )
      })}
    </div>
  )
}

// Action catalog used by the "+ Add Step" panel. Each entry's `action`
// matches the value used by ACTION_TYPES so the inline editor and
// detail line keep working on the new row.
const STEP_CATEGORIES = [
  {
    name: 'Motion',
    actions: [
      { action: 'move_home',   label: 'Move Home',    desc: 'Move robot to home position' },
      { action: 'move_joint',  label: 'Move Joint',   desc: 'Move to a joint position' },
      { action: 'move_linear', label: 'Move Linear',  desc: 'Move in a straight line' },
      { action: 'approach',    label: 'Approach',     desc: 'Move above a target position' },
    ],
  },
  {
    name: 'Pick and Place',
    actions: [
      { action: 'pick',          label: 'Pick',          desc: 'Descend and grasp an object' },
      { action: 'place',         label: 'Place',         desc: 'Place object at target' },
      { action: 'open_gripper',  label: 'Open Gripper',  desc: 'Open the gripper or release vacuum' },
      { action: 'close_gripper', label: 'Close Gripper', desc: 'Close gripper on object' },
    ],
  },
  {
    name: 'Control',
    actions: [
      { action: 'loop',   label: 'Loop',   desc: 'Repeat steps a number of times' },
      { action: 'wait',   label: 'Wait',   desc: 'Wait for time, I/O signal, or event' },
      { action: 'detect', label: 'Detect', desc: 'Run camera detection' },
      { action: 'set_io', label: 'Set I/O',desc: 'Set a digital or analog output' },
    ],
  },
  {
    name: 'Scan',
    actions: [
      { action: 'scan_workspace',     label: 'Scan Workspace', desc: 'Detect all objects on the table from current position' },
      { action: 'scan_identify_each', label: 'Identify Each',  desc: 'Move above each detected object for close-up identification' },
      { action: 'sort_scanned',       label: 'Sort Scanned',   desc: 'Pick and sort scanned parts by type (needs robot-frame calibration)' },
      { action: 'remove_defects',     label: 'Remove Defects', desc: 'Pick up defective parts from scan results (needs robot-frame calibration)' },
    ],
  },
]

// Default extras per action so a freshly-added step has sane defaults
// the inline editor can show without "[object Object]" placeholders.
function freshStepForAction(action) {
  const def = ACTION_TYPES.find((a) => a.value === action) || ACTION_TYPES[0]
  const base = { action: def.value, type: def.type, label: def.label, detail: '' }
  switch (action) {
    case 'open_gripper':  return { ...base, width_mm: 85, speed_pct: 80 }
    case 'close_gripper': return { ...base, force_pct: 50 }
    case 'move_joint':    return { ...base, joints: [0, -90, 0, -90, 0, 0] }
    case 'move_linear':   return { ...base, position: [0.3, -0.2, 0.4], speed_pct: 50 }
    case 'approach':      return { ...base, target: 'auto', offset_z_mm: 150 }
    case 'pick':          return { ...base, descend_mm: 130 }
    case 'place':         return { ...base, position: [0.3, -0.2, 0.4] }
    case 'wait':          return { ...base, duration_s: 1 }
    case 'detect':        return { ...base, target_part_id: null, target_part_name: null }
    case 'loop':          return { ...base, goto: 1, count: 0 }
    case 'set_io':        return { ...base, io_id: 'DO0', value: 1 }
    case 'scan_workspace': return {
      ...base, scan_height_mm: 150, scan_speed_pct: 30, mode: 'wide',
    }
    case 'scan_identify_each': return {
      ...base, scan_height_mm: 150, scan_speed_pct: 20,
      settle_time_ms: 500, capture_frames: 5, match_threshold_pct: 70,
    }
    case 'sort_scanned':   return base
    case 'remove_defects': return base
    default:              return base
  }
}

function InsertionBar() {
  return (
    <div
      // Don't intercept drag events — the bar lives between rows but
      // we want dragover to keep firing on the rows themselves.
      style={{
        height: 4,
        background: '#2563EB',
        borderRadius: 2,
        margin: '2px 12px',
        boxShadow: '0 0 8px rgba(37, 99, 235, 0.45)',
        pointerEvents: 'none',
      }}
    />
  )
}

// Size the rename input to fit the current text, clamped between
// 80px (so a one-character draft is still clickable) and 300px (so a
// long paste doesn't push the row's buttons off the right edge).
function labelInputWidth(text) {
  // Sized for the bumped 16 px label font: ~10 px per char.
  return Math.max(120, Math.min(420, (text || '').length * 10 + 28))
}

function EditableStepLabel({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => {
    if (editing && ref.current) { ref.current.focus(); ref.current.select() }
  }, [editing])

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input ref={ref} value={draft}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        style={{
          fontSize: 17, fontWeight: 500, letterSpacing: '0.01em',
          padding: '3px 8px',
          background: '#fff', color: '#111',
          border: '1px solid #2563EB', borderRadius: 4,
          outline: 'none',
          width: labelInputWidth(draft),
        }}
      />
    )
  }

  return (
    <span
      onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}
      title="Click to rename"
      style={{
        margin: 0, padding: 0, textAlign: 'left',
        fontSize: 17, fontWeight: 500, color: '#111',
        letterSpacing: '0.01em', lineHeight: 1.3,
        cursor: 'text', borderRadius: 4,
        display: 'inline-block',
        whiteSpace: 'normal', wordBreak: 'break-word',
        maxWidth: '100%',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {value}
    </span>
  )
}

// Renumber step ids 1..N. Called after every local mutation so the
// drag/select handlers (which key off step.id) always have unique,
// stable ids.
function renumber(arr) {
  return arr.map((s, i) => ({ ...s, id: i + 1 }))
}

// ────────────────────────────────────────────────────────
// TeachOverlay — dark fullscreen overlay that replaces the prior
// inline blue "Teaching step N" banner. Opened both by Teach All
// and by an individual step's Teach button. Reuses the live jog
// store actions (jog / jogCartesian / homeRobot / triggerEstop)
// but inlines the pendant markup at the large 140×140 sizing so
// nothing else has to be exported from ProgramLayout.
// ────────────────────────────────────────────────────────

function radiansToDeg(positions) {
  if (!Array.isArray(positions)) return [0, 0, 0, 0, 0, 0]
  return positions.slice(0, 6).map((rad) => Number(((rad || 0) * 180 / Math.PI).toFixed(2)))
}

function OverlayJogArrow({ onPress, color, label, rotation, size = 140, svgSize = 60 }) {
  const timer = useRef(null)
  const start = useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    onPress()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(onPress, 150)
  }, [onPress])
  const stop = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null }
  }, [])
  useEffect(() => () => stop(), [stop])
  return (
    <button
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#1C1C1F'; e.currentTarget.style.borderColor = '#2a2a30'; stop() }}
      onMouseEnter={(e) => { e.currentTarget.style.background = color + '22'; e.currentTarget.style.borderColor = color }}
      onTouchStart={start}
      onTouchEnd={stop}
      onTouchCancel={stop}
      style={{
        width: size, height: size, padding: 0,
        background: '#1C1C1F', border: '1px solid #2a2a30', borderRadius: 10,
        cursor: 'pointer', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4,
        userSelect: 'none', touchAction: 'none',
      }}>
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>{label}</span>
    </button>
  )
}

function OverlayPadCenter({ label, width = 140, height = 140 }) {
  return (
    <div style={{
      width, height,
      background: '#0F0F12', borderRadius: 10,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, color: '#525866',
    }}>{label}</div>
  )
}

function TeachOverlay({
  step, currentN, totalM, canBack,
  onRecord, onSkip, onBack, onCancel,
}) {
  const jog          = useStore((s) => s.jog)
  const jogCartesian = useStore((s) => s.jogCartesian)
  const homeRobot    = useStore((s) => s.homeRobot)
  const triggerEstop = useStore((s) => s.triggerEstop)

  const [jogMode, setJogMode] = useState('cartesian')
  const [stepSize, setStepSize] = useState(1.0)
  const [speed, setSpeed]       = useState(20)
  const [flash, setFlash]       = useState(false)
  const stepRef  = useRef(stepSize)
  const speedRef = useRef(speed)
  const modeRef  = useRef(jogMode)
  useEffect(() => { stepRef.current = stepSize },  [stepSize])
  useEffect(() => { speedRef.current = speed },    [speed])
  useEffect(() => { modeRef.current = jogMode },   [jogMode])

  // Lock body scroll while overlay is mounted.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const sendJog = useCallback((axis, direction) => {
    if (modeRef.current === 'joint') {
      const deltaRad = direction * stepRef.current * Math.PI / 180
      jog(axis - 1, deltaRad)
    } else {
      jogCartesian(axis, direction, stepRef.current, speedRef.current)
    }
  }, [jog, jogCartesian])

  const recording = useRef(false)
  async function doRecord() {
    if (recording.current) return
    recording.current = true
    setFlash(true)
    try { await onRecord() } finally {
      // Show "✓ RECORDED" for 1.5s then release (parent advances).
      setTimeout(() => { setFlash(false); recording.current = false }, 1500)
    }
  }

  const stepLabel = step?.label || step?.action || 'Position'
  const stepInstruction = 'Jog the robot to the desired position, then press Record.'

  // Viewport-driven sizing — the spec asks for larger D-pads on wide
  // screens (>1400 px) and the existing fullscreen size as the floor on
  // smaller tablets (<1100 px). Tracking on a single state var means a
  // window resize re-renders with the right metrics.
  const [vw, setVw] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth : 1280))
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Three tiers — tablet (≤ 1280 CSS px landscape ONN 11"), narrow
  // laptop, desktop. The previous two-tier scheme bottomed out at a
  // 140 px d-pad which overflowed the tablet's 1200 px viewport
  // (three 3×3 grids of 140 px + gaps + padding ≈ 1472 px).
  const isWide   = vw > 1400
  const isTabletW = vw <= 1280
  const padBtn      = isTabletW ? 96  : isWide ? 160 : 140
  const svgPx       = isTabletW ? 42  : isWide ?  72 :  60
  const padGap      = isTabletW ? 10  : 14
  const groupGap    = isTabletW ? 24  : 40
  const actionH     = isTabletW ? 56  : isWide ?  78 :  68
  const actionFont  = isTabletW ? 14  : isWide ?  18 :  16
  const modeBtnH    = isTabletW ? 48  : isWide ?  64 :  56
  const modeBtnFont = isTabletW ? 14  : isWide ?  17 :  16

  const modeBtn = (on) => ({
    padding: '0 26px', minHeight: modeBtnH, fontSize: modeBtnFont, fontWeight: 700,
    background: on ? '#2F7FFF' : '#1C1C1F',
    color:      on ? '#fff'    : '#cbd5e1',
    border:     on ? 'none'    : '1px solid #2a2a30',
    borderRadius: 8, cursor: 'pointer', flex: '0 0 auto',
  })

  const actionBtn = (variant) => {
    const base = {
      minHeight: actionH, padding: '0 22px',
      fontSize: actionFont, fontWeight: 700,
      borderRadius: 10, cursor: 'pointer',
      flex: '1 1 0', minWidth: 120,
    }
    if (variant === 'estop') {
      return {
        ...base,
        background: '#DC2626', color: '#fff',
        border: 'none', fontWeight: 800, letterSpacing: '0.5px',
      }
    }
    return {
      ...base,
      background: '#1C1C1F', color: '#cbd5e1',
      border: '1px solid #2a2a30',
    }
  }

  // M and N are 1-based per the spec.
  const progressPct = totalM > 0 ? ((currentN - 1) / totalM) * 100 : 0

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: '#0A0A0B', color: '#e5e7eb',
      display: 'flex', flexDirection: 'column',
      userSelect: 'none',
      overflowX: 'hidden',
    }}>
      {/* HEADER */}
      <div style={{
        height: 60, flexShrink: 0,
        background: '#141416', borderBottom: '1px solid #2a2a30',
        display: 'flex', alignItems: 'center',
        padding: isTabletW ? '0 14px' : '0 22px',
        gap: 16,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#9ca3af', letterSpacing: '0.04em' }}>
            TEACHING  •  Step {currentN} of {totalM}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginTop: 2 }}>
            {stepLabel}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={onCancel}
          style={{
            minHeight: 44, minWidth: 64, padding: '0 16px',
            fontSize: 14, fontWeight: 600,
            background: 'transparent', color: '#9ca3af',
            border: 'none', cursor: 'pointer',
          }}>
          Cancel
        </button>
      </div>

      {/* INSTRUCTION BAND */}
      <div style={{
        height: 48, flexShrink: 0,
        background: '#1C1C1F', borderBottom: '1px solid #0A0A0B',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 22px',
      }}>
        <div style={{ fontSize: 15, color: '#9ca3af', textAlign: 'center' }}>
          {stepInstruction}
        </div>
      </div>

      {/* JOG CONTROLS — fills the full area between instruction band and
          footer. Vertical layout: mode toggle row → speed/step row →
          main control area (D-pads, takes the rest) → action buttons. */}
      <div style={{
        width: '100%', height: '100%',
        flex: 1, minHeight: 0,
        background: '#0A0A0B',
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', alignItems: 'center',
        padding: isTabletW ? 12 : 24, gap: isTabletW ? 12 : 18,
        overflowX: 'hidden', overflowY: 'auto',
      }}>
        {/* Mode toggle row — flex 0 0 auto. */}
        <div style={{
          flex: '0 0 auto',
          display: 'flex', gap: 12, alignItems: 'center',
          width: '100%', justifyContent: 'space-evenly',
        }}>
          <button onClick={() => setJogMode('cartesian')} style={modeBtn(jogMode === 'cartesian')}>XYZ</button>
          <button onClick={() => setJogMode('joint')}     style={modeBtn(jogMode === 'joint')}>Joint</button>
          <button disabled title="Tool frame jogging requires URDF — coming soon"
            style={{ ...modeBtn(false), opacity: 0.45, cursor: 'not-allowed' }}>Tool</button>
        </div>

        {/* Speed + step row — flex 0 0 auto. */}
        <div style={{
          flex: '0 0 auto',
          width: '100%',
          display: 'flex', alignItems: 'center', gap: 18,
          justifyContent: 'space-evenly', flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#9ca3af' }}>Step:</span>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s} onClick={() => setStepSize(s)} style={{
                padding: '10px 14px', minHeight: 44,
                fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                background: stepSize === s ? '#2F7FFF' : '#1C1C1F',
                color:      stepSize === s ? '#fff'    : '#cbd5e1',
                border:     stepSize === s ? 'none'    : '1px solid #2a2a30',
              }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 240, maxWidth: 520 }}>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 2 }}>Speed: {speed}%</div>
            <input type="range" min={1} max={100} value={speed}
              onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
              style={{ width: '100%', height: 8 }} />
          </div>
        </div>

        {/* Main control area — flex 1 1 auto. Takes the remaining
            vertical room. The D-pad groups spread across the full
            width via space-evenly. */}
        <div style={{
          flex: '1 1 auto', minHeight: 0,
          width: '100%',
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-evenly',
          flexWrap: 'wrap', rowGap: groupGap,
        }}>
          {jogMode === 'cartesian' ? (
            <>
              <div style={{ flex: '0 1 auto' }}>
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginBottom: 6 }}>Position</div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                  gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                  gridTemplateAreas: '". up ." "left center right" ". down ."',
                  gap: padGap,
                }}>
                  <div style={{ gridArea: 'up' }}>    <OverlayJogArrow onPress={() => sendJog('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'left' }}>  <OverlayJogArrow onPress={() => sendJog('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'center' }}><OverlayPadCenter label="XY" width={padBtn} height={padBtn} /></div>
                  <div style={{ gridArea: 'right' }}> <OverlayJogArrow onPress={() => sendJog('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'down' }}>  <OverlayJogArrow onPress={() => sendJog('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} svgSize={svgPx} /></div>
                </div>
              </div>
              <div style={{ flex: '0 1 auto' }}>
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginBottom: 6 }}>Height</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: padGap, width: padBtn }}>
                  <OverlayJogArrow onPress={() => sendJog('z',  1)} rotation={0}   label="Z+" color="#3B82F6" size={padBtn} svgSize={svgPx} />
                  <OverlayJogArrow onPress={() => sendJog('z', -1)} rotation={180} label="Z−" color="#3B82F6" size={padBtn} svgSize={svgPx} />
                </div>
              </div>
              <div style={{ flex: '0 1 auto' }}>
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginBottom: 6 }}>Rotation</div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                  gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                  gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
                  gap: padGap,
                }}>
                  <div style={{ gridArea: 'rxp' }}>   <OverlayJogArrow onPress={() => sendJog('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'rzn' }}>   <OverlayJogArrow onPress={() => sendJog('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'center' }}><OverlayPadCenter label="Rot" width={padBtn} height={padBtn} /></div>
                  <div style={{ gridArea: 'rzp' }}>   <OverlayJogArrow onPress={() => sendJog('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'rxn' }}>   <OverlayJogArrow onPress={() => sendJog('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} svgSize={svgPx} /></div>
                </div>
              </div>
            </>
          ) : (
            [1, 2, 3, 4, 5, 6].map((j) => (
              <div key={j} style={{
                flex: '0 1 auto',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: padGap,
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#cbd5e1' }}>{'J' + j}</div>
                <OverlayJogArrow onPress={() => sendJog(j,  1)} rotation={0}   label={'+J' + j} color="#16A34A" size={padBtn} svgSize={svgPx} />
                <OverlayJogArrow onPress={() => sendJog(j, -1)} rotation={180} label={'−J' + j} color="#DC2626" size={padBtn} svgSize={svgPx} />
              </div>
            ))
          )}
        </div>

        {/* Action buttons row — flex 0 0 auto. Run/Pause/Teach belong on
            the program tab, not while teaching; here we surface Home and
            STOP at the larger fullscreen sizing. */}
        <div style={{
          flex: '0 0 auto',
          width: '100%',
          display: 'flex', gap: 16,
          justifyContent: 'space-evenly',
        }}>
          <button onClick={homeRobot} style={actionBtn('default')}>Home</button>
          <button onClick={triggerEstop} style={actionBtn('estop')}>STOP</button>
        </div>
      </div>

      {/* FOOTER */}
      <div style={{
        height: 100, flexShrink: 0,
        background: '#141416', borderTop: '1px solid #2a2a30',
        display: 'flex', alignItems: 'center', padding: '0 22px', gap: 16,
        position: 'relative',
      }}>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}>
          {canBack ? (
            <button onClick={onBack} style={{
              minHeight: 56, padding: '0 22px',
              fontSize: 15, fontWeight: 700,
              background: 'transparent', color: '#cbd5e1',
              border: '1px solid #2a2a30', borderRadius: 10, cursor: 'pointer',
            }}>← Back</button>
          ) : null}
        </div>

        <div style={{ flex: 2, display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={doRecord}
            onTouchStart={(e) => { e.preventDefault() }}
            onTouchEnd={(e) => { e.preventDefault(); doRecord() }}
            style={{
              height: 72, minWidth: 280, padding: '0 36px',
              fontSize: 20, fontWeight: 800, letterSpacing: '0.5px',
              background: flash ? '#fff' : '#00C47A',
              color:      flash ? '#00C47A' : '#fff',
              border: 'none', borderRadius: 12, cursor: 'pointer',
              transition: 'background 100ms, color 100ms',
            }}>
            {flash ? '✓ RECORDED' : 'RECORD POSITION'}
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onSkip} style={{
            minHeight: 56, padding: '0 22px',
            fontSize: 15, fontWeight: 700,
            background: 'transparent', color: '#cbd5e1',
            border: '1px solid #2a2a30', borderRadius: 10, cursor: 'pointer',
          }}>Skip →</button>
        </div>

        {/* Progress bar pinned to the very bottom */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: 4, background: '#1C1C1F',
        }}>
          <div style={{
            height: '100%', width: progressPct + '%',
            background: '#2F7FFF', transition: 'width 200ms',
          }} />
        </div>
      </div>
    </div>
  )
}

export default function ProgramEditor() {
  const currentProgram     = useStore((s) => s.currentProgram)
  const setCurrentProgram  = useStore((s) => s.setCurrentProgram)
  // setProgramSteps mirrors the editor's current steps to STATE.program
  // on Save / Load so the task runner (Run button) sees the same
  // program the editor displays. Edits between saves stay local.
  const setProgramSteps    = useStore((s) => s.setProgramSteps)
  const loadedProgram      = useStore((s) => s.loadedProgram)
  const setLoadedProgram   = useStore((s) => s.setLoadedProgram)
  // Refresh the shared programs list immediately on save/delete so
  // ProgramLibrary never lags behind the editor.
  const refreshPrograms    = useStore((s) => s.refreshPrograms)
  // For execution highlights we still need to know what the task
  // runner thinks is the active step. status comes from STATE.program
  // (the saved version that's actually running); we match by index so
  // an unsaved edit doesn't desync the highlight when running matches
  // the last save.
  const runningSteps       = useStore((s) => s.program.steps ?? [])
  const taskRunning        = useStore((s) => Boolean(s.task?.running || s.task?.paused))

  // Operator-renamed I/O labels for the detail line + IOPortSelector
  // dropdowns. Fetched once per editor mount.
  const ioLabels           = useIOLabels()

  // Editor identity / steps / unsaved all live in the store now so a
  // tab swap unmount-and-remount doesn't reset them.
  const programId   = currentProgram.id
  const programName = currentProgram.name
  const unsaved     = currentProgram.unsaved
  // Persisted (or wizard-output) steps may arrive without numeric ids
  // — for example, an older localStorage snapshot. If we passed those
  // straight to the editor's id-keyed selectors, editingId === step.id
  // would collapse to undefined === undefined → true for every row,
  // i.e. clicking Edit would open every step at once. Renumber on
  // ingest if any id is missing or non-numeric.
  const rawSteps = currentProgram.steps || []
  const stepsHaveIds = rawSteps.every((s) => typeof s.id === 'number')
  const steps = stepsHaveIds ? rawSteps : renumber(rawSteps)
  // Untaught steps the operator still needs to teach before the path
  // is ready to run. Includes gripper open/close and the home pose —
  // they all happen at a specific robot location.
  const untaughtCount = steps.filter((s) => isTeachable(s) && !s.taught).length
  const allTaughtForRun = untaughtCount === 0

  // Setters that wrap the store action with the right patch shape.
  const setProgramName = (name) => setCurrentProgram({ name, unsaved: true })
  const updateSteps    = (next) => setCurrentProgram({ steps: next, unsaved: true })

  // Transient UI state (selection / drag / wizard / load-menu / save
  // status) is fine to keep local — losing it on tab switch is the
  // expected behaviour, file-manager style.
  const [showWizard, setShowWizard]         = useState(false)
  const [showPbd,    setShowPbd]            = useState(false)
  const [editingId, setEditingId]           = useState(null)
  // True when the operator has opened the dedicated pallet config
  // editor for this program (entry point: Edit button on any
  // move_to_pallet step). Single-instance modal — not per-step.
  const [editingPallet, setEditingPallet]   = useState(false)
  const [selectedId, setSelectedId]         = useState(null)
  const [dragId, setDragId]                 = useState(null)
  const [dragOverId, setDragOverId]         = useState(null)
  const [dragOverPos, setDragOverPos]       = useState(null)
  const [saveStatus, setSaveStatus]         = useState(null)
  const [showLoadMenu, setShowLoadMenu]     = useState(false)
  // Sequential "Teach All" walk-through. -1 = idle, otherwise the
  // index into steps[] the operator is currently teaching.
  // Teach overlay state. `teachAllOrder` is the ordered list of step
  // IDs the operator is walking through (set when Teach All starts so
  // the path stays stable even if the underlying steps[] mutates);
  // `teachAllPos` is the current 0-based position in that path.
  // `teachSingleId` is set when the operator clicks an individual
  // step's Teach button — overlay shows just that one step.
  const [teachAllOrder, setTeachAllOrder]   = useState([])
  const [teachAllPos,   setTeachAllPos]     = useState(-1)
  const [teachSingleId, setTeachSingleId]   = useState(null)
  // Per-step open/closed state for the "View position data" drawer.
  // Stored as a Set of step.id values so the toggle on one row never
  // touches another row.
  const [openPosData, setOpenPosData]       = useState(() => new Set())
  const togglePosData = useCallback((id) => {
    setOpenPosData((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  const [contextMenu, setContextMenu]         = useState(null)
  const [showAddPanel, setShowAddPanel]       = useState(false)
  const [locked, setLocked]                   = useState(false)
  const addToast                              = useStore((s) => s.addToast)
  const [savedPrograms, setSavedPrograms] = useState([])

  // Diagnostic: log what the editor sees on every mount so a future
  // "switching tabs lost my program" report can be verified — if
  // currentProgram is intact here the bug is in render, not state.
  useEffect(() => {
    console.log('[ProgramEditor] mounted with currentProgram',
      { id: currentProgram.id, name: currentProgram.name, steps: currentProgram.steps?.length, unsaved: currentProgram.unsaved })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One-shot heal: if persisted steps lacked ids, write the
  // renumbered list back so subsequent reads are stable and the next
  // render doesn't redo the renumber.
  useEffect(() => {
    if (rawSteps.length > 0 && !stepsHaveIds) {
      console.warn('[ProgramEditor] persisted steps missing ids — healing', rawSteps.length)
      setCurrentProgram({ steps: renumber(rawSteps) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsHaveIds, rawSteps.length])

  // ProgramLibrary writes a saved program into the store and switches
  // to this tab. Consume it once, populate currentProgram, mirror to
  // STATE.program so Run sees it, then clear the slot.
  useEffect(() => {
    if (!loadedProgram || !loadedProgram.id) return
    console.log('[ProgramEditor] consuming loadedProgram',
      { id: loadedProgram.id, name: loadedProgram.name, steps: loadedProgram.steps?.length })
    // Renumber on ingest so an older saved program with duplicate or
    // non-numeric ids can't break id-keyed selectors (edit, drag, etc).
    const ingest = renumber(Array.isArray(loadedProgram.steps) ? loadedProgram.steps : [])
    setCurrentProgram({
      id:     loadedProgram.id,
      name:   loadedProgram.name || 'Untitled Program',
      steps:  ingest,
      unsaved: false,
      config: (loadedProgram.config && typeof loadedProgram.config === 'object') ? loadedProgram.config : {},
      description: loadedProgram.description || '',
      tags:        Array.isArray(loadedProgram.tags) ? loadedProgram.tags : [],
      cell_id:     loadedProgram.cell_id || null,
    })
    setProgramSteps(ingest)
    setLoadedProgram(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedProgram])

  // Execution highlight: when a task is running, map step ids to the
  // backend's status by index (the saved program is what's running, so
  // index alignment is correct as long as the editor matches the last
  // save). If editor has unsaved edits, indices may diverge — the
  // unsaved indicator already warns the operator.
  function statusOf(idx) {
    if (!taskRunning) return null
    return runningSteps[idx]?.status ?? null
  }
  const doneCount = taskRunning
    ? Math.min(steps.length, runningSteps.filter((s) => s.status === 'done').length)
    : 0

  function handleDragStart(e, id) {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id))
  }

  function handleDragOver(e, id) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    const pos  = e.clientY < midY ? 'before' : 'after'
    if (dragOverId !== id) setDragOverId(id)
    if (dragOverPos !== pos) setDragOverPos(pos)
  }

  function clearDrag() {
    setDragId(null)
    setDragOverId(null)
    setDragOverPos(null)
  }

  function handleDrop(e, targetId) {
    e.preventDefault()
    if (dragId === null) { clearDrag(); return }
    const ids   = steps.map((s) => s.id)
    const fromI = ids.indexOf(dragId)
    const toI   = ids.indexOf(targetId)
    if (fromI < 0 || toI < 0) { clearDrag(); return }
    // Compute the *post-removal* insertion index. 'after' lands after
    // the target (toI + 1); if we're removing from a position before
    // that, the splice shifts indices down by one.
    let insertI = dragOverPos === 'after' ? toI + 1 : toI
    if (fromI < insertI) insertI -= 1
    if (fromI === insertI) { clearDrag(); return }
    const next = [...steps]
    const [moved] = next.splice(fromI, 1)
    next.splice(insertI, 0, moved)
    updateSteps(renumber(next))
    clearDrag()
  }

  function handleDragEnd() { clearDrag() }

  function handleAdd() {
    const newStep = freshStepForAction('wait')
    updateSteps(renumber([...steps, newStep]))
  }

  // Add a step of a specific action — used by the categorized
  // "+ Add Step" panel. Appends to the end and opens the inline editor
  // on the new row so the operator can immediately set parameters.
  function handleAddAction(action) {
    const newStep = freshStepForAction(action)
    const next = renumber([...steps, newStep])
    updateSteps(next)
    setEditingId(next[next.length - 1].id)
    setShowAddPanel(false)
  }

  // Context-menu actions are id-based so they're resilient to a
  // concurrent reorder happening between right-click and selection.
  function runContextAction(id, action) {
    const idx = steps.findIndex((s) => s.id === id)
    if (idx < 0) return
    switch (action) {
      case 'edit':       setEditingId(id); break
      case 'rename':     setSelectedId(id); addToast('Click the step name to rename it', 'info'); break
      case 'add_above': {
        const newStep = freshStepForAction('move_joint')
        const next = renumber([...steps.slice(0, idx), newStep, ...steps.slice(idx)])
        updateSteps(next)
        setEditingId(next[idx].id)
        break
      }
      case 'add_below': {
        const newStep = freshStepForAction('move_joint')
        const next = renumber([...steps.slice(0, idx + 1), newStep, ...steps.slice(idx + 1)])
        updateSteps(next)
        setEditingId(next[idx + 1].id)
        break
      }
      case 'copy': {
        const src = steps[idx]
        const copy = {
          ...src,
          label: (src.label || src.action) + ' (copy)',
          taught: false,
          taught_joints: undefined,
          taught_tcp: undefined,
          taught_at: undefined,
        }
        const next = renumber([...steps.slice(0, idx + 1), copy, ...steps.slice(idx + 1)])
        updateSteps(next)
        break
      }
      case 'resume':
        addToast('Resume-from-step requires a backend handler — not yet wired', 'warning')
        break
      case 'delete':
        handleDelete(id)
        break
      default: break
    }
  }

  function handleDelete(id) {
    updateSteps(renumber(steps.filter((s) => s.id !== id)))
  }

  function handleRename(id, newLabel) {
    updateSteps(renumber(steps.map((s) => s.id === id ? { ...s, label: newLabel } : s)))
  }

  function handleEditSave(id, patch) {
    updateSteps(renumber(steps.map((s) => s.id === id ? { ...s, ...patch } : s)))
  }

  // Pull the live robot pose from /api/state and turn it into the
  // taught-position patch the step model expects.
  async function buildTaughtPatch() {
    let joints = [0, 0, 0, 0, 0, 0]
    let tcp    = null
    try {
      const res = await fetch('/api/state')
      if (res.ok) {
        const state = await res.json()
        joints = radiansToJointDegrees(state?.joints?.positions)
        if (Array.isArray(state?.tcp_pose)) tcp = state.tcp_pose
      }
    } catch { /* fall through to defaults */ }
    const patch = {
      taught:        true,
      taught_joints: joints,
      taught_tcp:    tcp,
      taught_at:     new Date().toISOString(),
      // Also overlay action-specific fields so an editor render shows
      // the taught pose without a separate "use taught" toggle.
      joints,
    }
    if (tcp) patch.position = tcp.slice(0, 3)
    return patch
  }

  // Individual Teach button on a step row → open the overlay for just
  // that step. The actual record happens via teachOverlayRecord when
  // the operator presses Record Position.
  function teachStep(id) {
    setTeachAllOrder([])
    setTeachAllPos(-1)
    setTeachSingleId(id)
  }

  // Teach All — snapshot the ordered list of step IDs that need
  // teaching and walk through them. The path stays fixed even if a
  // mid-walk record mutates `steps` (the rewrite happens via id, not
  // index).
  function startTeachAll() {
    const order = steps.filter((s) => isTeachable(s) && !s.taught).map((s) => s.id)
    if (order.length === 0) return
    setTeachSingleId(null)
    setTeachAllOrder(order)
    setTeachAllPos(0)
  }

  // Resolve the step the overlay is currently teaching (Teach All
  // path OR single-step path). Returns null when no overlay is open.
  function teachOverlayStep() {
    if (teachSingleId != null) {
      return steps.find((s) => s.id === teachSingleId) || null
    }
    if (teachAllPos >= 0 && teachAllPos < teachAllOrder.length) {
      const id = teachAllOrder[teachAllPos]
      return steps.find((s) => s.id === id) || null
    }
    return null
  }

  // Apply the just-jogged pose to the overlay's current step.
  async function teachOverlayRecord() {
    const target = teachOverlayStep()
    if (!target) return
    const patch = await buildTaughtPatch()
    // Teaching a derived step (descend / lift / "above") promotes it
    // to an override — the executor will then prefer this taught_tcp
    // over base+offset. Reset-to-auto clears it.
    if (target.derived_from) patch.overridden = true
    updateSteps(renumber(steps.map((s) => s.id === target.id ? { ...s, ...patch } : s)))
    // Single-step flow: just close.
    if (teachSingleId != null) {
      setTeachSingleId(null)
      return
    }
    // Teach All: advance to next slot, close when done.
    const nextPos = teachAllPos + 1
    if (nextPos >= teachAllOrder.length) {
      setTeachAllOrder([])
      setTeachAllPos(-1)
    } else {
      setTeachAllPos(nextPos)
    }
  }

  // Skip → advance without recording (Teach All only — Skip button is
  // hidden in single-step mode where it would do the same thing as
  // Cancel).
  function teachOverlaySkip() {
    if (teachSingleId != null) { setTeachSingleId(null); return }
    const nextPos = teachAllPos + 1
    if (nextPos >= teachAllOrder.length) {
      setTeachAllOrder([])
      setTeachAllPos(-1)
    } else {
      setTeachAllPos(nextPos)
    }
  }

  function teachOverlayBack() {
    if (teachAllPos > 0) setTeachAllPos(teachAllPos - 1)
  }

  function teachOverlayCancel() {
    setTeachSingleId(null)
    setTeachAllOrder([])
    setTeachAllPos(-1)
  }

  async function handleSave() {
    if (saveStatus === 'saving') return
    const name = programName.trim() || 'Untitled Program'
    setSaveStatus('saving')
    try {
      // Preserve the full config block (gripper, pallet, motion profile,
      // etc.) — earlier versions of this save sent only name+steps,
      // which silently wiped pallet config on every edit-save cycle for
      // palletize programs.
      const payload = { name, steps }
      const cfg = currentProgram.config
      if (cfg && typeof cfg === 'object') payload.config = cfg
      if (currentProgram.description) payload.description = currentProgram.description
      if (Array.isArray(currentProgram.tags) && currentProgram.tags.length) payload.tags = currentProgram.tags
      if (currentProgram.cell_id) payload.cell_id = currentProgram.cell_id
      const body = JSON.stringify(payload)
      const res = await fetch(
        programId ? `/api/programs/${encodeURIComponent(programId)}` : '/api/programs',
        { method: programId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' }, body },
      )
      const data = await res.json().catch(() => ({}))
      if (res.ok && data && data.ok && data.program) {
        setCurrentProgram({ id: data.program.id, name: data.program.name || name, unsaved: false })
        // Mirror to backend STATE so the task runner sees the just-
        // saved program when the user clicks Run.
        setProgramSteps(steps)
        // Refresh the shared programs list so ProgramLibrary sees
        // the just-saved program WITHOUT waiting for its next
        // mount-fetch. The store throttles within 500 ms but
        // this is a force-refresh — the operator just changed
        // the backend, we want the cache current immediately.
        refreshPrograms?.()
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus(null), 2000)
      } else {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus(null), 3000)
      }
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus(null), 3000)
    }
  }

  // Anchor rect for the portal'd Load dropdown. The button lives
  // inside a flex toolbar with `overflowY: hidden`, which would clip
  // any absolutely-positioned popover. We render the panel through a
  // portal to document.body with position:fixed at the button's
  // screen coordinates so no ancestor overflow can cut it off, and
  // raise the z-index above other page chrome.
  const loadBtnRef = useRef(null)
  const [loadBtnRect, setLoadBtnRect] = useState(null)

  async function openLoadMenu() {
    // Diagnostic — if the dropdown ever fails to appear we want to
    // know whether the click reached this handler at all (the state
    // flip happens; the menu's clipping/z-index is the problem) vs.
    // some invisible overlay swallowing the click.
    console.log('[ProgramEditor] Load clicked — fetching /api/programs')
    if (loadBtnRef.current) {
      setLoadBtnRect(loadBtnRef.current.getBoundingClientRect())
    }
    try {
      const res = await fetch('/api/programs')
      const data = await res.json()
      setSavedPrograms(data.programs || [])
      console.log('[ProgramEditor] Loaded', (data.programs || []).length, 'saved programs')
    } catch (e) {
      console.warn('[ProgramEditor] /api/programs failed', e)
      setSavedPrograms([])
    }
    setShowLoadMenu(true)
  }

  // Keep the dropdown anchored if the layout shifts while it's open
  // (resize, scroll inside the toolbar).
  useEffect(() => {
    if (!showLoadMenu) return
    const update = () => {
      if (loadBtnRef.current) {
        setLoadBtnRect(loadBtnRef.current.getBoundingClientRect())
      }
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [showLoadMenu])

  async function loadProgram(id) {
    try {
      const res = await fetch(`/api/programs/${encodeURIComponent(id)}`)
      if (!res.ok) return
      const prog = await res.json()
      if (prog && Array.isArray(prog.steps)) {
        const ingest = renumber(prog.steps)
        setCurrentProgram({
          id:      prog.id || id,
          name:    prog.name || 'Untitled Program',
          steps:   ingest,
          unsaved: false,
          config:      (prog.config && typeof prog.config === 'object') ? prog.config : {},
          description: prog.description || '',
          tags:        Array.isArray(prog.tags) ? prog.tags : [],
          cell_id:     prog.cell_id || null,
        })
        setProgramSteps(ingest)
      }
    } catch { /* swallow */ }
    setShowLoadMenu(false)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div className="no-scrollbar" style={{
        padding: '12px 16px',
        paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', maxWidth: '100%', minWidth: 0,
        overflowX: 'auto', overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        boxSizing: 'border-box',
      }}>
        <input
          value={programName}
          onChange={(e) => setProgramName(e.target.value)}
          placeholder="Untitled Program"
          style={{
            fontSize: 14, fontWeight: 700, flex: 1, padding: '4px 8px',
            background: 'transparent', color: '#111',
            border: '1px solid transparent', borderRadius: 4, outline: 'none',
            minWidth: 0,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#2563EB'; e.currentTarget.style.background = '#fff' }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'transparent' }}
        />
        {unsaved && (
          <div title="Unsaved changes"
            style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
        )}
        <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>

        <button onClick={handleSave} disabled={!unsaved || saveStatus === 'saving'}
          style={{
            padding: '6px 14px', fontSize: 12, fontWeight: 600,
            background: saveStatus === 'saved' ? '#16A34A'
                      : saveStatus === 'error' ? '#DC2626'
                      : unsaved ? '#2563EB' : '#e5e7eb',
            color:      (unsaved || saveStatus) ? '#fff' : '#9ca3af',
            border: 'none', borderRadius: 6,
            cursor: (unsaved && saveStatus !== 'saving') ? 'pointer' : 'default',
            minWidth: 80, flexShrink: 0,
          }}>
          {saveStatus === 'saving' ? 'Saving…'
            : saveStatus === 'saved' ? 'Saved'
            : saveStatus === 'error' ? 'Error'
            : unsaved ? 'Save' : 'Saved'}
        </button>

        <div style={{ flexShrink: 0 }}>
          <button ref={loadBtnRef} onClick={openLoadMenu}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              background: '#f3f4f6', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
            }}>
            Load
          </button>
          {/* Portal'd dropdown — see LoadProgramsPanel below. The
              portal escapes the toolbar's overflow:hidden so the
              menu can render at full size, and we anchor with
              position:fixed at the button's screen coordinates. */}
          {showLoadMenu && createPortal(
            <LoadProgramsPanel
              anchorRect={loadBtnRect}
              programs={savedPrograms}
              onSelect={loadProgram}
              onDismiss={() => setShowLoadMenu(false)}
            />,
            document.body,
          )}
        </div>

        <button onClick={() => setCurrentProgram({
          id: null,
          name: 'New Program',
          steps: [],
          unsaved: true,
        })}
          title="Start a blank program — Save creates a new file"
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6,
            cursor: 'pointer', flexShrink: 0,
          }}>
          New Program
        </button>

        <button onClick={() => setShowWizard(true)}
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: '#2563EB', color: '#fff', border: 'none',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}>
          New Program Wizard
        </button>

        <button onClick={() => setShowPbd(true)}
          title="Generate a draft program from a demonstration video + voice narration"
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: '#7C3AED', color: '#fff', border: 'none',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}>
          Program from Demonstration
        </button>

        <button onClick={() => setLocked(!locked)}
          title={locked ? 'Unlock to edit steps, drag-reorder, and add/delete' : 'Lock the program so it can only be read or run'}
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600,
            background: locked ? '#DC2626' : '#f3f4f6',
            color:      locked ? '#fff'    : '#374151',
            border:     locked ? 'none'    : '1px solid #d1d5db',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}>
          {locked ? '🔒 Locked' : 'Lock'}
        </button>
      </div>

      {locked && (
        <div style={{
          padding: '8px 16px', background: '#fef2f2', borderBottom: '1px solid #fecaca',
          color: '#b91c1c', fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>🔒</span>
          <span style={{ flex: 1 }}>Editing locked — unlock to make changes</span>
          <button onClick={() => setLocked(false)} style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 700,
            background: '#fff', color: '#b91c1c',
            border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer',
          }}>Unlock</button>
        </div>
      )}

      <div style={{ padding: '8px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#6b7280' }}>PROGRESS</span>
        <div style={{ flex: 1, height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            width: (steps.length ? (doneCount / steps.length) : 0) * 100 + '%',
            height: '100%', background: '#2563EB', borderRadius: 2, transition: 'width 300ms',
          }} />
        </div>
        <span style={{ fontSize: 10, color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
          {doneCount} / {steps.length}
        </span>
      </div>

      {/* Untaught-positions banner — visible whenever any move step
          still needs to be taught. Disappears once everything's set. */}
      {untaughtCount > 0 && teachAllPos < 0 && teachSingleId == null && (
        <div style={{
          margin: '8px 12px 0', padding: '8px 12px', fontSize: 12,
          background: '#fef2f2', color: '#b91c1c',
          border: '1px solid #fecaca', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700 }}>
            {untaughtCount} position{untaughtCount > 1 ? 's' : ''} not taught
          </span>
          <span style={{ color: '#9ca3af', fontSize: 11 }}>
            — jog the robot, then click Teach on each step
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={startTeachAll}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 700,
              background: '#2563EB', color: '#fff',
              border: 'none', borderRadius: 5, cursor: 'pointer',
            }}>
            Teach All ({untaughtCount})
          </button>
        </div>
      )}

      <div
        // Clicking blank space inside the scroll area (not on a row)
        // clears the selection — file-manager style.
        onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null) }}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {steps.map((step, idx) => {
          const def = actionFor(step)
          const tagColor = TAG_COLORS[def.tag] || '#6b7280'

          // Belt-and-suspenders: never match a null/undefined editingId
          // against a missing step.id — that's the exact failure mode
          // that opened every editor at once when persisted steps had
          // no ids.
          if (typeof editingId === 'number' && typeof step.id === 'number' && editingId === step.id) {
            return (
              <StepEditor key={step.id} step={step} allSteps={steps}
                onSave={(patch) => handleEditSave(step.id, patch)}
                onClose={() => setEditingId(null)}
              />
            )
          }

          const runStatus  = statusOf(idx)
          const isActive   = runStatus === 'active'
          const isDone     = runStatus === 'done'
          const isSelected = selectedId === step.id
          const isDragging = dragId === step.id
          // Only show the insertion indicator if a drag is in progress
          // and we wouldn't be dropping onto ourselves.
          const indicator  = (dragId !== null && dragOverId === step.id && dragId !== step.id)
                              ? dragOverPos
                              : null

          return (
            <div key={step.id}>
              {indicator === 'before' && <InsertionBar />}

              <div
                draggable={!isActive && !locked}
                onClick={() => setSelectedId(step.id)}
                onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, id: step.id }) }}
                onDragStart={(e) => handleDragStart(e, step.id)}
                onDragOver={(e) => handleDragOver(e, step.id)}
                onDrop={(e) => handleDrop(e, step.id)}
                onDragEnd={handleDragEnd}
                style={{
                  display: 'flex', alignItems: 'center', gap: 16,
                  padding: '12px 16px', width: '100%',
                  marginBottom: 4, borderRadius: 8,
                  boxSizing: 'border-box',
                  // Selection wins over the live-task highlight so the
                  // user can always tell what they just clicked.
                  background: isDragging ? '#f1f5f9'
                            : isSelected ? '#eff6ff'
                            : isActive   ? '#f0fdf4'
                            : '#fff',
                  border: isDragging ? '1px solid #e5e7eb'
                        : isSelected ? '2px solid #2563EB'
                        : isActive   ? '1px solid #bbf7d0'
                        : '1px solid #e5e7eb',
                  cursor: isActive ? 'default' : 'grab',
                  opacity: isDragging ? 0.3 : 1,
                  transform: isDragging ? 'scale(0.97)' : 'scale(1)',
                  transformOrigin: 'left center',
                  transition: 'opacity 150ms, transform 150ms, background 100ms, border 100ms',
                }}>

              {/* LEFT — drag handle, step number, T/! indicator, action tag.
                  Fixed width so the MIDDLE column always starts at the same
                  X coordinate, keeping every title left-edge aligned
                  regardless of which optional sub-elements are present. */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                flexShrink: 0, flexGrow: 0, width: 220,
              }}>
                <div style={{ color: '#9ca3af', fontSize: 18, userSelect: 'none', lineHeight: 1, width: 14, textAlign: 'center', flexShrink: 0 }}>⋮⋮</div>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: isDone ? '#16A34A' : isActive ? '#2563EB' : '#e5e7eb',
                  color: isDone || isActive ? '#fff' : '#6b7280',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, flexShrink: 0,
                }}>
                  {isDone ? '✓' : (idx + 1)}
                </div>
                {/* Always reserve the T/! slot so the pill's X position is
                    the same on teachable and non-teachable rows. */}
                <div title={isTeachable(step)
                              ? (step.taught ? `Taught at ${step.taught_at || 'unknown'}` : 'Position not taught — click Teach')
                              : undefined}
                  style={{
                    width: 26, height: 26, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                    visibility: isTeachable(step) ? 'visible' : 'hidden',
                    background: step.taught ? '#f0fdf4' : '#fef2f2',
                    border:     step.taught ? '2px solid #16A34A' : '2px dashed #DC2626',
                    color:      step.taught ? '#16A34A' : '#DC2626',
                    fontSize: 11, fontWeight: 700,
                  }}>
                  {step.taught ? 'T' : '!'}
                </div>
                <span style={{
                  display: 'inline-block', flexShrink: 0,
                  minWidth: 70, textAlign: 'center', boxSizing: 'border-box',
                  fontSize: 11, fontWeight: 700, padding: '3px 8px',
                  borderRadius: 4, letterSpacing: '0.5px',
                  background: tagColor + '18', color: tagColor,
                }}>
                  {def.tag}
                </span>
              </div>

              {/* MIDDLE — title + detail line, fills the remaining width.
                  paddingLeft:16 sets the canonical title X coordinate;
                  every title row aligns to this edge. */}
              <div style={{
                flex: '1 1 0', minWidth: 0,
                display: 'flex', flexDirection: 'column', gap: 4,
                paddingLeft: 16,
              }}>
                {locked ? (
                  <div style={{
                    margin: 0, padding: 0, width: '100%', textAlign: 'left',
                    fontSize: 17, fontWeight: 500, color: '#111',
                    letterSpacing: '0.01em', lineHeight: 1.3,
                    wordBreak: 'break-word', whiteSpace: 'normal',
                  }}>
                    {step.label || def.label}
                  </div>
                ) : (
                  <EditableStepLabel
                    value={step.label || def.label}
                    onSave={(newLabel) => handleRename(step.id, newLabel)}
                  />
                )}
                <div style={{
                  display: 'flex', width: '100%',
                  justifyContent: 'space-between', alignItems: 'center',
                  gap: 12,
                }}>
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontSize: 13, color: '#6b7280',
                    wordBreak: 'break-word', whiteSpace: 'normal',
                  }}>
                    {detailLine(step, ioLabels)}
                  </span>
                  {isTeachable(step) && hasPositionData(step) && (() => {
                    const open = openPosData.has(step.id)
                    return (
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePosData(step.id) }}
                        style={{
                          flexShrink: 0,
                          fontSize: 12, color: '#6b7280',
                          textDecoration: 'none',
                          cursor: 'pointer', userSelect: 'none',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
                        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
                      >
                        {open ? '▾ Hide position data' : '▸ View position data'}
                      </a>
                    )
                  })()}
                </div>
                {isTeachable(step) && !step.taught && (
                  <div style={{ fontSize: 13, color: '#DC2626', fontWeight: 600 }}>
                    NOT TAUGHT
                  </div>
                )}
                {isTeachable(step) && openPosData.has(step.id) && (
                  <div style={{
                    marginTop: 2, padding: 8,
                    background: '#f3f4f6', border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 11, color: '#374151',
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {positionDataLines(step).length > 0
                      ? positionDataLines(step).map((line, i) => (
                          <div key={i}>{line}</div>
                        ))
                      : <div style={{ color: '#9ca3af' }}>No position recorded yet.</div>}
                  </div>
                )}
              </div>

              {/* RIGHT — Edit, Teach, Del */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                flexShrink: 0,
              }}>
                {!locked && (
                  isPalletDriven(step) ? (
                    <button onClick={(e) => {
                      e.stopPropagation()
                      console.log('[ProgramEditor] Pallet Edit button clicked')
                      setEditingPallet(true)
                    }}
                      title="Edit the program's pallet configuration (grid, spacing, fill order, taught corner/pick)."
                      style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                               background: '#eff6ff', color: '#2563EB',
                               border: '1px solid #bfdbfe', borderRadius: 5,
                               cursor: 'pointer', flexShrink: 0 }}>
                      Edit
                    </button>
                  ) : (
                    <button onClick={(e) => {
                      e.stopPropagation()
                      if (typeof step.id !== 'number') {
                        console.error('[ProgramEditor] Step has no numeric id — refusing to open editor', step)
                        return
                      }
                      console.log('[ProgramEditor] Edit button clicked id=' + step.id + ' (was editingId=' + editingId + ')')
                      setEditingId(step.id)
                    }}
                      style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                               background: '#eff6ff', color: '#2563EB',
                               border: '1px solid #bfdbfe', borderRadius: 5,
                               cursor: 'pointer', flexShrink: 0 }}>
                      Edit
                    </button>
                  )
                )}
                {!locked && isTeachable(step) && (
                  <button onClick={(e) => { e.stopPropagation(); teachStep(step.id) }}
                    title={step.taught ? 'Re-record this position from the current robot pose' : 'Record the current robot pose as this step\'s position'}
                    style={{
                      padding: '6px 14px', fontSize: 12, fontWeight: 600, flexShrink: 0,
                      background: step.taught ? '#f0fdf4' : '#eff6ff',
                      color:      step.taught ? '#16A34A' : '#2563EB',
                      border:     step.taught ? '1px solid #bbf7d0' : '1px solid #bfdbfe',
                      borderRadius: 5, cursor: 'pointer',
                    }}>
                    {step.taught ? 'Re-teach' : 'Teach'}
                  </button>
                )}
                {!locked && (
                  <button onClick={(e) => { e.stopPropagation(); if (!isActive) handleDelete(step.id) }}
                    disabled={isActive}
                    title={isActive ? 'Cannot delete the active step' : 'Delete step'}
                    style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                             background: '#fef2f2', color: '#DC2626',
                             border: '1px solid #fecaca', borderRadius: 5,
                             cursor: isActive ? 'not-allowed' : 'pointer', flexShrink: 0,
                             opacity: isActive ? 0.4 : 1 }}>
                    Del
                  </button>
                )}
              </div>
              {/* /RIGHT */}
              </div>
              {/* /outer row */}

              {indicator === 'after' && <InsertionBar />}
            </div>
          )
        })}

        {!locked && (showAddPanel ? (
          <div style={{
            margin: '4px 0', padding: 12,
            background: '#f8fafc', borderRadius: 8,
            border: '2px solid #e5e7eb',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#111', flex: 1 }}>Add Step</span>
              <button onClick={() => setShowAddPanel(false)} title="Close"
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                         fontSize: 16, color: '#9ca3af', padding: '2px 6px' }}>✕</button>
            </div>
            {STEP_CATEGORIES.map((cat) => (
              <div key={cat.name} style={{ marginBottom: 12 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: '#6b7280',
                  marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px',
                }}>{cat.name}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {cat.actions.map((s) => (
                    <button key={s.action} onClick={() => handleAddAction(s.action)}
                      style={{
                        padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6,
                        transition: 'all 100ms',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2563EB'; e.currentTarget.style.background = '#eff6ff' }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{s.label}</div>
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{s.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <button onClick={() => setShowAddPanel(true)} style={{
            width: '100%', padding: 12, marginTop: 4,
            background: '#fafafa', color: '#374151', fontSize: 13, fontWeight: 600,
            border: '2px dashed #d1d5db', borderRadius: 6, cursor: 'pointer',
          }}>
            + Add Step
          </button>
        ))}
      </div>

      <VoiceBar />

      {contextMenu && (
        <StepContextMenu
          x={contextMenu.x} y={contextMenu.y}
          items={(() => {
            const base = [
              { action: 'edit',      label: 'Edit step',         hint: 'E' },
              { divider: true },
              { action: 'add_above', label: 'Add step above',    hint: '+' },
              { action: 'add_below', label: 'Add step below',    hint: '+' },
              { divider: true },
              { action: 'copy',      label: 'Duplicate',         hint: '⌘D' },
              { action: 'rename',    label: 'Rename',            hint: 'F2' },
              { divider: true },
              { action: 'resume',    label: 'Resume from step',  hint: '▶' },
              { divider: true },
              { action: 'delete',    label: 'Delete',            hint: 'Del', danger: true },
            ]
            // When locked, only "Resume from step" remains actionable.
            return locked
              ? base.map((it) => it.divider ? it
                  : it.action === 'resume' ? it
                  : { ...it, disabled: true })
              : base
          })()}
          onAction={(action) => runContextAction(contextMenu.id, action)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {showWizard && (
        <ProgramWizard
          onClose={() => setShowWizard(false)}
          onSaved={(program) => {
            if (program) {
              const ingest = renumber(program.steps || [])
              setCurrentProgram({
                id:      program.id,
                name:    program.name || 'Untitled Program',
                steps:   ingest,
                unsaved: false,
              })
              setProgramSteps(ingest)
            }
            setShowWizard(false)
          }}
        />
      )}

      {showPbd && (
        <ProgramFromDemonstration
          onClose={() => setShowPbd(false)}
          onSaved={(program) => {
            if (program) {
              const ingest = renumber(program.steps || [])
              setCurrentProgram({
                id:      program.id,
                name:    program.name || 'Demonstration draft',
                steps:   ingest,
                unsaved: false,
              })
              setProgramSteps(ingest)
            }
            setShowPbd(false)
          }}
        />
      )}

      {editingPallet && (
        <PalletConfigEditor
          config={currentProgram.config || {}}
          onSave={(patch) => {
            // patch carries pallet / pallet_mode / source / speed_pct +
            // optional pick_tcp / place_tcp. Merge into program.config,
            // then regenerate the move_to_pallet + pallet loop steps
            // so the runtime motion reflects edited grid / spacing /
            // fill order. Taught poses on other steps stay intact.
            const nextConfig = {
              ...(currentProgram.config || {}),
              ...patch,
              operation: 'palletize',
            }
            // Mirror the typed pallet config back to the legacy
            // pallet_* answer keys so the wizard's Review path stays
            // consistent if the operator ever round-trips through it.
            if (patch.pallet) {
              nextConfig.pallet_rows           = patch.pallet.rows
              nextConfig.pallet_cols           = patch.pallet.cols
              nextConfig.pallet_layers         = patch.pallet.layers
              nextConfig.pallet_spacing_x_mm   = patch.pallet.spacing_x_mm
              nextConfig.pallet_spacing_y_mm   = patch.pallet.spacing_y_mm
              nextConfig.pallet_layer_height_mm = patch.pallet.layer_height_mm
              nextConfig.pallet_fill_order     = patch.pallet.fill_order
              nextConfig.pallet_approach_height_mm = patch.pallet.approach_height_mm
              nextConfig.pallet_retract_height_mm  = patch.pallet.retract_height_mm
            }
            const regen = regenerateMoveToPalletSteps(steps, patch.pallet, patch.pallet_mode)
            setCurrentProgram({
              config:  nextConfig,
              steps:   renumber(regen),
              unsaved: true,
            })
            addToast?.('Pallet config updated — Save to persist', 'success')
          }}
          onClose={() => setEditingPallet(false)}
        />
      )}

      {/* Fullscreen teach overlay — replaces the old inline blue banner.
          Open when an individual step's Teach button was clicked
          (teachSingleId set) OR a Teach All walk is in progress
          (teachAllPos ≥ 0). */}
      {(() => {
        const overlayStep = teachOverlayStep()
        if (!overlayStep) return null
        const isSingle = teachSingleId != null
        const currentN = isSingle ? 1 : teachAllPos + 1
        const totalM   = isSingle ? 1 : teachAllOrder.length
        return (
          <TeachOverlay
            step={overlayStep}
            currentN={currentN}
            totalM={totalM}
            canBack={!isSingle && teachAllPos > 0}
            onRecord={teachOverlayRecord}
            onSkip={teachOverlaySkip}
            onBack={teachOverlayBack}
            onCancel={teachOverlayCancel}
          />
        )
      })()}
    </div>
  )
}

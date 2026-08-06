import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useStore, CLIENT_ID } from '../store/useStore'
import ProgramWizard from './ProgramWizard'
import ProgramFromDemonstration from './ProgramFromDemonstration'
import { HoldButton } from './JogControls'
import { JogStopBanner, LiveMarginHUD } from './JogStopSurface'
import TeachLockBanner from './TeachLockBanner'
import NumericField from './NumericField'
import PalletFrameDiagram from './PalletFrameDiagram'
import { readPayload, PAYLOAD_UNSET_WARNING }
  from '../lib/payload'
import { computePayloadTruth } from '../lib/payloadTruth'
import { useIOPortmap, portmapLabels, portmapToOptions }
  from '../lib/ioPortmap'
import { isStepTaught, untaughtStepIds, hasFullTaughtPose, verbForStep,
         palletFrameStatus, firstUntaughtPalletRole, PALLET_ROLE_ORDER,
         TEACHABLE_ACTIONS, isTeachable, isDerivedOffsetMove }
  from '../lib/programTruth'
import { PALLET_ROLE_TO_FIELD, modeForRole, taughtCount,
         backFrom, advanceFrom, jumpTo }
  from '../lib/palletTeachSequence'
import { validatePalletFrameServer, findingsBlockingThisRecord }
  from '../lib/palletFrameValidator'
import { namedLoadError } from '../lib/loadOutcome'
import { computeProgramFindings } from '../lib/programFindings'
import { computeTeachingDebt, debtBannerLabel } from '../lib/teachingDebt'
import { stepIndexForLine, lineMapHonesty } from '../lib/runState'
import { useLineMap } from '../lib/useLineMap'
import { teachLayoutMetrics } from '../lib/teachLayout'
import { paletteLabelForAction, effectorDisplayName, effectorOf }
  from '../lib/effectorVocab'

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

// TEACHABLE_ACTIONS + isDerivedOffsetMove + isTeachable now live in
// lib/programTruth so the itinerary + row consult the SAME predicate
// (2026-07-31 unification, §396 audit). Imported at the top; local
// re-definitions were retired to close the fork that put non-pose
// steps like `detect` and `move_to_pallet` into Teach All queues.

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

// Actions that carry a taught position AND are eligible for the
// "reuse an earlier taught position" prompt. Non-motion steps
// (open_gripper, wait, set_io, detect, etc.) skip the prompt.
const REUSABLE_POSITION_ACTIONS = new Set([
  'move_home', 'move_joint', 'move_linear', 'approach', 'pick', 'place',
])

// Given the current step list and a candidate action, return the
// FIRST earlier step that (a) has the same `action` or (b) shares a
// `position_role` derived from the same intent (home ↔ move_home,
// pick ↔ pick, place ↔ place). The returned step is a valid source
// for `position_ref` — the reused step live-links to it rather than
// copying joints. Used by the add-step handler to offer the reuse
// prompt. Returns null when there is no earlier taught source.
function findPositionReuseSource(steps, action) {
  if (!REUSABLE_POSITION_ACTIONS.has(action)) return null
  // Role inferred from the candidate action.
  const roleFor = (a) => {
    if (a === 'move_home')  return 'home'
    if (a === 'pick')       return 'pick'
    if (a === 'place')      return 'place'
    return null
  }
  const wantAction = action
  const wantRole   = roleFor(action)
  for (const s of steps) {
    // Skip steps that themselves reuse someone else — chase to the
    // ORIGINAL taught source so the operator sees "same as step 2"
    // even when they add a fourth step and the third is a link.
    if (s.position_ref) continue
    const sameAction = s.action === wantAction
    const sameRole   = wantRole && s.position_role === wantRole
    if (!sameAction && !sameRole) continue
    // Only offer as source if the step actually carries pose data
    // OR is a home (home's pose is the fixed all-zeros default —
    // reuse is meaningful even before "teach").
    const isHome = wantRole === 'home' || sameRole === 'home' || sameAction && wantAction === 'move_home'
    const taughtJoints = Array.isArray(s.taught_joints) && s.taught_joints.length >= 6
    const taughtTcp    = Array.isArray(s.taught_tcp)    && s.taught_tcp.length >= 3
    if (!isHome && !taughtJoints && !taughtTcp) continue
    return s
  }
  return null
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

// isTeachable was moved to lib/programTruth (2026-07-31 unification).
// Imported at the top of this file so the row + itinerary + badges
// consume ONE predicate. Legacy type-only fallback dropped —
// ambiguous (`type: 'move'` covers detect / scan_* / move_to_pallet)
// and unnecessary now that saved programs always carry an action.

// Count steps that reference a named point via `point_name`. Powers
// the picker's per-point badge and the row's link chip suffix.
function countStepsUsingPoint(steps, pointName) {
  if (!pointName || !Array.isArray(steps)) return 0
  let n = 0
  for (const s of steps) if (s && s.point_name === pointName) n += 1
  return n
}

// Count steps that link to another step via ea64950 step-id refs
// (position_ref) or the older linked_to_step_id field. Includes the
// source step itself in the total so the badge reads intuitively as
// "3 steps share this pose" (source + 2 refs = 3).
function countStepsSharingStep(steps, srcStepId) {
  if (srcStepId == null || !Array.isArray(steps)) return 0
  let n = 0
  for (const s of steps) {
    if (!s) continue
    if (s.id === srcStepId) { n += 1; continue }
    if (s.position_ref === srcStepId) n += 1
    else if (s.linked_to_step_id === srcStepId) n += 1
  }
  return n
}

// Aggregate every taught position the operator can link to. Two
// source families sit alongside each other:
//   • kind:'step'  — a position-type step in this program with taught
//                    joints. Linking sets step.position_ref (matching
//                    the ea64950 home-reuse pattern, which was the
//                    only place this ever worked pre-fix).
//   • kind:'point' — an entry in program.points, populated by
//                    /api/programs/{id}/points (Points panel, voice,
//                    wizard). Linking sets step.point_name.
// Sorted by taught_at desc — most-recently-touched first. Steps that
// themselves reference another step are excluded to keep the source
// list pointing at ORIGINALS (chase-through is what the finder was
// already doing at line ~200 before this refactor).
function collectPositionSources(steps, points) {
  const out = []
  const program = { steps, points }
  if (Array.isArray(steps)) {
    for (const s of steps) {
      if (!s) continue
      if (s.position_ref != null || s.linked_to_step_id != null) continue
      if (!isTeachable(s, program)) continue
      if (!s.taught) continue
      const j = Array.isArray(s.taught_joints) ? s.taught_joints
              : Array.isArray(s.joints)        ? s.joints : null
      const t = Array.isArray(s.taught_tcp)    ? s.taught_tcp
              : Array.isArray(s.position)      ? s.position : null
      if (!Array.isArray(j) || j.length < 6) continue
      out.push({
        kind:      'step',
        id:        s.id,
        label:     s.label || null,
        action:    s.action || null,
        role:      s.position_role || null,
        joints:    j,
        tcp:       t,
        taught_at: s.taught_at || '',
        refs:      countStepsSharingStep(steps, s.id),
      })
    }
  }
  if (points && typeof points === 'object') {
    for (const [name, p] of Object.entries(points)) {
      if (!p || !Array.isArray(p.joints) || p.joints.length < 6) continue
      out.push({
        kind:      'point',
        name,
        label:     p.label || null,
        joints:    p.joints,
        tcp:       Array.isArray(p.tcp) ? p.tcp : null,
        taught_at: p.taught_at || '',
        refs:      countStepsUsingPoint(steps, name),
      })
    }
  }
  out.sort((a, b) => (b.taught_at || '').localeCompare(a.taught_at || ''))
  return out
}

// Compact joint summary for the picker rows — J1..J6 degrees, single
// line, monospace-friendly.
function pointJointsLine(joints) {
  if (!Array.isArray(joints) || joints.length < 6) return ''
  return joints.slice(0, 6)
    .map((v, i) => `J${i + 1}:${Number(v).toFixed(1)}°`).join('  ')
}

// Format a taught_at ISO timestamp as "just now / 3m / 2h / 4d" for
// the picker's most-recent-first list. Falls back to the raw string
// on parse failure so a hand-authored program's non-standard stamp
// still renders something meaningful.
function formatTaughtAgo(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso).slice(0, 19)
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 45)     return 'just now'
  if (secs < 90)     return '1 min ago'
  const mins = Math.round(secs / 60)
  if (mins < 60)     return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48)    return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
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
  // Match the main I/O page + dropdown format: "DO2 — Vacuum On" when
  // the operator has renamed the port, plain "DO2" otherwise.
  const ioName = (id) => {
    if (!id) return id
    const lab = ioLabels && ioLabels[id]
    return lab ? `${id} — ${lab}` : id
  }
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
//
// Uses hasFullTaughtPose from programTruth so only 6-element arrays
// count — partial arrays are malformed teach data and shouldn't be
// presented to the operator as if they were captured (2026-07-30
// audit #P1-3).
function hasPositionData(step) {
  if (!step) return false
  if (hasFullTaughtPose(step)) return true
  // Legacy taught_at breadcrumb (drawer shows just the timestamp) —
  // preserved so operators inspecting old programs can still see when
  // a pose WAS taught, even if the payload got corrupted since.
  if (step.taught_at) return true
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

// Editor-wide label map for the detail line (fed into detailLine's
// ioName helper). One fetch per editor mount via useIOPortmap; the
// helper walks plate + flange terminals and returns the operator
// assignments as { "DO2": "Vacuum On", ... }. Channels without a
// user label are omitted so ioName falls back to the raw id.
function useIOLabels() {
  const pm = useIOPortmap()
  return portmapLabels(pm)
}

// Dropdown for a step-editor I/O field. Uses the same /api/io/portmap
// source as the main I/O page so display, port set, and system-reserved
// exclusions all stay in lockstep with the hardware plate.
//   direction='output' → writable DOs (+ AOs when analog=true)
//   direction='input'  → readable DIs (+ AIs when analog=true)
// System-reserved DIs (modeSwitch, enableButton, flangeButton*) and
// SAFETY terminals are excluded. Flange DOs/DIs sort to the bottom
// with a "(flange)" suffix.
function IOPortSelector({ label, value, onChange, direction, analog }) {
  const portmap = useIOPortmap()
  const options = portmapToOptions(portmap, direction, { analog: Boolean(analog) })
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>{label}</div>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}
        style={{ ...selectStyle }}>
        <option value="">Not assigned</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>{p.display}</option>
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
// 2026-08-06 palletize completeness — the operator directive asks for
// an expandable read-only preview of the emitted cycle template on
// the move_to_pallet step. This component renders the 12/13-line
// per-cycle skeleton the codegen actually emits, plus a note about
// how the layer-shift works. It is NOT the real Lua — that lives on
// the driver — but the labels and ordering mirror the codegen 1:1
// (see program_ops.py::codegen_lua_from_program palletize branch).
function PalletExpansionPreview({ step, palletCfg }) {
  const grip = String(step?.gripper_type || 'vacuum').toLowerCase()
  const vacPort = step?.vacuum_port_do ?? palletCfg?.vacuum_port_do ?? 2
  const blowPort = (step?.blow_off_port_do ?? palletCfg?.blow_off_port_do ?? null)
  const blowPulse = Number(step?.blow_off_pulse_ms ?? palletCfg?.blow_off_pulse_ms ?? 300)
  const seal = Number(step?.seal_wait_ms ?? palletCfg?.seal_wait_ms ?? 500)
  const approach = Number(step?.approach_distance_mm ?? palletCfg?.approach_distance_mm ?? 50)
  const retract  = Number(step?.retract_distance_mm  ?? palletCfg?.retract_distance_mm  ?? 50)
  const margin   = Number(step?.safety_margin_mm     ?? palletCfg?.safety_margin_mm     ?? 50)
  const layerH   = Number(palletCfg?.layer_height_mm ?? 100)
  const rows   = Number(palletCfg?.rows ?? 1)
  const cols   = Number(palletCfg?.cols ?? 1)
  const layers = Number(palletCfg?.layers ?? 1)
  const capacity = Math.max(1, rows * cols * layers)
  const partCount = Math.max(1, Math.min(
    Number(palletCfg?.part_count ?? capacity),
    capacity))
  const pickTaught  = Array.isArray(step?.pick_approach_joints)  && step.pick_approach_joints.length === 6
  const placeTaught = Array.isArray(step?.place_approach_joints) && step.place_approach_joints.length === 6
  const rowSty = { display: 'flex', gap: 8, alignItems: 'baseline',
                   padding: '2px 6px', fontSize: 11,
                   fontFamily: 'var(--font-mono, monospace)',
                   color: '#0f172a' }
  const numSty = { color: '#94a3b8', minWidth: 24, textAlign: 'right' }
  const kindSty = { fontWeight: 700, color: '#0369A1', minWidth: 80 }
  const lines = [
    ['movJ',   `pick_approach — ${pickTaught ? 'taught' : `axis-offset ${approach}mm along -pick_tool_Z`}`],
    ['movL',   'linear-down → pick contact (fixed taught pose)'],
    ['setDO',  `vacuum ON  (DO${vacPort} = 1)`],
    ['wait',   `seal wait  (${seal} ms)`],
    ['movL',   `linear-up → pick_approach (retract ${retract}mm)`],
    ['movL',   `transit_Z above pick (layer L's transit_Z = slot_Z(L) + ${layerH}+${margin}mm)`],
    ['movL',   `traverse-over-slot at transit_Z (X,Y of slot[r,c,L])`],
    ['movL',   `place_approach — ${placeTaught ? `taught + layer×${layerH}mm lift` : `axis-offset ${approach}mm along -slot_tool_Z`}`],
    ['movL',   'linear-down → slot contact (place)'],
    ['setDO',  `vacuum OFF  (DO${vacPort} = 0)`],
  ]
  if (blowPort !== null && blowPort !== undefined && String(blowPort) !== '') {
    lines.push(['setDO', `blow-off pulse start (DO${blowPort} = 1)`])
    lines.push(['wait',  `blow-off pulse  (${blowPulse} ms)`])
    lines.push(['setDO', `blow-off pulse end   (DO${blowPort} = 0)`])
  }
  lines.push(['movL', `linear-up → place_approach (retract ${retract}mm)`])
  lines.push(['movL', `transit_Z above slot (over slot at transit_Z; ready for next cycle)`])
  return (
    <div
      data-testid="pallet-expansion-preview"
      style={{
        marginTop: 6, marginBottom: 4, marginLeft: 220,
        padding: '10px 12px',
        background: '#f8fafc',
        border: '1px dashed #cbd5e1', borderRadius: 6,
        fontSize: 11, color: '#334155',
      }}>
      <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700,
                    color: '#0f766e', letterSpacing: 0.4 }}>
        PER-CYCLE TEMPLATE  ·  {partCount} cycle(s) of {capacity} capacity
        · gripper={grip}
      </div>
      {lines.map(([kind, text], i) => (
        <div key={i} style={rowSty}>
          <span style={numSty}>{String(i + 1).padStart(2, ' ')}.</span>
          <span style={kindSty}>{kind}</span>
          <span>{text}</span>
        </div>
      ))}
      <div style={{ marginTop: 6, fontSize: 11, color: '#475569',
                    lineHeight: 1.4 }}>
        Rule B: transit_Z(layer) = slot_Z(layer) + {layerH} + {margin} mm
        along the frame normal. Because slot_Z rises by layer_height
        per layer, transit_Z rises with it — a layer-{Math.max(0, layers - 1)}
        placement approaches from above layer {Math.max(0, layers - 1)}
        and never dips to a lower layer's Z.
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: '#64748b',
                    fontStyle: 'italic' }}>
        Read-only inspection. Edit the boxed fields via the pallet
        Edit modal — this preview reflects the codegen 1:1 (see
        program_ops.py::codegen_lua_from_program palletize branch).
      </div>
    </div>
  )
}


function regenerateMoveToPalletSteps(steps, palletCfg, palletMode) {
  if (!Array.isArray(steps)) return steps
  const rows   = Number(palletCfg?.rows   ?? 4)
  const cols   = Number(palletCfg?.cols   ?? 4)
  const layers = Number(palletCfg?.layers ?? 1)
  const cycles = Math.max(1, rows * cols * layers)
  const mode   = palletMode === 'depalletize' ? 'depalletize' : 'palletize'
  // 2026-08-06 palletize completeness — the modal edits vacuum I/O
  // + transit + approach fields alongside grid/pitch. Mirror them
  // onto the move_to_pallet step so the codegen sees them the same
  // way the composer would have stamped them originally.
  const _fanOut = {}
  if (palletCfg?.vacuum_port_do !== undefined && palletCfg.vacuum_port_do !== null) {
    _fanOut.vacuum_port_do = Number(palletCfg.vacuum_port_do)
  }
  if (palletCfg?.blow_off_port_do === null) {
    _fanOut.blow_off_port_do = null
  } else if (palletCfg?.blow_off_port_do !== undefined) {
    const n = Number(palletCfg.blow_off_port_do)
    _fanOut.blow_off_port_do = Number.isFinite(n) ? n : null
  }
  if (palletCfg?.blow_off_pulse_ms !== undefined) {
    _fanOut.blow_off_pulse_ms = Number(palletCfg.blow_off_pulse_ms) || 300
  }
  if (palletCfg?.safety_margin_mm !== undefined) {
    _fanOut.safety_margin_mm = Number(palletCfg.safety_margin_mm) || 50
  }
  if (palletCfg?.seal_wait_ms !== undefined) {
    _fanOut.seal_wait_ms = Number(palletCfg.seal_wait_ms) || 500
  }
  if (palletCfg?.approach_distance_mm !== undefined) {
    _fanOut.approach_distance_mm = Number(palletCfg.approach_distance_mm) || 50
  }
  if (palletCfg?.retract_distance_mm !== undefined) {
    _fanOut.retract_distance_mm = Number(palletCfg.retract_distance_mm) || 50
  }
  if (palletCfg?.pick_approach_joints !== undefined) {
    _fanOut.pick_approach_joints = palletCfg.pick_approach_joints
  }
  if (palletCfg?.place_approach_joints !== undefined) {
    _fanOut.place_approach_joints = palletCfg.place_approach_joints
  }
  return steps.map((s) => {
    if (s?.action === 'move_to_pallet') {
      return { ...s, ..._fanOut, mode,
               pallet_phase: mode === 'palletize' ? 'place' : 'pick' }
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
// PARAMETERS: rows/cols/layers/spacing/fill order/heights/speed.
// Nothing about teaching lives here.
//
// 2026-07-30 cleanup: taught positions were removed from this
// modal. 2026-07-31 cleanup: the last vestige — a read-only frame-
// status chip strip + "Teach via Teach All →" button + legacy-
// migration notice — was also removed. Frame teach state is shown
// on the STEP ROW (badge + Teach/Re-teach); the legacy-migration
// nudge is now a program VALIDATION FINDING (info severity) so it
// clears when the operator re-teaches ④, not when they read a
// modal.
//
// The modal preserves any already-captured corner_tcp on save so
// legacy programs don't lose data when re-saved through here; the
// pallet_slots endpoint transparently migrates corner_tcp →
// corner_a_tcp at read time.
function PalletConfigEditor({ config, onSave, onClose }) {
  const initialMode = config?.pallet_mode === 'depalletize' ? 'depalletize' : 'palletize'
  const initialPallet = (config?.pallet && typeof config.pallet === 'object') ? config.pallet : {}
  const initialPlace  = (config?.pallet_place && typeof config.pallet_place === 'object') ? config.pallet_place : {}
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
  // 2026-08-06 palletize completeness — vacuum I/O + rule-A approach.
  // Sourced from move_to_pallet step (composer-stamped from io_map);
  // reads through initialPallet AND from the step if present, so the
  // modal shows what the codegen will use.
  const _stepMTP = Array.isArray(config?.__steps)
    ? config.__steps.find((s) => s?.action === 'move_to_pallet')
    : null
  const _initApproachDist  = Number(initialPallet.approach_distance_mm ?? _stepMTP?.approach_distance_mm ?? 50)
  const _initRetractDist   = Number(initialPallet.retract_distance_mm  ?? _stepMTP?.retract_distance_mm  ?? 50)
  const _initSafetyMargin  = Number(initialPallet.safety_margin_mm     ?? _stepMTP?.safety_margin_mm     ?? 50)
  const _initSealWaitMs    = Number(initialPallet.seal_wait_ms         ?? _stepMTP?.seal_wait_ms         ?? 500)
  const _initVacPort       = Number(initialPallet.vacuum_port_do       ?? _stepMTP?.vacuum_port_do       ?? 2)
  const _initBlowRaw       = initialPallet.blow_off_port_do !== undefined
                              ? initialPallet.blow_off_port_do
                              : _stepMTP?.blow_off_port_do
  const _initBlowPort      = _initBlowRaw === null || _initBlowRaw === undefined
                              ? '' : String(_initBlowRaw)
  const _initBlowPulseMs   = Number(initialPallet.blow_off_pulse_ms    ?? _stepMTP?.blow_off_pulse_ms    ?? 300)
  const _initPickApprJ     = Array.isArray(initialPallet.pick_approach_joints)
                              ? initialPallet.pick_approach_joints
                              : (Array.isArray(_stepMTP?.pick_approach_joints)
                                 ? _stepMTP.pick_approach_joints
                                 : null)
  const _initPlaceApprJ    = Array.isArray(initialPallet.place_approach_joints)
                              ? initialPallet.place_approach_joints
                              : (Array.isArray(_stepMTP?.place_approach_joints)
                                 ? _stepMTP.place_approach_joints
                                 : null)
  const [approachDist, setApproachDist] = useState(_initApproachDist)
  const [retractDist,  setRetractDist]  = useState(_initRetractDist)
  const [safetyMargin, setSafetyMargin] = useState(_initSafetyMargin)
  const [sealWaitMs,   setSealWaitMs]   = useState(_initSealWaitMs)
  const [vacPort,      setVacPort]      = useState(_initVacPort)
  const [blowPort,     setBlowPort]     = useState(_initBlowPort)
  const [blowPulseMs,  setBlowPulseMs]  = useState(_initBlowPulseMs)
  const [pickApprJ,    setPickApprJ]    = useState(_initPickApprJ)
  const [placeApprJ,   setPlaceApprJ]   = useState(_initPlaceApprJ)
  // Current robot joints — snapshot on Teach click for the optional
  // pick_approach / place_approach poses. The teach model is intentionally
  // minimal: operator jogs the arm to the desired approach angle then
  // clicks Teach — we record joints from the store. Clear removes it
  // (codegen falls back to axis-offset default).
  const robotJoints = useStore((s) => s.robot?.joints)
  // 2026-08-06 (operator directive: part-count termination). N pick-
  // place cycles are emitted, one per part. Autofills from the PBD
  // demo's stated quantity when the composer set `pallet.part_count`;
  // otherwise defaults to capacity (all slots filled). Operator-
  // editable. Warn when > capacity → will be capped at capacity by
  // codegen; when < capacity → partial fill (fine, preferred over
  // empty cycles per operator doctrine).
  const _capacityInit = Math.max(1, Number(initialPallet.rows ?? 4)
                                   * Number(initialPallet.cols ?? 4)
                                   * Number(initialPallet.layers ?? 1))
  const [partCount,  setPartCount]  = useState(
    Number(initialPallet.part_count ?? _capacityInit))

  const cycles = Math.max(1, rows * cols * layers)
  const isDepal = mode === 'depalletize'
  const partCountWarning =
    !Number.isFinite(Number(partCount)) || Number(partCount) < 1
      ? 'Must be ≥ 1'
      : (Number(partCount) > cycles
         ? `${partCount} exceeds capacity ${cycles} — codegen will cap at ${cycles}`
         : (Number(partCount) < cycles
            ? `${partCount} of ${cycles} slots — top layer partial (fine)`
            : ''))

  function commit() {
    // Parameters-only patch. Preserve any 3-point taught frame +
    // legacy corner_tcp / pick_tcp / place_tcp values that already
    // sit on config — the modal no longer edits them, and re-
    // saving here MUST NOT discard operator-authored data.
    // Blow-off port: empty string = no pulse (null).
    const _blowRaw = String(blowPort).trim()
    const _blowNum = _blowRaw === '' ? null : Number(_blowRaw)
    const pallet = {
      ...initialPallet,                                   // preserve corner_tcp + anything else
      rows: Number(rows) || 1,
      cols: Number(cols) || 1,
      layers: Number(layers) || 1,
      spacing_x_mm: Number(spacingX) || 0,
      spacing_y_mm: Number(spacingY) || 0,
      layer_height_mm: Number(layerH) || 0,
      fill_order: fillOrder || 'row_lr',
      approach_height_mm: Number(approachH) || 0,
      retract_height_mm:  Number(retractH)  || 0,
      part_count: Math.max(1, Number(partCount) || 1),
      // 2026-08-06 palletize completeness — vacuum I/O + rule-A
      // approach + transit safety margin (fanned out onto the
      // move_to_pallet step by regenerateMoveToPalletSteps).
      approach_distance_mm: Math.max(0, Number(approachDist) || 0),
      retract_distance_mm:  Math.max(0, Number(retractDist)  || 0),
      safety_margin_mm:     Math.max(0, Number(safetyMargin) || 0),
      seal_wait_ms:         Math.max(0, Number(sealWaitMs)   || 0),
      vacuum_port_do:       Number.isFinite(Number(vacPort))
                             ? Number(vacPort) : 2,
      blow_off_port_do:     Number.isFinite(_blowNum) ? _blowNum : null,
      blow_off_pulse_ms:    Math.max(0, Number(blowPulseMs) || 0),
      pick_approach_joints:  pickApprJ,   // null or 6-el
      place_approach_joints: placeApprJ,
    }
    // pallet_place (schema-shape spec consumed by the taught-frame
    // math) also gets its grid fields updated but its taught frame
    // (corner_a_tcp / point_b_tcp / point_c_tcp / teach_mode) is
    // left intact.
    const palletPlace = {
      ...initialPlace,
      rows: Number(rows) || 1,
      cols: Number(cols) || 1,
      layers: Number(layers) || 1,
      pitch_row_mm: Number(spacingX) || 0,
      pitch_col_mm: Number(spacingY) || 0,
      layer_height_mm: Number(layerH) || 0,
      order: (fillOrder === 'col') ? 'col_major'
           : (fillOrder === 'snake') ? 'snake'
           : 'row_major',
    }
    onSave({
      pallet,
      pallet_place: palletPlace,
      pallet_mode: mode,
      source: mode === 'palletize' ? 'camera_library' : 'fixed_grid',
      speed_pct: Number(speed) || 60,
      // NOTE: pick_tcp / place_tcp intentionally NOT re-emitted —
      // the parent's config-spread preserves whatever is there.
    })
    onClose()
  }

  const fillOptions = [
    { value: 'row_lr', label: 'Rows (left → right)' },
    { value: 'row_rl', label: 'Rows (right → left)' },
    { value: 'col',    label: 'Columns (front → back)' },
    { value: 'snake',  label: 'Snake (alternate)' },
  ]

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
              <NumericField integer min={1} max={20} value={rows}
                onCommit={setRows} style={inputStyle} aria-label="Rows" />
            </Field>
            <Field label="Cols">
              <NumericField integer min={1} max={20} value={cols}
                onCommit={setCols} style={inputStyle} aria-label="Cols" />
            </Field>
            <Field label="Layers">
              <NumericField integer min={1} max={10} value={layers}
                onCommit={setLayers} style={inputStyle} aria-label="Layers" />
            </Field>
          </div>
          <div style={{ marginBottom: 6, fontSize: 11, color: '#0f766e', fontWeight: 600 }}>
            Total slots (capacity): {cycles}
          </div>

          {/* 2026-08-06 operator directive: part-count termination.
              N pick-place cycles emit for N available parts — partial
              top layer preferred over empty cycles. Autofilled from
              the PBD composer when it captures "5 holes"; otherwise
              defaults to capacity. */}
          <div style={{ marginBottom: 12 }}>
            <Field label={`Parts to place — number of pick-place cycles`}>
              <NumericField integer min={1} max={999} value={partCount}
                onCommit={setPartCount} style={inputStyle}
                aria-label="Part count" data-testid="pallet-part-count" />
            </Field>
            {partCountWarning && (
              <div style={{
                fontSize: 11,
                color: Number(partCount) > cycles ? '#B45309' : '#065F46',
                marginTop: -6,
              }}>
                {partCountWarning}
              </div>
            )}
          </div>

          {/* 2026-08-05 operator doctrine ruling: pitch is
              center-to-center between parts. Corners are the pallet's
              physical frame corners — corner-to-corner distance is
              geometric, not a derived pitch. Labels made explicit. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="Row pitch — center-to-center between parts (mm)">
              <NumericField integer min={0} value={spacingX}
                onCommit={setSpacingX} style={inputStyle} aria-label="Row pitch (mm)" />
            </Field>
            <Field label="Column pitch — center-to-center between parts (mm)">
              <NumericField integer min={0} value={spacingY}
                onCommit={setSpacingY} style={inputStyle} aria-label="Column pitch (mm)" />
            </Field>
            <Field label="Layer height (mm)">
              <NumericField integer min={0} value={layerH}
                onCommit={setLayerH} style={inputStyle} aria-label="Layer height" />
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
              <NumericField integer min={0} value={approachH}
                onCommit={setApproachH} style={inputStyle} aria-label="Approach height" />
            </Field>
            <Field label="Retract height (mm)">
              <NumericField integer min={0} value={retractH}
                onCommit={setRetractH} style={inputStyle} aria-label="Retract height" />
            </Field>
            <Field label="Speed (%)">
              <NumericField integer min={1} max={100} value={speed}
                onCommit={setSpeed} style={inputStyle} aria-label="Speed percent" />
            </Field>
          </div>

          {/* 2026-08-06 operator directive — palletize completeness.
              Approach distance = mm along the pose's OWN flange Z axis
              (rule A). Safety margin sizes the transit lift above the
              CURRENT layer (rule B — transit_Z rises per layer). */}
          <div style={{ marginTop: 12, marginBottom: 4,
                        fontSize: 11, fontWeight: 700,
                        color: '#0f766e', letterSpacing: 0.5 }}>
            APPROACH + TRANSIT
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                        gap: 10 }}>
            <Field label="Approach distance (mm) — along pose axis">
              <NumericField integer min={0} value={approachDist}
                onCommit={setApproachDist} style={inputStyle}
                aria-label="Approach distance mm"
                data-testid="pallet-approach-distance-mm" />
            </Field>
            <Field label="Retract distance (mm) — along pose axis">
              <NumericField integer min={0} value={retractDist}
                onCommit={setRetractDist} style={inputStyle}
                aria-label="Retract distance mm"
                data-testid="pallet-retract-distance-mm" />
            </Field>
            <Field label="Safety margin (mm) — transit clearance">
              <NumericField integer min={0} value={safetyMargin}
                onCommit={setSafetyMargin} style={inputStyle}
                aria-label="Safety margin mm"
                data-testid="pallet-safety-margin-mm" />
            </Field>
          </div>

          {/* Vacuum I/O — sourced from io_map defaults but editable per
              program. Blow-off is optional; blank = no pulse. */}
          <div style={{ marginTop: 12, marginBottom: 4,
                        fontSize: 11, fontWeight: 700,
                        color: '#0f766e', letterSpacing: 0.5 }}>
            VACUUM I/O
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr',
                        gap: 10 }}>
            <Field label="Vacuum DO port">
              <NumericField integer min={0} max={63} value={vacPort}
                onCommit={setVacPort} style={inputStyle}
                aria-label="Vacuum port DO number"
                data-testid="pallet-vacuum-port-do" />
            </Field>
            <Field label="Seal wait (ms)">
              <NumericField integer min={0} value={sealWaitMs}
                onCommit={setSealWaitMs} style={inputStyle}
                aria-label="Seal wait ms"
                data-testid="pallet-seal-wait-ms" />
            </Field>
            <Field label="Blow-off DO port (blank = none)">
              <input type="text" value={blowPort}
                onChange={(e) => setBlowPort(e.target.value.replace(/[^0-9]/g, ''))}
                style={inputStyle}
                aria-label="Blow-off port DO number"
                data-testid="pallet-blow-off-port-do" />
            </Field>
            <Field label="Blow-off pulse (ms)">
              <NumericField integer min={0} value={blowPulseMs}
                onCommit={setBlowPulseMs} style={inputStyle}
                aria-label="Blow-off pulse ms"
                data-testid="pallet-blow-off-pulse-ms" />
            </Field>
          </div>

          {/* Optional teachable approach poses (rule C). Operator jogs
              arm to the desired approach angle, clicks Teach — we
              snapshot robot.joints. Clear removes it → codegen falls
              back to the axis-offset default (rule A). Place approach
              is shifted per layer by layer_height. */}
          <div style={{ marginTop: 12, marginBottom: 4,
                        fontSize: 11, fontWeight: 700,
                        color: '#0f766e', letterSpacing: 0.5 }}>
            OPTIONAL TAUGHT APPROACH POSES (RULE C)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                        gap: 10, marginBottom: 6 }}>
            <Field label={pickApprJ
                    ? `Pick approach — taught (6 joints)`
                    : 'Pick approach — using axis-offset default'}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    const j = Array.isArray(robotJoints) && robotJoints.length === 6
                      ? robotJoints.map(Number)
                      : null
                    if (j) setPickApprJ(j)
                  }}
                  disabled={!(Array.isArray(robotJoints) && robotJoints.length === 6)}
                  data-testid="pallet-teach-pick-approach"
                  style={{ flex: 1, padding: '6px 10px', fontSize: 11,
                           fontWeight: 700,
                           background: pickApprJ ? '#065F46' : '#0369A1',
                           color: '#fff', border: 'none',
                           borderRadius: 4, cursor: 'pointer' }}>
                  {pickApprJ ? 'Re-teach pick approach' : 'Teach pick approach'}
                </button>
                {pickApprJ && (
                  <button onClick={() => setPickApprJ(null)}
                    data-testid="pallet-clear-pick-approach"
                    style={{ padding: '6px 10px', fontSize: 11,
                             background: '#fff', color: '#B91C1C',
                             border: '1px solid #B91C1C', borderRadius: 4,
                             cursor: 'pointer' }}>
                    Clear
                  </button>
                )}
              </div>
            </Field>
            <Field label={placeApprJ
                    ? 'Place approach — taught (6 joints, layer-shifted)'
                    : 'Place approach — using axis-offset default'}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    const j = Array.isArray(robotJoints) && robotJoints.length === 6
                      ? robotJoints.map(Number)
                      : null
                    if (j) setPlaceApprJ(j)
                  }}
                  disabled={!(Array.isArray(robotJoints) && robotJoints.length === 6)}
                  data-testid="pallet-teach-place-approach"
                  style={{ flex: 1, padding: '6px 10px', fontSize: 11,
                           fontWeight: 700,
                           background: placeApprJ ? '#065F46' : '#0369A1',
                           color: '#fff', border: 'none',
                           borderRadius: 4, cursor: 'pointer' }}>
                  {placeApprJ ? 'Re-teach place approach' : 'Teach place approach'}
                </button>
                {placeApprJ && (
                  <button onClick={() => setPlaceApprJ(null)}
                    data-testid="pallet-clear-place-approach"
                    style={{ padding: '6px 10px', fontSize: 11,
                             background: '#fff', color: '#B91C1C',
                             border: '1px solid #B91C1C', borderRadius: 4,
                             cursor: 'pointer' }}>
                    Clear
                  </button>
                )}
              </div>
            </Field>
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.4 }}>
            Teach captures the CURRENT arm joints as the approach pose.
            When taught, the arm moves LINEARLY from that angle onto the
            pick/place; when cleared, the codegen offsets back along the
            pose's own tool-Z axis by the approach distance above.
          </div>

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
                <NumericField step={0.001}
                  value={liveTcp ? Number(Number(liveTcp[i] ?? 0).toFixed(4)) : 0}
                  onCommit={(v) => updatePoseAxis(i, v)}
                  aria-label={lbl}
                  style={inputStyle} />
              </div>
            ))}
            {['Rx (rad)', 'Ry (rad)', 'Rz (rad)'].map((lbl, i) => (
              <div key={lbl}>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{lbl}</div>
                <NumericField step={0.01}
                  value={liveTcp ? Number(Number(liveTcp[i + 3] ?? 0).toFixed(4)) : 0}
                  onCommit={(v) => updatePoseAxis(i + 3, v)}
                  aria-label={lbl}
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
          <NumericField integer value={draft.width_mm ?? 85}
            onCommit={(v) => update('width_mm', v)} style={inputStyle}
            aria-label="Gripper width" />
        </Field>
      )}
      {actionDef.fields.includes('speed_pct') && (
        <Field label="Speed (%)">
          <NumericField integer min={1} max={100} value={draft.speed_pct ?? 80}
            onCommit={(v) => update('speed_pct', v)} style={inputStyle}
            aria-label="Speed percent" />
        </Field>
      )}
      {actionDef.fields.includes('force_pct') && (
        <Field label="Force (%)">
          <NumericField integer min={1} max={100} value={draft.force_pct ?? 50}
            onCommit={(v) => update('force_pct', v)} style={inputStyle}
            aria-label="Force percent" />
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
          <NumericField integer value={draft.offset_z_mm ?? 150}
            onCommit={(v) => update('offset_z_mm', v)} style={inputStyle}
            aria-label="Z offset (mm)" />
        </Field>
      )}
      {actionDef.fields.includes('descend_mm') && (
        <Field label="Descend (mm)">
          <NumericField integer value={draft.descend_mm ?? 130}
            onCommit={(v) => update('descend_mm', v)} style={inputStyle}
            aria-label="Descend (mm)" />
        </Field>
      )}
      {actionDef.fields.includes('position') && (
        <Field label="Position X, Y, Z (m)">
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 1, 2].map((i) => (
              <NumericField key={i} step={0.01}
                value={(draft.position || [0.3, -0.2, 0.4])[i]}
                onCommit={(v) => {
                  const pos = [...(draft.position || [0.3, -0.2, 0.4])]
                  pos[i] = v
                  update('position', pos)
                }}
                aria-label={['Position X', 'Position Y', 'Position Z'][i]}
                style={{ ...inputStyle, flex: 1 }} />
            ))}
          </div>
        </Field>
      )}
      {actionDef.fields.includes('joints') && (
        <Field label="Joint Angles (deg)">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[0, 1, 2, 3, 4, 5].map((j) => (
              <NumericField key={j} step={1}
                value={(draft.joints || [0, -90, 0, -90, 0, 0])[j]}
                onCommit={(v) => {
                  const jts = [...(draft.joints || [0, -90, 0, -90, 0, 0])]
                  jts[j] = v
                  update('joints', jts)
                }}
                placeholder={'J' + (j + 1)}
                aria-label={'J' + (j + 1)}
                style={{ ...inputStyle, width: 52, padding: '6px 4px', fontSize: 11, textAlign: 'center' }} />
            ))}
          </div>
        </Field>
      )}
      {actionDef.fields.includes('duration_s') && (
        <Field label="Duration (seconds)">
          <NumericField min={0} step={0.5} value={draft.duration_s ?? 1}
            onCommit={(v) => update('duration_s', v)} style={inputStyle}
            aria-label="Duration (seconds)" />
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
            <NumericField integer min={1} value={draft.goto ?? 1}
              onCommit={(v) => update('goto', v)} style={inputStyle}
              aria-label="Go to step" />
          </Field>
          <Field label="Repeat count (0=infinite)" style={{ flex: 1 }}>
            <NumericField integer min={0} value={draft.count ?? 0}
              onCommit={(v) => update('count', v)} style={inputStyle}
              aria-label="Repeat count" />
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
// `programCfg` is the program's config block — used to look up
// effector-aware labels via lib/effectorVocab so a freshly-added
// close_gripper on a vacuum program starts labeled "Engage vacuum",
// not the generic "Close Gripper" from ACTION_TYPES.
function freshStepForAction(action, programCfg = null) {
  const def = ACTION_TYPES.find((a) => a.value === action) || ACTION_TYPES[0]
  const effectorLabel = paletteLabelForAction(action, programCfg)
  const base = {
    action: def.value, type: def.type,
    label: effectorLabel || def.label,
    detail: '',
  }
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

// Modal shown when the operator adds a step whose position could
// reuse an earlier taught pose. Two-button choice — Use same (creates
// a linked reference via `position_ref`) or Teach new (independent
// pose that the operator will teach separately). Both close the modal;
// Cancel dismisses without adding a step.
function PositionReuseModal({ action, source, onUseSame, onTeachNew, onCancel }) {
  const kindLabel = action === 'move_home' ? 'Home'
                  : action === 'pick'      ? 'Pick'
                  : action === 'place'     ? 'Place'
                  : action === 'approach'  ? 'Approach'
                  : action === 'move_linear' ? 'Move Linear'
                  :                            'Move'
  const srcLabel = source?.label
                   || (source?.action === 'move_home' ? 'Home'
                       : source?.action || 'position')
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: '#111827',
          borderRadius: 12, width: '100%', maxWidth: 520,
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '16px 20px 8px 20px',
          borderBottom: '1px solid #E5E7EB',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280',
                        textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Add {kindLabel} step
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827',
                        marginTop: 4 }}>
            Use the same {kindLabel} position as Step {source?.id}?
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 6, lineHeight: 1.4 }}>
            &ldquo;{srcLabel}&rdquo; is already taught earlier in this program.
            Linking the new step shares the taught pose — re-teaching Step {source?.id}
            updates every linked step at once. Teach new gives you an
            independent position that you&rsquo;ll teach separately.
          </div>
        </div>
        <div style={{
          padding: '14px 20px 16px 20px',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button
            onClick={onCancel}
            style={{
              minHeight: 44, padding: '0 14px',
              background: 'transparent', color: '#6B7280',
              border: '1px solid #E5E7EB', borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onTeachNew}
            style={{
              minHeight: 44, padding: '0 14px',
              background: '#f3f4f6', color: '#111827',
              border: '1px solid #d1d5db', borderRadius: 8,
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Teach new
          </button>
          <button
            onClick={onUseSame}
            style={{
              minHeight: 44, padding: '0 18px',
              background: '#2563EB', color: '#fff',
              border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Use same as Step {source?.id}
          </button>
        </div>
      </div>
    </div>
  )
}

// Position picker — generalizes the ea64950 "same as Step N" prompt
// to every taught pose in the program. Two source families feed the
// list (see collectPositionSources): taught position-type steps and
// named entries in program.points. Linking is a SINGLE action;
// linkStepToSource decides which ref field to set based on the
// picked source's kind. Home's legacy "Use Step N home position"
// button on the row still works — it routes through this same
// linkStepToSource path.
function PositionPickerModal({
  step, steps, points,
  onLink, onDeletePoint, onRenamePoint, onClose,
}) {
  const [renamingName, setRenamingName] = useState(null)
  const [renameDraft, setRenameDraft]   = useState('')
  const [query, setQuery]               = useState('')

  const all = collectPositionSources(steps, points)
  const entries = all.filter((e) => {
    // Never offer THIS step's own position as a source — that would
    // create a self-reference. Applies only when the picker is
    // opened on a step-kind source.
    if (e.kind === 'step' && step?.id != null && e.id === step.id) return false
    if (!query) return true
    const q = query.toLowerCase()
    const hay = e.kind === 'step'
      ? `${e.label || ''} ${e.action || ''} ${e.role || ''}`.toLowerCase()
      : `${e.name} ${e.label || ''}`.toLowerCase()
    return hay.includes(q)
  })

  // The step's CURRENT link, in whatever family it lives.
  const currentRefId   = step?.position_ref ?? step?.linked_to_step_id ?? null
  const currentPointNm = step?.point_name || null

  function isCurrent(e) {
    if (e.kind === 'step')  return currentRefId   === e.id
    if (e.kind === 'point') return currentPointNm === e.name
    return false
  }
  function idFor(e) { return e.kind === 'step' ? `s${e.id}` : `p${e.name}` }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: '#111827',
          borderRadius: 12, width: '100%', maxWidth: 620,
          maxHeight: 'min(80vh, 720px)',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '16px 20px 12px 20px',
          borderBottom: '1px solid #E5E7EB',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280',
                        textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Link to taught position
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827',
                        marginTop: 4 }}>
            Step {step?.id != null ? step.id : ''}
            {step?.label ? <span style={{ color: '#6b7280', fontWeight: 500 }}>{' — '}{step.label}</span> : null}
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 6, lineHeight: 1.4 }}>
            Pick an existing taught position for this step. Re-teaching that
            position later updates every step that links to it.
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or label…"
            style={{
              marginTop: 10, width: '100%', boxSizing: 'border-box',
              padding: '8px 10px', fontSize: 13,
              border: '1px solid #d1d5db', borderRadius: 6, outline: 'none',
            }}
          />
        </div>

        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          padding: '4px 6px',
        }}>
          {entries.length === 0 ? (
            <div style={{
              padding: '28px 20px', textAlign: 'center',
              color: '#6b7280', fontSize: 13, lineHeight: 1.5,
            }}>
              {all.length === 0
                ? 'No taught positions in this program yet. Teach any step first — then every later step can link to it here.'
                : 'No positions match this filter.'}
            </div>
          ) : entries.map((e) => {
            const cur       = isCurrent(e)
            const canDelete = e.kind === 'point' && e.refs === 0
            const canRename = e.kind === 'point'
            const headline  = e.kind === 'step'
              ? (e.label || e.action || `Step ${e.id}`)
              : e.name
            const tagColor  = e.kind === 'step' ? '#0284c7' : '#4338ca'
            const tagBg     = e.kind === 'step' ? '#e0f2fe' : '#eef2ff'
            const tagBorder = e.kind === 'step' ? '#bae6fd' : '#c7d2fe'
            return (
              <div key={idFor(e)} style={{
                margin: '6px 8px', padding: 12,
                background: cur ? '#eff6ff' : '#fafafa',
                border:     cur ? '1px solid #93c5fd' : '1px solid #e5e7eb',
                borderRadius: 8,
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 800,
                    background: tagBg, color: tagColor,
                    border: `1px solid ${tagBorder}`,
                    borderRadius: 4, padding: '2px 6px',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    flexShrink: 0,
                  }}>{e.kind === 'step' ? `Step ${e.id}` : 'Point'}</span>
                  {renamingName === idFor(e) ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(evt) => setRenameDraft(evt.target.value)}
                      onKeyDown={(evt) => {
                        if (evt.key === 'Enter') {
                          const nn = renameDraft.trim()
                          if (nn && nn !== e.name) onRenamePoint(e.name, nn)
                          setRenamingName(null)
                        } else if (evt.key === 'Escape') {
                          setRenamingName(null)
                        }
                      }}
                      onBlur={() => setRenamingName(null)}
                      style={{
                        fontSize: 15, fontWeight: 700,
                        padding: '2px 8px', minWidth: 140,
                        border: '1px solid #2563EB', borderRadius: 4,
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <span style={{
                      fontSize: 15, fontWeight: 700, color: '#111827',
                      fontFamily: e.kind === 'point' ? 'var(--font-mono, monospace)' : undefined,
                    }}>{headline}</span>
                  )}
                  {e.kind === 'point' && e.label && renamingName !== idFor(e) && (
                    <span style={{ fontSize: 12, color: '#6b7280' }}>
                      &ldquo;{e.label}&rdquo;
                    </span>
                  )}
                  {e.kind === 'step' && e.role && (
                    <span style={{ fontSize: 11, color: '#6b7280',
                                   textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {e.role}
                    </span>
                  )}
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: 11, fontWeight: 600, color: '#4338ca',
                    background: '#eef2ff', border: '1px solid #c7d2fe',
                    borderRadius: 10, padding: '2px 8px',
                  }}>
                    {e.refs === 0 ? (e.kind === 'point' ? 'unused' : 'only this one')
                     : e.refs === 1 ? '1 step'
                     :                `${e.refs} steps`}
                  </span>
                  {e.taught_at && (
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>
                      taught {formatTaughtAgo(e.taught_at)}
                    </span>
                  )}
                </div>
                <div style={{
                  fontSize: 11, color: '#374151',
                  fontFamily: 'var(--font-mono, monospace)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {pointJointsLine(e.joints) || <span style={{ color: '#9ca3af' }}>no joint data</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  <button
                    onClick={() => { if (!cur) onLink(e) }}
                    disabled={cur}
                    style={{
                      padding: '6px 12px', fontSize: 12, fontWeight: 700,
                      background: cur ? '#dbeafe' : '#2563EB',
                      color:      cur ? '#1e3a8a' : '#fff',
                      border: 'none', borderRadius: 5,
                      cursor: cur ? 'default' : 'pointer',
                    }}
                  >
                    {cur ? '✓ Currently linked' : 'Link this step'}
                  </button>
                  {canRename && (
                    <button
                      onClick={() => { setRenamingName(idFor(e)); setRenameDraft(e.name) }}
                      style={{
                        padding: '6px 12px', fontSize: 12, fontWeight: 600,
                        background: '#f3f4f6', color: '#374151',
                        border: '1px solid #e5e7eb', borderRadius: 5, cursor: 'pointer',
                      }}
                    >Rename</button>
                  )}
                  {e.kind === 'point' && (
                    <button
                      onClick={() => { if (canDelete) onDeletePoint(e.name) }}
                      disabled={!canDelete}
                      title={canDelete ? 'Remove this taught position' : `${e.refs} step(s) still link to this position — unlink them first`}
                      style={{
                        padding: '6px 12px', fontSize: 12, fontWeight: 600,
                        background: canDelete ? '#fef2f2' : '#f9fafb',
                        color:      canDelete ? '#DC2626' : '#9ca3af',
                        border:     canDelete ? '1px solid #fecaca' : '1px solid #e5e7eb',
                        borderRadius: 5, cursor: canDelete ? 'pointer' : 'not-allowed',
                      }}
                    >Delete</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div style={{
          padding: '10px 20px 14px 20px',
          borderTop: '1px solid #E5E7EB',
          display: 'flex', justifyContent: 'flex-end', gap: 10,
        }}>
          <button
            onClick={onClose}
            style={{
              minHeight: 40, padding: '0 16px',
              background: 'transparent', color: '#6B7280',
              border: '1px solid #E5E7EB', borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
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
// TeachOverlay — fullscreen overlay for the "Teach All" and per-step
// Teach flows. Uses the SHARED HoldButton primitive from JogControls
// (WS transport, hold_id / seq refresh, 100 ms cadence, server-side
// keepalive with 300 ms deadman). The previous inline pendant fired
// setInterval(sendJog, 150) → discrete HTTP POSTs to /cmd/jog_cartesian
// with no hold_id → the driver treated each pulse as a fresh session
// and the freshness deadman stopped motion between them (the classic
// chatter symptom). Now routed through the same jogHold / jogRelease
// path the main Program-tab pendant uses.
//
// Styling matches the rest of the app: light theme, same button/panel
// tokens JogControls uses (white pads, #d1d5db borders, #374151 text).
// ────────────────────────────────────────────────────────

function radiansToDeg(positions) {
  if (!Array.isArray(positions)) return [0, 0, 0, 0, 0, 0]
  return positions.slice(0, 6).map((rad) => Number(((rad || 0) * 180 / Math.PI).toFixed(2)))
}

// Wraps HoldButton with the overlay pendant's larger sizing and the
// arrow SVG. Same identity-stable callback pattern the main
// JogControls's ArrowPad uses.
//
// 2026-08-05 fix — accepts jogStyle from the caller (drawer reads it
// from the shared store slice) AND wires onTap for STEP mode.
// Pre-fix the drawer's arrow buttons only fed the hold-refresh path
// and never provided onTap, so STEP mode was unreachable in teach
// flows and a fast tap either produced sustained motion (before the
// operator released) or nothing visible (server dead-man kicked in).
function OverlayJogArrow({
  jogStyle,
  onTap, onPressStart, onPressTick, onPressEnd,
  color, label, rotation, size = 140, svgSize = 60, disabled,
}) {
  return (
    <HoldButton
      jogStyle={jogStyle}
      onTap={onTap}
      onPressStart={onPressStart}
      onPressTick={onPressTick}
      onPressEnd={onPressEnd}
      color={color}
      width={size} height={size}
      disabled={disabled}>
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24"
           style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 4l-8 8h5v8h6v-8h5z" fill={color} />
      </svg>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>{label}</span>
    </HoldButton>
  )
}

function OverlayPadCenter({ label, width = 140, height = 140 }) {
  return (
    <div style={{
      width, height,
      background: '#f3f4f6', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, color: '#9ca3af',
    }}>{label}</div>
  )
}

// ────────────────────────────────────────────────────────
// RecordConfirmModal — confirms the current live pose before it's
// written into the step. The modal displays a live preview of the
// robot's pose (joints degrees + tcp) — the store's `joints` slice
// streams from /ws so the display refreshes as the arm moves; tcp
// polls /api/state at 500 ms cadence.
//
// The actual capture happens in teachOverlayRecord which re-reads
// /api/state at click time — so the pose the modal shows and the
// pose that lands in the step are the same value ± sub-second
// WS/HTTP lag. If the operator jogs while the dialog is open the
// preview updates; when they hit Record the CURRENT live pose is
// captured (not whatever was live at the moment the dialog opened).
//
// Overlay + card styling mirrors PositionReuseModal so the drawer
// stays visually consistent with the rest of the app's confirms.
// ────────────────────────────────────────────────────────
function RecordConfirmModal({ stepLabel, onConfirm, onCancel }) {
  const jointsRad = useStore((s) => s.joints?.positions) || [0, 0, 0, 0, 0, 0]
  const jointsDeg = radiansToJointDegrees(jointsRad)
  const [tcp, setTcp] = useState(null)
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/state')
        if (!res.ok) return
        const d = await res.json()
        if (alive && Array.isArray(d?.tcp_pose)) setTcp(d.tcp_pose)
      } catch { /* nop */ }
    }
    poll()
    const id = setInterval(poll, 500)
    return () => { alive = false; clearInterval(id) }
  }, [])
  const jointsLine = jointsDeg.slice(0, 6)
    .map((v, i) => `J${i + 1}:${Number(v).toFixed(2)}`).join('  ')
  const tcpKeys = ['x', 'y', 'z', 'rx', 'ry', 'rz']
  const tcpLine = Array.isArray(tcp)
    ? tcp.slice(0, 6).map((v, i) => `${tcpKeys[i]}:${Number(v).toFixed(3)}`).join('  ')
    : null
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', color: '#111827',
          borderRadius: 12, width: '100%', maxWidth: 560,
          boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '16px 20px 8px 20px',
          borderBottom: '1px solid #E5E7EB',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280',
                        textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Confirm capture
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827',
                        marginTop: 4 }}>
            Record this position?
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 6, lineHeight: 1.4 }}>
            Step: <span style={{ color: '#111827', fontWeight: 600 }}>{stepLabel}</span>.
            The pose shown below is the arm's live position — it updates as the
            arm moves. Pressing Record captures the CURRENT live pose.
          </div>
        </div>
        <div style={{ padding: '14px 20px' }}>
          <div style={{
            fontFamily: 'monospace', fontSize: 12, color: '#374151',
            background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6,
            padding: '10px 12px', lineHeight: 1.6, whiteSpace: 'pre-wrap',
          }}>
            joints: {jointsLine}
            {'\n'}
            tcp:    {tcpLine || '(awaiting live tcp…)'}
          </div>
        </div>
        <div style={{
          padding: '10px 20px 16px 20px',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button
            onClick={onCancel}
            style={{
              minHeight: 44, padding: '0 16px',
              background: 'transparent', color: '#6B7280',
              border: '1px solid #E5E7EB', borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              minHeight: 44, padding: '0 22px',
              background: '#16A34A', color: '#fff',
              border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Record
          </button>
        </div>
      </div>
    </div>
  )
}

// TeachOverlayDebugHUD (innerH/clientH/vv/drawer scrollH-clientH readout)
// removed 2026-08-05 per operator request — the tablet-drawer layout
// question landed in the 100dvh single-anchor fix (see the drawer's
// height:'100dvh' comment for the resolution) and the HUD was leftover
// instrumentation. Keep the drawerRef for a possible future re-add;
// current mounts do not use it.

function TeachOverlay({
  step, currentN, totalM, canBack,
  onRecord, onSkip, onBack, onCancel,
  diagram,
  counterSuffix = '',
  // 2026-08-04: read-only observer mode. When another device
  // owns the teach session, the overlay renders normally (so the
  // observer can watch badges fill live) but Record + Skip are
  // disabled. Jog is disabled by the banner-level gate elsewhere.
  recordDisabled = false,
  disabledReason = '',
  // 2026-08-05 (teach_lock_banner): the shared TeachLockBanner
  // rendered inside the overlay when another device owns the
  // session. Fixes the fork-1 defect where the fullscreen overlay
  // hid the editor tab's Take Over button.
  lockBanner = null,
}) {
  // Shared jog transport — WS-first with server-side hold keepalive.
  // Same store actions the main Program-tab JogControls uses; the old
  // (`s.jog` / `s.jogCartesian`) HTTP-pulse path was broken (s.jog is
  // undefined, jogCartesian sent discrete pulses that the driver's
  // 300 ms freshness deadman treated as start-stop chatter). See the
  // JogControls docstring for the full rationale.
  const jogHold          = useStore((s) => s.jogHold)
  const jogHoldCartesian = useStore((s) => s.jogHoldCartesian)
  const jogRelease       = useStore((s) => s.jogRelease)
  // 2026-08-05 unify: use the same STEP dispatch verbs the main
  // JogControls pendant uses so drawer/pendant/3D View behave
  // identically for tap-to-step.
  const jogIncrement      = useStore((s) => s.jogIncrement)
  const jogPulseCartesian = useStore((s) => s.jogPulseCartesian)
  // The shared Continuous/Step toggle (from useStore). CONTINUOUS is
  // the release default (2026-08-03 §2); STEP is a one-click switch
  // for fine positioning where "1mm button moves 1mm" matters.
  const jogStyleShared    = useStore((s) => s.jogStyle) || 'CONTINUOUS'
  const homeRobot    = useStore((s) => s.homeRobot)
  // Live joint stream + driver-computed limit/headroom. Joint mode
  // reads these to render the per-joint live angle + limit range +
  // proximity tint. Same slices JogControls (pendant/3D-view) uses so
  // the two views agree byte-for-byte on what the arm is doing.
  const joints        = useStore((s) => s.joints)
  const jointLimits   = useStore((s) => s.robot?.joint_limits)
  // 2026-08-04 (Lesson 165): the whole robot slice for the shared
  // JogStopBanner + LiveMarginHUD renderers. Zustand selector returns
  // the same reference across renders when the frame hasn't changed,
  // so this doesn't churn identity.
  const robot         = useStore((s) => s.robot)
  // Taught points on the currently-loaded program feed the optional
  // Match: selector. Purely display — no motion, no auto-move.
  const currentProgram = useStore((s) => s.currentProgram)
  // triggerEstop used to be pulled here for a red STOP button in the
  // drawer footer. The button was removed (redundant with TopBar's
  // global E-STOP, and inviting panic-taps mid-hold-to-jog). Motion
  // stopping remains release-to-stop + heartbeat deadman.

  const [jogMode, setJogMode] = useState('cartesian')
  const [stepSize, setStepSize] = useState(1.0)
  const [speed, setSpeed]       = useState(20)
  const [flash, setFlash]       = useState(false)
  // Optional Match: target — a taught-point name from the current
  // program whose joint values render as small grey targets under
  // each live angle. null (default) = no match; live angle uses the
  // stock proximity-tint palette. Explicit selection so the operator
  // opts in — nothing auto-tracks or auto-moves.
  const [matchName, setMatchName] = useState(null)
  // Any time the operator switches the target step / cancels, reset
  // the match so a stale target doesn't linger into the next teach.
  useEffect(() => { setMatchName(null) }, [step?.id, step?.point_name])
  // Confirm-before-record: opened by the footer Record Position
  // button; RecordConfirmModal fires doRecord() on confirm. Closed on
  // outside-click or Cancel; no capture happens on dismissal.
  const [confirming, setConfirming] = useState(false)
  // Drawer container ref — kept for possible future instrumentation
  // (e.g. re-adding the layout HUD gated behind ?debug=1). Currently
  // unused after the 2026-08-05 HUD removal; harmless.
  const drawerRef = useRef(null)
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

  // Hold callbacks that HoldButton feeds meta {hold_id, seq} into.
  // press-start AND every 100 ms tick send the same hold:true frame —
  // the driver interprets a hold with a matching hold_id as a refresh
  // (no restart); a hold_id change would be a new session.
  const holdStart = useCallback((axis, direction, meta) => {
    if (modeRef.current === 'joint') {
      return jogHold(axis, direction, speedRef.current, meta)
    }
    return jogHoldCartesian(axis, direction, speedRef.current, meta)
  }, [jogHold, jogHoldCartesian])
  const holdEnd = useCallback((meta) => {
    return jogRelease(modeRef.current, meta)
  }, [jogRelease])
  // 2026-08-05 unify — STEP-mode tap: one increment per tap. Mirrors
  // main JogControls.tap() (see JogControls.jsx:522) so drawer and
  // pendant agree byte-for-byte on the STEP dispatch. Joint uses
  // driver's time-boxed delta_deg path (angle-bounded, arm stops
  // exactly at the delta); Cartesian uses jogPulseCartesian's fixed
  // 150 ms mode:2 pulse (distance ≈ speed × 0.15 s; approximate but
  // matches pendant behavior).
  const tap = useCallback((axis, direction) => {
    if (modeRef.current === 'joint') {
      const deltaDeg = direction * stepRef.current
      jogIncrement(axis, deltaDeg)
    } else {
      jogPulseCartesian(axis, direction, speedRef.current)
    }
  }, [jogIncrement, jogPulseCartesian])
  // Wire helper: returns { onTap, onPressStart, onPressTick, onPressEnd }
  // for a given (axis, direction). identity stability comes from the
  // callbacks above. HoldButton fires onTap when jogStyle=='STEP',
  // and onPressStart/Tick/End when jogStyle=='CONTINUOUS'.
  const wire = useCallback((axis, direction) => ({
    jogStyle:     jogStyleShared,
    onTap:        () => tap(axis, direction),
    onPressStart: (meta) => holdStart(axis, direction, meta),
    onPressTick:  (meta) => holdStart(axis, direction, meta),
    onPressEnd:   (meta) => holdEnd(meta),
  }), [holdStart, holdEnd, tap, jogStyleShared])

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
  const stepInstruction = 'Jog the robot to the desired position, then press Record Position.'

  // Viewport-driven sizing. Width AND height both matter: a landscape
  // 1840×1080 tablet is not "tablet width" (fits desktop layout) yet
  // the vertical envelope after header+banner+Home bar+footer leaves
  // only ~640 px for the jog grid — desktop-size 140 px buttons
  // stacked 3-high plus gaps blows past that. Sizing therefore falls
  // back on whichever dimension is tighter. Tracking on state so
  // resize re-renders with the right metrics.
  const [vw, setVw] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth  : 1280))
  const [vh, setVh] = useState(() => (
    typeof window !== 'undefined' ? window.innerHeight : 800))
  useEffect(() => {
    const onResize = () => { setVw(window.innerWidth); setVh(window.innerHeight) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Layout budget arithmetic — shared with the pinned no-scroll
  // test at lib/teachLayout.js. Do NOT recompute inline here; the
  // pin exists precisely to catch drift between what renders and
  // what the test evaluates.
  const {
    isWide, isTabletW, padBtn, hideSectionLabels,
    svgPx, padGap, groupGap, modeBtnH, modeBtnFont,
    diagramPanelWidth,
  } = teachLayoutMetrics({ vw, vh })

  const modeBtn = (on) => ({
    padding: '0 26px', minHeight: modeBtnH, fontSize: modeBtnFont, fontWeight: 700,
    background: on ? '#2563EB' : '#fff',
    color:      on ? '#fff'    : '#374151',
    border:     on ? 'none'    : '1px solid #d1d5db',
    borderRadius: 8, cursor: 'pointer', flex: '0 0 auto',
  })

  // actionBtn() lived here for the (removed) STOP + Home row inside
  // the controls area. Home is now its own in-flow bar and STOP is
  // gone entirely — no callers left. Deleted.

  // M and N are 1-based per the spec.
  const progressPct = totalM > 0 ? ((currentN - 1) / totalM) * 100 : 0

  // Match: selector menu. Enumerate the current program's taught
  // points, sorted by taught_at so the list reads in the order the
  // operator built the program (most-recent last matches muscle
  // memory). Exclude the point currently being (re-)taught — matching
  // to your own step would compare to a stale snapshot of itself.
  const matchablePoints = (() => {
    const pts = currentProgram?.points || {}
    const excludeName = step?.point_name || null
    const out = []
    for (const [name, p] of Object.entries(pts)) {
      if (name === excludeName) continue
      if (!Array.isArray(p?.joints) || p.joints.length < 6) continue
      out.push({ name, label: p?.label || name, joints: p.joints, taught_at: p?.taught_at || 0 })
    }
    out.sort((a, b) => (a.taught_at || 0) - (b.taught_at || 0))
    return out
  })()
  const matchPoint = matchName
    ? matchablePoints.find((p) => p.name === matchName) || null
    : null
  const showMatchSelector = jogMode === 'joint' && matchablePoints.length > 0

  // Vertical budget check: drop the limits line when the tablet layout
  // is tight (same threshold that already hides the "Position/Height/
  // Rotation" section labels in Cartesian mode). Live angle NEVER
  // drops — that's the operator's primary readout during matching.
  const showJointLimits = !hideSectionLabels

  return (
    <div ref={drawerRef} style={{
      // Anchor the drawer to the visible viewport with a plain
      // `100dvh`. Chromium 108+ (the tablet's Android Chrome) resolves
      // dvh against the CURRENT visible viewport — URL bar showing OR
      // collapsed — so the footer stays reachable in either state.
      // The earlier "vh with dvh maxHeight" pair drifted whenever the
      // two disagreed; a single dvh anchor is simpler and matches
      // what the operator sees. viewport-fit=cover in index.html
      // means bottom:0 is at the physical device edge; the footer's
      // own padding handles safe-area avoidance below.
      position: 'fixed', top: 0, left: 0, right: 0,
      height: '100dvh',
      zIndex: 1000,
      background: '#f8fafc', color: '#111827',
      display: 'flex', flexDirection: 'column',
      userSelect: 'none',
      overflowX: 'hidden',
    }}>
      {/* HEADER */}
      <div style={{
        height: 60, flexShrink: 0,
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        display: 'flex', alignItems: 'center',
        padding: isTabletW ? '0 14px' : '0 22px',
        gap: 16,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#6b7280', letterSpacing: '0.04em' }}>
            TEACHING  •  Step {currentN} of {totalM}{counterSuffix}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#111827', marginTop: 2 }}>
            {stepLabel}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {/* Move to home — top-right beside Cancel. Same store action
            + safety gates as the pendant's Home; the previous
            full-width bar between the grid and the footer was
            reclaiming a whole row of tablet vertical space for a
            secondary action. Compact chip is enough. */}
        <button onClick={homeRobot}
          style={{
            minHeight: 44, padding: '0 14px',
            fontSize: 14, fontWeight: 600,
            background: '#fff', color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
          }}>
          ⌂ Move to home
        </button>
        <button onClick={onCancel}
          style={{
            minHeight: 44, minWidth: 64, padding: '0 16px',
            fontSize: 14, fontWeight: 600,
            background: 'transparent', color: '#6b7280',
            border: 'none', cursor: 'pointer',
          }}>
          Cancel
        </button>
      </div>

      {/* 2026-08-05 (teach_lock_banner): sit the lock banner ABOVE
          the instruction band so it's the first thing the operator
          sees on entry to a locked session. Renders only when the
          caller passed a `lockBanner` slot (empty otherwise). */}
      {lockBanner}

      {/* INSTRUCTION BAND */}
      <div style={{
        height: 48, flexShrink: 0,
        background: '#eff6ff', borderBottom: '1px solid #bfdbfe',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 22px',
      }}>
        <div style={{ fontSize: 15, color: '#1e40af', textAlign: 'center' }}>
          {stepInstruction}
        </div>
      </div>

      {/* 2026-08-04 (Lesson 165) — driver-initiated stop cause + live
          joint-margin HUD, rendered on the teach overlay via the shared
          canonical components. Fork registry: `jog_stop_cause_propagation`. */}
      <div style={{ padding: '8px 22px 0 22px', flexShrink: 0 }}>
        <JogStopBanner robot={robot} />
        <LiveMarginHUD robot={robot} />
      </div>

      {/* Passive frame-warning banner retired (§465 fork-1 kill,
          2026-08-04). Findings surface via toast at (a) Record —
          via palletTeachRecord's call to validatePalletFrameServer —
          and (b) teach-complete / handleSave, never as a passive
          overlay against mid-re-teach state. */}

      {/* JOG + DIAGRAM ROW — flex-row so the diagram docks BESIDE
          the jog pads, not above them. Keeps every jog button + the
          footer's Record Position visible without scroll at 1920×1080,
          1366×768, and the ONN tablet's landscape resolution — the
          operator-rule invariant. Diagram omitted → jog area takes
          the full width (non-pallet steps: layout unchanged). */}
      <div
        data-testid="teach-body-row"
        style={{
          flex: 1, minHeight: 0,
          display: 'flex', flexDirection: 'row',
          overflow: 'hidden',
        }}>
      {/* JOG CONTROLS — no internal scroll (mid-hold scrolling on a
          touch device is how accidental jogs happen), no vertical
          centering (justify-center + tall content clips off the TOP
          of the container in some engines). Content sits top-aligned
          and the height-responsive padBtn above guarantees fit. */}
      <div style={{
        flex: 1, minWidth: 0, minHeight: 0,
        background: '#f8fafc',
        display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-start', alignItems: 'center',
        padding: isTabletW ? 12 : 20, gap: isTabletW ? 12 : 16,
        overflow: 'hidden',
      }}>
        {/* Mode toggle row. When Joint mode is active and the program
            has taught points, an inline Match: selector appears at the
            right — pick a taught position and its joint values render
            as small grey targets under each live angle, live angle
            tints green within 0.5°. No motion; pure display. */}
        <div style={{
          flex: '0 0 auto',
          display: 'flex', gap: 12, alignItems: 'center',
          width: '100%', justifyContent: 'space-evenly',
        }}>
          <button onClick={() => setJogMode('cartesian')} style={modeBtn(jogMode === 'cartesian')}>XYZ</button>
          <button onClick={() => setJogMode('joint')}     style={modeBtn(jogMode === 'joint')}>Joint</button>
          <button disabled title="Tool frame jogging requires URDF — coming soon"
            style={{ ...modeBtn(false), opacity: 0.45, cursor: 'not-allowed' }}>Tool</button>
          {showMatchSelector && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginLeft: 8, flex: '0 0 auto',
            }}>
              <label style={{
                fontSize: 13, color: '#374151', fontWeight: 600,
              }}>Match:</label>
              <select
                value={matchName || ''}
                onChange={(e) => setMatchName(e.target.value || null)}
                style={{
                  minHeight: modeBtnH, fontSize: 14,
                  padding: '0 10px', borderRadius: 8,
                  border: '1px solid #d1d5db', background: '#fff',
                  color: '#111827', cursor: 'pointer',
                  maxWidth: 220,
                }}
              >
                <option value="">— none —</option>
                {matchablePoints.map((p) => (
                  <option key={p.name} value={p.name}>{p.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Speed + step row */}
        <div style={{
          flex: '0 0 auto',
          width: '100%',
          display: 'flex', alignItems: 'center', gap: 18,
          justifyContent: 'space-evenly', flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#6b7280' }}>Step:</span>
            {[0.1, 0.5, 1, 5, 10].map((s) => (
              <button key={s} onClick={() => setStepSize(s)} style={{
                padding: '10px 14px', minHeight: 44,
                fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                background: stepSize === s ? '#2563EB' : '#fff',
                color:      stepSize === s ? '#fff'    : '#374151',
                border:     stepSize === s ? 'none'    : '1px solid #d1d5db',
              }}>{s}{jogMode === 'joint' ? '°' : 'mm'}</button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 240, maxWidth: 520 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Speed: {speed}%</div>
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
                {!hideSectionLabels && (
                  <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', marginBottom: 6 }}>Position</div>
                )}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                  gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                  gridTemplateAreas: '". up ." "left center right" ". down ."',
                  gap: padGap,
                }}>
                  <div style={{ gridArea: 'up' }}>    <OverlayJogArrow {...wire('y',  1)} rotation={0}   label="Y+" color="#16A34A" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'left' }}>  <OverlayJogArrow {...wire('x', -1)} rotation={-90} label="X−" color="#DC2626" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'center' }}><OverlayPadCenter label="XY" width={padBtn} height={padBtn} /></div>
                  <div style={{ gridArea: 'right' }}> <OverlayJogArrow {...wire('x',  1)} rotation={90}  label="X+" color="#DC2626" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'down' }}>  <OverlayJogArrow {...wire('y', -1)} rotation={180} label="Y−" color="#16A34A" size={padBtn} svgSize={svgPx} /></div>
                </div>
              </div>
              <div style={{ flex: '0 1 auto' }}>
                {!hideSectionLabels && (
                  <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', marginBottom: 6 }}>Height</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: padGap, width: padBtn }}>
                  <OverlayJogArrow {...wire('z',  1)} rotation={0}   label="Z+" color="#3B82F6" size={padBtn} svgSize={svgPx} />
                  <OverlayJogArrow {...wire('z', -1)} rotation={180} label="Z−" color="#3B82F6" size={padBtn} svgSize={svgPx} />
                </div>
              </div>
              <div style={{ flex: '0 1 auto' }}>
                {!hideSectionLabels && (
                  <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', marginBottom: 6 }}>Rotation</div>
                )}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(3, ${padBtn}px)`,
                  gridTemplateRows:    `repeat(3, ${padBtn}px)`,
                  gridTemplateAreas: '". rxp ." "rzn center rzp" ". rxn ."',
                  gap: padGap,
                }}>
                  <div style={{ gridArea: 'rxp' }}>   <OverlayJogArrow {...wire('rx',  1)} rotation={0}   label="Rx+" color="#9333EA" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'rzn' }}>   <OverlayJogArrow {...wire('rz', -1)} rotation={-90} label="Rz−" color="#CA8A04" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'center' }}><OverlayPadCenter label="Rot" width={padBtn} height={padBtn} /></div>
                  <div style={{ gridArea: 'rzp' }}>   <OverlayJogArrow {...wire('rz',  1)} rotation={90}  label="Rz+" color="#CA8A04" size={padBtn} svgSize={svgPx} /></div>
                  <div style={{ gridArea: 'rxn' }}>   <OverlayJogArrow {...wire('rx', -1)} rotation={180} label="Rx−" color="#9333EA" size={padBtn} svgSize={svgPx} /></div>
                </div>
              </div>
            </>
          ) : (
            [1, 2, 3, 4, 5, 6].map((j) => {
              // Live angle: radians → degrees, one decimal. tabular-
              // nums keeps digits from jittering at 25 Hz.
              const posRad = joints?.positions?.[j - 1]
              const angleDeg = Number.isFinite(posRad)
                ? (posRad * 180 / Math.PI) : null
              // Driver-computed per-joint {limit_deg, headroom_deg}
              // — same slice JogControls (pendant/3D-view) reads.
              // Never hardcoded; if the driver hasn't broadcast yet
              // the limits line simply doesn't render.
              const jl = (jointLimits || []).find((x) => x?.joint === j)
              const limitDeg = Number.isFinite(jl?.limit_deg)
                ? jl.limit_deg : null
              const headroom = Number.isFinite(jl?.headroom_deg)
                ? jl.headroom_deg : null
              // Optional Match: target (small grey number under the
              // live angle). Green tint on the LIVE angle when within
              // 0.5° of the target — dial-to-green replaces the
              // photo-and-compare workflow.
              const targetDeg = matchPoint
                ? Number(matchPoint.joints?.[j - 1]) : null
              const hasTarget  = Number.isFinite(targetDeg)
              const matched    = hasTarget && angleDeg != null
                && Math.abs(angleDeg - targetDeg) <= 0.5
              // Proximity tint: red ≤3° headroom, amber ≤10°, green
              // when Match is on and within tolerance. Match-green
              // wins over headroom-amber because the operator's
              // active task is "hit the target"; approaching the
              // hardware limit is a background caution.
              let angleColor = '#111827'
              if (headroom != null) {
                if (headroom <= 3)       angleColor = '#DC2626'
                else if (headroom <= 10) angleColor = '#d97706'
              }
              if (matched) angleColor = '#16A34A'
              return (
                <div key={j} style={{
                  flex: '0 1 auto',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: padGap,
                }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#374151' }}>{'J' + j}</div>
                  <div style={{
                    fontSize: 18, fontWeight: 700, color: angleColor,
                    fontVariantNumeric: 'tabular-nums',
                    minHeight: 20, lineHeight: 1,
                  }}>
                    {angleDeg != null ? `${angleDeg.toFixed(1)}°` : '—'}
                  </div>
                  {hasTarget && (
                    <div style={{
                      fontSize: 12, fontWeight: 600,
                      color: matched ? '#16A34A' : '#9ca3af',
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: 1,
                    }}>
                      {`${targetDeg.toFixed(1)}°`}
                    </div>
                  )}
                  <OverlayJogArrow {...wire(j,  1)} rotation={0}   label={'+J' + j} color="#16A34A" size={padBtn} svgSize={svgPx} />
                  <OverlayJogArrow {...wire(j, -1)} rotation={180} label={'−J' + j} color="#DC2626" size={padBtn} svgSize={svgPx} />
                  {showJointLimits && limitDeg != null && (
                    <div style={{
                      fontSize: 11, color: '#9ca3af',
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap', lineHeight: 1,
                    }}>
                      {`−${limitDeg.toFixed(0)}° … +${limitDeg.toFixed(0)}°`}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

      </div>
      {/* DIAGRAM SIDE PANEL — docked right of the jog pads. Width
          responsive: 300px on wide desktop, 240px on tablet
          landscape (vw ≤ 1280). Panel is flex 0 0 auto so its width
          is fixed and the jog area gets exactly the remaining
          horizontal space. NEVER pushes any jog button below the
          viewport — the horizontal split does the work. */}
      {diagram && (
        <aside
          data-testid="pallet-diagram-side"
          style={{
            flex: `0 0 ${diagramPanelWidth}px`,
            minWidth: 0,
            background: '#fff',
            borderLeft: '1px solid #e5e7eb',
            padding: isTabletW ? '10px 12px' : '14px 16px',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'flex-start',
            overflow: 'hidden',
          }}>
          {diagram}
        </aside>
      )}
      </div>

      {/* STICKY FOOTER — Back (multi-pose only) + Record Position
          + Skip (multi-pose only). Standard slim bar: 48 px button
          height, 8 px vertical padding, safe-area padding sized to
          just clear the Android gesture home indicator (~20 px on
          the ONN tablet) instead of the earlier 48-px-floor hero
          band that was consuming close to a quarter of the viewport.
          No motion-stop button here — motion stopping is release-to-
          stop + the driver's 300 ms deadman + TopBar's global E-STOP.
          Progress bar is pinned to the very bottom of this row. */}
      {/* 3-column grid keeps Record Position horizontally centered
          regardless of whether Back / Skip are present. Left cell:
          Back or empty. Center: Record Position (self-justified to
          center). Right: Skip or empty. Column widths are fluid but
          the outer two are min-content — the center gets the natural
          center of the whole row. */}
      <div style={{
        flexShrink: 0,
        background: '#fff', borderTop: '1px solid #e5e7eb',
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        padding: '8px 16px',
        // Safe-area floor of 12 px is enough for the Android gesture
        // indicator on the target tablet; iOS notched devices' larger
        // env value takes over via the max().
        paddingBottom: 'calc(max(env(safe-area-inset-bottom, 0px), 12px) + 8px)',
        columnGap: 10,
        position: 'relative',
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          {canBack && (
            <button onClick={onBack} style={{
              height: 48, padding: '0 16px',
              fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
            }}>← Back</button>
          )}
        </div>

        <button
          data-testid="teach-record-position"
          disabled={recordDisabled}
          title={recordDisabled ? disabledReason : undefined}
          onClick={() => { if (!recordDisabled) setConfirming(true) }}
          onTouchStart={(e) => { e.preventDefault() }}
          onTouchEnd={(e) => {
            e.preventDefault()
            if (!recordDisabled) setConfirming(true)
          }}
          style={{
            height: 48,
            padding: '0 24px',
            fontSize: 15, fontWeight: 700, letterSpacing: '0.3px',
            background: recordDisabled ? '#e5e7eb'
                      : flash ? '#fff' : '#16A34A',
            color:      recordDisabled ? '#9ca3af'
                      : flash ? '#16A34A' : '#fff',
            border: flash ? '2px solid #16A34A' : 'none',
            borderRadius: 8,
            cursor: recordDisabled ? 'not-allowed' : 'pointer',
            transition: 'background 100ms, color 100ms',
            justifySelf: 'center',
          }}>
          {recordDisabled ? 'Record disabled — observing'
            : flash ? '✓ Recorded' : 'Record Position'}
        </button>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {totalM > 1 && (
            <button onClick={onSkip} style={{
              height: 48, padding: '0 16px',
              fontSize: 14, fontWeight: 600,
              background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
            }}>Skip this pose →</button>
          )}
        </div>

        {/* Progress bar pinned to the very bottom */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: 4, background: '#e5e7eb',
        }}>
          <div style={{
            height: '100%', width: progressPct + '%',
            background: '#2563EB', transition: 'width 200ms',
          }} />
        </div>
      </div>

      {confirming && (
        <RecordConfirmModal
          stepLabel={stepLabel}
          onConfirm={() => { setConfirming(false); doRecord() }}
          onCancel={()  => { setConfirming(false) }}
        />
      )}
    </div>
  )
}

// Editable "Tool & Payload" section — 2026-07-31 rewrite.
//
// * COLLAPSED by default; chevron opens.
// * When unset, the collapsed header still surfaces the amber
//   "Payload not set" chip so the operator sees the problem
//   without having to open the section.
// * Body: MASS + CoG only. The "Tool name (optional)" text field
//   was retired (see lib/payload — tool_name isn't read anywhere
//   operator-facing anymore).
// * The old "Info only" fine-print banner was replaced by a LIVE
//   truth line comparing program payload to the controller's
//   active preset (lib/payloadTruth). Three states — match /
//   mismatch / unreadable — one line, color carries the nuance.
// * Values live under program.config.{payload_kg, payload_cog_mm}.
// * FUTURE — per-cycle payload emission at grip/release is
//   currently gated on the setPayload("") argument-format
//   stop-condition (see luaenginelib.json). When the format is
//   resolved, "declare carried mass at grip" becomes a codegen
//   emission and THIS panel becomes its source of truth.
function ToolAndPayloadSection({ program, onPatch, controllerPayloadKg }) {
  const payload = readPayload(program)
  // Collapsed by default per the 2026-07-31 directive. The chip
  // on the header carries enough signal that the operator can
  // decide whether to open it.
  const [expanded, setExpanded] = useState(false)
  const [showCog,  setShowCog]  = useState(
    !!(payload.cog_mm && (payload.cog_mm.x || payload.cog_mm.y || payload.cog_mm.z)))

  // Live truth line — reads the shared resolver so mismatch /
  // unreadable states show consistent copy across surfaces.
  const truth = computePayloadTruth({
    programKg: payload.kg,
    controllerKg: controllerPayloadKg,
  })

  const containerStyle = {
    margin: '10px 12px 0', padding: 0,
    border: `1px solid ${payload.isSet ? '#e5e7eb' : '#F59E0B'}`,
    background: payload.isSet ? '#fff' : '#FFFBEB',
    borderRadius: 8,
  }
  const headerStyle = {
    padding: '8px 12px',
    display: 'flex', alignItems: 'center', gap: 10,
    cursor: 'pointer', userSelect: 'none',
    borderBottom: expanded ? `1px solid ${payload.isSet ? '#e5e7eb' : '#F59E0B'}` : 'none',
  }
  const labelStyle = {
    fontSize: 12, fontWeight: 700, color: payload.isSet ? '#111827' : '#92400E',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  }
  const inputStyle = {
    padding: '4px 8px', fontSize: 13, fontWeight: 500,
    border: '1px solid #d1d5db', borderRadius: 5,
    background: '#fff', color: '#111827', width: 90, textAlign: 'right',
  }
  const smallInput = { ...inputStyle, width: 64 }
  const bodyStyle = { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }

  return (
    <div style={containerStyle} data-testid="payload-section"
         data-expanded={expanded ? '1' : '0'}>
      <div style={headerStyle} onClick={() => setExpanded((v) => !v)}>
        <span style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 150ms', color: '#6b7280', fontSize: 11 }}>▶</span>
        <span style={labelStyle}>Tool &amp; Payload</span>
        <div style={{ flex: 1 }} />
        {payload.isSet
          ? (
            <span
              data-testid="payload-chip-set"
              style={{
                fontSize: 12, fontWeight: 600, color: '#065F46',
                background: '#ECFDF5', border: '1px solid #059669',
                padding: '2px 10px', borderRadius: 999,
              }}>
              {payload.kg} kg
            </span>
          )
          : (
            <span
              data-testid="payload-chip-unset"
              style={{
                fontSize: 12, fontWeight: 700, color: '#92400E',
                background: '#FEF3C7', border: '1px solid #F59E0B',
                padding: '2px 10px', borderRadius: 999,
              }}>
              ⚠ Payload not set
            </span>
          )}
      </div>
      {expanded && (
        <div style={bodyStyle}>
          {/* Truth line — live program-vs-controller comparison.
              Green when they match, amber when they don't OR when
              we can't read the controller (never implies sync that
              doesn't exist). Replaces the retired "info only"
              banner. */}
          {(() => {
            const palette = truth.state === 'match'
              ? { bg: '#ECFDF5', border: '#059669', fg: '#065F46' }
              : { bg: '#FEF3C7', border: '#F59E0B', fg: '#92400E' }
            return (
              <div
                data-testid="payload-truth"
                data-state={truth.state}
                style={{
                  padding: '8px 10px',
                  background: palette.bg,
                  border: `1px solid ${palette.border}`,
                  borderRadius: 6,
                  fontSize: 12, color: palette.fg, lineHeight: 1.5,
                }}>
                {truth.message}
              </div>
            )
          })()}
          {/* Tool mass — the whole first-row input, now mass-only.
              The retired "Tool name (optional)" input lived here
              alongside the mass field; it was deleted 2026-07-31. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#374151', fontWeight: 600, minWidth: 120 }}>
              Tool mass (kg)
            </label>
            <input
              data-testid="payload-mass-input"
              type="number" step="0.1" min="0" max="30"
              value={payload.kg ?? ''}
              placeholder="e.g. 1.2"
              onChange={(e) => {
                const v = e.target.value
                if (v === '') { onPatch({ payload_kg: null }); return }
                const n = Number(v)
                if (Number.isFinite(n)) onPatch({ payload_kg: n })
              }}
              style={inputStyle} />
          </div>
          {/* CoG toggle + fields */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={() => setShowCog((v) => !v)}
              style={{
                background: 'none', border: 'none', padding: 0,
                fontSize: 12, color: '#2563EB', cursor: 'pointer',
                fontWeight: 500, textAlign: 'left', maxWidth: 220,
              }}>
              {showCog ? '▾ Hide CoG offset' : '▸ Add CoG offset (advanced)'}
            </button>
            {showCog && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12, color: '#374151',
              }}>
                <span style={{ minWidth: 120 }}>CoG (mm from flange)</span>
                {['x', 'y', 'z'].map((k) => (
                  <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#6b7280', fontWeight: 600, textTransform: 'uppercase' }}>{k}</span>
                    <input
                      type="number" step="1"
                      placeholder="0"
                      value={payload.cog_mm?.[k] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        const prev = payload.cog_mm || {}
                        const next = { ...prev }
                        if (v === '') { delete next[k] }
                        else {
                          const n = Number(v)
                          if (Number.isFinite(n)) next[k] = n
                        }
                        onPatch({ payload_cog_mm: Object.keys(next).length ? next : null })
                      }}
                      style={smallInput} />
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ProgramFindingsPanel — program-level validation findings surfaced
// between the Tool & Payload section and the step list. Findings
// live on the program (see lib/programFindings.computeProgramFindings),
// clear when the underlying condition resolves, and never live in a
// modal.
//
// 2026-07-31 consolidation: teaching-debt findings (e.g. the legacy
// pallet migration nudge) no longer render here. They're absorbed
// into the unified teaching-debt banner above the Tool & Payload
// section — one banner per program, fed by computeTeachingDebt.
// The findings themselves are kept in computeProgramFindings for the
// audit record; this panel just filters them out of the visual list.
const TEACHING_DEBT_FINDING_IDS = new Set([
  'pallet-legacy-migration',
])

function ProgramFindingsPanel({ program, onAction }) {
  const findings = computeProgramFindings(program)
    .filter((f) => !TEACHING_DEBT_FINDING_IDS.has(f.id))
  if (findings.length === 0) return null
  return (
    <div
      data-testid="program-findings"
      style={{
        margin: '4px 12px 8px', display: 'flex',
        flexDirection: 'column', gap: 6,
      }}>
      {findings.map((f) => {
        const palette = f.severity === 'error'
          ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b', icon: '✕' }
          : f.severity === 'warn'
          ? { bg: '#fef3c7', border: '#fde68a', fg: '#78350f', icon: '⚠' }
          : { bg: '#eff6ff', border: '#bfdbfe', fg: '#1e40af', icon: 'ℹ' }
        return (
          <div key={f.id}
            data-testid={`program-finding-${f.id}`}
            data-severity={f.severity}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px',
              background: palette.bg,
              border: `1px solid ${palette.border}`,
              borderRadius: 6, fontSize: 13,
              color: palette.fg, lineHeight: 1.5,
            }}>
            <div style={{ fontSize: 15, lineHeight: 1, marginTop: 2 }}>{palette.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>{f.title}</div>
              <div>{f.body}</div>
            </div>
            {f.action && typeof onAction === 'function' && (
              <button
                data-testid={`program-finding-${f.id}-action`}
                onClick={() => onAction(f)}
                style={{
                  flexShrink: 0, alignSelf: 'center',
                  padding: '6px 12px', fontSize: 12, fontWeight: 600,
                  background: '#fff', color: palette.fg,
                  border: `1px solid ${palette.border}`, borderRadius: 5,
                  cursor: 'pointer',
                }}>
                {f.action.label}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function ProgramEditor() {
  const currentProgram     = useStore((s) => s.currentProgram)
  const setCurrentProgram  = useStore((s) => s.setCurrentProgram)
  // Cross-client sync trust (D10 in the Program Doctrine). When
  // false: WS is down or reconnect refetch is still pending; the
  // held taught-state may not reflect what other clients have
  // written. Taught badges render "state syncing…" instead of a
  // confident green ✓ during that window.
  const programRevConfirmed = useStore((s) => s.programRevConfirmed)
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
  // Same precedence lib/runState uses: prefer the controller's
  // program.line (mapped via stepIndexForLine) over the executor's
  // step counter. `executingIdx` is -1 when nothing is executing
  // (also when the run just finished — the bar clears to empty).
  const _programLine       = useStore((s) => s.robot?.program?.line)
  const _programStep       = useStore((s) => s.task?.program_step)
  const _residentSha       = useStore((s) => s.robot?.program?.codegen_sha)
  const _residentProgramId = useStore((s) => s.robot?.program?.resident_program_id
                                          ?? s.robot?.program?.project_id)
  // Same cache-key extension as StepPreviewPanel (2026-08-03) —
  // the push path refreshes the sidecar with the currently-running
  // codegen sha; keying on pushed_lua_sha12 forces a refetch as
  // soon as save_project mints a new push.
  const _pushedLuaSha12 = useStore((s) => s.robot?.program?.pushed_lua_sha12)
  const {
    lineMap: _lineMap, codegenSha: _mapSha, programId: _mapProgId
  } = useLineMap(currentProgram?.id,
    `${currentProgram?.rev ?? ''}#${_pushedLuaSha12 ?? ''}`)
  const _honesty = lineMapHonesty({
    residentSha: _residentSha,
    residentProgramId: _residentProgramId,
    lineMapSha: _mapSha,
    lineMapProgramId: _mapProgId,
  })
  const executingIdx = (() => {
    if (Number.isInteger(_programLine) && _programLine > 0 && _honesty.ok) {
      const idx = stepIndexForLine(currentProgram, _programLine, _lineMap)
      if (idx >= 0) return idx
    }
    if (Number.isInteger(_programStep)
        && (_honesty.ok || _honesty.reason === 'no_resident'
            || _honesty.reason === 'no_map')) {
      return _programStep
    }
    return -1
  })()

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
  // 2026-08-05 (editor truth, operator directive): when a teach
  // session exists for THIS program, the DRAFT poses are the
  // current truth — record-through writes each pose to disk on
  // Record and mirrors it to STATE.teach_sessions. The pre-fix
  // untaughtStepIds computation read from the saved currentProgram
  // only, so the operator would teach five poses in a row and the
  // banner would still claim six missing while the backend
  // validator (which reads the draft-merged view) counted one.
  //
  // Merge in the draft's step-keyed poses (slot_key = 'step:<id>')
  // BEFORE running the truth resolver — same honest-display
  // principle as the line-map and link-status chips.
  const _draftPoses = useStore((s) =>
    (s.teachSessions || {})[currentProgram?.id]?.poses || null)
  const stepsMerged = (() => {
    if (!_draftPoses || typeof _draftPoses !== 'object') return steps
    const byKey = _draftPoses
    let touched = false
    const out = steps.map((s) => {
      const patch = byKey['step:' + s.id]
      if (!patch || typeof patch !== 'object') return s
      touched = true
      // The draft patch mirrors the shape the record path writes:
      // taught_joints, taught_tcp, taught: true. Merge non-null
      // fields on top of the saved step — the draft is the newer
      // authoritative pose for this teach session.
      const merged = { ...s }
      for (const k of ('taught_joints', 'taught_tcp', 'taught',
                       'pose', 'pose_status')) {
        if (patch[k] !== undefined && patch[k] !== null) merged[k] = patch[k]
      }
      // Ensure `taught` reflects a resolved 6-vector even if the
      // patch omitted the flag but supplied the joints.
      if (Array.isArray(merged.taught_joints)
          && merged.taught_joints.length === 6
          && merged.taught !== true) {
        merged.taught = true
      }
      return merged
    })
    return touched ? out : steps
  })()
  // Untaught steps the operator still needs to teach before the path
  // is ready to run. Uses the shared programTruth.isStepTaught resolver
  // (mirror of backend _has_taught_poses) so this count agrees with the
  // Run modal, Monitor's runnable check, AND what codegen accepts.
  //
  // Old logic used `step.taught` (client-set boolean) which drifted
  // from backend truth for derived_from steps (2026-07-30 audit
  // #P1-2 — see docs/ui_truth_audit.md).
  const programForTruth = { steps: stepsMerged, points: currentProgram.points }
  const untaughtIds = untaughtStepIds(programForTruth)
                        .filter((id) => {
                          const s = stepsMerged.find((x) => x.id === id)
                          return s && isTeachable(s, programForTruth)
                        })
  const untaughtCount = untaughtIds.length
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
  // 2026-07-30 §430 — routine fold state. Default: collapsed.
  // Set of routine ids the operator has explicitly expanded. Edits
  // to a step inside a routine broadcast to sibling iterations
  // regardless of fold state (see broadcast helper below).
  const [expandedRoutines, setExpandedRoutines] = useState(() => new Set())
  // 2026-08-06 palletize completeness — inline expand of the
  // move_to_pallet step to a read-only preview of its cycle template.
  // Set of step ids currently expanded. Persists only in this
  // editor's memory (no localStorage — collapsing on remount is fine).
  const [palletExpandedIds, setPalletExpandedIds] = useState(() => new Set())
  const togglePalletExpanded = (id) => {
    setPalletExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const [selectedId, setSelectedId]         = useState(null)
  const [dragId, setDragId]                 = useState(null)
  const [dragOverId, setDragOverId]         = useState(null)
  const [dragOverPos, setDragOverPos]       = useState(null)
  const [saveStatus, setSaveStatus]         = useState(null)
  // Save-error text. Populated from the backend response body's
  // `error` field on any non-ok response (was previously discarded —
  // a 404 or 422 would flash a generic red "Error" badge with no
  // reason. Now the operator sees the specific message: "Step 2
  // (Move Linear) references point 'p1' which has not been taught",
  // "program id 'test_program' can't round-trip on the controller",
  // etc.).
  const [saveError, setSaveError] = useState(null)
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
  // 2026-08-05 (P0-B, stale-lock fix): store actions for the
  // session-lifecycle heartbeat + end wire. See the useEffect below
  // this state block for the exact open/close transitions that
  // trigger them.
  const endTeachSession       = useStore((s) => s.endTeachSession)
  const endTeachSessionBeacon = useStore((s) => s.endTeachSessionBeacon)
  const heartbeatTeachSession = useStore((s) => s.heartbeatTeachSession)
  // Pallet-frame teach state — one of 'pallet_c1'/'pallet_c2'/
  // 'pallet_c3'/'pallet_part' when the operator is walking through the
  // 4-point diagram-guided flow, null otherwise. Distinct from the
  // teachSingleId/teachAllOrder path because pallet teach writes to
  // program.config.pallet_place (not to a step's taught_tcp).
  //
  // Mode: 'teach' | 're-teach'. Derived from role + program state
  // via modeForRole(). Back-nav to an already-taught point sets
  // this to 're-teach' but KEEPS the existing pose until Record.
  const [palletTeachRole, setPalletTeachRole] = useState(null)
  const [palletTeachMode, setPalletTeachMode] = useState(null)
  // Optional per-role caption addendum (e.g. the legacy-migration
  // reason "seeded from corner A during migration"). Displayed
  // under the standard instruction when the flow enters via Teach
  // All chaining an owed re-teach; cleared as soon as the operator
  // navigates away from that role.
  const [palletTeachReason, setPalletTeachReason] = useState(null)

  // 2026-08-05 (P0-B): teach-session lifecycle. Overlay is "open"
  // when any of teachSingleId / teachAllOrder / palletTeachRole is
  // active. While open, heartbeat every 30 s so the owner-TTL
  // doesn't age us out. On close (open → not-open transition), OR
  // on component unmount, call /end to release the lock. beforeunload
  // uses sendBeacon so a window close still releases. Record-through
  // architecture means poses were already persisted on every Record;
  // releasing the lock loses nothing.
  // 2026-08-05 (teach-lock incident #3): the SPA keeps ProgramLayout
  // mounted across route changes via CSS `display:none` (see
  // App.jsx:154 kept3D list — Program + 3D View stay parked to avoid
  // re-loading GLBs). Consequence: ProgramEditor never unmounts on
  // route change, its useEffects keep running, and the heartbeat
  // interval kept refreshing the owner-TTL even after the operator
  // navigated to Monitor/Programs/Configure — leaving a phantom lock
  // no one was actively holding.
  //
  // Doctrine: session lifecycle = TEACH SURFACE lifecycle. Treat
  // "not on the Program tab" as "overlay closed" for lifecycle
  // purposes — the heartbeat halts, the /end path fires. When the
  // operator returns to Program, the overlay state re-inflates
  // (teachSingleId etc. are still set), heartbeat resumes, /start
  // implicitly re-claims via the next Record. Losing nothing:
  // record-through already persisted every pose.
  const activeTab = useStore((s) => s.activeTab)
  const overlayStateOpen = (teachSingleId != null
                            || (teachAllOrder && teachAllOrder.length > 0)
                            || palletTeachRole != null)
  const overlayOpen = overlayStateOpen && activeTab === 'program'
  const wasOverlayOpen = useRef(false)
  // 2026-08-05 (Lesson 179 gap fix): track the PROGRAM ID that owned
  // the currently-open teach overlay. When the operator navigates to
  // a different program mid-teach, we must end the session on the
  // OLD pid — not the new one. Pre-fix, the `pid = currentProgram?.id`
  // captured the NEW program id after route change, so the /end call
  // was harmlessly no-op and the old lock persisted until TTL.
  const openedPidRef = useRef(null)
  useEffect(() => {
    const pid = currentProgram?.id
    // Fires on: overlay open→closed transition OR program-id change
    // (which effectively closes the overlay on the old program).
    if (wasOverlayOpen.current && !overlayOpen && openedPidRef.current) {
      try { endTeachSession(openedPidRef.current) } catch (_) { /* nop */ }
      openedPidRef.current = null
    } else if (overlayOpen && !wasOverlayOpen.current && pid) {
      openedPidRef.current = pid
    } else if (overlayOpen
               && openedPidRef.current
               && openedPidRef.current !== pid) {
      // Program switched while overlay was open — end the OLD one,
      // adopt the new pid (the overlay just re-parented itself).
      try { endTeachSession(openedPidRef.current) } catch (_) { /* nop */ }
      openedPidRef.current = pid
    }
    wasOverlayOpen.current = overlayOpen
  }, [overlayOpen, currentProgram?.id, endTeachSession])
  useEffect(() => {
    if (!overlayOpen) return
    const pid = currentProgram?.id
    if (!pid) return
    // 15 s heartbeat. Server owner-TTL is 90 s (_TEACH_OWNER_TTL_S),
    // stale-heartbeat auto-swap fires at 60 s (4 missed beats).
    // Prior 30 s cadence meant one dropped beat + one slow network
    // frame could tip a live tab into the stale window.
    //
    // 2026-08-05 (Lesson 179 gap fix): DON'T heartbeat while the tab
    // is hidden. Background tabs kept ticking, extending the owner-
    // TTL indefinitely, so operators on a second device saw the lock
    // never expire even when the original device was minimized/away.
    // We keep the interval alive but SKIP the fetch on hidden — so
    // the moment the tab returns to foreground we heartbeat again
    // (no re-mount cost).
    const t = setInterval(() => {
      if (typeof document !== 'undefined'
          && document.visibilityState === 'hidden') {
        return
      }
      try { heartbeatTeachSession(pid) } catch (_) { /* nop */ }
    }, 15000)
    return () => clearInterval(t)
  }, [overlayOpen, currentProgram?.id, heartbeatTeachSession])
  useEffect(() => {
    // Window unload — beacon out one last /end before the tab dies.
    // sendBeacon survives a close where fetch would be cancelled.
    // Uses openedPidRef (not currentProgram?.id) so mid-teach program
    // switches don't lose the release for the OLD program.
    const onBeforeUnload = () => {
      const pid = openedPidRef.current
      if (!pid || !wasOverlayOpen.current) return
      try { endTeachSessionBeacon(pid) } catch (_) { /* nop */ }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', onBeforeUnload)
      // pagehide covers the iOS/Safari/tablet cases where beforeunload
      // isn't fired reliably (bfcache, PWA background).
      window.addEventListener('pagehide', onBeforeUnload)
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', onBeforeUnload)
        window.removeEventListener('pagehide', onBeforeUnload)
      }
    }
  }, [endTeachSessionBeacon])
  useEffect(() => {
    // Component unmount — route change out of ProgramEditor. Same
    // as close: release the lock on whichever pid was open.
    return () => {
      const pid = openedPidRef.current
      if (pid && wasOverlayOpen.current) {
        try { endTeachSession(pid) } catch (_) { /* nop */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Frame-validation findings are NOT held as passive banner state
  // anymore (§465 fork-1 kill, 2026-08-04). The mid-re-teach
  // passive-banner rendering surfaced findings against half-updated
  // state (e.g., a stale c2 pose that the operator was actively
  // replacing) — operator-hostile. Findings are now requested at
  // two moments only: (a) inside palletTeachRecord after each
  // Record, surfaced as a toast; (b) at teach-complete / handleSave
  // as the final gate. See palletFrameValidator.js.
  // Cancel-confirm modal state — the confirm dialog states the
  // number of already-recorded teaches so the operator knows what's
  // preserved before dismissing.
  const [palletCancelConfirm, setPalletCancelConfirm] = useState(false)
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
  // Position-reuse prompt state. `pendingReuse` is set when the user
  // adds a step whose position could reuse an already-taught source.
  // Shape: {action, sourceStep, insertIdx} — insertIdx null = append.
  const [pendingReuse, setPendingReuse]       = useState(null)
  // Position picker state — set to a step id when the operator clicks
  // the chain icon on a row. The picker reads `currentProgram.points`
  // and mutates the step's `point_name` on selection.
  const [pickerStepId, setPickerStepId]       = useState(null)
  const deletePoint                           = useStore((s) => s.deletePoint)
  const renamePoint                           = useStore((s) => s.renamePoint)
  // Bug 1 fix wiring — banner state + refresh-on-command.
  const programChangedByOther                 = useStore((s) => s.programChangedByOther)
  const clearProgramChangedByOther            = useStore((s) => s.clearProgramChangedByOther)
  const refreshCurrentProgram                 = useStore((s) => s._refreshCurrentProgram)
  const addToast                              = useStore((s) => s.addToast)
  // Teach-session record-through actions (2026-08-04). The
  // ProgramEditor reads these to POST every Record to the Jetson
  // BEFORE mutating local state; see teachOverlayRecord +
  // palletTeachRecord for wiring.
  const recordTeachPose      = useStore((s) => s.recordTeachPose)
  const takeOverTeachSession = useStore((s) => s.takeOverTeachSession)
  const promoteTeachSession  = useStore((s) => s.promoteTeachSession)
  // Server-truth teach session for the currently-open program.
  // Populated from the WS state broadcast (see useStore's
  // ws.onmessage → teachSessions). Null when no draft exists.
  const teachSession = useStore((s) =>
    (s.teachSessions || {})[currentProgram?.id] || null)
  const isTeachingElsewhere = useStore((s) =>
    !!(s.teachSessions
       && s.teachSessions[currentProgram?.id]
       && s.teachSessions[currentProgram?.id].owner_device_id
       && s.teachSessions[currentProgram?.id].owner_device_id
          !== s._teachDeviceId))
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
  // Executing step index — same source lib/runState uses for its
  // "Step N of M" pill. NO code path writes step.status='done', so
  // the old `s.status === 'done'` filter was always 0 during a real
  // run (2026-07-30 audit #P2-2). Derive from task.program_step
  // (executor sim) or robot.program.line via stepIndexForLine
  // (Estun pipeline) — the same precedence deriveRunState uses.
  //
  // For the progress-bar count, we treat "current step" as N steps
  // done so the bar advances one-per-step. That matches the visual
  // convention every operator has learned; the exact done-vs-cursor
  // distinction is called out in the mouseover title on the bar.
  function statusOf(idx) {
    if (!taskRunning) return null
    if (typeof executingIdx === 'number' && idx < executingIdx) return 'done'
    if (typeof executingIdx === 'number' && idx === executingIdx) return 'active'
    return null
  }
  const doneCount = (taskRunning && typeof executingIdx === 'number')
    ? Math.max(0, Math.min(steps.length, executingIdx))
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
    const newStep = freshStepForAction('wait', currentProgram?.config)
    updateSteps(renumber([...steps, newStep]))
  }

  // Add a step of a specific action — used by the categorized
  // "+ Add Step" panel. Appends to the end and opens the inline editor
  // on the new row so the operator can immediately set parameters.
  //
  // Reuse prompt (2026-07-17): when the operator adds a step whose
  // action could reuse an earlier taught position (move_home,
  // move_joint, approach, pick, place, move_linear), we check the
  // existing steps for a matching source. If one is found, defer the
  // insertion behind a modal offering [Use same] / [Teach new]. Use
  // same → new step gets `position_ref: <sourceId>` (shared, not
  // copied — re-teaching the source updates every referencing step
  // at execution time). Teach new → current behavior.
  function handleAddAction(action) {
    const source = findPositionReuseSource(steps, action)
    if (source) {
      setPendingReuse({ action, sourceStep: source, insertIdx: null })
      setShowAddPanel(false)
      return
    }
    const newStep = freshStepForAction(action, currentProgram?.config)
    const next = renumber([...steps, newStep])
    updateSteps(next)
    setEditingId(next[next.length - 1].id)
    setShowAddPanel(false)
  }

  function completeReuse({ useSame }) {
    if (!pendingReuse) return
    const { action, sourceStep, insertIdx } = pendingReuse
    let newStep = freshStepForAction(action, currentProgram?.config)
    if (useSame) {
      // Link to the source. Do NOT copy taught_joints / taught_tcp —
      // the executor resolves at runtime via position_ref so the
      // operator can re-teach the source and every reference updates.
      newStep = {
        ...newStep,
        position_ref: sourceStep.id,
        // Nicer default label so the operator sees the link intent.
        label: `${newStep.label} (from Step ${sourceStep.id})`,
        // Referencing steps are NOT independently teachable — the
        // teach panel skips them (see isTeachable).
        taught: undefined,
        taught_joints: undefined,
        taught_tcp: undefined,
      }
    }
    const next = insertIdx == null
      ? renumber([...steps, newStep])
      : renumber([...steps.slice(0, insertIdx), newStep, ...steps.slice(insertIdx)])
    updateSteps(next)
    // Focus the newly-inserted row.
    const inserted = insertIdx == null
      ? next[next.length - 1]
      : next[insertIdx]
    setEditingId(inserted.id)
    setPendingReuse(null)
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
        const src = findPositionReuseSource(steps, 'move_joint')
        if (src) { setPendingReuse({ action: 'move_joint', sourceStep: src, insertIdx: idx }); break }
        const newStep = freshStepForAction('move_joint', currentProgram?.config)
        const next = renumber([...steps.slice(0, idx), newStep, ...steps.slice(idx)])
        updateSteps(next)
        setEditingId(next[idx].id)
        break
      }
      case 'add_below': {
        const src = findPositionReuseSource(steps, 'move_joint')
        if (src) { setPendingReuse({ action: 'move_joint', sourceStep: src, insertIdx: idx + 1 }); break }
        const newStep = freshStepForAction('move_joint', currentProgram?.config)
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

  // 2026-07-30 §430 — routine metadata resolvers. Reads
  // currentProgram.routines[] (backend-persisted) and falls back to
  // scanning per-step routine_id/routine_iteration when the top-level
  // list is absent (older programs saved before the persist path).
  const routines = Array.isArray(currentProgram?.routines) ? currentProgram.routines : []
  const stepRoutineInfo = (() => {
    const info = {}
    // Prefer explicit routines[] step_indices_per_iter.
    for (const r of routines) {
      const ranges = Array.isArray(r?.step_indices_per_iter) ? r.step_indices_per_iter : []
      const firstRoutineIdx = ranges.length && Array.isArray(ranges[0]) ? Number(ranges[0][0]) : null
      for (let iter = 0; iter < ranges.length; iter++) {
        const rng = ranges[iter]
        if (!Array.isArray(rng) || rng.length < 2) continue
        const a = Number(rng[0]), b = Number(rng[1])
        for (let s_idx = a; s_idx < b; s_idx++) {
          info[s_idx] = {
            routineId:       r.id,
            iteration:       iter,
            offsetInIter:    s_idx - a,
            firstOfIteration: s_idx === a,
            firstOfRoutine:  s_idx === firstRoutineIdx,
            iterations:      Number(r.iterations || 0),
            name:            String(r.name || ''),
          }
        }
      }
    }
    // Fallback: scan step.routine_id / step.routine_iteration.
    // (Programs saved before the routines-persist path.)
    if (Object.keys(info).length === 0) {
      const groups = {}
      for (let i = 0; i < steps.length; i++) {
        const rid = steps[i]?.routine_id
        if (!rid) continue
        const iter = Number(steps[i]?.routine_iteration || 0)
        const key = `${rid}|${iter}`
        if (!groups[key]) groups[key] = { rid, iter, indices: [] }
        groups[key].indices.push(i)
      }
      const rangesByRid = {}
      for (const g of Object.values(groups)) {
        rangesByRid[g.rid] = rangesByRid[g.rid] || []
        rangesByRid[g.rid].push({ iter: g.iter, indices: g.indices.sort((a, b) => a - b) })
      }
      for (const rid of Object.keys(rangesByRid)) {
        const groupsForRid = rangesByRid[rid].sort((a, b) => a.iter - b.iter)
        const iterations = groupsForRid.length
        const firstRoutineIdx = groupsForRid[0]?.indices?.[0]
        for (const g of groupsForRid) {
          for (let k = 0; k < g.indices.length; k++) {
            const s_idx = g.indices[k]
            info[s_idx] = {
              routineId: rid, iteration: g.iter,
              offsetInIter:    k,
              firstOfIteration: k === 0,
              firstOfRoutine:  s_idx === firstRoutineIdx,
              iterations,
              name: '',
            }
          }
        }
      }
    }
    return info
  })()
  const isRoutineExpanded = (rid) => !!(expandedRoutines.has && expandedRoutines.has(rid))
  const toggleRoutine = (rid) => {
    setExpandedRoutines((prev) => {
      const next = new Set(prev || [])
      if (next.has(rid)) next.delete(rid); else next.add(rid)
      return next
    })
  }
  // Fields whose meaning is "the same across every iteration" — an
  // edit to iter 0 should broadcast to iters 1..N. Explicitly EXCLUDES
  // taught_joints / taught_tcp / taught / joints / position_ref /
  // point_name / derived_from_step_id / iter_offset_mm since those
  // are per-iteration (each iteration teaches its own pose OR links
  // to the anchor's pose via the dedupe pass).
  const _ROUTINE_BROADCAST_FIELDS = new Set([
    'label', 'action', 'io_id', 'value', 'duration_s', 'speed_pct',
    'force_pct', 'width_mm', 'io_open', 'io_open_confirm',
    'io_close', 'io_close_confirm', 'target_part', 'target',
    'offset_z_mm', 'scan_height_mm', 'scan_speed_pct',
    'settle_time_ms', 'capture_frames', 'match_threshold_pct',
  ])
  function _broadcastToRoutine(id, patch) {
    // Find the source step's index + routine info, then apply the
    // SAFE-fields portion of `patch` to every sibling step at the
    // matching offset in other iterations of the same routine.
    // No-op when the source isn't in a routine.
    const srcIdx = steps.findIndex((s) => s.id === id)
    if (srcIdx < 0) return steps
    const src = stepRoutineInfo[srcIdx]
    if (!src || !src.routineId) return steps
    const safePatch = {}
    for (const k of Object.keys(patch)) {
      if (_ROUTINE_BROADCAST_FIELDS.has(k)) safePatch[k] = patch[k]
    }
    if (Object.keys(safePatch).length === 0) return steps
    // Build sibling-index list from stepRoutineInfo: same routineId,
    // same offsetInIter, different iteration.
    const siblings = new Set()
    for (const [sIdxStr, inf] of Object.entries(stepRoutineInfo)) {
      const sIdx = Number(sIdxStr)
      if (sIdx === srcIdx) continue
      if (inf.routineId !== src.routineId) continue
      if (inf.offsetInIter !== src.offsetInIter) continue
      siblings.add(sIdx)
    }
    if (siblings.size === 0) return steps
    return steps.map((s, idx) => siblings.has(idx) ? { ...s, ...safePatch } : s)
  }

  function handleRename(id, newLabel) {
    const nextSteps = _broadcastToRoutine(id, { label: newLabel })
    updateSteps(renumber(nextSteps.map((s) => s.id === id ? { ...s, label: newLabel } : s)))
  }

  function handleEditSave(id, patch) {
    const nextSteps = _broadcastToRoutine(id, patch)
    updateSteps(renumber(nextSteps.map((s) => s.id === id ? { ...s, ...patch } : s)))
  }

  // Unified link handler — accepts a source descriptor from the
  // position picker (kind: 'step' | 'point'). One code path for both
  // families: step sources write `position_ref` (matching ea64950 and
  // the row's home-mirror behavior), point sources write `point_name`.
  // The OTHER ref field is always cleared so the two resolvers can't
  // collide. When we're linking to a step, we mirror its pose fields
  // onto the linking step too — some downstream consumers (older
  // codegen paths, monitor cards) inspect step-local taught_joints
  // directly and would otherwise show the row as stale. Mirrors what
  // linkHomeToFirst already does for the home flow.
  function linkStepToSource(stepId, src) {
    if (!src) return
    const srcStep = src.kind === 'step'
      ? (steps.find((s) => s.id === src.id) || null)
      : null
    updateSteps(renumber(steps.map((s) => {
      if (s.id !== stepId) return s
      const next = { ...s, taught: true }
      if (src.kind === 'step') {
        next.position_ref     = src.id
        next.linked_to_step_id = src.id
        if ('point_name' in next) delete next.point_name
        if (srcStep) {
          if (srcStep.taught_joints) next.taught_joints = [...srcStep.taught_joints]
          if (srcStep.taught_tcp)    next.taught_tcp    = [...srcStep.taught_tcp]
          if (srcStep.taught_at)     next.taught_at     = srcStep.taught_at
          if (srcStep.joints)        next.joints        = [...srcStep.joints]
          if (srcStep.taught_tcp)    next.position      = srcStep.taught_tcp.slice(0, 3)
        }
      } else {
        next.point_name = src.name
        if ('position_ref'     in next) delete next.position_ref
        if ('linked_to_step_id' in next) delete next.linked_to_step_id
      }
      return next
    })))
    setPickerStepId(null)
    const target = src.kind === 'step' ? `Step ${src.id}` : `point ${src.name}`
    addToast(`Step ${stepId} → ${target}`, 'success')
  }

  // Detach a step from whichever kind of link it currently holds. If
  // it carries local taught_joints (mirrored from a step source, or
  // set inline by Teach), `taught` stays true; otherwise it becomes
  // untaught and the Teach button lights up.
  function unlinkStepFromSource(stepId) {
    updateSteps(renumber(steps.map((s) => {
      if (s.id !== stepId) return s
      const next = { ...s }
      let hadLink = false
      if ('point_name'        in next) { delete next.point_name;        hadLink = true }
      if ('position_ref'      in next) { delete next.position_ref;      hadLink = true }
      if ('linked_to_step_id' in next) { delete next.linked_to_step_id; hadLink = true }
      if (!hadLink) return s
      const has6 = Array.isArray(next.taught_joints) && next.taught_joints.length >= 6
      next.taught = !!has6
      return next
    })))
    addToast(
      'Position link removed. This step now uses its own pose — re-teach if needed.',
      'info')
  }

  async function handleDeletePointFromPicker(name) {
    const ok = await deletePoint(name)
    if (ok) addToast(`Deleted position ${name}`, 'success')
  }

  async function handleRenamePointFromPicker(oldName, newName) {
    const p = await renamePoint(oldName, newName)
    if (!p) return
    // Server updates step.point_name references atomically (see
    // dashboard_server PUT /points/{name}), but the editor's in-memory
    // steps still carry the old name until refresh — mirror the rename
    // locally so the row's chip flips without waiting for a round-trip.
    updateSteps(renumber(steps.map((s) =>
      s.point_name === oldName ? { ...s, point_name: newName } : s)))
    addToast(`Renamed ${oldName} → ${newName}`, 'success')
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

  // "Use Step 1 home position" — for any move_home step past the
  // first, copy the first move_home step's taught pose into this
  // step AND record the link so future edits to the first step
  // propagate here automatically (see teachOverlayRecord). This is
  // the operator-facing form of the wizard's built-in "share home
  // pose across cycle start + end" intent — brought into the editor
  // so drift introduced by a later individual re-teach can be
  // healed with one click.
  function linkHomeToFirst(id) {
    const source = steps.find((s) => s.action === 'move_home')
    if (!source || source.id === id) return
    updateSteps(renumber(steps.map((s) => {
      if (s.id !== id) return s
      const mirrored = {
        ...s,
        linked_to_step_id: source.id,
        taught: !!source.taught,
        taught_joints: source.taught_joints ? [...source.taught_joints] : s.taught_joints,
        taught_tcp:    source.taught_tcp    ? [...source.taught_tcp]    : s.taught_tcp,
        taught_at:     source.taught_at || s.taught_at,
        joints:        source.joints || source.taught_joints || s.joints,
      }
      if (source.taught_tcp) mirrored.position = source.taught_tcp.slice(0, 3)
      return mirrored
    })))
  }
  // Break the link — the step keeps its currently-mirrored pose but
  // stops receiving updates from the source. Re-teach afterwards will
  // give this step its own independent pose.
  function unlinkHome(id) {
    updateSteps(renumber(steps.map((s) => {
      if (s.id !== id) return s
      const { linked_to_step_id, ...rest } = s
      return rest
    })))
  }

  // Teach All — walks the unified teaching debt: first every
  // untaught step, then any owed pallet re-teaches. The step queue
  // stays fixed once started (rewrite happens via id, not index)
  // so a mid-walk record can't derail the path. When the step
  // queue empties, chainToPalletReTeaches() picks up any owed
  // pallet re-teaches so ④ (legacy migration) becomes an ordinary
  // stop in the itinerary rather than a separate box.
  function startTeachAll() {
    const debt = computeTeachingDebt(currentProgram)
    if (debt.total === 0) return
    setTeachSingleId(null)
    setPalletTeachRole(null)
    setPalletTeachMode(null)
    setPalletTeachReason(null)
    if (debt.stepIds.length > 0) {
      // Step queue first — same behavior as before. Chaining runs
      // after the queue completes.
      setTeachAllOrder(debt.stepIds)
      setTeachAllPos(0)
    } else {
      // No untaught steps — go straight to the first owed re-teach.
      chainToPalletReTeaches(debt.palletReTeaches)
    }
  }

  // Transition from the step-teach queue into a pallet re-teach.
  // Called when the step queue empties AND there are owed pallet
  // re-teaches in the debt. Enters at the first owed role in
  // re-teach mode with its reason threaded through as the diagram
  // caption addendum.
  function chainToPalletReTeaches(palletReTeaches) {
    setTeachAllOrder([])
    setTeachAllPos(-1)
    if (!palletReTeaches || palletReTeaches.length === 0) return
    const first = palletReTeaches[0]
    const fs = palletFrameStatus(currentProgram)
    setPalletTeachRole(first.role)
    setPalletTeachMode(modeForRole(first.role, fs))
    setPalletTeachReason(first.reason || null)
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
  //
  // Record-through (2026-08-04, §406-teach-time-extension). The Jetson
  // is the single store for pose state, mid-teach included. Every
  // Record posts the patch to POST /api/teach_session/{id}/record
  // FIRST. Only on server ack do we update the local Zustand steps —
  // otherwise a 403 (not owner) or a network hiccup would leave the
  // UI showing a taught pose the server never accepted. The WS state
  // broadcast then propagates the new draft to every connected
  // device (tablet + PC converge without a refresh).
  async function teachOverlayRecord() {
    const target = teachOverlayStep()
    if (!target) return
    const patch = await buildTaughtPatch()
    // Teaching a derived step (descend / lift / "above") promotes it
    // to an override — the executor will then prefer this taught_tcp
    // over base+offset. Reset-to-auto clears it.
    if (target.derived_from) patch.overridden = true
    // Record-through: POST to the draft store, wait for ack.
    // Refuses to advance if the server rejects (403 not_owner or
    // network error). Local state stays as-is on failure.
    const pid = currentProgram?.id
    if (pid) {
      const ack = await recordTeachPose(pid, `step:${target.id}`, patch)
      if (!ack.ok) return
    }
    // Propagate to any step linked to this one (currently: a later
    // move_home linked via "Use Step 1 home position"). Mirrors the
    // taught fields so the persisted JSON always has both source and
    // linked-child at identical joints — no drift, no codegen FIX C
    // normalization ever needs to fire.
    updateSteps(renumber(steps.map((s) => {
      if (s.id === target.id) return { ...s, ...patch }
      if (s.linked_to_step_id === target.id) {
        const linkedPatch = {
          taught:        !!patch.taught,
          taught_joints: patch.taught_joints ? [...patch.taught_joints] : s.taught_joints,
          taught_tcp:    patch.taught_tcp    ? [...patch.taught_tcp]    : s.taught_tcp,
          taught_at:     patch.taught_at,
          joints:        patch.joints || patch.taught_joints || s.joints,
        }
        if (patch.taught_tcp) linkedPatch.position = patch.taught_tcp.slice(0, 3)
        return { ...s, ...linkedPatch }
      }
      return s
    })))
    // Single-step flow: just close.
    if (teachSingleId != null) {
      setTeachSingleId(null)
      return
    }
    // Teach All: advance to next slot; when the step queue empties,
    // chain into any owed pallet re-teaches (single unified
    // itinerary — the debt list feeds Teach All entirely).
    const nextPos = teachAllPos + 1
    if (nextPos >= teachAllOrder.length) {
      const remainingDebt = computeTeachingDebt(currentProgram)
      chainToPalletReTeaches(remainingDebt.palletReTeaches)
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
      // Same chaining as teachOverlayRecord — the itinerary is
      // unified, so skipping the last step still hands off to any
      // owed pallet re-teaches.
      const remainingDebt = computeTeachingDebt(currentProgram)
      chainToPalletReTeaches(remainingDebt.palletReTeaches)
    } else {
      setTeachAllPos(nextPos)
    }
  }

  function teachOverlayBack() {
    if (teachAllPos > 0) setTeachAllPos(teachAllPos - 1)
  }

  function teachOverlayCancel() {
    // Pallet teach with any recorded work → route through the
    // confirm dialog so the operator sees the "N of 4 teaches
    // will be kept" line. Other overlays: cancel directly.
    if (palletTeachRole && taughtCount(palletFrameStatus(currentProgram)) > 0) {
      setPalletCancelConfirm(true)
      return
    }
    setTeachSingleId(null)
    setTeachAllOrder([])
    setTeachAllPos(-1)
    setPalletTeachRole(null)
    setPalletTeachMode(null)
    setPalletTeachReason(null)
  }

  function palletTeachDiscardConfirm(discard) {
    setPalletCancelConfirm(false)
    // Both branches close the overlay. Recorded teaches persist
    // via setCurrentProgram writes made on each Record; there's no
    // separate rollback path, so `discard` is currently advisory —
    // it flips currentProgram.unsaved so the operator remembers to
    // hit Save (already true) or leaves it as-is on Keep.
    setPalletTeachRole(null)
    setPalletTeachMode(null)
    setPalletTeachReason(null)
    if (!discard) {
      addToast?.(`Teaches preserved — remember to Save`, 'success')
    }
  }

  // Pallet Teach button on a pallet-driven step row → open the
  // fullscreen overlay walking through the 4-point diagram-guided
  // flow. Mid-flow resume: if some points are already taught (e.g. ①
  // yes, ②/③ no), start at the first UNTAUGHT role rather than
  // restarting at ①. All taught → Re-teach from ①.
  function startPalletTeach() {
    const first = firstUntaughtPalletRole(currentProgram) || PALLET_ROLE_ORDER[0]
    const fs = palletFrameStatus(currentProgram)
    setTeachSingleId(null)
    setTeachAllOrder([])
    setTeachAllPos(-1)
    setPalletTeachRole(first)
    setPalletTeachMode(modeForRole(first, fs))
  }

  // Tap-navigation from the diagram — any role is a legal target.
  function jumpToPalletRole(nextRole) {
    const t = jumpTo(nextRole, currentProgram, palletTeachRole)
    if (!t) return
    setPalletTeachRole(t.role)
    setPalletTeachMode(t.mode)
    // Fresh navigation clears the caption addendum + any previous
    // warning banner — the operator has moved on; the reason /
    // numbers no longer apply to what they see.
    setPalletTeachReason(null)
  }

  // Diagram-guided step shape fed to TeachOverlay. 2026-08-05
  // operator doctrine ruling: corners 1-3 define the pallet FRAME
  // ONLY (origin + row axis + column axis + plane). Corner-to-corner
  // distance has NO required relationship to slot pitch. Slot
  // spacing comes exclusively from the typed pitch values.
  // Point 4 is the CENTER of slot [1,1] — the first-part datum.
  // Prompts updated so the operator never has to infer which
  // doctrine is in force.
  const PALLET_TEACH_STEPS = {
    pallet_c1: {
      label:  '① PALLET CORNER — origin (slot [1,1] corner)',
      action: 'pallet_teach_c1',
      instr:  "Touch the pallet's physical corner at slot [1,1] — this anchors the pallet frame origin.",
    },
    pallet_c2: {
      label:  '② PALLET CORNER — along the first row',
      action: 'pallet_teach_c2',
      instr:  "Touch the pallet's physical corner at the far end of the first row — locks the ROW DIRECTION only (not pitch).",
    },
    pallet_c3: {
      label:  '③ PALLET CORNER — along the first column',
      action: 'pallet_teach_c3',
      instr:  "Touch the pallet's physical corner at the far end of the first column — locks the COLUMN DIRECTION only (not pitch).",
    },
    pallet_part: {
      label:  '④ FIRST PART CENTER — slot [1,1] datum',
      action: 'pallet_teach_part',
      instr:  'Place a real part in slot [1,1] and touch the CENTER of that first place position — this datum plus your typed row/column pitch determines every other slot.',
    },
  }

  // Record the current live pose into program.config.pallet_place
  // under the field for the active role. Mirror to config.pallet
  // for consumers that still read the pre-pallet_place shape.
  //
  // Frame validation (§465 fork-1 kill, 2026-08-04): all frame
  // geometry runs on the backend via POST /api/pallet/validate_frame.
  // Timing rules:
  //   * On Record for a CORNER role, we POST the would-be place
  //     (including the just-recorded pose) and pass
  //     re_teaching_role=<this role> so findings mentioning ONLY
  //     the corner being replaced are suppressed.
  //   * If any BLOCKING (error-severity) finding involves the
  //     just-recorded corner, we REFUSE the record: don't commit
  //     currentProgram, stay at the current role, toast the
  //     operator with the measured distance in operator copy.
  //   * Non-blocking findings (or errors involving other corners
  //     only) surface as an error toast but the record commits
  //     and the flow advances — the operator can re-teach the
  //     offending OTHER corner from the itinerary.
  // No passive banner is rendered from this path.
  async function palletTeachRecord() {
    const role = palletTeachRole
    if (!role) return
    const field = PALLET_ROLE_TO_FIELD[role]
    if (!field) return
    const patch = await buildTaughtPatch()
    const tcp   = patch.taught_tcp
    if (!Array.isArray(tcp) || tcp.length < 6) {
      addToast?.('Could not read TCP from robot state', 'error')
      return
    }
    const cfg = currentProgram?.config || {}
    const nextPlace = { ...(cfg.pallet_place || {}), [field]: [...tcp] }
    const nextPallet = { ...(cfg.pallet || {}),      [field]: [...tcp] }
    const isCorner = role === 'pallet_c1' || role === 'pallet_c2' || role === 'pallet_c3'

    // Role → teach-session slot key (2026-08-04 record-through).
    // Every pallet Record POSTs its slot to the draft store on
    // the Jetson — same wire contract step teaching uses. Second
    // devices watching this program see corner badges fill live.
    const slotKey = {
      pallet_c1:   'corner:1',
      pallet_c2:   'corner:2',
      pallet_c3:   'corner:3',
      pallet_part: 'corner:part',
    }[role]

    if (isCorner) {
      // Ask the shared validator BEFORE committing. Blocking
      // findings that name the corner we just recorded refuse
      // the record. Non-blocking findings surface but proceed.
      const result = await validatePalletFrameServer(nextPlace, {
        // We are RECORDING this role, not re-teaching a stale
        // one, so pass null — the finding-with-this-corner is
        // exactly what we want to see (blocked or advisory).
        reTeachingRole: null,
      })
      const blockers = findingsBlockingThisRecord(result.findings, role)
      if (blockers.length > 0) {
        const op = blockers[0].operator || {}
        addToast?.({
          title:  op.title  || 'This corner is too close to another taught corner.',
          detail: op.detail || 'Jog to the pallet corner and record again.',
          technicalDetail: op.technicalDetail || blockers[0].message || '',
        }, 'error', 10000)
        // eslint-disable-next-line no-console
        console.warn('[pallet-teach] Record refused', {
          role, findings: result.findings, measured: result.measured,
        })
        // Do NOT commit currentProgram; stay at the current role
        // in re-teach mode so the operator's next Record replaces
        // the just-refused attempt without navigating. Also do
        // NOT record-through — a refused corner never enters the
        // draft.
        setPalletTeachMode('re-teach')
        return
      }
      // Record-through: POST the corner pose to the Jetson's
      // draft store. A 403 (not_owner) or network error refuses
      // the commit — otherwise the second device would see a
      // corner it CAN'T see in the shared draft.
      const pid = currentProgram?.id
      if (pid && slotKey) {
        const ack = await recordTeachPose(pid, slotKey, {
          taught: true, taught_tcp: [...tcp], taught_at: patch.taught_at,
        })
        if (!ack.ok) return
      }
      // Commit the good record.
      setCurrentProgram({
        config: { ...cfg, pallet_place: nextPlace, pallet: nextPallet },
        unsaved: true,
      })
      // Non-blocking findings (or errors involving other corners
      // only): surface once, let the flow advance.
      const advisory = (result.findings || []).find(
        (f) => f?.severity === 'error' || f?.severity === 'warning')
      if (advisory) {
        const op = advisory.operator || {}
        addToast?.({
          title:  op.title  || 'Pallet frame warning',
          detail: op.detail || (advisory.message || ''),
          technicalDetail: op.technicalDetail || advisory.message || '',
        }, advisory.severity === 'error' ? 'error' : 'warning', 8000)
      }
    } else {
      // ④ record: part-datum doesn't affect corner geometry
      // math — commit without a frame-validation round-trip, BUT
      // still record-through to the Jetson so the second-device
      // view sees the ④ badge fill. The teach-complete gate on
      // close catches any lingering issue.
      const pid = currentProgram?.id
      if (pid && slotKey) {
        const ack = await recordTeachPose(pid, slotKey, {
          taught: true, taught_tcp: [...tcp], taught_at: patch.taught_at,
        })
        if (!ack.ok) return
      }
      setCurrentProgram({
        config: { ...cfg, pallet_place: nextPlace, pallet: nextPallet },
        unsaved: true,
      })
    }

    const merged = {
      ...(currentProgram || {}),
      config: { ...cfg, pallet_place: nextPlace, pallet: nextPallet },
    }
    const next = advanceFrom(role, merged)
    // Advance clears the reason addendum — the current step is done,
    // whatever justified holding a reason no longer applies.
    setPalletTeachReason(null)
    setPalletTeachRole(next ? next.role : null)
    setPalletTeachMode(next ? next.mode : null)
    // Teach-complete gate — when the sequence closes (next===null)
    // run one final validation against the whole place. Findings
    // surface via toast; the actual save gate is in handleSave.
    if (next === null && isCorner) {
      // isCorner only fires the completion check when a corner
      // completed the sequence, matching the current guard.
      _runTeachCompleteGate(nextPlace)
    }
  }

  async function _runTeachCompleteGate(place) {
    const result = await validatePalletFrameServer(place || {}, {
      reTeachingRole: null,
    })
    if (!(result.findings && result.findings.length)) return
    for (const f of result.findings) {
      const op = f?.operator || {}
      addToast?.({
        title:  op.title  || 'Pallet frame finding',
        detail: op.detail || (f?.message || ''),
        technicalDetail: op.technicalDetail || f?.message || '',
      }, f?.severity === 'error' ? 'error' : 'warning', 8000)
    }
  }

  function palletTeachSkip() {
    // Skip always advances forward, even past taught points.
    const next = advanceFrom(palletTeachRole, currentProgram)
    setPalletTeachReason(null)
    setPalletTeachRole(next ? next.role : null)
    setPalletTeachMode(next ? next.mode : null)
  }

  function palletTeachBack() {
    // Back-nav to any earlier role. Sets mode='re-teach' when the
    // target already has a taught pose — the pose is KEPT until
    // Record fires, so backing up to look ≠ overwriting.
    const back = backFrom(palletTeachRole, currentProgram)
    if (!back) return
    setPalletTeachRole(back.role)
    setPalletTeachMode(back.mode)
    setPalletTeachReason(null)
  }

  async function handleSave() {
    if (saveStatus === 'saving') return
    const name = programName.trim() || 'Untitled Program'
    // Teach-complete gate (§465 fork-1 kill, 2026-08-04). If the
    // program carries a pallet_place with any taught corners,
    // run one final backend validation before writing to disk.
    // Any error-severity finding refuses the save with an
    // operator toast; warnings surface but don't block.
    const cfgSave = currentProgram?.config || {}
    const place   = cfgSave.pallet_place || null
    const hasAnyCorner = place && (place.corner1_tcp || place.corner2_tcp
      || place.corner3_tcp || place.part_tcp || place.corner_a_tcp
      || place.point_b_tcp || place.point_c_tcp)
    if (hasAnyCorner) {
      const gate = await validatePalletFrameServer(place,
        { reTeachingRole: null })
      const errors = (gate.findings || []).filter(
        (f) => f?.severity === 'error')
      if (errors.length > 0) {
        const op = errors[0].operator || {}
        addToast?.({
          title:  op.title  || 'Program can\'t save — pallet frame is bad.',
          detail: op.detail || (errors[0].message || ''),
          technicalDetail: op.technicalDetail || errors[0].message || '',
        }, 'error', 10000)
        setSaveStatus('error')
        setSaveError(
          'Pallet frame refused: ' + (op.title || errors[0].message || ''))
        return
      }
      // Non-error findings surface but don't block.
      const warns = (gate.findings || []).filter(
        (f) => f?.severity === 'warning' || f?.severity === 'info')
      for (const w of warns) {
        const op = w.operator || {}
        addToast?.({
          title:  op.title  || 'Pallet frame finding',
          detail: op.detail || (w.message || ''),
          technicalDetail: op.technicalDetail || w.message || '',
        }, w.severity === 'warning' ? 'warning' : 'info', 6000)
      }
    }
    setSaveStatus('saving')
    // Teach-session promotion (2026-08-04, record-through). If a
    // draft exists for this program on the Jetson, promote it
    // through the shared validator door BEFORE the standard PUT.
    // The server-side promote endpoint merges draft.poses into
    // the program on disk (via the pending-pose gate), then
    // deletes the draft. The subsequent PUT below saves the
    // program-level metadata (steps, config, routines, tags) in
    // the usual shape — the poses are already on disk after the
    // promote, so the PUT is idempotent w.r.t. pose data.
    if (programId && teachSession) {
      const promote = await promoteTeachSession(programId)
      if (!promote.ok) {
        // Route through the shared namedLoadError so operator
        // copy stays canonical — outcome.kind='pending_poses'
        // uses the same title/detail the /api/estun/program/run
        // path emits. Non-fork of load_outcome_operator_copy.
        const named = namedLoadError(promote.body || {},
                                     promote.status)
        addToast?.({
          title:           named.title,
          detail:          named.detail,
          technicalDetail: named.technicalDetail,
        }, 'error', 10000)
        setSaveStatus('error')
        setSaveError('teach-session promote refused')
        return
      }
    }
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
      // 2026-07-30 §430 — round-trip routines[] so the fold state
      // persists across save/reload. Backend accepts + preserves the
      // list; codegen ignores it (byte-diff pinned).
      if (Array.isArray(currentProgram.routines) && currentProgram.routines.length) {
        payload.routines = currentProgram.routines
      }
      const body = JSON.stringify(payload)
      const res = await fetch(
        programId ? `/api/programs/${encodeURIComponent(programId)}` : '/api/programs',
        { method: programId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body },
      )
      const data = await res.json().catch(() => ({}))
      if (res.ok && data && data.ok && data.program) {
        setCurrentProgram({ id: data.program.id, name: data.program.name || name, unsaved: false })
        setProgramSteps(steps)
        refreshPrograms?.()
        setSaveStatus('saved')
        setSaveError(null)
        setTimeout(() => setSaveStatus(null), 2000)
      } else if (res.status === 404 && programId) {
        // Stale-id case: currentProgram carries an id whose file
        // isn't on disk (deleted OR the id was authored under the
        // old underscored-slug regime and now fails _PROG_ID_RE).
        // Auto-fallback: retry as POST so the operator's edits
        // don't get lost. A fresh slug will be minted from the
        // current name.
        const retry = await fetch('/api/programs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
          body,
        })
        const rdata = await retry.json().catch(() => ({}))
        if (retry.ok && rdata.ok && rdata.program) {
          setCurrentProgram({
            id: rdata.program.id, name: rdata.program.name || name,
            unsaved: false,
          })
          setProgramSteps(steps)
          refreshPrograms?.()
          setSaveStatus('saved')
          setSaveError(`Saved as ${rdata.program.id} (previous id ${programId} no longer exists — the file was recreated with a fresh slug).`)
          setTimeout(() => setSaveStatus(null), 4000)
        } else {
          setSaveStatus('error')
          setSaveError(rdata?.error
            || `Save-as-new fallback also failed (HTTP ${retry.status})`)
        }
      } else {
        setSaveStatus('error')
        setSaveError(
          data?.error
          || `Save failed (HTTP ${res.status}${data?.step_issues ? '; see step details' : ''})`
        )
      }
    } catch (e) {
      setSaveStatus('error')
      setSaveError(`Network error: ${e?.message || e}`)
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
      {/* Teach-session concurrency banner (2026-08-04). Renders
          when another device owns the active teach session for
          this program. Live badges continue to update from the
          WS broadcast — this is a READ-ONLY view of the other
          operator's work in progress. Take Over swaps
          ownership atomically. */}
      {/* 2026-08-05 (teach_lock_banner fork-1 kill): shared banner
          + Take Over button — same component the fullscreen teach
          overlay renders. Both surfaces show the button; the operator
          can take over from EITHER location. Old inline copy retired. */}
      {isTeachingElsewhere && teachSession && (
        <TeachLockBanner
          session={teachSession}
          programId={currentProgram?.id}
          variant="inline"
        />
      )}
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
          title={saveError || (unsaved ? 'Save the current program' : 'No unsaved changes')}
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

        {/* Rename affordance for programs whose id can't round-trip
            through the controller (any id containing anything but
            [a-z0-9] — the controller splits underscores as path
            separators; see 2026-07-20 alarm 10001 bug). Only shown
            when the program has actually been saved (has an id) AND
            the id fails the round-trip test. */}
        {currentProgram?.id && !/^[a-z0-9]+$/.test(currentProgram.id) && (
          <button
            onClick={async () => {
              const suggested = (currentProgram.name || currentProgram.id)
                .toLowerCase().replace(/[^a-z0-9]+/g, '')
              const newName = window.prompt(
                `Program id "${currentProgram.id}" contains characters the controller ` +
                `can't round-trip (only [a-z0-9] work). Enter a new name — it will ` +
                `be re-slugged to a safe id.`,
                suggested || currentProgram.name || 'newprogram')
              if (newName) {
                const result = await useStore.getState().renameProgram(currentProgram.id, newName)
                if (result) {
                  setSaveError(null)
                  setSaveStatus('saved')
                  setTimeout(() => setSaveStatus(null), 3000)
                }
              }
            }}
            title="Migrate this program to a controller-safe id (letters + digits only)"
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 600,
              background: '#B45309', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer', flexShrink: 0,
            }}>
            Rename to controller-safe id
          </button>
        )}

        {/* Inline save-error text. Replaces the previously-silent
            "Error" badge with the specific server response (e.g.
            "Step 2 (Move Linear) references point 'p1' which has
            not been taught"). Auto-clears when the operator clicks
            Save successfully. */}
        {saveError && saveStatus === 'error' && (
          <div style={{
            padding: '4px 10px', fontSize: 11, color: '#7F1D1D',
            background: '#FEE2E2', border: '1px solid #DC2626',
            borderRadius: 6, maxWidth: 480, lineHeight: 1.4,
            flexShrink: 1, minWidth: 0,
          }}>
            {saveError}
          </div>
        )}

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
          // Full blank template — every field explicitly reset so a
          // previously-loaded PBD program's config.pbd_metadata / tags
          // / description can't leak into what looks like a fresh
          // hand-authored program. setCurrentProgram MERGES; passing
          // the full shape here is what forces a clean slate.
          id: null,
          name: 'New Program',
          description: '',
          steps: [],
          config: {},
          tags: [],
          cell_id: null,
          points: {},
          source: 'manual',
          has_taught_poses: false,
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

      {/* Bug 1 banner — the currently-open program was mutated on
          another device while THIS client has unsaved local edits.
          The store's _handleProgramEvents sets programChangedByOther
          only in the conflict case; in the no-unsaved-edits case the
          store refetches quietly and this banner never appears. */}
      {programChangedByOther && (
        <div style={{
          margin: '8px 12px 0', padding: '10px 14px', fontSize: 13,
          background: '#fffbeb', color: '#92400e',
          border: '1px solid #fde68a', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700 }}>⚠ Program updated on another device</span>
          <span style={{ color: '#78716c', fontSize: 12 }}>
            You have unsaved edits. Reload will lose them; Keep my edits
            leaves your work in place — the next Save will overwrite the
            other change.
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => { refreshCurrentProgram(); }}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700,
              background: '#f59e0b', color: '#fff',
              border: 'none', borderRadius: 5, cursor: 'pointer',
            }}>Reload</button>
          <button onClick={() => clearProgramChangedByOther()}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              background: '#fff', color: '#92400e',
              border: '1px solid #fde68a', borderRadius: 5, cursor: 'pointer',
            }}>Keep my edits</button>
        </div>
      )}

      {/* Unified teaching-debt banner — 2026-07-31 consolidation.
          Absorbs the old "N positions not taught" red banner AND
          the legacy-pallet-migration info banner into ONE display
          fed by computeTeachingDebt(program). Count = untaught
          steps + owed re-teaches. Severity: red when required
          teaches missing (program can't run); amber when only
          quality re-teaches remain. Hidden mid-flow (teachAllPos ≥ 0
          or teachSingleId set or pallet teach in progress). */}
      {(() => {
        if (teachAllPos >= 0) return null
        if (teachSingleId != null) return null
        if (palletTeachRole) return null
        const debt = computeTeachingDebt(currentProgram)
        if (!debt.severity) return null
        const palette = debt.severity === 'error'
          ? { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c', btn: '#DC2626' }
          : { bg: '#fef3c7', border: '#fde68a', fg: '#78350f', btn: '#D97706' }
        const detail = debt.severity === 'error'
          ? 'jog the robot, then click Teach on each step'
          : 'the program will run — clear the owed re-teaches to lock in the quality'
        return (
          <div
            data-testid="teaching-debt-banner"
            data-severity={debt.severity}
            data-total={debt.total}
            style={{
              margin: '8px 12px 0', padding: '8px 12px', fontSize: 12,
              background: palette.bg, color: palette.fg,
              border: `1px solid ${palette.border}`, borderRadius: 6,
              display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
            }}>
            <span style={{ fontWeight: 700 }}>
              {debtBannerLabel(debt)}
            </span>
            <span style={{ color: '#6b7280', fontSize: 11 }}>
              — {detail}
            </span>
            <div style={{ flex: 1 }} />
            <button
              data-testid="teaching-debt-teach-all"
              onClick={startTeachAll}
              style={{
                padding: '6px 14px', fontSize: 11, fontWeight: 700,
                background: palette.btn, color: '#fff',
                border: 'none', borderRadius: 5, cursor: 'pointer',
              }}>
              Teach All ({debt.total})
            </button>
          </div>
        )
      })()}

      {/* Tool & Payload — per-program metadata. Not on the wire (see
          codegen; setPayload isn't wire-proven), but the collision
          monitor and the run confirm modal both surface the value.
          Amber banner when unset to nudge the operator; the fields
          themselves live inside the collapsible section below. */}
      <ToolAndPayloadSection
        program={currentProgram}
        onPatch={(patch) => setCurrentProgram({
          config: { ...(currentProgram?.config || {}), ...patch },
          unsaved: true,
        })}
      />

      {/* Program-level findings — legacy-migration nudges, etc.
          Clears automatically when the operator resolves the
          underlying condition (e.g. re-teaches ④). Never lives in a
          modal; the operator sees + acts on findings in-flow. */}
      <ProgramFindingsPanel
        program={currentProgram}
        onAction={(f) => {
          // Route each finding's CTA to the right operator gesture.
          // Currently: 'teach-pallet-part' jumps into the pallet
          // teach sequence at ④.
          if (f.action?.kind === 'teach-pallet-part') {
            setTeachSingleId(null)
            setTeachAllOrder([])
            setTeachAllPos(-1)
            setPalletTeachRole('pallet_part')
            setPalletTeachMode(modeForRole('pallet_part',
              palletFrameStatus(currentProgram)))
                  }
        }}
      />

      <div
        // Clicking blank space inside the scroll area (not on a row)
        // clears the selection — file-manager style.
        onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null) }}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {steps.map((rawStep, idx) => {
          // 2026-08-05 (editor truth): the row's DISPLAY should
          // reflect the draft-merged view (if a teach session
          // exists), so a fresh Record on a step immediately
          // clears the NOT TAUGHT badge — same honest-display
          // principle the banner and Run gate use. All EDIT
          // operations still mutate `steps` by id — the merge is
          // a display-only overlay.
          const step = stepsMerged[idx] || rawStep
          // Program-level pallet frame status — same value for every
          // row, cheap to recompute per iteration and keeps the closure
          // over `currentProgram` fresh across edits.
          const _palletFrame  = palletFrameStatus(currentProgram)
          const _isPalletStep = isPalletDriven(step)
          // 2026-07-30 §430 — routine fold: skip rendering rows in
          // iteration > 0 of a collapsed routine. The iteration-0
          // representative row + a "×N ▸ expand" chip stand in for
          // the whole routine.
          const _rinfo = stepRoutineInfo[idx]
          if (_rinfo && _rinfo.iteration > 0 && !isRoutineExpanded(_rinfo.routineId)) {
            return null
          }
          // First move_home in the program is the shared "home"
          // fixture. Any later move_home can link to it via the
          // "Use Step 1 home position" control — updates to the first
          // step then propagate through teachOverlayRecord.
          const firstHomeStep    = steps.find((s) => s.action === 'move_home')
          const firstHomeStepId  = firstHomeStep ? firstHomeStep.id : null
          const firstHomeStepNum = firstHomeStep
            ? (steps.findIndex((s) => s.id === firstHomeStep.id) + 1)
            : null
          const isMoveHome     = step.action === 'move_home'
          const isLaterHome    = isMoveHome && firstHomeStepId != null && step.id !== firstHomeStepId
          const isLinkedToHome = step.linked_to_step_id === firstHomeStepId && firstHomeStepId != null
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
                {/* Always reserve the T/!/🔗 slot so the pill's X position
                    is the same on teachable and non-teachable rows.
                    position_ref rows render a link chip pointing at the
                    source step so the operator can see the shared pose
                    at a glance. `point_name` linkage (the named-points
                    path — the direction we're generalizing toward) gets
                    its own chip variant with the point name and the
                    total number of steps sharing it. */}
                {step.point_name ? (() => {
                  const refCount = countStepsUsingPoint(steps, step.point_name)
                  return (
                    <div
                      title={`Uses taught position ${step.point_name}${refCount > 1 ? ` — ${refCount} steps share it` : ''}. Re-teaching the point updates every linked step.`}
                      onClick={(e) => { e.stopPropagation(); if (!locked) setPickerStepId(step.id) }}
                      style={{
                        minWidth: 26, height: 26, borderRadius: 13,
                        padding: '0 10px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        gap: 4, flexShrink: 0,
                        background: '#eef2ff', border: '1px solid #c7d2fe',
                        color: '#4338ca', fontSize: 11, fontWeight: 700,
                        cursor: locked ? 'default' : 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 13, lineHeight: 1 }}>🔗</span>
                      <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{step.point_name}</span>
                      {refCount > 1 && (
                        <span style={{
                          fontSize: 10, fontWeight: 800,
                          background: '#4338ca', color: '#fff',
                          borderRadius: 8, padding: '1px 6px',
                        }}>×{refCount}</span>
                      )}
                    </div>
                  )
                })() : step.position_ref != null ? (
                  <div
                    title={`Uses the same position as Step ${step.position_ref}`}
                    style={{
                      minWidth: 26, height: 26, borderRadius: 13,
                      padding: '0 8px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      gap: 3, flexShrink: 0,
                      background: '#eff6ff', border: '1px solid #93c5fd',
                      color: '#1D4ED8', fontSize: 11, fontWeight: 700,
                    }}
                  >
                    <span style={{ fontSize: 13, lineHeight: 1 }}>🔗</span>
                    <span>{step.position_ref}</span>
                  </div>
                ) : _isPalletStep ? (() => {
                  // Pallet step badge tracks FRAME completeness — the
                  // move_to_pallet step has no per-step taught flag; the
                  // config's completeness is what the operator needs to
                  // see at a glance. Three states so partial doesn't
                  // look like none:
                  //   4/4 → solid green T
                  //   1..3/4 → amber solid, shows the count
                  //   0/4 → red dashed !
                  //
                  // D10 (Program Doctrine): while programRevConfirmed
                  // is false — WS down or post-reconnect refetch
                  // pending — we don't know if another client changed
                  // the frame. Render a subtle "syncing" state
                  // instead of a confident T. The stop-zone modal
                  // and the safety layer are unaffected; only the
                  // taught-state assertion softens.
                  const n = taughtCount(_palletFrame)
                  const derived = n === 4 ? 'full' : n === 0 ? 'none' : 'partial'
                  const state = programRevConfirmed ? derived : 'syncing'
                  const bg = state === 'full'    ? '#f0fdf4'
                           : state === 'partial' ? '#fef3c7'
                           : state === 'syncing' ? '#f1f5f9'
                                                 : '#fef2f2'
                  const border = state === 'full'    ? '2px solid #16A34A'
                               : state === 'partial' ? '2px solid #d97706'
                               : state === 'syncing' ? '2px dashed #64748b'
                                                     : '2px dashed #DC2626'
                  const fg = state === 'full'    ? '#16A34A'
                           : state === 'partial' ? '#92400e'
                           : state === 'syncing' ? '#475569'
                                                 : '#DC2626'
                  const label = state === 'full'    ? 'T'
                              : state === 'partial' ? `${n}/4`
                              : state === 'syncing' ? '…'
                                                    : '!'
                  const title = state === 'syncing'
                    ? 'state syncing… — the client\'s taught data is unconfirmed '
                      + '(WS reconnect pending). Never render green on unconfirmed data.'
                    : state === 'full'
                    ? 'Pallet frame taught: ①②③ corners + ④ first-part.'
                    : state === 'partial'
                    ? `Pallet frame partially taught: ${n} of 4 points. Click Teach to resume.`
                    : 'Pallet frame not yet taught — click Teach.'
                  return (
                    <div
                      data-testid="pallet-row-badge"
                      data-state={state}
                      title={title}
                      style={{
                        // Wider box for the "N/4" partial label.
                        minWidth: 26, height: 26, borderRadius: 13,
                        padding: state === 'partial' ? '0 6px' : 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                        background: bg,
                        border,
                        color: fg,
                        fontSize: state === 'partial' ? 10 : 11,
                        fontWeight: 700,
                        letterSpacing: state === 'partial' ? 0.5 : 0,
                        fontFamily: state === 'partial'
                          ? 'var(--font-mono, monospace)' : undefined,
                      }}>
                      {label}
                    </div>
                  )
                })() : (() => {
                  // Standard row badge — T / ! for teachable steps.
                  // D10: same "syncing" softening as the pallet badge.
                  const teachable = isTeachable(step, currentProgram)
                  const state = !teachable ? null
                              : !programRevConfirmed ? 'syncing'
                              : (step.taught ? 'taught' : 'untaught')
                  const title = state === 'syncing'
                    ? 'state syncing… — the client\'s taught data is unconfirmed '
                      + '(WS reconnect pending). Never render green on unconfirmed data.'
                    : teachable
                      ? (step.taught
                        ? `Taught at ${step.taught_at || 'unknown'}`
                        : 'Position not taught — click Teach')
                      : undefined
                  return (
                    <div
                      data-testid="step-row-taught-badge"
                      data-state={state || 'hidden'}
                      title={title}
                      style={{
                        width: 26, height: 26, borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                        visibility: teachable ? 'visible' : 'hidden',
                        background: state === 'syncing' ? '#f1f5f9'
                                  : state === 'taught'  ? '#f0fdf4'
                                                        : '#fef2f2',
                        border:     state === 'syncing' ? '2px dashed #64748b'
                                  : state === 'taught'  ? '2px solid #16A34A'
                                                        : '2px dashed #DC2626',
                        color:      state === 'syncing' ? '#475569'
                                  : state === 'taught'  ? '#16A34A'
                                                        : '#DC2626',
                        fontSize: 11, fontWeight: 700,
                      }}>
                      {state === 'syncing' ? '…'
                        : state === 'taught' ? 'T'
                        : '!'}
                    </div>
                  )
                })()}
                <span style={{
                  display: 'inline-block', flexShrink: 0,
                  minWidth: 70, textAlign: 'center', boxSizing: 'border-box',
                  fontSize: 11, fontWeight: 700, padding: '3px 8px',
                  borderRadius: 4, letterSpacing: '0.5px',
                  background: tagColor + '18', color: tagColor,
                }}>
                  {def.tag}
                </span>
                {/* Emitted-verb divergence chip (Doctrine D3).
                    When codegen has written program.emitted_verbs
                    AND the emitted verb differs from what step.action
                    implies, surface both plus the reason. Without
                    this the row would silently show "MOVE LINEAR"
                    while codegen emitted movJ. */}
                {(() => {
                  const v = verbForStep(currentProgram, idx)
                  if (!v || !v.verb) return null
                  if (v.expected) return null   // no emitted table → nothing to compare against
                  const impliedByAction =
                    step.action === 'move_home'   ? 'movJ'
                  : step.action === 'move_joint'  ? 'movJ'
                  : step.action === 'move_linear' ? 'movL'
                  : step.action === 'approach'    ? 'movL'
                  : step.action === 'pick'        ? 'movL'
                  : step.action === 'place'       ? 'movL'
                  : null
                  if (impliedByAction == null) return null
                  if (v.verb === impliedByAction) return null
                  return (
                    <span
                      data-testid="step-emitted-verb-chip"
                      title={`Codegen emitted ${v.verb} (action implies `
                        + `${impliedByAction})${v.reason ? ' — ' + v.reason : ''}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        flexShrink: 0, fontSize: 10, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 4,
                        background: '#FEF3C7', color: '#92400E',
                        border: '1px solid #F59E0B',
                        fontFamily: 'var(--font-mono, monospace)',
                      }}>
                      ⚠ {v.verb}
                    </span>
                  )
                })()}
                {_rinfo && _rinfo.firstOfRoutine && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleRoutine(_rinfo.routineId) }}
                    title={
                      isRoutineExpanded(_rinfo.routineId)
                        ? `Fold ${_rinfo.iterations} iterations back to one representative cycle. Edits apply to every iteration regardless of fold state.`
                        : `Expand to show all ${_rinfo.iterations} iterations. Edits to this cycle apply to every iteration.`
                    }
                    style={{
                      marginLeft: 6, fontSize: 10, fontWeight: 700,
                      padding: '3px 8px',
                      borderRadius: 12,
                      color: '#065f46', background: '#d1fae5',
                      border: '1px solid #6ee7b7',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      cursor: 'pointer', flexShrink: 0,
                    }}>
                    ×{_rinfo.iterations}
                    <span style={{ fontSize: 9, fontWeight: 800 }}>
                      {isRoutineExpanded(_rinfo.routineId) ? '▾ fold' : '▸ expand'}
                    </span>
                  </button>
                )}
                {/* 2026-08-06 palletize completeness — expand/fold chip
                    for the move_to_pallet cycle template preview. The
                    preview panel itself is rendered OUTSIDE the row
                    (see the sibling <PalletExpansionPreview /> call
                    lower in this component tree). */}
                {_isPalletStep && (
                  <button
                    type="button"
                    data-testid="pallet-step-expand-toggle"
                    onClick={(e) => { e.stopPropagation(); togglePalletExpanded(step.id) }}
                    title={
                      palletExpandedIds.has(step.id)
                        ? 'Hide the per-cycle template preview'
                        : 'Show the per-cycle template (approach, pick, vacuum, transit, place, release)'
                    }
                    style={{
                      marginLeft: 6, fontSize: 10, fontWeight: 700,
                      padding: '3px 8px', borderRadius: 12,
                      color: '#0f766e', background: '#ccfbf1',
                      border: '1px solid #5eead4',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      cursor: 'pointer', flexShrink: 0,
                    }}>
                    {palletExpandedIds.has(step.id) ? '▾ fold' : '▸ expand'}
                  </button>
                )}
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
                    {isLinkedToHome && (
                      <span style={{
                        marginLeft: 10, fontSize: 11, fontWeight: 700,
                        padding: '2px 8px', borderRadius: 10,
                        background: '#eef2ff', color: '#4338ca',
                        border: '1px solid #c7d2fe',
                      }}>🔗 Linked to Step {firstHomeStepNum}</span>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EditableStepLabel
                      value={step.label || def.label}
                      onSave={(newLabel) => handleRename(step.id, newLabel)}
                    />
                    {isLinkedToHome && (
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        padding: '2px 8px', borderRadius: 10,
                        background: '#eef2ff', color: '#4338ca',
                        border: '1px solid #c7d2fe', whiteSpace: 'nowrap',
                      }}>🔗 Linked to Step {firstHomeStepNum}</span>
                    )}
                  </div>
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
                  {isTeachable(step, currentProgram) && hasPositionData(step) && (() => {
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
                {isTeachable(step, currentProgram) && !step.taught && (
                  <div style={{ fontSize: 13, color: '#DC2626', fontWeight: 600 }}>
                    NOT TAUGHT
                  </div>
                )}
                {isTeachable(step, currentProgram) && openPosData.has(step.id) && (
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
                {!locked && isTeachable(step, currentProgram) && (
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
                {!locked && _isPalletStep && (
                  <button
                    data-testid="pallet-row-teach"
                    onClick={(e) => { e.stopPropagation(); startPalletTeach() }}
                    title={_palletFrame.allTaught
                      ? 'Re-teach the pallet frame — walk through ①②③ corners + ④ first-part.'
                      : 'Teach the pallet frame — walk through ①②③ corners + ④ first-part. Resumes at the first untaught point.'}
                    style={{
                      padding: '6px 14px', fontSize: 12, fontWeight: 600, flexShrink: 0,
                      background: _palletFrame.allTaught ? '#f0fdf4' : '#eff6ff',
                      color:      _palletFrame.allTaught ? '#16A34A' : '#2563EB',
                      border:     _palletFrame.allTaught ? '1px solid #bbf7d0' : '1px solid #bfdbfe',
                      borderRadius: 5, cursor: 'pointer',
                    }}>
                    {_palletFrame.allTaught ? 'Re-teach' : 'Teach'}
                  </button>
                )}
                {/* Position-picker gate. Every teachable step that
                    isn't already linked can open the picker. Enabled
                    condition: at least ONE taught position source
                    exists in the program (either another teachable
                    step with taught_joints, OR a named point in
                    program.points). This is the Bug 2 fix — the
                    previous version gated only on program.points,
                    which stays empty in the normal editor-teach flow,
                    so the button was dead on every non-home row. */}
                {/* The home-specific buttons below still cover later
                    move_home rows exactly as they did pre-Bug-2 — the
                    unified Link/Unlink here hides on those rows so an
                    operator with muscle memory sees the same UI.
                    Gate on TEACHABLE_ACTIONS membership rather than
                    isTeachable(step, currentProgram) — the latter returns false when
                    position_ref is set, which would hide our own
                    Unlink button on ea64950-linked rows. */}
                {(() => {
                  if (locked || isLaterHome) return null
                  const isPosStep = TEACHABLE_ACTIONS.has(step.action)
                                 || (step.type && ACTION_TYPES.find((a) => a.type === step.type
                                                                    && TEACHABLE_ACTIONS.has(a.value)))
                  if (!isPosStep) return null
                  if (isDerivedOffsetMove(step)) return null
                  const linked = step.point_name || step.position_ref != null
                  if (linked) {
                    return (
                      <button onClick={(e) => { e.stopPropagation(); unlinkStepFromSource(step.id) }}
                        title="Detach this step from its linked position. Keeps any mirrored pose data locally."
                        style={{
                          padding: '6px 14px', fontSize: 12, fontWeight: 600, flexShrink: 0,
                          background: '#f5f3ff', color: '#6d28d9',
                          border: '1px solid #ddd6fe', borderRadius: 5, cursor: 'pointer',
                        }}>
                        ⛓ Unlink
                      </button>
                    )
                  }
                  const hasAnySource = collectPositionSources(steps, currentProgram?.points)
                    .some((e) => e.kind !== 'step' || e.id !== step.id)
                  return (
                    <button onClick={(e) => { e.stopPropagation(); setPickerStepId(step.id) }}
                      title={hasAnySource
                        ? 'Link this step to a previously taught position. Re-teaching the source updates every linked step.'
                        : 'No other taught positions in this program yet — teach one first.'}
                      disabled={!hasAnySource}
                      style={{
                        padding: '6px 14px', fontSize: 12, fontWeight: 600, flexShrink: 0,
                        background: '#eef2ff', color: '#4338ca',
                        border: '1px solid #c7d2fe', borderRadius: 5,
                        cursor: hasAnySource ? 'pointer' : 'not-allowed',
                        opacity: hasAnySource ? 1 : 0.5,
                      }}>
                      🔗 Link
                    </button>
                  )
                })()}
                {/* "Use Step N home position" — appears on any move_home
                    step past the first. Clicking it mirrors the first
                    move_home's taught pose and records a live link so
                    future re-teach of the first propagates here. If
                    already linked, the button flips to "Unlink" so the
                    operator can break the mirror and give this step
                    its own pose again. */}
                {!locked && isLaterHome && !isLinkedToHome && (
                  <button onClick={(e) => { e.stopPropagation(); linkHomeToFirst(step.id) }}
                    title={`Mirror the pose taught in Step ${firstHomeStepNum} — future re-teach of Step ${firstHomeStepNum} will update this step too.`}
                    style={{
                      padding: '6px 14px', fontSize: 12, fontWeight: 600, flexShrink: 0,
                      background: '#eef2ff', color: '#4338ca',
                      border: '1px solid #c7d2fe', borderRadius: 5, cursor: 'pointer',
                    }}>
                    🔗 Use Step {firstHomeStepNum} home position
                  </button>
                )}
                {!locked && isLaterHome && isLinkedToHome && (
                  <button onClick={(e) => { e.stopPropagation(); unlinkHome(step.id) }}
                    title={`Currently mirroring Step ${firstHomeStepNum}. Click to break the link and let this step hold its own independent pose.`}
                    style={{
                      padding: '6px 14px', fontSize: 12, fontWeight: 600, flexShrink: 0,
                      background: '#f5f3ff', color: '#6d28d9',
                      border: '1px solid #ddd6fe', borderRadius: 5, cursor: 'pointer',
                    }}>
                    ⛓ Unlink from Step {firstHomeStepNum}
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

              {/* 2026-08-06 palletize completeness — inline expandable
                  preview of the move_to_pallet cycle template. Placed
                  OUTSIDE the draggable row so operating the toggle
                  never triggers a drag; indented under the row so the
                  visual "child" relationship is unambiguous. */}
              {_isPalletStep && palletExpandedIds.has(step.id) && (
                <PalletExpansionPreview
                  step={step}
                  palletCfg={currentProgram?.config?.pallet || {}}
                />
              )}

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
                  {cat.actions.map((s) => {
                    // Effector-aware label (audit instance #4): the
                    // Add Step palette shows "Engage vacuum" when the
                    // program's effector is vacuum, "Grip part" when
                    // finger, etc. Falls back to the category default.
                    const paletteLabel = paletteLabelForAction(
                      s.action, currentProgram?.config) || s.label
                    return (
                      <button key={s.action} onClick={() => handleAddAction(s.action)}
                        style={{
                          padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6,
                          transition: 'all 100ms',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2563EB'; e.currentTarget.style.background = '#eff6ff' }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{paletteLabel}</div>
                        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{s.desc}</div>
                      </button>
                    )
                  })}
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

      {pendingReuse && (
        <PositionReuseModal
          action={pendingReuse.action}
          source={pendingReuse.sourceStep}
          onUseSame={() => completeReuse({ useSame: true })}
          onTeachNew={() => completeReuse({ useSame: false })}
          onCancel={() => setPendingReuse(null)}
        />
      )}

      {pickerStepId != null && (() => {
        const pickerStep = steps.find((s) => s.id === pickerStepId) || null
        if (!pickerStep) return null
        return (
          <PositionPickerModal
            step={pickerStep}
            steps={steps}
            points={currentProgram?.points || {}}
            onLink={(src) => linkStepToSource(pickerStep.id, src)}
            onDeletePoint={handleDeletePointFromPicker}
            onRenamePoint={handleRenamePointFromPicker}
            onClose={() => setPickerStepId(null)}
          />
        )
      })()}

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
          (teachSingleId set), a Teach All walk is in progress
          (teachAllPos ≥ 0), OR the pallet Teach walk is active
          (palletTeachRole set). */}
      {(() => {
        // Pallet teach path wins if active — its step is synthesized
        // per-role and points at the diagram-guided flow.
        if (palletTeachRole) {
          const synth = PALLET_TEACH_STEPS[palletTeachRole]
          const roleIdx = PALLET_ROLE_ORDER.indexOf(palletTeachRole)
          const cfg     = currentProgram?.config || {}
          const pallet  = cfg.pallet || {}
          const rows      = pallet.rows       ?? cfg.pallet_rows       ?? 4
          const cols      = pallet.cols       ?? cfg.pallet_cols       ?? 4
          const fillOrder = pallet.fill_order ?? cfg.pallet_fill_order ?? 'row_lr'
          const frameStatus = palletFrameStatus(currentProgram)
          const nTaught     = taughtCount(frameStatus)
          // Header modifiers: "· already taught, re-teaching" when
          // the current role has a pose; "· N taught" counter suffix
          // that reflects reality regardless of navigation.
          const labelSuffix = palletTeachMode === 're-teach'
            ? ' · already taught, re-teaching'
            : ''
          const stepLabelForOverlay = synth.label + labelSuffix
          // Instr composition:
          //   base + (re-teach nudge if applicable)
          //   + (reason addendum if Teach All chained an owed
          //      re-teach here — e.g. the legacy-migration caption)
          const reTeachNudge = palletTeachMode === 're-teach'
            ? ' The existing pose stays until you press Record.' : ''
          const reasonAddendum = palletTeachReason
            ? ` (${palletTeachReason})` : ''
          const stepInstrForOverlay = synth.instr + reTeachNudge + reasonAddendum
          const counterSuffix = ` · ${nTaught} taught`
          const synthStep = {
            ...synth,
            label: stepLabelForOverlay,
            instr: stepInstrForOverlay,
          }
          return (
            <TeachOverlay
              step={synthStep}
              currentN={roleIdx + 1}
              totalM={PALLET_ROLE_ORDER.length}
              counterSuffix={counterSuffix}
              canBack={roleIdx > 0}
              onRecord={palletTeachRecord}
              onSkip={palletTeachSkip}
              onBack={palletTeachBack}
              onCancel={teachOverlayCancel}
              recordDisabled={isTeachingElsewhere}
              disabledReason={isTeachingElsewhere
                ? 'Teaching in progress on ' + (teachSession?.owner_label
                  || teachSession?.owner_device_id || 'another device')
                : ''}
              lockBanner={isTeachingElsewhere && teachSession ? (
                <TeachLockBanner
                  session={teachSession}
                  programId={currentProgram?.id}
                  variant="overlay"
                />
              ) : null}
              diagram={
                <PalletFrameDiagram
                  role={palletTeachRole}
                  rows={rows}
                  cols={cols}
                  fillOrder={fillOrder}
                  frameStatus={frameStatus}
                  mode={palletTeachMode}
                  onRoleTap={jumpToPalletRole}
                  size="large"
                />
              }
            />
          )
        }
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
            recordDisabled={isTeachingElsewhere}
            disabledReason={isTeachingElsewhere
              ? 'Teaching in progress on ' + (teachSession?.owner_label
                || teachSession?.owner_device_id || 'another device')
              : ''}
            lockBanner={isTeachingElsewhere && teachSession ? (
              <TeachLockBanner
                session={teachSession}
                programId={currentProgram?.id}
                variant="overlay"
              />
            ) : null}
          />
        )
      })()}

      {/* Cancel-confirm modal for the pallet teach flow. States the
          number of already-recorded teaches so the operator knows
          exactly what's preserved. Recorded teaches persist via
          setCurrentProgram writes on each Record; this dialog is a
          safety net for the "I hit Cancel by accident" case. */}
      {palletCancelConfirm && (() => {
        const nTaught = taughtCount(palletFrameStatus(currentProgram))
        return (
          <div
            data-testid="pallet-cancel-confirm"
            onClick={() => setPalletCancelConfirm(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 2000,
              background: 'rgba(15,23,42,0.55)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <div onClick={(e) => e.stopPropagation()}
              style={{
                background: '#fff', borderRadius: 10, width: 'min(460px, 92vw)',
                padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 8 }}>
                Leave pallet teach?
              </div>
              <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.55 }}>
                {nTaught} of 4 pallet frame points {nTaught === 1 ? 'has' : 'have'} been recorded.
                {' '}<strong>Recorded teaches will be kept</strong> — you can resume from the
                Teach button on the pallet step row.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button
                  onClick={() => setPalletCancelConfirm(false)}
                  style={{
                    padding: '6px 14px', fontSize: 13, fontWeight: 600,
                    background: '#f3f4f6', color: '#374151',
                    border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
                  }}>
                  Keep teaching
                </button>
                <button
                  data-testid="pallet-cancel-confirm-leave"
                  onClick={() => palletTeachDiscardConfirm(false)}
                  style={{
                    padding: '6px 14px', fontSize: 13, fontWeight: 600,
                    background: '#2563EB', color: '#fff',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                  }}>
                  Leave — teaches kept
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

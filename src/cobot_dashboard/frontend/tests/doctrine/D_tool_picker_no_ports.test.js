// DOCTRINE — Tool-selection cards show NO port chips (2026-10-05
// operator order).
//
// Order: on the "Which tool will this program use?" step (and every
// tool-selection surface), the tool cards must NOT show port chips.
// Card is tool NAME + its type badge only. Ports are not relevant at
// tool-pick time; they live on My Cell rows + the hookup / guidance
// screens + the saved receipt.
//
// Pin scope — ToolFromCellStep is the SINGLE tool-selection card
// component used by both the new-program wizard AND the palletize
// flow (both share the same PAGES list). My Cell + hookup + wizards'
// SavedScreen / summary surfaces are OUT of scope — the previous
// subtitle sweep (ada5424) already pinned them to route through the
// shared cellEntryDisplay formatter, which this pin leaves untouched.
//
// Pins:
//   1. ToolFromCellStep tool card body renders no port chips —
//      grep for the retired data-testid, the retired _portChip
//      style constant, and the port-rendering helpers at the card
//      scope.
//   2. ToolFromCellStep still renders the type badge + the tool
//      name (positive proof we didn't accidentally rip too much).
//   3. My Cell subtitle still routes through entrySubtitle (ports
//      survive where they belong — regression guard, not a new
//      claim).
//
// Failure format:
//   DOCTRINE TOOL_PICKER_NO_PORTS VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE TOOL_PICKER_NO_PORTS VIOLATED: ${msg}` }

const pickerSrc  = readSrc('components/ToolFromCellStep.jsx')
const myCellSrc  = readSrc('components/MyCellSection.jsx')


// ── (1) No port chips on the tool-selection card ───────────────────

test('ToolFromCellStep card renders no port chips', () => {
  // The retired data-testid for the chip row.
  assert.equal(/data-testid="tool-from-cell-card-port"/.test(pickerSrc),
    false,
    v('ToolFromCellStep must not render any element with '
      + 'data-testid="tool-from-cell-card-port" — the port-chip row '
      + 'is retired at the tool-selection surface.'))
  // The retired _portChip style constant.
  assert.equal(/_portChip\s*=\s*\{/.test(pickerSrc), false,
    v('ToolFromCellStep must not declare a _portChip style constant '
      + '— the chip style belongs to the retired port row.'))
  // The portDisplayName import is only needed for chip rendering;
  // once chips are gone the import is dead weight.
  assert.equal(/portDisplayName/.test(pickerSrc), false,
    v('ToolFromCellStep must not import portDisplayName — the only '
      + 'consumer was the retired port-chip row.'))
})


// ── (2) Positive proof: card still shows name + type badge ─────────

test('ToolFromCellStep card still renders name + type badge', () => {
  assert.ok(/data-testid="tool-from-cell-card-type-badge"/.test(pickerSrc),
    v('ToolFromCellStep must still render the type-badge span '
      + '(data-testid="tool-from-cell-card-type-badge") — the card '
      + 'is name + badge only, not nothing.'))
  assert.ok(/\{typeLabel\(e\)\}/.test(pickerSrc),
    v('ToolFromCellStep must still call typeLabel(e) inside the '
      + 'badge so the operator-plain kind label survives.'))
  assert.ok(/\{e\.name\}/.test(pickerSrc),
    v('ToolFromCellStep must still render {e.name} — the operator '
      + 'picks by name.'))
})


// ── (3) My Cell still shows ports (regression guard) ───────────────

test('My Cell subtitle still routes through entrySubtitle', () => {
  assert.ok(/entrySubtitle\(/.test(myCellSrc),
    v('MyCellSection must still render its row subtitle through '
      + 'entrySubtitle — ports stay visible where they belong.'))
})

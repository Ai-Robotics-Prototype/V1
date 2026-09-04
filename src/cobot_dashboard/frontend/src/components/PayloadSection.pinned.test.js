// ToolAndPayloadSection — 2026-07-31 collapse-and-truth rewrite.
//
// Directive pins:
//   1. Section renders COLLAPSED by default; chevron opens.
//   2. "Payload not set" chip stays on the collapsed header when unset.
//   3. "Tool name (optional)" text field is DELETED entirely.
//   4. Body has ONE truth line (green match / amber mismatch /
//      amber "not readable"), no "Info only" fine-print banner.
//   5. Truth line reads from lib/payloadTruth — no inline math.
//
// Source-level checks — matches the repo convention (see the
// NumericField.test.js docblock for why real render tests aren't
// wired up).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const source = fs.readFileSync(
  path.resolve(__dirname, 'ProgramEditor.jsx'), 'utf8')

const payloadLib = fs.readFileSync(
  path.resolve(__dirname, '..', 'lib', 'payload.js'), 'utf8')

// Isolate the ToolAndPayloadSection function body so unrelated
// occurrences (comments, StepEditor, etc.) don't confuse the pins.
// The signature uses destructuring — `function T({ a, b })` — so we
// have to skip past the parameter list's braces before locating the
// function body's `{`.
function _extractPayloadSection(src) {
  const start = src.indexOf('function ToolAndPayloadSection')
  assert.ok(start >= 0, 'ToolAndPayloadSection must exist')
  const parenOpen = src.indexOf('(', start)
  let depthP = 0
  let parenClose = -1
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') depthP++
    else if (src[i] === ')') {
      depthP--
      if (depthP === 0) { parenClose = i; break }
    }
  }
  assert.ok(parenClose > 0, 'signature ) must close')
  const braceStart = src.indexOf('{', parenClose)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(braceStart, i + 1)
    }
  }
  throw new Error('unbalanced braces in ToolAndPayloadSection')
}
const body = _extractPayloadSection(source)


// ── (1) Collapsed by default ─────────────────────────────────────

test('section renders collapsed by default (expanded=false)', () => {
  // The state init must be `useState(false)` — NOT `useState(!payload.isSet)`
  // (the retired auto-expand-when-unset behavior).
  assert.ok(/const \[expanded, setExpanded\]\s*=\s*useState\(false\)/.test(body),
    'expanded must default to false — collapsed at mount, chevron opens')
  // The old auto-expand effect MUST NOT be present.
  assert.equal(/setExpanded\(true\)/.test(body), false,
    'no useEffect that forces the section open — collapsed default '
    + 'is the whole point of the 2026-07-31 directive')
})

test('section carries a data-testid="payload-section" wrapper', () => {
  assert.ok(body.includes('data-testid="payload-section"'),
    'ToolAndPayloadSection wrapper must expose a stable testid')
  assert.ok(/data-expanded=\{expanded \?/.test(body),
    'wrapper must publish `data-expanded` so tests can assert the '
    + 'collapsed-vs-open state without inspecting styles')
})


// ── (2) Chip on the collapsed header ─────────────────────────────

test('"Payload not set" chip renders on the collapsed header', () => {
  // The chip is rendered inside the header (outside the {expanded &&}
  // conditional), so it's visible even when the body is collapsed.
  assert.ok(body.includes('data-testid="payload-chip-unset"'),
    'unset chip must carry a stable testid')
  assert.ok(/⚠ Payload not set/.test(body),
    'chip copy must be "⚠ Payload not set"')
  // "Set" chip too (for the taught state).
  assert.ok(body.includes('data-testid="payload-chip-set"'),
    'set chip must also carry a testid so tests can distinguish states')
})


// ── (3) Tool-name field is GONE ──────────────────────────────────

test('"Tool name (optional)" text field is DELETED', () => {
  // Strip block comments before checking — retirement docblocks
  // can legitimately reference the retired label without
  // reintroducing the widget.
  const jsxOnly = body.replace(/\/\*[\s\S]*?\*\//g, '')
                      .replace(/\/\/.*$/mg, '')
  assert.equal(/<label\b[^>]*>[^<]*Tool name \(optional\)/.test(jsxOnly), false,
    'the "Tool name (optional)" <label> must be gone — directive: mass + CoG only')
  assert.equal(/onPatch\(\{\s*tool_name:/.test(jsxOnly), false,
    'no code path writes tool_name from the editor panel anymore')
  assert.equal(/type=['"]text['"][\s\S]{0,200}?tool_name/.test(jsxOnly), false,
    'the text input for tool_name must be gone entirely')
})

test('readPayload no longer returns tool_name (backward-compat kept on disk)', () => {
  // The retired field is dropped from the object readPayload
  // hands out. Saved configs may still carry tool_name on disk
  // (backward compat); the codegen leaves it alone.
  assert.equal(/tool_name:\s*toolName/.test(payloadLib), false,
    'readPayload must not surface tool_name in its return value — '
    + 'the field is a retired writeout, no consumer should read it')
  assert.equal(/payload\.tool_name/.test(payloadLib), false,
    'payloadChipLabel must not append tool_name — chip is mass-only')
})


// ── (4) Truth line replaces the info banner ─────────────────────

test('body renders ONE truth line via payload-truth testid', () => {
  assert.ok(body.includes('data-testid="payload-truth"'),
    'truth line must carry a stable testid')
  assert.ok(/data-state=\{truth\.state\}/.test(body),
    'truth line must publish data-state so tests can assert '
    + 'match / mismatch / unreadable without color inspection')
})

test('the retired "Info only" fine-print banner is GONE', () => {
  assert.equal(/<b>Info only\.<\/b>/.test(body), false,
    'the "Info only" banner is retired — the truth line replaces it')
  assert.equal(/PAYLOAD_INFO_ONLY/.test(body), false,
    'PAYLOAD_INFO_ONLY must not be referenced in the section body — '
    + 'the copy moved to lib/payloadTruth\'s state-driven messages')
})

test('truth line severity: green on match, amber otherwise', () => {
  // Palette IIFE inside the body decides bg/border/fg from
  // truth.state === 'match'. Confirm both branches exist.
  assert.ok(/truth\.state === 'match'/.test(body),
    'body must branch on truth.state === \'match\'')
  assert.ok(/#ECFDF5/.test(body),  'green palette present for match state')
  assert.ok(/#FEF3C7/.test(body),  'amber palette present for non-match states')
})


// ── (5) Truth line reads the shared resolver ─────────────────────

test('body computes truth via computePayloadTruth (no inline math)', () => {
  assert.ok(/computePayloadTruth\(\{[\s\S]*?programKg[\s\S]*?controllerKg[\s\S]*?\}\)/.test(body),
    'body must call computePayloadTruth with { programKg, controllerKg } — '
    + 'the shared resolver, never an inline comparison')
})

test('editor imports computePayloadTruth from ../lib/payloadTruth', () => {
  assert.ok(/import\s*\{[^}]*computePayloadTruth[^}]*\}\s*from\s*['"]\.\.\/lib\/payloadTruth['"]/.test(source),
    'ProgramEditor must import computePayloadTruth from the shared module')
})

test("controllerPayloadKg is threaded through as a prop", () => {
  // The section takes controllerPayloadKg as a prop so the host can
  // pass whatever wire-read value it has (null when unreadable).
  const sig = body.match(/^\{[^}]*controllerPayloadKg[^}]*\}/m)
    // Fall back to matching the function signature line directly.
    || source.match(/function ToolAndPayloadSection\(\{([^}]*)\}\)/)
  assert.ok(sig, 'section must accept controllerPayloadKg via props')
  assert.ok(/controllerPayloadKg/.test(sig[0] || sig[1]),
    'controllerPayloadKg must appear in the destructured props — '
    + 'when the wire read isn\'t available, hosts pass null and '
    + 'the truth line renders the "unreadable" copy')
})

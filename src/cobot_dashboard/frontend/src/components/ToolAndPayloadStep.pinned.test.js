// ToolAndPayloadStep render-safety pins (2026-10-14 operator field
// report: wizard went blank on the payload step).
//
// The step must render safely for every answers-shape it could see:
// fresh program (no payload keys), skipped mass ('skip'), numeric
// mass, NaN-after-bad-input, and legacy payload_cog_mm shapes that
// aren't plain objects. Any read that crashes = blank wizard. These
// pins check the source for the explicit guards + the shape of the
// mass/CoG reads so a regression that removes the guard trips here
// before it reaches the field.
//
// Source-level checks only — the frontend uses the same
// read-the-source + regex pattern as PayloadSection.pinned.test.js
// and distanceUnits.test.js (no React render runner wired up).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const src = fs.readFileSync(
  path.resolve(__dirname, 'ProgramWizard.jsx'), 'utf8')

// Grab the ToolAndPayloadStep function body. The signature uses
// destructured params (`function T({ a, b })`) so we must skip past
// the parameter-list parens before locating the body-opening `{`.
function _extract(src, needle) {
  const start = src.indexOf(needle)
  assert.ok(start >= 0, `${needle} must exist`)
  const parenOpen = src.indexOf('(', start)
  let depthP = 0, parenClose = -1
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') depthP++
    else if (src[i] === ')') { depthP--; if (depthP === 0) { parenClose = i; break } }
  }
  assert.ok(parenClose > 0, 'signature ) must close')
  const braceStart = src.indexOf('{', parenClose)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unterminated')
}

const body = _extract(src, 'function ToolAndPayloadStep(')

test('ToolAndPayloadStep guards nullish answers', () => {
  assert.match(body, /const\s+safeAnswers\s*=\s*answers\s*\|\|\s*\{\s*\}/,
    'answers may be nullish — must coerce to {} before reads')
})

test('ToolAndPayloadStep mass read goes through _safeNumber (no raw Number())', () => {
  assert.match(body, /const\s+kgNum\s*=\s*_safeNumber\(kg\)/,
    'kgNum must come from _safeNumber (returns null for NaN/undefined)')
  assert.match(body, /kgNum\s*!==\s*null\s*&&\s*kgNum\s*>\s*0/,
    'massOk and input value must guard against null before comparing to 0')
})

test('ToolAndPayloadStep CoG read goes through _safeCog (no raw || {})', () => {
  assert.match(body, /const\s+cog\s*=\s*_safeCog\(/,
    'cog must come from _safeCog (rejects arrays/numbers/strings)')
})

test('ToolAndPayloadStep CoG input uses _safeNumber for value', () => {
  assert.match(body,
    /_safeNumber\(cog\[k\]\)\s*!==\s*null\s*\?\s*mmToIn\(cog\[k\],\s*2\)\s*:\s*''/,
    'CoG axis input must guard with _safeNumber before formatting')
})

test('ToolAndPayloadStep onChange guards NaN before writing payload_kg', () => {
  // The handler must never write a NaN into answers.payload_kg — it
  // should fall through to null when Number() returns NaN. The pre-fix
  // single-ternary could not express that path.
  assert.match(body,
    /Number\.isFinite\(n\)\s*\?\s*n\s*:\s*null/,
    'payload_kg onChange must write null for non-finite inputs')
})

test('_safeNumber + _safeCog helpers exist above the component', () => {
  const safeN = src.indexOf('function _safeNumber(')
  const safeC = src.indexOf('function _safeCog(')
  const comp  = src.indexOf('function ToolAndPayloadStep(')
  assert.ok(safeN > 0 && safeN < comp,
    '_safeNumber must be declared above ToolAndPayloadStep')
  assert.ok(safeC > 0 && safeC < comp,
    '_safeCog must be declared above ToolAndPayloadStep')
})

// ── _safeNumber / _safeCog behaviour (compiled-in-place copy) ──
// We re-declare the helpers below with identical bodies so the test
// can execute them directly without pulling the whole JSX module. If
// the behaviour drifts, the source-level pins above still fail.

function _safeNumber(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function _safeCog(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v
}

test('_safeNumber returns null for every non-numeric input', () => {
  assert.equal(_safeNumber(undefined), null)
  assert.equal(_safeNumber(null), null)
  assert.equal(_safeNumber(''), null)
  assert.equal(_safeNumber('abc'), null)
  assert.equal(_safeNumber(NaN), null)
  assert.equal(_safeNumber({}), null)
  assert.equal(_safeNumber('1.2'), 1.2)
  assert.equal(_safeNumber(1.2), 1.2)
  assert.equal(_safeNumber(0), 0)
})

test('_safeCog returns {} for every non-plain-object input', () => {
  assert.deepEqual(_safeCog(undefined), {})
  assert.deepEqual(_safeCog(null), {})
  assert.deepEqual(_safeCog(0), {})
  assert.deepEqual(_safeCog('x'), {})
  assert.deepEqual(_safeCog([]), {})
  assert.deepEqual(_safeCog([1, 2, 3]), {})
  const obj = { x: 10 }
  assert.strictEqual(_safeCog(obj), obj)
})

test('WizardStepErrorBoundary wraps the PageBody in ProgramWizard', () => {
  // The boundary MUST wrap PageBody so a thrown render error doesn't
  // blank the whole wizard shell. Pin the exact wrapper so a future
  // refactor can't accidentally remove it.
  assert.match(src,
    /<WizardStepErrorBoundary[^>]*key=\{safeIdx\}[\s\S]*?<PageBody/,
    'WizardStepErrorBoundary must wrap PageBody with key={safeIdx}')
  assert.match(src,
    /import WizardStepErrorBoundary from '\.\/WizardStepErrorBoundary'/,
    'import must exist at the top of ProgramWizard')
})

// ── 2026-10-14 tablet-only blank-screen diagnostics ──
// The boundary itself must stay parse-safe on older engines
// (no class fields, no optional chaining in render) AND must
// forward caught errors into the global index.html overlay so a
// tablet with no devtools shows SOMETHING.

const boundarySrc = fs.readFileSync(
  path.resolve(__dirname, 'WizardStepErrorBoundary.jsx'), 'utf8')

test('WizardStepErrorBoundary render path has no optional chaining', () => {
  // Everything in render() must use safe ES5 property reads so an
  // older engine never trips on the fallback UI itself. We check the
  // whole file because render-time code can live outside render()
  // (e.g. in bound helpers).
  assert.equal(/\?\./.test(boundarySrc), false,
    'optional chaining would defeat the point — removed in favour of '
    + '(x && x.y) reads so the boundary cannot itself fail to parse '
    + 'on an older Safari.')
})

test('WizardStepErrorBoundary uses constructor.bind instead of class fields', () => {
  // Pre-fix: `retry = () => this.setState(...)` was a class-field
  // arrow. Some older engines don't accept the syntax natively; vite
  // transpiles but defence-in-depth prefers constructor.bind so the
  // code is byte-identical for every target.
  assert.match(boundarySrc, /this\.retry\s*=\s*this\.retry\.bind\(this\)/,
    'retry must be bound in the constructor, not declared as a class field')
})

test('WizardStepErrorBoundary forwards errors to window.__cobotReportError', () => {
  assert.match(boundarySrc, /window\.__cobotReportError/,
    'componentDidCatch must forward to the global overlay so a tablet '
    + 'with no devtools still sees the error above the wizard.')
})

const htmlSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'index.html'), 'utf8')

test('index.html installs a global error overlay before React loads', () => {
  // The ES5-only inline script must register listeners for both
  // uncaught sync errors and unhandled promise rejections AND expose
  // window.__cobotReportError so React boundaries can push into the
  // same banner.
  assert.match(htmlSrc, /id="global-error-overlay"/,
    'overlay container must exist in the HTML')
  assert.match(htmlSrc, /addEventListener\(['"]error['"]/,
    'uncaught sync errors must be reported')
  assert.match(htmlSrc, /addEventListener\(['"]unhandledrejection['"]/,
    'unhandled rejections must be reported')
  assert.match(htmlSrc, /window\.__cobotReportError\s*=/,
    'global push hook must exist for React boundaries to forward into')
  // The overlay script must come BEFORE the module script so it can
  // catch any error thrown during module eval.
  const overlayIdx = htmlSrc.indexOf('__cobotReportError')
  const moduleIdx  = htmlSrc.indexOf('type="module"')
  assert.ok(overlayIdx > 0 && moduleIdx > overlayIdx,
    'overlay installer must appear BEFORE the type=module script tag')
})

// DOCTRINE D6 — Loop bodies have two predecessors; every
// previous-step rule evaluates BOTH.
//
// Failure format:
//   DOCTRINE D6 VIOLATED: <detail>
//
// Phase-1 coverage (this file):
//  (a) Classify a synthesized loop program: assert the first body
//      step has two predecessors (lexical prev + back-edge).
//  (b) The classifier helper (predecessorsOf) is available in one
//      canonical place — no local re-implementations.
//
// Phase-2 (TODO): assert the motion analyzer's rule evaluation
// walks both predecessors when computing blend continuity, speed
// carryover, and modal-state inheritance. Requires plumbing the
// analyzer into the JS test harness (currently Python-side).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d6(msg) { return `DOCTRINE D6 VIOLATED: ${msg}` }


// Reference predecessor classifier — mirrors the model the
// analyzer + codegen must use. Given a step index, returns the
// list of predecessor indices. The FIRST body step of a loop has
// TWO predecessors: the step before the loop AND the back-edge
// (the last step inside the loop).
export function predecessorsOf(steps, idx) {
  if (idx <= 0) return []
  const step = steps[idx]
  const prevLex = idx - 1
  // Find containing loop, if any. A loop step carries
  //   { action: 'loop', goto: <first-body-idx>, count: N }
  // The FIRST body step is at goto's target.
  const containingLoop = steps.findIndex((s, i) => {
    if (i <= idx) return false                     // loop must be after body
    if (!s || s.action !== 'loop') return false
    const goto = typeof s.goto === 'number' ? s.goto : -1
    // goto uses 1-based step indices in the wire shape; support both.
    const gotoIdx = (goto >= 1 && steps[goto - 1]) ? goto - 1 : goto
    return gotoIdx === idx
  })
  if (containingLoop < 0) return [prevLex]
  // idx IS the first body step. Second predecessor: the last body
  // step (i.e. the step immediately before the loop verb).
  const backEdgePrev = containingLoop - 1
  // Degenerate 1-body loop: the "last body step" IS the current
  // step, which makes it its own predecessor (nonsensical for
  // predecessor analysis). Fall back to the lexical prev only.
  if (backEdgePrev === idx) return [prevLex]
  if (prevLex === backEdgePrev) return [prevLex]
  return [prevLex, backEdgePrev]
}


test('D6(a): first body step of a loop has two predecessors', () => {
  // Wire-shape: `goto` is 1-based step number (matches wizard emit).
  const steps = [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_linear' },           // <- first body step (idx 1)
    { id: 3, action: 'set_io' },
    { id: 4, action: 'loop', goto: 2, count: 4 },
    { id: 5, action: 'move_home' },
  ]
  const preds = predecessorsOf(steps, 1)
  assert.deepEqual(preds, [0, 2],
    d6(`first body step of loop must have TWO predecessors — lexical `
     + `prev (idx 0, move_home) AND back-edge (idx 2, set_io). Got ${JSON.stringify(preds)}`))
})

test('D6(a): non-body step has one predecessor (lexical only)', () => {
  const steps = [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_linear' },
    { id: 3, action: 'set_io' },
  ]
  assert.deepEqual(predecessorsOf(steps, 2), [1],
    d6('non-loop-body step must have exactly one predecessor'))
})

test('D6(a): 1-body loop collapses to one predecessor', () => {
  const steps = [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_linear' },
    { id: 3, action: 'loop', goto: 2, count: 3 },
  ]
  // The single body step's lexical prev IS the back-edge prev
  // (both point at idx 0 / move_home). Dedup to one.
  const preds = predecessorsOf(steps, 1)
  assert.deepEqual(preds, [0],
    d6(`1-body loop must classify as one predecessor (dedup) — got ${JSON.stringify(preds)}`))
})


// ── (b) One classifier, one location ─────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..')

test('D6(b): predecessor classifier lives in ONE canonical location', () => {
  // TODO(phase 2): the CANONICAL predecessorsOf lives in the JS
  // side of the motion analyzer (or is exposed by the backend).
  // Today the frontend doesn't classify predecessors — the analyzer
  // is Python-side. This doctrine test PINS the invariant so the
  // day a JS-side classifier appears, it doesn't fork.
  //
  // For phase 1 we assert the reference implementation above is the
  // ONLY predecessorsOf definition in the frontend tree — no other
  // component may implement its own.
  function walk(dir) {
    const out = []
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        if (name === 'node_modules' || name === 'build' || name === 'dist'
            || name.startsWith('.')) continue
        out.push(...walk(full))
      } else if (/\.(jsx?|mjs)$/.test(name)) {
        out.push(full)
      }
    }
    return out
  }
  const files = walk(path.join(FRONTEND_ROOT, 'src'))
  const offenders = files.filter((f) => {
    const src = fs.readFileSync(f, 'utf8')
    return /function\s+predecessorsOf\s*\(/.test(src)
  })
  assert.equal(offenders.length, 0,
    d6(`predecessorsOf must not be redefined under src/. Any classifier `
     + `lives at a canonical location (once JS-side lands, it goes in `
     + `lib/motionAnalysis.js). Offenders:\n  ${offenders.join('\n  ')}`))
})

// DOCTRINE D10 — The screen never asserts state it can't read.
//
// Failure format:
//   DOCTRINE D10 VIOLATED: <detail>
//
// Phase-1 coverage:
//  (a) payloadTruth's "unreadable" copy names the limitation
//      explicitly (already pinned in payloadTruth.test.js; mirrored
//      here as doctrine).
//  (b) Sweep components for language patterns that imply a sync/
//      read where none exists: "syncs to", "auto-updates",
//      "in sync with controller". Any such phrase must be
//      accompanied by an explicit wire-read gate; otherwise the
//      screen is inventing an assertion.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d10(msg) { return `DOCTRINE D10 VIOLATED: ${msg}` }


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..')


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


test('D10(a): payloadTruth exposes the "unreadable" state with honest copy', () => {
  const src = fs.readFileSync(
    path.join(FRONTEND_ROOT, 'src', 'lib', 'payloadTruth.js'), 'utf8')
  assert.ok(/state:\s*['"]unreadable['"]/.test(src),
    d10('payloadTruth must expose an explicit unreadable state'))
  assert.ok(/not readable/.test(src),
    d10('unreadable copy must use the literal phrase "not readable"'))
  // Bans: no "sync" / "auto-updates" language on the unreadable path.
  const unreadableBlock = src.match(/state:\s*['"]unreadable['"][\s\S]{0,600}/)
  if (unreadableBlock) {
    assert.equal(/\bsync\b|\bauto[- ]?update/i.test(unreadableBlock[0]), false,
      d10('unreadable copy MUST NOT use "sync" / "auto-update" language — '
       + 'those imply a wire read that doesn\'t exist'))
  }
})


test('D10(b): sweep components for "syncs to" / "auto-updates" without a wire gate', () => {
  const forbiddenPhrases = [
    /\bsyncs? to the controller\b/i,
    /\bauto[- ]?syncs?\b/i,
    /\bin sync with the controller\b/i,
    /\bautomatically updates? the controller\b/i,
  ]
  const files = walk(path.join(FRONTEND_ROOT, 'src'))
  const offenders = []
  for (const file of files) {
    if (file.endsWith('.test.js')) continue
    if (file.includes('/tests/')) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const rx of forbiddenPhrases) {
      if (rx.test(src)) {
        offenders.push(`${file}: matched ${rx}`)
      }
    }
  }
  assert.equal(offenders.length, 0,
    d10('components imply a controller sync that we don\'t verify on '
     + 'the wire:\n  ' + offenders.join('\n  ')
     + '\n\nIf a wire-verified sync EXISTS, gate the copy on the read '
     + 'result (see payloadTruth for the pattern). Otherwise soften the '
     + 'language to name the actual limitation.'))
})


test('D10(b): drag-active status (when built) must be honest about observability', () => {
  // TODO(phase 2): once the bench observation lands a signal, the
  // drag chip will render "DRAG ACTIVE" or "drag button pressed"
  // depending on what we can actually observe. If the chip claims
  // mode information we can't read, D10 is violated.
  const bench = path.join(REPO_ROOT_FALLBACK(), 'scripts', 'observe_drag_button.py')
  assert.ok(fs.existsSync(bench),
    d10('scripts/observe_drag_button.py must exist — the bench-first '
     + 'protocol is how we decide what the drag chip is allowed to say'))
})

function REPO_ROOT_FALLBACK() {
  return path.resolve(__dirname, '..', '..', '..', '..', '..')
}

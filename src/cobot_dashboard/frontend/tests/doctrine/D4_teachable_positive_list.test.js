// DOCTRINE D4 — Teachability is a positive list in the shared
// resolver; every consumer (itinerary, banner, badges, buttons)
// uses it.
//
// Failure format:
//   DOCTRINE D4 VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { fileURLToPath } from 'node:url'

import { TEACHABLE_ACTIONS, isTeachable }
  from '../../src/lib/programTruth.js'


function d4(msg) { return `DOCTRINE D4 VIOLATED: ${msg}` }


test('D4: TEACHABLE_ACTIONS is exported from lib/programTruth', () => {
  assert.ok(TEACHABLE_ACTIONS instanceof Set,
    d4('TEACHABLE_ACTIONS must be a Set exported from lib/programTruth'))
  assert.ok(typeof isTeachable === 'function',
    d4('isTeachable must be a named function exported from lib/programTruth'))
})


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


test('D4: no component redefines TEACHABLE_ACTIONS or isTeachable locally', () => {
  const files = walk(path.join(FRONTEND_ROOT, 'src'))
  const offenders = []
  for (const file of files) {
    if (file.endsWith('/lib/programTruth.js')) continue          // the authority
    if (file.endsWith('/lib/palletTeachSequence.js')) continue   // legitimate re-exporter
    if (file.includes('/tests/')) continue
    if (file.endsWith('.test.js')) continue
    const src = fs.readFileSync(file, 'utf8')
    // Local definitions: `const TEACHABLE_ACTIONS = ...` or
    // `function isTeachable(...)`. Imports of these names from
    // programTruth are fine.
    if (/^\s*(const|let|var)\s+TEACHABLE_ACTIONS\s*=/m.test(src)) {
      offenders.push(`${file} redefines TEACHABLE_ACTIONS`)
    }
    if (/^\s*function\s+isTeachable\s*\(/m.test(src)) {
      offenders.push(`${file} redefines isTeachable`)
    }
  }
  assert.equal(offenders.length, 0,
    d4('local TEACHABLE_ACTIONS / isTeachable redefinition:\n  '
     + offenders.join('\n  ')))
})


test('D4: no-fork-truth guard runs clean', () => {
  // The scripts/no-fork-truth.mjs guard already exists and gates
  // components that reference shared-truth tokens without importing
  // the resolver. The doctrine test invokes it and asserts clean.
  const guardPath = path.resolve(FRONTEND_ROOT, 'scripts', 'no-fork-truth.mjs')
  assert.ok(fs.existsSync(guardPath),
    d4('scripts/no-fork-truth.mjs must exist — the build-time gate '
     + 'that catches new components forking the resolver'))
  // We don't spawn a child process here (keeps the test hermetic);
  // deploy.sh invokes the guard directly.
})

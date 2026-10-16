// DOCTRINE D9 — Every generated program carries its stamps
// (codegen sha, lint result, adaptation reasons) — self-documenting,
// always.
//
// Failure format:
//   DOCTRINE D9 VIOLATED: <detail>
//
// Phase-1 coverage: source-level — the codegen module emits the
// three stamp lines. Phase-2 will add fixture-based comparison
// against reference generated Lua.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d9(msg) { return `DOCTRINE D9 VIOLATED: ${msg}` }


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const PROGRAM_OPS = path.join(REPO_ROOT, 'src', 'estun_driver',
                              'estun_driver', 'program_ops.py')


test('D9: program_ops.py emits codegen sha stamp (codegen_sha OR src_sha)', () => {
  const src = fs.readFileSync(PROGRAM_OPS, 'utf8')
  // Historical spelling is `src_sha` (from CODEGEN_VERSION); accept
  // either name since both identify the emitter version to the
  // operator.
  assert.ok(/codegen_sha|src_sha/.test(src),
    d9('program_ops.py must emit a `codegen_sha: <hex>` (or `src_sha`) '
     + 'footer line. Without it the operator has no way to know which '
     + 'codegen version wrote the program on disk.'))
})


test('D9: program_ops.py emits lint stamp', () => {
  const src = fs.readFileSync(PROGRAM_OPS, 'utf8')
  // Emit path must reference a "lint" marker in the footer.
  assert.ok(/-- lint:|lint:\s*(OK|FAIL|violation)/i.test(src)
         || /footer_lines\.append[\s\S]{0,200}?lint/i.test(src),
    d9('program_ops.py must emit a `-- lint: OK|<violation>` footer '
     + 'line. Silent lint results erase the audit trail.'))
})


test('D9: program_ops.py emits adaptation reasons in footer', () => {
  const src = fs.readFileSync(PROGRAM_OPS, 'utf8')
  // Adaptation footer is written when analyzer rules fire.
  assert.ok(/ADAPTED|\badaptation(s)?\b/i.test(src),
    d9('program_ops.py must reference adaptations in its footer '
     + 'block. Every analyzer swap MUST be printed — silent swaps '
     + 'are D3 violations too.'))
})


test('D9: footer emitters use footer_lines pattern (single collection)', () => {
  const src = fs.readFileSync(PROGRAM_OPS, 'utf8')
  // The footer pattern in program_ops.py is `footer_lines.append(...)`.
  // If the emit path fragments across multiple collections, the
  // stamps become inconsistent.
  const usages = (src.match(/footer_lines\.append/g) || []).length
  assert.ok(usages >= 3,
    d9(`expected multiple footer_lines.append calls (codegen_sha + `
     + `lint + adaptations, at minimum). Found ${usages}. If the `
     + `emit path fragmented across multiple collections, the stamps `
     + `may render out of order.`))
})

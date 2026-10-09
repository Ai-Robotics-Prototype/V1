// DOCTRINE D7 — Modal state (blend/speed/accel) is set before use
// and cleared at exact-stop contexts + program end — never inherited.
//
// Failure format:
//   DOCTRINE D7 VIOLATED: <detail>
//
// Phase-1 coverage:
//  (a) Source-level: the codegen module (program_ops.py) emits
//      setNoBlender at every contact + program end. We grep for
//      the invariant in the codegen source since we can't easily
//      invoke Python-side codegen from a JS test.
//  (b) Fixture-based: if reference generated Lua exists under
//      tests/doctrine/fixtures/lua/, assert setNoBlender precedes
//      every contact line.
//
// Phase-2 (TODO): compose the reference programs through codegen at
// test time (Python subprocess) and check the emitted Lua.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d7(msg) { return `DOCTRINE D7 VIOLATED: ${msg}` }


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const PROGRAM_OPS = path.join(REPO_ROOT, 'src', 'estun_driver',
                              'estun_driver', 'program_ops.py')
const FIXTURES = path.join(__dirname, 'fixtures', 'lua')


test('D7(a): codegen module emits setNoBlender at exact-stop contexts', () => {
  assert.ok(fs.existsSync(PROGRAM_OPS),
    d7(`codegen module not found at ${PROGRAM_OPS} — cannot audit `
     + `D7 without it`))
  const src = fs.readFileSync(PROGRAM_OPS, 'utf8')
  assert.ok(/setNoBlender/.test(src),
    d7('program_ops.py does not reference setNoBlender — modal state '
     + 'cannot be cleared at exact-stop contexts if the emitter never '
     + 'writes the verb'))
})

test('D7(a): codegen emits setNoBlender at program end', () => {
  const src = fs.readFileSync(PROGRAM_OPS, 'utf8')
  // The emit-at-end path lives near the program footer. Pin by grep
  // for a footer-adjacent setNoBlender call.
  const hasFooterClear = /setNoBlender[\s\S]{0,400}?(footer|program.end|end.of.program)/i
                       .test(src) ||
                       /(footer|program.end|end.of.program)[\s\S]{0,400}?setNoBlender/i
                       .test(src)
  assert.ok(hasFooterClear,
    d7('program_ops.py must clear modal state at program end — grep '
     + 'for setNoBlender adjacent to the footer / end-of-program section'))
})


test('D7(b): if reference Lua fixtures exist, setNoBlender precedes every contact', () => {
  if (!fs.existsSync(FIXTURES)) {
    // Phase 2: fixture directory not populated yet. Skip loudly so
    // the operator sees where the coverage extends next.
    console.log('D7(b) SKIPPED — no fixtures under '
      + path.relative(REPO_ROOT, FIXTURES)
      + '. Populate with reference generated Lua for full coverage.')
    return
  }
  const files = fs.readdirSync(FIXTURES).filter((n) => n.endsWith('.lua'))
  assert.ok(files.length > 0,
    d7(`fixtures directory exists but is empty: ${FIXTURES}`))
  for (const file of files) {
    const lua = fs.readFileSync(path.join(FIXTURES, file), 'utf8')
    // Simple scan: for every occurrence of a station contact
    // (movL to a position_role that is "pick" | "place" | ...),
    // the preceding N lines contain setNoBlender.
    const lines = lua.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!/movL\(.*(pick|place|machine_load|contact)/i.test(lines[i])) continue
      const window = lines.slice(Math.max(0, i - 6), i).join('\n')
      assert.ok(/setNoBlender/.test(window),
        d7(`${file}:${i + 1} — contact line lacks setNoBlender within `
         + `6 lines above:\n${lines[i]}`))
    }
  }
})

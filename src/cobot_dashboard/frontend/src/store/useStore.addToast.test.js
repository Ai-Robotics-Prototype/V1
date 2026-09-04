// Structural pin: addToast accepts the structured
// {title, detail, technicalDetail} shape without collapsing the
// three fields into one message string (2026-08-04).
//
// Motivated by the pending_poses duplication report: pre-fix,
// callers concatenated headline + " — " + detail into one
// toast.message; when both strings shared phrases (which they
// often did for named errors) the operator saw the same words
// twice inside one toast. The structured shape gives each field
// its own render target — see ToastContainer.jsx.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC  = readFileSync(resolve(HERE, 'useStore.js'), 'utf8')


test('addToast accepts a structured object (title/detail/technicalDetail)', () => {
  // The store must inspect whether the first argument is an
  // object and split the fields into their own toast slots.
  // Without this branch, a caller passing {title, detail}
  // silently loses everything but the title.
  assert.match(SRC, /addToast\(\s*msgOrObject/,
    'addToast still takes a bare `message` param — the '
    + 'structured API is not wired')
  assert.match(SRC, /typeof msgOrObject === 'object'/,
    'addToast does not test for object shape — legacy string '
    + 'callers work but new callers passing {title, detail} '
    + 'lose their content')
})


test('addToast preserves title/detail/technicalDetail on the toast object', () => {
  // The generated toast MUST carry title, detail, and
  // technicalDetail as separate top-level fields so the Toast
  // component can render each independently.
  for (const field of ['title', 'detail', 'technicalDetail']) {
    assert.match(SRC,
      new RegExp(`${field}:\\s*t\\.${field}`),
      `addToast does not populate ${field} on the toast object — `
      + `ToastContainer's ${field} render slot would stay empty`)
  }
})


test('legacy 2-arg calls still land as a bare `message`', () => {
  // The ~30 pre-2026-08-04 callers pass a bare string as first
  // arg; the else-branch must keep them working.
  assert.match(SRC, /message:\s*msgOrObject/,
    'legacy string callers lose their message — the else-branch '
    + 'does not fall through to a bare message slot')
})


test('durationMs still overrides the default 3s dwell', () => {
  // Regression pin — the third arg was silently ignored before
  // 2026-08-04, error toasts hardcoded to 3s. After the
  // structural rewrite, the duration override must survive.
  assert.match(SRC, /const dwellMs\s*=/,
    'durationMs override binding was removed in the rewrite')
  assert.match(SRC, /setTimeout\(\(\) => get\(\)\.removeToast\(id\), dwellMs\)/,
    'setTimeout no longer uses dwellMs — error toasts would '
    + 'time out after the default before the operator can read')
})

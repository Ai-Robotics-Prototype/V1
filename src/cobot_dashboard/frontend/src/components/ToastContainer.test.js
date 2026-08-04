// Structural pins for the toast rendering surface (2026-08-04).
//
// Motivated by the pending_poses duplication bug: pre-fix, the
// toast rendered a single `message` string that callers built by
// concatenating headline + " — " + detail. Both often carried
// the same phrases, so operators saw "known controller-crashing
// codegen" twice inside one toast. The structural fix splits the
// content into title / detail / technicalDetail and renders each
// exactly once. These tests keep the split from silently
// re-collapsing to a single string.
//
// The full render layer needs React/JSDOM which this repo
// doesn't wire; these tests inspect the ToastContainer source
// directly so the invariants (test-ids, ordering, single
// render sites) are still pinned in CI.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'ToastContainer.jsx'), 'utf8')


test('Toast component pulls title from toast.title (structured API)', () => {
  assert.match(SRC, /toast\.title/,
    'Toast does not read toast.title — the structured content path '
    + 'is missing; callers passing {title, detail} will fall back to '
    + 'legacy .message rendering')
})


test('Toast component renders detail as a distinct block from title', () => {
  assert.match(SRC, /data-testid="toast-detail"/,
    'toast-detail test-id missing — the detail block is not '
    + 'independently addressable, so a duplicate-in-title bug would '
    + 'not fail a rendering test')
  assert.match(SRC, /data-testid="toast-title"/,
    'toast-title test-id missing — same reason as toast-detail')
})


test('technicalDetail lives behind a Details toggle, hidden by default', () => {
  // The user directive: "Keep the full technical detail (firmware
  // bug #3 citation) in an expandable 'details' section or console
  // log only." The toggle is the expandable-section version.
  assert.match(SRC, /data-testid="toast-details-toggle"/,
    'Details toggle test-id missing — technicalDetail has no '
    + 'expandable surface, so it would either render always-on '
    + '(operator-hostile) or never (loses debug info)')
  assert.match(SRC, /data-testid="toast-technical-detail"/,
    'Technical-detail render target test-id missing')
  // Detail toggle must start closed.
  assert.match(SRC, /useState\(false\)/,
    'detailsOpen state must default to false so technical detail '
    + 'is hidden until the operator clicks Details')
})


test('title and detail render exactly once each in the component source', () => {
  // Structural: count the number of times we render toast.title
  // and toast.detail as JSX children. Each should appear exactly
  // once. If a copy-paste refactor introduced a second render
  // site (a common regression on toast components), the operator
  // would see the string twice — the pending_poses report class.
  const titleRefs = SRC.match(/\{title\}/g) || []
  const detailRefs = SRC.match(/\{detail\}/g) || []
  assert.equal(titleRefs.length, 1,
    `Toast renders title in ${titleRefs.length} places (want 1); `
    + 'a second render site would duplicate the operator string')
  assert.equal(detailRefs.length, 1,
    `Toast renders detail in ${detailRefs.length} places (want 1); `
    + 'a second render site would duplicate the operator string')
})


test('legacy message fallback is preserved', () => {
  // Callers that still pass a bare string (the ~30 call sites
  // that predate the structured API) must keep working. The
  // Toast component picks title || message.
  assert.match(SRC, /toast\.title\s+\|\|\s+toast\.message/,
    'legacy `toast.message` fallback missing — the ~30 2-arg '
    + 'addToast callers would render blank titles')
})

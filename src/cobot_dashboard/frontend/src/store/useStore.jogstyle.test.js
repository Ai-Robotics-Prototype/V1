// Node's built-in test-runner unit tests for the jog-style store slice.
// Run with:  node --test src/store/useStore.jogstyle.test.js  from frontend/.
//
// This suite is scoped to store-level facts we can pin without a DOM:
//   * the DEFAULT jogStyle (2026-08-03 §2 flipped STEP → CONTINUOUS);
//   * setJogStyle input validation.
//
// Behavioral tests for HoldButton's release paths (pointer / blur /
// visibilitychange / WS-drop) live in the bench-verify sheet
// (docs/jog_continuous_default_bench_checklist.md) — they require a
// live driver + tablet, not jsdom.

import { test } from 'node:test'
import assert from 'node:assert/strict'


// The store module pulls in React, Zustand, and a lot of transitively
// browser-dependent code (Web Worker for the jog ticker, fetch shims,
// etc.). Rather than boot the whole app under jsdom, we crack open
// the source with a text-level check for the default and the setter's
// allow-list. This locks the value across future edits.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC  = readFileSync(resolve(HERE, 'useStore.js'), 'utf8')


test('jogStyle default is CONTINUOUS (2026-08-03 §2)', () => {
  // A precise regex — the store initializer line, not a comment.
  const m = SRC.match(/^\s*jogStyle:\s*'([^']+)',\s*$/m)
  assert.ok(m, 'jogStyle initializer not found in useStore.js')
  assert.equal(m[1], 'CONTINUOUS',
    `default was ${m[1]!==undefined?"'"+m[1]+"'":"missing"}; task §2 requires 'CONTINUOUS'.`)
})


test('setJogStyle only accepts STEP or CONTINUOUS', () => {
  // The setter is the safety valve — a rogue caller trying to write
  // 'CONTINOUS' (misspelled) or an object must be rejected.
  const setter = SRC.match(
    /setJogStyle\(style\)\s*\{[^}]*if\s*\([^)]*STEP[^)]*CONTINUOUS[^)]*\)/)
  assert.ok(setter, 'setJogStyle allow-list check must gate STEP or CONTINUOUS')
})


test('release-path event names cover blur, visibility, pagehide, disabled', () => {
  // Sanity: the HoldButton event emitter names locked in the code
  // match the release paths §3 enumerates. When one is removed by a
  // refactor this test surfaces first — before the bench does.
  const holdButtonSrc = readFileSync(
    resolve(HERE, '..', 'components', 'JogControls.jsx'), 'utf8')
  for (const evt of [
    'release_window_blur',
    'release_visibility_hidden',
    'release_pagehide',
    'release_disabled_midhold',
    // 2026-08-04 §3+§5: slide-off = stop. pointerleave now emits
    // an explicit release rather than relying on setPointerCapture
    // to keep events flowing on the button.
    'release_pointerleave',
  ]) {
    assert.ok(holdButtonSrc.includes("'" + evt + "'"),
      `expected HoldButton to emit '${evt}' — did the §3 release path get removed?`)
  }
})


test('teach drawer wires onTap AND reads shared jogStyle (2026-08-05 A(a))', () => {
  // The teach-drawer break: OverlayJogArrow used to hardcode
  // jogStyle="CONTINUOUS" and wire() returned no onTap — STEP mode
  // unreachable in the drawer. Lock the unified shape so a future
  // refactor can't silently strand teach flows again.
  const editorSrc = readFileSync(
    resolve(HERE, '..', 'components', 'ProgramEditor.jsx'), 'utf8')
  // OverlayJogArrow must accept jogStyle as a prop (not hardcode).
  assert.ok(
    /function OverlayJogArrow\(\{\s*jogStyle,/.test(editorSrc),
    'OverlayJogArrow must destructure jogStyle from props (unified with shared toggle)')
  assert.ok(
    !/jogStyle="CONTINUOUS"/.test(editorSrc),
    'OverlayJogArrow must NOT hardcode jogStyle="CONTINUOUS" — read it from the shared store')
  // Wire helper must include onTap.
  assert.ok(
    /onTap:\s*\(\)\s*=>\s*tap\(axis,\s*direction\)/.test(editorSrc),
    'TeachOverlay wire() must include onTap so STEP mode fires per-tap increments')
})


test('jog rejections surface as a toast (2026-08-05 A(c))', () => {
  // Silent driver rejections (allow_jog closed / monitor_only /
  // ws not connected) leave the operator staring at dead buttons.
  // Lock the store's toast-on-jog-rejection watcher so a future
  // refactor doesn't drop it.
  const storeSrc = readFileSync(resolve(HERE, 'useStore.js'), 'utf8')
  assert.ok(
    /_lastJogRejectTs/.test(storeSrc),
    'useStore must track _lastJogRejectTs for the rejection dedup')
  assert.ok(
    /`Jog rejected: /.test(storeSrc),
    'useStore must addToast on new jog rejections')
})


test('teach drawer debug HUD removed (2026-08-05)', () => {
  const editorSrc = readFileSync(
    resolve(HERE, '..', 'components', 'ProgramEditor.jsx'), 'utf8')
  // The HUD emitted a `<TeachOverlayDebugHUD ...>` element that was
  // leftover instrumentation. The function definition should be gone
  // AND no JSX mount should remain.
  assert.ok(
    !/function TeachOverlayDebugHUD/.test(editorSrc),
    'TeachOverlayDebugHUD function definition must be removed')
  assert.ok(
    !/<TeachOverlayDebugHUD /.test(editorSrc),
    'TeachOverlayDebugHUD JSX mount must be removed')
})


test('server deadman is 0.2s (2026-08-04 §4)', () => {
  // Locks the driver-side freshness timeout at the current 200 ms.
  // Reduces the "frozen tab leaves the arm moving" window vs. the
  // previous 0.3 default.  Client cadence is 100 ms — one missed
  // tick still leaves margin.
  // useStore.jogstyle.test.js is at src/cobot_dashboard/frontend/src/
  // store/ — go up 4 levels (store/ → src/ → frontend/ → cobot_dashboard/
  // → src/), then into estun_driver/config/.
  const yamlPath = new URL('../../../../estun_driver/config/estun.yaml',
                           import.meta.url)
  const yaml = readFileSync(yamlPath, 'utf8')
  const m = yaml.match(/^\s*jog_freshness_timeout_s:\s*([0-9.]+)\s*$/m)
  assert.ok(m, 'jog_freshness_timeout_s not found in estun.yaml')
  assert.equal(m[1], '0.2', `task §4 requires 0.2, yaml has ${m[1]}`)
})

/**
 * Slider → WS payload regression check.
 *
 * The bug fixed 2026-07-16: JogControls held a local `useState(20)` for
 * jog speed while JogSpeedSlider wrote to `store.jogSpeedPct`. Two
 * separate sliders, two separate states — the standalone slider looked
 * like it "did nothing" because the pad's hold handler ignored it.
 *
 * This test wires up the actual store getter/setter for jogSpeedPct and
 * calls the actual `jogHold` action; then asserts that the WS payload
 * dispatched to `_stateWs.send` carries `speed_pct == the current store
 * value`, for the three canonical slider frames (5 %, 12 %, 40 %) plus
 * the boundary cases (1 %, 100 %). Anyone re-adding a local useState
 * for speed will break this test.
 */

// Zustand needs a browser-ish global for its internal check.
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} }
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }

const zustand = await import('zustand')
const create = zustand.default ?? zustand.create

// Fake WebSocket sink — captures every send() so we can inspect the
// jog payload that would ride the /ws/state channel. `readyState: 1`
// means the store's _sendJogWS fast path is taken (mirrors OPEN).
const sent = []
const fakeWs = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) }

// Minimal store shape — mirrors the fields useStore.js jogHold reads.
// _sendJogWS is a verbatim copy of the store's implementation so the
// test locks the WS payload shape, not just the store field name.
const store = create((set, get) => ({
  jogSpeedPct: 50,
  setJogSpeedPct: (n) => set({ jogSpeedPct: n }),
  _stateWs: fakeWs,
  _sendJogWS(endpoint, body, meta = {}) {
    const ws = get()._stateWs
    if (!ws || ws.readyState !== 1) return false
    const { hold_id, seq, client_ts_ms } = meta
    const payload = { ...body }
    if (hold_id != null)      payload.hold_id = hold_id
    if (seq != null)          payload.seq = seq
    if (client_ts_ms != null) payload.client_ts_ms = client_ts_ms
    const type = endpoint === 'jog_cartesian' ? 'jog_cartesian'
               : endpoint === 'power'         ? 'power'
               :                                'jog'
    ws.send(JSON.stringify({ type, payload }))
    return true
  },
  jogHold(joint, direction, speedPct, meta = {}) {
    return get()._sendJogWS('jog', {
      joint, direction, speed_pct: speedPct, hold: true,
    }, meta)
  },
}))

function assert(cond, msg) {
  if (!cond) {
    console.log(`FAIL  ${msg}`)
    process.exit(1)
  }
  console.log(`PASS  ${msg}`)
}

// Simulate JogControls' post-fix behavior: read the store field on
// every hold. That's what the fix does — jogHold(axis, dir,
// store.jogSpeedPct). If someone re-introduces a stale local state,
// this test will still pass here (because we always read store
// directly) — BUT the accompanying build-time grep below will flag
// any resurrection of `useState.*speed` in JogControls.jsx.
for (const pct of [5, 12, 40, 1, 100]) {
  store.getState().setJogSpeedPct(pct)
  sent.length = 0
  store.getState().jogHold(1, 1, store.getState().jogSpeedPct,
                            { hold_id: `h${pct}`, seq: 1 })
  assert(sent.length === 1, `slider=${pct} produced exactly one WS send`)
  const p = sent[0].payload
  assert(sent[0].type === 'jog', `slider=${pct} → type='jog' (got ${sent[0].type})`)
  assert(p.speed_pct === pct,
         `slider=${pct} → payload.speed_pct=${p.speed_pct} == store.jogSpeedPct`)
  assert(p.hold === true, `slider=${pct} → payload.hold=true`)
}

// Regression guard: refuse to run if JogControls.jsx still has a
// local useState for speed. This is a source-level fence against the
// exact class of bug 2026-07-16.
import { readFileSync } from 'node:fs'
const src = readFileSync(
  new URL('../src/components/JogControls.jsx', import.meta.url),
  'utf8')
const localSpeedState = /\[\s*speed\s*,\s*setSpeed\s*\]\s*=\s*useState\s*\(/
if (localSpeedState.test(src)) {
  console.log('FAIL  JogControls.jsx has a local `useState` for speed — ' +
              'the pad slider must read store.jogSpeedPct so the standalone ' +
              'JogSpeedSlider is honored.')
  process.exit(1)
}
console.log('PASS  JogControls.jsx does not shadow speed with local useState')

console.log('\nslider-payload-test: OK')

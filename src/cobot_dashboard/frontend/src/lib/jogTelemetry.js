// Client-side jog telemetry.
//
// The tablet vs laptop jitter debate came down to "what's actually
// firing when" — this module gives every HoldButton a per-session
// ring buffer of events + interval samples that the JogDebugPanel
// renders in a corner overlay when the debug flag is on (either
// ?jogdebug=1 in the URL or localStorage.JOG_DEBUG === '1').
//
// Zero-cost when the flag is off — every push checks the flag first.

const MAX_EVENTS = 200
const MAX_INTERVALS = 400

const state = {
  events:    [],   // {t, kind, session, ...extras}
  intervals: [],   // {t, kind, target_ms, actual_ms, session}
  listeners: new Set(),
  session:   null,
  wsGaps:    [],   // {t, gap_ms} — inter-message spacing on /ws/state
}

function isEnabled() {
  if (typeof window === 'undefined') return false
  if (state.forceOn) return true
  try {
    if (localStorage.getItem('JOG_DEBUG') === '1') return true
  } catch { /* nop */ }
  try {
    const q = new URLSearchParams(window.location.search)
    if (q.get('jogdebug') === '1') return true
  } catch { /* nop */ }
  return false
}

function bump() {
  for (const fn of state.listeners) {
    try { fn() } catch { /* nop */ }
  }
}

export function jogTelemetryEnabled() { return isEnabled() }

export function jogTelemetryEnable() {
  state.forceOn = true
  try { localStorage.setItem('JOG_DEBUG', '1') } catch { /* nop */ }
  bump()
}

export function jogTelemetryDisable() {
  state.forceOn = false
  try { localStorage.removeItem('JOG_DEBUG') } catch { /* nop */ }
  state.events = []
  state.intervals = []
  state.wsGaps = []
  bump()
}

// Called by every HoldButton when it emits a lifecycle event. `kind` is
// one of: 'pointerdown', 'pointerup', 'pointercancel', 'tick_worker',
// 'tick_raf', 'tick_sent', 'tick_skip_inflight', 'release_sent',
// 'unmount_release'. `extras` is optional metadata.
export function pushJogEvent(kind, extras = {}) {
  if (!isEnabled()) return
  state.events.push({ t: performance.now(), kind, ...extras })
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS)
  }
  bump()
}

// Called every time the ticker actually fires. `target_ms` is the
// requested cadence (100), `actual_ms` is the wall-clock delta from
// the previous fire. Feeds the interval distribution.
export function pushJogInterval(kind, target_ms, actual_ms) {
  if (!isEnabled()) return
  state.intervals.push({
    t: performance.now(), kind, target_ms, actual_ms,
    session: state.session,
  })
  if (state.intervals.length > MAX_INTERVALS) {
    state.intervals.splice(0, state.intervals.length - MAX_INTERVALS)
  }
  bump()
}

export function pushWsGap(gap_ms) {
  if (!isEnabled()) return
  state.wsGaps.push({ t: performance.now(), gap_ms })
  if (state.wsGaps.length > MAX_INTERVALS) {
    state.wsGaps.splice(0, state.wsGaps.length - MAX_INTERVALS)
  }
  bump()
}

export function startJogSession(label = '') {
  if (!isEnabled()) return null
  state.session = `${label || 'S'}-${Math.round(performance.now())}`
  return state.session
}

export function endJogSession() {
  if (!isEnabled()) return
  state.session = null
}

function pctile(arr, p) {
  if (!arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.floor(p * s.length))
  return s[i]
}

export function jogTelemetrySnapshot() {
  const intervals = state.intervals
  const raf    = intervals.filter((r) => r.kind === 'raf').map((r) => r.actual_ms)
  const worker = intervals.filter((r) => r.kind === 'worker').map((r) => r.actual_ms)
  const sent   = intervals.filter((r) => r.kind === 'sent').map((r) => r.actual_ms)
  const gaps   = state.wsGaps.map((r) => r.gap_ms)
  return {
    enabled: isEnabled(),
    events:   state.events.slice(-40),
    session:  state.session,
    counts:   {
      total_intervals: intervals.length,
      total_events:    state.events.length,
      ws_gaps:         state.wsGaps.length,
    },
    tickers: {
      raf:    {n: raf.length,    p50: pctile(raf, 0.5),    p95: pctile(raf, 0.95),    max: raf.length    ? Math.max(...raf)    : null},
      worker: {n: worker.length, p50: pctile(worker, 0.5), p95: pctile(worker, 0.95), max: worker.length ? Math.max(...worker) : null},
      sent:   {n: sent.length,   p50: pctile(sent, 0.5),   p95: pctile(sent, 0.95),   max: sent.length   ? Math.max(...sent)   : null},
    },
    ws: {
      n:  gaps.length,
      p50: pctile(gaps, 0.5),
      p95: pctile(gaps, 0.95),
      p99: pctile(gaps, 0.99),
      max: gaps.length ? Math.max(...gaps) : null,
    },
  }
}

export function jogTelemetrySubscribe(fn) {
  state.listeners.add(fn)
  return () => state.listeners.delete(fn)
}

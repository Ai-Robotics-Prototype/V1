// Hold ticker — belt-and-braces keepalive fire source for jog holds.
//
// setInterval on the main thread is throttled by mobile browsers (iOS
// Safari, Android Chrome) under a variety of conditions: background
// tabs, high battery-saver, low RAM, "unresponsive main thread". The
// tablet-jog jitter surfaced because the driver's 300 ms freshness
// deadman is 3× the intended 100 ms cadence — one throttled interval
// past ~300 ms trips it and interrupts motion. The deadman is a safety
// parameter (Lesson 102 stands); we cannot widen it. Instead this
// module runs the tick from TWO sources simultaneously:
//
//   1. Web Worker — workers are exempt from most page-level timer
//      throttling. Uses a Blob-URL worker so no separate JS asset ships.
//   2. rAF with time accounting — foreground-only, drift-corrected via
//      performance.now() so we don't miss ticks under jank.
//
// Whichever fires first wins; the callback deduplicates via a
// coalescing guard (min interval since last fire). If either source
// dies the other keeps the deadman satisfied.
//
// Callback is NEVER called from inside the Worker — every fire crosses
// back to the main thread where the send-to-network path lives.

import { pushJogInterval } from './jogTelemetry.js'

const WORKER_SRC = `
  let timer = null;
  let target = 100;
  self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'start') {
      target = msg.interval_ms || 100;
      if (timer) clearInterval(timer);
      let lastPost = performance.now();
      timer = setInterval(() => {
        const now = performance.now();
        self.postMessage({ type: 'tick', now: now, gap: now - lastPost });
        lastPost = now;
      }, target);
    } else if (msg.type === 'stop') {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
`

function makeWorker() {
  if (typeof Worker === 'undefined') return null
  try {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' })
    return new Worker(URL.createObjectURL(blob))
  } catch {
    return null
  }
}

// Public: create a hold ticker. Returns { start, stop } handlers.
// `onFire` is called on every effective fire with { source, actual_ms }.
// `interval_ms` is the target cadence.
// `coalesce_ms` is the minimum time between fires (protects against
// two ticker sources firing back-to-back).
export function createHoldTicker({
  interval_ms  = 100,
  coalesce_ms  = 40,
  onFire,
}) {
  let worker = null
  let rafHandle = 0
  let lastFireTs = 0
  let running = false
  let rafLastPost = 0

  // Worker path.
  const onWorkerMessage = (e) => {
    if (!running) return
    if (!e.data || e.data.type !== 'tick') return
    pushJogInterval('worker', interval_ms, e.data.gap ?? 0)
    tryFire('worker')
  }

  // rAF path — polls performance.now() each frame; fires when the
  // gap since the last fire crosses interval_ms. This is drift-
  // corrected — a 40 ms frame followed by a 60 ms frame that puts
  // us over the target only fires ONCE (not once per frame).
  const rafStep = (now) => {
    if (!running) return
    if (now - rafLastPost >= interval_ms) {
      pushJogInterval('raf', interval_ms, now - rafLastPost)
      rafLastPost = now
      tryFire('raf')
    }
    rafHandle = requestAnimationFrame(rafStep)
  }

  const tryFire = (source) => {
    const now = performance.now()
    const since = now - lastFireTs
    if (since < coalesce_ms) return
    lastFireTs = now
    try { onFire && onFire({ source, actual_ms: since }) } catch { /* nop */ }
  }

  return {
    start() {
      if (running) return
      running = true
      lastFireTs = performance.now() - interval_ms   // fire immediately
      rafLastPost = performance.now()
      // Worker
      if (!worker) worker = makeWorker()
      if (worker) {
        worker.onmessage = onWorkerMessage
        worker.postMessage({ type: 'start', interval_ms })
      }
      // rAF fallback
      rafHandle = requestAnimationFrame(rafStep)
    },
    stop() {
      running = false
      if (worker) {
        try { worker.postMessage({ type: 'stop' }) } catch { /* nop */ }
      }
      if (rafHandle) {
        try { cancelAnimationFrame(rafHandle) } catch { /* nop */ }
        rafHandle = 0
      }
    },
    // Fully release the Worker on component unmount so we don't leak
    // the Blob URL / worker thread.
    destroy() {
      this.stop()
      if (worker) {
        try { worker.terminate() } catch { /* nop */ }
        worker = null
      }
    },
    isRunning() { return running },
  }
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import { installAuthInterceptors } from './lib/pairedDevice'

// Install the pairing-token fetch + WebSocket interceptors BEFORE
// React mounts. Fork-registry `device_pairing_auth` — this is the
// only site that patches the global transport for pairing.
installAuthInterceptors()

// Service-worker killswitch — 2026-10-14 operator audit #8B
// (tablet-stale class). The repo has NEVER registered a service
// worker (git history confirms: no `navigator.serviceWorker.
// register` call has ever existed), BUT if a prior short-lived
// deploy, a browser extension, or an upstream Vite preset ever
// installed one, it would persist across deploys and serve old
// cached bundles indefinitely — exactly the symptom seen on the
// tablet. Pre-empt that by actively unregistering any SW scoped
// to this origin on every boot. Cheap no-op when none exists; a
// one-shot cleanup when a stale one does. Also drops the SW cache
// buckets so no cached response survives the unregister.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) {
      reg.unregister().catch(() => { /* best-effort */ })
    }
    if (regs.length > 0 && typeof caches !== 'undefined' && caches.keys) {
      caches.keys().then((names) => {
        for (const n of names) caches.delete(n).catch(() => {})
      }).catch(() => {})
      // eslint-disable-next-line no-console
      console.warn('[sw-killswitch] unregistered', regs.length,
        'stale service worker(s); forcing hard reload once')
      // After unregister the current page may still be controlled
      // by the dying worker. One reload picks up the un-SW'd shell.
      try {
        const u = new URL(window.location.href)
        u.searchParams.set('_swkill', Date.now().toString(36))
        window.location.replace(u.toString())
      } catch { window.location.reload() }
    }
  }).catch(() => { /* best-effort */ })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

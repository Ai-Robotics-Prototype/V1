import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const WS_BASE = typeof window !== 'undefined'
  ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  : 'ws://localhost:8080'

let _stateWs = null
let _lidarWs = null
let _stateBackoff = 1000
let _lidarBackoff = 1000

export const useStore = create(
  persist(
    (set, get) => ({
      // ── state ──────────────────────────────────────────────────────────────
      robotState:    null,
      lidarPoints:   [],
      wsStatus:      'disconnected',
      lidarWsStatus: 'disconnected',
      wsLatency:     0,
      mode:          'operator',
      activeView:    'split',
      jogEnabled:    false,
      jogTimer:      null,
      pendingEstop:  null,

      // ── connect ────────────────────────────────────────────────────────────
      connectWebSockets() {
        _connectState(set, get)
        _connectLidar(set, get)
      },

      // ── commands ───────────────────────────────────────────────────────────
      async sendCommand(endpoint, body) {
        try {
          const res = await fetch(`/cmd/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          return await res.json()
        } catch (e) {
          console.error('sendCommand error', e)
          return null
        }
      },

      setMode(mode)   { set({ mode }) },
      setView(view)   { set({ activeView: view }) },

      unlockJog() {
        const prev = get().jogTimer
        if (prev) clearTimeout(prev)
        const timer = setTimeout(() => set({ jogEnabled: false, jogTimer: null }), 30000)
        set({ jogEnabled: true, jogTimer: timer })
      },

      setPendingEstop(v) { set({ pendingEstop: v }) },
    }),
    {
      name: 'roboai-ui',
      partialize: (s) => ({ mode: s.mode, activeView: s.activeView }),
    }
  )
)

// ── WebSocket connection helpers ───────────────────────────────────────────────

function _connectState(set, get) {
  if (_stateWs && _stateWs.readyState <= 1) return
  set({ wsStatus: 'connecting' })
  _stateWs = new WebSocket(`${WS_BASE}/ws/state`)

  _stateWs.onopen = () => {
    _stateBackoff = 1000
    set({ wsStatus: 'connected' })
  }

  _stateWs.onmessage = (ev) => {
    const t0 = performance.now()
    try {
      const data = JSON.parse(ev.data)
      const latency = Math.round(performance.now() - t0 + (Date.now() - data.t))
      set({ robotState: data, wsLatency: Math.max(0, latency) })
    } catch {}
  }

  _stateWs.onclose = () => {
    set({ wsStatus: 'disconnected' })
    _stateBackoff = Math.min(_stateBackoff * 2, 10000)
    setTimeout(() => _connectState(set, get), _stateBackoff)
  }

  _stateWs.onerror = () => _stateWs.close()
}

function _connectLidar(set, get) {
  if (_lidarWs && _lidarWs.readyState <= 1) return
  set({ lidarWsStatus: 'connecting' })
  _lidarWs = new WebSocket(`${WS_BASE}/ws/lidar`)

  _lidarWs.onopen = () => {
    _lidarBackoff = 1000
    set({ lidarWsStatus: 'connected' })
  }

  _lidarWs.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      set({ lidarPoints: data.points || [] })
    } catch {}
  }

  _lidarWs.onclose = () => {
    set({ lidarWsStatus: 'disconnected' })
    _lidarBackoff = Math.min(_lidarBackoff * 2, 10000)
    setTimeout(() => _connectLidar(set, get), _lidarBackoff)
  }

  _lidarWs.onerror = () => _lidarWs.close()
}

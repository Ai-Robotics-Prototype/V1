import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const HOST = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO =
  typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// Exponential backoff helper
function backoffDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt), 10000)
}

// ---------------------------------------------------------------------------
// Store definition
// ---------------------------------------------------------------------------

const storeDefinition = (set, get) => ({
  // ---- Connection ----
  wsStatus: 'disconnected',
  lidarWsStatus: 'disconnected',
  wsLatency: 0,
  lastMessageTime: 0,

  // ---- Robot state ----
  safety: { zone: 'GREEN', speed_scale: 1.0, estop: false, human_proximity: 2.4 },
  joints: {
    names: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'],
    positions: [0, 0, 0, 0, 0, 0],
    velocities: [0, 0, 0, 0, 0, 0],
  },
  task: {
    state: 'IDLE',
    target: null,
    program_step: 0,
    program_total: 5,
    running: false,
    paused: false,
  },
  detections: [],
  detectionMode: 'all',
  setDetectionMode: (mode) => {
    set({ detectionMode: mode })
    fetch('/cmd/detection_mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).catch(() => {})
  },
  lidar_objects: [],
  placed_objects: [],
  scene_graph: { objects: [] },
  grasp_poses: [],
  gripper: { state: 'open', position_mm: 85 },
  program: { steps: [] },

  // ---- UI state ----
  activeTab: 'monitor',
  activeView: 'split',
  mode: 'operator',
  jogEnabled: false,
  jogJoint: 0,
  _jogTimer: null,
  pendingCommand: null,
  commandError: null,
  toasts: [],

  // ---- LiDAR ----
  lidarPoints: [],

  // ---- Internal WS refs (not serialised) ----
  _stateWs: null,
  _lidarWs: null,
  _stateRetry: 0,
  _lidarRetry: 0,

  // ---------------------------------------------------------------------------
  // WebSocket management
  // ---------------------------------------------------------------------------

  connectWS() {
    get()._connectStateWS()
    get()._connectLidarWS()
  },

  _connectStateWS() {
    const attempt = get()._stateRetry
    set({ wsStatus: 'connecting' })

    const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/state`)

    ws.onopen = () => {
      set({ wsStatus: 'connected', _stateWs: ws, _stateRetry: 0 })
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        const now = Date.now()
        const latency = msg.t ? Math.round(now - msg.t) : 0
        set({
          safety: msg.safety ?? get().safety,
          joints: msg.joints ?? get().joints,
          task: msg.task ?? get().task,
          detections: msg.detections ?? get().detections,
          // Server publishes detection_mode in STATE; keep the store
          // in sync so a fresh page-load picks up whatever mode was
          // last set, even if this client didn't toggle it.
          detectionMode: msg.detection_mode ?? get().detectionMode,
          lidar_objects: msg.lidar_objects ?? get().lidar_objects,
          placed_objects: msg.placed_objects ?? get().placed_objects,
          scene_graph: msg.scene_graph ?? get().scene_graph,
          grasp_poses: msg.grasp_poses ?? get().grasp_poses,
          gripper: msg.gripper ?? get().gripper,
          program: msg.program ?? get().program,
          wsLatency: latency,
          lastMessageTime: now,
        })
      } catch (e) {
        // ignore parse errors
      }
    }

    ws.onerror = () => {
      // Let onclose handle reconnect
    }

    ws.onclose = () => {
      set({ wsStatus: 'disconnected', _stateWs: null })
      const nextAttempt = get()._stateRetry + 1
      set({ _stateRetry: nextAttempt })
      setTimeout(() => get()._connectStateWS(), backoffDelay(nextAttempt))
    }
  },

  _connectLidarWS() {
    const attempt = get()._lidarRetry
    set({ lidarWsStatus: 'connecting' })

    const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/lidar`)

    ws.onopen = () => {
      set({ lidarWsStatus: 'connected', _lidarWs: ws, _lidarRetry: 0 })
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        set({ lidarPoints: msg.points ?? [] })
      } catch (e) {
        // ignore parse errors
      }
    }

    ws.onerror = () => {}

    ws.onclose = () => {
      set({ lidarWsStatus: 'disconnected', _lidarWs: null })
      const nextAttempt = get()._lidarRetry + 1
      set({ _lidarRetry: nextAttempt })
      setTimeout(() => get()._connectLidarWS(), backoffDelay(nextAttempt))
    }
  },

  // ---------------------------------------------------------------------------
  // Command dispatch
  // ---------------------------------------------------------------------------

  async sendCommand(endpoint, body) {
    set({ pendingCommand: endpoint, commandError: null })
    try {
      const res = await fetch(`/cmd/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        const errMsg = data.error || `HTTP ${res.status}`
        set({ pendingCommand: null, commandError: errMsg })
        get().addToast(errMsg, 'error')
        return null
      }
      set({ pendingCommand: null })
      return data
    } catch (err) {
      const errMsg = err.message || 'Network error'
      set({ pendingCommand: null, commandError: errMsg })
      get().addToast(errMsg, 'error')
      return null
    }
  },

  // ---------------------------------------------------------------------------
  // Safety commands
  // ---------------------------------------------------------------------------

  triggerEstop() {
    // Optimistic update
    set((s) => ({ safety: { ...s.safety, estop: true } }))
    get().sendCommand('estop', { active: true })
  },

  releaseEstop() {
    const { safety } = get()
    if (safety.zone !== 'GREEN') {
      get().addToast('Move clear first (> 1.2 m) — zone must be GREEN', 'warning')
      return
    }
    get().sendCommand('estop', { active: false })
  },

  overrideEstop() {
    // Bypass zone check — operator has manually verified area is clear.
    // Speed stays at 0 until zone naturally returns to GREEN.
    get().sendCommand('estop', { active: false, override: true })
  },

  // ---------------------------------------------------------------------------
  // Task commands
  // ---------------------------------------------------------------------------

  runProgram() {
    return get().sendCommand('task', { command: 'run' })
  },

  pauseProgram() {
    return get().sendCommand('task', { command: 'pause' })
  },

  resumeProgram() {
    return get().sendCommand('task', { command: 'resume' })
  },

  homeRobot() {
    return get().sendCommand('task', { command: 'home' })
  },

  cancelProgram() {
    return get().sendCommand('task', { command: 'cancel' })
  },

  // ---------------------------------------------------------------------------
  // Jog commands
  // ---------------------------------------------------------------------------

  jogJoint(joint, delta) {
    if (!get().jogEnabled) {
      get().addToast('Enable manual jog first', 'warning')
      return
    }
    return get().sendCommand('jog', { joint, delta })
  },

  // ---------------------------------------------------------------------------
  // Gripper commands
  // ---------------------------------------------------------------------------

  openGripper() {
    return get().sendCommand('gripper', { action: 'open' })
  },

  closeGripper() {
    return get().sendCommand('gripper', { action: 'close' })
  },

  // ---------------------------------------------------------------------------
  // Voice
  // ---------------------------------------------------------------------------

  sendVoice(text) {
    return get().sendCommand('voice', { text })
  },

  // ---------------------------------------------------------------------------
  // Program editing
  // ---------------------------------------------------------------------------

  addProgramStep(step) {
    return get().sendCommand('program/add', step)
  },

  removeProgramStep(id) {
    return get().sendCommand('program/remove', { id })
  },

  reorderSteps(ids) {
    return get().sendCommand('program/reorder', { ids })
  },

  // ---------------------------------------------------------------------------
  // Jog enable/disable
  // ---------------------------------------------------------------------------

  enableJog() {
    const existing = get()._jogTimer
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      get().disableJog()
      get().addToast('Manual jog disabled (30 s timeout)', 'warning')
    }, 30000)
    set({ jogEnabled: true, _jogTimer: timer })
  },

  disableJog() {
    const timer = get()._jogTimer
    if (timer) clearTimeout(timer)
    set({ jogEnabled: false, _jogTimer: null })
  },

  // ---------------------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------------------

  addToast(message, type = 'info') {
    const id = Date.now() + Math.random()
    const toast = { id, message, type, ts: Date.now() }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    setTimeout(() => get().removeToast(id), 3000)
    return id
  },

  removeToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  setTab(tab) {
    set({ activeTab: tab })
  },

  setView(view) {
    set({ activeView: view })
  },

  setMode(mode) {
    set({ mode })
  },

  setJogJoint(j) {
    set({ jogJoint: j })
  },
})

// Wrap with persist for UI prefs only
export const useStore = create(
  persist(storeDefinition, {
    name: 'roboai-ui',
    partialize: (state) => ({
      mode: state.mode,
      activeTab: state.activeTab,
      activeView: state.activeView,
    }),
  })
)

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
  collision: {
    status: 'clear',
    min_distance_m: null,
    objects: [],
    have_joints: false,
    reach_radius_m: 1.4,
    warn_distance_m: 0.150,
    critical_distance_m: 0.050,
    mock_objects: [],
  },
  openvocab: {
    enabled: false,
    prompts: [],
    detections: [],
    stalled: false,
    inference_ms: 0,
    fps: 0,
    device: '',
    image_w: 0,
    image_h: 0,
    image_topic: '',
    model: '',
    error: null,
    frame_age_s: null,
  },
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
          collision: msg.collision ?? get().collision,
          openvocab: msg.openvocab ?? get().openvocab,
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

  // Dispatches to the program_executor_node via /api/program/run. We
  // keep the legacy /cmd/task sendCommand as a fallback so older code
  // paths (and the sim, when the executor isn't running) still update
  // STATE.task locally. The executor — when alive — overrides STATE.task
  // via its 5Hz /task/state publish, so its view wins.
  async _dispatchProgram(action, opts = {}) {
    const programId = opts.programId
      || (action === 'run' ? get().currentProgram?.id : undefined)
    try {
      await fetch('/api/program/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(programId ? { action, program_id: programId } : { action }),
      })
    } catch (e) { /* swallow; the sim fallback below still runs */ }
    // Keep the legacy task-command path so the sim still progresses
    // when the executor isn't connected.
    const legacy = { run: 'run', pause: 'pause', resume: 'resume',
                     stop: 'cancel', home: 'home' }[action]
    if (legacy) return get().sendCommand('task', { command: legacy })
  },

  runProgram(opts)     { return get()._dispatchProgram('run', opts) },
  pauseProgram()        { return get()._dispatchProgram('pause') },
  resumeProgram()       { return get()._dispatchProgram('resume') },
  homeRobot()           { return get()._dispatchProgram('home') },
  cancelProgram()       { return get()._dispatchProgram('stop') },

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

  updateProgramStep(id, patch) {
    return get().sendCommand('program/update', { id, patch })
  },

  setProgramSteps(steps) {
    return get().sendCommand('program/set', { steps })
  },

  jogCartesian(axis, direction, step, speed) {
    return get().sendCommand('jog_cartesian', { axis, direction, step, speed })
  },

  // Hand-off slot used by the Programs library to load a saved program
  // into the Program tab's editor. ProgramEditor reads it once and
  // clears it; it doesn't survive page reloads.
  loadedProgram: null,
  setLoadedProgram(prog) { set({ loadedProgram: prog }) },

  // ── Active cell — the single source of truth that Configure writes
  // to on Activate and that the 3D View, ProgramWizard, and any other
  // cell-scoped feature read from. Backend authority is
  // /api/cells/active; we hydrate once at app boot and on tab refocus
  // so the store stays in sync even if a cell was activated from
  // another browser session.
  //
  // `activeCellHydrated` tells consumers whether we've heard from the
  // backend yet — this distinguishes the initial-load "we don't know
  // yet" state from a confirmed "there is no active cell" state.
  // Without this, the 3D View briefly flashes "No active cell" before
  // the first /api/cells/active response lands (the original bug).
  activeCellId:       null,
  activeCell:         null,   // last full payload from /api/cells/active
  activeCellHydrated: false,
  // Full cell list — populated by `hydrateCells()` from /api/cells.
  // Configure subscribes to this so its list auto-loads on tab
  // navigation without a manual page refresh. Items follow the
  // /api/cells listing schema: { cell_id, name, baseline_captured,
  // is_active, ... }.
  cellsList:          [],
  cellsHydrated:      false,
  // When the last hydrate started — used to throttle: we'll happily
  // re-hydrate when /configure is focused but won't thrash the
  // backend if two effects fire within ~500 ms of each other.
  _cellsLastHydrate:  0,
  setActiveCellId(id, cell) {
    set((s) => {
      const next = {
        activeCellId:       id || null,
        activeCellHydrated: true,
      }
      // Merge a fresh `cell` payload if the caller provided one; keep
      // the previous one otherwise (Configure's local refresh and the
      // hydrate fetch can disagree on which fields they include).
      if (cell !== undefined) next.activeCell = cell || null
      else if ((id || null) !== s.activeCellId) next.activeCell = null
      return next
    })
  },
  async hydrateCells({ force = false } = {}) {
    // Throttle redundant calls — Configure re-mount, App tab change,
    // and visibilitychange can all fire within the same animation
    // frame on a fresh tab navigation. The first call populates
    // the store; the rest within 500 ms become no-ops.
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()
    if (!force && (now - (get()._cellsLastHydrate || 0)) < 500) return
    set({ _cellsLastHydrate: now })
    try {
      const r = await fetch('/api/cells')
      if (!r.ok) {
        // Backend reachable but the list endpoint failed — still mark
        // hydrated so consumers can stop showing "loading…" and the
        // operator sees the genuine empty state with an error chip
        // instead of an indefinite spinner.
        set({ cellsHydrated: true, activeCellHydrated: true })
        return
      }
      const j = await r.json()
      const cells = Array.isArray(j?.cells) ? j.cells : []
      const aid   = j?.active_cell_id || null
      const activeCell = aid ? (cells.find((c) => c.cell_id === aid) || null) : null
      set({
        cellsList:          cells,
        cellsHydrated:      true,
        activeCellId:       aid,
        activeCell:         activeCell,
        activeCellHydrated: true,
      })
    } catch {
      set({ cellsHydrated: true, activeCellHydrated: true })
    }
  },
  // Backward-compat shim. Some consumers (boot, the 3D View) only
  // care about the active cell — they don't need the full list — but
  // we still fold them into the same fetch so a single network
  // round-trip serves everyone.
  async hydrateActiveCell() {
    return get().hydrateCells()
  },
  // Imperative refresh — invoked by Configure on wizard close, on
  // delete, etc. Skips the throttle since the caller knows the
  // backend just changed.
  async refreshCells() {
    return get().hydrateCells({ force: true })
  },

  // ── Programs list — same pattern as cellsList. Populated by
  // hydratePrograms() from /api/programs; consumed by
  // ProgramLibrary so a tab-switch doesn't flash an empty list and
  // a just-saved program is visible immediately. After ProgramEditor.
  // handleSave we call refreshPrograms() so the cache is current
  // before the operator navigates to Library.
  programsList:         [],
  programsHydrated:     false,
  _programsLastHydrate: 0,
  async hydratePrograms({ force = false } = {}) {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()
    if (!force && (now - (get()._programsLastHydrate || 0)) < 500) return
    set({ _programsLastHydrate: now })
    try {
      const r = await fetch('/api/programs')
      if (!r.ok) {
        set({ programsHydrated: true })
        return
      }
      const j = await r.json()
      const programs = Array.isArray(j?.programs) ? j.programs : []
      set({
        programsList:     programs,
        programsHydrated: true,
      })
    } catch {
      set({ programsHydrated: true })
    }
  },
  async refreshPrograms() {
    return get().hydratePrograms({ force: true })
  },

  // The editor's authoritative state — survives ProgramEditor unmount
  // so switching tabs and coming back preserves the program identity,
  // steps, and unsaved flag. Step mutations update this slice locally;
  // Save and Load mirror it to STATE.program via setProgramSteps so the
  // task runner (which reads STATE) stays in sync with the last saved
  // version of the program.
  currentProgram: {
    id: null,
    name: 'Untitled Program',
    steps: [],
    unsaved: false,
    // Full program.config payload (gripper, pallet, motion_profile_name,
    // pallet_mode, pick_tcp, place_tcp, etc.). Loaded on Library → Edit
    // so the editor can mutate pallet configuration and send it back
    // through PUT /api/programs/{id}.
    config: {},
    description: '',
    tags: [],
    cell_id: null,
  },
  setCurrentProgram(patch) {
    set((s) => ({ currentProgram: { ...s.currentProgram, ...patch } }))
  },

  // Program-tab layout dimensions — kept in the store (and persisted)
  // so switching to another tab and back keeps the panels at the
  // sizes the operator dragged them to.
  programLayout: {
    leftWidth:    560,
    jogHeight:    500,
    jogMaximized: false,        // legacy alias — kept for persisted state
    expandedPanel: null,         // 'steps' | '3d' | 'jog' | null
  },
  setProgramLayout(patch) {
    set((s) => ({ programLayout: { ...s.programLayout, ...patch } }))
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
  // Alias — matches the name external diagnostic scripts grep for.
  setActiveTab(tab) {
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
      // Persist the editor's current draft (id / name / steps / unsaved)
      // across page reloads. A user mid-edit who accidentally hits F5
      // shouldn't lose their work — and switching tabs only un-mounts
      // the component, the store-backed slice survives either way.
      currentProgram: state.currentProgram,
      // Same idea for the Program tab's resizable layout — dragging the
      // dividers should outlive a tab switch and a page reload.
      programLayout:  state.programLayout,
    }),
  })
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pushWsGap as _pushWsGap } from '../lib/jogTelemetry'

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

  // ---- Jog speed (0-100 %) ----
  // Reusable knob. Currently drives ONLY the twin animation speed for
  // quick-orient / home / any future twin-side interpolated moves.
  // TODO(motion): when commanded motion is enabled (write-command
  // format captured, signs verified, Remote mode on the pendant),
  // this becomes speed_pct on /estun/move — safety-capped by
  // global_speed_cap_pct in estun_driver. Do NOT wire that path
  // without an explicit safety review; monitor_only stays true.
  jogSpeedPct: 50,
  setJogSpeedPct(pct) {
    const n = Math.max(0, Math.min(100, Number(pct)))
    if (Number.isFinite(n)) set({ jogSpeedPct: n })
  },

  // ---- Robot state ----
  safety: { zone: 'GREEN', speed_scale: 1.0, estop: false, human_proximity: 2.4 },
  joints: {
    names: ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'],
    positions: [0, 0, 0, 0, 0, 0],
    velocities: [0, 0, 0, 0, 0, 0],
  },
  // Real-arm state — mirrored from dashboard_server, which listens to
  // /estun/status. IncrementalJogPanel disables its buttons while
  // jog_active is true or connected is false.
  robot: {
    connected: false,
    mode: 'unknown',
    safety_mode: 'unknown',
    status_flag: 0,
    moving: false,
    jog_active: false,
    jog_mode: null,
    jog_index: 0,
    jog_direction: 0,
    allow_jog: false,
    allow_cartesian_jog: false,
    // Power transition surface — read-only mirror of the driver's
    // /estun/status. `allow_power` gates the /cmd/power endpoint; the
    // banner uses `enabled`, `enabling`, and `alarm` to pick the label.
    allow_power: false,
    enabled: false,
    enabling: false,
    alarm: false,
    alarm_count: 0,
    state_code: 0,
    state_name: '',
    // Structured active alarm from the controller. Shape (or null):
    //   {severity: int, code: int, ts: float, text: string}
    // Banner interprets `code` to pick recovery copy — 2002 joint-limit
    // is the operator's most common lockout.
    active_alarm: null,
    // Most recent driver-side stop reason string (from _stop_jog_locked).
    // Rendered as a transient toast/banner line while last_stop_ts is
    // recent (see JogControls). Empty until the first stop.
    last_stop_reason: '',
    last_stop_ts: 0,
    // Per-joint limit evaluation — one entry per joint, driver-side.
    // Each: {joint, current_deg, limit_deg, margin_deg, out_of_range,
    //        near_limit, headroom_deg}. Populated by /estun/status.
    joint_limits: [],
    // Self-collision guard mirror. `collision_pair` is [linkA, linkB]
    // when any capsule pair is under `collision_warn_mm`; the twin uses
    // it to tint those two links (amber ≤ warn, red ≤ stop). Values
    // update live at the same cadence as the state broadcast.
    collision_enabled: false,
    collision_pair: null,
    collision_min_mm: null,
    collision_warn_mm: 80.0,
    collision_stop_mm: 30.0,
    collision_warning: false,
    // Environment (static-obstacle) telemetry — separate from
    // self-collision because the escape popup is env-specific
    // (self-collision hands off to Joint mode / open-the-pose copy).
    env_zone_count: 0,
    env_pair: null,          // [link, "zone#<id>"] or null
    env_min_mm: null,
    env_warn_mm: 80.0,
    env_stop_mm: 30.0,
    // Driver-computed escape directions when in the warn zone.
    // Each: {joint, direction, projected_mm, current_mm}.
    env_escape_dirs: [],
    // Unified guard state — used by the guard popup for ANY collision
    // kind (self / ground / env). Driver publishes whichever pair is
    // closest into these keys with a `guard_kind` discriminator.
    guard_active: false,
    guard_kind: null,          // 'self' | 'ground' | 'env' | null
    guard_pair: null,
    guard_min_mm: null,
    guard_warn_mm: 80.0,
    guard_stop_mm: 30.0,
    guard_escapes: [],
    ground_z_mm: -300.0,
  },

  // Alarm recovery modal UI state — the modal auto-opens whenever an
  // alarm or out-of-range condition arises (see AlarmRecoveryModal).
  // The operator can minimize it to see the 3D twin behind; minimize
  // sets `alarmModalMinimized: true` and the banner grows a "Recovery
  // guide" button to re-open. Minimize is the ONLY way to close while
  // the condition persists — full-close only happens automatically
  // after a successful enable (2 s READY confirmation).
  // Reset to false on every fresh alarm transition so the modal
  // always demands attention when something new arrives.
  alarmModalMinimized: false,
  setAlarmModalMinimized(v) { set({ alarmModalMinimized: !!v }) },

  // 3D View tab's REAL-ARM jog panel visibility. Three states —
  // 'MINIMIZED' shows a dockable pill, 'NORMAL' shows the panel
  // beside the viewer, 'EXPANDED' fills the tab area (only one
  // panel can be expanded at a time; if a future viewer panel adopts
  // the same pattern it toggles this off when it expands).
  view3dJogPanel: 'NORMAL',
  setView3dJogPanel(mode) {
    if (mode === 'MINIMIZED' || mode === 'NORMAL' || mode === 'EXPANDED') {
      set({ view3dJogPanel: mode })
    }
  },

  // JogControls press style — mirrors the factory pendant's Jogging/
  // Inching split. STEP = one increment per press (no hold-repeat);
  // CONTINUOUS = motion while held. Applies to both Joint and Cartesian.
  // Default STEP: the conservative one. Persisted in Zustand (memory
  // only — no localStorage; a fresh page load resets to STEP).
  jogStyle: 'STEP',
  setJogStyle(style) {
    if (style === 'STEP' || style === 'CONTINUOUS') set({ jogStyle: style })
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
  // Cross-tab signal: the Program editor's detect step sets this to
  // true before switching to the Part Recognition tab; AdaptivePicking
  // reads + clears it on mount and opens the Teach New Part wizard.
  pendingTeachNew: false,
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
        // Jog telemetry — record inter-message gap on the state
        // channel so the tablet-vs-laptop RTT breakdown has real
        // numbers to look at. pushWsGap is a no-op when telemetry
        // is off, so this stays free of cost in prod.
        if (typeof performance !== 'undefined') {
          const nowP = performance.now()
          const prev = get()._lastWsMsgTs
          if (prev) {
            try { _pushWsGap(nowP - prev) } catch { /* nop */ }
          }
          get()._lastWsMsgTs = nowP
        }
        // ACK-gated state protocol (2026-07-16). Server sends the next
        // frame only after we ack this one, which bounds in-flight to
        // one frame and prevents the OS TCP send buffer from
        // accumulating multi-second backlogs on slow clients. We ack
        // BEFORE the set() so the ack is on the wire while React does
        // the re-render work — that way the server's next frame is
        // already being prepped and the pipeline is filled cleanly.
        // Pre-ACK server versions still work: they ignore the ack
        // (WS receiver treats unknown messages as no-op).
        if (msg.seq && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'state_ack', seq: msg.seq })) }
          catch (_) { /* socket closing — sender falls back to timeout gate */ }
        }
        set({
          safety: msg.safety ?? get().safety,
          joints: msg.joints ?? get().joints,
          robot: msg.robot ?? get().robot,
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

  // ── Robot power (enable / disable / clear_alarm) ────────────────────
  // Distinct from motion: transitions the servo state, not motion state.
  // The banner's Enable / Disable / Clear-Alarm buttons all funnel here
  // AFTER an operator confirmation dialog — no auto-callers. Every call
  // routes through the backend's /cmd/power, which validates the action
  // string and publishes onto /robot/power_command. The driver's
  // allow_power gate is the real safety layer; this helper is just the
  // transport. Returns the parsed response body (or null on error).
  sendPowerCommand(action) {
    if (action !== 'enable' && action !== 'disable' && action !== 'clear_alarm') {
      get().addToast(`Unknown power action: ${action}`, 'error')
      return Promise.resolve(null)
    }
    // WS-first, HTTP fallback — mirror the jog transport. Power gestures
    // are already gated by a confirmation dialog and are infrequent, so
    // either path is fine; WS eliminates handshake cost during degraded
    // dashboards.
    if (get()._sendJogWS('power', { action })) {
      return Promise.resolve({ ok: true, action, transport: 'ws' })
    }
    return get().sendCommand('power', { action })
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

  // Monitor Run button. Opens the confirm modal instead of firing the
  // run directly — the ladder-proven pipeline is destructive (overwrites
  // the controller's stored program on every press) and moves the real
  // arm, so the operator needs to see program name + step count +
  // effective speed + move-gate status before proceeding. The actual
  // POST /api/estun/program/run happens inside RunProgramModal on
  // Confirm. Passing {sim:true} bypasses the modal for the legacy sim
  // flow (executor + /task/run_program).
  runProgram(opts = {}) {
    if (opts.sim) return get()._dispatchProgram('run', opts)
    return get().openRunModal()
  },
  // Pause / Resume go through the ladder verbs (project/pause,
  // project/resume). Pause is still SOURCE-ONLY behavior-wise; a future
  // ladder rung will lift the flag. If the driver refuses (gate closed,
  // etc.), the rejection surfaces on STATE.robot.rejected.
  async pauseProgram() {
    try { await fetch('/api/estun/program/pause', { method: 'POST' }) }
    catch (_) { /* fall through to sim */ }
    return get()._dispatchProgram('pause')
  },
  async resumeProgram() {
    try { await fetch('/api/estun/program/run', { method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ program_id: get().currentProgram?.id }) }) }
    catch (_) { /* fall through to sim */ }
    return get()._dispatchProgram('resume')
  },
  // Return Home — dispatches through /api/robot/home, the wire-
  // verified path that synthesises a one-step move_home program in
  // memory and drives it through the estun /estun/program save→run
  // pipeline. The old {action:'home'} path was orphaned: it went via
  // /task/run_program → program_executor_node → /estun/command, and
  // /estun/command is bound to the driver's catch-all reject handler
  // (silent). Every failure mode of the new endpoint surfaces a JSON
  // body with a specific `outcome.kind` — this handler turns each
  // into a toast so the operator never sees a silent no-op.
  async homeRobot() {
    try {
      const res  = await fetch('/api/robot/home', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (data.ok) {
        get().addToast?.(
          `Homing at ${data.effective_pct || '?'}%`, 'info')
        return { ok: true }
      }
      const msg = data.error || `home failed (HTTP ${res.status})`
      get().addToast?.(msg, 'warning')
      return { ok: false, error: msg, outcome: data.outcome }
    } catch (e) {
      const msg = `home dispatch failed: ${e?.message || e}`
      get().addToast?.(msg, 'error')
      return { ok: false, error: msg }
    }
  },
  // Stop → project/stop, the wire-proven ladder-rung-1 verb. Falls
  // through to the sim's cancel so both paths land at rest.
  async cancelProgram() {
    try { await fetch('/api/estun/program/stop', { method: 'POST' }) }
    catch (_) { /* fall through to sim */ }
    return get()._dispatchProgram('stop')
  },
  // Clear the driver's latched error (also stops the 3 Hz publish/Error
  // reflood on the controller). Wired to the error modal below.
  async clearProgramError() {
    try { await fetch('/api/estun/program/clear_error', { method: 'POST' }) }
    catch (_) { /* no-op */ }
  },

  // Point-table teach flow. All calls are same-origin fetches to the
  // dashboard's /api/programs/{id}/points endpoints; the backend
  // snapshots the LIVE pose from the driver's /estun/status mirror
  // atomically at teach time, so we don't have to pass joints from
  // the client (avoids a client-server race on a fast operator).
  //
  // SAFETY: teach never publishes to /estun/program and never touches
  // allow_move. The gate governs Run only. That separation is
  // enforced backend-side by the endpoints living outside the
  // gate check block.
  async _pointsFetch(method, path, body = null) {
    const opts = { method }
    if (body !== null) {
      opts.headers = { 'Content-Type': 'application/json' }
      opts.body = JSON.stringify(body)
    }
    const res = await fetch(path, opts)
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  },
  // Fetches the current version of the currently-loaded program from
  // the server and merges into currentProgram (so points + steps +
  // has_taught_poses stay in sync after any teach/rename/delete).
  // Rename a program to a controller-safe slug. Server derives the
  // new id from newName (lowercase-alnum-only). On success, updates
  // currentProgram so the editor picks up the new id + name without
  // needing a reload. Used by the "Rename to controller-safe id"
  // affordance next to Save when currentProgram.id contains an
  // underscore or otherwise fails the ^[a-z0-9]+$ round-trip test.
  async renameProgram(oldId, newName) {
    if (!oldId || !newName) return null
    try {
      const res = await fetch(`/api/programs/${encodeURIComponent(oldId)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        get().addToast(data?.error || `rename failed (HTTP ${res.status})`, 'warning')
        return null
      }
      // Load the renamed file (which may have gained a numeric suffix
      // if the target slug already existed) into currentProgram.
      get().setCurrentProgram({
        id: data.program.id, name: data.program.name,
        description: data.program.description || '',
        steps: data.program.steps || [],
        config: data.program.config || {}, tags: data.program.tags || [],
        cell_id: data.program.cell_id || null,
        points: data.program.points || {},
        source: data.program.source,
        unsaved: false,
      })
      get().refreshPrograms?.()
      get().addToast(`Renamed ${oldId} → ${data.program.id}`, 'success')
      return data.program
    } catch (e) {
      get().addToast(`Network error during rename: ${e?.message || e}`, 'warning')
      return null
    }
  },

  async _refreshCurrentProgram() {
    const id = get().currentProgram?.id
    if (!id) return
    try {
      const res = await fetch('/api/programs/' + encodeURIComponent(id))
      if (!res.ok) return
      const full = await res.json()
      if (full && full.id) {
        get().setCurrentProgram({
          id:         full.id,
          name:       full.name,
          description: full.description || '',
          steps:      Array.isArray(full.steps) ? full.steps : get().currentProgram.steps,
          config:     full.config || {},
          tags:       Array.isArray(full.tags) ? full.tags : [],
          points:     full.points || {},
          source:     full.source,
          has_taught_poses: full.has_taught_poses,
        })
      }
    } catch (_) { /* silent — next tick refresh, if any, will retry */ }
  },
  async teachCurrentPose({ label } = {}) {
    const id = get().currentProgram?.id
    if (!id) {
      get().addToast('Load or save a program first, then teach', 'warning')
      return null
    }
    const { ok, status, data } = await get()._pointsFetch(
      'POST', `/api/programs/${encodeURIComponent(id)}/points`,
      label ? { label } : {})
    if (!ok) {
      const msg = data?.error || `teach failed (HTTP ${status})`
      get().addToast(msg, 'warning')
      return null
    }
    await get()._refreshCurrentProgram()
    get().addToast(`Taught ${data.point.name}${label ? ' — ' + label : ''}`, 'success')
    return data.point
  },
  async retachPoint(name) {
    const id = get().currentProgram?.id
    if (!id) return null
    const { ok, status, data } = await get()._pointsFetch(
      'PUT', `/api/programs/${encodeURIComponent(id)}/points/${encodeURIComponent(name)}`,
      { retach: true })
    if (!ok) {
      get().addToast(data?.error || `re-teach failed (HTTP ${status})`, 'warning')
      return null
    }
    await get()._refreshCurrentProgram()
    get().addToast(`Re-taught ${name}`, 'success')
    return data.point
  },
  async renamePoint(name, newName) {
    const id = get().currentProgram?.id
    if (!id) return null
    if (!newName || newName === name) return null
    const { ok, status, data } = await get()._pointsFetch(
      'PUT', `/api/programs/${encodeURIComponent(id)}/points/${encodeURIComponent(name)}`,
      { new_name: newName })
    if (!ok) {
      get().addToast(data?.error || `rename failed (HTTP ${status})`, 'warning')
      return null
    }
    await get()._refreshCurrentProgram()
    return data.point
  },
  async relabelPoint(name, label) {
    const id = get().currentProgram?.id
    if (!id) return null
    const { ok, status, data } = await get()._pointsFetch(
      'PUT', `/api/programs/${encodeURIComponent(id)}/points/${encodeURIComponent(name)}`,
      { label: label || null })
    if (!ok) {
      get().addToast(data?.error || `relabel failed (HTTP ${status})`, 'warning')
      return null
    }
    await get()._refreshCurrentProgram()
    return data.point
  },
  async deletePoint(name) {
    const id = get().currentProgram?.id
    if (!id) return false
    const { ok, status, data } = await get()._pointsFetch(
      'DELETE', `/api/programs/${encodeURIComponent(id)}/points/${encodeURIComponent(name)}`)
    if (!ok) {
      if (status === 409 && Array.isArray(data?.in_use_by)) {
        get().addToast(
          `Can't delete ${name}: step(s) ${data.in_use_by.map(i => '#' + (i + 1)).join(', ')} still use it. Re-target or delete those steps first.`,
          'warning')
      } else {
        get().addToast(data?.error || `delete failed (HTTP ${status})`, 'warning')
      }
      return false
    }
    await get()._refreshCurrentProgram()
    return true
  },
  // Append a movJ step that references a taught point by name. The
  // caller usually clicks a "+ Insert step" button next to a point
  // in the Points panel — the fastest way to author "movJ p1; movJ p2".
  async addMoveStepForPoint(name) {
    const cp = get().currentProgram
    if (!cp?.id) return false
    const steps = Array.isArray(cp.steps) ? [...cp.steps] : []
    steps.push({
      action: 'move',
      type:   'move',
      label:  `Move to ${name}`,
      point_name: name,
      taught: true,
      id:     Date.now(),
    })
    // Save via PUT so the change is durable AND the backend's
    // has_taught_poses recomputes for us on the next refresh.
    const { ok, status, data } = await get()._pointsFetch(
      'PUT', `/api/programs/${encodeURIComponent(cp.id)}`,
      { steps, name: cp.name, description: cp.description || '' })
    if (!ok) {
      get().addToast(data?.error || `add-step failed (HTTP ${status})`, 'warning')
      return false
    }
    await get()._refreshCurrentProgram()
    get().addToast(`Added step: movJ(${name})`, 'success')
    return true
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

  // ── Continuous hold-to-jog ────────────────────────────────
  // JogControls calls jogHold on press + every ~150 ms while held,
  // and jogRelease on release / touchcancel / unmount. The backend
  // translates hold:true / hold:false into /robot/jog_command frames
  // consumed by the driver's continuous-jog state machine.
  //
  // No jogEnabled toast gate here — the driver enforces gates
  // (monitor_only, allow_jog); a spurious hold under a closed gate
  // becomes a rejection log line rather than a UI-side warning.

  // Send a jog frame — WS-first, HTTP fallback. When the state WebSocket
  // is OPEN, jog holds/refreshes/releases ride the persistent channel:
  //   - no per-request TLS handshake / TCP connection cost (dashboard
  //     server's degraded event loop was pushing HTTP POST latency past
  //     the 300 ms driver freshness deadman — this cuts that path out),
  //   - ordered delivery (HTTP/1.1 parallel connections can reorder;
  //     seq=2-before-seq=1 was showing up in the driver log),
  //   - no in-flight promise to hang, so the doRefresh coalesce guard
  //     never trips on the WS path.
  // When the WS is not connected (initial page load / reconnect / server
  // restart), we fall back to fetch — the driver-side deadman is the
  // ultimate stop if the fallback stalls.
  // endpoint ∈ {'jog', 'jog_cartesian', 'power'}. Returns true if a send
  // was dispatched (WS or HTTP), false only when the WS is closed and
  // the HTTP fetch also throws — best-effort, no toasts, no retries.
  _sendJogWS(endpoint, body, meta = {}) {
    const ws = get()._stateWs
    if (!ws || ws.readyState !== 1 /* OPEN */) return false
    const { hold_id, seq, client_ts_ms } = meta
    const payload = { ...body }
    if (hold_id != null)      payload.hold_id = hold_id
    if (seq != null)          payload.seq = seq
    if (client_ts_ms != null) payload.client_ts_ms = client_ts_ms
    const type = endpoint === 'jog_cartesian' ? 'jog_cartesian'
               : endpoint === 'power'         ? 'power'
               :                                'jog'
    try {
      ws.send(JSON.stringify({ type, payload }))
      return true
    } catch {
      return false
    }
  },

  // Low-level jog transport — WS first, HTTP fallback. No UI toast on
  // failure: refresh cadence is 10 Hz and would spam.
  async _postJog(endpoint, body, meta = {}) {
    // WS fast path.
    if (get()._sendJogWS(endpoint, body, meta)) return true
    // HTTP fallback. Coalescing (skip-if-in-flight) lives one layer up
    // in HoldButton.doRefresh; the previous 400 ms abort-and-refire
    // self-heal was killing slow-but-viable requests and has been
    // removed there — a slow fallback fetch is now allowed to complete.
    const { signal, hold_id, seq, client_ts_ms } = meta
    const fullBody = { ...body }
    if (hold_id != null)      fullBody.hold_id = hold_id
    if (seq != null)          fullBody.seq = seq
    if (client_ts_ms != null) fullBody.client_ts_ms = client_ts_ms
    try {
      const res = await fetch(`/cmd/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullBody),
        signal,
      })
      try { await res.text() } catch { /* nop */ }
      return res.ok
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 20)) return false
      return false
    }
  },

  jogHold(joint1based, direction, speedPct, meta = {}) {
    return get()._postJog('jog', {
      joint: joint1based,
      direction,
      speed_pct: speedPct,
      hold: true,
    }, meta)
  },

  jogHoldCartesian(axisLetter, direction, speedPct, meta = {}) {
    return get()._postJog('jog_cartesian', {
      axis: axisLetter,
      direction,
      speed_pct: speedPct,
      hold: true,
    }, meta)
  },

  jogRelease(mode = 'joint', meta = {}) {
    // Idempotent — safe to call more than once (touchcancel + touchend
    // etc.). Backend maps to /robot/jog_command with hold:false, which
    // the driver treats as an explicit stop.
    const endpoint = mode === 'cartesian' ? 'jog_cartesian' : 'jog'
    return get()._postJog(endpoint, { hold: false }, meta)
  },

  // Tap → single-step increment. Joint uses the driver's time-boxed
  // delta_deg path (angle-bounded, driver owns stop timing). Cartesian
  // uses the new fixed-duration mode:2 pulse (see driver docstring).
  jogIncrement(joint1based, deltaDeg) {
    return get()._postJog('jog', {
      joint: joint1based,
      delta_deg: deltaDeg,
    })
  },

  jogPulseCartesian(axisLetter, direction, speedPct) {
    return get()._postJog('jog_cartesian', {
      axis: axisLetter,
      direction,
      speed_pct: speedPct,
      pulse: true,
    })
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
    // Taught-point table — {name: {joints[6 deg], tcp[6], label, taught_at}}.
    // Populated by /api/programs/{id}/points endpoints; drives varspoint
    // codegen when steps reference points by name.
    points: {},
    source: null,
    has_taught_poses: false,
  },
  setCurrentProgram(patch) {
    set((s) => ({ currentProgram: { ...s.currentProgram, ...patch } }))
    // Reset runSpeedPct to whatever the newly-loaded program's config
    // says, clamped 1..100. Only fires when the program's identity
    // OR its config.speed_pct actually changed — editing a step
    // without touching speed shouldn't reset the operator's manual
    // speed selection. `patch.id` is the reliable identity marker
    // (setCurrentProgram is used both for whole-program loads AND
    // for {unsaved:true} field-level updates).
    const cfg = patch?.config
    if (patch?.id !== undefined || (cfg && 'speed_pct' in cfg)) {
      const raw = Number(cfg?.speed_pct ?? patch?.speed_pct)
      if (Number.isFinite(raw) && raw > 0) {
        set({ runSpeedPct: Math.max(1, Math.min(100, Math.round(raw))) })
      }
    }
  },

  // Monitor "Run Program" confirm modal. The button opens this;
  // RunProgramModal renders the confirm/error/ok sequence and POSTs
  // /api/estun/program/run when the operator confirms. See the
  // RunProgramModal comment header for the full ladder-pipeline flow.
  runModalOpen: false,
  openRunModal()  { set({ runModalOpen: true })  },
  closeRunModal() { set({ runModalOpen: false }) },

  // Live step-preview panel expand/collapse. Session-scoped only —
  // NOT persisted (see partialize below). Defaults to expanded so a
  // fresh page load shows the operator step-by-step progress; the
  // operator can collapse it manually and their choice sticks until
  // the tab closes.
  stepPanelOpen: true,
  setStepPanelOpen(v) { set({ stepPanelOpen: !!v }) },

  // Monitor speed entry (integer % 1..100). Truth-in-UI display: the
  // driver's operator_speed_limit is the HARD cap; whatever the
  // operator enters here is clamped to [1, 100] first (invalid values
  // toast a clamp reason), then compared to the cap for display. The
  // effective % is min(entered, operator_cap_pct). See
  // RunProgramModal for the render + POST body wiring.
  //
  // Default 10 (safe conservative). Reset to program.config.speed_pct
  // whenever a program is loaded via setCurrentProgram({config:…}).
  // NOT persisted to localStorage — the operator's per-session choice
  // shouldn't leak into a fresh page-load, and program-editor changes
  // to speed_pct win.
  runSpeedPct: 10,
  setRunSpeedPct(rawInput) {
    // Accepts numbers or strings. Non-numeric / empty → falls back to
    // current value with an addToast('warning', …) so the operator
    // sees WHY their entry didn't stick.
    const cur = get().runSpeedPct
    if (rawInput === '' || rawInput === null || rawInput === undefined) {
      get().addToast('Speed must be an integer 1–100', 'warning')
      set({ runSpeedPct: cur }); return cur
    }
    let n = Number(rawInput)
    if (!Number.isFinite(n)) {
      get().addToast(`Speed ${JSON.stringify(rawInput)} isn't a number (kept ${cur}%)`, 'warning')
      set({ runSpeedPct: cur }); return cur
    }
    n = Math.round(n)
    if (n < 1) {
      get().addToast(`Speed ${n} clamped to 1%`, 'warning')
      n = 1
    } else if (n > 100) {
      get().addToast(`Speed ${n} clamped to 100%`, 'warning')
      n = 100
    }
    set({ runSpeedPct: n }); return n
  },

  // Program-tab layout dimensions used to live here (leftWidth /
  // jogHeight / expandedPanel) — removed 2026-07-23 when the Program
  // tab collapsed to a single full-width editor. Any old value in
  // localStorage is ignored on rehydrate; no migration needed since
  // the field is unread after this change.

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

  setPendingTeachNew(v) {
    set({ pendingTeachNew: !!v })
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
      // Persist the jog speed % so the operator's chosen speed survives
      // page reloads.
      jogSpeedPct:    state.jogSpeedPct,
    }),
  })
)

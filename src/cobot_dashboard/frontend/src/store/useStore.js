import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { pushWsGap as _pushWsGap, pushJogStop }
  from '../lib/jogTelemetry'

const HOST = typeof window !== 'undefined' ? window.location.host : 'localhost:8080'
const WS_PROTO =
  typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'

// Per-page-load client id, sent as `X-Client-Id` on every program
// mutation so the server can tag `program_changed` events with the
// originator and every OTHER client refetches while THIS client
// ignores its own echo. Regenerated per tab so two tabs on the same
// device still see each other's edits.
export const CLIENT_ID = (() => {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch { /* fall through */ }
  return 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
})()

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
  // Cross-client staleness invariant (2026-07-31 §D10 in the
  // Program Doctrine). programRevConfirmed goes:
  //   * true  — a fresh /api/programs/<id> fetch confirmed the
  //             held rev matches the server's, AND the WS is up
  //             (so any subsequent program_changed event will
  //             reach us on the next state frame).
  //   * false — either the WS is down OR the WS just reconnected
  //             and we haven't yet completed the post-reconnect
  //             refetch. In this window taught badges MUST render
  //             a "state syncing…" indicator instead of a confident
  //             green ✓. Never assert state we can't back with a
  //             fresh read.
  // The one place we FLIP this true is at the tail of
  // _refreshCurrentProgram (successful fetch). We flip it false
  // on WS onclose AND on WS onopen when this isn't the first
  // connect (the reconnect path always distrusts pre-drop state).
  programRevConfirmed: false,
  // Marker so onopen can tell "first connect" (initial page load)
  // from "reconnect" (WS came back). First connect: normal load
  // path is responsible for the initial fetch. Reconnect: the
  // onopen handler triggers a defensive refetch.
  _hasConnectedOnce: false,
  // Reconcile log — session-only ring of {ts, kind, detail}
  // recording every WS open/close, visibility resume, reconcile
  // start/done event. Capped at 64. Directive (2026-07-31): "log
  // reconnect+reconcile events client-side so the next report can
  // say which device reconciled when." Access via
  //   useStore.getState()._reconcileLog
  // in devtools. Not persisted — a page refresh clears it.
  _reconcileLog: [],
  // Deploy-aware "new version — refresh" state. serverBundleId is
  // the asset hash the SERVER is currently serving (fetched via
  // /api/build_id). __BUILD_ID__ (defined by vite at build time)
  // is the asset hash this bundle was BUILT with. Mismatch means
  // the operator's tab is running an obsolete bundle — surface a
  // standing toast so every-open-tab-invisibly-obsolete-six-times
  // never happens again.
  serverBundleId: null,
  bundleObsolete: false,
  // Same-machine Date.now() of the most recent WS frame carrying a
  // robot.program.state value. Used ONLY by isStateStreamStale so
  // the wedge banner can distinguish a real controller wedge from
  // a stale stream. 0 means "never received a program.state frame
  // this session" (freshly-loaded page).
  lastProgramStateTs: 0,

  // Previous robot.program.state value — tracked so we can detect a
  // 2→0 transition (run completed) and pop a completion toast that
  // carries the manifest's codegen_stale flag when applicable
  // (2026-07-30 §3 anti-staleness surfacing).
  _lastProgramState: null,

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

  // Self-collision presentation preferences.
  //   selfCollisionBannerEnabled — Safety-page toggle for the
  //     non-blocking warn-zone banner. Persists in localStorage.
  //     NEVER affects the stop-zone modal — that's the last line
  //     of defense and always fires.
  //   mutedCollisionPairs — session-only Set of canonical pair
  //     keys (see lib/collisionPresentation.pairMuteKey). Cleared
  //     on refresh, per directive: "per-pair session mute".
  //
  // 2026-07-31 OPERATOR DIRECTIVE: default OFF. The fat capsule
  // model was blocking legitimate jogs and flagging safe poses as
  // "close"; until the mesh-hull upgrade (§396 follow-up) lands,
  // the banner is off unless someone opts in for a customer cell.
  // The toggle stays so it can come back.
  selfCollisionBannerEnabled: (() => {
    try {
      const raw = localStorage.getItem('selfCollisionBannerEnabled')
      return raw === null ? false : raw === '1'
    } catch { return false }
  })(),
  mutedCollisionPairs: new Set(),
  setSelfCollisionBannerEnabled: (on) => {
    try { localStorage.setItem('selfCollisionBannerEnabled', on ? '1' : '0') }
    catch { /* ignore */ }
    set({ selfCollisionBannerEnabled: !!on })
  },
  muteCollisionPair: (key) => {
    if (!key) return
    set((s) => {
      const next = new Set(s.mutedCollisionPairs)
      next.add(key)
      return { mutedCollisionPairs: next }
    })
  },
  unmuteCollisionPair: (key) => {
    if (!key) return
    set((s) => {
      const next = new Set(s.mutedCollisionPairs)
      next.delete(key)
      return { mutedCollisionPairs: next }
    })
  },
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
  //
  // Default CONTINUOUS (2026-08-03 §2): press-and-hold matches operator
  // expectation on a pendant, and the client + server dead-man safety
  // net (Worker+rAF ticker at 100 ms cadence, driver's 200 ms freshness
  // deadman) has been in production since the CONTINUOUS mode landed —
  // STEP's "safer" reputation was margin-only. STEP remains a one-click
  // switch for fine positioning (25 mm/step, mm-precise) and operator
  // muscle memory. Persisted in Zustand (memory only — no localStorage;
  // a fresh page load re-defaults to CONTINUOUS).
  jogStyle: 'CONTINUOUS',
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
  // 2026-08-05 — high-water-mark timestamp of the last jog rejection
  // we toast'd. Prevents re-toasting the same rejection when the
  // rejected[] ring buffer re-arrives on subsequent /ws frames.
  _lastJogRejectTs: 0,
  pendingCommand: null,
  commandError: null,
  toasts: [],

  // ---- LiDAR ----
  lidarPoints: [],

  // ---- Trajectory overlay ----
  // Set by RecentRunsCard's [Trajectory] action so the 3D twin viewer
  // can draw the swept flange path in the same scene the operator
  // watches. Cleared when the user closes the trajectory panel.
  //   points: [[x, y, z], ...]  meters, in the URDF geometry frame
  //           (Y-up) — same frame ArmViewer3D loads the URDF into, so
  //           the polyline lands directly on the flange.
  //   step: integer step_index this path corresponds to (for label)
  //   runId: source run for the readout badge
  trajectoryOverlay: null,
  setTrajectoryOverlay(overlay) { set({ trajectoryOverlay: overlay }) },

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
    get()._installVisibilityHooks()
  },

  // Install document.visibilitychange + window.pageshow listeners
  // so the tablet's "resume from background" ALWAYS triggers a
  // full reconcile — even when the WS looks connected from the
  // browser's perspective. Mobile Chrome silently suspends WS
  // frames while a tab is backgrounded and can appear to seamlessly
  // resume without ANY onclose firing; that's how a tablet ends
  // up "connected" but sitting on stale state.
  //
  // Idempotent — registers once per page load. Guarded so the SSR
  // path (unlikely; kept for safety) is a no-op.
  _visibilityHooksInstalled: false,
  _installVisibilityHooks() {
    if (get()._visibilityHooksInstalled) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    set({ _visibilityHooksInstalled: true })
    // visibilitychange fires when the tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      // Log even when there's no open program — the log is what we
      // send when the operator asks "what happened on the tablet?"
      get()._pushReconcileLog('visibility_visible',
        `wsStatus=${get().wsStatus}`)
      // If the WS is down, onopen will trigger a reconcile when it
      // reconnects. If it looks up but we've been backgrounded,
      // force one anyway — the browser may have silently paused
      // frame delivery and we can't tell without a fresh fetch.
      get()._reconcileAll('visibilitychange')
    })
    // pageshow with persisted=true fires when the tab comes back
    // from the bfcache — no fetches ran while it was cached, so
    // the tab is running arbitrarily-old state.
    window.addEventListener('pageshow', (e) => {
      const persisted = !!(e && e.persisted)
      get()._pushReconcileLog('pageshow',
        persisted ? 'bfcache_restore' : 'initial')
      if (persisted) get()._reconcileAll('pageshow_bfcache')
    })
  },

  _connectStateWS() {
    const attempt = get()._stateRetry
    set({ wsStatus: 'connecting' })

    const ws = new WebSocket(`${WS_PROTO}://${HOST}/ws/state`)

    ws.onopen = () => {
      const wasReconnect = get()._hasConnectedOnce
      set({
        wsStatus: 'connected',
        _stateWs: ws,
        _stateRetry: 0,
        _hasConnectedOnce: true,
      })
      get()._pushReconcileLog('ws_open',
        wasReconnect ? 'reconnect' : 'first_connect')
      // Reconnect path: NEVER trust pre-drop state. During the WS
      // outage other clients may have mutated programs, deploys may
      // have restarted the server, mobile Chrome may have suspended
      // the tab entirely. Full reconcile fetches the {id: rev} map
      // + refetches the open program before rendering any confident
      // state again.
      //
      // Doctrine tie-in: D10 forbids the screen asserting state it
      // can't read. Between the WS drop and the reconcile response,
      // the client's held rev is unconfirmed — badges render the
      // "state syncing…" indicator via programRevConfirmed=false.
      if (wasReconnect) {
        get()._reconcileAll('ws_reconnect')
      } else {
        // First-connect path: still run the bundle-id check so an
        // open tab left through a deploy learns about it now, not
        // on the next disconnect. No full reconcile — the initial
        // program load is handled by the normal load path.
        get()._checkBundleId()
      }
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        const now = Date.now()
        // wsLatency estimates one-way (server-emit → client-receive)
        // delay, but msg.t is the server's Date.now() (Jetson clock)
        // and `now` is the tablet's Date.now() — cross-machine
        // wall-clock subtraction. Any NTP drift between the two
        // machines shows up here; on a fresh ONN tablet the browser
        // clock can drift a few hundred ms behind the Jetson, which
        // used to print as e.g. "-318 ms" in TopBar. Clamp to 0 so
        // the display never lies about direction. This value is a
        // ROUGH estimate under clock skew and MUST NOT be used in
        // any control-flow decision — wedge staleness, deadman
        // timers, etc. all use same-clock deltas instead (see
        // lastProgramStateTs below, `stuckStoppingMs` in
        // MonitorDashboard, HoldButton's Worker+rAF ticker).
        const latency = msg.t ? Math.max(0, Math.round(now - msg.t)) : 0
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
        // Track same-machine arrival time of ProjectState frames so
        // the wedge banner can distinguish a real controller wedge
        // (fresh state=3 arriving for >3s) from a stale stream
        // (nothing arriving at all). Client-side Date.now() only —
        // same clock as `stoppingSince`/`nowTs` in MonitorDashboard.
        // A `program.state` value of 0/2/3 counts as a live frame;
        // absence of `program.state` in the message doesn't refresh
        // the timestamp so a burst of non-program updates can't hide
        // a wedged stream.
        const progStateNow =
          msg.robot && msg.robot.program
            && msg.robot.program.state !== undefined
            && msg.robot.program.state !== null
            ? now : get().lastProgramStateTs
        // 2026-08-05 A(c): surface driver `jog` family rejections as
        // a toast so the operator never sees dead-button silence when
        // the allow_jog / monitor_only gate is closed on the driver.
        // Rejections stream via robot.rejected (ring buffer, 32
        // entries, mirrored by dashboard_server._on_estun_rejected).
        // We track the last-seen jog-rejection timestamp and toast
        // any newer entry — one toast per new rejection, coalesced by
        // the store's addToast dedup so a burst doesn't spam.
        const _incomingRej  = msg.robot?.rejected
        const _lastJogRejTs = get()._lastJogRejectTs || 0
        let   _newLastTs    = _lastJogRejTs
        if (Array.isArray(_incomingRej)) {
          for (const r of _incomingRej) {
            if (r?.family !== 'jog') continue
            const rts = Number(r?.ts) || 0
            if (rts <= _lastJogRejTs) continue
            if (rts > _newLastTs) _newLastTs = rts
            const reason = r?.reason || 'jog rejected (unknown reason)'
            try { get().addToast?.(`Jog rejected: ${reason}`, 'warning') }
            catch (_) { /* nop */ }
          }
        }
        // Run-completion toast on program.state 2→0 (running →
        // stopped). Fires ONCE per transition and, when the most-
        // recent run manifest carries codegen_stale=true, colors
        // the toast amber with the "used STALE codegen" call-out.
        // Non-blocking; failures are silent. See 2026-07-30 §3.
        const _prevProgState = get()._lastProgramState
        const _curProgState  = msg?.robot?.program?.state
        if (_prevProgState === 2 && _curProgState === 0) {
          // Debounced fetch — the manifest gets written by the
          // recorder on the same state transition; give it ~200ms
          // to land before we look, then check codegen_stale.
          setTimeout(() => {
            fetch('/api/runs')
              .then((r) => r.ok ? r.json() : null)
              .then((body) => {
                const runs = body?.runs || []
                const latest = runs[0]
                if (!latest) return
                if (latest.codegen_stale) {
                  try {
                    get().addToast?.(
                      `Run completed — used STALE codegen `
                      + `(boot ${(latest.codegen_version?.src_sha256 || '').slice(0, 12)} `
                      + `≠ disk ${latest.codegen_disk_sha || '?'}). `
                      + `Restart services or run scripts/deploy.sh `
                      + `before the next run.`,
                      'warning', 12000)
                  } catch (_) { /* nop */ }
                } else {
                  try {
                    const dur = latest.duration_s
                      ? `${latest.duration_s.toFixed(1)}s`
                      : 'complete'
                    get().addToast?.(`Run ${dur} — codegen fresh`, 'info', 4000)
                  } catch (_) { /* nop */ }
                }
              })
              .catch(() => {})
          }, 250)
        }

        set({
          safety: msg.safety ?? get().safety,
          joints: msg.joints ?? get().joints,
          robot: msg.robot ?? get().robot,
          task: msg.task ?? get().task,
          _lastJogRejectTs: _newLastTs,
          _lastProgramState: (_curProgState ?? _prevProgState),
          lastProgramStateTs: progStateNow,
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
        // Bug 1 fix (2026-07-27): program_changed events piggyback
        // on /ws/state as msg.program_events. Each event: {
        //   type, program_id, rev, source_client, kind, ts_ms }.
        // We ignore our own echoes (source_client === CLIENT_ID),
        // ignore events for programs we don't have open, and
        // dedupe on ts_ms so a single event fanning across
        // multiple frames only fires once. Cross-client refetch
        // lives at the bottom of the handler so all state is
        // already committed by the time we ask for a re-read.
        if (Array.isArray(msg.program_events) && msg.program_events.length) {
          get()._handleProgramEvents(msg.program_events)
        }
        // 2026-07-31 jog-stop instrumentation: watch for driver-
        // emitted stops. The driver publishes robot.last_stop_ts +
        // robot.last_stop_reason on every _stop_jog_locked call.
        // When the ts advances, the driver just stopped a jog on
        // its side; classify the cause from the reason string's
        // `cause=<tag>` prefix (added driver-side in the same
        // commit). Frontend-initiated stops also flow through this
        // path — we suppress those by matching against the client's
        // most recent pushJogStop timestamp.
        try {
          const _stopTs = Number(msg?.robot?.last_stop_ts) || 0
          const _prev   = get()._lastObservedDriverStopTs || 0
          if (_stopTs > _prev) {
            set({ _lastObservedDriverStopTs: _stopTs })
            const reason = String(msg?.robot?.last_stop_reason || '')
            // Reason strings are tagged as `cause=<tag>: <human>`
            // (driver-side change). Parse the tag; default to
            // 'server_gate' when the tag is missing / unknown.
            const m = /cause=([a-z_]+)/.exec(reason)
            const tag = m ? m[1] : 'server_gate'
            // Skip stops that trace back to a client-initiated
            // release (release_cmd) — those already got a
            // pointer_up / pointer_cancel entry from the UI.
            if (tag !== 'release_cmd') {
              try { pushJogStop(tag, { reason }) } catch { /* nop */ }
            }
          }
        } catch { /* nop */ }
        // 2026-07-31 CONVERGENCE: every state frame carries the
        // server's authoritative {program_id: rev} snapshot. If our
        // held rev for the OPEN program is behind, refetch now —
        // this heals missed events (event ring TTL 15s can age out
        // during long backgrounds) without waiting for the next
        // mutation to fire a fresh event.
        const _serverRevs = msg.program_revs
        if (_serverRevs && typeof _serverRevs === 'object') {
          const _cp = get().currentProgram
          if (_cp && _cp.id && _serverRevs[_cp.id] != null) {
            const serverRev = Number(_serverRevs[_cp.id])
            const heldRev   = _cp.rev == null ? -1 : Number(_cp.rev)
            // Two gap directions both trigger a refetch:
            //   (a) server > held — the normal case (another client
            //       just mutated). Missed-event heal.
            //   (b) server < held — the post-restart case (server
            //       lost its in-memory rev, our held value is now
            //       impossibly high). The refetch resets us to the
            //       authoritative server value.
            const gap = Number.isFinite(serverRev) && serverRev !== heldRev
            if (gap) {
              get()._pushReconcileLog('rev_gap_in_frame',
                `${_cp.id}: held=${_cp.rev} server=${serverRev} `
                + `(${serverRev > heldRev ? 'behind' : 'ahead-of-server'})`)
              // Skip the refetch when the operator has unsaved
              // edits — the existing programChangedByOther banner
              // path takes precedence to avoid clobbering their
              // local work.
              if (!_cp.unsaved) {
                get()._refreshCurrentProgram()
              }
            }
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    }

    ws.onerror = () => {
      // Let onclose handle reconnect
    }

    ws.onclose = () => {
      // WS down → held program state is no longer trustworthy. Any
      // mutation on another client during the outage will NOT reach
      // us via program_events until the WS comes back. Flip the
      // confirmation flag so taught badges surface the "state
      // syncing…" indicator (D10) rather than a confident green ✓.
      set({
        wsStatus: 'disconnected',
        _stateWs: null,
        programRevConfirmed: false,
      })
      get()._pushReconcileLog('ws_close', 'client-observed close')
      // 2026-07-31 jog-stop instrumentation: WS drops are a
      // top-suspect cause of mid-hold cutouts. The jog channel
      // rides /ws/state — losing the WS forces the fallback
      // path, and if that also stalls the driver's freshness
      // deadman fires. Tag so the bench analyzer separates them.
      try { pushJogStop('ws_drop', {}) } catch { /* nop */ }
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
  // Highest program_event ts_ms this client has already applied. Guards
  // against the same event firing multiple times as it rides successive
  // /ws/state frames within its 15 s TTL window on the server.
  _lastProgramEventTs: 0,

  // Set to {rev, source_client, kind, ts_ms} when the server tells us
  // OUR currently-open program was mutated on ANOTHER device while we
  // have local unsaved edits. ProgramEditor renders a banner reading
  // "Program updated on another device — [Reload] [Keep my edits]".
  // Cleared by explicit user action (Reload → auto-refetch clears it;
  // Keep my edits → clears without refetch, next Save will win). null
  // when there's nothing outstanding.
  programChangedByOther: null,
  clearProgramChangedByOther() { set({ programChangedByOther: null }) },

  _handleProgramEvents(events) {
    const cp = get().currentProgram
    if (!cp || !cp.id) return
    let latestSeen = get()._lastProgramEventTs
    let mustRefetch = null      // last event we WILL apply
    let mustBanner  = null      // last unsaved-edits-conflict event
    for (const ev of events) {
      if (!ev || ev.type !== 'program_changed') continue
      if (ev.program_id !== cp.id) continue
      if (ev.source_client && ev.source_client === CLIENT_ID) continue
      if (!ev.ts_ms || ev.ts_ms <= latestSeen) continue
      // Compare rev when we have one locally. rev==undefined on
      // fresh loads means "assume stale" and refetch on any event.
      if (cp.rev != null && ev.rev != null && ev.rev <= cp.rev) continue
      latestSeen = ev.ts_ms
      if (cp.unsaved) mustBanner  = ev
      else            mustRefetch = ev
    }
    if (latestSeen > get()._lastProgramEventTs) {
      set({ _lastProgramEventTs: latestSeen })
    }
    if (mustBanner) {
      set({ programChangedByOther: {
        rev:           mustBanner.rev,
        source_client: mustBanner.source_client,
        kind:          mustBanner.kind || 'mutation',
        ts_ms:         mustBanner.ts_ms,
      } })
    } else if (mustRefetch) {
      // No local unsaved edits → refetch quietly. The next state
      // frame that arrives after refetch clears cp.rev == null so
      // subsequent events fire the normal >-rev compare.
      get()._refreshCurrentProgram()
    }
  },

  async _pointsFetch(method, path, body = null) {
    // Every mutation stamps X-Client-Id so the server can tag the
    // resulting program_changed event with this client's UUID and
    // OTHER clients see the change while this one skips its echo
    // (see Bug 1 fix in dashboard_server._emit_program_changed).
    const headers = { 'X-Client-Id': CLIENT_ID }
    const opts = { method, headers }
    if (body !== null) {
      headers['Content-Type'] = 'application/json'
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

  // Log a reconcile event to the session-local ring. Capped at 64;
  // detail is a short free-form string. Every reconcile trigger
  // pushes at least a 'start' and 'done' pair so the operator can
  // read a linear timeline in devtools:
  //   useStore.getState()._reconcileLog
  _pushReconcileLog(kind, detail = '') {
    const entry = { ts: Date.now(), kind, detail: String(detail || '') }
    set((s) => {
      const next = [...(s._reconcileLog || []), entry]
      if (next.length > 64) next.splice(0, next.length - 64)
      return { _reconcileLog: next }
    })
  },

  // Full reconcile — the convergence guarantee (2026-07-31 §16).
  // Called on:
  //   * every WS onopen that isn't the first connect (reconnect)
  //   * every document visibilitychange to visible (mobile Chrome
  //     may have silently suspended the WS)
  //   * every window pageshow (tablet bfcache resume)
  //   * an in-frame rev-gap detected on program_revs
  // Fetches server-truth for the program list revs AND the currently
  // open program's full state before flipping programRevConfirmed
  // back to true. Never trust pre-reconcile state.
  async _reconcileAll(trigger = 'unspecified') {
    get()._pushReconcileLog('reconcile_start', trigger)
    // Mark state unconfirmed until the reconcile completes — the
    // badges render "state syncing…" during this window (D10).
    if (get().programRevConfirmed) {
      set({ programRevConfirmed: false })
    }
    let revsFetchOK = false
    try {
      const res = await fetch('/api/programs/revs')
      if (res.ok) {
        const body = await res.json()
        const revs = (body && body.revs) || {}
        // If the currently-open program's server rev exceeds the
        // client's held rev, refetch. The subsequent
        // _refreshCurrentProgram call below covers the same case
        // for programs with rev=null on the client, so this branch
        // is belt-and-suspenders for programs the client hasn't
        // touched yet in this session.
        const cp = get().currentProgram
        if (cp && cp.id && revs[cp.id] != null
            && (cp.rev == null || revs[cp.id] > cp.rev)) {
          get()._pushReconcileLog('rev_gap_detected',
            `${cp.id}: held=${cp.rev} server=${revs[cp.id]}`)
        }
        revsFetchOK = true
      }
    } catch (_) {
      // Network hiccup during reconcile. Log + don't flip confirmed
      // → badges stay in syncing state. The next tick's rev-gap
      // watcher OR the next visibility resume will retry.
      get()._pushReconcileLog('reconcile_err', 'revs fetch failed')
    }
    // Refetch the open program's full state — this is what actually
    // heals a missed teach/mutation.
    const cp = get().currentProgram
    if (cp && cp.id) {
      await get()._refreshCurrentProgram()
    } else if (revsFetchOK && get().wsStatus === 'connected') {
      // No open program to reconcile → nothing to hold syncing on.
      set({ programRevConfirmed: true })
    }
    // Deploy-aware bundle check runs alongside the reconcile so a
    // tab that was open through a deploy learns about it on the
    // very next reconcile trigger.
    get()._checkBundleId()
    get()._pushReconcileLog('reconcile_done', trigger)
  },

  // Compare the served bundle hash against this tab's build-time
  // __BUILD_ID__. Sets bundleObsolete=true on mismatch so the toast
  // banner renders. Silent when the server can't be reached OR the
  // ids match. Non-blocking.
  async _checkBundleId() {
    try {
      const res = await fetch('/api/build_id', { cache: 'no-store' })
      if (!res.ok) return
      const body = await res.json()
      const server = String((body && body.bundle_id) || '')
      const local = typeof __BUILD_ID__ !== 'undefined' ? String(__BUILD_ID__) : ''
      set({ serverBundleId: server || null })
      if (server && local && server !== local && !get().bundleObsolete) {
        set({ bundleObsolete: true })
        // Standing toast — long dwell (60s) so the operator sees it
        // even while working. Deduped by content in ToastContainer.
        try {
          get().addToast?.(
            `New app version available (${server.slice(0, 8)}) — `
            + `refresh to load. This tab is running ${local.slice(0, 8)}.`,
            'warning',
            60000)
        } catch (_) { /* nop */ }
      }
    } catch (_) { /* ignore; next reconcile tries again */ }
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
          rev:        full.rev,      // Bug 1 fix: pick up rev so future
                                     // program_events compare correctly.
          unsaved:    false,         // Refetch clears the dirty flag —
                                     // we just re-read canonical state.
          has_taught_poses: full.has_taught_poses,
        })
        get().clearProgramChangedByOther()
        // Fresh fetch → held rev matches server. Only mark
        // confirmed while the WS is up (otherwise a subsequent
        // mutation on another client would slip past us again).
        if (get().wsStatus === 'connected') {
          set({ programRevConfirmed: true })
        }
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
  //     the 200 ms driver freshness deadman — this cuts that path out),
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
    // Whole-program loads from the server carry a `rev`. That's our
    // "fresh from server" marker — flip programRevConfirmed=true if
    // the WS is up (an event fanning out after this arrives via
    // /ws/state will supersede the confirmation). Field-level
    // {unsaved:true} patches don't carry rev, so they don't flip
    // the flag — a local edit doesn't confirm cross-client sync.
    if (patch && patch.rev != null && get().wsStatus === 'connected') {
      set({ programRevConfirmed: true })
    }
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

  addToast(message, type = 'info', durationMs) {
    const id = Date.now() + Math.random()
    const toast = { id, message, type, ts: Date.now() }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    // Duration override (2026-08-04): error-severity toasts for the
    // load path need to dwell long enough for the operator to read
    // "Controller link down — program NOT loaded" without losing it
    // to the default 3s. 60s bundle-obsolete toast (line ~1109) was
    // already passing a third arg that was silently ignored — this
    // wires the ignored parameter without changing any 2-arg caller.
    const dwellMs = (typeof durationMs === 'number' && durationMs > 0)
      ? durationMs : 3000
    setTimeout(() => get().removeToast(id), dwellMs)
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
